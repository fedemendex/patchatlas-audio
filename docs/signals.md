# Audio Engine — Signal and Voltage Standard

This is the canonical reference for the virtual-voltage convention used by every kernel in
the audio preview engine. All numbers are normative. Kernels must import constants from
`src/engine/units.ts`; no kernel may hardcode tuning or gate constants.

## Signal types

| Signal | Convention |
|--------|------------|
| Audio | ±5 V nominal; headroom above ±5 V is legal inside the graph; clipping happens **only** in `audio-output` |
| Bipolar CV (LFO, FM amounts, etc.) | ±5 V |
| Unipolar CV (envelopes, VCA levels, etc.) | 0 → 10 V |
| Pitch | 1 V/oct; 0 V = C4 = 261.6256 Hz; `freq = C4_HZ * 2 ** volts` |
| Gates | 0 V low / 10 V high; inputs use a Schmitt trigger: re-arm below 0.1 V, fire at ≥ 1 V |
| Triggers | 1 ms pulse at 10 V |

The generic attenuverter treats an unpatched input as normalled to +CV_BIPOLAR_MAX, so the bipolar knob produces a manual -5 V..+5 V offset with the current signal convention.

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

## VCA response curves

Both curves normalize the CV input by `CV_BIPOLAR_MAX` (5 V), so 5 V CV at full
`CV Amt` = unity gain when `Gain` is at maximum.

```
normalizedCv = max(0, CV * cvAmt / CV_BIPOLAR_MAX)   // no upper clamp; headroom is legal

Linear:  gain = Gain * normalizedCv
Exp:     gain = Gain * normalizedCv²                  // monotone; 0→0, 1→1; gentler approach to unity
```

When the CV jack is unpatched, `gain = Gain` (level control only; `CV Amt` is irrelevant).
No soft-clipping inside the VCA — only `audio-output` clips.

## Linear FM scaling

Linear FM adds `FM input volts × FM Amt × LINEAR_FM_HZ_PER_VOLT` to the oscillator
frequency in Hz (`LINEAR_FM_HZ_PER_VOLT` = 100 — v1 educational scaling, not
hardware-accurate). Frequency clamps at 0 Hz: no negative/through-zero FM in v1.

## Oscillator waveforms

The oscillator writes five simultaneous shape outputs, all ±5 V nominal audio
(`AUDIO_NORM`):

- **`Sine`** — the reference phase-accumulator sine.
- **`Saw`** — rising ramp, band-limited with a 2-sample PolyBLEP at the wrap.
- **`Pulse`** — ±1 square at duty `pw`, PolyBLEP-corrected at both edges. `pw` is
  the `PW` control plus the `PWM` input, clamped to **0.05…0.95**.
- **`Tri`** — naive triangle, phase-aligned with `Sine`. Its harmonics fall off
  ~1/n², so aliasing stays well below the fundamental at normal pitch; no BLEP is
  applied — a documented educational-quality trade-off (no oversampling/wavetables).
- **`Sub`** — a PolyBLEP square one octave below the main oscillator (50 % duty on
  a half-rate phase), tracking the oscillator frequency exactly.

**PWM mapping**: `pulseWidth = clamp(PW + pwmVolts / (2·CV_BIPOLAR_MAX), 0.05, 0.95)`,
so ±5 V of `PWM` sweeps the duty ±0.5 around the knob before the clamp. A non-finite
`PWM` sample reads as 0 V; an unpatched `PWM` leaves only the `PW` knob in effect.

**Sync** (hard sync): a rising edge on `Sync` (standard Schmitt thresholds) resets
both the main and sub phases to 0 **before** the sample at that edge is written, so
the reset sample reads phase 0 for every wave (the accumulator otherwise advances
before writing). Hard sync is a genuine discontinuity that PolyBLEP does not
correct — band-limited sync is a non-goal in v1.

## Modulation sources

