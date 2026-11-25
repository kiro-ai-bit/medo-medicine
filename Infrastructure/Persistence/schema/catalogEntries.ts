import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const medicineCatalogEntries = pgTable(
  "medicine_catalog_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandName: text("brand_name").notNull(),
    ingredientNames: text("ingredient_names").array().notNull(),
    form: text("form").notNull(),
    packagingQuantity: integer("packaging_quantity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_catalog_brand_form").on(t.brandName, t.form),
    index("idx_catalog_updated").on(sql`${t.updatedAt} DESC`),
    uniqueIndex("uq_catalog_entries_identity").on(
      t.brandName,
      t.form,
      t.ingredientNames,
    ),
    check(
      "catalog_brand_name_len",
      sql`length(${t.brandName}) BETWEEN 1 AND 200`,
    ),
    check(
      "catalog_ingredients_min",
      sql`cardinality(${t.ingredientNames}) >= 1`,
    ),
    check(
      "catalog_form_enum",
      sql`${t.form} IN ('tablet','capsule','syrup','injection','drops','other')`,
    ),
    check("catalog_pack_qty", sql`${t.packagingQuantity} > 0`),
  ],
);

export type CatalogEntryRow = typeof medicineCatalogEntries.$inferSelect;
export type NewCatalogEntryRow = typeof medicineCatalogEntries.$inferInsert;
export type MedicineForm =
  "tablet" | "capsule" | "syrup" | "injection" | "drops" | "other";
