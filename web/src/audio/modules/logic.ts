// Logic kernel for slug "logic".
//
// Four combinational gates over `In 1`/`In 2` (Schmitt-latched, standard
// thresholds: fire >= GATE_FIRE_THRESHOLD_V, re-arm below
// GATE_REARM_THRESHOLD_V) plus a `Clock`-driven T flip-flop. `Clock` is
// dedicated to `FF` and never participates in the combinational outputs;
// `In 1`/`In 2` never affect `FF`.
//
// AND = In1 && In2, OR = In1 || In2, XOR = In1 xor In2 (exactly one high),
// NOR = neither In1 nor In2 high — each written as GATE_HIGH_V / 0.
//
// `FF` is a T flip-flop: starts low on module creation, toggles exactly once
// per `Clock` rising edge (standard Schmitt), and holds its state between
// calls — a sustained-high `Clock` toggles only once until it re-arms below
// GATE_REARM_THRESHOLD_V, and falling edges never toggle it. There is no
// reset input; only recreating the module (a fresh `init`) returns `FF` to
// low.
//
// Unpatched/non-finite `In 1`, `In 2`, or `Clock` samples read as 0 V (low).
//
// Jack layout (registry declaration order):
//   ins[0] = In 1   ins[1] = In 2   ins[2] = Clock
//   outs[0] = AND   outs[1] = OR   outs[2] = XOR   outs[3] = NOR   outs[4] = FF

import type { Kernel } from "../engine/kernel";
import { GATE_HIGH_V, GATE_FIRE_THRESHOLD_V, GATE_REARM_THRESHOLD_V } from "../engine/units";

interface LogicState {
  in1High: boolean; // Schmitt state of In 1
  in2High: boolean; // Schmitt state of In 2
  clkHigh: boolean; // Schmitt state of Clock; also the FF rising-edge detector
  ffHigh: boolean; // current FF output level; toggles on each Clock rising edge
}

export const logicKernel: Kernel<LogicState> = {
  init(_sr): LogicState {
    return {
      in1High: false,
      in2High: false,
      clkHigh: false,
      ffHigh: false,
    };
  },

  process(state, ins, outs, _params, n) {
    const inIn1 = ins[0];
    const inIn2 = ins[1];
    const inClk = ins[2];
    const outAnd = outs[0];
    const outOr = outs[1];
    const outXor = outs[2];
    const outNor = outs[3];
    const outFf = outs[4];

    let in1High = state.in1High;
    let in2High = state.in2High;
    let clkHigh = state.clkHigh;
    let ffHigh = state.ffHigh;

    for (let i = 0; i < n; i++) {
      // In 1 / In 2: Schmitt-latched operands for the combinational outputs.
      // Non-finite reads as 0 V (low).
      let v1 = 0;
      if (inIn1 !== null) {
        const v = inIn1[i];
        if (Number.isFinite(v)) v1 = v;
      }
      if (!in1High && v1 >= GATE_FIRE_THRESHOLD_V) in1High = true;
      else if (in1High && v1 < GATE_REARM_THRESHOLD_V) in1High = false;

      let v2 = 0;
      if (inIn2 !== null) {
        const v = inIn2[i];
        if (Number.isFinite(v)) v2 = v;
      }
      if (!in2High && v2 >= GATE_FIRE_THRESHOLD_V) in2High = true;
      else if (in2High && v2 < GATE_REARM_THRESHOLD_V) in2High = false;

      // Clock: Schmitt rising edge toggles FF once; falling edges never toggle.
      let vClk = 0;
      if (inClk !== null) {
        const v = inClk[i];
        if (Number.isFinite(v)) vClk = v;
      }
      if (!clkHigh && vClk >= GATE_FIRE_THRESHOLD_V) {
        clkHigh = true;
        ffHigh = !ffHigh;
      } else if (clkHigh && vClk < GATE_REARM_THRESHOLD_V) {
        clkHigh = false;
      }

      outAnd[i] = in1High && in2High ? GATE_HIGH_V : 0;
      outOr[i] = in1High || in2High ? GATE_HIGH_V : 0;
      outXor[i] = in1High !== in2High ? GATE_HIGH_V : 0;
      outNor[i] = !in1High && !in2High ? GATE_HIGH_V : 0;
      outFf[i] = ffHigh ? GATE_HIGH_V : 0;
    }

    state.in1High = in1High;
    state.in2High = in2High;
    state.clkHigh = clkHigh;
    state.ffHigh = ffHigh;
  },
};
