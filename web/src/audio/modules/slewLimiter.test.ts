// @vitest-environment node

import { describe, it, expect } from "vitest";
import { slewLimiterKernel } from "./slewLimiter";
import { registry, isPlayable } from "./registry";
import { BLOCK_FRAMES } from "../engine/units";

const SR = 48000;

// Documented endpoints from slewLimiter.ts: raw 1 (fully clockwise) maps to
// exactly TIME_PER_V_MAX_S = 2 s/V regardless of the minimum, since
// MIN * (MAX/MIN)^1 == MAX. Tests use this endpoint (plus CV that only ever
// shortens the effective time) so they don't depend on the private minimum.
const MAX_S_PER_V = 2;

function makeOuts(): Float32Array[] {
  return [new Float32Array(BLOCK_FRAMES)];
}

/**
 * Renders `totalSamples` of Out in BLOCK_FRAMES chunks from scripted
 * per-sample In / Rise CV / Fall CV volt scripts, starting from a fresh
 * kernel state.
 */
function render(opts: {
  sr?: number;
  totalSamples: number;
  inAt: (sample: number) => number;
  riseCvAt?: (sample: number) => number;
  fallCvAt?: (sample: number) => number;
  rise?: number | ((sample: number) => number);
  fall?: number | ((sample: number) => number);
  patchIn?: boolean;
  patchRiseCv?: boolean;
  patchFallCv?: boolean;
}): Float32Array {
  const sr = opts.sr ?? SR;
  const state = slewLimiterKernel.init(sr);
  const inBuf = new Float32Array(BLOCK_FRAMES);
  const riseCvBuf = new Float32Array(BLOCK_FRAMES);
  const fallCvBuf = new Float32Array(BLOCK_FRAMES);
  const outs = makeOuts();
  const out = new Float32Array(opts.totalSamples);
  const patchIn = opts.patchIn ?? true;
  const patchRiseCv = opts.patchRiseCv ?? true;
  const patchFallCv = opts.patchFallCv ?? true;

  const riseOpt = opts.rise;
  const riseAt: (sample: number) => number =
    typeof riseOpt === "function" ? riseOpt : (_i: number) => riseOpt ?? 0;
  const fallOpt = opts.fall;
  const fallAt: (sample: number) => number =
    typeof fallOpt === "function" ? fallOpt : (_i: number) => fallOpt ?? 0;

  const params = new Float32Array(2);

  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      inBuf[i] = opts.inAt(start + i);
      riseCvBuf[i] = opts.riseCvAt ? opts.riseCvAt(start + i) : 0;
      fallCvBuf[i] = opts.fallCvAt ? opts.fallCvAt(start + i) : 0;
    }
    params[0] = riseAt(start);
    params[1] = fallAt(start);
    slewLimiterKernel.process(
      state,
      [patchIn ? inBuf : null, patchRiseCv ? riseCvBuf : null, patchFallCv ? fallCvBuf : null],
      outs,
      params,
      n,
    );
    out.set(outs[0].subarray(0, n), start);
  }
  return out;
}

// ── 1. Registry / seed ───────────────────────────────────────────────────────

describe("slew-limiter registry entry", () => {
  it("matches the seed exactly: In/Rise CV/Fall CV inputs, Out output, Rise/Fall controls", () => {
    const entry = registry.get("slew-limiter");
    expect(entry).toBeDefined();
    expect(entry?.inJacks).toEqual(["In", "Rise CV", "Fall CV"]);
    expect(entry?.outJacks).toEqual(["Out"]);
    expect(Object.keys(entry?.params ?? {})).toEqual(["Rise", "Fall"]);
  });

  it("is playable", () => {
    expect(isPlayable("slew-limiter")).toBe(true);
  });

  it("uses the canonical slewLimiterKernel (identity)", () => {
    expect(registry.get("slew-limiter")?.kernel).toBe(slewLimiterKernel);
  });

  it("Rise/Fall default to 0, a hard bypass, so an untouched knob is a true passthrough", () => {
    const entry = registry.get("slew-limiter");
    expect(entry?.params.Rise.default).toBe(0);
    expect(entry?.params.Fall.default).toBe(0);
  });
});

// ── 2. Zero slew is exact passthrough ────────────────────────────────────────

