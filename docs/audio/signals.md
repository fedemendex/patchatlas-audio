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

`audio-output` is the sole point where virtual volts become DAC floats.
The per-sample chain is:

```
normalized = volts / AUDIO_NORM        // AUDIO_NORM = 5
dcBlocked  = highPass(normalized)      // one-pole high-pass, DC_BLOCKER_CUTOFF_HZ cutoff
output     = tanh(dcBlocked) × Level  // Level ∈ [0, 1], default 0.8
```

Dividing by 5 maps ±5 V to ±1.0 at the input of the soft clipper;
`tanh(±1)` then outputs about ±0.7616. Hotter signals approach ±1.0 smoothly.
The DC blocker removes DC offset with a one-pole high-pass
(y = x − x₋₁ + R·y₋₁, R = 1 − 2π·DC_BLOCKER_CUTOFF_HZ/sr; currently 10 Hz) and has
negligible effect on audio frequencies. No other module converts volts to floats.

**Mono normalization**: if only `L In` is patched, the same signal feeds both
left and right outputs. If only `R In` is patched, same behaviour. If neither
is patched, both outputs are silence. When both are patched, channels are
processed independently.

## Linear FM scaling

Linear FM adds `FM input volts × FM Amt × LINEAR_FM_HZ_PER_VOLT` to the oscillator
frequency in Hz (`LINEAR_FM_HZ_PER_VOLT` = 100 — v1 educational scaling, not
hardware-accurate). Frequency clamps at 0 Hz: no negative/through-zero FM in v1.

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
