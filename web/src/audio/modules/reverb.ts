// Stereo reverb kernel for slug "reverb" (GH #83).
//
// Topology: Dattorro-style figure-of-eight tank ("Effect Design Part 1",
// J. Dattorro, JAES 1997 — published mathematical structure, clean-room
// implementation, no GPL-derived code, no hardware modeling): per-channel
// pre-delay → bandwidth one-pole lowpass → 4 series input-diffusion allpasses,
// injected into a two-branch recirculating tank (modulated allpass → delay →
// damping lowpass → ×decay → allpass → delay, each branch cross-feeding the
// other), with the stereo outputs summed from 7 decorrelated taps per side.
//
// Jack layout (seed declaration order):
//   ins[0] = In L     — audio input; null → mono-normalled from In R
//   ins[1] = In R     — audio input; null → mono-normalled from In L
//   ins[2] = Time CV  — decay CV (seed group "Decay"); null → 0 V;
//                       ±CV_BIPOLAR_MAX spans the full 0..1 Decay range
//   outs[0] = Out L   outs[1] = Out R
//   params[0] = Preset   (positions: 0 Room, 1 Hall, 2 Plate)
//   params[1] = PreDelay (0..0.25 s, linear)
//   params[2] = Size     (0..1)   params[3] = Decay (0..1)
//   params[4] = Damp     (0..1)   params[5] = Mix   (0..1)
//
// Preset semantics: the kernel receives the preset ONLY as the numeric switch
// index — never a name — and uses it to index the hidden per-preset tables
// below (input/decay diffusion gains, bandwidth, tank modulation, input mode).
// The five visible params arrive as ordinary numeric params; the UI batch-sets
// them when the switch changes (web/src/audio/modules/reverbPresets.ts).
//
// Input modes (hidden, per preset): Room/Hall are stereo-fed — the L channel
// injects into tank branch A and R into branch B. Plate is mono-fed — both
// branches receive 0.5·(L+R), the classic mono-in plate model — but the output
// taps always straddle both branches, so every mode is stereo out.
//
// Size scales every tank delay/tap length by SIZE_MIN_FACTOR..1 (buffers are
// allocated for Size = 1 in init; per-block integer rescale, so a moving Size
// knob shifts read taps — a coarse pitch warble while turning is accepted v1
// behavior). Decay maps to a loop gain strictly below 1 (DECAY_GAIN_MAX), and
// the branch feedback sum is hard-clamped (±REVERB_STATE_LIMIT_V, numerical
// safety only), so the tank is unconditionally stable and cannot propagate
// NaN/Infinity: non-finite inputs read as 0, non-finite params fall back to
// their spec default upstream (interpreter clamp) and are re-guarded here.

import type { Kernel } from "../engine/kernel";
import { CV_BIPOLAR_MAX } from "../engine/units";

// ── Hidden per-preset DSP tables (index = Preset switch position) ────────────
// Companion to REVERB_PRESET_VISIBLE in reverbPresets.ts (kept there for the
// UI; kept here for the kernel so the import graph stays acyclic). Values are
// initial musical guesses per GH #83.        Room   Hall   Plate
const PRE_DIFFUSE_1 = [0.55, 0.75, 0.85]; // input diffusion stage 1 gain
const PRE_DIFFUSE_2 = [0.45, 0.65, 0.75]; // input diffusion stage 2 gain
const DECAY_DIFFUSE_1 = [0.55, 0.7, 0.8]; // tank diffusion 1 gain (negated)
const DECAY_DIFFUSE_2 = [0.35, 0.5, 0.6]; // tank diffusion 2 gain
const BANDWIDTH = [0.95, 0.85, 0.9]; // input one-pole lowpass coefficient
const MOD_RATE_HZ = [0.5, 1.0, 1.8]; // tank allpass modulation rate
const MOD_DEPTH_S = [0.0002, 0.0006, 0.0009]; // tank allpass modulation depth
const MONO_INPUT = [0, 0, 1]; // 1 = mono-fed tank (plate)

