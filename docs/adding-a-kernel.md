# Adding a built-in kernel

A practical, end-to-end walkthrough for adding a new module to the package.

## What this is and is not

**Contributors can add built-in kernels to this repository.** A new module is a source file
under `src/modules/`, an entry in `src/modules/registry.ts`, and tests. That is the whole
mechanism.

**Package consumers cannot register third-party kernels at runtime in v1.** There is no
`registerKernel()` and no plugin API. The registry is a closed, code-owned `Map` populated at
module-load time.

`Kernel<S>` and `ModuleDSP` are therefore **internal contributor contracts, not public API**.
They are not exported from [`src/index.ts`](../src/index.ts), and they can change in a patch
release. What *is* public is the kernel-free projection of the registry: `ModuleDefinition`,
`getModuleDefinitions()`, `getModuleDefinition()`, `isPlayable()`.

The package also **owns its module vocabulary** — slugs, jack names, param names and their
specs are defined here and nowhere else. PatchAtlas is a downstream consumer that must conform
to this vocabulary when it upgrades. Never make a change here conditional on a PatchAtlas seed
file; this library must not read, import, or depend on one.

---

## Before you write any code

1. Read [`signals.md`](signals.md) — the normative voltage/signal standard. Signal ranges,
   1 V/oct pitch, gate and trigger conventions, and DAC ownership are all decided there, and
   your kernel must conform. If the standard is wrong for what you are building, change
   `signals.md` **first, in its own reviewed change**, then the kernel.
