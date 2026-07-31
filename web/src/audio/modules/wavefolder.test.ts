// @vitest-environment node

import { describe, it, expect } from "vitest";
import { wavefolderKernel } from "./wavefolder";
import { BLOCK_FRAMES, CV_BIPOLAR_MAX, AUDIO_NORM } from "../engine/units";

const SR = 48000;

// Matches the seed control order in registry.ts: Fold, Sym, Bias.
const DEFAULT_PARAMS: [number, number, number] = [1, 0, 0];

function constBuf(v: number): Float32Array {
  return new Float32Array(BLOCK_FRAMES).fill(v);
}

function rampBuf(from: number, to: number): Float32Array {
  const buf = new Float32Array(BLOCK_FRAMES);
  for (let i = 0; i < BLOCK_FRAMES; i++) {
    buf[i] = from + ((to - from) * i) / (BLOCK_FRAMES - 1);
  }
  return buf;
}

function makeOut(): Float32Array {
  return new Float32Array(BLOCK_FRAMES);
}

function runFold(
  x: Float32Array | null,
  params: [number, number, number] = DEFAULT_PARAMS,
  foldCV: Float32Array | null = null,
  symCV: Float32Array | null = null,
): Float32Array {
  const state = wavefolderKernel.init(SR);
  const out = makeOut();
  wavefolderKernel.process(state, [x, foldCV, symCV], [out], new Float32Array(params), BLOCK_FRAMES);
  return out;
}

function expectAllFinite(buf: Float32Array): void {
  for (let i = 0; i < buf.length; i++) {
    expect(Number.isFinite(buf[i])).toBe(true);
  }
}

// Counts local extrema (sign changes in the first difference) as a proxy for
// "number of folds" — every additional reflection adds a turning point.
function countExtrema(buf: Float32Array): number {
  let count = 0;
  let prevDiff = 0;
  for (let i = 1; i < buf.length; i++) {
    const diff = buf[i] - buf[i - 1];
    if (diff !== 0) {
      if (prevDiff !== 0 && Math.sign(diff) !== Math.sign(prevDiff)) count++;
      prevDiff = diff;
    }
  }
  return count;
}

describe("wavefolder passthrough at minimum fold", () => {
  it("Fold=1 (min), Sym=0, Bias=0 passes constant values within the audio range through unchanged", () => {
    for (const v of [0, 1, -1, 2.5, -3.7, AUDIO_NORM, -AUDIO_NORM]) {
      const out = runFold(constBuf(v));
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        expect(out[i]).toBeCloseTo(v, 5);
      }
    }
  });

  it("passes a full-amplitude sine at min fold through essentially unchanged", () => {
    const x = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      x[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * AUDIO_NORM;
    }
    const out = runFold(x);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(x[i], 4);
    }
  });
});

describe("wavefolder positive/negative symmetry", () => {
  it("is an odd function when Sym=0: fold(-x) = -fold(x)", () => {
    const params: [number, number, number] = [6, 0, 0];
    for (const v of [0.5, 2, 3.9, 6.4, 20]) {
      const outPos = runFold(constBuf(v), params);
      const outNeg = runFold(constBuf(-v), params);
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        expect(outNeg[i]).toBeCloseTo(-outPos[i], 4);
      }
    }
  });

  it("Sym != 0 breaks symmetry: |fold(+v)| != |fold(-v)| for a value that folds", () => {
    const params: [number, number, number] = [4, 0.5, 0];
    const v = 6;
    const outPos = runFold(constBuf(v), params);
    const outNeg = runFold(constBuf(-v), params);
    expect(Math.abs(outPos[0])).not.toBeCloseTo(Math.abs(outNeg[0]), 3);
  });
});

describe("wavefolder fold amount increases harmonic complexity", () => {
  it("a higher Fold produces more extrema (more folds) across the same input sweep", () => {
    const x = rampBuf(-AUDIO_NORM * 1.2, AUDIO_NORM * 1.2);
    const lowFold = runFold(x, [1, 0, 0]);
    const highFold = runFold(x, [8, 0, 0]);
    const lowExtrema = countExtrema(lowFold);
    const highExtrema = countExtrema(highFold);
    expect(lowExtrema).toBeGreaterThanOrEqual(1);
    expect(highExtrema).toBeGreaterThan(lowExtrema);
  });
});

