// @vitest-environment node

import { describe, it, expect } from "vitest";
import { comparatorKernel } from "./comparator";
import { registry, isPlayable } from "./registry";
import { BLOCK_FRAMES, GATE_HIGH_V, CV_BIPOLAR_MAX, CV_UNIPOLAR_MAX } from "../engine/units";

const SR = 48000;
const [GATE, INV_GATE, SUM] = [0, 1, 2];
const PARAM_COUNT = 4;
const [OFFSET, PLUS_LEVEL, MINUS_LEVEL, GAP] = [0, 1, 2, 3];

function makeOuts(): Float32Array[] {
  return [new Float32Array(BLOCK_FRAMES), new Float32Array(BLOCK_FRAMES), new Float32Array(BLOCK_FRAMES)];
}

/**
 * Renders `totalSamples` of Gate/Inv Gate/Sum in BLOCK_FRAMES chunks from
 * scripted per-sample + In/− In/Offset CV volt scripts and per-block params,
 * starting from a fresh kernel state.
 */
function render(opts: {
  sr?: number;
  totalSamples: number;
  plusAt?: (sample: number) => number;
  minusAt?: (sample: number) => number;
  offsetCvAt?: (sample: number) => number;
  offset?: number | ((sample: number) => number);
  plusLevel?: number | ((sample: number) => number);
  minusLevel?: number | ((sample: number) => number);
  gap?: number | ((sample: number) => number);
  patchPlus?: boolean;
  patchMinus?: boolean;
  patchOffsetCv?: boolean;
}): { gate: Float32Array; invGate: Float32Array; sum: Float32Array } {
  const sr = opts.sr ?? SR;
  const state = comparatorKernel.init(sr);
  const plusBuf = new Float32Array(BLOCK_FRAMES);
  const minusBuf = new Float32Array(BLOCK_FRAMES);
  const offsetCvBuf = new Float32Array(BLOCK_FRAMES);
  const outs = makeOuts();
  const gate = new Float32Array(opts.totalSamples);
  const invGate = new Float32Array(opts.totalSamples);
  const sum = new Float32Array(opts.totalSamples);
  const patchPlus = opts.patchPlus ?? true;
  const patchMinus = opts.patchMinus ?? true;
  const patchOffsetCv = opts.patchOffsetCv ?? true;

  const asFn = (v: number | ((s: number) => number) | undefined, fallback: number): ((s: number) => number) =>
    typeof v === "function" ? v : (_s: number) => v ?? fallback;
  const offsetAt = asFn(opts.offset, 0);
  const plusLevelAt = asFn(opts.plusLevel, 1);
  const minusLevelAt = asFn(opts.minusLevel, 1);
  const gapAt = asFn(opts.gap, 0);

  const params = new Float32Array(PARAM_COUNT);

  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      plusBuf[i] = opts.plusAt ? opts.plusAt(start + i) : 0;
      minusBuf[i] = opts.minusAt ? opts.minusAt(start + i) : 0;
      offsetCvBuf[i] = opts.offsetCvAt ? opts.offsetCvAt(start + i) : 0;
    }
    params[OFFSET] = offsetAt(start);
    params[PLUS_LEVEL] = plusLevelAt(start);
    params[MINUS_LEVEL] = minusLevelAt(start);
    params[GAP] = gapAt(start);
    comparatorKernel.process(
      state,
      [patchPlus ? plusBuf : null, patchMinus ? minusBuf : null, patchOffsetCv ? offsetCvBuf : null],
      outs,
      params,
      n,
    );
    gate.set(outs[GATE].subarray(0, n), start);
    invGate.set(outs[INV_GATE].subarray(0, n), start);
    sum.set(outs[SUM].subarray(0, n), start);
  }
  return { gate, invGate, sum };
}

// ── 1. Registry / seed integrity ─────────────────────────────────────────────

