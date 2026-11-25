import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { medicineCatalogEntries } from "./catalogEntries.js";

export const catalogPhotos = pgTable(
  "catalog_photos",
  {
    entryId: uuid("entry_id").notNull(),
    slot: text("slot").notNull(),
    photoKey: text("photo_key").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.slot] }),
    foreignKey({
      columns: [t.entryId],
      foreignColumns: [medicineCatalogEntries.id],
      name: "catalog_photos_entry_fk",
    }).onDelete("cascade"),
    check("catalog_photos_slot_enum", sql`${t.slot} IN ('A','B','C')`),
  ],
);

export type CatalogPhotoRow = typeof catalogPhotos.$inferSelect;
export type PhotoSlot = "A" | "B" | "C";
