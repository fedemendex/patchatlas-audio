// Multi-shape LFO kernel for slug "lfo".
// Bipolar ±CV_BIPOLAR_MAX modulation source with five simultaneous shape
// outputs: Sine, Tri, Sq, Saw, and Sub (a square one octave below the rate).
//
// Rate CV is 1 V/oct around the Rate knob: freq = rate · 2^cv, clamped to
// [0, RATE_MAX_HZ] — deliberately sub-audio, no audio-rate ambitions in v1.
//
// Phase convention (differs from the oscillator, chosen for deterministic
// reset): each sample is written from the CURRENT phase, then phase advances.
// A rising edge on Rst (Schmitt: fire ≥ GATE_FIRE_THRESHOLD_V, re-arm below
// GATE_REARM_THRESHOLD_V) sets both phases to 0 before that sample is
// written, so the sample at the reset edge always reads phase 0
// (Sine 0, Tri 0 rising, Sq +max, Saw −max, Sub +max).
//
// Shape formulas over phase p ∈ [0, 1), all scaled by CV_BIPOLAR_MAX:
//   Sine: sin(2π·p)
//   Tri:  0→+1 over p∈[0,¼), +1→−1 over [¼,¾), −1→0 over [¾,1) — phase-aligned
//         with Sine (both start at 0 rising)
//   Sq:   +1 for p < ½, −1 for p ≥ ½
//   Saw:  2p − 1 (rising ramp, −max at p=0)
//   Sub:  square on a half-rate phase (one octave down)
//
// Jack/param layout (seed declaration order):
//   ins[0] = Rate CV   ins[1] = Rst
//   outs[0] = Sine  outs[1] = Tri  outs[2] = Sq  outs[3] = Saw  outs[4] = Sub
//   params[0] = Rate (Hz)

import type { Kernel } from "../engine/kernel";
import {
  CV_BIPOLAR_MAX,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
} from "../engine/units";

// Rate design constants (match the registry ParamSpec for "Rate").
const RATE_MIN_HZ = 0.01;
const RATE_MAX_HZ = 30;
const DEFAULT_RATE_HZ = 2;

const TWO_PI = 2 * Math.PI;

interface LfoState {
  invSr: number; // 1 / sr, phase increment per Hz
  phase: number; // main cycle phase in [0, 1)
  subPhase: number; // half-rate phase in [0, 1) for the Sub output
  rstHigh: boolean; // Schmitt state of the Rst input
}

export const lfoKernel: Kernel<LfoState> = {
  init(sr): LfoState {
    return { invSr: 1 / sr, phase: 0, subPhase: 0, rstHigh: false };
  },

  process(state, ins, outs, params, n) {
    const inRateCv = ins[0];
    const inRst = ins[1];
    const outSine = outs[0];
    const outTri = outs[1];
    const outSq = outs[2];
    const outSaw = outs[3];
    const outSub = outs[4];

    // Non-finite Rate falls back to the default; otherwise clamp to the knob range.
    let rate = params[0];
    if (!Number.isFinite(rate)) rate = DEFAULT_RATE_HZ;
    else if (rate < RATE_MIN_HZ) rate = RATE_MIN_HZ;
    else if (rate > RATE_MAX_HZ) rate = RATE_MAX_HZ;

    const invSr = state.invSr;
    let phase = state.phase;
    let subPhase = state.subPhase;
    let rstHigh = state.rstHigh;

    for (let i = 0; i < n; i++) {
      // Schmitt-trigger the reset input; non-finite samples read as 0 V (low).
      let rv = 0;
      if (inRst !== null) {
        const v = inRst[i];
        if (Number.isFinite(v)) rv = v;
      }
      if (!rstHigh && rv >= GATE_FIRE_THRESHOLD_V) {
        rstHigh = true;
        phase = 0; // reset before writing: this sample reads phase 0
        subPhase = 0;
      } else if (rstHigh && rv < GATE_REARM_THRESHOLD_V) {
        rstHigh = false;
      }

      // Effective frequency: 1 V/oct Rate CV around the knob. The inverted
      // comparison also catches NaN from a non-finite 2^cv, forcing 0 Hz so a
      // bad sample never poisons the phase accumulators.
      let freqHz = rate;
      if (inRateCv !== null) {
        freqHz = rate * Math.pow(2, inRateCv[i]);
        if (!(freqHz >= 0)) freqHz = 0;
        else if (freqHz > RATE_MAX_HZ) freqHz = RATE_MAX_HZ;
      }

      // Write all shapes from the current phase.
      outSine[i] = Math.sin(TWO_PI * phase) * CV_BIPOLAR_MAX;
      let tri;
      if (phase < 0.25) tri = 4 * phase;
      else if (phase < 0.75) tri = 2 - 4 * phase;
      else tri = 4 * phase - 4;
      outTri[i] = tri * CV_BIPOLAR_MAX;
      outSq[i] = phase < 0.5 ? CV_BIPOLAR_MAX : -CV_BIPOLAR_MAX;
      outSaw[i] = (2 * phase - 1) * CV_BIPOLAR_MAX;
      outSub[i] = subPhase < 0.5 ? CV_BIPOLAR_MAX : -CV_BIPOLAR_MAX;

      // Then advance.
      const inc = freqHz * invSr;
      phase += inc;
      if (phase >= 1) phase -= 1;
      subPhase += inc * 0.5;
      if (subPhase >= 1) subPhase -= 1;
    }

    state.phase = phase;
    state.subPhase = subPhase;
    state.rstHigh = rstHigh;
  },
};