describe("comparator registry entry", () => {
  it("matches the redesigned seed: + In/− In/Offset CV inputs, Gate/Inv Gate/Sum outputs, Offset/+ Level/− Level/Gap controls", () => {
    const entry = registry.get("comparator");
    expect(entry).toBeDefined();
    expect(entry?.inJacks).toEqual(["+ In", "− In", "Offset CV"]);
    expect(entry?.outJacks).toEqual(["Gate", "Inv Gate", "Sum"]);
    expect(Object.keys(entry?.params ?? {})).toEqual(["Offset", "+ Level", "− Level", "Gap"]);
  });

  it("is playable", () => {
    expect(isPlayable("comparator")).toBe(true);
  });

  it("is fully previewed (no preview block)", () => {
    expect(registry.get("comparator")?.preview).toBeUndefined();
  });

  it("uses the canonical comparatorKernel (identity)", () => {
    expect(registry.get("comparator")?.kernel).toBe(comparatorKernel);
  });

  it("+ Level/− Level default to 1 (unity), Offset is bipolar around 0, Gap is unipolar 0..CV_UNIPOLAR_MAX", () => {
    const entry = registry.get("comparator");
    expect(entry?.params["+ Level"]).toEqual({ min: 0, max: 1, default: 1, curve: "linear" });
    expect(entry?.params["− Level"]).toEqual({ min: 0, max: 1, default: 1, curve: "linear" });
    expect(entry?.params.Offset).toEqual({ min: -CV_BIPOLAR_MAX, max: CV_BIPOLAR_MAX, default: 0, curve: "linear" });
    expect(entry?.params.Gap).toEqual({ min: 0, max: CV_UNIPOLAR_MAX, default: 0, curve: "linear" });
  });
});

// ── 2. Complete summing equation ─────────────────────────────────────────────

describe("comparatorKernel — sum = (+Level×+In) − (−Level×−In) + Offset + Offset CV", () => {
  it("computes the full equation with all terms non-trivial", () => {
    const { sum } = render({
      totalSamples: 4,
      plusAt: () => 3,
      minusAt: () => 2,
      offsetCvAt: () => 1,
      offset: 0.5,
      plusLevel: 0.8,
      minusLevel: 0.25,
      gap: 0,
    });
    // (0.8*3) - (0.25*2) + 0.5 + 1 = 2.4 - 0.5 + 0.5 + 1 = 3.4
    for (let i = 0; i < 4; i++) expect(sum[i]).toBeCloseTo(3.4, 6);
  });
});

// ── 3. Independent + Level / − Level attenuation ─────────────────────────────

describe("comparatorKernel — independent Level attenuation", () => {
  it("+ Level scales + In only", () => {
    const { sum } = render({ totalSamples: 2, plusAt: () => 4, plusLevel: 0.5 });
    for (let i = 0; i < 2; i++) expect(sum[i]).toBeCloseTo(2, 6);
  });

  it("− Level scales − In only", () => {
    const { sum } = render({ totalSamples: 2, minusAt: () => 4, minusLevel: 0.5 });
    for (let i = 0; i < 2; i++) expect(sum[i]).toBeCloseTo(-2, 6);
  });

  it("changing + Level does not affect the − In contribution and vice versa", () => {
    const { sum: sumA } = render({ totalSamples: 2, plusAt: () => 3, minusAt: () => 3, plusLevel: 1, minusLevel: 1 });
    const { sum: sumB } = render({ totalSamples: 2, plusAt: () => 3, minusAt: () => 3, plusLevel: 0.2, minusLevel: 1 });
    expect(sumA[0]).toBeCloseTo(0, 6);
    expect(sumB[0]).toBeCloseTo(0.2 * 3 - 3, 6);
  });
});

// ── 4. Subtraction and cancellation ──────────────────────────────────────────

