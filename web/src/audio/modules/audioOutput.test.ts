// @vitest-environment node
// (Pure engine logic; no DOM needed and jsdom breaks import.meta.url resolves.)

import { describe, it, expect } from "vitest";
import { audioOutputKernel } from "./audioOutput";
import { registry, isPlayable } from "./registry";
import { Interpreter } from "../engine/interpreter";
import { testRegistry } from "../engine/testKernels";
import { compileGraph } from "../engine/graph";
import { AUDIO_NORM, BLOCK_FRAMES } from "../engine/units";
import type { EngineGraph } from "../engine/graph";
import type { ModuleDSP } from "./registry";
import type { Module, ModuleJack, ModuleControl } from "../../lib/api";
import type { PatchDraftDoc } from "../../patches/draft/patchDraft";

const SR = 48000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function graphOf(
  nodes: { id: string; slug: string; params?: number[] }[],
  edges: { from: [number, number]; to: [number, number]; feedback?: boolean }[] = [],
  outputNodes: number[] = [],
): EngineGraph {
  return {
    nodes: nodes.map((n) => ({ instanceId: n.id, slug: n.slug, params: n.params ?? [] })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, feedback: e.feedback ?? false })),
    outputNodes,
  };
}

function render(
  interp: Interpreter,
  blocks: number,
): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(blocks * BLOCK_FRAMES);
  const right = new Float32Array(blocks * BLOCK_FRAMES);
  const l = new Float32Array(BLOCK_FRAMES);
  const r = new Float32Array(BLOCK_FRAMES);
  for (let b = 0; b < blocks; b++) {
    interp.runBlock(BLOCK_FRAMES);
    interp.readOutput(l, r, BLOCK_FRAMES);
    left.set(l, b * BLOCK_FRAMES);
    right.set(r, b * BLOCK_FRAMES);
  }
  return { left, right };
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// toy-sine + real audio-output.
const mixedRegistry = new Map<string, ModuleDSP>([...testRegistry, ...registry]);

// ── 1. Registry integrity ─────────────────────────────────────────────────────

describe("registry integrity", () => {
  it("production registry contains audio-output and oscillator", () => {
    expect(registry.has("audio-output")).toBe(true);
    expect(registry.has("oscillator")).toBe(true);
  });

  it("audio-output entry has correct jack/param shape", () => {
    const entry = registry.get("audio-output")!;
    expect(entry.inJacks).toEqual(["L In", "R In"]);
    expect(entry.outJacks).toEqual([]);
    expect(entry.audioOutput).toEqual({ channels: 2 });
    expect(Object.keys(entry.params)).toEqual(["Level"]);
    const level = entry.params["Level"];
    expect(level.min).toBe(0);
    expect(level.max).toBe(1);
    expect(level.default).toBe(0.8);
    expect(level.curve).toBe("linear");
  });

  it("isPlayable('audio-output') is true", () => {
    expect(isPlayable("audio-output")).toBe(true);
  });

  it("toy kernels remain absent from the production registry", () => {
    expect(registry.has("toy-sine")).toBe(false);
    expect(registry.has("toy-gain")).toBe(false);
  });
});

// ── 2. Nominal sine level ─────────────────────────────────────────────────────

describe("nominal sine level", () => {
  it("±5 V sine at 440 Hz produces ~tanh(1) × Level peak after transient settles", () => {
    // toy-sine outputs ±AUDIO_NORM (±5 V). After normalization the peak input
    // to tanh is ±1.0, so peak out ≈ tanh(1) × Level ≈ 0.7616 × 0.8 = 0.6093.
    // The DC blocker is negligible at 440 Hz (~0.03% loss); the ±10% lower bound
    // accommodates peak estimation over a finite 20-block render window.
    const interp = new Interpreter(
      graphOf(
        [
          { id: "sine", slug: "toy-sine", params: [440] },
          { id: "ao", slug: "audio-output", params: [0.8] },
        ],
        [{ from: [0, 0], to: [1, 0] }], // toy-sine Out → audio-output L In
        [1],
      ),
      mixedRegistry,
      SR,
    );

    // Skip 10 blocks for DC blocker transient to settle.
    render(interp, 10);
    const { left, right } = render(interp, 20);

    let peakL = 0;
    for (let i = 0; i < left.length; i++) peakL = Math.max(peakL, Math.abs(left[i]));

    const idealPeak = Math.tanh(1) * 0.8;
    expect(peakL).toBeGreaterThan(idealPeak * 0.9);
    expect(peakL).toBeLessThan(idealPeak + 0.002); // can't exceed tanh(1)×Level

    // L-only patch → both channels carry signal (mono normalization).
    expect(rms(right)).toBeGreaterThan(0.1);
  });
});

