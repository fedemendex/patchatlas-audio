import { describe, expect, it } from "vitest";
import type { Kernel } from "./kernel";
import type { ModuleDSP } from "../modules/registry";
import type { EngineGraph } from "./graph";
import { testRegistry } from "./testKernels";
import { BLOCK_FRAMES, C4_HZ } from "./units";
import { Interpreter, PARAM_SMOOTH_SECONDS } from "./interpreter";

const SR = 48000;

// ── Test-only DSP fixtures ──────────────────────────────────────────────────
// Toy tap/mix/dc kernels for exercising the interpreter until AP-5's real
// audio-output exists. Like the AP-2 toys, these slugs are not seeded and must
// never enter the production registry.

/** Copies ins[c] → outs[c] (silence when unpatched). With audioOutput metadata
 *  this makes outs the internal DAC-domain buffers readOutput() sums. */
const tapKernel: Kernel<null> = {
  init: () => null,
  process(_state, ins, outs, _params, n) {
    for (let c = 0; c < outs.length; c++) {
      const src = c < ins.length ? ins[c] : null;
      const out = outs[c];
      if (src === null) {
        for (let i = 0; i < n; i++) out[i] = 0;
      } else {
        for (let i = 0; i < n; i++) out[i] = src[i];
      }
    }
  },
};

/** outs[0] = ins[0] + ins[1]; unpatched slots are silence. */
const mixKernel: Kernel<null> = {
  init: () => null,
  process(_state, ins, outs, _params, n) {
    const a = ins[0];
    const b = ins[1];
    const out = outs[0];
    for (let i = 0; i < n; i++) {
      out[i] = (a === null ? 0 : a[i]) + (b === null ? 0 : b[i]);
    }
  },
};

/** outs[0][i] = params[0] — a DC source that exposes the smoothed param directly. */
const dcKernel: Kernel<null> = {
  init: () => null,
  process(_state, _ins, outs, params, n) {
    const out = outs[0];
    const level = params[0];
    for (let i = 0; i < n; i++) out[i] = level;
  },
};

/**
 * Reports a `gates` bitmask that advances one block at a time, so a test can
 * tell a real readGates call apart from a fixed value. Outputs silence.
 */
const gateReporterKernel: Kernel<{ gates: number }> = {
  init: () => ({ gates: 0 }),
  process(state, _ins, outs, _params, n) {
    for (let c = 0; c < outs.length; c++) {
      const out = outs[c];
      for (let i = 0; i < n; i++) out[i] = 0;
    }
    state.gates += 1;
  },
};

const fixtureRegistry = new Map<string, ModuleDSP>([
  ...testRegistry,
  [
    "toy-gates",
    {
      slug: "toy-gates",
      kernel: gateReporterKernel,
      inJacks: [],
      outJacks: ["A", "B"],
      params: {},
      reportsGates: true,
    },
  ],
  [
    "toy-tap",
    {
      slug: "toy-tap",
      kernel: tapKernel,
      inJacks: ["In"],
      outJacks: [],
      params: {},
      audioOutput: { channels: 1 },
    },
  ],
  [
    "toy-tap-stereo",
    {
      slug: "toy-tap-stereo",
      kernel: tapKernel,
      inJacks: ["L", "R"],
      outJacks: [],
      params: {},
      audioOutput: { channels: 2 },
    },
  ],
  [
    "toy-mix2",
    {
      slug: "toy-mix2",
      kernel: mixKernel,
      inJacks: ["A", "B"],
      outJacks: ["Out"],
      params: {},
    },
  ],
  [
    "toy-dc",
    {
      slug: "toy-dc",
      kernel: dcKernel,
      inJacks: [],
      outJacks: ["Out"],
      params: { Level: { min: 0, max: 10, default: 0, curve: "linear" } },
    },
  ],
]);

// ── Graph + render helpers ──────────────────────────────────────────────────

interface EdgeSpec {
  from: [number, number];
  to: [number, number];
  feedback?: boolean;
}

