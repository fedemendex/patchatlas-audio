# patchatlas-audio docs

* [`architecture.md`](architecture.md) — the compile → interpret → worklet pipeline, the
  one-block feedback model, and the allocation-free `process()` contract. Start here.
* [`signals.md`](signals.md) — the normative voltage/signal-range standard every kernel
  follows (audio range, CV polarity, 1 V/oct pitch, gate/trigger thresholds, DAC conversion).
* [`kernel-checklist.md`](kernel-checklist.md) — the review checklist every kernel PR is held
  to (allocation discipline, units, testing, architecture).

See the package [README](../README.md) for install, the public API, and the `AudioContext`
ownership contract.
