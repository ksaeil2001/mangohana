import { describe, expect, it } from "vitest";
import {
  PRODUCTION_TYPESET_FONT_CSS_FAMILY,
  PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY,
  PRODUCTION_TYPESET_FONT_URL
} from "../../src/shared/productionTypesetFontResource";

describe("production typeset font public contract", () => {
  it("exposes only the fixed renderer-safe identity, family, and URL values", () => {
    expect(PRODUCTION_TYPESET_FONT_CSS_FAMILY).toBe("Pretendard");
    expect(PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY).toBe(
      "Pretendard Std Variable@1.3.9"
    );
    expect(PRODUCTION_TYPESET_FONT_URL).toBe(
      "trio-resource://font/pretendard-variable.ttf"
    );
  });
});
