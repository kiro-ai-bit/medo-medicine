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

const BASE = {
  brandName: "NORMIX",
  ingredientNames: ["Amoxicillin", "Clavulanate"],
  form: "tablet",
  packagingQuantity: 21,
};

async function createEntry(overrides: Record<string, unknown> = {}) {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/medicine-catalog",
    headers: auth(await token()),
    payload: { ...BASE, ...overrides },
  });
  return res;
}

describe("catalog CRUD", () => {
  it("create → 201 normalized DTO, photos null", async () => {
    const res = await createEntry();
    expect(res.statusCode).toBe(201);
    const body = j(res);
    expect(body.brandName).toBe("normix");
    expect(body.ingredientNames).toEqual(["amoxicillin", "clavulanate"]);
    expect(body.photos).toEqual({ A: null, B: null, C: null });
    expect(body.form).toBe("tablet");
    expect(body.packagingQuantity).toBe(21);
  });

  it("duplicate (case/space/order variants) → 409 + existingEntryId", async () => {
    const first = j(await createEntry({ brandName: "DupMed" }));
    const res = await createEntry({
      brandName: "  dupmed  ",
      ingredientNames: ["clavulanate", "AMOXICILLIN"],
    });
    expect(res.statusCode).toBe(409);
    const body = j(res);
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details.existingEntryId).toBe(first.id);
  });

  it("different ingredients → not a duplicate", async () => {
    const res = await createEntry({
      brandName: "DupMed",
      ingredientNames: ["Amoxicillin"],
    });
    expect(res.statusCode).toBe(201);
  });

  it("list → paginated entries, q matches brand + ingredients", async () => {
    const all = await t.app.inject({
      method: "GET",
      url: "/v1/medicine-catalog",
      headers: auth(await token()),
    });
    expect(all.statusCode).toBe(200);
    const allBody = j(all);
    expect(allBody.entries.length).toBeGreaterThanOrEqual(3);
    expect(allBody.pageSize).toBe(20);
    expect(allBody.total).toBe(allBody.entries.length);

    const q = await t.app.inject({
      method: "GET",
      url: "/v1/medicine-catalog?q=amoxicillin",
      headers: auth(await token()),
    });
    const qBody = j(q);
    expect(qBody.entries.length).toBeGreaterThanOrEqual(1);
    for (const e of qBody.entries) {
      const hay = `${e.brandName} ${e.ingredientNames.join(" ")}`.toLowerCase();
      expect(hay).toContain("amoxicillin");
    }
  });

  it("detail → 200; unknown id → 404", async () => {
    const created = j(await createEntry({ brandName: "DetailMed" }));
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/medicine-catalog/${created.id}`,
      headers: auth(await token()),
    });
    expect(res.statusCode).toBe(200);
    expect(j(res).id).toBe(created.id);

    const missing = await t.app.inject({
      method: "GET",
      url: "/v1/medicine-catalog/99999999-9999-4999-8999-999999999999",
      headers: auth(await token()),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("patch → LWW field update, photos untouched", async () => {
    const created = j(await createEntry({ brandName: "PatchMe" }));
    const res = await t.app.inject({
      method: "PATCH",
      url: `/v1/medicine-catalog/${created.id}`,
      headers: auth(await token()),
      payload: { packagingQuantity: 30, form: "capsule" },
    });
    expect(res.statusCode).toBe(200);
    const body = j(res);
    expect(body.packagingQuantity).toBe(30);
    expect(body.form).toBe("capsule");
    expect(body.brandName).toBe("patchme");
  });

  it("patch empty body → 400; unknown id → 404", async () => {
    const created = j(await createEntry({ brandName: "PatchEmpty" }));
    const bad = await t.app.inject({
      method: "PATCH",
      url: `/v1/medicine-catalog/${created.id}`,
      headers: auth(await token()),
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
    const missing = await t.app.inject({
      method: "PATCH",
      url: "/v1/medicine-catalog/99999999-9999-4999-8999-999999999999",
      headers: auth(await token()),
      payload: { form: "syrup" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("no token → 401; service token on user route → 401/403", async () => {
    const noAuth = await t.app.inject({
      method: "GET",
      url: "/v1/medicine-catalog",
    });
    expect(noAuth.statusCode).toBe(401);
    const { mintPeerServiceToken } = await import("../helpers.js");
    const svc = await mintPeerServiceToken(t.keys, { aud: "medo-medicine" });
    const svcRes = await t.app.inject({
      method: "GET",
      url: "/v1/medicine-catalog",
      headers: auth(svc),
    });
    expect([401, 403]).toContain(svcRes.statusCode);
  });

  it("caregiver role can browse catalog (any valid session)", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/medicine-catalog",
      headers: auth(await token("Caregiver", CAREGIVER_ID)),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("photo pipeline", () => {
  async function seededEntry() {
    const res = await createEntry({
      brandName: `PhotoMed-${Math.random().toString(36).slice(2, 8)}`,
    });
    return j(res);
  }

  it("issue → registry row + presign shape; confirm → slot upsert + DTO URL", async () => {
    const entry = await seededEntry();
    const issue = await t.app.inject({
      method: "POST",
      url: `/v1/medicine-catalog/${entry.id}/photos`,
      headers: auth(await token()),
      payload: { slot: "A" },
    });
    expect(issue.statusCode).toBe(200);
    const issued = j(issue);
    expect(issued.photoKey).toMatch(
      new RegExp(`^catalog/${entry.id}/A/[0-9a-f-]{36}$`),
    );
    expect(issued.uploadUrl).toContain("https://r2.test/put/");
    expect(issued.expiresAt).toBeTruthy();

    const reg = await t.servicePg.query<{ confirmed_at: string | null }>(
      `SELECT confirmed_at FROM catalog_photo_keys WHERE photo_key=$1`,
      [issued.photoKey],
    );
    expect(reg.rows[0].confirmed_at).toBeNull();

    const confirm = await t.app.inject({
      method: "PUT",
      url: `/v1/medicine-catalog/${entry.id}/photos/A`,
      headers: auth(await token()),
      payload: { photoKey: issued.photoKey },
    });
    expect(confirm.statusCode).toBe(200);
    const dto = j(confirm);
    expect(dto.photos.A).toBe(`https://photos.test/${issued.photoKey}`);
    // gap-fill: B and C fall back to A
    expect(dto.photos.B).toBe(dto.photos.A);
    expect(dto.photos.C).toBe(dto.photos.A);

    const reg2 = await t.servicePg.query<{ confirmed_at: string | null }>(
      `SELECT confirmed_at FROM catalog_photo_keys WHERE photo_key=$1`,
      [issued.photoKey],
    );
    expect(reg2.rows[0].confirmed_at).not.toBeNull();
    expect(t.r2Stub.verifyCalls).toContain(issued.photoKey);
  });

  it("gap-fill: B stored → C falls to B, A stays null", async () => {
    const entry = await seededEntry();
    const issue = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/medicine-catalog/${entry.id}/photos`,
        headers: auth(await token()),
        payload: { slot: "B" },
      }),
    );
    const confirm = j(
      await t.app.inject({
        method: "PUT",
        url: `/v1/medicine-catalog/${entry.id}/photos/B`,
        headers: auth(await token()),
        payload: { photoKey: issue.photoKey },
      }),
    );
    expect(confirm.photos.A).toBeNull();
    expect(confirm.photos.B).toBe(`https://photos.test/${issue.photoKey}`);
    expect(confirm.photos.C).toBe(confirm.photos.B);
  });

  it("foreign key (different entry) → uniform 403", async () => {
    const e1 = await seededEntry();
    const e2 = await seededEntry();
    const issue = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/medicine-catalog/${e1.id}/photos`,
        headers: auth(await token()),
        payload: { slot: "A" },
      }),
    );
    const res = await t.app.inject({
      method: "PUT",
      url: `/v1/medicine-catalog/${e2.id}/photos/A`,
      headers: auth(await token()),
      payload: { photoKey: issue.photoKey },
    });
    expect(res.statusCode).toBe(403);
  });

  it("wrong slot for issued key → 403; unknown key → 403", async () => {
    const entry = await seededEntry();
    const issue = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/medicine-catalog/${entry.id}/photos`,
        headers: auth(await token()),
        payload: { slot: "A" },
      }),
    );
    const wrongSlot = await t.app.inject({
      method: "PUT",
      url: `/v1/medicine-catalog/${entry.id}/photos/C`,
      headers: auth(await token()),
      payload: { photoKey: issue.photoKey },
    });
    expect(wrongSlot.statusCode).toBe(403);
    const unknown = await t.app.inject({
      method: "PUT",
      url: `/v1/medicine-catalog/${entry.id}/photos/A`,
      headers: auth(await token()),
      payload: { photoKey: "catalog/fake/key" },
    });
    expect(unknown.statusCode).toBe(403);
  });

  it("R2 verify false → 503, slot unchanged, registry stays unconfirmed", async () => {
    const entry = await seededEntry();
    const issue = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/medicine-catalog/${entry.id}/photos`,
        headers: auth(await token()),
        payload: { slot: "A" },
      }),
    );
    t.r2Stub.setVerify(async () => false);
    const res = await t.app.inject({
      method: "PUT",
      url: `/v1/medicine-catalog/${entry.id}/photos/A`,
      headers: auth(await token()),
      payload: { photoKey: issue.photoKey },
    });
    expect(res.statusCode).toBe(503);
    expect(j(res).error.code).toBe("DEPENDENCY_UNAVAILABLE");
    const detail = j(
      await t.app.inject({
        method: "GET",
        url: `/v1/medicine-catalog/${entry.id}`,
        headers: auth(await token()),
      }),
    );
    expect(detail.photos.A).toBeNull();
    const reg = await t.servicePg.query<{ confirmed_at: string | null }>(
      `SELECT confirmed_at FROM catalog_photo_keys WHERE photo_key=$1`,
      [issue.photoKey],
    );
    expect(reg.rows[0].confirmed_at).toBeNull();
    t.r2Stub.setVerify(async () => true);
  });

  it("R2 verify throws → 503 fail closed", async () => {
    const entry = await seededEntry();
    const issue = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/medicine-catalog/${entry.id}/photos`,
        headers: auth(await token()),
        payload: { slot: "A" },
      }),
    );
    t.r2Stub.setVerify(async () => {
      throw new Error("r2 down");
    });
    const res = await t.app.inject({
      method: "PUT",
      url: `/v1/medicine-catalog/${entry.id}/photos/A`,
      headers: auth(await token()),
      payload: { photoKey: issue.photoKey },
    });
    expect(res.statusCode).toBe(503);
    t.r2Stub.setVerify(async () => true);
  });

  it("re-confirm same key → 200 idempotent; slot replace → new key wins", async () => {
    const entry = await seededEntry();
    const issue1 = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/medicine-catalog/${entry.id}/photos`,
        headers: auth(await token()),
        payload: { slot: "A" },
      }),
    );
    const c1 = j(
      await t.app.inject({
        method: "PUT",
        url: `/v1/medicine-catalog/${entry.id}/photos/A`,
        headers: auth(await token()),
        payload: { photoKey: issue1.photoKey },
      }),
    );
    expect(c1.photos.A).toContain(issue1.photoKey);
    // idempotent re-confirm
    const again = await t.app.inject({
      method: "PUT",
      url: `/v1/medicine-catalog/${entry.id}/photos/A`,
      headers: auth(await token()),
      payload: { photoKey: issue1.photoKey },
    });
    expect(again.statusCode).toBe(200);
    // replace with second issued key
    const issue2 = j(
      await t.app.inject({
        method: "POST",
        url: `/v1/medicine-catalog/${entry.id}/photos`,
        headers: auth(await token()),
        payload: { slot: "A" },
      }),
    );
    const c2 = j(
      await t.app.inject({
        method: "PUT",
        url: `/v1/medicine-catalog/${entry.id}/photos/A`,
        headers: auth(await token()),
        payload: { photoKey: issue2.photoKey },
      }),
    );
    expect(c2.photos.A).toBe(`https://photos.test/${issue2.photoKey}`);
  });

  it("issue on unknown entry → 404; bad slot → 400", async () => {
    const missing = await t.app.inject({
      method: "POST",
      url: "/v1/medicine-catalog/99999999-9999-4999-8999-999999999999/photos",
      headers: auth(await token()),
      payload: { slot: "A" },
    });
    expect(missing.statusCode).toBe(404);
    const entry = await seededEntry();
    const bad = await t.app.inject({
      method: "POST",
      url: `/v1/medicine-catalog/${entry.id}/photos`,
      headers: auth(await token()),
      payload: { slot: "Z" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
