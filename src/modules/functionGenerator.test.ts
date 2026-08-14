// @vitest-environment node

import { describe, it, expect } from "vitest";
import { functionGeneratorKernel } from "./functionGenerator";
import {
  BLOCK_FRAMES,
  CV_UNIPOLAR_MAX,
  GATE_HIGH_V,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
} from "../engine/units";
// Out/EOR/EOC/Inv captured from this kernel BEFORE the Cycle input jack was
// added (every 16th sample of an 8192-sample render, three parameter/input
// scenarios). Regenerating it would defeat its purpose: it is the frozen
// definition of "what saved patches used to sound like".
import legacyBaseline from "./__fixtures__/functionGeneratorLegacy.json" with { type: "json" };

// Param slot order matches the registry entry: Rise, Fall, Curve, Cycle.
function makeParams(rise: number, fall: number, curve = 0, cycle = 0): Float32Array {
  return new Float32Array([rise, fall, curve, cycle]);
}

/**
 * Render `totalSamples` of the function generator in BLOCK_FRAMES chunks,
 * driving the six inputs from optional per-sample volt scripts (an omitted
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
  cycleAt?: (sample: number) => number;
}): { out: Float32Array; eor: Float32Array; eoc: Float32Array; inv: Float32Array } {
  const sr = opts.sr ?? 48000;
  const state = functionGeneratorKernel.init(sr);
  // Slot order is the registry's inJacks order — Cycle is last, appended after
  // Both CV, so the five original slots keep their indices.
  const scripts = [opts.trigAt, opts.inAt, opts.riseCvAt, opts.fallCvAt, opts.bothCvAt, opts.cycleAt];
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

/** Highest Out sample in [from, to) — "did this segment reach the peak?". */
function peakBetween(out: Float32Array, from: number, to: number): number {
  let peak = -Infinity;
  for (let i = from; i < Math.min(to, out.length); i++) if (out[i] > peak) peak = out[i];
  return peak;
}

/**
 * Completed fall segments, counted as rising edges of EOC — the same "one
 * cycle boundary per fall completion" measure the cycle-mode suite uses.
 */
