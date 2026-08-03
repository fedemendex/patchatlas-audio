// Noise source kernel for slug "noise-source".
//
// Four outputs: White, Pink, Red, Blue. All four are implemented; Red and
// Blue are approximate colorings, not lab-grade spectral models.
//
// White: a uniform draw in [-CV_BIPOLAR_MAX, +CV_BIPOLAR_MAX) per sample.
// Expected RMS for a uniform ±a signal is a/√3, i.e. ≈ 2.886 V here.
//
// Pink: Paul Kellet's "economy" pinking filter — three one-pole lowpass
// branches at different corner frequencies plus the raw white sample,
// summed with fixed gains (http://www.firstpr.com.au/dsp/pink-noise/). This
// is a "one-pole-sum" approximation: a rough −3 dB/oct trend over the
// audible range, not exact 1/f noise.
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
// Red: a leaky integrator (one-pole lowpass) fed by the same unit-scale
// white draw: redState = RED_LEAK_COEFF*redState + whiteUnit*RED_WHITE_GAIN.
// RED_LEAK_COEFF < 1 keeps this a bounded AR(1) process rather than an
// unbounded random walk (a true integrator, leak = 1, drifts without
// limit). This is preview-quality brown/red-ish noise — a rough low-frequency
// trend, not a calibrated −6 dB/oct spectral model. Scaled to volts and
// hard-clamped to ±CV_BIPOLAR_MAX as the same source-range guard as Pink.
//
// Blue: a first-difference (one-sample high-pass) of the unit-scale white
// draw: blueUnit = (whiteUnit − previousWhiteUnit) * BLUE_DIFF_GAIN. This
// doubles high-frequency energy the way differencing always does (the same
// mechanism the white-noise spectrum test exercises), giving a rough
// +6 dB/oct trend — preview-quality blue-ish noise, not a calibrated
// spectral model. Scaled to volts and hard-clamped to ±CV_BIPOLAR_MAX; the
// clamp matters more here since two independent uniform draws can add
// constructively past the nominal range.
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
// Scope: "noise-source" is the package's only noise module — a clean
// no-input/no-control source. A clocked random-voltage module (Clk/Rate CV in,
// Rand CV/Rand Gate out) is deliberately not registered: it overlaps with
// sample-and-hold plus clock, which already compose into the same behaviour.
//
// Jack/param layout (registry declaration order):
//   ins: none
//   outs[0] = White  outs[1] = Pink  outs[2] = Red  outs[3] = Blue
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

// Red (leaky integrator): leak < 1 keeps the AR(1) process bounded instead of
// an unbounded random walk; the gain is tuned (with the leak) to keep Red's
// stationary RMS well within the ±CV_BIPOLAR_MAX source range before clamping.
const RED_LEAK_COEFF = 0.98;
const RED_WHITE_GAIN = 0.1;

// Blue (first difference): gain on (current - previous) white sample, tuned
// so Blue's typical amplitude sits near White's while its clamp still
// catches the occasional constructive peak from two independent draws.
const BLUE_DIFF_GAIN = 0.8;

const U32_SCALE = 1 / 4294967296; // 2^32, converts an unsigned 32-bit int to [0, 1)

/** Source-range guard shared by Pink/Red/Blue: hard-clamps to ±CV_BIPOLAR_MAX. */
function clampToBipolarRange(v: number): number {
  if (v > CV_BIPOLAR_MAX) return CV_BIPOLAR_MAX;
  if (v < -CV_BIPOLAR_MAX) return -CV_BIPOLAR_MAX;
  return v;
}

interface NoiseSourceState {
  rngState: number; // xorshift32 state; always kept nonzero
  pinkB0: number;
  pinkB1: number;
  pinkB2: number;
  redState: number; // leaky integrator accumulator (unit scale, pre-CV_BIPOLAR_MAX)
  prevWhiteUnit: number; // previous unit-scale white draw, for Blue's difference
}

export const noiseSourceKernel: Kernel<NoiseSourceState> = {
  init(): NoiseSourceState {
    return {
      rngState: RNG_SEED,
      pinkB0: 0,
      pinkB1: 0,
      pinkB2: 0,
      redState: 0,
      prevWhiteUnit: 0,
    };
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
    let red = state.redState;
    let prevWhiteUnit = state.prevWhiteUnit;

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
      const pink =
        (b0 + b1 + b2 + whiteUnit * PINK_WHITE_GAIN_OUT) * PINK_GAIN_COMPENSATION * CV_BIPOLAR_MAX;
      // Source-range guard (not DAC clipping — see header note): bounds the
      // rare hot peak this filter's heavier-than-uniform tail can still
      // produce after gain compensation.
      outPink[i] = clampToBipolarRange(pink);

      red = RED_LEAK_COEFF * red + whiteUnit * RED_WHITE_GAIN;
      outRed[i] = clampToBipolarRange(red * CV_BIPOLAR_MAX);

      const blueUnit = (whiteUnit - prevWhiteUnit) * BLUE_DIFF_GAIN;
      outBlue[i] = clampToBipolarRange(blueUnit * CV_BIPOLAR_MAX);
      prevWhiteUnit = whiteUnit;
    }

    state.rngState = rng;
    state.pinkB0 = b0;
    state.pinkB1 = b1;
    state.pinkB2 = b2;
    state.redState = red;
    state.prevWhiteUnit = prevWhiteUnit;
  },
};
