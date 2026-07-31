// @vitest-environment node

import { describe, it, expect } from "vitest";
import { sequentialSwitch1ToNKernel } from "./sequentialSwitch1ToN";
import { registry, isPlayable } from "./registry";
import { BLOCK_FRAMES, GATE_HIGH_V, CV_UNIPOLAR_MAX } from "../engine/units";

const SR = 48000;
const STEP_COUNT = 4;

// Param layout mirrors the registry "sequential-switch-1-to-n" entry: [Steps].
function makeParams(steps: number): Float32Array {
  const p = new Float32Array(1);
  p[0] = steps;
  return p;
}

function makeOuts(): Float32Array[] {
  const outs: Float32Array[] = [];
  for (let i = 0; i < STEP_COUNT; i++) outs.push(new Float32Array(BLOCK_FRAMES));
  return outs;
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
  inAt?: (sample: number) => number;
  clkAt?: (sample: number) => number;
  rstAt?: (sample: number) => number;
  selAt?: (sample: number) => number;
}): { outs: Float32Array[] } {
  const sr = opts.sr ?? SR;
  const state = sequentialSwitch1ToNKernel.init(sr);
  const outs = makeOuts();
  const inBuf = opts.inAt ? new Float32Array(BLOCK_FRAMES) : null;
  const clkBuf = opts.clkAt ? new Float32Array(BLOCK_FRAMES) : null;
  const rstBuf = opts.rstAt ? new Float32Array(BLOCK_FRAMES) : null;
  const selBuf = opts.selAt ? new Float32Array(BLOCK_FRAMES) : null;
  const recorded: Float32Array[] = [];
  for (let s = 0; s < STEP_COUNT; s++) recorded.push(new Float32Array(opts.totalSamples));
  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      if (inBuf && opts.inAt) inBuf[i] = opts.inAt(start + i);
      if (clkBuf && opts.clkAt) clkBuf[i] = opts.clkAt(start + i);
      if (rstBuf && opts.rstAt) rstBuf[i] = opts.rstAt(start + i);
      if (selBuf && opts.selAt) selBuf[i] = opts.selAt(start + i);
    }
    sequentialSwitch1ToNKernel.process(state, [inBuf, clkBuf, rstBuf, selBuf], outs, opts.params, n);
    for (let s = 0; s < STEP_COUNT; s++) recorded[s].set(outs[s].subarray(0, n), start);
  }
  return { outs: recorded };
}

function activeStepAt(outs: Float32Array[], i: number): number | null {
  for (let s = 0; s < STEP_COUNT; s++) if (outs[s][i] !== 0) return s;
  return null;
}

// ── 1. Registry / seed ───────────────────────────────────────────────────────

describe("sequential-switch-1-to-n registry entry", () => {
  it("matches the seed: In/Clk/Rst/Sel inputs, Out 1..4 outputs, Steps control", () => {
    const entry = registry.get("sequential-switch-1-to-n");
    expect(entry).toBeDefined();
    expect(entry?.inJacks).toEqual(["In", "Clk", "Rst", "Sel"]);
    expect(entry?.outJacks).toEqual(["Out 1", "Out 2", "Out 3", "Out 4"]);
    expect(Object.keys(entry?.params ?? {})).toEqual(["Steps"]);
  });

  it("is playable", () => {
    expect(isPlayable("sequential-switch-1-to-n")).toBe(true);
  });

  it("is fully previewed (no preview block)", () => {
    expect(registry.get("sequential-switch-1-to-n")?.preview).toBeUndefined();
  });

  it("uses the canonical sequentialSwitch1ToNKernel (identity)", () => {
    expect(registry.get("sequential-switch-1-to-n")?.kernel).toBe(sequentialSwitch1ToNKernel);
  });
});

// ── 2. Steps = 1 — pinned to Out 1 ────────────────────────────────────────────

