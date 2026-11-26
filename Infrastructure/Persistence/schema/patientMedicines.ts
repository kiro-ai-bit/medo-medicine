import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { medicineCatalogEntries } from "./catalogEntries.js";

export const patientMedicines = pgTable(
  "patient_medicines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id").notNull(),
    catalogEntryId: uuid("catalog_entry_id").notNull(),
    prescribingDoctor: text("prescribing_doctor").notNull(),
    dosage: text("dosage").notNull(),
    dosesRemaining: integer("doses_remaining").notNull(),
    refillThreshold: integer("refill_threshold").notNull().default(6),
    price: numeric("price", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    pharmacyName: text("pharmacy_name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    refillLowArmed: boolean("refill_low_armed").notNull().default(true),
    refillOutArmed: boolean("refill_out_armed").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.catalogEntryId],
      foreignColumns: [medicineCatalogEntries.id],
      name: "patient_medicines_catalog_entry_fk",
    }),
    index("idx_patient_medicines_patient").on(t.patientId),
    index("idx_patient_medicines_catalog").on(t.catalogEntryId),
    check(
      "patient_medicines_doctor_len",
      sql`length(${t.prescribingDoctor}) BETWEEN 1 AND 200`,
    ),
    check(
      "patient_medicines_dosage_len",
      sql`length(${t.dosage}) BETWEEN 1 AND 200`,
    ),
    check("patient_medicines_doses_remaining", sql`${t.dosesRemaining} >= 0`),
    check("patient_medicines_refill_threshold", sql`${t.refillThreshold} >= 0`),
    check("patient_medicines_price", sql`${t.price} >= 0`),
    check(
      "patient_medicines_pharmacy_len",
      sql`length(${t.pharmacyName}) BETWEEN 1 AND 200`,
    ),
  ],
);

export type PatientMedicineRow = typeof patientMedicines.$inferSelect;
export type NewPatientMedicineRow = typeof patientMedicines.$inferInsert;
