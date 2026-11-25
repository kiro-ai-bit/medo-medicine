import type {
  CreateMedicineRequest,
  PatchMedicineRequest,
  PatientMedicineDetailDto,
  PatientMedicineSummaryDto,
} from "@kiro-ai-bit/contracts";
import type { Db, DbTx } from "@infrastructure/Persistence/db.js";
import {
  createCatalogEntriesRepo,
  createCatalogPhotosRepo,
  createPatientMedicinesRepo,
  type PatientMedicinePatch,
} from "@infrastructure/Persistence/repositories.js";
import type {
  PatientMedicineRow,
  PhotoSlot,
} from "@infrastructure/Persistence/schema/index.js";
import type { R2Client } from "@infrastructure/R2Client/r2.js";
import { appendOutbox } from "@infrastructure/Persistence/outbox.js";
import { resolvePhotoSlots } from "@core/Catalog/catalog.js";
import {
  ConflictError,
  DependencyError,
  ForbiddenError,
  NotFoundError,
} from "@core/errors.js";
import type { Metrics } from "@core/metrics.js";
import type { UserClaims } from "@core/types.js";

export interface MedicineDeps {
  db: Db;
  r2: R2Client;
  // Care check-link (positive-cached read-through) — throws DependencyError.
  checkLink: (patientId: string, caregiverId: string) => Promise<boolean>;
  // Schedule&Dose has-dose-records — throws DependencyError (fail-closed).
  hasDoseRecords: (patientId: string) => Promise<boolean>;
  metrics?: Metrics;
}

// §4.6/§11 — self (sub == patientId) or linked caregiver via check-link;
// check-link failure → DependencyError (fail-closed deny on caregiver calls).
async function authorizePatientAccess(
  deps: MedicineDeps,
  patientId: string,
  actor: UserClaims,
): Promise<void> {
  if (actor.sub === patientId) return;
  let active: boolean;
  try {
    active = await deps.checkLink(patientId, actor.sub);
  } catch {
    throw new DependencyError("care check-link unavailable");
  }
  if (!active) throw new ForbiddenError("no active care link");
}

// §8.7 arm-state machine — pure transition; flags persisted + outbox in same tx.
export interface RefillTransition {
  // deepest qualifying threshold to emit, or null
  threshold: 6 | 0 | null;
  refillLowArmed: boolean;
  refillOutArmed: boolean;
}

export function computeRefillTransition(
  lowArmed: boolean,
  outArmed: boolean,
  v: number,
): RefillTransition {
  const lowFire = v <= 6 && lowArmed;
  const outFire = v === 0 && outArmed;
  return {
    threshold: outFire ? 0 : lowFire ? 6 : null,
    refillLowArmed: v > 6 ? true : lowFire ? false : lowArmed,
    refillOutArmed: v > 0 ? true : outFire ? false : outArmed,
  };
}

async function appendRefillEvent(
  tx: DbTx,
  medicineId: string,
  patientId: string,
  dosesRemaining: number,
  threshold: 6 | 0,
): Promise<void> {
  await appendOutbox(tx, {
    type: "RefillThresholdCrossed",
    payload: { medicineId, patientId, dosesRemaining, threshold },
  });
}

type CatalogView = {
  brandName: string;
  form: PatientMedicineSummaryDto["catalog"]["form"];
  packagingQuantity: number;
  photos: { A: string | null; B: string | null; C: string | null };
};

async function catalogViews(
  deps: MedicineDeps,
  entryIds: string[],
): Promise<Map<string, CatalogView>> {
  const entriesRepo = createCatalogEntriesRepo(deps.db);
  const photosRepo = createCatalogPhotosRepo(deps.db);
  const entries = await entriesRepo.findByIds(entryIds);
  const slotsByEntry = await photosRepo.findSlotsByEntries(entryIds);
  const out = new Map<string, CatalogView>();
  for (const e of entries) {
    const confirmed = new Map<PhotoSlot, string>();
    const slotMap = slotsByEntry.get(e.id);
    if (slotMap) {
      for (const [k, v] of slotMap) confirmed.set(k as PhotoSlot, v);
    }
    out.set(e.id, {
      brandName: e.brandName,
      form: e.form as CatalogView["form"],
      packagingQuantity: e.packagingQuantity,
      photos: resolveSlots(deps, confirmed),
    });
  }
  return out;
}

function resolveSlots(
  deps: MedicineDeps,
  confirmed: Map<PhotoSlot, string>,
): CatalogView["photos"] {
  // local r2 public URL composition lives in catalog deps; medicine deps carry r2 too
  return resolvePhotoSlots(confirmed, (k) => deps.r2.publicPhotoUrl(k));
}

