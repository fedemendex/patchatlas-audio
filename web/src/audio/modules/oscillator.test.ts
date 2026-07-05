// @vitest-environment node
// (Pure engine logic; no DOM needed and jsdom breaks import.meta.url resolves.)

import { describe, it, expect } from "vitest";
import { oscillatorKernel } from "./oscillator";
import { registry, isPlayable } from "./registry";
import { Interpreter } from "../engine/interpreter";
import { AUDIO_NORM, BLOCK_FRAMES, C4_HZ, GATE_HIGH_V, LINEAR_FM_HZ_PER_VOLT } from "../engine/units";
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
// buffer for output slot `outIndex`. `insFull` are per-input full-length
// buffers (or null = unpatched), sliced per block via subarray.
// Output slots: 0 Saw, 1 Pulse, 2 Tri, 3 Sine, 4 Sub.
function renderOut(
  outIndex: number,
  totalSamples: number,
  params: Float32Array,
  insFull: (Float32Array | null)[] = [null, null, null, null, null],
): Float32Array {
  const state = oscillatorKernel.init(SR);
  const outs = [0, 1, 2, 3, 4].map(() => new Float32Array(BLOCK_FRAMES));
  const result = new Float32Array(totalSamples);
  for (let offset = 0; offset < totalSamples; offset += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, totalSamples - offset);
    const ins = insFull.map((b) => (b ? b.subarray(offset, offset + n) : null));
    oscillatorKernel.process(state, ins, outs, params, n);
    result.set(outs[outIndex].subarray(0, n), offset);
  }
  return result;
}

// The Sine output (slot 3) — the reference wave most tests measure.
function renderSine(
  totalSamples: number,
  params: Float32Array,
  insFull: (Float32Array | null)[] = [null, null, null, null, null],
): Float32Array {
  return renderOut(3, totalSamples, params, insFull);
}

// Peak absolute value across a buffer.
function maxAbs(buf: Float32Array): number {
  let m = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > m) m = a;
  }
  return m;
}

// Fraction of samples strictly above 0 V — a pulse's measured duty cycle.
function dutyCycle(buf: Float32Array): number {
  let high = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0) high++;
  return high / buf.length;
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
  it("production registry contains audio-output and oscillator", () => {
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

  it("every declared output carries signal at default params (no silent waves)", () => {
    // A full second so even the Sub (one octave down) completes many cycles.
    for (const outIndex of [0, 1, 2, 3, 4]) {
      const buf = renderOut(outIndex, SR, defaultParams());
      expect(maxAbs(buf)).toBeGreaterThan(1); // volts — clearly non-silent
    }
  });
});

// ── 9. Waveform outputs (Saw, Pulse, Tri, Sub) ────────────────────────────────

// Output slots: 0 Saw, 1 Pulse, 2 Tri, 3 Sine, 4 Sub. A band-limited wave may
// overshoot ±AUDIO_NORM slightly at edges; ±3·AUDIO_NORM is a generous ceiling
// that still catches a runaway.
const SAW = 0;
const PULSE = 1;
const TRI = 2;
const SUB = 4;

