// Import-boundary enforcement (#288 acceptance criterion: "Grep confirms no
// import resolves outside patchatlas-audio's public entry"). Every import of
// the package must be the bare "patchatlas-audio" specifier -- never a deep
// path into its dist/ or src/ -- and every relative import must resolve
// inside this directory, so no file here can reach into PatchAtlas code, the
// engine's internals, or the package's TypeScript sources. AST-based (not
// regex), matching packages/audio/src/boundary.test.ts's approach, so a
// comment mentioning an import-shaped string can never be mistaken for a
// real specifier.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.dirname(new URL(import.meta.url).pathname);

export interface SourceFile {
  relPath: string;
  content: string;
}

export interface BoundaryViolation {
  file: string;
  specifier: string;
}

// This file itself is excluded: it is test/tooling code (imports "vitest",
// "typescript", "node:fs", "node:path"), not part of the shipped playground,
// the same way packages/audio/src/boundary.test.ts lives outside the
// directories it scans.
const SELF = path.basename(new URL(import.meta.url).pathname);

function collectSourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  function walk(absDir: string, relDir: string): void {
    for (const entry of readdirSync(absDir)) {
      const abs = path.join(absDir, entry);
      const rel = relDir ? `${relDir}/${entry}` : entry;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else if (/\.tsx?$/.test(entry) && entry !== SELF) files.push({ relPath: rel, content: readFileSync(abs, "utf-8") });
    }
  }
  walk(SRC_ROOT, "");
  return files;
}

function extractSpecifiers(file: SourceFile): string[] {
  const source = ts.createSourceFile(file.relPath, file.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
        const resolved = path.posix.normalize(path.posix.join(fileDir, specifier));
        if (resolved.startsWith("..")) violations.push({ file: file.relPath, specifier });
      } else if (specifier.startsWith("patchatlas-audio")) {
        if (specifier !== "patchatlas-audio") violations.push({ file: file.relPath, specifier });
      } else if (!(isTest && specifier === "vitest")) {
        violations.push({ file: file.relPath, specifier });
      }
    }
  }
  return violations;
}

describe("playground import boundary", () => {
  it("imports only the bare patchatlas-audio specifier and within-src relative paths", () => {
    expect(findBoundaryViolations(collectSourceFiles())).toEqual([]);
  });

  it("flags a deep import into the package's dist or src", () => {
    expect(
      findBoundaryViolations([
        { relPath: "fixture.ts", content: `import { registry } from "patchatlas-audio/dist/internal";\n` },
      ]),
    ).toEqual([{ file: "fixture.ts", specifier: "patchatlas-audio/dist/internal" }]);
  });

  it("flags a relative import escaping the src directory", () => {
    expect(
      findBoundaryViolations([
        { relPath: "fixture.ts", content: `import type { Module } from "../../web/src/lib/api";\n` },
      ]),
    ).toEqual([{ file: "fixture.ts", specifier: "../../web/src/lib/api" }]);
  });

  it("does not mistake a comment containing an import-shaped string for a real specifier", () => {
    expect(
      findBoundaryViolations([
        { relPath: "fixture.ts", content: `// see "patchatlas-audio/worklet.js" in the README\nexport const X = 1;\n` },
      ]),
    ).toEqual([]);
  });
});
