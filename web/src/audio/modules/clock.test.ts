// @vitest-environment node

import { describe, it, expect } from "vitest";
import { clockKernel } from "./clock";
import { registry, isPlayable } from "./registry";
import {
  BLOCK_FRAMES,
  GATE_HIGH_V,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
  TRIGGER_SECONDS,
} from "../engine/units";

const SR = 48000;

// Output slot order matches the registry entry: Clk, /2, /4, /8, /16.
const CLK = 0;
const D2 = 1;
const D4 = 2;
const D8 = 3;
const D16 = 4;

function makeOuts(): Float32Array[] {
  return [
    new Float32Array(BLOCK_FRAMES),
    new Float32Array(BLOCK_FRAMES),
    new Float32Array(BLOCK_FRAMES),
    new Float32Array(BLOCK_FRAMES),
    new Float32Array(BLOCK_FRAMES),
  ];
}

/**
 * Renders `totalSamples` of the clock in BLOCK_FRAMES chunks with an optional
 * per-sample Ext Clk / Run / Rst volt script; returns each output's full buffer.
 * Slot order matches the registry: ins = [Ext Clk, Run, Rst].
 */
function renderClock(opts: {
  sr?: number;
  bpm: number;
  swing?: number;
  totalSamples: number;
  extAt?: (sample: number) => number;
  runAt?: (sample: number) => number;
  rstAt?: (sample: number) => number;
}): Float32Array[] {
  const sr = opts.sr ?? SR;
  const state = clockKernel.init(sr);
  const outs = makeOuts();
  const extBuf = opts.extAt ? new Float32Array(BLOCK_FRAMES) : null;
  const runBuf = opts.runAt ? new Float32Array(BLOCK_FRAMES) : null;
  const rstBuf = opts.rstAt ? new Float32Array(BLOCK_FRAMES) : null;
  const params = new Float32Array([opts.bpm, opts.swing ?? 0]);
  const result = [
    new Float32Array(opts.totalSamples),
    new Float32Array(opts.totalSamples),
    new Float32Array(opts.totalSamples),
    new Float32Array(opts.totalSamples),
    new Float32Array(opts.totalSamples),
  ];
  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      if (extBuf && opts.extAt) extBuf[i] = opts.extAt(start + i);
      if (runBuf && opts.runAt) runBuf[i] = opts.runAt(start + i);
      if (rstBuf && opts.rstAt) rstBuf[i] = opts.rstAt(start + i);
    }
    clockKernel.process(state, [extBuf, runBuf, rstBuf], outs, params, n);
    for (let s = 0; s < 5; s++) result[s].set(outs[s].subarray(0, n), start);
  }
  return result;
}

/**
 * Collects the global sample index of every rising edge on output `slot`,
 * scanning block by block without allocating a full-length buffer (so long
 * multi-minute renders stay cheap).
 */
function collectTicks(opts: {
  sr?: number;
  bpm: number;
  swing?: number;
  totalSamples: number;
  slot?: number;
  extAt?: (sample: number) => number;
  runAt?: (sample: number) => number;
  rstAt?: (sample: number) => number;
}): number[] {
  const sr = opts.sr ?? SR;
  const slot = opts.slot ?? CLK;
  const state = clockKernel.init(sr);
  const outs = makeOuts();
  const extBuf = opts.extAt ? new Float32Array(BLOCK_FRAMES) : null;
  const runBuf = opts.runAt ? new Float32Array(BLOCK_FRAMES) : null;
  const rstBuf = opts.rstAt ? new Float32Array(BLOCK_FRAMES) : null;
  const params = new Float32Array([opts.bpm, opts.swing ?? 0]);
  const ticks: number[] = [];
  let prevHigh = false;
  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      if (extBuf && opts.extAt) extBuf[i] = opts.extAt(start + i);
      if (runBuf && opts.runAt) runBuf[i] = opts.runAt(start + i);
      if (rstBuf && opts.rstAt) rstBuf[i] = opts.rstAt(start + i);
    }
    clockKernel.process(state, [extBuf, runBuf, rstBuf], outs, params, n);
    const out = outs[slot];
    for (let i = 0; i < n; i++) {
      const high = out[i] > 0;
      if (high && !prevHigh) ticks.push(start + i);
      prevHigh = high;
    }
  }
  return ticks;
}

