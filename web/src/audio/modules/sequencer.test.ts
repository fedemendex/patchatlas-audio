// @vitest-environment node

import { describe, it, expect } from "vitest";
import { sequencerKernel } from "./sequencer";
import { registry, isPlayable } from "./registry";
import { Interpreter } from "../engine/interpreter";
import type { EngineGraph } from "../engine/graph";
import { compilePatch } from "../engine/compile";
import type { Patch } from "../engine/patch";
import type { Kernel } from "../engine/kernel";
import type { ModuleDSP } from "./registry";
import {
  BLOCK_FRAMES,
  GATE_HIGH_V,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
} from "../engine/units";

const SR = 48000;

// Output slot order matches the registry entry: CV, Gate.
const CV = 0;
const GATE = 1;

// Param layout mirrors the registry "sequencer" entry: [Len, CV 1..8, On 1..8].
function makeParams(opts: { len?: number; cv: number[]; on?: number[] }): Float32Array {
  const p = new Float32Array(17);
  p[0] = opts.len ?? 8;
  for (let s = 0; s < 8; s++) p[1 + s] = opts.cv[s] ?? 0;
  for (let s = 0; s < 8; s++) p[9 + s] = opts.on ? (opts.on[s] ?? 0) : 1;
  return p;
}

function makeOuts(): Float32Array[] {
  return [new Float32Array(BLOCK_FRAMES), new Float32Array(BLOCK_FRAMES)];
}

/**
 * Renders `totalSamples` of the sequencer in BLOCK_FRAMES chunks from scripted
 * per-sample Clk / Rst volt scripts, returning the full CV and Gate outputs.
 */
function renderSeq(opts: {
  sr?: number;
  totalSamples: number;
  params: Float32Array;
  clkAt?: (sample: number) => number;
  rstAt?: (sample: number) => number;
  dirAt?: (sample: number) => number;
  selAt?: (sample: number) => number;
}): { cv: Float32Array; gate: Float32Array } {
  const sr = opts.sr ?? SR;
  const state = sequencerKernel.init(sr);
  const outs = makeOuts();
  const clkBuf = opts.clkAt ? new Float32Array(BLOCK_FRAMES) : null;
  const rstBuf = opts.rstAt ? new Float32Array(BLOCK_FRAMES) : null;
  const dirBuf = opts.dirAt ? new Float32Array(BLOCK_FRAMES) : null;
  const selBuf = opts.selAt ? new Float32Array(BLOCK_FRAMES) : null;
  const cv = new Float32Array(opts.totalSamples);
  const gate = new Float32Array(opts.totalSamples);
  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      if (clkBuf && opts.clkAt) clkBuf[i] = opts.clkAt(start + i);
      if (rstBuf && opts.rstAt) rstBuf[i] = opts.rstAt(start + i);
      if (dirBuf && opts.dirAt) dirBuf[i] = opts.dirAt(start + i);
      if (selBuf && opts.selAt) selBuf[i] = opts.selAt(start + i);
    }
    sequencerKernel.process(state, [clkBuf, rstBuf, dirBuf, selBuf], outs, opts.params, n);
    cv.set(outs[CV].subarray(0, n), start);
    gate.set(outs[GATE].subarray(0, n), start);
  }
  return { cv, gate };
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

function countGateRises(gate: Float32Array): number {
  let rises = 0;
  let prevHigh = false;
  for (let i = 0; i < gate.length; i++) {
    const high = gate[i] > 0;
    if (high && !prevHigh) rises++;
    prevHigh = high;
  }
  return rises;
}

// ── 1. Registry / seed ───────────────────────────────────────────────────────

describe("sequencer registry entry", () => {
  it("matches the seed: Clk/Rst/Dir/Sel inputs, CV/Gate outputs, Len + CV 1..8 + On 1..8", () => {
    const entry = registry.get("sequencer");
    expect(entry).toBeDefined();
    expect(entry?.inJacks).toEqual(["Clk", "Rst", "Dir", "Sel"]);
    expect(entry?.outJacks).toEqual(["CV", "Gate"]);
    expect(Object.keys(entry?.params ?? {})).toEqual([
      "Len",
      "CV 1", "CV 2", "CV 3", "CV 4", "CV 5", "CV 6", "CV 7", "CV 8",
      "On 1", "On 2", "On 3", "On 4", "On 5", "On 6", "On 7", "On 8",
    ]);
  });

  it("is playable", () => {
    expect(isPlayable("sequencer")).toBe(true);
  });

  it("is fully previewed (no preview block) now that Dir/Sel are wired", () => {
    expect(registry.get("sequencer")?.limitations).toBeUndefined();
  });

  it("uses the canonical sequencerKernel (identity)", () => {
    expect(registry.get("sequencer")?.kernel).toBe(sequencerKernel);
  });
});

