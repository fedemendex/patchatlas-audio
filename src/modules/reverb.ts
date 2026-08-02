// Stereo reverb kernel for slug "reverb" (GH #83).
//
// DSP core adapted from khoin/DattorroReverbNode
// (https://github.com/khoin/DattorroReverbNode, `dattorroReverb.js`), a
// WebAudio implementation of Jon Dattorro, "Effect Design Part 1: Reverberator
// and Other Filters" (JAES 1997). Upstream license (kept verbatim):
//
//   In jurisdictions that recognize copyright laws, this software is to
//   be released into the public domain.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
//   THE AUTHOR(S) SHALL NOT BE LIABLE FOR ANYTHING, ARISING FROM, OR IN
//   CONNECTION WITH THE SOFTWARE OR THE DISTRIBUTION OF THE SOFTWARE.
//
// The port preserves the upstream topology and constants exactly: the same
// delay-line lengths (second-denominated), the same four-allpass input
// diffusion chain, the same two cross-coupled tank loops with cubic-
// interpolated modulated allpasses (detuned 6.2800/6.2847 rad excursion
// oscillators), and the same 14-tap stereo output matrix.
//
// Input-feed model (per preset, MONO_INPUT below — a Patch Atlas product
// decision, GH #83, layered on the upstream core):
//   - Plate is mono-fed exactly as upstream: 0.5·(L+R) → pre-delay →
//     bandwidth → one diffusion chain → the SAME signal injected into both
//     tank loops. This mode is numerically equivalent to upstream (pinned by
//     reverb.test.ts against the vendored fixture).
//   - Room and Hall are STEREO-FED Dattorro-derived variants: each channel
//     gets its own pre-delay + bandwidth + diffusion chain (chain B duplicates
//     chain A's upstream lengths/gains), and L injects into the first tank
//     loop, R into the second. Same topology and constants as upstream, but a
//     hard-panned input is NOT summed to center before the tank. For
//     identical L/R input the two chains produce identical injections, so
//     this mode degenerates to the upstream mono-fed behavior exactly (also
//     pinned by test); for panned input it is deliberately NOT
//     upstream-equivalent. The dry path is stereo in every mode.
//
// Other differences from upstream, all at the integration boundary:
//   - Reshaped from an AudioWorkletProcessor into the Patch Atlas Kernel
//     contract (init/process, shared write counter, write-relative reads).
//   - Size (not an upstream parameter): scales the eight TANK delay/tap read
//     lengths by SIZE_MIN_FACTOR..1. At Size = 1 — where every preset sits —
//     the read lengths are upstream's exactly. Moving Size re-points reads
//     (coarse pitch warble while turning is accepted v1 behavior).
//   - One Mix knob instead of upstream's wet/dry pair: dry = 1 − mix,
//     wet = mix · WET_SCALE (upstream folds the same 0.6 into its wet gain).
//     Mix = 0 is bit-exact dry.
//   - Decay is capped below 1 (no freeze — out of scope per GH #83) and
//     "Decay CV" (seed group "Decay") adds to it per sample, ±CV_BIPOLAR_MAX
//     spanning the full range.
//   - Params/inputs are NaN/Infinity-guarded and the two tank injection sums
//     are hard-clamped (±REVERB_STATE_LIMIT_V, numerical safety only) — with
//     loop gain < 1 the tank is unconditionally stable.
//
// Jack layout (seed declaration order):
//   ins[0] = In L     — audio input; null → mono-normalled from In R
//   ins[1] = In R     — audio input; null → mono-normalled from In L
//   ins[2] = Decay CV — decay CV; null → 0 V
//   outs[0] = Out L   outs[1] = Out R
//   params[0] = Preset   (positions: 0 Room, 1 Hall, 2 Plate)
//   params[1] = PreDelay (0..0.25 s, linear)
//   params[2] = Size     (0..1)   params[3] = Decay (0..1)
//   params[4] = Damp     (0..1)   params[5] = Mix   (0..1)
//
// Preset semantics: the kernel receives the preset ONLY as the numeric switch
// index — never a name — and uses it to index the hidden per-preset tables
// below (upstream's bandwidth/diffusion/excursion parameters). The five
// visible params arrive as ordinary numeric params; the UI batch-sets them
// when the switch changes (reverbPresets.ts).

import type { Kernel } from "../engine/kernel";
import { CV_BIPOLAR_MAX } from "../engine/units";