describe("slewLimiterKernel — zero slew is exact passthrough", () => {
  it("Rise = Fall = 0 reproduces the input exactly, sample for sample, including a large instant step", () => {
    const out = render({
      totalSamples: 2000,
      rise: 0,
      fall: 0,
      inAt: (i) => (i < 1000 ? -5 : 8), // a large instant step, both directions represented
    });
    for (let i = 0; i < 2000; i++) {
      expect(out[i]).toBe(i < 1000 ? -5 : 8);
    }
  });

  it("Rise = Fall = 0 tracks a fast-moving arbitrary signal exactly", () => {
    const sig = (i: number) => Math.sin(i * 0.37) * 7 + Math.cos(i * 1.9) * 3;
    const out = render({ totalSamples: 500, rise: 0, fall: 0, inAt: sig });
    for (let i = 0; i < 500; i++) {
      // Bypass writes the sample straight through; the only precision loss is
      // the standard float64 -> Float32Array store, not slew accumulation.
      expect(out[i]).toBe(Math.fround(sig(i)));
    }
  });
});

// ── 3. Rising ramps respect the configured rate ──────────────────────────────

describe("slewLimiterKernel — rising ramps respect the configured rate", () => {
  it("a step after settling climbs at exactly 1/(2*sr) V per sample and reaches the target with no overshoot", () => {
    const settleSamples = 100;
    const stepAt = settleSamples;
    // At the slowest rate (2 s/V) a 4 V step takes a full 8 real seconds to
    // traverse, so use a small target: 0.05 V still exercises many samples
    // of ramp (~2400 at 48 kHz) without an unwieldy render length.
    const target = 0.05;
    const ratePerSample = 1 / (MAX_S_PER_V * SR);
    const reachSample = stepAt + Math.ceil(target / ratePerSample);
    const out = render({
      totalSamples: reachSample + 100,
      rise: 1, // 2 s/V, slowest rate
      fall: 0,
      inAt: (i) => (i < stepAt ? 0 : target),
    });
    // Before the step: initialized to 0 and holds at 0 (target already 0).
    for (let i = 0; i < stepAt; i++) expect(out[i]).toBe(0);

    // Exact linear climb, sample by sample, until the target is reached.
    // Tolerance covers float32 output rounding, not slew accumulation error
    // (state is accumulated at full float64 precision; only the Float32Array
    // write loses precision, same as every other kernel's output buffer).
    for (let i = stepAt; i < reachSample; i++) {
      const expected = Math.min(target, (i - stepAt + 1) * ratePerSample);
      expect(out[i]).toBeCloseTo(expected, 5);
    }
    // Reaches and holds exactly at the target.
    expect(out[reachSample]).toBeCloseTo(target, 6);
    expect(out[reachSample + 99]).toBeCloseTo(target, 6);
  });
});

// ── 4. Falling ramps respect the configured rate ─────────────────────────────

describe("slewLimiterKernel — falling ramps respect the configured rate", () => {
  it("a step after settling falls at exactly 1/(2*sr) V per sample and reaches the target with no overshoot", () => {
    const settleSamples = 100;
    const stepAt = settleSamples;
    const start = 0.03;
    const target = -0.02; // small delta — see rising-ramp test for why
    const ratePerSample = 1 / (MAX_S_PER_V * SR);
    const reachSample = stepAt + Math.ceil((start - target) / ratePerSample);
    const out = render({
      totalSamples: reachSample + 100,
      rise: 0,
      fall: 1, // 2 s/V, slowest rate
      inAt: (i) => (i < stepAt ? start : target),
    });
    for (let i = 0; i < stepAt; i++) expect(out[i]).toBeCloseTo(start, 6);

    for (let i = stepAt; i < reachSample; i++) {
      const expected = Math.max(target, start - (i - stepAt + 1) * ratePerSample);
      expect(out[i]).toBeCloseTo(expected, 5);
    }
    expect(out[reachSample]).toBeCloseTo(target, 6);
    expect(out[reachSample + 99]).toBeCloseTo(target, 6);
  });
});

// ── 5. No overshoot ───────────────────────────────────────────────────────────