describe("sequentialSwitch1ToNKernel — Steps = 1", () => {
  it("routes In to Out 1 only, forever, even across many clock edges", () => {
    const params = makeParams(1);
    const first = 100;
    const period = 500;
    const { outs } = renderSwitch({
      totalSamples: first + 10 * period,
      params,
      inAt: () => 7,
      clkAt: periodicClock(first, period, 50),
    });
    for (let k = 0; k < 9; k++) {
      const e = first + k * period;
      expect(outs[0][e]).toBe(7);
      expect(outs[1][e]).toBe(0);
      expect(outs[2][e]).toBe(0);
      expect(outs[3][e]).toBe(0);
    }
  });

  it("stays pinned to Out 1 even when Sel points elsewhere", () => {
    const params = makeParams(1);
    const first = 100;
    const period = 500;
    const { outs } = renderSwitch({
      totalSamples: first + 3 * period,
      params,
      inAt: () => 5,
      clkAt: periodicClock(first, period, 50),
      selAt: () => CV_UNIPOLAR_MAX, // would address the last step if the pool were bigger
    });
    for (let k = 0; k < 2; k++) {
      const e = first + k * period;
      expect(outs[0][e]).toBe(5);
      expect(outs[1][e]).toBe(0);
    }
  });
});

// ── 3. Steps = 4 — full rotation ──────────────────────────────────────────────

describe("sequentialSwitch1ToNKernel — Steps = 4 (default)", () => {
  const first = 1000;
  const period = 5000;

  it("first edge latches Out 1 (no advance); subsequent edges rotate forward and wrap", () => {
    const params = makeParams(4);
    const { outs } = renderSwitch({
      totalSamples: first + 6 * period,
      params,
      inAt: () => 3,
      clkAt: periodicClock(first, period, 100),
    });
    const expectedSteps = [0, 1, 2, 3, 0, 1];
    for (let k = 0; k < expectedSteps.length; k++) {
      const e = first + k * period;
      expect(activeStepAt(outs, e)).toBe(expectedSteps[k]);
    }
  });

  it("only the active output carries In; the others read 0 V", () => {
    const params = makeParams(4);
    const { outs } = renderSwitch({
      totalSamples: first + period + 100,
      params,
      inAt: () => 9,
      clkAt: periodicClock(first, period, 100),
    });
    for (let s = 0; s < STEP_COUNT; s++) {
      expect(outs[s][first]).toBe(s === 0 ? 9 : 0);
    }
  });

  it("Rst returns the active step to Out 1 and re-arms the first-edge latch", () => {
    const params = makeParams(4);
    const resetAt = first + 2 * period + 500; // between edge2 (Out 2) and edge3
    const { outs } = renderSwitch({
      totalSamples: resetAt + period,
      params,
      inAt: () => 4,
      clkAt: periodicClock(first, period, 100),
      rstAt: (i) => (i >= resetAt && i < resetAt + 100 ? GATE_HIGH_V : 0),
    });
    // Next clock edge after reset re-latches Out 1, not Out 4 (the would-be advance).
    const nextEdge = first + 3 * period;
    expect(activeStepAt(outs, nextEdge)).toBe(0);
  });
});

// ── 4. Sel addressing ─────────────────────────────────────────────────────────

describe("sequentialSwitch1ToNKernel — Sel addressing", () => {
  const first = 1000;
  const period = 5000;

  it("Sel takes priority over rotation on every edge, including the first", () => {
    const params = makeParams(4);
    // Sel sweeps to different quadrants of 0..10V for each of 4 edges.
    const selForEdge = [0, CV_UNIPOLAR_MAX * 0.3, CV_UNIPOLAR_MAX * 0.6, CV_UNIPOLAR_MAX * 0.99];
    const { outs } = renderSwitch({
      totalSamples: first + 4 * period,
      params,
      inAt: () => 2,
      clkAt: periodicClock(first, period, 100),
      selAt: (i) => {
        const k = Math.floor((i - first) / period);
        return k >= 0 && k < 4 ? selForEdge[k] : 0;
      },
    });
    const expectedSteps = [0, 1, 2, 3];
    for (let k = 0; k < 4; k++) {
      const e = first + k * period;
      expect(activeStepAt(outs, e)).toBe(expectedSteps[k]);
    }
  });

  it("clamps Sel to the active pool when Steps < 4", () => {
    const params = makeParams(2);
    const { outs } = renderSwitch({
      totalSamples: first + period,
      params,
      inAt: () => 6,
      clkAt: periodicClock(first, period, 100),
      selAt: () => CV_UNIPOLAR_MAX, // would be step 3 at full pool, clamps to step 1
    });
    expect(activeStepAt(outs, first)).toBe(1);
  });

  it("non-finite Sel reads as 0 V (Out 1)", () => {
    const params = makeParams(4);
    const { outs } = renderSwitch({
      totalSamples: first + period,
      params,
      inAt: () => 1,
      clkAt: periodicClock(first, period, 100),
      selAt: () => NaN,
    });
    expect(activeStepAt(outs, first)).toBe(0);
  });
});

