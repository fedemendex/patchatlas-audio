// The closed, code-owned DSP registry: seeded slug → kernel binding.
// Keys are slugs from seed/generic_modules.json; jack and param names are seed NAMES
// (stable across databases), never DB ids — the compiler (AP-3) resolves ids → names
// via the catalog Module objects. Integrity against the seed is enforced by
// registry.test.ts; every new kernel must pass docs/audio/kernel-checklist.md.

import type { Kernel, ParamSpec } from "../engine/kernel";
import { GATE_HIGH_V, CV_BIPOLAR_MAX, CV_UNIPOLAR_MAX } from "../engine/units";
import { audioOutputKernel } from "./audioOutput";
import { oscillatorKernel } from "./oscillator";
import { vcaKernel } from "./vca";
import { attenuverterKernel } from "./attenuverter";
import { multKernel } from "./mult";
import { mixerKernel } from "./mixer";
import { crossfaderKernel } from "./crossfader";
import { filterKernel } from "./filter";
import { envelopeGeneratorKernel } from "./envelopeGenerator";
import { functionGeneratorKernel } from "./functionGenerator";
import { lfoKernel } from "./lfo";
import { noiseSourceKernel } from "./noiseSource";
import { sampleAndHoldKernel } from "./sampleAndHold";
import { clockKernel } from "./clock";
import { sequencerKernel } from "./sequencer";
import { triggerSequencerKernel } from "./triggerSequencer";
import { ringModKernel } from "./ringMod";
import { lowPassGateKernel } from "./lowPassGate";
import { reverbKernel } from "./reverb";
import { wavefolderKernel } from "./wavefolder";
import { sequentialSwitch1ToNKernel } from "./sequentialSwitch1ToN";
import { sequentialSwitchNTo1Kernel } from "./sequentialSwitchNTo1";
import { quantizerKernel } from "./quantizer";
import { logicKernel } from "./logic";
import { slewLimiterKernel } from "./slewLimiter";
import { comparatorKernel } from "./comparator";

export interface ModuleDSP {
  slug: string; // must exist in seed/generic_modules.json
  kernel: Kernel<unknown>;
  inJacks: string[]; // seed jack NAMES, order = ins[] slots
  outJacks: string[]; // seed jack NAMES, order = outs[] slots
  params: Record<string, ParamSpec>; // seed control NAME → spec; order defines params[] slots

  // For modules that terminate the graph into DAC-domain output.
  // audio-output has no patchable output jacks, but it produces L/R buffers
  // for Interpreter.readOutput().
  audioOutput?: {
    channels: 1 | 2;
  };

  // When true, the kernel's state carries a numeric `step` field that the
  // Interpreter reports to the UI (sequencer current-step indicator). The
  // worklet forwards it on a throttled channel; it never affects DSP.
  reportsStep?: boolean;

  // Preview capability metadata (AP-13). Seed NAMES of jacks/controls that are
  // visible in the UI but produce no audible effect in the preview engine, so
  // the UI can badge them and docs/audio/preview-coverage.md can enumerate them.
  // A module with none of these fields is fully previewed. All names are
  // validated against the seed in registry.test.ts. See preview-coverage.md for
  // the taxonomy; the two mechanisms are:
  //   - declared-but-unread: the jack/control IS in inJacks/outJacks/params
  //     (silentOutputs / ignoredInputs / ignoredControls) — a cable/knob resolves
  //     to a real slot the kernel never reads.
  //   - deferred (seed-only): the jack/control is in the seed but absent from
  //     inJacks/outJacks/params (deferredJacks / deferredControls) — the compiler
  //     drops the connection and the control value is never passed.
  preview?: {
    silentOutputs?: string[]; // in outJacks; kernel writes silence every block
    ignoredInputs?: string[]; // in inJacks; kernel never reads the slot
    ignoredControls?: string[]; // in params; kernel never reads the slot
    deferredJacks?: string[]; // seeded jack absent from inJacks/outJacks (dropped)
    deferredControls?: string[]; // seeded control absent from params (never passed)
  };
}

