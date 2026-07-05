// Clock kernel for slug "clock".
//
// An internal-tempo clock generator + frequency divider. The Tempo knob sets a
// quarter-note rate (BPM); the main Clk output emits a trigger (GATE_HIGH_V for
// TRIGGER_SECONDS, per units.ts) on every quarter-note tick. Four division
// outputs (/2 /4 /8 /16) emit a trigger on every 2nd/4th/8th/16th parent tick,
// derived by counting parent ticks — never by independent timers — so a
// division pulse is always sample-aligned with the parent Clk tick that caused
// it (at tick 0 all five outputs fire on the same sample).
//
// Timing / drift strategy (structural rule: all musical time is generated here,
// sample by sample, on the audio thread — no setTimeout/rAF/Date.now anywhere):
//   period = sr · 60 / bpm  (samples per quarter tick, a float)
//   `phase` counts up by 1 each sample; a tick fires when phase >= period, then
//   phase -= period — carrying the sub-sample remainder forward forever. Ticks
//   therefore land at cumulative positions m·period accurate to within float
//   epsilon (±1 sample over any render), with zero rounding drift. periodSamples
//   is never rounded-and-accumulated.
//
// Run input (Schmitt latch, fire >= GATE_FIRE_THRESHOLD_V, re-arm below
// GATE_REARM_THRESHOLD_V): unpatched Run defaults to running. Patched Run high
// runs, low stops (outputs forced low, phase frozen, in-flight pulses cleared);
// non-finite Run samples hold the current run state.
//
// Reset input (Schmitt rising edge): restarts the clock to its power-on state —
// the divide counter returns to 0 and a downbeat tick fires on the reset sample
// itself (same convention as init, so reset is indistinguishable from a fresh
// start). Reset is processed before the fire check, so its tick is emitted at
// the reset sample.
//
// Non-finite Tempo falls back to DEFAULT_BPM; Tempo is clamped to
// [TEMPO_MIN_BPM, TEMPO_MAX_BPM] so period is always finite and positive.
//
// Jack/param layout (registry declaration order):
//   ins[0] = Run   ins[1] = Rst
//   outs[0] = Clk  outs[1] = /2  outs[2] = /4  outs[3] = /8  outs[4] = /16
//   params[0] = Tempo (BPM)
//
// Deferred (declared in the seed, intentionally not wired here — mirrors the
// S&H Slew precedent): the seed's `Ext Clk` input (external-clock sync, turning
// this into a divider of an incoming clock) and `Swing` control (an explicit
// AP-12 non-goal). Both are follow-ups; internal-tempo generation is the AP-12
// scope.

import type { Kernel } from "../engine/kernel";
import {
  GATE_HIGH_V,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
  TRIGGER_SECONDS,
} from "../engine/units";

// Tempo design constants (match the registry ParamSpec for "Tempo").
const TEMPO_MIN_BPM = 30;
const TEMPO_MAX_BPM = 300;
const DEFAULT_BPM = 120;

const SECONDS_PER_MINUTE = 60;

interface ClockState {
  sr: number;
  pulseSamples: number; // trigger high-length in samples (>= 1)
  phase: number; // samples since last tick (float; carries the drift-free remainder)
  tickPhase: number; // parent-tick counter 0..15 (wraps), drives the divisions
  needsDownbeat: boolean; // init/reset flag: force an immediate tick on the next sample
  running: boolean; // Schmitt latch for the Run input
  rstHigh: boolean; // Schmitt state of the Rst input (for rising-edge detection)
  tailClk: number; // remaining high samples per output
  tail2: number;
  tail4: number;
  tail8: number;
  tail16: number;
}