// ── 2. Step advancement ───────────────────────────────────────────────────────

describe("sequencerKernel — step advancement", () => {
  const cv = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const pulseLen = 100;
  const edge = (k: number) => 1000 * k; // edges at 1000, 2000, …

  it("advances one step per rising edge; first edge latches step 0; holds between edges", () => {
    const params = makeParams({ cv });
    const { cv: out } = renderSeq({
      totalSamples: 9000,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
    });

    // Region after edge k holds the step value: edge1 latches step0, edge2→step1, …
    const expectedForEdge = (k: number) => cv[Math.max(0, k - 1)];
    for (let k = 1; k <= 8; k++) {
      const e = edge(k);
      // Changes on the edge sample itself…
      expect(out[e]).toBeCloseTo(expectedForEdge(k), 6);
      // …and holds constant until the next edge.
      const end = k < 8 ? edge(k + 1) : 9000;
      for (let i = e; i < end; i++) expect(out[i]).toBeCloseTo(expectedForEdge(k), 6);
    }
    // Before the first edge, CV sits at step 0.
    for (let i = 0; i < 1000; i++) expect(out[i]).toBeCloseTo(cv[0], 6);
  });

  it("a sustained-high clock advances only once, then holds until re-armed", () => {
    const params = makeParams({ cv });
    // Edge at 1000 (latch step0), edge at 2000 (→ step1), then held high forever.
    const { cv: out } = renderSeq({
      totalSamples: 50000,
      params,
      clkAt: (i) => {
        if (i >= 1000 && i < 1100) return GATE_HIGH_V; // pulse 1
        if (i >= 2000) return GATE_HIGH_V; // rises once at 2000, stays high
        return 0;
      },
    });
    // After the 2000 edge we are on step1 and never advance again.
    for (let i = 2000; i < 50000; i++) expect(out[i]).toBeCloseTo(cv[1], 6);
  });

  it("a slow ramp through the threshold region fires the gate exactly once", () => {
    const total = 20000;
    const params = makeParams({ cv });
    const { gate } = renderSeq({
      totalSamples: total,
      params,
      clkAt: (i) => (2 * i) / total, // 0 → 2 V, crosses both thresholds once
    });
    expect(countGateRises(gate)).toBe(1);
  });

  it("a clock held between the thresholds never fires", () => {
    const between = (GATE_REARM_THRESHOLD_V + GATE_FIRE_THRESHOLD_V) / 2;
    const params = makeParams({ cv });
    const { cv: out, gate } = renderSeq({
      totalSamples: 4000,
      params,
      clkAt: () => between,
    });
    for (let i = 0; i < 4000; i++) {
      expect(out[i]).toBeCloseTo(cv[0], 6); // never leaves step 0
      expect(gate[i]).toBe(0); // never gates
    }
  });
});

// ── 3. Step values & wrap ─────────────────────────────────────────────────────

describe("sequencerKernel — step values wrap after Len steps", () => {
  it("with Len=4 the pattern wraps to step 0 on the 5th advancing edge", () => {
    const cv = [0.11, 0.22, 0.33, 0.44, 0.55, 0.66, 0.77, 0.88];
    const params = makeParams({ len: 4, cv });
    const pulseLen = 100;
    const { cv: out } = renderSeq({
      totalSamples: 8000,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
    });
    // edge1 latch step0(0.11), edge2 step1(0.22), edge3 step2(0.33),
    // edge4 step3(0.44), edge5 wraps to step0(0.11), edge6 step1(0.22).
    const expected = [0.11, 0.11, 0.22, 0.33, 0.44, 0.11, 0.22];
    for (let k = 1; k <= 6; k++) {
      expect(out[1000 * k]).toBeCloseTo(expected[k], 6);
    }
  });
});

// ── 3b. Dir (direction) ───────────────────────────────────────────────────────

