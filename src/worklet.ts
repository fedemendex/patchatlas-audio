// tsdown's second build entry (see tsdown.config.ts and docs/architecture.md,
// "Build and delivery"): this file is what becomes dist/worklet.js, the fully
// self-contained AudioWorklet bundle. The processor itself lives at
// worklet/engine.worklet.ts; this is a bare side-effect import so that file's
// path stays stable independently of the build entry's name.
import "./worklet/engine.worklet";
