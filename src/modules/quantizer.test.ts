// @vitest-environment node

import { describe, it, expect } from "vitest";
import { quantizerKernel } from "./quantizer";
import { BLOCK_FRAMES } from "../engine/units";

const SR = 48000;

// Scale selector positions, matching the Scale ParamSpec in registry.ts.
const CHROM = 0;
const MAJ = 1;
const MIN = 2;
const PENT = 3;
const HARM_MIN = 4;

// Volts per semitone (1 V/oct pitch CV convention, see docs/signals.md).
const SEMI = 1 / 12;

const CHROM_PCS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MAJ_PCS = [0, 2, 4, 5, 7, 9, 11];
const MIN_PCS = [0, 2, 3, 5, 7, 8, 10];
const PENT_PCS = [0, 2, 4, 7, 9];
const HARM_MIN_PCS = [0, 2, 3, 5, 7, 8, 11];

function makeParams(scale: number): Float32Array {
  return new Float32Array([scale]);
}

// Runs the kernel over one block whose input samples are `semitonesIn`
// (given in semitones, converted to volts internally), returning the output
// samples converted back to semitones for easy assertions.
function runSemitones(semitonesIn: number[], scale: number): number[] {
  const state = quantizerKernel.init(SR);
  const n = semitonesIn.length;
  const inBuf = new Float32Array(n);
  for (let i = 0; i < n; i++) inBuf[i] = semitonesIn[i] * SEMI;
  const outBuf = new Float32Array(n);
  quantizerKernel.process(state, [inBuf], [outBuf], makeParams(scale), n);
  const result: number[] = [];
  for (let i = 0; i < n; i++) result.push(outBuf[i] / SEMI);
  return result;
}

function runOneSemitone(semitoneIn: number, scale: number): number {
  return runSemitones([semitoneIn], scale)[0];
}

// ── 1. Allowed pitch classes per scale (exact passthrough) ─────────────────

describe("quantizer allowed pitch classes", () => {
  it.each([
    ["Chrom", CHROM, CHROM_PCS],
    ["Maj", MAJ, MAJ_PCS],
    ["Min", MIN, MIN_PCS],
    ["Pent", PENT, PENT_PCS],
    ["Harm Min", HARM_MIN, HARM_MIN_PCS],
  ] as const)("%s: every allowed pitch class passes through unchanged", (_name, scale, pcs) => {
    for (const pc of pcs) {
      expect(runOneSemitone(pc, scale)).toBeCloseTo(pc, 4);
    }
  });
});

// ── 2. Exact-note passthrough across octaves ────────────────────────────────

describe("quantizer exact-note passthrough", () => {
  it("an exact scale note in a non-zero octave passes through unchanged", () => {
    // C major's 7th (11) three octaves up.
    expect(runOneSemitone(11 + 36, MAJ)).toBeCloseTo(11 + 36, 4);
  });

  it("an exact scale note in a negative octave passes through unchanged", () => {
    // C major's 11 (B) at octave -2 -> semitone -13.
    expect(runOneSemitone(-13, MAJ)).toBeCloseTo(-13, 4);
  });
});

// ── 3. Notes immediately above/below a quantization boundary ───────────────

describe("quantizer boundary neighbours", () => {
  it("chromatic: semitone 11.4 (just below the C/B octave boundary) snaps to 11", () => {
    expect(runOneSemitone(11.4, CHROM)).toBeCloseTo(11, 4);
  });

  it("chromatic: semitone 11.6 (just above the boundary) snaps to 12 (next-octave C)", () => {
    expect(runOneSemitone(11.6, CHROM)).toBeCloseTo(12, 4);
  });

  it("major pentatonic: semitone 5 (between 4 and 7) snaps to 4", () => {
    expect(runOneSemitone(5, PENT)).toBeCloseTo(4, 4);
  });

  it("major pentatonic: semitone 6 (between 4 and 7) snaps to 7", () => {
    expect(runOneSemitone(6, PENT)).toBeCloseTo(7, 4);
  });
});

// ── 4. Deterministic halfway ties (prefer the higher note) ─────────────────

describe("quantizer halfway ties", () => {
  it("major: semitone 1 (midpoint of 0 and 2) resolves to the higher note (2)", () => {
    expect(runOneSemitone(1, MAJ)).toBeCloseTo(2, 4);
  });

  it("natural minor: semitone 4 (midpoint of 3 and 5) resolves to the higher note (5)", () => {
    expect(runOneSemitone(4, MIN)).toBeCloseTo(5, 4);
  });

  it("natural minor: semitone 11 (midpoint of 10 and next-octave 12) resolves to 12", () => {
    expect(runOneSemitone(11, MIN)).toBeCloseTo(12, 4);
  });

  it("harmonic minor: semitone 9.5 (midpoint of 8 and 11) resolves to the higher note (11)", () => {
    expect(runOneSemitone(9.5, HARM_MIN)).toBeCloseTo(11, 4);
  });
});

