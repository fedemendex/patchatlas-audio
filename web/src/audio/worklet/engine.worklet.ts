// Thin AudioWorklet host over the pure engine (AP-7). Owns an
// Interpreter | null; graphs are compiled on the main thread and arrive whole
// via postMessage — this file never sees a PatchDraftDoc and imports only
// pure engine TS (no React, no DOM, no api.ts).
//
// Graph swaps fade the current output to silence (~30 ms), swap interpreters,
// then fade back in. Voices restart; no state carry-over — a deliberate
// product decision. Interpreter construction happens in the message handler
// (between process calls); the steady-state process() path allocates nothing.

import type { EngineGraph } from "../engine/graph";
import { Interpreter } from "../engine/interpreter";
import { BLOCK_FRAMES } from "../engine/units";
import { registry } from "../modules/registry";
import type { EngineWorkletMessage } from "./protocol";

// AudioWorkletGlobalScope — not declared in TypeScript's DOM lib
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor
): void;

/** Fade-out/fade-in length for graph swaps. Host plumbing, not signal tuning. */
const GRAPH_FADE_SECONDS = 0.03;

class EngineProcessor extends AudioWorkletProcessor {
  private current: Interpreter | null = null;
  private pending: Interpreter | null = null;
  /** Output gain, ramped per sample toward 0 (swap pending) or 1. */
  private gain = 0;
  private readonly gainStep: number;
  private readonly left: Float32Array;
  private readonly right: Float32Array;

  constructor() {
    super();
    this.gainStep = 1 / (sampleRate * GRAPH_FADE_SECONDS);
    this.left = new Float32Array(BLOCK_FRAMES);
    this.right = new Float32Array(BLOCK_FRAMES);
    this.port.onmessage = (e: MessageEvent<EngineWorkletMessage>) => {
      const msg = e.data;
      if (msg.type === "graph") {
        this.acceptGraph(msg.graph);
      } else if (msg.type === "stop") {
        // The node is disconnected around this message, so an instant cut
        // (no fade) is inaudible; the next graph fades in from silence.
        this.current = null;
        this.pending = null;
        this.gain = 0;
      } else if (msg.type === "param") {
        // Route to both: `current` keeps sounding right until the swap, and a
        // `pending` interpreter must not start with a stale value. Unknown
        // targets are a no-op inside setParam.
        this.current?.setParam(msg.instanceId, msg.controlName, msg.value);
        this.pending?.setParam(msg.instanceId, msg.controlName, msg.value);
      }
    };
  }

  private acceptGraph(graph: EngineGraph): void {
    let interpreter: Interpreter;
    try {
      interpreter = new Interpreter(graph, registry, sampleRate);
    } catch {
      // A malformed graph must not kill the processor; keep playing the
      // current one. compileGraph + the shared registry make this unreachable
      // in practice.
      return;
    }
    if (this.current === null) {
      this.current = interpreter;
      this.gain = 0; // fade in from silence
    } else {
      this.pending = interpreter; // fade out, then swap in process()
    }
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const ch0 = output[0];
    const ch1 = output.length > 1 ? output[1] : null;
    let n = ch0.length;
    if (n > BLOCK_FRAMES) n = BLOCK_FRAMES;

    const current = this.current;
    if (current === null) {
      for (let i = 0; i < n; i++) ch0[i] = 0;
      if (ch1 !== null) for (let i = 0; i < n; i++) ch1[i] = 0;
      return true;
    }

    current.runBlock(n);
    current.readOutput(this.left, this.right, n);

    // Ramp toward 0 while a pending interpreter waits, else toward 1.
    const target = this.pending !== null ? 0 : 1;
    const step = this.gainStep;
    let gain = this.gain;
    const left = this.left;
    const right = this.right;
    if (ch1 !== null) {
      for (let i = 0; i < n; i++) {
        if (gain < target) {
          gain += step;
          if (gain > target) gain = target;
        } else if (gain > target) {
          gain -= step;
          if (gain < target) gain = target;
        }
        ch0[i] = left[i] * gain;
        ch1[i] = right[i] * gain;
      }
    } else {
      // Mono destination: mix L/R equally.
      for (let i = 0; i < n; i++) {
        if (gain < target) {
          gain += step;
          if (gain > target) gain = target;
        } else if (gain > target) {
          gain -= step;
          if (gain < target) gain = target;
        }
        ch0[i] = (left[i] + right[i]) * 0.5 * gain;
      }
    }
    this.gain = gain;

    // Fade-out complete → swap; next blocks fade the new interpreter in.
    if (this.pending !== null && gain === 0) {
      this.current = this.pending;
      this.pending = null;
    }

    return true;
  }
}

registerProcessor("engine-processor", EngineProcessor);
