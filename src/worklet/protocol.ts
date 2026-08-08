// Message protocol between createEngine (main thread, engine/session.ts) and
// the engine worklet processor. Internal — not exported from src/index.ts.
// Types only: this module must stay erasable so neither side pulls runtime
// code across the boundary.

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

// Worklet → host. Throttled UI telemetry, posted only when a value changed.
// Both variants align their value array with `ids` by index.
export type EngineHostMessage =
  | {
      /** Live current step of every step-reporting node (sequencers). */
      type: "steps";
      ids: string[];
      steps: Int32Array;
    }
  | {
      /**
       * Live output bitmask of every gate-reporting node (clock-divider-2):
       * bit k set while that node's outJacks[k] is high. Drives panel LEDs.
       */
      type: "gates";
      ids: string[];
      gates: Int32Array;
    };
