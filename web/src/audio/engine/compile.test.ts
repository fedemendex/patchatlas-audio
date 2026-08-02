import { describe, expect, it } from "vitest";
import { registry } from "../modules/registry";
import { compilePatch } from "./compile";
import type { Patch } from "./patch";

describe("compilePatch determinism", () => {
  it("is unaffected by shuffling patch.modules and patch.connections", () => {
    const base: Patch = {
      modules: [
        { id: "b-vca2", type: "vca" },
        { id: "a-vca1", type: "vca" },
        { id: "c-out", type: "audio-output" },
      ],
      connections: [
        { from: ["a-vca1", "Out"], to: ["b-vca2", "In"] },
        { from: ["b-vca2", "Out"], to: ["a-vca1", "In"] },
        { from: ["b-vca2", "Out"], to: ["c-out", "L In"] },
      ],
    };
    const shuffled: Patch = {
      modules: [base.modules[2], base.modules[0], base.modules[1]],
      connections: [...base.connections].reverse(),
    };

    const a = compilePatch(base, registry);
    const b = compilePatch(shuffled, registry);

    expect(b.graph).toEqual(a.graph);
    expect(b.graph.nodes.map((n) => n.instanceId)).toEqual(
      a.graph.nodes.map((n) => n.instanceId),
    );
  });
});

describe("compilePatch param clamping", () => {
  it("clamps a finite out-of-range param value to the spec's [min, max]", () => {
    const cutoffSpec = registry.get("filter")!.params.Cutoff;
    const patch: Patch = {
      modules: [{ id: "a-filter", type: "filter", params: { Cutoff: cutoffSpec.max * 100 } }],
      connections: [],
    };
    const { graph } = compilePatch(patch, registry);
    expect(graph.nodes[0].params[0]).toBe(cutoffSpec.max);
  });

  it("clamps a finite out-of-range param value below the minimum", () => {
    const cutoffSpec = registry.get("filter")!.params.Cutoff;
    const patch: Patch = {
      modules: [{ id: "a-filter", type: "filter", params: { Cutoff: -1 } }],
      connections: [],
    };
    const { graph } = compilePatch(patch, registry);
    expect(graph.nodes[0].params[0]).toBe(cutoffSpec.min);
  });

  it("rounds a fractional value for a 'positions' curve param before clamping", () => {
    const responseSpec = registry.get("vca")!.params.Response;
    expect(responseSpec.curve).toBe("positions");
    const patch: Patch = {
      // Response is params[2]: Gain, CV Amt, Response (registry declaration order).
      modules: [{ id: "a-vca", type: "vca", params: { Response: 0.6 } }],
      connections: [],
    };
    const { graph } = compilePatch(patch, registry);
    expect(graph.nodes[0].params[2]).toBe(1);
  });
});

describe("compilePatch duplicate module ids", () => {
  it("rejects the load when a duplicate id is referenced by a connection", () => {
    const dupPatch: Patch = {
      modules: [
        { id: "a", type: "oscillator" },
        { id: "a", type: "vca" },
        { id: "out", type: "audio-output" },
      ],
      connections: [{ from: ["a", "Saw"], to: ["out", "L In"] }],
    };
    const { loaded, diagnostics } = compilePatch(dupPatch, registry);
    expect(loaded).toBe(false);
    expect(diagnostics.filter((d) => d.code === "duplicate-module-id")).toHaveLength(2);
  });

  it("stays loaded when the duplicate id is never referenced by a connection", () => {
    const dupPatch: Patch = {
      modules: [
        { id: "a", type: "oscillator" },
        { id: "a", type: "vca" },
        { id: "out", type: "audio-output" },
      ],
      connections: [],
    };
    const { loaded } = compilePatch(dupPatch, registry);
    expect(loaded).toBe(true);
  });
});
