import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import {
  rateLimitPlugin,
  type RateLimitOptions,
} from "@kiro-ai-bit/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { JWK } from "jose";
import type { Db } from "@infrastructure/Persistence/db.js";
import type { Queryable } from "@kiro-ai-bit/eventing";
import type { PublisherHandle } from "@kiro-ai-bit/eventing";
import {
  ensureMedicineEventing,
  startMedicinePublisher,
} from "@infrastructure/Eventing/index.js";
import { createJwksCache } from "@infrastructure/AuthzClient/jwks.js";
import {
  createR2Client,
  type R2Client,
  type R2Config,
} from "@infrastructure/R2Client/r2.js";
import { registerErrorHandler } from "./Middleware/errors.js";
import { registerAuthn } from "./Middleware/authn.js";
import {
  createMetrics,
  registerRedHook,
  type MetricsImpl,
} from "./Middleware/metrics.js";
import { registerCatalogRoutes } from "./Public/routes.js";
import { registerMedicineRoutes } from "./Public/medicines.js";
import { registerPlatformRoutes } from "./Platform/routes.js";
import { createServiceTokenMinter } from "@infrastructure/AuthzClient/serviceToken.js";
import {
  createCachedCheckLink,
  createCareCheckLinkClient,
  type CheckLinkCache,
} from "@infrastructure/AuthzClient/checkLink.js";
import { createScheduleDoseClient } from "@infrastructure/ScheduleDoseClient/hasDoseRecords.js";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BROKER_DATABASE_URL: z.string().min(1),
  SERVICE_PUBLIC_KEYS: z.string().min(1),
  SERVICE_PRIVATE_KEY: z.string().min(1),
  IDENTITY_JWKS_URL: z.string().min(1),
  CARE_SERVICE_URL: z.string().min(1),
  SCHEDULE_DOSE_SERVICE_URL: z.string().min(1),
  R2_ENDPOINT: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  R2_PUBLIC_BASE_URL: z.string().min(1),
  SENTRY_DSN: z.string().optional().default(""),
  PORT: z.coerce.number().int().positive().default(3003),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export interface AppConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  databaseUrl: string;
  brokerDatabaseUrl: string;
  servicePublicKeys: Record<string, JWK[]>;
  servicePrivateKey: JWK;
  identityJwksUrl: string;
  careServiceUrl: string;
  scheduleDoseServiceUrl: string;
  r2: R2Config;
  sentryDsn: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = envSchema.parse(env);
  return {
    port: e.PORT,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    brokerDatabaseUrl: e.BROKER_DATABASE_URL,
    servicePublicKeys: JSON.parse(e.SERVICE_PUBLIC_KEYS) as Record<
      string,
      JWK[]
    >,
    servicePrivateKey: JSON.parse(e.SERVICE_PRIVATE_KEY) as JWK,
    identityJwksUrl: e.IDENTITY_JWKS_URL,
    careServiceUrl: e.CARE_SERVICE_URL,
    scheduleDoseServiceUrl: e.SCHEDULE_DOSE_SERVICE_URL,
    r2: {
      endpoint: e.R2_ENDPOINT,
      accessKeyId: e.R2_ACCESS_KEY_ID,
      secretAccessKey: e.R2_SECRET_ACCESS_KEY,
      bucketName: e.R2_BUCKET_NAME,
      publicBaseUrl: e.R2_PUBLIC_BASE_URL,
    },
    sentryDsn: e.SENTRY_DSN,
  };
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  medicineQueryable: Queryable;
  brokerQueryable: Queryable;
  brokerDsn?: string;
  rateLimitOptions?: RateLimitOptions;
  startWorkers?: boolean;
  fetchImpl?: typeof fetch;
  r2Client?: R2Client;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: Db;
  metrics: MetricsImpl;
  r2: R2Client;
  checkLinkCache: CheckLinkCache;
  publisher?: PublisherHandle;
  close: () => Promise<void>;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { config } = deps;
  if (config.sentryDsn) {
    Sentry.init({ dsn: config.sentryDsn, environment: config.nodeEnv });
  }

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && h.length > 0 ? h : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", String(request.id));
  });

  registerErrorHandler(app);

  const metrics = createMetrics();
  registerRedHook(app, metrics);

  const jwks = createJwksCache({
    jwksUrl: config.identityJwksUrl,
    fetchImpl: deps.fetchImpl,
  });
  const r2 = deps.r2Client ?? createR2Client(config.r2);

  // authN guard hook must run before rate-limit preHandler (rate-limit pkg contract)
  registerAuthn(app, {
    jwks,
    userIssuer: "medo-identity",
    userAudience: "medo",
    servicePublicKeys: config.servicePublicKeys,
    serviceAudience: "medo-medicine",
  });
  await app.register(rateLimitPlugin, deps.rateLimitOptions ?? {});

  const catalogDeps = { db: deps.db, r2, metrics };
  registerCatalogRoutes(app, catalogDeps);

  const mintServiceToken = createServiceTokenMinter(config.servicePrivateKey);
  const checkLinkClient = createCachedCheckLink(
    createCareCheckLinkClient({
      baseUrl: config.careServiceUrl,
      mintServiceToken,
      fetchImpl: deps.fetchImpl,
    }),
  );
  const scheduleDoseClient = createScheduleDoseClient({
    baseUrl: config.scheduleDoseServiceUrl,
    mintServiceToken,
    fetchImpl: deps.fetchImpl,
  });
  registerMedicineRoutes(app, {
    db: deps.db,
    r2,
    checkLink: checkLinkClient.checkLink,
    hasDoseRecords: (patientId) => scheduleDoseClient.hasDoseRecords(patientId),
    metrics,
  });
  registerPlatformRoutes(app, {
    db: deps.db,
    broker: deps.brokerQueryable,
    metrics,
  });

  await ensureMedicineEventing({
    service: deps.medicineQueryable,
    broker: deps.brokerQueryable,
  });

  const publisher = deps.startWorkers
    ? await startMedicinePublisher({
        service: deps.medicineQueryable,
        broker: deps.brokerQueryable,
        brokerDsn: deps.brokerDsn,
        logger: { error: (m, meta) => app.log.error({ meta }, m) },
      })
    : undefined;

  return {
    app,
    db: deps.db,
    metrics,
    r2,
    checkLinkCache: checkLinkClient.cache,
    publisher,
    close: async () => {
      if (publisher) await publisher.stop();
      await app.close();
    },
  };
}