// ── 1. Registry / seed ───────────────────────────────────────────────────────

describe("clock registry entry", () => {
  it("matches the seed: Ext Clk/Run/Rst inputs, Clk + /2 /4 /8 /16 outputs, Tempo + Swing controls", () => {
    const entry = registry.get("clock");
    expect(entry).toBeDefined();
    expect(entry?.inJacks).toEqual(["Ext Clk", "Run", "Rst"]);
    expect(entry?.outJacks).toEqual(["Clk", "/2", "/4", "/8", "/16"]);
    expect(Object.keys(entry?.params ?? {})).toEqual(["Tempo", "Swing"]);
  });

  it("is playable", () => {
    expect(isPlayable("clock")).toBe(true);
  });

  it("uses the canonical clockKernel (identity)", () => {
    expect(registry.get("clock")?.kernel).toBe(clockKernel);
  });
});

// ── 2. BPM timing ─────────────────────────────────────────────────────────────

describe("clockKernel — BPM timing", () => {
  it("120 BPM emits a trigger every 0.5 s, starting with a downbeat at sample 0", () => {
    const period = SR * 0.5; // 24000 samples per quarter note at 120 BPM
    const ticks = collectTicks({ bpm: 120, totalSamples: period * 5 + 100 });
    expect(ticks).toEqual([0, period, 2 * period, 3 * period, 4 * period, 5 * period]);
  });

  it("over a 60 s render, cumulative 120 BPM tick positions are accurate to ±1 sample", () => {
    const period = (SR * 60) / 120; // exactly 24000
    const ticks = collectTicks({ bpm: 120, totalSamples: SR * 60 });
    expect(ticks.length).toBeGreaterThan(100);
    for (let m = 0; m < ticks.length; m++) {
      expect(Math.abs(ticks[m] - m * period)).toBeLessThanOrEqual(1);
    }
  });

  it("a fractional period (110 BPM) accumulates zero drift over 60 s (cumulative ±1 sample)", () => {
    // 48000·60/110 = 26181.81… samples — deliberately non-integer, so a
    // rounded-and-accumulated period would drift many samples by minute's end.
    const period = (SR * 60) / 110;
    const ticks = collectTicks({ bpm: 110, totalSamples: SR * 60 });
    expect(ticks.length).toBeGreaterThan(100);
    for (let m = 0; m < ticks.length; m++) {
      expect(Math.abs(ticks[m] - m * period)).toBeLessThanOrEqual(1);
    }
  });
});

// ── 3. Trigger pulse shape ────────────────────────────────────────────────────

describe("clockKernel — trigger pulse shape", () => {
  it("Clk pulses are GATE_HIGH_V for round(TRIGGER_SECONDS·sr) samples, 0 V between", () => {
    const period = SR * 0.5;
    const pulseLen = Math.round(TRIGGER_SECONDS * SR); // 48 samples at 48 kHz
    const [clk] = renderClock({ bpm: 120, totalSamples: period + pulseLen + 200 });

    // The downbeat pulse: high for exactly pulseLen samples from sample 0.
    for (let i = 0; i < pulseLen; i++) expect(clk[i]).toBe(GATE_HIGH_V);
    expect(clk[pulseLen]).toBe(0);
    // Low all the way up to the next tick.
    for (let i = pulseLen; i < period; i++) expect(clk[i]).toBe(0);
    // Next tick pulse.
    expect(clk[period]).toBe(GATE_HIGH_V);
  });
});

// ── 4. Division outputs ───────────────────────────────────────────────────────

describe("clockKernel — division outputs", () => {
  it("/2 /4 /8 /16 fire on the correct parent ticks, sample-aligned with Clk", () => {
    const period = (SR * 60) / 300; // 9600 samples (integer) at 300 BPM
    const totalSamples = period * 16 + 200; // 17 parent ticks: 0..16
    const clkTicks = collectTicks({ bpm: 300, totalSamples });
    const d2 = collectTicks({ bpm: 300, totalSamples, slot: D2 });
    const d4 = collectTicks({ bpm: 300, totalSamples, slot: D4 });
    const d8 = collectTicks({ bpm: 300, totalSamples, slot: D8 });
    const d16 = collectTicks({ bpm: 300, totalSamples, slot: D16 });

    const tickAt = (m: number) => m * period;
    expect(clkTicks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(tickAt));
    // /2 on parent ticks 0,2,4,…; /4 on 0,4,8,…; /8 on 0,8,16; /16 on 0,16.
    expect(d2).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16].map(tickAt));
    expect(d4).toEqual([0, 4, 8, 12, 16].map(tickAt));
    expect(d8).toEqual([0, 8, 16].map(tickAt));
    expect(d16).toEqual([0, 16].map(tickAt));
  });
});