// ── Hidden per-preset DSP tables (index = Preset switch position) ────────────
// Values are lifted from the upstream demo's own preset rows (index.html):
// Room = "small non-empty room", Hall = "big empty church", Plate = the
// processor defaults (= the Dattorro paper's plate). The matching VISIBLE
// values live in REVERB_PRESET_VISIBLE (reverbPresets.ts; kept there for the
// UI, here for the kernel, so the import graph stays acyclic).
//                            Room    Hall    Plate
const BANDWIDTH = [0.5683, 0.928, 0.9999]; // input one-pole lowpass coefficient
const INPUT_DIFFUSION_1 = [0.4666, 0.7331, 0.75]; // pre-tank allpass 1+2 gain
const INPUT_DIFFUSION_2 = [0.5853, 0.4534, 0.625]; // pre-tank allpass 3+4 gain
const DECAY_DIFFUSION_1 = [0.6954, 0.7839, 0.7]; // tank modulated-allpass gain
const DECAY_DIFFUSION_2 = [0.6022, 0.1992, 0.5]; // tank second-allpass gain
const EXCURSION_RATE_HZ = [0, 0, 0.5]; // tank allpass modulation rate
const EXCURSION_DEPTH_MS = [0, 0, 0.7]; // tank allpass modulation depth
// 1 = mono-fed tank (upstream's model, classic plate): 0.5·(L+R) into both
// loops. 0 = stereo-fed (our variant): L into the first loop, R into the
// second. See the input-feed section of the file header.
const MONO_INPUT = [0, 0, 1];

// ── Design constants ─────────────────────────────────────────────────────────
const PRESET_COUNT = 3;
const PRE_DELAY_MAX_S = 0.25; // must cover the PreDelay ParamSpec max
const SIZE_MIN_FACTOR = 0.25; // tank scale at Size = 0 (our extension)
const DECAY_MAX = 0.98; // loop gain cap — strictly < 1, no freeze
const WET_SCALE = 0.6; // upstream's wet gain fold-in
const REVERB_STATE_LIMIT_V = 100; // tank hard clamp — numerical safety only
// Upstream's detuned excursion oscillators (intentionally ≠ 2π and unequal).
const EXC_RAD_L = 6.28;
const EXC_RAD_R = 6.2847;
// Shared sample counter wrap: a power of two that every line mask divides.
const COUNTER_WRAP = 1 << 30;

// Delay lines, lengths in SECONDS (upstream's paper values, converted by its
// Conversion.xlsx; effective delay per line is round(s·sr) − 1).
//  0..3   input diffusion allpasses 1..4, channel A (upstream's only chain)
//  4..7   left tank loop: modulated allpass, delay, allpass, delay
//  8..11  right tank loop: modulated allpass, delay, allpass, delay
// 12..15  input diffusion chain B (stereo-fed mode's right channel) — same
//         upstream lengths as 0..3, so identical L/R input produces identical
//         injections and the stereo-fed mode degenerates to upstream exactly.
const LINE_COUNT = 16;
const TANK_FIRST = 4;
const TANK_LAST = 11;
const LINE_LEN_S = [
  0.004771345, 0.003595309, 0.012734787, 0.009307483,
  0.022579886, 0.149625349, 0.060481839, 0.1249958,
  0.030509727, 0.141695508, 0.089244313, 0.106280031,
  0.004771345, 0.003595309, 0.012734787, 0.009307483,
];

// Upstream's 14 output taps, in SECONDS. A tap value is an offset from the
// line's read end: effective tap delay = lineDelay − round(tap·sr).
const TAP_COUNT = 7;
const TAP_L_LINE = [9, 9, 10, 11, 5, 6, 7];
const TAP_L_S = [0.008937872, 0.099929438, 0.064278754, 0.067067639, 0.066866033, 0.006283391, 0.035818689];
const TAP_L_SIGN = [1, 1, -1, 1, -1, -1, -1];
const TAP_R_LINE = [5, 5, 6, 7, 9, 10, 11];
const TAP_R_S = [0.011861161, 0.121870905, 0.041262054, 0.08981553, 0.070931756, 0.011256342, 0.004065724];
const TAP_R_SIGN = [1, 1, -1, 1, -1, -1, -1];

