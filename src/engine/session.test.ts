// Tests for the instance-based engine runtime: createEngine() against a
// mocked AudioContext/AudioWorkletNode (no real Web Audio available under
// Node). Covers the lifecycle and host/routing contracts documented in
// docs/architecture.md, "Runtime lifecycle".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "./session";
import type { Patch } from "./patch";
import type { EngineGraph } from "./graph";

const playablePatch: Patch = {
  modules: [
    { id: "osc", type: "oscillator" },
    { id: "out", type: "audio-output" },
  ],
  connections: [{ from: ["osc", "Saw"], to: ["out", "L In"] }],
};

class MockAudioContext {
  state = "running";
  destination = { kind: "destination" };
  audioWorklet = { addModule: vi.fn(() => Promise.resolve()) };
  resume = vi.fn(() => Promise.resolve());
  suspend = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());
}

class MockAudioWorkletNode {
  static instances: MockAudioWorkletNode[] = [];
  port = {
    postMessage: vi.fn(),
    onmessage: null as ((e: MessageEvent) => void) | null,
  };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(
    public context: unknown,
    public processorName: string,
  ) {
    MockAudioWorkletNode.instances.push(this);
  }
}

function emitSteps(node: MockAudioWorkletNode, ids: string[], steps: number[]): void {
  node.port.onmessage!({
    data: { type: "steps", ids, steps: Int32Array.from(steps) },
  } as unknown as MessageEvent);
}

function emitGates(node: MockAudioWorkletNode, ids: string[], gates: number[]): void {
  node.port.onmessage!({
    data: { type: "gates", ids, gates: Int32Array.from(gates) },
  } as unknown as MessageEvent);
}

function emitControlFlags(node: MockAudioWorkletNode, ids: string[], controlFlags: number[]): void {
  node.port.onmessage!({
    data: { type: "controlFlags", ids, controlFlags: Int32Array.from(controlFlags) },
  } as unknown as MessageEvent);
}

