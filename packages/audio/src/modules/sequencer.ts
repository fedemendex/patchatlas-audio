// Sequencer kernel for slug "sequencer".
//
// An N-step CV/gate sequencer clocked entirely on the audio thread. Step values
// are the instance's stored control values, arriving through the compiled
// `params` array (the editor's per-step CV knobs and On buttons) — the kernel
// never reads editor/React state. Because these params are static during
// playback (target === initial), the interpreter's one-pole smoother never
// moves them: step voltages are exact, not smoothed.
//
// Advancement: on each Clk rising edge (Schmitt: fire >= GATE_FIRE_THRESHOLD_V,
// re-arm below GATE_REARM_THRESHOLD_V) the step pointer moves according to
// `Sel`/`Dir` (see below) and wraps within `Len` steps. CV changes exactly on
// the edge sample and is held between edges.
//
// Step CV mapping: each `CV n` control maps (in the registry ParamSpec, linear
// 0..2, default 0) to a 0..2 V pitch range — two octaves above C4 at 1 V/oct.
// The kernel passes the already-mapped volts straight through; a non-finite
// step param falls back to 0 V.
//
// Gate output: high for SEQUENCER_GATE_DUTY (0.5) of the *measured* previous
// clock period after each advancing edge, but only when that step's `On` button
// is enabled (>= 0.5) — a disabled step is a rest (gate stays low, CV still
// updates). Before a period has been measured (the first edge after init/reset)
// the gate uses a fixed INITIAL_GATE_SECONDS fallback. The gate re-triggers on
// every new step, so a downstream envelope plucks each note.
//
// Reset (Rst, Schmitt rising edge): returns the pointer to step 0 and re-arms
// the first-edge latch, so the next clock edge re-plays step 0 (restarting the
// pattern) when `Sel` is unpatched. Reset repositions only; it does not itself
// fire a gate.
//
// `Dir` (direction, sampled on the clock edge, not continuously): unpatched Dir
// preserves the original forward-only behavior exactly (bit-for-bit). When
// patched, Dir is read on the same sample as the clock edge: low (<
// GATE_FIRE_THRESHOLD_V, including a non-finite sample) steps forward
// (`+1 mod length`); high (>= GATE_FIRE_THRESHOLD_V) steps backward
// (`-1 mod length`). Dir only affects the ordinary advancing edges — it has no
// effect on the first-edge latch, and it is ignored entirely whenever `Sel` is
// patched (see below). Dir needs no Schmitt hysteresis of its own: it is a
// single-sample read at the instant of the (already-debounced) clock edge, not
// an independently-tracked edge.
//
// `Sel` (external step-select / address CV, sampled on the clock edge): when
// patched, Sel takes priority over Dir and the first-edge latch — *every*
// clock edge, including the first after init/reset, sets the step directly
// from the address `clamp(floor(selVolts / CV_UNIPOLAR_MAX * length), 0,
// length - 1)` (0..10 V spans the currently active `Len` steps, matching the
// range Dir/forward stepping wraps within). A non-finite Sel sample reads as
// 0 V (step 0) for that edge; negative Sel clamps to step 0; Sel >= 10 V
// clamps to the final active step. Unpatched Sel preserves the original
// clocked Dir/forward-only behavior exactly.
//
// Unpatched Clk never advances; unpatched Rst never resets; non-finite Clk/Rst
// samples read as 0 V (low) and are safe.
//
// Jack/param layout (registry declaration order):
//   ins[0] = Clk   ins[1] = Rst   ins[2] = Dir   ins[3] = Sel
//   outs[0] = CV   outs[1] = Gate
//   params: [ Len, CV 1..8, On 1..8 ]  (indexed positionally — see constants)

import type { Kernel } from "../engine/kernel";
import {
  GATE_HIGH_V,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
  CV_UNIPOLAR_MAX,
} from "../engine/units";

// Param layout constants (must match the registry "sequencer" params order).
const STEP_COUNT = 8;
const LEN_IDX = 0;
const CV_BASE = 1; // params[CV_BASE + step]
const ON_BASE = CV_BASE + STEP_COUNT; // params[ON_BASE + step]

// Fraction of the measured clock period the gate stays high after each step.
const SEQUENCER_GATE_DUTY = 0.5;
// First-edge gate length (seconds) before any clock period has been measured.
const INITIAL_GATE_SECONDS = 0.05;
// A step's On button counts as enabled at or above this threshold (0/1 values).
const ON_THRESHOLD = 0.5;

interface SequencerState {
  initialGateSamples: number; // INITIAL_GATE_SECONDS in samples (>= 1)
  step: number; // current step index, always in [0, STEP_COUNT)
  firstEdge: boolean; // next clock edge latches step 0 instead of advancing
  clkHigh: boolean; // Schmitt state of the Clk input
  rstHigh: boolean; // Schmitt state of the Rst input
  gateTail: number; // remaining gate-high samples
  sinceLastEdge: number; // samples since the last clock edge (for gate duty)
  hasPeriod: boolean; // whether a clock period has been measured yet
}