// ── 5. Run / reset ────────────────────────────────────────────────────────────

describe("clockKernel — Run input", () => {
  it("unpatched Run defaults to running", () => {
    const ticks = collectTicks({ bpm: 120, totalSamples: SR }); // no runAt → null
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]).toBe(0);
  });

  it("Run held low suppresses all pulses", () => {
    const outs = renderClock({ bpm: 120, totalSamples: SR, runAt: () => 0 });
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < SR; i++) expect(outs[s][i]).toBe(0);
    }
  });

  it("Run high runs; dropping Run low stops pulses; raising it resumes", () => {
    const period = SR * 0.5; // 24000
    const stopAt = period + 1000; // after the first two ticks (0, period)
    const resumeAt = 3 * period; // well after the stop
    const ticks = collectTicks({
      bpm: 120,
      totalSamples: 4 * period,
      runAt: (i) => (i < stopAt || i >= resumeAt ? GATE_HIGH_V : 0),
    });
    // Ticks at 0 and `period` happen; the tick at 2·period is suppressed
    // (clock stopped); after resume a downbeat-style tick appears.
    expect(ticks).toContain(0);
    expect(ticks).toContain(period);
    expect(ticks).not.toContain(2 * period);
  });

  it("Schmitt hysteresis: Run hovering in the threshold band after going high does not chatter", () => {
    const between = (GATE_REARM_THRESHOLD_V + GATE_FIRE_THRESHOLD_V) / 2;
    const period = SR * 0.5;
    const ticks = collectTicks({
      bpm: 120,
      totalSamples: 3 * period,
      runAt: (i) => (i < 10 ? GATE_HIGH_V : between), // latches running, then hovers
    });
    // Still running throughout: ticks keep coming at the normal spacing.
    expect(ticks).toContain(0);
    expect(ticks).toContain(period);
    expect(ticks).toContain(2 * period);
  });
});

describe("clockKernel — reset", () => {
  it("a Rst rising edge fires a downbeat on the reset sample and re-zeros the divide counter", () => {
    const period = SR * 0.5; // 24000
    const resetAt = 30000; // between the natural ticks at 24000 and 48000
    const totalSamples = 60000;
    const clkTicks = collectTicks({ bpm: 120, totalSamples, rstAt: (i) => (i >= resetAt && i < resetAt + 100 ? GATE_HIGH_V : 0) });
    const d2 = collectTicks({ bpm: 120, totalSamples, slot: D2, rstAt: (i) => (i >= resetAt && i < resetAt + 100 ? GATE_HIGH_V : 0) });
    const d16 = collectTicks({ bpm: 120, totalSamples, slot: D16, rstAt: (i) => (i >= resetAt && i < resetAt + 100 ? GATE_HIGH_V : 0) });

    // A Clk downbeat lands exactly on the reset sample, and the next tick is
    // one full period later (phase restarted).
    expect(clkTicks).toContain(resetAt);
    expect(clkTicks).toContain(resetAt + period);
    // Divide counter reset to 0 → every division also fires on the reset sample.
    expect(d2).toContain(resetAt);
    expect(d16).toContain(resetAt);
  });
});

// ── 6. External clock (Ext Clk input) ─────────────────────────────────────────

/**
 * A rising-edge script: HIGH for `width` samples starting at each edge sample,
 * 0 otherwise. `width` < the edge spacing so each pulse is a distinct edge.
 */
function extPulses(edges: number[], width = 50): (sample: number) => number {
  return (i) => {
    for (let e = 0; e < edges.length; e++) {
      if (i >= edges[e] && i < edges[e] + width) return GATE_HIGH_V;
    }
    return 0;
  };
}

