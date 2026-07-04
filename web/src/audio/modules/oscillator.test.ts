// @vitest-environment node
// (Pure engine logic; no DOM needed and jsdom breaks import.meta.url resolves.)

import { describe, it, expect } from "vitest";
import { oscillatorKernel } from "./oscillator";
import { registry, isPlayable } from "./registry";
import { Interpreter } from "../engine/interpreter";
import { BLOCK_FRAMES, C4_HZ, LINEAR_FM_HZ_PER_VOLT } from "../engine/units";
import type { EngineGraph } from "../engine/graph";

const SR = 48000;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Seed param order: Tune, Fine, FM Amt, EFM Amt, PW — all defaults.
function defaultParams(): Float32Array {
  return new Float32Array([0, 0, 0, 0, 0.5]);
}

function constBuf(len: number, volts: number): Float32Array {
  return new Float32Array(len).fill(volts);
}

function sineBuf(len: number, hz: number, amp: number): Float32Array {
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) buf[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return buf;
}

// Renders the kernel directly (init + process) and returns the full-length
// Sine output. `insFull` are per-input full-length buffers (or null =
// unpatched), sliced per block via subarray.
function renderSine(
  totalSamples: number,
  params: Float32Array,
  insFull: (Float32Array | null)[] = [null, null, null, null, null],
): Float32Array {
  const state = oscillatorKernel.init(SR);
  const outs = [0, 1, 2, 3, 4].map(() => new Float32Array(BLOCK_FRAMES));
  const sine = new Float32Array(totalSamples);
  for (let offset = 0; offset < totalSamples; offset += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, totalSamples - offset);
    const ins = insFull.map((b) => (b ? b.subarray(offset, offset + n) : null));
    oscillatorKernel.process(state, ins, outs, params, n);
    sine.set(outs[3].subarray(0, n), offset);
  }
  return sine;
}

// Frequency estimate from upward zero crossings, measured first-to-last
// crossing so partial cycles at the edges don't bias the count.
function estimateHz(buf: Float32Array, sr: number = SR): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1] < 0 && buf[i] >= 0) {
      if (first === -1) first = i;
      last = i;
      count++;
    }
  }
  if (count < 2) return 0;
  return (count - 1) / ((last - first) / sr);
}

