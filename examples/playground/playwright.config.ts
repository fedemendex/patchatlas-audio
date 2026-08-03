// Playwright config for the playground's headless smoke test: an RMS probe on
// a real AnalyserNode, driving the built package (dist/patchatlas-audio.js +
// dist/worklet.js) through the built playground (dist/main.js). webServer
// always rebuilds first so every invocation tests a fresh dist/, never a
// stale one.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    ...devices["Desktop Chrome"],
    launchOptions: {
      // The test clicks Start (a real user gesture), so this flag is
      // belt-and-braces against headless autoplay policy blocking
      // AudioContext.resume() before the click registers as an activation.
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
  },
  webServer: {
    command: "npm run build && node scripts/serve.mjs",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
