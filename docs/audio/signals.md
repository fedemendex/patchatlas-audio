# Audio Engine — Signal and Voltage Standard

This is the canonical reference for the virtual-voltage convention used by every kernel in
the audio preview engine. All numbers are normative. Kernels must import constants from
`web/src/audio/engine/units.ts`; no kernel may hardcode tuning or gate constants.

## Signal types

| Signal | Convention |
|--------|------------|
| Audio | ±5 V nominal; headroom above ±5 V is legal inside the graph; clipping happens **only** in `audio-output` |
| Bipolar CV (LFO, FM amounts, etc.) | ±5 V |
| Unipolar CV (envelopes, VCA levels, etc.) | 0 → 10 V |
| Pitch | 1 V/oct; 0 V = C4 = 261.6256 Hz; `freq = C4_HZ * 2 ** volts` |
| Gates | 0 V low / 10 V high; inputs use a Schmitt trigger: re-arm below 0.1 V, fire at ≥ 1 V |
| Triggers | 1 ms pulse at 10 V |

## DAC conversion (audio-output only)

`audio-output` is the sole point where virtual volts become DAC floats:

```
sample = tanh(volts / AUDIO_NORM)   // AUDIO_NORM = 5
```

Dividing by 5 maps ±5 V to ±1.0; `tanh` provides soft clipping for signals above ±5 V.
No other module converts volts to floats.

## Timing

- **Sample rate**: taken from the environment (`AudioContext.sampleRate`) at kernel init.
  It is never hardcoded. Kernels receive `sr` as a parameter to their `init()` function.
- **Block size**: 128 frames (the Web Audio render quantum). Jacks carry a mono
  `Float32Array` of 128 samples per block. Kernels loop per-sample inside a block.

## Jacks

All jacks are mono. There are no stereo jacks in v1.

## Feedback cycles

Cycles in the patch graph are legal. The compiler detects them (SCC analysis) and inserts a
one-block feedback delay (~2.7 ms at 48 kHz) on feedback edges. This is an **accepted
product decision**: the audible artifact is inaudible at normal patch complexity and avoids
the complexity of sub-block iterative solving.

## Kernel rule

**No kernel may hardcode any tuning or gate constant.** Every numeric threshold — `261.6256`,
`5`, `0.1`, `1`, `10`, `0.001`, `128` — must be imported from `units.ts`. Violations are
caught in review using the kernel checklist (AP-2).
