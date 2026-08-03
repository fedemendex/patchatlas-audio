// Instance-based browser engine runtime (#285). This is the extraction's cut
// line (docs/audio/extraction-plan.md §5): everything createEngine touches —
// worklet loading, the AudioWorkletNode, graph compilation/messaging,
// transport state, step subscriptions — is package-owned and DOM/host
// agnostic. Everything on the other side of the line stays in PatchAtlas: the
// host creates and owns the AudioContext (resume/suspend/close) and all
// routing, including `engine.output.connect(context.destination)`. The
// engine must never touch context.destination or call close()/suspend() on a
// context it did not create; several engines may share one context.
//
// `workletUrl` default (#287): resolved relative to this module's own URL,
// not a bundler-specific import. tsdown bundles src/index.ts into one
// dist/index.js file, so at runtime `import.meta.url` here is dist/index.js's
// own URL regardless of where this source line originated — "./worklet.js"
// therefore always resolves to dist/worklet.js, the package's other build
// entry, matching the "./worklet.js" subpath in package.json's exports map.

import { compilePatch } from "./compile";
import type { Diagnostic } from "./diagnostics";
import type { EngineGraph } from "./graph";
import type { Patch } from "./patch";
import { registry } from "../modules/registry";
import type { EngineHostMessage, EngineWorkletMessage } from "../worklet/protocol";

const defaultWorkletUrl = new URL("./worklet.js", import.meta.url).href;

export interface EngineOptions {
  workletUrl?: string;
}

export interface Engine {
  readonly output: AudioNode;
  /**
   * Compiles `patch` and loads the result, unless `graph` is supplied — then
   * that pre-compiled graph is trusted and used as-is (no recompilation),
   * for a caller (e.g. a dry-run) that already ran compilePatch(patch, ...)
   * itself. `graph` must actually be patch's compiled graph; nothing here
   * re-checks that, and `diagnostics` is empty in that case since the
   * caller's own compile already produced them.
   */
  load(patch: Patch, graph?: EngineGraph): { loaded: boolean; diagnostics: Diagnostic[] };
  setParam(moduleId: string, param: string, value: number): void;
  start(): void;
  stop(): void;
  onSteps(cb: (steps: Record<string, number>) => void): () => void;
  dispose(): void;
}

// Worklet module registration is per-AudioContext, not per-Engine, so two
// engines sharing one context never double-register it. A failed load is
// evicted so the next createEngine() on that context retries from scratch —
// the instance-based equivalent of the old module-level
// `workletModuleReady = null` reset.
const workletReadyByContext = new WeakMap<AudioContext, Promise<void>>();

async function ensureWorkletLoaded(context: AudioContext, workletUrl: string): Promise<void> {
  let ready = workletReadyByContext.get(context);
  if (!ready) {
    ready = context.audioWorklet.addModule(workletUrl);
    workletReadyByContext.set(context, ready);
  }
  try {
    await ready;
  } catch (err) {
    workletReadyByContext.delete(context);
    throw err;
  }
}

export async function createEngine(
  context: AudioContext,
  options: EngineOptions = {},
): Promise<Engine> {
  await ensureWorkletLoaded(context, options.workletUrl ?? defaultWorkletUrl);

  const node = new AudioWorkletNode(context, "engine-processor");
  const stepSubscribers = new Set<(steps: Record<string, number>) => void>();
  let lastGraph: EngineGraph | null = null;
  let started = false;
  let disposed = false;

  node.port.onmessage = (e: MessageEvent<EngineHostMessage>) => {
    const msg = e.data;
    if (msg?.type !== "steps" || !msg.ids || !msg.steps) return;
    const steps: Record<string, number> = {};
    for (let i = 0; i < msg.ids.length; i++) steps[msg.ids[i]] = msg.steps[i];
    for (const cb of stepSubscribers) cb(steps);
  };

  function post(message: EngineWorkletMessage): void {
    node.port.postMessage(message);
  }

  function assertNotDisposed(): void {
    if (disposed) throw new Error("Engine has been disposed");
  }

  return {
    output: node,

    load(patch: Patch, graph?: EngineGraph): { loaded: boolean; diagnostics: Diagnostic[] } {
      assertNotDisposed();
      const result = graph
        ? { graph, diagnostics: [] as Diagnostic[], loaded: true }
        : compilePatch(patch, registry);
      // `loaded: false` means the Patch was structurally ambiguous (a
      // duplicate module id a connection references — diagnostics.ts) and
      // `graph` was built from an arbitrarily incomplete module set; it must
      // not replace a good lastGraph or be pushed live to the worklet.
      if (result.loaded) {
        lastGraph = result.graph;
        // Only push to the worklet if transport is already running — an
        // engine loaded before start() must not resurrect sound on its own.
        if (started) post({ type: "graph", graph: result.graph });
      }
      return result;
    },

    setParam(moduleId: string, param: string, value: number): void {
      assertNotDisposed();
      post({ type: "param", instanceId: moduleId, controlName: param, value });
    },

    start(): void {
      assertNotDisposed();
      started = true;
      // stop() always clears the worklet's current interpreter first, so
      // re-posting the last-loaded graph here fades in from silence rather
      // than crossfading from (resurrecting) whatever was playing before.
      if (lastGraph) post({ type: "graph", graph: lastGraph });
    },

    stop(): void {
      assertNotDisposed();
      started = false;
      post({ type: "stop" });
    },

    onSteps(cb: (steps: Record<string, number>) => void): () => void {
      assertNotDisposed();
      stepSubscribers.add(cb);
      return () => stepSubscribers.delete(cb);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      node.port.onmessage = null;
      stepSubscribers.clear();
      node.disconnect();
    },
  };
}
