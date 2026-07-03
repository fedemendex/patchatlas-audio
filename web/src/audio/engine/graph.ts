// compileGraph: PatchDraftDoc → engine-ready graph + structured warnings.
//
// Pure and deterministic, mirroring patchDraft.ts: plain JSON in, plain JSON
// out, catalog and DSP registry injected, no I/O. Warnings are data — the UI
// (AP-13) renders them; nothing here is a user-facing string.

import type { Module } from "../../lib/api";
import type { PatchDraftDoc } from "../../patches/draft/patchDraft";
import type { ModuleDSP } from "../modules/registry";
import type { ParamSpec } from "./kernel";

export interface EngineNode {
  instanceId: string;
  slug: string;
  params: number[];
}

export interface EngineEdge {
  from: [nodeIndex: number, outSlot: number];
  to: [nodeIndex: number, inSlot: number];
  feedback: boolean; // reads previous block's buffer
}

export interface EngineGraph {
  sampleRateHint?: number; // engine still takes real sr at init
  nodes: EngineNode[]; // in deterministic processing order
  edges: EngineEdge[];
  outputNodes: number[]; // indices of audio-output instances
}

export type CompileWarning =
  | { kind: "custom-module"; instanceId: string; label: string }
  | { kind: "unplayable-module"; instanceId: string; label: string; slug: string }
  | { kind: "unknown-module"; instanceId: string }
  | { kind: "no-audio-output" };

// ── Param mapping ───────────────────────────────────────────────────────────
// Knob values are stored normalized 0..1 (see ModulePanel); switches store a
// position index. Curves map normalized → engine units.

function paramValue(spec: ParamSpec, raw: number | boolean | undefined): number {
  if (raw === undefined) return spec.default;
  const v = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
  if (!Number.isFinite(v)) return spec.default;
  const t = Math.min(1, Math.max(0, v));
  switch (spec.curve) {
    case "linear":
      return spec.min + t * (spec.max - spec.min);
    case "exponential":
      return spec.min * Math.pow(spec.max / spec.min, t);
    case "positions":
      return Math.min(spec.max, Math.max(spec.min, Math.round(v)));
  }
}

function paramsFor(dsp: ModuleDSP, module: Module, controlValues: Record<string, number | boolean>): number[] {
  const controlIdByName = new Map(module.controls.map((c) => [c.name, c.id]));
  return Object.entries(dsp.params).map(([name, spec]) => {
    const controlId = controlIdByName.get(name);
    const raw = controlId === undefined ? undefined : controlValues[controlId];
    return paramValue(spec, raw);
  });
}

// ── Compilation ─────────────────────────────────────────────────────────────

interface Resolved {
  instanceId: string;
  module: Module;
  dsp: ModuleDSP;
}

// Iterative Tarjan. `ids` must be sorted and `successors` lists sorted, so
// component discovery — and therefore everything downstream — is
// deterministic regardless of input array order.
function stronglyConnectedComponents(
  ids: string[],
  successors: Map<string, string[]>,
): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of ids) {
    if (index.has(root)) continue;
    // Frame: [node, next successor position to visit].
    const work: [string, number][] = [[root, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [id, pos] = frame;
      if (pos === 0) {
        index.set(id, counter);
        lowlink.set(id, counter);
        counter++;
        stack.push(id);
        onStack.add(id);
      }
      const succ = successors.get(id) ?? [];
      if (pos < succ.length) {
        frame[1]++;
        const next = succ[pos];
        if (!index.has(next)) {
          work.push([next, 0]);
        } else if (onStack.has(next)) {
          lowlink.set(id, Math.min(lowlink.get(id) as number, index.get(next) as number));
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1][0];
          lowlink.set(
            parent,
            Math.min(lowlink.get(parent) as number, lowlink.get(id) as number),
          );
        }
        if (lowlink.get(id) === index.get(id)) {
          const members: string[] = [];
          let popped: string;
          do {
            popped = stack.pop() as string;
            onStack.delete(popped);
            members.push(popped);
          } while (popped !== id);
          members.sort((a, b) => a.localeCompare(b));
          components.push(members);
        }
      }
    }
  }
  return components;
}

// Member order inside one component: DFS preorder over intra-component
// edges from the smallest id. Following the cycle's flow direction keeps the
// backward-edge (feedback) set small — typically one edge per simple loop.
function componentOrder(members: string[], successors: Map<string, string[]>): string[] {
  if (members.length === 1) return members;
  const inComp = new Set(members);
  const visited = new Set<string>();
  const order: string[] = [];
  for (const root of members) {
    if (visited.has(root)) continue;
    const work = [root];
    while (work.length > 0) {
      const id = work.pop() as string;
      if (visited.has(id)) continue;
      visited.add(id);
      order.push(id);
      const next = (successors.get(id) ?? []).filter(
        (s) => inComp.has(s) && !visited.has(s),
      );
      // Reverse so the smallest-id successor is popped (visited) first.
      for (let i = next.length - 1; i >= 0; i--) work.push(next[i]);
    }
  }
  return order;
}

