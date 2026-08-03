// The package's public entry point — the authoritative surface the package
// commits to supporting. Everything else under engine/, modules/ and
// worklet/ is a private implementation detail, free to change without notice
// (docs/architecture.md lists which names are which). Export the minimum a
// consumer needs; nothing here can be removed cheaply once shipped, which is
// what publicSurface.test.ts's snapshot is there to make deliberate.

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
  clampToSpecRange,
} from "./engine/params";
export {
  REVERB_SLUG,
  REVERB_PRESET_CONTROL,
  REVERB_PRESET_VISIBLE,
  REVERB_PRESET_POSITIONS,
} from "./modules/reverbPresets";
