// @vitest-environment node

import { describe, it, expect } from "vitest";
import { lfoKernel } from "./lfo";
import {
  BLOCK_FRAMES,
  CV_BIPOLAR_MAX,
  GATE_HIGH_V,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
} from "../engine/units";

// Output slot order matches the registry entry: Sine, Tri, Sq, Saw, Sub.
const SINE = 0;
const TRI = 1;
const SQ = 2;
const SAW = 3;
const SUB = 4;

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
 * Render `totalSamples` of the LFO in BLOCK_FRAMES chunks with optional
 * per-sample Rate CV / Rst volt scripts; returns each shape's full output.
 */
function renderLfo(opts: {
  sr?: number;
  rateHz: number;
  totalSamples: number;
  rateCvAt?: (sample: number) => number;
  rstAt?: (sample: number) => number;
}): Float32Array[] {
  const sr = opts.sr ?? 48000;
  const state = lfoKernel.init(sr);
  const outs = makeOuts();
  const rateCvBuf = opts.rateCvAt ? new Float32Array(BLOCK_FRAMES) : null;
  const rstBuf = opts.rstAt ? new Float32Array(BLOCK_FRAMES) : null;
  const params = new Float32Array([opts.rateHz]);
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
      if (rateCvBuf && opts.rateCvAt) rateCvBuf[i] = opts.rateCvAt(start + i);
      if (rstBuf && opts.rstAt) rstBuf[i] = opts.rstAt(start + i);
    }
    lfoKernel.process(state, [rateCvBuf, rstBuf], outs, params, n);
    for (let o = 0; o < 5; o++) result[o].set(outs[o].subarray(0, n), start);
  }
  return result;
}

/** Measured frequency from the Sq output's rising edges (cycle wrap points). */
function measuredHz(sq: Float32Array, sr: number): number {
  let firstRise = -1;
  let lastRise = -1;
  let rises = 0;
  for (let i = 1; i < sq.length; i++) {
    if (sq[i] > 0 && sq[i - 1] < 0) {
      if (firstRise === -1) firstRise = i;
      else {
        lastRise = i;
        rises++;
      }
    }
  }
  if (rises < 1) return 0;
  return (rises * sr) / (lastRise - firstRise);
}

describe("lfoKernel — frequency", () => {
  it("measures ~1 Hz and ~10 Hz at 48 kHz within 2%", () => {
    const sr = 48000;
    for (const rate of [1, 10]) {
      const outs = renderLfo({ sr, rateHz: rate, totalSamples: sr * 3 });
      expect(measuredHz(outs[SQ], sr)).toBeCloseTo(rate, 1);
      const rel = Math.abs(measuredHz(outs[SQ], sr) - rate) / rate;
      expect(rel).toBeLessThan(0.02);
    }
  });

  it("measures ~0.1 Hz at a low sample rate within 2%", () => {
    const sr = 8000;
    const outs = renderLfo({ sr, rateHz: 0.1, totalSamples: sr * 25 });
    const rel = Math.abs(measuredHz(outs[SQ], sr) - 0.1) / 0.1;
    expect(rel).toBeLessThan(0.02);
  });

  it("Sub runs at half the main rate (one octave down)", () => {
    const sr = 48000;
    const outs = renderLfo({ sr, rateHz: 8, totalSamples: sr * 2 });
    const main = measuredHz(outs[SQ], sr);
    const sub = measuredHz(outs[SUB], sr);
    expect(sub).toBeCloseTo(main / 2, 1);
  });

  it("deep negative Rate CV freezes (or nearly freezes) the LFO", () => {
    // Intentional clamp asymmetry (see kernel header / signals.md): the
    // effective rate is [0, RATE_MAX_HZ], so strong negative CV may slow the
    // LFO below the knob floor toward a standstill.
    const sr = 48000;
    const outs = renderLfo({
      sr,
      rateHz: 10,
      totalSamples: sr, // 1 s — 10 full cycles if the CV had no effect
      rateCvAt: () => -20, // 10 Hz · 2^-20 ≈ 9.5 µHz
    });
    // Phase is effectively stuck at 0: every shape holds its phase-0 value.
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < outs[SINE].length; i++) {
      if (outs[SINE][i] < min) min = outs[SINE][i];
      if (outs[SINE][i] > max) max = outs[SINE][i];
    }
    expect(max - min).toBeLessThan(CV_BIPOLAR_MAX * 0.001);
    expect(outs[SQ][outs[SQ].length - 1]).toBe(CV_BIPOLAR_MAX);
  });

  it("+1 V on Rate CV doubles the frequency (1 V/oct)", () => {
    const sr = 48000;
    const base = renderLfo({ sr, rateHz: 2, totalSamples: sr * 2 });
    const up = renderLfo({ sr, rateHz: 2, totalSamples: sr * 2, rateCvAt: () => 1 });
    const fBase = measuredHz(base[SQ], sr);
    const fUp = measuredHz(up[SQ], sr);
    expect(fUp / fBase).toBeGreaterThan(1.96);
    expect(fUp / fBase).toBeLessThan(2.04);
  });
});