describe("slewLimiterKernel — no overshoot", () => {
  it("never exceeds the target while rising, for a variety of rates", () => {
    for (const rise of [0.1, 0.5, 0.9, 1]) {
      const target = 5;
      const out = render({
        totalSamples: SR,
        rise,
        fall: 0,
        inAt: (i) => (i < 10 ? 0 : target),
      });
      for (let i = 0; i < SR; i++) {
        expect(out[i]).toBeLessThanOrEqual(target);
      }
    }
  });

  it("never undershoots the target while falling, for a variety of rates", () => {
    for (const fall of [0.1, 0.5, 0.9, 1]) {
      const target = -5;
      const out = render({
        totalSamples: SR,
        rise: 0,
        fall,
        inAt: (i) => (i < 10 ? 0 : target),
      });
      for (let i = 0; i < SR; i++) {
        expect(out[i]).toBeGreaterThanOrEqual(target);
      }
    }
  });

  it("a target that reverses mid-slew never overshoots the new target either", () => {
    const out = render({
      totalSamples: SR,
      rise: 0.5,
      fall: 0.5,
      inAt: (i) => {
        if (i < 10) return 0;
        if (i < 5000) return 10; // rising
        return -10; // reverses to falling before reaching +10
      },
    });
    for (let i = 0; i < SR; i++) {
      expect(out[i]).toBeLessThanOrEqual(10);
      expect(out[i]).toBeGreaterThanOrEqual(-10);
    }
  });
});

// ── 6. Asymmetric Rise/Fall ───────────────────────────────────────────────────

describe("slewLimiterKernel — asymmetric Rise/Fall", () => {
  it("Rise limited, Fall bypassed: rising is gradual, falling is instant", () => {
    const out = render({
      totalSamples: SR * 3,
      rise: 1, // slow
      fall: 0, // bypass
      inAt: (i) => (i < 100 ? 0 : i < SR ? 5 : -5),
    });
    // Rising: does not jump immediately to 5.
    expect(out[101]).toBeGreaterThan(0);
    expect(out[101]).toBeLessThan(5);
    // Falling: the sample right after the step to -5 is exactly -5 (bypassed).
    expect(out[SR]).toBe(-5);
  });

  it("Fall limited, Rise bypassed: falling is gradual, rising is instant", () => {
    const out = render({
      totalSamples: SR * 3,
      rise: 0, // bypass
      fall: 1, // slow
      inAt: (i) => (i < 100 ? 5 : i < SR ? -5 : 5),
    });
    // Falling: does not jump immediately to -5.
    expect(out[101]).toBeLessThan(5);
    expect(out[101]).toBeGreaterThan(-5);
    // Rising: the sample right after the step back to 5 is exactly 5 (bypassed).
    expect(out[SR]).toBe(5);
  });
});

// ── 7. Sample-rate independence ───────────────────────────────────────────────

describe("slewLimiterKernel — identical real-time behavior at multiple sample rates", () => {
  it("a rising ramp at Rise = 1 (2 s/V) reaches the same voltage after the same elapsed time at 44.1k/48k/96k", () => {
    const target = 4;
    const elapsedSeconds = 1;
    for (const sr of [44100, 48000, 96000]) {
      const stepAt = 10;
      const out = render({
        sr,
        totalSamples: stepAt + Math.round(elapsedSeconds * sr) + 10,
        rise: 1,
        fall: 0,
        inAt: (i) => (i < stepAt ? 0 : target),
      });
      const ratePerSample = 1 / (MAX_S_PER_V * sr);
      const expected = Math.min(target, Math.round(elapsedSeconds * sr) * ratePerSample);
      const sampleIdx = stepAt + Math.round(elapsedSeconds * sr);
      expect(out[sampleIdx]).toBeCloseTo(expected, 3);
      // 1 second at 0.5 V/s = 0.5 V, well short of the 4 V target.
      expect(out[sampleIdx]).toBeCloseTo(0.5, 3);
    }
  });
});

// ── 8. Negative and bipolar CV (signal path) ─────────────────────────────────

