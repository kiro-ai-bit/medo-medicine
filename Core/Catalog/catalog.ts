import { randomUUID } from "node:crypto";
import type {
  CatalogEntryDto,
  CreateCatalogEntryRequest,
  IssuePhotoResponse,
  PatchCatalogEntryRequest,
} from "@kiro-ai-bit/contracts";
import type { Db } from "@infrastructure/Persistence/db.js";
import {
  buildCatalogWhere,
  createCatalogEntriesRepo,
  createCatalogPhotoKeysRepo,
  createCatalogPhotosRepo,
} from "@infrastructure/Persistence/repositories.js";
import type {
  CatalogEntryRow,
  PhotoSlot,
} from "@infrastructure/Persistence/schema/index.js";
import type { R2Client } from "@infrastructure/R2Client/r2.js";
import {
  ConflictError,
  DependencyError,
  ForbiddenError,
  NotFoundError,
} from "@core/errors.js";
import type { Metrics } from "@core/metrics.js";

export const CATALOG_PAGE_SIZE = 20;
export const CATALOG_PAGE_SIZE_MAX = 50;

export interface CatalogDeps {
  db: Db;
  r2: R2Client;
  metrics?: Metrics;
}

// LD-MED-06 — trim + collapse whitespace + lowercase; applied to all catalog
// text at write and to q at read-compare.
export function normalizeCatalogText(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

// Ingredients: normalize each, sort, dedupe → canonical sorted array.
export function normalizeIngredientNames(names: string[]): string[] {
  return [...new Set(names.map(normalizeCatalogText))].sort();
}

async function throwDupConflict(
  deps: CatalogDeps,
  repo: ReturnType<typeof createCatalogEntriesRepo>,
  brandName: string,
  form: string,
  ingredientNames: string[],
): Promise<never> {
  const dup = await repo.findDuplicate(brandName, form, ingredientNames);
  deps.metrics?.incr("medo_medicine_catalog_total", { action: "dup_conflict" });
  throw new ConflictError("duplicate catalog entry", {
    existingEntryId: dup?.id ?? null,
  });
}

function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === "23505";
}

// §8.2 gap-fill — A→A, B→B??A, C→C??B??A; values are public R2 URLs.
export function resolvePhotoSlots(
  confirmed: Map<PhotoSlot, string> | undefined,
  publicUrl: (key: string) => string,
): { A: string | null; B: string | null; C: string | null } {
  const key = (slot: PhotoSlot): string | null => confirmed?.get(slot) ?? null;
  const a = key("A");
  const b = key("B") ?? a;
  const c = key("C") ?? key("B") ?? a;
  return {
    A: a ? publicUrl(a) : null,
    B: b ? publicUrl(b) : null,
    C: c ? publicUrl(c) : null,
  };
}

function toDto(
  row: CatalogEntryRow,
  photos: { A: string | null; B: string | null; C: string | null },
): CatalogEntryDto {
  return {
    id: row.id,
    brandName: row.brandName,
    ingredientNames: row.ingredientNames,
    form: row.form as CatalogEntryDto["form"],
    packagingQuantity: row.packagingQuantity,
    photos,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function entryDto(
  deps: CatalogDeps,
  row: CatalogEntryRow,
): Promise<CatalogEntryDto> {
  const photosRepo = createCatalogPhotosRepo(deps.db);
  const slots = await photosRepo.findSlotsByEntry(row.id);
  const map = new Map<PhotoSlot, string>(
    slots.map((s) => [s.slot as PhotoSlot, s.photoKey]),
  );
  return toDto(
    row,
    resolvePhotoSlots(map, (k) => deps.r2.publicPhotoUrl(k)),
  );
}

// §8.1 browse/search — q ILIKE over brand+ingredients, updated_at DESC paging.
export async function listCatalog(
  deps: CatalogDeps,
  q: string | undefined,
  page: number,
): Promise<{
  entries: CatalogEntryDto[];
  page: number;
  pageSize: number;
  total: number;
}> {
  const normQ = q ? normalizeCatalogText(q) : undefined;
  const where = buildCatalogWhere(
    normQ && normQ.length > 0 ? normQ : undefined,
  );
  const repo = createCatalogEntriesRepo(deps.db);
  const photosRepo = createCatalogPhotosRepo(deps.db);
  const { rows, total } = await repo.search(where, page, CATALOG_PAGE_SIZE);
  const slotsByEntry = await photosRepo.findSlotsByEntries(
    rows.map((r) => r.id),
  );
  const entries = rows.map((row) =>
    toDto(
      row,
      resolvePhotoSlots(slotsByEntry.get(row.id), (k) =>
        deps.r2.publicPhotoUrl(k),
      ),
    ),
  );
  return { entries, page, pageSize: CATALOG_PAGE_SIZE, total };
}

export async function getCatalogEntry(
  deps: CatalogDeps,
  entryId: string,
): Promise<CatalogEntryDto> {
  const repo = createCatalogEntriesRepo(deps.db);
  const row = await repo.findById(entryId);
  if (!row) throw new NotFoundError("catalog entry not found");
  return entryDto(deps, row);
}

// §8.3 — normalized dup-check → insert; unique index closes the race (LD-MED-06).
export async function createCatalogEntry(
  deps: CatalogDeps,
  cmd: CreateCatalogEntryRequest,
): Promise<CatalogEntryDto> {
  const brandName = normalizeCatalogText(cmd.brandName);
  const ingredientNames = normalizeIngredientNames(cmd.ingredientNames);
  const repo = createCatalogEntriesRepo(deps.db);

  const existing = await repo.findDuplicate(
    brandName,
    cmd.form,
    ingredientNames,
  );
  if (existing) {
    deps.metrics?.incr("medo_medicine_catalog_total", {
      action: "dup_conflict",
    });
    throw new ConflictError("duplicate catalog entry", {
      existingEntryId: existing.id,
    });
  }

  let row: CatalogEntryRow;
  try {
    row = await repo.insert({
      brandName,
      ingredientNames,
      form: cmd.form,
      packagingQuantity: cmd.packagingQuantity,
    });
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      await throwDupConflict(deps, repo, brandName, cmd.form, ingredientNames);
    }
    throw err;
  }
  deps.metrics?.incr("medo_medicine_catalog_total", { action: "created" });
  return entryDto(deps, row);
}

// §8.12 — community LWW field edit; photo slots untouched.
export async function editCatalogEntry(
  deps: CatalogDeps,
  entryId: string,
  patch: PatchCatalogEntryRequest,
): Promise<CatalogEntryDto> {
  const repo = createCatalogEntriesRepo(deps.db);
  const row = await repo.findById(entryId);
  if (!row) throw new NotFoundError("catalog entry not found");

  const fields: Parameters<typeof repo.updateFields>[1] = {};
  if (patch.brandName !== undefined)
    fields.brandName = normalizeCatalogText(patch.brandName);
  if (patch.ingredientNames !== undefined)
    fields.ingredientNames = normalizeIngredientNames(patch.ingredientNames);
  if (patch.form !== undefined) fields.form = patch.form;
  if (patch.packagingQuantity !== undefined)
    fields.packagingQuantity = patch.packagingQuantity;

  let updated: CatalogEntryRow | null;
  try {
    updated = await repo.updateFields(entryId, fields);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      const brand = fields.brandName ?? row.brandName;
      const form = fields.form ?? row.form;
      const ings = fields.ingredientNames ?? row.ingredientNames;
      await throwDupConflict(deps, repo, brand, form, ings);
    }
    throw err;
  }
  if (!updated) throw new NotFoundError("catalog entry not found");
  deps.metrics?.incr("medo_medicine_catalog_total", { action: "edited" });
  return entryDto(deps, updated);
}

