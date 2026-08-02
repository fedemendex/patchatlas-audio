#!/usr/bin/env node
// Built-package smoke test (#287, docs/audio/extraction-plan.md §7):
// consumes only `dist`, through the package's own `exports` map -- via
// self-reference (Node resolves the "patchatlas-audio" specifier against
// this package's own package.json, no workspace symlink required) -- so a
// broken build (missing export, stale dist, an unbundled worklet import)
// fails here even when nothing outside this package has been touched.
//
// The worklet entry point calls `registerProcessor` at import time, so its
// AudioWorkletGlobalScope globals are stubbed exactly as
// src/worklet/engine.worklet.test.ts stubs them for the source file --
// proof that the *built* processor still behaves identically to the source
// one under test.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findUnresolvedImports } from "./verify-worklet-bundle.mjs";

const SR = 48000;
const BLOCK_FRAMES = 128;

class FakeAudioWorkletProcessor {
  port = { onmessage: null, postMessage: () => {} };
}

let ProcessorCtor;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = FakeAudioWorkletProcessor;
globalThis.registerProcessor = (name, ctor) => {
  assert.equal(name, "engine-processor");
  ProcessorCtor = ctor;
};

const indexUrl = await import.meta.resolve("patchatlas-audio");
const workletUrl = await import.meta.resolve("patchatlas-audio/worklet.js");
assert.match(
  fileURLToPath(indexUrl),
  /\/dist\/index\.js$/,
  `"patchatlas-audio" resolved outside dist: ${indexUrl}`,
);
assert.match(
  fileURLToPath(workletUrl),
  /\/dist\/worklet\.js$/,
  `"patchatlas-audio/worklet.js" resolved outside dist: ${workletUrl}`,
);

const worklet = readFileSync(fileURLToPath(workletUrl), "utf-8");
assert.equal(
  findUnresolvedImports(worklet),
  null,
  `dist/worklet.js has an import/require statement -- not a self-contained AudioWorklet bundle`,
);

const { compilePatch, getModuleDefinitions } = await import("patchatlas-audio");
await import("patchatlas-audio/worklet.js");
assert.ok(ProcessorCtor, "dist/worklet.js did not call registerProcessor");

const definitions = new Map(getModuleDefinitions().map((d) => [d.slug, d]));
const patch = {
  modules: [
    { id: "osc", type: "oscillator", params: { Tune: 0 } },
    { id: "out", type: "audio-output" },
  ],
  connections: [
    { from: ["osc", "Sine"], to: ["out", "L In"] },
    { from: ["osc", "Sine"], to: ["out", "R In"] },
  ],
};
const { graph, loaded, diagnostics } = compilePatch(patch, definitions);
assert.equal(loaded, true, `minimal patch failed to compile: ${JSON.stringify(diagnostics)}`);

const proc = new ProcessorCtor();
proc.port.onmessage({ data: { type: "graph", graph } });

let peak = 0;
// A few blocks so the ~30 ms fade-in (engine.worklet.ts's GRAPH_FADE_SECONDS)
// has time to reach steady-state output.
for (let b = 0; b < 20; b++) {
  const left = new Float32Array(BLOCK_FRAMES);
  const right = new Float32Array(BLOCK_FRAMES);
  const alive = proc.process([], [[left, right]], {});
  assert.equal(alive, true);
  for (let i = 0; i < BLOCK_FRAMES; i++) {
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
}
assert.ok(peak > 0.01, `minimal osc -> audio-output patch produced near-silent output (peak ${peak})`);

console.log(`smoke: ok (dist/index.js + dist/worklet.js, peak output ${peak.toFixed(3)})`);
