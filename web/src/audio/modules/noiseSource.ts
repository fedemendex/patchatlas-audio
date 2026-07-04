// Noise source kernel for slug "noise-source".
//
// The seed's four outputs are White, Pink, Red, Blue. Only White (required)
// and Pink (a small, standard approximation) are implemented in AP-11; Red
// and Blue write silence — see the deferral note below.
//
// White: a uniform draw in [-CV_BIPOLAR_MAX, +CV_BIPOLAR_MAX) per sample.
// Expected RMS for a uniform ±a signal is a/√3, i.e. ≈ 2.886 V here.
//
// Pink: Paul Kellet's "economy" pinking filter — three one-pole lowpass
// branches at different corner frequencies plus the raw white sample,
// summed with fixed gains (http://www.firstpr.com.au/dsp/pink-noise/). This
// is the "one-pole-sum" approximation named in the roadmap issue: a rough
// −3 dB/oct trend over the audible range, not exact 1/f noise.
//
// The raw Kellet sum is not itself scaled to a unit range (its stationary
// RMS runs well above the white input's), so PINK_GAIN_COMPENSATION brings
// it back in line with White's RMS: empirically calibrated offline for this
// exact coefficient set (2M-sample render) to put pink RMS at the same
// order of magnitude as white RMS. Even compensated, occasional summed
// peaks can still exceed ±CV_BIPOLAR_MAX (pink's tail is heavier than
// White's hard-bounded uniform distribution), so the output is additionally
// hard-clamped to ±CV_BIPOLAR_MAX as source-range enforcement — this is
// this module staying within its own nominal output range, not the
// audio-output DAC's tanh soft-clip/drive stage (signals.md's "clipping
// happens only in audio-output" refers to volts→float DAC conversion; this
// clamp never converts volts to floats and is not a substitute for it).
//
// RNG: xorshift32 (Marsaglia), a small deterministic 32-bit PRNG. Its state
// lives entirely in the per-kernel state object allocated by init() — never
// a module-level/global variable — so two freshly initialized kernels
// produce an identical sequence, and one running kernel's sequence keeps
// evolving without repeating trivially. Seeded to a fixed nonzero 32-bit
// constant (xorshift is degenerate at an all-zero state, so 0 must never be
// used or reached — it never is, since xorshift32 is a bijection on the
// nonzero states).
//
// Deferred: Red and Blue outputs are silence (0 V) in AP-11. Neither is
// named in the roadmap issue's scope, and adding correct integrated
// (red/brown) or differentiated (blue) noise coloring is left to a
// follow-up if a patch needs it.
//
// Deferred: "noise-random" (a second seeded noise slug with Clk/Rate CV
// inputs and White/Pink/Rand CV/Rand Gate outputs) is NOT registered here.
// noise-source is the canonical playable noise slug for AP-11: its seed
// entry is a clean no-input/no-control noise source, while noise-random's
// seed entry has a malformed `outputs` array (plain strings instead of
// `{name, group}` objects — inconsistent with every other seeded module)
// and overlaps with sample-and-hold/clock functionality out of scope here.
//
// Jack/param layout (seed declaration order):
//   ins: none
//   outs[0] = White  outs[1] = Pink  outs[2] = Red (silent)  outs[3] = Blue (silent)
//   params: none

import type { Kernel } from "../engine/kernel";
import { CV_BIPOLAR_MAX } from "../engine/units";

// xorshift32 seed: any fixed nonzero 32-bit value works; this one is
// arbitrary (it is not a "magic" tuning constant from units.ts — it is the
// PRNG's fixed seed, analogous to a test fixture constant).
const RNG_SEED = 0x9e3779b9;

// Paul Kellet's "economy" pinking-filter coefficients.
const PINK_B0_COEFF = 0.99765;
const PINK_B1_COEFF = 0.963;
const PINK_B2_COEFF = 0.57;
const PINK_WHITE_GAIN_B0 = 0.099046;
const PINK_WHITE_GAIN_B1 = 0.2965164;
const PINK_WHITE_GAIN_B2 = 1.0526913;
const PINK_WHITE_GAIN_OUT = 0.1848;

// Empirically calibrated (see header note above) so this filter's RMS lands
// at the same order of magnitude as White's ±CV_BIPOLAR_MAX uniform RMS.
const PINK_GAIN_COMPENSATION = 0.22;

const U32_SCALE = 1 / 4294967296; // 2^32, converts an unsigned 32-bit int to [0, 1)

interface NoiseSourceState {
  rngState: number; // xorshift32 state; always kept nonzero
  pinkB0: number;
  pinkB1: number;
  pinkB2: number;
}

export const noiseSourceKernel: Kernel<NoiseSourceState> = {
  init(): NoiseSourceState {
    return { rngState: RNG_SEED, pinkB0: 0, pinkB1: 0, pinkB2: 0 };
  },

  process(state, _ins, outs, _params, n) {
    const outWhite = outs[0];
    const outPink = outs[1];
    const outRed = outs[2];
    const outBlue = outs[3];

    let rng = state.rngState;
    let b0 = state.pinkB0;
    let b1 = state.pinkB1;
    let b2 = state.pinkB2;

    for (let i = 0; i < n; i++) {
      // xorshift32 step (Marsaglia).
      rng ^= rng << 13;
      rng ^= rng >>> 17;
      rng ^= rng << 5;

      // Unsigned uniform in [0, 1), then a unit-scale bipolar draw in [-1, 1).
      const uniform01 = (rng >>> 0) * U32_SCALE;
      const whiteUnit = uniform01 * 2 - 1;

      outWhite[i] = whiteUnit * CV_BIPOLAR_MAX;

      b0 = PINK_B0_COEFF * b0 + whiteUnit * PINK_WHITE_GAIN_B0;
      b1 = PINK_B1_COEFF * b1 + whiteUnit * PINK_WHITE_GAIN_B1;
      b2 = PINK_B2_COEFF * b2 + whiteUnit * PINK_WHITE_GAIN_B2;
      let pink =
        (b0 + b1 + b2 + whiteUnit * PINK_WHITE_GAIN_OUT) * PINK_GAIN_COMPENSATION * CV_BIPOLAR_MAX;
      // Source-range guard (not DAC clipping — see header note): bounds the
      // rare hot peak this filter's heavier-than-uniform tail can still
      // produce after gain compensation.
      if (pink > CV_BIPOLAR_MAX) pink = CV_BIPOLAR_MAX;
      else if (pink < -CV_BIPOLAR_MAX) pink = -CV_BIPOLAR_MAX;
      outPink[i] = pink;

      outRed[i] = 0;
      outBlue[i] = 0;
    }

    state.rngState = rng;
    state.pinkB0 = b0;
    state.pinkB1 = b1;
    state.pinkB2 = b2;
  },
};
