import { describe, expect, it } from "vitest";
import type { Module, ModuleControl, ModuleJack } from "../../lib/api";
import type { PatchDraftDoc } from "../../patches/draft/patchDraft";
import { registry } from "../modules/registry";
import { krellCatalog, krellDoc } from "../../patches/seed/krellPatch";
import { toPatch } from "../patchAdapter";
import { compileGraph } from "./graph";
import { compilePatch } from "./compile";
import { normalizedToEngineValue } from "./params";
import type { Patch } from "./patch";

// ── Fixtures ────────────────────────────────────────────────────────────────
// Same style as graph.test.ts, but built against the REAL registry (not a toy
// one) so the differential test exercises actual seed jack/control names.

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

const oscModule = catalogModule({
  id: "mod-osc",
  name: "Oscillator",
  slug: "oscillator",
  jacks: [
    jack("j-osc-1voct", "1V/Oct", "in", 0),
    jack("j-osc-saw", "Saw", "out", 1),
    jack("j-osc-sine", "Sine", "out", 2),
  ],
  controls: [knob("c-osc-tune", "Tune", 0)],
});

const vcaModule = catalogModule({
  id: "mod-vca",
  name: "VCA",
  slug: "vca",
  jacks: [
    jack("j-vca-in", "In", "in", 0),
    jack("j-vca-cv", "CV", "in", 1),
    jack("j-vca-out", "Out", "out", 2),
  ],
  controls: [knob("c-vca-gain", "Gain", 0)],
});

const outModule = (idSuffix: string) =>
  catalogModule({
    id: `mod-out-${idSuffix}`,
    name: "Audio Output",
    slug: "audio-output",
    jacks: [
      jack(`j-out-${idSuffix}-l`, "L In", "in", 0),
      jack(`j-out-${idSuffix}-r`, "R In", "in", 1),
    ],
  });

const outA = outModule("a");
const outB = outModule("b");

const customModule = catalogModule({
  id: "mod-custom",
  name: "My Custom",
  slug: null,
  isSeeded: false,
  jacks: [jack("j-custom-in", "In", "in", 0)],
});

const baseModuleById = new Map<string, Module>(
  [oscModule, vcaModule, outA, outB, customModule].map((m) => [m.id, m]),
);

function doc(overrides?: Partial<PatchDraftDoc>): PatchDraftDoc {
  return {
    meta: { title: "t", notes: "", visibility: "private", tags: [] },
    modules: [],
    connections: [],
    ...overrides,
  };
}

function draftModule(
  instanceId: string,
  moduleId: string,
  controlValues: Record<string, number | boolean> = {},
) {
  return { instanceId, moduleId, label: "", positionX: 0, positionY: 0, controlValues };
}

// A→B→A feedback cycle through two VCAs, draining to one audio-output.
const feedbackDoc = doc({
  modules: [
    draftModule("a-vca1", "mod-vca"),
    draftModule("b-vca2", "mod-vca"),
    draftModule("c-out", "mod-out-a"),
  ],
  connections: [
    { fromInstanceId: "a-vca1", fromJackId: "j-vca-out", toInstanceId: "b-vca2", toJackId: "j-vca-in" },
    { fromInstanceId: "b-vca2", fromJackId: "j-vca-out", toInstanceId: "a-vca1", toJackId: "j-vca-in" },
    { fromInstanceId: "b-vca2", fromJackId: "j-vca-out", toInstanceId: "c-out", toJackId: "j-out-a-l" },
  ],
});

// Oscillator into a VCA, nothing patched to an audio-output.
const noOutputDoc = doc({
  modules: [draftModule("a-osc", "mod-osc"), draftModule("b-vca", "mod-vca")],
  connections: [
    { fromInstanceId: "a-osc", fromJackId: "j-osc-saw", toInstanceId: "b-vca", toJackId: "j-vca-in" },
  ],
});

