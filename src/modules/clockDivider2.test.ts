import { describe, expect, it } from "vitest";
import { clockDivider2Kernel } from "./clockDivider2";
import { GATE_HIGH_V, GATE_FIRE_THRESHOLD_V, GATE_REARM_THRESHOLD_V } from "../engine/units";

const SR = 48000;
const OUT_COUNT = 7;

// Param slots: [Div, Mode]. Div: 0 = Pow 2, 1 = Prime, 2 = Int.
const DIV_POW2 = 0;
const DIV_PRIME = 1;
const DIV_INT = 2;
const MODE_GATE = 0;
const MODE_TRIG = 1;

const params = (div: number, mode: number): Float32Array => Float32Array.from([div, mode]);

function makeOuts(n: number): Float32Array[] {
  const outs: Float32Array[] = [];
  for (let k = 0; k < OUT_COUNT; k++) outs.push(new Float32Array(n));
  return outs;
}

/**
 * A clock buffer of `edges` pulses, each `width` samples high, starting at
 * sample 0 and repeating every `period` samples.
 */
function makeClock(n: number, period: number, width = 4): Float32Array {
  const clk = new Float32Array(n);
  for (let start = 0; start < n; start += period) {
    for (let i = start; i < Math.min(start + width, n); i++) clk[i] = GATE_HIGH_V;
  }
  return clk;
}

/** The sample index at which the p-th clock pulse rises. */
const edgeAt = (p: number, period: number): number => p * period;

describe("clockDivider2 kernel — gate mode divisions", () => {
  it("divides by 2,4,8,16,32,64,128 on the Pow 2 set with a ~50% duty gate", () => {
    const period = 8;
    const cycles = 260; // enough clock pulses to see /128 toggle
    const n = period * cycles;
    const state = clockDivider2Kernel.init(SR);
    const clk = makeClock(n, period);
    const outs = makeOuts(n);

    clockDivider2Kernel.process(state, [clk, null], outs, params(DIV_POW2, MODE_GATE), n);

    const divisors = [2, 4, 8, 16, 32, 64, 128];
    divisors.forEach((divisor, k) => {
      const high = divisor >> 1; // even divisors: exactly half
      // Sample the output level on each clock period and compare it with the
      // expected square: high for the first half of every `divisor` periods.
      for (let p = 0; p < cycles; p++) {
        const expected = p % divisor < high ? GATE_HIGH_V : 0;
        expect(outs[k][edgeAt(p, period)]).toBe(expected);
      }
    });
  });

  it("rounds the high half UP for odd divisors on the Prime set (3 → high 2, low 1)", () => {
    const period = 8;
    const cycles = 60;
    const n = period * cycles;
    const state = clockDivider2Kernel.init(SR);
    const outs = makeOuts(n);

    clockDivider2Kernel.process(state, [makeClock(n, period), null], outs, params(DIV_PRIME, MODE_GATE), n);

    // Out 2 on the Prime set is /3: high, high, low.
    const out3 = outs[1];
    for (let p = 0; p < cycles; p++) {
      const expected = p % 3 < 2 ? GATE_HIGH_V : 0;
      expect(out3[edgeAt(p, period)]).toBe(expected);
    }
    // Out 4 is /7: high for 4 periods, low for 3.
    const out7 = outs[3];
    for (let p = 0; p < cycles; p++) {
      const expected = p % 7 < 4 ? GATE_HIGH_V : 0;
      expect(out7[edgeAt(p, period)]).toBe(expected);
    }
  });

  it("uses 2,3,4,5,6,7,8 on the Int set", () => {
    const period = 8;
    const cycles = 40;
    const n = period * cycles;
    const state = clockDivider2Kernel.init(SR);
    const outs = makeOuts(n);

    clockDivider2Kernel.process(state, [makeClock(n, period), null], outs, params(DIV_INT, MODE_GATE), n);

    const divisors = [2, 3, 4, 5, 6, 7, 8];
    divisors.forEach((divisor, k) => {
      const high = (divisor + 1) >> 1;
      for (let p = 0; p < cycles; p++) {
        expect(outs[k][edgeAt(p, period)]).toBe(p % divisor < high ? GATE_HIGH_V : 0);
      }
    });
  });

  it("holds the gate level between clock edges — it does not follow the clock pulse width", () => {
    const period = 16;
    const n = period * 4;
    const state = clockDivider2Kernel.init(SR);
    const outs = makeOuts(n);

    // 4-sample-wide clock pulses; the /2 gate must stay high for the whole
    // 16-sample period, not just while the clock itself is high.
    clockDivider2Kernel.process(state, [makeClock(n, period, 4), null], outs, params(DIV_POW2, MODE_GATE), n);

    for (let i = 0; i < period; i++) expect(outs[0][i]).toBe(GATE_HIGH_V);
    for (let i = period; i < period * 2; i++) expect(outs[0][i]).toBe(0);
  });

  it("fires every output together on the first edge after power-on", () => {
    const period = 8;
    const n = period * 2;
    const state = clockDivider2Kernel.init(SR);
    const outs = makeOuts(n);

    clockDivider2Kernel.process(state, [makeClock(n, period), null], outs, params(DIV_PRIME, MODE_GATE), n);

    // Phase 0 sits inside the high half of every divisor >= 2.
    for (let k = 0; k < OUT_COUNT; k++) expect(outs[k][0]).toBe(GATE_HIGH_V);
  });
});

