// @vitest-environment node

import { describe, it, expect } from "vitest";
import { logicKernel } from "./logic";
import { registry, isPlayable } from "./registry";
import { BLOCK_FRAMES, GATE_HIGH_V, GATE_FIRE_THRESHOLD_V, GATE_REARM_THRESHOLD_V } from "../engine/units";

const SR = 48000;
const OUT_COUNT = 5;
const [AND, OR, XOR, NOR, FF] = [0, 1, 2, 3, 4];
const EMPTY_PARAMS = new Float32Array(0);

function makeOuts(): Float32Array[] {
  const outs: Float32Array[] = [];
  for (let i = 0; i < OUT_COUNT; i++) outs.push(new Float32Array(BLOCK_FRAMES));
  return outs;
}

// A periodic clock: high for `pulseLen` samples starting at every `period`
// boundary from `first`. Rising edges land exactly on those boundaries.
function periodicClock(first: number, period: number, pulseLen: number) {
  return (i: number): number => {
    if (i < first) return 0;
    const phase = (i - first) % period;
    return phase < pulseLen ? GATE_HIGH_V : 0;
  };
}

function renderLogic(opts: {
  sr?: number;
  totalSamples: number;
  in1At?: (sample: number) => number;
  in2At?: (sample: number) => number;
  clkAt?: (sample: number) => number;
}): { outs: Float32Array[] } {
  const sr = opts.sr ?? SR;
  const state = logicKernel.init(sr);
  const outs = makeOuts();
  const in1Buf = opts.in1At ? new Float32Array(BLOCK_FRAMES) : null;
  const in2Buf = opts.in2At ? new Float32Array(BLOCK_FRAMES) : null;
  const clkBuf = opts.clkAt ? new Float32Array(BLOCK_FRAMES) : null;
  const recorded: Float32Array[] = [];
  for (let s = 0; s < OUT_COUNT; s++) recorded.push(new Float32Array(opts.totalSamples));
  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      if (in1Buf && opts.in1At) in1Buf[i] = opts.in1At(start + i);
      if (in2Buf && opts.in2At) in2Buf[i] = opts.in2At(start + i);
      if (clkBuf && opts.clkAt) clkBuf[i] = opts.clkAt(start + i);
    }
    logicKernel.process(state, [in1Buf, in2Buf, clkBuf], outs, EMPTY_PARAMS, n);
    for (let s = 0; s < OUT_COUNT; s++) recorded[s].set(outs[s].subarray(0, n), start);
  }
  return { outs: recorded };
}

// ── 1. Registry / seed integrity ─────────────────────────────────────────────

describe("logic registry entry", () => {
  it("matches the renamed seed: In 1/In 2/Clock inputs, AND/OR/XOR/NOR/FF outputs, no controls", () => {
    const entry = registry.get("logic");
    expect(entry).toBeDefined();
    expect(entry?.inJacks).toEqual(["In 1", "In 2", "Clock"]);
    expect(entry?.outJacks).toEqual(["AND", "OR", "XOR", "NOR", "FF"]);
    expect(Object.keys(entry?.params ?? {})).toEqual([]);
  });

  it("is playable", () => {
    expect(isPlayable("logic")).toBe(true);
  });

  it("is fully previewed (no preview block)", () => {
    expect(registry.get("logic")?.preview).toBeUndefined();
  });

  it("uses the canonical logicKernel (identity)", () => {
    expect(registry.get("logic")?.kernel).toBe(logicKernel);
  });
});

// ── 2. Truth table ────────────────────────────────────────────────────────────