// A chain plus an unseeded custom module patched in (dropped by the adapter).
const customModuleDoc = doc({
  modules: [
    draftModule("a-osc", "mod-osc"),
    draftModule("b-vca", "mod-vca"),
    draftModule("c-out", "mod-out-a"),
    draftModule("d-custom", "mod-custom"),
  ],
  connections: [
    { fromInstanceId: "a-osc", fromJackId: "j-osc-saw", toInstanceId: "b-vca", toJackId: "j-vca-in" },
    { fromInstanceId: "b-vca", fromJackId: "j-vca-out", toInstanceId: "c-out", toJackId: "j-out-a-l" },
    { fromInstanceId: "a-osc", fromJackId: "j-osc-saw", toInstanceId: "d-custom", toJackId: "j-custom-in" },
  ],
});

// One oscillator feeding two independent audio-output instances.
const multiOutputDoc = doc({
  modules: [
    draftModule("a-osc", "mod-osc"),
    draftModule("b-out", "mod-out-a"),
    draftModule("c-out", "mod-out-b"),
  ],
  connections: [
    { fromInstanceId: "a-osc", fromJackId: "j-osc-saw", toInstanceId: "b-out", toJackId: "j-out-a-l" },
    { fromInstanceId: "a-osc", fromJackId: "j-osc-saw", toInstanceId: "c-out", toJackId: "j-out-b-r" },
  ],
});

// ── Differential test ───────────────────────────────────────────────────────

function assertDifferential(label: string, d: PatchDraftDoc, moduleById: Map<string, Module>) {
  const { graph: oldGraph } = compileGraph(d, moduleById, registry);
  const { patch } = toPatch(d, moduleById, registry);
  const { graph: newGraph, loaded } = compilePatch(patch, registry);
  expect(newGraph, label).toEqual(oldGraph);
  expect(loaded, label).toBe(true);
}

describe("compilePatch differential against compileGraph", () => {
  it("the Krell patch", () => {
    const moduleById = new Map(krellCatalog.map((m) => [m.id, m]));
    assertDifferential("krell", krellDoc, moduleById);
  });

  it("a feedback cycle", () => {
    assertDifferential("feedback", feedbackDoc, baseModuleById);
  });

  it("a patch with no audio output", () => {
    assertDifferential("no-output", noOutputDoc, baseModuleById);
  });

  it("a patch with a custom (unseeded) module", () => {
    assertDifferential("custom-module", customModuleDoc, baseModuleById);
  });

  it("a multi-output patch", () => {
    assertDifferential("multi-output", multiOutputDoc, baseModuleById);
    const { patch } = toPatch(multiOutputDoc, baseModuleById, registry);
    const { graph } = compilePatch(patch, registry);
    expect(graph.outputNodes).toHaveLength(2);
  });
});

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

describe("compilePatch round-trip", () => {
  it("compiles identically after JSON.parse(JSON.stringify(...))", () => {
    const moduleById = new Map(krellCatalog.map((m) => [m.id, m]));
    const { patch } = toPatch(krellDoc, moduleById, registry);
    const roundtripped: Patch = JSON.parse(JSON.stringify(patch));

    const a = compilePatch(patch, registry);
    const b = compilePatch(roundtripped, registry);

    expect(b.graph).toEqual(a.graph);
  });
});

describe("compilePatch param mapping", () => {
  it("normalized 0.5 on an exponential spec reaches the kernel as the adapter's engine value", () => {
    const cutoffSpec = registry.get("filter")!.params.Cutoff;
    const filterModule = catalogModule({
      id: "mod-filter",
      name: "Filter",
      slug: "filter",
      jacks: [jack("j-filter-in", "In", "in", 0), jack("j-filter-lp", "LP", "out", 1)],
      controls: [knob("c-filter-cutoff", "Cutoff", 0)],
    });
    const moduleById = new Map([[filterModule.id, filterModule]]);
    const filterDoc = doc({
      modules: [draftModule("a-filter", "mod-filter", { "c-filter-cutoff": 0.5 })],
    });

    const { patch } = toPatch(filterDoc, moduleById, registry);
    const { graph } = compilePatch(patch, registry);

    const expected = normalizedToEngineValue(cutoffSpec, 0.5);
    expect(graph.nodes[0].params[0]).toBe(expected);
    // Sanity: this isn't 20 (the default) or 0.5 (the raw normalized input) —
    // it's the curve-mapped engine value.
    expect(expected).not.toBe(cutoffSpec.default);
    expect(expected).not.toBe(0.5);
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
