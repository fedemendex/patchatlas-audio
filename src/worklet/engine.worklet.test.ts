// Headless tests for the worklet host's graph/fade state machine. The
// AudioWorkletGlobalScope globals (sampleRate, AudioWorkletProcessor,
// registerProcessor) are stubbed so the processor runs under Vitest; audio
// correctness itself is covered by the interpreter/kernel suites.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineGraph } from "../engine/graph";
import { BLOCK_FRAMES } from "../engine/units";
import type { EngineWorkletMessage } from "./protocol";

const SR = 48000;

interface ProcessorLike {
  port: {
    onmessage: ((e: { data: EngineWorkletMessage }) => void) | null;
    postMessage: (message: unknown) => void;
  };
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

class FakeAudioWorkletProcessor {
  port: ProcessorLike["port"] = { onmessage: null, postMessage: () => {} };
}

let ProcessorCtor: new () => ProcessorLike;

beforeAll(async () => {
  vi.stubGlobal("sampleRate", SR);
  vi.stubGlobal("AudioWorkletProcessor", FakeAudioWorkletProcessor);
  vi.stubGlobal(
    "registerProcessor",
    (name: string, ctor: new () => ProcessorLike) => {
      expect(name).toBe("engine-processor");
      ProcessorCtor = ctor;
    },
  );
  await import("./engine.worklet");
  expect(ProcessorCtor).toBeDefined();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// Compiled shape of oscillator.Sine → audio-output.L In (registry slot order:
// osc params [Tune, Fine, FM Amt, EFM Amt, PW]; Sine is out slot 3, L In is
// in slot 0).
function sineToOutputGraph(tuneOctaves = 0): EngineGraph {
  return {
    nodes: [
      { instanceId: "inst-osc", slug: "oscillator", params: [tuneOctaves, 0, 0, 0, 0.5] },
      { instanceId: "inst-out", slug: "audio-output", params: [0.8] },
    ],
    edges: [{ from: [0, 3], to: [1, 0], feedback: false }],
    outputNodes: [1],
  };
}

// clock.Clk → sequencer.Clk; no audio output (telemetry runs regardless). The
// sequencer params are [Len, CV 1..8, On 1..8]; step 0 is latched on the
// downbeat, so readSteps reports 0.
function clockSequencerGraph(): EngineGraph {
  return {
    nodes: [
      { instanceId: "clk", slug: "clock", params: [120] },
      { instanceId: "seq", slug: "sequencer", params: [8, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1] },
    ],
    edges: [{ from: [0, 0], to: [1, 0], feedback: false }],
    outputNodes: [],
  };
}

// clock.Clk → clock-divider-2.Clk; no audio output. The divider's params are
// [Div, Mode]; the first clock edge is a downbeat on all seven outputs, so the
// reported bitmask is 0b1111111.
function clockDividerGraph(): EngineGraph {
  return {
    nodes: [
      { instanceId: "clk", slug: "clock", params: [120] },
      { instanceId: "div", slug: "clock-divider-2", params: [0, 0] },
    ],
    edges: [{ from: [0, 0], to: [1, 0], feedback: false }],
    outputNodes: [],
  };
}

// A sequencer and a divider on one clock, so both telemetry channels are live
// in the same graph.
function clockSequencerDividerGraph(): EngineGraph {
  return {
    nodes: [
      { instanceId: "clk", slug: "clock", params: [120] },
      { instanceId: "seq", slug: "sequencer", params: [8, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1] },
      { instanceId: "div", slug: "clock-divider-2", params: [0, 0] },
    ],
    edges: [
      { from: [0, 0], to: [1, 0], feedback: false },
      { from: [0, 0], to: [2, 0], feedback: false },
    ],
    outputNodes: [],
  };
}

let proc: ProcessorLike;
let left: Float32Array;
let right: Float32Array;

beforeEach(() => {
  proc = new ProcessorCtor();
  left = new Float32Array(BLOCK_FRAMES);
  right = new Float32Array(BLOCK_FRAMES);
});

function send(message: EngineWorkletMessage): void {
  proc.port.onmessage!({ data: message });
}

function runBlock(): { peakL: number; peakR: number } {
  left.fill(123); // poison so "writes every sample" is observable
  right.fill(123);
  const alive = proc.process([], [[left, right]], {});
  expect(alive).toBe(true);
  let peakL = 0;
  let peakR = 0;
  for (let i = 0; i < BLOCK_FRAMES; i++) {
    peakL = Math.max(peakL, Math.abs(left[i]));
    peakR = Math.max(peakR, Math.abs(right[i]));
  }
  return { peakL, peakR };
}

function runBlocks(count: number): { peakL: number; peakR: number } {
  let last = { peakL: 0, peakR: 0 };
  for (let b = 0; b < count; b++) last = runBlock();
  return last;
}

describe("engine worklet processor", () => {
  it("writes silence to every sample while no graph has arrived", () => {
    const { peakL, peakR } = runBlock();
    expect(peakL).toBe(0);
    expect(peakR).toBe(0);
  });

  it("fades in after the first graph message and reaches steady sine output", () => {
    send({ type: "graph", graph: sineToOutputGraph() });

    const first = runBlock();
    expect(first.peakL).toBeLessThan(0.1); // fade starts near silence

    const steady = runBlocks(30); // well past the ~30 ms fade
    expect(steady.peakL).toBeGreaterThan(0.3); // ≈ tanh(1) × 0.8 at crest
    expect(steady.peakR).toBeGreaterThan(0.3); // mono-normalized to both sides
  });

  it("fades out, swaps, and fades back in on a graph replacement", () => {
    send({ type: "graph", graph: sineToOutputGraph() });
    runBlocks(30);

    send({ type: "graph", graph: sineToOutputGraph(1) });

    // Fade-out: within ~15 blocks (30 ms + slack) a near-silent trough block.
    let trough = Number.POSITIVE_INFINITY;
    for (let b = 0; b < 15; b++) trough = Math.min(trough, runBlock().peakL);
    expect(trough).toBeLessThan(0.02);

    // Fade-in of the new interpreter completes.
    const steady = runBlocks(30);
    expect(steady.peakL).toBeGreaterThan(0.3);
  });

  it("routes param messages to the running interpreter", () => {
    send({ type: "graph", graph: sineToOutputGraph() });
    runBlocks(30);

    send({ type: "param", instanceId: "inst-out", controlName: "Level", value: 0 });

    const after = runBlocks(60); // param smoothing ~10 ms
    expect(after.peakL).toBeLessThan(0.01);
  });

  it("ignores param messages for unknown targets", () => {
    send({ type: "graph", graph: sineToOutputGraph() });
    runBlocks(30);

    send({ type: "param", instanceId: "nope", controlName: "Level", value: 0 });
    send({ type: "param", instanceId: "inst-out", controlName: "Nope", value: 0 });

    const after = runBlocks(10);
    expect(after.peakL).toBeGreaterThan(0.3);
  });

  it("clears to silence on a stop message and fades a later graph in fresh", () => {
    send({ type: "graph", graph: sineToOutputGraph() });
    runBlocks(30);

    send({ type: "stop" });

    const cleared = runBlock();
    expect(cleared.peakL).toBe(0);
    expect(cleared.peakR).toBe(0);

    // A later graph starts from silence and fades in — no stale interpreter
    // at full gain.
    send({ type: "graph", graph: sineToOutputGraph() });
    const first = runBlock();
    expect(first.peakL).toBeLessThan(0.1);
    const steady = runBlocks(30);
    expect(steady.peakL).toBeGreaterThan(0.3);
  });

  it("posts throttled, instanceId-keyed sequencer-step telemetry", () => {
    const posted: { ids: string[]; steps: number[] }[] = [];
    proc.port.postMessage = (m) => {
      // Snapshot: the worklet reuses the message object and its buffers.
      const msg = m as { ids: string[]; steps: Int32Array };
      posted.push({ ids: [...msg.ids], steps: [...msg.steps] });
    };
    send({ type: "graph", graph: clockSequencerGraph() });

    // Report interval ≈ 0.03·SR = 1440 samples ≈ 12 blocks; run past it.
    runBlocks(15);

    expect(posted.length).toBeGreaterThanOrEqual(1);
    expect(posted[0].ids).toEqual(["seq"]);
    expect(posted[0].steps).toEqual([0]); // step 0 latched on the downbeat
  });

  it("posts throttled, instanceId-keyed gate telemetry on its own channel", () => {
    const posted: { type: string; ids: string[]; gates: number[] }[] = [];
    proc.port.postMessage = (m) => {
      const msg = m as { type: string; ids: string[]; gates: Int32Array };
      if (msg.type !== "gates") return;
      // Snapshot: the worklet reuses the message object and its buffers.
      posted.push({ type: msg.type, ids: [...msg.ids], gates: [...msg.gates] });
    };
    send({ type: "graph", graph: clockDividerGraph() });

    runBlocks(15); // past the ~12-block report interval

    expect(posted.length).toBeGreaterThanOrEqual(1);
    expect(posted[0].ids).toEqual(["div"]);
    // Downbeat: all seven outputs high → every bit set.
    expect(posted[0].gates).toEqual([0b1111111]);
  });

  it("posts steps and gates as separate messages when a graph has both", () => {
    const types: string[] = [];
    proc.port.postMessage = (m) => {
      types.push((m as { type: string }).type);
    };
    send({ type: "graph", graph: clockSequencerDividerGraph() });

    runBlocks(15);

    expect(types).toContain("steps");
    expect(types).toContain("gates");
  });

  it("posts no gate telemetry for a graph with no gate-reporting node", () => {
    const types: string[] = [];
    proc.port.postMessage = (m) => {
      types.push((m as { type: string }).type);
    };
    send({ type: "graph", graph: clockSequencerGraph() });

    runBlocks(15);

    expect(types).toContain("steps");
    expect(types).not.toContain("gates");
  });

  it("stops posting gate telemetry after a stop message", () => {
    send({ type: "graph", graph: clockDividerGraph() });
    runBlocks(15);

    send({ type: "stop" });
    const after: string[] = [];
    proc.port.postMessage = (m) => {
      after.push((m as { type: string }).type);
    };
    runBlocks(30);

    expect(after).not.toContain("gates");
  });

  it("keeps rendering audio when a gate postMessage throws", () => {
    proc.port.postMessage = () => {
      throw new Error("port closed");
    };
    send({ type: "graph", graph: clockDividerGraph() });
    for (let b = 0; b < 20; b++) {
      expect(proc.process([], [[left, right]], {})).toBe(true);
    }
  });

  it("keeps rendering audio when a step postMessage throws", () => {
    proc.port.postMessage = () => {
      throw new Error("port closed");
    };
    send({ type: "graph", graph: clockSequencerGraph() });
    // Well past the report interval, so a post is attempted (and swallowed).
    for (let b = 0; b < 20; b++) {
      expect(proc.process([], [[left, right]], {})).toBe(true);
    }
  });

  it("handles a mono output array without crashing and still writes audio", () => {
    send({ type: "graph", graph: sineToOutputGraph() });

    let peak = 0;
    const mono = new Float32Array(BLOCK_FRAMES);
    for (let b = 0; b < 30; b++) {
      mono.fill(123);
      expect(proc.process([], [[mono]], {})).toBe(true);
      peak = 0;
      for (let i = 0; i < BLOCK_FRAMES; i++) peak = Math.max(peak, Math.abs(mono[i]));
    }
    expect(peak).toBeGreaterThan(0.3);
  });
});