describe("logicKernel — combinational truth table", () => {
  const cases: Array<{ in1: number; in2: number; and: number; or: number; xor: number; nor: number }> = [
    { in1: 0, in2: 0, and: 0, or: 0, xor: 0, nor: GATE_HIGH_V },
    { in1: GATE_HIGH_V, in2: 0, and: 0, or: GATE_HIGH_V, xor: GATE_HIGH_V, nor: 0 },
    { in1: 0, in2: GATE_HIGH_V, and: 0, or: GATE_HIGH_V, xor: GATE_HIGH_V, nor: 0 },
    { in1: GATE_HIGH_V, in2: GATE_HIGH_V, and: GATE_HIGH_V, or: GATE_HIGH_V, xor: 0, nor: 0 },
  ];

  for (const c of cases) {
    it(`In 1=${c.in1}V, In 2=${c.in2}V -> AND=${c.and} OR=${c.or} XOR=${c.xor} NOR=${c.nor}`, () => {
      const { outs } = renderLogic({
        totalSamples: 200,
        in1At: () => c.in1,
        in2At: () => c.in2,
      });
      // Steady-state sample, well after the Schmitt latch settles.
      const i = 100;
      expect(outs[AND][i]).toBe(c.and);
      expect(outs[OR][i]).toBe(c.or);
      expect(outs[XOR][i]).toBe(c.xor);
      expect(outs[NOR][i]).toBe(c.nor);
    });
  }
});

// ── 3. Unconnected inputs ─────────────────────────────────────────────────────

describe("logicKernel — unconnected inputs", () => {
  it("unpatched In 1/In 2/Clock all read as low: NOR high, AND/OR/XOR/FF low", () => {
    const state = logicKernel.init(SR);
    const outs = makeOuts();
    logicKernel.process(state, [null, null, null], outs, EMPTY_PARAMS, BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(outs[AND][i]).toBe(0);
      expect(outs[OR][i]).toBe(0);
      expect(outs[XOR][i]).toBe(0);
      expect(outs[NOR][i]).toBe(GATE_HIGH_V);
      expect(outs[FF][i]).toBe(0);
    }
  });

  it("unpatched In 2 alone reads as low (In 1 high -> OR/XOR high, AND/NOR low)", () => {
    const { outs } = renderLogic({ totalSamples: 200, in1At: () => GATE_HIGH_V });
    const i = 100;
    expect(outs[AND][i]).toBe(0);
    expect(outs[OR][i]).toBe(GATE_HIGH_V);
    expect(outs[XOR][i]).toBe(GATE_HIGH_V);
    expect(outs[NOR][i]).toBe(0);
  });
});

// ── 4. Clock isolation from the combinational outputs ────────────────────────

describe("logicKernel — Clock does not affect AND/OR/XOR/NOR", () => {
  it("clocking rapidly while In 1/In 2 are fixed leaves the combinational outputs unchanged", () => {
    const first = 50;
    const period = 40;
    const { outs } = renderLogic({
      totalSamples: 2000,
      in1At: () => GATE_HIGH_V,
      in2At: () => 0,
      clkAt: periodicClock(first, period, 10),
    });
    for (let i = 0; i < 2000; i++) {
      expect(outs[AND][i]).toBe(0);
      expect(outs[OR][i]).toBe(GATE_HIGH_V);
      expect(outs[XOR][i]).toBe(GATE_HIGH_V);
      expect(outs[NOR][i]).toBe(0);
    }
  });
});

// ── 5. In 1/In 2 isolation from FF ────────────────────────────────────────────

describe("logicKernel — In 1/In 2 do not affect FF", () => {
  it("toggling In 1/In 2 without a Clock edge never changes FF", () => {
    const { outs } = renderLogic({
      totalSamples: 400,
      in1At: (i) => (Math.floor(i / 20) % 2 === 0 ? GATE_HIGH_V : 0),
      in2At: (i) => (Math.floor(i / 13) % 2 === 0 ? GATE_HIGH_V : 0),
    });
    for (let i = 0; i < 400; i++) expect(outs[FF][i]).toBe(0);
  });
});

// ── 6-10. FF (T flip-flop) behavior ──────────────────────────────────────────

