// @vitest-environment node

import { describe, it, expect } from "vitest";
import { lowPassGateKernel } from "./lowPassGate";
import { registry } from "./registry";
import { BLOCK_FRAMES, CV_UNIPOLAR_MAX, GATE_HIGH_V } from "../engine/units";

const SR = 48000;

// Mode positions (seed order): VCA, LPG, Both — see registry.ts / lowPassGate.ts.
const MODE_VCA = 0;
const MODE_LPG = 1;
const MODE_BOTH = 2;

function makeOuts(): Float32Array[] {
  return [new Float32Array(BLOCK_FRAMES)];
}

/**
 * Renders `totalSamples` of Out in BLOCK_FRAMES chunks from scripted
 * per-sample In / CV / Strike volt scripts and a fixed Mode, starting from a
 * fresh kernel state. Omitting `cvAt`/`strikeAt` passes a genuine `null` jack
 * for that input (truly unpatched), not a buffer filled with 0 V.
 */
function render(opts: {
  sr?: number;
  totalSamples: number;
  mode: number;
  inAt: (sample: number) => number;
  cvAt?: (sample: number) => number;
  strikeAt?: (sample: number) => number;
}): Float32Array {
  const sr = opts.sr ?? SR;
  const state = lowPassGateKernel.init(sr);
  const inBuf = new Float32Array(BLOCK_FRAMES);
  const cvBuf = opts.cvAt ? new Float32Array(BLOCK_FRAMES) : null;
  const strikeBuf = opts.strikeAt ? new Float32Array(BLOCK_FRAMES) : null;
  const outs = makeOuts();
  const out = new Float32Array(opts.totalSamples);
  const params = new Float32Array(1);
  params[0] = opts.mode;

  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      inBuf[i] = opts.inAt(start + i);
      if (cvBuf) cvBuf[i] = opts.cvAt!(start + i);
      if (strikeBuf) strikeBuf[i] = opts.strikeAt!(start + i);
    }
    lowPassGateKernel.process(state, [inBuf, cvBuf, strikeBuf], outs, params, n);
    out.set(outs[0].subarray(0, n), start);
  }
  return out;
}

function rms(buf: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / (end - start));
}

/**
 * First-difference RMS: a cheap high-band energy proxy (one-sample high-pass).
 * Robust for comparing brightness between renders without asserting exact
 * spectra or samples.
 */
function diffRms(buf: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start + 1; i < end; i++) {
    const d = buf[i] - buf[i - 1];
    sum += d * d;
  }
  return Math.sqrt(sum / (end - start - 1));
}

// Harmonically rich test material: naive 220 Hz saw at ±4 V. Aliasing is
// irrelevant here — we only compare relative energy between renders of the
// same signal. A sine cannot reveal lowpass tone differences, so saw is the
// primary mode-separation material (per the LPG voicing QA follow-up).
const saw = (i: number) => 4 * (2 * (((i * 220) / SR) % 1) - 1);

describe("seed confirmation", () => {
  it("registry entry matches the seeded low-pass-gate jack/control names", () => {
    const entry = registry.get("low-pass-gate");
    expect(entry?.inJacks).toEqual(["In", "CV", "Strike"]);
    expect(entry?.outJacks).toEqual(["Out"]);
    expect(Object.keys(entry?.params ?? {})).toEqual(["Mode"]);
    expect(entry?.params.Mode.positions).toEqual(["VCA", "LPG", "Both"]);
  });
});

describe("closed gate (In patched, CV genuinely unpatched, no Strike)", () => {
  it("Mode=VCA settles to near-silence on a sustained input", () => {
    const out = render({ totalSamples: 4000, mode: MODE_VCA, inAt: () => 4 });
    expect(Math.abs(out[out.length - 1])).toBeLessThan(1e-3);
  });

  it("Mode=LPG settles to near-silence on a sustained input", () => {
    // This is the mode most at risk of leaking sustained/DC signal through
    // when closed, since a bare lowpass has unity DC gain regardless of
    // cutoff — LPG's amp multiply is what must gate it to silence here.
    const out = render({ totalSamples: 4000, mode: MODE_LPG, inAt: () => 4 });
    expect(Math.abs(out[out.length - 1])).toBeLessThan(1e-3);
  });

  it("Mode=Both settles to near-silence on a sustained input", () => {
    const out = render({ totalSamples: 4000, mode: MODE_BOTH, inAt: () => 4 });
    expect(Math.abs(out[out.length - 1])).toBeLessThan(1e-3);
  });
});