// Goertzel single-bin power — relative comparisons only, so unnormalized.
function goertzelPower(buf: Float32Array, hz: number, sr: number = SR): number {
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / sr);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const s0 = buf[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

// ── 1. Registry ───────────────────────────────────────────────────────────────

describe("oscillator registry entry", () => {
  it("production registry has exactly audio-output and oscillator (size 2)", () => {
    expect(registry.size).toBe(2);
    expect(registry.has("audio-output")).toBe(true);
    expect(registry.has("oscillator")).toBe(true);
  });

  it("entry matches seed jack and control names in seed order", () => {
    const entry = registry.get("oscillator")!;
    expect(entry.inJacks).toEqual(["1V/Oct", "FM", "EFM", "Sync", "PWM"]);
    expect(entry.outJacks).toEqual(["Saw", "Pulse", "Tri", "Sine", "Sub"]);
    expect(Object.keys(entry.params)).toEqual(["Tune", "Fine", "FM Amt", "EFM Amt", "PW"]);
  });

  it("param specs match the issue mapping", () => {
    const p = registry.get("oscillator")!.params;
    expect(p["Tune"]).toEqual({ min: -2, max: 2, default: 0, curve: "linear" });
    expect(p["Fine"]).toEqual({ min: -1 / 12, max: 1 / 12, default: 0, curve: "linear" });
    expect(p["FM Amt"]).toEqual({ min: -1, max: 1, default: 0, curve: "linear" });
    expect(p["EFM Amt"]).toEqual({ min: -1, max: 1, default: 0, curve: "linear" });
    expect(p["PW"]).toEqual({ min: 0.05, max: 0.95, default: 0.5, curve: "linear" });
  });

  it("entry uses the canonical oscillatorKernel and is not an audio output", () => {
    const entry = registry.get("oscillator")!;
    expect(entry.kernel).toBe(oscillatorKernel);
    expect(entry.audioOutput).toBeUndefined();
  });

  it("isPlayable('oscillator') is true", () => {
    expect(isPlayable("oscillator")).toBe(true);
  });
});

// ── 2. Basic pitch law ────────────────────────────────────────────────────────

describe("pitch law (1 V/oct)", () => {
  it("0 V pitch at default params renders ≈ C4", () => {
    const sine = renderSine(SR, defaultParams());
    expect(estimateHz(sine)).toBeCloseTo(C4_HZ, 0);
  });

  it("+1 V on 1V/Oct doubles the frequency", () => {
    const sine = renderSine(SR, defaultParams(), [constBuf(SR, 1), null, null, null, null]);
    expect(estimateHz(sine)).toBeCloseTo(2 * C4_HZ, 0);
  });

  it("−1 V on 1V/Oct halves the frequency", () => {
    const sine = renderSine(SR, defaultParams(), [constBuf(SR, -1), null, null, null, null]);
    expect(estimateHz(sine)).toBeCloseTo(C4_HZ / 2, 0);
  });

  it("renders ≈ C4 end-to-end through the Interpreter and audio-output", () => {
    const graph: EngineGraph = {
      nodes: [
        { instanceId: "osc", slug: "oscillator", params: [0, 0, 0, 0, 0.5] },
        { instanceId: "ao", slug: "audio-output", params: [1.0] },
      ],
      edges: [{ from: [0, 3], to: [1, 0], feedback: false }], // Sine → L In
      outputNodes: [1],
    };
    const interp = new Interpreter(graph, registry, SR);
    const blocks = Math.ceil(SR / BLOCK_FRAMES);
    const left = new Float32Array(blocks * BLOCK_FRAMES);
    const l = new Float32Array(BLOCK_FRAMES);
    const r = new Float32Array(BLOCK_FRAMES);
    for (let b = 0; b < blocks; b++) {
      interp.runBlock(BLOCK_FRAMES);
      interp.readOutput(l, r, BLOCK_FRAMES);
      left.set(l, b * BLOCK_FRAMES);
    }
    expect(estimateHz(left)).toBeCloseTo(C4_HZ, 0);
  });
});

// ── 3. Tune and Fine ─────────────────────────────────────────────────────────

describe("Tune and Fine", () => {
  it("Tune +1 raises one octave", () => {
    const params = defaultParams();
    params[0] = 1;
    expect(estimateHz(renderSine(SR, params))).toBeCloseTo(2 * C4_HZ, 0);
  });

  it("Fine +1/12 raises one semitone", () => {
    const params = defaultParams();
    params[1] = 1 / 12;
    expect(estimateHz(renderSine(SR, params))).toBeCloseTo(C4_HZ * Math.pow(2, 1 / 12), 0);
  });
});

// ── 4. Linear FM ─────────────────────────────────────────────────────────────

describe("linear FM", () => {
  it("FM Amt = 0 → FM input has exactly no effect", () => {
    const modulated = renderSine(SR, defaultParams(), [
      null,
      sineBuf(SR, 220, 5),
      null,
      null,
      null,
    ]);
    const dry = renderSine(SR, defaultParams());
    expect(modulated).toEqual(dry);
  });

  it("constant +1 V FM at full FM Amt adds LINEAR_FM_HZ_PER_VOLT Hz", () => {
    const params = defaultParams();
    params[2] = 1; // FM Amt
    const sine = renderSine(SR, params, [null, constBuf(SR, 1), null, null, null]);
    expect(estimateHz(sine)).toBeCloseTo(C4_HZ + LINEAR_FM_HZ_PER_VOLT, 0);
  });

  it("low-rate FM makes the estimated frequency vary over time", () => {
    // 2 Hz sine at ±2 V, FM Amt 1 → instantaneous frequency sweeps
    // C4 ± 2·LINEAR_FM_HZ_PER_VOLT. Windowed estimates must spread well
    // beyond both sides of the carrier.
    const params = defaultParams();
    params[2] = 1;
    const sine = renderSine(SR, params, [null, sineBuf(SR, 2, 2), null, null, null]);
    const win = Math.floor(SR / 20); // 50 ms windows
    let minHz = Infinity;
    let maxHz = 0;
    for (let start = 0; start + win <= sine.length; start += win) {
      const hz = estimateHz(sine.subarray(start, start + win));
      minHz = Math.min(minHz, hz);
      maxHz = Math.max(maxHz, hz);
    }
    expect(maxHz).toBeGreaterThan(C4_HZ + LINEAR_FM_HZ_PER_VOLT);
    expect(minHz).toBeLessThan(C4_HZ - LINEAR_FM_HZ_PER_VOLT);
  });

  it("audio-rate FM produces sideband energy at fc + fm", () => {
    // 220 Hz sine at ±5 V, FM Amt 0.4 → ±200 Hz deviation (no clamp at 0 Hz).
    // Linear FM of a sine carrier puts sidebands at fc ± k·fm; fc + fm is not
    // a harmonic of either source, so its energy comes only from modulation.
    const params = defaultParams();
    params[2] = 0.4;
    const modulated = renderSine(SR, params, [null, sineBuf(SR, 220, 5), null, null, null]);
    const dry = renderSine(SR, defaultParams());

    const sidebandHz = C4_HZ + 220;
    const modPower = goertzelPower(modulated, sidebandHz);
    const dryPower = goertzelPower(dry, sidebandHz);
    expect(modPower).toBeGreaterThan(dryPower * 10);

    // And the waveform itself is measurably different from the dry render.
    let diff = 0;
    for (let i = 0; i < dry.length; i++) diff += (modulated[i] - dry[i]) ** 2;
    expect(Math.sqrt(diff / dry.length)).toBeGreaterThan(1); // volts RMS
  });
});

// ── 5. Exponential FM ────────────────────────────────────────────────────────

describe("exponential FM", () => {
  it("EFM Amt = 0 → EFM input has exactly no effect", () => {
    const modulated = renderSine(SR, defaultParams(), [
      null,
      null,
      sineBuf(SR, 220, 5),
      null,
      null,
    ]);
    const dry = renderSine(SR, defaultParams());
    expect(modulated).toEqual(dry);
  });

  it("static EFM volts shift pitch by equal ratios up and down", () => {
    // +2 V × EFM Amt 0.5 = +1 octave into the exponent; −2 V = −1 octave.
    const params = defaultParams();
    params[3] = 0.5; // EFM Amt
    const up = renderSine(SR, params, [null, null, constBuf(SR, 2), null, null]);
    const down = renderSine(SR, params, [null, null, constBuf(SR, -2), null, null]);
    expect(estimateHz(up)).toBeCloseTo(2 * C4_HZ, 0);
    expect(estimateHz(down)).toBeCloseTo(C4_HZ / 2, 0);
  });

  it("negative EFM Amt inverts the modulation direction", () => {
    const params = defaultParams();
    params[3] = -0.5;
    const sine = renderSine(SR, params, [null, null, constBuf(SR, 2), null, null]);
    expect(estimateHz(sine)).toBeCloseTo(C4_HZ / 2, 0);
  });

  it("audio-rate EFM produces a measurably different, spectrally spread waveform", () => {
    // 220 Hz at ±5 V, EFM Amt 0.4 → pitch swings ±2 octaves at audio rate.
    // The carrier bin collapses as energy smears into modulation products.
    const params = defaultParams();
    params[3] = 0.4;
    const modulated = renderSine(SR, params, [null, null, sineBuf(SR, 220, 5), null, null]);
    const dry = renderSine(SR, defaultParams());

    expect(goertzelPower(modulated, C4_HZ)).toBeLessThan(0.5 * goertzelPower(dry, C4_HZ));

    let diff = 0;
    for (let i = 0; i < dry.length; i++) diff += (modulated[i] - dry[i]) ** 2;
    expect(Math.sqrt(diff / dry.length)).toBeGreaterThan(1); // volts RMS
  });
});

// ── 6. Two-oscillator patches through the Interpreter (AP-7 milestone) ───────

describe("two-oscillator FM/EFM through the Interpreter", () => {
  // osc A Sine → osc B (FM or EFM in-slot) → Sine → audio-output L In.
  function renderTwoOsc(inSlot: number | null, amtSlot: number, amt: number): Float32Array {
    const oscBParams = [0, 0, 0, 0, 0.5];
    oscBParams[amtSlot] = amt;
    const graph: EngineGraph = {
      nodes: [
        // osc A tuned −2 octaves (≈65.4 Hz) so the modulator is slow-ish audio.
        { instanceId: "oscA", slug: "oscillator", params: [-2, 0, 0, 0, 0.5] },
        { instanceId: "oscB", slug: "oscillator", params: oscBParams },
        { instanceId: "ao", slug: "audio-output", params: [1.0] },
      ],
      edges: [
        ...(inSlot === null
          ? []
          : [{ from: [0, 3] as [number, number], to: [1, inSlot] as [number, number], feedback: false }]),
        { from: [1, 3], to: [2, 0], feedback: false }, // B Sine → L In
      ],
      outputNodes: [2],
    };
    const interp = new Interpreter(graph, registry, SR);
    const blocks = Math.ceil(SR / BLOCK_FRAMES);
    const left = new Float32Array(blocks * BLOCK_FRAMES);
    const l = new Float32Array(BLOCK_FRAMES);
    const r = new Float32Array(BLOCK_FRAMES);
    for (let b = 0; b < blocks; b++) {
      interp.runBlock(BLOCK_FRAMES);
      interp.readOutput(l, r, BLOCK_FRAMES);
      left.set(l, b * BLOCK_FRAMES);
    }
    return left;
  }

  it("osc A Sine → osc B FM audibly modulates B", () => {
    const dry = renderTwoOsc(null, 2, 1);
    const modulated = renderTwoOsc(1, 2, 1); // FM in-slot, FM Amt = 1
    let diff = 0;
    for (let i = 0; i < dry.length; i++) diff += (modulated[i] - dry[i]) ** 2;
    expect(Math.sqrt(diff / dry.length)).toBeGreaterThan(0.05); // DAC floats
  });

  it("osc A Sine → osc B EFM audibly modulates B", () => {
    const dry = renderTwoOsc(null, 3, 0.5);
    const modulated = renderTwoOsc(2, 3, 0.5); // EFM in-slot, EFM Amt = 0.5
    let diff = 0;
    for (let i = 0; i < dry.length; i++) diff += (modulated[i] - dry[i]) ** 2;
    expect(Math.sqrt(diff / dry.length)).toBeGreaterThan(0.05); // DAC floats
  });
});

// ── 7. Clamping and safety ────────────────────────────────────────────────────

function expectAllFinite(buf: Float32Array): void {
  let finite = true;
  for (let i = 0; i < buf.length; i++) {
    if (!Number.isFinite(buf[i])) {
      finite = false;
      break;
    }
  }
  expect(finite).toBe(true);
}

describe("clamping and safety", () => {
  it("very high pitch clamps to ≤ sr × 0.45", () => {
    const params = defaultParams();
    params[0] = 10; // way past the Tune spec range, passed directly
    const sine = renderSine(SR, params);
    expectAllFinite(sine);
    const hz = estimateHz(sine);
    expect(hz).toBeLessThanOrEqual(SR * 0.45 * 1.01);
    expect(hz).toBeGreaterThan(SR * 0.4);
  });

  it("negative linear FM cannot make frequency negative — phase freezes at 0 Hz", () => {
    const params = defaultParams();
    params[2] = 1;
    const sine = renderSine(SR, params, [null, constBuf(SR, -10), null, null, null]);
    expectAllFinite(sine);
    expect(estimateHz(sine)).toBe(0); // no oscillation
    // Frozen phase → constant output.
    for (let i = 1; i < BLOCK_FRAMES; i++) {
      expect(sine[sine.length - i]).toBe(sine[sine.length - 1]);
    }
  });

  it("non-finite params fall back to safe defaults (≈ C4, no NaN)", () => {
    const params = new Float32Array([NaN, Infinity, NaN, -Infinity, NaN]);
    const sine = renderSine(SR, params);
    expectAllFinite(sine);
    expect(estimateHz(sine)).toBeCloseTo(C4_HZ, 0);
  });

  it("non-finite input samples do not poison the output", () => {
    const badPitch = constBuf(SR, 0);
    badPitch[100] = NaN;
    badPitch[200] = Infinity;
    badPitch[300] = -Infinity;
    const sine = renderSine(SR, defaultParams(), [badPitch, null, null, null, null]);
    expectAllFinite(sine);
    // Recovers to C4 after the bad samples pass.
    expect(estimateHz(sine.subarray(SR / 2))).toBeCloseTo(C4_HZ, 0);
  });

  it("setParam clamps Tune to the spec range through the Interpreter", () => {
    const graph: EngineGraph = {
      nodes: [
        { instanceId: "osc", slug: "oscillator", params: [0, 0, 0, 0, 0.5] },
        { instanceId: "ao", slug: "audio-output", params: [1.0] },
      ],
      edges: [{ from: [0, 3], to: [1, 0], feedback: false }],
      outputNodes: [1],
    };
    const interp = new Interpreter(graph, registry, SR);
    interp.setParam("osc", "Tune", 100); // clamps to +2 octaves
    const l = new Float32Array(BLOCK_FRAMES);
    const r = new Float32Array(BLOCK_FRAMES);
    // Half a second for the one-pole smoother to settle (~10 ms constant).
    const settleBlocks = Math.ceil(SR / 2 / BLOCK_FRAMES);
    for (let b = 0; b < settleBlocks; b++) {
      interp.runBlock(BLOCK_FRAMES);
      interp.readOutput(l, r, BLOCK_FRAMES);
    }
    const blocks = Math.ceil(SR / BLOCK_FRAMES);
    const left = new Float32Array(blocks * BLOCK_FRAMES);
    for (let b = 0; b < blocks; b++) {
      interp.runBlock(BLOCK_FRAMES);
      interp.readOutput(l, r, BLOCK_FRAMES);
      left.set(l, b * BLOCK_FRAMES);
    }
    expect(estimateHz(left)).toBeCloseTo(4 * C4_HZ, 0);
  });
});

// ── 8. Unpatched inputs and output writing ────────────────────────────────────

describe("unpatched inputs and output writing", () => {
  it("all inputs unpatched behaves as 0 V and does not crash", () => {
    const sine = renderSine(SR, defaultParams());
    expectAllFinite(sine);
    expect(estimateHz(sine)).toBeCloseTo(C4_HZ, 0);
  });

  it("every declared output buffer is written every block", () => {
    const state = oscillatorKernel.init(SR);
    const sentinel = 123;
    const outs = [0, 1, 2, 3, 4].map(() => new Float32Array(BLOCK_FRAMES).fill(sentinel));
    oscillatorKernel.process(
      state,
      [null, null, null, null, null],
      outs,
      defaultParams(),
      BLOCK_FRAMES,
    );
    for (const out of outs) {
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        expect(out[i]).not.toBe(sentinel);
      }
    }
  });

  it("deferred waves (Saw, Pulse, Tri, Sub) are explicit silence", () => {
    const state = oscillatorKernel.init(SR);
    const outs = [0, 1, 2, 3, 4].map(() => new Float32Array(BLOCK_FRAMES).fill(1));
    oscillatorKernel.process(
      state,
      [null, null, null, null, null],
      outs,
      defaultParams(),
      BLOCK_FRAMES,
    );
    const silence = new Float32Array(BLOCK_FRAMES);
    expect(outs[0]).toEqual(silence); // Saw
    expect(outs[1]).toEqual(silence); // Pulse
    expect(outs[2]).toEqual(silence); // Tri
    expect(outs[4]).toEqual(silence); // Sub
    // Sine is live.
    let sineEnergy = 0;
    for (let i = 0; i < BLOCK_FRAMES; i++) sineEnergy += outs[3][i] * outs[3][i];
    expect(sineEnergy).toBeGreaterThan(0);
  });
});
