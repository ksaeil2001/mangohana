import { describe, expect, it } from "vitest";
import type { DialogueLine } from "../../src/shared/projectTypes";
import {
  classifyTranslationOwnership,
  canConfirmTranslation,
  confirmTranslation,
  markTranslationDraft,
  mergeAiTranslationProposal,
  markTranslationReview
} from "../../src/renderer/translationOwnership";

function line(overrides: Partial<DialogueLine> = {}): DialogueLine {
  return {
    id: "line-1",
    order: 1,
    pageNumber: 1,
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "原文",
    parseConfidence: 1,
    parseWarnings: [],
    lineStatus: "untranslated",
    ...overrides
  };
}

describe("translation ownership", () => {
  it("derives the four user-visible states without relying on color", () => {
    expect(classifyTranslationOwnership(line({ aiTranslation: "AI" }))).toMatchObject({
      state: "ai-suggestion",
      label: "AI 제안"
    });
    expect(classifyTranslationOwnership(line({ userTranslation: "수정", lineStatus: "draft" }))).toMatchObject({
      state: "user-edited",
      label: "사용자 수정"
    });
    expect(classifyTranslationOwnership(line({ userTranslation: "확정", lineStatus: "complete" }))).toMatchObject({
      state: "user-confirmed",
      label: "사용자 확정"
    });
    expect(classifyTranslationOwnership(line({ lineStatus: "review", userTranslation: "재검토" }))).toMatchObject({
      state: "review-required",
      label: "재검토 필요"
    });
  });

  it("protects user text and completion while accepting a fresh AI proposal", () => {
    const confirmed = line({ aiTranslation: "old AI", userTranslation: "사용자 확정", lineStatus: "complete" });
    const merged = mergeAiTranslationProposal(confirmed, "new AI");
    expect(merged.aiTranslation).toBe("new AI");
    expect(merged.userTranslation).toBe("사용자 확정");
    expect(merged.lineStatus).toBe("complete");
  });

  it("creates draft, confirm, and review transitions using only user-owned fields", () => {
    const draft = markTranslationDraft(line({ aiTranslation: "AI" }), " 사용자 수정 ");
    expect(draft).toMatchObject({ userTranslation: " 사용자 수정 ", lineStatus: "draft", aiTranslation: "AI" });
    const confirmed = confirmTranslation(draft);
    expect(confirmed).toMatchObject({ userTranslation: " 사용자 수정 ", lineStatus: "complete" });
    expect(markTranslationReview(confirmed).lineStatus).toBe("review");
  });

  it("adopts the selected AI suggestion on explicit confirmation without overwriting user text", () => {
    expect(confirmTranslation(line({ aiTranslation: "제안 번역" }))).toMatchObject({
      aiTranslation: "제안 번역", userTranslation: "제안 번역", lineStatus: "complete"
    });
    expect(confirmTranslation(line({ aiTranslation: "제안 번역", userTranslation: "사용자 번역" }))).toMatchObject({
      aiTranslation: "제안 번역", userTranslation: "사용자 번역", lineStatus: "complete"
    });
  });

  it("requires actual text and never replaces an existing whitespace-only user value with a proposal", () => {
    expect(canConfirmTranslation(line())).toBe(false);
    expect(canConfirmTranslation(line({ aiTranslation: "제안" }))).toBe(true);
    expect(canConfirmTranslation(line({ userTranslation: "사용자" }))).toBe(true);
    expect(canConfirmTranslation(line({ userTranslation: "  ", aiTranslation: "제안" }))).toBe(false);
  });
});
