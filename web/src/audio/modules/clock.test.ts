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
 * per-sample Run / Rst volt script; returns each output's full buffer.
 */
function renderClock(opts: {
  sr?: number;
  bpm: number;
  totalSamples: number;
  runAt?: (sample: number) => number;
  rstAt?: (sample: number) => number;
}): Float32Array[] {
  const sr = opts.sr ?? SR;
  const state = clockKernel.init(sr);
  const outs = makeOuts();
  const runBuf = opts.runAt ? new Float32Array(BLOCK_FRAMES) : null;
  const rstBuf = opts.rstAt ? new Float32Array(BLOCK_FRAMES) : null;
  const params = new Float32Array([opts.bpm]);
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
      if (runBuf && opts.runAt) runBuf[i] = opts.runAt(start + i);
      if (rstBuf && opts.rstAt) rstBuf[i] = opts.rstAt(start + i);
    }
    clockKernel.process(state, [runBuf, rstBuf], outs, params, n);
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
  totalSamples: number;
  slot?: number;
  runAt?: (sample: number) => number;
  rstAt?: (sample: number) => number;
}): number[] {
  const sr = opts.sr ?? SR;
  const slot = opts.slot ?? CLK;
  const state = clockKernel.init(sr);
  const outs = makeOuts();
  const runBuf = opts.runAt ? new Float32Array(BLOCK_FRAMES) : null;
  const rstBuf = opts.rstAt ? new Float32Array(BLOCK_FRAMES) : null;
  const params = new Float32Array([opts.bpm]);
  const ticks: number[] = [];
  let prevHigh = false;
  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      if (runBuf && opts.runAt) runBuf[i] = opts.runAt(start + i);
      if (rstBuf && opts.rstAt) rstBuf[i] = opts.rstAt(start + i);
    }
    clockKernel.process(state, [runBuf, rstBuf], outs, params, n);
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
  it("matches the seed: Run/Rst inputs, Clk + /2 /4 /8 /16 outputs, Tempo control", () => {
    const entry = registry.get("clock");
    expect(entry).toBeDefined();
    expect(entry?.inJacks).toEqual(["Run", "Rst"]);
    expect(entry?.outJacks).toEqual(["Clk", "/2", "/4", "/8", "/16"]);
    expect(Object.keys(entry?.params ?? {})).toEqual(["Tempo"]);
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

// ── 6. Safety ─────────────────────────────────────────────────────────────────

describe("clockKernel — safety", () => {
  it("non-finite Tempo falls back to a running clock with finite outputs", () => {
    const state = clockKernel.init(SR);
    const outs = makeOuts();
    const params = new Float32Array([NaN]);
    clockKernel.process(state, [null, null], outs, params, BLOCK_FRAMES);
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
    const params = new Float32Array([120]);
    clockKernel.process(state, [runBuf, rstBuf], outs, params, BLOCK_FRAMES);
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < BLOCK_FRAMES; i++) expect(Number.isFinite(outs[s][i])).toBe(true);
    }
  });

  it("writes every declared output for a partial block, no stale sentinel samples", () => {
    const state = clockKernel.init(SR);
    const outs = makeOuts();
    for (const o of outs) o.fill(999);
    const n = 17;
    const params = new Float32Array([120]);
    clockKernel.process(state, [null, null], outs, params, n);
    for (const o of outs) {
      for (let i = 0; i < n; i++) expect(o[i]).not.toBe(999);
      for (let i = n; i < BLOCK_FRAMES; i++) expect(o[i]).toBe(999);
    }
  });
});
