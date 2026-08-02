// @vitest-environment node

import { describe, it, expect } from "vitest";
import { triggerSequencerKernel } from "./triggerSequencer";
import { registry, isPlayable } from "./registry";
import { BLOCK_FRAMES, GATE_HIGH_V, TRIGGER_SECONDS } from "../engine/units";

const SR = 48000;
const STEP_COUNT = 8;
const EOC = STEP_COUNT; // outs[8]
const TRIG = STEP_COUNT + 1; // outs[9]
const GATE = STEP_COUNT + 2; // outs[10]
const TOTAL_OUTS = STEP_COUNT + 3;
const PULSE_SAMPLES = Math.round(TRIGGER_SECONDS * SR); // 48 at 48 kHz

// Param layout mirrors the registry "trigger-sequencer" entry: [Gate Len, On 1..8].
function makeParams(opts: { gateLen?: number; on?: number[] }): Float32Array {
  const p = new Float32Array(1 + STEP_COUNT);
  p[0] = opts.gateLen ?? 0.01;
  for (let s = 0; s < STEP_COUNT; s++) p[1 + s] = opts.on ? (opts.on[s] ?? 0) : 1;
  return p;
}

function makeOuts(): Float32Array[] {
  const outs: Float32Array[] = [];
  for (let i = 0; i < TOTAL_OUTS; i++) outs.push(new Float32Array(BLOCK_FRAMES));
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

function countRises(sig: Float32Array): number {
  let rises = 0;
  let prevHigh = false;
  for (let i = 0; i < sig.length; i++) {
    const high = sig[i] > 0;
    if (high && !prevHigh) rises++;
    prevHigh = high;
  }
  return rises;
}

function countHigh(sig: Float32Array, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (sig[i] > 0) n++;
  return n;
}

function renderTrig(opts: {
  sr?: number;
  totalSamples: number;
  params: Float32Array;
  clkAt?: (sample: number) => number;
  rstAt?: (sample: number) => number;
  cvAt?: (sample: number) => number;
}): { steps: Float32Array[]; eoc: Float32Array; trig: Float32Array; gate: Float32Array } {
  const sr = opts.sr ?? SR;
  const state = triggerSequencerKernel.init(sr);
  const outs = makeOuts();
  const clkBuf = opts.clkAt ? new Float32Array(BLOCK_FRAMES) : null;
  const rstBuf = opts.rstAt ? new Float32Array(BLOCK_FRAMES) : null;
  const cvBuf = opts.cvAt ? new Float32Array(BLOCK_FRAMES) : null;
  const steps: Float32Array[] = [];
  for (let s = 0; s < STEP_COUNT; s++) steps.push(new Float32Array(opts.totalSamples));
  const eoc = new Float32Array(opts.totalSamples);
  const trig = new Float32Array(opts.totalSamples);
  const gate = new Float32Array(opts.totalSamples);
  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      if (clkBuf && opts.clkAt) clkBuf[i] = opts.clkAt(start + i);
      if (rstBuf && opts.rstAt) rstBuf[i] = opts.rstAt(start + i);
      if (cvBuf && opts.cvAt) cvBuf[i] = opts.cvAt(start + i);
    }
    triggerSequencerKernel.process(state, [clkBuf, rstBuf, cvBuf], outs, opts.params, n);
    for (let s = 0; s < STEP_COUNT; s++) steps[s].set(outs[s].subarray(0, n), start);
    eoc.set(outs[EOC].subarray(0, n), start);
    trig.set(outs[TRIG].subarray(0, n), start);
    gate.set(outs[GATE].subarray(0, n), start);
  }
  return { steps, eoc, trig, gate };
}

// ── 1. Registry / seed ───────────────────────────────────────────────────────

describe("trigger-sequencer registry entry", () => {
  it("matches the seed: Clk/Rst/CV inputs, S1..S8/EOC/Trig/Gate outputs, Gate Len + On 1..8", () => {
    const entry = registry.get("trigger-sequencer");
    expect(entry).toBeDefined();
    expect(entry?.inJacks).toEqual(["Clk", "Rst", "CV"]);
    expect(entry?.outJacks).toEqual([
      "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "EOC", "Trig", "Gate",
    ]);
    expect(Object.keys(entry?.params ?? {})).toEqual([
      "Gate Len",
      "On 1", "On 2", "On 3", "On 4", "On 5", "On 6", "On 7", "On 8",
    ]);
  });

  it("is playable", () => {
    expect(isPlayable("trigger-sequencer")).toBe(true);
  });

  it("is fully previewed (no preview block)", () => {
    expect(registry.get("trigger-sequencer")?.limitations).toBeUndefined();
  });

  it("uses the canonical triggerSequencerKernel (identity)", () => {
    expect(registry.get("trigger-sequencer")?.kernel).toBe(triggerSequencerKernel);
  });
});

