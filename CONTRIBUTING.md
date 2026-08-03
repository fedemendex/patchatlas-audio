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
* **`src/index.ts` is the public surface.** Everything else is internal.
  [`src/publicSurface.test.ts`](src/publicSurface.test.ts) snapshots it, so any addition or
  removal has to be deliberate.
* **`process()` must not allocate.** See
  [`docs/kernel-checklist.md`](docs/kernel-checklist.md).
* **The engine stays browser-free.** Tests run in a Node environment with no DOM; nothing
  under `src/engine/` or `src/modules/` may touch a browser API.
* **No host-application coupling.** The package owns its module vocabulary and never reads a
  downstream consumer's assets. [`src/boundary.test.ts`](src/boundary.test.ts) enforces this.
