// Bundled example patches, plain JSON in the package's generic `Patch`
// schema (patchatlas-audio's engine/patch.ts) -- so this file doubles as
// schema documentation for anyone reading the playground source. Every
// param value is already in ENGINE units, not the 0..1 normalized form
// PatchAtlas stores; see docs/signals.md in the package for the convention.
//
// "krell" is adapted from web/src/patches/seed/krellPatch.ts (a PatchDraftDoc,
// PatchAtlas's own storage shape) -- its normalized control values were
// converted to engine units once, offline, via the package's own
// normalizedToEngineValue(spec, normalized) against the real registry specs,
// then hand-verified with compilePatch() (loaded: true, zero diagnostics)
// before being pasted in below as plain numbers.

import type { Patch } from "patchatlas-audio";

export interface Preset {
  id: string;
  title: string;
  description: string;
  patch: Patch;
}

const krell: Patch = {
  modules: [
    { id: "noise", type: "noise-source" },
    { id: "sh-a", type: "sample-and-hold" },
    { id: "sh-b", type: "sample-and-hold", params: { Slew: 0.68 } },
    { id: "fg-b", type: "function-generator", params: { Rise: 2.5118864315095797, Fall: 4.365158322401661, Cycle: 1 } },
    { id: "lpg", type: "low-pass-gate", params: { Mode: 1 } },
    { id: "verb", type: "reverb", params: { Preset: 2, PreDelay: 0.1, Size: 1, Decay: 0.68, Damp: 0.21, Mix: 0.4 } },
    { id: "fg-a", type: "function-generator", params: { Rise: 10, Fall: 5.248074602497728, Cycle: 1 } },
    { id: "att", type: "attenuverter", params: { "Att 1": 0.3, "Att 2": 0.68 } },
    { id: "osc-a", type: "oscillator", params: { "FM Amt": 0.32 } },
    { id: "out", type: "audio-output", params: { Level: 0.32 } },
    { id: "osc-b", type: "oscillator", params: { Tune: -0.92 } },
  ],
  connections: [
    { from: ["noise", "Pink"], to: ["sh-a", "In"] },
    { from: ["noise", "White"], to: ["sh-b", "In"] },
    { from: ["fg-b", "EOC"], to: ["sh-b", "Trig"] },
    { from: ["fg-b", "EOR"], to: ["sh-a", "Trig"] },
    { from: ["sh-b", "S&H"], to: ["att", "In 1"] },
    { from: ["sh-a", "S&H"], to: ["att", "In 2"] },
    { from: ["sh-b", "S&H"], to: ["fg-a", "Both CV"] },
    { from: ["fg-a", "Out"], to: ["fg-b", "Both CV"] },
    { from: ["fg-b", "Out"], to: ["lpg", "CV"] },
    { from: ["osc-a", "Saw"], to: ["lpg", "In"] },
    { from: ["lpg", "Out"], to: ["verb", "In L"] },
    { from: ["verb", "Out L"], to: ["out", "L In"] },
    { from: ["verb", "Out R"], to: ["out", "R In"] },
    { from: ["att", "Out 1"], to: ["osc-a", "1V/Oct"] },
    { from: ["att", "Out 2"], to: ["osc-b", "1V/Oct"] },
    { from: ["osc-b", "Sine"], to: ["osc-a", "FM"] },
  ],
};

const subtractive: Patch = {
  modules: [
    { id: "osc", type: "oscillator" },
    { id: "lfo", type: "lfo", params: { Rate: 0.15 } },
    { id: "filt", type: "filter", params: { Cutoff: 1200, Res: 0.3, "CV Amt": 0.6 } },
    { id: "out", type: "audio-output" },
  ],
  connections: [
    { from: ["osc", "Saw"], to: ["filt", "In"] },
    { from: ["lfo", "Sine"], to: ["filt", "Cut CV"] },
    { from: ["filt", "LP"], to: ["out", "L In"] },
    { from: ["filt", "LP"], to: ["out", "R In"] },
  ],
};

const fm: Patch = {
  modules: [
    { id: "mod", type: "oscillator", params: { Tune: 1 } },
    { id: "car", type: "oscillator", params: { "FM Amt": 0.5 } },
    { id: "out", type: "audio-output" },
  ],
  connections: [
    { from: ["mod", "Sine"], to: ["car", "FM"] },
    { from: ["car", "Sine"], to: ["out", "L In"] },
    { from: ["car", "Sine"], to: ["out", "R In"] },
  ],
};

// One node's output patched back into its own input -- the smallest possible
// demonstration of the engine's one-block feedback model (docs/architecture.md):
// the FM input reads the Sine output one render block (128 samples) late.
const feedback: Patch = {
  modules: [
    { id: "osc", type: "oscillator", params: { "FM Amt": 0.6 } },
    { id: "out", type: "audio-output", params: { Level: 0.5 } },
  ],
  connections: [
    { from: ["osc", "Sine"], to: ["osc", "FM"] },
    { from: ["osc", "Sine"], to: ["out", "L In"] },
    { from: ["osc", "Sine"], to: ["out", "R In"] },
  ],
};

export const PRESETS: Preset[] = [
  {
    id: "krell",
    title: "Krell",
    description: "Classic generative random-voltage patch: a cycling function generator opens a low pass gate and clocks two sample & holds for fresh random pitches each cycle, through a plate reverb.",
    patch: krell,
  },
  {
    id: "subtractive",
    title: "Basic subtractive",
    description: "Sawtooth oscillator through a resonant lowpass filter, cutoff swept by a slow LFO.",
    patch: subtractive,
  },
  {
    id: "fm",
    title: "FM pair",
    description: "One oscillator's sine output frequency-modulates a second oscillator one octave below, a minimal two-operator FM patch.",
    patch: fm,
  },
  {
    id: "feedback",
    title: "Feedback cycle",
    description: "An oscillator's own output patched back into its FM input -- a one-block-delayed self-modulation loop, demonstrating the engine's feedback model.",
    patch: feedback,
  },
];