// ── 3. Hot input safety ───────────────────────────────────────────────────────

describe("hot input safety", () => {
  it("±25 V input stays finite and within ±1.0 at Level = 1", () => {
    const state = audioOutputKernel.init(SR);
    const hot = new Float32Array(BLOCK_FRAMES).fill(25);
    const outL = new Float32Array(BLOCK_FRAMES);
    const outR = new Float32Array(BLOCK_FRAMES);
    const params = new Float32Array([1.0]);

    audioOutputKernel.process(state, [hot, hot], [outL, outR], params, BLOCK_FRAMES);

    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Number.isFinite(outL[i])).toBe(true);
      expect(Math.abs(outL[i])).toBeLessThanOrEqual(1.0);
      expect(Number.isFinite(outR[i])).toBe(true);
      expect(Math.abs(outR[i])).toBeLessThanOrEqual(1.0);
    }
  });

  it("−25 V hot input produces no NaN/Inf", () => {
    const state = audioOutputKernel.init(SR);
    const cold = new Float32Array(BLOCK_FRAMES).fill(-25);
    const outL = new Float32Array(BLOCK_FRAMES);
    const outR = new Float32Array(BLOCK_FRAMES);
    const params = new Float32Array([1.0]);

    audioOutputKernel.process(state, [cold, null], [outL, outR], params, BLOCK_FRAMES);

    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Number.isFinite(outL[i])).toBe(true);
      expect(Number.isFinite(outR[i])).toBe(true);
    }
  });
});

// ── 4. DC blocker ─────────────────────────────────────────────────────────────

describe("DC blocker", () => {
  it("constant 5 V DC decays toward 0 within 10 time constants (~60 blocks)", () => {
    // Time constant ≈ sr / (2π × 10 Hz) ≈ 764 samples ≈ 6 blocks.
    // After 60 blocks the residual is e^−10 ≈ 4×10^−5 of the initial value.
    const state = audioOutputKernel.init(SR);
    const dc = new Float32Array(BLOCK_FRAMES).fill(5);
    const outL = new Float32Array(BLOCK_FRAMES);
    const outR = new Float32Array(BLOCK_FRAMES);
    const params = new Float32Array([1.0]);

    for (let b = 0; b < 60; b++) {
      audioOutputKernel.process(state, [dc, null], [outL, outR], params, BLOCK_FRAMES);
    }

    expect(Math.abs(outL[BLOCK_FRAMES - 1])).toBeLessThan(0.01);
    expect(Math.abs(outR[BLOCK_FRAMES - 1])).toBeLessThan(0.01);
  });
});

// ── 5. Mono normalization ─────────────────────────────────────────────────────

