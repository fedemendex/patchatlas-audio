// @vitest-environment node

import { describe, it, expect } from "vitest";
import { sequentialSwitchNTo1Kernel } from "./sequentialSwitchNTo1";
import { registry, isPlayable } from "./registry";
import { BLOCK_FRAMES, GATE_HIGH_V, CV_UNIPOLAR_MAX } from "../engine/units";

const SR = 48000;
const STEP_COUNT = 4;

// Param layout mirrors the registry "sequential-switch-n-to-1" entry: [Steps].
function makeParams(steps: number): Float32Array {
  const p = new Float32Array(1);
  p[0] = steps;
  return p;
}

function makeOuts(): Float32Array[] {
  return [new Float32Array(BLOCK_FRAMES)];
}

// A periodic clock: high for `pulseLen` samples starting at every `period`
// boundary from `first`. Rising edges land exactly on those boundaries.
function periodicClock(first: number, period: number, pulseLen: number) {
  return (i: number): number => {
    if (i < first) return 0;
    const phase = (i - first) % period;
    return phase < pulseLen ? GATE_HIGH_V : 0;
  };
}

function renderSwitch(opts: {
  sr?: number;
  totalSamples: number;
  params: Float32Array;
  inAt?: (step: number, sample: number) => number; // per-input value generator
  clkAt?: (sample: number) => number;
  rstAt?: (sample: number) => number;
  selAt?: (sample: number) => number;
}): { out: Float32Array } {
  const sr = opts.sr ?? SR;
  const state = sequentialSwitchNTo1Kernel.init(sr);
  const outs = makeOuts();
  const inBufs: (Float32Array | null)[] = [];
  for (let s = 0; s < STEP_COUNT; s++) inBufs.push(opts.inAt ? new Float32Array(BLOCK_FRAMES) : null);
  const clkBuf = opts.clkAt ? new Float32Array(BLOCK_FRAMES) : null;
  const rstBuf = opts.rstAt ? new Float32Array(BLOCK_FRAMES) : null;
  const selBuf = opts.selAt ? new Float32Array(BLOCK_FRAMES) : null;
  const out = new Float32Array(opts.totalSamples);
  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      if (opts.inAt) for (let s = 0; s < STEP_COUNT; s++) inBufs[s]![i] = opts.inAt(s, start + i);
      if (clkBuf && opts.clkAt) clkBuf[i] = opts.clkAt(start + i);
      if (rstBuf && opts.rstAt) rstBuf[i] = opts.rstAt(start + i);
      if (selBuf && opts.selAt) selBuf[i] = opts.selAt(start + i);
    }
    sequentialSwitchNTo1Kernel.process(
      state,
      [...inBufs, clkBuf, rstBuf, selBuf],
      outs,
      opts.params,
      n,
    );
    out.set(outs[0].subarray(0, n), start);
  }
  return { out };
}

// Inputs carry distinct constant voltages In1=100, In2=200, In3=300, In4=400
// so the active step can be read back from the output value.
function fourInputs(s: number, _i: number): number {
  return (s + 1) * 100;
}
function stepFromValue(v: number): number {
  return Math.round(v / 100) - 1;
}

// ── 1. Registry / seed ───────────────────────────────────────────────────────

describe("sequential-switch-n-to-1 registry entry", () => {
  it("matches the seed: In 1..4/Clk/Rst/Sel inputs, single Out, Steps control", () => {
    const entry = registry.get("sequential-switch-n-to-1");
    expect(entry).toBeDefined();
    expect(entry?.inJacks).toEqual(["In 1", "In 2", "In 3", "In 4", "Clk", "Rst", "Sel"]);
    expect(entry?.outJacks).toEqual(["Out"]);
    expect(Object.keys(entry?.params ?? {})).toEqual(["Steps"]);
  });

  it("is playable", () => {
    expect(isPlayable("sequential-switch-n-to-1")).toBe(true);
  });

  it("is fully previewed (no preview block)", () => {
    expect(registry.get("sequential-switch-n-to-1")?.limitations).toBeUndefined();
  });

  it("uses the canonical sequentialSwitchNTo1Kernel (identity)", () => {
    expect(registry.get("sequential-switch-n-to-1")?.kernel).toBe(sequentialSwitchNTo1Kernel);
  });
});

// ── 2. Steps = 1 — pinned to In 1 ─────────────────────────────────────────────

describe("sequentialSwitchNTo1Kernel — Steps = 1", () => {
  it("routes In 1 to Out only, forever, even across many clock edges", () => {
    const params = makeParams(1);
    const first = 100;
    const period = 500;
    const { out } = renderSwitch({
      totalSamples: first + 10 * period,
      params,
      inAt: fourInputs,
      clkAt: periodicClock(first, period, 50),
    });
    for (let k = 0; k < 9; k++) {
      const e = first + k * period;
      expect(out[e]).toBe(100); // In 1
    }
  });

  it("stays pinned to In 1 even when Sel points elsewhere", () => {
    const params = makeParams(1);
    const first = 100;
    const period = 500;
    const { out } = renderSwitch({
      totalSamples: first + 3 * period,
      params,
      inAt: fourInputs,
      clkAt: periodicClock(first, period, 50),
      selAt: () => CV_UNIPOLAR_MAX, // would address the last input if the pool were bigger
    });
    for (let k = 0; k < 2; k++) {
      const e = first + k * period;
      expect(out[e]).toBe(100);
    }
  });
});