describe("wavefolder bias", () => {
  it("Bias offsets a silent (zero) input away from zero", () => {
    const out = runFold(constBuf(0), [1, 0, 0.5]);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).not.toBe(0);
    }
    expectAllFinite(out);
  });
});

describe("wavefolder bounded output", () => {
  it("output never exceeds the maximum possible fold threshold (AUDIO_NORM * 1.6) at extreme params/input", () => {
    const maxThreshold = AUDIO_NORM * 1.6; // matches SYM_DEPTH=0.6 in wavefolder.ts
    const out = runFold(constBuf(1e6), [8, 1, 1], constBuf(1e6), constBuf(1e6));
    expectAllFinite(out);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Math.abs(out[i])).toBeLessThanOrEqual(maxThreshold + 1e-6);
    }
  });

  it("bounded for a wide sweep of input voltages at max fold", () => {
    const x = rampBuf(-1000, 1000);
    const out = runFold(x, [8, 0, 0]);
    const maxThreshold = AUDIO_NORM * 1.6;
    expectAllFinite(out);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Math.abs(out[i])).toBeLessThanOrEqual(maxThreshold + 1e-6);
    }
  });
});

describe("wavefolder silence", () => {
  it("zero input at default params produces exact silence", () => {
    const out = runFold(constBuf(0));
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("unpatched input reads as 0V and produces silence at default params", () => {
    const out = runFold(null);
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });
});

describe("wavefolder safety with extreme/invalid values", () => {
  it("NaN input samples are treated as 0V and produce finite output", () => {
    const out = runFold(constBuf(NaN), [4, 0, 0]);
    expectAllFinite(out);
  });

  it("Infinity input samples produce finite, bounded output", () => {
    const out = runFold(constBuf(Infinity), [4, 0, 0]);
    expectAllFinite(out);
    const maxThreshold = AUDIO_NORM * 1.6;
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Math.abs(out[i])).toBeLessThanOrEqual(maxThreshold + 1e-6);
    }
  });

  it("NaN control params fall back to defaults and produce finite output", () => {
    const out = runFold(constBuf(2), [NaN, NaN, NaN]);
    expectAllFinite(out);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(2, 5);
    }
  });

  it("out-of-range control params are clamped, producing finite bounded output", () => {
    const out = runFold(constBuf(3), [1000, 1000, 1000]);
    expectAllFinite(out);
    const maxThreshold = AUDIO_NORM * 1.6;
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Math.abs(out[i])).toBeLessThanOrEqual(maxThreshold + 1e-6);
    }
  });

  it("NaN/Infinity Fold CV and Sym CV samples never produce non-finite output", () => {
    const foldCV = new Float32Array(BLOCK_FRAMES);
    const symCV = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      foldCV[i] = i % 2 === 0 ? NaN : Infinity;
      symCV[i] = i % 2 === 0 ? Infinity : -Infinity;
    }
    const out = runFold(constBuf(2), [2, 0, 0], foldCV, symCV);
    expectAllFinite(out);
  });

  it("all outputs written every block (sentinel overwrite)", () => {
    const state = wavefolderKernel.init(SR);
    const out = new Float32Array(BLOCK_FRAMES).fill(99);
    wavefolderKernel.process(
      state,
      [constBuf(1), null, null],
      [out],
      new Float32Array(DEFAULT_PARAMS),
      BLOCK_FRAMES,
    );
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).not.toBe(99);
    }
  });
});

describe("wavefolder CV modulation", () => {
  it("Fold CV adds to the base Fold amount (more folding with positive CV)", () => {
    const x = rampBuf(-AUDIO_NORM * 1.2, AUDIO_NORM * 1.2);
    const withoutCV = runFold(x, [1, 0, 0], null, null);
    const withCV = runFold(x, [1, 0, 0], constBuf(CV_BIPOLAR_MAX), null);
    expect(countExtrema(withCV)).toBeGreaterThan(countExtrema(withoutCV));
  });

  it("Sym CV adds to the base Sym amount", () => {
    const v = 6;
    const params: [number, number, number] = [4, 0, 0];
    const baseline = runFold(constBuf(v), params);
    const withSymCV = runFold(constBuf(v), params, null, constBuf(CV_BIPOLAR_MAX));
    expect(withSymCV[0]).not.toBeCloseTo(baseline[0], 3);
  });
});
