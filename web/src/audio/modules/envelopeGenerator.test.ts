// @vitest-environment node

import { describe, it, expect } from "vitest";
import { envelopeGeneratorKernel } from "./envelopeGenerator";
import {
  BLOCK_FRAMES,
  GATE_HIGH_V,
  GATE_FIRE_THRESHOLD_V,
  GATE_REARM_THRESHOLD_V,
  TRIGGER_SECONDS,
} from "../engine/units";

// Param slot order matches the registry entry: A, D, S, R.
function makeParams(a: number, d: number, s: number, r: number): Float32Array {
  return new Float32Array([a, d, s, r]);
}

function makeOuts(): Float32Array[] {
  return [
    new Float32Array(BLOCK_FRAMES),
    new Float32Array(BLOCK_FRAMES),
    new Float32Array(BLOCK_FRAMES),
  ];
}

/**
 * Render `totalSamples` of the envelope in BLOCK_FRAMES chunks, driving the
 * Gate (and optionally Retrigger) inputs from per-sample volt scripts.
 * Returns the concatenated Env / Inv / EOC outputs.
 */
function renderEnvelope(opts: {
  sr?: number;
  params: Float32Array;
  totalSamples: number;
  gateAt: (sample: number) => number;
  retrigAt?: (sample: number) => number;
}): { env: Float32Array; inv: Float32Array; eoc: Float32Array } {
  const sr = opts.sr ?? 48000;
  const state = envelopeGeneratorKernel.init(sr);
  const gateBuf = new Float32Array(BLOCK_FRAMES);
  const retrigBuf = opts.retrigAt ? new Float32Array(BLOCK_FRAMES) : null;
  const outs = makeOuts();
  const env = new Float32Array(opts.totalSamples);
  const inv = new Float32Array(opts.totalSamples);
  const eoc = new Float32Array(opts.totalSamples);

  for (let start = 0; start < opts.totalSamples; start += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, opts.totalSamples - start);
    for (let i = 0; i < n; i++) {
      gateBuf[i] = opts.gateAt(start + i);
      if (retrigBuf && opts.retrigAt) retrigBuf[i] = opts.retrigAt(start + i);
    }
    envelopeGeneratorKernel.process(state, [gateBuf, retrigBuf], outs, opts.params, n);
    env.set(outs[0].subarray(0, n), start);
    inv.set(outs[1].subarray(0, n), start);
    eoc.set(outs[2].subarray(0, n), start);
  }
  return { env, inv, eoc };
}

describe("envelopeGeneratorKernel — ADSR shape", () => {
  const SR = 48000;
  // A=10ms, D=50ms, S=5V, R=50ms; gate high for 0.5 s of a 1 s render.
  const A = 0.01;
  const D = 0.05;
  const S = GATE_HIGH_V / 2;
  const R = 0.05;
  const GATE_OFF = Math.round(SR * 0.5);
  const render = renderEnvelope({
    sr: SR,
    params: makeParams(A, D, S, R),
    totalSamples: SR,
    gateAt: (i) => (i < GATE_OFF ? GATE_HIGH_V : 0),
  });

  it("attack rises toward GATE_HIGH_V", () => {
    let peak = 0;
    for (let i = 0; i < GATE_OFF; i++) if (render.env[i] > peak) peak = render.env[i];
    expect(peak).toBeGreaterThan(GATE_HIGH_V * 0.98);
    expect(peak).toBeLessThanOrEqual(GATE_HIGH_V);
  });

  it("decays toward the sustain voltage and holds while the gate stays high", () => {
    // Well after A+D (0.3 s in) the envelope should sit at sustain…
    expect(render.env[Math.round(SR * 0.3)]).toBeCloseTo(S, 1);
    // …and still be there just before the gate drops.
    expect(render.env[GATE_OFF - 1]).toBeCloseTo(S, 1);
  });

  it("releases toward 0 after the gate goes low", () => {
    // A few release times after gate-off the envelope is near silent.
    expect(render.env[GATE_OFF + Math.round(SR * R * 4)]).toBeLessThan(0.1);
    expect(render.env[SR - 1]).toBeLessThan(0.05);
  });

  it("stays within 0..GATE_HIGH_V for the whole render", () => {
    for (let i = 0; i < SR; i++) {
      expect(render.env[i]).toBeGreaterThanOrEqual(0);
      expect(render.env[i]).toBeLessThanOrEqual(GATE_HIGH_V);
    }
  });
});

