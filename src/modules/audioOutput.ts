// DAC sink kernel: the only place where virtual volts become output floats.
// Implements Kernel<AudioOutputState> for slug "audio-output".
//
// Jack layout (as assigned by the Interpreter):
//   ins[0]  = L In     (null when unpatched)
//   ins[1]  = R In     (null when unpatched)
//   outs[0] = internal DAC left buffer  (consumed by Interpreter.readOutput)
//   outs[1] = internal DAC right buffer
//   params[0] = Level  (0..1, default 0.8)
//
// Mono-normalization: if only one side is patched, that signal feeds both
// channels. If neither is patched, both channels output silence.
//
// Per-sample chain: volts / AUDIO_NORM → DC blocker → tanh → × Level.
// DC blocker: y = x − x₋₁ + R·y₋₁, where R = 1 − 2π·DC_BLOCKER_CUTOFF_HZ/sr,
// cutting below ~10 Hz. State is kept per channel so stereo inputs are independent.
// In mono mode (exactly one side patched), a single DC-blocker pass feeds both
// outputs — guaranteeing bit-identical samples regardless of prior stereo history.

import type { Kernel } from "../engine/kernel";
import { AUDIO_NORM, DC_BLOCKER_CUTOFF_HZ } from "../engine/units";

interface AudioOutputState {
  R: number;    // DC blocker pole coefficient, computed once at init
  dcXL: number; // previous normalized input, L channel
  dcYL: number; // previous high-pass output, L channel
  dcXR: number; // previous normalized input, R channel
  dcYR: number; // previous high-pass output, R channel
}

export const audioOutputKernel: Kernel<AudioOutputState> = {
  init(sr) {
    return {
      R: 1 - (2 * Math.PI * DC_BLOCKER_CUTOFF_HZ) / sr,
      dcXL: 0,
      dcYL: 0,
      dcXR: 0,
      dcYR: 0,
    };
  },

  process(state, ins, outs, params, n) {
    const inL = ins[0];
    const inR = ins[1];
    const outL = outs[0];
    const outR = outs[1];

    // Non-finite Level (NaN, ±Infinity) falls back to the param default (0.8).
    const rawLevel = params[0];
    const level = Number.isFinite(rawLevel) ? (rawLevel < 0 ? 0 : rawLevel > 1 ? 1 : rawLevel) : 0.8;

    const R = state.R;
    let dcXL = state.dcXL;
    let dcYL = state.dcYL;
    let dcXR = state.dcXR;
    let dcYR = state.dcYR;

    if (inL !== null && inR !== null) {
      // Stereo: process each channel through its own DC blocker state.
      for (let i = 0; i < n; i++) {
        const xL = inL[i] / AUDIO_NORM;
        const yL = xL - dcXL + R * dcYL;
        dcXL = xL;
        dcYL = yL;
        outL[i] = Math.tanh(yL) * level;

        const xR = inR[i] / AUDIO_NORM;
        const yR = xR - dcXR + R * dcYR;
        dcXR = xR;
        dcYR = yR;
        outR[i] = Math.tanh(yR) * level;
      }
    } else if (inL !== null) {
      // L-only mono: one pass through L state; copy sample to R for bit-identical output.
      for (let i = 0; i < n; i++) {
        const xL = inL[i] / AUDIO_NORM;
        const yL = xL - dcXL + R * dcYL;
        dcXL = xL;
        dcYL = yL;
        const s = Math.tanh(yL) * level;
        outL[i] = s;
        outR[i] = s;
      }
    } else if (inR !== null) {
      // R-only mono: one pass through R state; copy sample to L for bit-identical output.
      for (let i = 0; i < n; i++) {
        const xR = inR[i] / AUDIO_NORM;
        const yR = xR - dcXR + R * dcYR;
        dcXR = xR;
        dcYR = yR;
        const s = Math.tanh(yR) * level;
        outL[i] = s;
        outR[i] = s;
      }
    } else {
      // Neither patched: silence.
      for (let i = 0; i < n; i++) {
        outL[i] = 0;
        outR[i] = 0;
      }
    }

    state.dcXL = dcXL;
    state.dcYL = dcYL;
    state.dcXR = dcXR;
    state.dcYR = dcYR;
  },
};
