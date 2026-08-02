# Architecture

How a `Patch` becomes sound: compile → interpret → worklet. This is implementation detail —
none of the types or classes named below are exported (see `src/index.ts` / the package
[README](../README.md) for the actual public surface) — but understanding the pipeline helps
when reading kernel source or debugging a patch that won't load.

## 1. Compile: `Patch` → `EngineGraph`

A [`Patch`](../src/engine/patch.ts) is plain, name-addressed JSON: modules have a caller-chosen
`id` and a registry `type` slug; connections reference `[moduleId, jackName]` pairs, with
direction implied by position (`from` is always an out-jack, `to` an in-jack).

[`resolvePatch`](../src/engine/diagnostics.ts) resolves that against the module registry —
matching each module's `type` to its jack/param shape, each connection's jack names to real
slots — producing a `Diagnostic[]` for anything it has to drop (unknown module type, unknown
jack, a jack used backwards, ...) alongside the resolved node and edge data.
[`compilePatch`](../src/engine/compile.ts) takes that resolution and shapes it into an
[`EngineGraph`](../src/engine/graph.ts): a deterministic node order plus numeric `[nodeIndex,
slot]` edges, ready for the interpreter.

Node order is not insertion order. Nodes are condensed into strongly connected components
(Tarjan), the component DAG is topologically sorted (Kahn's algorithm, ties broken by the
smallest module id in a component), and a cyclic component's members are ordered by DFS
preorder from its smallest id. This is what makes an edge's `feedback` flag well-defined: an
edge is `feedback: true` exactly when its destination's index is `<=` its source's index in
this order — including a self-loop, where source and destination are the same node (see the
playground's `feedback` preset). `validate()` and `compilePatch()` share `resolvePatch()` so
the two can never disagree about what a given `Patch` means; `validate()` just discards the
graph-shaping pieces and returns the diagnostics.

## 2. Interpret: the pure engine

[`Interpreter`](../src/engine/interpreter.ts) has zero browser dependencies — it is plain
TypeScript, exercised directly by Vitest, and the worklet (below) is a thin shell over it. Its
constructor does all the allocation: one kernel state per node (`kernel.init(sr)`), one output
buffer per patchable jack, fan-in mix buffers for jacks with more than one incoming connection,
and — for every out jack that sources at least one feedback edge — a double buffer (`pairA` /
`pairB`).

### The one-block feedback model

Feedback edges read the *previous* render block, never the current one. Each feedback-sourcing
jack's double buffer has a "front" side (written this block, the true current output) and a
"back" side (what was written last block); a `flip` bit toggles at the end of every
`runBlock()`, and precomputed reference lists repoint every consumer to the correct side —
reference swaps, never buffer copies. Non-feedback consumers always read the front side;
feedback consumers always read the back side, regardless of where producer and consumer land
in processing order. The very first block's feedback reads silence (the back buffer starts
zeroed), so a cyclic patch fades in from nothing rather than reading garbage.

The delay this introduces is exactly one render block — `BLOCK_FRAMES` samples (128, the Web
Audio render quantum) in the worklet, since the worklet always calls `runBlock(128)`. At a
48 kHz sample rate that is ~2.7 ms: inaudible as *latency* in the usual sense, but audible as
*character* — a self-modulated oscillator (see the playground's `feedback` preset) does not
behave like an idealized zero-delay analog feedback loop; the one-block delay is part of the
sound.

`runBlock(n)` itself: for each node in order, fill its fan-in mix buffers (summing all current
source refs — by this point every non-feedback source earlier in the order has already run),
advance its params one step toward their smoothed targets, then call the kernel's `process()`.
`readOutput(left, right, n)` sums every `audio-output` node's internal DAC-domain buffers into
the two output channels — mono `audio-output` instances feed both.

## 3. Worklet: the thin host

[`EngineProcessor`](../src/worklet/engine.worklet.ts) never sees a `Patch` — compiled
`EngineGraph`s arrive whole over `postMessage` from the main thread (`createEngine` in
[`src/engine/session.ts`](../src/engine/session.ts) does the compiling). It holds up to two
`Interpreter`s at once: `current` (what's audible) and `pending` (a graph swap in flight).

A new graph while nothing is loaded becomes `current` immediately, fading in from silence. A
new graph while something is already `current` becomes `pending`: output gain ramps to 0 over
~30 ms, then `current` is replaced and gain ramps back to 1. **Voices restart on every swap —
there is no state carry-over between interpreters.** This is a deliberate product decision: a
graph swap (e.g. changing a preset, as the playground's preset selector does) is a clean
transition, not an attempt to preserve running envelope/LFO/sequencer phase. `stop()` cuts
instantly with no fade — safe because the node is disconnected around that message, so the cut
is inaudible regardless.

Sequencer-style modules (`ModuleDSP.reportsStep`) report their current step on a throttled
(~33 Hz), allocation-free `postMessage` channel purely for UI telemetry (e.g. a step
indicator); it has no effect on audio and reuses the same message object every tick.

## The allocation-free `process()` contract

Every kernel implements [`Kernel<S>`](../src/engine/kernel.ts): `init(sr)` allocates *all* of
that kernel's state, once; `process(state, ins, outs, params, n)` runs every block and **must
not allocate** — no `new`, no object or array literals, no closures, no array methods
(`map`/`forEach`/spread/iteration), only plain indexed loops. `Interpreter.runBlock` and
`readOutput` hold themselves to the same discipline in their own hot paths.

This exists because `process()` runs on the browser's real-time audio thread: an allocation
there risks a GC pause landing inside your 128-sample budget, which is an audible glitch, not
a slow frame. It is enforced by review, not the type system —
[`docs/kernel-checklist.md`](kernel-checklist.md) is the checklist every kernel PR is held to,
and it is the first thing to read before touching kernel code.
