# Kernel PR Checklist

Apply this checklist to every PR that adds or modifies a module kernel
(`src/modules/**`, `src/engine/**`). It is the enforcement arm of the
roadmap's review checklist (`docs/issues/audio-preview-roadmap.md`) for kernel code
specifically. A kernel PR that fails any line is not mergeable.

## Allocation discipline

- [ ] `process()` allocates nothing — no `new`, no object/array literals, no string building.
- [ ] All state is allocated in `init()` and reused every block.
- [ ] No closures, spreads, object/array literals, or array methods (`map`, `forEach`,
      `slice`, iterator/`for…of` over arrays, …) inside `process()`. Plain indexed loops only.

## Units and constants

- [ ] Every tuning, gate, and normalization constant is imported from
      `src/engine/units.ts` and conforms to `docs/signals.md`.
      No kernel ever writes `261.6256`, `5`, `0.1`, `1`, `10`, `0.001`, or `128` inline.
- [ ] Sample rate comes from `init(sr)` — never a hardcoded `44100`/`48000`.

## Testing

- [ ] A numeric rendering test exists (Vitest, headless): render buffers by calling
      `init` + `process` directly and assert on the numbers (frequency via zero crossings,
      gain ratios, envelope shape, …). "Doesn't throw" is not a test.
- [ ] Jack and param names in the `ModuleDSP` entry are seed **names** verified against
      `seed/generic_modules.json` — the registry-integrity test
      (`src/modules/registry.test.ts`) passes.

## Architecture

- [ ] No native Web Audio node architecture — kernels are pure TypeScript. Native nodes are
      confined to plumbing (one `AudioContext`, one `AudioWorkletNode`, destination) and
      never implement module behavior.
- [ ] Behavior matches `docs/signals.md` (signal ranges, 1 V/oct pitch, Schmitt gate
      thresholds, DAC conversion only in `audio-output`). If the standard is wrong, update
      `signals.md` first — in its own reviewed change — then the kernel.
