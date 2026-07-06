// @vitest-environment node

import { describe, it, expect } from "vitest";
import { reverbKernel } from "./reverb";
import { registry } from "./registry";
import { REVERB_PRESET_VISIBLE } from "./reverbPresets";
import { AUDIO_NORM, BLOCK_FRAMES } from "../engine/units";

const SR = 48000;

// Param slot order (registry declaration order — the kernel indexes positionally).
const P_PRESET = 0;
const P_PRE_DELAY = 1;
const P_SIZE = 2;
const P_DECAY = 3;
const P_DAMP = 4;
const P_MIX = 5;
const PARAM_COUNT = 6;

const PRESET_ROOM = 0;
const PRESET_HALL = 1;
const PRESET_PLATE = 2;

// Room defaults (= the registry defaults; see reverbPresets.test.ts).
function roomParams(): Float32Array {
  const p = new Float32Array(PARAM_COUNT);
  p[P_PRESET] = PRESET_ROOM;
  p[P_PRE_DELAY] = 0.032;
  p[P_SIZE] = 1;
  p[P_DECAY] = 0.32;
  p[P_DAMP] = 0.64;
  p[P_MIX] = 0.25;
  return p;
}

/** Params fully expanded from a preset's visible values (engine units). */
function presetParams(preset: number): Float32Array {
  const p = new Float32Array(PARAM_COUNT);
  const v = REVERB_PRESET_VISIBLE[preset];
  p[P_PRESET] = preset;
  p[P_PRE_DELAY] = v.PreDelay;
  p[P_SIZE] = v.Size;
  p[P_DECAY] = v.Decay;
  p[P_DAMP] = v.Damp;
  p[P_MIX] = v.Mix;
  return p;
}

/**
 * Renders `totalSamples` of stereo output in BLOCK_FRAMES chunks from
 * per-sample L/R volt scripts, starting from a fresh kernel state. Omitting
 * `inLAt`/`inRAt` passes a genuine null jack (truly unpatched). Params are
 * per-block constants (the interpreter's smoothing is upstream of kernels).
 */
function render(opts: {
  sr?: number;
  totalSamples: number;
  params: Float32Array;
  inLAt?: (sample: number) => number;
  inRAt?: (sample: number) => number;
  decayCvAt?: (sample: number) => number;
}): { L: Float32Array; R: Float32Array } {
  const sr = opts.sr ?? SR;
  const state = reverbKernel.init(sr);
  const inL = opts.inLAt ? new Float32Array(BLOCK_FRAMES) : null;
  const inR = opts.inRAt ? new Float32Array(BLOCK_FRAMES) : null;
  const cv = opts.decayCvAt ? new Float32Array(BLOCK_FRAMES) : null;
  const outs = [new Float32Array(BLOCK_FRAMES), new Float32Array(BLOCK_FRAMES)];
  const L = new Float32Array(opts.totalSamples);
  const R = new Float32Array(opts.totalSamples);

  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      if (inL) inL[i] = opts.inLAt!(start + i);
      if (inR) inR[i] = opts.inRAt!(start + i);
      if (cv) cv[i] = opts.decayCvAt!(start + i);
    }
    reverbKernel.process(state, [inL, inR, cv], outs, opts.params, n);
    L.set(outs[0].subarray(0, n), start);
    R.set(outs[1].subarray(0, n), start);
  }
  return { L, R };
}

const impulseAt0 = (i: number): number => (i === 0 ? AUDIO_NORM : 0);

function rms(buf: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / (end - start));
}

function sumAbs(buf: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += Math.abs(buf[i]);
  return sum;
}

/** High-frequency share of a window: first-difference energy over energy. */
function hfShare(buf: Float32Array, start: number, end: number): number {
  let diff = 0;
  let energy = 0;
  for (let i = start + 1; i < end; i++) {
    const d = buf[i] - buf[i - 1];
    diff += d * d;
    energy += buf[i] * buf[i];
  }
  return energy === 0 ? 0 : diff / energy;
}

function expectAllFinite(buf: Float32Array): void {
  for (let i = 0; i < buf.length; i++) {
    if (!Number.isFinite(buf[i])) {
      throw new Error(`non-finite sample ${buf[i]} at index ${i}`);
    }
  }
}

