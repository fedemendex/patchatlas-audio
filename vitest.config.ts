import { configDefaults, defineConfig } from "vitest/config";

// Node environment, no globals: this is what enforces the package's "zero
// browser dependencies" claim at test time instead of merely asserting it in
// a comment -- under jsdom, a stray `window` reference would still pass.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // examples/playground is its own npm workspace with its own vitest.config.ts
    // and test script (npm run test --workspace=examples/playground); the root
    // package's `npm test` must stay scoped to this package's own src/.
    exclude: [...configDefaults.exclude, "examples/**"],
  },
});
