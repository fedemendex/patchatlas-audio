import { describe, expect, it } from "vitest";
import type { Module, ModuleControl, ModuleJack } from "../../lib/api";
import type { PatchDraftDoc } from "../../patches/draft/patchDraft";
import type { ModuleDSP } from "../modules/registry";
import { testRegistry, toyGainKernel } from "./testKernels";
import { compileGraph } from "./graph";

// ── Fixtures ────────────────────────────────────────────────────────────────
// Catalog Modules mirroring the AP-2 toy registry, plus a toy audio output.
// Jack/control ids are DB-style ids distinct from seed names, so tests prove
// the id → name → slot resolution actually happens.

function jack(id: string, name: string, direction: "in" | "out", index: number): ModuleJack {
  return { id, name, direction, index, group: null, groupIndex: null };
}

function knob(id: string, name: string, index: number): ModuleControl {
  return {
    id,
    name,
    kind: "knob",
    index,
    bipolar: false,
    group: "",
    groupIndex: null,
    positions: null,
  };
}

function catalogModule(overrides: {
  id: string;
  name: string;
  slug: string | null;
  isSeeded?: boolean;
  jacks?: ModuleJack[];
  controls?: ModuleControl[];
}): Module {
  return {
    id: overrides.id,
    name: overrides.name,
    manufacturerName: null,
    isSeeded: overrides.isSeeded ?? true,
    version: "1",
    hpWidth: null,
    description: null,
    slug: overrides.slug,
    gridRows: null,
    gridColumns: null,
    types: [],
    jacks: overrides.jacks ?? [],
    controls: overrides.controls ?? [],
    createdBy: null,
    createdAt: "",
    updatedAt: "",
  };
}

const sineModule = catalogModule({
  id: "mod-sine",
  name: "Toy Sine",
  slug: "toy-sine",
  jacks: [jack("j-sine-out", "Out", "out", 0)],
  controls: [knob("c-sine-freq", "Freq", 0)],
});

const gainModule = catalogModule({
  id: "mod-gain",
  name: "Toy Gain",
  slug: "toy-gain",
  jacks: [jack("j-gain-in", "In", "in", 0), jack("j-gain-out", "Out", "out", 1)],
  controls: [knob("c-gain-gain", "Gain", 0)],
});

const outModule = catalogModule({
  id: "mod-out",
  name: "Toy Out",
  slug: "toy-out",
  jacks: [jack("j-out-in", "In", "in", 0)],
});

const toyOutDSP: ModuleDSP = {
  slug: "toy-out",
  kernel: toyGainKernel, // any kernel body works; the compiler only reads metadata
  inJacks: ["In"],
  outJacks: [],
  params: {},
  audioOutput: { channels: 1 },
};

const fixtureRegistry = new Map<string, ModuleDSP>([
  ...testRegistry,
  ["toy-out", toyOutDSP],
]);

const moduleById = new Map<string, Module>(
  [sineModule, gainModule, outModule].map((m) => [m.id, m]),
);

function doc(overrides?: Partial<PatchDraftDoc>): PatchDraftDoc {
  return {
    meta: { title: "t", notes: "", visibility: "private", tags: [] },
    modules: [],
    connections: [],
    ...overrides,
  };
}

