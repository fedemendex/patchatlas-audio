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
  p[P_PRE_DELAY] = 0.015;
  p[P_SIZE] = 0.35;
  p[P_DECAY] = 0.35;
  p[P_DAMP] = 0.45;
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
    const dark = roomParams();
    dark[P_DAMP] = 0.9;
    dark[P_MIX] = 1;
    const a = render({ totalSamples: SR, params: bright, inLAt: impulseAt0, inRAt: impulseAt0 });
    const b = render({ totalSamples: SR, params: dark, inLAt: impulseAt0, inRAt: impulseAt0 });
    // Late-tail window: damping is applied per tank circulation, so its
    // spectral effect compounds with time — the early tail is dominated by
    // first reflections that have barely passed through the damping filter.
    const start = Math.floor(0.3 * SR);
    const end = Math.floor(0.5 * SR);
    expect(hfShare(b.L, start, end)).toBeLessThan(hfShare(a.L, start, end) * 0.5);
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
