// The single source of truth for ParamSpec ↔ control-value mapping.
//
// Control values are stored normalized: knobs/sliders as a 0..1 position,
// switches ("positions") as the raw position index, and step buttons as the
// 0/1 the linear curve reduces to. The adapter (patchAdapter.ts) turns those
// into engine units; the ModulePanel UI turns a ParamSpec.default into the
// knob's rest position so an untouched control is DRAWN where the engine
// actually RUNS it. Both sides go through here so the curve math is never
// duplicated (or allowed to drift).

import type { ParamSpec } from "./kernel";

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// Shared [spec.min, spec.max] range clamp. Used by the "positions" curve case
// below and by diagnostics.ts's hand-authored-Patch param clamp, so a future
// change to clamping semantics can't drift between the UI-authored and
// hand-authored Patch pipelines.
export function clampToSpecRange(spec: ParamSpec, value: number): number {
  return Math.min(spec.max, Math.max(spec.min, value));
}

// Normalized (stored) value → engine units. For linear/exponential the input
// is a 0..1 knob position (clamped); for "positions" it is the switch index,
// which already equals the engine value (rounded, clamped to [min, max]) — this
// mirrors the mapping the adapter has always applied. A non-finite input falls
// back to the spec default.
export function normalizedToEngineValue(spec: ParamSpec, normalized: number): number {
  if (!Number.isFinite(normalized)) return spec.default;
  switch (spec.curve) {
    case "linear":
      return spec.min + clamp01(normalized) * (spec.max - spec.min);
    case "exponential":
      return spec.min * Math.pow(spec.max / spec.min, clamp01(normalized));
    case "positions":
      return clampToSpecRange(spec, Math.round(normalized));
  }
}

// Engine units → normalized (stored) value: the inverse of the above, clamped
// to the control's representable range. For "positions" it returns the clamped
// index (the stored form for a switch). A non-finite input, or a degenerate
// range that would divide by zero, falls back to the default's normalized
// position.
export function engineValueToNormalized(spec: ParamSpec, value: number): number {
  if (!Number.isFinite(value)) return defaultNormalizedValue(spec);
  switch (spec.curve) {
    case "linear":
      if (spec.max === spec.min) return 0;
      return clamp01((value - spec.min) / (spec.max - spec.min));
    case "exponential":
      // Exponential specs are required to have min > 0 && max > 0 (audited in
      // params.test.ts); guard anyway so a bad spec can't produce NaN.
      if (spec.min <= 0 || spec.max <= 0 || spec.max === spec.min) return 0;
      return clamp01(Math.log(value / spec.min) / Math.log(spec.max / spec.min));
    case "positions":
      return clampToSpecRange(spec, Math.round(value));
  }
}

// The normalized rest position for an untouched control — where the knob is
// drawn when no value is stored, so its picture matches the ParamSpec.default
// the adapter uses. Bipolar knobs (default 0) land at 0.5 (centre) naturally.
export function defaultNormalizedValue(spec: ParamSpec): number {
  return engineValueToNormalized(spec, spec.default);
}

// A bipolar knob straddles zero with a centred default, so the UI draws a
// 12-o'clock detent mark. Switches ("positions") are never treated as bipolar.
export function isBipolarParam(spec: ParamSpec): boolean {
  return (
    spec.curve !== "positions" &&
    spec.min < 0 &&
    spec.max > 0 &&
    Math.abs(spec.default) < 1e-9
  );
}