describe("true unpatched CV (null jack, not a 0 V buffer)", () => {
  it("stays closed with In patched and CV genuinely unpatched, opens on Strike, then closes again", () => {
    const strikeAtSample = 5000;
    const totalSamples = strikeAtSample + Math.round(1.5 * SR); // ~5 decay time constants after the strike
    const out = render({
      totalSamples,
      mode: MODE_LPG,
      inAt: () => 4,
      // cvAt intentionally omitted: CV is a real null jack throughout.
      strikeAt: (i) => (i === strikeAtSample ? GATE_HIGH_V : 0),
    });
    // Closed before the strike — CV was never patched.
    expect(Math.abs(out[strikeAtSample - 1])).toBeLessThan(1e-3);
    // The strike opens it, even with CV still unpatched.
    expect(Math.abs(out[strikeAtSample + 10])).toBeGreaterThan(1);
    // With CV still unpatched (closed target), it decays back to silence.
    expect(Math.abs(out[totalSamples - 1])).toBeLessThan(0.05);
  });
});

describe("CV patched at a real 0 V buffer (not null)", () => {
  // Exercises the inCv !== null branch (line-read v === 0), distinct from
  // the "true unpatched CV" (null jack) cases above — both must close the
  // gate, but only these actually read a real sample of 0. Regression guard
  // across all three modes.
  it("Mode=VCA stays closed with CV explicitly reading 0 V every sample", () => {
    const out = render({ totalSamples: 4000, mode: MODE_VCA, inAt: () => 4, cvAt: () => 0 });
    expect(Math.abs(out[out.length - 1])).toBeLessThan(1e-3);
  });

  it("Mode=LPG stays closed with CV explicitly reading 0 V every sample", () => {
    const out = render({ totalSamples: 4000, mode: MODE_LPG, inAt: () => 4, cvAt: () => 0 });
    expect(Math.abs(out[out.length - 1])).toBeLessThan(1e-3);
  });

  it("Mode=Both stays closed with CV explicitly reading 0 V every sample", () => {
    const out = render({ totalSamples: 4000, mode: MODE_BOTH, inAt: () => 4, cvAt: () => 0 });
    expect(Math.abs(out[out.length - 1])).toBeLessThan(1e-3);
  });
});

describe("CV opens the gate", () => {
  it("fully open CV (10 V) settles to pass a sustained input at near-full amplitude", () => {
    const out = render({
      totalSamples: 4000,
      mode: MODE_BOTH,
      inAt: () => 4,
      cvAt: () => CV_UNIPOLAR_MAX,
    });
    expect(out[out.length - 1]).toBeGreaterThan(3.9);
  });

  it("partial CV attenuates and darkens the signal more than amplitude scaling alone", () => {
    // A sine well above the half-open cutoff (level = 0.5 → 40 + 0.125 × 3960
    // ≈ 535 Hz) so the filter rolls it off in addition to the amp multiply.
    // (Sine is fine here: this test isolates roll-off depth at one frequency,
    // not mode-vs-mode timbre separation.)
    const freqHz = 6000;
    const sine = (i: number) => 4 * Math.sin((2 * Math.PI * freqHz * i) / SR);

    const full = render({ totalSamples: 6000, mode: MODE_BOTH, inAt: sine, cvAt: () => CV_UNIPOLAR_MAX });
    const half = render({ totalSamples: 6000, mode: MODE_BOTH, inAt: sine, cvAt: () => CV_UNIPOLAR_MAX / 2 });

    // Skip the filter's settling transient.
    const fullRms = rms(full, 2000, 6000);
    const halfRms = rms(half, 2000, 6000);
    expect(fullRms).toBeGreaterThan(0.5);

    // Regression guard for audible darkening, not an exact voicing lock: the
    // 0.25 bound is the *analytic amplitude-only prediction* (amp = level² =
    // 0.5² = 0.25), so any measured ratio below it proves the filter darkens
    // on top of the amp multiply — with the filter bypassed the ratio would
    // sit at exactly 0.25, which is why the bound must not be "relaxed"
    // upward. Under the current voicing (open ≈ 4 kHz, level³ curve) the
    // ratio measures ≈ 0.22 in Both mode; the margin is inherently modest
    // here because half of Both's blend bypasses the filter. A future retune
    // that narrows it further should reconsider the source material or mode,
    // not the bound.
    const ratio = halfRms / fullRms;
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(0.25);
  });
});