describe("sequencerKernel — Dir input", () => {
  const cv = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const pulseLen = 100;

  it("unpatched Dir preserves old forward stepping exactly", () => {
    const params = makeParams({ cv });
    const { cv: out } = renderSeq({
      totalSamples: 9000,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
    });
    const expectedForEdge = (k: number) => cv[Math.max(0, k - 1)];
    for (let k = 1; k <= 8; k++) {
      expect(out[1000 * k]).toBeCloseTo(expectedForEdge(k), 6);
    }
  });

  it("Dir low (explicit) steps forward, same as unpatched", () => {
    const params = makeParams({ cv });
    const { cv: out } = renderSeq({
      totalSamples: 5000,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
      dirAt: () => 0,
    });
    // edge1 latch step0, edge2 step1, edge3 step2, edge4 step3.
    expect(out[1000]).toBeCloseTo(cv[0], 6);
    expect(out[2000]).toBeCloseTo(cv[1], 6);
    expect(out[3000]).toBeCloseTo(cv[2], 6);
    expect(out[4000]).toBeCloseTo(cv[3], 6);
  });

  it("Dir high steps backward and wraps correctly", () => {
    const params = makeParams({ cv });
    const { cv: out } = renderSeq({
      totalSamples: 5000,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
      dirAt: () => GATE_HIGH_V,
    });
    // edge1 latches step0 (first-edge latch, direction irrelevant).
    expect(out[1000]).toBeCloseTo(cv[0], 6);
    // edge2 reverses to the last step (wraps 0 -> 7).
    expect(out[2000]).toBeCloseTo(cv[7], 6);
    // edge3 continues backward to step 6.
    expect(out[3000]).toBeCloseTo(cv[6], 6);
    // edge4 -> step 5.
    expect(out[4000]).toBeCloseTo(cv[5], 6);
  });

  it("direction is sampled on the clock edge, not continuously mid-step", () => {
    const params = makeParams({ cv });
    // Dir is high only for a brief window well after the second edge — it
    // must have no effect until the *next* edge samples it.
    const { cv: out } = renderSeq({
      totalSamples: 3500,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
      dirAt: (i) => (i >= 2500 && i < 2600 ? GATE_HIGH_V : 0),
    });
    // edge1 -> step0, edge2 (at 2000, Dir still low) -> step1 (forward).
    expect(out[2000]).toBeCloseTo(cv[1], 6);
    // Dir goes high mid-step (2500..2600): must not move the step early.
    expect(out[2600]).toBeCloseTo(cv[1], 6);
    // edge3 (at 3000) samples Dir high (having fallen back to 0 by then is
    // irrelevant — only the edge-sample value matters, and Dir is already
    // low again at 3000, so this edge steps forward to step2).
    expect(out[3000]).toBeCloseTo(cv[2], 6);
  });

  it("reset + Dir behavior is deterministic: reset repositions to 0, subsequent reverse edges wrap correctly", () => {
    const params = makeParams({ cv });
    const { cv: out } = renderSeq({
      totalSamples: 6000,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
      dirAt: () => GATE_HIGH_V,
      rstAt: (i) => (i >= 2500 && i < 2600 ? GATE_HIGH_V : 0),
    });
    // edge1 (1000) latches step0. Reset at 2500 forces step0 and re-arms the
    // first-edge latch. edge3 (3000) is now the post-reset first edge: it
    // latches step0 regardless of Dir.
    expect(out[3000]).toBeCloseTo(cv[0], 6);
    // edge4 (4000) is the first real reverse step after reset: wraps to 7.
    expect(out[4000]).toBeCloseTo(cv[7], 6);
    // edge5 (5000) continues backward to 6.
    expect(out[5000]).toBeCloseTo(cv[6], 6);
  });

  it("step telemetry (state.step) reports the actual current step in reverse mode", () => {
    const state = sequencerKernel.init(SR);
    const outs = makeOuts();
    const params = makeParams({ cv });
    const clkBuf = new Float32Array(BLOCK_FRAMES);
    const dirBuf = new Float32Array(BLOCK_FRAMES);
    dirBuf.fill(GATE_HIGH_V);
    // First block: rising edge at sample 10 (first edge -> latches step 0).
    clkBuf.fill(0);
    for (let i = 10; i < BLOCK_FRAMES; i++) clkBuf[i] = GATE_HIGH_V;
    sequencerKernel.process(state, [clkBuf, null, dirBuf, null], outs, params, BLOCK_FRAMES);
    expect(state.step).toBe(0);
    // Re-arm (low), then rising edge again -> reverse step to 7.
    clkBuf.fill(0);
    sequencerKernel.process(state, [clkBuf, null, dirBuf, null], outs, params, BLOCK_FRAMES);
    clkBuf.fill(GATE_HIGH_V);
    sequencerKernel.process(state, [clkBuf, null, dirBuf, null], outs, params, BLOCK_FRAMES);
    expect(state.step).toBe(7);
  });
});

