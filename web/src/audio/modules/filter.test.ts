// @vitest-environment node

import { describe, it, expect } from "vitest";
import { filterKernel } from "./filter";
import { BLOCK_FRAMES, AUDIO_NORM, CV_BIPOLAR_MAX } from "../engine/units";

// Maximum output magnitude the stress test allows. Set to 2× the filter's
// state safety limit (100 V); values above this indicate runaway.
const STRESS_OUT_BOUND = 200;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

/**
 * Run the filter with a continuous sine at `freqHz` for `settleBlocks + 1`
 * total blocks; return RMS of LP / BP / HP from the final (settled) block.
 * All CV inputs default to null; `cutCVVolts` wires ins[2] to a DC buffer.
 */
function probeSteadySine(opts: {
  sr?: number;
  cutoffHz: number;
  res: number;
  freqHz: number;
  cvAmt?: number;
  trackAmt?: number;
  cutCVVolts?: number;
  settleBlocks?: number;
}): { lp: number; bp: number; hp: number } {
  const sr = opts.sr ?? 48000;
  const settleBlocks = opts.settleBlocks ?? 50;
  const n = BLOCK_FRAMES;
  const state = filterKernel.init(sr);

  const inBuf = new Float32Array(n);
  const cutCVBuf =
    opts.cutCVVolts !== undefined && opts.cutCVVolts !== 0
      ? new Float32Array(n).fill(opts.cutCVVolts)
      : null;
  const outLP = new Float32Array(n);
  const outBP = new Float32Array(n);
  const outHP = new Float32Array(n);

  const params = new Float32Array([
    opts.cutoffHz,
    opts.res,
    opts.cvAmt ?? 0,
    opts.trackAmt ?? 0,
  ]);
  const ins: (Float32Array | null)[] = [inBuf, null, cutCVBuf, null, null];
  const outs = [outLP, outBP, outHP];

  const phaseInc = (2 * Math.PI * opts.freqHz) / sr;
  let phase = 0;
  const amp = AUDIO_NORM;

  for (let b = 0; b <= settleBlocks; b++) {
    for (let i = 0; i < n; i++) {
      inBuf[i] = Math.sin(phase) * amp;
      phase += phaseInc;
    }
    filterKernel.process(state, ins, outs, params, n);
  }

  return { lp: rms(outLP), bp: rms(outBP), hp: rms(outHP) };
}

// ---------------------------------------------------------------------------
// Tracer bullet: basic init + process
// ---------------------------------------------------------------------------

