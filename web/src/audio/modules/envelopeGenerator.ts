// ADSR envelope generator kernel for slug "envelope-generator".
//
// Gate-driven ADSR with exponential-feeling one-pole segments. The gate input
// goes through a Schmitt trigger (fire ≥ GATE_FIRE_THRESHOLD_V, re-arm below
// GATE_REARM_THRESHOLD_V); a rising gate — including during release — enters
// attack from the CURRENT envelope level, never a reset to 0. The Retrigger
// input restarts attack from the current level while the gate is held high.
//
// Segments approach their target with y += (target − y) · coeff where the
// per-sample coeff derives from τ = time / ln(100): a segment covers 99% of
// its span in the knob time. Because one-pole curves are asymptotic, a
// segment "completes" when it is within SEGMENT_COMPLETE_RATIO (1%) of
// GATE_HIGH_V of its target.
//
// Jack/param layout (seed declaration order):
//   ins[0] = Gate        — Schmitt-triggered gate; null → low
//   ins[1] = Retrigger   — Schmitt-triggered; rising edge while gate high
//                          restarts attack from the current level; null → low
//   outs[0] = Env  — unipolar envelope, 0 → GATE_HIGH_V
//   outs[1] = Inv  — polarity-inverted envelope, 0 → −GATE_HIGH_V
//                    (same convention as the mixer's Inv output)
//   outs[2] = EOC  — end-of-cycle: TRIGGER_SECONDS pulse at GATE_HIGH_V when
//                    release completes
//   params[0] = A (s)  params[1] = D (s)  params[2] = S (V)  params[3] = R (s)

import type { Kernel } from "../engine/kernel";
import {
  GATE_HIGH_V,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
  TRIGGER_SECONDS,
} from "../engine/units";

// Segment design constants (local envelope shaping, not signal-standard values).
const SEGMENT_COMPLETE_RATIO = 0.01; // segment done within 1% of GATE_HIGH_V of target
const TIME_TO_TAU = Math.log(1 / SEGMENT_COMPLETE_RATIO); // τ = time / ln(100)
const TIME_MIN_S = 0.001;
const TIME_MAX_S = 10;
const DEFAULT_ATTACK_S = 0.01;
const DEFAULT_DECAY_S = 0.2;
const DEFAULT_SUSTAIN_V = GATE_HIGH_V * 0.7;
const DEFAULT_RELEASE_S = 0.3;

// Stage constants (small ints, no enum object on the hot path).
const IDLE = 0;
const ATTACK = 1;
const DECAY = 2;
const SUSTAIN = 3;
const RELEASE = 4;

interface EnvelopeGeneratorState {
  sr: number;
  stage: number;
  env: number; // current level in volts
  gateHigh: boolean; // Schmitt state of the Gate input
  retrigHigh: boolean; // Schmitt state of the Retrigger input
  eocSamplesLeft: number; // remaining samples of the current EOC pulse
  eocPulseSamples: number; // TRIGGER_SECONDS at this sample rate
}

const COMPLETE_EPS_V = SEGMENT_COMPLETE_RATIO * GATE_HIGH_V;

// Idle drain snaps the inaudible release tail to exactly 0 below this level.
const IDLE_SNAP_EPS_V = 1e-6;

