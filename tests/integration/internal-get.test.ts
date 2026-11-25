import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  PATIENT_ID,
  adoptMedicine,
  auth,
  createTestApp,
  j,
  mintPeerServiceToken,
  mintUserToken,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.closeAll());

async function token(sub = PATIENT_ID) {
  return mintUserToken(t.keys, { sub, role: "Patient" });
}

describe("GET /v1/medicines/{id} — dual surface", () => {
  it("service-JWT caller → 200 identical DTO, no check-link call", async () => {
    const med = await adoptMedicine(t);
    t.careStub.calls.length = 0;
    const svcTok = await mintPeerServiceToken(t.keys, {
      iss: "medo-notification",
    });
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/medicines/${med.id}`,
      headers: auth(svcTok),
    });
    expect(res.statusCode).toBe(200);
    const body = j(res);
    expect(body.id).toBe(med.id);
    expect(body.catalog.brandName).toBeTruthy();
    expect(body.dosesRemaining).toBe(10);
    // internal read must NOT consult Care check-link
    expect(t.careStub.calls).toHaveLength(0);
  });

  it("user JWT still works (public path, check-link authz)", async () => {
    const med = await adoptMedicine(t);
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/medicines/${med.id}`,
      headers: auth(await token()),
    });
    expect(res.statusCode).toBe(200);
    expect(j(res).id).toBe(med.id);
  });

  it("service token wrong aud → 403; unknown id → 404", async () => {
    const med = await adoptMedicine(t);
    const wrongAud = await mintPeerServiceToken(t.keys, { aud: "medo-care" });
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/medicines/${med.id}`,
      headers: auth(wrongAud),
    });
    expect(res.statusCode).toBe(403);

    const svcTok = await mintPeerServiceToken(t.keys);
    const missing = await t.app.inject({
      method: "GET",
      url: "/v1/medicines/99999999-9999-4999-8999-999999999999",
      headers: auth(svcTok),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("service token rejected on user-only routes; no token → 401", async () => {
    const med = await adoptMedicine(t);
    const svcTok = await mintPeerServiceToken(t.keys);
    const list = await t.app.inject({
      method: "GET",
      url: `/v1/medicines?patientId=${PATIENT_ID}`,
      headers: auth(svcTok),
    });
    expect(list.statusCode).toBe(401);
    const catalog = await t.app.inject({
      method: "GET",
      url: "/v1/medicine-catalog",
      headers: auth(svcTok),
    });
    expect(catalog.statusCode).toBe(401);

    const noAuth = await t.app.inject({
      method: "GET",
      url: `/v1/medicines/${med.id}`,
    });
    expect(noAuth.statusCode).toBe(401);
  });
});
