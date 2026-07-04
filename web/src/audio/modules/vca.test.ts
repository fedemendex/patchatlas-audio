// @vitest-environment node

import { describe, it, expect } from "vitest";
import { vcaKernel } from "./vca";
import { BLOCK_FRAMES, CV_BIPOLAR_MAX } from "../engine/units";

const SR = 48000;

// params order: Gain (0..1), CV Amt (0..1), Response (0=Exp 1=Lin)
function makeParams(gain: number, cvAmt: number, response: number): Float32Array {
  return new Float32Array([gain, cvAmt, response]);
}

function constBuf(v: number): Float32Array {
  return new Float32Array(BLOCK_FRAMES).fill(v);
}

function makeOut(): Float32Array {
  return new Float32Array(BLOCK_FRAMES);
}

function runVca(
  inSig: Float32Array | null,
  inCv: Float32Array | null,
  params: Float32Array,
): Float32Array {
  const state = vcaKernel.init(SR);
  const out = makeOut();
  vcaKernel.process(state, [inSig, inCv], [out], params, BLOCK_FRAMES);
  return out;
}

function expectAllFinite(buf: Float32Array): void {
  for (let i = 0; i < buf.length; i++) {
    expect(Number.isFinite(buf[i])).toBe(true);
  }
}

// ── 1. Linear response ────────────────────────────────────────────────────────

