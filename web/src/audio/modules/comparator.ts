// Comparator kernel for slug "comparator".
//
// A Doepfer A-167-inspired comparator/subtractor: an attenuated two-input
// summer/subtractor (`+ In`/`− In`, each with its own `Level` attenuator) plus
// a bipolar `Offset` knob and `Offset CV` input, feeding both a raw analog
// `Sum` output and a Schmitt-style `Gate`/`Inv Gate` pair with knob-controlled
// symmetric hysteresis (`Gap`). This is an original interpretation of the
// A-167's summing-comparator topology, not a traced circuit model.
//
// Equation (every sample):
//   sum = (+Level × + In) − (−Level × − In) + Offset + Offset CV
// `+ In`/`− In`/`Offset CV` read as 0 V when unpatched or non-finite — the
// standard engine convention (see logic.ts, slewLimiter.ts). `Sum` outputs
// `sum` directly: no normalization, clipping, or smoothing. Only non-finite
// results (which cannot occur from finite inputs/params, but are guarded as
// a last resort per the kernel checklist) are sanitized to 0 V before ever
// reaching an output.
//
// Comparator / hysteresis: `Gate` is a Schmitt-style comparator on `sum`
// against 0 V, with `Gap` (a unipolar knob, engine volts) setting a symmetric
// hysteresis band around zero:
//   - Gap <= 0: strict zero-comparison — Gate is high iff sum > 0 (equality
//     is low), independent of the previous state. This matches a hysteresis
//     band collapsed to a point, and keeps Gap = 0 exactly reproducible
//     regardless of Gate's prior value.
//   - Gap > 0: symmetric hysteresis — while low, Gate goes high only once
//     sum > Gap / 2; while high, Gate goes low only once sum < −Gap / 2;
//     between those thresholds Gate holds its previous state.
// `Inv Gate` is always the exact logical complement of `Gate` (never an
// independent comparison), so the two can never briefly disagree.
//
// Gate/Inv Gate write GATE_HIGH_V for high and exactly 0 for low — the
// standard engine gate convention (units.ts). Comparator state (`gateHigh`)
// starts low (false) when the kernel instance is created and is not
// persisted beyond the instance's lifetime — recreating the module resets it
// to low, matching every other stateful kernel's convention.
//
// Jack/param layout (seed declaration order):
//   ins[0] = + In        ins[1] = − In        ins[2] = Offset CV
//   outs[0] = Gate        outs[1] = Inv Gate   outs[2] = Sum
//   params[0] = Offset (bipolar, engine volts)
//   params[1] = + Level (0..1)
//   params[2] = − Level (0..1)
//   params[3] = Gap (unipolar, engine volts)

import type { Kernel } from "../engine/kernel";
import { GATE_HIGH_V } from "../engine/units";

interface ComparatorState {
  gateHigh: boolean;
}

export const comparatorKernel: Kernel<ComparatorState> = {
  init(_sr): ComparatorState {
    return { gateHigh: false };
  },

  process(state, ins, outs, params, n) {
    const inPlus = ins[0];
    const inMinus = ins[1];
    const inOffsetCv = ins[2];
    const outGate = outs[0];
    const outInvGate = outs[1];
    const outSum = outs[2];

    let offset = params[0];
    if (!Number.isFinite(offset)) offset = 0;
    let plusLevel = params[1];
    if (!Number.isFinite(plusLevel)) plusLevel = 0;
    let minusLevel = params[2];
    if (!Number.isFinite(minusLevel)) minusLevel = 0;
    let gap = params[3];
    if (!Number.isFinite(gap)) gap = 0;

    let gateHigh = state.gateHigh;

    for (let i = 0; i < n; i++) {
      let vPlus = 0;
      if (inPlus !== null) {
        const v = inPlus[i];
        if (Number.isFinite(v)) vPlus = v;
      }
      let vMinus = 0;
      if (inMinus !== null) {
        const v = inMinus[i];
        if (Number.isFinite(v)) vMinus = v;
      }
      let vOffsetCv = 0;
      if (inOffsetCv !== null) {
        const v = inOffsetCv[i];
        if (Number.isFinite(v)) vOffsetCv = v;
      }

      let sum = plusLevel * vPlus - minusLevel * vMinus + offset + vOffsetCv;
      if (!Number.isFinite(sum)) sum = 0;

      if (gap <= 0) {
        gateHigh = sum > 0;
      } else {
        const half = gap / 2;
        if (!gateHigh && sum > half) gateHigh = true;
        else if (gateHigh && sum < -half) gateHigh = false;
      }

      outSum[i] = sum;
      outGate[i] = gateHigh ? GATE_HIGH_V : 0;
      outInvGate[i] = gateHigh ? 0 : GATE_HIGH_V;
    }

    state.gateHigh = gateHigh;
  },
};
