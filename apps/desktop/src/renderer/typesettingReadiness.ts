import type { DialogueLine } from "../shared/projectTypes.js";
import type { RenderReadinessEvidence } from "../shared/renderReadiness.js";
import { isValidTypesettingGeometry } from "../shared/renderReadiness.js";
import {
  PRODUCTION_TYPESET_FONT_CSS_FAMILY,
  PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY
} from "../shared/productionTypesetFontResource.js";
import {
  hasTypesettingTextOverflow
} from "./typesettingGeometry.js";

/**
 * Collects renderer-only evidence without treating a generic CSS family as a
 * verified font. Main receives the resulting evidence and rechecks its
 * relationship to the current project before accepting the PNG.
 */
export function collectRenderReadinessEvidence(
  lines: readonly DialogueLine[],
  options: { productionFontLoaded?: boolean } = {}
): RenderReadinessEvidence {
  try {
    return collectRenderReadinessEvidenceUnsafe(lines, options);
  } catch {
    return createFailClosedEvidence();
  }
}

function collectRenderReadinessEvidenceUnsafe(
  lines: readonly DialogueLine[],
  options: { productionFontLoaded?: boolean }
): RenderReadinessEvidence {
  const productionFontLoaded = options.productionFontLoaded === true;
  const effectiveFontFamily = PRODUCTION_TYPESET_FONT_CSS_FAMILY;
  const documentFontsAvailable = hasDocumentFonts();
  const metricContext = createMetricContext();
  const lineFontChecks = lines.map((line) => {
    const text = line.userTranslation?.trim() ?? "";
    const resourceAvailable = Boolean(
      productionFontLoaded &&
      documentFontsAvailable &&
      checkFontResource(effectiveFontFamily, text || "한")
    );
    const metricsCalculated = Boolean(
      productionFontLoaded &&
      documentFontsAvailable &&
      metricContext &&
      measureText(metricContext, effectiveFontFamily, text || "한")
    );
    const glyphCoverageVerified = Boolean(
      metricContext &&
      text &&
      resourceAvailable &&
      [...text].every((character) => measureText(metricContext, effectiveFontFamily, character))
    );
    return {
      line,
      resourceAvailable,
      metricsCalculated,
      glyphCoverageVerified
    };
  });

  const resourceAvailable = Boolean(
    productionFontLoaded &&
    documentFontsAvailable &&
    checkFontResource(effectiveFontFamily, "한") &&
    (lines.length === 0 || lineFontChecks.every((check) => check.resourceAvailable))
  );
  const metricsCalculated = Boolean(
    productionFontLoaded &&
    documentFontsAvailable &&
    metricContext &&
    measureText(metricContext, effectiveFontFamily, "한") &&
    (lines.length === 0 || lineFontChecks.every((check) => check.metricsCalculated))
  );
  const glyphCoverageVerified = Boolean(
    resourceAvailable &&
    metricsCalculated &&
    lineFontChecks.every((check) => check.glyphCoverageVerified || !check.line.userTranslation?.trim())
  );

  const missingGlyphLineIds = lineFontChecks
    .filter((check) => check.line.userTranslation?.trim() && !check.glyphCoverageVerified)
    .map((check) => check.line.id);
  const overflowLineIds = lines
    .filter((line) => {
      const text = line.userTranslation?.trim() ?? "";
      const typesetting = line.typesetting;
      return Boolean(
        text &&
        typesetting &&
        isValidTypesettingGeometry(typesetting) &&
        hasTypesettingTextOverflow(text, {
          shape: typesetting.shape,
          fontSizeRatio: typesetting.fontSizeRatio,
          lineHeight: typesetting.lineHeight
        })
      );
    })
    .map((line) => line.id);

  return {
    font: {
      identity: productionFontLoaded && documentFontsAvailable
        ? PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY
        : "",
      resourceAvailable,
      metricsCalculated,
      glyphCoverageVerified
    },
    safeAreaProvisionalLineIds: [],
    missingGlyphLineIds,
    overflowLineIds
  };
}

function createFailClosedEvidence(): RenderReadinessEvidence {
  return {
    font: {
      identity: "",
      resourceAvailable: false,
      metricsCalculated: false,
      glyphCoverageVerified: false
    },
    safeAreaProvisionalLineIds: [],
    missingGlyphLineIds: [],
    overflowLineIds: []
  };
}

function hasDocumentFonts(): boolean {
  return getDocumentFontSet() !== null;
}

function checkFontResource(family: string, text: string): boolean {
  try {
    const fonts = getDocumentFontSet();
    if (!fonts) return false;
    const check = fonts.check;
    if (!check) return false;
    return check(`16px "${family.replaceAll('"', "")}"`, text);
  } catch {
    return false;
  }
}

function getDocumentFontSet(): { check?: (font: string, text?: string) => boolean } | null {
  try {
    if (typeof document === "undefined") return null;
    const fonts = document.fonts;
    return fonts && typeof fonts.check === "function" ? fonts : null;
  } catch {
    return null;
  }
}

function createMetricContext(): CanvasRenderingContext2D | null {
  try {
    if (typeof document === "undefined") return null;
    return document.createElement("canvas").getContext("2d");
  } catch {
    return null;
  }
}

function measureText(
  context: CanvasRenderingContext2D,
  family: string,
  text: string
): boolean {
  try {
    context.font = `bold 16px "${family.replaceAll('"', "")}"`;
    const metrics = context.measureText(text);
    return Number.isFinite(metrics.width) && metrics.width > 0 &&
      Number.isFinite(metrics.actualBoundingBoxAscent) &&
      Number.isFinite(metrics.actualBoundingBoxDescent);
  } catch {
    return false;
  }
}
