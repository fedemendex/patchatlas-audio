# patchatlas-audio playground

A small, framework-free demo of [`patchatlas-audio`](../../packages/audio)'s public API. Every
import in `src/` resolves to the bare `"patchatlas-audio"` specifier (enforced by
`src/boundary.test.ts`) and the build consumes only the package's built `dist`, never its
TypeScript sources.

## Run it

```sh
npm run build --workspace=examples/playground
npm run serve --workspace=examples/playground   # http://127.0.0.1:4174
```

`npm run build` requires `packages/audio/dist` to exist first (`npm run build
--workspace=packages/audio`).

**Requires a real HTTP(S) origin — `dist/index.html` will not work if opened directly via a
`file://` URL.** This isn't a bug in the build: Chromium (and other browsers) refuse to fetch
an ES module script, or run `AudioContext.audioWorklet.addModule()`, from a `file://` origin —
both hit the browser's same-origin/CORS policy regardless of how the output is bundled. Any
static file server works — `npm run serve` above, `npx serve dist`, `python3 -m http.server`
from `dist/`, or a GitHub Pages deployment.

## Develop

* `npm run typecheck --workspace=examples/playground`
* `npm run test --workspace=examples/playground` — the import-boundary test (Vitest)
* `npm run test:e2e --workspace=examples/playground` — headless Playwright smoke test; builds
  and serves `dist/` itself, then asserts every bundled preset renders non-silent audio

## How the build resolves `patchatlas-audio`

`tsdown` (via rolldown) treats `patchatlas-audio` as an external dependency rather than
bundling it in, so `dist/main.js` keeps a bare `import ... from "patchatlas-audio"` a browser
can't resolve on its own. `scripts/copy-assets.mjs` copies the package's own built
`dist/index.js` alongside `dist/main.js`, and `static/index.html` declares an import map
pointing the specifier at that copy — so the browser loads exactly the artifact npm's
`exports` map would hand any other bundler, unmodified. The same script copies
`dist/worklet.js`, and `src/main.ts` points `createEngine`'s `workletUrl` option at it
explicitly, exercising the public override documented in the package README rather than
relying on the package's own bundled-in default.