describe("envelopeGeneratorKernel — segment timing", () => {
  const SR = 48000;

  it("attack peaks at approximately the A knob time", () => {
    const A = 0.05;
    const { env } = renderEnvelope({
      sr: SR,
      params: makeParams(A, 0.05, GATE_HIGH_V / 2, 0.05),
      totalSamples: Math.round(SR * 0.2),
      gateAt: () => GATE_HIGH_V, // gate high for the whole render
    });
    // τ = A / ln(100), so the one-pole reaches 99% of GATE_HIGH_V at t ≈ A,
    // where attack completes and decay starts pulling downward — the peak
    // sample marks attack completion.
    let peakAt = 0;
    for (let i = 1; i < env.length; i++) if (env[i] > env[peakAt]) peakAt = i;
    expect(peakAt).toBeGreaterThan(A * SR * 0.7);
    expect(peakAt).toBeLessThan(A * SR * 1.3);
  });

  it("attack duration scales with the A knob (10× knob ≈ 10× time)", () => {
    const timeToHalf = (a: number): number => {
      const { env } = renderEnvelope({
        sr: SR,
        params: makeParams(a, 10, GATE_HIGH_V, 10),
        totalSamples: Math.round(SR * 0.5),
        gateAt: () => GATE_HIGH_V,
      });
      for (let i = 0; i < env.length; i++) if (env[i] >= GATE_HIGH_V / 2) return i;
      return env.length;
    };
    const fast = timeToHalf(0.01);
    const slow = timeToHalf(0.1);
    expect(slow / fast).toBeGreaterThan(7);
    expect(slow / fast).toBeLessThan(13);
  });

  it("decay reaches near sustain in approximately the D knob time", () => {
    const D = 0.1;
    const S = GATE_HIGH_V / 2;
    const { env } = renderEnvelope({
      sr: SR,
      params: makeParams(0.001, D, S, 0.05),
      totalSamples: Math.round(SR * 0.4),
      gateAt: () => GATE_HIGH_V,
    });
    let peakAt = 0;
    for (let i = 1; i < env.length; i++) if (env[i] > env[peakAt]) peakAt = i;
    let settledAt = env.length;
    for (let i = peakAt; i < env.length; i++) {
      if (Math.abs(env[i] - S) <= 0.1) {
        settledAt = i;
        break;
      }
    }
    // From ~9.9 V to within 0.1 V of 5 V with τ = D/ln(100) takes
    // τ·ln(4.9/0.1) ≈ 0.85·D — allow a wide tolerance.
    const decaySamples = settledAt - peakAt;
    expect(decaySamples).toBeGreaterThan(D * SR * 0.5);
    expect(decaySamples).toBeLessThan(D * SR * 1.2);
  });

  it("release reaches near 0 in approximately the R knob time", () => {
    const R = 0.1;
    const S = GATE_HIGH_V / 2;
    const gateOff = Math.round(SR * 0.3);
    const { env } = renderEnvelope({
      sr: SR,
      params: makeParams(0.001, 0.02, S, R),
      totalSamples: Math.round(SR * 0.6),
      gateAt: (i) => (i < gateOff ? GATE_HIGH_V : 0),
    });
    let releasedAt = env.length;
    for (let i = gateOff; i < env.length; i++) {
      if (env[i] <= 0.1) {
        releasedAt = i;
        break;
      }
    }
    // From 5 V to 0.1 V with τ = R/ln(100) takes τ·ln(50) ≈ 0.85·R.
    const releaseSamples = releasedAt - gateOff;
    expect(releaseSamples).toBeGreaterThan(R * SR * 0.5);
    expect(releaseSamples).toBeLessThan(R * SR * 1.2);
  });
});

