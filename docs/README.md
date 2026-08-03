# patchatlas-audio docs

| Read this | For |
| --- | --- |
| [`architecture.md`](architecture.md) | **Understand the architecture.** The technology stack, the repository map, the vocabulary, the full `Patch` → `EngineGraph` → `Interpreter` → kernel → output path, the main-thread/`AudioWorklet` boundary, the one-block feedback model, and how the build is delivered. Start here. |
| [`adding-a-kernel.md`](adding-a-kernel.md) | **Add a built-in kernel.** The complete workflow from a new file under `src/modules/` through the registry to the tests you must update. |
| [`signals.md`](signals.md) | **Signal and voltage conventions.** The normative standard every kernel follows: audio range, CV polarity, 1 V/oct pitch, gate/trigger thresholds, timing, DAC conversion. |
| [`kernel-checklist.md`](kernel-checklist.md) | The review checklist every kernel PR is held to (allocation discipline, units, testing, architecture). |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | **Contribute.** Setup, every verification command, and the ground rules. |

See the package [README](../README.md) for install, the public API, and the `AudioContext`
ownership contract.
