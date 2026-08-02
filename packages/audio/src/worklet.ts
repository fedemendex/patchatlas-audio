// tsdown's second build entry (packages/audio's own build config). The
// AudioWorklet processor lives at worklet/engine.worklet.ts, not here — a
// straight re-export keeps that file's path stable so `git log --follow`
// on it still works after the #287 move (#289 extracts its history).
import "./worklet/engine.worklet";