export const clockKernel: Kernel<ClockState> = {
  init(sr): ClockState {
    return {
      sr,
      pulseSamples: Math.max(1, Math.round(TRIGGER_SECONDS * sr)),
      phase: 0,
      tickPhase: 0,
      needsDownbeat: true, // fire a downbeat on the very first processed sample
      running: true,
      rstHigh: false,
      tailClk: 0,
      tail2: 0,
      tail4: 0,
      tail8: 0,
      tail16: 0,
    };
  },

  process(state, ins, outs, params, n) {
    const inRun = ins[0];
    const inRst = ins[1];
    const outClk = outs[0];
    const out2 = outs[1];
    const out4 = outs[2];
    const out8 = outs[3];
    const out16 = outs[4];

    const sr = state.sr;
    const pulseSamples = state.pulseSamples;

    // Non-finite Tempo falls back to the default; otherwise clamp to the knob range.
    let bpm = params[0];
    if (!Number.isFinite(bpm)) bpm = DEFAULT_BPM;
    else if (bpm < TEMPO_MIN_BPM) bpm = TEMPO_MIN_BPM;
    else if (bpm > TEMPO_MAX_BPM) bpm = TEMPO_MAX_BPM;
    const period = (sr * SECONDS_PER_MINUTE) / bpm; // always finite and > 0

    let phase = state.phase;
    let tickPhase = state.tickPhase;
    let needsDownbeat = state.needsDownbeat;
    let running = state.running;
    let rstHigh = state.rstHigh;
    let tailClk = state.tailClk;
    let tail2 = state.tail2;
    let tail4 = state.tail4;
    let tail8 = state.tail8;
    let tail16 = state.tail16;

    for (let i = 0; i < n; i++) {
      // Run latch: unpatched → running; patched → Schmitt hysteresis; a
      // non-finite sample holds the current state (no spurious stop).
      if (inRun === null) {
        running = true;
      } else {
        const rv = inRun[i];
        if (Number.isFinite(rv)) {
          if (rv >= GATE_FIRE_THRESHOLD_V) running = true;
          else if (rv < GATE_REARM_THRESHOLD_V) running = false;
        }
      }

      // Reset: Schmitt rising edge → schedule an immediate downbeat. Non-finite
      // samples read as 0 V (low), so they never fire.
      let rstV = 0;
      if (inRst !== null) {
        const v = inRst[i];
        if (Number.isFinite(v)) rstV = v;
      }
      if (!rstHigh && rstV >= GATE_FIRE_THRESHOLD_V) {
        rstHigh = true;
        needsDownbeat = true;
      } else if (rstHigh && rstV < GATE_REARM_THRESHOLD_V) {
        rstHigh = false;
      }

      if (needsDownbeat) {
        phase = period; // >= period forces a fire on this sample
        tickPhase = 0;
        tailClk = 0;
        tail2 = 0;
        tail4 = 0;
        tail8 = 0;
        tail16 = 0;
        needsDownbeat = false;
      }

      if (running) {
        if (phase >= period) {
          phase -= period;
          tailClk = pulseSamples;
          if ((tickPhase & 1) === 0) tail2 = pulseSamples; // every 2nd parent tick
          if ((tickPhase & 3) === 0) tail4 = pulseSamples; // every 4th
          if ((tickPhase & 7) === 0) tail8 = pulseSamples; // every 8th
          if ((tickPhase & 15) === 0) tail16 = pulseSamples; // every 16th
          tickPhase = (tickPhase + 1) & 15;
        }
        phase += 1;

        outClk[i] = tailClk > 0 ? GATE_HIGH_V : 0;
        if (tailClk > 0) tailClk--;
        out2[i] = tail2 > 0 ? GATE_HIGH_V : 0;
        if (tail2 > 0) tail2--;
        out4[i] = tail4 > 0 ? GATE_HIGH_V : 0;
        if (tail4 > 0) tail4--;
        out8[i] = tail8 > 0 ? GATE_HIGH_V : 0;
        if (tail8 > 0) tail8--;
        out16[i] = tail16 > 0 ? GATE_HIGH_V : 0;
        if (tail16 > 0) tail16--;
      } else {
        // Stopped: outputs low, phase frozen, in-flight pulses cleared so a
        // resume starts cleanly and deterministically.
        tailClk = 0;
        tail2 = 0;
        tail4 = 0;
        tail8 = 0;
        tail16 = 0;
        outClk[i] = 0;
        out2[i] = 0;
        out4[i] = 0;
        out8[i] = 0;
        out16[i] = 0;
      }
    }

    state.phase = phase;
    state.tickPhase = tickPhase;
    state.needsDownbeat = needsDownbeat;
    state.running = running;
    state.rstHigh = rstHigh;
    state.tailClk = tailClk;
    state.tail2 = tail2;
    state.tail4 = tail4;
    state.tail8 = tail8;
    state.tail16 = tail16;
  },
};
