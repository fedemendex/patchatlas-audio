// The generic, name-addressed patch schema: plain JSON, no PatchAtlas domain
// types. This is the engine's standalone entry point — a caller with no
// database and no catalog can hand-write one of these directly.
//
// Modules are addressed by a caller-chosen `id` and a registry `type` slug;
// connections are addressed by [moduleId, jack name] pairs, with direction
// implied by position (`from` is the out-jack endpoint, `to` is the in-jack
// endpoint) rather than a stored direction flag. compile.ts resolves jack
// names against the ModuleDSP's inJacks/outJacks lists.
//
// Params are ENGINE units, not the normalized 0..1 the UI stores — see
// docs/audio/extraction-plan.md §4. An omitted param and a present one must
// land in the same unit system, which compileGraph's normalized path does
// not guarantee today.

export interface PatchModule {
  id: string; // caller-chosen, unique within the patch
  type: string; // registry slug, e.g. "oscillator"
  params?: Record<string, number>; // seed control NAME -> ENGINE UNITS
}

export interface PatchConnection {
  from: [moduleId: string, jack: string]; // out jack NAME
  to: [moduleId: string, jack: string]; // in jack NAME
}

export interface Patch {
  modules: PatchModule[];
  connections: PatchConnection[];
}