const chainDoc = doc({
  modules: [
    {
      instanceId: "a-sine",
      moduleId: "mod-sine",
      label: "",
      positionX: 0,
      positionY: 0,
      controlValues: { "c-sine-freq": 1 },
    },
    {
      instanceId: "b-gain",
      moduleId: "mod-gain",
      label: "",
      positionX: 0,
      positionY: 0,
      controlValues: { "c-gain-gain": 0.25 },
    },
    {
      instanceId: "c-out",
      moduleId: "mod-out",
      label: "",
      positionX: 0,
      positionY: 0,
      controlValues: {},
    },
  ],
  connections: [
    {
      fromInstanceId: "a-sine",
      fromJackId: "j-sine-out",
      toInstanceId: "b-gain",
      toJackId: "j-gain-in",
    },
    {
      fromInstanceId: "b-gain",
      fromJackId: "j-gain-out",
      toInstanceId: "c-out",
      toJackId: "j-out-in",
    },
  ],
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("compileGraph", () => {
  it("drops a custom module and its connections with a warning; the rest compiles", () => {
    const customModule = catalogModule({
      id: "mod-custom",
      name: "My Custom",
      slug: null,
      isSeeded: false,
      jacks: [jack("j-custom-in", "In", "in", 0)],
    });
    const catalog = new Map(moduleById).set("mod-custom", customModule);
    const withCustom = doc({
      modules: [
        ...chainDoc.modules,
        {
          instanceId: "d-custom",
          moduleId: "mod-custom",
          label: "wiggler",
          positionX: 0,
          positionY: 0,
          controlValues: {},
        },
      ],
      connections: [
        ...chainDoc.connections,
        {
          fromInstanceId: "a-sine",
          fromJackId: "j-sine-out",
          toInstanceId: "d-custom",
          toJackId: "j-custom-in",
        },
      ],
    });

    const { graph, warnings } = compileGraph(withCustom, catalog, fixtureRegistry);

    expect(warnings).toEqual([
      { kind: "custom-module", instanceId: "d-custom", label: "wiggler" },
    ]);
    expect(graph.nodes.map((n) => n.instanceId)).toEqual(["a-sine", "b-gain", "c-out"]);
    expect(graph.edges).toHaveLength(2);
  });

  it("warns on an unknown moduleId instead of throwing", () => {
    const withGhost = doc({
      modules: [
        ...chainDoc.modules,
        {
          instanceId: "z-ghost",
          moduleId: "mod-deleted",
          label: "",
          positionX: 0,
          positionY: 0,
          controlValues: {},
        },
      ],
      connections: chainDoc.connections,
    });

    const { graph, warnings } = compileGraph(withGhost, moduleById, fixtureRegistry);

    expect(warnings).toEqual([{ kind: "unknown-module", instanceId: "z-ghost" }]);
    expect(graph.nodes).toHaveLength(3);
  });

  it("warns on a seeded module with no registry kernel (unplayable)", () => {
    const filterModule = catalogModule({
      id: "mod-filter",
      name: "Toy Filter",
      slug: "toy-filter",
      jacks: [jack("j-filter-in", "In", "in", 0)],
    });
    const catalog = new Map(moduleById).set("mod-filter", filterModule);
    const withFilter = doc({
      modules: [
        ...chainDoc.modules,
        {
          instanceId: "d-filter",
          moduleId: "mod-filter",
          label: "",
          positionX: 0,
          positionY: 0,
          controlValues: {},
        },
      ],
      connections: chainDoc.connections,
    });

    const { graph, warnings } = compileGraph(withFilter, catalog, fixtureRegistry);

    expect(warnings).toEqual([
      { kind: "unplayable-module", instanceId: "d-filter", label: "Toy Filter", slug: "toy-filter" },
    ]);
    expect(graph.nodes).toHaveLength(3);
  });

  it("marks exactly one feedback edge in an A→B→A cycle and keeps the rest topo-ordered", () => {
    const loopDoc = doc({
      modules: [
        {
          instanceId: "a-g1",
          moduleId: "mod-gain",
          label: "",
          positionX: 0,
          positionY: 0,
          controlValues: {},
        },
        {
          instanceId: "b-g2",
          moduleId: "mod-gain",
          label: "",
          positionX: 0,
          positionY: 0,
          controlValues: {},
        },
        {
          instanceId: "c-out",
          moduleId: "mod-out",
          label: "",
          positionX: 0,
          positionY: 0,
          controlValues: {},
        },
      ],
      connections: [
        {
          fromInstanceId: "a-g1",
          fromJackId: "j-gain-out",
          toInstanceId: "b-g2",
          toJackId: "j-gain-in",
        },
        {
          fromInstanceId: "b-g2",
          fromJackId: "j-gain-out",
          toInstanceId: "a-g1",
          toJackId: "j-gain-in",
        },
        {
          fromInstanceId: "b-g2",
          fromJackId: "j-gain-out",
          toInstanceId: "c-out",
          toJackId: "j-out-in",
        },
      ],
    });

    const { graph, warnings } = compileGraph(loopDoc, moduleById, fixtureRegistry);

    expect(warnings).toEqual([]);
    expect(graph.nodes.map((n) => n.instanceId)).toEqual(["a-g1", "b-g2", "c-out"]);
    expect(graph.edges).toEqual([
      { from: [0, 0], to: [1, 0], feedback: false },
      { from: [1, 0], to: [0, 0], feedback: true },
      { from: [1, 0], to: [2, 0], feedback: false },
    ]);
  });

  it("maps control values: clamps, exponential endpoints, defaults, switch index", () => {
    const switcherModule = catalogModule({
      id: "mod-switcher",
      name: "Toy Switcher",
      slug: "toy-switcher",
      controls: [
        knob("c-sw-freq", "Freq", 0),
        knob("c-sw-amount", "Amount", 1),
        {
          id: "c-sw-mode",
          name: "Mode",
          kind: "switch",
          index: 2,
          bipolar: null,
          group: "",
          groupIndex: null,
          positions: ["A", "B", "C"],
        },
      ],
    });
    const switcherDSP: ModuleDSP = {
      slug: "toy-switcher",
      kernel: toyGainKernel,
      inJacks: [],
      outJacks: [],
      params: {
        Freq: { min: 20, max: 20000, default: 440, curve: "exponential" },
        Amount: { min: 0, max: 10, default: 3, curve: "linear" },
        Mode: { min: 0, max: 2, default: 0, curve: "positions", positions: ["A", "B", "C"] },
      },
    };
    const catalog = new Map(moduleById).set("mod-switcher", switcherModule);
    const registry = new Map(fixtureRegistry).set("toy-switcher", switcherDSP);

    const compile = (controlValues: Record<string, number | boolean>) => {
      const { graph } = compileGraph(
        doc({
          modules: [
            {
              instanceId: "s1",
              moduleId: "mod-switcher",
              label: "",
              positionX: 0,
              positionY: 0,
              controlValues,
            },
          ],
        }),
        catalog,
        registry,
      );
      return graph.nodes[0].params;
    };

    // Exponential endpoints hit min/max exactly; out-of-range values clamp.
    expect(compile({ "c-sw-freq": 0 })[0]).toBe(20);
    expect(compile({ "c-sw-freq": 1 })[0]).toBe(20000);
    expect(compile({ "c-sw-freq": 1.7 })[0]).toBe(20000);
    expect(compile({ "c-sw-amount": -0.5 })[1]).toBe(0);
    expect(compile({ "c-sw-amount": 0.5 })[1]).toBe(5);
    // Unset controls fall back to spec defaults, in registry param order.
    expect(compile({})).toEqual([440, 3, 0]);
    // Switch values are position indices, clamped to the valid range.
    expect(compile({ "c-sw-mode": 2 })[2]).toBe(2);
    expect(compile({ "c-sw-mode": 7 })[2]).toBe(2);
    // Unknown control ids are ignored.
    expect(compile({ "c-nope": 0.9 })).toEqual([440, 3, 0]);
  });

  it("warns when no audio-output instance survives compilation", () => {
    const silentDoc = doc({
      modules: [chainDoc.modules[0], chainDoc.modules[1]],
      connections: [chainDoc.connections[0]],
    });

    const { graph, warnings } = compileGraph(silentDoc, moduleById, fixtureRegistry);

    expect(warnings).toEqual([{ kind: "no-audio-output" }]);
    expect(graph.outputNodes).toEqual([]);
    expect(graph.nodes).toHaveLength(2);
  });

  it("drops a connection whose from endpoint is an input jack, even under in/out name collision", () => {
    // "Sig" names both an in and an out jack; only direction disambiguates.
    const thruModule = catalogModule({
      id: "mod-thru",
      name: "Toy Thru",
      slug: "toy-thru",
      jacks: [jack("j-thru-in", "Sig", "in", 0), jack("j-thru-out", "Sig", "out", 1)],
    });
    const thruDSP: ModuleDSP = {
      slug: "toy-thru",
      kernel: toyGainKernel,
      inJacks: ["Sig"],
      outJacks: ["Sig"],
      params: {},
    };
    const catalog = new Map(moduleById).set("mod-thru", thruModule);
    const registry = new Map(fixtureRegistry).set("toy-thru", thruDSP);
    const reversedDoc = doc({
      modules: [
        {
          instanceId: "a-thru",
          moduleId: "mod-thru",
          label: "",
          positionX: 0,
          positionY: 0,
          controlValues: {},
        },
        {
          instanceId: "b-gain",
          moduleId: "mod-gain",
          label: "",
          positionX: 0,
          positionY: 0,
          controlValues: {},
        },
      ],
      connections: [
        // Legit: thru's OUT jack → gain in.
        {
          fromInstanceId: "a-thru",
          fromJackId: "j-thru-out",
          toInstanceId: "b-gain",
          toJackId: "j-gain-in",
        },
        // Bogus: thru's IN jack as the from endpoint — must be dropped, not
        // resolved through the identically named out jack.
        {
          fromInstanceId: "a-thru",
          fromJackId: "j-thru-in",
          toInstanceId: "b-gain",
          toJackId: "j-gain-in",
        },
      ],
    });

    const { graph } = compileGraph(reversedDoc, catalog, registry);

    expect(graph.edges).toEqual([{ from: [0, 0], to: [1, 0], feedback: false }]);
  });

  it("does not mutate its inputs: a deep-frozen doc compiles identically", () => {
    // Include an unknown module so the warning path runs against frozen state
    // too. Any mutation of the frozen doc throws (test files are strict mode).
    const base = doc({
      modules: [
        ...chainDoc.modules,
        {
          instanceId: "z-ghost",
          moduleId: "mod-deleted",
          label: "",
          positionX: 0,
          positionY: 0,
          controlValues: {},
        },
      ],
      connections: chainDoc.connections,
    });
    const frozen = deepFreeze(structuredClone(base));
    // Catalog Modules are plain JSON; the registry holds kernel functions and
    // cannot be structuredCloned, so purity there rests on the doc/catalog run.
    const frozenCatalog = new Map(
      [...moduleById].map(([id, m]) => [id, deepFreeze(structuredClone(m))]),
    );

    const result = compileGraph(frozen, frozenCatalog, fixtureRegistry);

    expect(result).toEqual(compileGraph(base, moduleById, fixtureRegistry));
    expect(frozen).toEqual(base);
  });

  it("is deterministic under shuffled module and connection order", () => {
    const base = doc({
      modules: [
        ...chainDoc.modules,
        {
          instanceId: "z-ghost",
          moduleId: "mod-deleted",
          label: "",
          positionX: 0,
          positionY: 0,
          controlValues: {},
        },
        {
          instanceId: "d-g2",
          moduleId: "mod-gain",
          label: "",
          positionX: 0,
          positionY: 0,
          controlValues: {},
        },
      ],
      connections: [
        ...chainDoc.connections,
        // Second feedback-ish tangle: gain d-g2 loops with b-gain.
        {
          fromInstanceId: "b-gain",
          fromJackId: "j-gain-out",
          toInstanceId: "d-g2",
          toJackId: "j-gain-in",
        },
        {
          fromInstanceId: "d-g2",
          fromJackId: "j-gain-out",
          toInstanceId: "b-gain",
          toJackId: "j-gain-in",
        },
      ],
    });
    const shuffled = doc({
      modules: [base.modules[3], base.modules[1], base.modules[4], base.modules[0], base.modules[2]],
      connections: [...base.connections].reverse(),
    });

    const a = compileGraph(base, moduleById, fixtureRegistry);
    const b = compileGraph(shuffled, moduleById, fixtureRegistry);

    expect(b).toEqual(a);
    expect(b.graph.nodes.map((n) => n.instanceId)).toEqual(
      a.graph.nodes.map((n) => n.instanceId),
    );
  });

  it("compiles a 3-node chain with resolved slots, params, and topo order", () => {
    const { graph, warnings } = compileGraph(chainDoc, moduleById, fixtureRegistry);

    expect(warnings).toEqual([]);
    expect(graph.nodes.map((n) => n.instanceId)).toEqual(["a-sine", "b-gain", "c-out"]);
    expect(graph.nodes.map((n) => n.slug)).toEqual(["toy-sine", "toy-gain", "toy-out"]);
    // Freq knob at 1 → exponential top of range; Gain knob at 0.25 → linear lerp.
    expect(graph.nodes[0].params).toEqual([20000]);
    expect(graph.nodes[1].params).toEqual([0.5]);
    expect(graph.nodes[2].params).toEqual([]);
    expect(graph.edges).toEqual([
      { from: [0, 0], to: [1, 0], feedback: false },
      { from: [1, 0], to: [2, 0], feedback: false },
    ]);
    expect(graph.outputNodes).toEqual([2]);
  });
});
