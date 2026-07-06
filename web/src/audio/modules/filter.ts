// Generic SVF (state-variable filter) kernel for slug "filter".
// Topology: topology-preserving transform (TPT) / zero-delay-feedback (ZDF)
// state-variable filter with simultaneous LP, BP, and HP outputs.
// Clean-room implementation from the standard published two-integrator SVF
// mathematical structure. No GPL-derived code; no hardware modeling.
//
// Jack layout (seed declaration order):
//   ins[0] = In         — audio input; null → silence
//   ins[1] = 1V/Oct     — pitch tracking CV; null → 0 V; scaled by Track Amt
//   ins[2] = Cut CV     — exponential cutoff CV; null → 0 V; scaled by CV Amt
//   ins[3] = FM         — additional 1 V/oct cutoff CV; null → 0 V; unscaled
//   ins[4] = Res CV     — resonance CV; null → 0 V; added to Res, normalized by CV_BIPOLAR_MAX
//   outs[0] = LP   outs[1] = BP   outs[2] = HP
//   params[0] = Cutoff   (20..16000 Hz, exponential curve)
//   params[1] = Res      (0..1 linear)
//   params[2] = CV Amt   (-1..1 bipolar)
//   params[3] = Track Amt (-1..1 bipolar)
//
// Resonance mapping (GH #78): the linear 0..1 Res param maps exponentially onto
// filter Q — Q = RES_Q_MIN · (RES_Q_MAX/RES_Q_MIN)^res, i.e. 0.5 → 20 — so each
// knob increment multiplies Q by a constant ratio and audible resonance grows
// evenly across the whole rotation (a direct k = 2 − 2·res mapping crams the
// entire audible Q range into the top fifth of the knob). Q is bounded at
// RES_Q_MAX: max Res rings hard and approaches self-oscillation but k = 1/Q
// stays > 0, so the SVF remains unconditionally stable and ringing decays.
//
// Resonance gain compensation: the input is scaled by comp = √(k/2) (exactly 1
// at Res = 0), so the resonant peak gain grows as √(Q·RES_Q_MIN) instead of Q —
// capping the absolute peak gain at √(RES_Q_MAX·RES_Q_MIN) = √10 ≈ 3.2× input
// (+10 dB) instead of the uncompensated 20× peak at Q = 20. A ±5 V input
// therefore peaks around ±16 V at full Res, not at the ±100 V state clamp.
// The trade-off is a Moog-ladder-style passband drop (≈ −16 dB at full Res);
// relative peak-vs-passband resonance is unaffected.
//
// SVF formula (TPT, two integrators, from the published mathematical structure
// of the topology-preserving bilinear transform state-variable filter):
//
//   g  = tan(π · cutoffHz / sr)
//   k  = 1/Q = 2·(RES_Q_MIN/RES_Q_MAX)^res   (k=2 → maximally damped)
//   a1 = 1 / (1 + g·(g + k))
//   a2 = g·a1,  a3 = g·a2
//
//   v3 = x − ic2eq
//   BP = a1·ic1eq + a2·v3
//   LP = ic2eq + a2·ic1eq + a3·v3
//   HP = x − k·BP − LP
//
//   ic1eq ← 2·BP − ic1eq
//   ic2eq ← 2·LP − ic2eq
//
// Integrator-state hard clamp (±FILTER_STATE_LIMIT_V): numerical safety only.
// With bounded Q and gain compensation the musical worst case sits around
// ±16 V, so this 100 V clamp is a genuine last-resort guard that never triggers
// in normal use — it is not the loudness control. Downstream audio-output clips
// via tanh; downstream CV modules see the compensated (~audio-scale) signal.
// This is numerical safety, not analog character.

import type { Kernel } from "../engine/kernel";
import { CV_BIPOLAR_MAX } from "../engine/units";

// Filter design constants (local to this module; not signal-standard values).
const CUTOFF_MIN_HZ = 20;
const CUTOFF_MAX_FRAC = 0.45; // max cutoff = sr × this (stays below Nyquist)
const FILTER_STATE_LIMIT_V = 100; // numerical safety bound — see file-header comment
const RES_Q_MIN = 0.5; // Q at Res=0 → k=2, the maximally damped SVF (unchanged zero-res)
const RES_Q_MAX = 20; // bounded Q at Res=1 → k=0.05: hard ring, never unstable
const RES_Q_SHAPE_RATIO = RES_Q_MIN / RES_Q_MAX; // per-sample base of the exponential Res curve

interface FilterState {
  piOverSr: number;   // π / sr — used as tan(piOverSr · f) each sample
  maxCutoffHz: number;
  ic1eq: number;
  ic2eq: number;
}