describe("seed confirmation", () => {
  it("registry entry matches the seeded reverb jack/control names", () => {
    const entry = registry.get("reverb");
    expect(entry?.inJacks).toEqual(["In L", "In R", "Time CV"]);
    expect(entry?.outJacks).toEqual(["Out L", "Out R"]);
    expect(Object.keys(entry?.params ?? {})).toEqual([
      "Preset",
      "PreDelay",
      "Size",
      "Decay",
      "Damp",
      "Mix",
    ]);
  });
});

describe("dry/wet mix", () => {
  it("mix = 0 returns the dry input bit-exactly", () => {
    const params = roomParams();
    params[P_MIX] = 0;
    const script = (i: number): number => Math.sin(i * 0.1) * 2;
    const { L, R } = render({ totalSamples: SR / 2, params, inLAt: script, inRAt: script });
    for (let i = 0; i < L.length; i++) {
      expect(L[i]).toBe(Math.fround(script(i)));
      expect(R[i]).toBe(Math.fround(script(i)));
    }
  });

  it("an impulse with mix > 0 produces a wet tail well after the impulse", () => {
    const { L, R } = render({
      totalSamples: SR,
      params: roomParams(),
      inLAt: impulseAt0,
      inRAt: impulseAt0,
    });
    // Dry is a single sample at t=0; anything at 0.3..0.5 s is reverb tail.
    expect(rms(L, 0.3 * SR, 0.5 * SR)).toBeGreaterThan(1e-5);
    expect(rms(R, 0.3 * SR, 0.5 * SR)).toBeGreaterThan(1e-5);
  });
});

describe("stereo shape", () => {
  it("mono input (In R unpatched) produces valid, decorrelated stereo output", () => {
    const params = roomParams();
    params[P_MIX] = 1;
    const { L, R } = render({ totalSamples: SR, params, inLAt: impulseAt0 });
    expectAllFinite(L);
    expectAllFinite(R);
    expect(rms(L, 0, SR)).toBeGreaterThan(0);
    expect(rms(R, 0, SR)).toBeGreaterThan(0);
    // The output taps are decorrelated — the two channels must not be equal.
    let maxDiff = 0;
    for (let i = 0; i < L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(L[i] - R[i]));
    expect(maxDiff).toBeGreaterThan(1e-4);
  });

  it("stereo input produces valid stereo output", () => {
    const { L, R } = render({
      totalSamples: SR / 2,
      params: roomParams(),
      inLAt: (i) => Math.sin(i * 0.05),
      inRAt: (i) => Math.cos(i * 0.07),
    });
    expectAllFinite(L);
    expectAllFinite(R);
    expect(rms(L, 0, SR / 2)).toBeGreaterThan(0);
    expect(rms(R, 0, SR / 2)).toBeGreaterThan(0);
  });

  it("plate is mono-fed: a hard-left input still yields balanced stereo reverb", () => {
    const params = presetParams(PRESET_PLATE);
    params[P_MIX] = 1; // wet only, so channel balance measures the tank alone
    const { L, R } = render({
      totalSamples: SR,
      params,
      inLAt: impulseAt0,
      inRAt: () => 0, // hard left: R patched at silence, so no mono-normalling
    });
    const eL = rms(L, 0, SR);
    const eR = rms(R, 0, SR);
    expect(eL).toBeGreaterThan(0);
    expect(eR).toBeGreaterThan(0);
    // Mono-fed tank: both wet channels carry comparable energy...
    expect(eL / eR).toBeGreaterThan(1 / 3);
    expect(eL / eR).toBeLessThan(3);
    // ...but the output is still stereo, not dual mono.
    let maxDiff = 0;
    for (let i = 0; i < L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(L[i] - R[i]));
    expect(maxDiff).toBeGreaterThan(1e-4);
  });
});

