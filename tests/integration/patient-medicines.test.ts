import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  CAREGIVER_ID,
  PATIENT_ID,
  createTestApp,
  mintUserToken,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.closeAll());

async function token(
  role: "Patient" | "Caregiver" = "Patient",
  sub = PATIENT_ID,
) {
  return mintUserToken(t.keys, { sub, role });
}
function auth(tok: string) {
  return { authorization: `Bearer ${tok}` };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: { json(): unknown }) => r.json() as Record<string, any>;

// ---- fixtures -----------------------------------------------------------

const ENTRY = {
  ingredientNames: ["TestIngredient"],
  form: "tablet",
  packagingQuantity: 10,
};

function uniqueBrand(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function catalogEntryWithPhoto() {
  const created = j(
    await t.app.inject({
      method: "POST",
      url: "/v1/medicine-catalog",
      headers: auth(await token()),
      payload: { ...ENTRY, brandName: uniqueBrand("MedRec") },
    }),
  );
  const issue = j(
    await t.app.inject({
      method: "POST",
      url: `/v1/medicine-catalog/${created.id}/photos`,
      headers: auth(await token()),
      payload: { slot: "A" },
    }),
  );
  await t.app.inject({
    method: "PUT",
    url: `/v1/medicine-catalog/${created.id}/photos/A`,
    headers: auth(await token()),
    payload: { photoKey: issue.photoKey },
  });
  return created;
}

async function catalogEntryNoPhoto() {
  return j(
    await t.app.inject({
      method: "POST",
      url: "/v1/medicine-catalog",
      headers: auth(await token()),
      payload: {
        ...ENTRY,
        brandName: uniqueBrand("NoPhoto"),
      },
    }),
  );
}

const MED_BODY = {
  prescribingDoctor: "Dr. Test",
  dosage: "1 tab daily",
  dosesRemaining: 10,
  price: 120.5,
  pharmacyName: "Test Pharmacy",
};

async function adopt(
  catalogEntryId: string,
  overrides: Record<string, unknown> = {},
  tok?: string,
  patientId = PATIENT_ID,
) {
  return t.app.inject({
    method: "POST",
    url: "/v1/medicines",
    headers: auth(tok ?? (await token())),
    payload: { patientId, catalogEntryId, ...MED_BODY, ...overrides },
  });
}

async function outboxRows(type: string) {
  const res = await t.servicePg.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM outbox WHERE event_type = $1 ORDER BY occurred_at, event_id`,
    [type],
  );
  return res.rows.map((r) => r.payload);
}

// ---- tests ---------------------------------------------------------------

describe("adopt / list / detail", () => {
  it("adopt → 201 detail DTO with catalog-resolved fields; list shows it", async () => {
    const entry = await catalogEntryWithPhoto();
    const res = await adopt(entry.id);
    expect(res.statusCode).toBe(201);
    const body = j(res);
    expect(body.patientId).toBe(PATIENT_ID);
    expect(body.catalogEntryId).toBe(entry.id);
    expect(body.catalog.brandName).toBe(entry.brandName);
    expect(body.catalog.photos.A).toContain("https://photos.test/");
    expect(body.dosesRemaining).toBe(10);
    expect(body.archivedAt).toBeNull();

    const list = await t.app.inject({
      method: "GET",
      url: `/v1/medicines?patientId=${PATIENT_ID}`,
      headers: auth(await token()),
    });
    expect(list.statusCode).toBe(200);
    const meds = j(list).medicines as Array<Record<string, unknown>>;
    expect(meds.some((m) => m.id === body.id)).toBe(true);

    const detail = await t.app.inject({
      method: "GET",
      url: `/v1/medicines/${body.id}`,
      headers: auth(await token()),
    });
    expect(detail.statusCode).toBe(200);
    expect(j(detail).id).toBe(body.id);
  });

  it("adopt with dosesRemaining=0 → RefillThresholdCrossed threshold 0 in outbox", async () => {
    const entry = await catalogEntryWithPhoto();
    const res = await adopt(entry.id, { dosesRemaining: 0 });
    expect(res.statusCode).toBe(201);
    const rows = await outboxRows("RefillThresholdCrossed");
    const mine = rows.filter((r) => r.medicineId === j(res).id);
    expect(mine).toHaveLength(1);
    expect(mine[0].threshold).toBe(0);
    expect(mine[0].dosesRemaining).toBe(0);
    expect(mine[0].patientId).toBe(PATIENT_ID);
  });

  it("adopt with dosesRemaining=5 → threshold 6 event", async () => {
    const entry = await catalogEntryWithPhoto();
    const res = await adopt(entry.id, { dosesRemaining: 5 });
    expect(res.statusCode).toBe(201);
    const rows = await outboxRows("RefillThresholdCrossed");
    const mine = rows.filter((r) => r.medicineId === j(res).id);
    expect(mine).toHaveLength(1);
    expect(mine[0].threshold).toBe(6);
  });

  it("adopt with dosesRemaining=10 → no threshold event", async () => {
    const entry = await catalogEntryWithPhoto();
    const res = await adopt(entry.id);
    expect(res.statusCode).toBe(201);
    const rows = await outboxRows("RefillThresholdCrossed");
    expect(rows.filter((r) => r.medicineId === j(res).id)).toHaveLength(0);
  });

  it("photo-less catalog entry → 409; unknown catalogEntryId → 404", async () => {
    const noPhoto = await catalogEntryNoPhoto();
    const res = await adopt(noPhoto.id);
    expect(res.statusCode).toBe(409);

    const missing = await adopt("99999999-9999-4999-8999-999999999999");
    expect(missing.statusCode).toBe(404);
  });

  it("authz: caregiver with active check-link → parity; inactive → 403", async () => {
    const entry = await catalogEntryWithPhoto();
    const cgTok = await token("Caregiver", CAREGIVER_ID);
    const patientId = PATIENT_ID;

    t.careStub.setHandler(() => ({ status: 200, body: { active: true } }));
    const ok = await adopt(entry.id, {}, cgTok, patientId);
    expect(ok.statusCode).toBe(201);

    const list = await t.app.inject({
      method: "GET",
      url: `/v1/medicines?patientId=${patientId}`,
      headers: auth(cgTok),
    });
    expect(list.statusCode).toBe(200);
    expect(t.careStub.calls.length).toBeGreaterThan(0);
    expect(t.careStub.calls[0]).toContain("patientId=" + patientId);
    expect(t.careStub.calls[0]).toContain("caregiverId=" + CAREGIVER_ID);

    t.careStub.setHandler(() => ({ status: 200, body: { active: false } }));
    // positive cache may still serve — use a fresh patientId to bypass cache
    const otherPatient = "33333333-3333-4333-8333-333333333333";
    const denied = await t.app.inject({
      method: "GET",
      url: `/v1/medicines?patientId=${otherPatient}`,
      headers: auth(cgTok),
    });
    expect(denied.statusCode).toBe(403);
  });

  it("authz: patient token for foreign patientId → 403 via check-link deny", async () => {
    t.careStub.setHandler(() => ({ status: 200, body: { active: false } }));
    const foreign = "44444444-4444-4444-8444-444444444444";
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/medicines?patientId=${foreign}`,
      headers: auth(
        await token("Patient", "55555555-5555-4555-8555-555555555555"),
      ),
    });
    expect(res.statusCode).toBe(403);
  });

  it("authz: check-link unreachable → 503 fail closed (caregiver only)", async () => {
    const entry = await catalogEntryWithPhoto();
    // fresh pair — positive check-link cache is per (patientId, caregiverId)
    const p = "66666666-6666-4666-8666-666666666666";
    const c = "77777777-7777-4777-8777-777777777777";
    t.careStub.setHandler(() => {
      throw new Error("care down");
    });
    const cgTok = await token("Caregiver", c);
    const res = await adopt(entry.id, {}, cgTok, p);
    expect(res.statusCode).toBe(503);

    // patient-self path unaffected
    const self = await adopt(entry.id);
    expect(self.statusCode).toBe(201);
    t.careStub.setHandler(() => ({ status: 200, body: { active: false } }));
  });

  it("no token → 401; bad patientId → 400", async () => {
    const noAuth = await t.app.inject({ method: "GET", url: "/v1/medicines" });
    expect(noAuth.statusCode).toBe(401);
    const bad = await t.app.inject({
      method: "GET",
      url: "/v1/medicines?patientId=not-a-uuid",
      headers: auth(await token()),
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("patch + refill arm-state", () => {
  it("patch private fields → 200; empty patch → 400; unknown id → 404", async () => {
    const entry = await catalogEntryWithPhoto();
    const med = j(await adopt(entry.id));

    const res = await t.app.inject({
      method: "PATCH",
      url: `/v1/medicines/${med.id}`,
      headers: auth(await token()),
      payload: { dosage: "2 tabs daily", price: 99.9 },
    });
    expect(res.statusCode).toBe(200);
    const body = j(res);
    expect(body.dosage).toBe("2 tabs daily");
    expect(body.price).toBe(99.9);

    const empty = await t.app.inject({
      method: "PATCH",
      url: `/v1/medicines/${med.id}`,
      headers: auth(await token()),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const missing = await t.app.inject({
      method: "PATCH",
      url: "/v1/medicines/99999999-9999-4999-8999-999999999999",
      headers: auth(await token()),
      payload: { dosage: "x" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("dosesRemaining transitions fire threshold events exactly per arm-state", async () => {
    const entry = await catalogEntryWithPhoto();
    const med = j(await adopt(entry.id, { dosesRemaining: 10 }));
    const before = (await outboxRows("RefillThresholdCrossed")).filter(
      (r) => r.medicineId === med.id,
    ).length;
    expect(before).toBe(0);

    const tok = await token();
    const patch = (v: number) =>
      t.app.inject({
        method: "PATCH",
        url: `/v1/medicines/${med.id}`,
        headers: auth(tok),
        payload: { dosesRemaining: v },
      });

    // 10 → 5: crosses ≤6 → threshold 6
    expect((await patch(5)).statusCode).toBe(200);
    // 5 → 5: no change → no eval
    expect((await patch(5)).statusCode).toBe(200);
    // 5 → 8: re-arms (>6)
    expect((await patch(8)).statusCode).toBe(200);
    // 8 → 5: fires again
    expect((await patch(5)).statusCode).toBe(200);
    // 5 → 0: deepest → threshold 0 (subsumes 6)
    expect((await patch(0)).statusCode).toBe(200);

    const mine = (await outboxRows("RefillThresholdCrossed")).filter(
      (r) => r.medicineId === med.id,
    );
    expect(mine.map((r) => r.threshold)).toEqual([6, 6, 0]);
    expect(mine.every((r) => (r.dosesRemaining as number) <= 6)).toBe(true);
  });

  it("caregiver parity: patch + detail via active check-link; deny → 403", async () => {
    const entry = await catalogEntryWithPhoto();
    const p = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const c = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const cgTok = await token("Caregiver", c);
    t.careStub.setHandler(() => ({ status: 200, body: { active: true } }));
    const med = j(await adopt(entry.id, {}, cgTok, p));

    const patch = await t.app.inject({
      method: "PATCH",
      url: `/v1/medicines/${med.id}`,
      headers: auth(cgTok),
      payload: { dosage: "cg edited" },
    });
    expect(patch.statusCode).toBe(200);
    expect(j(patch).dosage).toBe("cg edited");

    const detail = await t.app.inject({
      method: "GET",
      url: `/v1/medicines/${med.id}`,
      headers: auth(cgTok),
    });
    expect(detail.statusCode).toBe(200);

    t.careStub.setHandler(() => ({ status: 200, body: { active: false } }));
    const p2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const med2 = j(await adopt(entry.id, {}, await token("Patient", p2), p2));
    const denied = await t.app.inject({
      method: "PATCH",
      url: `/v1/medicines/${med2.id}`,
      headers: auth(cgTok),
      payload: { dosage: "nope" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("non-count patch does not touch arm state or emit events", async () => {
    const entry = await catalogEntryWithPhoto();
    const med = j(await adopt(entry.id, { dosesRemaining: 10 }));
    const res = await t.app.inject({
      method: "PATCH",
      url: `/v1/medicines/${med.id}`,
      headers: auth(await token()),
      payload: { pharmacyName: "New Pharmacy" },
    });
    expect(res.statusCode).toBe(200);
    const rows = (await outboxRows("RefillThresholdCrossed")).filter(
      (r) => r.medicineId === med.id,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("archive", () => {
  it("archive → 200 + archivedAt + one MedicineArchived; repeat → no-op no dup", async () => {
    const entry = await catalogEntryWithPhoto();
    const med = j(await adopt(entry.id));

    const res = await t.app.inject({
      method: "POST",
      url: `/v1/medicines/${med.id}/archive`,
      headers: auth(await token()),
    });
    expect(res.statusCode).toBe(200);
    const body = j(res);
    expect(body.id).toBe(med.id);
    expect(body.archivedAt).toBeTruthy();

    const rows = await outboxRows("MedicineArchived");
    const mine = rows.filter((r) => r.medicineId === med.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].patientId).toBe(PATIENT_ID);

    // repeat archive → success no-op, still one event
    const again = await t.app.inject({
      method: "POST",
      url: `/v1/medicines/${med.id}/archive`,
      headers: auth(await token()),
    });
    expect(again.statusCode).toBe(200);
    expect(j(again).archivedAt).toBe(body.archivedAt);
    const rows2 = await outboxRows("MedicineArchived");
    expect(rows2.filter((r) => r.medicineId === med.id)).toHaveLength(1);

    // list excludes archived; detail still resolves
    const list = j(
      await t.app.inject({
        method: "GET",
        url: `/v1/medicines?patientId=${PATIENT_ID}`,
        headers: auth(await token()),
      }),
    );
    expect(
      (list.medicines as Array<{ id: string }>).some((m) => m.id === med.id),
    ).toBe(false);
    const detail = await t.app.inject({
      method: "GET",
      url: `/v1/medicines/${med.id}`,
      headers: auth(await token()),
    });
    expect(detail.statusCode).toBe(200);
    expect(j(detail).archivedAt).toBeTruthy();
  });

  it("patch on archived record → 409", async () => {
    const entry = await catalogEntryWithPhoto();
    const med = j(await adopt(entry.id));
    await t.app.inject({
      method: "POST",
      url: `/v1/medicines/${med.id}/archive`,
      headers: auth(await token()),
    });
    const res = await t.app.inject({
      method: "PATCH",
      url: `/v1/medicines/${med.id}`,
      headers: auth(await token()),
      payload: { dosage: "changed" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("archive unknown id → 404; no token → 401", async () => {
    const missing = await t.app.inject({
      method: "POST",
      url: "/v1/medicines/99999999-9999-4999-8999-999999999999/archive",
      headers: auth(await token()),
    });
    expect(missing.statusCode).toBe(404);
    const noAuth = await t.app.inject({
      method: "POST",
      url: "/v1/medicines/00000000-0000-4000-8000-000000000000/archive",
    });
    expect(noAuth.statusCode).toBe(401);
  });
});

describe("delete", () => {
  it("has-dose-records=true → 409; false → 200 deleted; repeat → 404", async () => {
    const entry = await catalogEntryWithPhoto();
    const med = j(await adopt(entry.id));

    t.scheduleDoseStub.setHandler(() => ({
      status: 200,
      body: { hasDoseRecords: true },
    }));
    const blocked = await t.app.inject({
      method: "DELETE",
      url: `/v1/medicines/${med.id}`,
      headers: auth(await token()),
    });
    expect(blocked.statusCode).toBe(409);

    t.scheduleDoseStub.setHandler(() => ({
      status: 200,
      body: { hasDoseRecords: false },
    }));
    const del = await t.app.inject({
      method: "DELETE",
      url: `/v1/medicines/${med.id}`,
      headers: auth(await token()),
    });
    expect(del.statusCode).toBe(200);
    expect(j(del)).toEqual({ id: med.id, deleted: true });

    const again = await t.app.inject({
      method: "DELETE",
      url: `/v1/medicines/${med.id}`,
      headers: auth(await token()),
    });
    expect(again.statusCode).toBe(404);
  });

  it("has-dose-records failure → 503 fail closed, record intact", async () => {
    const entry = await catalogEntryWithPhoto();
    const med = j(await adopt(entry.id));
    t.scheduleDoseStub.setHandler(() => {
      throw new Error("sd down");
    });
    const res = await t.app.inject({
      method: "DELETE",
      url: `/v1/medicines/${med.id}`,
      headers: auth(await token()),
    });
    expect(res.statusCode).toBe(503);
    t.scheduleDoseStub.setHandler(() => ({
      status: 200,
      body: { hasDoseRecords: false },
    }));
    const detail = await t.app.inject({
      method: "GET",
      url: `/v1/medicines/${med.id}`,
      headers: auth(await token()),
    });
    expect(detail.statusCode).toBe(200);
  });

  it("archived record with zero dose records → deletable", async () => {
    const entry = await catalogEntryWithPhoto();
    const med = j(await adopt(entry.id));
    await t.app.inject({
      method: "POST",
      url: `/v1/medicines/${med.id}/archive`,
      headers: auth(await token()),
    });
    const del = await t.app.inject({
      method: "DELETE",
      url: `/v1/medicines/${med.id}`,
      headers: auth(await token()),
    });
    expect(del.statusCode).toBe(200);
  });

  it("delete unknown id → 404; caregiver delete via active link → 200", async () => {
    const missing = await t.app.inject({
      method: "DELETE",
      url: "/v1/medicines/99999999-9999-4999-8999-999999999999",
      headers: auth(await token()),
    });
    expect(missing.statusCode).toBe(404);

    const entry = await catalogEntryWithPhoto();
    const p = "88888888-8888-4888-8888-888888888888";
    const c = "99999999-9999-4999-8999-999999999998";
    const cgTok = await token("Caregiver", c);
    t.careStub.setHandler(() => ({ status: 200, body: { active: true } }));
    const med = j(await adopt(entry.id, {}, cgTok, p));
    const del = await t.app.inject({
      method: "DELETE",
      url: `/v1/medicines/${med.id}`,
      headers: auth(cgTok),
    });
    expect(del.statusCode).toBe(200);
    t.careStub.setHandler(() => ({ status: 200, body: { active: false } }));
  });
});
