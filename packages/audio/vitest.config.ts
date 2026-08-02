import { defineConfig } from "vitest/config";

// Node environment, no globals (#287, docs/audio/extraction-plan.md §7): this
// is what enforces the package's "zero browser dependencies" claim at test
// time instead of merely asserting it in a comment -- under web's inherited
// jsdom, a stray `window` reference would still pass.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
  },
});