describe("clockDivider2 kernel — trigger mode", () => {
  it("emits one pulse per cycle, the same width as the incoming clock pulse", () => {
    const period = 20;
    const width = 6;
    const cycles = 12;
    const n = period * cycles;
    const state = clockDivider2Kernel.init(SR);
    const outs = makeOuts(n);

    clockDivider2Kernel.process(
      state,
      [makeClock(n, period, width), null],
      outs,
      params(DIV_INT, MODE_TRIG),
      n,
    );

    // Out 1 is /2 on the Int set: a pulse on every 2nd clock, `width` long.
    const out = outs[0];
    for (let p = 0; p < cycles; p++) {
      const start = edgeAt(p, period);
      const isDownbeat = p % 2 === 0;
      for (let i = 0; i < period; i++) {
        const withinClockPulse = i < width;
        const expected = isDownbeat && withinClockPulse ? GATE_HIGH_V : 0;
        expect(out[start + i]).toBe(expected);
      }
    }
  });

  it("tracks the clock pulse width — a wider clock makes a wider trigger", () => {
    const period = 20;
    const cycles = 4;
    const n = period * cycles;

    const measure = (width: number): number => {
      const state = clockDivider2Kernel.init(SR);
      const outs = makeOuts(n);
      clockDivider2Kernel.process(
        state,
        [makeClock(n, period, width), null],
        outs,
        params(DIV_INT, MODE_TRIG),
        n,
      );
      let high = 0;
      for (let i = 0; i < period; i++) if (outs[0][i] === GATE_HIGH_V) high++;
      return high;
    };

    expect(measure(3)).toBe(3);
    expect(measure(9)).toBe(9);
  });

  it("emits exactly one pulse per division cycle, not one per high-half clock", () => {
    const period = 8;
    const cycles = 32;
    const n = period * cycles;
    const state = clockDivider2Kernel.init(SR);
    const outs = makeOuts(n);

    clockDivider2Kernel.process(state, [makeClock(n, period), null], outs, params(DIV_POW2, MODE_TRIG), n);

    // Out 3 is /8: count rising edges on the output over 32 clock pulses.
    let pulses = 0;
    let high = false;
    for (let i = 0; i < n; i++) {
      const isHigh = outs[2][i] === GATE_HIGH_V;
      if (isHigh && !high) pulses++;
      high = isHigh;
    }
    expect(pulses).toBe(cycles / 8);
  });

  it("switching Mode mid-stream takes effect immediately without losing the cycle", () => {
    const period = 8;
    const n = period * 8;
    const state = clockDivider2Kernel.init(SR);
    const clk = makeClock(n, period);

    // First half in gate mode, second half in trigger mode, same state object.
    const outsA = makeOuts(n);
    clockDivider2Kernel.process(state, [clk, null], outsA, params(DIV_POW2, MODE_GATE), n);
    const outsB = makeOuts(n);
    clockDivider2Kernel.process(state, [clk, null], outsB, params(DIV_POW2, MODE_TRIG), n);

    // The /2 cycle continues across the switch: block A ended having consumed
    // 8 pulses (an even count), so block B's first pulse is a downbeat again.
    expect(outsB[0][0]).toBe(GATE_HIGH_V);
    expect(outsB[0][5]).toBe(0); // clock low → trigger low, unlike gate mode
    expect(outsA[0][5]).toBe(GATE_HIGH_V);
  });
});