export const registry: Map<string, ModuleDSP> = new Map<string, ModuleDSP>([
  [
    "audio-output",
    {
      slug: "audio-output",
      kernel: audioOutputKernel,
      inJacks: ["L In", "R In"],
      outJacks: [],
      params: {
        Level: { min: 0, max: 1, default: 0.8, curve: "linear" },
      },
      audioOutput: { channels: 2 },
    },
  ],
  [
    "oscillator",
    {
      slug: "oscillator",
      kernel: oscillatorKernel,
      inJacks: ["1V/Oct", "FM", "EFM", "Sync", "PWM"],
      outJacks: ["Saw", "Pulse", "Tri", "Sine", "Sub"],
      params: {
        Tune: { min: -2, max: 2, default: 0, curve: "linear" },
        Fine: { min: -1 / 12, max: 1 / 12, default: 0, curve: "linear" },
        "FM Amt": { min: -1, max: 1, default: 0, curve: "linear" },
        "EFM Amt": { min: -1, max: 1, default: 0, curve: "linear" },
        PW: { min: 0.05, max: 0.95, default: 0.5, curve: "linear" },
      },
      // Fully previewed: Sine, plus PolyBLEP Saw/Pulse/Sub, naive Tri, PWM/PW
      // duty control, and hard-sync on the Sync input (see oscillator.ts).
    },
  ],
  [
    "vca",
    {
      slug: "vca",
      kernel: vcaKernel,
      inJacks: ["In", "CV"],
      outJacks: ["Out"],
      params: {
        Gain: { min: 0, max: 1, default: 1, curve: "linear" },
        "CV Amt": { min: 0, max: 1, default: 1, curve: "linear" },
        Response: { min: 0, max: 1, default: 1, curve: "positions", positions: ["Exp", "Lin"] },
      },
    },
  ],
  [
    "attenuverter",
    {
      slug: "attenuverter",
      kernel: attenuverterKernel,
      inJacks: ["In 1", "In 2"],
      outJacks: ["Out 1", "Out 2"],
      params: {
        "Att 1": { min: -1, max: 1, default: 0, curve: "linear" },
        "Att 2": { min: -1, max: 1, default: 0, curve: "linear" },
      },
    },
  ],
  [
    "mult",
    {
      slug: "mult",
      kernel: multKernel,
      inJacks: ["In"],
      outJacks: ["Out 1", "Out 2", "Out 3"],
      params: {},
    },
  ],
  [
    "mixer",
    {
      slug: "mixer",
      kernel: mixerKernel,
      inJacks: ["In 1", "In 2", "In 3", "In 4"],
      outJacks: ["Mix", "Inv"],
      params: {
        "Level 1": { min: 0, max: 1, default: 1, curve: "linear" },
        "Level 2": { min: 0, max: 1, default: 1, curve: "linear" },
        "Level 3": { min: 0, max: 1, default: 1, curve: "linear" },
        "Level 4": { min: 0, max: 1, default: 1, curve: "linear" },
      },
    },
  ],
  [
    "crossfader",
    {
      slug: "crossfader",
      kernel: crossfaderKernel,
      inJacks: ["A", "B", "CV"],
      outJacks: ["Out"],
      params: {
        Fade: { min: -1, max: 1, default: 0, curve: "linear" },
      },
    },
  ],
  [
    "filter",
    {
      slug: "filter",
      kernel: filterKernel,
      inJacks: ["In", "1V/Oct", "Cut CV", "FM", "Res CV"],
      outJacks: ["LP", "BP", "HP"],
      params: {
        // Default at the minimum so an untouched Cutoff knob — drawn fully
        // counter-clockwise (the UI's unipolar rest position) — actually sounds
        // closed: LP silent, BP passing lows, HP fully open. Anything above min
        // would leave the audible cutoff out of sync with the knob until moved.
        Cutoff: { min: 20, max: 16000, default: 20, curve: "exponential" },
        Res: { min: 0, max: 1, default: 0, curve: "linear" },
        "CV Amt": { min: -1, max: 1, default: 0, curve: "linear" },
        "Track Amt": { min: -1, max: 1, default: 0, curve: "linear" },
      },
    },
  ],
  [
    "envelope-generator",
    {
      slug: "envelope-generator",
      kernel: envelopeGeneratorKernel,
      inJacks: ["Gate", "Retrigger"],
      outJacks: ["Env", "Inv", "EOC"],
      params: {
        A: { min: 0.001, max: 10, default: 0.01, curve: "exponential" },
        D: { min: 0.001, max: 10, default: 0.2, curve: "exponential" },
        S: { min: 0, max: GATE_HIGH_V, default: GATE_HIGH_V * 0.7, curve: "linear" },
        R: { min: 0.001, max: 10, default: 0.3, curve: "exponential" },
      },
    },
  ],
  [
    "function-generator",
    {
      slug: "function-generator",
      kernel: functionGeneratorKernel,
      // Maths/DUSG-style slope generator (see functionGenerator.ts header):
      // Trig fires a rise→fall transient to CV_UNIPOLAR_MAX, In is the slew/
      // follower input and transient floor, Rise CV/Fall CV/Both CV scale the
      // knob times at 1 oct/V (positive = slower). EOR/EOC are movement-derived
      // gates (low while rising / falling), so EOC → Trig self-patches into a
      // cycle. Cycle (button, default off) self-cycles without a patch.
      inJacks: ["Trig", "In", "Rise CV", "Fall CV", "Both CV"],
      outJacks: ["Out", "EOR", "EOC", "Inv"],
      params: {
        Rise: { min: 0.001, max: 10, default: 0.01, curve: "exponential" },
        Fall: { min: 0.001, max: 10, default: 0.3, curve: "exponential" },
        // Bipolar (seed `bipolar: true`): −1 log, 0 linear, +1 expo transient
        // shaping (g = 4^curve in the kernel).
        Curve: { min: -1, max: 1, default: 0, curve: "linear" },
        Cycle: { min: 0, max: 1, default: 0, curve: "linear" },
      },
    },
  ],
  [
    "lfo",
    {
      slug: "lfo",
      kernel: lfoKernel,
      inJacks: ["Rate CV", "Rst"],
      outJacks: ["Sine", "Tri", "Sq", "Saw", "Sub"],
      params: {
        Rate: { min: 0.01, max: 30, default: 2, curve: "exponential" },
      },
    },
  ],
  [
    "noise-source",
    {
      slug: "noise-source",
      kernel: noiseSourceKernel,
      inJacks: [],
      outJacks: ["White", "Pink", "Red", "Blue"],
      params: {},
      // Fully previewed: White, Pink, Red (leaky-integrator) and Blue
      // (first-difference) coloring are all implemented — see noiseSource.ts.
    },
  ],
  [
    "sample-and-hold",
    {
      slug: "sample-and-hold",
      kernel: sampleAndHoldKernel,
      inJacks: ["In", "Trig"],
      outJacks: ["S&H", "T&H"],
      params: {
        // Slew is read by the kernel, which maps this raw 0..1 knob value
        // exponentially onto a time constant in-kernel (see sampleAndHold.ts
        // header); default 0 matches the original instantaneous behavior.
        Slew: { min: 0, max: 1, default: 0, curve: "linear" },
      },
    },
  ],
  [
    "clock",
    {
      slug: "clock",
      kernel: clockKernel,
      // Fully previewed. Ext Clk slaves the divider to an external clock; when
      // unpatched the internal BPM generator runs (see clock.ts header). Swing is
      // the bipolar offbeat delay on the internal clock.
      // Slot order matches the seed: Ext Clk, Run, Rst.
      inJacks: ["Ext Clk", "Run", "Rst"],
      outJacks: ["Clk", "/2", "/4", "/8", "/16"],
      params: {
        Tempo: { min: 30, max: 300, default: 120, curve: "exponential" },
        // Bipolar (seed `bipolar: true`): 0 = straight, + delays the offbeat
        // (standard shuffle), − pushes it early. Applies to the internal clock;
        // external clock is passed through unswung.
        Swing: { min: -1, max: 1, default: 0, curve: "linear" },
      },
    },
  ],
  [
    "sequencer",
    {
      slug: "sequencer",
      kernel: sequencerKernel,
      reportsStep: true, // current step surfaced to the editor's step buttons
      // Fully previewed: Dir (direction, sampled on the clock edge) and Sel
      // (step-select address CV, sampled on the clock edge) are both wired —
      // see sequencer.ts header for semantics and priority (Sel overrides
      // Dir/first-edge whenever patched).
      inJacks: ["Clk", "Rst", "Dir", "Sel"],
      outJacks: ["CV", "Gate"],
      // Slot order MUST stay Len, CV 1..8, On 1..8 — the kernel indexes params
      // positionally (LEN_IDX / CV_BASE / ON_BASE in sequencer.ts).
      params: {
        Len: { min: 1, max: 8, default: 8, curve: "linear" },
        "CV 1": { min: 0, max: 2, default: 0, curve: "linear" },
        "CV 2": { min: 0, max: 2, default: 0, curve: "linear" },
        "CV 3": { min: 0, max: 2, default: 0, curve: "linear" },
        "CV 4": { min: 0, max: 2, default: 0, curve: "linear" },
        "CV 5": { min: 0, max: 2, default: 0, curve: "linear" },
        "CV 6": { min: 0, max: 2, default: 0, curve: "linear" },
        "CV 7": { min: 0, max: 2, default: 0, curve: "linear" },
        "CV 8": { min: 0, max: 2, default: 0, curve: "linear" },
        "On 1": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 2": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 3": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 4": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 5": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 6": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 7": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 8": { min: 0, max: 1, default: 1, curve: "linear" },
      },
    },
  ],
  [
    "trigger-sequencer",
    {
      slug: "trigger-sequencer",
      kernel: triggerSequencerKernel,
      reportsStep: true, // current step surfaced to the editor's step buttons
      // Fully previewed. No Len control in this seed — the cycle hard-wraps at
      // 8 steps unless shortened by patching an S<n> output back into Rst (see
      // triggerSequencer.ts header). CV modulates Gate Len 1 V/oct.
      inJacks: ["Clk", "Rst", "CV"],
      outJacks: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "EOC", "Trig", "Gate"],
      params: {
        "Gate Len": { min: 0.001, max: 2, default: 0.05, curve: "exponential" },
        "On 1": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 2": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 3": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 4": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 5": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 6": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 7": { min: 0, max: 1, default: 1, curve: "linear" },
        "On 8": { min: 0, max: 1, default: 1, curve: "linear" },
      },
    },
  ],
  [
    "ring-modulator",
    {
      slug: "ring-modulator",
      kernel: ringModKernel,
      // DC-coupled bipolar multiplier: Out = X * Y / CV_BIPOLAR_MAX (see ringMod.ts).
      // No controls in the seed; unpatched X or Y reads as 0 V (no internal carrier).
      inJacks: ["X", "Y"],
      outJacks: ["Out"],
      params: {},
    },
  ],
  [
    "low-pass-gate",
    {
      slug: "low-pass-gate",
      kernel: lowPassGateKernel,
      // Vactrol-driven coupled VCA + 2-pole lowpass (see lowPassGate.ts). Mode
      // selects VCA-only (amp only) / LPG (filtered * amp, the actual gate
      // response) / Both (50/50 parallel blend of the VCA and LPG paths).
      // Generic educational preview model, not a specific hardware clone;
      // default is Both.
      inJacks: ["In", "CV", "Strike"],
      outJacks: ["Out"],
      params: {
        Mode: { min: 0, max: 2, default: 2, curve: "positions", positions: ["VCA", "LPG", "Both"] },
      },
    },
  ],
  [
    "wavefolder",
    {
      slug: "wavefolder",
      kernel: wavefolderKernel,
      // Clean digital triangle/reflection folder (see wavefolder.ts header) —
      // an educational preview model, not a specific circuit emulation. Fold
      // defaults to its minimum (1x, unity gain into the folder) so an
      // untouched knob passes audio through unfolded, matching the Cutoff
      // default-at-min convention used by "filter" for the same reason.
      inJacks: ["In", "Fold CV", "Sym CV"],
      outJacks: ["Out"],
      params: {
        Fold: { min: 1, max: 8, default: 1, curve: "exponential" },
        Sym: { min: -1, max: 1, default: 0, curve: "linear" },
        Bias: { min: -1, max: 1, default: 0, curve: "linear" },
      },
    },
  ],
  [
    "reverb",
    {
      slug: "reverb",
      kernel: reverbKernel,
      // Dattorro tank adapted from khoin/DattorroReverbNode (public domain;
      // see reverb.ts header). Preset (Room/Hall/Plate) travels as a numeric
      // switch index; the kernel derives the hidden diffusion/bandwidth/
      // modulation values from it, and the UI batch-sets the five visible
      // knobs on a preset change (reverbPresets.ts / GH #83). "Decay CV"
      // (renamed from "Time CV" in migration 0017) adds to the Decay knob.
      // Defaults below ARE the Room preset (asserted in reverbPresets.test.ts).
      inJacks: ["In L", "In R", "Decay CV"],
      outJacks: ["Out L", "Out R"],
      params: {
        Preset: { min: 0, max: 2, default: 0, curve: "positions", positions: ["Room", "Hall", "Plate"] },
        PreDelay: { min: 0, max: 0.25, default: 0.032, curve: "linear" },
        Size: { min: 0, max: 1, default: 1, curve: "linear" },
        Decay: { min: 0, max: 1, default: 0.32, curve: "linear" },
        Damp: { min: 0, max: 1, default: 0.64, curve: "linear" },
        Mix: { min: 0, max: 1, default: 0.25, curve: "linear" },
      },
    },
  ],
  [
    "sequential-switch-1-to-n",
    {
      slug: "sequential-switch-1-to-n",
      kernel: sequentialSwitch1ToNKernel,
      // Fully previewed. Steps (1..4, default 4 = full rotation) picks how many
      // of the 4 outputs are in the active pool, starting from Out 1; Clk
      // rotates through the pool, Rst returns to Out 1, and Sel (when patched)
      // addresses the active output directly — see sequentialSwitch1ToN.ts header.
      inJacks: ["In", "Clk", "Rst", "Sel"],
      outJacks: ["Out 1", "Out 2", "Out 3", "Out 4"],
      params: {
        Steps: { min: 1, max: 4, default: 4, curve: "linear" },
      },
    },
  ],
  [
    "sequential-switch-n-to-1",
    {
      slug: "sequential-switch-n-to-1",
      kernel: sequentialSwitchNTo1Kernel,
      // Fully previewed. Steps (1..4, default 4 = full rotation) picks how many
      // of the 4 inputs are in the active pool, starting from In 1; Clk rotates
      // through the pool, Rst returns to In 1, and Sel (when patched) addresses
      // the active input directly — see sequentialSwitchNTo1.ts header.
      inJacks: ["In 1", "In 2", "In 3", "In 4", "Clk", "Rst", "Sel"],
      outJacks: ["Out"],
      params: {
        Steps: { min: 1, max: 4, default: 4, curve: "linear" },
      },
    },
  ],
  [
    "quantizer",
    {
      slug: "quantizer",
      kernel: quantizerKernel,
      // Fully previewed. Fixed C root; Scale selects the pitch-class set
      // (Chrom/Maj/Min/Pent/Harm Min — "Harm Min" is C harmonic minor). See
      // quantizer.ts header for the nearest-note-across-octaves algorithm
      // and its halfway-tie convention (ties resolve to the higher note).
      inJacks: ["CV"],
      outJacks: ["Out"],
      params: {
        Scale: {
          min: 0,
          max: 4,
          default: 0,
          curve: "positions",
          positions: ["Chrom", "Maj", "Min", "Pent", "Harm Min"],
        },
      },
    },
  ],
  [
    "logic",
    {
      slug: "logic",
      kernel: logicKernel,
      // Fully previewed. AND/OR/XOR/NOR are combinational over In 1/In 2
      // only; Clock is dedicated to the FF output (a T flip-flop, starts low,
      // toggles once per Clock rising edge) and never participates in the
      // combinational outputs — see logic.ts header.
      inJacks: ["In 1", "In 2", "Clock"],
      outJacks: ["AND", "OR", "XOR", "NOR", "FF"],
      params: {},
    },
  ],
  [
    "slew-limiter",
    {
      slug: "slew-limiter",
      kernel: slewLimiterKernel,
      // Fully previewed. Linear, constant-rate slew (not a one-pole filter) with
      // independent Rise/Fall; each raw 0..1 knob maps in-kernel onto a
      // 0.0005..2 s/V rate, 0 = exact bypass for that direction — see
      // slewLimiter.ts header and docs/audio/signals.md.
      inJacks: ["In", "Rise CV", "Fall CV"],
      outJacks: ["Out"],
      params: {
        Rise: { min: 0, max: 1, default: 0, curve: "linear" },
        Fall: { min: 0, max: 1, default: 0, curve: "linear" },
      },
    },
  ],
  [
    "comparator",
    {
      slug: "comparator",
      kernel: comparatorKernel,
      // Fully previewed. A-167-inspired comparator/subtractor: Sum outputs
      // (+Level×+In) − (−Level×−In) + Offset + Offset CV directly (no
      // clipping/smoothing); Gate/Inv Gate compare Sum to 0 V with Gap-knob
      // symmetric hysteresis (Gap = 0 is a strict, non-hysteretic zero
      // comparison) — see comparator.ts header and docs/audio/signals.md.
      inJacks: ["+ In", "− In", "Offset CV"],
      outJacks: ["Gate", "Inv Gate", "Sum"],
      params: {
        Offset: { min: -CV_BIPOLAR_MAX, max: CV_BIPOLAR_MAX, default: 0, curve: "linear" },
        "+ Level": { min: 0, max: 1, default: 1, curve: "linear" },
        "− Level": { min: 0, max: 1, default: 1, curve: "linear" },
        Gap: { min: 0, max: CV_UNIPOLAR_MAX, default: 0, curve: "linear" },
      },
    },
  ],
]);

export function isPlayable(slug: string | null): boolean {
  return slug !== null && registry.has(slug);
}