// GH #83 revision: Room and Hall are STEREO-FED (L → first tank loop, R →
// second); only Plate mono-sums the wet input (0.5·(L+R), upstream's model).
// The discriminating assertion: if a preset mono-summed, a hard-left impulse
// would be indistinguishable from the same energy centered (L = R = imp/2) —
// so those two renders must DIFFER for Room/Hall and be IDENTICAL for Plate.
describe("per-preset input feed (stereo-fed Room/Hall, mono-fed Plate)", () => {
  const silence = (): number => 0;
  const halfImpulse = (i: number): number => (i === 0 ? AUDIO_NORM / 2 : 0);

  function wetOnly(preset: number, inLAt: (i: number) => number, inRAt: (i: number) => number) {
    const params = presetParams(preset);
    params[P_MIX] = 1; // wet only: the dry path is stereo in every mode and
    // would mask the tank-feed distinction under test
    return render({ totalSamples: SR / 2, params, inLAt, inRAt });
  }

  // Normalized L2 distance between two renders, over both channels.
  function distance(
    a: { L: Float32Array; R: Float32Array },
    b: { L: Float32Array; R: Float32Array },
  ): number {
    let diff = 0;
    let ref = 0;
    for (let i = 0; i < a.L.length; i++) {
      diff += (a.L[i] - b.L[i]) ** 2 + (a.R[i] - b.R[i]) ** 2;
      ref += a.L[i] ** 2 + a.R[i] ** 2;
    }
    return diff / ref;
  }

  it.each([
    ["room", PRESET_ROOM],
    ["hall", PRESET_HALL],
  ])("%s does not mono-sum: hard-left ≠ the same energy centered", (_n, preset) => {
    const hardLeft = wetOnly(preset, impulseAt0, silence);
    const centered = wetOnly(preset, halfImpulse, halfImpulse);
    // A mono-summing feed would make these bit-identical (0.5·(imp+0) ==
    // 0.5·(imp/2+imp/2)); the stereo feed must separate them decisively.
    expect(distance(hardLeft, centered)).toBeGreaterThan(0.1);
  });

  it("plate DOES mono-sum: hard-left and the same energy centered render identical wet output", () => {
    const hardLeft = wetOnly(PRESET_PLATE, impulseAt0, silence);
    const centered = wetOnly(PRESET_PLATE, halfImpulse, halfImpulse);
    for (let i = 0; i < hardLeft.L.length; i++) {
      expect(hardLeft.L[i]).toBe(centered.L[i]);
      expect(hardLeft.R[i]).toBe(centered.R[i]);
    }
  });

  it.each([
    ["room", PRESET_ROOM],
    ["hall", PRESET_HALL],
  ])("%s: a hard-left impulse excites the tank differently than a hard-right impulse", (_n, preset) => {
    const left = wetOnly(preset, impulseAt0, silence);
    const right = wetOnly(preset, silence, impulseAt0);
    // Different injection points (first vs second tank loop) — the wet
    // responses must differ, not merely mirror each other.
    expect(distance(left, right)).toBeGreaterThan(0.1);
    // The panned input still reaches BOTH output channels (cross-coupled
    // tank), and each side's render is finite, non-silent stereo.
    for (const r of [left, right]) {
      expectAllFinite(r.L);
      expectAllFinite(r.R);
      expect(rms(r.L, 0, r.L.length)).toBeGreaterThan(0);
      expect(rms(r.R, 0, r.R.length)).toBeGreaterThan(0);
    }
  });

  it("stereo-fed room stays bounded under sustained hard-panned input at max Decay", () => {
    const params = presetParams(PRESET_ROOM);
    params[P_DECAY] = 1;
    params[P_MIX] = 1;
    const { L, R } = render({
      totalSamples: SR,
      params,
      inLAt: (i) => Math.sin(i * 0.13) * AUDIO_NORM * 4,
      inRAt: () => 0,
    });
    expectAllFinite(L);
    expectAllFinite(R);
  });
});

