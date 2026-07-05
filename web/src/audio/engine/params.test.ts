import { describe, it, expect } from "vitest";
import {
  normalizedToEngineValue,
  engineValueToNormalized,
  defaultNormalizedValue,
  isBipolarParam,
} from "./params";
import type { ParamSpec } from "./kernel";
import { registry } from "../modules/registry";

const linear = (min: number, max: number, def: number): ParamSpec => ({ min, max, default: def, curve: "linear" });
const exp = (min: number, max: number, def: number): ParamSpec => ({ min, max, default: def, curve: "exponential" });
const positions = (def: number, labels: string[]): ParamSpec => ({
  min: 0,
  max: labels.length - 1,
  default: def,
  curve: "positions",
  positions: labels,
});

describe("normalizedToEngineValue", () => {
  it("maps a linear range and clamps out-of-range input", () => {
    const spec = linear(0, 10, 3);
    expect(normalizedToEngineValue(spec, 0)).toBe(0);
    expect(normalizedToEngineValue(spec, 0.5)).toBe(5);
    expect(normalizedToEngineValue(spec, 1)).toBe(10);
    expect(normalizedToEngineValue(spec, -0.5)).toBe(0);
    expect(normalizedToEngineValue(spec, 1.7)).toBe(10);
  });

  it("maps a bipolar linear range with 0.5 at centre", () => {
    const spec = linear(-1, 1, 0);
    expect(normalizedToEngineValue(spec, 0)).toBe(-1);
    expect(normalizedToEngineValue(spec, 0.5)).toBe(0);
    expect(normalizedToEngineValue(spec, 1)).toBe(1);
  });

  it("hits exponential endpoints exactly", () => {
    const spec = exp(20, 20000, 440);
    expect(normalizedToEngineValue(spec, 0)).toBe(20);
    expect(normalizedToEngineValue(spec, 1)).toBe(20000);
    expect(normalizedToEngineValue(spec, 0.5)).toBeCloseTo(Math.sqrt(20 * 20000), 6);
  });

  it("rounds and clamps a switch index (positions)", () => {
    const spec = positions(0, ["A", "B", "C"]);
    expect(normalizedToEngineValue(spec, 2)).toBe(2);
    expect(normalizedToEngineValue(spec, 1.4)).toBe(1);
    expect(normalizedToEngineValue(spec, 7)).toBe(2);
    expect(normalizedToEngineValue(spec, -3)).toBe(0);
  });

  it("falls back to the default for a non-finite input", () => {
    expect(normalizedToEngineValue(linear(0, 10, 3), NaN)).toBe(3);
    expect(normalizedToEngineValue(exp(20, 20000, 440), Infinity)).toBe(440);
  });
});

describe("engineValueToNormalized", () => {
  it("inverts the linear map and clamps", () => {
    const spec = linear(0, 10, 3);
    expect(engineValueToNormalized(spec, 5)).toBe(0.5);
    expect(engineValueToNormalized(spec, 0)).toBe(0);
    expect(engineValueToNormalized(spec, 20)).toBe(1);
  });

  it("inverts the exponential map", () => {
    const spec = exp(20, 20000, 440);
    expect(engineValueToNormalized(spec, 20)).toBe(0);
    expect(engineValueToNormalized(spec, 20000)).toBe(1);
    expect(engineValueToNormalized(spec, Math.sqrt(20 * 20000))).toBeCloseTo(0.5, 6);
  });

  it("returns the clamped index for a switch", () => {
    const spec = positions(1, ["A", "B", "C"]);
    expect(engineValueToNormalized(spec, 2)).toBe(2);
    expect(engineValueToNormalized(spec, 9)).toBe(2);
  });

  it("falls back to the default position for a non-finite value", () => {
    const spec = linear(0, 10, 3);
    expect(engineValueToNormalized(spec, NaN)).toBe(defaultNormalizedValue(spec));
  });

  it("does not divide by zero on a degenerate range", () => {
    expect(engineValueToNormalized(linear(5, 5, 5), 5)).toBe(0);
    expect(Number.isFinite(engineValueToNormalized(exp(0, 0, 0), 1))).toBe(true);
  });
});

