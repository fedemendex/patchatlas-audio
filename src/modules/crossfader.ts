// Crossfader kernel for slug "crossfader".
// Linear (not equal-power) crossfade so the module behaves predictably for
// both audio and CV: out = A*(1-t) + B*t. Equal-power/sine crossfading is
// deliberately not used — it would distort a CV signal blended through it.
//
// Fade (bipolar knob, -1..1) sets the blend position: -1 = full A, 0 = equal
// A/B mix, +1 = full B. CV combines with Fade using the same bipolar-CV
// convention as filter.ts's Res + Res CV: normalized by CV_BIPOLAR_MAX and
// summed directly (this module has no separate CV Amt control), then clamped to
// the knob's own [-1, 1] range before mapping to the [0, 1] blend position
// t = (fade + 1) / 2 — so CV can drive the fade all the way to either exact
// endpoint. Unpatched A/B/CV all read as 0 V (silence / no CV offset), so
// fading toward an unpatched side fades to silence.
// DC-coupled; no clipping.
//
// Jack layout:
//   ins[0] = A   ins[1] = B   ins[2] = CV
//   outs[0] = Out
//   params[0] = Fade (-1..1 bipolar)

import type { Kernel } from "../engine/kernel";
import { CV_BIPOLAR_MAX } from "../engine/units";

interface CrossfaderState {}

export const crossfaderKernel: Kernel<CrossfaderState> = {
  init(_sr): CrossfaderState {
    return {};
  },

  process(_state, ins, outs, params, n) {
    const inA = ins[0];
    const inB = ins[1];
    const inCv = ins[2];
    const out = outs[0];

    let fade = params[0];
    if (!Number.isFinite(fade)) fade = 0;
    else if (fade < -1) fade = -1;
    else if (fade > 1) fade = 1;

    if (inCv === null) {
      const t = (fade + 1) / 2;
      const g1 = 1 - t;
      for (let i = 0; i < n; i++) {
        const a = inA !== null && Number.isFinite(inA[i]) ? inA[i] : 0;
        const b = inB !== null && Number.isFinite(inB[i]) ? inB[i] : 0;
        out[i] = a * g1 + b * t;
      }
      return;
    }

    for (let i = 0; i < n; i++) {
      let total = fade;
      const cv = inCv[i];
      if (Number.isFinite(cv)) total += cv / CV_BIPOLAR_MAX;
      if (total < -1) total = -1;
      else if (total > 1) total = 1;
      const t = (total + 1) / 2;

      const a = inA !== null && Number.isFinite(inA[i]) ? inA[i] : 0;
      const b = inB !== null && Number.isFinite(inB[i]) ? inB[i] : 0;
      out[i] = a * (1 - t) + b * t;
    }
  },
};