describe("visible controls shape the tail", () => {
  it("increasing Decay lengthens the tail", () => {
    const short = roomParams();
    short[P_DECAY] = 0.2;
    const long = roomParams();
    long[P_DECAY] = 0.9;
    const a = render({ totalSamples: SR, params: short, inLAt: impulseAt0, inRAt: impulseAt0 });
    const b = render({ totalSamples: SR, params: long, inLAt: impulseAt0, inRAt: impulseAt0 });
    const lateShort = rms(a.L, 0.5 * SR, 0.9 * SR);
    const lateLong = rms(b.L, 0.5 * SR, 0.9 * SR);
    expect(lateLong).toBeGreaterThan(lateShort * 3);
  });

  it("increasing Damp reduces high-frequency content in the tail", () => {
    const bright = roomParams();
    bright[P_DAMP] = 0.1;
    bright[P_MIX] = 1;
    bright[P_DECAY] = 0.7; // long enough that the window below is pure tail
    const dark = roomParams();
    dark[P_DAMP] = 0.9;
    dark[P_MIX] = 1;
    dark[P_DECAY] = 0.7;
    const a = render({ totalSamples: SR, params: bright, inLAt: impulseAt0, inRAt: impulseAt0 });
    const b = render({ totalSamples: SR, params: dark, inLAt: impulseAt0, inRAt: impulseAt0 });
    // Late-tail window: damping is applied per tank circulation, so its
    // spectral effect compounds with time — the early tail is dominated by
    // first reflections that have barely passed through the damping filter.
    const start = Math.floor(0.3 * SR);
    const end = Math.floor(0.5 * SR);
    expect(hfShare(b.L, start, end)).toBeLessThan(hfShare(a.L, start, end) * 0.5);
  });

  it("Time CV (decay CV) lengthens the tail on top of the Decay knob, clamped below freeze", () => {
    const params = roomParams();
    params[P_DECAY] = 0.1;
    params[P_MIX] = 1;
    const knobOnly = render({ totalSamples: SR, params, inLAt: impulseAt0, inRAt: impulseAt0 });
    const withCV = render({
      totalSamples: SR,
      params,
      inLAt: impulseAt0,
      inRAt: impulseAt0,
      decayCvAt: () => 5, // +CV_BIPOLAR_MAX: pushes decay to the (capped) top
    });
    const late = (r: { L: Float32Array }): number => rms(r.L, 0.5 * SR, 0.9 * SR);
    expect(late(withCV)).toBeGreaterThan(late(knobOnly) * 3);
    expectAllFinite(withCV.L); // capped at DECAY_MAX < 1 — no freeze/blowup
    expectAllFinite(withCV.R);
  });

  it("sweeping Size while playing stays finite and bounded (accepted-warble, never blowup)", () => {
    const state = reverbKernel.init(SR);
    const params = roomParams();
    params[P_MIX] = 1;
    params[P_DECAY] = 0.9;
    const inL = new Float32Array(BLOCK_FRAMES);
    const inR = new Float32Array(BLOCK_FRAMES);
    const outs = [new Float32Array(BLOCK_FRAMES), new Float32Array(BLOCK_FRAMES)];
    const total = SR; // 1 s, sweeping Size 1 → 0 → 1 across the render
    for (let start = 0; start < total; start += BLOCK_FRAMES) {
      const phase = start / total;
      params[P_SIZE] = Math.abs(1 - 2 * phase); // 1 → 0 → 1
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        inL[i] = Math.sin((start + i) * 0.11) * AUDIO_NORM;
        inR[i] = inL[i];
      }
      reverbKernel.process(state, [inL, inR, null], outs, params, BLOCK_FRAMES);
      expectAllFinite(outs[0]);
      expectAllFinite(outs[1]);
    }
  });

  it("PreDelay delays the wet onset", () => {
    const immediate = roomParams();
    immediate[P_PRE_DELAY] = 0;
    immediate[P_SIZE] = 0;
    immediate[P_MIX] = 1;
    const delayed = roomParams();
    delayed[P_PRE_DELAY] = 0.2;
    delayed[P_SIZE] = 0;
    delayed[P_MIX] = 1;
    const a = render({ totalSamples: SR, params: immediate, inLAt: impulseAt0, inRAt: impulseAt0 });
    const b = render({ totalSamples: SR, params: delayed, inLAt: impulseAt0, inRAt: impulseAt0 });
    const wStart = Math.floor(0.05 * SR);
    const wEnd = Math.floor(0.15 * SR);
    // Wet-only output: with 200 ms of pre-delay this window precedes any
    // signal reaching the tank, so it is exactly silent — not just quiet.
    expect(sumAbs(b.L, wStart, wEnd)).toBe(0);
    expect(sumAbs(b.R, wStart, wEnd)).toBe(0);
    expect(sumAbs(a.L, wStart, wEnd)).toBeGreaterThan(0);
  });
});