describe("filterKernel — tracer bullet", () => {
  it("init returns a state object and process runs without throwing", () => {
    const state = filterKernel.init(48000);
    const ins: (Float32Array | null)[] = [null, null, null, null, null];
    const outs = [
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
      new Float32Array(BLOCK_FRAMES),
    ];
    const params = new Float32Array([1000, 0.5, 0, 0]);
    expect(() =>
      filterKernel.process(state, ins, outs, params, BLOCK_FRAMES),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Default (minimum) cutoff — an untouched filter, drawn fully left, is closed
// ---------------------------------------------------------------------------

describe("filterKernel — default minimum cutoff is closed", () => {
  it("at 20 Hz cutoff a 1 kHz tone is silenced on LP and passed on HP", () => {
    const inputRms = AUDIO_NORM / Math.SQRT2; // rms of the ±AUDIO_NORM drive
    const { lp, bp, hp } = probeSteadySine({ cutoffHz: 20, res: 0, freqHz: 1000 });
    expect(lp).toBeLessThan(inputRms * 0.05); // LP essentially closed
    expect(hp).toBeGreaterThan(inputRms * 0.7); // HP fully open
    expect(bp).toBeLessThan(hp); // BP only opens near the low corner
  });
});

// ---------------------------------------------------------------------------
// Output writing
// ---------------------------------------------------------------------------

describe("filterKernel — output writing", () => {
  it("writes all three outputs every block with unpatched input", () => {
    const state = filterKernel.init(48000);
    const n = BLOCK_FRAMES;
    const outs = [
      new Float32Array(n).fill(999),
      new Float32Array(n).fill(999),
      new Float32Array(n).fill(999),
    ];
    const params = new Float32Array([1000, 0.5, 0, 0]);
    filterKernel.process(state, [null, null, null, null, null], outs, params, n);
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(outs[0][i])).toBe(true);
      expect(Number.isFinite(outs[1][i])).toBe(true);
      expect(Number.isFinite(outs[2][i])).toBe(true);
    }
  });

  it("unpatched audio input produces silence on all outputs", () => {
    const state = filterKernel.init(48000);
    const n = BLOCK_FRAMES;
    const outs = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    const params = new Float32Array([1000, 0.5, 0, 0]);
    filterKernel.process(state, [null, null, null, null, null], outs, params, n);
    expect(rms(outs[0])).toBe(0);
    expect(rms(outs[1])).toBe(0);
    expect(rms(outs[2])).toBe(0);
  });

  it("NaN input samples are treated as 0 and produce finite outputs", () => {
    const state = filterKernel.init(48000);
    const n = BLOCK_FRAMES;
    const inBuf = new Float32Array(n).fill(NaN);
    const outs = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    const params = new Float32Array([1000, 0.5, 0, 0]);
    filterKernel.process(state, [inBuf, null, null, null, null], outs, params, n);
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(outs[0][i])).toBe(true);
      expect(Number.isFinite(outs[1][i])).toBe(true);
      expect(Number.isFinite(outs[2][i])).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// LP / HP / BP character (basic)
// ---------------------------------------------------------------------------

describe("filterKernel — LP / HP / BP character", () => {
  // cutoff = 1000 Hz; below cutoff = 200 Hz; above cutoff = 4000 Hz
  const SR = 48000;
  const CUTOFF = 1000;
  const F_LOW = 200;
  const F_HIGH = 4000;

  it("LP passes frequencies below cutoff more than frequencies above", () => {
    const low = probeSteadySine({ sr: SR, cutoffHz: CUTOFF, res: 0, freqHz: F_LOW });
    const high = probeSteadySine({ sr: SR, cutoffHz: CUTOFF, res: 0, freqHz: F_HIGH });
    // Low-frequency signal should be stronger at LP output than high-frequency signal.
    expect(low.lp).toBeGreaterThan(high.lp * 3);
  });

  it("HP passes frequencies above cutoff more than frequencies below", () => {
    const low = probeSteadySine({ sr: SR, cutoffHz: CUTOFF, res: 0, freqHz: F_LOW });
    const high = probeSteadySine({ sr: SR, cutoffHz: CUTOFF, res: 0, freqHz: F_HIGH });
    expect(high.hp).toBeGreaterThan(low.hp * 3);
  });

  it("BP output is stronger at cutoff frequency than far below or far above", () => {
    const atCutoff = probeSteadySine({ sr: SR, cutoffHz: CUTOFF, res: 0.5, freqHz: CUTOFF });
    const farBelow = probeSteadySine({ sr: SR, cutoffHz: CUTOFF, res: 0.5, freqHz: F_LOW });
    const farAbove = probeSteadySine({ sr: SR, cutoffHz: CUTOFF, res: 0.5, freqHz: F_HIGH });
    expect(atCutoff.bp).toBeGreaterThan(farBelow.bp);
    expect(atCutoff.bp).toBeGreaterThan(farAbove.bp);
  });
});

// ---------------------------------------------------------------------------
// LP rolloff slope — sine probe method
// ---------------------------------------------------------------------------

describe("filterKernel — LP rolloff (sine probes)", () => {
  // For a 2nd-order LP with low resonance:
  //   1 oct above cutoff ≈ -12 to -14 dB (amplitude factor ≈ 0.20)
  //   2 oct above cutoff ≈ -24 dB         (amplitude factor ≈ 0.06)
  //
  // We test coarse ratios only — exact dB precision is not required.
  it("LP attenuates 1-oct-above-cutoff more than pass-band", () => {
    const sr = 48000;
    const cutoffHz = 1000;
    const below = probeSteadySine({ sr, cutoffHz, res: 0, freqHz: 250 });
    const above1oct = probeSteadySine({ sr, cutoffHz, res: 0, freqHz: 2000 });
    // Pass-band RMS should be at least 3× the RMS one octave above cutoff.
    expect(below.lp).toBeGreaterThan(above1oct.lp * 3);
  });

  it("LP attenuates 2-oct-above-cutoff more than 1-oct-above", () => {
    const sr = 48000;
    const cutoffHz = 1000;
    const above1oct = probeSteadySine({ sr, cutoffHz, res: 0, freqHz: 2000 });
    const above2oct = probeSteadySine({ sr, cutoffHz, res: 0, freqHz: 4000 });
    // Rolloff increases with frequency — 2-oct-above should be weaker than 1-oct-above.
    expect(above1oct.lp).toBeGreaterThan(above2oct.lp * 2);
  });
});

// ---------------------------------------------------------------------------
// Cutoff CV law
// ---------------------------------------------------------------------------

describe("filterKernel — cutoff CV law", () => {
  it("+1 V Cut CV with CV Amt=1 shifts the effective cutoff upward by ~1 octave", () => {
    // Strategy: feed a sine at 2× base cutoff.
    // - Without CV, 2× cutoff is 1 oct above the cutoff → well attenuated by LP.
    // - With +1V CV (CV Amt=1), effective cutoff doubles → test freq is now AT the
    //   new cutoff (-3 dB point) → much less attenuated.
    // The LP amplitude with CV applied should be significantly larger.
    const sr = 48000;
    const baseCutoff = 500;
    const testFreq = 1000; // 2× baseCutoff

    const withoutCV = probeSteadySine({
      sr,
      cutoffHz: baseCutoff,
      res: 0,
      freqHz: testFreq,
      cvAmt: 1,
      cutCVVolts: 0,
    });

    const withCV = probeSteadySine({
      sr,
      cutoffHz: baseCutoff,
      res: 0,
      freqHz: testFreq,
      cvAmt: 1,
      cutCVVolts: 1,
    });

    // With +1V CV: test freq is at the new cutoff (-3 dB ≈ 0.71× amplitude).
    // Without CV: test freq is 1 oct above old cutoff (≈ 0.20× amplitude).
    // Ratio should be > 2.
    expect(withCV.lp).toBeGreaterThan(withoutCV.lp * 2);
  });
});

// ---------------------------------------------------------------------------
// Resonance stability
// ---------------------------------------------------------------------------

describe("filterKernel — resonance stability", () => {
  // Runs `durationSeconds` of audio at max resonance with deterministic noise.
  // Returns true if all outputs stayed finite and within STRESS_OUT_BOUND for
  // the entire render.
  function stressRender(cutoffHz: number, durationSeconds: number, seedInit: number): boolean {
    const sr = 48000;
    const n = BLOCK_FRAMES;
    const state = filterKernel.init(sr);
    const inBuf = new Float32Array(n);
    const outLP = new Float32Array(n);
    const outBP = new Float32Array(n);
    const outHP = new Float32Array(n);
    const params = new Float32Array([cutoffHz, 1, 0, 0]);
    const ins: (Float32Array | null)[] = [inBuf, null, null, null, null];
    const outs = [outLP, outBP, outHP];

    // Deterministic noise via a simple LCG — Lehmer-style with 32-bit-truncated
    // product and modulus 2^31 − 1. Not Park–Miller (which requires 64-bit
    // arithmetic); the truncated form has a different period and state space.
    // seed = 0 is a fixed point and is guarded against below.
    let seed = seedInit;
    const totalBlocks = Math.ceil((durationSeconds * sr) / n);

    for (let b = 0; b < totalBlocks; b++) {
      for (let i = 0; i < n; i++) {
        seed = (Math.imul(seed, 48271) >>> 0) % 2147483647;
        if (seed === 0) seed = 1; // guard degenerate fixed point
        inBuf[i] = ((seed / 2147483647) * 2 - 1) * AUDIO_NORM;
      }
      filterKernel.process(state, ins, outs, params, n);

      // Accumulate pass/fail without calling expect() inside the inner loop
      // (per-sample expect() calls dominate runtime for long renders).
      for (let i = 0; i < n; i++) {
        if (
          !Number.isFinite(outLP[i]) ||
          !Number.isFinite(outBP[i]) ||
          !Number.isFinite(outHP[i]) ||
          Math.abs(outLP[i]) > STRESS_OUT_BOUND ||
          Math.abs(outBP[i]) > STRESS_OUT_BOUND ||
          Math.abs(outHP[i]) > STRESS_OUT_BOUND
        ) {
          return false;
        }
      }
    }
    return true;
  }

  it("max resonance (res=1), 10 s render: all outputs remain finite", () => {
    expect(stressRender(1000, 10, 0x12345678)).toBe(true);
  });

  it("max resonance at high cutoff (8000 Hz), 3 s render: outputs remain finite", () => {
    expect(stressRender(8000, 3, 0xdeadbeef)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Param safety / clamping
// ---------------------------------------------------------------------------

describe("filterKernel — param safety", () => {
  function runOnce(
    params: [number, number, number, number],
    inSample?: number,
  ): { lp: number; bp: number; hp: number } {
    const state = filterKernel.init(48000);
    const n = BLOCK_FRAMES;
    const inBuf = new Float32Array(n).fill(inSample ?? AUDIO_NORM);
    const outLP = new Float32Array(n);
    const outBP = new Float32Array(n);
    const outHP = new Float32Array(n);
    const p = new Float32Array(params);
    filterKernel.process(state, [inBuf, null, null, null, null], [outLP, outBP, outHP], p, n);
    return { lp: outLP[n - 1], bp: outBP[n - 1], hp: outHP[n - 1] };
  }

  it("cutoff below min (e.g. -1 Hz) clamps to minimum and stays finite", () => {
    const r = runOnce([-1, 0.5, 0, 0]);
    expect(Number.isFinite(r.lp)).toBe(true);
    expect(Number.isFinite(r.bp)).toBe(true);
    expect(Number.isFinite(r.hp)).toBe(true);
  });

  it("cutoff above max (e.g. 100 000 Hz) clamps to sr×0.45 and stays finite", () => {
    const r = runOnce([100000, 0.5, 0, 0]);
    expect(Number.isFinite(r.lp)).toBe(true);
    expect(Number.isFinite(r.bp)).toBe(true);
    expect(Number.isFinite(r.hp)).toBe(true);
  });

  it("resonance above 1 clamps to 1 and stays finite (no blowup on first block)", () => {
    const r = runOnce([1000, 2, 0, 0]);
    expect(Number.isFinite(r.lp)).toBe(true);
    expect(Number.isFinite(r.bp)).toBe(true);
    expect(Number.isFinite(r.hp)).toBe(true);
  });

  it("NaN in Cutoff param falls back to min cutoff, outputs remain finite", () => {
    const r = runOnce([NaN, 0.5, 0, 0]);
    expect(Number.isFinite(r.lp)).toBe(true);
    expect(Number.isFinite(r.bp)).toBe(true);
    expect(Number.isFinite(r.hp)).toBe(true);
  });

  it("Infinity in Cutoff param clamps to max cutoff, outputs remain finite", () => {
    const r = runOnce([Infinity, 0.5, 0, 0]);
    expect(Number.isFinite(r.lp)).toBe(true);
    expect(Number.isFinite(r.bp)).toBe(true);
    expect(Number.isFinite(r.hp)).toBe(true);
  });

  it("NaN in Res param falls back to 0, outputs remain finite", () => {
    const r = runOnce([1000, NaN, 0, 0]);
    expect(Number.isFinite(r.lp)).toBe(true);
    expect(Number.isFinite(r.bp)).toBe(true);
    expect(Number.isFinite(r.hp)).toBe(true);
  });

  it("NaN in CV Amt param falls back to 0, outputs remain finite", () => {
    const r = runOnce([1000, 0.5, NaN, 0]);
    expect(Number.isFinite(r.lp)).toBe(true);
    expect(Number.isFinite(r.bp)).toBe(true);
    expect(Number.isFinite(r.hp)).toBe(true);
  });

  it("hot but finite input remains finite at output (no output clipping)", () => {
    // Feed a signal 10× audio nominal (well above ±5 V headroom).
    const r = runOnce([1000, 0, 0, 0], AUDIO_NORM * 10);
    expect(Number.isFinite(r.lp)).toBe(true);
    expect(Number.isFinite(r.bp)).toBe(true);
    expect(Number.isFinite(r.hp)).toBe(true);
    // Kernel must not clip — output may legally exceed AUDIO_NORM.
    expect(Math.abs(r.lp)).toBeGreaterThan(AUDIO_NORM * 0.5);
  });

  it("Res CV modulates resonance: +5 V / +2.5 V / 0 V produce monotonically stronger BP peaks", () => {
    // Verifies CV_BIPOLAR_MAX scaling: +5 V → totalRes=1.0, +2.5 V → 0.5, 0 V → 0.
    // Each configuration uses its own LP/BP/HP output buffers to avoid aliasing.
    const sr = 48000;
    const cutoffHz = 1000;
    const n = BLOCK_FRAMES;
    const settle = 50;
    const phaseInc = (2 * Math.PI * cutoffHz) / sr;
    const params = new Float32Array([cutoffHz, 0, 0, 0]);

    function bpRmsWithResCv(resCVVolts: number): number {
      const state = filterKernel.init(sr);
      const inBuf = new Float32Array(n);
      const resCVBuf = resCVVolts !== 0 ? new Float32Array(n).fill(resCVVolts) : null;
      const outLP = new Float32Array(n);
      const outBP = new Float32Array(n);
      const outHP = new Float32Array(n);
      for (let b = 0; b <= settle; b++) {
        for (let i = 0; i < n; i++) {
          inBuf[i] = Math.sin(phaseInc * (b * n + i)) * AUDIO_NORM;
        }
        filterKernel.process(state, [inBuf, null, null, null, resCVBuf], [outLP, outBP, outHP], params, n);
      }
      return rms(outBP);
    }

    const noCV   = bpRmsWithResCv(0);                    // res = 0
    const halfCV = bpRmsWithResCv(CV_BIPOLAR_MAX / 2);   // res = 0.5 (+2.5 V)
    const fullCV = bpRmsWithResCv(CV_BIPOLAR_MAX);        // res = 1.0 (+5 V)

    // More resonance = stronger BP peak at the cutoff frequency.
    expect(halfCV).toBeGreaterThan(noCV);
    expect(fullCV).toBeGreaterThan(halfCV);
  });
});
