// Wavefolder kernel for slug "wavefolder".
// A clean digital triangle/reflection folder — Patch Atlas's generic educational
// preview model, not a claim to emulate any specific Buchla/Serge folding circuit.
//
// Folding function: closed-form triangle-wave reflection via asin(sin(.)), exact
// (not an approximation) for the linear region and reflecting beyond it:
//
//   u   = (pi / (2*T)) * driven
//   out = (2*T / pi) * asin(sin(u))
//
// For |driven| <= T this reduces exactly to out = driven (asin is the true
// inverse of sin over [-pi/2, pi/2]) — a bit-exact unity-gain passthrough, not
// a curve that merely approaches one. Beyond T, the signal reflects back down
// (and continues reflecting for larger excursions), which is the textbook
// triangle/reflection fold. Math.sin/Math.asin are bounded for any finite
// argument, so |out| never exceeds T regardless of how large driven gets —
// bounded output and NaN/Infinity-safety fall out of the formula itself, no
// separate clamp needed on the output.
//
// Signal path:
//   driven = In * foldGain + biasVolts
//   foldGain = Fold (+ Fold CV, summed) clamped to [FOLD_GAIN_MIN, FOLD_GAIN_MAX]
//   biasVolts = Bias * BIAS_MAX_FRAC * AUDIO_NORM
//   T (fold threshold) is asymmetric per polarity of `driven`, set by Sym
//   (+ Sym CV): T_pos = AUDIO_NORM*(1 - sym*SYM_DEPTH), T_neg = AUDIO_NORM*(1 + sym*SYM_DEPTH)
//
// At Fold = FOLD_GAIN_MIN (1x), Sym = 0, Bias = 0: driven = In, T = AUDIO_NORM,
// and any input within the nominal +/-5V audio range folds not at all — an
// exact passthrough, not silence or heavy coloration. Turning Fold up drives
// more of the signal past the threshold, producing additional folds (more
// zero-crossings / harmonic complexity) as amplitude increases. Near driven=0
// the slope of the fold function is always exactly 1 regardless of T, so low-
// level signal stays clean even with Sym/Bias engaged; only larger excursions
// fold.
//
// No oversampling in this v1: a hard reflection introduces new harmonics above
// the input's bandwidth, and without band-limiting they can alias above
// Nyquist at high Fold settings on bright material — a known, documented
// preview-quality trade-off (see docs/audio/signals.md), not a hidden CPU cost.
//
// Jack layout:
//   ins[0] = In        ins[1] = Fold CV     ins[2] = Sym CV
//   outs[0] = Out
//   params[0] = Fold (1..8, exponential, default 1 = passthrough gain)
//   params[1] = Sym  (-1..1, linear, default 0 = symmetric)
//   params[2] = Bias (-1..1, linear, default 0 = no offset)

import type { Kernel } from "../engine/kernel";
import { AUDIO_NORM, CV_BIPOLAR_MAX } from "../engine/units";

// Local design constants (not signal-standard values — see units.ts for those).
const FOLD_GAIN_MIN = 1; // unity gain into the folder: passthrough at the audio norm
const FOLD_GAIN_MAX = 8; // strong folding: up to ~3 reflections at full audio-range input
const SYM_DEPTH = 0.6; // max fractional threshold skew from Sym (keeps both thresholds > 0)
const BIAS_MAX_FRAC = 0.6; // Bias knob's max DC offset, as a fraction of AUDIO_NORM

interface WavefolderState {}

export const wavefolderKernel: Kernel<WavefolderState> = {
  init(_sr): WavefolderState {
    return {};
  },

  process(_state, ins, outs, params, n) {
    const inAudio = ins[0];
    const inFoldCV = ins[1];
    const inSymCV = ins[2];
    const out = outs[0];

    let baseFold = params[0];
    if (!Number.isFinite(baseFold)) baseFold = FOLD_GAIN_MIN;
    else if (baseFold < FOLD_GAIN_MIN) baseFold = FOLD_GAIN_MIN;
    else if (baseFold > FOLD_GAIN_MAX) baseFold = FOLD_GAIN_MAX;

    let baseSym = params[1];
    if (!Number.isFinite(baseSym)) baseSym = 0;
    else if (baseSym < -1) baseSym = -1;
    else if (baseSym > 1) baseSym = 1;

    let baseBias = params[2];
    if (!Number.isFinite(baseBias)) baseBias = 0;
    else if (baseBias < -1) baseBias = -1;
    else if (baseBias > 1) baseBias = 1;

    const biasVolts = baseBias * BIAS_MAX_FRAC * AUDIO_NORM;

    for (let i = 0; i < n; i++) {
      let x = 0;
      if (inAudio !== null) {
        const v = inAudio[i];
        if (Number.isFinite(v)) x = v;
      }

      let fold = baseFold;
      if (inFoldCV !== null) {
        const v = inFoldCV[i];
        if (Number.isFinite(v)) fold += (v / CV_BIPOLAR_MAX) * (FOLD_GAIN_MAX - FOLD_GAIN_MIN);
      }
      if (fold < FOLD_GAIN_MIN) fold = FOLD_GAIN_MIN;
      else if (fold > FOLD_GAIN_MAX) fold = FOLD_GAIN_MAX;

      let sym = baseSym;
      if (inSymCV !== null) {
        const v = inSymCV[i];
        if (Number.isFinite(v)) sym += v / CV_BIPOLAR_MAX;
      }
      if (sym < -1) sym = -1;
      else if (sym > 1) sym = 1;

      const driven = x * fold + biasVolts;
      const threshold = driven >= 0 ? AUDIO_NORM * (1 - sym * SYM_DEPTH) : AUDIO_NORM * (1 + sym * SYM_DEPTH);

      const u = ((Math.PI / 2) * driven) / threshold;
      out[i] = ((2 * threshold) / Math.PI) * Math.asin(Math.sin(u));
    }
  },
};