// ── 3c. Sel (step-select) ─────────────────────────────────────────────────────

describe("sequencerKernel — Sel input", () => {
  const cv = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const pulseLen = 100;

  it("unpatched Sel preserves old forward-stepping behavior exactly", () => {
    const params = makeParams({ cv });
    const { cv: out } = renderSeq({
      totalSamples: 5000,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
    });
    expect(out[1000]).toBeCloseTo(cv[0], 6);
    expect(out[2000]).toBeCloseTo(cv[1], 6);
    expect(out[3000]).toBeCloseTo(cv[2], 6);
    expect(out[4000]).toBeCloseTo(cv[3], 6);
  });

  it("Sel 0 V selects step 0 (even on the first edge)", () => {
    const params = makeParams({ cv });
    const { cv: out } = renderSeq({
      totalSamples: 1500,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
      selAt: () => 0,
    });
    expect(out[1000]).toBeCloseTo(cv[0], 6);
  });

  it("Sel mid-range values select the expected step", () => {
    const params = makeParams({ cv }); // Len=8 (default), so stepCount = 8
    // 5 V of 10 V spans half of 8 steps -> floor(5/10*8) = 4.
    const { cv: out } = renderSeq({
      totalSamples: 1500,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
      selAt: () => 5,
    });
    expect(out[1000]).toBeCloseTo(cv[4], 6);
  });

  it("Sel 10 V (full range) clamps to the final active step", () => {
    const params = makeParams({ cv });
    const { cv: out } = renderSeq({
      totalSamples: 1500,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
      selAt: () => 10,
    });
    expect(out[1000]).toBeCloseTo(cv[7], 6);
  });

  it("negative Sel clamps to step 0", () => {
    const params = makeParams({ cv });
    const { cv: out } = renderSeq({
      totalSamples: 1500,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
      selAt: () => -3,
    });
    expect(out[1000]).toBeCloseTo(cv[0], 6);
  });

  it("overrange Sel (beyond 10 V) clamps to the final active step", () => {
    const params = makeParams({ cv });
    const { cv: out } = renderSeq({
      totalSamples: 1500,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
      selAt: () => 25,
    });
    expect(out[1000]).toBeCloseTo(cv[7], 6);
  });

  it("non-finite Sel is safe and reads as 0 V (selects step 0)", () => {
    const params = makeParams({ cv });
    const { cv: out, gate } = renderSeq({
      totalSamples: 1500,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
      selAt: () => NaN,
    });
    expect(Number.isFinite(out[1000])).toBe(true);
    expect(Number.isFinite(gate[1000])).toBe(true);
    expect(out[1000]).toBeCloseTo(cv[0], 6);
  });

  it("Sel is sampled on the clock edge: changing Sel between clocks doesn't move the step until the next edge", () => {
    const params = makeParams({ cv });
    const { cv: out } = renderSeq({
      totalSamples: 2500,
      params,
      clkAt: periodicClock(1000, 1000, pulseLen),
      // Sel reads 0 V through the first edge, then jumps to 8 V shortly after.
      selAt: (i) => (i < 1500 ? 0 : 8),
    });
    // edge1 (1000) samples Sel=0 -> step0.
    expect(out[1000]).toBeCloseTo(cv[0], 6);
    // Between edges the step must not change even though Sel changed at 1500.
    expect(out[1600]).toBeCloseTo(cv[0], 6);
    // edge2 (2000) samples the new Sel=8 -> floor(8/10*8)=6.
    expect(out[2000]).toBeCloseTo(cv[6], 6);
  });

  it("step telemetry (state.step) reports the selected step", () => {
    const state = sequencerKernel.init(SR);
    const outs = makeOuts();
    const params = makeParams({ cv });
    const clkBuf = new Float32Array(BLOCK_FRAMES);
    const selBuf = new Float32Array(BLOCK_FRAMES);
    selBuf.fill(10); // final step
    clkBuf.fill(0);
    for (let i = 10; i < BLOCK_FRAMES; i++) clkBuf[i] = GATE_HIGH_V;
    sequencerKernel.process(state, [clkBuf, null, null, selBuf], outs, params, BLOCK_FRAMES);
    expect(state.step).toBe(7);
  });
});

