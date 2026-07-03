// The pure execution half of the engine: takes a compiled EngineGraph,
// preallocates every buffer and lookup in the constructor, and runs kernels
// block by block. Zero browser dependencies — Vitest renders audio headlessly
// through this class, and the AP-7 worklet is a thin shell over it.
//
// Hot-path discipline (see docs/audio/kernel-checklist.md): runBlock and
// readOutput allocate nothing — no `new`, no object/array literals, no
// closures, no array methods. Plain indexed loops only. All string/map work
// happens in the constructor or in setParam (a cold control path).
//
// Feedback timing note: the one-block feedback delay is guaranteed per render
// block. With partial blocks (n < BLOCK_FRAMES) the delay in samples equals
// the previous block's length; the AP-7 worklet always calls with
// n = BLOCK_FRAMES, where the delay is exactly BLOCK_FRAMES samples.

import type { Kernel } from "./kernel";
import type { ModuleDSP } from "../modules/registry";
import type { EngineEdge, EngineGraph } from "./graph";
import { BLOCK_FRAMES } from "./units";

/**
 * One-pole param smoothing time constant. Each runBlock advances every param
 * toward its target once: p += α·(target − p), α = 1 − e^(−n / (sr · this)).
 */
export const PARAM_SMOOTH_SECONDS = 0.01;

export class Interpreter {
  private readonly sr: number;
  private readonly nodeCount: number;
  private readonly kernels: Kernel<unknown>[];
  private readonly states: unknown[];
  private readonly params: Float32Array[];
  private readonly targets: Float32Array[];
  private readonly ins: (Float32Array | null)[][];
  private readonly outs: Float32Array[][];

  // Cold-path lookups for setParam only; runBlock never touches these.
  private readonly nodeIndexById: Map<string, number>;
  private readonly paramIndexByName: Map<string, number>[];
  private readonly paramMin: Float32Array[];
  private readonly paramMax: Float32Array[];

  // Fan-in mix buffers, grouped by destination node: mixStart[i]..mixStart[i+1]
  // index node i's mixes. Each mix buffer is a stable ins[] ref (never
  // repointed by the feedback swap); runBlock fills it by summing its source
  // refs just before the node processes. The source refs ARE swap-repointed,
  // so feedback sources read the previous block and the rest read current.
  private readonly mixStart: Int32Array;
  private readonly mixBufs: Float32Array[];
  private readonly mixSrcs: Float32Array[][];

  // readOutput sources: internal audioOutput buffers per channel. A
  // one-channel output appears in both lists so it feeds L and R.
  private readonly leftSources: Float32Array[];
  private readonly rightSources: Float32Array[];

  // Feedback double buffers. Each out jack sourcing a feedback edge owns a
  // buffer pair (A/B). `flip` selects the front buffer (written this block):
  // A when 0, B when 1; the back buffer holds the previous block. At block
  // end the flip toggles and the precomputed (holder array, slot) pairs are
  // repointed — reference swapping, never copying. Front pairs are the
  // producer's outs slot plus non-feedback consumers; back pairs are the
  // feedback consumers, which therefore always read the previous block no
  // matter where producer and consumer sit in processing order.
  private flip: number;
  private readonly pairA: Float32Array[];
  private readonly pairB: Float32Array[];
  private readonly frontHolders: (Float32Array | null)[][];
  private readonly frontSlots: number[];
  private readonly frontPair: number[];
  private readonly backHolders: (Float32Array | null)[][];
  private readonly backSlots: number[];
  private readonly backPair: number[];

