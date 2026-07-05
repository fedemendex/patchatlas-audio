// The closed, code-owned DSP registry: seeded slug → kernel binding.
// Keys are slugs from seed/generic_modules.json; jack and param names are seed NAMES
// (stable across databases), never DB ids — the compiler (AP-3) resolves ids → names
// via the catalog Module objects. Integrity against the seed is enforced by
// registry.test.ts; every new kernel must pass docs/audio/kernel-checklist.md.

import type { Kernel, ParamSpec } from "../engine/kernel";
import { GATE_HIGH_V } from "../engine/units";
import { audioOutputKernel } from "./audioOutput";
import { oscillatorKernel } from "./oscillator";
import { vcaKernel } from "./vca";
import { attenuverterKernel } from "./attenuverter";
import { multKernel } from "./mult";
import { mixerKernel } from "./mixer";
import { filterKernel } from "./filter";
import { envelopeGeneratorKernel } from "./envelopeGenerator";
import { lfoKernel } from "./lfo";
import { noiseSourceKernel } from "./noiseSource";
import { sampleAndHoldKernel } from "./sampleAndHold";
import { clockKernel } from "./clock";
import { sequencerKernel } from "./sequencer";

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
      // Deferred (declared in seed, not wired — see sequencer.ts header):
      // `Dir` (direction) and `Sel` (step-select) inputs.
      inJacks: ["Clk", "Rst"],
      outJacks: ["CV", "Gate"],
      // Dir (direction) and Sel (step-select) are in the seed but not wired:
      // forward-only stepping is the AP-12 scope. Cables into them are dropped
      // by the compiler.
      preview: {
        deferredJacks: ["Dir", "Sel"],
      },
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
]);

export function isPlayable(slug: string | null): boolean {
  return slug !== null && registry.has(slug);
}