function toSummaryDto(
  row: PatientMedicineRow,
  catalog: CatalogView,
): PatientMedicineSummaryDto {
  return {
    id: row.id,
    patientId: row.patientId,
    catalogEntryId: row.catalogEntryId,
    catalog,
    prescribingDoctor: row.prescribingDoctor,
    dosage: row.dosage,
    dosesRemaining: row.dosesRemaining,
    price: row.price,
    pharmacyName: row.pharmacyName,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDetailDto(
  row: PatientMedicineRow,
  catalog: CatalogView,
): PatientMedicineDetailDto {
  return {
    ...toSummaryDto(row, catalog),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

async function detailDto(
  deps: MedicineDeps,
  row: PatientMedicineRow,
): Promise<PatientMedicineDetailDto> {
  const views = await catalogViews(deps, [row.catalogEntryId]);
  const catalog = views.get(row.catalogEntryId);
  if (!catalog) throw new NotFoundError("catalog entry not found");
  return toDetailDto(row, catalog);
}

// GET /v1/medicines?patientId= — archived excluded (FR-MED-013b).
export async function listMedicines(
  deps: MedicineDeps,
  patientId: string,
  actor: UserClaims,
): Promise<{ medicines: PatientMedicineSummaryDto[] }> {
  await authorizePatientAccess(deps, patientId, actor);
  const repo = createPatientMedicinesRepo();
  const rows = (await repo.listByPatient(deps.db, patientId)).filter(
    (r) => r.archivedAt === null,
  );
  const views = await catalogViews(
    deps,
    rows.map((r) => r.catalogEntryId),
  );
  const medicines = rows.map((row) => {
    const catalog = views.get(row.catalogEntryId);
    if (!catalog) throw new NotFoundError("catalog entry not found");
    return toSummaryDto(row, catalog);
  });
  return { medicines };
}

// POST /v1/medicines — adopt; ≥1 confirmed photo guard; arm eval on initial v.
export async function createMedicine(
  deps: MedicineDeps,
  cmd: CreateMedicineRequest,
  actor: UserClaims,
): Promise<PatientMedicineDetailDto> {
  await authorizePatientAccess(deps, cmd.patientId, actor);

  const entriesRepo = createCatalogEntriesRepo(deps.db);
  const photosRepo = createCatalogPhotosRepo(deps.db);
  const entry = await entriesRepo.findById(cmd.catalogEntryId);
  if (!entry) throw new NotFoundError("catalog entry not found");
  const confirmed = await photosRepo.confirmedSlotCount(entry.id);
  if (confirmed === 0) {
    throw new ConflictError("catalog entry has no confirmed photos");
  }

  const repo = createPatientMedicinesRepo();
  const transition = computeRefillTransition(true, true, cmd.dosesRemaining);
  const row = await deps.db.transaction(async (tx) => {
    const inserted = await repo.insert(tx, {
      patientId: cmd.patientId,
      catalogEntryId: cmd.catalogEntryId,
      prescribingDoctor: cmd.prescribingDoctor,
      dosage: cmd.dosage,
      dosesRemaining: cmd.dosesRemaining,
      price: cmd.price,
      pharmacyName: cmd.pharmacyName,
      refillLowArmed: transition.refillLowArmed,
      refillOutArmed: transition.refillOutArmed,
    });
    if (transition.threshold !== null) {
      await appendRefillEvent(
        tx,
        inserted.id,
        inserted.patientId,
        cmd.dosesRemaining,
        transition.threshold,
      );
    }
    return inserted;
  });
  deps.metrics?.incr("medo_medicine_medicines_total", { action: "created" });
  if (transition.threshold !== null) {
    deps.metrics?.incr("medo_medicine_refill_events_total", {
      threshold: String(transition.threshold),
    });
  }
  return detailDto(deps, row);
}

// GET /v1/medicines/{id} — archived records resolve (FR-MED-014).
export async function getMedicine(
  deps: MedicineDeps,
  medicineId: string,
  actor: UserClaims,
): Promise<PatientMedicineDetailDto> {
  const repo = createPatientMedicinesRepo();
  const row = await repo.findById(deps.db, medicineId);
  if (!row) throw new NotFoundError("medicine not found");
  await authorizePatientAccess(deps, row.patientId, actor);
  return detailDto(deps, row);
}

// PATCH /v1/medicines/{id} — archived → 409 (LD-MED-09); dosesRemaining change
// runs the same arm-state eval as the event path (§8.8).
export async function editMedicine(
  deps: MedicineDeps,
  medicineId: string,
  patch: PatchMedicineRequest,
  actor: UserClaims,
): Promise<PatientMedicineDetailDto> {
  const repo = createPatientMedicinesRepo();
  const row = await repo.findById(deps.db, medicineId);
  if (!row) throw new NotFoundError("medicine not found");
  await authorizePatientAccess(deps, row.patientId, actor);
  if (row.archivedAt !== null) {
    throw new ConflictError("medicine is archived");
  }

  const countChanged =
    patch.dosesRemaining !== undefined &&
    patch.dosesRemaining !== row.dosesRemaining;
  const transition = countChanged
    ? computeRefillTransition(
        row.refillLowArmed,
        row.refillOutArmed,
        patch.dosesRemaining as number,
      )
    : null;

  const fields: PatientMedicinePatch = {};
  if (patch.prescribingDoctor !== undefined)
    fields.prescribingDoctor = patch.prescribingDoctor;
  if (patch.dosage !== undefined) fields.dosage = patch.dosage;
  if (patch.dosesRemaining !== undefined)
    fields.dosesRemaining = patch.dosesRemaining;
  if (patch.price !== undefined) fields.price = patch.price;
  if (patch.pharmacyName !== undefined)
    fields.pharmacyName = patch.pharmacyName;
  if (transition) {
    fields.refillLowArmed = transition.refillLowArmed;
    fields.refillOutArmed = transition.refillOutArmed;
  }

  const updated = await deps.db.transaction(async (tx) => {
    const u = await repo.updateFields(tx, medicineId, fields);
    if (!u) throw new NotFoundError("medicine not found");
    if (transition?.threshold != null) {
      await appendRefillEvent(
        tx,
        u.id,
        u.patientId,
        u.dosesRemaining,
        transition.threshold,
      );
    }
    return u;
  });
  deps.metrics?.incr("medo_medicine_medicines_total", { action: "edited" });
  if (transition?.threshold != null) {
    deps.metrics?.incr("medo_medicine_refill_events_total", {
      threshold: String(transition.threshold),
    });
  }
  return detailDto(deps, updated);
}

// POST /v1/medicines/{id}/archive — conditional UPDATE terminal guard (§8.9).
export async function archiveMedicine(
  deps: MedicineDeps,
  medicineId: string,
  actor: UserClaims,
): Promise<{ id: string; archivedAt: string }> {
  const repo = createPatientMedicinesRepo();
  const row = await repo.findById(deps.db, medicineId);
  if (!row) throw new NotFoundError("medicine not found");
  await authorizePatientAccess(deps, row.patientId, actor);

  const result = await deps.db.transaction(async (tx) => {
    const archived = await repo.markArchived(tx, medicineId);
    if (archived) {
      await appendOutbox(tx, {
        type: "MedicineArchived",
        payload: { medicineId: archived.id, patientId: archived.patientId },
      });
      return { id: archived.id, archivedAt: archived.archivedAt };
    }
    // already archived → success no-op; vanished → NotFound
    const existing = await repo.findById(tx, medicineId);
    if (!existing) throw new NotFoundError("medicine not found");
    return { id: existing.id, archivedAt: existing.archivedAt };
  });
  if (!result.archivedAt) throw new NotFoundError("medicine not found");
  deps.metrics?.incr("medo_medicine_medicines_total", { action: "archived" });
  return {
    id: result.id,
    archivedAt: result.archivedAt.toISOString(),
  };
}

// DELETE /v1/medicines/{id} — pre-tx fail-closed has-dose-records guard (§8.10).
export async function deleteMedicine(
  deps: MedicineDeps,
  medicineId: string,
  actor: UserClaims,
): Promise<{ id: string; deleted: true }> {
  const repo = createPatientMedicinesRepo();
  const row = await repo.findById(deps.db, medicineId);
  if (!row) throw new NotFoundError("medicine not found");
  await authorizePatientAccess(deps, row.patientId, actor);

  let hasRecords: boolean;
  try {
    hasRecords = await deps.hasDoseRecords(row.patientId);
  } catch {
    deps.metrics?.incr("medo_medicine_medicines_total", {
      action: "delete_refused",
    });
    throw new DependencyError("dose-record check unavailable");
  }
  if (hasRecords) {
    deps.metrics?.incr("medo_medicine_medicines_total", {
      action: "delete_refused",
    });
    throw new ConflictError("medicine has dose records — archive instead");
  }

  await deps.db.transaction(async (tx) => {
    await repo.deleteById(tx, medicineId);
  });
  deps.metrics?.incr("medo_medicine_medicines_total", { action: "deleted" });
  return { id: medicineId, deleted: true };
}
