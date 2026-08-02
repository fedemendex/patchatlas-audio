import { describe, it, expect } from "vitest";
import { registry, isPlayable } from "./registry";
import { audioOutputKernel } from "./audioOutput";
import { oscillatorKernel } from "./oscillator";
import { vcaKernel } from "./vca";
import { attenuverterKernel } from "./attenuverter";
import { multKernel } from "./mult";
import { mixerKernel } from "./mixer";
import { crossfaderKernel } from "./crossfader";
import { filterKernel } from "./filter";
import { envelopeGeneratorKernel } from "./envelopeGenerator";
import { functionGeneratorKernel } from "./functionGenerator";
import { lfoKernel } from "./lfo";
import { noiseSourceKernel } from "./noiseSource";
import { sampleAndHoldKernel } from "./sampleAndHold";
import { clockKernel } from "./clock";
import { sequencerKernel } from "./sequencer";
import { triggerSequencerKernel } from "./triggerSequencer";
import { ringModKernel } from "./ringMod";
import { lowPassGateKernel } from "./lowPassGate";
import { reverbKernel } from "./reverb";
import { wavefolderKernel } from "./wavefolder";
import { sequentialSwitch1ToNKernel } from "./sequentialSwitch1ToN";
import { sequentialSwitchNTo1Kernel } from "./sequentialSwitchNTo1";
import { quantizerKernel } from "./quantizer";
import { logicKernel } from "./logic";
import { slewLimiterKernel } from "./slewLimiter";
import { comparatorKernel } from "./comparator";

// Seed-integrity checking moved out to web/src/audio/seedConformance.test.ts
// (#286): the package itself must not read a PatchAtlas asset, so this file
// only asserts the registry's own internal shape (kernel bindings, defaults,
// limitations metadata) — never the seed.