describe("presets", () => {
  it("room, hall and plate produce audibly different reverbs", () => {
    const renders = [PRESET_ROOM, PRESET_HALL, PRESET_PLATE].map((preset) => {
      const params = presetParams(preset);
      params[P_MIX] = 1;
      return render({ totalSamples: SR, params, inLAt: impulseAt0, inRAt: impulseAt0 });
    });
    for (let a = 0; a < renders.length; a++) {
      for (let b = a + 1; b < renders.length; b++) {
        const x = renders[a].L;
        const y = renders[b].L;
        let diff = 0;
        let ref = 0;
        for (let i = 0; i < x.length; i++) {
          diff += (x[i] - y[i]) * (x[i] - y[i]);
          ref += x[i] * x[i];
        }
        // Normalized L2 distance: identical tails would be ~0.
        expect(diff / ref).toBeGreaterThan(0.1);
      }
    }
  });

  it("hall (longer decay) sustains a longer tail than room", () => {
    const room = render({
      totalSamples: SR,
      params: presetParams(PRESET_ROOM),
      inLAt: impulseAt0,
      inRAt: impulseAt0,
    });
    const hall = render({
      totalSamples: SR,
      params: presetParams(PRESET_HALL),
      inLAt: impulseAt0,
      inRAt: impulseAt0,
    });
    expect(rms(hall.L, 0.6 * SR, SR)).toBeGreaterThan(rms(room.L, 0.6 * SR, SR) * 2);
  });
});

// The kernel's core is a port of khoin/DattorroReverbNode (see reverb.ts
// header). These tests run the VENDORED upstream processor (__fixtures__/
// dattorroReverbUpstream.js, verbatim) against the kernel and require
// numerical agreement to within float32 rounding noise. Scope of the claim
// (GH #83 revision): upstream is mono-fed, so equivalence is asserted where
// our feed model coincides with upstream's — Plate (mono-fed always) and the
// stereo-fed presets under IDENTICAL L/R input, where the per-channel chains
// produce identical injections and the feed degenerates to upstream's. For
// PANNED input, Room/Hall are deliberately NOT upstream-equivalent (see the
// per-preset input feed tests).
describe("upstream equivalence (khoin/DattorroReverbNode)", () => {
  interface UpstreamProcessor {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, number[]>,
    ): boolean;
  }

  // Memoized: the fixture's registerProcessor side effect fires only on the
  // first import (module cache), so capture the class once. sampleRate is
  // read at class-body evaluation and construction — always SR here.
  let upstreamClass: Promise<new () => UpstreamProcessor> | null = null;
  function loadUpstream(sr: number): Promise<new () => UpstreamProcessor> {
    if (upstreamClass) return upstreamClass;
    const g = globalThis as Record<string, unknown>;
    let captured: unknown;
    g.sampleRate = sr;
    g.AudioWorkletProcessor = class {};
    g.registerProcessor = (_name: string, cls: unknown) => {
      captured = cls;
    };
    upstreamClass = import("./__fixtures__/dattorroReverbUpstream.js").then(
      () => captured as new () => UpstreamProcessor,
    );
    return upstreamClass;
  }

  // Renders both implementations over the same scripted input (IDENTICAL on
  // L and R — the regime where every preset's feed matches upstream's) and
  // returns the max absolute sample difference across both channels.
  async function maxDivergence(opts: {
    preset: number;
    upstreamParams: Record<string, number[]>;
    visible: { preDelay: number; decay: number; damp: number; mix: number };
    blocks: number;
    inAt: (i: number) => number;
  }): Promise<number> {
    const Upstream = await loadUpstream(SR);
    const proc = new Upstream();
    const state = reverbKernel.init(SR);

    const p = new Float32Array(PARAM_COUNT);
    p[P_PRESET] = opts.preset;
    p[P_PRE_DELAY] = opts.visible.preDelay;
    p[P_SIZE] = 1; // upstream's tank is our Size = 1 exactly
    p[P_DECAY] = opts.visible.decay;
    p[P_DAMP] = opts.visible.damp;
    p[P_MIX] = opts.visible.mix;

    const inL = new Float32Array(BLOCK_FRAMES);
    const inR = new Float32Array(BLOCK_FRAMES);
    const upL = new Float32Array(BLOCK_FRAMES);
    const upR = new Float32Array(BLOCK_FRAMES);
    const outs = [new Float32Array(BLOCK_FRAMES), new Float32Array(BLOCK_FRAMES)];
    let maxDiff = 0;
    for (let b = 0; b < opts.blocks; b++) {
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        inL[i] = opts.inAt(b * BLOCK_FRAMES + i);
        inR[i] = inL[i];
      }
      upL.fill(0);
      upR.fill(0);
      proc.process([[inL, inR]], [[upL, upR]], opts.upstreamParams);
      reverbKernel.process(state, [inL, inR, null], outs, p, BLOCK_FRAMES);
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        maxDiff = Math.max(
          maxDiff,
          Math.abs(upL[i] - outs[0][i]),
          Math.abs(upR[i] - outs[1][i]),
        );
      }
    }
    return maxDiff;
  }

  const burst = (i: number): number =>
    i === 0 ? AUDIO_NORM : i > 500 && i < 1000 ? Math.sin(i * 0.23) * 2 : 0;

  it("plate preset matches the upstream processor defaults sample-for-sample", async () => {
    const mix = 0.5;
    const diff = await maxDivergence({
      preset: PRESET_PLATE,
      visible: { preDelay: 0.05, decay: 0.7, damp: 0.3, mix },
      upstreamParams: {
        preDelay: [Math.round(0.05 * SR)],
        bandwidth: [0.9999],
        inputDiffusion1: [0.75],
        inputDiffusion2: [0.625],
        decay: [0.7],
        decayDiffusion1: [0.7],
        decayDiffusion2: [0.5],
        damping: [0.3],
        excursionRate: [0.5],
        excursionDepth: [0.7],
        wet: [mix], // upstream folds ×0.6 into wet, as our Mix does
        dry: [1 - mix],
      },
      blocks: 400, // ~1 s, well into the recirculating tail
      inAt: burst,
    });
    expect(diff).toBeLessThan(1e-6);
  });

  it("stereo-fed room degenerates to upstream exactly for identical L/R input (demo's small-room row)", async () => {
    const mix = 0.4;
    const diff = await maxDivergence({
      preset: PRESET_ROOM,
      visible: { preDelay: 1525 / SR, decay: 0.3226, damp: 0.6446, mix },
      upstreamParams: {
        preDelay: [1525],
        bandwidth: [0.5683],
        inputDiffusion1: [0.4666],
        inputDiffusion2: [0.5853],
        decay: [0.3226],
        decayDiffusion1: [0.6954],
        decayDiffusion2: [0.6022],
        damping: [0.6446],
        excursionRate: [0],
        excursionDepth: [0],
        wet: [mix],
        dry: [1 - mix],
      },
      blocks: 300,
      inAt: burst,
    });
    expect(diff).toBeLessThan(1e-6);
  });
});

