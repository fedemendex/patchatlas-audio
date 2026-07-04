// @vitest-environment node

import { describe, it, expect } from "vitest";
import { sampleAndHoldKernel } from "./sampleAndHold";
import { noiseSourceKernel } from "./noiseSource";
import { registry, isPlayable } from "./registry";
import { Interpreter } from "../engine/interpreter";
import type { EngineGraph } from "../engine/graph";
import type { Kernel } from "../engine/kernel";
import type { ModuleDSP } from "./registry";
import {
  BLOCK_FRAMES,
  CV_BIPOLAR_MAX,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
} from "../engine/units";

const SR = 48000;

// Output slot order matches the registry entry: S&H, T&H.
const SH = 0;
const TH = 1;

function makeOuts(): Float32Array[] {
  return [new Float32Array(BLOCK_FRAMES), new Float32Array(BLOCK_FRAMES)];
}

/**
 * Renders `totalSamples` of S&H/T&H in BLOCK_FRAMES chunks from scripted
 * per-sample In / Trig volt scripts, starting from a fresh kernel state.
 */
function render(opts: {
  sr?: number;
  totalSamples: number;
  inAt: (sample: number) => number;
  trigAt: (sample: number) => number;
}): { sh: Float32Array; th: Float32Array } {
  const sr = opts.sr ?? SR;
  const state = sampleAndHoldKernel.init(sr);
  const inBuf = new Float32Array(BLOCK_FRAMES);
  const trigBuf = new Float32Array(BLOCK_FRAMES);
  const outs = makeOuts();
  const sh = new Float32Array(opts.totalSamples);
  const th = new Float32Array(opts.totalSamples);

  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      inBuf[i] = opts.inAt(start + i);
      trigBuf[i] = opts.trigAt(start + i);
    }
    sampleAndHoldKernel.process(state, [inBuf, trigBuf], outs, new Float32Array(1), n);
    sh.set(outs[SH].subarray(0, n), start);
    th.set(outs[TH].subarray(0, n), start);
  }
  return { sh, th };
}

// ── 1. Registry / seed ───────────────────────────────────────────────────────

describe("sample-and-hold registry entry", () => {
  it("matches the seed exactly: In/Trig inputs, S&H/T&H outputs, Slew control", () => {
    const entry = registry.get("sample-and-hold");
    expect(entry).toBeDefined();
    expect(entry?.inJacks).toEqual(["In", "Trig"]);
    expect(entry?.outJacks).toEqual(["S&H", "T&H"]);
    expect(Object.keys(entry?.params ?? {})).toEqual(["Slew"]);
  });

  it("is playable", () => {
    expect(isPlayable("sample-and-hold")).toBe(true);
  });

  it("uses the canonical sampleAndHoldKernel (identity)", () => {
    expect(registry.get("sample-and-hold")?.kernel).toBe(sampleAndHoldKernel);
  });
});

// ── 2. Basic hold ─────────────────────────────────────────────────────────────

describe("sampleAndHoldKernel — basic hold", () => {
  it("output changes only at trigger samples and equals input at that sample", () => {
    const triggerAt = [1000, 2500, 4000];
    const pulseLen = 5;
    const { sh } = render({
      totalSamples: 6000,
      inAt: (i) => (i / 6000) * 10 - 5, // ramp -5V..+5V
      trigAt: (i) =>
        triggerAt.some((t) => i >= t && i < t + pulseLen) ? CV_BIPOLAR_MAX : 0,
    });

    const expectedAtTrigger = (t: number) => (t / 6000) * 10 - 5;
    for (const t of triggerAt) {
      expect(sh[t]).toBeCloseTo(expectedAtTrigger(t), 6);
    }

    // Holds constant between triggers.
    for (let seg = 0; seg < triggerAt.length; seg++) {
      const start = triggerAt[seg];
      const end = seg + 1 < triggerAt.length ? triggerAt[seg + 1] : 6000;
      for (let i = start + 1; i < end; i++) {
        expect(sh[i]).toBe(sh[start]);
      }
    }
  });

  it("initial held value is 0 V before any trigger", () => {
    const { sh } = render({
      totalSamples: 500,
      inAt: () => 3.3,
      trigAt: () => 0,
    });
    for (let i = 0; i < 500; i++) expect(sh[i]).toBe(0);
  });
});

// ── 3. Schmitt hysteresis ────────────────────────────────────────────────────

