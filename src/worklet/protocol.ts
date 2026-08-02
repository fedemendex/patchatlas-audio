// Message protocol between useAudioEngine (main thread) and the engine
// worklet processor. Types only — this module must stay erasable so neither
// side pulls runtime code across the boundary.

import type { EngineGraph } from "../engine/graph";

export type EngineWorkletMessage =
  | {
      /** Swap to a freshly compiled graph (fade out → rebuild → fade in). */
      type: "graph";
      graph: EngineGraph;
    }
  | {
      /** Live param update in engine units; unknown targets are a no-op. */
      type: "param";
      instanceId: string;
      controlName: string;
      value: number;
    }
  | {
      /**
       * Drop the current interpreter and go silent. Sent on Stop and on the
       * running→unplayable transition, so a reused node never resurrects a
       * stale graph at full gain when the next play connects it.
       */
      type: "stop";
    };

// Worklet → host. Throttled UI telemetry; carries the live current step of
// every step-reporting node (sequencers), aligned by index with `ids`.
export type EngineHostMessage = {
  type: "steps";
  ids: string[];
  steps: Int32Array;
};
