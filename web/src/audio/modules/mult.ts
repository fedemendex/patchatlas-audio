// Mult kernel for slug "mult".
// One input copied bit-exactly to every output. No gain, no clipping.
// DC-coupled: works on audio, CV, gates, or any voltage.
//
// Jack layout:
//   ins[0]  = In
//   outs[0] = Out 1   outs[1] = Out 2   outs[2] = Out 3

import type { Kernel } from "../engine/kernel";

interface MultState {}

export const multKernel: Kernel<MultState> = {
  init(_sr): MultState {
    return {};
  },

  process(_state, ins, outs, _params, n) {
    const inp = ins[0];
    const o0 = outs[0];
    const o1 = outs[1];
    const o2 = outs[2];
    if (inp === null) {
      for (let i = 0; i < n; i++) {
        o0[i] = 0;
        o1[i] = 0;
        o2[i] = 0;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const v = inp[i];
        o0[i] = v;
        o1[i] = v;
        o2[i] = v;
      }
    }
  },
};
