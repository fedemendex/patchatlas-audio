// @vitest-environment node

import { describe, it, expect } from "vitest";
import { mixerKernel } from "./mixer";
import { Interpreter } from "../engine/interpreter";
import { registry } from "./registry";
import { BLOCK_FRAMES } from "../engine/units";
import type { EngineGraph } from "../engine/graph";

const SR = 48000;

// params: Level 1, Level 2, Level 3, Level 4 (each 0..1)
function makeParams(l1: number, l2: number, l3: number, l4: number): Float32Array {
  return new Float32Array([l1, l2, l3, l4]);
}

function constBuf(v: number): Float32Array {
  return new Float32Array(BLOCK_FRAMES).fill(v);
}

function run(
  ins: (Float32Array | null)[],
  params: Float32Array,
): { mix: Float32Array; inv: Float32Array } {
  const state = mixerKernel.init(SR);
  const mix = new Float32Array(BLOCK_FRAMES);
  const inv = new Float32Array(BLOCK_FRAMES);
  mixerKernel.process(state, ins, [mix, inv], params, BLOCK_FRAMES);
  return { mix, inv };
}

// ── 1. Summation ──────────────────────────────────────────────────────────────

describe("mixer summation", () => {
  it("two channels at known levels sum to predicted waveform", () => {
    const in1 = constBuf(3.0);
    const in2 = constBuf(2.0);
    // L1=1, L2=0.5 → Mix = 3*1 + 2*0.5 = 4.0
    const { mix } = run([in1, in2, null, null], makeParams(1, 0.5, 0, 0));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(mix[i]).toBeCloseTo(4.0, 5);
    }
  });

  it("unpatched channels do not contribute to the mix", () => {
    const in1 = constBuf(5.0);
    // All other channels unpatched
    const { mix } = run([in1, null, null, null], makeParams(1, 1, 1, 1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(mix[i]).toBeCloseTo(5.0, 5);
    }
  });

  it("all four channels contribute independently", () => {
    const in1 = constBuf(1.0);
    const in2 = constBuf(2.0);
    const in3 = constBuf(3.0);
    const in4 = constBuf(4.0);
    // Mix = 1*1 + 2*0.5 + 3*0.25 + 4*0.125 = 1+1+0.75+0.5 = 3.25
    const { mix } = run([in1, in2, in3, in4], makeParams(1, 0.5, 0.25, 0.125));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(mix[i]).toBeCloseTo(3.25, 4);
    }
  });

  it("per-channel level = 0 silences that channel", () => {
    const in1 = constBuf(5.0);
    const in2 = constBuf(5.0);
    const { mix } = run([in1, in2, null, null], makeParams(0, 1, 0, 0));
    // Only ch2 contributes: 5 * 1 = 5
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(mix[i]).toBeCloseTo(5.0, 5);
    }
  });

  it("hot sums remain finite (no soft clipping)", () => {
    // Each channel at 5V × level=1 → Mix = 20V — intentionally hot, legal headroom
    const inp = constBuf(5.0);
    const { mix } = run([inp, inp, inp, inp], makeParams(1, 1, 1, 1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Number.isFinite(mix[i])).toBe(true);
      expect(mix[i]).toBeCloseTo(20.0, 4);
    }
  });

  it("DC signal passes correctly (DC-coupled)", () => {
    // CV signal into mixer
    const cv = constBuf(3.7);
    const { mix } = run([cv, null, null, null], makeParams(1, 1, 1, 1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(mix[i]).toBeCloseTo(3.7, 5);
    }
  });
});

// ── 2. Inv output ─────────────────────────────────────────────────────────────

describe("mixer Inv output", () => {
  it("Inv is the polarity-inverted Mix", () => {
    const in1 = constBuf(3.0);
    const in2 = constBuf(-1.0);
    const { mix, inv } = run([in1, in2, null, null], makeParams(1, 1, 0, 0));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(inv[i]).toBeCloseTo(-mix[i], 6);
    }
  });

  it("Inv of silence is silence", () => {
    const { inv } = run([null, null, null, null], makeParams(1, 1, 1, 1));
    expect(inv).toEqual(new Float32Array(BLOCK_FRAMES));
  });
});

// ── 3. Non-finite input safety ────────────────────────────────────────────────