describe("numerical safety", () => {
  it("all-NaN params render finite output", () => {
    const params = new Float32Array(PARAM_COUNT).fill(NaN);
    const { L, R } = render({ totalSamples: SR / 4, params, inLAt: impulseAt0, inRAt: impulseAt0 });
    expectAllFinite(L);
    expectAllFinite(R);
  });

  it("Infinity params render finite output", () => {
    const params = new Float32Array(PARAM_COUNT).fill(Infinity);
    const { L, R } = render({ totalSamples: SR / 4, params, inLAt: impulseAt0, inRAt: impulseAt0 });
    expectAllFinite(L);
    expectAllFinite(R);
  });

  it("NaN input samples are read as silence and never propagate", () => {
    const params = roomParams();
    params[P_MIX] = 1;
    const { L, R } = render({
      totalSamples: SR / 4,
      params,
      inLAt: (i) => (i % 3 === 0 ? NaN : 1),
      inRAt: () => NaN,
    });
    expectAllFinite(L);
    expectAllFinite(R);
  });

  it("a sustained loud input at maximum Decay stays bounded", () => {
    const params = roomParams();
    params[P_DECAY] = 1;
    params[P_MIX] = 1;
    const { L } = render({
      totalSamples: SR,
      params,
      inLAt: (i) => Math.sin(i * 0.1) * AUDIO_NORM * 4,
      inRAt: (i) => Math.sin(i * 0.11) * AUDIO_NORM * 4,
    });
    expectAllFinite(L);
    // The tank clamp bounds recirculating energy; taps sum 7 clamped lines.
    let peak = 0;
    for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]));
    expect(peak).toBeLessThan(1000);
  });
});
