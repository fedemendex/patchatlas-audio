// Engine graph shape plus the deterministic ordering machinery compilePatch
// (compile.ts) uses to turn a name-addressed Patch into numeric node indices
// and [nodeIndex, slot] edges. See docs/architecture.md, "Deterministic
// ordering", for why the order is what it is.

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

// ── Ordering ────────────────────────────────────────────────────────────────

// Code-unit compare. localeCompare collation varies with the runtime's ICU
// locale (hyphens — which UUIDs are full of — can even be ignorable), and
// ordering here must not depend on the environment. Exported so compile.ts
// (AP-14) sorts caller ids the same way, rather than forking the comparator.
export const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Iterative Tarjan. `ids` must be sorted and `successors` lists sorted, so
// component discovery — and therefore everything downstream — is
// deterministic regardless of input array order. Private: only
// computeProcessingOrder calls this, and it's covered indirectly through that
// entry point by graph.test.ts and compile.test.ts's shuffle test — kept
// unexported rather than growing the module's surface for callers that don't
// exist.
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
          members.sort(compareId);
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
// The marking is deterministic and the non-feedback remainder is acyclic by
// construction, but the set is NOT guaranteed globally minimal: densely
// cross-linked components can mark an edge whose unmarking would still leave
// the remainder acyclic. Accepted for v1 by product decision — cycles use
// one-block feedback, so over-marking costs one block of latency on that
// edge, never incorrectness. No pruning pass. Private, same reasoning as
// stronglyConnectedComponents above: no caller outside computeProcessingOrder.
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

// Processing order for a resolved node set: SCC condensation topo-sorted
// (Kahn, ties broken by the smallest instanceId in the component), members of
// a cyclic component in DFS preorder from its smallest id. `ids` must be
// sorted and every `successors` list sorted, matching
// stronglyConnectedComponents's contract.
export function computeProcessingOrder(
  ids: string[],
  successors: Map<string, string[]>,
): string[] {
  const components = stronglyConnectedComponents(ids, successors);
  const compOf = new Map<string, number>();
  components.forEach((members, ci) => {
    for (const id of members) compOf.set(id, ci);
  });

  const compIndegree = components.map(() => 0);
  const compSuccessors: Set<number>[] = components.map(() => new Set());
  for (const id of ids) {
    const a = compOf.get(id) as number;
    for (const to of successors.get(id) ?? []) {
      const b = compOf.get(to) as number;
      if (a !== b && !compSuccessors[a].has(b)) {
        compSuccessors[a].add(b);
        compIndegree[b]++;
      }
    }
  }

  const order: string[] = [];
  const readyComps: number[] = [];
  compIndegree.forEach((d, ci) => {
    if (d === 0) readyComps.push(ci);
  });
  while (readyComps.length > 0) {
    readyComps.sort((a, b) => compareId(components[a][0], components[b][0]));
    const ci = readyComps.shift() as number;
    order.push(...componentOrder(components[ci], successors));
    for (const next of compSuccessors[ci]) {
      if (--compIndegree[next] === 0) readyComps.push(next);
    }
  }
  return order;
}

// Per-source successor lists, sorted for determinism — the direct input
// computeProcessingOrder requires.
export function buildSuccessors<E extends { fromId: string; toId: string }>(
  ids: string[],
  edges: E[],
): Map<string, string[]> {
  const successors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) successors.get(e.fromId)?.push(e.toId);
  for (const list of successors.values()) list.sort(compareId);
  return successors;
}

// Resolved (fromId/toId) edges reindexed onto a computeProcessingOrder result
// as EngineGraph's numeric [nodeIndex, slot] pairs: edges that point
// backwards (or to self) in `indexById` are marked feedback — everything
// else is acyclic by construction — and the result is sorted into
// EngineGraph's canonical edge order.
export function shapeEdges<E extends { fromId: string; outSlot: number; toId: string; inSlot: number }>(
  edges: E[],
  indexById: Map<string, number>,
): EngineEdge[] {
  return edges
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
}
