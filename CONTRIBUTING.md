# Contributing

Thanks for looking at `patchatlas-audio`. This page is a signpost — the real documentation
lives in [`docs/`](docs).

## Start here

| I want to… | Read |
| --- | --- |
| Understand how the whole thing works | [`docs/architecture.md`](docs/architecture.md) |
| Add a built-in module kernel | [`docs/adding-a-kernel.md`](docs/adding-a-kernel.md) |
| Get signal ranges, pitch, gates and units right | [`docs/signals.md`](docs/signals.md) |
| Know what a kernel PR is reviewed against | [`docs/kernel-checklist.md`](docs/kernel-checklist.md) |
| Use the package as a consumer | [`README.md`](README.md) |

## Setup

```sh
npm ci
```

Node 22+ (CI runs 22). The root package and `examples/playground` are one npm workspace, so a
single `npm ci` at the root installs both.

## Commands

```sh
npm run typecheck   # tsc --noEmit
npm test            # Vitest, Node environment
npm run build       # tsdown + the self-contained-worklet assertion
npm run smoke       # drive the BUILT dist through the package's own exports map
npm run dev         # tsdown --watch
```

Playground (a real consumer of the built package — build the root package first):

```sh
npm run typecheck --workspace=examples/playground
npm run test      --workspace=examples/playground
npm run build     --workspace=examples/playground
npm run serve     --workspace=examples/playground   # then open the printed URL
npm run test:e2e  --workspace=examples/playground   # headless Chromium
```

Before opening a PR, run the full sequence in the order CI runs it
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) — the playground consumes the root
package's built `dist`, so the root build must succeed first:

```sh
npm run typecheck && npm test && npm run build && npm run smoke \
  && npm run typecheck --workspace=examples/playground \
  && npm run test --workspace=examples/playground \
  && npm run build --workspace=examples/playground \
  && npm run test:e2e --workspace=examples/playground
```

## Ground rules

* **No runtime dependencies.** The package ships with an empty dependency tree; keep it that
  way. Build and test tooling is the only thing that belongs in `devDependencies`.
* **`src/index.ts` is the public TypeScript API.** No other module under `src/` is importable
  by consumers. [`src/publicSurface.test.ts`](src/publicSurface.test.ts) snapshots the
  exported names, so any addition or removal has to be deliberate. The package's other public
  artifact is the built `dist/worklet.js`, resolved through the `"./worklet.js"` export — its
  URL is public, its contents and message protocol are not.
* **`process()` must not allocate.** See
  [`docs/kernel-checklist.md`](docs/kernel-checklist.md).
* **The DSP half stays browser-independent.** The compiler, graph logic, `Interpreter` and
  every kernel must run under plain Node with no DOM and no `AudioContext` — that is what
  makes numeric DSP tests possible. Web Audio belongs to exactly two places:
  `src/engine/session.ts` (`AudioContext`, `AudioWorkletNode`) and `src/worklet/`
  (`AudioWorkletProcessor` and its globals). Don't let it leak anywhere else.
* **No host-application coupling.** The package owns its module vocabulary and never reads a
  downstream consumer's assets. [`src/boundary.test.ts`](src/boundary.test.ts) enforces this.
