import { describe, expect, it } from "vitest";
import {
  mergeCropReocrResults,
  selectCropReocrTargets
} from "../../src/shared/speechBubbleReocr";
import type { SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction";

describe("speechBubbleReocr", () => {
  it("selects low-confidence speech and non-speech text for crop reOCR", () => {
    const result = extraction({
      speechConfidence: 0.74,
      nonSpeechConfidence: 0.5
    });

    expect(selectCropReocrTargets(result).map((target) => `${target.kind}:${target.index}`)).toEqual([
      "speechBubbles:0",
      "nonSpeechText:0"
    ]);
  });

  it("selects text containing [?] for crop reOCR", () => {
    const result = extraction({
      speechText: "Hel[?]o",
      speechConfidence: 0.95,
      nonSpeechText: "Do[?]r",
      nonSpeechConfidence: 0.91
    });

    expect(selectCropReocrTargets(result).map((target) => target.text)).toEqual(["Hel[?]o", "Do[?]r"]);
  });

  it("does not select confident text without uncertainty markers", () => {
    const result = extraction({
      speechText: "Hello",
      speechConfidence: 0.75,
      nonSpeechText: "Door",
      nonSpeechConfidence: 0.9
    });

    expect(selectCropReocrTargets(result)).toEqual([]);
  });

  it("applies crop text when it reduces [?]", () => {
    const result = extraction({ speechText: "Hel[?]o", speechConfidence: 0.62 });
    const [target] = selectCropReocrTargets(result);

    const merged = mergeCropReocrResults(result, [
      {
        target,
        result: { text: "Hello", confidence: 0.88, notes: "clear crop" }
      }
    ]);

    expect(merged.speechBubbles[0]?.text).toBe("Hello");
    expect(merged.speechBubbles[0]?.confidence).toBe(0.88);
    expect(merged.speechBubbles[0]?.notes).toContain("Crop ReOCR applied");
    expect(merged.speechBubbles[0]?.notes).toContain("clear crop");
    expect(merged.warnings).toEqual([]);
  });

  it("records a warning when crop text conflicts with existing text", () => {
    const result = extraction({ speechText: "Hello", speechConfidence: 0.6 });
    const [target] = selectCropReocrTargets(result);

    const merged = mergeCropReocrResults(result, [
      {
        target,
        result: { text: "Hallo", confidence: 0.9, notes: "crop says different text" }
      }
    ]);

    expect(merged.speechBubbles[0]?.text).toBe("Hello");
    expect(merged.speechBubbles[0]?.notes).toContain("crop says different text");
    expect(merged.warnings.join("\n")).toContain('whole image "Hello" vs crop "Hallo"');
  });

  it("preserves bbox type and readingOrder while merging", () => {
    const result = extraction({
      nonSpeechText: "Si[?]n",
      nonSpeechConfidence: 0.7
    });
    const nonSpeechTarget = selectCropReocrTargets(result).find((target) => target.kind === "nonSpeechText");

    const merged = mergeCropReocrResults(result, [
      {
        target: nonSpeechTarget!,
        result: { text: "Sign", confidence: 0.86, notes: "" }
      }
    ]);

    expect(merged.nonSpeechText[0]).toMatchObject({
      type: "sign_or_label",
      text: "Sign",
      bbox: { x: 0.4, y: 0.5, width: 0.2, height: 0.1 },
      readingOrder: 2
    });
  });

  it("preserves speaker candidates while merging crop reOCR text", () => {
    const result = extraction({
      speechText: "Hel[?]o"
    });
    result.speechBubbles[0] = {
      ...result.speechBubbles[0]!,
      speakerCandidates: [{ speaker: "Mika", confidence: 0.82, reason: "tail points left" }]
    };
    const [target] = selectCropReocrTargets(result);

    const merged = mergeCropReocrResults(result, [
      { target: target!, result: { text: "Hello", confidence: 0.9, notes: "clear crop" } }
    ]);

    expect(merged.speechBubbles[0]?.speakerCandidates).toEqual([
      { speaker: "Mika", confidence: 0.82, reason: "tail points left" }
    ]);
  });
});

function extraction(overrides: {
  speechText?: string;
  speechConfidence?: number;
  nonSpeechText?: string;
  nonSpeechConfidence?: number;
}): SpeechBubbleExtractionResult {
  return {
    pageNumber: 1,
    speechBubbles: [
      {
        id: "bubble-001",
        type: "speech_bubble",
        text: overrides.speechText ?? "Hello",
        language: "en",
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        readingOrder: 1,
        confidence: overrides.speechConfidence ?? 0.9,
        notes: "whole image",
        speakerCandidates: []
      }
    ],
    nonSpeechText: [
      {
        type: "sign_or_label",
        text: overrides.nonSpeechText ?? "Door",
        bbox: { x: 0.4, y: 0.5, width: 0.2, height: 0.1 },
        readingOrder: 2,
        confidence: overrides.nonSpeechConfidence ?? 0.85,
        notes: "background sign",
        speakerCandidates: []
      }
    ],
    warnings: []
  };
}