2. Read [`kernel-checklist.md`](kernel-checklist.md) — the review gate your PR must pass.
3. Skim [`architecture.md`](architecture.md), especially
   [How modules are connected](architecture.md#how-modules-are-connected). The one thing to
   internalise: **names live in the patch and the registry; your kernel only ever sees
   positional arrays.**
4. Read an existing kernel of similar shape. [`vca.ts`](../src/modules/vca.ts) is the smallest
   stateless one; [`lfo.ts`](../src/modules/lfo.ts) is a good small stateful one;
   [`clock.ts`](../src/modules/clock.ts) shows sample-accurate timing.

---

## Step 1 — Create `src/modules/<module>.ts`

One kernel per file, named `<module>Kernel`, exported as a `const`. Start with a header
comment that states the slug and the full positional layout — that comment is how the next
reader maps `ins[2]` back to a jack name, and every existing kernel has one.

The file has three parts, marked **(a)**, **(b)** and **(c)** in the skeleton below: the state
interface, `init(sr)`, and `process(...)`.

```ts
// Sub-octave divider kernel for slug "sub-octave".
// Divides a rising-edge signal down and emits a bipolar square.
//
// Jack/param layout (registry declaration order):
//   ins[0] = In      ins[1] = Rst
//   outs[0] = Out
//   params[0] = Division (positions: /2, /4, /8)

import type { Kernel } from "../engine/kernel";
import {
  CV_BIPOLAR_MAX,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
} from "../engine/units";

// Design constants live next to the kernel; anything that is a *signal
// convention* comes from units.ts instead.
const DEFAULT_DIVISION = 0;

// (a) State: every value that must survive across blocks goes in the state
// interface. Nothing persistent may live in a module-level variable — two
// instances of the same module share the kernel object and would collide.
interface SubOctaveState {
  invSr: number;   // 1 / sr, cached because init() is the only place sr is known
  count: number;   // rising edges seen since the last output flip
  high: boolean;   // current output polarity
  inHigh: boolean; // Schmitt state of the In jack
}

export const subOctaveKernel: Kernel<SubOctaveState> = {
  // (b) init(sr) allocates EVERYTHING, once. Scratch Float32Arrays,
  // delay lines, tables — all of it here, never in process().
  init(sr): SubOctaveState {
    return { invSr: 1 / sr, count: 0, high: false, inHigh: false };
  },

  // (c) process() must not allocate. Plain indexed loops only.
  process(state, ins, outs, params, n) {
    const inSig = ins[0];        // null when the jack is unpatched
    const inRst = ins[1];
    const out = outs[0];

    // Params arrive smoothed, in ENGINE UNITS. Guard non-finite readings
    // with the spec default rather than propagating NaN into the buffer.
    const division = Number.isFinite(params[0]) ? params[0] : DEFAULT_DIVISION;
    const divisor = 1 << (Math.round(division) + 1); // 2, 4, 8

    // Unpatched input: define the behaviour explicitly. Silence here.
    if (inSig === null) {
      for (let i = 0; i < n; i++) out[i] = 0;
      return;
    }

    for (let i = 0; i < n; i++) {
      if (inRst !== null && inRst[i] >= GATE_FIRE_THRESHOLD_V) {
        state.count = 0;
        state.high = false;
      }

      // Non-finite sample data is treated as 0, never propagated.
      const v = Number.isFinite(inSig[i]) ? inSig[i] : 0;
      if (!state.inHigh && v >= GATE_FIRE_THRESHOLD_V) {
        state.inHigh = true;
        if (++state.count >= divisor) {
          state.count = 0;
          state.high = !state.high;
        }
      } else if (state.inHigh && v < GATE_REARM_THRESHOLD_V) {
        state.inHigh = false;
      }

      // (c, cont.) Write EVERY output sample, every block. Buffers are
      // reused across blocks — a skipped sample replays stale audio.
      out[i] = state.high ? CV_BIPOLAR_MAX : -CV_BIPOLAR_MAX;
    }
  },
};
```

### The contracts in that skeleton

| Rule | Why |
| --- | --- |
| **`null` means unpatched.** `ins[i]` is `null` when no cable reaches that jack — it is not a zero buffer. Decide and document what unpatched means for each input (silence, a normalled default, "no effect"). | A `null` dereference on the audio thread is a hard failure with no error path. |
| **Write every output sample, every block.** | Output buffers are allocated once and reused. Anything you skip still holds the previous block's samples. |
| **Never allocate in `process()`.** No `new`, no `{}`/`[]` literals, no closures, no `map`/`forEach`/spread/`for…of` over arrays. Plain indexed loops. | A GC pause inside a 128-sample budget is an audible glitch. |
| **All state in the state interface, allocated in `init(sr)`.** No module-level mutable variables. | Every instance of a module gets its own state object from the same shared kernel object. Module-level state would be shared across instances *and* across graph swaps. |
| **Sample rate comes from `init(sr)`.** Never `44100`/`48000`. | The host owns the `AudioContext` and its rate. Cache `1/sr` in state if you need it per sample. |
| **Engine units, always.** Params reaching you are in Hz, volts, seconds, or switch indices — never a 0..1 knob position. | Curve mapping happens once, on the main thread, in `params.ts`. |
| **Import every signal constant from [`units.ts`](../src/engine/units.ts).** No inline `5`, `10`, `0.1`, `261.6256`, `0.001`, `128`. | One source of truth for the standard in `signals.md`. |
| **Handle non-finite input.** Guard both param reads and sample reads. | A single `NaN` propagates through the rest of the graph and cannot be recovered from downstream. |
| **Never throw.** | There is no error path on the audio thread; a throw takes out the whole renderer. |
| **Gates and triggers use Schmitt thresholds.** Fire at `GATE_FIRE_THRESHOLD_V`, re-arm below `GATE_REARM_THRESHOLD_V`. Triggers are `TRIGGER_SECONDS` long at `GATE_HIGH_V`. | Consistency across modules is the whole point of the standard — see `signals.md`. |
| **No DAC conversion, no output soft clipping.** Work in the virtual-voltage domain. | Normalization to ±1.0 and DC blocking belong to `audio-output` alone. |
| **No wall-clock timers.** All musical time is counted in samples. | `setTimeout` and friends do not exist meaningfully on the audio thread, and would drift. |

---

## Step 2 — Register it in `src/modules/registry.ts`

Import the kernel at the top of the file, then add an entry to the `registry` map:

```ts
import { subOctaveKernel } from "./subOctave";

// …inside the registry Map:
  [
    "sub-octave",
    {
      slug: "sub-octave",
      kernel: subOctaveKernel,
      inJacks: ["In", "Rst"],
      outJacks: ["Out"],
      params: {
        Division: {
          min: 0,
          max: 2,
          default: 0,
          curve: "positions",
          positions: ["/2", "/4", "/8"],
        },
      },
    },
  ],
```

### Declaration order **is** the wire protocol

This is the single most important thing to get right:

* `inJacks[k]` is `ins[k]` in `process()`.
* `outJacks[k]` is `outs[k]`.
* **`Object.keys(params)` order** — i.e. the order you typed the keys — is `params[k]`.

`resolvePatch` maps a cable's jack *name* to a slot with `indexOf`, and the interpreter
allocates one buffer per slot in exactly this order. Reordering an existing module's arrays or
param keys silently rewires every patch already in the wild. Adding a new jack or param at the
**end** is the only append-safe change.

Two optional fields:

* `audioOutput: { channels: 1 | 2 }` — the module terminates the graph into the DAC domain.
  Its channel buffers are appended *after* its patchable out jacks, and the compiler records
  its node index in `EngineGraph.outputNodes`. Only `audio-output` uses this.
* `reportsStep: true` — the kernel's state carries a numeric `step` field that the interpreter
  reads for UI telemetry. It never affects audio. Only the sequencers use this.
* `reportsGates: true` — the kernel's state carries a numeric `gates` bitmask (bit `k` set
  while `outJacks[k]` is high) that the interpreter reads for a host's per-output indicator
  LEDs. Same throttled channel shape as `reportsStep`, and likewise never affects audio; a
  module reporting gates is responsible for holding a bit long enough to outlast the host's
  poll interval, since telemetry is sampled at ~33 Hz and a trigger can be far shorter than
  that. Limited to the low 31 bits. Only `clock-divider-2` uses this.