// ── 5. Steps shrinks mid-run ──────────────────────────────────────────────────

describe("sequentialSwitch1ToNKernel — Steps changes take effect immediately", () => {
  it("pins the active step into the new pool even without a fresh clock edge", () => {
    const state = sequentialSwitch1ToNKernel.init(SR);
    const outs = makeOuts();
    const inBuf = new Float32Array(BLOCK_FRAMES).fill(8);
    const clkBuf = new Float32Array(BLOCK_FRAMES);
    // Two edges to reach step 3 (Out 4) at full pool: first edge latches
    // step 0, second edge advances to step 1... run several edges via
    // repeated blocks instead, one edge per block for simplicity.
    const paramsFull = makeParams(4);
    // Advance to step 3 across 4 edges (one per call).
    for (let edge = 0; edge < 4; edge++) {
      clkBuf.fill(0);
      clkBuf[0] = GATE_HIGH_V;
      sequentialSwitch1ToNKernel.process(state, [inBuf, clkBuf, null, null], outs, paramsFull, BLOCK_FRAMES);
      clkBuf.fill(0);
      sequentialSwitch1ToNKernel.process(state, [inBuf, clkBuf, null, null], outs, paramsFull, BLOCK_FRAMES);
    }
    expect(activeStepAt(outs, 0)).toBe(3);

    // Now shrink the pool to 1 without any further clock edge.
    const paramsShrunk = makeParams(1);
    clkBuf.fill(0);
    sequentialSwitch1ToNKernel.process(state, [inBuf, clkBuf, null, null], outs, paramsShrunk, BLOCK_FRAMES);
    expect(activeStepAt(outs, 0)).toBe(0);
    expect(outs[0][0]).toBe(8);
  });
});

// ── 6. Safety ─────────────────────────────────────────────────────────────────

describe("sequentialSwitch1ToNKernel — safety", () => {
  it("non-finite In/Clk/Rst/Sel samples never crash; outputs stay finite", () => {
    const params = makeParams(4);
    const { outs } = renderSwitch({
      totalSamples: 2000,
      params,
      inAt: (i) => (i % 4 === 0 ? NaN : Infinity),
      clkAt: (i) => (i % 2 === 0 ? NaN : Infinity),
      rstAt: (i) => (i % 3 === 0 ? -Infinity : NaN),
      selAt: (i) => (i % 5 === 0 ? NaN : Infinity),
    });
    for (let i = 0; i < 2000; i++) {
      for (let s = 0; s < STEP_COUNT; s++) expect(Number.isFinite(outs[s][i])).toBe(true);
    }
  });

  it("a non-finite Steps param falls back to a safe full pool, not zero/NaN", () => {
    const params = makeParams(NaN);
    const { outs } = renderSwitch({
      totalSamples: 2000,
      params,
      inAt: () => 3,
      clkAt: periodicClock(500, 400, 50),
    });
    let sawOut2 = false;
    for (let i = 0; i < 2000; i++) if (outs[1][i] !== 0) sawOut2 = true;
    expect(sawOut2).toBe(true);
  });

  it("unpatched In reads as 0 V on the active output", () => {
    const params = makeParams(4);
    const { outs } = renderSwitch({
      totalSamples: 200,
      params,
      clkAt: periodicClock(50, 400, 50),
    });
    for (let i = 0; i < 200; i++) {
      for (let s = 0; s < STEP_COUNT; s++) expect(outs[s][i]).toBe(0);
    }
  });

  it("writes every declared output for a partial block, no stale sentinel samples", () => {
    const state = sequentialSwitch1ToNKernel.init(SR);
    const outs = makeOuts();
    for (const o of outs) o.fill(999);
    const n = 17;
    const params = makeParams(4);
    sequentialSwitch1ToNKernel.process(state, [null, null, null, null], outs, params, n);
    for (const o of outs) {
      for (let i = 0; i < n; i++) expect(o[i]).not.toBe(999);
      for (let i = n; i < BLOCK_FRAMES; i++) expect(o[i]).toBe(999);
    }
  });
});
