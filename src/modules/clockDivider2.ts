// Clock Divider 2 kernel for slug "clock-divider-2".
//
// A seven-output clock/trigger divider in the spirit of the Doepfer A-160-2,
// and a strictly more capable sibling of the division outputs on "clock": it
// has no internal tempo generator at all (it is always slaved to the Clk
// input), it offers three selectable division-factor sets rather than the
// fixed /2 /4 /8 /16, and each output can be either a divided gate or a
// clock-width trigger.
//
// Division sets (the Div switch, 3 positions — outputs 1..7 in order):
//   Pow 2   2   4   8  16  32  64 128     (a classic binary divider chain)
//   Prime   2   3   5   7  11  13  17     (polyrhythms that realign slowly)
//   Int     2   3   4   5   6   7   8     (ordinary integer divisions)
//
// Output modes (the Mode switch, 2 positions):
//   Gate  a ~50% duty square at the divided rate. Within a cycle of N clock
//         periods the output is high for the first ceil(N/2) periods and low
//         for the rest, so N = 2 is exactly a binary /2 square and odd
//         divisors round the high half up (N = 3 → high 2, low 1). The level
//         is decided on a clock edge and HELD until the next one, so it does
//         not follow the clock's own pulse width.
//   Trig  the divided cycle AND-ed with the Clk input, per the A-160-2's
//         "the clock pulsewidth affects the pulsewidth of the outputs": the
//         output is high only while Clk itself is high, and only during the
//         FIRST clock period of each division cycle — one pulse per cycle,
//         the same width as the incoming clock pulse. (AND-ing against the
//         whole high half instead would emit ceil(N/2) pulses per cycle,
//         which is a /1 pattern with gaps rather than a division.)
// Both levels are tracked every sample regardless of the selected mode, so
// flipping Mode mid-stream takes effect immediately without a glitch or a
// lost cycle.
//
// Division counting is by counted Clk rising edges (Schmitt: fire >=
// GATE_FIRE_THRESHOLD_V, re-arm < GATE_REARM_THRESHOLD_V), never by an
// independent timer — every output is therefore sample-aligned with the clock
// edge that caused it, and at cycle 0 all seven outputs start together. A
// sustained-high Clk fires once until it re-arms; non-finite Clk samples hold
// the latch and never fire an edge.
//
// Rst (Schmitt rising edge) returns the module to its power-on state: every
// division counter to 0 and every output immediately low. The next Clk rising
// edge is then a downbeat on all seven outputs (phase 0 is inside the high
// half of every N >= 2, and is the one period Trig mode ANDs against). Rst is
// evaluated before the Clk edge within a sample, so a simultaneous Rst + Clk
// edge resets and then fires the downbeat — the same convention as clock.ts.
//
// Unpatched Clk means no edges ever arrive: the outputs simply hold their
// power-on (or post-reset) level, which is low. Unpatched Rst never resets.
//
// Switching Div mid-cycle re-bases any counter that now sits past the end of
// its new, shorter cycle (it restarts that output's cycle on the next edge)
// rather than letting it run out of range.
//
// LED telemetry (`reportsGates` in the registry): `state.gates` is a bitmask
// with bit k set while outs[k] is high, read by Interpreter.readGates for the
// host's per-output indicator LEDs. A bit is held set for at least
// LED_HOLD_SECONDS so that a Trig-mode pulse — which can be far shorter than
// the host's ~33 Hz telemetry poll — is never missed between two polls. This
// is a UI-visibility affordance only: it is computed from, and never affects,
// the audio written to outs[].
//
// Jack/param layout (registry declaration order):
//   ins[0] = Clk  ins[1] = Rst
//   outs[0] = Out 1  outs[1] = Out 2  …  outs[6] = Out 7
//   params[0] = Div (0 = Pow 2, 1 = Prime, 2 = Int)
//   params[1] = Mode (0 = Gate, 1 = Trig)

import type { Kernel } from "../engine/kernel";
import { GATE_HIGH_V, GATE_FIRE_THRESHOLD_V, GATE_REARM_THRESHOLD_V } from "../engine/units";

/** Outputs on the panel; also the width of the `gates` telemetry bitmask. */
const OUT_COUNT = 7;

// The three Div switch positions, flattened to one table so process() can
// index it without a nested array lookup: set s, output k is at
// DIVISION_SETS[s * OUT_COUNT + k]. Order matches the registry's
// ParamSpec.positions for "Div".
const DIVISION_SETS = Int32Array.from([
  2, 4, 8, 16, 32, 64, 128, // Pow 2
  2, 3, 5, 7, 11, 13, 17, // Prime
  2, 3, 4, 5, 6, 7, 8, // Int
]);

const DIVISION_SET_COUNT = DIVISION_SETS.length / OUT_COUNT;

/** Mode switch positions. */
const MODE_GATE = 0;
const MODE_TRIG = 1;
const MODE_COUNT = 2;

// Minimum time an LED telemetry bit stays set after its output goes high.
// Only has to outlast the host's telemetry poll interval (~30 ms) so a
// one-clock-wide Trig pulse between two polls still lights the LED; it is
// deliberately not a signal constant, and nothing in the audio path reads it.
const LED_HOLD_SECONDS = 0.05;

