// @vitest-environment node

import { describe, it, expect } from "vitest";
import { crossfaderKernel } from "./crossfader";
import { BLOCK_FRAMES, CV_BIPOLAR_MAX } from "../engine/units";

const SR = 48000;

// params order: Fade (-1..1 bipolar)
function makeParams(fade: number): Float32Array {
  return new Float32Array([fade]);
}

function constBuf(v: number): Float32Array {
  return new Float32Array(BLOCK_FRAMES).fill(v);
}

function makeOut(): Float32Array {
  return new Float32Array(BLOCK_FRAMES);
}

function runCrossfader(
  inA: Float32Array | null,
  inB: Float32Array | null,
  inCv: Float32Array | null,
  params: Float32Array,
): Float32Array {
  const state = crossfaderKernel.init(SR);
  const out = makeOut();
  crossfaderKernel.process(state, [inA, inB, inCv], [out], params, BLOCK_FRAMES);
  return out;
}

function expectAllFinite(buf: Float32Array): void {
  for (let i = 0; i < buf.length; i++) {
    expect(Number.isFinite(buf[i])).toBe(true);
  }
}

// ── 1. Endpoints and midpoint (no CV) ──────────────────────────────────────

describe("crossfader fade endpoints", () => {
  it("Fade = -1 (full CCW): output is exactly A", () => {
    const a = constBuf(3.0);
    const b = constBuf(-7.0);
    const out = runCrossfader(a, b, null, makeParams(-1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBe(3.0);
    }
  });

  it("Fade = +1 (full CW): output is exactly B", () => {
    const a = constBuf(3.0);
    const b = constBuf(-7.0);
    const out = runCrossfader(a, b, null, makeParams(1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBe(-7.0);
    }
  });

  it("Fade = 0 (center): equal linear mix of A and B", () => {
    const a = constBuf(4.0);
    const b = constBuf(2.0);
    const out = runCrossfader(a, b, null, makeParams(0));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(3.0, 5); // (4*0.5 + 2*0.5)
    }
  });

  it("intermediate positions interpolate linearly", () => {
    const a = constBuf(10.0);
    const b = constBuf(0.0);
    // Fade = -0.5 -> t = 0.25 -> out = 10*0.75 + 0*0.25 = 7.5
    expect(runCrossfader(a, b, null, makeParams(-0.5))[0]).toBeCloseTo(7.5, 5);
    // Fade = 0.5 -> t = 0.75 -> out = 10*0.25 + 0*0.75 = 2.5
    expect(runCrossfader(a, b, null, makeParams(0.5))[0]).toBeCloseTo(2.5, 5);
    // Fade = -0.8 -> t = 0.1 -> out = 10*0.9 = 9.0
    expect(runCrossfader(a, b, null, makeParams(-0.8))[0]).toBeCloseTo(9.0, 5);
    // Fade = 0.8 -> t = 0.9 -> out = 10*0.1 = 1.0
    expect(runCrossfader(a, b, null, makeParams(0.8))[0]).toBeCloseTo(1.0, 5);
  });

  it("Fade position is clamped to [-1, 1] beyond knob range", () => {
    const a = constBuf(5.0);
    const b = constBuf(-5.0);
    const outLow = runCrossfader(a, b, null, makeParams(-3));
    const outHigh = runCrossfader(a, b, null, makeParams(3));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(outLow[i]).toBe(5.0);
      expect(outHigh[i]).toBe(-5.0);
    }
  });
});

// ── 2. Unconnected inputs ───────────────────────────────────────────────────

describe("crossfader unconnected inputs", () => {
  it("only A connected: fading toward B fades to silence", () => {
    const a = constBuf(6.0);
    const out = runCrossfader(a, null, null, makeParams(1)); // full B
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
    const mid = runCrossfader(a, null, null, makeParams(0));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(mid[i]).toBeCloseTo(3.0, 5); // half of A, half of silence
    }
  });

  it("only B connected: fading toward A fades to silence", () => {
    const b = constBuf(6.0);
    const out = runCrossfader(null, b, null, makeParams(-1)); // full A
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
    const mid = runCrossfader(null, b, null, makeParams(0));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(mid[i]).toBeCloseTo(3.0, 5);
    }
  });

  it("both A and B unconnected: silence regardless of Fade", () => {
    for (const fade of [-1, -0.3, 0, 0.5, 1]) {
      const out = runCrossfader(null, null, null, makeParams(fade));
      expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
    }
  });

  it("unpatched CV leaves Fade knob in full manual control", () => {
    const a = constBuf(10.0);
    const b = constBuf(0.0);
    const out = runCrossfader(a, b, null, makeParams(0.5));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(2.5, 5); // t = 0.75
    }
  });
});

// ── 3. Fade CV modulation ────────────────────────────────────────────────