describe("Strike pluck", () => {
  it("produces a decaying pluck from a sustained input with no CV (Mode=LPG, the gated response)", () => {
    // Default decay time constant is ~0.3 s; render several time constants
    // (~1.5 s) so the amp-squared tail is unambiguously settled to silence.
    const totalSamples = Math.round(1.5 * SR);
    const out = render({
      totalSamples,
      mode: MODE_LPG,
      inAt: () => 4,
      strikeAt: (i) => (i === 0 ? GATE_HIGH_V : 0),
    });
    // Peaks near the strike, then decays toward silence.
    expect(Math.abs(out[10])).toBeGreaterThan(Math.abs(out[5000]));
    expect(Math.abs(out[5000])).toBeGreaterThan(Math.abs(out[totalSamples - 1]));
    expect(Math.abs(out[totalSamples - 1])).toBeLessThan(0.05);
  });

  it("produces a decaying pluck under Mode=Both too", () => {
    const totalSamples = Math.round(1.5 * SR);
    const out = render({
      totalSamples,
      mode: MODE_BOTH,
      inAt: () => 4,
      strikeAt: (i) => (i === 0 ? GATE_HIGH_V : 0),
    });
    expect(Math.abs(out[10])).toBeGreaterThan(Math.abs(out[5000]));
    expect(Math.abs(out[5000])).toBeGreaterThan(Math.abs(out[totalSamples - 1]));
    expect(Math.abs(out[totalSamples - 1])).toBeLessThan(0.05);
  });

  it("pluck on a saw decays in loudness AND brightness together, and is not a one-block blip", () => {
    // CV genuinely unpatched; one Strike edge at sample 0; rich material so
    // the brightness trajectory is measurable. Windows are ~50 ms each.
    const totalSamples = Math.round(1.5 * SR);
    const out = render({
      totalSamples,
      mode: MODE_LPG,
      inAt: saw,
      strikeAt: (i) => (i === 0 ? GATE_HIGH_V : 0),
    });

    const w = Math.round(0.05 * SR); // 50 ms window
    const early = { start: Math.round(0.01 * SR), end: Math.round(0.01 * SR) + w };
    const mid = { start: Math.round(0.2 * SR), end: Math.round(0.2 * SR) + w };
    const late = { start: Math.round(0.5 * SR), end: Math.round(0.5 * SR) + w };

    // Non-silent, and clearly still sounding well past the first block
    // (BLOCK_FRAMES is ~2.7 ms at 48 kHz — a pluck must far outlive it).
    const earlyRms = rms(out, early.start, early.end);
    const midRms = rms(out, mid.start, mid.end);
    const lateRms = rms(out, late.start, late.end);
    expect(earlyRms).toBeGreaterThan(0.5);
    expect(midRms).toBeGreaterThan(0.02); // audible tail at 200 ms, not a blip

    // Loudness decays monotonically across the windows…
    expect(earlyRms).toBeGreaterThan(midRms);
    expect(midRms).toBeGreaterThan(lateRms);

    // …and brightness (high-band share of the energy) decays too: the
    // level³ cutoff curve darkens the sound during the audible part of the
    // decay, not after it.
    const earlyBright = diffRms(out, early.start, early.end) / earlyRms;
    const midBright = diffRms(out, mid.start, mid.end) / midRms;
    expect(midBright).toBeLessThan(earlyBright * 0.7);

    // …and it does not sustain forever.
    expect(rms(out, totalSamples - w, totalSamples)).toBeLessThan(0.01);
  });

  it("uses Schmitt behavior: sustained high fires once, rearm required before retrigger", () => {
    // Strike held high the whole time: only the first rising edge (sample 0)
    // should fire. Level then decays; it must NOT jump back to 1 later while
    // Strike is still continuously high.
    const heldHighOut = render({
      totalSamples: 10000,
      mode: MODE_VCA, // amp-only output makes the level trajectory directly legible
      inAt: () => 4,
      strikeAt: () => GATE_HIGH_V,
    });
    // Strictly decreasing (monotonic decay) after the initial strike — proof
    // there is no second retrigger bump while Strike stays high.
    for (let i = 10; i + 500 < heldHighOut.length; i += 500) {
      expect(Math.abs(heldHighOut[i])).toBeGreaterThanOrEqual(Math.abs(heldHighOut[i + 500]) - 1e-9);
    }

    // Now rearm (drop below GATE_REARM_THRESHOLD_V) then re-fire: this SHOULD
    // jump back to peak.
    const rearmOut = render({
      totalSamples: 10000,
      mode: MODE_VCA,
      inAt: () => 4,
      strikeAt: (i) => {
        if (i === 0) return GATE_HIGH_V;
        if (i < 5000) return 0; // well below GATE_REARM_THRESHOLD_V
        return GATE_HIGH_V; // re-fire at sample 5000
      },
    });
    expect(Math.abs(rearmOut[5001])).toBeGreaterThan(Math.abs(rearmOut[4999]));
  });
});