describe("comparatorKernel — subtraction and cancellation", () => {
  it("equal + In / − In with unity levels cancels exactly to zero", () => {
    const { sum } = render({ totalSamples: 4, plusAt: () => 2.5, minusAt: () => 2.5 });
    for (let i = 0; i < 4; i++) expect(sum[i]).toBe(0);
  });

  it("− In larger than + In produces a negative Sum", () => {
    const { sum } = render({ totalSamples: 2, plusAt: () => 1, minusAt: () => 5 });
    for (let i = 0; i < 2; i++) expect(sum[i]).toBeCloseTo(-4, 6);
  });
});

// ── 5. Positive and negative Offset ──────────────────────────────────────────

describe("comparatorKernel — Offset", () => {
  it("a positive Offset shifts Sum up with no inputs patched", () => {
    const { sum } = render({ totalSamples: 2, offset: 3 });
    for (let i = 0; i < 2; i++) expect(sum[i]).toBe(3);
  });

  it("a negative Offset shifts Sum down with no inputs patched", () => {
    const { sum } = render({ totalSamples: 2, offset: -2.5 });
    for (let i = 0; i < 2; i++) expect(sum[i]).toBe(-2.5);
  });
});

// ── 6. Offset CV ──────────────────────────────────────────────────────────────

describe("comparatorKernel — Offset CV", () => {
  it("adds directly to Sum, summing with the Offset knob", () => {
    const { sum } = render({ totalSamples: 2, offset: 1, offsetCvAt: () => 2 });
    for (let i = 0; i < 2; i++) expect(sum[i]).toBeCloseTo(3, 6);
  });

  it("tracks a time-varying Offset CV sample by sample", () => {
    const { sum } = render({ totalSamples: 4, offsetCvAt: (i) => i });
    for (let i = 0; i < 4; i++) expect(sum[i]).toBeCloseTo(i, 6);
  });
});

// ── 7. Unconnected inputs contribute zero ────────────────────────────────────

describe("comparatorKernel — unconnected inputs", () => {
  it("unpatched + In contributes 0, regardless of + Level", () => {
    const { sum } = render({ totalSamples: 2, patchPlus: false, plusLevel: 1, minusAt: () => 1 });
    for (let i = 0; i < 2; i++) expect(sum[i]).toBeCloseTo(-1, 6);
  });

  it("unpatched − In contributes 0, regardless of − Level", () => {
    const { sum } = render({ totalSamples: 2, patchMinus: false, minusLevel: 1, plusAt: () => 1 });
    for (let i = 0; i < 2; i++) expect(sum[i]).toBeCloseTo(1, 6);
  });

  it("unpatched Offset CV contributes 0", () => {
    const { sum } = render({ totalSamples: 2, patchOffsetCv: false, offset: 1 });
    for (let i = 0; i < 2; i++) expect(sum[i]).toBe(1);
  });

  it("all inputs unpatched and Offset/Gap at default yields Sum = 0 and Gate low", () => {
    const { sum, gate, invGate } = render({ totalSamples: 2, patchPlus: false, patchMinus: false, patchOffsetCv: false });
    for (let i = 0; i < 2; i++) {
      expect(sum[i]).toBe(0);
      expect(gate[i]).toBe(0);
      expect(invGate[i]).toBe(GATE_HIGH_V);
    }
  });
});

// ── 8. Sum is never clamped or normalized ────────────────────────────────────

describe("comparatorKernel — Sum is unclamped", () => {
  it("passes a large excursion through Sum with no clipping", () => {
    const { sum } = render({ totalSamples: 2, plusAt: () => 1000, plusLevel: 1 });
    for (let i = 0; i < 2; i++) expect(sum[i]).toBe(1000);
  });

  it("passes a large negative excursion through Sum with no clipping", () => {
    const { sum } = render({ totalSamples: 2, minusAt: () => 1000, minusLevel: 1 });
    for (let i = 0; i < 2; i++) expect(sum[i]).toBe(-1000);
  });
});

// ── 9. Zero-gap comparison, including equality ───────────────────────────────

