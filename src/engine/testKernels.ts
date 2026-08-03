// Test-only toy kernels for exercising the Kernel contract and the
// compiler/interpreter, without depending on any real module. These slugs are
// not in the production registry (modules/registry.ts) and must never be
// added to it.

import type { Kernel } from "./kernel";
import type { ModuleDSP } from "../modules/registry";
import { AUDIO_NORM } from "./units";

interface ToySineState {
  phase: number;
  sr: number;
}

/** params[0] = frequency in Hz. Output: ±AUDIO_NORM volts sine on outs[0]. */
export const toySineKernel: Kernel<ToySineState> = {
  init(sr) {
    return { phase: 0, sr };
  },
  process(state, _ins, outs, params, n) {
    const out = outs[0];
    const inc = params[0] / state.sr;
    for (let i = 0; i < n; i++) {
      out[i] = AUDIO_NORM * Math.sin(2 * Math.PI * state.phase);
      state.phase += inc;
      if (state.phase >= 1) state.phase -= 1;
    }
  },
};

/** params[0] = linear gain. outs[0] = ins[0] * gain; silence when unpatched. */
export const toyGainKernel: Kernel<Record<string, never>> = {
  init() {
    return {};
  },
  process(_state, ins, outs, params, n) {
    const input = ins[0];
    const out = outs[0];
    const gain = params[0];
    if (input === null) {
      for (let i = 0; i < n; i++) out[i] = 0;
      return;
    }
    for (let i = 0; i < n; i++) out[i] = input[i] * gain;
  },
};

// Tiny registry fixture for compiler/interpreter tests. The slugs are
// deliberately not module names the package ships, so nothing here can be
// mistaken for — or leak into — the production registry.
export const testRegistry: Map<string, ModuleDSP> = new Map<string, ModuleDSP>([
  [
    "toy-sine",
    {
      slug: "toy-sine",
      kernel: toySineKernel,
      inJacks: [],
      outJacks: ["Out"],
      params: { Freq: { min: 20, max: 20000, default: 440, curve: "exponential" } },
    },
  ],
  [
    "toy-gain",
    {
      slug: "toy-gain",
      kernel: toyGainKernel,
      inJacks: ["In"],
      outJacks: ["Out"],
      params: { Gain: { min: 0, max: 2, default: 1, curve: "linear" } },
    },
  ],
]);