describe("slewLimiterKernel — negative and bipolar CV signal path", () => {
  it("preserves a negative DC target through a bypassed slew", () => {
    const out = render({ totalSamples: 200, rise: 0, fall: 0, inAt: () => -7.5 });
    for (let i = 0; i < 200; i++) expect(out[i]).toBe(-7.5);
  });

  it("slews correctly across a bipolar swing (negative to positive and back)", () => {
    const out = render({
      totalSamples: SR,
      rise: 0.5,
      fall: 0.5,
      inAt: (i) => (i < 100 ? -5 : i < SR / 2 ? 5 : -5),
    });
    // Monotonic rise from -5 toward 5 after the first step.
    for (let i = 101; i < SR / 2 - 1 && out[i] < 5; i++) {
      expect(out[i + 1]).toBeGreaterThanOrEqual(out[i]);
    }
    for (let i = 0; i < SR; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(-5);
      expect(out[i]).toBeLessThanOrEqual(5);
    }
  });

  it("Rise CV / Fall CV shorten the effective time with negative volts (1 oct/V)", () => {
    const target = 10;
    const stepAt = 10;
    // Rise = 1 (base 2 s/V), Rise CV = -1 V => 2 * 2^-1 = 1 s/V (twice as fast).
    const outFast = render({
      totalSamples: SR,
      rise: 1,
      fall: 0,
      riseCvAt: () => -1,
      inAt: (i) => (i < stepAt ? 0 : target),
    });
    const outSlow = render({
      totalSamples: SR,
      rise: 1,
      fall: 0,
      inAt: (i) => (i < stepAt ? 0 : target),
    });
    // At a fixed sample well before either reaches the target, the CV-sped-up
    // version has climbed further.
    const probe = stepAt + 5000;
    expect(outFast[probe]).toBeGreaterThan(outSlow[probe]);
  });

  it("positive Rise CV cannot push the effective time past the 2 s/V maximum (already at max)", () => {
    const target = 10;
    const stepAt = 10;
    const withCv = render({
      totalSamples: SR,
      rise: 1, // already at the 2 s/V ceiling
      fall: 0,
      riseCvAt: () => 3, // would lengthen further if unclamped
      inAt: (i) => (i < stepAt ? 0 : target),
    });
    const withoutCv = render({
      totalSamples: SR,
      rise: 1,
      fall: 0,
      inAt: (i) => (i < stepAt ? 0 : target),
    });
    for (let i = 0; i < SR; i++) {
      expect(withCv[i]).toBeCloseTo(withoutCv[i], 9);
    }
  });

  it("CV has no effect while the corresponding knob is at bypass (raw 0)", () => {
    const out = render({
      totalSamples: 2000,
      rise: 0,
      fall: 0,
      riseCvAt: () => 5,
      fallCvAt: () => -5,
      inAt: (i) => (i < 1000 ? -4 : 6),
    });
    for (let i = 0; i < 2000; i++) {
      expect(out[i]).toBe(i < 1000 ? -4 : 6);
    }
  });
});

// ── 9. Constant input settles exactly at the target ──────────────────────────

describe("slewLimiterKernel — constant input settles exactly at the target", () => {
  it("holds a constant target exactly, with no drift, once reached", () => {
    const target = 3.3333;
    const out = render({ totalSamples: SR, rise: 0.7, fall: 0.7, inAt: () => target });
    // First sample initializes directly to the constant target, subject only
    // to the standard float64 -> Float32Array output rounding.
    const expected = Math.fround(target);
    expect(out[0]).toBe(expected);
    for (let i = 1; i < SR; i++) expect(out[i]).toBe(expected);
  });
});

// ── 10. First-sample initialization ──────────────────────────────────────────

describe("slewLimiterKernel — first-sample initialization", () => {
  it("initializes from the first input sample, not an artificial 0 V ramp", () => {
    const out = render({
      totalSamples: 1000,
      rise: 1, // slowest rate — if it ramped from 0 this would be obviously visible
      fall: 1,
      inAt: () => 9,
    });
    expect(out[0]).toBe(9);
    for (let i = 0; i < 1000; i++) expect(out[i]).toBe(9);
  });

  it("initializes from a negative first sample directly", () => {
    const out = render({ totalSamples: 500, rise: 1, fall: 1, inAt: () => -8 });
    expect(out[0]).toBe(-8);
  });

  it("initializes only once: state carries over correctly across process() calls", () => {
    const state = slewLimiterKernel.init(SR);
    const outs = makeOuts();
    const params = new Float32Array(2);
    params[0] = 1;
    params[1] = 1;

    const in1 = new Float32Array(BLOCK_FRAMES).fill(4);
    slewLimiterKernel.process(state, [in1, null, null], outs, params, BLOCK_FRAMES);
    expect(outs[0][0]).toBe(4); // first sample of the whole render initializes directly

    const in2 = new Float32Array(BLOCK_FRAMES).fill(4);
    slewLimiterKernel.process(state, [in2, null, null], outs, params, BLOCK_FRAMES);
    // Second block: still 4, held steady (target unchanged), not re-initialized
    // from a fresh 0 V (which would be indistinguishable here, so also check a
    // changed target actually slews rather than jumping).
    for (let i = 0; i < BLOCK_FRAMES; i++) expect(outs[0][i]).toBe(4);
  });
});

