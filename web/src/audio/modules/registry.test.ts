// @vitest-environment node
// (jsdom rewrites import.meta.url to an http: URL, which breaks the fs seed read;
// this file is pure logic and needs no DOM.)

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { registry, isPlayable, type ModuleDSP } from "./registry";
import { audioOutputKernel } from "./audioOutput";
import { oscillatorKernel } from "./oscillator";
import { vcaKernel } from "./vca";
import { attenuverterKernel } from "./attenuverter";
import { multKernel } from "./mult";
import { mixerKernel } from "./mixer";
import { filterKernel } from "./filter";
import { envelopeGeneratorKernel } from "./envelopeGenerator";
import { lfoKernel } from "./lfo";
import { noiseSourceKernel } from "./noiseSource";
import { sampleAndHoldKernel } from "./sampleAndHold";
import { clockKernel } from "./clock";
import { sequencerKernel } from "./sequencer";
import { toyGainKernel, toySineKernel } from "../engine/testKernels";

// --- Seed-integrity validator -----------------------------------------------
// For every registry entry: the slug must exist in seed/generic_modules.json,
// every inJacks/outJacks name must match a seeded jack of the right direction
// (direction = which seed array it appears in), and every params key must match
// a seeded control name. The real registry is empty until AP-5, so the
// mechanism is proven below with valid and deliberately-broken fixtures.

// A seed jack is either a bare string (ungrouped) or an object with a name —
// both shapes are accepted by internal/api/seed/loader.go's SeedJack.UnmarshalJSON.
type SeedJack = string | { name: string };

interface SeedModule {
  slug: string;
  inputs: SeedJack[];
  outputs: SeedJack[];
  controls: { name: string; count?: number }[];
}

const jackName = (j: SeedJack): string => (typeof j === "string" ? j : j.name);

const seed = JSON.parse(
  readFileSync(new URL("../../../../seed/generic_modules.json", import.meta.url), "utf-8"),
) as SeedModule[];

function validateEntryAgainstSeed(entry: ModuleDSP, seedModules: SeedModule[]): string[] {
  const seeded = seedModules.find((m) => m.slug === entry.slug);
  if (!seeded) return [`unknown slug "${entry.slug}"`];

  const errors: string[] = [];
  const inputs = new Set(seeded.inputs.map(jackName));
  const outputs = new Set(seeded.outputs.map(jackName));
  // Expand counted controls to their "{name} {n}" (1-based) DB names,
  // matching the contractual expansion in internal/api/seed/loader.go.
  // Go expands any non-nil count (including count=1); nil count uses bare name.
  const controls = new Set<string>();
  for (const c of seeded.controls) {
    if (c.count != null) {
      for (let n = 1; n <= c.count; n++) controls.add(`${c.name} ${n}`);
    } else {
      controls.add(c.name);
    }
  }

  for (const name of entry.inJacks) {
    if (!inputs.has(name)) {
      errors.push(
        outputs.has(name)
          ? `jack "${name}" on "${entry.slug}" is an output, used as an input`
          : `unknown input jack "${name}" on "${entry.slug}"`,
      );
    }
  }
  for (const name of entry.outJacks) {
    if (!outputs.has(name)) {
      errors.push(
        inputs.has(name)
          ? `jack "${name}" on "${entry.slug}" is an input, used as an output`
          : `unknown output jack "${name}" on "${entry.slug}"`,
      );
    }
  }
  for (const name of Object.keys(entry.params)) {
    if (!controls.has(name)) {
      errors.push(`unknown control "${name}" on "${entry.slug}"`);
    }
  }
  return errors;
}

// Valid fixtures mirror real seeded modules, exercising both shapes the
// interface must express: a many-jack source (oscillator) and a graph
// terminator with no patchable outputs (audio-output).
const validOscillatorEntry: ModuleDSP = {
  slug: "oscillator",
  kernel: toySineKernel,
  inJacks: ["1V/Oct", "FM", "EFM", "Sync", "PWM"],
  outJacks: ["Saw", "Pulse", "Tri", "Sine", "Sub"],
  params: {
    Tune: { min: -5, max: 5, default: 0, curve: "linear" },
    Fine: { min: -1, max: 1, default: 0, curve: "linear" },
    "FM Amt": { min: -1, max: 1, default: 0, curve: "linear" },
    "EFM Amt": { min: -1, max: 1, default: 0, curve: "linear" },
    PW: { min: 0.05, max: 0.95, default: 0.5, curve: "linear" },
  },
};

