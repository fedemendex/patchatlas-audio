// The closed, code-owned DSP registry: seeded slug → kernel binding.
// Keys are slugs from seed/generic_modules.json; jack and param names are seed NAMES
// (stable across databases), never DB ids — the compiler (AP-3) resolves ids → names
// via the catalog Module objects. Integrity against the seed is enforced by
// registry.test.ts; every new kernel must pass docs/audio/kernel-checklist.md.

import type { Kernel, ParamSpec } from "../engine/kernel";
import { audioOutputKernel } from "./audioOutput";
import { oscillatorKernel } from "./oscillator";

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
    },
  ],
]);

export function isPlayable(slug: string | null): boolean {
  return slug !== null && registry.has(slug);
}