describe("createEngine", () => {
  beforeEach(() => {
    MockAudioWorkletNode.instances = [];
    vi.stubGlobal("AudioWorkletNode", MockAudioWorkletNode);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates one AudioWorkletNode as its output and never touches destination/close/suspend", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);

    expect(MockAudioWorkletNode.instances).toHaveLength(1);
    expect(engine.output).toBe(MockAudioWorkletNode.instances[0]);
    expect(ctx.close).not.toHaveBeenCalled();
    expect(ctx.suspend).not.toHaveBeenCalled();
  });

  it("load/start/stop drive the worklet protocol; start() never resurrects a stopped graph mid-swap", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    const node = MockAudioWorkletNode.instances[0];

    const { loaded } = engine.load(playablePatch);
    expect(loaded).toBe(true);
    expect(node.port.postMessage).not.toHaveBeenCalled(); // not started yet

    engine.start();
    expect(node.port.postMessage).toHaveBeenCalledTimes(1);
    expect(node.port.postMessage.mock.calls[0][0].type).toBe("graph");

    engine.stop();
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ type: "stop" });

    engine.start();
    expect(node.port.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "graph" }),
    );
  });

  it("load() with a caller-supplied graph skips recompilation and posts that graph as-is", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    const node = MockAudioWorkletNode.instances[0];

    // A graph that could not have come from compiling `playablePatch` (wrong
    // node count) proves load() used it verbatim instead of recompiling.
    const suppliedGraph: EngineGraph = {
      nodes: [{ instanceId: "only-node", slug: "oscillator", params: [] }],
      edges: [],
      outputNodes: [],
    };

    const { loaded, diagnostics } = engine.load(playablePatch, suppliedGraph);
    expect(loaded).toBe(true);
    expect(diagnostics).toEqual([]);

    engine.start();
    expect(node.port.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "graph",
      graph: suppliedGraph,
    });
  });

  it("load() with a structurally ambiguous patch (loaded: false) never posts to the worklet and never overwrites the last good graph", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    const node = MockAudioWorkletNode.instances[0];

    engine.load(playablePatch);
    engine.start();
    expect(node.port.postMessage).toHaveBeenCalledTimes(1);
    const goodGraphMessage = node.port.postMessage.mock.calls[0][0];

    // A duplicate module id referenced by a connection — resolvePatch
    // (diagnostics.ts) rejects the whole load rather than guessing.
    const ambiguousPatch: Patch = {
      modules: [
        { id: "osc", type: "oscillator" },
        { id: "osc", type: "oscillator" },
        { id: "out", type: "audio-output" },
      ],
      connections: [{ from: ["osc", "Saw"], to: ["out", "L In"] }],
    };
    const { loaded } = engine.load(ambiguousPatch);
    expect(loaded).toBe(false);
    // Still running the last good graph — no new postMessage, no stop.
    expect(node.port.postMessage).toHaveBeenCalledTimes(1);

    // Confirms lastGraph was never overwritten either: a stop()+start()
    // cycle re-posts the original good graph, not the rejected one.
    engine.stop();
    engine.start();
    expect(node.port.postMessage).toHaveBeenLastCalledWith(goodGraphMessage);
  });

  it("setParam posts a param message with engine-unit values verbatim", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    const node = MockAudioWorkletNode.instances[0];

    engine.setParam("osc", "Freq", 440);

    expect(node.port.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "param",
      instanceId: "osc",
      controlName: "Freq",
      value: 440,
    });
  });

  it("dispose() disconnects output, drops listeners, and leaves the context alone", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    const node = MockAudioWorkletNode.instances[0];

    const cb = vi.fn();
    engine.onSteps(cb);
    engine.dispose();

    expect(node.disconnect).toHaveBeenCalledTimes(1);
    // The port handler is cleared, so a worklet message arriving after
    // dispose reaches no subscriber (there is nothing left to invoke it).
    expect(node.port.onmessage).toBeNull();
    expect(ctx.close).not.toHaveBeenCalled();
    expect(ctx.suspend).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
  });

  it("throws on use after dispose", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    engine.dispose();

    expect(() => engine.load(playablePatch)).toThrow();
    expect(() => engine.start()).toThrow();
    expect(() => engine.stop()).toThrow();
    expect(() => engine.setParam("osc", "Freq", 1)).toThrow();
    expect(() => engine.onSteps(() => {})).toThrow();
    expect(() => engine.dispose()).not.toThrow(); // dispose stays idempotent
  });

  it("onSteps fans worklet step telemetry out to every subscriber and supports unsubscribe", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    const node = MockAudioWorkletNode.instances[0];

    const a = vi.fn();
    const b = vi.fn();
    engine.onSteps(a);
    const unsubB = engine.onSteps(b);

    emitSteps(node, ["seq"], [2]);
    expect(a).toHaveBeenCalledWith({ seq: 2 });
    expect(b).toHaveBeenCalledWith({ seq: 2 });

    unsubB();
    emitSteps(node, ["seq"], [3]);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1); // unsubscribed — no second call
  });

  it("onGates fans worklet gate telemetry out to every subscriber and supports unsubscribe", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    const node = MockAudioWorkletNode.instances[0];

    const a = vi.fn();
    const b = vi.fn();
    engine.onGates(a);
    const unsubB = engine.onGates(b);

    emitGates(node, ["div"], [0b1010101]);
    expect(a).toHaveBeenCalledWith({ div: 0b1010101 });
    expect(b).toHaveBeenCalledWith({ div: 0b1010101 });

    unsubB();
    emitGates(node, ["div"], [0b0000001]);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("routes steps and gates to their own subscribers only", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    const node = MockAudioWorkletNode.instances[0];

    const steps = vi.fn();
    const gates = vi.fn();
    engine.onSteps(steps);
    engine.onGates(gates);

    emitSteps(node, ["seq"], [3]);
    expect(steps).toHaveBeenCalledWith({ seq: 3 });
    expect(gates).not.toHaveBeenCalled();

    emitGates(node, ["div"], [0b11]);
    expect(gates).toHaveBeenCalledWith({ div: 0b11 });
    expect(steps).toHaveBeenCalledTimes(1);
  });

  it("onGates throws after dispose, and dispose drops gate subscribers", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    const node = MockAudioWorkletNode.instances[0];

    const cb = vi.fn();
    engine.onGates(cb);
    engine.dispose();

    expect(() => engine.onGates(() => {})).toThrow();
    // The port handler is detached, so nothing can reach a stale subscriber.
    expect(node.port.onmessage).toBeNull();
    expect(cb).not.toHaveBeenCalled();
  });

  it("two engines on one context share one worklet load but never cross-talk", async () => {
    const ctx = new MockAudioContext();
    const a = await createEngine(ctx as unknown as AudioContext);
    const b = await createEngine(ctx as unknown as AudioContext);

    expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(MockAudioWorkletNode.instances).toHaveLength(2);
    const [nodeA, nodeB] = MockAudioWorkletNode.instances;
    expect(nodeA).not.toBe(nodeB);

    a.load(playablePatch);
    a.start();
    expect(nodeA.port.postMessage).toHaveBeenCalledTimes(1);
    expect(nodeB.port.postMessage).not.toHaveBeenCalled();

    const stepsA = vi.fn();
    const stepsB = vi.fn();
    a.onSteps(stepsA);
    b.onSteps(stepsB);
    emitSteps(nodeA, ["from-a"], [5]);
    expect(stepsA).toHaveBeenCalledWith({ "from-a": 5 });
    expect(stepsB).not.toHaveBeenCalled();

    b.stop();
    expect(nodeA.port.postMessage).toHaveBeenCalledTimes(1); // unaffected by b
    expect(nodeB.port.postMessage).toHaveBeenLastCalledWith({ type: "stop" });
  });

  it("retries worklet loading on the next createEngine() call after addModule rejects", async () => {
    const ctx = new MockAudioContext();
    let attempts = 0;
    ctx.audioWorklet.addModule = vi.fn(() => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error("load failed")) : Promise.resolve();
    });

    await expect(createEngine(ctx as unknown as AudioContext)).rejects.toThrow("load failed");
    expect(MockAudioWorkletNode.instances).toHaveLength(0);

    const engine = await createEngine(ctx as unknown as AudioContext);
    expect(attempts).toBe(2);
    expect(MockAudioWorkletNode.instances).toHaveLength(1);
    expect(engine.output).toBeDefined();
  });
});