function countCycles(eoc: Float32Array): number {
  let cycles = 0;
  for (let i = 1; i < eoc.length; i++) {
    if (eoc[i] === GATE_HIGH_V && eoc[i - 1] === 0) cycles++;
  }
  return cycles;
}

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

  it("an unconnected Cycle jack produces exactly one envelope per trigger", () => {
    const RISE = 0.01;
    const FALL = 0.02;
    const { eoc } = renderFunction({
      sr: SR,
      params: makeParams(RISE, FALL),
      totalSamples: SR / 2,
      // Three well-separated triggers.
      trigAt: (i) => (i % 4800 < 48 && i < 3 * 4800 ? GATE_HIGH_V : 0),
    });
    expect(countCycles(eoc)).toBe(3);
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

// ── Cycle gate input (ins[5]) ───────────────────────────────────────────────
//
// The Cycle jack was appended to inJacks AFTER this module had been shipping
// for a while, so the first suite below is the backward-compatibility guard:
// __fixtures__/functionGeneratorLegacy.json holds Out/EOR/EOC/Inv sampled from
// the kernel as it stood BEFORE the jack existed, and the unpatched path must
// still reproduce it sample for sample. Everything after that tests the new
// behavior.

describe("functionGeneratorKernel — legacy (pre-Cycle-jack) output is unchanged", () => {
  // The exact scenarios the baseline was captured under. Do not retune these:
  // the fixture is only meaningful against the inputs that produced it.
  const STRIDE = legacyBaseline.stride;
  const TOTAL = legacyBaseline.totalSamples;
  const trigAt = (i: number) => (i >= 200 && i < 296 ? 10 : 0);
  const inAt = (i: number) => (i < 4096 ? 0 : 2.5);
  const riseCvAt = () => 0.4;
  const fallCvAt = (i: number) => (i < 2048 ? 0 : -0.75);
  const bothCvAt = () => 0.2;

  const decimate = (a: Float32Array): number[] => {
    const sampled: number[] = [];
    for (let i = 0; i < TOTAL; i += STRIDE) sampled.push(a[i]);
    return sampled;
  };

  const channels = (r: { out: Float32Array; eor: Float32Array; eoc: Float32Array; inv: Float32Array }) =>
    [decimate(r.out), decimate(r.eor), decimate(r.eoc), decimate(r.inv)];

  it("reproduces the pre-change one-shot render exactly, with Cycle unpatched", () => {
    const render = renderFunction({
      sr: legacyBaseline.sr,
      params: makeParams(0.02, 0.06, 0.5, 0),
      totalSamples: TOTAL,
      trigAt,
      inAt,
      riseCvAt,
      fallCvAt,
      bothCvAt,
    });
    expect(channels(render)).toEqual(legacyBaseline.oneShot);
  });

  it("reproduces the pre-change button-Cycle render exactly, with the jack unpatched", () => {
    const render = renderFunction({
      sr: legacyBaseline.sr,
      params: makeParams(0.02, 0.06, -0.5, 1),
      totalSamples: TOTAL,
      trigAt,
      inAt,
      riseCvAt,
      fallCvAt,
      bothCvAt,
    });
    expect(channels(render)).toEqual(legacyBaseline.buttonCycle);
  });

  it("reproduces the pre-change default-knob render exactly, with only Trig patched", () => {
    const render = renderFunction({
      sr: legacyBaseline.sr,
      params: makeParams(0.01, 0.3, 0, 0),
      totalSamples: TOTAL,
      trigAt,
    });
    expect(channels(render)).toEqual(legacyBaseline.bare);
  });

  it("a patched-but-low Cycle input is indistinguishable from an unpatched one", () => {
    const opts = {
      sr: legacyBaseline.sr,
      params: makeParams(0.02, 0.06, 0.5, 0),
      totalSamples: TOTAL,
      trigAt,
      inAt,
      riseCvAt,
      fallCvAt,
      bothCvAt,
    };
    const low = renderFunction({ ...opts, cycleAt: () => 0 });
    expect(channels(low)).toEqual(legacyBaseline.oneShot);
  });
});

describe("functionGeneratorKernel — Cycle gate input", () => {
  const RISE = 0.01;
  const FALL = 0.02;
  const period = Math.round((RISE + FALL) * SR); // 1440 samples

  it("a high gate starts a cycle from idle with no trigger at all", () => {
    const { out } = renderFunction({
      sr: SR,
      params: makeParams(RISE, FALL),
      totalSamples: period,
      cycleAt: () => GATE_HIGH_V,
    });
    // Rises away from rest immediately and reaches the peak by the rise time.
    expect(out[0]).toBeGreaterThan(0);
    expect(peakBetween(out, 0, Math.round(RISE * SR) + 2)).toBeCloseTo(CV_UNIPOLAR_MAX, 3);
  });

  it("a continuously high gate repeats complete rise/fall cycles", () => {
    const { out, eoc } = renderFunction({
      sr: SR,
      params: makeParams(RISE, FALL),
      totalSamples: SR / 2, // 24000 samples ≈ 16.7 periods
      cycleAt: () => GATE_HIGH_V,
    });
    const expected = Math.floor(SR / 2 / period);
    expect(countCycles(eoc)).toBeGreaterThanOrEqual(expected - 1);
    expect(countCycles(eoc)).toBeLessThanOrEqual(expected + 1);
    // Each cycle is a full-depth swing, not a partial one.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 2 * period; i < 3 * period; i++) {
      if (out[i] < lo) lo = out[i];
      if (out[i] > hi) hi = out[i];
    }
    expect(hi).toBeCloseTo(CV_UNIPOLAR_MAX, 3);
    expect(lo).toBeLessThan(0.1);
  });

  it("a gate that goes low mid-cycle lets the current cycle finish, then rests at 0 V", () => {
    // Drop the gate a quarter of the way into the third cycle's rise.
    const dropAt = 2 * period + Math.round(RISE * SR * 0.25);
    const { out, eoc } = renderFunction({
      sr: SR,
      params: makeParams(RISE, FALL),
      totalSamples: 6 * period,
      cycleAt: (i) => (i < dropAt ? GATE_HIGH_V : 0),
    });
    // The in-flight cycle still completes: the peak is reached after the drop.
    let peakAfterDrop = 0;
    for (let i = dropAt; i < dropAt + Math.round(RISE * SR) + 4; i++) {
      if (out[i] > peakAfterDrop) peakAfterDrop = out[i];
    }
    expect(peakAfterDrop).toBeCloseTo(CV_UNIPOLAR_MAX, 3);
    // Then it stops: exactly three fall completions, and flat 0 V thereafter.
    expect(countCycles(eoc)).toBe(3);
    for (let i = 4 * period; i < 6 * period; i++) expect(out[i]).toBe(0);
  });

  it("a gate going high again restarts cycling", () => {
    const offFrom = 2 * period;
    const onAgain = 5 * period;
    const { out, eoc } = renderFunction({
      sr: SR,
      params: makeParams(RISE, FALL),
      totalSamples: 9 * period,
      cycleAt: (i) => (i < offFrom || i >= onAgain ? GATE_HIGH_V : 0),
    });
    // Idle window between the finished cycle and the gate returning.
    for (let i = 3 * period; i < onAgain; i++) expect(out[i]).toBe(0);
    // Restarted: rises again within a rise time of the gate coming back.
    expect(peakBetween(out, onAgain, onAgain + Math.round(RISE * SR) + 2)).toBeCloseTo(
      CV_UNIPOLAR_MAX,
      3,
    );
    // Two cycles before the pause, more after — never zero after the restart.
    expect(countCycles(eoc.subarray(0, onAgain))).toBe(3);
    expect(countCycles(eoc.subarray(onAgain))).toBeGreaterThanOrEqual(3);
  });

  it("the gate is a Schmitt level latch: a voltage between the thresholds holds the current state", () => {
    const between = (GATE_FIRE_THRESHOLD_V + GATE_REARM_THRESHOLD_V) / 2;
    // Never crosses the fire threshold → never starts.
    const neverStarted = renderFunction({
      sr: SR,
      params: makeParams(RISE, FALL),
      totalSamples: 3 * period,
      cycleAt: () => between,
    });
    for (let i = 0; i < 3 * period; i++) expect(neverStarted.out[i]).toBe(0);
    // Fires once, then sits between the thresholds → stays latched high.
    const stillCycling = renderFunction({
      sr: SR,
      params: makeParams(RISE, FALL),
      totalSamples: 4 * period,
      cycleAt: (i) => (i < 16 ? GATE_HIGH_V : between),
    });
    expect(countCycles(stillCycling.eoc)).toBeGreaterThanOrEqual(3);
  });

  it("external triggers keep their behavior while the gate is high or low", () => {
    // Gate low: a trigger mid-fall still restarts the rise continuously, and
    // the module still returns to rest afterwards (one-shot semantics).
    const secondTrig = Math.round((RISE + FALL / 2) * SR);
    const gateLow = renderFunction({
      sr: SR,
      params: makeParams(RISE, FALL),
      totalSamples: 6 * period,
      trigAt: (i) => ((i < 48) || (i >= secondTrig && i < secondTrig + 48) ? GATE_HIGH_V : 0),
      cycleAt: () => 0,
    });
    let peakAfter = 0;
    for (let i = secondTrig; i < gateLow.out.length; i++) {
      if (gateLow.out[i] > peakAfter) peakAfter = gateLow.out[i];
    }
    expect(peakAfter).toBeCloseTo(CV_UNIPOLAR_MAX, 3);
    for (let i = 4 * period; i < 6 * period; i++) expect(gateLow.out[i]).toBe(0);

    // Gate high: a trigger restarts the rise from the current level rather
    // than being swallowed, and never breaks continuity.
    const gateHigh = renderFunction({
      sr: SR,
      params: makeParams(RISE, FALL),
      totalSamples: 4 * period,
      trigAt: (i) => (i >= 2 * period && i < 2 * period + 48 ? GATE_HIGH_V : 0),
      cycleAt: () => GATE_HIGH_V,
    });
    const maxStep = (CV_UNIPOLAR_MAX / (RISE * SR)) * 4;
    for (let i = 1; i < gateHigh.out.length; i++) {
      expect(Math.abs(gateHigh.out[i] - gateHigh.out[i - 1])).toBeLessThanOrEqual(maxStep);
    }
    expect(
      peakBetween(gateHigh.out, 2 * period, 2 * period + Math.round(RISE * SR) + 2),
    ).toBeCloseTo(CV_UNIPOLAR_MAX, 3);
  });

  it("the Cycle button still cycles on its own, and OR's with the gate", () => {
    // Button on, gate explicitly low → still cycles (the gate cannot veto).
    const { eoc } = renderFunction({
      sr: SR,
      params: makeParams(RISE, FALL, 0, 1),
      totalSamples: 4 * period,
      cycleAt: () => 0,
    });
    expect(countCycles(eoc)).toBeGreaterThanOrEqual(3);
  });

  it("a non-finite gate sample holds the latch instead of stopping the cycle", () => {
    const { out, eoc } = renderFunction({
      sr: SR,
      params: makeParams(RISE, FALL),
      totalSamples: 4 * period,
      cycleAt: (i) => (i < 16 ? GATE_HIGH_V : NaN),
    });
    expect(countCycles(eoc)).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i])).toBe(true);
  });
});