// ── 4. Reset ──────────────────────────────────────────────────────────────────

describe("sequencerKernel — reset", () => {
  it("a Rst rising edge returns to step 0 immediately, and the next clock re-latches step 0", () => {
    const cv = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const params = makeParams({ cv });
    const pulseLen = 100;
    const resetAt = 3500;
    const { cv: out } = renderSeq({
      totalSamples: 7000,
      params,
      // Edges at 1000 (step0), 2000 (step1), 3000 (step2), 4000, 5000.
      clkAt: periodicClock(1000, 1000, pulseLen),
      rstAt: (i) => (i >= resetAt && i < resetAt + 100 ? GATE_HIGH_V : 0),
    });

    // Just before reset we are on step 2.
    expect(out[3400]).toBeCloseTo(cv[2], 6);
    // Reset convention: CV snaps to step 0 on the reset sample itself.
    expect(out[resetAt]).toBeCloseTo(cv[0], 6);
    for (let i = resetAt; i < 4000; i++) expect(out[i]).toBeCloseTo(cv[0], 6);
    // The next clock edge (4000) re-latches step 0 (does not jump to step 1)…
    expect(out[4000]).toBeCloseTo(cv[0], 6);
    // …and only the following edge (5000) advances to step 1.
    expect(out[5000]).toBeCloseTo(cv[1], 6);
  });
});

// ── 5. Gate output ────────────────────────────────────────────────────────────

describe("sequencerKernel — gate output", () => {
  it("gate is GATE_HIGH_V for ~half the measured clock period after each step", () => {
    const cv = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const params = makeParams({ cv });
    const period = 4000;
    const pulseLen = 50;
    const { gate } = renderSeq({
      totalSamples: 20000,
      params,
      clkAt: periodicClock(1000, period, pulseLen),
    });

    // Edge 2 lands at 1000 + period = 5000 and has a measured period (4000),
    // so its gate is high for round(0.5·4000) = 2000 samples.
    const e2 = 5000;
    let highCount = 0;
    for (let i = e2; i < e2 + period; i++) {
      if (gate[i] > 0) {
        expect(gate[i]).toBe(GATE_HIGH_V);
        highCount++;
      }
    }
    expect(highCount).toBe(2000);
    // Gate is low for the back half of the step.
    expect(gate[e2 + 2000]).toBe(0);
    expect(gate[e2 + period - 1]).toBe(0);
  });

  it("gate re-triggers on every enabled step (one rising edge per clock edge)", () => {
    const cv = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const params = makeParams({ cv });
    const { gate } = renderSeq({
      totalSamples: 20000,
      params,
      clkAt: periodicClock(1000, 4000, 50), // edges at 1000, 5000, 9000, 13000, 17000
    });
    expect(countGateRises(gate)).toBe(5);
  });

  it("a disabled (On=0) step is a rest: gate stays low but CV still updates", () => {
    const cv = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    // Step 1 (index 1) is off.
    const params = makeParams({ cv, on: [1, 0, 1, 1, 1, 1, 1, 1] });
    const period = 4000;
    const { cv: out, gate } = renderSeq({
      totalSamples: 20000,
      params,
      clkAt: periodicClock(1000, period, 50),
    });
    // Edge 2 at 5000 selects step1 (the rest): CV updates, gate stays low.
    const e2 = 5000;
    for (let i = e2; i < e2 + period; i++) {
      expect(gate[i]).toBe(0);
      expect(out[i]).toBeCloseTo(cv[1], 6);
    }
    // Edge 3 at 9000 selects step2 (enabled): gate fires again.
    expect(gate[9000]).toBe(GATE_HIGH_V);
  });

  it("gate rises on the same sample the CV changes (aligned with the active step)", () => {
    const cv = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const params = makeParams({ cv });
    const period = 4000;
    const { cv: out, gate } = renderSeq({
      totalSamples: 12000,
      params,
      clkAt: periodicClock(1000, period, 50),
    });
    const e2 = 5000;
    // CV became step1 exactly at e2, and the gate is high at e2.
    expect(out[e2]).toBeCloseTo(cv[1], 6);
    expect(out[e2 - 1]).toBeCloseTo(cv[0], 6);
    expect(gate[e2]).toBe(GATE_HIGH_V);
  });
});