describe("clockDivider2 kernel — reset", () => {
  it("re-zeros every counter so the next clock edge is a shared downbeat", () => {
    const period = 8;
    const n = period * 16;
    const state = clockDivider2Kernel.init(SR);
    const clk = makeClock(n, period);
    const rst = new Float32Array(n);
    // Reset midway, between two clock pulses, at an odd phase for /2.
    const resetAt = period * 5 + 2;
    for (let i = resetAt; i < resetAt + 4; i++) rst[i] = GATE_HIGH_V;
    const outs = makeOuts(n);

    clockDivider2Kernel.process(state, [clk, rst], outs, params(DIV_PRIME, MODE_GATE), n);

    // Outputs go low immediately on the reset sample …
    for (let k = 0; k < OUT_COUNT; k++) expect(outs[k][resetAt]).toBe(0);
    // … and every output fires together on the next clock edge.
    const nextEdge = period * 6;
    for (let k = 0; k < OUT_COUNT; k++) expect(outs[k][nextEdge]).toBe(GATE_HIGH_V);
  });

  it("resets before the clock edge when both land on the same sample", () => {
    const period = 8;
    const n = period * 8;
    const state = clockDivider2Kernel.init(SR);
    const clk = makeClock(n, period);
    const rst = new Float32Array(n);
    // Rst rises exactly on the 5th clock pulse (an odd /2 phase without it).
    const coincident = edgeAt(5, period);
    for (let i = coincident; i < coincident + 4; i++) rst[i] = GATE_HIGH_V;
    const outs = makeOuts(n);

    clockDivider2Kernel.process(state, [clk, rst], outs, params(DIV_POW2, MODE_GATE), n);

    // Reset then downbeat: all outputs high on that very sample.
    for (let k = 0; k < OUT_COUNT; k++) expect(outs[k][coincident]).toBe(GATE_HIGH_V);
  });

  it("re-arms: a sustained-high Rst resets once, not every sample", () => {
    const period = 8;
    const n = period * 12;
    const state = clockDivider2Kernel.init(SR);
    const clk = makeClock(n, period);
    const rst = new Float32Array(n);
    // Rst goes high at sample 1 and never falls.
    for (let i = 1; i < n; i++) rst[i] = GATE_HIGH_V;
    const outs = makeOuts(n);

    clockDivider2Kernel.process(state, [clk, rst], outs, params(DIV_POW2, MODE_GATE), n);

    // If reset re-fired every sample the /2 output would be stuck; instead the
    // division continues normally from the reset.
    expect(outs[0][edgeAt(1, period)]).toBe(GATE_HIGH_V);
    expect(outs[0][edgeAt(2, period)]).toBe(0);
    expect(outs[0][edgeAt(3, period)]).toBe(GATE_HIGH_V);
  });
});