describe("logicKernel — FF flip-flop", () => {
  it("starts low", () => {
    const state = logicKernel.init(SR);
    const outs = makeOuts();
    logicKernel.process(state, [null, null, null], outs, EMPTY_PARAMS, 10);
    expect(outs[FF][0]).toBe(0);
  });

  it("toggles on successive rising Clock edges", () => {
    const first = 100;
    const period = 500;
    const { outs } = renderLogic({
      totalSamples: first + 6 * period,
      clkAt: periodicClock(first, period, 50),
    });
    const expected = [GATE_HIGH_V, 0, GATE_HIGH_V, 0, GATE_HIGH_V, 0];
    for (let k = 0; k < expected.length; k++) {
      expect(outs[FF][first + k * period]).toBe(expected[k]);
    }
  });

  it("a Clock held high toggles only once", () => {
    const state = logicKernel.init(SR);
    const outs = makeOuts();
    const clkBuf = new Float32Array(BLOCK_FRAMES).fill(GATE_HIGH_V);
    logicKernel.process(state, [null, null, clkBuf], outs, EMPTY_PARAMS, BLOCK_FRAMES);
    // Toggles once on sample 0, then stays high for the rest of the block.
    for (let i = 0; i < BLOCK_FRAMES; i++) expect(outs[FF][i]).toBe(GATE_HIGH_V);
    // A second full block held high must not toggle again.
    logicKernel.process(state, [null, null, clkBuf], outs, EMPTY_PARAMS, BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) expect(outs[FF][i]).toBe(GATE_HIGH_V);
  });

  it("falling edges never toggle FF", () => {
    const state = logicKernel.init(SR);
    const outs = makeOuts();
    const clkBuf = new Float32Array(BLOCK_FRAMES);
    // Rising edge at sample 10, falling edge at sample 60 — only the rise toggles.
    for (let i = 10; i < 60; i++) clkBuf[i] = GATE_HIGH_V;
    logicKernel.process(state, [null, null, clkBuf], outs, EMPTY_PARAMS, BLOCK_FRAMES);
    expect(outs[FF][9]).toBe(0);
    expect(outs[FF][10]).toBe(GATE_HIGH_V);
    expect(outs[FF][59]).toBe(GATE_HIGH_V);
    expect(outs[FF][60]).toBe(GATE_HIGH_V); // falling edge: still high, no toggle
    expect(outs[FF][BLOCK_FRAMES - 1]).toBe(GATE_HIGH_V);
  });

  it("Clock Schmitt state and FF state survive block boundaries", () => {
    const state = logicKernel.init(SR);
    const outs = makeOuts();
    // Block 1: rising edge near the end, still high at block end (not yet re-armed).
    const clk1 = new Float32Array(BLOCK_FRAMES);
    clk1[BLOCK_FRAMES - 1] = GATE_HIGH_V;
    logicKernel.process(state, [null, null, clk1], outs, EMPTY_PARAMS, BLOCK_FRAMES);
    expect(outs[FF][BLOCK_FRAMES - 1]).toBe(GATE_HIGH_V);

    // Block 2: Clock held high at the very start must NOT re-toggle (the
    // Schmitt latch from block 1 is still armed high).
    const clk2 = new Float32Array(BLOCK_FRAMES).fill(GATE_HIGH_V);
    logicKernel.process(state, [null, null, clk2], outs, EMPTY_PARAMS, BLOCK_FRAMES);
    expect(outs[FF][0]).toBe(GATE_HIGH_V);

    // Block 3: Clock falls low (re-arming the latch) before a fresh rising
    // edge at sample 20. Re-arming itself must not toggle FF — only the
    // fresh edge does.
    const clk3 = new Float32Array(BLOCK_FRAMES);
    clk3[20] = GATE_HIGH_V; // (rest stays 0 -> re-arms before sample 20)
    logicKernel.process(state, [null, null, clk3], outs, EMPTY_PARAMS, BLOCK_FRAMES);
    expect(outs[FF][0]).toBe(GATE_HIGH_V); // re-arming (low) does not itself toggle FF
    expect(outs[FF][19]).toBe(GATE_HIGH_V); // still holding, no edge yet
    expect(outs[FF][20]).toBe(0); // fresh rising edge toggles high -> low
  });

  it("detects multiple legitimate rising edges within a single block", () => {
    const state = logicKernel.init(SR);
    const outs = makeOuts();
    const clkBuf = new Float32Array(BLOCK_FRAMES);
    // Three separate pulses within one block: edges at 5, 25, 45.
    for (const start of [5, 25, 45]) {
      for (let i = start; i < start + 8; i++) clkBuf[i] = GATE_HIGH_V;
    }
    logicKernel.process(state, [null, null, clkBuf], outs, EMPTY_PARAMS, BLOCK_FRAMES);
    expect(outs[FF][4]).toBe(0);
    expect(outs[FF][5]).toBe(GATE_HIGH_V); // edge 1: toggled 0 -> high
    expect(outs[FF][20]).toBe(GATE_HIGH_V); // holds high in the gap (re-armed, not yet re-toggled)
    expect(outs[FF][25]).toBe(0); // edge 2: toggled high -> 0
    expect(outs[FF][40]).toBe(0); // holds low in the gap
    expect(outs[FF][45]).toBe(GATE_HIGH_V); // edge 3: toggled 0 -> high
  });
});

