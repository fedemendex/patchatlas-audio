import { defineConfig } from "tsdown";

// One entry, bundled: the playground is a single static page, so main.ts and
// everything it imports (including patchatlas-audio's dist/index.js) lands in
// one dist/main.js. This still consumes only the package's built `dist`
// (never src) through its public entry point -- tsdown resolves the
// "patchatlas-audio" specifier via the workspace symlink in node_modules,
// which points at the repository root, whose own package.json `exports` map
// resolves "." to ./dist/index.js.
//
// The AudioWorklet bundle (dist/worklet.js) is never imported here -- it is
// copied byte-for-byte alongside dist/main.js by scripts/copy-assets.mjs and
// loaded at runtime via an explicit `workletUrl` (see src/main.ts), which is
// also what exercises the public `workletUrl` override documented in the
// package README.
export default defineConfig({
  entry: "src/main.ts",
  format: "esm",
  platform: "browser",
  dts: false,
  clean: true,
});
