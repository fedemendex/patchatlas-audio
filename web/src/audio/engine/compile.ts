// compilePatch: the engine's standalone compiler — a Patch (patch.ts) in, the
// EngineGraph the interpreter consumes out, plus structured Diagnostics
// (diagnostics.ts) for anything dropped along the way. PatchAtlas is the only
// caller today, via the adapter (patchAdapter.ts) that turns its
// database-backed PatchDraftDoc into a Patch first (#284); the point of this
// module is that it needs no PatchAtlas types to do its job.
//
// Node/edge ordering reuses graph.ts's buildSuccessors, computeProcessingOrder
// and shapeEdges verbatim (SCC condensation, Kahn topo-sort, DFS-preorder
// feedback marking, canonical edge sort). Sorts by the caller's `id`.

import type { EngineGraph, EngineNode } from "./graph";
import { buildSuccessors, computeProcessingOrder, shapeEdges } from "./graph";
import type { ModuleDefinition } from "../modules/definitions";
import { resolvePatch, type Diagnostic } from "./diagnostics";
import type { Patch } from "./patch";

export function compilePatch(
  patch: Patch,
  definitions: Map<string, ModuleDefinition>,
): { graph: EngineGraph; diagnostics: Diagnostic[]; loaded: boolean } {
  const { diagnostics, loaded, ids, resolved, edges } = resolvePatch(patch, definitions);

  const successors = buildSuccessors(ids, edges);
  const order = computeProcessingOrder(ids, successors);
  const indexById = new Map(order.map((id, i) => [id, i]));

  // Single pass over `order`, one checked `resolved.get(id)` lookup shared by
  // both nodes and outputNodes — the two used to look this id up separately,
  // and the second lookup skipped the checked-and-thrown guard the first one
  // has (safe only because `order` is always derived from `resolved`'s own
  // keys; not worth two different failure modes for the same invariant).
  const nodes: EngineNode[] = [];
  const outputNodes: number[] = [];
  order.forEach((id, i) => {
    const r = resolved.get(id);
    if (!r) throw new Error(`resolvePatch produced an order id "${id}" with no resolution`);
    nodes.push({ instanceId: id, slug: r.dsp.slug, params: r.params });
    if (r.dsp.audioOutput) outputNodes.push(i);
  });

  const engineEdges = shapeEdges(edges, indexById);

  return { graph: { nodes, edges: engineEdges, outputNodes }, diagnostics, loaded };
}