describe("waveform outputs", () => {
  it("Saw is non-silent, bounded, finite, and runs at the pitch frequency", () => {
    const saw = renderOut(SAW, SR, defaultParams());
    expectAllFinite(saw);
    expect(maxAbs(saw)).toBeGreaterThan(AUDIO_NORM * 0.5);
    expect(maxAbs(saw)).toBeLessThan(AUDIO_NORM * 3);
    expect(estimateHz(saw)).toBeCloseTo(C4_HZ, 0); // one up-crossing per cycle
  });

  it("Pulse is non-silent, bounded, finite, and runs at the pitch frequency", () => {
    const pulse = renderOut(PULSE, SR, defaultParams());
    expectAllFinite(pulse);
    expect(maxAbs(pulse)).toBeGreaterThan(AUDIO_NORM * 0.5);
    expect(maxAbs(pulse)).toBeLessThan(AUDIO_NORM * 3);
    expect(estimateHz(pulse)).toBeCloseTo(C4_HZ, 0);
  });

  it("Tri is non-silent, bounded, finite, and runs at the pitch frequency", () => {
    const tri = renderOut(TRI, SR, defaultParams());
    expectAllFinite(tri);
    expect(maxAbs(tri)).toBeGreaterThan(AUDIO_NORM * 0.5);
    expect(maxAbs(tri)).toBeLessThan(AUDIO_NORM * 1.5);
    expect(estimateHz(tri)).toBeCloseTo(C4_HZ, 0);
  });

  it("Sub is non-silent, bounded, finite, and runs one octave below the oscillator", () => {
    const sub = renderOut(SUB, SR, defaultParams());
    expectAllFinite(sub);
    expect(maxAbs(sub)).toBeGreaterThan(AUDIO_NORM * 0.5);
    expect(maxAbs(sub)).toBeLessThan(AUDIO_NORM * 3);
    // Half the main frequency, within a tight band around C4/2.
    const subHz = estimateHz(sub);
    expect(subHz).toBeGreaterThan((C4_HZ / 2) * 0.98);
    expect(subHz).toBeLessThan((C4_HZ / 2) * 1.02);
  });

  it("Sub tracks the oscillator: at +1 octave it is still exactly half", () => {
    const params = defaultParams();
    params[0] = 1; // Tune +1 octave → main 2·C4, Sub should be ≈ C4
    const sub = renderOut(SUB, SR, params);
    expect(estimateHz(sub)).toBeCloseTo(C4_HZ, 0);
  });
});

// ── 10. Pulse width and PWM ───────────────────────────────────────────────────

describe("pulse width and PWM", () => {
  it("PW controls the duty cycle", () => {
    const narrow = defaultParams();
    narrow[4] = 0.25;
    const wide = defaultParams();
    wide[4] = 0.75;
    expect(dutyCycle(renderOut(PULSE, SR, narrow))).toBeCloseTo(0.25, 1);
    expect(dutyCycle(renderOut(PULSE, SR, wide))).toBeCloseTo(0.75, 1);
  });

  it("PWM input modulates the duty cycle around PW", () => {
    // PW 0.5, PWM ±2.5 V → duty PW ± 0.25 (2.5 / (2·CV_BIPOLAR_MAX=10)).
    const base = dutyCycle(renderOut(PULSE, SR, defaultParams()));
    const up = dutyCycle(renderOut(PULSE, SR, defaultParams(), [null, null, null, null, constBuf(SR, 2.5)]));
    const down = dutyCycle(renderOut(PULSE, SR, defaultParams(), [null, null, null, null, constBuf(SR, -2.5)]));
    expect(base).toBeCloseTo(0.5, 1);
    expect(up).toBeCloseTo(0.75, 1);
    expect(down).toBeCloseTo(0.25, 1);
    expect(up).toBeGreaterThan(base);
    expect(down).toBeLessThan(base);
  });

  it("unpatched PWM leaves only the PW knob in effect", () => {
    const p = defaultParams();
    p[4] = 0.3;
    const noPwm = dutyCycle(renderOut(PULSE, SR, p));
    const nullPwm = dutyCycle(renderOut(PULSE, SR, p, [null, null, null, null, null]));
    expect(noPwm).toBeCloseTo(0.3, 1);
    expect(nullPwm).toBe(noPwm);
  });

  it("PW (and PWM excursions) clamp safely to 0.05..0.95", () => {
    const tooHigh = defaultParams();
    tooHigh[4] = 2; // past the spec max, passed directly
    const tooLow = defaultParams();
    tooLow[4] = -1; // past the spec min
    const hi = renderOut(PULSE, SR, tooHigh);
    const lo = renderOut(PULSE, SR, tooLow);
    expectAllFinite(hi);
    expectAllFinite(lo);
    expect(dutyCycle(hi)).toBeCloseTo(0.95, 1);
    expect(dutyCycle(lo)).toBeCloseTo(0.05, 1);

    // PWM that would drive duty far out of range is also clamped, not wrapped.
    const clampedByPwm = renderOut(PULSE, SR, defaultParams(), [null, null, null, null, constBuf(SR, 50)]);
    expectAllFinite(clampedByPwm);
    expect(dutyCycle(clampedByPwm)).toBeCloseTo(0.95, 1);
  });

  it("non-finite PW and PWM samples never produce NaN/Inf", () => {
    const params = defaultParams();
    params[4] = NaN; // PW falls back to 0.5
    const badPwm = constBuf(SR, 0);
    badPwm[100] = NaN;
    badPwm[200] = Infinity;
    badPwm[300] = -Infinity;
    const pulse = renderOut(PULSE, SR, params, [null, null, null, null, badPwm]);
    expectAllFinite(pulse);
    expect(dutyCycle(pulse)).toBeCloseTo(0.5, 1); // default PW, bad samples read 0 V
  });
});