// ── Reverb design constants (module-local; not signal-standard values) ──────
const PRESET_COUNT = 3;
const PRE_DELAY_MAX_S = 0.25; // must cover the PreDelay ParamSpec max
const SIZE_MIN_FACTOR = 0.25; // tank scale at Size = 0
const DECAY_GAIN_MIN = 0.2; // loop gain at Decay = 0
const DECAY_GAIN_MAX = 0.98; // loop gain at Decay = 1 — strictly < 1
const DAMP_COEF_MAX = 0.99; // damping one-pole coefficient at Damp = 1
const OUT_TAP_GAIN = 0.6; // wet output tap weighting (Dattorro)
const REVERB_STATE_LIMIT_V = 100; // tank hard clamp — numerical safety only
const TWO_PI = 2 * Math.PI;
// Shared sample counter wrap: a power of two that every line mask divides.
const COUNTER_WRAP = 1 << 30;

// Reference sample rate the length tables below are expressed at (Dattorro's
// 29.761 kHz); init() rescales everything to the environment rate.
const REF_SR = 29761;

// Line indices into ReverbState.bufs/masks/baseLen/len.
//  0..3  pre-diffusion allpasses, channel A     4..7  same, channel B
//  8..11 tank branch A: mod-allpass, delay 1, allpass 2, delay 2
// 12..15 tank branch B: mod-allpass, delay 1, allpass 2, delay 2
// 16..17 pre-delay L / R
const LINE_COUNT = 18;
const TANK_FIRST = 8;
const TANK_LAST = 15;
// Lengths in samples at REF_SR. Channel B pre-diffusion uses nearby (coprime)
// lengths so a genuinely stereo input decorrelates without a second topology.
const LINE_LEN_REF = [
  142, 107, 379, 277, // pre-diffusion A (Dattorro input diffusers)
  150, 113, 399, 293, // pre-diffusion B (detuned siblings)
  672, 4453, 1800, 3720, // tank A
  908, 4217, 2656, 3163, // tank B
];

// Output taps: (line, length at REF_SR, sign) triplets summed per channel.
const TAP_L_LINE = [13, 13, 14, 15, 9, 10, 11];
const TAP_L_REF = [266, 2974, 1913, 1996, 1990, 187, 1066];
const TAP_L_SIGN = [1, 1, -1, 1, -1, -1, -1];
const TAP_R_LINE = [9, 9, 10, 11, 13, 14, 15];
const TAP_R_REF = [353, 3627, 1228, 2673, 2111, 335, 121];
const TAP_R_SIGN = [1, 1, -1, 1, -1, -1, -1];
const TAP_COUNT = 7;

interface ReverbState {
  sr: number;
  bufs: Float32Array[];
  masks: Int32Array;
  /** Per-line length in samples at this sr, before Size scaling. */
  baseLen: Float32Array;
  /** Per-line integer length for the current block (Size-scaled tank). */
  len: Int32Array;
  /** Output tap offsets at this sr (unscaled) and per-block scaled ints. */
  tapBaseL: Float32Array;
  tapBaseR: Float32Array;
  tapL: Int32Array;
  tapR: Int32Array;
  /** Shared write counter: line writes at t & mask, reads at (t − len) & mask. */
  t: number;
  modPhase: number;
  bwA: number; // input bandwidth lowpass state, channel A
  bwB: number;
  dampA: number; // tank damping lowpass state, branch A
  dampB: number;
}

const pow2Above = (n: number): number => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