describe("mono normalization", () => {
  function makeSine(): Float32Array {
    const buf = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      buf[i] = AUDIO_NORM * Math.sin((2 * Math.PI * 440 * i) / SR);
    }
    return buf;
  }

  it("L-only: left and right outputs are identical", () => {
    const state = audioOutputKernel.init(SR);
    const sig = makeSine();
    const outL = new Float32Array(BLOCK_FRAMES);
    const outR = new Float32Array(BLOCK_FRAMES);
    audioOutputKernel.process(state, [sig, null], [outL, outR], new Float32Array([1.0]), BLOCK_FRAMES);
    expect(outL).toEqual(outR);
  });

  it("R-only: left and right outputs are identical", () => {
    const state = audioOutputKernel.init(SR);
    const sig = makeSine();
    const outL = new Float32Array(BLOCK_FRAMES);
    const outR = new Float32Array(BLOCK_FRAMES);
    audioOutputKernel.process(state, [null, sig], [outL, outR], new Float32Array([1.0]), BLOCK_FRAMES);
    expect(outL).toEqual(outR);
  });

  it("both patched: channels process independently", () => {
    const state = audioOutputKernel.init(SR);
    const sigL = makeSine(); // 440 Hz
    const sigR = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      sigR[i] = AUDIO_NORM * Math.sin((2 * Math.PI * 880 * i) / SR); // 880 Hz
    }
    const outL = new Float32Array(BLOCK_FRAMES);
    const outR = new Float32Array(BLOCK_FRAMES);
    audioOutputKernel.process(state, [sigL, sigR], [outL, outR], new Float32Array([1.0]), BLOCK_FRAMES);

    let allSame = true;
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      if (outL[i] !== outR[i]) { allSame = false; break; }
    }
    expect(allSame).toBe(false);
  });

  it("neither patched: both channels are silence", () => {
    const state = audioOutputKernel.init(SR);
    const outL = new Float32Array(BLOCK_FRAMES);
    const outR = new Float32Array(BLOCK_FRAMES);
    audioOutputKernel.process(state, [null, null], [outL, outR], new Float32Array([1.0]), BLOCK_FRAMES);
    expect(outL).toEqual(new Float32Array(BLOCK_FRAMES));
    expect(outR).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("stereo→L-only: outputs are bit-identical after DC blocker states have diverged", () => {
    const state = audioOutputKernel.init(SR);
    const params = new Float32Array([1.0]);
    const sigL = new Float32Array(BLOCK_FRAMES);
    const sigR = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      sigL[i] = AUDIO_NORM * Math.sin((2 * Math.PI * 440 * i) / SR);
      sigR[i] = AUDIO_NORM * Math.sin((2 * Math.PI * 880 * i) / SR);
    }
    const scratch1 = new Float32Array(BLOCK_FRAMES);
    const scratch2 = new Float32Array(BLOCK_FRAMES);
    // Drive stereo for 5 blocks so L and R DC blocker states diverge.
    for (let b = 0; b < 5; b++) {
      audioOutputKernel.process(state, [sigL, sigR], [scratch1, scratch2], params, BLOCK_FRAMES);
    }
    // Switch to L-only: must be bit-identical despite stale R state.
    const outL = new Float32Array(BLOCK_FRAMES);
    const outR = new Float32Array(BLOCK_FRAMES);
    audioOutputKernel.process(state, [sigL, null], [outL, outR], params, BLOCK_FRAMES);
    expect(outL).toEqual(outR);
  });

  it("stereo→R-only: outputs are bit-identical after DC blocker states have diverged", () => {
    const state = audioOutputKernel.init(SR);
    const params = new Float32Array([1.0]);
    const sigL = new Float32Array(BLOCK_FRAMES);
    const sigR = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      sigL[i] = AUDIO_NORM * Math.sin((2 * Math.PI * 440 * i) / SR);
      sigR[i] = AUDIO_NORM * Math.sin((2 * Math.PI * 880 * i) / SR);
    }
    const scratch1 = new Float32Array(BLOCK_FRAMES);
    const scratch2 = new Float32Array(BLOCK_FRAMES);
    for (let b = 0; b < 5; b++) {
      audioOutputKernel.process(state, [sigL, sigR], [scratch1, scratch2], params, BLOCK_FRAMES);
    }
    const outL = new Float32Array(BLOCK_FRAMES);
    const outR = new Float32Array(BLOCK_FRAMES);
    audioOutputKernel.process(state, [null, sigR], [outL, outR], params, BLOCK_FRAMES);
    expect(outL).toEqual(outR);
  });
});

// ── 6. Level clamping ────────────────────────────────────────────────────────