describe("sampleAndHoldKernel — Schmitt hysteresis", () => {
  it("a slow ramp through the threshold region fires exactly once", () => {
    const totalSamples = 20000;
    const { sh } = render({
      totalSamples,
      inAt: (i) => i, // distinct value per sample so re-fires are detectable
      // Ramps from 0V to 2V over the whole render — crosses both thresholds once.
      trigAt: (i) => (2 * i) / totalSamples,
    });
    let fires = 0;
    for (let i = 1; i < totalSamples; i++) {
      if (sh[i] !== sh[i - 1]) fires++;
    }
    expect(fires).toBe(1);
  });

  it("values strictly between the thresholds never fire before going high once", () => {
    const between = (GATE_REARM_THRESHOLD_V + GATE_FIRE_THRESHOLD_V) / 2;
    const { sh } = render({
      totalSamples: 2000,
      inAt: (i) => i,
      trigAt: () => between,
    });
    for (let i = 0; i < 2000; i++) expect(sh[i]).toBe(0);
  });

  it("must fall below GATE_REARM_THRESHOLD_V before firing again", () => {
    const between = (GATE_REARM_THRESHOLD_V + GATE_FIRE_THRESHOLD_V) / 2;
    const fireAt = 500;
    const { sh } = render({
      totalSamples: 5000,
      inAt: (i) => i,
      trigAt: (i) => {
        if (i < fireAt) return 0;
        if (i < fireAt + 10) return CV_BIPOLAR_MAX; // fires once
        return between; // hovers in the hysteresis band — must not re-fire
      },
    });
    const heldValue = sh[fireAt];
    for (let i = fireAt + 10; i < 5000; i++) {
      expect(sh[i]).toBe(heldValue);
    }
  });
});

// ── 4. Double-trigger-proof ───────────────────────────────────────────────────

describe("sampleAndHoldKernel — double-trigger-proof", () => {
  it("a sustained high trigger over many samples fires only once", () => {
    const totalSamples = 10000;
    const { sh } = render({
      totalSamples,
      inAt: (i) => i,
      trigAt: (i) => (i < 100 ? 0 : CV_BIPOLAR_MAX), // rises once, stays high
    });
    let fires = 0;
    for (let i = 1; i < totalSamples; i++) {
      if (sh[i] !== sh[i - 1]) fires++;
    }
    expect(fires).toBe(1);
    expect(sh[100]).toBe(100); // sampled at the rising edge
  });

  it("does not resample across multiple process() calls while trigger stays high, then samples again after re-arm", () => {
    // Exercises repeated block processing explicitly (each process() call is
    // one BLOCK_FRAMES-sized block), unlike a single scripted render: the
    // trigger rises in block 1 and stays high through block 2 with a
    // *different* input value — S&H must not resample mid-high. Only after
    // dropping below GATE_REARM_THRESHOLD_V and rising again does it sample
    // the new input.
    const state = sampleAndHoldKernel.init(SR);
    const outs = makeOuts();
    const params = new Float32Array(1);

    // Block 1: trigger rises partway through, input is 1.0 at the rising sample.
    const in1 = new Float32Array(BLOCK_FRAMES).fill(1.0);
    const trig1 = new Float32Array(BLOCK_FRAMES).fill(0);
    trig1[20] = CV_BIPOLAR_MAX;
    for (let i = 20; i < BLOCK_FRAMES; i++) trig1[i] = CV_BIPOLAR_MAX;
    sampleAndHoldKernel.process(state, [in1, trig1], outs, params, BLOCK_FRAMES);
    expect(outs[SH][20]).toBeCloseTo(1.0, 6);
    expect(outs[SH][BLOCK_FRAMES - 1]).toBeCloseTo(1.0, 6);

    // Block 2 (a separate process() call, same state): trigger stays high
    // throughout, but input has changed to 9.0 — must NOT resample.
    const in2 = new Float32Array(BLOCK_FRAMES).fill(9.0);
    const trig2 = new Float32Array(BLOCK_FRAMES).fill(CV_BIPOLAR_MAX);
    sampleAndHoldKernel.process(state, [in2, trig2], outs, params, BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(outs[SH][i]).toBeCloseTo(1.0, 6);
    }

    // Block 3: trigger drops to 0 (re-arms) then rises again partway
    // through with a new input value — must sample the new value now.
    const in3 = new Float32Array(BLOCK_FRAMES).fill(9.0);
    const trig3 = new Float32Array(BLOCK_FRAMES).fill(0);
    for (let i = 60; i < BLOCK_FRAMES; i++) trig3[i] = CV_BIPOLAR_MAX;
    sampleAndHoldKernel.process(state, [in3, trig3], outs, params, BLOCK_FRAMES);
    for (let i = 0; i < 60; i++) expect(outs[SH][i]).toBeCloseTo(1.0, 6); // still held
    for (let i = 60; i < BLOCK_FRAMES; i++) expect(outs[SH][i]).toBeCloseTo(9.0, 6); // resampled
  });

  it("a single sustained-high trigger held across one long render fires only once (regression)", () => {
    const totalSamples = 3000;
    const { sh } = render({
      totalSamples,
      inAt: (i) => i,
      trigAt: (i) => (i < 10 ? 0 : CV_BIPOLAR_MAX),
    });
    const heldValue = sh[10];
    for (let i = 10; i < totalSamples; i++) expect(sh[i]).toBe(heldValue);
  });
});