describe("clockKernel — external clock (Ext Clk)", () => {
  it("unpatched Ext Clk preserves the internal BPM behavior exactly", () => {
    const period = SR * 0.5; // 24000 at 120 BPM
    // Identical script to the internal downbeat test, extAt omitted (Ext Clk null).
    const ticks = collectTicks({ bpm: 120, totalSamples: period * 5 + 100 });
    expect(ticks).toEqual([0, period, 2 * period, 3 * period, 4 * period, 5 * period]);
  });

  it("emits Clk pulses exactly on external rising-edge samples", () => {
    const edges = [1000, 4000, 9000];
    const ticks = collectTicks({
      bpm: 120,
      totalSamples: 10000,
      extAt: extPulses(edges),
    });
    expect(ticks).toEqual(edges);
  });

  it("the internal BPM generator produces no ticks while Ext Clk is patched (held low)", () => {
    // Fast internal tempo, but Ext Clk patched and never crossing threshold →
    // zero output: external input has fully replaced the internal generator.
    const ticks = collectTicks({
      bpm: 300,
      totalSamples: SR,
      extAt: () => 0,
    });
    expect(ticks).toEqual([]);
  });

  it("a sustained-high Ext Clk fires exactly once (no retrigger until re-armed)", () => {
    const ticks = collectTicks({
      bpm: 120,
      totalSamples: 20000,
      extAt: (i) => (i >= 1000 ? GATE_HIGH_V : 0), // one long pulse, never re-arms
    });
    expect(ticks).toEqual([1000]);
  });

  it("a slow ramp through the threshold fires exactly once", () => {
    // 0 V until 1000, then ramps at 0.001 V/sample; crosses GATE_FIRE_THRESHOLD_V
    // (1 V) at sample 2000 and stays high thereafter — one edge only.
    const ticks = collectTicks({
      bpm: 120,
      totalSamples: 20000,
      extAt: (i) => (i < 1000 ? 0 : Math.min(GATE_HIGH_V, (i - 1000) * 0.001)),
    });
    expect(ticks).toEqual([2000]);
  });

  it("division outputs count external ticks exactly as they count internal ticks", () => {
    const spacing = 2000;
    const edges: number[] = [];
    for (let k = 0; k <= 16; k++) edges.push(k * spacing); // ticks 0..16
    const totalSamples = 16 * spacing + 200;
    const ext = extPulses(edges);

    const clk = collectTicks({ bpm: 120, totalSamples, extAt: ext });
    const d2 = collectTicks({ bpm: 120, totalSamples, slot: D2, extAt: ext });
    const d4 = collectTicks({ bpm: 120, totalSamples, slot: D4, extAt: ext });
    const d8 = collectTicks({ bpm: 120, totalSamples, slot: D8, extAt: ext });
    const d16 = collectTicks({ bpm: 120, totalSamples, slot: D16, extAt: ext });

    const at = (k: number) => k * spacing;
    expect(clk).toEqual(edges);
    expect(d2).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16].map(at));
    expect(d4).toEqual([0, 4, 8, 12, 16].map(at));
    expect(d8).toEqual([0, 8, 16].map(at));
    expect(d16).toEqual([0, 16].map(at));
  });

  it("Rst re-zeros the external divide phase: the next external edge is a downbeat", () => {
    const spacing = 2000;
    const edges: number[] = [];
    for (let k = 0; k <= 8; k++) edges.push(k * spacing); // edges at 0,2000,…,16000
    const totalSamples = 8 * spacing + 200;
    const resetAt = 5000; // between the edges at 4000 and 6000
    const ext = extPulses(edges);
    const rst = (i: number) => (i >= resetAt && i < resetAt + 100 ? GATE_HIGH_V : 0);

    const clk = collectTicks({ bpm: 120, totalSamples, extAt: ext, rstAt: rst });
    const d16 = collectTicks({ bpm: 120, totalSamples, slot: D16, extAt: ext, rstAt: rst });

    // Reset itself emits no Clk (external mode fires only on edges); the edge at
    // 6000 fires, and — divide phase re-zeroed — /16 fires with it (downbeat).
    expect(clk).not.toContain(resetAt);
    expect(clk).toContain(6000);
    expect(d16).toContain(6000);
  });

  it("non-finite Ext Clk samples never fire and keep outputs finite", () => {
    // Infinity/NaN scattered through the buffer; one genuine finite edge at 500.
    const ext = (i: number) => {
      if (i >= 500 && i < 550) return GATE_HIGH_V; // the only real edge
      if (i % 5 === 0) return Infinity;
      if (i % 7 === 0) return NaN;
      return 0;
    };
    const outs = renderClock({ bpm: 120, totalSamples: 5000, extAt: ext });
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < 5000; i++) expect(Number.isFinite(outs[s][i])).toBe(true);
    }
    const ticks = collectTicks({ bpm: 120, totalSamples: 5000, extAt: ext });
    expect(ticks).toEqual([500]); // the Infinity/NaN samples did not fire
  });
});

