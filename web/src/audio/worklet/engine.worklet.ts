// AudioWorkletGlobalScope — not declared in TypeScript's DOM lib
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor
): void;

class EngineProcessor extends AudioWorkletProcessor {
  private phase = 0;
  private lpState = 0;
  private cutoff = 1000;
  private targetCutoff = 1000;
  private readonly smoothCoeff: number;

  constructor() {
    super();
    // ~50 ms one-pole smoothing so param changes are click-free
    this.smoothCoeff = Math.exp(-1 / (sampleRate * 0.05));
    this.port.onmessage = (e: MessageEvent<{ type: string; value: number }>) => {
      if (e.data.type === "param") {
        this.targetCutoff = e.data.value;
      }
    };
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;

    const phaseInc = 440 / sampleRate;
    const sc = this.smoothCoeff;

    for (let i = 0; i < out.length; i++) {
      // Smooth cutoff toward target
      this.cutoff = this.cutoff + (1 - sc) * (this.targetCutoff - this.cutoff);

      // Saw oscillator at 440 Hz
      this.phase += phaseInc;
      if (this.phase >= 1) this.phase -= 1;
      const saw = this.phase * 2 - 1;

      // One-pole lowpass: alpha = 1 - e^(-2π·fc/sr)
      const alpha = 1 - Math.exp((-6.283185307 * this.cutoff) / sampleRate);
      this.lpState += alpha * (saw - this.lpState);

      out[i] = this.lpState * 0.3;
    }

    return true;
  }
}

registerProcessor("engine-processor", EngineProcessor);
