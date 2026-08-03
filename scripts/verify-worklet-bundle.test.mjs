// Coverage for findUnresolvedImports's regex (GH #294 finding #3): it must
// catch every shape that would break an AudioWorklet's global scope, and
// must not flag prose that merely mentions "import".

import { describe, expect, it } from "vitest";
import { findUnresolvedImports } from "./verify-worklet-bundle.mjs";

describe("findUnresolvedImports", () => {
  it("catches a static default import", () => {
    expect(findUnresolvedImports('import foo from "bar";')).not.toBeNull();
  });

  it("catches a bare side-effect import", () => {
    expect(findUnresolvedImports('import "bar";')).not.toBeNull();
  });

  it("catches a dynamic import() call", () => {
    expect(findUnresolvedImports('const m = await import("bar");')).not.toBeNull();
  });

  it("catches a dynamic import() call with whitespace before the parenthesis", () => {
    expect(findUnresolvedImports('const m = await import ("bar");')).not.toBeNull();
  });

  it("catches a re-export from", () => {
    expect(findUnresolvedImports('export { foo } from "bar";')).not.toBeNull();
  });

  it("catches a require() call", () => {
    expect(findUnresolvedImports('const foo = require("bar");')).not.toBeNull();
  });

  it("does not flag prose that mentions import without the syntax", () => {
    expect(findUnresolvedImports("// this worklet has no import statements")).toBeNull();
  });

  it("does not flag a self-contained bundle with no import/require", () => {
    expect(findUnresolvedImports('class Foo { process() { return 1; } }')).toBeNull();
  });
});
