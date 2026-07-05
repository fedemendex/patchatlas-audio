// @vitest-environment node

import { describe, it, expect } from "vitest";
import { noiseSourceKernel } from "./noiseSource";
import { registry, isPlayable } from "./registry";
import { BLOCK_FRAMES, CV_BIPOLAR_MAX } from "../engine/units";

const SR = 48000;

// Output slot order matches the registry entry: White, Pink, Red, Blue.
const WHITE = 0;
const PINK = 1;
const RED = 2;
const BLUE = 3;

function makeOuts(): Float32Array[] {
  return [
    new Float32Array(BLOCK_FRAMES),
    new Float32Array(BLOCK_FRAMES),
    new Float32Array(BLOCK_FRAMES),
    new Float32Array(BLOCK_FRAMES),
  ];
}

/** Renders `totalSamples` of noise in BLOCK_FRAMES chunks from a fresh kernel state. */
function render(totalSamples: number, sr = SR): Float32Array[] {
  const state = noiseSourceKernel.init(sr);
  const outs = makeOuts();
  const result = [
    new Float32Array(totalSamples),
    new Float32Array(totalSamples),
    new Float32Array(totalSamples),
    new Float32Array(totalSamples),
  ];
  for (let start = 0; start < totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, totalSamples - start);
    noiseSourceKernel.process(state, [], outs, new Float32Array(0), n);
    for (let o = 0; o < 4; o++) result[o].set(outs[o].subarray(0, n), start);
  }
  return result;
}

// ── 1. Registry / seed ───────────────────────────────────────────────────────

describe("noise-source registry entry", () => {
  it("matches the seed exactly: no inputs, four Noise-group outputs, no controls", () => {
    const entry = registry.get("noise-source");
    expect(entry).toBeDefined();
    expect(entry?.inJacks).toEqual([]);
    expect(entry?.outJacks).toEqual(["White", "Pink", "Red", "Blue"]);
    expect(entry?.params).toEqual({});
  });

  it("is playable", () => {
    expect(isPlayable("noise-source")).toBe(true);
  });

  it("uses the canonical noiseSourceKernel (identity)", () => {
    expect(registry.get("noise-source")?.kernel).toBe(noiseSourceKernel);
  });

  it("does not register the deferred noise-random slug", () => {
    expect(registry.has("noise-random")).toBe(false);
  });
});

// ── 2. Determinism ───────────────────────────────────────────────────────────

describe("noiseSourceKernel — determinism", () => {
  it("two freshly initialized states produce an identical first block", () => {
    const a = render(BLOCK_FRAMES);
    const b = render(BLOCK_FRAMES);
    expect(a[WHITE]).toEqual(b[WHITE]);
    expect(a[PINK]).toEqual(b[PINK]);
    expect(a[RED]).toEqual(b[RED]);
    expect(a[BLUE]).toEqual(b[BLUE]);
  });

  it("a continued state produces a different second block than the first", () => {
    const outs = render(BLOCK_FRAMES * 2);
    const firstBlock = outs[WHITE].subarray(0, BLOCK_FRAMES);
    const secondBlock = outs[WHITE].subarray(BLOCK_FRAMES, BLOCK_FRAMES * 2);
    let identical = true;
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      if (firstBlock[i] !== secondBlock[i]) identical = false;
    }
    expect(identical).toBe(false);
  });

  it("does not collapse to a constant/DC sequence", () => {
    const outs = render(BLOCK_FRAMES);
    let allSame = true;
    for (let i = 1; i < BLOCK_FRAMES; i++) {
      if (outs[WHITE][i] !== outs[WHITE][0]) allSame = false;
    }
    expect(allSame).toBe(false);
  });
});

// ── 3. White noise range / RMS ───────────────────────────────────────────────

describe("noiseSourceKernel — white noise", () => {
  const totalSamples = SR * 2; // 2 s
  const outs = render(totalSamples);

  it("every sample is finite", () => {
    for (let i = 0; i < totalSamples; i++) {
      expect(Number.isFinite(outs[WHITE][i])).toBe(true);
    }
  });

  it("stays within ±CV_BIPOLAR_MAX", () => {
    for (let i = 0; i < totalSamples; i++) {
      expect(outs[WHITE][i]).toBeGreaterThanOrEqual(-CV_BIPOLAR_MAX);
      expect(outs[WHITE][i]).toBeLessThan(CV_BIPOLAR_MAX);
    }
  });

  it("RMS is close to CV_BIPOLAR_MAX/√3 (~2.886 V) over a long render", () => {
    let sumSq = 0;
    for (let i = 0; i < totalSamples; i++) sumSq += outs[WHITE][i] * outs[WHITE][i];
    const rms = Math.sqrt(sumSq / totalSamples);
    const expected = CV_BIPOLAR_MAX / Math.sqrt(3);
    expect(rms).toBeGreaterThan(expected * 0.95);
    expect(rms).toBeLessThan(expected * 1.05);
  });

  it("mean is near 0 within a loose tolerance", () => {
    let sum = 0;
    for (let i = 0; i < totalSamples; i++) sum += outs[WHITE][i];
    const mean = sum / totalSamples;
    expect(Math.abs(mean)).toBeLessThan(CV_BIPOLAR_MAX * 0.05);
  });
});

