// Clock kernel for slug "clock".
//
// An internal-tempo clock generator + frequency divider that can also slave to
// an external clock. The Tempo knob sets a quarter-note rate (BPM); the main Clk
// output emits a trigger (GATE_HIGH_V for TRIGGER_SECONDS, per units.ts) on every
// quarter-note tick. Four division outputs (/2 /4 /8 /16) emit a trigger on every
// 2nd/4th/8th/16th parent tick, derived by counting parent ticks — never by
// independent timers — so a division pulse is always sample-aligned with the
// parent Clk tick that caused it (at tick 0 all five outputs fire on the same
// sample).
//
// Timing / drift strategy (structural rule: all musical time is generated here,
// sample by sample, on the audio thread — no setTimeout/rAF/Date.now anywhere):
//   period = sr · 60 / bpm  (samples per quarter tick, a float)
//   `phase` counts up by 1 each sample; a tick fires when phase >= currentPeriod,
//   then phase -= currentPeriod — carrying the sub-sample remainder forward
//   forever. Ticks therefore land at cumulative positions accurate to within
//   float epsilon (±1 sample over any render), with zero rounding drift.
//   periodSamples is never rounded-and-accumulated.
//
// Swing (internal BPM clock only): the Swing knob (bipolar −1..+1) delays every
// second parent tick within a two-tick cycle without cumulative drift. With
// P = base period and delay = swing · MAX_SWING_DELAY_RATIO · P, parent ticks land
// at 0, P+delay, 2P, 3P+delay, 4P, … — alternating long/short intervals
//   interval A = P + delay   (even tick → odd tick)
//   interval B = P − delay   (odd tick → even tick)
// so every two-tick cycle sums to exactly 2P (no drift) and even ticks stay
// pinned to k·P. The threshold used for each fire is chosen by tick parity
// (tickPhase & 1): odd ticks use A, even ticks use B, so the accumulator subtracts
// exactly the interval it just measured. MAX_SWING_DELAY_RATIO = 1/3 keeps
// |delay| ≤ P/3, so B is always positive (intervals never collapse). swing = 0
// (or a non-finite reading) reduces A = B = P — bit-for-bit the straight clock.
// Positive swing delays the offbeat (standard shuffle); negative swing pushes it
// early. Division outputs derive from the swung parent ticks (the /2 /4 /8 /16
// outputs fire on even ticks, so they land on the un-delayed downbeats).
//
// External clock (Ext Clk input): when Ext Clk is patched it REPLACES the internal
// BPM generator as the parent-tick source — a rising edge (Schmitt: fire >=
// GATE_FIRE_THRESHOLD_V, re-arm < GATE_REARM_THRESHOLD_V) emits the main Clk
// trigger on that same sample and advances the divide counter, so /2 /4 /8 /16
// count external ticks exactly as they count internal ticks. A sustained-high
// Ext Clk fires once until it re-arms; non-finite Ext Clk samples hold the latch
// and never fire. Swing applies to the internal BPM clock only — the external
// clock is passed through sample-accurately and used as the parent tick source
// (offbeats are NOT re-timed). When Ext Clk is unpatched, behavior is exactly the
// internal-tempo clock. init/reset re-zero the divide counter for external ticks
// too, so the next external edge after a reset is a downbeat (all divisions fire).
//
// Run input (Schmitt latch, fire >= GATE_FIRE_THRESHOLD_V, re-arm below
// GATE_REARM_THRESHOLD_V): unpatched Run defaults to running. Patched Run high
// runs, low stops (outputs forced low, phase frozen, in-flight pulses cleared);
// non-finite Run samples hold the current run state. (Applies to both internal
// and external modes: while stopped, external edges are ignored.)
//
// Reset input (Schmitt rising edge): restarts the clock to its power-on state —
// the divide counter returns to 0 and (internal mode) a downbeat tick fires on
// the reset sample itself (same convention as init). In external mode reset only
// re-zeros the divide counter/phase; the next external rising edge is the new
// downbeat (Clk fires only on external edges).
//
// Non-finite Tempo falls back to DEFAULT_BPM; Tempo is clamped to
// [TEMPO_MIN_BPM, TEMPO_MAX_BPM] so period is always finite and positive.
// Non-finite Swing falls back to 0 (straight timing); Swing is clamped to
// [SWING_MIN, SWING_MAX].
//
// Jack/param layout (registry declaration order):
//   ins[0] = Ext Clk  ins[1] = Run  ins[2] = Rst
//   outs[0] = Clk  outs[1] = /2  outs[2] = /4  outs[3] = /8  outs[4] = /16
//   params[0] = Tempo (BPM)  params[1] = Swing (−1..+1)

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

// Swing design constants (match the registry ParamSpec for "Swing", a bipolar
// knob). MAX_SWING_DELAY_RATIO is the fraction of one base period by which a
// fully-swung offbeat is displaced; 1/3 (a "triplet"-ish feel) keeps the delay
// safely below a full period so the shortened interval never reaches zero.
const SWING_MIN = -1;
const SWING_MAX = 1;
const MAX_SWING_DELAY_RATIO = 1 / 3;

