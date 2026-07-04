// Sample & Hold kernel for slug "sample-and-hold".
//
// Two simultaneous outputs, both driven by the same Schmitt-triggered Trig
// input (fire >= GATE_FIRE_THRESHOLD_V, re-arm below GATE_REARM_THRESHOLD_V,
// both from units.ts):
//   S&H — classic sample-and-hold: on a trigger rising edge, sample In and
//         hold that value until the next rising edge.
//   T&H — track-and-hold: tracks In continuously while Trig reads high,
//         freezes at the last tracked value while Trig reads low.
//
// Trigger/sample timing convention:
//   S&H — at sample i, the trigger and input are read first; if the rising
//         edge fires at i, the held value updates to In[i] *before* either
//         output is written, so the trigger sample itself already carries
//         the newly sampled value — never one sample later.
//   T&H — tracks In[i] on every sample while Trig reads high, starting on
//         the same sample the rising edge fires (its high/low state for
//         sample i is resolved before the output is written, same as S&H).
//         On the falling edge — the sample where Trig's Schmitt state drops
//         to low — T&H freezes at the last value tracked *while high*; it
//         does not sample the falling sample's own input. Concretely, the
//         falling sample's output equals the previous sample's tracked
//         value, not In[i] at the falling sample itself.
//
// Unpatched In reads as 0 V; unpatched Trig never fires (reads as 0 V, below
// both thresholds). Non-finite In samples read as 0 V (a safe finite
// fallback) rather than propagating NaN/Inf into the held/tracked state;
// non-finite Trig samples read as 0 V (low), so they never fire and are
// indistinguishable from silence.
//
// Deferred: the seed's Slew knob is declared in the registry (so the
// seed-integrity test passes) but not read here — S&H/T&H transitions are
// instantaneous in AP-11, matching a Slew=0 (no slew) reading. A slew
// limiter on both outputs is a small, well-understood follow-up if a patch
// needs smoothed steps.
//
// Jack/param layout (seed declaration order):
//   ins[0] = In   ins[1] = Trig
//   outs[0] = S&H   outs[1] = T&H
//   params: none read (Slew declared, deferred — see above)

import type { Kernel } from "../engine/kernel";
import { GATE_FIRE_THRESHOLD_V, GATE_REARM_THRESHOLD_V } from "../engine/units";

interface SampleAndHoldState {
  heldSH: number; // S&H's held value, updated only on a trigger rising edge
  trackTH: number; // T&H's current value: tracks In while high, frozen while low
  trigHigh: boolean; // Schmitt state of the Trig input
}

export const sampleAndHoldKernel: Kernel<SampleAndHoldState> = {
  init(): SampleAndHoldState {
    return { heldSH: 0, trackTH: 0, trigHigh: false };
  },

  process(state, ins, outs, _params, n) {
    const inSig = ins[0];
    const inTrig = ins[1];
    const outSH = outs[0];
    const outTH = outs[1];

    let heldSH = state.heldSH;
    let trackTH = state.trackTH;
    let trigHigh = state.trigHigh;

    for (let i = 0; i < n; i++) {
      // Non-finite/unpatched Trig reads as 0 V (low): never fires, and if it
      // goes non-finite while high, the next sample re-arms (0 V is below
      // GATE_REARM_THRESHOLD_V) — the same "safe low" convention used by the
      // envelope generator and LFO kernels.
      let tv = 0;
      if (inTrig !== null) {
        const v = inTrig[i];
        if (Number.isFinite(v)) tv = v;
      }
      // Non-finite/unpatched In reads as 0 V — a safe finite fallback for
      // both the sampled and tracked value.
      let iv = 0;
      if (inSig !== null) {
        const v = inSig[i];
        if (Number.isFinite(v)) iv = v;
      }

      if (!trigHigh && tv >= GATE_FIRE_THRESHOLD_V) {
        trigHigh = true;
        heldSH = iv; // sample at the trigger sample itself, not one sample later
      } else if (trigHigh && tv < GATE_REARM_THRESHOLD_V) {
        trigHigh = false;
      }

      if (trigHigh) trackTH = iv; // continuously track while high; frozen otherwise

      outSH[i] = heldSH;
      outTH[i] = trackTH;
    }

    state.heldSH = heldSH;
    state.trackTH = trackTH;
    state.trigHigh = trigHigh;
  },
};
