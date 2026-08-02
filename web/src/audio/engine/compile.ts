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
import type { ModuleDSP } from "../modules/registry";
import { resolvePatch, type Diagnostic } from "./diagnostics";
import type { Patch } from "./patch";

export function compilePatch(
  patch: Patch,
  definitions: Map<string, ModuleDSP>,
): { graph: EngineGraph; diagnostics: Diagnostic[]; loaded: boolean } {
  const { diagnostics, loaded, ids, resolved, edges } = resolvePatch(patch, definitions);

  const successors = buildSuccessors(ids, edges);
  const order = computeProcessingOrder(ids, successors);
  const indexById = new Map(order.map((id, i) => [id, i]));

  const nodes: EngineNode[] = order.map((id) => {
    const r = resolved.get(id);
    if (!r) throw new Error(`resolvePatch produced an order id "${id}" with no resolution`);
    return { instanceId: id, slug: r.dsp.slug, params: r.params };
  });

  const engineEdges = shapeEdges(edges, indexById);

  const outputNodes = order
    .map((id, i) => ((resolved.get(id) as { dsp: ModuleDSP }).dsp.audioOutput ? i : -1))
    .filter((i) => i !== -1);

  return { graph: { nodes, edges: engineEdges, outputNodes }, diagnostics, loaded };
}
