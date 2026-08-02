import { describe, expect, it } from "vitest";
import type { ModuleDSP } from "../modules/registry";
import type { Patch } from "./patch";
import { validate } from "./diagnostics";
import { toyGainKernel, toySineKernel } from "./testKernels";

// A tiny hand-built registry: toy-sine (Freq param, one Out jack) and toy-gain
// (Gain param, one In jack, one Out jack). No audio-output entry, so any
// patch below is expected to surface "no-audio-output" unless noted.
const registry = new Map<string, ModuleDSP>([
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
  [
    "toy-out",
    {
      slug: "toy-out",
      kernel: toyGainKernel,
      inJacks: ["In"],
      outJacks: [],
      params: {},
      audioOutput: { channels: 1 },
    },
  ],
  [
    "toy-thru",
    {
      // A pass-through module whose in-jack and out-jack share the literal
      // name "Sig" — the case a same-name-both-directions Patch schema could
      // plausibly confuse if it ever searched a merged in+out jack list.
      slug: "toy-thru",
      kernel: toyGainKernel,
      inJacks: ["Sig"],
      outJacks: ["Sig"],
      params: {},
    },
  ],
]);

function patch(overrides?: Partial<Patch>): Patch {
  return { modules: [], connections: [], ...overrides };
}

describe("validate", () => {
  it("unknown-module-type: a module whose type has no registry entry", () => {
    const diags = validate(
      patch({ modules: [{ id: "m1", type: "nope" }] }),
      registry,
    );
    expect(diags).toContainEqual({
      code: "unknown-module-type",
      severity: "error",
      dropped: true,
      message: `module "m1" has unknown type "nope"`,
      moduleId: "m1",
    });
  });

  it("unknown-jack: a connection names a jack absent from both in and out lists", () => {
    const diags = validate(
      patch({
        modules: [
          { id: "a", type: "toy-sine" },
          { id: "b", type: "toy-gain" },
        ],
        connections: [{ from: ["a", "Ghost"], to: ["b", "In"] }],
      }),
      registry,
    );
    expect(diags).toContainEqual({
      code: "unknown-jack",
      severity: "error",
      dropped: true,
      message: `module "a" has no output jack "Ghost"`,
      moduleId: "a",
      jack: "Ghost",
      connection: { from: ["a", "Ghost"], to: ["b", "In"] },
    });
  });

  it("unknown-param: a param name not in the module's ParamSpec map", () => {
    const diags = validate(
      patch({ modules: [{ id: "a", type: "toy-sine", params: { Nope: 1 } }] }),
      registry,
    );
    expect(diags).toContainEqual({
      code: "unknown-param",
      severity: "warning",
      dropped: true,
      message: `module "a" has no param "Nope"`,
      moduleId: "a",
      param: "Nope",
    });
  });

  it("unknown-param: a param name that collides with an inherited Object.prototype property", () => {
    // dsp.params is a plain object; a naive `key in dsp.params` check would
    // see "constructor" as present via the prototype chain even though no
    // ParamSpec map actually declares it, silently swallowing the diagnostic.
    const diags = validate(
      patch({ modules: [{ id: "a", type: "toy-sine", params: { constructor: 1, toString: 2 } }] }),
      registry,
    );
    expect(diags).toContainEqual(
      expect.objectContaining({ code: "unknown-param", moduleId: "a", param: "constructor" }),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({ code: "unknown-param", moduleId: "a", param: "toString" }),
    );
  });

  it("invalid-param-value: a known param name with a non-finite value falls back to the default with a diagnostic", () => {
    const diags = validate(
      patch({ modules: [{ id: "a", type: "toy-sine", params: { Freq: NaN } }] }),
      registry,
    );
    expect(diags).toContainEqual({
      code: "invalid-param-value",
      severity: "warning",
      dropped: true,
      message: `module "a" has a non-finite value for param "Freq"; using the default`,
      moduleId: "a",
      param: "Freq",
    });
  });

  it("connection diagnostics are ordered independently of patch.connections' array order", () => {
    const conflicting = patch({
      modules: [
        { id: "a", type: "toy-sine" },
        { id: "b", type: "toy-gain" },
      ],
      connections: [
        { from: ["a", "Ghost1"], to: ["b", "In"] },
        { from: ["a", "Ghost2"], to: ["b", "In"] },
      ],
    });
    const reversed = patch({ ...conflicting, connections: [...conflicting.connections].reverse() });

    const forward = validate(conflicting, registry).filter((d) => d.code === "unknown-jack");
    const backward = validate(reversed, registry).filter((d) => d.code === "unknown-jack");

    expect(backward).toEqual(forward);
  });

  it("duplicate-module-id: two modules share an id", () => {
    const diags = validate(
      patch({
        modules: [
          { id: "a", type: "toy-sine" },
          { id: "a", type: "toy-gain" },
        ],
      }),
      registry,
    );
    const dupDiags = diags.filter((d) => d.code === "duplicate-module-id");
    expect(dupDiags).toHaveLength(2);
    for (const d of dupDiags) {
      expect(d).toMatchObject({ severity: "error", dropped: true, moduleId: "a" });
    }
  });

  it("connection-to-missing-module: a connection references an id no module declares", () => {
    const diags = validate(
      patch({
        modules: [{ id: "a", type: "toy-sine" }],
        connections: [{ from: ["a", "Out"], to: ["ghost", "In"] }],
      }),
      registry,
    );
    expect(diags).toContainEqual({
      code: "connection-to-missing-module",
      severity: "warning",
      dropped: true,
      message: "connection references a module that did not resolve",
      connection: { from: ["a", "Out"], to: ["ghost", "In"] },
    });
  });

  it("jack-direction-mismatch: the from endpoint names an input jack", () => {
    const diags = validate(
      patch({
        modules: [
          { id: "a", type: "toy-gain" },
          { id: "b", type: "toy-gain" },
        ],
        connections: [{ from: ["a", "In"], to: ["b", "In"] }],
      }),
      registry,
    );
    expect(diags).toContainEqual({
      code: "jack-direction-mismatch",
      severity: "error",
      dropped: true,
      message: `"In" on module "a" is an input jack, not an output`,
      moduleId: "a",
      jack: "In",
      connection: { from: ["a", "In"], to: ["b", "In"] },
    });
  });

  it("jack-direction-mismatch: the to endpoint names an output jack", () => {
    const diags = validate(
      patch({
        modules: [
          { id: "a", type: "toy-sine" },
          { id: "b", type: "toy-gain" },
        ],
        connections: [{ from: ["a", "Out"], to: ["b", "Out"] }],
      }),
      registry,
    );
    expect(diags).toContainEqual({
      code: "jack-direction-mismatch",
      severity: "error",
      dropped: true,
      message: `"Out" on module "b" is an output jack, not an input`,
      moduleId: "b",
      jack: "Out",
      connection: { from: ["a", "Out"], to: ["b", "Out"] },
    });
  });

  it("jack-direction-mismatch: both endpoints backwards produce one diagnostic per side", () => {
    // Both jack names are real but swapped: "Out" is toy-sine's output used as
    // the `to` endpoint, "In" is toy-gain's input used as the `from` endpoint.
    const diags = validate(
      patch({
        modules: [
          { id: "a", type: "toy-gain" },
          { id: "b", type: "toy-sine" },
        ],
        connections: [{ from: ["a", "In"], to: ["b", "Out"] }],
      }),
      registry,
    );
    const mismatches = diags.filter((d) => d.code === "jack-direction-mismatch");
    expect(mismatches).toHaveLength(2);
    expect(mismatches).toContainEqual(
      expect.objectContaining({ moduleId: "a", jack: "In" }),
    );
    expect(mismatches).toContainEqual(
      expect.objectContaining({ moduleId: "b", jack: "Out" }),
    );
  });

  it("resolves a module's same-named in/out jacks by connection position, not a merged name lookup", () => {
    // "Sig" as a `from` endpoint must resolve against toy-thru's outJacks;
    // "Sig" as a `to` endpoint must resolve against its inJacks. The two
    // connections below only work if resolution never conflates the two.
    const diags = validate(
      patch({
        modules: [
          { id: "a", type: "toy-sine" },
          { id: "t", type: "toy-thru" },
          { id: "out", type: "toy-out" },
        ],
        connections: [
          { from: ["a", "Out"], to: ["t", "Sig"] },
          { from: ["t", "Sig"], to: ["out", "In"] },
        ],
      }),
      registry,
    );
    expect(diags).toEqual([]);
  });

  it("no-audio-output: no resolved module declares audioOutput", () => {
    const diags = validate(patch({ modules: [{ id: "a", type: "toy-sine" }] }), registry);
    expect(diags).toContainEqual({
      code: "no-audio-output",
      severity: "warning",
      dropped: false,
      message: "patch has no audio-output module",
    });
  });

  it("no-audio-output is absent once an audioOutput module resolves", () => {
    const diags = validate(
      patch({
        modules: [
          { id: "a", type: "toy-sine" },
          { id: "out", type: "toy-out" },
        ],
        connections: [{ from: ["a", "Out"], to: ["out", "In"] }],
      }),
      registry,
    );
    expect(diags.some((d) => d.code === "no-audio-output")).toBe(false);
  });

  it("a fully valid patch has no diagnostics", () => {
    const diags = validate(
      patch({
        modules: [
          { id: "a", type: "toy-sine" },
          { id: "b", type: "toy-gain" },
          { id: "c", type: "toy-out" },
        ],
        connections: [
          { from: ["a", "Out"], to: ["b", "In"] },
          { from: ["b", "Out"], to: ["c", "In"] },
        ],
      }),
      registry,
    );
    expect(diags).toEqual([]);
  });
});
