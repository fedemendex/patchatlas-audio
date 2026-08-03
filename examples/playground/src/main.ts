// patchatlas-audio playground entry point. Imports only the package's public
// API (see boundary.test.ts) -- no internal engine files, no framework.
//
// workletUrl is computed relative to this module's own URL and points at a
// copy of the package's dist/worklet.js placed alongside dist/main.js by
// scripts/copy-assets.mjs at build time -- an explicit exercise of the
// public `workletUrl` override (see the package README) rather than relying
// on the package's own bundled-in default, which would resolve against
// wherever tsdown's bundler happens to inline patchatlas-audio's code.
//
// AudioContext ownership follows the package's contract (docs/architecture.md,
// "Runtime lifecycle"): this file creates and owns the context (resume/close)
// and all routing --
// engine.output.connect(context.destination) and
// engine.output.connect(analyser) both live here, never inside the engine.

import {
  createEngine,
  getModuleDefinitions,
  validate,
  type Diagnostic,
  type Engine,
} from "patchatlas-audio";
import { renderControls } from "./controls";
import { PRESETS, type Preset } from "./presets";
import { startScope } from "./scope";

declare global {
  interface Window {
    // Exposed unconditionally (this is example/demo code, not the production
    // app) so e2e/smoke.spec.ts can read real rendered audio the same way
    // the oscilloscope does, instead of duplicating an analyser.
    __playgroundAnalyser?: AnalyserNode;
  }
}

const workletUrl = new URL("./worklet.js", import.meta.url).href;
const definitions = new Map(getModuleDefinitions().map((d) => [d.slug, d]));

const startBtn = document.querySelector<HTMLButtonElement>("#start-btn")!;
const stopBtn = document.querySelector<HTMLButtonElement>("#stop-btn")!;
const presetSelect = document.querySelector<HTMLSelectElement>("#preset-select")!;
const nowPlayingEl = document.querySelector<HTMLElement>("#now-playing")!;
const descriptionEl = document.querySelector<HTMLElement>("#preset-description")!;
const controlsEl = document.querySelector<HTMLElement>("#controls")!;
const diagnosticsEl = document.querySelector<HTMLUListElement>("#diagnostics")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const scopeCanvas = document.querySelector<HTMLCanvasElement>("#scope")!;

let context: AudioContext | null = null;
let engine: Engine | null = null;
let stopScope: (() => void) | null = null;

for (const preset of PRESETS) {
  const opt = document.createElement("option");
  opt.value = preset.id;
  opt.textContent = preset.title;
  presetSelect.appendChild(opt);
}

function currentPreset(): Preset {
  return PRESETS.find((p) => p.id === presetSelect.value) ?? PRESETS[0];
}

function renderDiagnostics(diagnostics: Diagnostic[]): void {
  diagnosticsEl.replaceChildren();
  if (diagnostics.length === 0) {
    const li = document.createElement("li");
    li.className = "diagnostic-ok";
    li.textContent = "No diagnostics.";
    diagnosticsEl.appendChild(li);
    return;
  }
  for (const d of diagnostics) {
    const li = document.createElement("li");
    li.className = `diagnostic-${d.severity}`;
    li.textContent = `[${d.severity}] ${d.code}: ${d.message}`;
    diagnosticsEl.appendChild(li);
  }
}

function loadPreset(): void {
  const preset = currentPreset();
  nowPlayingEl.textContent = preset.title;
  descriptionEl.textContent = preset.description;
  if (engine) {
    const { diagnostics } = engine.load(preset.patch);
    renderDiagnostics(diagnostics);
    renderControls(controlsEl, preset.patch, engine);
  } else {
    // Before Start, there is no engine to drive controls with -- validate()
    // is pure (no audio, no DOM) and still gives real load diagnostics.
    renderDiagnostics(validate(preset.patch, definitions));
    controlsEl.replaceChildren();
  }
}

presetSelect.addEventListener("change", loadPreset);

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  try {
    if (!context) context = new AudioContext();
    await context.resume(); // the click itself is the user gesture autoplay policy requires

    if (!engine) {
      engine = await createEngine(context, { workletUrl });
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      engine.output.connect(context.destination);
      engine.output.connect(analyser);
      stopScope = startScope(scopeCanvas, analyser);
      window.__playgroundAnalyser = analyser;
    }

    loadPreset();
    engine.start();
    statusEl.textContent = "running";
    stopBtn.disabled = false;
    // startBtn stays disabled while running: engine.start() unconditionally
    // reposts the last-loaded graph (session.ts), and the worklet treats any
    // repost while already playing as a graph swap -- a real preset change
    // should fade like that, but a redundant Start click on an unchanged
    // preset should not audibly restart the voice for no reason.
  } catch (err) {
    statusEl.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", () => {
  engine?.stop();
  statusEl.textContent = "stopped";
  stopBtn.disabled = true;
  startBtn.disabled = false;
});

window.addEventListener("beforeunload", () => {
  stopScope?.();
  engine?.dispose();
  // Ours to close (the engine must never close a context it did not create)
  // -- Stop deliberately leaves the context
  // running so a later Start is instant; page teardown is the actual end of
  // this context's lifetime.
  void context?.close();
});

loadPreset();