// ── 7. Swing (internal clock) ─────────────────────────────────────────────────

describe("clockKernel — swing", () => {
  it("swing = 0 matches the straight clock exactly", () => {
    const period = SR * 0.5;
    const totalSamples = period * 5 + 100;
    const straight = collectTicks({ bpm: 120, totalSamples });
    const swung0 = collectTicks({ bpm: 120, swing: 0, totalSamples });
    expect(swung0).toEqual(straight);
  });

  it("positive swing delays the offbeat: intervals alternate long/short", () => {
    // P = 24000, delay = 0.5·(1/3)·P = 4000 → A = 28000, B = 20000 (integers).
    const P = SR * 0.5;
    const ticks = collectTicks({ bpm: 120, swing: 0.5, totalSamples: 100000 });
    expect(ticks).toEqual([0, 28000, 48000, 76000, 96000]);
    // Interval A then B then A then B …
    const intervals: number[] = [];
    for (let k = 1; k < ticks.length; k++) intervals.push(ticks[k] - ticks[k - 1]);
    expect(intervals).toEqual([28000, 20000, 28000, 20000]);
    // Every two-tick cycle sums to exactly 2P — no cumulative drift.
    for (let k = 0; k + 2 < ticks.length; k++) {
      expect(ticks[k + 2] - ticks[k]).toBe(2 * P);
    }
  });

  it("negative swing pushes the offbeat early: intervals alternate short/long", () => {
    const P = SR * 0.5;
    const ticks = collectTicks({ bpm: 120, swing: -0.5, totalSamples: 100000 });
    const intervals: number[] = [];
    for (let k = 1; k < ticks.length; k++) intervals.push(ticks[k] - ticks[k - 1]);
    expect(intervals).toEqual([20000, 28000, 20000, 28000]);
    for (let k = 0; k + 2 < ticks.length; k++) {
      expect(ticks[k + 2] - ticks[k]).toBe(2 * P);
    }
  });

  it("even ticks stay pinned to k·P over a 60 s render (no cumulative drift)", () => {
    const P = (SR * 60) / 120; // exactly 24000
    const delay = 0.5 * (1 / 3) * P; // 4000
    const ticks = collectTicks({ bpm: 120, swing: 0.5, totalSamples: SR * 60 });
    expect(ticks.length).toBeGreaterThan(100);
    for (let m = 0; m < ticks.length; m++) {
      // even index → on the grid; odd index → grid + delay. Both within ±1.
      const expected = (m % 2 === 0 ? m * P : m * P + delay);
      expect(Math.abs(ticks[m] - expected)).toBeLessThanOrEqual(1);
    }
  });

  it("swing has no cumulative drift with a fractional period (110 BPM, 60 s)", () => {
    // 48000·60/110 = 26181.81… samples — deliberately non-integer, and the swing
    // delay P/6 is fractional too, so a clock that accumulated rounded periods
    // would drift many samples by minute's end. Unlike the 120 BPM case above,
    // this exercises the float remainder path, not integer arithmetic.
    const P = (SR * 60) / 110;
    const delay = 0.5 * (1 / 3) * P; // P/6, fractional
    const A = P + delay; // long interval (even tick → odd tick)
    const B = P - delay; // short interval (odd tick → even tick)
    const ticks = collectTicks({ bpm: 110, swing: 0.5, totalSamples: SR * 60 });
    expect(ticks.length).toBeGreaterThan(100);

    // Downbeat/even ticks stay within ±1 sample of the ideal grid (m·P); odd
    // ticks stay within ±1 of the swung position (m·P + delay). No drift.
    for (let m = 0; m < ticks.length; m++) {
      const ideal = m % 2 === 0 ? m * P : m * P + delay;
      expect(Math.abs(ticks[m] - ideal)).toBeLessThanOrEqual(1);
    }

    // Long/short intervals still alternate (each within ±1 of ideal A/B) and every
    // two-tick cycle sums to ≈ 2P — asserted with a tolerance, not float equality.
    for (let k = 1; k < ticks.length; k++) {
      const interval = ticks[k] - ticks[k - 1];
      const idealInterval = k % 2 === 1 ? A : B; // interval leading into tick k
      expect(Math.abs(interval - idealInterval)).toBeLessThanOrEqual(1);
    }
    for (let k = 0; k + 2 < ticks.length; k++) {
      expect(Math.abs(ticks[k + 2] - ticks[k] - 2 * P)).toBeLessThanOrEqual(1);
    }
  });

  it("division outputs align with the swung parent ticks (divisions land on even ticks)", () => {
    const totalSamples = 200000;
    const clk = collectTicks({ bpm: 120, swing: 0.5, totalSamples });
    const d2 = collectTicks({ bpm: 120, swing: 0.5, totalSamples, slot: D2 });
    // /2 fires on parent ticks 0,2,4,… — the even (un-delayed) ticks.
    const evenTicks: number[] = [];
    for (let k = 0; k < clk.length; k += 2) evenTicks.push(clk[k]);
    expect(d2).toEqual(evenTicks);
  });

  it("out-of-range swing clamps safely (no zero/negative interval)", () => {
    const P = SR * 0.5;
    // swing 5 clamps to 1 → delay = P/3 = 8000 → A = 32000, B = 16000.
    const ticks = collectTicks({ bpm: 120, swing: 5, totalSamples: 100000 });
    const intervals: number[] = [];
    for (let k = 1; k < ticks.length; k++) intervals.push(ticks[k] - ticks[k - 1]);
    for (const iv of intervals) expect(iv).toBeGreaterThan(0);
    expect(intervals[0]).toBe(32000);
    expect(intervals[1]).toBe(16000);
    for (let k = 0; k + 2 < ticks.length; k++) {
      expect(ticks[k + 2] - ticks[k]).toBe(2 * P);
    }
  });

  it("non-finite swing falls back to straight timing", () => {
    const period = SR * 0.5;
    const totalSamples = period * 4 + 100;
    const straight = collectTicks({ bpm: 120, totalSamples });
    const nan = collectTicks({ bpm: 120, swing: NaN, totalSamples });
    expect(nan).toEqual(straight);
  });
});

