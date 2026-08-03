// Kernel-free public projection of the registry. ModuleDefinition is what the
// package commits to supporting for a consumer: jack/param shape, not the
// kernel implementation. It intentionally omits ModuleDSP.kernel and carries
// no host panel metadata (hp, types, group, groupIndex, kind, explicit
// bipolar hints — those belong to whatever catalog the host maintains;
// `bipolar` is derivable from a ParamSpec via the public isBipolarParam
// helper).

import type { ParamSpec } from "../engine/kernel";
import { isPlayable, registry, type ModuleDSP } from "./registry";

export interface ModuleDefinition {
  slug: string;
  inJacks: string[];
  outJacks: string[];
  params: Record<string, ParamSpec>;
  audioOutput?: { channels: 1 | 2 };
  reportsStep?: boolean;
  limitations?: ModuleDSP["limitations"];
}

function toDefinition(dsp: ModuleDSP): ModuleDefinition {
  const definition: ModuleDefinition = {
    slug: dsp.slug,
    inJacks: dsp.inJacks,
    outJacks: dsp.outJacks,
    params: dsp.params,
  };
  if (dsp.audioOutput) definition.audioOutput = dsp.audioOutput;
  if (dsp.reportsStep) definition.reportsStep = dsp.reportsStep;
  if (dsp.limitations) definition.limitations = dsp.limitations;
  return definition;
}

// Computed once, lazily, and cached: `registry` is a static Map populated at
// module-load time and never mutated afterward in production, so re-deriving
// this projection on every call (e.g. every panel render in a host UI) would
// be pure waste. Safe under test mocks too — a mocked "./registry" resolves
// before this module's first call, so the cache still reflects it.
let definitionsCache: ModuleDefinition[] | null = null;
let definitionsBySlug: Map<string, ModuleDefinition> | null = null;

function ensureCache(): void {
  if (definitionsBySlug) return;
  const list = [...registry.values()].map(toDefinition);
  definitionsCache = list;
  definitionsBySlug = new Map(list.map((d) => [d.slug, d]));
}

/** All module definitions the package currently registers (kernel-free). */
export function getModuleDefinitions(): ModuleDefinition[] {
  ensureCache();
  return definitionsCache!;
}

/** A single module's definition by slug, or undefined if unregistered. */
export function getModuleDefinition(slug: string): ModuleDefinition | undefined {
  ensureCache();
  return definitionsBySlug!.get(slug);
}

export { isPlayable };