// ── 2. Step advancement (one-hot walking outputs) ─────────────────────────────

describe("triggerSequencerKernel — step advancement", () => {
  const gateLen = 0.01; // 480 samples at 48 kHz
  const gateSamples = Math.round(gateLen * SR);
  const period = 5000;
  const first = 1000;

  it("each clock edge lights exactly one S<n> output for the Gate Len duration; first edge lights S1", () => {
    const params = makeParams({ gateLen });
    const { steps, gate } = renderTrig({
      totalSamples: first + 7 * period + gateSamples + 100,
      params,
      clkAt: periodicClock(first, period, 100),
    });

    for (let k = 0; k < STEP_COUNT; k++) {
      const e = first + k * period;
      for (let s = 0; s < STEP_COUNT; s++) {
        const expectHigh = s === k;
        for (let i = e; i < e + gateSamples; i++) {
          expect(steps[s][i]).toBe(expectHigh ? GATE_HIGH_V : 0);
        }
      }
      // Combined Gate mirrors the active step's window.
      for (let i = e; i < e + gateSamples; i++) expect(gate[i]).toBe(GATE_HIGH_V);
      expect(gate[e + gateSamples + 10]).toBe(0);
    }
  });

  it("Trig fires a fixed TRIGGER_SECONDS pulse on every step, independent of Gate Len", () => {
    const longGateLen = 1.0; // 48000 samples — far longer than the trig pulse
    const params = makeParams({ gateLen: longGateLen });
    const { trig, steps } = renderTrig({
      totalSamples: first + period + 200,
      params,
      clkAt: periodicClock(first, period, 100),
    });
    expect(countHigh(trig, first, first + PULSE_SAMPLES)).toBe(PULSE_SAMPLES);
    expect(trig[first + PULSE_SAMPLES + 5]).toBe(0);
    // Meanwhile the step's own gate is still high (Gate Len far exceeds the trig pulse).
    expect(steps[0][first + PULSE_SAMPLES + 5]).toBe(GATE_HIGH_V);
  });
});

// ── 3. CV modulates Gate Len (1 V/oct) ────────────────────────────────────────

describe("triggerSequencerKernel — CV gate-length modulation", () => {
  const gateLen = 0.01; // base 480 samples
  const baseSamples = Math.round(gateLen * SR);
  const first = 1000;
  const period = 20000; // plenty of room to observe a long pulse

  it("+1 V doubles the gate length (1 V/oct)", () => {
    const params = makeParams({ gateLen });
    const { steps } = renderTrig({
      totalSamples: first + baseSamples * 3,
      params,
      clkAt: periodicClock(first, period, 100),
      cvAt: () => 1,
    });
    const expected = Math.round(baseSamples * 2);
    expect(countHigh(steps[0], first, first + expected)).toBe(expected);
    expect(steps[0][first + expected + 10]).toBe(0);
  });

  it("-1 V halves the gate length", () => {
    const params = makeParams({ gateLen });
    const { steps } = renderTrig({
      totalSamples: first + baseSamples * 2,
      params,
      clkAt: periodicClock(first, period, 100),
      cvAt: () => -1,
    });
    const expected = Math.round(baseSamples / 2);
    expect(countHigh(steps[0], first, first + expected)).toBe(expected);
    expect(steps[0][first + expected + 10]).toBe(0);
  });

  it("non-finite CV is safe and applies no modulation (reads as 0 V)", () => {
    const params = makeParams({ gateLen });
    const { steps } = renderTrig({
      totalSamples: first + baseSamples * 2,
      params,
      clkAt: periodicClock(first, period, 100),
      cvAt: () => NaN,
    });
    expect(countHigh(steps[0], first, first + baseSamples)).toBe(baseSamples);
    expect(steps[0][first + baseSamples + 10]).toBe(0);
  });

  it("an overflowing CV (2^cv -> +Infinity) clamps to the max gate length, not the min", () => {
    const params = makeParams({ gateLen });
    const maxSamples = Math.round(10 * SR); // MAX_GATE_SECONDS = 10s
    // A single edge only (period far beyond the render window) — a second
    // edge landing back on step 0 mid-decay would re-trigger its tail and
    // mask the clamp being tested.
    const onlyOnePeriod = maxSamples * 2;
    const { steps } = renderTrig({
      totalSamples: first + maxSamples + 100,
      params,
      clkAt: periodicClock(first, onlyOnePeriod, 100),
      cvAt: () => 2000, // 2^2000 overflows Math.pow to +Infinity
    });
    expect(countHigh(steps[0], first, first + maxSamples)).toBe(maxSamples);
    expect(steps[0][first + maxSamples + 10]).toBe(0);
  });
});