// ── 5. C/B octave-boundary transitions ──────────────────────────────────────

describe("quantizer octave boundary transitions", () => {
  it("harmonic minor: semitone 11 (the raised 7th) passes through unchanged", () => {
    expect(runOneSemitone(11, HARM_MIN)).toBeCloseTo(11, 4);
  });

  it("chromatic: semitone 11 passes through unchanged (B), semitone 12 is next-octave C", () => {
    expect(runOneSemitone(11, CHROM)).toBeCloseTo(11, 4);
    expect(runOneSemitone(12, CHROM)).toBeCloseTo(12, 4);
  });

  it("major: an input just below C wraps down to the previous octave's 11 (B)", () => {
    // -1.3 semitones: nearest major note is pc 11 at octave -1 (== -1), not pc 0 (== 0).
    expect(runOneSemitone(-1.3, MAJ)).toBeCloseTo(-1, 4);
  });
});

// ── 6. Negative CV octaves ───────────────────────────────────────────────────

describe("quantizer negative CV octaves", () => {
  it("chromatic: one octave below C4 (-1 V) quantizes to itself", () => {
    expect(runOneSemitone(-12, CHROM)).toBeCloseTo(-12, 4);
  });

  it("chromatic: two octaves below C4 (-2 V) quantizes to itself", () => {
    expect(runOneSemitone(-24, CHROM)).toBeCloseTo(-24, 4);
  });

  it("major: a non-exact note two octaves down snaps within that octave", () => {
    // -24.3 semitones is closest to major's 0 at octave -2 (-24).
    expect(runOneSemitone(-24.3, MAJ)).toBeCloseTo(-24, 4);
  });
});

// ── 7. Chromatic quantization in semitone increments ────────────────────────

describe("quantizer chromatic increments", () => {
  it("quantizes arbitrary fractional volts to the nearest whole semitone", () => {
    for (let s = -6; s <= 6; s++) {
      expect(runOneSemitone(s + 0.2, CHROM)).toBeCloseTo(s, 4);
      expect(runOneSemitone(s - 0.2, CHROM)).toBeCloseTo(s, 4);
    }
  });
});

// ── 8. Major vs. natural minor distinctions ─────────────────────────────────

describe("quantizer major vs natural minor", () => {
  it("semitone 3 (minor third) is exact in natural minor but ties toward 4 in major", () => {
    expect(runOneSemitone(3, MIN)).toBeCloseTo(3, 4);
    expect(runOneSemitone(3, MAJ)).toBeCloseTo(4, 4);
  });

  it("semitone 8 (minor sixth) is exact in natural minor but ties toward 9 in major", () => {
    expect(runOneSemitone(8, MIN)).toBeCloseTo(8, 4);
    // Major has no 8 (7 and 9 are equidistant) — tie resolves to the higher note.
    expect(runOneSemitone(8, MAJ)).toBeCloseTo(9, 4);
  });
});

// ── 9. Major pentatonic behaviour ───────────────────────────────────────────

describe("quantizer major pentatonic", () => {
  it("has no 4th/6th scale degrees — 5 and 8 both snap to pentatonic neighbours", () => {
    expect(runOneSemitone(4, PENT)).toBeCloseTo(4, 4); // exact (major 3rd IS in pentatonic)
    expect(runOneSemitone(5, PENT)).toBeCloseTo(4, 4); // 4th snaps down to the 3rd
    // 8 is equidistant between 7 and 9 (no 6th in pentatonic) — tie resolves higher.
    expect(runOneSemitone(8, PENT)).toBeCloseTo(9, 4);
  });
});

// ── 10. Harm Min (formerly "User") maps to C harmonic minor ────────────────

describe("quantizer Harm Min position", () => {
  it("matches the C harmonic minor pitch-class set exactly, including the raised 7th", () => {
    for (const pc of HARM_MIN_PCS) {
      expect(runOneSemitone(pc, HARM_MIN)).toBeCloseTo(pc, 4);
    }
    // The raised 7th (11) distinguishes it from natural minor's 10.
    expect(runOneSemitone(10, HARM_MIN)).not.toBeCloseTo(10, 1);
  });
});