// ── 11. Schmitt-trigger hysteresis ───────────────────────────────────────────

describe("logicKernel — Schmitt-trigger hysteresis", () => {
  it("a noisy Clock dithering across the fire threshold does not toggle repeatedly", () => {
    const state = logicKernel.init(SR);
    const outs = makeOuts();
    const clkBuf = new Float32Array(BLOCK_FRAMES);
    // First sample: a clean rising edge that fires and latches high.
    clkBuf[0] = GATE_HIGH_V;
    // Dither around/just above the fire threshold WITHOUT ever dropping below
    // the re-arm threshold -- the Schmitt latch must not re-fire on this noise.
    for (let i = 1; i < BLOCK_FRAMES; i++) {
      clkBuf[i] = i % 2 === 0 ? GATE_FIRE_THRESHOLD_V + 0.01 : GATE_FIRE_THRESHOLD_V + 0.5;
    }
    logicKernel.process(state, [null, null, clkBuf], outs, EMPTY_PARAMS, BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) expect(outs[FF][i]).toBe(GATE_HIGH_V);
  });

  it("a noisy In 1 dithering between the fire and re-arm thresholds does not chatter AND/OR/XOR/NOR", () => {
    const { outs } = renderLogic({
      totalSamples: 300,
      in1At: (i) => {
        if (i < 100) return GATE_HIGH_V; // establish a solid high latch
        // Dither strictly between the re-arm and fire thresholds: neither
        // condition should fire, so the latch must stay exactly as it was.
        const mid = (GATE_FIRE_THRESHOLD_V + GATE_REARM_THRESHOLD_V) / 2;
        return i % 2 === 0 ? mid - 0.01 : mid + 0.01;
      },
      in2At: () => 0,
    });
    for (let i = 100; i < 300; i++) {
      expect(outs[OR][i]).toBe(GATE_HIGH_V); // still latched high, no chatter
      expect(outs[NOR][i]).toBe(0);
    }
  });
});

// ── 12. Non-finite safety ────────────────────────────────────────────────────

describe("logicKernel — safety", () => {
  it("non-finite In 1/In 2/Clock samples never crash; outputs stay finite", () => {
    const { outs } = renderLogic({
      totalSamples: 2000,
      in1At: (i) => (i % 4 === 0 ? NaN : Infinity),
      in2At: (i) => (i % 3 === 0 ? -Infinity : NaN),
      clkAt: (i) => (i % 5 === 0 ? NaN : Infinity),
    });
    for (let i = 0; i < 2000; i++) {
      for (let s = 0; s < OUT_COUNT; s++) expect(Number.isFinite(outs[s][i])).toBe(true);
    }
  });

  it("unusual but finite input values (large, negative, fractional) never produce NaN/Infinity", () => {
    const { outs } = renderLogic({
      totalSamples: 500,
      in1At: (i) => (i % 2 === 0 ? 1e12 : -1e12),
      in2At: (i) => (i % 3 === 0 ? -0.5 : 0.999999),
      clkAt: (i) => (i % 7 === 0 ? Number.MIN_VALUE : -1e-9),
    });
    for (let i = 0; i < 500; i++) {
      for (let s = 0; s < OUT_COUNT; s++) {
        const v = outs[s][i];
        expect(Number.isFinite(v)).toBe(true);
        expect(v === 0 || v === GATE_HIGH_V).toBe(true);
      }
    }
  });

  it("writes every declared output for a partial block, no stale sentinel samples", () => {
    const state = logicKernel.init(SR);
    const outs = makeOuts();
    for (const o of outs) o.fill(999);
    const n = 17;
    logicKernel.process(state, [null, null, null], outs, EMPTY_PARAMS, n);
    for (const o of outs) {
      for (let i = 0; i < n; i++) expect(o[i]).not.toBe(999);
      for (let i = n; i < BLOCK_FRAMES; i++) expect(o[i]).toBe(999);
    }
  });
});
