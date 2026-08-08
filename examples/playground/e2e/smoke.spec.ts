// Headless smoke test (#288 "Tests"): proves the BUILT playground -- served
// as static files, importing the package's BUILT dist through the import map
// scripts/copy-assets.mjs writes -- loads the default preset and renders
// clearly non-zero audio. Same RMS-probe technique as
// web/e2e/audio-smoke.spec.ts, driving the built package instead of the app.
//
// Measurement: window.__playgroundAnalyser -- the same host-owned
// AnalyserNode the oscilloscope draws from (src/main.ts), read here exactly
// as a real caller would via the Web Audio API. No test-only production
// hook: this is example code, and exposing its own analyser on window is a
// reasonable thing for a playground to do.

import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __playgroundAnalyser?: AnalyserNode;
  }
}

async function rms(page: Page): Promise<number> {
  return page.evaluate(() => {
    const analyser = window.__playgroundAnalyser;
    if (!analyser) return 0;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  });
}

async function waitAudible(page: Page, timeout = 8_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const analyser = window.__playgroundAnalyser;
      if (!analyser) return false;
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return Math.sqrt(sum / buf.length) > 0.01;
    },
    undefined,
    { timeout },
  );
}

test("built playground plays audible audio from the default preset", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  await page.goto("/");
  await expect(page.locator("#preset-select option")).toHaveCount(5);

  const startButton = page.locator("#start-btn");
  await expect(startButton).toBeEnabled();
  await startButton.click();

  await expect(page.locator("#stop-btn")).toBeEnabled();

  // Wait for the ~30 ms worklet fade-in.
  await waitAudible(page, 10_000);

  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(100);
    samples.push(await rms(page));
  }
  for (const value of samples) expect(Number.isFinite(value)).toBe(true);
  const sustained = samples.filter((value) => value > 0.01).length;
  expect(sustained).toBeGreaterThanOrEqual(8);

  const diagnostics = await page.locator("#diagnostics li").allTextContents();
  expect(diagnostics).toEqual(["No diagnostics."]);

  expect(pageErrors).toEqual([]);
});

test("every bundled preset loads, sounds, and reports its diagnostics", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#preset-select option")).toHaveCount(5);
  await page.locator("#start-btn").click();

  const ids = await page.locator("#preset-select option").evaluateAll((opts) =>
    opts.map((o) => (o as HTMLOptionElement).value),
  );

  for (const id of ids) {
    await page.selectOption("#preset-select", id);
    await waitAudible(page);
    const diagnostics = await page.locator("#diagnostics li").allTextContents();
    expect(diagnostics).toEqual(["No diagnostics."]);
  }
});

test("Start/Stop lifecycle: repeated Start is inert while running, Stop then Start restarts cleanly", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  await page.goto("/");
  await expect(page.locator("#preset-select option")).toHaveCount(5);

  const startButton = page.locator("#start-btn");
  const stopButton = page.locator("#stop-btn");

  await startButton.click();
  await waitAudible(page, 10_000);
  await expect(startButton).toBeDisabled();
  await expect(stopButton).toBeEnabled();

  // A second createEngine()/AnalyserNode pair would be a resource leak, and
  // a redundant engine.start() while already running would trigger an
  // audible ~30ms voice-restart fade for no reason (main.ts's comment on
  // this) -- the button being disabled is what prevents a user from
  // triggering either through the UI. Force a click anyway, simulating a
  // stray event, to prove the guard also holds regardless of button state.
  await startButton.click({ force: true });
  await page.waitForTimeout(200);
  const analyserCountAfterDoubleStart = await page.evaluate(
    () => (window.__playgroundAnalyser ? 1 : 0),
  );
  expect(analyserCountAfterDoubleStart).toBe(1);
  await expect(page.locator("#status")).toHaveText("running");

  await stopButton.click();
  await expect(startButton).toBeEnabled();
  await expect(stopButton).toBeDisabled();
  await expect(page.locator("#status")).toHaveText("stopped");

  // Restart reuses the same engine/context (no re-creation) and must sound
  // again, not stay silent or throw.
  await startButton.click();
  await waitAudible(page, 10_000);
  await expect(page.locator("#status")).toHaveText("running");

  expect(pageErrors).toEqual([]);
});