// ── 5. Safety ─────────────────────────────────────────────────────────────────

describe("sampleAndHoldKernel — safety", () => {
  it("non-finite input at the trigger sample holds a safe (0 V) fallback", () => {
    const { sh } = render({
      totalSamples: 200,
      inAt: (i) => (i === 50 ? NaN : 3),
      trigAt: (i) => (i === 50 ? CV_BIPOLAR_MAX : 0),
    });
    expect(sh[50]).toBe(0);
    for (let i = 51; i < 200; i++) expect(sh[i]).toBe(0);
  });

  it("non-finite trigger samples never fire", () => {
    const { sh } = render({
      totalSamples: 200,
      inAt: () => 4,
      trigAt: (i) => (i % 3 === 0 ? NaN : i % 3 === 1 ? Infinity : -Infinity),
    });
    // +Infinity is non-finite too (treated as 0 V/low): nothing ever fires.
    for (let i = 0; i < 200; i++) expect(sh[i]).toBe(0);
  });

  it("unpatched input samples 0 V", () => {
    const state = sampleAndHoldKernel.init(SR);
    const outs = makeOuts();
    const trig = new Float32Array(BLOCK_FRAMES).fill(CV_BIPOLAR_MAX);
    sampleAndHoldKernel.process(state, [null, trig], outs, new Float32Array(1), BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) expect(outs[SH][i]).toBe(0);
  });

  it("unpatched trigger never fires; output remains the initial 0 V", () => {
    const state = sampleAndHoldKernel.init(SR);
    const outs = makeOuts();
    const inp = new Float32Array(BLOCK_FRAMES).fill(7);
    sampleAndHoldKernel.process(state, [inp, null], outs, new Float32Array(1), BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) expect(outs[SH][i]).toBe(0);
  });

  it("held value never becomes NaN/Inf even under adversarial input", () => {
    const { sh } = render({
      totalSamples: 2000,
      inAt: (i) => (i % 7 === 0 ? NaN : i % 11 === 0 ? Infinity : i - 1000),
      trigAt: (i) => (i % 50 === 0 ? CV_BIPOLAR_MAX : i % 50 === 25 ? 0 : CV_BIPOLAR_MAX / 2),
    });
    for (let i = 0; i < 2000; i++) expect(Number.isFinite(sh[i])).toBe(true);
  });

  it("writes every declared output for a partial block, no stale sentinel samples", () => {
    const state = sampleAndHoldKernel.init(SR);
    const outs = makeOuts();
    for (const o of outs) o.fill(999);
    const n = 17;
    const inp = new Float32Array(BLOCK_FRAMES).fill(2);
    const trig = new Float32Array(BLOCK_FRAMES).fill(CV_BIPOLAR_MAX);
    sampleAndHoldKernel.process(state, [inp, trig], outs, new Float32Array(1), n);
    for (const o of outs) {
      for (let i = 0; i < n; i++) expect(o[i]).not.toBe(999);
      for (let i = n; i < BLOCK_FRAMES; i++) expect(o[i]).toBe(999);
    }
  });
});

// ── T&H (track-and-hold) ──────────────────────────────────────────────────────