describe("comparatorKernel — Gap = 0 strict comparison", () => {
  it("Gate is high when Sum > 0", () => {
    const { gate, invGate } = render({ totalSamples: 2, offset: 0.001 });
    expect(gate[0]).toBe(GATE_HIGH_V);
    expect(invGate[0]).toBe(0);
  });

  it("Gate is low when Sum < 0", () => {
    const { gate, invGate } = render({ totalSamples: 2, offset: -0.001 });
    expect(gate[0]).toBe(0);
    expect(invGate[0]).toBe(GATE_HIGH_V);
  });

  it("Gate is low when Sum == 0 exactly, regardless of prior state", () => {
    // Drive Gate high first, then land exactly on 0 — equality must read low.
    const { gate } = render({ totalSamples: 6, offsetCvAt: (i) => (i < 3 ? 5 : 0) });
    expect(gate[2]).toBe(GATE_HIGH_V);
    expect(gate[3]).toBe(0);
    expect(gate[4]).toBe(0);
  });
});

// ── 10. Symmetric hysteresis thresholds ──────────────────────────────────────

describe("comparatorKernel — symmetric hysteresis (Gap > 0)", () => {
  it("while low, switches high only once Sum > Gap / 2", () => {
    const gap = 2; // half = 1
    const { gate: gateAtHalf } = render({ totalSamples: 2, offsetCvAt: () => 1, gap });
    expect(gateAtHalf[0]).toBe(0); // exactly at the boundary: not yet high

    const { gate: gateAboveHalf } = render({ totalSamples: 2, offsetCvAt: () => 1.001, gap });
    expect(gateAboveHalf[0]).toBe(GATE_HIGH_V);
  });

  it("while high, switches low only once Sum < −Gap / 2", () => {
    const gap = 2; // half = 1
    // Rise above +1 first to latch high, then approach the low threshold.
    const { gate } = render({
      totalSamples: 4,
      offsetCvAt: (i) => (i === 0 ? 5 : i === 1 ? -1 : -1.001),
      gap,
    });
    expect(gate[0]).toBe(GATE_HIGH_V); // latched high by +5
    expect(gate[1]).toBe(GATE_HIGH_V); // exactly at −half: still high
    expect(gate[2]).toBe(0); // below −half: now low
    expect(gate[3]).toBe(0);
  });
});

// ── 11. State retention inside the hysteresis gap ────────────────────────────

describe("comparatorKernel — state retention inside the gap", () => {
  it("holds high while Sum wanders inside (−Gap/2, +Gap/2) after rising above +Gap/2", () => {
    const gap = 4; // half = 2
    const { gate } = render({
      totalSamples: 5,
      offsetCvAt: (i) => [3, 1, -1, 0, 1.9][i],
      gap,
    });
    for (let i = 0; i < 5; i++) expect(gate[i]).toBe(GATE_HIGH_V);
  });

  it("holds low while Sum wanders inside (−Gap/2, +Gap/2) after falling below −Gap/2", () => {
    const gap = 4; // half = 2
    // First latch high (sum > +half), then drop below −half to flip low,
    // then wander inside the band — it must stay low throughout.
    const { gate } = render({
      totalSamples: 6,
      offsetCvAt: (i) => [3, -3, -1, 1, 0, -1.9][i],
      gap,
    });
    expect(gate[0]).toBe(GATE_HIGH_V); // latched high first
    for (let i = 1; i < 6; i++) expect(gate[i]).toBe(0);
  });

  it("starts low (no prior state) when the module is created", () => {
    const { gate, invGate } = render({ totalSamples: 1, gap: 10, offsetCvAt: () => 3 });
    // 3 is inside (-5, 5) for gap=10, so the initial low state is retained.
    expect(gate[0]).toBe(0);
    expect(invGate[0]).toBe(GATE_HIGH_V);
  });
});

// ── 12. Exact complementary outputs ───────────────────────────────────────────

