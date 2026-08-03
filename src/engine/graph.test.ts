// Dedicated correctness coverage for graph.ts's own cycle-detection/marking
// logic (restores the hardcoded-expected-value test lost in the #287 move —
// see docs' extraction follow-ups). compile.test.ts's shuffle test only
// checks self-consistency across input reorderings; this file checks the
// marking against a known-correct answer, so a regression that still
// produces an internally consistent but wrong result (e.g. the wrong edge,
// or zero/two edges marked feedback in a simple cycle) fails a test instead
// of shipping as a silent audio-behavior change.

import { describe, expect, it } from "vitest";
import { buildSuccessors, computeProcessingOrder, shapeEdges } from "./graph";

interface NamedEdge {
  fromId: string;
  outSlot: number;
  toId: string;
  inSlot: number;
}

function edge(fromId: string, toId: string): NamedEdge {
  return { fromId, outSlot: 0, toId, inSlot: 0 };
}

function markFeedback(ids: string[], edges: NamedEdge[]): Map<string, boolean> {
  const successors = buildSuccessors(ids, edges);
  const order = computeProcessingOrder(ids, successors);
  const indexById = new Map(order.map((id, i) => [id, i]));
  const shaped = shapeEdges(edges, indexById);
  const byPair = new Map<string, boolean>();
  for (let i = 0; i < edges.length; i++) {
    byPair.set(`${edges[i].fromId}->${edges[i].toId}`, shaped[i].feedback);
  }
  return byPair;
}

describe("graph.ts feedback-edge marking", () => {
  it("marks exactly the closing edge in a 2-node cycle (A -> B -> A)", () => {
    const ids = ["a", "b"];
    const edges = [edge("a", "b"), edge("b", "a")];

    const feedback = markFeedback(ids, edges);

    expect(feedback.get("a->b")).toBe(false);
    expect(feedback.get("b->a")).toBe(true);
  });

  it("marks exactly the closing edge in a 3-node cycle (A -> B -> C -> A)", () => {
    const ids = ["a", "b", "c"];
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a")];

    const feedback = markFeedback(ids, edges);

    expect(feedback.get("a->b")).toBe(false);
    expect(feedback.get("b->c")).toBe(false);
    expect(feedback.get("c->a")).toBe(true);
  });

  it("marks no edge feedback in an acyclic chain (A -> B -> C)", () => {
    const ids = ["a", "b", "c"];
    const edges = [edge("a", "b"), edge("b", "c")];

    const feedback = markFeedback(ids, edges);

    expect(feedback.get("a->b")).toBe(false);
    expect(feedback.get("b->c")).toBe(false);
  });
});
