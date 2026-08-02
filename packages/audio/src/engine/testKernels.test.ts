import { describe, it, expect } from "vitest";
import { BLOCK_FRAMES } from "./units";
import { testRegistry, toyGainKernel, toySineKernel } from "./testKernels";

const SR = 48000;

describe("toy-sine kernel", () => {
  it("renders ~440 Hz: counts ~440 positive-going zero crossings over one second", () => {
    const state = toySineKernel.init(SR);
    const out = new Float32Array(BLOCK_FRAMES);
    const params = new Float32Array([440]);

    const blocks = Math.floor(SR / BLOCK_FRAMES);
    let crossings = 0;
    let prev = 0;
    for (let b = 0; b < blocks; b++) {
      toySineKernel.process(state, [], [out], params, BLOCK_FRAMES);
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        if (prev <= 0 && out[i] > 0) crossings++;
        prev = out[i];
      }
    }

    const seconds = (blocks * BLOCK_FRAMES) / SR;
    const hz = crossings / seconds;
    expect(hz).toBeGreaterThan(435);
    expect(hz).toBeLessThan(445);
  });
});

describe("toy-gain kernel", () => {
  it("scales the input buffer by params[0]", () => {
    const state = toyGainKernel.init(SR);
    const input = new Float32Array([1, -2, 0.5, 0]);
    const out = new Float32Array(4);

    toyGainKernel.process(state, [input], [out], new Float32Array([0.25]), 4);

    expect(Array.from(out)).toEqual([0.25, -0.5, 0.125, 0]);
  });

  it("outputs silence when the input jack is unpatched (null)", () => {
    const state = toyGainKernel.init(SR);
    const out = new Float32Array([9, 9, 9, 9]);

    toyGainKernel.process(state, [null], [out], new Float32Array([1]), 4);

    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });
});

describe("test registry fixture", () => {
  it("contains exactly the toy modules, wired to their kernels", () => {
    expect(Array.from(testRegistry.keys()).sort()).toEqual(["toy-gain", "toy-sine"]);
    expect(testRegistry.get("toy-sine")?.kernel).toBe(toySineKernel);
    expect(testRegistry.get("toy-gain")?.kernel).toBe(toyGainKernel);
  });
});