interface ReverbState {
  sr: number;
  bufs: Float32Array[];
  masks: Int32Array;
  /** Per-line effective delay in samples at this sr (upstream's len − 1). */
  baseLen: Int32Array;
  /** Per-line Size-scaled integer delay for the current block. */
  len: Int32Array;
  /** Tap base delays (lineDelay − tap) at this sr, and per-block scaled ints. */
  tapBaseL: Int32Array;
  tapBaseR: Int32Array;
  tapL: Int32Array;
  tapR: Int32Array;
  preDelayBufL: Float32Array;
  preDelayBufR: Float32Array;
  preDelayMask: number;
  /** Shared write counter: line writes at t & mask, reads at (t − delay) & mask. */
  t: number;
  excPhase: number;
  lp1: number; // input bandwidth lowpass, chain A (upstream _lp1)
  lp1b: number; // input bandwidth lowpass, chain B (stereo-fed right channel)
  lp2: number; // left tank damping lowpass (upstream _lp2)
  lp3: number; // right tank damping lowpass (upstream _lp3)
}

const pow2Above = (n: number): number => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

// Upstream's cubic interpolation (O. Niemitalo, via musicdsp.org) — a direct
// port of readDelayCAt. `L` is the line's (Size-scaled) base delay and `i` the
// excursion offset toward the write head, exactly as upstream: the four
// points sit at positions (read + ⌊i⌋ − 1 .. + 2), i.e. write-relative
// t − L + ⌊i⌋ − 1 onward, and frac interpolates from x1 toward x2.
function cubicReadAt(
  buf: Float32Array,
  mask: number,
  t: number,
  L: number,
  i: number,
): number {
  const ii = Math.floor(i);
  const frac = i - ii;
  const base = t - L + ii - 1;
  const x0 = buf[base & mask];
  const x1 = buf[(base + 1) & mask];
  const x2 = buf[(base + 2) & mask];
  const x3 = buf[(base + 3) & mask];
  const a = (3 * (x1 - x2) - x0 + x3) / 2;
  const b = 2 * x2 + x0 - (5 * x1 + x3) / 2;
  const c = (x2 - x0) / 2;
  return ((a * frac + b) * frac + c) * frac + x1;
}

