// @vitest-environment node

import { describe, it, expect } from "vitest";
import { functionGeneratorKernel } from "./functionGenerator";
import {
  BLOCK_FRAMES,
  CV_UNIPOLAR_MAX,
  GATE_HIGH_V,
} from "../engine/units";

// Param slot order matches the registry entry: Rise, Fall, Curve, Cycle.
function makeParams(rise: number, fall: number, curve = 0, cycle = 0): Float32Array {
  return new Float32Array([rise, fall, curve, cycle]);
}

/**
 * Render `totalSamples` of the function generator in BLOCK_FRAMES chunks,
 * driving the five inputs from optional per-sample volt scripts (an omitted
 * script = unpatched jack). Returns the concatenated Out/EOR/EOC/Inv outputs.
 */
function renderFunction(opts: {
  sr?: number;
  params: Float32Array;
  totalSamples: number;
  trigAt?: (sample: number) => number;
  inAt?: (sample: number) => number;
  riseCvAt?: (sample: number) => number;
  fallCvAt?: (sample: number) => number;
  bothCvAt?: (sample: number) => number;
}): { out: Float32Array; eor: Float32Array; eoc: Float32Array; inv: Float32Array } {
  const sr = opts.sr ?? 48000;
  const state = functionGeneratorKernel.init(sr);
  const scripts = [opts.trigAt, opts.inAt, opts.riseCvAt, opts.fallCvAt, opts.bothCvAt];
  const inBufs = scripts.map((s) => (s ? new Float32Array(BLOCK_FRAMES) : null));
  const outs = [
    new Float32Array(BLOCK_FRAMES),
    new Float32Array(BLOCK_FRAMES),
    new Float32Array(BLOCK_FRAMES),
    new Float32Array(BLOCK_FRAMES),
  ];
  const out = new Float32Array(opts.totalSamples);
  const eor = new Float32Array(opts.totalSamples);
  const eoc = new Float32Array(opts.totalSamples);
  const inv = new Float32Array(opts.totalSamples);

  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let s = 0; s < scripts.length; s++) {
      const script = scripts[s];
      const buf = inBufs[s];
      if (script && buf) for (let i = 0; i < n; i++) buf[i] = script(start + i);
    }
    functionGeneratorKernel.process(state, inBufs, outs, opts.params, n);
    out.set(outs[0].subarray(0, n), start);
    eor.set(outs[1].subarray(0, n), start);
    eoc.set(outs[2].subarray(0, n), start);
    inv.set(outs[3].subarray(0, n), start);
  }
  return { out, eor, eoc, inv };
}

const SR = 48000;

describe("functionGeneratorKernel — triggered one-shot", () => {
  const RISE = 0.05;
  const FALL = 0.1;
  const TRIG_AT = 100;
  const riseSamples = Math.round(RISE * SR);
  const fallSamples = Math.round(FALL * SR);
  const render = renderFunction({
    sr: SR,
    params: makeParams(RISE, FALL),
    totalSamples: SR,
    trigAt: (i) => (i >= TRIG_AT && i < TRIG_AT + 96 ? GATE_HIGH_V : 0),
  });

  it("rests at 0 V before the trigger", () => {
    for (let i = 0; i < TRIG_AT; i++) expect(render.out[i]).toBe(0);
  });

  it("rises to the CV_UNIPOLAR_MAX peak at approximately the Rise knob time", () => {
    let peakAt = 0;
    for (let i = 1; i < render.out.length; i++) {
      if (render.out[i] > render.out[peakAt]) peakAt = i;
    }
    expect(render.out[peakAt]).toBeCloseTo(CV_UNIPOLAR_MAX, 3);
    expect(peakAt).toBeGreaterThan(TRIG_AT + riseSamples * 0.95);
    expect(peakAt).toBeLessThan(TRIG_AT + riseSamples * 1.05);
  });

  it("falls back to 0 V by approximately Rise + Fall after the trigger, and stays there", () => {
    const doneAt = TRIG_AT + riseSamples + Math.round(fallSamples * 1.05);
    for (let i = doneAt; i < SR; i++) expect(render.out[i]).toBe(0);
  });

  it("linear curve (0) passes half the peak at half the rise time", () => {
    const mid = render.out[TRIG_AT + Math.round(riseSamples / 2)];
    expect(mid).toBeCloseTo(CV_UNIPOLAR_MAX / 2, 1);
  });

  it("stays within 0..CV_UNIPOLAR_MAX for the whole render", () => {
    for (let i = 0; i < SR; i++) {
      expect(render.out[i]).toBeGreaterThanOrEqual(0);
      expect(render.out[i]).toBeLessThanOrEqual(CV_UNIPOLAR_MAX);
    }
  });

  it("Inv mirrors Out exactly (0 → −CV_UNIPOLAR_MAX)", () => {
    for (let i = 0; i < SR; i++) expect(render.inv[i]).toBe(0 - render.out[i]);
    // At rest the kernel writes 0 − y, never IEEE 754 −0.
    expect(Object.is(render.inv[0], -0)).toBe(false);
  });

  it("EOR is low exactly while rising, high at rest and during the fall", () => {
    for (let i = 0; i < TRIG_AT; i++) expect(render.eor[i]).toBe(GATE_HIGH_V);
    // Mid-rise: low. Mid-fall and long after: high.
    expect(render.eor[TRIG_AT + Math.round(riseSamples / 2)]).toBe(0);
    expect(render.eor[TRIG_AT + riseSamples + Math.round(fallSamples / 2)]).toBe(GATE_HIGH_V);
    expect(render.eor[SR - 1]).toBe(GATE_HIGH_V);
  });

  it("EOC is low exactly while falling, high at rest and during the rise", () => {
    for (let i = 0; i < TRIG_AT; i++) expect(render.eoc[i]).toBe(GATE_HIGH_V);
    expect(render.eoc[TRIG_AT + Math.round(riseSamples / 2)]).toBe(GATE_HIGH_V);
    expect(render.eoc[TRIG_AT + riseSamples + Math.round(fallSamples / 2)]).toBe(0);
    expect(render.eoc[SR - 1]).toBe(GATE_HIGH_V);
  });
});

