// @vitest-environment node
// Boundary enforcement (#286, docs/audio/extraction-plan.md): engine/,
// modules/ and worklet/ are the directories that move to the standalone
// package. No file under them may import anything outside that boundary —
// "vitest" is the sole exception, and only inside *.test.ts(x) files — so a
// PatchAtlas import (a domain type, an adapter, a React component) can never
// creep back in before the #287 move. This is what makes that move
// mechanical rather than reviewed by eye.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const BOUNDARY_DIRS = ["engine", "modules", "worklet"];
const AUDIO_ROOT = path.dirname(new URL(import.meta.url).pathname);

export interface SourceFile {
  /** Path relative to web/src/audio, posix-separated, e.g. "modules/registry.ts". */
  relPath: string;
  content: string;
}

export interface BoundaryViolation {
  file: string;
  specifier: string;
}

function collectSourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  function walk(absDir: string, relDir: string): void {
    for (const entry of readdirSync(absDir)) {
      const abs = path.join(absDir, entry);
      const rel = relDir ? `${relDir}/${entry}` : entry;
      if (statSync(abs).isDirectory()) {
        walk(abs, rel);
      } else if (/\.tsx?$/.test(entry)) {
        files.push({ relPath: rel, content: readFileSync(abs, "utf-8") });
      }
    }
  }
  for (const dir of BOUNDARY_DIRS) walk(path.join(AUDIO_ROOT, dir), dir);
  return files;
}

// AST-based (not regex) so a comment mentioning an import-shaped string (e.g.
// registry.ts's `(renamed from "Time CV" in migration 0017)`) can never be
// mistaken for a real specifier.
function extractSpecifiers(file: SourceFile): string[] {
  const scriptKind = file.relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file.relPath, file.content, ts.ScriptTarget.Latest, true, scriptKind);
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) specifiers.push(spec.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push((node.arguments[0] as ts.StringLiteral).text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

export function findBoundaryViolations(files: SourceFile[]): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const file of files) {
    const isTest = /\.test\.tsx?$/.test(file.relPath);
    const fileDir = path.posix.dirname(file.relPath);
    for (const specifier of extractSpecifiers(file)) {
      if (specifier.startsWith(".")) {
        const withoutQuery = specifier.split("?")[0];
        const resolved = path.posix.normalize(path.posix.join(fileDir, withoutQuery));
        const inBoundary = BOUNDARY_DIRS.some(
          (dir) => resolved === dir || resolved.startsWith(`${dir}/`),
        );
        if (!inBoundary) violations.push({ file: file.relPath, specifier });
      } else if (!(isTest && specifier === "vitest")) {
        violations.push({ file: file.relPath, specifier });
      }
    }
  }
  return violations;
}

describe("engine/modules/worklet boundary", () => {
  it("has no import from outside engine/, modules/ or worklet/", () => {
    const violations = findBoundaryViolations(collectSourceFiles());
    expect(violations).toEqual([]);
  });

  it("fails when given a fixture file containing a lib/api import", () => {
    const violations = findBoundaryViolations([
      {
        relPath: "modules/fixture.ts",
        content: `import type { Module } from "../../lib/api";\n`,
      },
    ]);
    expect(violations).toEqual([{ file: "modules/fixture.ts", specifier: "../../lib/api" }]);
  });

  it("allows a within-boundary import across engine/modules/worklet siblings", () => {
    const violations = findBoundaryViolations([
      { relPath: "modules/registry.ts", content: `import type { Kernel } from "../engine/kernel";\n` },
    ]);
    expect(violations).toEqual([]);
  });

  it("allows vitest in a test file but flags it in a non-test file", () => {
    expect(
      findBoundaryViolations([
        { relPath: "modules/foo.test.ts", content: `import { describe } from "vitest";\n` },
      ]),
    ).toEqual([]);
    expect(
      findBoundaryViolations([
        { relPath: "modules/foo.ts", content: `import { describe } from "vitest";\n` },
      ]),
    ).toEqual([{ file: "modules/foo.ts", specifier: "vitest" }]);
  });

  it("does not mistake a comment containing an import-shaped string for a real specifier", () => {
    const violations = findBoundaryViolations([
      {
        relPath: "modules/fixture.ts",
        content: `// renamed from "Time CV" in migration 0017\nexport const X = 1;\n`,
      },
    ]);
    expect(violations).toEqual([]);
  });
});