// ── 6. Safety ─────────────────────────────────────────────────────────────────

describe("sequencerKernel — safety", () => {
  it("non-finite Clk / Rst samples never advance or crash; outputs stay finite", () => {
    const cv = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const params = makeParams({ cv });
    const { cv: out, gate } = renderSeq({
      totalSamples: 2000,
      params,
      clkAt: (i) => (i % 2 === 0 ? NaN : Infinity),
      rstAt: (i) => (i % 3 === 0 ? -Infinity : NaN),
    });
    for (let i = 0; i < 2000; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(Number.isFinite(gate[i])).toBe(true);
      expect(out[i]).toBeCloseTo(cv[0], 6); // never advanced
    }
  });

  it("a non-finite step CV param falls back to 0 V", () => {
    const cv = [NaN, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const params = makeParams({ cv });
    const { cv: out } = renderSeq({ totalSamples: 500, params }); // no clock → step 0
    for (let i = 0; i < 500; i++) expect(out[i]).toBe(0);
  });

  it("writes every declared output for a partial block, no stale sentinel samples", () => {
    const state = sequencerKernel.init(SR);
    const outs = makeOuts();
    for (const o of outs) o.fill(999);
    const n = 17;
    const params = makeParams({ cv: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] });
    sequencerKernel.process(state, [null, null, null, null], outs, params, n);
    for (const o of outs) {
      for (let i = 0; i < n; i++) expect(o[i]).not.toBe(999);
      for (let i = n; i < BLOCK_FRAMES; i++) expect(o[i]).toBe(999);
    }
  });
});

// ── 7. On defaults through the compiler (missing → ON, explicit OFF rests) ────
// Generic Patch, not the PatchAtlas adapter (#286: modules/ may not depend on
// PatchAtlas domain types) — params are engine units keyed by seed control
// NAME directly, so an omitted "On n" falls back to the registry default (1 =
// ON) via resolvePatch (diagnostics.ts), exactly as an explicit 0 rests it.

describe("sequencer On defaults — missing params gate, explicit Off rests", () => {
  function compileSeqParams(params: Record<string, number>): Float32Array {
    const patch: Patch = { modules: [{ id: "seq", type: "sequencer", params }], connections: [] };
    const { graph } = compilePatch(patch, registry);
    const node = graph.nodes.find((n) => n.instanceId === "seq")!;
    return new Float32Array(node.params); // [Len, CV 1..8, On 1..8]
  }

  const ON_BASE = 9; // params[9..16] are On 1..8

  it("a fresh sequencer (no On params) compiles every step to ON and gates all steps", () => {
    const params = compileSeqParams({});
    for (let s = 0; s < 8; s++) expect(params[ON_BASE + s]).toBe(1);

    const period = 4000;
    const { gate } = renderSeq({
      totalSamples: 8 * period + 2000,
      params,
      clkAt: periodicClock(1000, period, 50),
    });
    // Edges at 1000, 5000, … 33000 → 9 within the window, each an enabled step.
    expect(countGateRises(gate)).toBe(9);
  });

  it("an explicit Off on one step rests it while the others still gate", () => {
    const params = compileSeqParams({ "On 3": 0 }); // On 3 → step index 2
    expect(params[ON_BASE + 2]).toBe(0);
    for (let s = 0; s < 8; s++) if (s !== 2) expect(params[ON_BASE + s]).toBe(1);

    const period = 4000;
    const { gate } = renderSeq({
      totalSamples: 8 * period + 2000,
      params,
      clkAt: periodicClock(1000, period, 50),
    });
    // Edge 3 (step index 2) lands at 1000 + 2·period = 9000: the rest step.
    const restEdge = 1000 + 2 * period;
    for (let i = restEdge; i < restEdge + period; i++) expect(gate[i]).toBe(0);
    // But the step before it (edge 2 → step 1) did gate.
    expect(gate[1000 + period]).toBe(GATE_HIGH_V);
  });
});

// ── 8. Interpreter integration: clock → sequencer ─────────────────────────────