The envelope generator's `Env` output is unipolar 0 → 10 V; its `Inv` output is the
polarity-inverted envelope (0 → −10 V, the same convention as the mixer's `Inv`), and `EOC`
emits a standard trigger (1 ms at 10 V) when the release segment completes. The LFO's shape
outputs are bipolar ±5 V. LFO Rate CV is 1 V/oct around the Rate knob and may slow the LFO
to 0 Hz; the upper rate is capped at 30 Hz (the preview LFO is deliberately sub-audio).
`Sub` is a square one octave below the main rate.

The noise source's `White` output is bipolar ±5 V uniform noise (expected RMS
`CV_BIPOLAR_MAX / √3` ≈ 2.886 V); `Pink` is a small one-pole-sum approximation of the same
noise, not exact 1/f. `Red` is a leaky-integrator (bounded one-pole lowpass) coloring of the
same white draw, and `Blue` is a first-difference (one-sample high-pass) coloring — both are
preview-quality brown-ish/blue-ish trends, not calibrated spectral models, and both are
hard-clamped to ±CV_BIPOLAR_MAX as the same source-range guard as `Pink` (`noiseSource.ts`).
`Sample & Hold`'s `Trig` input uses the standard Schmitt gate
thresholds; the trigger sample itself already carries the newly sampled value (sampling
happens before the output is written, never one sample later). Its `Slew` control smooths
both the `S&H` and `T&H` outputs toward their sampled/tracked target with a one-pole
follower (`out += (target − out) · coeff`, never overshooting); the raw 0..1 knob maps
exponentially onto a 0.001–2 s time constant, and 0 (or a non-finite reading) bypasses the
follower for the original instantaneous behavior.

## Low pass gate

The low pass gate (`low-pass-gate`) is Patch Atlas's generic educational preview model of a
vactrol-driven coupled VCA + 2-pole lowpass — it is not modeled on, or claimed to match, any
specific hardware LPG. A single follower state (`level`, 0 → 1, "openness") drives both stages:

- **`CV`** is unipolar 0 → `CV_UNIPOLAR_MAX` V and sets the follower's *target*:
  `cvOpen = clamp(CV / CV_UNIPOLAR_MAX, 0, 1)`. Unpatched/non-finite `CV` reads as 0 V (closed).
- **`Strike`** is a Schmitt-gated (standard thresholds) rising-edge pluck: the rising edge snaps
  `level` to 1 on that sample; a sustained high does not retrigger until `Strike` re-arms below
  `GATE_REARM_THRESHOLD_V`. Non-finite `Strike` samples never fire.
- Every other sample, `level` chases `cvOpen`: an instant rise if `cvOpen > level` (jumps exactly
  to the target, never overshooting), otherwise an exponential decay at a fixed ~0.3 s time
  constant. The seed has no Damp/Decay/Response control on this module, so the decay time is
  fixed rather than knob-mapped.
- Audio path: `amp = level²`, `cutoffHz = 40 + level³ × 3960`, run through two cascaded one-pole
  lowpass stages (12 dB/oct). The fully-open cutoff (~4 kHz) sits deliberately inside the audible
  band so the filtered path colors harmonically rich material even at full level, and the `level³`
  cutoff curve is steeper than the `level²` amp curve so brightness falls during the loud part of
  a decay rather than after it — together these are what make the modes audibly distinct and a
  `Strike` read as a natural pluck that darkens as it fades. The filter always runs regardless of
  `Mode`, so its state stays continuous across a live mode switch.
- **`Mode`** (seed switch, positions `VCA` / `LPG` / `Both`, default `Both`) selects which
  combination becomes the output — Patch Atlas's generic preview semantics, not a claim to match
  any specific hardware convention:
  - `VCA`: the bright, amplitude-only gate, `Out = In × amp`. The filter still runs every sample
    (so its state stays live for a clean transition if `Mode` changes) but is never read for
    output, so no lowpass coloration reaches `Out`.
  - `LPG`: the actual low-pass-gate response, `Out = filtered × amp` — clearly darker than `VCA`
    on rich input because the same vactrol `level` drives both the amplitude and the cutoff, so
    closed (`level = 0`) is silent.
  - `Both`: a parallel 50/50 blend of the bright VCA path and the darker LPG path,
    `Out = 0.5 × amp × (In + filtered)` — brighter than `LPG` alone (half the signal skips the
    filter) but still gated, since `amp` multiplies the whole blend; closed is silent here too.
  - A filter-only mode (cutoff modulated by `level` with no amplitude multiply) was deliberately
    not offered: since a stable lowpass has unity gain at DC/low frequencies regardless of
    cutoff, a filter-only "closed" state would still pass sustained or low-frequency input
    through nearly unattenuated — it would not gate anything, contradicting what a low-pass
    *gate* is for.

## Function generator

