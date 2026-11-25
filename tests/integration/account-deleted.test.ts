import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  PATIENT_ID,
  adoptMedicine,
  createTestApp,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.closeAll());

async function handle(userId: string) {
  const { handleAccountDeleted } =
    await import("@application/AccountDeletion/handleAccountDeleted.js");
  await handleAccountDeleted(
    { db: t.db, checkLinkCache: t.checkLinkCache, metrics: t.metrics },
    { userId },
  );
}

describe("AccountDeleted consumer", () => {
  it("purges patient medicines + cascades outcome states; catalog + other patients untouched; cache invalidated; redelivery no-op", async () => {
    const OTHER = "44444444-4444-4444-8444-444444444444";
    const med = await adoptMedicine(t, { patientId: PATIENT_ID });
    const other = await adoptMedicine(t, { patientId: OTHER });
    // seed an outcome-state row for the deleted patient's medicine
    await t.servicePg.query(
      `INSERT INTO dose_outcome_states (medicine_id, dose_id, last_outcome, occurred_at)
       VALUES ($1, $2, 'taken-on-time', now())`,
      [med.id, "dddddddd-0000-4000-8000-0000000000dd"],
    );

    const invalidated: string[] = [];
    const orig = t.checkLinkCache.invalidateForUser.bind(t.checkLinkCache);
    t.checkLinkCache.invalidateForUser = (u: string) => {
      invalidated.push(u);
      orig(u);
    };

    await handle(PATIENT_ID);

    const count = async (sql: string, params: unknown[] = []) =>
      (await t.servicePg.query<{ c: number }>(sql, params as never[])).rows[0]
        .c;
    expect(
      await count(
        `SELECT count(*)::int c FROM patient_medicines WHERE patient_id=$1`,
        [PATIENT_ID],
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int c FROM dose_outcome_states WHERE medicine_id=$1`,
        [med.id],
      ),
    ).toBe(0);
    // catalog entry survives (community asset)
    expect(
      await count(
        `SELECT count(*)::int c FROM medicine_catalog_entries WHERE id=$1`,
        [med.catalogEntryId],
      ),
    ).toBe(1);
    // other patient's medicine untouched
    expect(
      await count(`SELECT count(*)::int c FROM patient_medicines WHERE id=$1`, [
        other.id,
      ]),
    ).toBe(1);
    // no Medicine-published event on purge
    expect(
      await count(
        `SELECT count(*)::int c FROM outbox WHERE event_type IN ('MedicineArchived','RefillThresholdCrossed') AND payload->>'medicineId'=$1`,
        [med.id],
      ),
    ).toBe(0);
    expect(invalidated).toEqual([PATIENT_ID]);

    // redelivery → no-op
    await handle(PATIENT_ID);
    expect(invalidated).toEqual([PATIENT_ID, PATIENT_ID]);
    expect(
      await count(`SELECT count(*)::int c FROM patient_medicines WHERE id=$1`, [
        other.id,
      ]),
    ).toBe(1);
  });
});
