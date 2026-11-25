import type { Db } from "@infrastructure/Persistence/db.js";
import type { Metrics } from "@core/metrics.js";
import {
  applyDoseOutcomeDelta,
  type DoseOutcomeChangedPayload,
} from "@core/Medicine/medicine.js";

// LLD §4.7/§8.6 — orchestrates the per-event tx via core-medicine.
// Unknown medicineId / foreign patientId → structural no-op inside.
export async function handleDoseOutcomeChanged(
  deps: { db: Db; metrics?: Metrics },
  event: DoseOutcomeChangedPayload,
): Promise<void> {
  try {
    await applyDoseOutcomeDelta(deps, event);
  } catch (err) {
    deps.metrics?.incr("medo_medicine_doseoutcome_consumed_total", {
      result: "failed",
    });
    throw err;
  }
}
