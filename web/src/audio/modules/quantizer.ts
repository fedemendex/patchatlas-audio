// Quantizer kernel for slug "quantizer".
// Snaps an incoming 1 V/oct pitch CV to the nearest note in the selected
// scale. All scales are fixed to a C root (docs/audio/signals.md: 0 V = C4).
//
// Algorithm: 1 semitone = 1/12 V (see oscillator.ts's Fine param range for
// the same convention). For each pitch class in the selected scale, find
// that pitch class's closest octave-shifted instance to the input:
//   candidate = pc + 12 * round((semitones - pc) / 12)
// then keep whichever candidate (across the whole scale) is closest to the
// input, searching every octave rather than only the input's own octave so
// notes near a B/C boundary quantize correctly. This is done per pitch
// class rather than by first rounding the input to the nearest integer
// semitone and then looking up a scale table: pre-rounding can pick the
// wrong side of a tie whenever two allowed notes are an even number of
// semitones apart (e.g. the common whole-step gap in major/minor scales),
// because the true midpoint then falls on an integer, not a rounding
// boundary. Exact ties resolve to the higher note.
//
// The output is never smoothed — smoothing a quantized CV would transiently
// pass through out-of-scale voltages between two allowed notes, defeating
// the point of quantizing.
//
// Jack layout:
//   ins[0] = CV   outs[0] = Out
//   params[0] = Scale (0=Chrom, 1=Maj, 2=Min, 3=Pent, 4=Harm Min)

import type { Kernel } from "../engine/kernel";

// Pitch classes (semitones above C) for each Scale position, fixed C root.
const SCALE_TABLES: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // Chrom: chromatic
  [0, 2, 4, 5, 7, 9, 11], // Maj: C major
  [0, 2, 3, 5, 7, 8, 10], // Min: C natural minor
  [0, 2, 4, 7, 9], // Pent: C major pentatonic
  [0, 2, 3, 5, 7, 8, 11], // Harm Min: C harmonic minor
];

const SCALE_COUNT = SCALE_TABLES.length;

// Tolerance for treating two candidate distances as an exact tie, given
// floating-point noise in the candidate arithmetic below.
const TIE_EPSILON = 1e-9;

interface QuantizerState {}

export const quantizerKernel: Kernel<QuantizerState> = {
  init(_sr): QuantizerState {
    return {};
  },

  process(_state, ins, outs, params, n) {
    const inp = ins[0];
    const out = outs[0];

    let scaleF = params[0];
    if (!Number.isFinite(scaleF)) scaleF = 0;
    let scaleIdx = Math.round(scaleF);
    if (scaleIdx < 0) scaleIdx = 0;
    else if (scaleIdx > SCALE_COUNT - 1) scaleIdx = SCALE_COUNT - 1;

    const scale = SCALE_TABLES[scaleIdx];
    const len = scale.length;

    for (let i = 0; i < n; i++) {
      let v = inp !== null ? inp[i] : 0;
      if (!Number.isFinite(v)) v = 0;

      const semitones = v * 12;
      if (!Number.isFinite(semitones)) {
        // v*12 overflowed (an extreme finite v) — fall back to C rather
        // than propagate a non-finite value into the search below.
        out[i] = 0;
        continue;
      }

      let bestCandidate = 0;
      let bestDist = Infinity;
      for (let k = 0; k < len; k++) {
        const pc = scale[k];
        const octave = Math.round((semitones - pc) / 12);
        const candidate = pc + 12 * octave;
        const dist = Math.abs(candidate - semitones);
        if (dist < bestDist - TIE_EPSILON) {
          bestDist = dist;
          bestCandidate = candidate;
        } else if (dist < bestDist + TIE_EPSILON && candidate > bestCandidate) {
          bestCandidate = candidate;
        }
      }

      out[i] = bestCandidate / 12;
    }
  },
};
