// Generic educational oscillator kernel for slug "oscillator".
// Implements Kernel<OscillatorState>. 1 V/oct pitch with Tune/Fine, linear FM
// (volts → Hz) and exponential FM (volts → octaves into the pitch exponent).
//
// Five simultaneous shape outputs (all ±AUDIO_NORM = ±5 V nominal audio):
//   Sine  — reference phase-accumulator sine.
//   Saw   — rising ramp, band-limited with a 2-sample PolyBLEP at the wrap.
//   Pulse — ±1 square at duty `pw`, PolyBLEP-corrected at both edges. `pw` is
//           the PW control plus the PWM input (see PWM mapping below), clamped
//           to [PW_MIN, PW_MAX].
//   Tri   — naive triangle, phase-aligned with Sine. Its harmonics fall off
//           ~1/n² so aliasing stays well below the fundamental at normal pitch;
//           no BLEP is needed for the educational quality bar.
//   Sub   — square one octave down (PolyBLEP, 50 % duty on a half-rate phase).
//
// PWM mapping: pulseWidth = clamp(PW + pwmVolts / (2·CV_BIPOLAR_MAX),
// PW_MIN, PW_MAX). ±5 V of PWM sweeps the duty ±0.5 around the knob before the
// clamp. A non-finite PWM sample reads as 0 V; an unpatched PWM leaves only PW.
//
// Sync (hard sync): a rising edge on Sync (Schmitt: fire ≥ GATE_FIRE_THRESHOLD_V,
// re-arm below GATE_REARM_THRESHOLD_V) resets both phases to 0 *before* the
// sample at that edge is written (the accumulator otherwise advances before
// writing). Sine/Tri read 0 at that phase; the BLEP-corrected edge waveforms
// (Saw, Pulse, Sub) read ≈ 0 on the reset sample, since PolyBLEP at phase 0
// cancels the naive step rather than jumping straight to ±max. Hard sync is a
// genuine discontinuity that PolyBLEP does not correct — a known, documented
// educational-quality trade-off, not band-limited sync.
//
// Jack/param layout (as assigned by the Interpreter, seed order):
//   ins[0]  = 1V/Oct   ins[1] = FM    ins[2] = EFM   ins[3] = Sync   ins[4] = PWM
//   outs[0] = Saw   outs[1] = Pulse   outs[2] = Tri   outs[3] = Sine   outs[4] = Sub
//   params[0] = Tune (oct)  params[1] = Fine (oct)  params[2] = FM Amt
//   params[3] = EFM Amt     params[4] = PW

import type { Kernel } from "../engine/kernel";
import {
  AUDIO_NORM,
  CV_BIPOLAR_MAX,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
  LINEAR_FM_HZ_PER_VOLT,
  voltsToHz,
} from "../engine/units";

// Frequency ceiling as a fraction of the sample rate — keeps the phase
// increment well under Nyquist. v1 has no negative/through-zero frequency,
// so the working range is [0, sr × this].
const MAX_FREQ_SR_RATIO = 0.45;

// Pulse-width clamp range — matches the registry ParamSpec for "PW".
const PW_MIN = 0.05;
const PW_MAX = 0.95;

const TWO_PI = 2 * Math.PI;

// Clean-room 2-sample PolyBLEP residual for a discontinuity at phase 0/1.
// `t` is the phase in [0, 1); `dt` the per-sample phase increment. Add the
// residual for an upward step, subtract it for a downward step. Both branches
// are monotone within their window (no ringing) and return 0 when dt ≤ 0
// (frozen 0 Hz), so no division by zero and no spurious zero crossings.
function polyBlep(t: number, dt: number): number {
  if (dt <= 0) return 0;
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1; // −(x−1)², range [−1, 0]
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1; // (x+1)², range [0, 1)
  }
  return 0;
}

interface OscillatorState {
  invSr: number; // 1 / sr, phase increment per Hz
  maxHz: number; // sr * MAX_FREQ_SR_RATIO
  phase: number; // main cycle phase in [0, 1)
  subPhase: number; // half-rate phase in [0, 1) for the Sub output
  syncHigh: boolean; // Schmitt state of the Sync input
}

