#!/usr/bin/env node
// Build assertion, not a manual check (see docs/architecture.md, "Build and
// delivery"): `import` inside an AudioWorklet script isn't reliably supported
// outside Chromium, so dist/worklet.js must be one fully self-contained
// file. Run automatically as the last step of `npm run build`; also
// imported by scripts/smoke.mjs so the same check is exercised as a test
// against the built artifact, not just at build time.

import { readFileSync } from "node:fs";

// Not anchored to line start: a future rolldown/tsdown version emitting a
// statement mid-line (minification, a semicolon-joined line) must still be
// caught. Requires the actual `from "..."`/`require("...")` shape, a bare
// `import "..."` side-effect import, or a dynamic `import("...")` call
// (there's no space before the `(`, unlike the static-import branch) — not
// just the word "import", so a prose comment mentioning imports can't
// produce a false positive.
const IMPORT_OR_REQUIRE =
  /\bimport\s+(?:[\w$*{},\s]+\s+from\s+)?["']|\bimport\s*\(\s*["']|\bexport\s[^;\n]*\bfrom\s+["']|\brequire\s*\(\s*["']/;

export function findUnresolvedImports(source) {
  return source.match(IMPORT_OR_REQUIRE) ?? null;
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: verify-worklet-bundle.mjs <path-to-worklet-bundle>");
    process.exit(1);
  }
  const source = readFileSync(path, "utf-8");
  const match = findUnresolvedImports(source);
  if (match) {
    console.error(
      `${path} contains an import/require statement, so it is not a self-contained AudioWorklet bundle:\n  ${match[0].trim()}`,
    );
    process.exit(1);
  }
  console.log(`${path}: no unresolved imports.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
