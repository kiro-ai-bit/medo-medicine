import { describe, expect, it } from "vitest";
import { computeRefillTransition } from "../../Core/Medicine/medicine.js";

describe("computeRefillTransition — custom refillThreshold", () => {
  it("fires low alert at the custom threshold, not the fixed 6", () => {
    // threshold 10, v drops to 10 → low fires
    expect(computeRefillTransition(true, true, 10, 10).threshold).toBe(10);
    // v = 9 with threshold 6 → no low fire
    expect(computeRefillTransition(true, true, 9, 6).threshold).toBeNull();
  });

  it("0 alert still fires regardless of custom threshold", () => {
    expect(computeRefillTransition(true, true, 0, 10).threshold).toBe(0);
  });

  it("default threshold 6 preserves legacy behaviour", () => {
    expect(computeRefillTransition(true, true, 6).threshold).toBe(6);
    expect(computeRefillTransition(true, true, 7).threshold).toBeNull();
  });

  it("arms re-arm when count rises above the custom threshold", () => {
    const t = computeRefillTransition(false, true, 12, 10);
    expect(t.refillLowArmed).toBe(true);
  });
});
