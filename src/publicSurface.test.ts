// Public-surface snapshot (#286): the exported name list from index.ts is
// what the package commits to supporting once extracted — additions must be
// deliberate, and this test is what makes a silent one fail CI.

import { describe, expect, it } from "vitest";
import * as publicSurface from "./index";

describe("audio public surface", () => {
  it("exports exactly the committed set of names", () => {
    expect(Object.keys(publicSurface).sort()).toEqual(
      [
        "createEngine",
        "validate",
        "compilePatch",
        "getModuleDefinitions",
        "getModuleDefinition",
        "isPlayable",
        "normalizedToEngineValue",
        "engineValueToNormalized",
        "defaultNormalizedValue",
        "isBipolarParam",
        "clampToSpecRange",
        "REVERB_SLUG",
        "REVERB_PRESET_CONTROL",
        "REVERB_PRESET_VISIBLE",
        "REVERB_PRESET_POSITIONS",
      ].sort(),
    );
  });
});