const SECONDS_PER_MINUTE = 60;

interface ClockState {
  sr: number;
  pulseSamples: number; // trigger high-length in samples (>= 1)
  phase: number; // samples since last tick (float; carries the drift-free remainder)
  tickPhase: number; // parent-tick counter 0..15 (wraps), drives divisions + swing parity
  needsDownbeat: boolean; // init/reset flag: force an immediate tick (internal) / re-zero counter (external)
  running: boolean; // Schmitt latch for the Run input
  rstHigh: boolean; // Schmitt state of the Rst input (for rising-edge detection)
  extHigh: boolean; // Schmitt state of the Ext Clk input (for rising-edge detection)
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
      extHigh: false,
      tailClk: 0,
      tail2: 0,
      tail4: 0,
      tail8: 0,
      tail16: 0,
    };
  },

  process(state, ins, outs, params, n) {
    const inExt = ins[0];
    const inRun = ins[1];
    const inRst = ins[2];
    const outClk = outs[0];
    const out2 = outs[1];
    const out4 = outs[2];
    const out8 = outs[3];
    const out16 = outs[4];

    const sr = state.sr;
    const pulseSamples = state.pulseSamples;

    // Ext Clk patched → external clock is the parent-tick source; the internal
    // BPM generator (and swing) is bypassed.
    const external = inExt !== null;

    // Non-finite Tempo falls back to the default; otherwise clamp to the knob range.
    let bpm = params[0];
    if (!Number.isFinite(bpm)) bpm = DEFAULT_BPM;
    else if (bpm < TEMPO_MIN_BPM) bpm = TEMPO_MIN_BPM;
    else if (bpm > TEMPO_MAX_BPM) bpm = TEMPO_MAX_BPM;
    const period = (sr * SECONDS_PER_MINUTE) / bpm; // always finite and > 0

    // Non-finite Swing falls back to straight; clamp to the bipolar knob range.
    let swing = params[1];
    if (!Number.isFinite(swing)) swing = 0;
    else if (swing < SWING_MIN) swing = SWING_MIN;
    else if (swing > SWING_MAX) swing = SWING_MAX;
    // Alternating interval thresholds. |swingDelay| <= period/3 so periodB > 0.
    const swingDelay = swing * MAX_SWING_DELAY_RATIO * period;
    const periodA = period + swingDelay; // even tick → odd tick
    const periodB = period - swingDelay; // odd tick → even tick

    let phase = state.phase;
    let tickPhase = state.tickPhase;
    let needsDownbeat = state.needsDownbeat;
    let running = state.running;
    let rstHigh = state.rstHigh;
    let extHigh = state.extHigh;
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

      // Reset: Schmitt rising edge → schedule a downbeat. Non-finite samples
      // read as 0 V (low), so they never fire.
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
        tickPhase = 0;
        tailClk = 0;
        tail2 = 0;
        tail4 = 0;
        tail8 = 0;
        tail16 = 0;
        // Internal: preset phase to the tick-0 threshold (periodB, since
        // tickPhase 0 is even) so a downbeat fires on this sample. External:
        // the downbeat is the next external rising edge — just re-zero phase.
        phase = external ? 0 : periodB;
        needsDownbeat = false;
      }

      if (running) {
        // A parent tick fires from the external edge (external mode) or the
        // internal swung accumulator (internal mode). `fire` triggers a single
        // shared emit path so divisions count identically in both modes.
        let fire = false;

        if (external) {
          // Ext Clk rising edge (Schmitt). Non-finite samples hold the latch.
          const ev = (inExt as Float32Array)[i];
          if (Number.isFinite(ev)) {
            if (!extHigh && ev >= GATE_FIRE_THRESHOLD_V) {
              extHigh = true;
              fire = true;
            } else if (extHigh && ev < GATE_REARM_THRESHOLD_V) {
              extHigh = false;
            }
          }
        } else {
          // Internal: threshold alternates by tick parity for swing.
          const currentPeriod = (tickPhase & 1) === 1 ? periodA : periodB;
          if (phase >= currentPeriod) {
            phase -= currentPeriod;
            fire = true;
          }
          phase += 1;
        }

        if (fire) {
          tailClk = pulseSamples;
          if ((tickPhase & 1) === 0) tail2 = pulseSamples; // every 2nd parent tick
          if ((tickPhase & 3) === 0) tail4 = pulseSamples; // every 4th
          if ((tickPhase & 7) === 0) tail8 = pulseSamples; // every 8th
          if ((tickPhase & 15) === 0) tail16 = pulseSamples; // every 16th
          tickPhase = (tickPhase + 1) & 15;
        }

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
    state.extHigh = extHigh;
    state.tailClk = tailClk;
    state.tail2 = tail2;
    state.tail4 = tail4;
    state.tail8 = tail8;
    state.tail16 = tail16;
  },
};