describe("sampleAndHoldKernel — T&H tracks while high, holds while low", () => {
  it("tracks the input continuously while Trig is high", () => {
    const { th } = render({
      totalSamples: 300,
      inAt: (i) => i * 0.01,
      trigAt: (i) => (i >= 50 && i < 150 ? CV_BIPOLAR_MAX : 0),
    });
    for (let i = 50; i < 150; i++) {
      expect(th[i]).toBeCloseTo(i * 0.01, 6);
    }
  });

  it("freezes at the last tracked value once Trig drops low", () => {
    const { th } = render({
      totalSamples: 300,
      inAt: (i) => i * 0.01,
      trigAt: (i) => (i >= 50 && i < 150 ? CV_BIPOLAR_MAX : 0),
    });
    const frozen = th[149];
    for (let i = 150; i < 300; i++) expect(th[i]).toBe(frozen);
  });
});

// ── 6. Interpreter integration ────────────────────────────────────────────────

describe("noise → sample-and-hold → tap through the Interpreter", () => {
  it("the classic S&H patch: LFO Sq triggers a stepped hold of noise White", () => {
    // A local, test-only tap slug (never added to the production registry —
    // mirrors the AP-2 toy-kernel convention) exposes S&H's raw output
    // undistorted, since routing through the real audio-output kernel would
    // DC-block/soft-clip the held DC-like plateaus we're asserting on here.
    const tapKernel: Kernel<null> = {
      init: () => null,
      process(_state, ins, outs, _params, n) {
        const src = ins[0];
        const out = outs[0];
        for (let i = 0; i < n; i++) out[i] = src === null ? 0 : src[i];
      },
    };
    const fixtureRegistry = new Map<string, ModuleDSP>(registry);
    fixtureRegistry.set("test-tap", {
      slug: "test-tap",
      kernel: tapKernel,
      inJacks: ["In"],
      outJacks: [],
      params: {},
      audioOutput: { channels: 1 },
    });

    const rateHz = 5;
    const graph: EngineGraph = {
      nodes: [
        { instanceId: "noise", slug: "noise-source", params: [] },
        { instanceId: "lfo", slug: "lfo", params: [rateHz] },
        { instanceId: "sh", slug: "sample-and-hold", params: [0] },
        { instanceId: "tap", slug: "test-tap", params: [] },
      ],
      edges: [
        { from: [0, 0], to: [2, 0], feedback: false }, // noise.White → sh.In
        { from: [1, 2], to: [2, 1], feedback: false }, // lfo.Sq → sh.Trig
        { from: [2, 0], to: [3, 0], feedback: false }, // sh.S&H → tap.In
      ],
      outputNodes: [3],
    };

    const interp = new Interpreter(graph, fixtureRegistry, SR);
    const totalSamples = SR / rateHz * 3; // 3 full LFO cycles
    const tapped = new Float32Array(totalSamples);
    const l = new Float32Array(BLOCK_FRAMES);
    const r = new Float32Array(BLOCK_FRAMES);
    for (let start = 0; start < totalSamples; start += BLOCK_FRAMES) {
      const n = Math.min(BLOCK_FRAMES, totalSamples - start);
      interp.runBlock(n);
      interp.readOutput(l, r, n);
      tapped.set(l.subarray(0, n), start);
    }

    // Independently render the expected White noise sequence from a fresh
    // kernel with the same block chunking, to know what the S&H should have
    // sampled at each LFO rising edge.
    const noiseState = noiseSourceKernel.init(SR);
    const noiseOuts = [
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
    ];
    const expectedWhite = new Float32Array(totalSamples);
    for (let start = 0; start < totalSamples; start += BLOCK_FRAMES) {
      const n = Math.min(BLOCK_FRAMES, totalSamples - start);
      noiseSourceKernel.process(noiseState, [], noiseOuts, new Float32Array(0), n);
      expectedWhite.set(noiseOuts[0].subarray(0, n), start);
    }

    // The LFO's Sq output is already high at phase 0, so the Schmitt trigger
    // fires on sample 0 of each cycle (period = SR / rateHz).
    const period = SR / rateHz;
    for (let cycle = 0; cycle < 3; cycle++) {
      const t = cycle * period;
      expect(tapped[t]).toBeCloseTo(expectedWhite[t], 4);
    }

    // Stepped behavior: output is flat within each cycle and changes at the
    // cycle boundary (extremely unlikely for two independent noise draws to
    // coincide).
    for (let cycle = 0; cycle < 3; cycle++) {
      const start = cycle * period;
      const end = start + period;
      for (let i = start + 1; i < end; i++) {
        expect(tapped[i]).toBe(tapped[start]);
      }
    }
    expect(tapped[0]).not.toBe(tapped[period]);
    expect(tapped[period]).not.toBe(tapped[2 * period]);
  });
});
