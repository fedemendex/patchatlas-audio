// Trigger Sequencer kernel for slug "trigger-sequencer".
//
// An 8-step walking gate/trigger sequencer clocked entirely on the audio thread.
// Unlike the CV/Gate `sequencer` (one continuous pitch CV line), this module has
// no pitch output — each step gets its own physical output jack (S1..S8), so a
// single step can be routed to a different destination (e.g. 8 separate drum
// voices). `On 1..8` mute a step (still counted, no pulse) exactly like
// `sequencer`'s On buttons.
//
// Step counter: 0-based, hard-wraps modulo STEP_COUNT (8) — there is no `Len`
// control in this seed. The *effective* cycle length is instead entirely
// patch-driven: the classic modular trick of patching one of the S<n> outputs
// back into `Rst` shortens the cycle, because the resulting Rst edge (delayed
// one sample by the interpreter's feedback-edge plumbing — the same mechanism
// already used by function-generator's EOC→Trig self-cycle) forces the step
// pointer back to 0 before the counter ever reaches the later steps.
//
// EOC ("end of cycle"): fires a fixed TRIGGER_SECONDS pulse coincident with
// whichever step turns out to be the *last* one of a lap:
//   - Rst rising edge (external OR self-patched from any S<n>) fires EOC on
//     that same sample and resets the pointer to step 0 (first-edge latch
//     re-armed, exactly like `sequencer`'s Rst — reset repositions only, it
//     does not itself fire a step pulse).
//   - Otherwise, the natural hard-wrap ceiling: EOC fires the moment the
//     counter reaches step index 7 (S8), the default 8-step lap's last step,
//     so an unpatched Rst still gets a useful once-per-lap EOC.
// A step patched into Rst therefore both shortens the run AND becomes the new
// "last step" that EOC tracks — e.g. patching S5 into Rst yields a 5-step loop
// whose EOC coincides with S5, not S8.
//
// Per-step outputs (S1..S8) share the Gate-Len duration (Gate Len knob,
// exponentially CV-modulated 1 V/oct by the `CV` input — same octave-scaling
// convention as `lfo`'s Rate CV) but each has its own independent countdown,
// so overlapping pulses are possible if Gate Len exceeds the clock period —
// this mirrors independent physical output circuits on real hardware, not a
// shared/exclusive bus. `Gate` is the logical OR of the eight S<n> tails on a
// single combined jack. `Trig` is a separate, fixed-width (TRIGGER_SECONDS)
// pulse on every enabled step advance, independent of Gate Len — a clean
// re-trigger source for drum modules regardless of the Gate Len setting.
//
// Unpatched Clk never advances; unpatched Rst never resets (only the natural
// 8-step wrap drives EOC); non-finite Clk/Rst/CV samples are safe (read as
// 0 V / no modulation).
//
// Jack/param layout (registry declaration order):
//   ins[0] = Clk   ins[1] = Rst   ins[2] = CV (gate-length modulation)
//   outs[0..7] = S1..S8   outs[8] = EOC   outs[9] = Trig   outs[10] = Gate
//   params[0] = Gate Len (seconds)   params[1..8] = On 1..8

import type { Kernel } from "../engine/kernel";
import {
  GATE_HIGH_V,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
  TRIGGER_SECONDS,
} from "../engine/units";

const STEP_COUNT = 8;
const ON_BASE = 1; // params[ON_BASE + step]

// A step's On button counts as enabled at or above this threshold (0/1 values).
const ON_THRESHOLD = 0.5;

// Safe bounds for the (knob * CV-modulated) gate length, in seconds.
const MIN_GATE_SECONDS = 0.001;
const MAX_GATE_SECONDS = 10;

interface TriggerSequencerState {
  sr: number;
  pulseSamples: number; // TRIGGER_SECONDS in samples, for Trig/EOC (>= 1)
  step: number; // current step index, always in [0, STEP_COUNT)
  firstEdge: boolean; // next clock edge latches step 0 instead of advancing
  clkHigh: boolean; // Schmitt state of the Clk input
  rstHigh: boolean; // Schmitt state of the Rst input
  stepTails: Int32Array; // remaining gate-high samples, one per S<n> output
  trigTail: number; // remaining Trig-high samples
  eocTail: number; // remaining EOC-high samples
}