describe("Level clamping", () => {
  function runWithLevel(level: number): Float32Array {
    const state = audioOutputKernel.init(SR);
    const sig = new Float32Array(BLOCK_FRAMES).fill(5); // 5 V DC
    const outL = new Float32Array(BLOCK_FRAMES);
    const outR = new Float32Array(BLOCK_FRAMES);
    audioOutputKernel.process(state, [sig, null], [outL, outR], new Float32Array([level]), BLOCK_FRAMES);
    return outL;
  }

  it("NaN Level produces finite output (no NaN propagation)", () => {
    const out = runWithLevel(NaN);
    for (let i = 0; i < BLOCK_FRAMES; i++) expect(Number.isFinite(out[i])).toBe(true);
  });

  it("Infinity Level produces finite output", () => {
    const out = runWithLevel(Infinity);
    for (let i = 0; i < BLOCK_FRAMES; i++) expect(Number.isFinite(out[i])).toBe(true);
  });

  it("-Infinity Level produces finite output", () => {
    const out = runWithLevel(-Infinity);
    for (let i = 0; i < BLOCK_FRAMES; i++) expect(Number.isFinite(out[i])).toBe(true);
  });

  it("Level below 0 clamps to 0 (silence)", () => {
    expect(runWithLevel(-0.5)).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("Level above 1 clamps to 1 (matches explicit Level = 1.0)", () => {
    expect(runWithLevel(1.5)).toEqual(runWithLevel(1.0));
  });
});

// ── 7. readOutput integration ─────────────────────────────────────────────────

describe("readOutput integration", () => {
  it("audio-output internal buffers flow through readOutput with mono normalization", () => {
    // L In only patched → kernel writes same processed signal to both DAC buffers.
    // readOutput sums them, so left === right.
    const interp = new Interpreter(
      graphOf(
        [
          { id: "sine", slug: "toy-sine", params: [440] },
          { id: "ao", slug: "audio-output", params: [1.0] },
        ],
        [{ from: [0, 0], to: [1, 0] }],
        [1],
      ),
      mixedRegistry,
      SR,
    );

    render(interp, 5); // skip startup
    const { left, right } = render(interp, 4);

    expect(rms(left)).toBeGreaterThan(0.1);
    for (let i = 0; i < left.length; i++) {
      expect(left[i]).toBe(right[i]);
    }
  });

  it("two audio-output nodes sum into readOutput", () => {
    const one = new Interpreter(
      graphOf(
        [
          { id: "sine", slug: "toy-sine", params: [440] },
          { id: "ao", slug: "audio-output", params: [1.0] },
        ],
        [{ from: [0, 0], to: [1, 0] }],
        [1],
      ),
      mixedRegistry,
      SR,
    );
    const two = new Interpreter(
      graphOf(
        [
          { id: "sine", slug: "toy-sine", params: [440] },
          { id: "ao1", slug: "audio-output", params: [1.0] },
          { id: "ao2", slug: "audio-output", params: [1.0] },
        ],
        [
          { from: [0, 0], to: [1, 0] },
          { from: [0, 0], to: [2, 0] },
        ],
        [1, 2],
      ),
      mixedRegistry,
      SR,
    );

    // Skip startup transient on both.
    render(one, 5);
    render(two, 5);
    const single = render(one, 4);
    const summed = render(two, 4);

    for (let i = 0; i < single.left.length; i++) {
      expect(summed.left[i]).toBeCloseTo(2 * single.left[i], 4);
    }
  });
});

// ── 8. no-audio-output behavior ───────────────────────────────────────────────

describe("no-audio-output behavior", () => {
  // Minimal catalog helpers mirroring graph.test.ts fixtures.
  function jack(id: string, name: string, direction: "in" | "out", index: number): ModuleJack {
    return { id, name, direction, index, group: null, groupIndex: null };
  }
  function knob(id: string, name: string, index: number): ModuleControl {
    return {
      id, name, kind: "knob", index, bipolar: false,
      group: "", groupIndex: null, positions: null,
    };
  }
  function catalogMod(overrides: {
    id: string; name: string; slug: string | null;
    isSeeded?: boolean; jacks?: ModuleJack[]; controls?: ModuleControl[];
  }): Module {
    return {
      id: overrides.id, name: overrides.name, manufacturerName: null,
      isSeeded: overrides.isSeeded ?? true, version: "1", hpWidth: null,
      description: null, slug: overrides.slug, gridRows: null, gridColumns: null,
      types: [], jacks: overrides.jacks ?? [], controls: overrides.controls ?? [],
      createdBy: null, createdAt: "", updatedAt: "",
    };
  }

  const sineModule = catalogMod({
    id: "mod-sine", name: "Toy Sine", slug: "toy-sine",
    jacks: [jack("j-out", "Out", "out", 0)],
    controls: [knob("c-freq", "Freq", 0)],
  });

  const audioOutputModule = catalogMod({
    id: "mod-ao", name: "Audio Output", slug: "audio-output",
    jacks: [
      jack("j-lin", "L In", "in", 0),
      jack("j-rin", "R In", "in", 1),
    ],
    controls: [knob("c-level", "Level", 0)],
  });

  function patchDoc(modules: PatchDraftDoc["modules"]): PatchDraftDoc {
    return {
      meta: { title: "", notes: "", visibility: "private" },
      modules,
      connections: [],
    };
  }

  it("patch without audio-output emits no-audio-output and outputNodes is empty", () => {
    const doc = patchDoc([
      {
        instanceId: "i-sine", moduleId: "mod-sine", label: "",
        positionX: 0, positionY: 0, controlValues: {},
      },
    ]);
    // testRegistry has toy-sine but no audio-output entry.
    const { graph, warnings } = compileGraph(
      doc,
      new Map([[sineModule.id, sineModule]]),
      testRegistry,
    );
    expect(warnings.some((w) => w.kind === "no-audio-output")).toBe(true);
    expect(graph.outputNodes).toHaveLength(0);
  });

  it("patch with audio-output surviving does not emit no-audio-output", () => {
    const doc = patchDoc([
      {
        instanceId: "i-sine", moduleId: "mod-sine", label: "",
        positionX: 0, positionY: 0, controlValues: {},
      },
      {
        instanceId: "i-ao", moduleId: "mod-ao", label: "",
        positionX: 0, positionY: 0, controlValues: {},
      },
    ]);
    const { graph, warnings } = compileGraph(
      doc,
      new Map([[sineModule.id, sineModule], [audioOutputModule.id, audioOutputModule]]),
      mixedRegistry,
    );
    expect(warnings.some((w) => w.kind === "no-audio-output")).toBe(false);
    expect(graph.outputNodes).toHaveLength(1);
  });
});
