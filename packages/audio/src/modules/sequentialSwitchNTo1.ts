// Sequential Switch N→1 kernel for slug "sequential-switch-n-to-1".
//
// Routes one of up to 4 inputs through to a single output. The active source
// advances one step per `Clk` rising edge (standard Schmitt: fire >=
// GATE_FIRE_THRESHOLD_V, re-arm below GATE_REARM_THRESHOLD_V) — forward-only
// and wrapping within `Steps` — unless `Sel` is patched (see below). `Out`
// carries only the active input; every other input is ignored for that
// sample. This is a pure DC-coupled router (no gain, no clipping, no mixing
// of the inactive inputs) — the mirror image of `sequential-switch-1-to-n`.
//
// `Steps` (knob, 1..4, rounded, default 4 = all four inputs in rotation):
// selects how many of the 4 inputs are in the active pool, starting from
// In 1. All the way left (`Steps` = 1) pins the route to In 1 permanently —
// there is only one source in the pool, so nothing ever switches away from
// it, regardless of Clk/Sel activity. All the way right (`Steps` = 4) rotates
// through all four inputs. `Steps` is sampled once per block (like
// `sequencer`'s `Len`); the active step is clamped into the current pool
// immediately (not just on the next edge), so shrinking `Steps` takes effect
// at once even without a fresh Clk edge.
//
// `Rst` (Schmitt rising edge): returns the active step to In 1 and re-arms
// the first-edge latch, so the next Clk edge re-latches In 1 (not advance
// past it). Reset repositions only — it does not itself move a sample of any
// input to `Out`.
//
// `Sel` (external step-select address CV, sampled on the `Clk` edge): when
// patched, `Sel` takes priority over the first-edge latch — *every* Clk edge,
// including the first after init/reset, addresses the active input directly
// via `clamp(floor(selVolts / CV_UNIPOLAR_MAX * Steps), 0, Steps - 1)`, the
// same 0..10 V → active-pool mapping `sequencer`'s `Sel` uses. A non-finite
// Sel sample reads as 0 V (In 1) for that edge. Unpatched Sel preserves plain
// forward rotation.
//
// Unpatched Clk never advances; unpatched Rst never resets; an unpatched (or
// currently inactive) input reads as 0 V on `Out`. Non-finite In<n>/Clk/Rst/
// Sel samples are safe (read as 0 V / no effect).
//
// Jack/param layout (registry declaration order):
//   ins[0..3] = In 1..In 4   ins[4] = Clk   ins[5] = Rst   ins[6] = Sel
//   outs[0] = Out
//   params[0] = Steps

import type { Kernel } from "../engine/kernel";
import { GATE_FIRE_THRESHOLD_V, GATE_REARM_THRESHOLD_V, CV_UNIPOLAR_MAX } from "../engine/units";

const STEP_COUNT = 4;

interface SequentialSwitchNTo1State {
  step: number; // active input index, always in [0, STEP_COUNT)
  firstEdge: boolean; // next clock edge latches step 0 instead of advancing
  clkHigh: boolean; // Schmitt state of the Clk input
  rstHigh: boolean; // Schmitt state of the Rst input
}

export const sequentialSwitchNTo1Kernel: Kernel<SequentialSwitchNTo1State> = {
  init(_sr): SequentialSwitchNTo1State {
    return {
      step: 0,
      firstEdge: true,
      clkHigh: false,
      rstHigh: false,
    };
  },

  process(state, ins, outs, params, n) {
    const inClk = ins[STEP_COUNT];
    const inRst = ins[STEP_COUNT + 1];
    const inSel = ins[STEP_COUNT + 2];
    const outOut = outs[0];

    // Active pool size: rounded, clamped to [1, STEP_COUNT]; non-finite -> full pool.
    let steps = params[0];
    if (!Number.isFinite(steps)) steps = STEP_COUNT;
    else {
      steps = Math.round(steps);
      if (steps < 1) steps = 1;
      else if (steps > STEP_COUNT) steps = STEP_COUNT;
    }

    let step = state.step;
    if (step >= steps) step = steps - 1; // pool shrank: pin into the new range immediately
    let firstEdge = state.firstEdge;
    let clkHigh = state.clkHigh;
    let rstHigh = state.rstHigh;

    for (let i = 0; i < n; i++) {
      // Reset first: Schmitt rising edge -> In 1, re-arm first-edge latch.
      // Non-finite reads as 0 V (low).
      let rstV = 0;
      if (inRst !== null) {
        const v = inRst[i];
        if (Number.isFinite(v)) rstV = v;
      }
      if (!rstHigh && rstV >= GATE_FIRE_THRESHOLD_V) {
        rstHigh = true;
        step = 0;
        firstEdge = true;
      } else if (rstHigh && rstV < GATE_REARM_THRESHOLD_V) {
        rstHigh = false;
      }

      // Clock: Schmitt rising edge advances the active step. Non-finite reads as low.
      let clkV = 0;
      if (inClk !== null) {
        const v = inClk[i];
        if (Number.isFinite(v)) clkV = v;
      }
      if (!clkHigh && clkV >= GATE_FIRE_THRESHOLD_V) {
        clkHigh = true;
        if (inSel !== null) {
          // Sel patched: address the active step directly, on every edge
          // (including the first) — takes priority over the first-edge latch.
          let selV = inSel[i];
          if (!Number.isFinite(selV)) selV = 0;
          let idx = Math.floor((selV / CV_UNIPOLAR_MAX) * steps);
          if (idx < 0) idx = 0;
          else if (idx > steps - 1) idx = steps - 1;
          step = idx;
          firstEdge = false;
        } else if (firstEdge) {
          firstEdge = false; // latch In 1 (no advance, not a rotation)
        } else {
          step = (step + 1) % steps;
        }
      } else if (clkHigh && clkV < GATE_REARM_THRESHOLD_V) {
        clkHigh = false;
      }

      // Route the active input to Out; a null/non-finite active input reads as 0 V.
      const active = ins[step];
      let v = 0;
      if (active !== null) {
        const activeV = active[i];
        if (Number.isFinite(activeV)) v = activeV;
      }
      outOut[i] = v;
    }

    state.step = step;
    state.firstEdge = firstEdge;
    state.clkHigh = clkHigh;
    state.rstHigh = rstHigh;
  },
};
