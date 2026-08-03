#!/usr/bin/env node
// Second half of `npm run build`, after tsdown has written dist/main.js.
// rolldown (tsdown's bundler) treats "patchatlas-audio" as external -- a real
// npm dependency, not bundled by default -- so dist/main.js still contains a
// bare `import ... from "patchatlas-audio"` a browser cannot resolve on its
// own. Rather than fight the bundler into inlining it, this step copies the
// package's own built dist/index.js byte-for-byte and index.html declares an
// import map pointing the bare specifier at that copy: the browser resolves
// exactly the same artifact npm's `exports` map would have handed a bundler,
// unmodified. Both resolutions go through import.meta.resolve() against
// "patchatlas-audio"'s own package.json, exactly like the root package's
// scripts/smoke.mjs, so a broken or renamed export (the main
// entry or "./worklet.js") fails this build instead of silently shipping a
// stale copy.
//
// src/main.ts additionally points `workletUrl` explicitly at dist/worklet.js
// rather than relying on the package's bundled-in default -- an explicit
// exercise of the public `workletUrl` override documented in the README.

import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const dist = path.join(root, "dist");

mkdirSync(dist, { recursive: true });

// Deliberately not fs.cpSync(src, dist, { recursive: true }): its recursive
// directory-copy path throws EACCES against this workspace's dist/ under
// Docker Desktop's macOS bind mount (verified against test.sh's containerized
// build step -- plain mkdirSync + copyFileSync do not have the problem).
function copyTree(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, entry);
    const destPath = path.join(destDir, entry);
    if (statSync(srcPath).isDirectory()) copyTree(srcPath, destPath);
    else copyFileSync(srcPath, destPath);
  }
}
copyTree(path.join(root, "static"), dist);

const indexUrl = await import.meta.resolve("patchatlas-audio");
copyFileSync(fileURLToPath(indexUrl), path.join(dist, "patchatlas-audio.js"));

const workletUrl = await import.meta.resolve("patchatlas-audio/worklet.js");
copyFileSync(fileURLToPath(workletUrl), path.join(dist, "worklet.js"));

console.log("copy-assets: static shell + patchatlas-audio.js + worklet.js -> dist/");
