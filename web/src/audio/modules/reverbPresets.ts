// Reverb preset expansion, UI side (GH #83): maps the 3-position Preset
// switch to the batch of VISIBLE control values PatchEditor commits when the
// switch changes. The preset never reaches the engine by name — it travels as
// a plain positions param (0/1/2), and the kernel (reverb.ts) derives the
// HIDDEN Dattorro-style tank parameters from that integer via its own
// module-local tables. Import direction is one-way (this file → registry →
// reverb.ts), which is why the hidden tables live in the kernel file.
//
// Because expansion happens here, a saved patch stores ordinary per-control
// values and the hidden parameters are never persisted — exactly as the issue
// requires. Values are initial musical guesses ("exact values can be tuned
// later" — GH #83).

import type { Module } from "../../lib/api";
import { engineValueToNormalized } from "../engine/params";
import { registry } from "./registry";

export const REVERB_SLUG = "reverb";
export const REVERB_PRESET_CONTROL = "Preset";

/** Switch position order — must match the seed `positions` and the registry ParamSpec. */
export const REVERB_PRESET_POSITIONS = ["Room", "Hall", "Plate"] as const;

/**
 * Visible control values per preset, in ENGINE UNITS, keyed by seed control
 * NAME. Index = switch position (0 Room, 1 Hall, 2 Plate). The Room column is
 * also the registry default for each control, so an untouched reverb IS the
 * Room preset (asserted in reverbPresets.test.ts).
 */
export const REVERB_PRESET_VISIBLE: ReadonlyArray<Readonly<Record<string, number>>> = [
  { PreDelay: 0.015, Size: 0.35, Decay: 0.35, Damp: 0.45, Mix: 0.25 }, // Room
  { PreDelay: 0.06, Size: 0.75, Decay: 0.78, Damp: 0.35, Mix: 0.35 }, // Hall
  { PreDelay: 0.025, Size: 0.6, Decay: 0.65, Damp: 0.2, Mix: 0.4 }, // Plate
];

/**
 * UI-side preset expansion. Returns the full batch of control commits —
 * the Preset switch itself plus every visible knob at the preset's value,
 * normalized to the stored 0..1 form via the registry ParamSpec curves — or
 * null when this commit is not a reverb Preset change (caller falls back to
 * the ordinary single-control commit).
 */
export function reverbPresetCommitEntries(
  module: Module,
  controlId: string,
  value: number | boolean | undefined,
): Array<[controlId: string, value: number]> | null {
  if (module.slug !== REVERB_SLUG || typeof value !== "number") return null;
  const control = module.controls.find((c) => c.id === controlId);
  if (control?.name !== REVERB_PRESET_CONTROL) return null;

  const specs = registry.get(REVERB_SLUG)?.params;
  if (!specs) return null;
  const preset = Math.min(
    REVERB_PRESET_POSITIONS.length - 1,
    Math.max(0, Math.round(value)),
  );

  const entries: Array<[string, number]> = [[controlId, preset]];
  for (const [name, engineValue] of Object.entries(REVERB_PRESET_VISIBLE[preset])) {
    const target = module.controls.find((c) => c.name === name);
    const spec = specs[name];
    if (!target || !spec) continue; // seed/registry drift is caught by registry.test.ts
    entries.push([target.id, engineValueToNormalized(spec, engineValue)]);
  }
  return entries;
}