describe("Mode switch", () => {
  it("VCA mode bypasses the filter: output tracks input instantaneously when open", () => {
    const inAt = (i: number) => (i % 2 === 0 ? 3 : -3);
    const out = render({ totalSamples: 200, mode: MODE_VCA, inAt, cvAt: () => CV_UNIPOLAR_MAX });
    // Fully open (level ≈ 1 quickly): output should equal input directly,
    // sample for sample, with no filter lag.
    for (let i = 50; i < 200; i++) {
      expect(out[i]).toBeCloseTo(inAt(i), 1);
    }
  });

  it("LPG mode gates the signal: closed is silent, open passes near-full amplitude, partial level attenuates", () => {
    const open = render({
      totalSamples: 6000,
      mode: MODE_LPG,
      inAt: () => 4,
      cvAt: () => CV_UNIPOLAR_MAX,
    });
    expect(open[open.length - 1]).toBeGreaterThan(3.9);

    const partial = render({
      totalSamples: 6000,
      mode: MODE_LPG,
      inAt: () => 4,
      cvAt: () => CV_UNIPOLAR_MAX / 2,
    });
    // cvOpen = 0.5 -> level settles to 0.5 -> amp = 0.25 -> settled ~1 V.
    expect(partial[partial.length - 1]).toBeGreaterThan(0.8);
    expect(partial[partial.length - 1]).toBeLessThan(1.2);
  });

  it("Both mode gates the signal too: partial level attenuates similarly to LPG", () => {
    const out = render({
      totalSamples: 6000,
      mode: MODE_BOTH,
      inAt: () => 4,
      cvAt: () => CV_UNIPOLAR_MAX / 2,
    });
    // For a sustained/DC input the filtered path converges to the same
    // value as the raw input, so Both's blend collapses to the same settled
    // amplitude as LPG-only here; the modes are distinguished by their
    // *frequency response* instead (see "Mode distinction" below).
    expect(out[out.length - 1]).toBeGreaterThan(0.8);
    expect(out[out.length - 1]).toBeLessThan(1.2);
  });

  it("Mode distinction on a saw: LPG has clearly less high-band energy than VCA; Both sits between", () => {
    // Harmonically rich input (saw) at the same fully-open level in all three
    // modes; brightness compared via first-difference (high-band) energy.
    // Fully open the cutoff is ~4 kHz, so LPG mode must audibly darken a saw
    // even at full level — the core fix of the LPG voicing QA follow-up.
    const totalSamples = 12000;

    const vcaOut = render({ totalSamples, mode: MODE_VCA, inAt: saw, cvAt: () => CV_UNIPOLAR_MAX });
    const lpgOut = render({ totalSamples, mode: MODE_LPG, inAt: saw, cvAt: () => CV_UNIPOLAR_MAX });
    const bothOut = render({ totalSamples, mode: MODE_BOTH, inAt: saw, cvAt: () => CV_UNIPOLAR_MAX });

    // Skip the level-rise + filter settling transient.
    const vcaHf = diffRms(vcaOut, 4000, totalSamples);
    const lpgHf = diffRms(lpgOut, 4000, totalSamples);
    const bothHf = diffRms(bothOut, 4000, totalSamples);

    // LPG is *clearly* darker than VCA, not marginally.
    expect(lpgHf).toBeLessThan(vcaHf * 0.5);
    // Both sits distinguishably between the two, with margin on both sides.
    expect(bothHf).toBeLessThan(vcaHf * 0.9);
    expect(bothHf).toBeGreaterThan(lpgHf * 1.1);

    // Overall loudness stays comparable — the separation is timbral, not a
    // volume drop (DC-adjacent/low-harmonic content passes in every mode).
    const vcaRms = rms(vcaOut, 4000, totalSamples);
    const lpgRms = rms(lpgOut, 4000, totalSamples);
    expect(lpgRms).toBeGreaterThan(vcaRms * 0.5);
  });

  it("live Mode switching stays finite and non-explosive while a gated voice plays", () => {
    // Regression guard for the always-running filter state: cycle Mode every
    // block while fully open on a saw; output must stay finite and bounded
    // (no runaway/explosion). Exact per-sample values are not asserted.
    const state = lowPassGateKernel.init(SR);
    const inBuf = new Float32Array(BLOCK_FRAMES);
    const cvBuf = new Float32Array(BLOCK_FRAMES).fill(CV_UNIPOLAR_MAX);
    const outs = makeOuts();
    const params = new Float32Array(1);

    const blocks = 60;
    for (let b = 0; b < blocks; b++) {
      for (let i = 0; i < BLOCK_FRAMES; i++) inBuf[i] = saw(b * BLOCK_FRAMES + i);
      params[0] = b % 3; // VCA → LPG → Both, switching every block
      lowPassGateKernel.process(state, [inBuf, cvBuf, null], outs, params, BLOCK_FRAMES);
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        expect(Number.isFinite(outs[0][i])).toBe(true);
        expect(Math.abs(outs[0][i])).toBeLessThan(10); // input is ±4 V; nothing should blow up
      }
    }
  });
});