// ── 4. Spectrum (coarse flatness) ────────────────────────────────────────────

describe("noiseSourceKernel — white noise spectrum", () => {
  it("is roughly flat: low-lag autocorrelation is small relative to variance", () => {
    // A flat (white) spectrum implies near-zero autocorrelation at nonzero
    // lags. This is a coarse, allocation-light stand-in for a full FFT check.
    const totalSamples = SR; // 1 s
    const outs = render(totalSamples);
    const white = outs[WHITE];

    let variance = 0;
    for (let i = 0; i < totalSamples; i++) variance += white[i] * white[i];
    variance /= totalSamples;

    for (const lag of [1, 2, 5, 20]) {
      let cov = 0;
      for (let i = lag; i < totalSamples; i++) cov += white[i] * white[i - lag];
      cov /= totalSamples - lag;
      // Normalized autocorrelation should be small (near 0) for white noise.
      expect(Math.abs(cov / variance)).toBeLessThan(0.1);
    }
  });

  it("bucketed energy (low vs high half of the block-rate spectrum) is roughly balanced", () => {
    // Coarse two-bucket energy split via consecutive-sample differencing:
    // white noise's difference signal retains comparable energy to the
    // original (no strong low-frequency bias), unlike pink/red noise.
    const totalSamples = SR;
    const outs = render(totalSamples);
    const white = outs[WHITE];

    let energy = 0;
    let diffEnergy = 0;
    for (let i = 1; i < totalSamples; i++) {
      energy += white[i] * white[i];
      const d = white[i] - white[i - 1];
      diffEnergy += d * d;
    }
    const ratio = diffEnergy / energy;
    // White noise: differencing roughly doubles the energy (ratio ≈ 2).
    // A ratio far below 1 would indicate strong low-frequency correlation.
    expect(ratio).toBeGreaterThan(1.2);
  });
});

// ── 5. Output writing ────────────────────────────────────────────────────────

describe("noiseSourceKernel — output discipline", () => {
  it("writes every declared output for every sample", () => {
    const state = noiseSourceKernel.init(SR);
    const outs = makeOuts();
    for (const o of outs) o.fill(999);
    const n = BLOCK_FRAMES;
    noiseSourceKernel.process(state, [], outs, new Float32Array(0), n);
    for (let i = 0; i < n; i++) {
      expect(outs[WHITE][i]).not.toBe(999);
      expect(outs[PINK][i]).not.toBe(999);
      expect(outs[RED][i]).not.toBe(999);
      expect(outs[BLUE][i]).not.toBe(999);
    }
  });

  it("writes every output for a partial block, no stale sentinel samples", () => {
    const state = noiseSourceKernel.init(SR);
    const outs = makeOuts();
    for (const o of outs) o.fill(999);
    const n = 17;
    noiseSourceKernel.process(state, [], outs, new Float32Array(0), n);
    for (const o of outs) {
      for (let i = 0; i < n; i++) expect(o[i]).not.toBe(999);
      for (let i = n; i < BLOCK_FRAMES; i++) expect(o[i]).toBe(999);
    }
  });
});

// ── 6. Pink noise ─────────────────────────────────────────────────────────────

describe("noiseSourceKernel — pink noise", () => {
  const totalSamples = SR * 2;
  const outs = render(totalSamples);

  it("every sample is finite", () => {
    for (let i = 0; i < totalSamples; i++) {
      expect(Number.isFinite(outs[PINK][i])).toBe(true);
    }
  });

  it("is deterministic across two fresh renders", () => {
    const a = render(BLOCK_FRAMES);
    const b = render(BLOCK_FRAMES);
    expect(a[PINK]).toEqual(b[PINK]);
  });

  it("RMS is bounded and not dramatically hotter than White", () => {
    let sumSqWhite = 0;
    let sumSqPink = 0;
    for (let i = 0; i < totalSamples; i++) {
      sumSqWhite += outs[WHITE][i] * outs[WHITE][i];
      sumSqPink += outs[PINK][i] * outs[PINK][i];
    }
    const whiteRms = Math.sqrt(sumSqWhite / totalSamples);
    const pinkRms = Math.sqrt(sumSqPink / totalSamples);
    // Gain-compensated pink should be the same order of magnitude as white
    // (previously ~3x hotter before compensation was added), not silent either.
    expect(pinkRms).toBeGreaterThan(whiteRms * 0.3);
    expect(pinkRms).toBeLessThan(whiteRms * 1.5);
  });

  it("peak over a long deterministic render stays within the ±CV_BIPOLAR_MAX source-range guard", () => {
    for (let i = 0; i < totalSamples; i++) {
      expect(outs[PINK][i]).toBeGreaterThanOrEqual(-CV_BIPOLAR_MAX);
      expect(outs[PINK][i]).toBeLessThanOrEqual(CV_BIPOLAR_MAX);
    }
  });

  it("shows a low-vs-high energy trend consistent with pink (−3 dB/oct): less high-frequency energy than white", () => {
    // Consecutive-sample differencing acts as a crude high-pass; pink noise's
    // differenced energy should be relatively smaller than white's, since
    // pink carries more low-frequency energy per Hz.
    const white = outs[WHITE];
    const pink = outs[PINK];

    let whiteEnergy = 0;
    let whiteDiffEnergy = 0;
    let pinkEnergy = 0;
    let pinkDiffEnergy = 0;
    for (let i = 1; i < totalSamples; i++) {
      whiteEnergy += white[i] * white[i];
      pinkEnergy += pink[i] * pink[i];
      const wd = white[i] - white[i - 1];
      const pd = pink[i] - pink[i - 1];
      whiteDiffEnergy += wd * wd;
      pinkDiffEnergy += pd * pd;
    }
    const whiteRatio = whiteDiffEnergy / whiteEnergy;
    const pinkRatio = pinkDiffEnergy / pinkEnergy;
    expect(pinkRatio).toBeLessThan(whiteRatio);
  });
});

