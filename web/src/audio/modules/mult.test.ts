// @vitest-environment node

import { describe, it, expect } from "vitest";
import { multKernel } from "./mult";
import { BLOCK_FRAMES } from "../engine/units";

const SR = 48000;

function constBuf(len: number, v: number): Float32Array {
  return new Float32Array(len).fill(v);
}

function makeOuts(): Float32Array[] {
  return [0, 1, 2].map(() => new Float32Array(BLOCK_FRAMES));
}

// ── 1. Fan-out correctness ────────────────────────────────────────────────────

describe("mult fan-out", () => {
  it("all three outputs equal the input exactly (bit-exact copy)", () => {
    const state = multKernel.init(SR);
    const inp = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) inp[i] = (i / BLOCK_FRAMES) * 5 - 2.5;
    const outs = makeOuts();
    multKernel.process(state, [inp], outs, new Float32Array(0), BLOCK_FRAMES);
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        expect(outs[j][i]).toBe(inp[i]);
      }
    }
  });

  it("unpatched input writes zeros to all outputs", () => {
    const state = multKernel.init(SR);
    const outs = makeOuts();
    // Fill with sentinel to verify overwrite.
    for (const o of outs) o.fill(99);
    multKernel.process(state, [null], outs, new Float32Array(0), BLOCK_FRAMES);
    for (let j = 0; j < 3; j++) {
      expect(outs[j]).toEqual(new Float32Array(BLOCK_FRAMES));
    }
  });

  it("constant DC signal is copied bit-exactly", () => {
    const state = multKernel.init(SR);
    const inp = constBuf(BLOCK_FRAMES, 3.7);
    const outs = makeOuts();
    multKernel.process(state, [inp], outs, new Float32Array(0), BLOCK_FRAMES);
    for (let j = 0; j < 3; j++) {
      expect(outs[j]).toEqual(inp);
    }
  });

  it("negative voltage is copied exactly (DC-coupled)", () => {
    const state = multKernel.init(SR);
    const inp = constBuf(BLOCK_FRAMES, -4.2);
    const outs = makeOuts();
    multKernel.process(state, [inp], outs, new Float32Array(0), BLOCK_FRAMES);
    for (let j = 0; j < 3; j++) {
      expect(outs[j]).toEqual(inp);
    }
  });

  it("writes all n samples, not just first sample", () => {
    const state = multKernel.init(SR);
    const inp = new Float32Array(BLOCK_FRAMES);
    for (let i = 0; i < BLOCK_FRAMES; i++) inp[i] = i * 0.01;
    const outs = makeOuts();
    multKernel.process(state, [inp], outs, new Float32Array(0), BLOCK_FRAMES);
    // Check last sample is written.
    for (let j = 0; j < 3; j++) {
      expect(outs[j][BLOCK_FRAMES - 1]).toBe(inp[BLOCK_FRAMES - 1]);
    }
  });
});
