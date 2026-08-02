import { defineConfig } from "tsdown";

// Two independent build configs, not two entries on one config (#287,
// docs/audio/extraction-plan.md §7/§3). A single multi-entry config lets
// rolldown factor shared code (compilePatch, registry, ...) into a common
// chunk imported by both outputs -- fine for dist/index.js, fatal for
// dist/worklet.js, which must be one fully self-contained file: `import`
// inside an AudioWorklet script isn't reliably supported outside Chromium.
// Separate configs guarantee no chunk is ever shared between the two.
export default defineConfig([
  {
    entry: "src/index.ts",
    format: "esm",
    platform: "neutral",
    dts: true,
    clean: true,
  },
  {
    entry: "src/worklet.ts",
    format: "esm",
    platform: "neutral",
    dts: false,
    clean: false,
  },
]);