// ── 7. Red noise ──────────────────────────────────────────────────────────────

describe("noiseSourceKernel — red noise", () => {
  const totalSamples = SR * 2;
  const outs = render(totalSamples);

  it("every sample is finite", () => {
    for (let i = 0; i < totalSamples; i++) {
      expect(Number.isFinite(outs[RED][i])).toBe(true);
    }
  });

  it("is non-silent", () => {
    let allZero = true;
    for (let i = 0; i < totalSamples; i++) {
      if (outs[RED][i] !== 0) allZero = false;
    }
    expect(allZero).toBe(false);
  });

  it("is deterministic across two fresh renders", () => {
    const a = render(BLOCK_FRAMES);
    const b = render(BLOCK_FRAMES);
    expect(a[RED]).toEqual(b[RED]);
  });

  it("stays within ±CV_BIPOLAR_MAX", () => {
    for (let i = 0; i < totalSamples; i++) {
      expect(outs[RED][i]).toBeGreaterThanOrEqual(-CV_BIPOLAR_MAX);
      expect(outs[RED][i]).toBeLessThanOrEqual(CV_BIPOLAR_MAX);
    }
  });

  it("has lower average sample-to-sample movement than White (leaky-integrator smoothing)", () => {
    const white = outs[WHITE];
    const red = outs[RED];
    let whiteMovement = 0;
    let redMovement = 0;
    for (let i = 1; i < totalSamples; i++) {
      whiteMovement += Math.abs(white[i] - white[i - 1]);
      redMovement += Math.abs(red[i] - red[i - 1]);
    }
    expect(redMovement).toBeLessThan(whiteMovement);
  });
});

// ── 8. Blue noise ─────────────────────────────────────────────────────────────

describe("noiseSourceKernel — blue noise", () => {
  const totalSamples = SR * 2;
  const outs = render(totalSamples);

  it("every sample is finite", () => {
    for (let i = 0; i < totalSamples; i++) {
      expect(Number.isFinite(outs[BLUE][i])).toBe(true);
    }
  });

  it("is non-silent", () => {
    let allZero = true;
    for (let i = 0; i < totalSamples; i++) {
      if (outs[BLUE][i] !== 0) allZero = false;
    }
    expect(allZero).toBe(false);
  });

  it("is deterministic across two fresh renders", () => {
    const a = render(BLOCK_FRAMES);
    const b = render(BLOCK_FRAMES);
    expect(a[BLUE]).toEqual(b[BLUE]);
  });

  it("stays within ±CV_BIPOLAR_MAX", () => {
    for (let i = 0; i < totalSamples; i++) {
      expect(outs[BLUE][i]).toBeGreaterThanOrEqual(-CV_BIPOLAR_MAX);
      expect(outs[BLUE][i]).toBeLessThanOrEqual(CV_BIPOLAR_MAX);
    }
  });

  it("has higher average sample-to-sample movement than White (first-difference brightening)", () => {
    const white = outs[WHITE];
    const blue = outs[BLUE];
    let whiteMovement = 0;
    let blueMovement = 0;
    for (let i = 1; i < totalSamples; i++) {
      whiteMovement += Math.abs(white[i] - white[i - 1]);
      blueMovement += Math.abs(blue[i] - blue[i - 1]);
    }
    expect(blueMovement).toBeGreaterThan(whiteMovement);
  });

  it("has materially more high-frequency movement than Red", () => {
    const red = outs[RED];
    const blue = outs[BLUE];
    let redMovement = 0;
    let blueMovement = 0;
    for (let i = 1; i < totalSamples; i++) {
      redMovement += Math.abs(red[i] - red[i - 1]);
      blueMovement += Math.abs(blue[i] - blue[i - 1]);
    }
    expect(blueMovement).toBeGreaterThan(redMovement * 5);
  });
});
