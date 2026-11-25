import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  PATIENT_ID,
  adoptMedicine,
  createTestApp,
  type TestApp,
} from "../helpers.js";
import type { Queryable } from "@kiro-ai-bit/eventing";
import { PGlite } from "@electric-sql/pglite";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.closeAll());

function wrap(pg: PGlite): Queryable {
  return {
    query: async <T = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) => {
      const res = await pg.query<T>(text, params as unknown[]);
      return { rows: res.rows };
    },
  };
}

async function dosesRemainingOf(medicineId: string): Promise<number> {
  const res = await t.servicePg.query<{ doses_remaining: number }>(
    `SELECT doses_remaining FROM patient_medicines WHERE id = $1`,
    [medicineId],
  );
  return res.rows[0].doses_remaining;
}

async function outcomeState(
  medicineId: string,
  doseId: string,
): Promise<{ last_outcome: string; occurred_at: string } | null> {
  const res = await t.servicePg.query<{
    last_outcome: string;
    occurred_at: string;
  }>(
    `SELECT last_outcome, occurred_at FROM dose_outcome_states WHERE medicine_id = $1 AND dose_id = $2`,
    [medicineId, doseId],
  );
  return res.rows[0] ?? null;
}

async function refillEvents(medicineId: string) {
  const res = await t.servicePg.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM outbox WHERE event_type = 'RefillThresholdCrossed'`,
  );
  return res.rows
    .map((r) => r.payload)
    .filter((p) => p.medicineId === medicineId);
}

const DOSE_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DOSE_B = "bbbbbbbb-0000-4000-8000-0000000000b2";

async function dispatch(event: Record<string, unknown>) {
  const { handleDoseOutcomeChanged } =
    await import("@application/DoseOutcome/handleDoseOutcomeChanged.js");
  await handleDoseOutcomeChanged(
    { db: t.db, metrics: t.metrics },
    event as never,
  );
}

function outcomeEvent(
  med: { id: string },
  doseId: string,
  outcome: string,
  occurredAt: string,
  patientId = PATIENT_ID,
) {
  return {
    doseId,
    medicineId: med.id,
    patientId,
    outcome,
    occurredAt,
    actorId: "99999999-9999-4999-8999-999999999999",
  };
}

describe("DoseOutcomeChanged consumer — delta + ordering", () => {
  it("first-seen taken-on-time decrements dosesRemaining by 1 and stores state", async () => {
    const med = await adoptMedicine(t, { dosesRemaining: 10 });
    await dispatch(
      outcomeEvent(med, DOSE_A, "taken-on-time", "2026-11-25T10:00:00.000Z"),
    );
    expect(await dosesRemainingOf(med.id)).toBe(9);
    const state = await outcomeState(med.id, DOSE_A);
    expect(state?.last_outcome).toBe("taken-on-time");
  });

  it("taken → skipped restores +1; skipped/missed never decrement on entry", async () => {
    const med = await adoptMedicine(t, { dosesRemaining: 10 });
    await dispatch(
      outcomeEvent(med, DOSE_A, "taken-on-time", "2026-11-25T10:00:00.000Z"),
    );
    expect(await dosesRemainingOf(med.id)).toBe(9);
    // taken → skipped: restore
    await dispatch(
      outcomeEvent(med, DOSE_A, "skipped", "2026-11-25T11:00:00.000Z"),
    );
    expect(await dosesRemainingOf(med.id)).toBe(10);
    // skipped → missed: same class (not taken), delta 0
    await dispatch(
      outcomeEvent(med, DOSE_A, "missed", "2026-11-25T12:00:00.000Z"),
    );
    expect(await dosesRemainingOf(med.id)).toBe(10);
    // missed → taken-late: decrement (taken class)
    await dispatch(
      outcomeEvent(med, DOSE_A, "taken-late", "2026-11-25T13:00:00.000Z"),
    );
    expect(await dosesRemainingOf(med.id)).toBe(9);
  });

  it("redelivery of identical (occurredAt,outcome) is a no-op; stale occurredAt ignored", async () => {
    const med = await adoptMedicine(t, { dosesRemaining: 10 });
    const e = outcomeEvent(
      med,
      DOSE_A,
      "taken-on-time",
      "2026-11-25T10:00:00.000Z",
    );
    await dispatch(e);
    expect(await dosesRemainingOf(med.id)).toBe(9);
    // identical redelivery
    await dispatch(e);
    expect(await dosesRemainingOf(med.id)).toBe(9);
    // stale (older occurredAt, different outcome)
    await dispatch(
      outcomeEvent(med, DOSE_A, "missed", "2026-11-25T09:00:00.000Z"),
    );
    expect(await dosesRemainingOf(med.id)).toBe(9);
    expect((await outcomeState(med.id, DOSE_A))?.last_outcome).toBe(
      "taken-on-time",
    );
  });

  it("equal occurredAt with different outcome applies (arrival-order LWW)", async () => {
    const med = await adoptMedicine(t, { dosesRemaining: 10 });
    const ts = "2026-11-25T10:00:00.000Z";
    await dispatch(outcomeEvent(med, DOSE_A, "taken-on-time", ts));
    await dispatch(outcomeEvent(med, DOSE_A, "skipped", ts));
    expect(await dosesRemainingOf(med.id)).toBe(10);
    expect((await outcomeState(med.id, DOSE_A))?.last_outcome).toBe("skipped");
  });

  it("floor 0: taken at dosesRemaining=0 stays 0", async () => {
    const med = await adoptMedicine(t, { dosesRemaining: 0 });
    await dispatch(
      outcomeEvent(med, DOSE_B, "taken-on-time", "2026-11-25T10:00:00.000Z"),
    );
    expect(await dosesRemainingOf(med.id)).toBe(0);
  });

  it("threshold crossing via consumer fires RefillThresholdCrossed once per transition", async () => {
    const med = await adoptMedicine(t, { dosesRemaining: 7 });
    await dispatch(
      outcomeEvent(med, DOSE_A, "taken-on-time", "2026-11-25T10:00:00.000Z"),
    );
    expect(await dosesRemainingOf(med.id)).toBe(6);
    let events = await refillEvents(med.id);
    expect(events).toHaveLength(1);
    expect(events[0].threshold).toBe(6);
    expect(events[0].dosesRemaining).toBe(6);
    // another taken → 5: already below 6, arm consumed → no new event
    await dispatch(
      outcomeEvent(med, DOSE_B, "taken-on-time", "2026-11-25T11:00:00.000Z"),
    );
    expect(await dosesRemainingOf(med.id)).toBe(5);
    events = await refillEvents(med.id);
    expect(events).toHaveLength(1);
  });

  it("unknown medicineId and foreign patientId are no-ops", async () => {
    const med = await adoptMedicine(t, { dosesRemaining: 10 });
    await dispatch(
      outcomeEvent(
        { id: "99999999-9999-4999-8999-999999999999" },
        DOSE_A,
        "taken-on-time",
        "2026-11-25T10:00:00.000Z",
      ),
    );
    await dispatch(
      outcomeEvent(
        med,
        DOSE_A,
        "taken-on-time",
        "2026-11-25T10:00:00.000Z",
        "33333333-3333-4333-8333-333333333333",
      ),
    );
    expect(await dosesRemainingOf(med.id)).toBe(10);
    expect(await outcomeState(med.id, DOSE_A)).toBeNull();
  });
});

describe("consumer worker — offset after success", () => {
  it("tick processes subscribed event once; second tick skips via offset", async () => {
    const med = await adoptMedicine(t, { dosesRemaining: 10 });
    const { startDoseOutcomeConsumer } =
      await import("@infrastructure/Eventing/index.js");
    const { handleDoseOutcomeChanged } =
      await import("@application/DoseOutcome/handleDoseOutcomeChanged.js");
    const consumer = await startDoseOutcomeConsumer({
      service: wrap(t.servicePg),
      broker: wrap(t.brokerPg),
      dispatch: (event) =>
        handleDoseOutcomeChanged(
          { db: t.db, metrics: t.metrics },
          {
            doseId: event.doseId as string,
            medicineId: event.medicineId as string,
            patientId: event.patientId as string,
            outcome: event.outcome as never,
            occurredAt: event.occurredAt as string,
          },
        ),
    });
    const payload = {
      eventId: crypto.randomUUID(),
      occurredAt: "2026-11-25T10:00:00.000Z",
      type: "DoseOutcomeChanged",
      doseId: DOSE_A,
      medicineId: med.id,
      patientId: PATIENT_ID,
      outcome: "taken-on-time",
    };
    await t.brokerPg.query(
      `INSERT INTO events (event_id, event_type, payload, occurred_at) VALUES ($1::uuid, 'DoseOutcomeChanged', $2::jsonb, now())`,
      [payload.eventId, JSON.stringify(payload)],
    );
    const first = await consumer.tick();
    expect(first.processed).toBe(1);
    expect(await dosesRemainingOf(med.id)).toBe(9);
    const second = await consumer.tick();
    expect(second.processed).toBe(0);
    expect(await dosesRemainingOf(med.id)).toBe(9);
    await consumer.stop();
  });
});