export const filterKernel: Kernel<FilterState> = {
  init(sr): FilterState {
    return {
      piOverSr: Math.PI / sr,
      maxCutoffHz: sr * CUTOFF_MAX_FRAC,
      ic1eq: 0,
      ic2eq: 0,
    };
  },

  process(state, ins, outs, params, n) {
    const inAudio = ins[0];
    const inTrack = ins[1];
    const inCutCV = ins[2];
    const inFm    = ins[3];
    const inResCV = ins[4];
    const outLP   = outs[0];
    const outBP   = outs[1];
    const outHP   = outs[2];

    // --- Guard base cutoff ---
    let baseCutoffHz = params[0];
    if (!Number.isFinite(baseCutoffHz) || baseCutoffHz < CUTOFF_MIN_HZ) {
      baseCutoffHz = CUTOFF_MIN_HZ;
    } else if (baseCutoffHz > state.maxCutoffHz) {
      baseCutoffHz = state.maxCutoffHz;
    }

    // --- Guard base resonance ---
    let baseRes = params[1];
    if (!Number.isFinite(baseRes) || baseRes < 0) baseRes = 0;
    else if (baseRes > 1) baseRes = 1;

    // --- Guard CV Amt (bipolar: only check finiteness) ---
    let cvAmt = params[2];
    if (!Number.isFinite(cvAmt)) cvAmt = 0;

    // --- Guard Track Amt ---
    let trackAmt = params[3];
    if (!Number.isFinite(trackAmt)) trackAmt = 0;

    const piOverSr    = state.piOverSr;
    const maxCutoffHz = state.maxCutoffHz;
    let ic1eq = state.ic1eq;
    let ic2eq = state.ic2eq;

    for (let i = 0; i < n; i++) {
      // Sum all cutoff CV contributions in octave-space.
      // cutoffHz = baseCutoffHz * 2^(cutCV*cvAmt + fm + track*trackAmt)
      let cvOctaves = 0;
      if (inCutCV !== null) {
        const v = inCutCV[i];
        if (Number.isFinite(v)) cvOctaves += v * cvAmt;
      }
      if (inFm !== null) {
        const v = inFm[i];
        if (Number.isFinite(v)) cvOctaves += v;
      }
      if (inTrack !== null) {
        const v = inTrack[i];
        if (Number.isFinite(v)) cvOctaves += v * trackAmt;
      }

      let cutoffHz = baseCutoffHz * Math.pow(2, cvOctaves);
      if (!Number.isFinite(cutoffHz) || cutoffHz < CUTOFF_MIN_HZ) {
        cutoffHz = CUTOFF_MIN_HZ;
      } else if (cutoffHz > maxCutoffHz) {
        cutoffHz = maxCutoffHz;
      }

      // Resonance: base param + Res CV. Normalized by CV_BIPOLAR_MAX so a standard
      // ±5 V bipolar LFO or envelope spans the full [0, 1] resonance range.
      let totalRes = baseRes;
      if (inResCV !== null) {
        const v = inResCV[i];
        if (Number.isFinite(v)) totalRes += v / CV_BIPOLAR_MAX;
      }
      if (totalRes < 0) totalRes = 0;
      else if (totalRes > 1) totalRes = 1;

      // Exponential Res → Q curve with bounded max Q (see file-header comment):
      // qShape = 1 at res=0 → k=2 (bit-exact zero-res); qShape = 0.025 at res=1
      // → k=0.05 (Q=20). comp = √(k/2) is the resonance gain compensation.
      const qShape = Math.pow(RES_Q_SHAPE_RATIO, totalRes);
      const k = 2 * qShape;
      const comp = Math.sqrt(qShape);

      // TPT SVF coefficients.
      const g  = Math.tan(piOverSr * cutoffHz);
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;

      // Input sample (null or non-finite → 0), scaled by the resonance
      // gain compensation.
      let x = 0;
      if (inAudio !== null) {
        const v = inAudio[i];
        if (Number.isFinite(v)) x = v * comp;
      }

      // SVF tick.
      const v3 = x - ic2eq;
      const bp = a1 * ic1eq + a2 * v3;
      const lp = ic2eq + a2 * ic1eq + a3 * v3;
      const hp = x - k * bp - lp;

      // State update.
      ic1eq = 2 * bp - ic1eq;
      ic2eq = 2 * lp - ic2eq;

      // Numerical safety: hard-clamp integrator states.
      if (ic1eq > FILTER_STATE_LIMIT_V) ic1eq = FILTER_STATE_LIMIT_V;
      else if (ic1eq < -FILTER_STATE_LIMIT_V) ic1eq = -FILTER_STATE_LIMIT_V;
      if (ic2eq > FILTER_STATE_LIMIT_V) ic2eq = FILTER_STATE_LIMIT_V;
      else if (ic2eq < -FILTER_STATE_LIMIT_V) ic2eq = -FILTER_STATE_LIMIT_V;

      outLP[i] = lp;
      outBP[i] = bp;
      outHP[i] = hp;
    }

    state.ic1eq = ic1eq;
    state.ic2eq = ic2eq;
  },
};