function graphOf(
  nodes: { id: string; slug: string; params?: number[] }[],
  edges: EdgeSpec[] = [],
  outputNodes: number[] = [],
): EngineGraph {
  return {
    nodes: nodes.map((n) => ({ instanceId: n.id, slug: n.slug, params: n.params ?? [] })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, feedback: e.feedback ?? false })),
    outputNodes,
  };
}

/** Render `blocks` full blocks and return concatenated L/R output. */
function render(interp: Interpreter, blocks: number): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(blocks * BLOCK_FRAMES);
  const right = new Float32Array(blocks * BLOCK_FRAMES);
  const l = new Float32Array(BLOCK_FRAMES);
  const r = new Float32Array(BLOCK_FRAMES);
  for (let b = 0; b < blocks; b++) {
    interp.runBlock(BLOCK_FRAMES);
    interp.readOutput(l, r, BLOCK_FRAMES);
    left.set(l, b * BLOCK_FRAMES);
    right.set(r, b * BLOCK_FRAMES);
  }
  return { left, right };
}

function risingZeroCrossings(buf: Float32Array): number {
  let count = 0;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1] < 0 && buf[i] >= 0) count++;
  }
  return count;
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Interpreter", () => {
  it("renders toy-sine at C4 through a tap: ~261.6 Hz over 1 s", () => {
    // toy-sine's param is frequency in Hz directly (no 1 V/oct mapping), so
    // "0 V equivalent" is pinned here as params: [C4_HZ].
    const graph = graphOf(
      [
        { id: "sine", slug: "toy-sine", params: [C4_HZ] },
        { id: "tap", slug: "toy-tap" },
      ],
      [{ from: [0, 0], to: [1, 0] }],
      [1],
    );
    const interp = new Interpreter(graph, fixtureRegistry, SR);

    const blocks = Math.floor(SR / BLOCK_FRAMES); // just under 1 s
    const { left } = render(interp, blocks);
    const seconds = (blocks * BLOCK_FRAMES) / SR;

    const crossings = risingZeroCrossings(left) / seconds;
    expect(crossings).toBeGreaterThan(C4_HZ - 2);
    expect(crossings).toBeLessThan(C4_HZ + 2);
  });

  it("toy-gain at 0.5 halves the RMS of the sine", () => {
    const chain = (gain: number) =>
      new Interpreter(
        graphOf(
          [
            { id: "sine", slug: "toy-sine", params: [C4_HZ] },
            { id: "gain", slug: "toy-gain", params: [gain] },
            { id: "tap", slug: "toy-tap" },
          ],
          [
            { from: [0, 0], to: [1, 0] },
            { from: [1, 0], to: [2, 0] },
          ],
          [2],
        ),
        fixtureRegistry,
        SR,
      );

    const blocks = Math.floor(SR / BLOCK_FRAMES);
    const unity = render(chain(1), blocks);
    const halved = render(chain(0.5), blocks);

    // Multiplying by 0.5 is exact in float32, so the ratio is numerically tight.
    expect(rms(halved.left) / rms(unity.left)).toBeCloseTo(0.5, 6);
    // Sanity: absolute level matches a ±5 V sine attenuated to ±2.5 V.
    expect(rms(halved.left)).toBeCloseTo(2.5 / Math.SQRT2, 2);
  });

  describe("readOutput", () => {
    it("sums multiple audioOutput nodes into the caller's arrays", () => {
      const one = new Interpreter(
        graphOf(
          [
            { id: "sine", slug: "toy-sine", params: [C4_HZ] },
            { id: "tap1", slug: "toy-tap" },
          ],
          [{ from: [0, 0], to: [1, 0] }],
          [1],
        ),
        fixtureRegistry,
        SR,
      );
      const two = new Interpreter(
        graphOf(
          [
            { id: "sine", slug: "toy-sine", params: [C4_HZ] },
            { id: "tap1", slug: "toy-tap" },
            { id: "tap2", slug: "toy-tap" },
          ],
          [
            { from: [0, 0], to: [1, 0] },
            { from: [0, 0], to: [2, 0] },
          ],
          [1, 2],
        ),
        fixtureRegistry,
        SR,
      );

      const single = render(one, 4);
      const summed = render(two, 4);

      for (let i = 0; i < summed.left.length; i++) {
        expect(summed.left[i]).toBeCloseTo(2 * single.left[i], 5);
      }
    });

    it("feeds a one-channel audioOutput to both left and right", () => {
      const interp = new Interpreter(
        graphOf(
          [
            { id: "sine", slug: "toy-sine", params: [C4_HZ] },
            { id: "tap", slug: "toy-tap" },
          ],
          [{ from: [0, 0], to: [1, 0] }],
          [1],
        ),
        fixtureRegistry,
        SR,
      );

      const { left, right } = render(interp, 4);

      expect(rms(left)).toBeGreaterThan(1);
      expect(right).toEqual(left);
    });

    it("maps a two-channel audioOutput as outs[0] → left, outs[1] → right", () => {
      // Patch the sine into L only: left carries signal, right stays silent —
      // proving the channels are mapped separately, not mixed or mirrored.
      const interp = new Interpreter(
        graphOf(
          [
            { id: "sine", slug: "toy-sine", params: [C4_HZ] },
            { id: "tap", slug: "toy-tap-stereo" },
          ],
          [{ from: [0, 0], to: [1, 0] }],
          [1],
        ),
        fixtureRegistry,
        SR,
      );

      const { left, right } = render(interp, 4);

      expect(rms(left)).toBeGreaterThan(1);
      expect(rms(right)).toBe(0);
    });

    it("produces silence when the graph has no output nodes, clearing stale caller data", () => {
      const interp = new Interpreter(
        graphOf([{ id: "sine", slug: "toy-sine", params: [C4_HZ] }], [], []),
        fixtureRegistry,
        SR,
      );

      const left = new Float32Array(BLOCK_FRAMES).fill(123);
      const right = new Float32Array(BLOCK_FRAMES).fill(-42);
      interp.runBlock(BLOCK_FRAMES);
      interp.readOutput(left, right, BLOCK_FRAMES);

      expect(left).toEqual(new Float32Array(BLOCK_FRAMES));
      expect(right).toEqual(new Float32Array(BLOCK_FRAMES));
    });
  });

  describe("feedback", () => {
    it("delays a feedback edge by exactly BLOCK_FRAMES regardless of node order", () => {
      // A forward edge marked feedback: the interpreter must not second-guess
      // AP-3's marking — feedback means previous-block input, full stop.
      const interp = new Interpreter(
        graphOf(
          [
            { id: "sine", slug: "toy-sine", params: [C4_HZ] },
            { id: "tap", slug: "toy-tap" },
          ],
          [{ from: [0, 0], to: [1, 0], feedback: true }],
          [1],
        ),
        fixtureRegistry,
        SR,
      );

      const blocks = 8;
      const delayed = render(interp, blocks).left;
      const reference = bareSine(blocks);

      // First block reads the zeroed previous-block buffer.
      expect(delayed.slice(0, BLOCK_FRAMES)).toEqual(new Float32Array(BLOCK_FRAMES));
      // Every later sample is the reference shifted by exactly one block.
      for (let i = BLOCK_FRAMES; i < blocks * BLOCK_FRAMES; i++) {
        expect(delayed[i]).toBe(reference[i - BLOCK_FRAMES]);
      }
    });

    it("renders a gain loop < 1.0 stable, with the loop contribution lagging one block", () => {
      // sine → mix.A; mix → gain(0.5); gain → mix.B (feedback, backward edge
      // as AP-3 marks it); mix → tap. Per block: y[b] = x[b] + 0.5·y[b-1].
      const interp = new Interpreter(
        graphOf(
          [
            { id: "sine", slug: "toy-sine", params: [C4_HZ] },
            { id: "mix", slug: "toy-mix2" },
            { id: "gain", slug: "toy-gain", params: [0.5] },
            { id: "tap", slug: "toy-tap" },
          ],
          [
            { from: [0, 0], to: [1, 0] },
            { from: [1, 0], to: [2, 0] },
            { from: [2, 0], to: [1, 1], feedback: true },
            { from: [1, 0], to: [3, 0] },
          ],
          [3],
        ),
        fixtureRegistry,
        SR,
      );

      const blocks = 200;
      const y = render(interp, blocks).left;
      const x = bareSine(blocks);

      // Block 0: no feedback contribution yet — output is the dry sine.
      for (let i = 0; i < BLOCK_FRAMES; i++) expect(y[i]).toBe(x[i]);
      // Later blocks: contribution is 0.5 × the output exactly one block ago.
      for (let i = BLOCK_FRAMES; i < blocks * BLOCK_FRAMES; i++) {
        expect(y[i] - x[i]).toBeCloseTo(0.5 * y[i - BLOCK_FRAMES], 4);
      }
      // Stable and bounded: geometric series caps at 5 V / (1 − 0.5) = 10 V.
      let peak = 0;
      for (let i = 0; i < y.length; i++) {
        expect(Number.isFinite(y[i])).toBe(true);
        peak = Math.max(peak, Math.abs(y[i]));
      }
      expect(peak).toBeLessThanOrEqual(10.001);
    });

    it("lets a tap read a feedback-sourcing jack's current block while the loop reads previous", () => {
      // The canonical audible-loop shape AP-3 emits: the same gain.Out jack
      // sources both the feedback edge into the loop AND a plain edge to the
      // tap. The tap must follow the double-buffer flip (current block); the
      // loop input must lag one block.
      const interp = new Interpreter(
        graphOf(
          [
            { id: "sine", slug: "toy-sine", params: [C4_HZ] },
            { id: "mix", slug: "toy-mix2" },
            { id: "gain", slug: "toy-gain", params: [0.5] },
            { id: "tap", slug: "toy-tap" },
          ],
          [
            { from: [0, 0], to: [1, 0] },
            { from: [1, 0], to: [2, 0] },
            { from: [2, 0], to: [1, 1], feedback: true },
            { from: [2, 0], to: [3, 0] },
          ],
          [3],
        ),
        fixtureRegistry,
        SR,
      );

      const blocks = 8;
      const t = render(interp, blocks).left;
      const x = bareSine(blocks);

      // Block 0 is 0.5·x — nonzero, so the tap reads gain's CURRENT block.
      // (A previous-block read would make block 0 silent.)
      for (let i = 0; i < BLOCK_FRAMES; i++) expect(t[i]).toBe(0.5 * x[i]);
      // t[i] = 0.5·y[i] with y[i] = x[i] + t[i−128]: the loop side of the
      // same jack contributes exactly one block late.
      for (let i = BLOCK_FRAMES; i < blocks * BLOCK_FRAMES; i++) {
        expect(t[i]).toBeCloseTo(0.5 * x[i] + 0.5 * t[i - BLOCK_FRAMES], 4);
      }
    });
  });

  describe("fan-in", () => {
    it("sums multiple edges into one input slot instead of last-wins", () => {
      // Drafts only reject exact duplicate cables, so two different sources
      // on one input jack are legal and must both be heard.
      const interp = new Interpreter(
        graphOf(
          [
            { id: "sine", slug: "toy-sine", params: [C4_HZ] },
            { id: "dc", slug: "toy-dc", params: [2] },
            { id: "tap", slug: "toy-tap" },
          ],
          [
            { from: [0, 0], to: [2, 0] },
            { from: [1, 0], to: [2, 0] },
          ],
          [2],
        ),
        fixtureRegistry,
        SR,
      );

      const blocks = 4;
      const { left } = render(interp, blocks);
      const reference = bareSine(blocks);

      for (let i = 0; i < blocks * BLOCK_FRAMES; i++) {
        expect(left[i]).toBeCloseTo(reference[i] + 2, 4);
      }
    });

    it("keeps a mixed feedback + non-feedback fan-in summed consistently across flips", () => {
      // tap.In receives dc.Out (current block, ≡2) plus gain.Out marked
      // feedback (previous block; gain outputs 0.5·2 ≡ 1). Expected: block 0
      // is 2 (feedback side still zeroed), every later block is 3. Failure
      // modes this pins down: last-wins wiring would stay at 2 (or 1)
      // forever, and a feedback ref clobbering the slot after the first flip
      // would drop to 1 from block 1 on.
      const interp = new Interpreter(
        graphOf(
          [
            { id: "dc", slug: "toy-dc", params: [2] },
            { id: "gain", slug: "toy-gain", params: [0.5] },
            { id: "tap", slug: "toy-tap" },
          ],
          [
            { from: [0, 0], to: [1, 0] },
            { from: [0, 0], to: [2, 0] },
            { from: [1, 0], to: [2, 0], feedback: true },
          ],
          [2],
        ),
        fixtureRegistry,
        SR,
      );

      const blocks = 6;
      const { left } = render(interp, blocks);

      for (let i = 0; i < BLOCK_FRAMES; i++) expect(left[i]).toBe(2);
      for (let i = BLOCK_FRAMES; i < blocks * BLOCK_FRAMES; i++) expect(left[i]).toBe(3);
    });
  });

  /** Reference render: the bare sine through a tap, same params. */
  function bareSine(blocks: number): Float32Array {
    const interp = new Interpreter(
      graphOf(
        [
          { id: "sine", slug: "toy-sine", params: [C4_HZ] },
          { id: "tap", slug: "toy-tap" },
        ],
        [{ from: [0, 0], to: [1, 0] }],
        [1],
      ),
      fixtureRegistry,
      SR,
    );
    return render(interp, blocks).left;
  }

  describe("setParam smoothing", () => {
    // toy-dc outputs its (smoothed) Level param directly, so each rendered
    // block exposes the param trajectory sample-for-sample.
    function dcInterp(initialLevel: number): Interpreter {
      return new Interpreter(
        graphOf(
          [
            { id: "dc", slug: "toy-dc", params: [initialLevel] },
            { id: "tap", slug: "toy-tap" },
          ],
          [{ from: [0, 0], to: [1, 0] }],
          [1],
        ),
        fixtureRegistry,
        SR,
      );
    }

    it("approaches a stepped target on the pinned ~10 ms one-pole, ≥95% within ~30 ms", () => {
      const interp = dcInterp(0);
      const target = 8;
      interp.setParam("dc", "Level", target);

      // Pinned smoother: once per block, p += α·(target − p) with
      // α = 1 − e^(−n / (sr · PARAM_SMOOTH_SECONDS)) and PARAM_SMOOTH_SECONDS = 10 ms.
      expect(PARAM_SMOOTH_SECONDS).toBe(0.01);
      const alpha = 1 - Math.exp(-BLOCK_FRAMES / (SR * PARAM_SMOOTH_SECONDS));

      const blocks = Math.ceil((0.03 * SR) / BLOCK_FRAMES); // ~30 ms rendered
      const { left } = render(interp, blocks);

      let expected = 0;
      for (let b = 0; b < blocks; b++) {
        expected += alpha * (target - expected);
        // Constant within the block, and exactly on the one-pole trajectory —
        // no instantaneous jump beyond what the smoother allows.
        expect(left[b * BLOCK_FRAMES]).toBeCloseTo(expected, 3);
        expect(left[(b + 1) * BLOCK_FRAMES - 1]).toBeCloseTo(expected, 3);
      }
      // First block moved only one smoothing step, not to the target.
      expect(left[0]).toBeLessThan(alpha * target * 1.001);
      // ≥95% of the target within ~30 ms of rendered time.
      expect(left[blocks * BLOCK_FRAMES - 1]).toBeGreaterThanOrEqual(0.95 * target);
    });

    it("clamps targets to the ParamSpec range", () => {
      // toy-dc Level spec is [0, 10]. ~60 blocks ≈ 160 ms lets the smoother
      // converge, so the rendered level exposes the clamped target.
      const over = dcInterp(0);
      over.setParam("dc", "Level", 99);
      const settledHigh = render(over, 60).left;
      expect(settledHigh[settledHigh.length - 1]).toBeGreaterThan(9.99);
      expect(settledHigh[settledHigh.length - 1]).toBeLessThanOrEqual(10);

      const under = dcInterp(5);
      under.setParam("dc", "Level", -99);
      const settledLow = render(under, 60).left;
      expect(settledLow[settledLow.length - 1]).toBeLessThan(0.01);
      expect(settledLow[settledLow.length - 1]).toBeGreaterThanOrEqual(0);
    });

    it("no-ops on unknown instanceId or controlName", () => {
      const interp = dcInterp(3);

      expect(() => {
        interp.setParam("nope", "Level", 9);
        interp.setParam("dc", "Nope", 9);
      }).not.toThrow();

      const { left } = render(interp, 2);
      for (let i = 0; i < left.length; i++) expect(left[i]).toBeCloseTo(3, 5);
    });
  });

  it("passes null for unpatched input slots and toy kernels render silence", () => {
    // gain and mix.B are left unpatched; mix.A gets the gain's (silent) out.
    const interp = new Interpreter(
      graphOf(
        [
          { id: "gain", slug: "toy-gain", params: [1] },
          { id: "mix", slug: "toy-mix2" },
          { id: "tap", slug: "toy-tap" },
        ],
        [
          { from: [0, 0], to: [1, 0] },
          { from: [1, 0], to: [2, 0] },
        ],
        [2],
      ),
      fixtureRegistry,
      SR,
    );

    const { left, right } = render(interp, 4);

    expect(left).toEqual(new Float32Array(4 * BLOCK_FRAMES));
    expect(right).toEqual(new Float32Array(4 * BLOCK_FRAMES));
  });

  it("throws clearly in the constructor when a node's slug has no registry entry", () => {
    const graph = graphOf([{ id: "ghost", slug: "toy-missing" }], [], []);

    expect(() => new Interpreter(graph, fixtureRegistry, SR)).toThrowError(
      /toy-missing.*ghost/s,
    );
  });

  it("rejects invalid runBlock/readOutput frame counts", () => {
    const interp = new Interpreter(
      graphOf([{ id: "sine", slug: "toy-sine", params: [C4_HZ] }], [], []),
      fixtureRegistry,
      SR,
    );
    const l = new Float32Array(BLOCK_FRAMES);
    const r = new Float32Array(BLOCK_FRAMES);

    expect(() => interp.runBlock(BLOCK_FRAMES + 1)).toThrow(RangeError);
    expect(() => interp.runBlock(0)).toThrow(RangeError);
    expect(() => interp.runBlock(1.5)).toThrow(RangeError);
    expect(() => interp.readOutput(l, r, BLOCK_FRAMES + 1)).toThrow(RangeError);
    // Partial blocks up to BLOCK_FRAMES are legal.
    expect(() => {
      interp.runBlock(BLOCK_FRAMES - 1);
      interp.readOutput(l, r, BLOCK_FRAMES - 1);
    }).not.toThrow();
  });

  it("does not mutate the EngineGraph", () => {
    function deepFreeze<T>(value: T): T {
      if (value !== null && typeof value === "object") {
        for (const inner of Object.values(value)) deepFreeze(inner);
        Object.freeze(value);
      }
      return value;
    }
    const graph = deepFreeze(
      graphOf(
        [
          { id: "sine", slug: "toy-sine", params: [C4_HZ] },
          { id: "gain", slug: "toy-gain", params: [0.5] },
          { id: "tap", slug: "toy-tap" },
        ],
        [
          { from: [0, 0], to: [1, 0] },
          { from: [1, 0], to: [2, 0], feedback: true },
        ],
        [2],
      ),
    );

    // Any write to the frozen graph would throw (test files are strict mode).
    const interp = new Interpreter(graph, fixtureRegistry, SR);
    interp.setParam("gain", "Gain", 1);
    expect(() => render(interp, 4)).not.toThrow();
  });

  it("soak: 30 s of a feedback patch stays finite and bounded", () => {
    // Same stable loop as the feedback test: y[b] = x[b] + 0.5·y[b−1].
    const interp = new Interpreter(
      graphOf(
        [
          { id: "sine", slug: "toy-sine", params: [C4_HZ] },
          { id: "mix", slug: "toy-mix2" },
          { id: "gain", slug: "toy-gain", params: [0.5] },
          { id: "tap", slug: "toy-tap" },
        ],
        [
          { from: [0, 0], to: [1, 0] },
          { from: [1, 0], to: [2, 0] },
          { from: [2, 0], to: [1, 1], feedback: true },
          { from: [1, 0], to: [3, 0] },
        ],
        [3],
      ),
      fixtureRegistry,
      SR,
    );

    const l = new Float32Array(BLOCK_FRAMES);
    const r = new Float32Array(BLOCK_FRAMES);
    const blocks = Math.ceil((30 * SR) / BLOCK_FRAMES);
    let peak = 0;
    let allFinite = true;
    for (let b = 0; b < blocks; b++) {
      interp.runBlock(BLOCK_FRAMES);
      interp.readOutput(l, r, BLOCK_FRAMES);
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        if (!Number.isFinite(l[i])) allFinite = false;
        peak = Math.max(peak, Math.abs(l[i]));
      }
    }

    expect(allFinite).toBe(true);
    expect(peak).toBeGreaterThan(1); // actually producing audio
    expect(peak).toBeLessThanOrEqual(10.001); // geometric series bound
  });
});