export const triggerSequencerKernel: Kernel<TriggerSequencerState> = {
  init(sr): TriggerSequencerState {
    return {
      sr,
      pulseSamples: Math.max(1, Math.round(TRIGGER_SECONDS * sr)),
      step: 0,
      firstEdge: true,
      clkHigh: false,
      rstHigh: false,
      stepTails: new Int32Array(STEP_COUNT),
      trigTail: 0,
      eocTail: 0,
    };
  },

  process(state, ins, outs, params, n) {
    const inClk = ins[0];
    const inRst = ins[1];
    const inCV = ins[2];
    const outEOC = outs[STEP_COUNT];
    const outTrig = outs[STEP_COUNT + 1];
    const outGate = outs[STEP_COUNT + 2];

    let gateLenBase = params[0];
    if (!Number.isFinite(gateLenBase) || gateLenBase <= 0) gateLenBase = MIN_GATE_SECONDS;

    const sr = state.sr;
    const pulseSamples = state.pulseSamples;
    const stepTails = state.stepTails;
    let step = state.step;
    let firstEdge = state.firstEdge;
    let clkHigh = state.clkHigh;
    let rstHigh = state.rstHigh;
    let trigTail = state.trigTail;
    let eocTail = state.eocTail;

    for (let i = 0; i < n; i++) {
      // Reset first: Schmitt rising edge -> step 0, re-arm first-edge latch,
      // fire EOC coincident with the reset. Non-finite reads as 0 V (low).
      let rstV = 0;
      if (inRst !== null) {
        const v = inRst[i];
        if (Number.isFinite(v)) rstV = v;
      }
      if (!rstHigh && rstV >= GATE_FIRE_THRESHOLD_V) {
        rstHigh = true;
        step = 0;
        firstEdge = true;
        eocTail = pulseSamples;
      } else if (rstHigh && rstV < GATE_REARM_THRESHOLD_V) {
        rstHigh = false;
      }

      // Clock: Schmitt rising edge advances the step (or latches step 0 on
      // the first edge). Non-finite reads as low.
      let clkV = 0;
      if (inClk !== null) {
        const v = inClk[i];
        if (Number.isFinite(v)) clkV = v;
      }
      if (!clkHigh && clkV >= GATE_FIRE_THRESHOLD_V) {
        clkHigh = true;
        if (firstEdge) {
          firstEdge = false; // latch step 0 (no advance, not a cycle boundary)
        } else {
          step = step + 1;
          if (step >= STEP_COUNT) step = 0;
        }
        // Natural end-of-lap: the counter has reached the last step (S8).
        if (step === STEP_COUNT - 1) eocTail = pulseSamples;

        // CV -> gate length: 1 V/oct around the Gate Len knob (same octave-
        // scaling convention as lfo.ts's Rate CV), sampled once on this edge.
        let cvV = 0;
        if (inCV !== null) {
          const v = inCV[i];
          if (Number.isFinite(v)) cvV = v;
        }
        // Math.pow(2, cvV) is always positive for finite cvV — it can only go
        // non-finite by overflowing to +Infinity (never NaN/-Infinity), so an
        // overflow means "very long", not "very short": clamp to the max.
        let gateLenSeconds = gateLenBase * Math.pow(2, cvV);
        if (!Number.isFinite(gateLenSeconds) || gateLenSeconds > MAX_GATE_SECONDS) {
          gateLenSeconds = MAX_GATE_SECONDS;
        } else if (gateLenSeconds < MIN_GATE_SECONDS) {
          gateLenSeconds = MIN_GATE_SECONDS;
        }
        const gateSamples = Math.max(1, Math.round(gateLenSeconds * sr));

        // A disabled (rest) step suppresses S<n>/Trig; NaN On also reads as
        // off. The pointer still advanced and EOC (handled above) is unaffected.
        const onVal = params[ON_BASE + step];
        if (onVal >= ON_THRESHOLD) {
          stepTails[step] = gateSamples;
          trigTail = pulseSamples;
        }
      } else if (clkHigh && clkV < GATE_REARM_THRESHOLD_V) {
        clkHigh = false;
      }

      // Per-step outputs + combined Gate (logical OR of all step tails).
      let anyHigh = false;
      for (let s = 0; s < STEP_COUNT; s++) {
        let tail = stepTails[s];
        if (tail > 0) {
          outs[s][i] = GATE_HIGH_V;
          anyHigh = true;
          tail--;
          stepTails[s] = tail;
        } else {
          outs[s][i] = 0;
        }
      }
      outGate[i] = anyHigh ? GATE_HIGH_V : 0;

      outTrig[i] = trigTail > 0 ? GATE_HIGH_V : 0;
      if (trigTail > 0) trigTail--;

      outEOC[i] = eocTail > 0 ? GATE_HIGH_V : 0;
      if (eocTail > 0) eocTail--;
    }

    state.step = step;
    state.firstEdge = firstEdge;
    state.clkHigh = clkHigh;
    state.rstHigh = rstHigh;
    state.trigTail = trigTail;
    state.eocTail = eocTail;
  },
};