* `limitations` — declares jacks/controls that exist in a host's UI but produce no audible
  effect in this engine, so a host can badge them. Every currently registered module is
  complete and omits this field; only add it if you are deliberately shipping a partial module.

---

## Step 3 — Add numeric DSP tests in `src/modules/<module>.test.ts`

Call `init` and `process` directly and assert on the numbers. **"Doesn't throw" is not a
test.** Kernels and the interpreter are browser-independent, so this runs headlessly under
Vitest in Node — no `AudioContext`, no DOM, no mocking.

```ts
import { describe, expect, it } from "vitest";
import { subOctaveKernel } from "./subOctave";
import { CV_BIPOLAR_MAX, GATE_HIGH_V } from "../engine/units";

const SR = 48000;
const N = 128;

describe("subOctave kernel", () => {
  it("flips polarity once every two rising edges at /2", () => {
    const state = subOctaveKernel.init(SR);
    const clock = new Float32Array(N);
    for (const i of [0, 8, 16, 24]) clock[i] = GATE_HIGH_V; // one-sample pulses
    const outs = [new Float32Array(N)];

    subOctaveKernel.process(state, [clock, null], outs, Float32Array.from([0]), N);

    expect(outs[0][0]).toBe(-CV_BIPOLAR_MAX); // 1st edge: count 1 of 2, no flip
    expect(outs[0][8]).toBe(CV_BIPOLAR_MAX); // 2nd edge flips high
    expect(outs[0][16]).toBe(CV_BIPOLAR_MAX); // 3rd edge: count 1 of 2 again
    expect(outs[0][24]).toBe(-CV_BIPOLAR_MAX); // 4th edge flips back
  });

  it("outputs silence when In is unpatched", () => {
    const state = subOctaveKernel.init(SR);
    const outs = [new Float32Array(N).fill(1)];
    subOctaveKernel.process(state, [null, null], outs, Float32Array.from([0]), N);
    expect([...outs[0]]).toEqual(Array(N).fill(0));
  });
});
```

Cover at minimum:

* the module's defining numeric behaviour (frequency via zero crossings, gain ratios, envelope
  shape, division counts, threshold positions — whatever it *is*);
* every input being `null` (unpatched);
* non-finite param values and non-finite input samples;
* every switch position and both ends of every continuous param range;
* state continuity across two consecutive `process()` calls, if the module is stateful;
* determinism, if the module is expected to be deterministic.

---

## Step 4 — Update registry and definition tests

Both of these assert exact counts and will fail until you update them:

* [`src/modules/registry.test.ts`](../src/modules/registry.test.ts) — bump the registry size
  assertion, add your slug to the expected-slug list, and add a
  `expect(registry.get("sub-octave")?.kernel).toBe(subOctaveKernel)` case. If a param default
  encodes a product decision (an untouched knob should sound closed, a switch should rest on
  a particular position), assert that too — several entries already do.
* [`src/modules/definitions.test.ts`](../src/modules/definitions.test.ts) — bump the
  definition count. If you set `audioOutput`, `reportsStep`, `reportsGates` or `limitations`,
  update the tests that assert exactly which slugs carry each of those fields.

You should **not** need to touch [`src/index.ts`](../src/index.ts) or
[`src/publicSurface.test.ts`](../src/publicSurface.test.ts). A new module changes the *data*
returned by `getModuleDefinitions()`, not the public surface. If you find yourself wanting to
export something new, that is a public-API change and needs its own discussion.

---

## Step 5 — Update `signals.md` if you introduced new semantics

If your module defines behaviour the standard does not yet cover — a new modulation
convention, a new response curve, a new timing rule — add it to
[`signals.md`](signals.md) as part of the same work, and import any new constant from
[`units.ts`](../src/engine/units.ts) rather than inlining it. A kernel whose behaviour is not
described in `signals.md` is not finished.

---

## Step 6 — Verify

Run all of these from the repository root:

```sh
npm run typecheck
npm test
npm run build
npm run smoke
npm run build --workspace=examples/playground
npm run test --workspace=examples/playground
npm run test:e2e --workspace=examples/playground
```

`npm test` also runs the boundary test
([`src/boundary.test.ts`](../src/boundary.test.ts)), which fails if anything under `engine/`,
`modules/` or `worklet/` imports outside that boundary. Your kernel may import from
`../engine/*` and from sibling files under `modules/` — never from anything outside those
directories, and never a third-party package.

To hear it, add a preset to `examples/playground/src/presets.ts` and run the playground —
that is the fastest path from "the numbers look right" to "it sounds right".

---

## Checklist

Before opening the PR, walk [`kernel-checklist.md`](kernel-checklist.md) line by line. A
kernel PR that fails any line of it is not mergeable.
