import { describe, expect, it } from "vitest";
import {
  OVERLAY_KIND_ORDER,
  SEMANTIC_OVERLAY_META,
  clampSemanticBbox,
  getSemanticOverlayMeta,
  buildSemanticOverlayDescriptors,
  selectVisibleSemanticOverlays,
  type SemanticOverlayDescriptor
} from "../../src/renderer/semanticOverlays";

const descriptor = (id: string, kind: SemanticOverlayDescriptor["kind"], selected = false): SemanticOverlayDescriptor => ({
  id,
  kind,
  bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
  selected
});

describe("semantic overlay descriptors", () => {
  it("defines a labeled, non-color semantic marker for every overlay kind", () => {
    expect(OVERLAY_KIND_ORDER).toEqual([
      "ocr",
      "balloon",
      "safe-area",
      "typeset",
      "inpainting-mask",
      "preserve",
      "issue"
    ]);

    for (const kind of OVERLAY_KIND_ORDER) {
      const meta = getSemanticOverlayMeta(kind);
      expect(meta.label).toBe(SEMANTIC_OVERLAY_META[kind].label);
      expect(meta.pattern).toBeTruthy();
      expect(meta.lineStyle).toBeTruthy();
      expect(meta.className).toContain(`semantic-overlay-${kind}`);
    }
  });

  it("clamps normalized bbox coordinates without changing source objects", () => {
    const source = { x: -0.2, y: 0.8, width: 1.4, height: 0.5 };
    expect(clampSemanticBbox(source)).toMatchObject({ x: 0, y: 0.8, width: 1 });
    expect(clampSemanticBbox(source).height).toBeCloseTo(0.2);
    expect(source).toEqual({ x: -0.2, y: 0.8, width: 1.4, height: 0.5 });
  });

  it("retains selected overlays while capping unselected overlays deterministically", () => {
    const overlays = [
      descriptor("issue-2", "issue"),
      descriptor("ocr-selected", "ocr", true),
      descriptor("issue-1", "issue"),
      descriptor("balloon-selected", "balloon", true),
      descriptor("typeset-1", "typeset"),
      descriptor("ocr-1", "ocr")
    ];

    const first = selectVisibleSemanticOverlays(overlays, { maxUnselected: 2 });
    const second = selectVisibleSemanticOverlays([...overlays].reverse(), { maxUnselected: 2 });

    expect(first.filter((item) => item.selected).map((item) => item.id)).toEqual([
      "ocr-selected",
      "balloon-selected"
    ]);
    expect(first).toHaveLength(4);
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
    expect(first.map((item) => item.id)).toEqual([
      "ocr-selected",
      "balloon-selected",
      "ocr-1",
      "typeset-1"
    ]);
  });

  it("filters by visible kind before congestion selection", () => {
    const overlays = [descriptor("ocr-1", "ocr"), descriptor("issue-1", "issue", true)];
    expect(
      selectVisibleSemanticOverlays(overlays, {
        visibleKinds: ["issue"],
        maxUnselected: 0
      }).map((item) => item.id)
    ).toEqual(["issue-1"]);
  });

  it("builds real extraction overlays for all seven kinds without persisting derived geometry", () => {
    const descriptors = buildSemanticOverlayDescriptors({
      extraction: {
        pageNumber: 1,
        speechBubbles: [{
          id: "bubble-1",
          type: "speech_bubble",
          text: "hello",
          language: "en",
          bbox: { x: 0.2, y: 0.25, width: 0.3, height: 0.2 },
          readingOrder: 1,
          confidence: 0.45,
          notes: "unclear",
          speakerCandidates: []
        }],
        nonSpeechText: [{
          type: "sign_or_label",
          text: "sign",
          bbox: { x: 0.6, y: 0.1, width: 0.2, height: 0.1 },
          confidence: 0.9,
          notes: "",
          readingOrder: 2,
          speakerCandidates: []
        }],
        warnings: ["low resolution"]
      },
      activeItemId: "bubble-1",
      inpaintingMaskBbox: { x: 0.05, y: 0.05, width: 0.1, height: 0.1 }
    });

    expect(new Set(descriptors.map((item) => item.kind))).toEqual(new Set(OVERLAY_KIND_ORDER));
    expect(descriptors.filter((item) => item.selected).map((item) => item.kind)).toEqual(
      expect.arrayContaining(["ocr", "balloon", "safe-area", "typeset", "issue"])
    );
    expect(descriptors.find((item) => item.kind === "typeset")?.label).toMatch(/초안|추정/);
    expect(descriptors.find((item) => item.kind === "safe-area")?.label).toMatch(/추정/);
    expect(descriptors.find((item) => item.kind === "inpainting-mask")?.bbox).toEqual({
      x: 0.05,
      y: 0.05,
      width: 0.1,
      height: 0.1
    });
  });

  it("keeps duplicate source bubble descriptors unique and stable while preserving first-id selection", () => {
    const extraction = {
      pageNumber: 1,
      speechBubbles: [
        {
          id: "duplicate-bubble",
          type: "speech_bubble" as const,
          text: "first",
          language: "en" as const,
          bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
          readingOrder: 1,
          confidence: 0.6,
          notes: "unclear",
          speakerCandidates: []
        },
        {
          id: "duplicate-bubble",
          type: "thought_bubble" as const,
          text: "second",
          language: "en" as const,
          bbox: { x: 0.4, y: 0.1, width: 0.2, height: 0.1 },
          readingOrder: 2,
          confidence: 0.9,
          notes: "",
          speakerCandidates: []
        }
      ],
      nonSpeechText: [],
      warnings: []
    };

    const first = buildSemanticOverlayDescriptors({ extraction, activeItemId: "duplicate-bubble" });
    const second = buildSemanticOverlayDescriptors({ extraction, activeItemId: "duplicate-bubble" });
    const ids = first.map((item) => item.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(second.map((item) => item.id));
    expect(first.some((item) => item.id === "ocr:duplicate-bubble")).toBe(true);
    expect(first.filter((item) => item.selected).length).toBeGreaterThan(0);
    expect(new Set(first.map((item) => item.kind))).toEqual(new Set(["ocr", "balloon", "safe-area", "typeset", "issue"]));
  });
});