describe("safety", () => {
  it("output stays finite for non-finite In/CV/Strike/Mode", () => {
    const state = lowPassGateKernel.init(SR);
    const inBuf = new Float32Array(BLOCK_FRAMES).fill(NaN);
    const cvBuf = new Float32Array(BLOCK_FRAMES).fill(Infinity);
    const strikeBuf = new Float32Array(BLOCK_FRAMES).fill(-Infinity);
    const outs = makeOuts();
    const params = new Float32Array([NaN]);

    lowPassGateKernel.process(state, [inBuf, cvBuf, strikeBuf], outs, params, BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Number.isFinite(outs[0][i])).toBe(true);
    }
  });

  it("handles unpatched jacks (null) safely", () => {
    const state = lowPassGateKernel.init(SR);
    const outs = makeOuts();
    const params = new Float32Array([MODE_BOTH]);
    lowPassGateKernel.process(state, [null, null, null], outs, params, BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(outs[0][i]).toBe(0);
    }
  });

  it("process() writes every output sample every block", () => {
    const state = lowPassGateKernel.init(SR);
    const inBuf = new Float32Array(BLOCK_FRAMES).fill(1);
    const cvBuf = new Float32Array(BLOCK_FRAMES).fill(CV_UNIPOLAR_MAX);
    const strikeBuf = new Float32Array(BLOCK_FRAMES).fill(0);
    const outs = makeOuts();
    outs[0].fill(NaN); // poison the buffer first so untouched samples would show up
    const params = new Float32Array([MODE_BOTH]);
    lowPassGateKernel.process(state, [inBuf, cvBuf, strikeBuf], outs, params, BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(Number.isNaN(outs[0][i])).toBe(false);
    }
  });
});
