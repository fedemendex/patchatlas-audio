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
// Slew: the sampled/tracked value above (`heldSH` / `trackTH`) is the
// *target* for a one-pole follower that is what actually gets written to
// each output. At Slew = 0 (or non-finite — a safe fallback) the follower is
// bypassed and the output equals the target exactly on every sample, i.e.
// the original instantaneous behavior. For Slew > 0 the raw 0..1 knob value
// is mapped exponentially onto a [SLEW_TIME_MIN_S, SLEW_TIME_MAX_S] time
// constant (see signals.md for the product-fit range), and the output glides
// toward the target with `out += (target - out) * coeff` — a standard
// one-pole with no overshoot. For S&H this smooths the step at each trigger;
// for T&H it also smooths continuous tracking while Trig is high, then
// glides to the frozen target after the falling edge. Because the follower
// state is kept in sync with the target whenever Slew is bypassed, turning
// Slew back up always starts gliding from the current output, never a stale
// value.
//
// Jack/param layout (seed declaration order):
//   ins[0] = In   ins[1] = Trig
//   outs[0] = S&H   outs[1] = T&H
//   params[0] = Slew (raw 0..1 knob value, mapped in-kernel — see above)

import type { Kernel } from "../engine/kernel";
import { GATE_FIRE_THRESHOLD_V, GATE_REARM_THRESHOLD_V } from "../engine/units";

// Slew time-constant range: local design constants (product fit for a
// sample-rate CV glide), not signal-standard values from units.ts.
const SLEW_TIME_MIN_S = 0.001;
const SLEW_TIME_MAX_S = 2;

interface SampleAndHoldState {
  sr: number;
  heldSH: number; // S&H's held value (slew target), updated only on a trigger rising edge
  trackTH: number; // T&H's target: tracks In while high, frozen while low
  trigHigh: boolean; // Schmitt state of the Trig input
  outSH: number; // S&H's slewed output (equals heldSH when Slew is bypassed)
  outTH: number; // T&H's slewed output (equals trackTH when Slew is bypassed)
}

export const sampleAndHoldKernel: Kernel<SampleAndHoldState> = {
  init(sr): SampleAndHoldState {
    return { sr, heldSH: 0, trackTH: 0, trigHigh: false, outSH: 0, outTH: 0 };
  },

  process(state, ins, outs, params, n) {
    const inSig = ins[0];
    const inTrig = ins[1];
    const outSH = outs[0];
    const outTH = outs[1];

    let heldSH = state.heldSH;
    let trackTH = state.trackTH;
    let trigHigh = state.trigHigh;
    let slewedSH = state.outSH;
    let slewedTH = state.outTH;

    // Non-finite Slew falls back to 0 (bypassed, instantaneous) — the safe
    // direction, matching every other kernel's non-finite-param convention.
    let slew = params[0];
    if (!Number.isFinite(slew)) slew = 0;
    else if (slew < 0) slew = 0;
    else if (slew > 1) slew = 1;

    // coeff <= 0 means "no slew": the loop below writes the target straight
    // through, so the follower state stays glued to the target and a later
    // increase in Slew always glides from the true current value.
    let coeff = 0;
    if (slew > 0) {
      const timeSeconds = SLEW_TIME_MIN_S * Math.pow(SLEW_TIME_MAX_S / SLEW_TIME_MIN_S, slew);
      coeff = 1 - Math.exp(-1 / (timeSeconds * state.sr));
    }

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

      if (coeff > 0) {
        slewedSH += (heldSH - slewedSH) * coeff;
        slewedTH += (trackTH - slewedTH) * coeff;
      } else {
        slewedSH = heldSH;
        slewedTH = trackTH;
      }

      outSH[i] = slewedSH;
      outTH[i] = slewedTH;
    }

    state.heldSH = heldSH;
    state.trackTH = trackTH;
    state.trigHigh = trigHigh;
    state.outSH = slewedSH;
    state.outTH = slewedTH;
  },
};