describe("envelopeGeneratorKernel — gate Schmitt hysteresis", () => {
  const SR = 48000;
  const params = () => makeParams(0.005, 0.05, GATE_HIGH_V / 2, 0.05);

  it("a gate below GATE_REARM_THRESHOLD_V never fires", () => {
    const { env } = renderEnvelope({
      sr: SR,
      params: params(),
      totalSamples: SR / 4,
      gateAt: () => GATE_REARM_THRESHOLD_V * 0.9,
    });
    for (let i = 0; i < env.length; i++) expect(env[i]).toBe(0);
  });

  it("a gate between the thresholds does not fire before ever going high", () => {
    const between = (GATE_REARM_THRESHOLD_V + GATE_FIRE_THRESHOLD_V) / 2;
    const { env } = renderEnvelope({
      sr: SR,
      params: params(),
      totalSamples: SR / 4,
      gateAt: () => between,
    });
    for (let i = 0; i < env.length; i++) expect(env[i]).toBe(0);
  });

  it("a fired gate stays high while the input hovers between the thresholds", () => {
    const between = (GATE_REARM_THRESHOLD_V + GATE_FIRE_THRESHOLD_V) / 2;
    const S = GATE_HIGH_V / 2;
    const hold = Math.round(SR * 0.25);
    const { env } = renderEnvelope({
      sr: SR,
      params: makeParams(0.005, 0.02, S, 0.005),
      totalSamples: hold * 2,
      // Fire properly, then drop into the hysteresis band.
      gateAt: (i) => (i < hold ? GATE_HIGH_V : between),
    });
    // If the band re-armed the gate, the envelope would have released to ~0.
    expect(env[env.length - 1]).toBeCloseTo(S, 1);
  });

  it("noisy values inside the hysteresis band do not chatter after re-arm", () => {
    const gateOff = Math.round(SR * 0.1);
    const { env } = renderEnvelope({
      sr: SR,
      params: makeParams(0.005, 0.05, GATE_HIGH_V / 2, 0.2),
      totalSamples: Math.round(SR * 0.5),
      gateAt: (i) => {
        if (i < gateOff) return GATE_HIGH_V;
        if (i < gateOff + 100) return 0; // clean re-arm below GATE_REARM_THRESHOLD_V
        // Deterministic "noise" strictly inside (rearm, fire) — must not re-fire.
        return GATE_REARM_THRESHOLD_V + (GATE_FIRE_THRESHOLD_V - GATE_REARM_THRESHOLD_V) * (0.2 + 0.6 * Math.abs(Math.sin(i)));
      },
    });
    // After re-arm the release must decay monotonically: any attack re-fire
    // would produce a rise.
    for (let i = gateOff + 101; i < env.length; i++) {
      expect(env[i]).toBeLessThanOrEqual(env[i - 1] + 1e-9);
    }
  });
});

