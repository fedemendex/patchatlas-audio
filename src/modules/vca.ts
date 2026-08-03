// VCA kernel for slug "vca".
// DC-coupled: works on audio and CV alike. No soft-clipping — headroom above
// CV_BIPOLAR_MAX is legal inside the graph.
//
// Jack layout:
//   ins[0] = In       ins[1] = CV
//   outs[0] = Out
//   params[0] = Gain (0..1)
//   params[1] = CV Amt (0..1)   attenuates the CV input before normalization
//   params[2] = Response (0 = Exp, 1 = Lin, from the Response switch positions)
//
// Gain calculation when CV is patched:
//   normalizedCv = max(0, CV[i] * cvAmt / CV_BIPOLAR_MAX)   (no upper clamp)
//   Linear:  gain = Gain * normalizedCv
//   Exp:     gain = Gain * normalizedCv²   (monotone on [0,∞), 0→0 and 1→1)
//
// When CV is unpatched, gain = Gain (level control only; CV Amt is irrelevant).
// The exp curve keeps x² for simplicity: monotone, 0→silence, 1→unity at 5 V.

import type { Kernel } from "../engine/kernel";
import { CV_BIPOLAR_MAX } from "../engine/units";

interface VcaState {}

const DEFAULT_GAIN = 1;
const DEFAULT_CV_AMT = 1;
const DEFAULT_RESPONSE = 1;

export const vcaKernel: Kernel<VcaState> = {
  init(_sr): VcaState {
    return {};
  },

  process(_state, ins, outs, params, n) {
    const inSig = ins[0];
    const inCv = ins[1];
    const out = outs[0];

    let gain = params[0];
    if (!Number.isFinite(gain)) gain = DEFAULT_GAIN;
    let cvAmt = params[1];
    if (!Number.isFinite(cvAmt)) cvAmt = DEFAULT_CV_AMT;
    const response = Number.isFinite(params[2]) ? params[2] : DEFAULT_RESPONSE;
    const linear = response >= 0.5;

    if (inCv !== null) {
      for (let i = 0; i < n; i++) {
        const sig = inSig !== null && Number.isFinite(inSig[i]) ? inSig[i] : 0;
        let cv = inCv[i];
        if (!Number.isFinite(cv)) cv = 0;
        let normalizedCv = (cv * cvAmt) / CV_BIPOLAR_MAX;
        if (normalizedCv < 0) normalizedCv = 0;
        const g = linear ? gain * normalizedCv : gain * normalizedCv * normalizedCv;
        out[i] = sig * g;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const sig = inSig !== null && Number.isFinite(inSig[i]) ? inSig[i] : 0;
        out[i] = sig * gain;
      }
    }
  },
};