describe("comparatorKernel — Gate/Inv Gate are always exact complements", () => {
  it("across zero-gap, hysteresis, and adversarial scripts", () => {
    const scripts: Array<{ gap: number; offsetCvAt: (i: number) => number }> = [
      { gap: 0, offsetCvAt: (i) => Math.sin(i * 0.3) * 3 },
      { gap: 3, offsetCvAt: (i) => Math.sin(i * 0.1) * 5 },
      { gap: 8, offsetCvAt: (i) => (i % 13 === 0 ? NaN : (i % 40) - 20) },
    ];
    for (const script of scripts) {
      const { gate, invGate } = render({ totalSamples: 500, gap: script.gap, offsetCvAt: script.offsetCvAt });
      for (let i = 0; i < 500; i++) {
        expect(gate[i] === GATE_HIGH_V).toBe(invGate[i] === 0);
        expect(gate[i] + invGate[i]).toBe(GATE_HIGH_V);
      }
    }
  });
});

// ── 13. Audio-rate zero crossings ────────────────────────────────────────────

describe("comparatorKernel — audio-rate zero crossings", () => {
  it("tracks every zero crossing of an audio-rate sine at Gap = 0", () => {
    const freq = 440;
    const totalSamples = 1000;
    const { gate } = render({
      totalSamples,
      plusAt: (i) => 5 * Math.sin((2 * Math.PI * freq * i) / SR),
    });
    let crossings = 0;
    let expectedHigh = false;
    for (let i = 0; i < totalSamples; i++) {
      const v = 5 * Math.sin((2 * Math.PI * freq * i) / SR);
      const shouldBeHigh = v > 0;
      if (shouldBeHigh !== expectedHigh) {
        crossings++;
        expectedHigh = shouldBeHigh;
      }
      expect(gate[i]).toBe(shouldBeHigh ? GATE_HIGH_V : 0);
    }
    expect(crossings).toBeGreaterThan(10);
  });
});

// ── 14. Invalid / non-finite values ──────────────────────────────────────────

describe("comparatorKernel — safety", () => {
  it("never emits NaN/Infinity under adversarial inputs and controls", () => {
    const { sum, gate, invGate } = render({
      totalSamples: 3000,
      plusAt: (i) => (i % 5 === 0 ? NaN : i % 3 === 0 ? Infinity : (i % 2000) - 1000),
      minusAt: (i) => (i % 7 === 0 ? -Infinity : i % 11 === 0 ? NaN : (i % 1500) - 750),
      offsetCvAt: (i) => (i % 13 === 0 ? NaN : (i % 200) - 100),
      offset: (i) => (i % 17 === 0 ? NaN : (i % 3) - 1),
      plusLevel: (i) => (i % 19 === 0 ? Infinity : (i % 100) / 100),
      minusLevel: (i) => (i % 23 === 0 ? -Infinity : (i % 100) / 100),
      gap: (i) => (i % 29 === 0 ? NaN : i % 4),
    });
    for (let i = 0; i < 3000; i++) {
      expect(Number.isFinite(sum[i])).toBe(true);
      expect(Number.isFinite(gate[i])).toBe(true);
      expect(Number.isFinite(invGate[i])).toBe(true);
    }
  });

  it("writes every declared output for a partial block, no stale sentinel samples", () => {
    const state = comparatorKernel.init(SR);
    const outs = makeOuts();
    outs[GATE].fill(999);
    outs[INV_GATE].fill(999);
    outs[SUM].fill(999);
    const n = 17;
    const plusBuf = new Float32Array(BLOCK_FRAMES).fill(2);
    comparatorKernel.process(state, [plusBuf, null, null], outs, new Float32Array(PARAM_COUNT), n);
    for (let i = 0; i < n; i++) {
      expect(outs[GATE][i]).not.toBe(999);
      expect(outs[INV_GATE][i]).not.toBe(999);
      expect(outs[SUM][i]).not.toBe(999);
    }
    for (let i = n; i < BLOCK_FRAMES; i++) {
      expect(outs[GATE][i]).toBe(999);
      expect(outs[INV_GATE][i]).toBe(999);
      expect(outs[SUM][i]).toBe(999);
    }
  });
});