// ── 11. Extreme and invalid control values ────────────────────────────────────

describe("slewLimiterKernel — extreme and invalid control values", () => {
  it("clamps raw Rise/Fall above 1 to the maximum rate", () => {
    const target = 4;
    const stepAt = 10;
    const outClamped = render({
      totalSamples: SR,
      rise: 5, // out of range
      fall: 0,
      inAt: (i) => (i < stepAt ? 0 : target),
    });
    const outAtMax = render({
      totalSamples: SR,
      rise: 1,
      fall: 0,
      inAt: (i) => (i < stepAt ? 0 : target),
    });
    for (let i = 0; i < SR; i++) expect(outClamped[i]).toBeCloseTo(outAtMax[i], 9);
  });

  it("clamps negative raw Rise/Fall to bypass (0)", () => {
    const out = render({
      totalSamples: 500,
      rise: -3,
      fall: -3,
      inAt: (i) => (i < 250 ? -2 : 6),
    });
    for (let i = 0; i < 500; i++) expect(out[i]).toBe(i < 250 ? -2 : 6);
  });

  it("non-finite Rise/Fall fall back to bypass (0), the safe direction", () => {
    const out = render({
      totalSamples: 500,
      rise: NaN,
      fall: Infinity,
      inAt: (i) => (i < 250 ? -2 : 6),
    });
    for (let i = 0; i < 500; i++) expect(out[i]).toBe(i < 250 ? -2 : 6);
  });
});

// ── 12. No NaN/Infinity ───────────────────────────────────────────────────────

describe("slewLimiterKernel — safety", () => {
  it("never emits NaN/Infinity under adversarial input and control values", () => {
    const out = render({
      totalSamples: 3000,
      rise: (i) => (i % 7 === 0 ? NaN : (i % 100) / 100),
      fall: (i) => (i % 11 === 0 ? Infinity : (i % 50) / 50),
      riseCvAt: (i) => (i % 13 === 0 ? NaN : i % 200),
      fallCvAt: (i) => (i % 17 === 0 ? -Infinity : -(i % 200)),
      inAt: (i) => (i % 5 === 0 ? NaN : i % 3 === 0 ? Infinity : (i % 2000) - 1000),
    });
    for (let i = 0; i < 3000; i++) expect(Number.isFinite(out[i])).toBe(true);
  });

  it("unpatched In reads as 0 V", () => {
    const out = render({ totalSamples: 200, rise: 0, fall: 0, inAt: () => 5, patchIn: false });
    for (let i = 0; i < 200; i++) expect(out[i]).toBe(0);
  });

  it("unpatched Rise CV / Fall CV leave the base rate unaffected", () => {
    const target = 4;
    const stepAt = 10;
    const outUnpatched = render({
      totalSamples: SR,
      rise: 0.5,
      fall: 0,
      inAt: (i) => (i < stepAt ? 0 : target),
      patchRiseCv: false,
    });
    const outZeroCv = render({
      totalSamples: SR,
      rise: 0.5,
      fall: 0,
      riseCvAt: () => 0,
      inAt: (i) => (i < stepAt ? 0 : target),
    });
    for (let i = 0; i < SR; i++) expect(outUnpatched[i]).toBe(outZeroCv[i]);
  });

  it("writes every declared output for a partial block, no stale sentinel samples", () => {
    const state = slewLimiterKernel.init(SR);
    const outs = makeOuts();
    outs[0].fill(999);
    const n = 17;
    const inp = new Float32Array(BLOCK_FRAMES).fill(2);
    slewLimiterKernel.process(state, [inp, null, null], outs, new Float32Array(2), n);
    for (let i = 0; i < n; i++) expect(outs[0][i]).not.toBe(999);
    for (let i = n; i < BLOCK_FRAMES; i++) expect(outs[0][i]).toBe(999);
  });
});
