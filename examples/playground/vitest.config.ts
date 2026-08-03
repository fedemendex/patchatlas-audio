import { configDefaults, defineConfig } from "vitest/config";

// Node environment: the boundary test walks source text on disk, it never
// touches a browser API (mirrors the root package's vitest.config.ts).
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // e2e/ is Playwright's (npm run test:e2e), not Vitest's.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