export const envelopeGeneratorKernel: Kernel<EnvelopeGeneratorState> = {
  init(sr): EnvelopeGeneratorState {
    return {
      sr,
      stage: IDLE,
      env: 0,
      gateHigh: false,
      retrigHigh: false,
      eocSamplesLeft: 0,
      eocPulseSamples: Math.max(1, Math.round(TRIGGER_SECONDS * sr)),
    };
  },

  process(state, ins, outs, params, n) {
    const inGate = ins[0];
    const inRetrig = ins[1];
    const outEnv = outs[0];
    const outInv = outs[1];
    const outEoc = outs[2];

    // Non-finite params fall back to defaults; times clamp to the knob range,
    // sustain clamps to the unipolar envelope range.
    let a = params[0];
    if (!Number.isFinite(a)) a = DEFAULT_ATTACK_S;
    else if (a < TIME_MIN_S) a = TIME_MIN_S;
    else if (a > TIME_MAX_S) a = TIME_MAX_S;
    let d = params[1];
    if (!Number.isFinite(d)) d = DEFAULT_DECAY_S;
    else if (d < TIME_MIN_S) d = TIME_MIN_S;
    else if (d > TIME_MAX_S) d = TIME_MAX_S;
    let s = params[2];
    if (!Number.isFinite(s)) s = DEFAULT_SUSTAIN_V;
    else if (s < 0) s = 0;
    else if (s > GATE_HIGH_V) s = GATE_HIGH_V;
    let r = params[3];
    if (!Number.isFinite(r)) r = DEFAULT_RELEASE_S;
    else if (r < TIME_MIN_S) r = TIME_MIN_S;
    else if (r > TIME_MAX_S) r = TIME_MAX_S;

    // Per-sample one-pole coefficients, once per block (params are per-block).
    const sr = state.sr;
    const aCoeff = 1 - Math.exp(-TIME_TO_TAU / (a * sr));
    const dCoeff = 1 - Math.exp(-TIME_TO_TAU / (d * sr));
    const rCoeff = 1 - Math.exp(-TIME_TO_TAU / (r * sr));

    let stage = state.stage;
    let env = state.env;
    let gateHigh = state.gateHigh;
    let retrigHigh = state.retrigHigh;
    let eocSamplesLeft = state.eocSamplesLeft;
    const eocPulseSamples = state.eocPulseSamples;

    for (let i = 0; i < n; i++) {
      // Schmitt-trigger the gate. Non-finite samples read as 0 V (low is the
      // safe direction: NaN comparisons are false, so gv stays 0).
      let gv = 0;
      if (inGate !== null) {
        const v = inGate[i];
        if (Number.isFinite(v)) gv = v;
      }
      if (!gateHigh && gv >= GATE_FIRE_THRESHOLD_V) {
        gateHigh = true;
        // Rising gate: attack from the current level (retrigger during
        // release continues from wherever the envelope is).
        stage = ATTACK;
      } else if (gateHigh && gv < GATE_REARM_THRESHOLD_V) {
        gateHigh = false;
        if (stage !== IDLE) stage = RELEASE;
      }

      // Schmitt-trigger the Retrigger input: rising edge restarts attack from
      // the current level while the gate is held high.
      let rv = 0;
      if (inRetrig !== null) {
        const v = inRetrig[i];
        if (Number.isFinite(v)) rv = v;
      }
      if (!retrigHigh && rv >= GATE_FIRE_THRESHOLD_V) {
        retrigHigh = true;
        if (gateHigh) stage = ATTACK;
      } else if (retrigHigh && rv < GATE_REARM_THRESHOLD_V) {
        retrigHigh = false;
      }

      // Advance the active segment.
      if (stage === ATTACK) {
        env += (GATE_HIGH_V - env) * aCoeff;
        if (GATE_HIGH_V - env < COMPLETE_EPS_V) stage = DECAY;
      } else if (stage === DECAY) {
        env += (s - env) * dCoeff;
        const delta = env - s;
        if (delta < COMPLETE_EPS_V && delta > -COMPLETE_EPS_V) stage = SUSTAIN;
      } else if (stage === SUSTAIN) {
        // Track the sustain knob smoothly with the decay coefficient.
        env += (s - env) * dCoeff;
      } else if (stage === RELEASE) {
        env += (0 - env) * rCoeff;
        if (env < COMPLETE_EPS_V) {
          stage = IDLE;
          eocSamplesLeft = eocPulseSamples; // end of cycle: fire the trigger
        }
      } else {
        // IDLE: keep approaching 0 so the tail below COMPLETE_EPS_V still
        // fades out instead of freezing; snap the last inaudible remainder.
        env += (0 - env) * rCoeff;
        if (env < IDLE_SNAP_EPS_V) env = 0;
      }

      outEnv[i] = env;
      outInv[i] = 0 - env; // avoid IEEE 754 -0 when env === 0
      if (eocSamplesLeft > 0) {
        outEoc[i] = GATE_HIGH_V;
        eocSamplesLeft--;
      } else {
        outEoc[i] = 0;
      }
    }

    state.stage = stage;
    state.env = env;
    state.gateHigh = gateHigh;
    state.retrigHigh = retrigHigh;
    state.eocSamplesLeft = eocSamplesLeft;
  },
};
