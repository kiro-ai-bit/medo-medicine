import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  catalogPhotoKeys,
  catalogPhotos,
  medicineCatalogEntries,
} from "./schema/index.js";
import type {
  CatalogEntryRow,
  CatalogPhotoKeyRow,
  CatalogPhotoRow,
  NewCatalogEntryRow,
  NewCatalogPhotoKeyRow,
  PhotoSlot,
} from "./schema/index.js";
import type { Db, DbTx } from "./db.js";

// Repos bind to any drizzle executor — pass the tx object (cast as Db) for
// in-transaction work; PGlite is single-connection so mixing db+tx deadlocks.

export function createCatalogEntriesRepo(db: Db) {
  return {
    async search(
      where: ReturnType<typeof buildCatalogWhere>,
      page: number,
      pageSize: number,
    ): Promise<{ rows: CatalogEntryRow[]; total: number }> {
      const offset = (page - 1) * pageSize;
      const rows = await db
        .select()
        .from(medicineCatalogEntries)
        .where(where)
        .orderBy(
          desc(medicineCatalogEntries.updatedAt),
          medicineCatalogEntries.id,
        )
        .limit(pageSize)
        .offset(offset);
      const countRows = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(medicineCatalogEntries)
        .where(where);
      return { rows, total: Number(countRows[0]?.c ?? 0) };
    },
    async findById(id: string): Promise<CatalogEntryRow | null> {
      const rows = await db
        .select()
        .from(medicineCatalogEntries)
        .where(eq(medicineCatalogEntries.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
    async insert(entry: NewCatalogEntryRow): Promise<CatalogEntryRow> {
      const rows = await db
        .insert(medicineCatalogEntries)
        .values(entry)
        .returning();
      return rows[0];
    },
    async updateFields(
      id: string,
      fields: Partial<{
        brandName: string;
        ingredientNames: string[];
        form: string;
        packagingQuantity: number;
      }>,
    ): Promise<CatalogEntryRow | null> {
      const rows = await db
        .update(medicineCatalogEntries)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(medicineCatalogEntries.id, id))
        .returning();
      return rows[0] ?? null;
    },
    // Normalized-identity dup check — brand+form narrow, sorted-array equality (LD-MED-06).
    async findDuplicate(
      brandName: string,
      form: string,
      ingredientNames: string[],
    ): Promise<CatalogEntryRow | null> {
      const rows = await db
        .select()
        .from(medicineCatalogEntries)
        .where(
          and(
            eq(medicineCatalogEntries.brandName, brandName),
            eq(medicineCatalogEntries.form, form),
            eq(medicineCatalogEntries.ingredientNames, ingredientNames),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

export type CatalogEntriesRepo = ReturnType<typeof createCatalogEntriesRepo>;

// q → ILIKE '%norm(q)%' over brand_name + ingredient_names text (LD-MED-02).
export function buildCatalogWhere(q: string | undefined) {
  if (!q) return undefined;
  const pattern = `%${q}%`;
  return or(
    ilike(medicineCatalogEntries.brandName, pattern),
    sql`${medicineCatalogEntries.ingredientNames}::text ILIKE ${pattern}`,
  );
}

export function createCatalogPhotosRepo(db: Db) {
  return {
    async findSlotsByEntry(entryId: string): Promise<CatalogPhotoRow[]> {
      return db
        .select()
        .from(catalogPhotos)
        .where(eq(catalogPhotos.entryId, entryId));
    },
    async findSlotsByEntries(
      entryIds: string[],
    ): Promise<Map<string, Map<PhotoSlot, string>>> {
      const out = new Map<string, Map<PhotoSlot, string>>();
      if (entryIds.length === 0) return out;
      const rows = await db
        .select()
        .from(catalogPhotos)
        .where(inArray(catalogPhotos.entryId, entryIds));
      for (const r of rows) {
        let m = out.get(r.entryId);
        if (!m) {
          m = new Map();
          out.set(r.entryId, m);
        }
        m.set(r.slot as PhotoSlot, r.photoKey);
      }
      return out;
    },
    async slotKey(entryId: string, slot: PhotoSlot): Promise<string | null> {
      const rows = await db
        .select({ photoKey: catalogPhotos.photoKey })
        .from(catalogPhotos)
        .where(
          and(eq(catalogPhotos.entryId, entryId), eq(catalogPhotos.slot, slot)),
        )
        .limit(1);
      return rows[0]?.photoKey ?? null;
    },
    async confirmedSlotCount(entryId: string): Promise<number> {
      const rows = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(catalogPhotos)
        .where(eq(catalogPhotos.entryId, entryId));
      return Number(rows[0]?.c ?? 0);
    },
    // Confirm tx: replace prior confirmed key for the slot (LWW, FR-MED-009).
    async upsertSlot(
      tx: DbTx,
      entryId: string,
      slot: PhotoSlot,
      photoKey: string,
    ): Promise<void> {
      await (tx as unknown as Db)
        .insert(catalogPhotos)
        .values({ entryId, slot, photoKey, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [catalogPhotos.entryId, catalogPhotos.slot],
          set: { photoKey, updatedAt: new Date() },
        });
    },
  };
}

export type CatalogPhotosRepo = ReturnType<typeof createCatalogPhotosRepo>;

export function createCatalogPhotoKeysRepo(db: Db) {
  return {
    async insertIssued(
      key: NewCatalogPhotoKeyRow,
    ): Promise<CatalogPhotoKeyRow> {
      const rows = await db.insert(catalogPhotoKeys).values(key).returning();
      return rows[0];
    },
    async findByKey(photoKey: string): Promise<CatalogPhotoKeyRow | null> {
      const rows = await db
        .select()
        .from(catalogPhotoKeys)
        .where(eq(catalogPhotoKeys.photoKey, photoKey))
        .limit(1);
      return rows[0] ?? null;
    },
    async markConfirmed(tx: DbTx, keyId: string): Promise<boolean> {
      const rows = await (tx as unknown as Db)
        .update(catalogPhotoKeys)
        .set({ confirmedAt: new Date() })
        .where(
          and(
            eq(catalogPhotoKeys.id, keyId),
            sql`${catalogPhotoKeys.confirmedAt} IS NULL`,
          ),
        )
        .returning({ id: catalogPhotoKeys.id });
      return rows.length > 0;
    },
  };
}

export type CatalogPhotoKeysRepo = ReturnType<
  typeof createCatalogPhotoKeysRepo
>;