describe("envelopeGeneratorKernel — retrigger", () => {
  const SR = 48000;

  it("a new gate during release re-enters attack from the current level, not 0", () => {
    const S = GATE_HIGH_V / 2;
    const gateOff = Math.round(SR * 0.2);
    const gateOn2 = Math.round(SR * 0.25); // mid-release
    const { env } = renderEnvelope({
      sr: SR,
      params: makeParams(0.02, 0.02, S, 0.2),
      totalSamples: Math.round(SR * 0.5),
      gateAt: (i) => (i < gateOff || i >= gateOn2 ? GATE_HIGH_V : 0),
    });
    const levelAtRetrigger = env[gateOn2 - 1];
    expect(levelAtRetrigger).toBeGreaterThan(1); // still audibly mid-release
    // From the retrigger on, the envelope rises from the current level —
    // it never falls below where release left it.
    for (let i = gateOn2; i < gateOn2 + Math.round(SR * 0.02); i++) {
      expect(env[i]).toBeGreaterThanOrEqual(levelAtRetrigger - 0.01);
    }
    // And it climbs back toward GATE_HIGH_V.
    let peak = 0;
    for (let i = gateOn2; i < env.length; i++) if (env[i] > peak) peak = env[i];
    expect(peak).toBeGreaterThan(GATE_HIGH_V * 0.95);
  });

  it("Retrigger rising edge while the gate is held restarts attack from the current level", () => {
    const S = GATE_HIGH_V / 2;
    const retrigAtSample = Math.round(SR * 0.3); // envelope sits at sustain by then
    const { env } = renderEnvelope({
      sr: SR,
      params: makeParams(0.02, 0.02, S, 0.05),
      totalSamples: Math.round(SR * 0.5),
      gateAt: () => GATE_HIGH_V,
      retrigAt: (i) =>
        i >= retrigAtSample && i < retrigAtSample + 48 ? GATE_HIGH_V : 0,
    });
    expect(env[retrigAtSample - 1]).toBeCloseTo(S, 1);
    // Rises again from sustain — no dip toward 0 first.
    for (let i = retrigAtSample; i < retrigAtSample + Math.round(SR * 0.01); i++) {
      expect(env[i]).toBeGreaterThanOrEqual(S - 0.1);
    }
    let peak = 0;
    for (let i = retrigAtSample; i < env.length; i++) if (env[i] > peak) peak = env[i];
    expect(peak).toBeGreaterThan(GATE_HIGH_V * 0.95);
  });
});

describe("envelopeGeneratorKernel — gate-off mid-attack", () => {
  it("releases from the mid-attack level, no jump to peak or snap to 0", () => {
    const SR = 48000;
    const A = 0.2; // slow attack so gate-off lands mid-rise
    const gateOff = Math.round(SR * 0.05);
    const { env } = renderEnvelope({
      sr: SR,
      params: makeParams(A, 0.05, GATE_HIGH_V / 2, 0.1),
      totalSamples: Math.round(SR * 0.3),
      gateAt: (i) => (i < gateOff ? GATE_HIGH_V : 0),
    });
    const levelAtGateOff = env[gateOff - 1];
    expect(levelAtGateOff).toBeGreaterThan(1); // genuinely mid-attack…
    expect(levelAtGateOff).toBeLessThan(GATE_HIGH_V * 0.9); // …not at peak
    // Release decays monotonically from that level.
    let monotone = true;
    for (let i = gateOff + 1; i < env.length; i++) {
      if (env[i] > env[i - 1] + 1e-9) monotone = false;
    }
    expect(monotone).toBe(true);
    expect(env[gateOff]).toBeLessThanOrEqual(levelAtGateOff);
    expect(env[env.length - 1]).toBeLessThan(0.1);
  });
});

describe("envelopeGeneratorKernel — EOC re-arm", () => {
  it("two full gate cycles emit exactly two EOC pulses", () => {
    const SR = 48000;
    // Two 0.1 s gates separated by enough silence for release to complete.
    const g1On = 0;
    const g1Off = Math.round(SR * 0.1);
    const g2On = Math.round(SR * 0.3);
    const g2Off = Math.round(SR * 0.4);
    const { eoc } = renderEnvelope({
      sr: SR,
      params: makeParams(0.005, 0.02, GATE_HIGH_V / 2, 0.02),
      totalSamples: Math.round(SR * 0.6),
      gateAt: (i) =>
        (i >= g1On && i < g1Off) || (i >= g2On && i < g2Off) ? GATE_HIGH_V : 0,
    });
    // Count distinct pulses (rising edges of the EOC output).
    let pulses = 0;
    for (let i = 1; i < eoc.length; i++) {
      if (eoc[i] === GATE_HIGH_V && eoc[i - 1] === 0) pulses++;
    }
    expect(pulses).toBe(2);
  });
});