describe("clockDivider2 kernel — clock input handling", () => {
  it("outputs silence on every jack when Clk is unpatched", () => {
    const n = 256;
    const state = clockDivider2Kernel.init(SR);
    const outs = makeOuts(n);
    for (const out of outs) out.fill(1);

    clockDivider2Kernel.process(state, [null, null], outs, params(DIV_POW2, MODE_GATE), n);

    for (let k = 0; k < OUT_COUNT; k++) {
      expect([...outs[k]]).toEqual(Array(n).fill(0));
    }
  });

  it("fires once on a sustained-high clock, then re-arms below the threshold", () => {
    const n = 64;
    const state = clockDivider2Kernel.init(SR);
    const clk = new Float32Array(n).fill(GATE_HIGH_V);
    clk[0] = 0;
    const outs = makeOuts(n);

    clockDivider2Kernel.process(state, [clk, null], outs, params(DIV_POW2, MODE_GATE), n);

    // One edge only → the /2 gate goes high at sample 1 and stays high.
    expect(outs[0][0]).toBe(0);
    for (let i = 1; i < n; i++) expect(outs[0][i]).toBe(GATE_HIGH_V);
  });

  it("uses Schmitt thresholds: fires at the fire threshold, re-arms below the re-arm threshold", () => {
    const n = 32;
    const state = clockDivider2Kernel.init(SR);
    const clk = new Float32Array(n);
    clk[4] = GATE_FIRE_THRESHOLD_V; // exactly at the threshold → fires
    clk[5] = GATE_REARM_THRESHOLD_V; // above re-arm → still latched high
    clk[6] = 0; // re-arms
    clk[8] = GATE_FIRE_THRESHOLD_V; // second edge
    const outs = makeOuts(n);

    clockDivider2Kernel.process(state, [clk, null], outs, params(DIV_POW2, MODE_GATE), n);

    expect(outs[0][3]).toBe(0);
    expect(outs[0][4]).toBe(GATE_HIGH_V); // 1st edge: /2 high
    expect(outs[0][7]).toBe(GATE_HIGH_V); // held between edges
    expect(outs[0][8]).toBe(0); // 2nd edge: /2 low
  });

  it("holds the latch through non-finite clock samples and never fires on them", () => {
    const n = 32;
    const state = clockDivider2Kernel.init(SR);
    const clk = new Float32Array(n);
    clk[4] = NaN;
    clk[5] = Infinity;
    clk[6] = NaN;
    const outs = makeOuts(n);

    clockDivider2Kernel.process(state, [clk, null], outs, params(DIV_POW2, MODE_GATE), n);

    for (let k = 0; k < OUT_COUNT; k++) {
      for (let i = 0; i < n; i++) expect(outs[k][i]).toBe(0);
    }
  });

  it("ignores non-finite Rst samples", () => {
    const period = 8;
    const n = period * 6;
    const state = clockDivider2Kernel.init(SR);
    const rst = new Float32Array(n).fill(NaN);
    const outs = makeOuts(n);

    clockDivider2Kernel.process(state, [makeClock(n, period), rst], outs, params(DIV_POW2, MODE_GATE), n);

    // Unaffected: the /2 output alternates exactly as with Rst unpatched.
    expect(outs[0][edgeAt(0, period)]).toBe(GATE_HIGH_V);
    expect(outs[0][edgeAt(1, period)]).toBe(0);
    expect(outs[0][edgeAt(2, period)]).toBe(GATE_HIGH_V);
  });
});

