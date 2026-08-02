// Function generator kernel for slug "function-generator".
//
// One channel of a Maths / Serge DUSG-style slope generator: a slew core with
// independent Rise and Fall times that is simultaneously a triggered envelope,
// a cycling LFO, and a slew limiter.
//
// Core model — three stages:
//   FOLLOW (rest): the output slews toward the In jack (0 V unpatched) with
//     linear rate limiting — full scale (CV_UNIPOLAR_MAX) in the Rise knob
//     time going up, the Fall knob time going down. Curve does not shape the
//     follower (linear slew only); it shapes transients.
//   RISE: a Trig rising edge (standard Schmitt thresholds) starts a transient
//     from the CURRENT level to the CV_UNIPOLAR_MAX peak over the effective
//     rise time; a new edge mid-transient restarts the rise from the current
//     level (no discontinuity). The segment is a shaped phase ramp
//     y = start + (peak − start) · p^g, so the knob time is the ACTUAL segment
//     time (not a one-pole 99% convention).
//   FALL: on reaching the peak the transient falls to the follower target
//     (the live In sample, 0 V unpatched) over the effective fall time with
//     the time-mirrored shape y = floor + (start − floor) · (1 − p)^g. When
//     the fall completes: Cycle on → immediately re-rise (self-cycling LFO
//     between the In level and the peak); Cycle off → back to FOLLOW.
//
// Curve (bipolar knob, −1..+1): g = CURVE_GAMMA_MAX^curve. 0 = linear ramps;
// +1 = "expo" (rise slow-start/fast-end, fall fast-drop/slow-tail — the
// classic analog exponential look); −1 = "log" (the mirror: RC-charge rise,
// held-then-drop fall).
//
// Time CV: Rise CV and Fall CV each add to Both CV, and the summed volts
// scale the corresponding knob time exponentially at one octave per volt —
// positive volts LENGTHEN the time (Maths convention), negative shorten it.
// The effective time clamps to the knob range. Non-finite CV samples read
// as 0 V.
//
// EOR / EOC are movement-derived Maths-style gates, one rule each:
//   EOR = GATE_HIGH_V except while the output is moving UP (any stage);
//   EOC = GATE_HIGH_V except while the output is moving DOWN.
// At rest both sit high, so patching EOC → Trig self-patches into a cycle
// exactly like the hardware trick (the first sample fires the Schmitt, the
// fall drags EOC low, and its rising edge at the bottom re-triggers).
//
// Jack/param layout (seed declaration order):
//   ins[0] = Trig     — Schmitt-triggered; starts/restarts a rise transient
//   ins[1] = In       — slew/follower input and transient floor; null → 0 V
//   ins[2] = Rise CV  — 1 oct/V rise-time scaling (positive = slower)
//   ins[3] = Fall CV  — 1 oct/V fall-time scaling (positive = slower)
//   ins[4] = Both CV  — added to both Rise CV and Fall CV
//   outs[0] = Out — the function, 0 → CV_UNIPOLAR_MAX from rest (follows In
//                   outside transients, so it can sit at any input level)
//   outs[1] = EOR — end-of-rise gate (low while rising)
//   outs[2] = EOC — end-of-cycle gate (low while falling)
//   outs[3] = Inv — polarity-inverted function (mixer/envelope Inv convention)
//   params[0] = Rise (s)  params[1] = Fall (s)
//   params[2] = Curve (−1..1)  params[3] = Cycle (button, ≥ 0.5 = on)

import type { Kernel } from "../engine/kernel";
import {
  CV_UNIPOLAR_MAX,
  GATE_HIGH_V,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
} from "../engine/units";

// Segment design constants (local shaping, not signal-standard values;
// Rise/Fall min/max/defaults match the registry ParamSpecs).
const TIME_MIN_S = 0.001;
const TIME_MAX_S = 10;
const DEFAULT_RISE_S = 0.01;
const DEFAULT_FALL_S = 0.3;
// Curve exponent at full knob: g spans 1/4 (log) → 4 (expo).
const CURVE_GAMMA_MAX = 4;
const CYCLE_ON_THRESHOLD = 0.5;

// Stage constants (small ints, no enum object on the hot path).
const FOLLOW = 0;
const RISE = 1;
const FALL = 2;

interface FunctionGeneratorState {
  sr: number;
  stage: number;
  y: number; // current output level in volts
  prevY: number; // previous sample's level, for the movement-derived gates
  phase: number; // transient segment phase in [0, 1)
  segStart: number; // level at the start of the current transient segment
  trigHigh: boolean; // Schmitt state of the Trig input
}

