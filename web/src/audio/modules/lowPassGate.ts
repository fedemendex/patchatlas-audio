// Low Pass Gate kernel for slug "low-pass-gate".
//
// Patchamama's generic educational preview semantics — not a clone of, or a
// claim to match, any specific hardware LPG convention. Models a
// vactrol-driven coupled VCA + 2-pole lowpass, selectable via
// the seeded Mode switch (positions VCA / LPG / Both). "Gate" (amplitude
// control) is part of every mode except plain VCA-only, since a low-pass
// *gate* is defined by combining filtering with amplitude control — a
// filter-only mode would not gate anything and would leak sustained/DC
// signal through when "closed", so it is not offered:
//   VCA  — amplitude gate only: output = In * amp. The filter stage still
//          runs every sample (state stays live for continuity) but is not
//          read for output, so no low-pass coloration reaches Out.
//   LPG  — the actual low-pass-gate response: output = filtered * amp, both
//          driven by the same level. Closed (level = 0) is silent, since amp
//          multiplies the filtered path too.
//   Both — a parallel 50/50 blend of the VCA and LPG paths:
//          output = 0.5 * amp * (In + filtered). Brighter than LPG-only
//          (half the signal skips the lowpass) but darker/gated compared to
//          VCA-only. Closed is silent (amp gates both halves of the blend).
//
// Jack/param layout (seed declaration order):
//   ins[0] = In   ins[1] = CV   ins[2] = Strike
//   outs[0] = Out
//   params[0] = Mode (0 = VCA, 1 = LPG, 2 = Both; "positions" curve)
//
// Vactrol follower ("level", 0..1 = LPG openness):
//   - CV is unipolar 0..CV_UNIPOLAR_MAX V: cvOpen = clamp(CV / CV_UNIPOLAR_MAX,
//     0, 1). Unpatched/non-finite CV reads as 0 V (closed target).
//   - Strike is a Schmitt-gated rising-edge pluck (thresholds from units.ts):
//     on the rising edge, level snaps to 1.0 that same sample. A sustained
//     high does not retrigger until Strike falls back below
//     GATE_REARM_THRESHOLD_V. Non-finite Strike samples never fire.
//   - On every other sample, level chases cvOpen: an instant rise if cvOpen >
//     level (jumps exactly to the target, never past it — no overshoot),
//     otherwise an exponential decay at a fixed DECAY_TIME_S time constant.
//     There is no seeded Damp/Decay/Response control on this module to
//     modulate the decay time, so it is fixed rather than knob-mapped.
//   - level is hard-clamped to [0, 1] every sample.
//
// Audio path: amp = level², cutoffHz = LPG_CUTOFF_MIN_HZ + level² ×
// LPG_CUTOFF_RANGE_HZ, run through two cascaded one-pole lowpass stages
// (12 dB/oct total). The filter always runs (regardless of Mode) so its
// state stays continuous across a live Mode switch; Mode only selects which
// combination of {In, filtered} × amp becomes the output (see the per-mode
// breakdown above).
//
// Non-finite input/CV/Strike/params fall back to safe defaults (0 V, or the
// nearest in-range default); output is always finite. process() is
// allocation-free.

import type { Kernel } from "../engine/kernel";
import { CV_UNIPOLAR_MAX, GATE_FIRE_THRESHOLD_V, GATE_REARM_THRESHOLD_V } from "../engine/units";

// LPG design constants: local to this module, not signal-standard values
// (same precedent as filter.ts's CUTOFF_MIN_HZ / CUTOFF_MAX_FRAC).
const LPG_CUTOFF_MIN_HZ = 40;
const LPG_CUTOFF_RANGE_HZ = 12000;
const DECAY_TIME_S = 0.3;

// Mode switch positions (seed order): VCA, LPG, Both.
const MODE_VCA = 0;
const MODE_LPG = 1;
const MODE_BOTH = 2;

interface LowPassGateState {
  twoPiOverSr: number;
  decayCoeff: number;
  level: number;
  lp1: number;
  lp2: number;
  strikeHigh: boolean;
}

export const lowPassGateKernel: Kernel<LowPassGateState> = {
  init(sr): LowPassGateState {
    return {
      twoPiOverSr: (2 * Math.PI) / sr,
      decayCoeff: 1 - Math.exp(-1 / (DECAY_TIME_S * sr)),
      level: 0,
      lp1: 0,
      lp2: 0,
      strikeHigh: false,
    };
  },

  process(state, ins, outs, params, n) {
    const inSig = ins[0];
    const inCv = ins[1];
    const inStrike = ins[2];
    const out = outs[0];

    let mode = params[0];
    if (!Number.isFinite(mode)) mode = MODE_BOTH;
    else mode = Math.round(mode);
    if (mode < MODE_VCA) mode = MODE_VCA;
    else if (mode > MODE_BOTH) mode = MODE_BOTH;

    const twoPiOverSr = state.twoPiOverSr;
    const decayCoeff = state.decayCoeff;
    let level = state.level;
    let lp1 = state.lp1;
    let lp2 = state.lp2;
    let strikeHigh = state.strikeHigh;

    for (let i = 0; i < n; i++) {
      // CV: unipolar 0..10 V openness target. Non-finite/unpatched reads as
      // 0 V (closed).
      let cvOpen = 0;
      if (inCv !== null) {
        const v = inCv[i];
        if (Number.isFinite(v)) cvOpen = v / CV_UNIPOLAR_MAX;
      }
      if (cvOpen < 0) cvOpen = 0;
      else if (cvOpen > 1) cvOpen = 1;

      // Strike: Schmitt-gated rising-edge pluck. Non-finite reads as 0 V
      // (never fires; the safe direction).
      let sv = 0;
      if (inStrike !== null) {
        const v = inStrike[i];
        if (Number.isFinite(v)) sv = v;
      }

      let struck = false;
      if (!strikeHigh && sv >= GATE_FIRE_THRESHOLD_V) {
        strikeHigh = true;
        struck = true;
        level = 1;
      } else if (strikeHigh && sv < GATE_REARM_THRESHOLD_V) {
        strikeHigh = false;
      }

      if (!struck) {
        if (cvOpen > level) level = cvOpen; // instant rise, never overshoots
        else level += (cvOpen - level) * decayCoeff;
      }
      if (level < 0) level = 0;
      else if (level > 1) level = 1;

      const levelSq = level * level;

      // In: non-finite/unpatched reads as 0 V.
      let x = 0;
      if (inSig !== null) {
        const v = inSig[i];
        if (Number.isFinite(v)) x = v;
      }

      // Two-pole lowpass, cutoff opening with level. Always runs so filter
      // state stays continuous across a live Mode switch.
      const cutoffHz = LPG_CUTOFF_MIN_HZ + levelSq * LPG_CUTOFF_RANGE_HZ;
      const coeff = 1 - Math.exp(-twoPiOverSr * cutoffHz);
      lp1 += (x - lp1) * coeff;
      lp2 += (lp1 - lp2) * coeff;

      if (mode === MODE_VCA) out[i] = x * levelSq;
      else if (mode === MODE_LPG) out[i] = lp2 * levelSq;
      else out[i] = 0.5 * levelSq * (x + lp2); // MODE_BOTH: parallel VCA+LPG blend
    }

    state.level = level;
    state.lp1 = lp1;
    state.lp2 = lp2;
    state.strikeHigh = strikeHigh;
  },
};