describe("envelopeGeneratorKernel — no-click smoothness", () => {
  const SR = 48000;

  it("max sample-to-sample delta at gate onset is bounded by the attack time", () => {
    const A = 0.05;
    const gateOn = 1000;
    const { env } = renderEnvelope({
      sr: SR,
      params: makeParams(A, 0.05, GATE_HIGH_V / 2, 0.05),
      totalSamples: Math.round(SR * 0.2),
      gateAt: (i) => (i >= gateOn ? GATE_HIGH_V : 0),
    });
    // One-pole attack: the largest step is the first one,
    // GATE_HIGH_V · (1 − e^(−ln100/(A·sr))) ≈ 0.019 V for A = 50 ms.
    const coeff = 1 - Math.exp(-Math.log(100) / (A * SR));
    const bound = GATE_HIGH_V * coeff * 1.01;
    for (let i = 1; i < env.length; i++) {
      expect(Math.abs(env[i] - env[i - 1])).toBeLessThanOrEqual(bound);
    }
  });

  it("never jumps from 0 to GATE_HIGH_V in one sample, even at minimum attack", () => {
    const { env } = renderEnvelope({
      sr: SR,
      params: makeParams(0.001, 0.05, GATE_HIGH_V, 0.05),
      totalSamples: SR / 10,
      gateAt: () => GATE_HIGH_V,
    });
    for (let i = 1; i < env.length; i++) {
      expect(Math.abs(env[i] - env[i - 1])).toBeLessThan(GATE_HIGH_V);
    }
  });
});

describe("envelopeGeneratorKernel — Inv and EOC outputs", () => {
  const SR = 48000;

  it("Inv is the polarity-inverted envelope, sample-exact", () => {
    const gateOff = Math.round(SR * 0.2);
    const { env, inv } = renderEnvelope({
      sr: SR,
      params: makeParams(0.01, 0.05, GATE_HIGH_V / 2, 0.05),
      totalSamples: Math.round(SR * 0.4),
      gateAt: (i) => (i < gateOff ? GATE_HIGH_V : 0),
    });
    for (let i = 0; i < env.length; i++) {
      expect(inv[i]).toBe(-env[i] === 0 ? 0 : -env[i]);
    }
  });

  it("EOC fires a TRIGGER_SECONDS pulse at GATE_HIGH_V when release completes", () => {
    const gateOff = Math.round(SR * 0.2);
    const { eoc } = renderEnvelope({
      sr: SR,
      params: makeParams(0.01, 0.02, GATE_HIGH_V / 2, 0.02),
      totalSamples: Math.round(SR * 0.5),
      gateAt: (i) => (i < gateOff ? GATE_HIGH_V : 0),
    });
    // No pulse before or during the gate.
    for (let i = 0; i < gateOff; i++) expect(eoc[i]).toBe(0);
    // Exactly one pulse of round(TRIGGER_SECONDS·sr) samples after release.
    let pulseStart = -1;
    let pulseLen = 0;
    for (let i = gateOff; i < eoc.length; i++) {
      if (eoc[i] === GATE_HIGH_V) {
        if (pulseStart === -1) pulseStart = i;
        pulseLen++;
      } else if (pulseStart !== -1 && i > pulseStart + pulseLen) {
        expect(eoc[i]).toBe(0); // nothing re-fires afterwards
      }
    }
    expect(pulseStart).toBeGreaterThan(gateOff);
    expect(pulseLen).toBe(Math.round(TRIGGER_SECONDS * SR));
  });
});