export const reverbKernel: Kernel<ReverbState> = {
  init(sr): ReverbState {
    const srk = sr / REF_SR;
    const maxModSamples = Math.ceil(MOD_DEPTH_S[PRESET_COUNT - 1] * sr) + 4;

    const bufs: Float32Array[] = [];
    const masks = new Int32Array(LINE_COUNT);
    const baseLen = new Float32Array(LINE_COUNT);
    const len = new Int32Array(LINE_COUNT);
    for (let li = 0; li < LINE_COUNT - 2; li++) {
      baseLen[li] = LINE_LEN_REF[li] * srk;
      // Modulated tank allpasses (lines 8 and 12) need headroom for the
      // excursion; everything else only ever reads at ≤ its base length.
      const isModAp = li === 8 || li === 12;
      const size = pow2Above(Math.ceil(baseLen[li]) + (isModAp ? maxModSamples : 2));
      bufs.push(new Float32Array(size));
      masks[li] = size - 1;
      len[li] = Math.max(1, Math.floor(baseLen[li])); // pre lines keep this forever
    }
    for (let li = LINE_COUNT - 2; li < LINE_COUNT; li++) {
      const size = pow2Above(Math.ceil(PRE_DELAY_MAX_S * sr) + 2);
      bufs.push(new Float32Array(size));
      masks[li] = size - 1;
      baseLen[li] = 0;
      len[li] = 0;
    }

    const tapBaseL = new Float32Array(TAP_COUNT);
    const tapBaseR = new Float32Array(TAP_COUNT);
    for (let k = 0; k < TAP_COUNT; k++) {
      tapBaseL[k] = TAP_L_REF[k] * srk;
      tapBaseR[k] = TAP_R_REF[k] * srk;
    }

    return {
      sr,
      bufs,
      masks,
      baseLen,
      len,
      tapBaseL,
      tapBaseR,
      tapL: new Int32Array(TAP_COUNT),
      tapR: new Int32Array(TAP_COUNT),
      t: 0,
      modPhase: 0,
      bwA: 0,
      bwB: 0,
      dampA: 0,
      dampB: 0,
    };
  },

  process(state, ins, outs, params, n) {
    const inL = ins[0];
    const inR = ins[1];
    const inDecayCV = ins[2];
    const outL = outs[0];
    const outR = outs[1];

    // --- Guard params (block rate) ---
    let presetF = params[0];
    if (!Number.isFinite(presetF)) presetF = 0;
    let preset = Math.round(presetF);
    if (preset < 0) preset = 0;
    else if (preset > PRESET_COUNT - 1) preset = PRESET_COUNT - 1;

    let preDelayS = params[1];
    if (!Number.isFinite(preDelayS) || preDelayS < 0) preDelayS = 0;
    else if (preDelayS > PRE_DELAY_MAX_S) preDelayS = PRE_DELAY_MAX_S;
    const preDelaySamples = Math.round(preDelayS * state.sr);

    let size = params[2];
    if (!Number.isFinite(size) || size < 0) size = 0;
    else if (size > 1) size = 1;

    let baseDecay = params[3];
    if (!Number.isFinite(baseDecay) || baseDecay < 0) baseDecay = 0;
    else if (baseDecay > 1) baseDecay = 1;

    let damp = params[4];
    if (!Number.isFinite(damp) || damp < 0) damp = 0;
    else if (damp > 1) damp = 1;
    const dampCoef = damp * DAMP_COEF_MAX;

    let mix = params[5];
    if (!Number.isFinite(mix) || mix < 0) mix = 0;
    else if (mix > 1) mix = 1;

    // --- Hidden per-preset values ---
    const gPre1 = PRE_DIFFUSE_1[preset];
    const gPre2 = PRE_DIFFUSE_2[preset];
    const gTank1 = -DECAY_DIFFUSE_1[preset]; // Dattorro decay diffusion 1 is negative
    const gTank2 = DECAY_DIFFUSE_2[preset];
    const bw = BANDWIDTH[preset];
    const modInc = (TWO_PI * MOD_RATE_HZ[preset]) / state.sr;
    const modDepth = MOD_DEPTH_S[preset] * state.sr;
    const monoIn = MONO_INPUT[preset] === 1;

    // --- Size-scale the tank lengths and output taps for this block ---
    const bufs = state.bufs;
    const masks = state.masks;
    const len = state.len;
    const szK = SIZE_MIN_FACTOR + size * (1 - SIZE_MIN_FACTOR);
    for (let li = TANK_FIRST; li <= TANK_LAST; li++) {
      const l = Math.floor(state.baseLen[li] * szK);
      len[li] = l < 1 ? 1 : l;
    }
    const tapL = state.tapL;
    const tapR = state.tapR;
    for (let k = 0; k < TAP_COUNT; k++) {
      const tl = Math.floor(state.tapBaseL[k] * szK);
      tapL[k] = tl < 1 ? 1 : tl;
      const tr = Math.floor(state.tapBaseR[k] * szK);
      tapR[k] = tr < 1 ? 1 : tr;
    }

    let t = state.t;
    let modPhase = state.modPhase;
    let bwA = state.bwA;
    let bwB = state.bwB;
    let dampA = state.dampA;
    let dampB = state.dampB;

    for (let i = 0; i < n; i++) {
      // Inputs, mono-normalled: one patched channel feeds both sides.
      let dryL = 0;
      let dryR = 0;
      if (inL !== null) {
        const v = inL[i];
        if (Number.isFinite(v)) dryL = v;
      }
      if (inR !== null) {
        const v = inR[i];
        if (Number.isFinite(v)) dryR = v;
      } else {
        dryR = dryL;
      }
      if (inL === null) dryL = dryR;

      // Decay CV (seed jack "Time CV", group "Decay"): a ±CV_BIPOLAR_MAX
      // signal spans the full 0..1 Decay range on top of the knob.
      let decay01 = baseDecay;
      if (inDecayCV !== null) {
        const v = inDecayCV[i];
        if (Number.isFinite(v)) decay01 += v / CV_BIPOLAR_MAX;
      }
      if (decay01 < 0) decay01 = 0;
      else if (decay01 > 1) decay01 = 1;
      const decayGain = DECAY_GAIN_MIN + decay01 * (DECAY_GAIN_MAX - DECAY_GAIN_MIN);

      // Pre-delay (wet path only).
      bufs[16][t & masks[16]] = dryL;
      bufs[17][t & masks[17]] = dryR;
      const pdL = bufs[16][(t - preDelaySamples) & masks[16]];
      const pdR = bufs[17][(t - preDelaySamples) & masks[17]];

      // Tank feed: plate sums to mono before the tank; room/hall stay stereo.
      let feedA;
      let feedB;
      if (monoIn) {
        feedA = 0.5 * (pdL + pdR);
        feedB = feedA;
      } else {
        feedA = pdL;
        feedB = pdR;
      }

      // Input bandwidth lowpass: y = bw·x + (1 − bw)·y.
      bwA = bw * feedA + (1 - bw) * bwA;
      bwB = bw * feedB + (1 - bw) * bwB;

      // Input diffusion: 4 series allpasses per channel (lattice form:
      // w = x + g·w[t−D]; y = w[t−D] − g·w). Stage gains g1,g1,g2,g2.
      let injA = bwA;
      for (let k = 0; k < 4; k++) {
        const buf = bufs[k];
        const mask = masks[k];
        const wD = buf[(t - len[k]) & mask];
        const g = k < 2 ? gPre1 : gPre2;
        const w = injA + g * wD;
        buf[t & mask] = w;
        injA = wD - g * w;
      }
      let injB = bwB;
      for (let k = 4; k < 8; k++) {
        const buf = bufs[k];
        const mask = masks[k];
        const wD = buf[(t - len[k]) & mask];
        const g = k < 6 ? gPre1 : gPre2;
        const w = injB + g * wD;
        buf[t & mask] = w;
        injB = wD - g * w;
      }

      // Cross-feedback: each branch input takes the OTHER branch's final
      // delay output (previous samples — reads precede this sample's writes).
      const fbFromB = bufs[15][(t - len[15]) & masks[15]];
      const fbFromA = bufs[11][(t - len[11]) & masks[11]];

      const modSin = Math.sin(modPhase);
      modPhase += modInc;
      if (modPhase > TWO_PI) modPhase -= TWO_PI;

      // ── Tank branch A ──────────────────────────────────────────────────
      let xA = injA + decayGain * fbFromB;
      if (xA > REVERB_STATE_LIMIT_V) xA = REVERB_STATE_LIMIT_V;
      else if (xA < -REVERB_STATE_LIMIT_V) xA = -REVERB_STATE_LIMIT_V;
      {
        // Modulated allpass (line 8): fractional read at len + excursion.
        const off = len[8] + modDepth * (0.5 + 0.5 * modSin);
        const oi = off | 0;
        const frac = off - oi;
        const d0 = bufs[8][(t - oi) & masks[8]];
        const d1 = bufs[8][(t - oi - 1) & masks[8]];
        const wD = d0 + frac * (d1 - d0);
        const w = xA + gTank1 * wD;
        bufs[8][t & masks[8]] = w;
        const y = wD - gTank1 * w;
        // Delay 1 (line 9) → damping lowpass → ×decay.
        bufs[9][t & masks[9]] = y;
        const dOut = bufs[9][(t - len[9]) & masks[9]];
        dampA = dOut + dampCoef * (dampA - dOut);
        const damped = dampA * decayGain;
        // Allpass 2 (line 10) → delay 2 (line 11).
        const wD2 = bufs[10][(t - len[10]) & masks[10]];
        const w2 = damped + gTank2 * wD2;
        bufs[10][t & masks[10]] = w2;
        bufs[11][t & masks[11]] = wD2 - gTank2 * w2;
      }

      // ── Tank branch B (mirrored; counter-phase modulation) ─────────────
      let xB = injB + decayGain * fbFromA;
      if (xB > REVERB_STATE_LIMIT_V) xB = REVERB_STATE_LIMIT_V;
      else if (xB < -REVERB_STATE_LIMIT_V) xB = -REVERB_STATE_LIMIT_V;
      {
        const off = len[12] + modDepth * (0.5 - 0.5 * modSin);
        const oi = off | 0;
        const frac = off - oi;
        const d0 = bufs[12][(t - oi) & masks[12]];
        const d1 = bufs[12][(t - oi - 1) & masks[12]];
        const wD = d0 + frac * (d1 - d0);
        const w = xB + gTank1 * wD;
        bufs[12][t & masks[12]] = w;
        const y = wD - gTank1 * w;
        bufs[13][t & masks[13]] = y;
        const dOut = bufs[13][(t - len[13]) & masks[13]];
        dampB = dOut + dampCoef * (dampB - dOut);
        const damped = dampB * decayGain;
        const wD2 = bufs[14][(t - len[14]) & masks[14]];
        const w2 = damped + gTank2 * wD2;
        bufs[14][t & masks[14]] = w2;
        bufs[15][t & masks[15]] = wD2 - gTank2 * w2;
      }

      // Output taps: 7 decorrelated reads per side across both branches.
      let wetL = 0;
      for (let k = 0; k < TAP_COUNT; k++) {
        const li = TAP_L_LINE[k];
        wetL += TAP_L_SIGN[k] * bufs[li][(t - tapL[k]) & masks[li]];
      }
      let wetR = 0;
      for (let k = 0; k < TAP_COUNT; k++) {
        const li = TAP_R_LINE[k];
        wetR += TAP_R_SIGN[k] * bufs[li][(t - tapR[k]) & masks[li]];
      }
      wetL *= OUT_TAP_GAIN;
      wetR *= OUT_TAP_GAIN;

      // Mix = 0 is bit-exact dry.
      outL[i] = dryL + mix * (wetL - dryL);
      outR[i] = dryR + mix * (wetR - dryR);

      t++;
      if (t >= COUNTER_WRAP) t = 0;
    }

    state.t = t;
    state.modPhase = modPhase;
    state.bwA = bwA;
    state.bwB = bwB;
    state.dampA = dampA;
    state.dampB = dampB;
  },
};
