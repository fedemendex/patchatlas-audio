import { describe, it, expect } from "vitest";
import { registry } from "./registry";
import { getModuleDefinition, getModuleDefinitions, isPlayable, type ModuleDefinition } from "./definitions";

describe("getModuleDefinitions", () => {
  const definitions = getModuleDefinitions();

  it("returns exactly one definition per registered module (26)", () => {
    expect(definitions).toHaveLength(26);
    expect(new Set(definitions.map((d) => d.slug)).size).toBe(26);
  });

  it("carries no kernel reference or function value anywhere", () => {
    for (const def of definitions) {
      expect(def).not.toHaveProperty("kernel");
      for (const value of Object.values(def)) {
        expect(typeof value).not.toBe("function");
      }
    }
  });

  it("is serialisable — JSON.stringify round-trips with no kernel functions leaked", () => {
    const roundTripped = JSON.parse(JSON.stringify(definitions)) as ModuleDefinition[];
    expect(roundTripped).toEqual(definitions);
  });

  it("carries no PatchAtlas panel metadata (hp, types, group, groupIndex, kind, bipolar)", () => {
    for (const def of definitions) {
      for (const forbidden of ["hp", "types", "group", "groupIndex", "kind", "bipolar"]) {
        expect(def).not.toHaveProperty(forbidden);
      }
    }
  });

  it("carries audioOutput only for audio-output", () => {
    const audioOutput = definitions.find((d) => d.slug === "audio-output");
    expect(audioOutput?.audioOutput).toEqual({ channels: 2 });
    expect(definitions.filter((d) => d.audioOutput).map((d) => d.slug)).toEqual(["audio-output"]);
  });

  it("carries reportsStep only for sequencer and trigger-sequencer", () => {
    const withStep = definitions.filter((d) => d.reportsStep).map((d) => d.slug).sort();
    expect(withStep).toEqual(["sequencer", "trigger-sequencer"]);
  });

  it("omits limitations for every currently fully-previewed module", () => {
    for (const def of definitions) {
      expect(def.limitations).toBeUndefined();
    }
  });

  it("matches the underlying registry entry's jack/param shape", () => {
    const oscillator = definitions.find((d) => d.slug === "oscillator")!;
    const dsp = registry.get("oscillator")!;
    expect(oscillator.inJacks).toEqual(dsp.inJacks);
    expect(oscillator.outJacks).toEqual(dsp.outJacks);
    expect(oscillator.params).toEqual(dsp.params);
  });
});

describe("getModuleDefinition", () => {
  it("returns the definition for a registered slug", () => {
    const def = getModuleDefinition("vca");
    expect(def?.slug).toBe("vca");
    expect(def?.inJacks).toEqual(["In", "CV"]);
  });

  it("returns undefined for a slug with no kernel (e.g. delay)", () => {
    expect(getModuleDefinition("delay")).toBeUndefined();
  });

  it("returns undefined for an unknown slug", () => {
    expect(getModuleDefinition("not-a-real-slug")).toBeUndefined();
  });

  it("is cached — repeated calls return the same object, not a fresh allocation", () => {
    expect(getModuleDefinition("vca")).toBe(getModuleDefinition("vca"));
    expect(getModuleDefinitions()).toBe(getModuleDefinitions());
    expect(getModuleDefinitions().find((d) => d.slug === "vca")).toBe(getModuleDefinition("vca"));
  });
});

describe("isPlayable (re-exported)", () => {
  it("agrees with the registry", () => {
    expect(isPlayable("vca")).toBe(true);
    expect(isPlayable("delay")).toBe(false);
    expect(isPlayable(null)).toBe(false);
  });
});