describe("Interpreter — gate telemetry (readGates)", () => {
  it("exposes only reportsGates nodes, in graph order", () => {
    const interp = new Interpreter(
      graphOf([
        { id: "dc", slug: "toy-dc" },
        { id: "div-a", slug: "toy-gates" },
        { id: "div-b", slug: "toy-gates" },
      ]),
      fixtureRegistry,
      SR,
    );

    expect(interp.gateReportIds).toEqual(["div-a", "div-b"]);
  });

  it("is empty for a graph with no gate-reporting node", () => {
    const interp = new Interpreter(graphOf([{ id: "dc", slug: "toy-dc" }]), fixtureRegistry, SR);
    expect(interp.gateReportIds).toEqual([]);
  });

  it("writes each node's live gates bitmask into the caller's buffer", () => {
    const interp = new Interpreter(
      graphOf([
        { id: "div-a", slug: "toy-gates" },
        { id: "div-b", slug: "toy-gates" },
      ]),
      fixtureRegistry,
      SR,
    );

    const out = new Int32Array(interp.gateReportIds.length);
    interp.readGates(out);
    expect([...out]).toEqual([0, 0]);

    interp.runBlock(BLOCK_FRAMES);
    interp.readGates(out);
    expect([...out]).toEqual([1, 1]);

    interp.runBlock(BLOCK_FRAMES);
    interp.runBlock(BLOCK_FRAMES);
    interp.readGates(out);
    expect([...out]).toEqual([3, 3]);
  });

  it("does not allocate a fresh buffer — it fills the one it is given", () => {
    const interp = new Interpreter(graphOf([{ id: "div", slug: "toy-gates" }]), fixtureRegistry, SR);
    const out = new Int32Array(1);
    interp.runBlock(BLOCK_FRAMES);
    interp.readGates(out);
    const same = out;
    interp.runBlock(BLOCK_FRAMES);
    interp.readGates(out);
    expect(out).toBe(same);
    expect(out[0]).toBe(2);
  });

  it("keeps the step and gate channels independent", () => {
    const interp = new Interpreter(graphOf([{ id: "div", slug: "toy-gates" }]), fixtureRegistry, SR);
    expect(interp.stepReportIds).toEqual([]);
    expect(interp.gateReportIds).toEqual(["div"]);
  });
});