describe("clockDivider2 kernel — params", () => {
  it("falls back to Pow 2 / Gate for non-finite Div and Mode", () => {
    const period = 8;
    const n = period * 8;
    const outs = makeOuts(n);
    const clk = makeClock(n, period);

    clockDivider2Kernel.process(
      clockDivider2Kernel.init(SR),
      [clk, null],
      outs,
      Float32Array.from([NaN, NaN]),
      n,
    );

    const reference = makeOuts(n);
    clockDivider2Kernel.process(
      clockDivider2Kernel.init(SR),
      [clk, null],
      reference,
      params(DIV_POW2, MODE_GATE),
      n,
    );

    for (let k = 0; k < OUT_COUNT; k++) expect([...outs[k]]).toEqual([...reference[k]]);
  });

  it("clamps Div and Mode to their switch ranges", () => {
    const period = 8;
    const n = period * 8;
    const clk = makeClock(n, period);

    const outOfRange = makeOuts(n);
    clockDivider2Kernel.process(
      clockDivider2Kernel.init(SR),
      [clk, null],
      outOfRange,
      Float32Array.from([99, 99]),
      n,
    );
    const clamped = makeOuts(n);
    clockDivider2Kernel.process(
      clockDivider2Kernel.init(SR),
      [clk, null],
      clamped,
      params(DIV_INT, MODE_TRIG),
      n,
    );
    for (let k = 0; k < OUT_COUNT; k++) expect([...outOfRange[k]]).toEqual([...clamped[k]]);

    const negative = makeOuts(n);
    clockDivider2Kernel.process(
      clockDivider2Kernel.init(SR),
      [clk, null],
      negative,
      Float32Array.from([-5, -5]),
      n,
    );
    const first = makeOuts(n);
    clockDivider2Kernel.process(
      clockDivider2Kernel.init(SR),
      [clk, null],
      first,
      params(DIV_POW2, MODE_GATE),
      n,
    );
    for (let k = 0; k < OUT_COUNT; k++) expect([...negative[k]]).toEqual([...first[k]]);
  });

  it("re-bases a counter left past the end of a newly selected shorter cycle", () => {
    const period = 8;
    const n = period * 8;
    const state = clockDivider2Kernel.init(SR);
    const clk = makeClock(n, period);

    // Run 8 pulses on Pow 2 so Out 7 (/128) sits at phase 8.
    clockDivider2Kernel.process(state, [clk, null], makeOuts(n), params(DIV_POW2, MODE_GATE), n);
    // Switch to Int, where Out 7 is /8 — phase 8 is out of range and restarts.
    const outs = makeOuts(n);
    clockDivider2Kernel.process(state, [clk, null], outs, params(DIV_INT, MODE_GATE), n);

    // Out 7 restarts its cycle: high for the first 4 of 8 periods.
    for (let p = 0; p < 8; p++) {
      expect(outs[6][edgeAt(p, period)]).toBe(p % 8 < 4 ? GATE_HIGH_V : 0);
    }
  });
});

describe("clockDivider2 kernel — state continuity and determinism", () => {
  it("continues the division across consecutive process() calls", () => {
    const period = 8;
    const blockPulses = 4;
    const n = period * blockPulses;
    const clk = makeClock(n, period);

    const split = clockDivider2Kernel.init(SR);
    const blockA = makeOuts(n);
    const blockB = makeOuts(n);
    clockDivider2Kernel.process(split, [clk, null], blockA, params(DIV_POW2, MODE_GATE), n);
    clockDivider2Kernel.process(split, [clk, null], blockB, params(DIV_POW2, MODE_GATE), n);

    // One continuous render of twice the length must match the two blocks.
    const whole = clockDivider2Kernel.init(SR);
    const wholeOuts = makeOuts(n * 2);
    clockDivider2Kernel.process(
      whole,
      [makeClock(n * 2, period), null],
      wholeOuts,
      params(DIV_POW2, MODE_GATE),
      n * 2,
    );

    for (let k = 0; k < OUT_COUNT; k++) {
      expect([...blockA[k], ...blockB[k]]).toEqual([...wholeOuts[k]]);
    }
  });

  it("is deterministic — two fresh instances render identically", () => {
    const period = 8;
    const n = period * 20;
    const clk = makeClock(n, period);
    const a = makeOuts(n);
    const b = makeOuts(n);

    clockDivider2Kernel.process(clockDivider2Kernel.init(SR), [clk, null], a, params(DIV_PRIME, MODE_TRIG), n);
    clockDivider2Kernel.process(clockDivider2Kernel.init(SR), [clk, null], b, params(DIV_PRIME, MODE_TRIG), n);

    for (let k = 0; k < OUT_COUNT; k++) expect([...a[k]]).toEqual([...b[k]]);
  });

  it("writes every output sample every block — stale buffer contents never survive", () => {
    const n = 128;
    const state = clockDivider2Kernel.init(SR);
    const outs = makeOuts(n);
    for (const out of outs) out.fill(-999);

    clockDivider2Kernel.process(state, [makeClock(n, 8), null], outs, params(DIV_POW2, MODE_GATE), n);

    for (let k = 0; k < OUT_COUNT; k++) {
      for (let i = 0; i < n; i++) expect(outs[k][i]).not.toBe(-999);
    }
  });
});

