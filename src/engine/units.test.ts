import { describe, it, expect } from "vitest";
import {
  C4_HZ,
  GATE_HIGH_V,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
  voltsToHz,
} from "./units";

describe("voltsToHz", () => {
  it("returns C4 at 0 V", () => {
    expect(voltsToHz(0)).toBeCloseTo(261.6256, 4);
  });

  it("doubles frequency at +1 V", () => {
    expect(voltsToHz(1)).toBeCloseTo(C4_HZ * 2, 4);
  });

  it("halves frequency at -1 V", () => {
    expect(voltsToHz(-1)).toBeCloseTo(C4_HZ / 2, 4);
  });
});

describe("gate thresholds", () => {
  it("satisfies REARM < FIRE < GATE_HIGH", () => {
    expect(GATE_REARM_THRESHOLD_V).toBeLessThan(GATE_FIRE_THRESHOLD_V);
    expect(GATE_FIRE_THRESHOLD_V).toBeLessThan(GATE_HIGH_V);
  });
});