export const functionGeneratorKernel: Kernel<FunctionGeneratorState> = {
  init(sr): FunctionGeneratorState {
    return {
      sr,
      stage: FOLLOW,
      y: 0,
      prevY: 0,
      phase: 0,
      segStart: 0,
      trigHigh: false,
    };
  },

  process(state, ins, outs, params, n) {
    const inTrig = ins[0];
    const inSig = ins[1];
    const inRiseCv = ins[2];
    const inFallCv = ins[3];
    const inBothCv = ins[4];
    const outOut = outs[0];
    const outEor = outs[1];
    const outEoc = outs[2];
    const outInv = outs[3];

    // Non-finite params fall back to defaults; times clamp to the knob range,
    // curve clamps to its bipolar range.
    let rise = params[0];
    if (!Number.isFinite(rise)) rise = DEFAULT_RISE_S;
    else if (rise < TIME_MIN_S) rise = TIME_MIN_S;
    else if (rise > TIME_MAX_S) rise = TIME_MAX_S;
    let fall = params[1];
    if (!Number.isFinite(fall)) fall = DEFAULT_FALL_S;
    else if (fall < TIME_MIN_S) fall = TIME_MIN_S;
    else if (fall > TIME_MAX_S) fall = TIME_MAX_S;
    let curve = params[2];
    if (!Number.isFinite(curve)) curve = 0;
    else if (curve < -1) curve = -1;
    else if (curve > 1) curve = 1;
    // NaN comparison is false, so a non-finite Cycle reads as off.
    const cycle = params[3] >= CYCLE_ON_THRESHOLD;

    const g = Math.pow(CURVE_GAMMA_MAX, curve);
    const sr = state.sr;

    let stage = state.stage;
    let y = state.y;
    let prevY = state.prevY;
    let phase = state.phase;
    let segStart = state.segStart;
    let trigHigh = state.trigHigh;

    for (let i = 0; i < n; i++) {
      // Schmitt-trigger the Trig input; non-finite samples read as 0 V (low).
      let tv = 0;
      if (inTrig !== null) {
        const v = inTrig[i];
        if (Number.isFinite(v)) tv = v;
      }
      if (!trigHigh && tv >= GATE_FIRE_THRESHOLD_V) {
        trigHigh = true;
        stage = RISE;
        segStart = y;
        phase = 0;
      } else if (trigHigh && tv < GATE_REARM_THRESHOLD_V) {
        trigHigh = false;
      }

      // Follower target / transient floor: the live In sample (0 V unpatched
      // or non-finite).
      let target = 0;
      if (inSig !== null) {
        const v = inSig[i];
        if (Number.isFinite(v)) target = v;
      }

      // Effective times: summed CV volts scale the knob exponentially at one
      // octave per volt (positive = slower), clamped back to the knob range.
      // Finite CV can still overflow pow to Infinity — the clamp catches it.
      let riseCv = 0;
      let fallCv = 0;
      if (inRiseCv !== null) {
        const v = inRiseCv[i];
        if (Number.isFinite(v)) riseCv += v;
      }
      if (inFallCv !== null) {
        const v = inFallCv[i];
        if (Number.isFinite(v)) fallCv += v;
      }
      if (inBothCv !== null) {
        const v = inBothCv[i];
        if (Number.isFinite(v)) {
          riseCv += v;
          fallCv += v;
        }
      }
      let riseEff = rise;
      if (riseCv !== 0) {
        riseEff = rise * Math.pow(2, riseCv);
        if (riseEff < TIME_MIN_S) riseEff = TIME_MIN_S;
        else if (!(riseEff <= TIME_MAX_S)) riseEff = TIME_MAX_S;
      }
      let fallEff = fall;
      if (fallCv !== 0) {
        fallEff = fall * Math.pow(2, fallCv);
        if (fallEff < TIME_MIN_S) fallEff = TIME_MIN_S;
        else if (!(fallEff <= TIME_MAX_S)) fallEff = TIME_MAX_S;
      }

      // Cycle mode self-starts from rest, entering the rise exactly like a
      // Trig edge would (this sample already advances the new segment).
      if (stage === FOLLOW && cycle) {
        stage = RISE;
        segStart = y;
        phase = 0;
      }

      // Advance the active stage.
      if (stage === RISE) {
        phase += 1 / (riseEff * sr);
        if (phase >= 1) {
          y = CV_UNIPOLAR_MAX;
          stage = FALL;
          segStart = y;
          phase = 0;
        } else {
          y = segStart + (CV_UNIPOLAR_MAX - segStart) * Math.pow(phase, g);
        }
      } else if (stage === FALL) {
        phase += 1 / (fallEff * sr);
        if (phase >= 1) {
          y = target;
          if (cycle) {
            stage = RISE;
            segStart = y;
            phase = 0;
          } else {
            stage = FOLLOW;
          }
        } else {
          // Time-mirror of the rise shape: fast-drop/slow-tail for g > 1.
          y = target + (segStart - target) * Math.pow(1 - phase, g);
        }
      } else {
        // FOLLOW: linear rate-limited slew toward the In level — full scale
        // in the rise time going up, the fall time going down.
        if (target > y) {
          y += CV_UNIPOLAR_MAX / (riseEff * sr);
          if (y > target) y = target;
        } else if (target < y) {
          y -= CV_UNIPOLAR_MAX / (fallEff * sr);
          if (y < target) y = target;
        }
      }

      outOut[i] = y;
      outInv[i] = 0 - y; // avoid IEEE 754 -0 when y === 0
      // Movement-derived gates: EOR low while moving up, EOC low while
      // moving down, both high at rest.
      const dy = y - prevY;
      outEor[i] = dy > 0 ? 0 : GATE_HIGH_V;
      outEoc[i] = dy < 0 ? 0 : GATE_HIGH_V;
      prevY = y;
    }

    state.stage = stage;
    state.y = y;
    state.prevY = prevY;
    state.phase = phase;
    state.segStart = segStart;
    state.trigHigh = trigHigh;
  },
};
