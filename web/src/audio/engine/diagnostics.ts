// Structured diagnostics for the generic compiler (compile.ts): every module,
// jack, or connection compilePatch has to drop gets a machine-readable
// Diagnostic instead of vanishing silently.
// validate() and compilePatch() share resolvePatch() below so a Patch is
// resolved against a registry exactly once; validate() just discards the
// graph-shaping pieces (resolved node/edge maps) and returns the diagnostics.
//
// Every diagnostic carries a stable machine-readable code, a severity, the
// relevant identifiers, whether the item was dropped, and a human-readable
// message. Lenient loading drops what it safely can and keeps going;
// structurally ambiguous input (a duplicate module id a connection
// references) is not safe to guess at, so resolvePatch signals `loaded:
// false` instead of arbitrarily picking one of the duplicates.

import type { ModuleDefinition } from "../modules/definitions";
import { compareId } from "./graph";
import { clampToSpecRange } from "./params";
import type { Patch, PatchConnection, PatchModule } from "./patch";

export type DiagnosticCode =
  | "unknown-module-type"
  | "unknown-jack"
  | "unknown-param"
  | "invalid-param-value"
  | "duplicate-module-id"
  | "connection-to-missing-module"
  | "jack-direction-mismatch"
  | "no-audio-output";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: "warning" | "error";
  dropped: boolean;
  message: string;
  moduleId?: string;
  jack?: string;
  param?: string;
  connection?: { from: [string, string]; to: [string, string] };
}

export interface ResolvedModule {
  id: string;
  dsp: ModuleDefinition;
  params: number[]; // slot order = Object.keys(dsp.params) order
}

export interface ResolvedEdge {
  fromId: string;
  outSlot: number;
  toId: string;
  inSlot: number;
}

export interface Resolution {
  diagnostics: Diagnostic[];
  loaded: boolean;
  // Sorted by compareId up front so node/diagnostic order never depends on
  // the caller's array order.
  ids: string[];
  resolved: Map<string, ResolvedModule>;
  edges: ResolvedEdge[];
}

function connectionRef(conn: PatchConnection): { from: [string, string]; to: [string, string] } {
  return { from: [...conn.from], to: [...conn.to] };
}

// Resolves one connection endpoint against its module's jack lists, pushing
// a diagnostic (and returning -1) unless `jackName` is a real jack of the
// expected role. Shared by both the `from`/output and `to`/input endpoints in
// resolvePatch below so a future change to the diagnostic shape can't drift
// between the two — they used to be two hand-copied blocks differing only in
// field names and message wording.
function resolveEndpointSlot(
  role: "output" | "input",
  moduleId: string,
  dsp: ModuleDefinition,
  jackName: string,
  conn: PatchConnection,
  diagnostics: Diagnostic[],
): number {
  const ownList = role === "output" ? dsp.outJacks : dsp.inJacks;
  const otherList = role === "output" ? dsp.inJacks : dsp.outJacks;
  const otherRole = role === "output" ? "input" : "output";
  const slot = ownList.indexOf(jackName);
  if (slot === -1) {
    const isDirectionMismatch = otherList.includes(jackName);
    diagnostics.push({
      code: isDirectionMismatch ? "jack-direction-mismatch" : "unknown-jack",
      severity: "error",
      dropped: true,
      message: isDirectionMismatch
        ? `"${jackName}" on module "${moduleId}" is an ${otherRole} jack, not an ${role}`
        : `module "${moduleId}" has no ${role} jack "${jackName}"`,
      moduleId,
      jack: jackName,
      connection: connectionRef(conn),
    });
  }
  return slot;
}

