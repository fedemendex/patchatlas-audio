// @vitest-environment node

import { describe, it, expect } from "vitest";
import { registry } from "./registry";
import { REVERB_PRESET_POSITIONS, REVERB_PRESET_VISIBLE } from "./reverbPresets";

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