  constructor(graph: EngineGraph, registry: Map<string, ModuleDSP>, sr: number) {
    const nodes = graph.nodes;
    this.nodeCount = nodes.length;

    const dsps: ModuleDSP[] = nodes.map((node) => {
      const dsp = registry.get(node.slug);
      if (!dsp) {
        throw new Error(
          `Interpreter: no registry entry for slug "${node.slug}" ` +
            `(instance "${node.instanceId}") — compileGraph should have skipped this node`,
        );
      }
      return dsp;
    });

    this.sr = sr;
    this.kernels = dsps.map((d) => d.kernel);
    this.states = dsps.map((d) => d.kernel.init(sr));
    this.params = nodes.map((n) => Float32Array.from(n.params));
    this.targets = nodes.map((n) => Float32Array.from(n.params));

    this.nodeIndexById = new Map(nodes.map((n, i) => [n.instanceId, i]));
    // Param slot order is Object.entries declaration order — never sorted;
    // it must match how compileGraph laid out node.params.
    this.paramIndexByName = dsps.map(
      (dsp) => new Map(Object.keys(dsp.params).map((name, i) => [name, i])),
    );
    this.paramMin = dsps.map((dsp) =>
      Float32Array.from(Object.values(dsp.params), (spec) => spec.min),
    );
    this.paramMax = dsps.map((dsp) =>
      Float32Array.from(Object.values(dsp.params), (spec) => spec.max),
    );

    // Output buffers: one per patchable out jack (dsp.outJacks order), then
    // audioOutput internal DAC-domain buffers in channel order.
    this.outs = dsps.map((dsp) => {
      const bufs: Float32Array[] = dsp.outJacks.map(() => new Float32Array(BLOCK_FRAMES));
      if (dsp.audioOutput) {
        for (let c = 0; c < dsp.audioOutput.channels; c++) {
          bufs.push(new Float32Array(BLOCK_FRAMES));
        }
      }
      return bufs;
    });

    // Input slots default to null (unpatched); edges patch in buffer refs.
    this.ins = dsps.map((dsp) => dsp.inJacks.map(() => null));

    // Allocate a double buffer for every out jack that sources a feedback
    // edge. The already-allocated out buffer becomes side A (the initial
    // front); side B starts zeroed, so the first block's feedback reads
    // silence — exactly one block of delay.
    this.flip = 0;
    this.pairA = [];
    this.pairB = [];
    this.frontHolders = [];
    this.frontSlots = [];
    this.frontPair = [];
    this.backHolders = [];
    this.backSlots = [];
    this.backPair = [];
    const pairByJack = new Map<string, number>();
    for (const edge of graph.edges) {
      if (!edge.feedback) continue;
      const [fromNode, outSlot] = edge.from;
      const key = `${fromNode}:${outSlot}`;
      if (pairByJack.has(key)) continue;
      pairByJack.set(key, this.pairA.length);
      this.pairA.push(this.outs[fromNode][outSlot]);
      this.pairB.push(new Float32Array(BLOCK_FRAMES));
      this.frontHolders.push(this.outs[fromNode]);
      this.frontSlots.push(outSlot);
      this.frontPair.push(this.pairA.length - 1);
    }

    // Points holder[slot] at an edge's source buffer: the plain out buffer,
    // or — when the source jack is double-buffered — the front (current) or
    // back (previous block) side, registered for repointing at each flip.
    const wire = (edge: EngineEdge, holder: (Float32Array | null)[], slot: number): void => {
      const [fromNode, outSlot] = edge.from;
      const pair = pairByJack.get(`${fromNode}:${outSlot}`);
      if (pair === undefined) {
        holder[slot] = this.outs[fromNode][outSlot];
      } else if (edge.feedback) {
        holder[slot] = this.pairB[pair];
        this.backHolders.push(holder);
        this.backSlots.push(slot);
        this.backPair.push(pair);
      } else {
        holder[slot] = this.pairA[pair];
        this.frontHolders.push(holder);
        this.frontSlots.push(slot);
        this.frontPair.push(pair);
      }
    };

    // Wire inputs, grouping edges by destination slot. Zero edges leaves the
    // slot null (unpatched), one edge wires the source buffer directly, and
    // several edges — fan-in is legal, drafts only reject exact duplicate
    // cables — share a mix buffer summed from all sources every block.
    const edgesByInput = new Map<string, EngineEdge[]>();
    for (const edge of graph.edges) {
      const key = `${edge.to[0]}:${edge.to[1]}`;
      const group = edgesByInput.get(key);
      if (group) group.push(edge);
      else edgesByInput.set(key, [edge]);
    }

    this.mixBufs = [];
    this.mixSrcs = [];
    this.mixStart = new Int32Array(nodes.length + 1);
    for (let i = 0; i < nodes.length; i++) {
      for (let slot = 0; slot < dsps[i].inJacks.length; slot++) {
        const group = edgesByInput.get(`${i}:${slot}`);
        if (!group) continue;
        if (group.length === 1) {
          wire(group[0], this.ins[i], slot);
        } else {
          const mixBuf = new Float32Array(BLOCK_FRAMES);
          this.ins[i][slot] = mixBuf;
          // Placeholder entries; wire() immediately repoints each one.
          const srcs = new Array<Float32Array>(group.length).fill(mixBuf);
          for (let k = 0; k < group.length; k++) wire(group[k], srcs, k);
          this.mixBufs.push(mixBuf);
          this.mixSrcs.push(srcs);
        }
      }
      this.mixStart[i + 1] = this.mixBufs.length;
    }

    this.leftSources = [];
    this.rightSources = [];
    for (const nodeIndex of graph.outputNodes) {
      const dsp = dsps[nodeIndex];
      if (!dsp.audioOutput) continue;
      const firstChannel = dsp.outJacks.length;
      if (dsp.audioOutput.channels === 1) {
        this.leftSources.push(this.outs[nodeIndex][firstChannel]);
        this.rightSources.push(this.outs[nodeIndex][firstChannel]);
      } else {
        this.leftSources.push(this.outs[nodeIndex][firstChannel]);
        this.rightSources.push(this.outs[nodeIndex][firstChannel + 1]);
      }
    }
  }