describe("functionGeneratorKernel — curve shaping", () => {
  const RISE = 0.05;
  const riseSamples = Math.round(RISE * SR);
  const midRise = (curve: number) => {
    const { out } = renderFunction({
      sr: SR,
      params: makeParams(RISE, 0.05, curve),
      totalSamples: riseSamples,
      trigAt: (i) => (i < 48 ? GATE_HIGH_V : 0),
    });
    return out[Math.round(riseSamples / 2)];
  };

  it("expo (+1) sags below linear at mid-rise, log (−1) bulges above", () => {
    const lin = midRise(0);
    const expo = midRise(1);
    const log = midRise(-1);
    // g = 4^curve: p^4 at p=½ → 0.0625·peak; p^¼ at p=½ → ~0.841·peak.
    expect(expo).toBeLessThan(lin * 0.5);
    expect(expo).toBeCloseTo(CV_UNIPOLAR_MAX * 0.0625, 0);
    expect(log).toBeGreaterThan(lin * 1.3);
    expect(log).toBeCloseTo(CV_UNIPOLAR_MAX * Math.pow(0.5, 0.25), 0);
  });

  it("curve does not change the total rise time", () => {
    for (const curve of [-1, 0, 1]) {
      const { out } = renderFunction({
        sr: SR,
        params: makeParams(RISE, 0.05, curve),
        totalSamples: riseSamples + 24,
        trigAt: (i) => (i < 48 ? GATE_HIGH_V : 0),
      });
      let peakAt = 0;
      for (let i = 1; i < out.length; i++) if (out[i] > out[peakAt]) peakAt = i;
      expect(peakAt).toBeGreaterThan(riseSamples * 0.95);
      expect(peakAt).toBeLessThan(riseSamples * 1.05);
    }
  });
});

describe("functionGeneratorKernel — cycle mode", () => {
  const RISE = 0.05;
  const FALL = 0.05;
  const period = Math.round((RISE + FALL) * SR);
  const render = renderFunction({
    sr: SR,
    params: makeParams(RISE, FALL, 0, 1),
    totalSamples: SR, // 1 s → 10 full cycles
  });

  it("self-oscillates between 0 and the peak with period ≈ Rise + Fall", () => {
    // Count rising edges of EOC (fall completions) as cycle boundaries.
    let cycles = 0;
    for (let i = 1; i < SR; i++) {
      if (render.eoc[i] === GATE_HIGH_V && render.eoc[i - 1] === 0) cycles++;
    }
    expect(cycles).toBeGreaterThanOrEqual(9);
    expect(cycles).toBeLessThanOrEqual(11);
    // Full swing: hits both extremes within the first period.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < period + 2; i++) {
      if (render.out[i] < lo) lo = render.out[i];
      if (render.out[i] > hi) hi = render.out[i];
    }
    expect(hi).toBeCloseTo(CV_UNIPOLAR_MAX, 3);
    expect(lo).toBeLessThan(0.1);
  });

  it("EOR/EOC are complementary squares mid-cycle (EOC high while rising, low while falling)", () => {
    // Sample well inside the second cycle's rise and fall halves.
    const riseMid = period + Math.round(RISE * SR * 0.5);
    const fallMid = period + Math.round((RISE + FALL * 0.5) * SR);
    expect(render.eor[riseMid]).toBe(0);
    expect(render.eoc[riseMid]).toBe(GATE_HIGH_V);
    expect(render.eor[fallMid]).toBe(GATE_HIGH_V);
    expect(render.eoc[fallMid]).toBe(0);
  });
});