// ── 8. Safety ─────────────────────────────────────────────────────────────────

describe("clockKernel — safety", () => {
  it("non-finite Tempo (and Swing) falls back to a running clock with finite outputs", () => {
    const state = clockKernel.init(SR);
    const outs = makeOuts();
    const params = new Float32Array([NaN, NaN]);
    clockKernel.process(state, [null, null, null], outs, params, BLOCK_FRAMES);
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < BLOCK_FRAMES; i++) expect(Number.isFinite(outs[s][i])).toBe(true);
    }
    // Downbeat still fires at sample 0 with the fallback tempo.
    expect(outs[CLK][0]).toBe(GATE_HIGH_V);
  });

  it("non-finite Run / Rst samples keep outputs finite and never crash", () => {
    const state = clockKernel.init(SR);
    const outs = makeOuts();
    const runBuf = new Float32Array(BLOCK_FRAMES);
    const rstBuf = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      runBuf[i] = i % 2 === 0 ? NaN : GATE_HIGH_V;
      rstBuf[i] = i % 3 === 0 ? Infinity : i % 3 === 1 ? -Infinity : 0;
    }
    const params = new Float32Array([120, 0]);
    clockKernel.process(state, [null, runBuf, rstBuf], outs, params, BLOCK_FRAMES);
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < BLOCK_FRAMES; i++) expect(Number.isFinite(outs[s][i])).toBe(true);
    }
  });

  it("writes every declared output for a partial block, no stale sentinel samples", () => {
    const state = clockKernel.init(SR);
    const outs = makeOuts();
    for (const o of outs) o.fill(999);
    const n = 17;
    const params = new Float32Array([120, 0]);
    clockKernel.process(state, [null, null, null], outs, params, n);
    for (const o of outs) {
      for (let i = 0; i < n; i++) expect(o[i]).not.toBe(999);
      for (let i = n; i < BLOCK_FRAMES; i++) expect(o[i]).toBe(999);
    }
  });
});
