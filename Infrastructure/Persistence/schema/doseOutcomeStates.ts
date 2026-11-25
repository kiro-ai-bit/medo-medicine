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
import { patientMedicines } from "./patientMedicines.js";

export const doseOutcomeStates = pgTable(
  "dose_outcome_states",
  {
    medicineId: uuid("medicine_id").notNull(),
    doseId: uuid("dose_id").notNull(),
    lastOutcome: text("last_outcome").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.medicineId, t.doseId] }),
    foreignKey({
      columns: [t.medicineId],
      foreignColumns: [patientMedicines.id],
      name: "dose_outcome_states_medicine_fk",
    }).onDelete("cascade"),
    check(
      "dose_outcome_states_outcome_enum",
      sql`${t.lastOutcome} IN ('taken-on-time','taken-late','skipped','missed')`,
    ),
  ],
);

export type DoseOutcomeStateRow = typeof doseOutcomeStates.$inferSelect;
export type DoseOutcome = "taken-on-time" | "taken-late" | "skipped" | "missed";