interface ClockDivider2State {
  /** Clock periods elapsed in the current division cycle, per output (0..N-1). */
  phase: Int32Array;
  /** Gate-mode level per output, decided on an edge and held until the next. */
  gateHigh: Uint8Array;
  /** Trig-mode arming per output: 1 during the first clock period of a cycle. */
  trigArmed: Uint8Array;
  /** Remaining LED-hold samples per output (telemetry only). */
  ledHold: Int32Array;
  /** LED-hold length in samples (>= 1). */
  ledHoldSamples: number;
  /** Schmitt state of Clk, for rising-edge detection. */
  clkHigh: boolean;
  /** Schmitt state of Rst, for rising-edge detection. */
  rstHigh: boolean;
  /** Telemetry bitmask: bit k set while outs[k] is (or was very recently) high. */
  gates: number;
}

export const clockDivider2Kernel: Kernel<ClockDivider2State> = {
  init(sr): ClockDivider2State {
    return {
      phase: new Int32Array(OUT_COUNT),
      gateHigh: new Uint8Array(OUT_COUNT),
      trigArmed: new Uint8Array(OUT_COUNT),
      ledHold: new Int32Array(OUT_COUNT),
      ledHoldSamples: Math.max(1, Math.round(LED_HOLD_SECONDS * sr)),
      clkHigh: false,
      rstHigh: false,
      gates: 0,
    };
  },

  process(state, ins, outs, params, n) {
    const inClk = ins[0];
    const inRst = ins[1];

    const phase = state.phase;
    const gateHigh = state.gateHigh;
    const trigArmed = state.trigArmed;
    const ledHold = state.ledHold;
    const ledHoldSamples = state.ledHoldSamples;

    // Non-finite Div falls back to the first set; clamp to the switch range.
    let setF = params[0];
    if (!Number.isFinite(setF)) setF = 0;
    let setIdx = Math.round(setF);
    if (setIdx < 0) setIdx = 0;
    else if (setIdx > DIVISION_SET_COUNT - 1) setIdx = DIVISION_SET_COUNT - 1;
    const setBase = setIdx * OUT_COUNT;

    // Non-finite Mode falls back to Gate; clamp to the switch range.
    let modeF = params[1];
    if (!Number.isFinite(modeF)) modeF = MODE_GATE;
    let modeIdx = Math.round(modeF);
    if (modeIdx < 0) modeIdx = MODE_GATE;
    else if (modeIdx > MODE_COUNT - 1) modeIdx = MODE_COUNT - 1;
    const trigMode = modeIdx === MODE_TRIG;

    let clkHigh = state.clkHigh;
    let rstHigh = state.rstHigh;
    let gates = state.gates;

    for (let i = 0; i < n; i++) {
      // Rst first, so a Rst and a Clk edge on the same sample reset and then
      // fire the downbeat (clock.ts uses the same ordering).
      let rstV = 0;
      if (inRst !== null) {
        const v = inRst[i];
        if (Number.isFinite(v)) rstV = v;
      }
      if (!rstHigh && rstV >= GATE_FIRE_THRESHOLD_V) {
        rstHigh = true;
        for (let k = 0; k < OUT_COUNT; k++) {
          phase[k] = 0;
          gateHigh[k] = 0;
          trigArmed[k] = 0;
        }
      } else if (rstHigh && rstV < GATE_REARM_THRESHOLD_V) {
        rstHigh = false;
      }

      // Clk Schmitt edge. A non-finite sample holds the latch and never fires.
      let edge = false;
      if (inClk !== null) {
        const v = inClk[i];
        if (Number.isFinite(v)) {
          if (!clkHigh && v >= GATE_FIRE_THRESHOLD_V) {
            clkHigh = true;
            edge = true;
          } else if (clkHigh && v < GATE_REARM_THRESHOLD_V) {
            clkHigh = false;
          }
        }
      }

      if (edge) {
        for (let k = 0; k < OUT_COUNT; k++) {
          const divisor = DIVISION_SETS[setBase + k];
          // A Div change can leave a counter past the end of its new, shorter
          // cycle — restart that output's cycle rather than run out of range.
          let p = phase[k];
          if (p >= divisor) p = 0;
          // Gate: high for the first ceil(divisor / 2) periods of the cycle.
          gateHigh[k] = p < (divisor + 1) >> 1 ? 1 : 0;
          // Trig: armed only during the cycle's first clock period.
          trigArmed[k] = p === 0 ? 1 : 0;
          p += 1;
          if (p >= divisor) p = 0;
          phase[k] = p;
        }
      }

      let mask = 0;
      for (let k = 0; k < OUT_COUNT; k++) {
        const high = trigMode ? trigArmed[k] === 1 && clkHigh : gateHigh[k] === 1;
        outs[k][i] = high ? GATE_HIGH_V : 0;
        // Telemetry only: hold the bit briefly so a short Trig pulse survives
        // until the host's next poll. Never read back into the audio path.
        if (high) ledHold[k] = ledHoldSamples;
        else if (ledHold[k] > 0) ledHold[k]--;
        if (high || ledHold[k] > 0) mask |= 1 << k;
      }
      gates = mask;
    }

    state.clkHigh = clkHigh;
    state.rstHigh = rstHigh;
    state.gates = gates;
  },
};
