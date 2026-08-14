// @vitest-environment node
//
// Whole-patch tests for the function generator's Cycle gate, driven through
// the REAL compilePatch + Interpreter rather than by hand-chaining kernels.
// The kernel suite (functionGenerator.test.ts) proves the DSP; this proves the
// path around it — jack-name → in-slot resolution, node ordering, and the
// one-block feedback edge a self-patch compiles to — because a Cycle cable can
// fail in the graph without the kernel being wrong.
//
// Every case here asserts the same thing in different shapes: a gate into
// Cycle produces SUSTAINED cycling, never one envelope per event. The
// distinction is not subtle in the numbers — a cycling patch shows tens of
// cycles per second where a one-shot shows one per trigger.

import { describe, it, expect } from "vitest";
import { compilePatch } from "../engine/compile";
import { Interpreter } from "../engine/interpreter";
import { registry } from "./registry";
import { getModuleDefinitions } from "./definitions";
import type { Patch } from "../engine/patch";
import { BLOCK_FRAMES, GATE_HIGH_V } from "../engine/units";

const SR = 48000;
const definitions = new Map(getModuleDefinitions().map((d) => [d.slug, d]));

interface Measured {
  /** Completed falls (rising edges of the node's EOC). */
  cycles: number;
  /** Fraction of samples where the node's Out is off the floor. */
  activeFraction: number;
  peak: number;
}

/**
 * Runs `patch` for `seconds` and measures one node's Out/EOC.
 *
 * Reaching into `interpreter.outs` is a deliberate test-only cast: the node
 * under observation is a function generator, not an audio-output, so
 * readOutput() cannot see it — and routing it through an audio-output instead
 * would DC-block and rescale exactly the envelope shape being measured.
 */
function measure(patch: Patch, watchId: string, seconds: number): Measured {
  const { graph, diagnostics } = compilePatch(patch, definitions);
  // Only the expected "nothing is wired to a speaker" diagnostic may appear;
  // a dropped Cycle cable would show up here as unknown-jack and must not.
  expect(diagnostics.map((d) => d.code)).toEqual(["no-audio-output"]);

  const interp = new Interpreter(graph, registry, SR);
  const nodeIndex = graph.nodes.findIndex((n) => n.instanceId === watchId);
  expect(nodeIndex).toBeGreaterThanOrEqual(0);
  const outs = (interp as unknown as { outs: Float32Array[][] }).outs;

  const total = SR * seconds;
  let moving = 0;
  let cycles = 0;
  let peak = 0;
  let prevEoc = GATE_HIGH_V;
  for (let s = 0; s < total; s += BLOCK_FRAMES) {
    interp.runBlock(BLOCK_FRAMES);
    const out = outs[nodeIndex][0];
    const eoc = outs[nodeIndex][2];
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      if (out[i] > 0.01) moving++;
      if (out[i] > peak) peak = out[i];
      if (eoc[i] === GATE_HIGH_V && prevEoc === 0) cycles++;
      prevEoc = eoc[i];
    }
  }
  return { cycles, activeFraction: moving / total, peak };
}

const fg = (id: string, params: Record<string, number>) => ({
  id,
  type: "function-generator",
  params,
});

// A master slow enough to make a usable gate, and a slave fast enough to fit
// several cycles inside it — the ratio that makes cycling audible AS cycling.
const CYCLING_MASTER = { Rise: 0.25, Fall: 0.25, Curve: 0, Cycle: 1 };
const FAST_SLAVE = { Rise: 0.01, Fall: 0.04, Curve: 0, Cycle: 0 };
const SECONDS = 2;
// A one-shot-per-event patch could not exceed a handful of cycles in 2 s; real
// cycling clears this by a wide margin, so the threshold needs no tuning.
const CYCLING_FLOOR = 10;

describe("function generator Cycle — whole-patch behavior through the compiler", () => {
  for (const src of ["EOR", "EOC"] as const) {
    it(`a cycling master's ${src} keeps a slave cycling, not one-shotting`, () => {
      const { cycles, peak } = measure(
        {
          modules: [fg("a-master", CYCLING_MASTER), fg("b-slave", FAST_SLAVE)],
          connections: [{ from: ["a-master", src], to: ["b-slave", "Cycle"] }],
        },
        "b-slave",
        SECONDS,
      );
      expect(cycles).toBeGreaterThan(CYCLING_FLOOR);
      expect(peak).toBeCloseTo(10, 1);
    });

    it(`${src} self-patched into its own Cycle free-runs across the feedback edge`, () => {
      // A self-patch is a graph CYCLE: the compiler marks the back edge and the
      // interpreter reads the previous block's buffer. Cycling must survive
      // that one-block delay.
      const { cycles, activeFraction } = measure(
        {
          modules: [fg("solo", FAST_SLAVE)],
          connections: [{ from: ["solo", src], to: ["solo", "Cycle"] }],
        },
        "solo",
        SECONDS,
      );
      expect(cycles).toBeGreaterThan(CYCLING_FLOOR);
      expect(activeFraction).toBeGreaterThan(0.9); // essentially never at rest
    });

    it(`a clock-TRIGGERED master's ${src} still drives sustained slave cycling`, () => {
      // The shape a user reaches for first: the master is fired by a clock
      // rather than cycling on its own button. Its EOR/EOC still gate the
      // slave — note both sit HIGH while the master rests, so the slave runs
      // freely between triggers rather than stopping.
      const { cycles } = measure(
        {
          modules: [
            { id: "a-clk", type: "clock", params: { Tempo: 120, Swing: 0 } },
            fg("b-master", { Rise: 0.01, Fall: 0.3, Curve: 0, Cycle: 0 }),
            fg("c-slave", FAST_SLAVE),
          ],
          connections: [
            { from: ["a-clk", "Clk"], to: ["b-master", "Trig"] },
            { from: ["b-master", src], to: ["c-slave", "Cycle"] },
          ],
        },
        "c-slave",
        SECONDS,
      );
      expect(cycles).toBeGreaterThan(CYCLING_FLOOR);
    });
  }

  it("a slave whose own cycle is longer than the gate yields ONE cycle per gate", () => {
    // The trap, pinned as behavior rather than left as folklore: cycles-per-
    // gate is gateDuration / (slave Rise + Fall). With the stock Fall of 0.3 s
    // the slave's 0.31 s period exceeds the 0.25 s gate, so it completes
    // exactly one cycle per gate — audibly identical to patching Trig, and the
    // usual reason a working Cycle cable looks broken.
    const slowSlave = { Rise: 0.01, Fall: 0.3, Curve: 0, Cycle: 0 };
    const { cycles } = measure(
      {
        modules: [fg("a-master", CYCLING_MASTER), fg("b-slave", slowSlave)],
        connections: [{ from: ["a-master", "EOC"], to: ["b-slave", "Cycle"] }],
      },
      "b-slave",
      SECONDS,
    );
    // ~2 gates per second, one cycle each — not the >10 of real cycling.
    expect(cycles).toBeLessThanOrEqual(5);
  });
});