describe("functionGeneratorKernel — cycling is bounded at minimum segment times", () => {
  // Rise/Fall of 0 clamp to TIME_MIN_S (1 ms), so a segment always spans at
  // least one sample and the stage machine can never spin: the guard against
  // a zero-duration setting locking up the render thread.
  const params = makeParams(0, 0);

  it("renders finite output with zero Rise/Fall and a high gate", () => {
    const { out, eor, eoc, inv } = renderFunction({
      sr: SR,
      params,
      totalSamples: BLOCK_FRAMES * 8,
      cycleAt: () => GATE_HIGH_V,
    });
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(Number.isFinite(eor[i])).toBe(true);
      expect(Number.isFinite(eoc[i])).toBe(true);
      expect(Number.isFinite(inv[i])).toBe(true);
      expect(out[i]).toBeGreaterThanOrEqual(0);
      expect(out[i]).toBeLessThanOrEqual(CV_UNIPOLAR_MAX);
    }
  });

  it("completes at most one cycle per two samples, even at the minimum times", () => {
    const totalSamples = BLOCK_FRAMES * 8;
    const { eoc } = renderFunction({ sr: SR, params, totalSamples, cycleAt: () => GATE_HIGH_V });
    // A cycle needs a rise segment AND a fall segment, each ≥ 1 sample.
    expect(countCycles(eoc)).toBeLessThanOrEqual(totalSamples / 2);
    // At 1 ms per segment and 48 kHz, the real figure is ~1 per 96 samples.
    expect(countCycles(eoc)).toBeLessThanOrEqual(Math.ceil(totalSamples / 96) + 1);
  });

  it("stays bounded when non-finite times meet a high gate", () => {
    const { out } = renderFunction({
      sr: SR,
      params: makeParams(NaN, NaN),
      totalSamples: BLOCK_FRAMES * 8,
      cycleAt: () => GATE_HIGH_V,
      riseCvAt: () => Infinity,
      fallCvAt: () => -Infinity,
    });
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(out[i]).toBeGreaterThanOrEqual(0);
      expect(out[i]).toBeLessThanOrEqual(CV_UNIPOLAR_MAX);
    }
  });
});