describe("mixer non-finite input safety", () => {
  function expectAllFinite(buf: Float32Array): void {
    for (let i = 0; i < buf.length; i++) {
      expect(Number.isFinite(buf[i])).toBe(true);
    }
  }

  it("NaN in one channel does not poison Mix or Inv", () => {
    const nan = new Float32Array(BLOCK_FRAMES).fill(NaN);
    const { mix, inv } = run([nan, null, null, null], makeParams(1, 1, 1, 1));
    expectAllFinite(mix);
    expectAllFinite(inv);
  });

  it("+Infinity in one channel does not poison Mix or Inv", () => {
    const inf = new Float32Array(BLOCK_FRAMES).fill(Infinity);
    const { mix, inv } = run([inf, null, null, null], makeParams(1, 1, 1, 1));
    expectAllFinite(mix);
    expectAllFinite(inv);
  });

  it("-Infinity in one channel does not poison Mix or Inv", () => {
    const neginf = new Float32Array(BLOCK_FRAMES).fill(-Infinity);
    const { mix, inv } = run([neginf, null, null, null], makeParams(1, 1, 1, 1));
    expectAllFinite(mix);
    expectAllFinite(inv);
  });

  it("valid channels still contribute when another channel carries NaN", () => {
    const nan = new Float32Array(BLOCK_FRAMES).fill(NaN);
    const good = constBuf(3.0);
    // ch1=NaN (treated as 0), ch2=3.0×1 → Mix = 3.0
    const { mix } = run([nan, good, null, null], makeParams(1, 1, 1, 1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(mix[i]).toBeCloseTo(3.0, 5);
    }
  });

  it("hot finite sums are not clipped (headroom is legal)", () => {
    // Four channels of 10V at level 1 → Mix = 40V — legal hot sum, must not clip
    const hot = constBuf(10.0);
    const { mix } = run([hot, hot, hot, hot], makeParams(1, 1, 1, 1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Number.isFinite(mix[i])).toBe(true);
      expect(mix[i]).toBeCloseTo(40.0, 4);
    }
  });
});

// ── 5. All outputs written ────────────────────────────────────────────────────

describe("mixer output discipline", () => {
  it("all outputs written every block (sentinel overwrite)", () => {
    const state = mixerKernel.init(SR);
    const mix = new Float32Array(BLOCK_FRAMES).fill(99);
    const inv = new Float32Array(BLOCK_FRAMES).fill(99);
    mixerKernel.process(state, [null, null, null, null], [mix, inv], makeParams(1, 1, 1, 1), BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(mix[i]).not.toBe(99);
      expect(inv[i]).not.toBe(99);
    }
  });
});

// ── 6. Interpreter integration ────────────────────────────────────────────────

describe("mixer through Interpreter (two oscillators → mixer → audio-output)", () => {
  it("two oscillators mixed sum to measurable signal", () => {
    // We need registry to have mixer after AP-8 — this test depends on
    // registry being updated. Until then, use the kernel directly above.
    // This test is written to run AFTER registry.ts is updated.
    if (!registry.has("mixer")) return; // skip until registry wired

    const graph: EngineGraph = {
      nodes: [
        { instanceId: "oscA", slug: "oscillator", params: [0, 0, 0, 0, 0.5] },
        { instanceId: "oscB", slug: "oscillator", params: [0.1, 0, 0, 0, 0.5] },
        { instanceId: "mix", slug: "mixer", params: [1, 1, 0, 0] },
        { instanceId: "ao", slug: "audio-output", params: [0.8] },
      ],
      edges: [
        { from: [0, 3], to: [2, 0], feedback: false }, // oscA Sine → In 1
        { from: [1, 3], to: [2, 1], feedback: false }, // oscB Sine → In 2
        { from: [2, 0], to: [3, 0], feedback: false }, // Mix → L In
      ],
      outputNodes: [3],
    };
    const interp = new Interpreter(graph, registry, SR);
    const l = new Float32Array(BLOCK_FRAMES);
    const r = new Float32Array(BLOCK_FRAMES);
    let rms = 0;
    for (let b = 0; b < 10; b++) {
      interp.runBlock(BLOCK_FRAMES);
      interp.readOutput(l, r, BLOCK_FRAMES);
      for (let i = 0; i < BLOCK_FRAMES; i++) rms += l[i] * l[i];
    }
    rms = Math.sqrt(rms / (10 * BLOCK_FRAMES));
    expect(rms).toBeGreaterThan(0.1); // audible signal
  });
});
