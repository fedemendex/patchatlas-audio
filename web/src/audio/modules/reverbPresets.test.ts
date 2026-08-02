// @vitest-environment node

import { describe, it, expect } from "vitest";
import type { Module, ModuleControl } from "../../lib/api";
import { compilePatch } from "../engine/compile";
import { toPatch } from "../patchAdapter";
import { normalizedToEngineValue } from "../engine/params";
import type { PatchDraftDoc } from "../../patches/draft/patchDraft";
import { commitControls } from "../../patches/draft/patchDraft";
import type { PatchDraftState } from "../../patches/draft/patchDraft";
import { registry } from "./registry";
import {
  REVERB_PRESET_POSITIONS,
  REVERB_PRESET_VISIBLE,
  reverbPresetCommitEntries,
} from "./reverbPresets";

const control = (id: string, name: string, kind: ModuleControl["kind"] = "knob"): ModuleControl => ({
  id,
  name,
  kind,
  index: 0,
  bipolar: null,
  group: name,
  groupIndex: null,
  positions: kind === "switch" ? [...REVERB_PRESET_POSITIONS] : null,
});

const reverbModule = (overrides: Partial<Module> = {}): Module => ({
  id: "mod-reverb",
  name: "Reverb",
  manufacturerName: null,
  isSeeded: true,
  version: "1",
  hpWidth: 10,
  description: null,
  slug: "reverb",
  gridRows: null,
  gridColumns: null,
  types: [],
  jacks: [],
  controls: [
    control("ctl-preset", "Preset", "switch"),
    control("ctl-predelay", "PreDelay"),
    control("ctl-size", "Size"),
    control("ctl-decay", "Decay"),
    control("ctl-damp", "Damp"),
    control("ctl-mix", "Mix"),
  ],
  createdBy: null,
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

describe("preset table shape", () => {
  it("supports exactly room, hall and plate", () => {
    expect(REVERB_PRESET_POSITIONS).toEqual(["Room", "Hall", "Plate"]);
    expect(REVERB_PRESET_VISIBLE).toHaveLength(3);
  });

  it("every preset sets exactly the five visible controls", () => {
    for (const preset of REVERB_PRESET_VISIBLE) {
      expect(Object.keys(preset).sort()).toEqual(["Damp", "Decay", "Mix", "PreDelay", "Size"]);
    }
  });

  it("the Room preset IS the registry default — an untouched reverb is Room", () => {
    const specs = registry.get("reverb")?.params;
    expect(specs).toBeDefined();
    expect(specs!.Preset.default).toBe(0);
    for (const [name, engineValue] of Object.entries(REVERB_PRESET_VISIBLE[0])) {
      expect(specs![name].default).toBe(engineValue);
    }
  });

  it("every preset value is representable within its ParamSpec range", () => {
    const specs = registry.get("reverb")!.params;
    for (const preset of REVERB_PRESET_VISIBLE) {
      for (const [name, engineValue] of Object.entries(preset)) {
        expect(engineValue).toBeGreaterThanOrEqual(specs[name].min);
        expect(engineValue).toBeLessThanOrEqual(specs[name].max);
      }
    }
  });
});

describe("reverbPresetCommitEntries", () => {
  const mod = reverbModule();

  it.each([
    ["room", 0],
    ["hall", 1],
    ["plate", 2],
  ])("expands a %s commit to the switch plus all five visible knobs", (_name, preset) => {
    const entries = reverbPresetCommitEntries(mod, "ctl-preset", preset);
    expect(entries).not.toBeNull();
    const byId = new Map(entries!);
    expect(byId.get("ctl-preset")).toBe(preset);

    // Each knob's stored (normalized) value must map back to the preset's
    // engine-unit value through the same curve the adapter applies.
    const specs = registry.get("reverb")!.params;
    const expected = REVERB_PRESET_VISIBLE[preset];
    expect(byId.size).toBe(6);
    for (const [id, name] of [
      ["ctl-predelay", "PreDelay"],
      ["ctl-size", "Size"],
      ["ctl-decay", "Decay"],
      ["ctl-damp", "Damp"],
      ["ctl-mix", "Mix"],
    ] as const) {
      const stored = byId.get(id);
      expect(stored).toBeDefined();
      expect(normalizedToEngineValue(specs[name], stored!)).toBeCloseTo(expected[name], 10);
    }
  });

  it("clamps out-of-range switch values to a valid preset", () => {
    expect(new Map(reverbPresetCommitEntries(mod, "ctl-preset", 7)!).get("ctl-preset")).toBe(2);
    expect(new Map(reverbPresetCommitEntries(mod, "ctl-preset", -3)!).get("ctl-preset")).toBe(0);
  });

  it("returns null for a non-reverb module", () => {
    expect(reverbPresetCommitEntries(reverbModule({ slug: "filter" }), "ctl-preset", 1)).toBeNull();
  });

  it("returns null for a non-Preset control on the reverb", () => {
    expect(reverbPresetCommitEntries(mod, "ctl-size", 1)).toBeNull();
  });

  it("returns null for non-numeric commits (double-click reset, booleans)", () => {
    expect(reverbPresetCommitEntries(mod, "ctl-preset", undefined)).toBeNull();
    expect(reverbPresetCommitEntries(mod, "ctl-preset", true)).toBeNull();
  });
});

// End-to-end state → engine proof: committing a preset batch into the draft
// and compiling yields engine params at exactly the preset's values — the same
// path the live preview's debounced graph rebuild takes (useAudioEngine).
describe("preset changes reach the audio engine", () => {
  const mod = reverbModule();

  function draftStateWithReverb(): PatchDraftState {
    const doc: PatchDraftDoc = {
      meta: { title: "", notes: "", visibility: "private", tags: [] },
      modules: [
        {
          instanceId: "inst-reverb",
          moduleId: mod.id,
          label: "",
          positionX: 0,
          positionY: 0,
          controlValues: {},
        },
      ],
      connections: [],
    };
    return { patchId: null, doc, baseline: doc, origin: { moduleCreatedAt: {} } };
  }

  it("compiles hall params after committing the hall preset batch", () => {
    const entries = reverbPresetCommitEntries(mod, "ctl-preset", 1)!;
    const s = commitControls(draftStateWithReverb(), "inst-reverb", entries);
    const { patch } = toPatch(s.doc, new Map([[mod.id, mod]]), registry);
    const { graph, diagnostics } = compilePatch(patch, registry);

    expect(diagnostics.map((d) => d.code)).toEqual(["no-audio-output"]);
    expect(graph.nodes).toHaveLength(1);
    const hall = REVERB_PRESET_VISIBLE[1];
    // Param slot order = registry declaration order: Preset, PreDelay, Size, Decay, Damp, Mix.
    const [preset, preDelay, size, decay, damp, mix] = graph.nodes[0].params;
    expect(preset).toBe(1);
    expect(preDelay).toBeCloseTo(hall.PreDelay, 10);
    expect(size).toBeCloseTo(hall.Size, 10);
    expect(decay).toBeCloseTo(hall.Decay, 10);
    expect(damp).toBeCloseTo(hall.Damp, 10);
    expect(mix).toBeCloseTo(hall.Mix, 10);
  });

  it("compiles room defaults when no control values are stored", () => {
    const { patch } = toPatch(draftStateWithReverb().doc, new Map([[mod.id, mod]]), registry);
    const { graph } = compilePatch(patch, registry);
    const room = REVERB_PRESET_VISIBLE[0];
    const [preset, preDelay, size, decay, damp, mix] = graph.nodes[0].params;
    expect(preset).toBe(0);
    expect(preDelay).toBeCloseTo(room.PreDelay, 10);
    expect(size).toBeCloseTo(room.Size, 10);
    expect(decay).toBeCloseTo(room.Decay, 10);
    expect(damp).toBeCloseTo(room.Damp, 10);
    expect(mix).toBeCloseTo(room.Mix, 10);
  });
});