describe("functionGeneratorKernel — bouncing ball (the headline Cycle-gate patch)", () => {
  // The Maths patch this jack exists for: a master envelope holds Cycle high
  // AND drives Fall CV. Positive volts lengthen the fall, so a decaying master
  // (10 V → 0 V) makes each successive cycle shorter — bounces that accelerate
  // while the gate holds, then stop cleanly at rest when it lets go.
  it("accelerates while the gate is held, then stops at 0 V when it drops", () => {
    const HOLD = SR; // 1 s of gate
    const total = Math.round(SR * 1.5);
    const master = (i: number) => (i < HOLD ? 4 * (1 - i / HOLD) : 0);

    const { out, eoc } = renderFunction({
      sr: SR,
      params: makeParams(0.002, 0.01),
      totalSamples: total,
      cycleAt: (i) => (i < HOLD ? GATE_HIGH_V : 0),
      fallCvAt: master,
    });

    // Collect the sample index of each fall completion (each "bounce").
    const bounces: number[] = [];
    for (let i = 1; i < total; i++) {
      if (eoc[i] === GATE_HIGH_V && eoc[i - 1] === 0) bounces.push(i);
    }
    expect(bounces.length).toBeGreaterThan(6);

    // The gaps between bounces shrink: the first is materially longer than the
    // last, and never grows along the way.
    const gaps: number[] = [];
    for (let i = 1; i < bounces.length; i++) gaps.push(bounces[i] - bounces[i - 1]);
    expect(gaps[0]).toBeGreaterThan(gaps[gaps.length - 1] * 2);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeLessThanOrEqual(gaps[i - 1]);
    }

    // Every bounce is a full-height one, and the ball comes to rest.
    expect(peakBetween(out, 0, HOLD)).toBeCloseTo(CV_UNIPOLAR_MAX, 3);
    for (let i = HOLD + Math.round(0.05 * SR); i < total; i++) expect(out[i]).toBe(0);
  });
});

