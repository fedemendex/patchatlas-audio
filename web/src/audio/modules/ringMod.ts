// Ring Modulator kernel for slug "ring-modulator".
// DC-coupled bipolar multiplier: Out = X * Y / CV_BIPOLAR_MAX.
// +5V * +5V -> +5V, +5V * -5V -> -5V, -5V * -5V -> +5V, 0V on either input -> 0V.
// An unpatched input reads as 0V (silence) — no internal carrier. No soft-clipping;
// audio-output owns final DAC limiting.
//
// Jack layout:
//   ins[0] = X (Carrier)   ins[1] = Y (Modulator)
//   outs[0] = Out

import type { Kernel } from "../engine/kernel";
import { CV_BIPOLAR_MAX } from "../engine/units";

interface RingModState {}

export const ringModKernel: Kernel<RingModState> = {
  init(_sr): RingModState {
    return {};
  },

  process(_state, ins, outs, _params, n) {
    const inX = ins[0];
    const inY = ins[1];
    const out = outs[0];

    if (inX === null || inY === null) {
      for (let i = 0; i < n; i++) out[i] = 0;
      return;
    }

    for (let i = 0; i < n; i++) {
      const x = Number.isFinite(inX[i]) ? inX[i] : 0;
      const y = Number.isFinite(inY[i]) ? inY[i] : 0;
      out[i] = (x * y) / CV_BIPOLAR_MAX;
    }
  },
};