export const reverbKernel: Kernel<ReverbState> = {
  init(sr): ReverbState {
    const bufs: Float32Array[] = [];
    const masks = new Int32Array(LINE_COUNT);
    const baseLen = new Int32Array(LINE_COUNT);
    const len = new Int32Array(LINE_COUNT);
    for (let li = 0; li < LINE_COUNT; li++) {
      const samples = Math.round(LINE_LEN_S[li] * sr);
      baseLen[li] = samples - 1; // upstream's effective delay is len − 1
      // +4 headroom covers the cubic interpolator's ⌊d⌋±2 neighbor reads.
      const size = pow2Above(samples + 4);
      bufs.push(new Float32Array(size));
      masks[li] = size - 1;
      len[li] = baseLen[li];
    }

    const tapBaseL = new Int32Array(TAP_COUNT);
    const tapBaseR = new Int32Array(TAP_COUNT);
    for (let k = 0; k < TAP_COUNT; k++) {
      tapBaseL[k] = baseLen[TAP_L_LINE[k]] - Math.round(TAP_L_S[k] * sr);
      tapBaseR[k] = baseLen[TAP_R_LINE[k]] - Math.round(TAP_R_S[k] * sr);
    }

    const pdSize = pow2Above(Math.ceil(PRE_DELAY_MAX_S * sr) + 2);

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
      preDelayBufL: new Float32Array(pdSize),
      preDelayBufR: new Float32Array(pdSize),
      preDelayMask: pdSize - 1,
      t: 0,
      excPhase: 0,
      lp1: 0,
      lp1b: 0,
      lp2: 0,
      lp3: 0,
    };
  },

  process(state, ins, outs, params, n) {
    const inL = ins[0];
    const inR = ins[1];
    const inDecayCV = ins[2];
    const outL = outs[0];
    const outR = outs[1];

    // --- Guard params (block rate; upstream is k-rate too) ---
    let presetF = params[0];
    if (!Number.isFinite(presetF)) presetF = 0;
    let preset = Math.round(presetF);
    if (preset < 0) preset = 0;
    else if (preset > PRESET_COUNT - 1) preset = PRESET_COUNT - 1;

    let preDelayS = params[1];
    if (!Number.isFinite(preDelayS) || preDelayS < 0) preDelayS = 0;
    else if (preDelayS > PRE_DELAY_MAX_S) preDelayS = PRE_DELAY_MAX_S;
    const pd = Math.round(preDelayS * state.sr);

    let size = params[2];
    if (!Number.isFinite(size) || size < 0) size = 0;
    else if (size > 1) size = 1;

    let baseDecay = params[3];
    if (!Number.isFinite(baseDecay) || baseDecay < 0) baseDecay = 0;
    else if (baseDecay > 1) baseDecay = 1;

    let damp = params[4];
    if (!Number.isFinite(damp) || damp < 0) damp = 0;
    else if (damp > 1) damp = 1;
    const dp = 1 - damp; // upstream: dp = 1 − damping

    let mix = params[5];
    if (!Number.isFinite(mix) || mix < 0) mix = 0;
    else if (mix > 1) mix = 1;
    const dry = 1 - mix;
    const wet = mix * WET_SCALE;

    // --- Hidden per-preset values (upstream parameter names) ---
    const bw = BANDWIDTH[preset];
    const fi = INPUT_DIFFUSION_1[preset];
    const si = INPUT_DIFFUSION_2[preset];
    const ft = DECAY_DIFFUSION_1[preset];
    const st = DECAY_DIFFUSION_2[preset];
    const ex = EXCURSION_RATE_HZ[preset] / state.sr;
    const ed = (EXCURSION_DEPTH_MS[preset] * state.sr) / 1000;
    const monoIn = MONO_INPUT[preset] === 1;

    // --- Size-scale the tank delays and output taps for this block ---
    const bufs = state.bufs;
    const masks = state.masks;
    const len = state.len;
    const szK = SIZE_MIN_FACTOR + size * (1 - SIZE_MIN_FACTOR);
    for (let li = TANK_FIRST; li <= TANK_LAST; li++) {
      const l = Math.round(state.baseLen[li] * szK);
      len[li] = l < 2 ? 2 : l;
    }
    const tapL = state.tapL;
    const tapR = state.tapR;
    for (let k = 0; k < TAP_COUNT; k++) {
      const tl = Math.round(state.tapBaseL[k] * szK);
      tapL[k] = tl < 1 ? 1 : tl;
      const tr = Math.round(state.tapBaseR[k] * szK);
      tapR[k] = tr < 1 ? 1 : tr;
    }

    const pdBufL = state.preDelayBufL;
    const pdBufR = state.preDelayBufR;
    const pdMask = state.preDelayMask;
    let t = state.t;
    let excPhase = state.excPhase;
    let lp1 = state.lp1;
    let lp1b = state.lp1b;
    let lp2 = state.lp2;
    let lp3 = state.lp3;

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

      // Decay CV (seed jack "Decay CV"): a ±CV_BIPOLAR_MAX signal spans the
      // full 0..1 Decay range on top of the knob. Capped at DECAY_MAX (< 1):
      // freeze is out of scope (GH #83).
      let decay01 = baseDecay;
      if (inDecayCV !== null) {
        const v = inDecayCV[i];
        if (Number.isFinite(v)) decay01 += v / CV_BIPOLAR_MAX;
      }
      if (decay01 < 0) decay01 = 0;
      else if (decay01 > DECAY_MAX) decay01 = DECAY_MAX;
      const dc = decay01;

      // Per-channel pre-delay. Reading both and summing after is equivalent
      // to upstream's sum-then-delay (linear, same pd on both lines).
      pdBufL[t & pdMask] = dryL;
      pdBufR[t & pdMask] = dryR;
      const pdL = pdBufL[(t - pd) & pdMask];
      const pdR = pdBufR[(t - pd) & pdMask];

      // Tank feed per preset: Plate mono-sums before the chains (upstream's
      // model); Room/Hall keep the channels separate (stereo-fed variant).
      let feedA;
      let feedB;
      if (monoIn) {
        feedA = 0.5 * (pdL + pdR);
        feedB = feedA;
      } else {
        feedA = pdL;
        feedB = pdR;
      }

      // Input bandwidth lowpass (upstream: lp1 += bw·(x − lp1)), per chain.
      lp1 += bw * (feedA - lp1);
      lp1b += bw * (feedB - lp1b);

      // Pre-tank: four series input-diffusion allpasses per chain (chain A =
      // lines 0..3, upstream's; chain B = lines 12..15, same lengths/gains),
      // written exactly as upstream's chained writeDelay/readDelay form
      // (wN is the value written to line N; dN its delayed read).
      const d0 = bufs[0][(t - len[0]) & masks[0]];
      const d1 = bufs[1][(t - len[1]) & masks[1]];
      const d2 = bufs[2][(t - len[2]) & masks[2]];
      const d3 = bufs[3][(t - len[3]) & masks[3]];
      const w0 = lp1 - fi * d0;
      bufs[0][t & masks[0]] = w0;
      const w1 = fi * (w0 - d1) + d0;
      bufs[1][t & masks[1]] = w1;
      const w2 = fi * w1 + d1 - si * d2;
      bufs[2][t & masks[2]] = w2;
      const w3 = si * (w2 - d3) + d2;
      bufs[3][t & masks[3]] = w3;
      const splitA = si * w3 + d3;

      const d12 = bufs[12][(t - len[12]) & masks[12]];
      const d13 = bufs[13][(t - len[13]) & masks[13]];
      const d14 = bufs[14][(t - len[14]) & masks[14]];
      const d15 = bufs[15][(t - len[15]) & masks[15]];
      const w12 = lp1b - fi * d12;
      bufs[12][t & masks[12]] = w12;
      const w13 = fi * (w12 - d13) + d12;
      bufs[13][t & masks[13]] = w13;
      const w14 = fi * w13 + d13 - si * d14;
      bufs[14][t & masks[14]] = w14;
      const w15 = si * (w14 - d15) + d14;
      bufs[15][t & masks[15]] = w15;
      const splitB = si * w15 + d15;

      // Injections: mono mode uses chain A's signal for BOTH loops (bit-exact
      // upstream; chain B still runs so its state is warm across preset
      // switches). Stereo mode: L → first loop, R → second loop.
      const injL = splitA;
      const injR = monoIn ? splitA : splitB;

      // Excursions (upstream's detuned cos/sin pair from one phase).
      const excL = ed * (1 + Math.cos(excPhase * EXC_RAD_L));
      const excR = ed * (1 + Math.sin(excPhase * EXC_RAD_R));

      // ── Left tank loop (lines 4..7; cross-fed from line 11) ────────────
      const ap4 = cubicReadAt(bufs[4], masks[4], t, len[4], excL);
      let tank = injL + dc * bufs[11][(t - len[11]) & masks[11]] + ft * ap4;
      if (tank > REVERB_STATE_LIMIT_V) tank = REVERB_STATE_LIMIT_V;
      else if (tank < -REVERB_STATE_LIMIT_V) tank = -REVERB_STATE_LIMIT_V;
      bufs[4][t & masks[4]] = tank;
      bufs[5][t & masks[5]] = ap4 - ft * tank;
      lp2 += dp * (bufs[5][(t - len[5]) & masks[5]] - lp2);
      const d6 = bufs[6][(t - len[6]) & masks[6]];
      const w6 = dc * lp2 - st * d6;
      bufs[6][t & masks[6]] = w6;
      bufs[7][t & masks[7]] = d6 + st * w6;

      // ── Right tank loop (lines 8..11; cross-fed from line 7) ───────────
      const ap8 = cubicReadAt(bufs[8], masks[8], t, len[8], excR);
      let tankR = injR + dc * bufs[7][(t - len[7]) & masks[7]] + ft * ap8;
      if (tankR > REVERB_STATE_LIMIT_V) tankR = REVERB_STATE_LIMIT_V;
      else if (tankR < -REVERB_STATE_LIMIT_V) tankR = -REVERB_STATE_LIMIT_V;
      bufs[8][t & masks[8]] = tankR;
      bufs[9][t & masks[9]] = ap8 - ft * tankR;
      lp3 += dp * (bufs[9][(t - len[9]) & masks[9]] - lp3);
      const d10 = bufs[10][(t - len[10]) & masks[10]];
      const w10 = dc * lp3 - st * d10;
      bufs[10][t & masks[10]] = w10;
      bufs[11][t & masks[11]] = d10 + st * w10;

      // Output taps: upstream's 14-tap stereo matrix.
      let lo = 0;
      for (let k = 0; k < TAP_COUNT; k++) {
        const li = TAP_L_LINE[k];
        lo += TAP_L_SIGN[k] * bufs[li][(t - tapL[k]) & masks[li]];
      }
      let ro = 0;
      for (let k = 0; k < TAP_COUNT; k++) {
        const li = TAP_R_LINE[k];
        ro += TAP_R_SIGN[k] * bufs[li][(t - tapR[k]) & masks[li]];
      }

      // Mix = 0 is bit-exact dry (dry = 1, wet = 0).
      outL[i] = dryL * dry + lo * wet;
      outR[i] = dryR * dry + ro * wet;

      excPhase += ex;
      t++;
      if (t >= COUNTER_WRAP) t = 0;
    }

    state.t = t;
    state.excPhase = excPhase;
    state.lp1 = lp1;
    state.lp1b = lp1b;
    state.lp2 = lp2;
    state.lp3 = lp3;
  },
};