describe("functionGeneratorKernel — EOR/EOC driving Cycle", () => {
  // EOR/EOC are movement-derived (EOR low only while rising, EOC low only
  // while falling), which makes their DUTY CYCLE a direct function of the
  // driving generator's Rise:Fall ratio. That ratio, not the patch, decides
  // whether a Cycle gate reads as "held", "bursting" or "trigger-width" —
  // the failure mode these tests exist to pin down.
  const OUT = 0;
  const EOR = 1;
  const EOC = 2;
  const TOTAL = SR * 2;

  // One generator whose own output feeds its Cycle slot, reproducing the
  // compiler's one-BLOCK feedback delay for a graph cycle (graph.ts marks the
  // back edge and the interpreter reads the previous block's buffer).
  function selfPatch(srcOut: number, params: Float32Array) {
    const state = functionGeneratorKernel.init(SR);
    const ins: (Float32Array | null)[] = [null, null, null, null, null, new Float32Array(BLOCK_FRAMES)];
    const outs = [
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
    ];
    const eoc = new Float32Array(TOTAL);
    let movingSamples = 0;
    for (let start = 0; start < TOTAL; start += BLOCK_FRAMES) {
      const n = Math.min(BLOCK_FRAMES, TOTAL - start);
      functionGeneratorKernel.process(state, ins, outs, params, n);
      eoc.set(outs[EOC].subarray(0, n), start);
      for (let i = 0; i < n; i++) if (outs[OUT][i] > 0.01) movingSamples++;
      ins[5]!.set(outs[srcOut].subarray(0, n));
    }
    return { cycles: countCycles(eoc), activeFraction: movingSamples / TOTAL };
  }

  // Master (processed first, same block — an acyclic edge) drives slave Cycle.
  function crossPatch(srcOut: number, masterParams: Float32Array, slaveParams: Float32Array) {
    const m = functionGeneratorKernel.init(SR);
    const mIns: (Float32Array | null)[] = [null, null, null, null, null, null];
    const mOuts = [
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
    ];
    const s = functionGeneratorKernel.init(SR);
    const sIns: (Float32Array | null)[] = [null, null, null, null, null, new Float32Array(BLOCK_FRAMES)];
    const sOuts = [
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
    ];
    const eoc = new Float32Array(TOTAL);
    let gateHighSamples = 0;
    for (let start = 0; start < TOTAL; start += BLOCK_FRAMES) {
      const n = Math.min(BLOCK_FRAMES, TOTAL - start);
      functionGeneratorKernel.process(m, mIns, mOuts, masterParams, n);
      for (let i = 0; i < n; i++) {
        sIns[5]![i] = mOuts[srcOut][i];
        if (mOuts[srcOut][i] >= GATE_FIRE_THRESHOLD_V) gateHighSamples++;
      }
      functionGeneratorKernel.process(s, sIns, sOuts, slaveParams, n);
      eoc.set(sOuts[EOC].subarray(0, n), start);
    }
    return { slaveCycles: countCycles(eoc), gateDuty: gateHighSamples / TOTAL };
  }

  const STOCK = () => makeParams(0.01, 0.3);
  const SLAVE_FAST = () => makeParams(0.01, 0.04);

  it("self-patching EOR into Cycle free-runs (EOR is high through the whole fall)", () => {
    const { cycles, activeFraction } = selfPatch(EOR, STOCK());
    // Period ≈ Rise + Fall = 0.31 s → ~6 cycles in 2 s.
    expect(cycles).toBeGreaterThanOrEqual(5);
    expect(activeFraction).toBeGreaterThan(0.9); // essentially never at rest
  });

  it("self-patching EOC into Cycle free-runs too, re-arming at the bottom", () => {
    // EOC is low for the whole fall, so the fall completes with the gate low
    // and the generator rests — for the one block it takes EOC to go high
    // again, which restarts it. Net effect is still continuous cycling.
    const { cycles, activeFraction } = selfPatch(EOC, STOCK());
    expect(cycles).toBeGreaterThanOrEqual(5);
    expect(activeFraction).toBeGreaterThan(0.9);
  });

  it("a SYMMETRIC master turns either output into a ~50% gate that bursts the slave", () => {
    const master = makeParams(0.25, 0.25, 0, 1); // cycling on its own button
    for (const out of [EOR, EOC]) {
      const { slaveCycles, gateDuty } = crossPatch(out, master, SLAVE_FAST());
      expect(gateDuty).toBeGreaterThan(0.4);
      expect(gateDuty).toBeLessThan(0.6);
      // Slave period ≈ 0.05 s; at ~50% duty over 2 s that is ~20 cycles —
      // far more than the ~4 a trigger-width gate would allow.
      expect(slaveCycles).toBeGreaterThan(12);
    }
  });

  it("an ASYMMETRIC master makes EOR read as held-high and EOC as trigger-width", () => {
    // The trap: with the stock Rise 0.01 / Fall 0.3 the master spends ~3% of
    // each cycle rising, so EOR is high ~97% (slave never stops) and EOC is
    // high ~3%, i.e. ~10 ms — indistinguishable from a trigger.
    const master = makeParams(0.01, 0.3, 0, 1);
    const viaEor = crossPatch(EOR, master, SLAVE_FAST());
    const viaEoc = crossPatch(EOC, master, SLAVE_FAST());
    expect(viaEor.gateDuty).toBeGreaterThan(0.9);
    expect(viaEoc.gateDuty).toBeLessThan(0.1);
    // One slave cycle per master cycle through EOC — the "it does nothing" look.
    expect(viaEoc.slaveCycles).toBeLessThan(viaEor.slaveCycles / 3);
  });
});