// ── 11. Hard sync ─────────────────────────────────────────────────────────────

describe("hard sync", () => {
  // A rising edge on Sync (slot 3) resets phase to 0 *before* the edge sample
  // is written. With default params (no modulation) the increment is constant,
  // so after a reset at index E the Sine reads sin(2π · j · inc) for j ≥ 0.
  const INC = C4_HZ / SR;

  it("a rising edge resets phase deterministically (reset-before-write)", () => {
    const E = 500;
    const sync = new Float32Array(SR); // low everywhere…
    for (let i = E; i < E + 50; i++) sync[i] = GATE_HIGH_V; // …a high plateau from E
    const sine = renderSine(SR, defaultParams(), [null, null, null, sync, null]);
    expectAllFinite(sine);
    // The reset sample reads phase 0, then the wave restarts cleanly from there.
    for (let j = 0; j < 20; j++) {
      expect(sine[E + j]).toBeCloseTo(Math.sin(2 * Math.PI * j * INC) * AUDIO_NORM, 3);
    }
  });

  it("a sustained high does not retrigger until the input re-arms", () => {
    const E = 500;
    const sync = new Float32Array(SR);
    for (let i = E; i < SR; i++) sync[i] = GATE_HIGH_V; // high for the rest of the render
    const sine = renderSine(SR, defaultParams(), [null, null, null, sync, null]);
    // If it re-reset every high sample the phase would be pinned and the tail
    // would be silent; instead it free-runs at C4 after the single reset.
    const tail = sine.subarray(E + BLOCK_FRAMES);
    expect(maxAbs(tail)).toBeGreaterThan(AUDIO_NORM * 0.5);
    expect(estimateHz(tail)).toBeCloseTo(C4_HZ, 0);
  });

  it("re-arms after going low, so a second rising edge resets again", () => {
    const E1 = 300;
    const E2 = 900;
    const sync = new Float32Array(SR);
    for (let i = E1; i < E1 + 20; i++) sync[i] = GATE_HIGH_V;
    // Gap (low) between the two pulses lets the Schmitt trigger re-arm.
    for (let i = E2; i < E2 + 20; i++) sync[i] = GATE_HIGH_V;
    const sine = renderSine(SR, defaultParams(), [null, null, null, sync, null]);
    // Both edges restart the wave from phase 0.
    for (let j = 0; j < 10; j++) {
      expect(sine[E1 + j]).toBeCloseTo(Math.sin(2 * Math.PI * j * INC) * AUDIO_NORM, 3);
      expect(sine[E2 + j]).toBeCloseTo(Math.sin(2 * Math.PI * j * INC) * AUDIO_NORM, 3);
    }
  });

  it("unpatched Sync leaves the free-running wave untouched", () => {
    const withNull = renderSine(SR, defaultParams(), [null, null, null, null, null]);
    const plain = renderSine(SR, defaultParams());
    expect(withNull).toEqual(plain);
  });
});