describe("production registry", () => {
  it("has exactly the twenty-six registered entries (size 26)", () => {
    expect(registry.size).toBe(26);
    for (const slug of [
      "audio-output",
      "oscillator",
      "vca",
      "attenuverter",
      "mult",
      "mixer",
      "crossfader",
      "filter",
      "envelope-generator",
      "function-generator",
      "lfo",
      "noise-source",
      "sample-and-hold",
      "clock",
      "sequencer",
      "trigger-sequencer",
      "ring-modulator",
      "low-pass-gate",
      "reverb",
      "wavefolder",
      "sequential-switch-1-to-n",
      "sequential-switch-n-to-1",
      "quantizer",
      "logic",
      "slew-limiter",
      "comparator",
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

  it("crossfader entry uses the canonical crossfaderKernel", () => {
    expect(registry.get("crossfader")?.kernel).toBe(crossfaderKernel);
  });

  it("filter Cutoff defaults to its minimum so an untouched knob (fully left) sounds closed", () => {
    const cutoff = registry.get("filter")?.params.Cutoff;
    expect(cutoff?.default).toBe(cutoff?.min);
  });

  it("envelope-generator entry uses the canonical envelopeGeneratorKernel", () => {
    expect(registry.get("envelope-generator")?.kernel).toBe(envelopeGeneratorKernel);
  });

  it("function-generator entry uses the canonical functionGeneratorKernel", () => {
    expect(registry.get("function-generator")?.kernel).toBe(functionGeneratorKernel);
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

  it("trigger-sequencer entry uses the canonical triggerSequencerKernel", () => {
    expect(registry.get("trigger-sequencer")?.kernel).toBe(triggerSequencerKernel);
  });

  it("ring-modulator entry uses the canonical ringModKernel", () => {
    expect(registry.get("ring-modulator")?.kernel).toBe(ringModKernel);
  });

  it("low-pass-gate entry uses the canonical lowPassGateKernel", () => {
    expect(registry.get("low-pass-gate")?.kernel).toBe(lowPassGateKernel);
  });

  it("reverb entry uses the canonical reverbKernel", () => {
    expect(registry.get("reverb")?.kernel).toBe(reverbKernel);
  });

  it("reverb Preset defaults to Room (position 0) with exactly Room/Hall/Plate", () => {
    const preset = registry.get("reverb")?.params.Preset;
    expect(preset?.curve).toBe("positions");
    expect(preset?.positions).toEqual(["Room", "Hall", "Plate"]);
    expect(preset?.default).toBe(0);
  });

  it("wavefolder entry uses the canonical wavefolderKernel", () => {
    expect(registry.get("wavefolder")?.kernel).toBe(wavefolderKernel);
  });

  it("wavefolder Fold defaults to its minimum so an untouched knob passes through unfolded", () => {
    const fold = registry.get("wavefolder")?.params.Fold;
    expect(fold?.default).toBe(fold?.min);
  });

  it("sequential-switch-1-to-n entry uses the canonical sequentialSwitch1ToNKernel", () => {
    expect(registry.get("sequential-switch-1-to-n")?.kernel).toBe(sequentialSwitch1ToNKernel);
  });

  it("sequential-switch-1-to-n Steps defaults to its maximum so an untouched knob rotates through all 4 outputs", () => {
    const steps = registry.get("sequential-switch-1-to-n")?.params.Steps;
    expect(steps?.default).toBe(steps?.max);
  });

  it("sequential-switch-n-to-1 entry uses the canonical sequentialSwitchNTo1Kernel", () => {
    expect(registry.get("sequential-switch-n-to-1")?.kernel).toBe(sequentialSwitchNTo1Kernel);
  });

  it("sequential-switch-n-to-1 Steps defaults to its maximum so an untouched knob rotates through all 4 inputs", () => {
    const steps = registry.get("sequential-switch-n-to-1")?.params.Steps;
    expect(steps?.default).toBe(steps?.max);
  });

  it("quantizer entry uses the canonical quantizerKernel", () => {
    expect(registry.get("quantizer")?.kernel).toBe(quantizerKernel);
  });

  it("quantizer Scale defaults to Chrom (position 0) with exactly the five expected positions", () => {
    const scale = registry.get("quantizer")?.params.Scale;
    expect(scale?.curve).toBe("positions");
    expect(scale?.positions).toEqual(["Chrom", "Maj", "Min", "Pent", "Harm Min"]);
    expect(scale?.default).toBe(0);
  });

  it("logic entry uses the canonical logicKernel", () => {
    expect(registry.get("logic")?.kernel).toBe(logicKernel);
  });

  it("logic has no controls (In 1/In 2/Clock inputs, AND/OR/XOR/NOR/FF outputs)", () => {
    const entry = registry.get("logic");
    expect(entry?.inJacks).toEqual(["In 1", "In 2", "Clock"]);
    expect(entry?.outJacks).toEqual(["AND", "OR", "XOR", "NOR", "FF"]);
    expect(Object.keys(entry?.params ?? {})).toEqual([]);
  });

  it("slew-limiter entry uses the canonical slewLimiterKernel", () => {
    expect(registry.get("slew-limiter")?.kernel).toBe(slewLimiterKernel);
  });

  it("slew-limiter Rise/Fall default to 0 (bypass), so an untouched knob is a true passthrough", () => {
    const entry = registry.get("slew-limiter");
    expect(entry?.params.Rise).toEqual({ min: 0, max: 1, default: 0, curve: "linear" });
    expect(entry?.params.Fall).toEqual({ min: 0, max: 1, default: 0, curve: "linear" });
  });

  it("comparator entry uses the canonical comparatorKernel", () => {
    expect(registry.get("comparator")?.kernel).toBe(comparatorKernel);
  });

  it("comparator has the redesigned + In/− In/Offset CV inputs and Gate/Inv Gate/Sum outputs", () => {
    const entry = registry.get("comparator");
    expect(entry?.inJacks).toEqual(["+ In", "− In", "Offset CV"]);
    expect(entry?.outJacks).toEqual(["Gate", "Inv Gate", "Sum"]);
    expect(Object.keys(entry?.params ?? {})).toEqual(["Offset", "+ Level", "− Level", "Gap"]);
  });

  it("comparator + Level/− Level default to 1 (unity), Offset defaults to 0 (bipolar), Gap defaults to 0 (no hysteresis)", () => {
    const entry = registry.get("comparator");
    expect(entry?.params["+ Level"]).toEqual({ min: 0, max: 1, default: 1, curve: "linear" });
    expect(entry?.params["− Level"]).toEqual({ min: 0, max: 1, default: 1, curve: "linear" });
    expect(entry?.params.Offset).toEqual({ min: -5, max: 5, default: 0, curve: "linear" });
    expect(entry?.params.Gap).toEqual({ min: 0, max: 10, default: 0, curve: "linear" });
  });

  it("does not contain the deferred noise-random slug", () => {
    expect(registry.has("noise-random")).toBe(false);
  });

  it("does not contain the toy test kernels", () => {
    expect(registry.has("toy-sine")).toBe(false);
    expect(registry.has("toy-gain")).toBe(false);
  });
});

describe("limitations metadata (renamed from `preview` in #286)", () => {
  it("sequencer is fully previewed — Dir/Sel wired, no limitations block", () => {
    const entry = registry.get("sequencer");
    expect(entry?.inJacks).toEqual(["Clk", "Rst", "Dir", "Sel"]);
    expect(entry?.limitations).toBeUndefined();
  });

  it("clock is fully previewed — Ext Clk wired, Swing param present, no limitations block", () => {
    const entry = registry.get("clock");
    expect(entry?.inJacks).toEqual(["Ext Clk", "Run", "Rst"]);
    expect(Object.keys(entry?.params ?? {})).toEqual(["Tempo", "Swing"]);
    expect(entry?.limitations).toBeUndefined();
  });

  it("trigger-sequencer is fully previewed — Clk/Rst/CV wired, S1..S8/EOC/Trig/Gate outputs, no limitations block", () => {
    const entry = registry.get("trigger-sequencer");
    expect(entry?.inJacks).toEqual(["Clk", "Rst", "CV"]);
    expect(entry?.outJacks).toEqual([
      "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "EOC", "Trig", "Gate",
    ]);
    expect(entry?.limitations).toBeUndefined();
  });

  it("noise-source is fully previewed — White, Pink, Red, Blue all implemented, no limitations block", () => {
    expect(registry.get("noise-source")?.limitations).toBeUndefined();
  });

  it("sequential-switch-1-to-n is fully previewed — In/Clk/Rst/Sel wired, Out 1..4 outputs, no limitations block", () => {
    const entry = registry.get("sequential-switch-1-to-n");
    expect(entry?.inJacks).toEqual(["In", "Clk", "Rst", "Sel"]);
    expect(entry?.outJacks).toEqual(["Out 1", "Out 2", "Out 3", "Out 4"]);
    expect(entry?.limitations).toBeUndefined();
  });

  it("sequential-switch-n-to-1 is fully previewed — In 1..4/Clk/Rst/Sel wired, single Out, no limitations block", () => {
    const entry = registry.get("sequential-switch-n-to-1");
    expect(entry?.inJacks).toEqual(["In 1", "In 2", "In 3", "In 4", "Clk", "Rst", "Sel"]);
    expect(entry?.outJacks).toEqual(["Out"]);
    expect(entry?.limitations).toBeUndefined();
  });

  it("leaves fully-previewed modules without a limitations block", () => {
    for (const slug of ["audio-output", "oscillator", "vca", "attenuverter", "mult", "mixer", "crossfader", "filter", "envelope-generator", "function-generator", "lfo", "sample-and-hold", "clock", "noise-source", "sequencer", "trigger-sequencer", "ring-modulator", "low-pass-gate", "reverb", "wavefolder", "sequential-switch-1-to-n", "sequential-switch-n-to-1", "quantizer", "logic", "slew-limiter", "comparator"]) {
      expect(registry.get(slug)?.limitations).toBeUndefined();
    }
  });

  it("no registered module currently declares partial-limitations metadata", () => {
    for (const [, entry] of registry) {
      expect(entry.limitations).toBeUndefined();
    }
  });
});

describe("isPlayable", () => {
  it("returns false for null", () => {
    expect(isPlayable(null)).toBe(false);
  });

  it("returns true for all twenty-six registered playable slugs", () => {
    for (const slug of [
      "audio-output",
      "oscillator",
      "vca",
      "attenuverter",
      "mult",
      "mixer",
      "crossfader",
      "filter",
      "envelope-generator",
      "function-generator",
      "lfo",
      "noise-source",
      "sample-and-hold",
      "clock",
      "sequencer",
      "trigger-sequencer",
      "ring-modulator",
      "low-pass-gate",
      "reverb",
      "wavefolder",
      "sequential-switch-1-to-n",
      "sequential-switch-n-to-1",
      "quantizer",
      "logic",
      "slew-limiter",
      "comparator",
    ]) {
      expect(isPlayable(slug)).toBe(true);
    }
  });

  it("returns false for a slug not in the registry", () => {
    expect(isPlayable("toy-sine")).toBe(false);
  });
});