describe("functionGeneratorKernel — Cycle control-flag telemetry", () => {
  // Drives the kernel for one block and returns the indicator bitmask the
  // Interpreter would forward (state.controlFlags). Bit 3 = Cycle, the 4th
  // params key.
  const CYCLE_BIT = 1 << 3;

  function flagsAfterBlock(params: Float32Array, cycleVolts: number | null): number {
    const state = functionGeneratorKernel.init(SR) as unknown as { controlFlags: number };
    const ins: (Float32Array | null)[] = [null, null, null, null, null, null];
    if (cycleVolts !== null) ins[5] = new Float32Array(BLOCK_FRAMES).fill(cycleVolts);
    const outs = [
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
    ];
    functionGeneratorKernel.process(state as never, ins, outs, params, BLOCK_FRAMES);
    return state.controlFlags;
  }

  const off = () => makeParams(0.01, 0.3, 0, 0);
  const on = () => makeParams(0.01, 0.3, 0, 1);

  it("is clear when neither the button nor the gate engages Cycle", () => {
    expect(flagsAfterBlock(off(), null)).toBe(0);
    expect(flagsAfterBlock(off(), 0)).toBe(0);
  });

  it("sets the Cycle bit when the BUTTON is on, with the jack unpatched", () => {
    expect(flagsAfterBlock(on(), null) & CYCLE_BIT).toBe(CYCLE_BIT);
  });

  it("sets the Cycle bit when the GATE is high and the button is off", () => {
    // The case the indicator exists for: the stored button value is still 0,
    // so a host drawing only the stored value would show nothing.
    expect(flagsAfterBlock(off(), GATE_HIGH_V) & CYCLE_BIT).toBe(CYCLE_BIT);
  });

  it("clears again when the gate goes low", () => {
    const state = functionGeneratorKernel.init(SR) as unknown as { controlFlags: number };
    const ins: (Float32Array | null)[] = [null, null, null, null, null, new Float32Array(BLOCK_FRAMES)];
    const outs = [
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
    ];
    ins[5]!.fill(GATE_HIGH_V);
    functionGeneratorKernel.process(state as never, ins, outs, off(), BLOCK_FRAMES);
    expect(state.controlFlags).toBe(CYCLE_BIT);

    ins[5]!.fill(0);
    functionGeneratorKernel.process(state as never, ins, outs, off(), BLOCK_FRAMES);
    expect(state.controlFlags).toBe(0);
  });

  it("touches no bit other than Cycle's", () => {
    expect(flagsAfterBlock(on(), GATE_HIGH_V)).toBe(CYCLE_BIT);
  });

  it("does not alter a single output sample", () => {
    // The indicator must be inert with respect to audio: the legacy baseline
    // suite already pins the unpatched render, and this asserts the telemetry
    // write specifically cannot have perturbed the block it was computed in.
    const withGate = renderFunction({
      sr: SR,
      params: makeParams(0.01, 0.05),
      totalSamples: BLOCK_FRAMES * 4,
      cycleAt: () => GATE_HIGH_V,
    });
    for (let i = 0; i < withGate.out.length; i++) {
      expect(Number.isFinite(withGate.out[i])).toBe(true);
    }
    expect(peakBetween(withGate.out, 0, BLOCK_FRAMES * 4)).toBeCloseTo(CV_UNIPOLAR_MAX, 3);
  });
});