describe("VCA linear response", () => {
  it("5 V CV at linear mode and full Gain gives unity gain", () => {
    const inp = constBuf(3.0); // arbitrary signal level
    const cv = constBuf(CV_BIPOLAR_MAX); // 5 V
    const out = runVca(inp, cv, makeParams(1, 1, 1)); // Lin = 1
    // gain = 1 * max(0, 5/5) = 1 → out = 3.0
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(3.0, 5);
    }
  });

  it("0 V CV gives silence regardless of Gain", () => {
    const inp = constBuf(5.0);
    const cv = constBuf(0);
    const out = runVca(inp, cv, makeParams(1, 1, 1));
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("2.5 V CV at linear mode halves the signal", () => {
    const inp = constBuf(4.0);
    const cv = constBuf(CV_BIPOLAR_MAX / 2); // 2.5 V
    const out = runVca(inp, cv, makeParams(1, 1, 1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(2.0, 5);
    }
  });

  it("negative CV is clamped to silence (not inverted) in linear mode", () => {
    const inp = constBuf(3.0);
    const cv = constBuf(-5.0);
    const out = runVca(inp, cv, makeParams(1, 1, 1));
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("Gain = 0.5 halves the output at unity CV", () => {
    const inp = constBuf(4.0);
    const cv = constBuf(CV_BIPOLAR_MAX);
    const out = runVca(inp, cv, makeParams(0.5, 1, 1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(2.0, 5);
    }
  });

  it("CV Amt = 0 silences output even with full CV patched", () => {
    const inp = constBuf(5.0);
    const cv = constBuf(CV_BIPOLAR_MAX);
    const out = runVca(inp, cv, makeParams(1, 0, 1));
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("CV Amt = 0.5 halves the effective CV (at 5 V CV → 0.5 normalized)", () => {
    const inp = constBuf(4.0);
    const cv = constBuf(CV_BIPOLAR_MAX); // 5 V
    // normalizedCv = 5 * 0.5 / 5 = 0.5 → gain = 1 * 0.5 = 0.5 → out = 2.0
    const out = runVca(inp, cv, makeParams(1, 0.5, 1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(2.0, 5);
    }
  });

  it("DC signal passes correctly (DC-coupled)", () => {
    // 3.7 V DC in, 8 V CV (above CV_BIPOLAR_MAX), full Gain, Lin
    // normalizedCv = max(0, 8/5) = 1.6 (no upper clamp) → gain = 1.6
    const inp = constBuf(3.7);
    const cv = constBuf(8);
    const out = runVca(inp, cv, makeParams(1, 1, 1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(3.7 * 1.6, 4);
    }
  });
});

// ── 2. Unpatched CV ────────────────────────────────────────────────────────────

describe("VCA unpatched CV", () => {
  it("unpatched CV: output = In * Gain (level control only)", () => {
    const inp = constBuf(5.0);
    // No CV, Gain = 0.6
    const out = runVca(inp, null, makeParams(0.6, 1, 1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(3.0, 5);
    }
  });

  it("unpatched CV with Gain = 1 → unity pass-through", () => {
    const inp = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) inp[i] = Math.sin(2 * Math.PI * 440 * i / SR) * 5;
    const out = runVca(inp, null, makeParams(1, 1, 1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBe(inp[i]);
    }
  });

  it("unpatched CV with Gain = 0 → silence", () => {
    const inp = constBuf(5.0);
    const out = runVca(inp, null, makeParams(0, 1, 1));
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("unpatched signal input → silence", () => {
    const cv = constBuf(CV_BIPOLAR_MAX);
    const out = runVca(null, cv, makeParams(1, 1, 1));
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });
});

// ── 3. Exponential response ───────────────────────────────────────────────────

describe("VCA exponential response", () => {
  it("0 V CV → silence in exp mode", () => {
    const inp = constBuf(5.0);
    const cv = constBuf(0);
    const out = runVca(inp, cv, makeParams(1, 1, 0)); // Exp = 0
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("5 V CV at full Gain in exp mode → unity gain", () => {
    const inp = constBuf(4.0);
    const cv = constBuf(CV_BIPOLAR_MAX);
    const out = runVca(inp, cv, makeParams(1, 1, 0)); // Exp
    // normalizedCv = 1, gain = 1 * 1^2 = 1
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(4.0, 5);
    }
  });

  it("exp response is strictly monotonic: more CV → more gain", () => {
    const inp = constBuf(5.0);
    const params = makeParams(1, 1, 0);
    const cvLevels = [0, 1, 2, 3, 4, 5];
    let prevOut = -Infinity;
    for (const cv of cvLevels) {
      const out = runVca(inp, constBuf(cv), params);
      expect(out[0]).toBeGreaterThanOrEqual(prevOut);
      prevOut = out[0];
    }
    // Also verify strictly increasing (not just flat).
    const low = runVca(inp, constBuf(1), params);
    const high = runVca(inp, constBuf(4), params);
    expect(high[0]).toBeGreaterThan(low[0]);
  });

  it("exp gain at 2.5 V is exactly 0.25 (x² of normalizedCv=0.5)", () => {
    const inp = constBuf(4.0);
    const cv = constBuf(CV_BIPOLAR_MAX / 2); // 2.5 V
    const lin = runVca(inp, cv, makeParams(1, 1, 1));
    const exp = runVca(inp, cv, makeParams(1, 1, 0));
    // normalizedCv = 2.5/5 = 0.5; Lin: gain=0.5→out=2.0; Exp: gain=0.25→out=1.0
    expect(lin[0]).toBeCloseTo(2.0, 5);
    expect(exp[0]).toBeCloseTo(1.0, 5);
  });
});

// ── 4. Safety ─────────────────────────────────────────────────────────────────

describe("VCA safety", () => {
  it("NaN params produce finite output", () => {
    const inp = constBuf(3.0);
    const cv = constBuf(5.0);
    const out = runVca(inp, cv, new Float32Array([NaN, NaN, NaN]));
    expectAllFinite(out);
  });

  it("NaN input samples produce finite output", () => {
    const inp = new Float32Array(BLOCK_FRAMES).fill(NaN);
    const cv = constBuf(5.0);
    const out = runVca(inp, cv, makeParams(1, 1, 1));
    expectAllFinite(out);
  });

  it("NaN CV samples produce finite output", () => {
    const inp = constBuf(3.0);
    const cv = new Float32Array(BLOCK_FRAMES).fill(NaN);
    const out = runVca(inp, cv, makeParams(1, 1, 1));
    expectAllFinite(out);
  });

  it("all outputs written every block (sentinel overwrite)", () => {
    const state = vcaKernel.init(SR);
    const out = new Float32Array(BLOCK_FRAMES).fill(99);
    vcaKernel.process(state, [constBuf(1.0), constBuf(CV_BIPOLAR_MAX)], [out], makeParams(1, 1, 1), BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).not.toBe(99);
    }
  });
});
