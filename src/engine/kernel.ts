// The fixed contract every module kernel implements. Internal: this is a
// contributor contract, not a public plugin API — it is not exported from
// src/index.ts, and consumers cannot register kernels at runtime.
// See docs/adding-a-kernel.md and docs/kernel-checklist.md before adding one.

export interface Kernel<S> {
  /** Allocate ALL state here. `sr` is the environment sample rate — never hardcoded. */
  init(sr: number): S;
  process(
    state: S,
    ins: (Float32Array | null)[], // null = unpatched jack
    outs: Float32Array[], // write every sample, every block
    params: Float32Array, // smoothed control values (engine units)
    n: number, // frames this block
  ): void; // no allocation, no exceptions
}

export interface ParamSpec {
  min: number;
  max: number;
  default: number;
  curve: "linear" | "exponential" | "positions";
  positions?: string[]; // for switch controls
}