describe("defaultNormalizedValue", () => {
  it("places a non-minimum unipolar default off the left stop", () => {
    // audio-output Level default 0.8 → 0.8 (not 0).
    expect(defaultNormalizedValue(linear(0, 1, 0.8))).toBeCloseTo(0.8, 6);
  });

  it("centres a bipolar default", () => {
    expect(defaultNormalizedValue(linear(-1, 1, 0))).toBe(0.5);
  });

  it("places an exponential default at its true position (clock Tempo)", () => {
    // 120 BPM in a 30..300 exponential range.
    expect(defaultNormalizedValue(exp(30, 300, 120))).toBeCloseTo(Math.log(4) / Math.log(10), 6);
  });

  it("returns the default index for a switch", () => {
    expect(defaultNormalizedValue(positions(2, ["VCA", "LPG", "Both"]))).toBe(2);
  });
});

describe("isBipolarParam", () => {
  it("is true for a zero-straddling centred-default knob", () => {
    expect(isBipolarParam(linear(-1, 1, 0))).toBe(true);
    expect(isBipolarParam(linear(-2, 2, 0))).toBe(true);
    expect(isBipolarParam(exp(0.5, 2, 1))).toBe(false); // positive range, not bipolar
  });

  it("is false for a unipolar knob", () => {
    expect(isBipolarParam(linear(0, 1, 0.8))).toBe(false);
    expect(isBipolarParam(linear(0, 10, 3))).toBe(false);
  });

  it("is false for an off-centre-default range", () => {
    expect(isBipolarParam(linear(-1, 1, 0.5))).toBe(false);
  });

  it("is never true for a switch", () => {
    expect(isBipolarParam(positions(0, ["A", "B"]))).toBe(false);
  });
});

// ── Audit every registered ParamSpec ────────────────────────────────────────
// A wrong default (non-finite, out of range, or an exponential range that
// touches zero) would silently desync the knob picture from the engine, or
// produce NaN in the mapping. This sweeps the whole registry so a future kernel
// can't regress it.
describe("registry ParamSpec audit", () => {
  const allParams: [string, string, ParamSpec][] = [];
  for (const [slug, dsp] of registry) {
    for (const [name, spec] of Object.entries(dsp.params)) {
      allParams.push([slug, name, spec]);
    }
  }

  it("covers at least one param per registered module that has controls", () => {
    // Sanity: the sweep actually found params (guards against an empty loop).
    expect(allParams.length).toBeGreaterThan(0);
  });

  it.each(allParams)("%s / %s has a sane default and round-trips", (_slug, _name, spec) => {
    expect(Number.isFinite(spec.default)).toBe(true);

    if (spec.curve === "exponential") {
      expect(spec.min).toBeGreaterThan(0);
      expect(spec.max).toBeGreaterThan(0);
    }

    if (spec.curve !== "positions") {
      expect(spec.default).toBeGreaterThanOrEqual(spec.min);
      expect(spec.default).toBeLessThanOrEqual(spec.max);
      const norm = defaultNormalizedValue(spec);
      expect(Number.isFinite(norm)).toBe(true);
      expect(norm).toBeGreaterThanOrEqual(0);
      expect(norm).toBeLessThanOrEqual(1);
    } else {
      // Switch: default is a valid position index.
      expect(Number.isInteger(spec.default)).toBe(true);
      expect(spec.default).toBeGreaterThanOrEqual(spec.min);
      expect(spec.default).toBeLessThanOrEqual(spec.max);
    }

    // Round-trip: default → normalized → engine ≈ default, and back.
    const norm = defaultNormalizedValue(spec);
    expect(normalizedToEngineValue(spec, norm)).toBeCloseTo(spec.default, 6);
    expect(engineValueToNormalized(spec, spec.default)).toBeCloseTo(norm, 6);
  });
});