  runBlock(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > BLOCK_FRAMES) {
      throw new RangeError(`Interpreter.runBlock: n must be an integer in [1, ${BLOCK_FRAMES}], got ${n}`);
    }
    const count = this.nodeCount;
    const kernels = this.kernels;
    const states = this.states;
    const params = this.params;
    const targets = this.targets;
    const ins = this.ins;
    const outs = this.outs;
    const mixStart = this.mixStart;
    const mixBufs = this.mixBufs;
    const mixSrcs = this.mixSrcs;
    const alpha = 1 - Math.exp(-n / (this.sr * PARAM_SMOOTH_SECONDS));
    for (let i = 0; i < count; i++) {
      // Fill this node's fan-in mixes: by now every current-block source has
      // already run, and feedback source refs still point at previous-block
      // buffers — summing here keeps both timings correct.
      for (let m = mixStart[i]; m < mixStart[i + 1]; m++) {
        const buf = mixBufs[m];
        const srcs = mixSrcs[m];
        for (let s = 0; s < n; s++) buf[s] = 0;
        for (let k = 0; k < srcs.length; k++) {
          const src = srcs[k];
          for (let s = 0; s < n; s++) buf[s] += src[s];
        }
      }
      const p = params[i];
      const t = targets[i];
      for (let j = 0; j < p.length; j++) {
        p[j] += alpha * (t[j] - p[j]);
      }
      kernels[i].process(states[i], ins[i], outs[i], p, n);
    }

    // Swap feedback double buffers by repointing the precomputed refs.
    const flip = this.flip ^ 1;
    this.flip = flip;
    const pairA = this.pairA;
    const pairB = this.pairB;
    const frontHolders = this.frontHolders;
    const frontSlots = this.frontSlots;
    const frontPair = this.frontPair;
    for (let k = 0; k < frontHolders.length; k++) {
      const p = frontPair[k];
      frontHolders[k][frontSlots[k]] = flip === 0 ? pairA[p] : pairB[p];
    }
    const backHolders = this.backHolders;
    const backSlots = this.backSlots;
    const backPair = this.backPair;
    for (let k = 0; k < backHolders.length; k++) {
      const p = backPair[k];
      backHolders[k][backSlots[k]] = flip === 0 ? pairB[p] : pairA[p];
    }
  }

  readOutput(left: Float32Array, right: Float32Array, n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > BLOCK_FRAMES) {
      throw new RangeError(`Interpreter.readOutput: n must be an integer in [1, ${BLOCK_FRAMES}], got ${n}`);
    }
    for (let i = 0; i < n; i++) {
      left[i] = 0;
      right[i] = 0;
    }
    const leftSources = this.leftSources;
    for (let k = 0; k < leftSources.length; k++) {
      const src = leftSources[k];
      for (let i = 0; i < n; i++) left[i] += src[i];
    }
    const rightSources = this.rightSources;
    for (let k = 0; k < rightSources.length; k++) {
      const src = rightSources[k];
      for (let i = 0; i < n; i++) right[i] += src[i];
    }
  }

  /**
   * Sets a param's smoothing target, clamped to the ParamSpec [min, max]
   * range (engine units). Unknown instance/control is a no-op.
   */
  setParam(instanceId: string, controlName: string, value: number): void {
    const nodeIndex = this.nodeIndexById.get(instanceId);
    if (nodeIndex === undefined) return;
    const paramIndex = this.paramIndexByName[nodeIndex].get(controlName);
    if (paramIndex === undefined) return;
    const min = this.paramMin[nodeIndex][paramIndex];
    const max = this.paramMax[nodeIndex][paramIndex];
    this.targets[nodeIndex][paramIndex] = value < min ? min : value > max ? max : value;
  }
}