describe("clock → sequencer through the Interpreter", () => {
  it("the sequencer advances at the clock's timing and emits stored step CVs in order", () => {
    // Test-only tap (channels:1) exposes the sequencer's raw CV undistorted —
    // routing through audio-output would DC-block/soft-clip the DC-like steps.
    const tapKernel: Kernel<null> = {
      init: () => null,
      process(_state, ins, outs, _params, n) {
        const src = ins[0];
        const out = outs[0];
        for (let i = 0; i < n; i++) out[i] = src === null ? 0 : src[i];
      },
    };
    const fixtureRegistry = new Map<string, ModuleDSP>(registry);
    fixtureRegistry.set("test-tap", {
      slug: "test-tap",
      kernel: tapKernel,
      inJacks: ["In"],
      outJacks: [],
      params: {},
      audioOutput: { channels: 1 },
    });

    const bpm = 120;
    const period = (SR * 60) / bpm; // 24000 samples per step
    const stepCv = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6];
    // Sequencer params array in registry slot order: [Len, CV 1..8, On 1..8].
    const seqParams = [8, ...stepCv, 1, 1, 1, 1, 1, 1, 1, 1];

    const graph: EngineGraph = {
      nodes: [
        { instanceId: "clock", slug: "clock", params: [bpm] },
        { instanceId: "seq", slug: "sequencer", params: seqParams },
        { instanceId: "tap", slug: "test-tap", params: [] },
      ],
      edges: [
        { from: [0, 0], to: [1, 0], feedback: false }, // clock.Clk → seq.Clk
        { from: [1, 0], to: [2, 0], feedback: false }, // seq.CV → tap.In
      ],
      outputNodes: [2],
    };

    const interp = new Interpreter(graph, fixtureRegistry, SR);
    const totalSamples = period * 5 + 100;
    const tapped = new Float32Array(totalSamples);
    const l = new Float32Array(BLOCK_FRAMES);
    const r = new Float32Array(BLOCK_FRAMES);
    for (let start = 0; start < totalSamples; start += BLOCK_FRAMES) {
      const n = Math.min(BLOCK_FRAMES, totalSamples - start);
      interp.runBlock(n);
      interp.readOutput(l, r, n);
      tapped.set(l.subarray(0, n), start);
    }

    // Tick m lands at sample m·period. Tick 0 latches step 0; each later tick
    // advances one step, so tick m selects step m.
    for (let m = 0; m < 5; m++) {
      const t = m * period;
      expect(tapped[t]).toBeCloseTo(stepCv[m], 5);
      // Held constant across the whole step until the next tick.
      for (let i = t + 1; i < t + period; i++) {
        expect(tapped[i]).toBeCloseTo(stepCv[m], 5);
      }
    }
  });
});

// ── 8b. Interpreter step reporting (UI telemetry) ─────────────────────────────

describe("Interpreter step reporting for the sequencer", () => {
  it("exposes an advancing current step via stepReportIds / readSteps", () => {
    const bpm = 120;
    const period = (SR * 60) / bpm; // 24000
    const seqParams = [8, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1, 1, 1, 1, 1, 1, 1, 1];
    const graph: EngineGraph = {
      nodes: [
        { instanceId: "clock", slug: "clock", params: [bpm] },
        { instanceId: "seq", slug: "sequencer", params: seqParams },
      ],
      edges: [{ from: [0, 0], to: [1, 0], feedback: false }], // clock.Clk → seq.Clk
      outputNodes: [],
    };
    const interp = new Interpreter(graph, registry, SR);
    // Only the sequencer reports a step.
    expect(interp.stepReportIds).toEqual(["seq"]);

    const steps = new Int32Array(1);
    const seen: number[] = [];
    const totalSamples = Math.floor(4.5 * period); // ticks 0..4, not yet 5
    for (let start = 0; start < totalSamples; start += BLOCK_FRAMES) {
      const n = Math.min(BLOCK_FRAMES, totalSamples - start);
      interp.runBlock(n);
      interp.readSteps(steps);
      if (seen.length === 0 || seen[seen.length - 1] !== steps[0]) seen.push(steps[0]);
    }
    // Step 0 latched on tick 0, then one advance per tick.
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("reports no step-nodes when the graph has no sequencer", () => {
    const graph: EngineGraph = {
      nodes: [{ instanceId: "osc", slug: "oscillator", params: [0, 0, 0, 0, 0.5] }],
      edges: [],
      outputNodes: [],
    };
    const interp = new Interpreter(graph, registry, SR);
    expect(interp.stepReportIds).toEqual([]);
  });
});
