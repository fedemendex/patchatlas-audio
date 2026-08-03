// Virtual-voltage constants for the engine.
// Canonical reference: docs/signals.md
// No kernel may inline these numbers — always import from here.

/** C4 frequency in Hz (0 V pitch reference). */
export const C4_HZ = 261.6256;

/** Volts at which audio is normalised to ±1.0 before DAC (audio-output only). */
export const AUDIO_NORM = 5;

/** Peak bipolar CV voltage (e.g. LFO output). */
export const CV_BIPOLAR_MAX = 5;

/** Peak unipolar CV voltage (e.g. envelope output). */
export const CV_UNIPOLAR_MAX = 10;

/** Gate high voltage. */
export const GATE_HIGH_V = 10;

/** Schmitt trigger fire threshold: gate fires when voltage rises to this value. */
export const GATE_FIRE_THRESHOLD_V = 1;

/** Schmitt trigger re-arm threshold: gate re-arms when voltage falls below this value. */
export const GATE_REARM_THRESHOLD_V = 0.1;

/** Trigger pulse duration in seconds. */
export const TRIGGER_SECONDS = 0.001;

/** Audio render block size in frames (Web Audio render quantum). */
export const BLOCK_FRAMES = 128;

/**
 * Informational engine version string. Not part of the public API and not
 * persisted anywhere; nothing in the render path reads it.
 */
export const ENGINE_VERSION = "0.1.0";

/** DC blocker cutoff frequency in Hz (used by audio-output). */
export const DC_BLOCKER_CUTOFF_HZ = 10;

/**
 * Linear FM depth: Hz added to the oscillator frequency per volt of FM input
 * at full FM Amt. Conservative v1 educational scaling (±5 V audio at full
 * amount swings ±500 Hz) — not hardware-accurate.
 */
export const LINEAR_FM_HZ_PER_VOLT = 100;

/** Convert a 1 V/oct pitch voltage to frequency in Hz. */
export function voltsToHz(volts: number): number {
  return C4_HZ * Math.pow(2, volts);
}
