// The generic, name-addressed patch schema: plain JSON, no host domain types.
// This is the engine's public input format — a caller with no database and no
// catalog can hand-write one of these directly.
//
// Modules are addressed by a caller-chosen `id` and a registry `type` slug;
// connections are addressed by [moduleId, jack name] pairs, with direction
// implied by position (`from` is the out-jack endpoint, `to` is the in-jack
// endpoint) rather than a stored direction flag. compile.ts resolves jack
// names against the ModuleDSP's inJacks/outJacks lists.
//
// Params are ENGINE units (Hz, volts, seconds, switch indices), not the
// normalized 0..1 a UI knob stores — see docs/signals.md. A host holding
// normalized values must map them through params.ts's normalizedToEngineValue
// first; an omitted param falls back to the ParamSpec default, which is also
// in engine units, so the two must land in the same unit system.

export interface PatchModule {
  id: string; // caller-chosen, unique within the patch
  type: string; // registry slug, e.g. "oscillator"
  params?: Record<string, number>; // control NAME -> ENGINE UNITS
}

export interface PatchConnection {
  from: [moduleId: string, jack: string]; // out jack NAME
  to: [moduleId: string, jack: string]; // in jack NAME
}

export interface Patch {
  modules: PatchModule[];
  connections: PatchConnection[];
}
