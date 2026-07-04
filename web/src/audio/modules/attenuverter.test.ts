// @vitest-environment node

import { describe, it, expect } from "vitest";
import { attenuverterKernel } from "./attenuverter";
import { BLOCK_FRAMES, CV_BIPOLAR_MAX } from "../engine/units";

const SR = 48000;

// params: Att 1 (-1..1), Att 2 (-1..1)
function makeParams(k1: number, k2: number): Float32Array {
  return new Float32Array([k1, k2]);
}

function constBuf(v: number): Float32Array {
  return new Float32Array(BLOCK_FRAMES).fill(v);
}

function run(
  in1: Float32Array | null,
  in2: Float32Array | null,
  k1: number,
  k2: number,
): { out1: Float32Array; out2: Float32Array } {
  const state = attenuverterKernel.init(SR);
  const out1 = new Float32Array(BLOCK_FRAMES);
  const out2 = new Float32Array(BLOCK_FRAMES);
  attenuverterKernel.process(state, [in1, in2], [out1, out2], makeParams(k1, k2), BLOCK_FRAMES);
  return { out1, out2 };
}

// ── 1. Patched input behaviour ─────────────────────────────────────────────────

describe("attenuverter patched input", () => {
  it("k=+1 passes signal unchanged (ch1)", () => {
    const inp = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) inp[i] = (i / BLOCK_FRAMES) * 10 - 5;
    const { out1 } = run(inp, null, 1, 0);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out1[i]).toBe(inp[i]);
    }
  });

  it("k=-1 exactly inverts signal (ch1)", () => {
    const inp = constBuf(3.5);
    const { out1 } = run(inp, null, -1, 0);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out1[i]).toBeCloseTo(-3.5, 6);
    }
  });

  it("k=0 silences a patched signal (ch1)", () => {
    const inp = constBuf(5.0);
    const { out1 } = run(inp, null, 0, 0);
    expect(out1).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("k=0.5 halves the signal", () => {
    const inp = constBuf(4.0);
    const { out1 } = run(inp, null, 0.5, 0);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out1[i]).toBeCloseTo(2.0, 6);
    }
  });

  it("channels are independent — ch2 does not bleed into ch1", () => {
    const inp1 = constBuf(5.0);
    const inp2 = constBuf(3.0);
    const { out1, out2 } = run(inp1, inp2, 1, -1);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out1[i]).toBeCloseTo(5.0, 6);
      expect(out2[i]).toBeCloseTo(-3.0, 6);
    }
  });
});

// ── 2. Unpatched input behaviour (offset source) ──────────────────────────────

describe("attenuverter unpatched input (offset source)", () => {
  it("k=+1 unpatched → +CV_BIPOLAR_MAX output", () => {
    const { out1 } = run(null, null, 1, 0);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out1[i]).toBeCloseTo(CV_BIPOLAR_MAX, 6);
    }
  });

  it("k=-1 unpatched → -CV_BIPOLAR_MAX output", () => {
    const { out1 } = run(null, null, -1, 0);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out1[i]).toBeCloseTo(-CV_BIPOLAR_MAX, 6);
    }
  });

  it("k=0 unpatched → 0 V output", () => {
    const { out1 } = run(null, null, 0, 0);
    expect(out1).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("k=0.5 unpatched → +CV_BIPOLAR_MAX/2", () => {
    const { out1 } = run(null, null, 0.5, 0);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out1[i]).toBeCloseTo(CV_BIPOLAR_MAX / 2, 6);
    }
  });

  it("ch2 unpatched k=-0.5 → -CV_BIPOLAR_MAX/2, independent of ch1", () => {
    const inp1 = constBuf(2.0);
    const { out1, out2 } = run(inp1, null, 1, -0.5);
    // ch1 patched → passes signal × 1
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out1[i]).toBeCloseTo(2.0, 6);
    }
    // ch2 unpatched → CV_BIPOLAR_MAX × -0.5
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out2[i]).toBeCloseTo(-CV_BIPOLAR_MAX * 0.5, 6);
    }
  });
});

// ── 3. Safety ─────────────────────────────────────────────────────────────────

describe("attenuverter safety", () => {
  it("NaN input samples do not produce NaN output", () => {
    const inp = new Float32Array(BLOCK_FRAMES).fill(NaN);
    const { out1 } = run(inp, null, 1, 0);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Number.isFinite(out1[i])).toBe(true);
    }
  });

  it("NaN k params do not produce NaN output", () => {
    const inp = constBuf(3.0);
    const state = attenuverterKernel.init(SR);
    const out1 = new Float32Array(BLOCK_FRAMES);
    const out2 = new Float32Array(BLOCK_FRAMES);
    attenuverterKernel.process(state, [inp, null], [out1, out2], new Float32Array([NaN, NaN]), BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Number.isFinite(out1[i])).toBe(true);
      expect(Number.isFinite(out2[i])).toBe(true);
    }
  });

  it("all output buffers written every block (sentinel overwrite)", () => {
    const state = attenuverterKernel.init(SR);
    const out1 = new Float32Array(BLOCK_FRAMES).fill(99);
    const out2 = new Float32Array(BLOCK_FRAMES).fill(99);
    attenuverterKernel.process(state, [null, null], [out1, out2], makeParams(0.5, 0.5), BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out1[i]).not.toBe(99);
      expect(out2[i]).not.toBe(99);
    }
  });
});