describe("lfoKernel — shape ranges", () => {
  const sr = 48000;
  const outs = renderLfo({ sr, rateHz: 5, totalSamples: sr });

  function minMax(buf: Float32Array): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] < min) min = buf[i];
      if (buf[i] > max) max = buf[i];
    }
    return { min, max };
  }

  it("sine reaches near ±CV_BIPOLAR_MAX and never exceeds it", () => {
    const { min, max } = minMax(outs[SINE]);
    expect(max).toBeGreaterThan(CV_BIPOLAR_MAX * 0.999);
    expect(max).toBeLessThanOrEqual(CV_BIPOLAR_MAX);
    expect(min).toBeLessThan(-CV_BIPOLAR_MAX * 0.999);
    expect(min).toBeGreaterThanOrEqual(-CV_BIPOLAR_MAX);
  });

  it("triangle reaches near ±CV_BIPOLAR_MAX and never exceeds it", () => {
    const { min, max } = minMax(outs[TRI]);
    expect(max).toBeGreaterThan(CV_BIPOLAR_MAX * 0.99);
    expect(max).toBeLessThanOrEqual(CV_BIPOLAR_MAX);
    expect(min).toBeLessThan(-CV_BIPOLAR_MAX * 0.99);
    expect(min).toBeGreaterThanOrEqual(-CV_BIPOLAR_MAX);
  });

  it("saw spans near -CV_BIPOLAR_MAX..+CV_BIPOLAR_MAX", () => {
    const { min, max } = minMax(outs[SAW]);
    expect(max).toBeGreaterThan(CV_BIPOLAR_MAX * 0.99);
    expect(max).toBeLessThanOrEqual(CV_BIPOLAR_MAX);
    expect(min).toBe(-CV_BIPOLAR_MAX); // phase 0 is sampled exactly
  });

  it("square and sub are exactly ±CV_BIPOLAR_MAX", () => {
    // Accumulate violations instead of per-sample expect() (runtime).
    let violations = 0;
    for (const o of [SQ, SUB]) {
      for (let i = 0; i < outs[o].length; i++) {
        if (Math.abs(outs[o][i]) !== CV_BIPOLAR_MAX) violations++;
      }
    }
    expect(violations).toBe(0);
  });

  it("square output can act as a makeshift gate: +5 V fires, -5 V re-arms", () => {
    // Documents the AP-10 manual-test trick: the Sq output swings across both
    // Schmitt thresholds, so it can drive the envelope's Gate input until a
    // real gate/sequencer source lands in AP-12.
    expect(CV_BIPOLAR_MAX).toBeGreaterThanOrEqual(GATE_FIRE_THRESHOLD_V);
    expect(-CV_BIPOLAR_MAX).toBeLessThan(GATE_REARM_THRESHOLD_V);
  });
});

