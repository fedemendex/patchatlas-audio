// Generic educational oscillator kernel for slug "oscillator".
// Implements Kernel<OscillatorState>. 1 V/oct pitch with Tune/Fine, linear FM
// (volts → Hz) and exponential FM (volts → octaves into the pitch exponent).
//
// AP-6 ships Sine only: Saw, Pulse, Tri and Sub are intentionally written as
// silence every block (never left stale) until a follow-up adds PolyBLEP
// waves. Sync and PWM inputs are safely ignored for now — Sync hard-sync and
// PW/PWM only become meaningful with the deferred waves.
//
// Jack/param layout (as assigned by the Interpreter, seed order):
//   ins[0]  = 1V/Oct   ins[1] = FM    ins[2] = EFM   ins[3] = Sync   ins[4] = PWM
//   outs[0] = Saw   outs[1] = Pulse   outs[2] = Tri   outs[3] = Sine   outs[4] = Sub
//   params[0] = Tune (oct)  params[1] = Fine (oct)  params[2] = FM Amt
//   params[3] = EFM Amt     params[4] = PW

import type { Kernel } from "../engine/kernel";
import { AUDIO_NORM, LINEAR_FM_HZ_PER_VOLT, voltsToHz } from "../engine/units";

// Frequency ceiling as a fraction of the sample rate — keeps the phase
// increment well under Nyquist. v1 has no negative/through-zero frequency,
// so the working range is [0, sr × this].
const MAX_FREQ_SR_RATIO = 0.45;

const TWO_PI = 2 * Math.PI;

interface OscillatorState {
  sr: number;
  invSr: number; // 1 / sr, phase increment per Hz
  maxHz: number; // sr * MAX_FREQ_SR_RATIO
  phase: number; // cycle phase in [0, 1)
}

export const oscillatorKernel: Kernel<OscillatorState> = {
  init(sr) {
    return { sr, invSr: 1 / sr, maxHz: sr * MAX_FREQ_SR_RATIO, phase: 0 };
  },

  process(state, ins, outs, params, n) {
    const inPitch = ins[0];
    const inFm = ins[1];
    const inEfm = ins[2];
    const outSaw = outs[0];
    const outPulse = outs[1];
    const outTri = outs[2];
    const outSine = outs[3];
    const outSub = outs[4];

    // Non-finite params (NaN, ±Infinity) fall back to the spec defaults
    // instead of poisoning the phase accumulator.
    let tune = params[0];
    if (!Number.isFinite(tune)) tune = 0;
    let fine = params[1];
    if (!Number.isFinite(fine)) fine = 0;
    let fmAmt = params[2];
    if (!Number.isFinite(fmAmt)) fmAmt = 0;
    let efmAmt = params[3];
    if (!Number.isFinite(efmAmt)) efmAmt = 0;

    const baseVolts = tune + fine;
    const fmHzPerVolt = fmAmt * LINEAR_FM_HZ_PER_VOLT;

    const invSr = state.invSr;
    const maxHz = state.maxHz;
    let phase = state.phase;

    for (let i = 0; i < n; i++) {
      let pitchVolts = baseVolts;
      if (inPitch !== null) pitchVolts += inPitch[i];
      if (inEfm !== null) pitchVolts += inEfm[i] * efmAmt;

      let freqHz = voltsToHz(pitchVolts);
      if (inFm !== null) freqHz += inFm[i] * fmHzPerVolt;
      // No negative/through-zero FM in v1. The inverted comparison also
      // catches NaN (from non-finite input samples), forcing it to 0 Hz so
      // one bad sample can never poison the phase accumulator.
      if (!(freqHz >= 0)) freqHz = 0;
      else if (freqHz > maxHz) freqHz = maxHz;

      phase += freqHz * invSr;
      if (phase >= 1) phase -= 1;

      outSine[i] = Math.sin(TWO_PI * phase) * AUDIO_NORM;

      // Deferred waves: explicit silence, never stale samples.
      outSaw[i] = 0;
      outPulse[i] = 0;
      outTri[i] = 0;
      outSub[i] = 0;
    }

    state.phase = phase;
  },
};