// ── 4. On mute (rest) ──────────────────────────────────────────────────────────

describe("triggerSequencerKernel — On mute", () => {
  const gateLen = 0.01;
  const gateSamples = Math.round(gateLen * SR);
  const first = 1000;
  const period = 5000;

  it("a disabled step is a rest: no S<n>/Trig/Gate, but the pointer still advances", () => {
    const on = [1, 1, 1, 1, 0, 1, 1, 1]; // step 5 (index 4) muted
    const params = makeParams({ gateLen, on });
    const { steps, trig, gate } = renderTrig({
      totalSamples: first + 5 * period + gateSamples + 100,
      params,
      clkAt: periodicClock(first, period, 100),
    });
    const e5 = first + 4 * period; // edge landing on step index 4 (S5)
    for (let i = e5; i < e5 + gateSamples; i++) {
      expect(steps[4][i]).toBe(0);
      expect(gate[i]).toBe(0);
    }
    expect(countRises(trig.subarray(e5, e5 + gateSamples))).toBe(0);
    // Next edge still advances normally to step index 5 (S6).
    const e6 = first + 5 * period;
    expect(steps[5][e6]).toBe(GATE_HIGH_V);
  });

  it("EOC is structural: it still fires on a muted last step (On 8 = 0)", () => {
    const on = [1, 1, 1, 1, 1, 1, 1, 0]; // step 8 (index 7) muted
    const params = makeParams({ gateLen, on });
    const { steps, eoc } = renderTrig({
      totalSamples: first + 7 * period + gateSamples + 100,
      params,
      clkAt: periodicClock(first, period, 100),
    });
    const e8 = first + 7 * period;
    expect(steps[7][e8]).toBe(0); // muted: no S8 pulse
    expect(countHigh(eoc, e8, e8 + PULSE_SAMPLES)).toBe(PULSE_SAMPLES); // EOC still fires
  });
});

// ── 5. EOC — natural 8-step wrap (Rst unpatched) ──────────────────────────────

describe("triggerSequencerKernel — EOC natural wrap", () => {
  const gateLen = 0.01;
  const first = 1000;
  const period = 5000;

  it("EOC fires coincident with S8's own pulse, not with S1 of the next lap", () => {
    const params = makeParams({ gateLen });
    // 16 edges: two full 8-step laps (S8 recurs at edge 8 and edge 16).
    const { eoc } = renderTrig({
      totalSamples: first + 16 * period,
      params,
      clkAt: periodicClock(first, period, 100),
    });
    const e8 = first + 7 * period; // first lap's S8
    const e9 = first + 8 * period; // start of the next lap (S1 again)
    const e16 = first + 15 * period; // second lap's S8
    expect(countHigh(eoc, e8, e8 + PULSE_SAMPLES)).toBe(PULSE_SAMPLES);
    expect(countHigh(eoc, e9, e9 + PULSE_SAMPLES)).toBe(0);
    expect(countHigh(eoc, e16, e16 + PULSE_SAMPLES)).toBe(PULSE_SAMPLES);
    // Exactly one EOC pulse per 8-step lap over two laps.
    expect(countRises(eoc)).toBe(2);
  });
});

// ── 6. EOC + Rst — external/self-patched reset shortens the cycle ────────────

