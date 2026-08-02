// The package's public entry point (#286, docs/audio/extraction-plan.md §2,
// §7). This is the entire surface the package commits to supporting once
// extracted — everything else under engine/, modules/ and worklet/ is a
// private implementation detail, free to change without notice. Export the
// minimum PatchAtlas and the future playground need; nothing here can be
// removed cheaply once shipped (see audio.publicSurface.test.ts's snapshot).

export { createEngine } from "./engine/session";
export type { Engine, EngineOptions } from "./engine/session";
export { validate } from "./engine/diagnostics";
export { compilePatch } from "./engine/compile";
export type { Patch, PatchModule, PatchConnection } from "./engine/patch";
export type { EngineGraph } from "./engine/graph";
export type { Diagnostic } from "./engine/diagnostics";
export type { ParamSpec } from "./engine/kernel";
export {
  getModuleDefinitions, // all definitions
  getModuleDefinition, // single lookup by slug -> ModuleDefinition | undefined
  isPlayable, // slug -> boolean
} from "./modules/definitions";
export type { ModuleDefinition } from "./modules/definitions";
export {
  normalizedToEngineValue,
  engineValueToNormalized,
  defaultNormalizedValue,
  isBipolarParam,
} from "./engine/params";
export {
  REVERB_SLUG,
  REVERB_PRESET_CONTROL,
  REVERB_PRESET_VISIBLE,
  REVERB_PRESET_POSITIONS,
} from "./modules/reverbPresets";
