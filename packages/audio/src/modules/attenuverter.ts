// Attenuverter/Offset kernel for slug "attenuverter".
// Two independent channels. Per channel:
//   - Input patched:   out = in * k
//   - Input unpatched: out = k * CV_BIPOLAR_MAX   (manual DC offset source)
//
// This matches the signal convention: the unpatched normalling to CV_BIPOLAR_MAX
// means the bipolar knob produces a -5 V..+5 V offset with no cable needed.
// DC-coupled; no clipping.
//
// Jack layout:
//   ins[0] = In 1    ins[1] = In 2
//   outs[0] = Out 1  outs[1] = Out 2
//   params[0] = Att 1 (-1..1)   params[1] = Att 2 (-1..1)

import type { Kernel } from "../engine/kernel";
import { CV_BIPOLAR_MAX } from "../engine/units";

interface AttenuverterState {}

export const attenuverterKernel: Kernel<AttenuverterState> = {
  init(_sr): AttenuverterState {
    return {};
  },

  process(_state, ins, outs, params, n) {
    const in1 = ins[0];
    const in2 = ins[1];
    const out1 = outs[0];
    const out2 = outs[1];

    let k1 = params[0];
    if (!Number.isFinite(k1)) k1 = 0;
    let k2 = params[1];
    if (!Number.isFinite(k2)) k2 = 0;

    if (in1 !== null) {
      for (let i = 0; i < n; i++) {
        const v = in1[i];
        out1[i] = (Number.isFinite(v) ? v : 0) * k1;
      }
    } else {
      const dc1 = k1 * CV_BIPOLAR_MAX;
      for (let i = 0; i < n; i++) out1[i] = dc1;
    }

    if (in2 !== null) {
      for (let i = 0; i < n; i++) {
        const v = in2[i];
        out2[i] = (Number.isFinite(v) ? v : 0) * k2;
      }
    } else {
      const dc2 = k2 * CV_BIPOLAR_MAX;
      for (let i = 0; i < n; i++) out2[i] = dc2;
    }
  },
};