// ── 3. Steps = 4 — full rotation ──────────────────────────────────────────────

describe("sequentialSwitchNTo1Kernel — Steps = 4 (default)", () => {
  const first = 1000;
  const period = 5000;

  it("first edge latches In 1 (no advance); subsequent edges rotate forward and wrap", () => {
    const params = makeParams(4);
    const { out } = renderSwitch({
      totalSamples: first + 6 * period,
      params,
      inAt: fourInputs,
      clkAt: periodicClock(first, period, 100),
    });
    const expectedSteps = [0, 1, 2, 3, 0, 1];
    for (let k = 0; k < expectedSteps.length; k++) {
      const e = first + k * period;
      expect(stepFromValue(out[e])).toBe(expectedSteps[k]);
    }
  });

  it("Rst returns the active step to In 1 and re-arms the first-edge latch", () => {
    const params = makeParams(4);
    const resetAt = first + 2 * period + 500; // between edge2 (In 2) and edge3
    const { out } = renderSwitch({
      totalSamples: resetAt + period,
      params,
      inAt: fourInputs,
      clkAt: periodicClock(first, period, 100),
      rstAt: (i) => (i >= resetAt && i < resetAt + 100 ? GATE_HIGH_V : 0),
    });
    const nextEdge = first + 3 * period;
    expect(stepFromValue(out[nextEdge])).toBe(0);
  });
});

// ── 4. Sel addressing ─────────────────────────────────────────────────────────

describe("sequentialSwitchNTo1Kernel — Sel addressing", () => {
  const first = 1000;
  const period = 5000;

  it("Sel takes priority over rotation on every edge, including the first", () => {
    const params = makeParams(4);
    const selForEdge = [0, CV_UNIPOLAR_MAX * 0.3, CV_UNIPOLAR_MAX * 0.6, CV_UNIPOLAR_MAX * 0.99];
    const { out } = renderSwitch({
      totalSamples: first + 4 * period,
      params,
      inAt: fourInputs,
      clkAt: periodicClock(first, period, 100),
      selAt: (i) => {
        const k = Math.floor((i - first) / period);
        return k >= 0 && k < 4 ? selForEdge[k] : 0;
      },
    });
    const expectedSteps = [0, 1, 2, 3];
    for (let k = 0; k < 4; k++) {
      const e = first + k * period;
      expect(stepFromValue(out[e])).toBe(expectedSteps[k]);
    }
  });

  it("clamps Sel to the active pool when Steps < 4", () => {
    const params = makeParams(2);
    const { out } = renderSwitch({
      totalSamples: first + period,
      params,
      inAt: fourInputs,
      clkAt: periodicClock(first, period, 100),
      selAt: () => CV_UNIPOLAR_MAX, // would be step 3 at full pool, clamps to step 1
    });
    expect(stepFromValue(out[first])).toBe(1);
  });

  it("non-finite Sel reads as 0 V (In 1)", () => {
    const params = makeParams(4);
    const { out } = renderSwitch({
      totalSamples: first + period,
      params,
      inAt: fourInputs,
      clkAt: periodicClock(first, period, 100),
      selAt: () => NaN,
    });
    expect(stepFromValue(out[first])).toBe(0);
  });
});

// ── 5. Safety ─────────────────────────────────────────────────────────────────

describe("sequentialSwitchNTo1Kernel — safety", () => {
  it("non-finite In/Clk/Rst/Sel samples never crash; output stays finite", () => {
    const params = makeParams(4);
    const { out } = renderSwitch({
      totalSamples: 2000,
      params,
      inAt: (s, i) => (i % (s + 2) === 0 ? NaN : Infinity),
      clkAt: (i) => (i % 2 === 0 ? NaN : Infinity),
      rstAt: (i) => (i % 3 === 0 ? -Infinity : NaN),
      selAt: (i) => (i % 5 === 0 ? NaN : Infinity),
    });
    for (let i = 0; i < 2000; i++) expect(Number.isFinite(out[i])).toBe(true);
  });

  it("a non-finite Steps param falls back to a safe full pool, not zero/NaN", () => {
    const params = makeParams(NaN);
    const { out } = renderSwitch({
      totalSamples: 2000,
      params,
      inAt: fourInputs,
      clkAt: periodicClock(500, 400, 50),
    });
    let sawIn2 = false;
    for (let i = 0; i < 2000; i++) if (out[i] === 200) sawIn2 = true;
    expect(sawIn2).toBe(true);
  });

  it("unpatched inputs read as 0 V on Out", () => {
    const params = makeParams(4);
    const { out } = renderSwitch({
      totalSamples: 200,
      params,
      clkAt: periodicClock(50, 400, 50),
    });
    for (let i = 0; i < 200; i++) expect(out[i]).toBe(0);
  });

  it("writes Out for a partial block, no stale sentinel samples", () => {
    const state = sequentialSwitchNTo1Kernel.init(SR);
    const outs = makeOuts();
    outs[0].fill(999);
    const n = 17;
    const params = makeParams(4);
    sequentialSwitchNTo1Kernel.process(state, [null, null, null, null, null, null, null], outs, params, n);
    for (let i = 0; i < n; i++) expect(outs[0][i]).not.toBe(999);
    for (let i = n; i < BLOCK_FRAMES; i++) expect(outs[0][i]).toBe(999);
  });
});
