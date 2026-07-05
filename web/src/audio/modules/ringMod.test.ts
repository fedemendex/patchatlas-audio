// @vitest-environment node

import { describe, it, expect } from "vitest";
import { ringModKernel } from "./ringMod";
import { BLOCK_FRAMES, CV_BIPOLAR_MAX } from "../engine/units";

const SR = 48000;

function constBuf(v: number): Float32Array {
  return new Float32Array(BLOCK_FRAMES).fill(v);
}

function makeOut(): Float32Array {
  return new Float32Array(BLOCK_FRAMES);
}

function runRingMod(x: Float32Array | null, y: Float32Array | null): Float32Array {
  const state = ringModKernel.init(SR);
  const out = makeOut();
  ringModKernel.process(state, [x, y], [out], new Float32Array(0), BLOCK_FRAMES);
  return out;
}

function expectAllFinite(buf: Float32Array): void {
  for (let i = 0; i < buf.length; i++) {
    expect(Number.isFinite(buf[i])).toBe(true);
  }
}

describe("ring modulator polarity", () => {
  it("+/+ gives positive output", () => {
    const out = runRingMod(constBuf(CV_BIPOLAR_MAX), constBuf(CV_BIPOLAR_MAX));
    // 5 * 5 / 5 = 5
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(CV_BIPOLAR_MAX, 5);
    }
  });

  it("+/- gives negative output", () => {
    const out = runRingMod(constBuf(CV_BIPOLAR_MAX), constBuf(-CV_BIPOLAR_MAX));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(-CV_BIPOLAR_MAX, 5);
    }
  });

  it("-/- gives positive output", () => {
    const out = runRingMod(constBuf(-CV_BIPOLAR_MAX), constBuf(-CV_BIPOLAR_MAX));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(CV_BIPOLAR_MAX, 5);
    }
  });

  it("partial voltages multiply correctly (2 * 3 / 5 = 1.2)", () => {
    const out = runRingMod(constBuf(2), constBuf(3));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(1.2, 5);
    }
  });
});

describe("ring modulator zero/unpatched behavior", () => {
  it("zero on X mutes output", () => {
    const out = runRingMod(constBuf(0), constBuf(CV_BIPOLAR_MAX));
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("zero on Y mutes output", () => {
    const out = runRingMod(constBuf(CV_BIPOLAR_MAX), constBuf(0));
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("unpatched X mutes output (no internal carrier)", () => {
    const out = runRingMod(null, constBuf(CV_BIPOLAR_MAX));
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("unpatched Y mutes output (no internal carrier)", () => {
    const out = runRingMod(constBuf(CV_BIPOLAR_MAX), null);
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("both unpatched mutes output", () => {
    const out = runRingMod(null, null);
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });
});

describe("ring modulator audio-rate multiplication", () => {
  it("produces non-silent, bounded, finite output for two audio-rate sines", () => {
    const x = new Float32Array(BLOCK_FRAMES);
    const y = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      x[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * CV_BIPOLAR_MAX;
      y[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * CV_BIPOLAR_MAX;
    }
    const out = runRingMod(x, y);
    expectAllFinite(out);
    let nonZero = false;
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      if (out[i] !== 0) nonZero = true;
      expect(Math.abs(out[i])).toBeLessThanOrEqual(CV_BIPOLAR_MAX + 1e-6);
    }
    expect(nonZero).toBe(true);
  });
});

describe("ring modulator safety", () => {
  it("NaN X samples are treated as 0V and produce finite output", () => {
    const x = new Float32Array(BLOCK_FRAMES).fill(NaN);
    const out = runRingMod(x, constBuf(CV_BIPOLAR_MAX));
    expectAllFinite(out);
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("Infinity Y samples produce finite output", () => {
    const y = new Float32Array(BLOCK_FRAMES).fill(Infinity);
    const out = runRingMod(constBuf(CV_BIPOLAR_MAX), y);
    expectAllFinite(out);
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("all outputs written every block (sentinel overwrite)", () => {
    const state = ringModKernel.init(SR);
    const out = new Float32Array(BLOCK_FRAMES).fill(99);
    ringModKernel.process(
      state,
      [constBuf(CV_BIPOLAR_MAX), constBuf(CV_BIPOLAR_MAX)],
      [out],
      new Float32Array(0),
      BLOCK_FRAMES,
    );
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).not.toBe(99);
    }
  });
});