describe("crossfader Fade CV modulation", () => {
  it("CV adds to the manual Fade position (bipolar CV convention)", () => {
    const a = constBuf(10.0);
    const b = constBuf(0.0);
    // Fade = 0, CV = +2.5V -> total = 0 + 2.5/5 = 0.5 -> t = 0.75 -> out = 2.5
    const out = runCrossfader(a, b, constBuf(2.5), makeParams(0));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(2.5, 5);
    }
  });

  it("CV reaches the exact A endpoint when driven past -1", () => {
    const a = constBuf(4.0);
    const b = constBuf(-4.0);
    // Fade = 0, CV = -5V (full negative) -> total = -1 -> exact A
    const out = runCrossfader(a, b, constBuf(-CV_BIPOLAR_MAX), makeParams(0));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBe(4.0);
    }
  });

  it("CV reaches the exact B endpoint when driven past +1", () => {
    const a = constBuf(4.0);
    const b = constBuf(-4.0);
    const out = runCrossfader(a, b, constBuf(CV_BIPOLAR_MAX), makeParams(0));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBe(-4.0);
    }
  });

  it("CV beyond CV_BIPOLAR_MAX still clamps to the exact endpoint (no overshoot)", () => {
    const a = constBuf(4.0);
    const b = constBuf(-4.0);
    const out = runCrossfader(a, b, constBuf(CV_BIPOLAR_MAX * 4), makeParams(0));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBe(-4.0);
    }
  });

  it("manual Fade and CV combine additively before clamping", () => {
    const a = constBuf(8.0);
    const b = constBuf(0.0);
    // Fade = 0.5, CV = 2.5V/5 = 0.5 -> total clamped to 1 -> exact B (0.0)
    const out = runCrossfader(a, b, constBuf(2.5), makeParams(0.5));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBe(0.0);
    }
  });

  it("negative bipolar CV pulls the fade toward A", () => {
    const a = constBuf(8.0);
    const b = constBuf(0.0);
    // Fade = 0, CV = -1.25V -> total = -0.25 -> t = 0.375 -> out = 8*0.625 = 5.0
    const out = runCrossfader(a, b, constBuf(-1.25), makeParams(0));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(5.0, 5);
    }
  });
});

// ── 4. Signal path: audio and bipolar CV, DC ────────────────────────────────

describe("crossfader signal path", () => {
  it("passes a bipolar audio-rate signal through at Fade = -1 unchanged (A)", () => {
    const a = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) a[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 5;
    const b = constBuf(0);
    const out = runCrossfader(a, b, null, makeParams(-1));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBe(a[i]);
    }
  });

  it("preserves DC and negative values at the midpoint", () => {
    const a = constBuf(-6.0);
    const b = constBuf(-2.0);
    const out = runCrossfader(a, b, null, makeParams(0));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(-4.0, 5);
    }
  });

  it("blends two audio-rate signals sample-for-sample", () => {
    const a = new Float32Array(BLOCK_FRAMES);
    const b = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      a[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 5;
      b[i] = Math.sin((2 * Math.PI * 880 * i) / SR) * 5;
    }
    const out = runCrossfader(a, b, null, makeParams(0));
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).toBeCloseTo(a[i] * 0.5 + b[i] * 0.5, 5);
    }
  });
});

// ── 5. Parameter changes across render blocks ───────────────────────────────

describe("crossfader parameter changes across blocks", () => {
  it("responds to a different Fade value on each successive block", () => {
    const state = crossfaderKernel.init(SR);
    const a = constBuf(10.0);
    const b = constBuf(0.0);
    const out = makeOut();

    crossfaderKernel.process(state, [a, b, null], [out], makeParams(-1), BLOCK_FRAMES);
    expect(out[0]).toBe(10.0);

    crossfaderKernel.process(state, [a, b, null], [out], makeParams(1), BLOCK_FRAMES);
    expect(out[0]).toBe(0.0);

    crossfaderKernel.process(state, [a, b, null], [out], makeParams(0), BLOCK_FRAMES);
    expect(out[0]).toBeCloseTo(5.0, 5);
  });
});

// ── 6. Safety ────────────────────────────────────────────────────────────

describe("crossfader safety", () => {
  it("NaN Fade param produces finite output", () => {
    const a = constBuf(3.0);
    const b = constBuf(-3.0);
    const out = runCrossfader(a, b, null, new Float32Array([NaN]));
    expectAllFinite(out);
  });

  it("Infinity Fade param falls back to the default (0) like other non-finite values", () => {
    const a = constBuf(3.0);
    const b = constBuf(-3.0);
    const out = runCrossfader(a, b, null, new Float32Array([Infinity]));
    expectAllFinite(out);
    expect(out[0]).toBeCloseTo(0.0, 5); // fade defaults to 0 -> equal A/B mix

    const outNeg = runCrossfader(a, b, null, new Float32Array([-Infinity]));
    expectAllFinite(outNeg);
    expect(outNeg[0]).toBeCloseTo(0.0, 5);
  });

  it("NaN A/B input samples produce finite output", () => {
    const a = new Float32Array(BLOCK_FRAMES).fill(NaN);
    const b = new Float32Array(BLOCK_FRAMES).fill(NaN);
    const out = runCrossfader(a, b, null, makeParams(0));
    expectAllFinite(out);
    expect(out).toEqual(new Float32Array(BLOCK_FRAMES));
  });

  it("NaN/Infinity CV samples produce finite output and fall back to manual Fade", () => {
    const a = constBuf(5.0);
    const b = constBuf(-5.0);
    const cv = new Float32Array(BLOCK_FRAMES);
    cv[0] = NaN;
    cv[1] = Infinity;
    cv[2] = -Infinity;
    const out = runCrossfader(a, b, cv, makeParams(0));
    expectAllFinite(out);
    expect(out[0]).toBeCloseTo(0.0, 5); // NaN CV -> ignored -> Fade=0 midpoint
  });

  it("all outputs written every block (sentinel overwrite)", () => {
    const state = crossfaderKernel.init(SR);
    const out = new Float32Array(BLOCK_FRAMES).fill(99);
    crossfaderKernel.process(
      state,
      [constBuf(1.0), constBuf(-1.0), constBuf(1.0)],
      [out],
      makeParams(0),
      BLOCK_FRAMES,
    );
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(out[i]).not.toBe(99);
    }
  });
});