export const oscillatorKernel: Kernel<OscillatorState> = {
  init(sr) {
    return {
      invSr: 1 / sr,
      maxHz: sr * MAX_FREQ_SR_RATIO,
      phase: 0,
      subPhase: 0,
      syncHigh: false,
    };
  },

  process(state, ins, outs, params, n) {
    const inPitch = ins[0];
    const inFm = ins[1];
    const inEfm = ins[2];
    const inSync = ins[3];
    const inPwm = ins[4];
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
    let pwBase = params[4];
    if (!Number.isFinite(pwBase)) pwBase = 0.5;

    const baseVolts = tune + fine;
    const fmHzPerVolt = fmAmt * LINEAR_FM_HZ_PER_VOLT;
    // ±CV_BIPOLAR_MAX of PWM → ±0.5 of duty around the knob (before clamp).
    const pwmScale = 1 / (2 * CV_BIPOLAR_MAX);

    const invSr = state.invSr;
    const maxHz = state.maxHz;
    let phase = state.phase;
    let subPhase = state.subPhase;
    let syncHigh = state.syncHigh;

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

      const inc = freqHz * invSr;

      // Advance both phases (this oscillator advances before writing).
      phase += inc;
      if (phase >= 1) phase -= 1;
      subPhase += inc * 0.5;
      if (subPhase >= 1) subPhase -= 1;

      // Hard sync: a rising edge on Sync overrides the advance for this sample,
      // pinning both phases to 0 before the waves are written (reset-before-write
      // convention). Non-finite samples read as 0 V (low).
      if (inSync !== null) {
        const v = inSync[i];
        const sv = Number.isFinite(v) ? v : 0;
        if (!syncHigh && sv >= GATE_FIRE_THRESHOLD_V) {
          syncHigh = true;
          phase = 0;
          subPhase = 0;
        } else if (syncHigh && sv < GATE_REARM_THRESHOLD_V) {
          syncHigh = false;
        }
      }

      // Saw: rising ramp; the wrap is a downward step, so subtract the BLEP.
      outSaw[i] = (2 * phase - 1 - polyBlep(phase, inc)) * AUDIO_NORM;

      // Pulse: ±1 square at duty `pw`. Rising edge at phase 0 (add BLEP),
      // falling edge at phase `pw` (subtract BLEP, shifted to the wrap point).
      let pw = pwBase;
      if (inPwm !== null) {
        const pv = inPwm[i];
        if (Number.isFinite(pv)) pw += pv * pwmScale;
      }
      if (pw < PW_MIN) pw = PW_MIN;
      else if (pw > PW_MAX) pw = PW_MAX;

      let pulse = phase < pw ? 1 : -1;
      pulse += polyBlep(phase, inc);
      let pf = phase + (1 - pw);
      if (pf >= 1) pf -= 1;
      pulse -= polyBlep(pf, inc);
      outPulse[i] = pulse * AUDIO_NORM;

      // Tri: naive, phase-aligned with Sine (both start at 0 rising).
      let tri;
      if (phase < 0.25) tri = 4 * phase;
      else if (phase < 0.75) tri = 2 - 4 * phase;
      else tri = 4 * phase - 4;
      outTri[i] = tri * AUDIO_NORM;

      outSine[i] = Math.sin(TWO_PI * phase) * AUDIO_NORM;

      // Sub: BLEP square one octave down (50 % duty on the half-rate phase).
      const subDt = inc * 0.5;
      let sub = subPhase < 0.5 ? 1 : -1;
      sub += polyBlep(subPhase, subDt);
      let sf = subPhase + 0.5;
      if (sf >= 1) sf -= 1;
      sub -= polyBlep(sf, subDt);
      outSub[i] = sub * AUDIO_NORM;
    }

    state.phase = phase;
    state.subPhase = subPhase;
    state.syncHigh = syncHigh;
  },
};
