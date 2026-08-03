// Slew limiter kernel for slug "slew-limiter".
//
// A linear, constant-rate slew limiter with independent Rise and Fall
// controls — not a one-pole/exponential follower. The output moves toward
// the In target at a fixed rate (volts per second) and stops exactly at the
// target: it never overshoots and never rings.
//
// Units: each control is the time, in seconds, required to traverse ONE
// engine voltage unit ("s/V" — a rate control, not a full-scale time). The
// Rise/Fall are plain knobs with no hardware-derived range, so the raw
// 0..1 knob value (registry ParamSpec: linear, min 0, max 1, default 0) is
// mapped exponentially in-kernel onto [TIME_PER_V_MIN_S, TIME_PER_V_MAX_S]
// s/V — the same in-kernel-mapping convention sample-and-hold's Slew control
// uses:
//   timePerVolt = TIME_PER_V_MIN_S * (TIME_PER_V_MAX_S / TIME_PER_V_MIN_S) ^ raw
// Raw 0 (the knob's minimum/rest position, and the default) is a hard bypass
// for that direction: In passes straight through with NO limiting at all —
// not merely a very fast slew — so a fully-CCW Rise/Fall knob is a true
// passthrough, matching an unpatched jack. Raw 1 (fully clockwise) is
// exactly TIME_PER_V_MAX_S = 2 s/V, the slowest rate.
//
// Sample-rate-independent rate, per direction:
//   unitsPerSecond      = 1 / timePerVolt
//   maxChangePerSample  = unitsPerSecond / sr
// Each sample moves `y` toward the target by at most maxChangePerSample and
// clamps exactly to the target when within one step of it.
//
// Rise CV / Fall CV: 1 oct/V scaling of the *effective* timePerVolt while
// its knob is above the bypass minimum (Maths/function-generator
// convention: positive volts lengthen the time, i.e. slower), clamped back
// to [TIME_PER_V_MIN_S, TIME_PER_V_MAX_S]. CV has no effect while the
// corresponding knob is at the bypass minimum — there is no base rate to
// scale, so passthrough stays exact regardless of CV. Non-finite CV samples
// read as 0 V.
//
// First-sample initialization: state starts uninitialized (not 0 V). On the
// very first sample this kernel instance ever processes, `y` is set
// directly to that (sanitized) input sample — never ramped up from an
// artificial 0 V start.
//
// Unconnected/non-finite In reads as 0 V, matching the engine's normal
// unpatched-input convention. Output is never clamped to an arbitrary
// voltage range — it is only ever moved toward, and stopped at, the target,
// so DC, negative, and bipolar CV all pass through unchanged in shape.
//
// Jack/param layout (registry declaration order):
//   ins[0] = In        ins[1] = Rise CV   ins[2] = Fall CV
//   outs[0] = Out
//   params[0] = Rise (raw 0..1, in-kernel exponential mapping — see above)
//   params[1] = Fall (raw 0..1, in-kernel exponential mapping — see above)

import type { Kernel } from "../engine/kernel";

// Slew time-per-volt range: local design constants (product fit), not
// signal-standard values from units.ts — same convention as sample-and-hold's
// SLEW_TIME_MIN_S/MAX_S and function-generator's TIME_MIN_S/MAX_S.
const TIME_PER_V_MIN_S = 0.0005;
const TIME_PER_V_MAX_S = 2;

interface SlewLimiterState {
  sr: number;
  y: number;
  initialized: boolean;
}

function effectiveTimePerVolt(raw: number, cv: number): number {
  let t = TIME_PER_V_MIN_S * Math.pow(TIME_PER_V_MAX_S / TIME_PER_V_MIN_S, raw);
  if (cv !== 0) {
    t *= Math.pow(2, cv);
    if (t < TIME_PER_V_MIN_S) t = TIME_PER_V_MIN_S;
    else if (!(t <= TIME_PER_V_MAX_S)) t = TIME_PER_V_MAX_S;
  }
  return t;
}

export const slewLimiterKernel: Kernel<SlewLimiterState> = {
  init(sr): SlewLimiterState {
    return { sr, y: 0, initialized: false };
  },

  process(state, ins, outs, params, n) {
    const inSig = ins[0];
    const inRiseCv = ins[1];
    const inFallCv = ins[2];
    const outOut = outs[0];

    let riseRaw = params[0];
    if (!Number.isFinite(riseRaw)) riseRaw = 0;
    else if (riseRaw < 0) riseRaw = 0;
    else if (riseRaw > 1) riseRaw = 1;
    let fallRaw = params[1];
    if (!Number.isFinite(fallRaw)) fallRaw = 0;
    else if (fallRaw < 0) fallRaw = 0;
    else if (fallRaw > 1) fallRaw = 1;

    const sr = state.sr;
    let y = state.y;
    let initialized = state.initialized;

    for (let i = 0; i < n; i++) {
      let target = 0;
      if (inSig !== null) {
        const v = inSig[i];
        if (Number.isFinite(v)) target = v;
      }

      if (!initialized) {
        y = target;
        initialized = true;
        outOut[i] = y;
        continue;
      }

      if (target > y) {
        if (riseRaw <= 0) {
          y = target;
        } else {
          let cv = 0;
          if (inRiseCv !== null) {
            const v = inRiseCv[i];
            if (Number.isFinite(v)) cv = v;
          }
          const maxChangePerSample = 1 / (effectiveTimePerVolt(riseRaw, cv) * sr);
          y += maxChangePerSample;
          if (y > target) y = target;
        }
      } else if (target < y) {
        if (fallRaw <= 0) {
          y = target;
        } else {
          let cv = 0;
          if (inFallCv !== null) {
            const v = inFallCv[i];
            if (Number.isFinite(v)) cv = v;
          }
          const maxChangePerSample = 1 / (effectiveTimePerVolt(fallRaw, cv) * sr);
          y -= maxChangePerSample;
          if (y < target) y = target;
        }
      }

      outOut[i] = y;
    }

    state.y = y;
    state.initialized = initialized;
  },
};