describe("createEngine — control-flag telemetry", () => {
  beforeEach(() => {
    MockAudioWorkletNode.instances = [];
    vi.stubGlobal("AudioWorkletNode", MockAudioWorkletNode);
  });

  it("fans control-flag telemetry out to every subscriber and supports unsubscribe", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    const node = MockAudioWorkletNode.instances[0];

    const a = vi.fn();
    const b = vi.fn();
    engine.onControlFlags(a);
    const unsubB = engine.onControlFlags(b);

    emitControlFlags(node, ["fg"], [0b1000]);
    expect(a).toHaveBeenCalledWith({ fg: 0b1000 });
    expect(b).toHaveBeenCalledWith({ fg: 0b1000 });

    unsubB();
    emitControlFlags(node, ["fg"], [0]);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("keeps the three channels' subscribers separate", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    const node = MockAudioWorkletNode.instances[0];

    const gates = vi.fn();
    const controlFlags = vi.fn();
    engine.onGates(gates);
    engine.onControlFlags(controlFlags);

    emitControlFlags(node, ["fg"], [0b1000]);
    expect(controlFlags).toHaveBeenCalledTimes(1);
    expect(gates).not.toHaveBeenCalled();

    emitGates(node, ["div"], [0b11]);
    expect(gates).toHaveBeenCalledTimes(1);
    expect(controlFlags).toHaveBeenCalledTimes(1);
  });

  it("stops delivering after dispose", async () => {
    const ctx = new MockAudioContext();
    const engine = await createEngine(ctx as unknown as AudioContext);
    const node = MockAudioWorkletNode.instances[0];
    const cb = vi.fn();
    engine.onControlFlags(cb);

    engine.dispose();
    expect(node.port.onmessage).toBeNull();
    expect(cb).not.toHaveBeenCalled();
  });
});