describe("lfoKernel — reset", () => {
  const sr = 48000;

  it("a rising Rst edge re-phases to 0 deterministically at the edge sample", () => {
    const resetAt = 10000;
    const outs = renderLfo({
      sr,
      rateHz: 3,
      totalSamples: 20000,
      rstAt: (i) => (i >= resetAt && i < resetAt + 100 ? GATE_HIGH_V : 0),
    });
    // The reset sample reads phase 0 on every shape.
    expect(outs[SINE][resetAt]).toBe(0);
    expect(outs[TRI][resetAt]).toBe(0);
    expect(outs[SQ][resetAt]).toBe(CV_BIPOLAR_MAX);
    expect(outs[SAW][resetAt]).toBe(-CV_BIPOLAR_MAX);
    expect(outs[SUB][resetAt]).toBe(CV_BIPOLAR_MAX);
  });

  it("repeated resets reproduce the identical output sequence", () => {
    const r1 = 6000;
    const r2 = 14500;
    const span = 4000;
    const outs = renderLfo({
      sr,
      rateHz: 7,
      totalSamples: 20000,
      rstAt: (i) =>
        (i >= r1 && i < r1 + 50) || (i >= r2 && i < r2 + 50) ? GATE_HIGH_V : 0,
    });
    let mismatches = 0;
    for (const o of [SINE, TRI, SQ, SAW, SUB]) {
      for (let i = 0; i < span; i++) {
        if (outs[o][r1 + i] !== outs[o][r2 + i]) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });

  it("values inside the hysteresis band do not retrigger until re-armed", () => {
    const between = (GATE_REARM_THRESHOLD_V + GATE_FIRE_THRESHOLD_V) / 2;
    const resetAt = 5000;
    const bandAt = 9000; // drifts up into the band without ever re-arming
    const outs = renderLfo({
      sr,
      rateHz: 3,
      totalSamples: 20000,
      rstAt: (i) => {
        if (i < resetAt) return 0;
        if (i < bandAt) return GATE_HIGH_V; // fired, held high
        return between; // never dropped below re-arm — must not re-fire
      },
    });
    // If the band re-fired, Saw would snap to -CV_BIPOLAR_MAX at bandAt.
    // Instead it must continue its ramp without discontinuity.
    const inc = (2 * (3 / sr)) * CV_BIPOLAR_MAX;
    for (let i = bandAt; i < bandAt + 3000; i++) {
      const step = outs[SAW][i] - outs[SAW][i - 1];
      // Steps are either the ramp increment or a full wrap upward through -5.
      if (Math.abs(step) > inc * 2) {
        expect(outs[SAW][i - 1]).toBeGreaterThan(CV_BIPOLAR_MAX * 0.99); // natural wrap only
      }
    }
  });
});

describe("lfoKernel — safety", () => {
  const sr = 48000;

  it("non-finite Rate param falls back to the default and stays finite", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const outs = renderLfo({ sr, rateHz: bad, totalSamples: sr * 2 });
      let allFinite = true;
      for (const o of [SINE, TRI, SQ, SAW, SUB]) {
        for (let i = 0; i < outs[o].length; i++) {
          if (!Number.isFinite(outs[o][i])) allFinite = false;
        }
      }
      expect(allFinite).toBe(true);
      // Still oscillates at the default rate.
      expect(measuredHz(outs[SQ], sr)).toBeGreaterThan(0);
    }
  });

  it("non-finite Rate CV samples freeze safely (0 Hz), outputs stay finite", () => {
    const outs = renderLfo({
      sr,
      rateHz: 5,
      totalSamples: sr,
      rateCvAt: (i) => (i % 2 === 0 ? NaN : Infinity),
    });
    let ok = true;
    for (const o of [SINE, TRI, SQ, SAW, SUB]) {
      for (let i = 0; i < outs[o].length; i++) {
        if (!Number.isFinite(outs[o][i]) || Math.abs(outs[o][i]) > CV_BIPOLAR_MAX) ok = false;
      }
    }
    expect(ok).toBe(true);
  });

  it("non-finite Rst samples read as low and never reset", () => {
    const clean = renderLfo({ sr, rateHz: 3, totalSamples: 10000 });
    const dirty = renderLfo({
      sr,
      rateHz: 3,
      totalSamples: 10000,
      rstAt: () => NaN,
    });
    let mismatches = 0;
    for (let i = 0; i < 10000; i++) {
      if (dirty[SINE][i] !== clean[SINE][i]) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it("writes every declared output for a partial block, no stale samples", () => {
    const state = lfoKernel.init(sr);
    const outs = makeOuts();
    for (const o of outs) o.fill(999);
    const n = 17;
    lfoKernel.process(state, [null, null], outs, new Float32Array([5]), n);
    for (const o of outs) {
      for (let i = 0; i < n; i++) expect(o[i]).not.toBe(999);
      for (let i = n; i < BLOCK_FRAMES; i++) expect(o[i]).toBe(999);
    }
  });

  it("output range clamps within ±CV_BIPOLAR_MAX at the rate extremes", () => {
    for (const rate of [0.01, 30]) {
      const outs = renderLfo({ sr, rateHz: rate, totalSamples: sr / 2 });
      let ok = true;
      for (const o of [SINE, TRI, SQ, SAW, SUB]) {
        for (let i = 0; i < outs[o].length; i++) {
          if (Math.abs(outs[o][i]) > CV_BIPOLAR_MAX) ok = false;
        }
      }
      expect(ok).toBe(true);
    }
  });
});

describe("lfoKernel — tracer bullet", () => {
  it("unpatched inputs at 1 Hz write a sine starting at 0 rising", () => {
    const sr = 48000;
    const state = lfoKernel.init(sr);
    const outs = makeOuts();
    const params = new Float32Array([1]); // Rate = 1 Hz
    lfoKernel.process(state, [null, null], outs, params, BLOCK_FRAMES);
    // Phase convention: sample written from current phase, then advance —
    // the very first sample is sin(0) = 0.
    expect(outs[SINE][0]).toBe(0);
    // 1 Hz at 48 kHz rises slowly but strictly within the first block.
    expect(outs[SINE][BLOCK_FRAMES - 1]).toBeGreaterThan(0);
    expect(outs[SINE][BLOCK_FRAMES - 1]).toBeLessThan(CV_BIPOLAR_MAX * 0.05);
  });
});