describe("triggerSequencerKernel — Rst shortens the cycle and EOC follows it", () => {
  const gateLen = 0.01;
  const first = 1000;
  const period = 2000;

  it("an external Rst rising edge resets to step 0 and fires EOC at that sample; the next clock re-latches S1", () => {
    const params = makeParams({ gateLen });
    const resetAt = 4500; // between edge2 (3000, S2) and edge3 (5000, S3)
    const { steps, eoc } = renderTrig({
      totalSamples: 7000,
      params,
      clkAt: periodicClock(first, period, 100),
      rstAt: (i) => (i >= resetAt && i < resetAt + 100 ? GATE_HIGH_V : 0),
    });
    expect(countHigh(eoc, resetAt, resetAt + PULSE_SAMPLES)).toBe(PULSE_SAMPLES);
    // The next clock edge (5000) re-latches step 0 (S1), not step 2 (S3).
    expect(steps[0][5000]).toBe(GATE_HIGH_V);
    expect(steps[2][5000]).toBe(0);
  });

  it("self-patching S5 into Rst yields a repeating 5-step loop whose EOC coincides with S5 (never reaching S6..S8)", () => {
    // True feedback simulation (not a scripted absolute-time guess): Rst at
    // sample i is fed from S5's own output at sample i-1 — the interpreter's
    // one-sample feedback-edge delay for a self-patched cable (same mechanism
    // as function-generator's EOC->Trig self-cycle). Processed one sample at a
    // time so each sample's Rst can depend on the previous sample's real output.
    const params = makeParams({ gateLen });
    const state = triggerSequencerKernel.init(SR);
    const outs = makeOuts();
    const clk = periodicClock(first, period, 100);
    const clkBuf = new Float32Array(1);
    const rstBuf = new Float32Array(1);
    const totalSamples = first + 3 * (5 * period) + 100; // ~3 loops of headroom
    const stepsHist: Float32Array[] = [];
    for (let s = 0; s < STEP_COUNT; s++) stepsHist.push(new Float32Array(totalSamples));
    const eocHist = new Float32Array(totalSamples);
    let prevS5 = 0;
    for (let i = 0; i < totalSamples; i++) {
      clkBuf[0] = clk(i);
      rstBuf[0] = prevS5;
      triggerSequencerKernel.process(state, [clkBuf, rstBuf, null], outs, params, 1);
      for (let s = 0; s < STEP_COUNT; s++) stepsHist[s][i] = outs[s][0];
      eocHist[i] = outs[EOC][0];
      prevS5 = outs[4][0]; // S5 = index 4
    }

    // S6, S7, S8 are never reached.
    expect(countRises(stepsHist[5])).toBe(0);
    expect(countRises(stepsHist[6])).toBe(0);
    expect(countRises(stepsHist[7])).toBe(0);
    // S1..S5 each fire multiple times (repeating 5-step loop).
    for (let s = 0; s < 5; s++) expect(countRises(stepsHist[s])).toBeGreaterThanOrEqual(2);
    // EOC fires once per loop, exactly as often as S5 does.
    expect(countRises(eocHist)).toBe(countRises(stepsHist[4]));
  });
});

// ── 7. Combined Gate can overlap across steps (independent per-output tails) ──

describe("triggerSequencerKernel — combined Gate output", () => {
  it("stays continuously high across steps when Gate Len exceeds the clock period", () => {
    const period = 1000;
    const gateLen = 0.03; // 1440 samples, longer than the period (960 gap would remain otherwise)
    const params = makeParams({ gateLen });
    const first = 500;
    const { gate } = renderTrig({
      totalSamples: first + 4 * period,
      params,
      clkAt: periodicClock(first, period, 50),
    });
    for (let i = first; i < first + 3 * period; i++) expect(gate[i]).toBe(GATE_HIGH_V);
  });
});

// ── 8. Safety ─────────────────────────────────────────────────────────────────

describe("triggerSequencerKernel — safety", () => {
  it("non-finite Clk / Rst / CV samples never advance or crash; outputs stay finite", () => {
    const params = makeParams({ gateLen: 0.01 });
    const { steps, eoc, trig, gate } = renderTrig({
      totalSamples: 2000,
      params,
      clkAt: (i) => (i % 2 === 0 ? NaN : Infinity),
      rstAt: (i) => (i % 3 === 0 ? -Infinity : NaN),
      cvAt: (i) => (i % 5 === 0 ? NaN : Infinity),
    });
    for (let i = 0; i < 2000; i++) {
      for (let s = 0; s < STEP_COUNT; s++) expect(Number.isFinite(steps[s][i])).toBe(true);
      expect(Number.isFinite(eoc[i])).toBe(true);
      expect(Number.isFinite(trig[i])).toBe(true);
      expect(Number.isFinite(gate[i])).toBe(true);
      expect(steps[0][i]).toBe(0); // never advanced past power-on (no valid edge)
    }
  });

  it("a non-finite Gate Len param falls back to a safe minimum, not zero/NaN", () => {
    const params = makeParams({ gateLen: 0.01 });
    params[0] = NaN;
    const { steps } = renderTrig({
      totalSamples: 2000,
      params,
      clkAt: periodicClock(500, 1000, 50),
    });
    let sawHigh = false;
    for (let i = 0; i < 2000; i++) {
      expect(Number.isFinite(steps[0][i])).toBe(true);
      if (steps[0][i] > 0) sawHigh = true;
    }
    expect(sawHigh).toBe(true);
  });

  it("writes every declared output for a partial block, no stale sentinel samples", () => {
    const state = triggerSequencerKernel.init(SR);
    const outs = makeOuts();
    for (const o of outs) o.fill(999);
    const n = 17;
    const params = makeParams({ gateLen: 0.01 });
    triggerSequencerKernel.process(state, [null, null, null], outs, params, n);
    for (const o of outs) {
      for (let i = 0; i < n; i++) expect(o[i]).not.toBe(999);
      for (let i = n; i < BLOCK_FRAMES; i++) expect(o[i]).toBe(999);
    }
  });
});