// Resolves a Patch against a registry, producing every diagnostic and the
// node/edge data compile.ts needs to shape an EngineGraph. Shared by
// validate() and compilePatch() so the two can never disagree about what a
// given Patch means.
export function resolvePatch(patch: Patch, definitions: Map<string, ModuleDefinition>): Resolution {
  const diagnostics: Diagnostic[] = [];

  const byId = new Map<string, PatchModule[]>();
  for (const m of patch.modules) {
    const list = byId.get(m.id);
    if (list) list.push(m);
    else byId.set(m.id, [m]);
  }
  const duplicateIds = new Set(
    [...byId.entries()].filter(([, list]) => list.length > 1).map(([id]) => id),
  );

  // Modules sorted by id up front — module resolution order, and therefore
  // diagnostic order, is independent of patch.modules' array order.
  const modules = [...patch.modules].sort((a, b) => compareId(a.id, b.id));
  const resolved = new Map<string, ResolvedModule>();

  for (const m of modules) {
    if (duplicateIds.has(m.id)) {
      diagnostics.push({
        code: "duplicate-module-id",
        severity: "error",
        dropped: true,
        message: `module id "${m.id}" is used by more than one module`,
        moduleId: m.id,
      });
      continue;
    }
    const dsp = definitions.get(m.type);
    if (!dsp) {
      diagnostics.push({
        code: "unknown-module-type",
        severity: "error",
        dropped: true,
        message: `module "${m.id}" has unknown type "${m.type}"`,
        moduleId: m.id,
      });
      continue;
    }
    const provided = m.params ?? {};
    for (const key of Object.keys(provided)) {
      if (!Object.hasOwn(dsp.params, key)) {
        diagnostics.push({
          code: "unknown-param",
          severity: "warning",
          dropped: true,
          message: `module "${m.id}" has no param "${key}"`,
          moduleId: m.id,
          param: key,
        });
      } else if (!Number.isFinite(provided[key])) {
        diagnostics.push({
          code: "invalid-param-value",
          severity: "warning",
          dropped: true,
          message: `module "${m.id}" has a non-finite value for param "${key}"; using the default`,
          moduleId: m.id,
          param: key,
        });
      }
    }
    // Engine units are the caller's responsibility (patch.ts), but a Patch
    // is a public entry point (compilePatch has no PatchAtlas-side validation
    // in front of it) — clamp to the spec's declared range via the same
    // clampToSpecRange the curve math (params.ts) uses for every normalized
    // input, so the two Patch-authoring paths can't drift on clamp semantics.
    const params = Object.keys(dsp.params).map((name) => {
      const spec = dsp.params[name];
      const raw = provided[name];
      if (raw === undefined || !Number.isFinite(raw)) return spec.default;
      // "positions" values are switch indices — round before clamping, the
      // same as normalizedToEngineValue/engineValueToNormalized (params.ts),
      // so a hand-authored Patch can't hand a kernel a fractional index.
      return clampToSpecRange(spec, spec.curve === "positions" ? Math.round(raw) : raw);
    });
    resolved.set(m.id, { id: m.id, dsp, params });
  }

  // A duplicate id referenced by a connection is structurally ambiguous —
  // both copies were dropped above, but nothing here should be trusted to
  // pick a graph for the caller, so the whole load is rejected.
  let loaded = true;
  for (const id of duplicateIds) {
    if (patch.connections.some((c) => c.from[0] === id || c.to[0] === id)) {
      loaded = false;
      break;
    }
  }

  // Sorted by a stable composite key up front, matching the module loop
  // above — connection diagnostic order (unlike graph shape, which is
  // re-sorted numerically downstream regardless) must not depend on the
  // caller's array order either.
  const connectionKey = (c: PatchConnection) => `${c.from[0]}::${c.from[1]}::${c.to[0]}::${c.to[1]}`;
  const connections = [...patch.connections].sort((a, b) =>
    compareId(connectionKey(a), connectionKey(b)),
  );

  const edges: ResolvedEdge[] = [];
  for (const conn of connections) {
    const [fromId, fromJack] = conn.from;
    const [toId, toJack] = conn.to;
    const from = resolved.get(fromId);
    const to = resolved.get(toId);
    if (!from || !to) {
      diagnostics.push({
        code: "connection-to-missing-module",
        severity: "warning",
        dropped: true,
        message: `connection references a module that did not resolve`,
        connection: connectionRef(conn),
      });
      continue;
    }
    // Both endpoints are checked independently — not short-circuited after
    // the first failure — so a connection that's backwards on both ends
    // (a plausible copy/paste mistake for a hand-written Patch) surfaces a
    // diagnostic for each side instead of only the `from` one. The edge is
    // dropped either way, so this only ever adds diagnostics, never changes
    // which connections make it into the graph.
    const outSlot = resolveEndpointSlot("output", fromId, from.dsp, fromJack, conn, diagnostics);
    const inSlot = resolveEndpointSlot("input", toId, to.dsp, toJack, conn, diagnostics);
    if (outSlot === -1 || inSlot === -1) continue;
    edges.push({ fromId, outSlot, toId, inSlot });
  }

  const ids = [...resolved.keys()];
  if (!ids.some((id) => (resolved.get(id) as ResolvedModule).dsp.audioOutput)) {
    diagnostics.push({
      code: "no-audio-output",
      severity: "warning",
      dropped: false,
      message: "patch has no audio-output module",
    });
  }

  return { diagnostics, loaded, ids, resolved, edges };
}

// Pure: no audio, no DOM, no browser APIs. Structural validation only.
export function validate(patch: Patch, definitions: Map<string, ModuleDefinition>): Diagnostic[] {
  return resolvePatch(patch, definitions).diagnostics;
}