The function generator (`function-generator`) is one channel of a Maths / Serge DUSG-style
slope generator: a slew core with independent `Rise` and `Fall` times (0.001 → 10 s,
exponential knobs) that acts as a triggered envelope, a cycling LFO, and a slew limiter.

- **Slew core (rest state)**: the output follows the `In` jack (0 V unpatched/non-finite)
  with linear rate limiting — full scale (`CV_UNIPOLAR_MAX`) in the `Rise` time going up and
  the `Fall` time going down. `Curve` does not shape the follower, only transients.
- **Trig**: a rising edge (standard Schmitt thresholds) fires a transient from the *current*
  level to a `CV_UNIPOLAR_MAX` peak over the rise time, then falls to the follower target
  (the live `In` sample, 0 V unpatched). Segments are shaped phase ramps, so the knob time is
  the actual segment time. A retrigger mid-transient restarts the rise from the current level
  (always continuous, never a reset to 0).
- **Curve** (bipolar −1..+1): shapes transients with exponent `g = 4^curve` — rise
  `y = start + (peak − start)·p^g`, fall the time-mirror `(1 − p)^g`. 0 = linear ramps; +1 =
  "expo" (slow-start rise, fast-drop/slow-tail fall, the classic analog exponential look);
  −1 = "log" (the mirror).
- **Time CV**: `Rise CV` and `Fall CV` each sum with `Both CV`; the summed volts scale the
  corresponding knob time exponentially at **one octave per volt, positive = slower** (Maths
  convention). Effective times clamp to the knob range; non-finite CV samples read as 0 V.
- **Cycle** (button, default off): when on, the fall completion immediately re-fires the rise,
  self-cycling between the `In` level and the peak (an LFO with period ≈ Rise + Fall).