export const sequencerKernel: Kernel<SequencerState> = {
  init(sr): SequencerState {
    return {
      initialGateSamples: Math.max(1, Math.round(INITIAL_GATE_SECONDS * sr)),
      step: 0,
      firstEdge: true,
      clkHigh: false,
      rstHigh: false,
      gateTail: 0,
      sinceLastEdge: 0,
      hasPeriod: false,
    };
  },

  process(state, ins, outs, params, n) {
    const inClk = ins[0];
    const inRst = ins[1];
    const inDir = ins[2];
    const inSel = ins[3];
    const outCV = outs[0];
    const outGate = outs[1];

    // Active length: rounded, clamped to [1, STEP_COUNT]; non-finite → full length.
    let length = params[LEN_IDX];
    if (!Number.isFinite(length)) length = STEP_COUNT;
    else {
      length = Math.round(length);
      if (length < 1) length = 1;
      else if (length > STEP_COUNT) length = STEP_COUNT;
    }

    const initialGateSamples = state.initialGateSamples;
    let step = state.step;
    let firstEdge = state.firstEdge;
    let clkHigh = state.clkHigh;
    let rstHigh = state.rstHigh;
    let gateTail = state.gateTail;
    let sinceLastEdge = state.sinceLastEdge;
    let hasPeriod = state.hasPeriod;

    for (let i = 0; i < n; i++) {
      // Reset first: Schmitt rising edge → back to step 0, re-arm first-edge
      // latch, drop any measured period. Non-finite reads as 0 V (low).
      let rstV = 0;
      if (inRst !== null) {
        const v = inRst[i];
        if (Number.isFinite(v)) rstV = v;
      }
      if (!rstHigh && rstV >= GATE_FIRE_THRESHOLD_V) {
        rstHigh = true;
        step = 0;
        firstEdge = true;
        hasPeriod = false;
        sinceLastEdge = 0;
      } else if (rstHigh && rstV < GATE_REARM_THRESHOLD_V) {
        rstHigh = false;
      }

      // Clock: Schmitt rising edge advances the step. Non-finite reads as low.
      let clkV = 0;
      if (inClk !== null) {
        const v = inClk[i];
        if (Number.isFinite(v)) clkV = v;
      }
      if (!clkHigh && clkV >= GATE_FIRE_THRESHOLD_V) {
        clkHigh = true;
        if (inSel !== null) {
          // Sel patched: address the active step directly, on every edge
          // (including the first) — takes priority over Dir and the
          // first-edge latch.
          let selV = inSel[i];
          if (!Number.isFinite(selV)) selV = 0;
          let idx = Math.floor((selV / CV_UNIPOLAR_MAX) * length);
          if (idx < 0) idx = 0;
          else if (idx > length - 1) idx = length - 1;
          step = idx;
          firstEdge = false;
        } else if (firstEdge) {
          firstEdge = false; // latch step 0 (no advance)
        } else {
          // Dir sampled on this edge: low (or unpatched/non-finite) steps
          // forward, high steps backward. Both wrap within `length`.
          let reverse = false;
          if (inDir !== null) {
            const dirV = inDir[i];
            reverse = Number.isFinite(dirV) && dirV >= GATE_FIRE_THRESHOLD_V;
          }
          step = reverse ? (step - 1 + length) % length : (step + 1) % length;
        }
        // Gate length: measured duty, or the fixed fallback on the first edge.
        gateTail = hasPeriod ? Math.round(SEQUENCER_GATE_DUTY * sinceLastEdge) : initialGateSamples;
        hasPeriod = true;
        sinceLastEdge = 0;
        // A disabled (rest) step suppresses the gate; NaN On also reads as off.
        const onVal = params[ON_BASE + step];
        if (!(onVal >= ON_THRESHOLD)) gateTail = 0;
      } else if (clkHigh && clkV < GATE_REARM_THRESHOLD_V) {
        clkHigh = false;
      }

      // CV = current step's stored voltage (already mapped to volts); a
      // non-finite param falls back to a safe 0 V.
      let cv = params[CV_BASE + step];
      if (!Number.isFinite(cv)) cv = 0;
      outCV[i] = cv;

      outGate[i] = gateTail > 0 ? GATE_HIGH_V : 0;
      if (gateTail > 0) gateTail--;

      sinceLastEdge++;
    }

    state.step = step;
    state.firstEdge = firstEdge;
    state.clkHigh = clkHigh;
    state.rstHigh = rstHigh;
    state.gateTail = gateTail;
    state.sinceLastEdge = sinceLastEdge;
    state.hasPeriod = hasPeriod;
  },
};