const validAudioOutputEntry: ModuleDSP = {
  slug: "audio-output",
  kernel: toyGainKernel,
  inJacks: ["L In", "R In"],
  outJacks: [],
  params: {
    Level: { min: 0, max: 1, default: 0.8, curve: "linear" },
  },
  audioOutput: { channels: 2 },
};

describe("seed-integrity validator", () => {
  it("loads the seed from the repo root", () => {
    expect(seed.length).toBeGreaterThan(0);
    expect(seed.some((m) => m.slug === "oscillator")).toBe(true);
    expect(seed.some((m) => m.slug === "audio-output")).toBe(true);
  });

  it("accepts a valid oscillator entry", () => {
    expect(validateEntryAgainstSeed(validOscillatorEntry, seed)).toEqual([]);
  });

  it("accepts a valid audio-output entry (no patchable outputs, DAC channels)", () => {
    expect(validateEntryAgainstSeed(validAudioOutputEntry, seed)).toEqual([]);
  });

  it("rejects an unknown slug", () => {
    const broken: ModuleDSP = { ...validOscillatorEntry, slug: "oscillator-9000" };
    expect(validateEntryAgainstSeed(broken, seed)).toEqual(['unknown slug "oscillator-9000"']);
  });

  it("rejects an unknown input jack", () => {
    const broken: ModuleDSP = { ...validOscillatorEntry, inJacks: ["1V/Oct", "Nope"] };
    expect(validateEntryAgainstSeed(broken, seed)).toEqual([
      'unknown input jack "Nope" on "oscillator"',
    ]);
  });

  it("rejects a jack used with the wrong direction", () => {
    const outAsIn: ModuleDSP = { ...validOscillatorEntry, inJacks: ["Saw"] };
    expect(validateEntryAgainstSeed(outAsIn, seed)).toEqual([
      'jack "Saw" on "oscillator" is an output, used as an input',
    ]);

    const inAsOut: ModuleDSP = { ...validOscillatorEntry, outJacks: ["FM"] };
    expect(validateEntryAgainstSeed(inAsOut, seed)).toEqual([
      'jack "FM" on "oscillator" is an input, used as an output',
    ]);
  });

  it("rejects an unknown output jack", () => {
    const broken: ModuleDSP = { ...validOscillatorEntry, outJacks: ["Sine", "Bogus"] };
    expect(validateEntryAgainstSeed(broken, seed)).toEqual([
      'unknown output jack "Bogus" on "oscillator"',
    ]);
  });

  it("rejects an unknown control/param", () => {
    const broken: ModuleDSP = {
      ...validOscillatorEntry,
      params: {
        ...validOscillatorEntry.params,
        Warp: { min: 0, max: 1, default: 0, curve: "linear" },
      },
    };
    expect(validateEntryAgainstSeed(broken, seed)).toEqual([
      'unknown control "Warp" on "oscillator"',
    ]);
  });

  // count-expansion fixtures use an inline mock seed so we can control the
  // count value precisely without depending on a real seed entry.
  const countMockSeed: SeedModule[] = [
    {
      slug: "mock-one",
      inputs: [{ name: "In" }],
      outputs: [{ name: "Out" }],
      controls: [{ name: "Att", count: 1 }],
    },
    {
      slug: "mock-two",
      inputs: [],
      outputs: [],
      controls: [{ name: "Att", count: 2 }],
    },
  ];

  it("accepts expanded '{name} 1' param for a count=1 control", () => {
    const valid: ModuleDSP = {
      slug: "mock-one",
      kernel: toyGainKernel,
      inJacks: ["In"],
      outJacks: ["Out"],
      params: { "Att 1": { min: -1, max: 1, default: 0, curve: "linear" } },
    };
    expect(validateEntryAgainstSeed(valid, countMockSeed)).toEqual([]);
  });

  it("rejects bare-name param when seed control has count=1", () => {
    const broken: ModuleDSP = {
      slug: "mock-one",
      kernel: toyGainKernel,
      inJacks: ["In"],
      outJacks: ["Out"],
      params: { Att: { min: -1, max: 1, default: 0, curve: "linear" } },
    };
    expect(validateEntryAgainstSeed(broken, countMockSeed)).toContain(
      'unknown control "Att" on "mock-one"',
    );
  });

  it("rejects bare-name param when seed control has count=2", () => {
    const broken: ModuleDSP = {
      slug: "mock-two",
      kernel: toyGainKernel,
      inJacks: [],
      outJacks: [],
      params: { Att: { min: -1, max: 1, default: 0, curve: "linear" } },
    };
    expect(validateEntryAgainstSeed(broken, countMockSeed)).toContain(
      'unknown control "Att" on "mock-two"',
    );
  });

  it("every real registry entry validates against the seed", () => {
    for (const [slug, entry] of registry) {
      expect(slug).toBe(entry.slug);
      expect(validateEntryAgainstSeed(entry, seed)).toEqual([]);
    }
  });
});

