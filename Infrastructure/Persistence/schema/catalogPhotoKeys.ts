import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { medicineCatalogEntries } from "./catalogEntries.js";

export const catalogPhotoKeys = pgTable(
  "catalog_photo_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id").notNull(),
    slot: text("slot").notNull(),
    photoKey: text("photo_key").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.entryId],
      foreignColumns: [medicineCatalogEntries.id],
      name: "catalog_photo_keys_entry_fk",
    }).onDelete("cascade"),
    uniqueIndex("catalog_photo_keys_photo_key_key").on(t.photoKey),
    index("idx_photo_keys_entry_slot").on(t.entryId, t.slot),
    index("idx_photo_keys_unconfirmed")
      .on(t.confirmedAt)
      .where(sql`${t.confirmedAt} IS NULL`),
    check("catalog_photo_keys_slot_enum", sql`${t.slot} IN ('A','B','C')`),
  ],
);

export type CatalogPhotoKeyRow = typeof catalogPhotoKeys.$inferSelect;
export type NewCatalogPhotoKeyRow = typeof catalogPhotoKeys.$inferInsert;