// §8.4 issue — verify entry → register issued key → presign (local, no R2 call).
export async function issuePhotoKey(
  deps: CatalogDeps,
  entryId: string,
  slot: PhotoSlot,
): Promise<IssuePhotoResponse> {
  const entriesRepo = createCatalogEntriesRepo(deps.db);
  const keysRepo = createCatalogPhotoKeysRepo(deps.db);
  const entry = await entriesRepo.findById(entryId);
  if (!entry) throw new NotFoundError("catalog entry not found");

  const photoKey = `catalog/${entryId}/${slot}/${randomUUID()}`;
  await keysRepo.insertIssued({ entryId, slot, photoKey });
  const presign = await deps.r2.createPresignedPut(photoKey);
  deps.metrics?.incr("medo_medicine_photos_total", { action: "issued" });
  return {
    photoKey,
    uploadUrl: presign.url,
    expiresAt: presign.expiresAt.toISOString(),
  };
}

// §8.4 confirm — registry binding → R2 verify (pre-tx, fail closed) → tx attach.
export async function confirmPhotoKey(
  deps: CatalogDeps,
  entryId: string,
  slot: PhotoSlot,
  photoKey: string,
): Promise<CatalogEntryDto> {
  const entriesRepo = createCatalogEntriesRepo(deps.db);
  const keysRepo = createCatalogPhotoKeysRepo(deps.db);
  const photosRepo = createCatalogPhotosRepo(deps.db);

  const entry = await entriesRepo.findById(entryId);
  if (!entry) throw new NotFoundError("catalog entry not found");

  const reg = await keysRepo.findByKey(photoKey);
  // Uniform 403 — no key-state enumeration (FR-MED-009b).
  if (!reg || reg.entryId !== entryId || reg.slot !== slot) {
    deps.metrics?.incr("medo_medicine_photos_total", { action: "rejected" });
    throw new ForbiddenError("photo key not valid for this entry and slot");
  }

  if (reg.confirmedAt !== null) {
    const current = await photosRepo.slotKey(entryId, slot);
    if (current === photoKey) {
      return entryDto(deps, entry); // idempotent re-confirm
    }
    deps.metrics?.incr("medo_medicine_photos_total", { action: "rejected" });
    throw new ForbiddenError("photo key not valid for this entry and slot");
  }

  let exists: boolean;
  try {
    exists = await deps.r2.verifyObjectExists(photoKey);
  } catch {
    deps.metrics?.incr("medo_medicine_photos_total", {
      action: "verify_failed",
    });
    throw new DependencyError("photo storage unavailable");
  }
  if (!exists) {
    deps.metrics?.incr("medo_medicine_photos_total", {
      action: "verify_failed",
    });
    throw new DependencyError("photo object not found");
  }

  await deps.db.transaction(async (tx) => {
    const keysTx = createCatalogPhotoKeysRepo(tx as unknown as Db);
    const photosTx = createCatalogPhotosRepo(tx as unknown as Db);
    await keysTx.markConfirmed(tx, reg.id);
    await photosTx.upsertSlot(tx, entryId, slot, photoKey);
  });
  deps.metrics?.incr("medo_medicine_photos_total", { action: "confirmed" });
  return entryDto(deps, entry);
}