- **`EOR` / `EOC`** are movement-derived Maths-style gates: `EOR` is `GATE_HIGH_V` except
  while the output is moving up, `EOC` is `GATE_HIGH_V` except while it is moving down; both
  sit high at rest. Patching `EOC → Trig` therefore self-patches into a cycle exactly like the
  hardware trick (via the compiler's one-block feedback delay). `Inv` is the polarity-inverted
  function (the mixer/envelope `Inv` convention).

## Ring modulator

The ring modulator (`ring-modulator`) is a DC-coupled bipolar multiplier: `Out = X * Y /
CV_BIPOLAR_MAX`, so ±5 V on both inputs gives ±5 V out (`+5·+5→+5`, `+5·−5→−5`, `−5·−5→+5`),
matching the audio/CV bipolar convention rather than a raw volt² product. An unpatched `X` or
`Y` reads as 0 V (silence) — the seed has no internal carrier oscillator, so there is nothing
to normal an unpatched input to. Non-finite input samples read as 0 V. No soft-clipping —
`audio-output` owns final DAC limiting.

## Wavefolder

The wavefolder (`wavefolder`) is Patch Atlas's generic educational preview model of a clean
digital triangle/reflection folder — it is not modeled on, or claimed to match, any specific
Buchla/Serge folding circuit. The folding function is a closed-form triangle wave via
`asin(sin(.))`, exact (not an approximation) inside the linear region and reflecting beyond it:

```
u   = (pi / (2*T)) * driven
out = (2*T / pi) * asin(sin(u))
```

For `|driven| <= T` this is bit-exact `out = driven` (`asin` is the true inverse of `sin` over
`[-pi/2, pi/2]`) — a genuine unity-gain passthrough, not a curve that merely approaches one.
Beyond `T` the signal reflects back down, and continues reflecting for larger excursions, which
is the textbook triangle/reflection fold. `Math.sin`/`Math.asin` are bounded for any finite
argument, so `|out|` never exceeds `T` regardless of how large `driven` gets — bounded output and
freedom from `NaN`/`Infinity` fall out of the formula itself, with no separate output clamp.

- `driven = In * foldGain + biasVolts`. `In` unpatched/non-finite reads as 0 V.
- **`Fold`** (1..8, exponential, default 1) sets `foldGain`, summed with `Fold CV` (normalized by
  `CV_BIPOLAR_MAX`, unbounded before the final clamp to `[1, 8]` — same convention as the filter's
  `Res CV`). At `Fold` = 1 (the knob's rest position) a signal within the nominal `AUDIO_NORM`
  range folds not at all: an untouched knob passes audio straight through, not silence or heavy
  coloration. Turning `Fold` up drives more of the signal past the threshold, producing additional
  folds (more zero-crossings/harmonic complexity) as amplitude increases.
- **`Sym`** (bipolar −1..1, default 0, + `Sym CV` summed the same way) skews the fold threshold
  asymmetrically per polarity of `driven`: `T_pos = AUDIO_NORM * (1 - Sym * 0.6)`,
  `T_neg = AUDIO_NORM * (1 + Sym * 0.6)`. At `Sym` = 0 both thresholds equal `AUDIO_NORM` and the
  folder is a pure odd function (`fold(-x) = -fold(x)`); away from 0 the positive and negative
  halves fold at different amounts, adding even harmonics. The 0.6 depth keeps both thresholds
  comfortably above 0 V at the extremes (0.4×..1.6× `AUDIO_NORM`).
- **`Bias`** (bipolar −1..1, default 0) adds a fixed `Bias * 0.6 * AUDIO_NORM` (≤ ±3 V) offset to
  `driven` before folding — a second, DC-based way to push the waveform into asymmetric folding,
  distinct from `Sym`'s threshold skew. Near `driven` = 0 the fold function's slope is always
  exactly 1 regardless of `T`, so low-level signal stays clean through `Sym`/`Bias` changes; only
  larger excursions actually fold.
- No soft-clipping inside the module — `audio-output` owns final DAC limiting, same convention as
  the ring modulator and VCA.
- **Known limitation**: v1 does no oversampling. A hard reflection introduces harmonics above the
  input's own bandwidth, and without band-limiting they can alias above Nyquist at high `Fold`
  settings on bright material. This is a documented preview-quality trade-off, not a bug —
  oversampling is deferred rather than adding a large hidden CPU cost to every block.

## Logic

The logic module (`logic`) provides four combinational gates plus a T flip-flop. Its seeded
third input was renamed from `In 3` to `Clock` (the stable slug `logic` and the `AND`/`OR`/`XOR`/
`NOR`/`FF` outputs are unchanged):

- **`AND`/`OR`/`XOR`/`NOR`** operate on `In 1`/`In 2` only, each read through the standard Schmitt
  latch (fire >= `GATE_FIRE_THRESHOLD_V`, re-arm below `GATE_REARM_THRESHOLD_V`) so a noisy signal
  near either threshold does not chatter the combinational outputs. `AND` is high when both latches
  are high; `OR` when either is; `XOR` when exactly one is; `NOR` when neither is. Unpatched/
  non-finite `In 1`/`In 2` read as 0 V (low). `Clock` has no effect on any of these four outputs.
- **`FF`** is a T flip-flop driven solely by `Clock` (also the standard Schmitt thresholds): it
  starts low when the module instance is created, and toggles exactly once per `Clock` rising
  edge. A sustained-high `Clock` toggles only once until it re-arms below
  `GATE_REARM_THRESHOLD_V`; falling edges never toggle it. `FF` state (and the `Clock` Schmitt
  latch) persists across render blocks; there is no reset input, so re-creating the module is the
  only way to return `FF` to low. `In 1`/`In 2` have no effect on `FF`.

## Slew limiter

The slew limiter (`slew-limiter`) is a linear, constant-rate slew — not a one-pole/exponential
follower — with independent `Rise` and `Fall` controls. The output moves toward the `In` target
at a fixed rate and stops exactly at the target: it never overshoots.

- **Units**: each control is the time, in seconds, to traverse **one engine voltage unit** ("s/V"),
  not a full-scale time. The seed control is a plain knob with no numeric range, so the raw 0..1
  value maps in-kernel onto `[0.0005, 2]` s/V:
  `timePerVolt = 0.0005 * (2 / 0.0005) ^ raw` — the same in-kernel-mapping convention as
  `sample-and-hold`'s `Slew` control.
- **Bypass**: raw `0` (the knob's rest position and its default) is a **hard bypass** for that
  direction — `In` passes straight through with no limiting at all, not merely a fast slew. This
  is what makes a fully-CCW `Rise`/`Fall` knob an exact passthrough, matching an unpatched jack.
- **Rate**: sample-rate independent — `maxChangePerSample = (1 / timePerVolt) / sr` — computed
  fresh from the current sample rate at every sample, so real-time behavior is identical across
  sample rates.
- **Rise CV / Fall CV**: 1 oct/V scaling of the effective time while the corresponding knob is
  above bypass (positive volts lengthen the time, the same convention as `function-generator`'s
  `Rise CV`/`Fall CV`), clamped back to `[0.0005, 2]` s/V. CV has no effect while the knob is at
  bypass — there is no base rate to scale. Non-finite CV samples read as 0 V.
- **Initialization**: unlike most kernels, the internal state does **not** start at 0 V. On the
  first sample this kernel instance ever processes, the output is set directly to the (sanitized)
  `In` sample, so a patch that starts with a nonzero DC level does not ramp up from an artificial
  0 V starting point.
- `In` unpatched/non-finite reads as 0 V, the standard convention. Output is never clamped to an
  arbitrary voltage range — it is only ever moved toward, and stopped at, the target, so DC,
  negative, and bipolar CV pass through unchanged in shape.

## Filter resonance

The state-variable filter (`filter`) maps its linear 0..1 `Res` param exponentially onto
filter Q — `Q = 0.5 · 40^res`, i.e. 0.5 → 20 — so audible resonance grows evenly across the
knob, and Q is bounded (the SVF never becomes unstable; max-res ringing decays). The input
is gain-compensated by `√(k/2)`, capping the worst-case resonant emphasis at
`√(Q_MAX/2) ≈ 3.2×` (+10 dB): a ±5 V input peaks around ±16 V at full Res. Downstream
consumers therefore see an audio-scale signal even at maximum resonance — the filter's
±100 V integrator clamp is a numerical last resort, not the loudness ceiling. Zero-res
behavior is bit-exact with the uncompensated filter. Full details: `filter.ts` header.

## Comparator

The comparator (`comparator`) is a Doepfer A-167-inspired comparator/subtractor — an original
interpretation of the A-167's summing-comparator topology, not a traced circuit model. Its seeded
inputs/control were renamed (`A` → `+ In`, `B` → `− In`, `Thresh` (input) → `Offset CV`, `Thresh`
(control) → `Offset`; migration `0037_rename_comparator_jacks_and_control`) and it gained `+ Level`/
`− Level`/`Gap` knobs and a `Sum` output.

- **`Sum`** outputs, every sample, exactly:
  `sum = (+ Level × + In) − (− Level × − In) + Offset + Offset CV`
  with no normalization, clipping, or smoothing — DC, negative, and bipolar/audio-rate signals all
  pass through unchanged in shape. `+ In`/`− In`/`Offset CV` read as 0 V when unpatched or
  non-finite, the standard convention. `+ Level`/`− Level` are unipolar 0..1 knobs (default 1,
  unity); `Offset` is a bipolar knob over `±CV_BIPOLAR_MAX`, default 0.
- **`Gate`/`Inv Gate`** compare `Sum` to 0 V with `Gap`-knob symmetric hysteresis (`Gap` is unipolar
  0..`CV_UNIPOLAR_MAX`, default 0, in engine volts):
  - `Gap <= 0` (including the default): a strict, non-hysteretic zero comparison — `Gate` is high
    iff `Sum > 0` (equality is low), independent of the previous state, so `Gap = 0` behavior is
    exactly reproducible regardless of Gate's prior value.
  - `Gap > 0`: symmetric hysteresis around zero — while low, `Gate` goes high only once
    `Sum > Gap / 2`; while high, `Gate` goes low only once `Sum < −Gap / 2`; between those
    thresholds `Gate` holds its previous state.
  - `Inv Gate` is always the exact logical complement of `Gate` (never an independent comparison).
  - Both write `GATE_HIGH_V` for high and exactly 0 for low, the standard gate convention. The
    comparator's internal hysteresis state starts low when the module instance is created and is
    not persisted beyond the instance's lifetime.
- Full details: `comparator.ts` header.

## Timing

- **Sample rate**: taken from the environment (`AudioContext.sampleRate`) at kernel init.
  It is never hardcoded. Kernels receive `sr` as a parameter to their `init()` function.
- **Block size**: 128 frames (the Web Audio render quantum). Jacks carry a mono
  `Float32Array` of 128 samples per block. Kernels loop per-sample inside a block.

## Clock and sequencer timing

All musical time is generated inside kernels, sample by sample, on the audio thread — never
`setTimeout`/`setInterval`/`requestAnimationFrame`/`Date.now`/`performance.now`. (The one
timer under `web/src/audio`, in `useAudioEngine`, is a non-musical graph-rebuild debounce.)

- **Clock** (`clock`): the `Tempo` knob sets a quarter-note rate (30 → 300 BPM, default 120).
  `Clk` emits a standard trigger (1 ms at 10 V) each tick; timing uses a fractional sample
  accumulator (`period = sr·60/BPM`; fire at `phase ≥ period`, then `phase −= period`) so tick
  positions stay within ±1 sample of `m·period` over any render — zero cumulative drift.
  `/2 /4 /8 /16` fire on every 2nd/4th/8th/16th parent tick, sample-aligned with `Clk`
  (all five coincide on tick 0). Unpatched `Run` runs; a `Run` low stops (Schmitt). A `Rst`
  rising edge restarts to the power-on state — divide counter to 0, downbeat on the reset
  sample.
  - **`Swing`** (bipolar −1..+1, default 0) delays every second parent tick within a two-tick
    cycle: with `delay = swing · MAX_SWING_DELAY_RATIO · period` (`MAX_SWING_DELAY_RATIO` = 1/3),
    ticks land at `0, P+delay, 2P, 3P+delay, 4P, …`, so the two alternating intervals
    (`P+delay` / `P−delay`) always sum to exactly `2P` — even ticks stay pinned to `k·P` with no
    cumulative drift, and `1/3` keeps `|delay| < P` so an interval never collapses. Positive swing
    delays the offbeat (standard shuffle); negative pushes it early; 0 (or a non-finite reading)
    is bit-for-bit the straight clock. Divisions derive from the swung parent ticks, firing on the
    un-delayed even ticks.
  - **`Ext Clk`** (external-clock input): when patched it **replaces** the internal BPM generator
    as the parent-tick source — a rising edge (standard Schmitt thresholds) emits `Clk` on that
    sample and advances the divide counter, so `/2 /4 /8 /16` count external ticks identically to
    internal ones; a sustained-high input fires once until it re-arms and non-finite samples never
    fire. `Rst` re-zeros the external divide phase (the next edge is a downbeat). **Swing applies
    to the internal BPM clock only; the external clock is passed through sample-accurately and used
    as the parent tick source** (offbeats are not re-timed). Unpatched `Ext Clk` leaves the
    internal-tempo clock exactly as above.
- **Sequencer** (`sequencer`): advances one step per `Clk` rising edge (standard Schmitt
  thresholds); the first edge after init/reset latches step 0 (never an off-by-one to step 1),
  unless `Sel` is patched (see below). Step CV comes from the stored `CV 1..8` controls, each
  mapped **0 → 2 V** (two octaves at 1 V/oct); CV changes on the edge sample and holds between
  edges. `Gate` is high for `SEQUENCER_GATE_DUTY` = 0.5 of the measured previous clock period
  after each step, gated by that step's `On` button (a disabled step is a rest: gate low, CV
  still updates); the first edge (no measured period yet) uses a fixed `INITIAL_GATE_SECONDS`
  = 0.05 fallback. `Len` (1 → 8) sets the wrap length. `Rst` rising edge returns to step 0.
  - **`Dir`** (direction, sampled on the `Clk` edge, not continuously): unpatched `Dir`
    preserves forward-only stepping exactly (bit-for-bit). When patched, a sample read
    < `GATE_FIRE_THRESHOLD_V` (including non-finite) steps forward (`+1 mod Len`); a sample
    ≥ `GATE_FIRE_THRESHOLD_V` steps backward (`-1 mod Len`). `Dir` only affects ordinary
    advancing edges — it has no effect on the first-edge latch and is ignored whenever `Sel`
    is patched.
  - **`Sel`** (external step-select address CV, sampled on the `Clk` edge): when patched, `Sel`
    takes priority over `Dir` and the first-edge latch — every clock edge, including the
    first, sets the step directly from `clamp(floor(selVolts / CV_UNIPOLAR_MAX * Len), 0,
    Len - 1)`, so 0 → 10 V spans the currently active `Len` steps. A non-finite `Sel` sample
    reads as 0 V (step 0); negative `Sel` clamps to step 0; `Sel` ≥ 10 V clamps to the final
    active step. Unpatched `Sel` preserves the clocked `Dir`/forward-only behavior exactly.

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
