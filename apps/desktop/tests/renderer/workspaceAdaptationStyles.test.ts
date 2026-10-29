import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/renderer/styles.css", "utf8");

describe("workspace adaptation stylesheet contract", () => {
  it("defines the exact 1440/1200/1024 responsive boundaries", () => {
    const boundaries = [
      "@media screen and (min-width: 1440px)",
      "@media screen and (min-width: 1200px) and (max-width: 1439.98px)",
      "@media screen and (min-width: 1024px) and (max-width: 1199.98px)",
      "@media screen and (max-width: 1023.98px)"
    ];
    for (const boundary of boundaries) expect(styles).toContain(boundary);
    expect(styles.indexOf(boundaries[0])).toBeLessThan(styles.indexOf(boundaries[1]));
    expect(styles.indexOf(boundaries[1])).toBeLessThan(styles.indexOf(boundaries[2]));
    expect(styles.indexOf(boundaries[2])).toBeLessThan(styles.indexOf(boundaries[3]));
  });

  it("keeps 1024-1199 panels in document flow so image and edge controls remain reachable", () => {
    const responsiveContract = styles.slice(styles.lastIndexOf("/* UI-11 responsive contract."));
    expect(responsiveContract).toContain(".focus-deck-shell .resizable-workspace > .focus-deck-editor");
    expect(responsiveContract).toContain(".focus-deck-shell .focus-deck-pages");
    expect(responsiveContract).toContain("display: grid");
    expect(responsiveContract).toContain("position: static");
    expect(responsiveContract).toContain("inset: auto");
    expect(responsiveContract).not.toContain("position: fixed");
    expect(responsiveContract).not.toContain("display: block !important");
    expect(styles).not.toMatch(/\.focus-deck-shell \.resizable-workspace > \.focus-deck-editor\s*\{[^}]*position:\s*fixed/);
    expect(styles).toContain(".focus-deck-pages-edge");
    expect(styles).toContain(".focus-deck-inspector-edge");
    expect(styles).toContain(".focus-deck-results-control");
    expect(styles).toContain("min-height: var(--focus-edge-control-size)");
  });

  it("gives the resizable workspace the center column when pages are collapsed", () => {
    const pagesCollapsedSelector = ".focus-deck-shell.pages-collapsed .focus-deck-workspace";
    const pagesCollapsedIndex = styles.lastIndexOf(pagesCollapsedSelector);
    const precisionMediaIndex = styles.lastIndexOf("@media screen and (max-width: 1023.98px)");
    expect(pagesCollapsedIndex).toBeGreaterThan(precisionMediaIndex);

    const pagesCollapsedContract = styles.slice(pagesCollapsedIndex, styles.indexOf("}", pagesCollapsedIndex) + 1);
    expect(pagesCollapsedContract).toMatch(
      /grid-template-columns:\s*var\(--focus-edge-control-size\)\s+minmax\(0,\s*1fr\)\s+var\(--focus-edge-control-size\)/
    );
  });

  it("releases the inspector track when the inspector DOM is collapsed", () => {
    const inspectorCollapsedSelector = ".focus-deck-shell .focus-deck-workspace .resizable-workspace.inspector-collapsed";
    const inspectorCollapsedIndex = styles.lastIndexOf(inspectorCollapsedSelector);
    const precisionMediaIndex = styles.lastIndexOf("@media screen and (max-width: 1023.98px)");
    expect(inspectorCollapsedIndex).toBeGreaterThan(precisionMediaIndex);

    const inspectorCollapsedContract = styles.slice(
      inspectorCollapsedIndex,
      styles.indexOf("}", inspectorCollapsedIndex) + 1
    );
    expect(inspectorCollapsedContract).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("wraps the 1024-1199 top bar after legacy max-1099 rules", () => {
    const legacyRulesIndex = styles.lastIndexOf("@media (max-width: 1099px)");
    const narrowIndex = styles.lastIndexOf("@media screen and (min-width: 1024px) and (max-width: 1199.98px)");
    const nextTierIndex = styles.indexOf("@media screen and (max-width: 1023.98px)", narrowIndex);
    expect(narrowIndex).toBeGreaterThan(legacyRulesIndex);
    expect(nextTierIndex).toBeGreaterThan(narrowIndex);

    const narrowContract = styles.slice(narrowIndex, nextTierIndex);
    expect(narrowContract).toContain('.focus-deck-shell[data-layout-tier="narrow"] .focus-deck-top-bar');
    expect(narrowContract).toContain("flex-wrap: wrap");
    expect(narrowContract).toContain("overflow: auto");
    expect(narrowContract).toContain('.focus-deck-shell[data-layout-tier="narrow"] .focus-deck-top-bar > .app-top-bar');
    expect(narrowContract).toContain("flex: 1 1 100%");
    expect(narrowContract).toContain("height: auto");
    expect(narrowContract).toContain("min-height: var(--focus-top-height)");
  });

  it("keeps an open narrow inspector in the second track when its resize handle is hidden", () => {
    const narrowIndex = styles.lastIndexOf("@media screen and (min-width: 1024px) and (max-width: 1199.98px)");
    const nextTierIndex = styles.indexOf("@media screen and (max-width: 1023.98px)", narrowIndex);
    const narrowContract = styles.slice(narrowIndex, nextTierIndex);
    expect(narrowContract).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*(?:var\(--focus-editor-width\)|min\(var\(--focus-editor-width\),\s*30vw\)\))/
    );
    expect(narrowContract).toContain(".focus-deck-resize-handle");
    expect(narrowContract).toContain("display: none");
    expect(narrowContract).toContain('.focus-deck-shell[data-layout-tier="narrow"] .focus-deck-workspace .resizable-workspace > .focus-deck-editor');
    expect(narrowContract).toContain("grid-column: 2");
    expect(narrowContract).toContain("overflow: auto");
  });

  it("removes the project path from non-wide top bars while retaining primary actions", () => {
    const responsiveContract = styles.slice(styles.lastIndexOf("/* UI-11 responsive contract."));
    expect(responsiveContract).toContain(".focus-deck-top-bar .top-file-path");
    expect(responsiveContract).toContain("display: none");
    expect(styles).toContain(".top-file-actions");
    expect(styles).not.toContain('.focus-deck-shell[data-layout-tier="wide"] .top-file-path');
  });

  it("wraps welcome actions into an in-flow row at 1024px", () => {
    const welcomeContract = styles.slice(styles.indexOf("@media (min-width: 701px) and (max-width: 1100px)"));

    expect(welcomeContract).toContain(".project-home-header");
    expect(welcomeContract).toContain("flex-wrap: wrap");
    expect(welcomeContract).toContain(".project-home-header-actions");
    expect(welcomeContract).toContain("flex: 1 1 100%");
    expect(welcomeContract).toContain("justify-content: flex-end");
    expect(welcomeContract).toContain("max-width: 100%");
  });

  it("keeps edge toggles, badges, and focus rings inside their 34px tracks", () => {
    const responsiveContract = styles.slice(styles.lastIndexOf("/* UI-11 responsive contract."));
    expect(responsiveContract).toContain(".focus-deck-pages-edge .focus-deck-panel-toggle");
    expect(responsiveContract).toContain(".focus-deck-inspector-edge .focus-deck-panel-toggle");
    expect(responsiveContract).toContain("width: 100%");
    expect(responsiveContract).toContain("min-width: 0");
    expect(responsiveContract).toContain("max-width: 100%");
    expect(responsiveContract).toContain("overflow: hidden");
    expect(responsiveContract).toContain(".focus-deck-panel-badge");
    expect(responsiveContract).toContain("outline-offset: -2px");
  });

  it("keeps narrow and precision legends horizontal while reserving image stage height", () => {
    const responsiveContract = styles.slice(styles.lastIndexOf("/* UI-11 responsive contract."));
    for (const tier of ["narrow", "precision-limited"]) {
      expect(responsiveContract).toContain(
        `.focus-deck-shell[data-layout-tier="${tier}"] .page-image-toolbar .semantic-overlay-legend`
      );
      expect(responsiveContract).toContain(
        `.focus-deck-shell[data-layout-tier="${tier}"] .page-image-toolbar .semantic-overlay-legend-items`
      );
      expect(responsiveContract).toContain(
        `.focus-deck-shell[data-layout-tier="${tier}"] .page-image-toolbar .semantic-overlay-toggle`
      );
    }
    expect(responsiveContract).toContain("flex-wrap: nowrap");
    expect(responsiveContract).toContain("overflow-x: auto");
    expect(responsiveContract).toContain("max-height: 64px");
    expect(responsiveContract).toContain("flex: 0 0 auto");
    expect(responsiveContract).toContain(".page-image-panel:not(.editor-open)");
    expect(responsiveContract).toContain("grid-template-rows: auto minmax(180px, 1fr) auto");
    expect(responsiveContract).toContain(".page-image-stage");
    expect(responsiveContract).toContain("min-height: 180px");
  });

  it("preserves a visible focus ring for all keyboard-reachable workspace controls", () => {
    expect(styles).toContain(":where(button, a, input, select, textarea, [tabindex]):focus-visible");
    expect(styles).toContain("outline: 3px solid Highlight");
    expect(styles).toContain("outline-offset: 2px");
  });

  it("has a forced-colors contract that keeps selected/current/error and semantic overlay meaning", () => {
    const forcedColors = styles.slice(styles.lastIndexOf("@media (forced-colors: active)"));
    expect(forcedColors).toContain('button[aria-pressed="true"]');
    expect(forcedColors).toContain('[aria-current="true"]');
    expect(forcedColors).toContain('[aria-current="step"]');
    expect(forcedColors).toContain("border: 2px solid Highlight");
    expect(forcedColors).toContain("color: HighlightText");
    expect(forcedColors).toContain("data-overlay-line-style");
    expect(forcedColors).toContain("border-style: dotted");
    expect(forcedColors).toContain("border-style: double");
    expect(forcedColors).toContain(".semantic-overlay-label");
    expect(forcedColors).toContain("CanvasText");
    expect(forcedColors).toContain('data-result-status="render-failed"');
    expect(forcedColors).toContain("border: 2px dashed CanvasText");
    expect(forcedColors).toContain("background: Canvas");
    expect(styles).toContain('data-overlay-pattern="crosshatch"');
    expect(styles).toContain('data-overlay-pattern="grid"');
  });
});