describe("production registry", () => {
  it("has exactly the thirteen AP-12 entries (size 13)", () => {
    expect(registry.size).toBe(13);
    for (const slug of [
      "audio-output",
      "oscillator",
      "vca",
      "attenuverter",
      "mult",
      "mixer",
      "filter",
      "envelope-generator",
      "lfo",
      "noise-source",
      "sample-and-hold",
      "clock",
      "sequencer",
    ]) {
      expect(registry.has(slug)).toBe(true);
    }
  });

  it("audio-output entry uses the canonical audioOutputKernel", () => {
    expect(registry.get("audio-output")?.kernel).toBe(audioOutputKernel);
  });

  it("oscillator entry uses the canonical oscillatorKernel", () => {
    expect(registry.get("oscillator")?.kernel).toBe(oscillatorKernel);
  });

  it("vca entry uses the canonical vcaKernel", () => {
    expect(registry.get("vca")?.kernel).toBe(vcaKernel);
  });

  it("attenuverter entry uses the canonical attenuverterKernel", () => {
    expect(registry.get("attenuverter")?.kernel).toBe(attenuverterKernel);
  });

  it("mult entry uses the canonical multKernel", () => {
    expect(registry.get("mult")?.kernel).toBe(multKernel);
  });

  it("mixer entry uses the canonical mixerKernel", () => {
    expect(registry.get("mixer")?.kernel).toBe(mixerKernel);
  });

  it("filter entry uses the canonical filterKernel", () => {
    expect(registry.get("filter")?.kernel).toBe(filterKernel);
  });

  it("filter Cutoff defaults to its minimum so an untouched knob (fully left) sounds closed", () => {
    const cutoff = registry.get("filter")?.params.Cutoff;
    expect(cutoff?.default).toBe(cutoff?.min);
  });

  it("envelope-generator entry uses the canonical envelopeGeneratorKernel", () => {
    expect(registry.get("envelope-generator")?.kernel).toBe(envelopeGeneratorKernel);
  });

  it("lfo entry uses the canonical lfoKernel", () => {
    expect(registry.get("lfo")?.kernel).toBe(lfoKernel);
  });

  it("noise-source entry uses the canonical noiseSourceKernel", () => {
    expect(registry.get("noise-source")?.kernel).toBe(noiseSourceKernel);
  });

  it("sample-and-hold entry uses the canonical sampleAndHoldKernel", () => {
    expect(registry.get("sample-and-hold")?.kernel).toBe(sampleAndHoldKernel);
  });

  it("clock entry uses the canonical clockKernel", () => {
    expect(registry.get("clock")?.kernel).toBe(clockKernel);
  });

  it("sequencer entry uses the canonical sequencerKernel", () => {
    expect(registry.get("sequencer")?.kernel).toBe(sequencerKernel);
  });

  it("does not contain the deferred noise-random slug", () => {
    expect(registry.has("noise-random")).toBe(false);
  });

  it("does not contain the toy test kernels", () => {
    expect(registry.has("toy-sine")).toBe(false);
    expect(registry.has("toy-gain")).toBe(false);
  });
});

describe("isPlayable", () => {
  it("returns false for null", () => {
    expect(isPlayable(null)).toBe(false);
  });

  it("returns true for all thirteen AP-12 playable slugs", () => {
    for (const slug of [
      "audio-output",
      "oscillator",
      "vca",
      "attenuverter",
      "mult",
      "mixer",
      "filter",
      "envelope-generator",
      "lfo",
      "noise-source",
      "sample-and-hold",
      "clock",
      "sequencer",
    ]) {
      expect(isPlayable(slug)).toBe(true);
    }
  });

  it("returns false for a slug not in the registry", () => {
    expect(isPlayable("toy-sine")).toBe(false);
  });
});
