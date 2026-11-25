import type { Db } from "@infrastructure/Persistence/db.js";
import { createPatientMedicinesRepo } from "@infrastructure/Persistence/repositories.js";
import type { Metrics } from "@core/metrics.js";
import type { CheckLinkCache } from "@infrastructure/AuthzClient/checkLink.js";

// LLD §8.11 — single tx purge; catalog untouched; no Medicine event emitted.
// Post-commit: positive-only check-link cache entries involving userId purged.
// Idempotent — redelivery finds no rows.
export async function handleAccountDeleted(
  deps: { db: Db; checkLinkCache: CheckLinkCache; metrics?: Metrics },
  event: { userId: string },
): Promise<void> {
  const repo = createPatientMedicinesRepo();
  await deps.db.transaction(async (tx) => {
    await repo.deleteByPatientId(tx, event.userId);
  });
  deps.checkLinkCache.invalidateForUser(event.userId);
  deps.metrics?.incr("medo_medicine_accountdeleted_processed_total");
}
