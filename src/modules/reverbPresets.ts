// Reverb preset table, kernel domain data (GH #83): the engine-units values
// for the 3-position Preset switch. The preset never reaches the engine by
// name — it travels as a plain positions param (0/1/2), and the kernel
// (reverb.ts) derives the HIDDEN Dattorro-style tank parameters from that
// integer via its own module-local tables. Import direction is one-way (this
// file → registry → reverb.ts), which is why the hidden tables live in the
// kernel file.
//
// Expanding a preset selection into a host's own control values is host UI
// work, not kernel knowledge — that is why these constants are exported
// through the public entry point rather than kept private: a host consumes
// them, the engine only ever sees the position index.

export const REVERB_SLUG = "reverb";
export const REVERB_PRESET_CONTROL = "Preset";

/** Switch position order — must match the registry ParamSpec `positions`. */
export const REVERB_PRESET_POSITIONS = ["Room", "Hall", "Plate"] as const;

/**
 * Visible control values per preset, in ENGINE UNITS, keyed by control
 * NAME. Index = switch position (0 Room, 1 Hall, 2 Plate). The Room column is
 * also the registry default for each control, so an untouched reverb IS the
 * Room preset (asserted in reverbPresets.test.ts).
 *
 * Values come from the khoin/DattorroReverbNode demo's own preset rows (the
 * reference sound; see the reverb.ts header for provenance): Room = "small
 * non-empty room", Hall = "big empty church", Plate = the processor defaults.
 * PreDelay/Decay/Damp map 1:1 onto the upstream preDelay/decay/damping
 * columns. Size is our extension (upstream has no size) — every preset sits
 * at 1, where the tank is length-identical to upstream. Mix folds upstream's
 * wet/dry pair into one knob, so its per-preset values are ours.
 */
export const REVERB_PRESET_VISIBLE: ReadonlyArray<Readonly<Record<string, number>>> = [
  { PreDelay: 0.032, Size: 1, Decay: 0.32, Damp: 0.64, Mix: 0.25 }, // Room
  { PreDelay: 0, Size: 1, Decay: 0.83, Damp: 0.6, Mix: 0.35 }, // Hall
  { PreDelay: 0, Size: 1, Decay: 0.5, Damp: 0.005, Mix: 0.4 }, // Plate
];