describe("functionGeneratorKernel — slew limiter (In follower)", () => {
  it("slews a rising step at full-scale-per-Rise-time and clamps at the target", () => {
    const RISE = 0.1; // 100 V/s slope → 4 V in 0.04 s
    const target = 4;
    const reachAt = Math.round((target / CV_UNIPOLAR_MAX) * RISE * SR); // 1920
    const { out } = renderFunction({
      sr: SR,
      params: makeParams(RISE, 0.01),
      totalSamples: 4800,
      inAt: () => target,
    });
    // Linear mid-slew: half the target at half the traverse time.
    expect(out[Math.round(reachAt / 2)]).toBeCloseTo(target / 2, 1);
    expect(out[reachAt + 10]).toBeCloseTo(target, 3);
    expect(out[4799]).toBe(target);
  });

  it("slews a falling step at full-scale-per-Fall-time", () => {
    const FALL = 0.1;
    const stepDown = 4800;
    const { out } = renderFunction({
      sr: SR,
      params: makeParams(0.001, FALL),
      totalSamples: 9600,
      inAt: (i) => (i < stepDown ? 4 : 0),
    });
    expect(out[stepDown - 1]).toBeCloseTo(4, 3);
    // 100 V/s down → 4 V traversed in 0.04 s = 1920 samples.
    expect(out[stepDown + 960]).toBeCloseTo(2, 1);
    expect(out[stepDown + 1930]).toBeCloseTo(0, 3);
  });
});

describe("functionGeneratorKernel — time CV", () => {
  const RISE = 0.02;
  const riseSamples = Math.round(RISE * SR);

  const peakIndex = (opts: {
    riseCvAt?: (i: number) => number;
    bothCvAt?: (i: number) => number;
  }) => {
    const { out } = renderFunction({
      sr: SR,
      params: makeParams(RISE, 0.05),
      totalSamples: riseSamples * 5,
      trigAt: (i) => (i < 48 ? GATE_HIGH_V : 0),
      ...opts,
    });
    let peakAt = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[peakAt]) peakAt = i;
    return peakAt;
  };

  it("+1 V on Rise CV doubles the rise time (1 oct/V, positive = slower)", () => {
    const doubled = peakIndex({ riseCvAt: () => 1 });
    expect(doubled).toBeGreaterThan(riseSamples * 2 * 0.95);
    expect(doubled).toBeLessThan(riseSamples * 2 * 1.05);
  });

  it("−1 V on Both CV halves the rise time", () => {
    const halved = peakIndex({ bothCvAt: () => -1 });
    expect(halved).toBeGreaterThan(riseSamples * 0.5 * 0.9);
    expect(halved).toBeLessThan(riseSamples * 0.5 * 1.1);
  });

  it("Rise CV and Both CV sum (1 V + 1 V → 4× rise time)", () => {
    const quad = peakIndex({ riseCvAt: () => 1, bothCvAt: () => 1 });
    expect(quad).toBeGreaterThan(riseSamples * 4 * 0.95);
    expect(quad).toBeLessThan(riseSamples * 4 * 1.05);
  });
});

describe("functionGeneratorKernel — retrigger and robustness", () => {
  it("a trigger during the fall restarts the rise from the current level, continuously", () => {
    const RISE = 0.01;
    const FALL = 0.1;
    const secondTrig = Math.round((RISE + FALL / 2) * SR); // mid-fall
    const { out } = renderFunction({
      sr: SR,
      params: makeParams(RISE, FALL),
      totalSamples: SR / 2,
      trigAt: (i) =>
        (i < 48) || (i >= secondTrig && i < secondTrig + 48) ? GATE_HIGH_V : 0,
    });
    // Continuity: no per-sample jump larger than the fastest linear slope
    // (full scale over the rise time) with generous headroom.
    const maxStep = (CV_UNIPOLAR_MAX / (RISE * SR)) * 4;
    for (let i = 1; i < out.length; i++) {
      expect(Math.abs(out[i] - out[i - 1])).toBeLessThanOrEqual(maxStep);
    }
    // The second rise reaches the peak again.
    let peakAfter = 0;
    for (let i = secondTrig; i < out.length; i++) if (out[i] > peakAfter) peakAfter = out[i];
    expect(peakAfter).toBeCloseTo(CV_UNIPOLAR_MAX, 3);
  });

  it("unpatched and idle: 0 V out, both gates high", () => {
    const { out, eor, eoc } = renderFunction({
      sr: SR,
      params: makeParams(0.01, 0.3),
      totalSamples: BLOCK_FRAMES * 4,
    });
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(0);
      expect(eor[i]).toBe(GATE_HIGH_V);
      expect(eoc[i]).toBe(GATE_HIGH_V);
    }
  });

  it("non-finite params and input samples never produce non-finite output", () => {
    const { out, eor, eoc, inv } = renderFunction({
      sr: SR,
      params: makeParams(NaN, NaN, NaN, NaN),
      totalSamples: BLOCK_FRAMES * 8,
      trigAt: (i) => (i % 200 < 50 ? NaN : GATE_HIGH_V),
      inAt: (i) => (i % 3 === 0 ? NaN : 2),
      riseCvAt: () => NaN,
      fallCvAt: () => Infinity,
      bothCvAt: () => -Infinity,
    });
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(Number.isFinite(eor[i])).toBe(true);
      expect(Number.isFinite(eoc[i])).toBe(true);
      expect(Number.isFinite(inv[i])).toBe(true);
    }
  });
});