export function compileGraph(
  doc: PatchDraftDoc,
  moduleById: Map<string, Module>,
  registry: Map<string, ModuleDSP>,
): { graph: EngineGraph; warnings: CompileWarning[] } {
  const warnings: CompileWarning[] = [];

  // Instance order is sorted by instanceId up front so classification,
  // ordering ties, and warning order are independent of doc array order.
  const instances = [...doc.modules].sort((a, b) =>
    a.instanceId.localeCompare(b.instanceId),
  );

  const resolved = new Map<string, Resolved>();
  for (const inst of instances) {
    const module = moduleById.get(inst.moduleId);
    if (!module) {
      warnings.push({ kind: "unknown-module", instanceId: inst.instanceId });
      continue;
    }
    const label = inst.label !== "" ? inst.label : module.name;
    if (!module.isSeeded) {
      warnings.push({ kind: "custom-module", instanceId: inst.instanceId, label });
      continue;
    }
    const dsp = module.slug === null ? undefined : registry.get(module.slug);
    if (!dsp) {
      warnings.push({
        kind: "unplayable-module",
        instanceId: inst.instanceId,
        label,
        slug: module.slug ?? "",
      });
      continue;
    }
    resolved.set(inst.instanceId, { instanceId: inst.instanceId, module, dsp });
  }

  // Resolve connections to (instanceId, slot) endpoints; drop anything that
  // touches a skipped instance or an unmapped jack.
  interface ResolvedEdge {
    fromId: string;
    outSlot: number;
    toId: string;
    inSlot: number;
  }
  const resolvedEdges: ResolvedEdge[] = [];
  for (const conn of doc.connections) {
    const from = resolved.get(conn.fromInstanceId);
    const to = resolved.get(conn.toInstanceId);
    if (!from || !to) continue;
    const fromJack = from.module.jacks.find((j) => j.id === conn.fromJackId);
    const toJack = to.module.jacks.find((j) => j.id === conn.toJackId);
    if (!fromJack || !toJack) continue;
    const outSlot = from.dsp.outJacks.indexOf(fromJack.name);
    const inSlot = to.dsp.inJacks.indexOf(toJack.name);
    if (outSlot === -1 || inSlot === -1) continue;
    resolvedEdges.push({ fromId: from.instanceId, outSlot, toId: to.instanceId, inSlot });
  }

  // Processing order: SCC condensation topo-sorted (Kahn, ties broken by the
  // smallest instanceId in the component), members of a cyclic component in
  // DFS preorder from its smallest id. Edges that point backwards (or to
  // self) in the resulting order are the feedback set — everything else is
  // acyclic by construction.
  const ids = [...resolved.keys()]; // already sorted via `instances`
  const successors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of resolvedEdges) successors.get(e.fromId)?.push(e.toId);
  for (const list of successors.values()) list.sort((a, b) => a.localeCompare(b));

  const components = stronglyConnectedComponents(ids, successors);
  const compOf = new Map<string, number>();
  components.forEach((members, ci) => {
    for (const id of members) compOf.set(id, ci);
  });

  const compIndegree = components.map(() => 0);
  const compSuccessors: Set<number>[] = components.map(() => new Set());
  for (const e of resolvedEdges) {
    const a = compOf.get(e.fromId) as number;
    const b = compOf.get(e.toId) as number;
    if (a !== b && !compSuccessors[a].has(b)) {
      compSuccessors[a].add(b);
      compIndegree[b]++;
    }
  }

  const order: string[] = [];
  const readyComps: number[] = [];
  compIndegree.forEach((d, ci) => {
    if (d === 0) readyComps.push(ci);
  });
  while (readyComps.length > 0) {
    readyComps.sort((a, b) => components[a][0].localeCompare(components[b][0]));
    const ci = readyComps.shift() as number;
    order.push(...componentOrder(components[ci], successors));
    for (const next of compSuccessors[ci]) {
      if (--compIndegree[next] === 0) readyComps.push(next);
    }
  }

  const indexById = new Map(order.map((id, i) => [id, i]));
  const instanceById = new Map(instances.map((m) => [m.instanceId, m]));
  const nodes: EngineNode[] = order.map((id) => {
    const r = resolved.get(id) as Resolved;
    const inst = instanceById.get(id);
    return {
      instanceId: id,
      slug: r.dsp.slug,
      params: paramsFor(r.dsp, r.module, inst?.controlValues ?? {}),
    };
  });

  const edges: EngineEdge[] = resolvedEdges
    .map((e) => {
      const fromIdx = indexById.get(e.fromId) as number;
      const toIdx = indexById.get(e.toId) as number;
      return {
        from: [fromIdx, e.outSlot] as [number, number],
        to: [toIdx, e.inSlot] as [number, number],
        feedback: toIdx <= fromIdx,
      };
    })
    .sort(
      (a, b) =>
        a.from[0] - b.from[0] || a.from[1] - b.from[1] || a.to[0] - b.to[0] || a.to[1] - b.to[1],
    );

  const outputNodes = order
    .map((id, i) => ((resolved.get(id) as Resolved).dsp.audioOutput ? i : -1))
    .filter((i) => i !== -1);
  if (outputNodes.length === 0) warnings.push({ kind: "no-audio-output" });

  return { graph: { nodes, edges, outputNodes }, warnings };
}