describe("envelopeGeneratorKernel — safety", () => {
  const SR = 48000;

  it("non-finite gate samples read as low and never produce NaN/Inf", () => {
    const { env, inv, eoc } = renderEnvelope({
      sr: SR,
      params: makeParams(0.01, 0.05, GATE_HIGH_V / 2, 0.05),
      totalSamples: SR / 4,
      gateAt: (i) => (i % 3 === 0 ? NaN : i % 3 === 1 ? Infinity : -Infinity),
    });
    for (let i = 0; i < env.length; i++) {
      expect(Number.isFinite(env[i])).toBe(true);
      expect(Number.isFinite(inv[i])).toBe(true);
      expect(Number.isFinite(eoc[i])).toBe(true);
      expect(env[i]).toBeGreaterThanOrEqual(0);
      expect(env[i]).toBeLessThanOrEqual(GATE_HIGH_V);
    }
  });

  it("non-finite Retrigger samples read as low and do not perturb the envelope", () => {
    const gateOff = Math.round(SR * 0.15);
    const script = {
      sr: SR,
      params: makeParams(0.01, 0.05, GATE_HIGH_V / 2, 0.05),
      totalSamples: Math.round(SR * 0.3),
      gateAt: (i: number) => (i < gateOff ? GATE_HIGH_V : 0),
    };
    const clean = renderEnvelope(script);
    const dirty = renderEnvelope({
      ...script,
      retrigAt: (i) => (i % 3 === 0 ? NaN : i % 3 === 1 ? Infinity : -Infinity),
    });
    let mismatches = 0;
    for (let i = 0; i < clean.env.length; i++) {
      // Non-finite samples (incl. +Inf) read as 0 V, so Retrigger never
      // fires and the dirty render must match the clean one bit-exactly.
      if (dirty.env[i] !== clean.env[i]) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it("non-finite params fall back to defaults and outputs stay finite", () => {
    const { env } = renderEnvelope({
      sr: SR,
      params: makeParams(NaN, Infinity, NaN, -Infinity),
      totalSamples: SR / 4,
      gateAt: () => GATE_HIGH_V,
    });
    for (let i = 0; i < env.length; i++) {
      expect(Number.isFinite(env[i])).toBe(true);
      expect(env[i]).toBeGreaterThanOrEqual(0);
      expect(env[i]).toBeLessThanOrEqual(GATE_HIGH_V);
    }
    // The envelope still does something useful (attacks toward high).
    expect(env[env.length - 1]).toBeGreaterThan(1);
  });

  it("out-of-range params clamp (negative times, sustain above GATE_HIGH_V)", () => {
    const { env } = renderEnvelope({
      sr: SR,
      params: makeParams(-5, -5, GATE_HIGH_V * 3, -5),
      totalSamples: SR / 4,
      gateAt: () => GATE_HIGH_V,
    });
    for (let i = 0; i < env.length; i++) {
      expect(Number.isFinite(env[i])).toBe(true);
      expect(env[i]).toBeLessThanOrEqual(GATE_HIGH_V);
    }
  });

  it("writes every declared output for a partial block (n < BLOCK_FRAMES)", () => {
    const state = envelopeGeneratorKernel.init(SR);
    const outs = makeOuts();
    outs[0].fill(999);
    outs[1].fill(999);
    outs[2].fill(999);
    const n = 17;
    const gate = new Float32Array(BLOCK_FRAMES).fill(GATE_HIGH_V);
    envelopeGeneratorKernel.process(
      state,
      [gate, null],
      outs,
      makeParams(0.01, 0.05, GATE_HIGH_V / 2, 0.05),
      n,
    );
    for (let i = 0; i < n; i++) {
      expect(outs[0][i]).not.toBe(999);
      expect(outs[1][i]).not.toBe(999);
      expect(outs[2][i]).not.toBe(999);
    }
    // Samples beyond n are untouched.
    for (let i = n; i < BLOCK_FRAMES; i++) expect(outs[0][i]).toBe(999);
  });
});

describe("envelopeGeneratorKernel — tracer bullet", () => {
  it("idle with unpatched gate outputs 0 V on Env every sample", () => {
    const state = envelopeGeneratorKernel.init(48000);
    const outs = makeOuts();
    outs[0].fill(999);
    const params = makeParams(0.01, 0.2, GATE_HIGH_V * 0.7, 0.3);
    envelopeGeneratorKernel.process(state, [null, null], outs, params, BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      expect(outs[0][i]).toBe(0);
    }
  });
});