describe("clockDivider2 kernel — LED gate telemetry", () => {
  // `gates` is UI telemetry (Interpreter.readGates), never audio: bit k is set
  // while outs[k] is high, held briefly so short pulses survive a poll.
  const gatesOf = (state: unknown): number => (state as { gates: number }).gates;

  it("sets a bit per output that is currently high, in outJacks order", () => {
    const period = 8;
    const n = period; // stop right after the first (downbeat) pulse
    const state = clockDivider2Kernel.init(SR);

    clockDivider2Kernel.process(state, [makeClock(n, period), null], makeOuts(n), params(DIV_POW2, MODE_GATE), n);

    // Every output is high on the downbeat → all seven bits set.
    expect(gatesOf(state)).toBe(0b1111111);
  });

  it("clears the bit of an output that has gone low", () => {
    const period = 8;
    const n = period * 2; // two pulses: /2 has gone low again
    const state = clockDivider2Kernel.init(SR);

    clockDivider2Kernel.process(state, [makeClock(n, period), null], makeOuts(n), params(DIV_POW2, MODE_GATE), n);

    // The LED hold is ~50 ms — far longer than these 16 samples — so bit 0 is
    // still held from its earlier high. Render past the hold to see it clear.
    const holdSamples = Math.round(0.05 * SR);
    const tail = holdSamples + period;
    const tailClk = new Float32Array(tail); // no further edges
    clockDivider2Kernel.process(state, [tailClk, null], makeOuts(tail), params(DIV_POW2, MODE_GATE), tail);

    // /2 is low; /4../128 are still in the high half of their cycles.
    expect(gatesOf(state) & 0b1).toBe(0);
    expect(gatesOf(state) & 0b1111110).toBe(0b1111110);
  });

  it("holds a bit past a trigger far shorter than the host's poll interval", () => {
    const period = 4800; // 100 ms at 48 kHz
    const width = 48; // 1 ms trigger — much shorter than a ~30 ms poll
    const n = period;
    const state = clockDivider2Kernel.init(SR);

    clockDivider2Kernel.process(
      state,
      [makeClock(n, period, width), null],
      makeOuts(n),
      params(DIV_INT, MODE_TRIG),
      n,
    );

    // 100 ms after the pulse the hold has expired and every bit is clear …
    expect(gatesOf(state)).toBe(0);

    // … but sampling ~25 ms in (inside a realistic poll window) sees it set.
    const early = clockDivider2Kernel.init(SR);
    const earlyN = 1200; // 25 ms
    clockDivider2Kernel.process(
      early,
      [makeClock(earlyN, period, width), null],
      makeOuts(earlyN),
      params(DIV_INT, MODE_TRIG),
      earlyN,
    );
    expect(gatesOf(early) & 0b1).toBe(0b1);
  });

  it("reports no bits set before any clock edge arrives", () => {
    const state = clockDivider2Kernel.init(SR);
    clockDivider2Kernel.process(state, [null, null], makeOuts(128), params(DIV_POW2, MODE_GATE), 128);
    expect(gatesOf(state)).toBe(0);
  });
});
