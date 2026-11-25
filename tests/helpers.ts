import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { generateKeyPair, exportJWK, SignJWT, importJWK } from "jose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Queryable } from "@kiro-ai-bit/eventing";
import * as schema from "@infrastructure/Persistence/schema/index.js";
import type { Db } from "@infrastructure/Persistence/db.js";
import { buildApp, type AppConfig, type BuiltApp } from "@webapi/bootstrap.js";
import type { JWK } from "jose";
import type { R2Client } from "@infrastructure/R2Client/r2.js";

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

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

export interface TestKeys {
  identityPrivateJwk: JWK; // signs USER tokens (iss=medo-identity)
  identityPublicJwk: JWK;
  medicineServicePrivateJwk: JWK; // medo-medicine outbound service JWTs
  peerServicePublicJwkByIss: Record<string, JWK[]>; // inbound service auth
}

export async function makeKeys(): Promise<TestKeys> {
  const ident = await generateKeyPair("ES256", { extractable: true });
  const svc = await generateKeyPair("ES256", { extractable: true });
  const ip = (await exportJWK(ident.publicKey)) as JWK;
  const is = (await exportJWK(ident.privateKey)) as JWK;
  const cp = (await exportJWK(svc.publicKey)) as JWK;
  const cs = (await exportJWK(svc.privateKey)) as JWK;
  for (const k of [ip, is, cp, cs]) {
    k.kid = "test-kid";
    k.alg = "ES256";
    k.use = "sig";
  }
  return {
    identityPrivateJwk: is,
    identityPublicJwk: ip,
    medicineServicePrivateJwk: cs,
    peerServicePublicJwkByIss: {
      "medo-identity": [cp],
      "medo-care": [cp],
      "medo-schedule-dose": [cp],
      "medo-notification": [cp],
      "medo-gamification": [cp],
    },
  };
}

export function makeConfig(
  keys: TestKeys,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    databaseUrl: "pglite://",
    brokerDatabaseUrl: "pglite://",
    servicePublicKeys: keys.peerServicePublicJwkByIss,
    identityJwksUrl: "http://identity.test/.well-known/jwks.json",
    r2: {
      endpoint: "https://r2.test",
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      bucketName: "medo-photos-test",
      publicBaseUrl: "https://photos.test",
    },
    sentryDsn: "",
    ...overrides,
  };
}

// R2 stub — records presigns, verify behavior scriptable per test.
export interface R2Stub extends R2Client {
  presigned: string[];
  verifyCalls: string[];
  setVerify: (fn: (key: string) => Promise<boolean>) => void;
}

export function makeR2Stub(): R2Stub {
  const presigned: string[] = [];
  const verifyCalls: string[] = [];
  let verifyFn: (key: string) => Promise<boolean> = async () => true;
  return {
    presigned,
    verifyCalls,
    setVerify(fn) {
      verifyFn = fn;
    },
    async createPresignedPut(photoKey: string) {
      presigned.push(photoKey);
      return {
        url: `https://r2.test/put/${photoKey}?sig=test`,
        expiresAt: new Date(Date.now() + 900_000),
      };
    },
    async verifyObjectExists(photoKey: string) {
      verifyCalls.push(photoKey);
      return verifyFn(photoKey);
    },
    publicPhotoUrl(photoKey: string) {
      return `https://photos.test/${photoKey}`;
    },
  };
}

export interface TestApp extends BuiltApp {
  servicePg: PGlite;
  brokerPg: PGlite;
  config: AppConfig;
  keys: TestKeys;
  r2Stub: R2Stub;
  closeAll: () => Promise<void>;
}

// Stub fetch: JWKS URL → identity public JWK.
function makeFetchStub(keys: TestKeys): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/.well-known/jwks.json")) {
      return new Response(JSON.stringify({ keys: [keys.identityPublicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export async function createTestApp(
  opts: {
    configOverrides?: Partial<AppConfig>;
    startWorkers?: boolean;
  } = {},
): Promise<TestApp> {
  const keys = await makeKeys();
  const config = makeConfig(keys, opts.configOverrides);
  const fetchImpl = makeFetchStub(keys);
  const servicePg = new PGlite();
  const brokerPg = new PGlite();
  const serviceDb = drizzlePglite(servicePg, { schema });
  await migratePglite(serviceDb, { migrationsFolder: MIGRATIONS });
  const db = serviceDb as unknown as Db;
  const r2Stub = makeR2Stub();
  const built = await buildApp({
    config,
    db,
    medicineQueryable: wrap(servicePg),
    brokerQueryable: wrap(brokerPg),
    rateLimitOptions: {
      limits: { public: 100000, write: 100000, read: 100000 },
    },
    startWorkers: opts.startWorkers ?? false,
    fetchImpl,
    r2Client: r2Stub,
  });
  return {
    ...built,
    servicePg,
    brokerPg,
    config,
    keys,
    r2Stub,
    closeAll: async () => {
      await built.close();
      await servicePg.close();
      await brokerPg.close();
    },
  };
}

// Mint a USER JWT as Identity would (iss=medo-identity, aud=medo).
export async function mintUserToken(
  keys: TestKeys,
  opts: { sub: string; role: "Patient" | "Caregiver"; sid?: string },
): Promise<string> {
  const key = await importJWK(keys.identityPrivateJwk, "ES256");
  return new SignJWT({ role: opts.role, sid: opts.sid ?? "sess-1" })
    .setProtectedHeader({ alg: "ES256", kid: "test-kid", typ: "JWT" })
    .setIssuer("medo-identity")
    .setAudience("medo")
    .setSubject(opts.sub)
    .setIssuedAt()
    .setExpirationTime("25m")
    .sign(key as CryptoKey);
}

// Mint a SERVICE JWT as a peer caller (aud=medo-medicine by default).
export async function mintPeerServiceToken(
  keys: TestKeys,
  opts: { iss?: string; aud?: string } = {},
): Promise<string> {
  const key = await importJWK(keys.medicineServicePrivateJwk, "ES256");
  return new SignJWT({ role: "service" })
    .setProtectedHeader({ alg: "ES256", kid: "test-kid", typ: "JWT" })
    .setIssuer(opts.iss ?? "medo-care")
    .setAudience(opts.aud ?? "medo-medicine")
    .setSubject("svc-test")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key as CryptoKey);
}

export const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
export const CAREGIVER_ID = "22222222-2222-4222-8222-222222222222";
