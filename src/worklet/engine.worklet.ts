// Thin AudioWorklet host over the pure engine. Owns an Interpreter | null;
// graphs are compiled on the main thread and arrive whole via postMessage —
// this file never sees a Patch or any host type, and imports only pure
// engine TS (no DOM, no framework, no network).
//
// Graph swaps fade the current output to silence (~30 ms), swap interpreters,
// then fade back in. Voices restart; no state carry-over — a deliberate
// product decision. Interpreter construction happens in the message handler
// (between process calls); the steady-state process() path allocates nothing.

import type { EngineGraph } from "../engine/graph";
import { Interpreter } from "../engine/interpreter";
import { BLOCK_FRAMES } from "../engine/units";
import { registry } from "../modules/registry";
import type { EngineWorkletMessage, EngineHostMessage } from "./protocol";

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

/** How often the worklet reports UI telemetry (steps, gates) to the host (~33 Hz). */
const TELEMETRY_REPORT_SECONDS = 0.03;

/**
 * Per-interpreter telemetry scratch, one per channel: reused buffers, no
 * per-block alloc. `last` starts at -1, which is not a valid step index nor a
 * valid gate bitmask, so the first read of either channel always counts as a
 * change and posts an initial value.
 */
interface TelemetryConfig {
  ids: string[];
  buf: Int32Array; // current values, filled by readSteps/readGates
  last: Int32Array; // last posted values, for change detection
}

function makeTelemetryConfig(ids: string[]): TelemetryConfig | null {
  if (ids.length === 0) return null;
  return { ids, buf: new Int32Array(ids.length), last: new Int32Array(ids.length).fill(-1) };
}

/** Whether any value changed since the last post; updates `last` in place. */
function telemetryChanged(cfg: TelemetryConfig): boolean {
  let changed = false;
  for (let k = 0; k < cfg.buf.length; k++) {
    if (cfg.buf[k] !== cfg.last[k]) {
      cfg.last[k] = cfg.buf[k];
      changed = true;
    }
  }
  return changed;
}

class EngineProcessor extends AudioWorkletProcessor {
  private current: Interpreter | null = null;
  private pending: Interpreter | null = null;
  /** Output gain, ramped per sample toward 0 (swap pending) or 1. */
  private gain = 0;
  private readonly gainStep: number;
  private readonly left: Float32Array;
  private readonly right: Float32Array;

  // Telemetry: current/pending configs track their interpreter through the
  // swap; both channels share one throttle counter so they post on the same
  // tick. The message objects are reused (postMessage structured-clones them).
  private currentSteps: TelemetryConfig | null = null;
  private pendingSteps: TelemetryConfig | null = null;
  private currentGates: TelemetryConfig | null = null;
  private pendingGates: TelemetryConfig | null = null;
  private telemetryPostSamples = 0;
  private readonly telemetryPostInterval: number;
  private readonly stepMsg: EngineHostMessage;
  private readonly gateMsg: EngineHostMessage;

  constructor() {
    super();
    this.gainStep = 1 / (sampleRate * GRAPH_FADE_SECONDS);
    this.left = new Float32Array(BLOCK_FRAMES);
    this.right = new Float32Array(BLOCK_FRAMES);
    this.telemetryPostInterval = Math.max(1, Math.round(sampleRate * TELEMETRY_REPORT_SECONDS));
    this.stepMsg = { type: "steps", ids: [], steps: new Int32Array(0) };
    this.gateMsg = { type: "gates", ids: [], gates: new Int32Array(0) };
    this.port.onmessage = (e: MessageEvent<EngineWorkletMessage>) => {
      const msg = e.data;
      if (msg.type === "graph") {
        this.acceptGraph(msg.graph);
      } else if (msg.type === "stop") {
        // The node is disconnected around this message, so an instant cut
        // (no fade) is inaudible; the next graph fades in from silence.
        this.current = null;
        this.pending = null;
        this.currentSteps = null;
        this.pendingSteps = null;
        this.currentGates = null;
        this.pendingGates = null;
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
      // current one. The compiler + the shared registry make this unreachable
      // in practice.
      return;
    }
    if (this.current === null) {
      this.current = interpreter;
      this.currentSteps = makeTelemetryConfig(interpreter.stepReportIds);
      this.currentGates = makeTelemetryConfig(interpreter.gateReportIds);
      this.telemetryPostSamples = 0;
      this.gain = 0; // fade in from silence
    } else {
      this.pending = interpreter; // fade out, then swap in process()
      this.pendingSteps = makeTelemetryConfig(interpreter.stepReportIds);
      this.pendingGates = makeTelemetryConfig(interpreter.gateReportIds);
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
      this.currentSteps = this.pendingSteps;
      this.pendingSteps = null;
      this.currentGates = this.pendingGates;
      this.pendingGates = null;
      this.telemetryPostSamples = 0;
    }

    // Throttled UI telemetry: read each channel and post only when a value
    // changed. Allocation-free — the message objects and their buffers are
    // reused; postMessage structured-clones them. `interp` is re-read from
    // this.current AFTER the swap above so it and the configs are the same
    // generation. One counter drives both channels, so a graph carrying both
    // a sequencer and a divider posts them on the same tick.
    const stepCfg = this.currentSteps;
    const gateCfg = this.currentGates;
    const interp = this.current;
    if (interp !== null && (stepCfg !== null || gateCfg !== null)) {
      this.telemetryPostSamples += n;
      if (this.telemetryPostSamples >= this.telemetryPostInterval) {
        this.telemetryPostSamples = 0;
        if (stepCfg !== null) {
          interp.readSteps(stepCfg.buf);
          if (telemetryChanged(stepCfg)) {
            this.stepMsg.ids = stepCfg.ids;
            (this.stepMsg as { steps: Int32Array }).steps = stepCfg.buf;
            this.postTelemetry(this.stepMsg);
          }
        }
        if (gateCfg !== null) {
          interp.readGates(gateCfg.buf);
          if (telemetryChanged(gateCfg)) {
            this.gateMsg.ids = gateCfg.ids;
            (this.gateMsg as { gates: Int32Array }).gates = gateCfg.buf;
            this.postTelemetry(this.gateMsg);
          }
        }
      }
    }

    return true;
  }

  /** Telemetry is best-effort: a failed post must never stop audio. */
  private postTelemetry(msg: EngineHostMessage): void {
    try {
      this.port.postMessage(msg);
    } catch {
      // swallow — the next change will try again
    }
  }
}

registerProcessor("engine-processor", EngineProcessor);
