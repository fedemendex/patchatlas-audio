// Mixer kernel for slug "mixer".
// 4 inputs, Mix output (sum of per-channel signal × level), and Inv output
// (polarity-inverted Mix). Unpatched channels contribute silence.
// DC-coupled; no clipping — hot sums above CV_BIPOLAR_MAX are legal headroom.
//
// Jack layout:
//   ins[0..3] = In 1..In 4
//   outs[0] = Mix    outs[1] = Inv
//   params[0..3] = Level 1..Level 4 (0..1 each)

import type { Kernel } from "../engine/kernel";

interface MixerState {}

const DEFAULT_LEVEL = 1;

export const mixerKernel: Kernel<MixerState> = {
  init(_sr): MixerState {
    return {};
  },

  process(_state, ins, outs, params, n) {
    const in0 = ins[0];
    const in1 = ins[1];
    const in2 = ins[2];
    const in3 = ins[3];
    const outMix = outs[0];
    const outInv = outs[1];

    const l0 = Number.isFinite(params[0]) ? params[0] : DEFAULT_LEVEL;
    const l1 = Number.isFinite(params[1]) ? params[1] : DEFAULT_LEVEL;
    const l2 = Number.isFinite(params[2]) ? params[2] : DEFAULT_LEVEL;
    const l3 = Number.isFinite(params[3]) ? params[3] : DEFAULT_LEVEL;

    for (let i = 0; i < n; i++) {
      let sum = 0;
      if (in0 !== null) sum += (Number.isFinite(in0[i]) ? in0[i] : 0) * l0;
      if (in1 !== null) sum += (Number.isFinite(in1[i]) ? in1[i] : 0) * l1;
      if (in2 !== null) sum += (Number.isFinite(in2[i]) ? in2[i] : 0) * l2;
      if (in3 !== null) sum += (Number.isFinite(in3[i]) ? in3[i] : 0) * l3;
      outMix[i] = sum;
      outInv[i] = 0 - sum; // avoid IEEE 754 -0 when sum === 0
    }
  },
};