// ── 11. Silence / 0 V produces C ────────────────────────────────────────────

describe("quantizer silence", () => {
  it.each([CHROM, MAJ, MIN, PENT, HARM_MIN])("0 V quantizes to C (0 V) for scale %i", (scale) => {
    expect(runOneSemitone(0, scale)).toBeCloseTo(0, 4);
  });
});

// ── 12. Extreme finite input values ─────────────────────────────────────────

describe("quantizer extreme finite inputs", () => {
  it("a very large positive voltage stays finite and lands on an allowed pitch class", () => {
    const outSemi = runOneSemitone(1_000_000, MAJ);
    expect(Number.isFinite(outSemi)).toBe(true);
    const pcOut = ((Math.round(outSemi) % 12) + 12) % 12;
    expect(MAJ_PCS).toContain(pcOut);
  });

  it("a very large negative voltage stays finite and lands on an allowed pitch class", () => {
    const outSemi = runOneSemitone(-1_000_000, MIN);
    expect(Number.isFinite(outSemi)).toBe(true);
    const pcOut = ((Math.round(outSemi) % 12) + 12) % 12;
    expect(MIN_PCS).toContain(pcOut);
  });

  it("Number.MAX_VALUE input does not produce NaN or Infinity", () => {
    const state = quantizerKernel.init(SR);
    const inBuf = new Float32Array(1).fill(Number.MAX_VALUE);
    const outBuf = new Float32Array(1);
    quantizerKernel.process(state, [inBuf], [outBuf], makeParams(CHROM), 1);
    expect(Number.isFinite(outBuf[0])).toBe(true);
  });
});

// ── 13. Invalid selector values ──────────────────────────────────────────────

describe("quantizer invalid Scale selector values", () => {
  it("NaN selector falls back to Chrom (index 0)", () => {
    const state = quantizerKernel.init(SR);
    const inBuf = new Float32Array(1).fill(3 * SEMI); // 3 is not in Chrom... it is (chromatic has all)
    const outBuf = new Float32Array(1);
    quantizerKernel.process(state, [inBuf], [outBuf], new Float32Array([NaN]), 1);
    expect(outBuf[0]).toBeCloseTo(3 * SEMI, 4);
  });

  it("negative selector clamps to Chrom (index 0)", () => {
    expect(runOneSemitone(1.4, -3)).toBeCloseTo(1, 4); // chromatic nearest-integer behaviour
  });

  it("out-of-range selector (10) clamps to the last position (Harm Min)", () => {
    for (const pc of HARM_MIN_PCS) {
      expect(runOneSemitone(pc, 10)).toBeCloseTo(pc, 4);
    }
  });

  it("Infinity selector falls back safely (clamped, does not throw or emit NaN)", () => {
    const out = runOneSemitone(2, Infinity);
    expect(Number.isFinite(out)).toBe(true);
  });
});

// ── 14. No NaN or Infinity in output ────────────────────────────────────────

describe("quantizer safety", () => {
  it("NaN input samples do not produce NaN output", () => {
    const state = quantizerKernel.init(SR);
    const inBuf = new Float32Array(BLOCK_FRAMES).fill(NaN);
    const outBuf = new Float32Array(BLOCK_FRAMES);
    quantizerKernel.process(state, [inBuf], [outBuf], makeParams(MAJ), BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Number.isFinite(outBuf[i])).toBe(true);
    }
  });

  it("Infinity input samples do not produce NaN or Infinity output", () => {
    const state = quantizerKernel.init(SR);
    const inBuf = new Float32Array(BLOCK_FRAMES).fill(Infinity);
    const outBuf = new Float32Array(BLOCK_FRAMES);
    quantizerKernel.process(state, [inBuf], [outBuf], makeParams(MIN), BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Number.isFinite(outBuf[i])).toBe(true);
    }
  });

  it("unpatched input (null) produces C (0 V), not NaN", () => {
    const state = quantizerKernel.init(SR);
    const outBuf = new Float32Array(BLOCK_FRAMES);
    quantizerKernel.process(state, [null], [outBuf], makeParams(CHROM), BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(outBuf[i]).toBe(0);
    }
  });

  it("all output samples written every block (sentinel overwrite)", () => {
    const state = quantizerKernel.init(SR);
    const inBuf = new Float32Array(BLOCK_FRAMES).fill(2.3 * SEMI);
    const outBuf = new Float32Array(BLOCK_FRAMES).fill(99);
    quantizerKernel.process(state, [inBuf], [outBuf], makeParams(MAJ), BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(outBuf[i]).not.toBe(99);
    }
  });
});
