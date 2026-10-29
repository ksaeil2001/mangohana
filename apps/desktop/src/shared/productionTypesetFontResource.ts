/**
 * Renderer-safe identifiers for the production Korean typesetting font.
 *
 * Resource roots, policy files, and trust decisions stay in Main. The
 * renderer only needs the fixed CSS family, evidence identity, and read-only
 * protocol URL to load and report the installed font.
 */
export const PRODUCTION_TYPESET_FONT_CSS_FAMILY = "Pretendard" as const;
export const PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY =
  "Pretendard Std Variable@1.3.9" as const;
export const PRODUCTION_TYPESET_FONT_URL =
  "trio-resource://font/pretendard-variable.ttf" as const;
