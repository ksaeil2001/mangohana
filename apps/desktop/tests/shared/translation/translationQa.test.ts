import { describe, expect, it } from "vitest";
import type { CharacterProfile, DictionaryTerm } from "../../../src/shared/projectTypes";
import { inspectTranslationQuality } from "../../../src/shared/translation/translationQa";

describe("translationQa", () => {
  const honorificProfile: CharacterProfile = {
    id: "char-1",
    name: "비올라",
    aliases: ["ヴィオラ"],
    speechStyle: "정중한 존댓말/경어체"
  };

  const glossary: DictionaryTerm[] = [
    { id: "term-1", source: "海賊王", target: "해적왕" },
    { id: "term-2", source: "ゴムゴムの実", target: "고무고무 열매" }
  ];

  it("passes high-quality, fully consistent translation", () => {
    const report = inspectTranslationQuality({
      sourceText: "海賊王に私はなります。",
      translatedText: "해적왕이 저는 되겠습니다.",
      matchedTerms: glossary,
      speakerProfile: honorificProfile,
      dialogueType: "speech"
    });

    expect(report.passed).toBe(true);
    expect(report.score).toBe(100);
    expect(report.issues).toHaveLength(0);
  });

  it("flags empty or un-translated identical source text", () => {
    const reportEmpty = inspectTranslationQuality({
      sourceText: "こんにちは",
      translatedText: ""
    });
    expect(reportEmpty.passed).toBe(false);
    expect(reportEmpty.issues[0]?.type).toBe("EMPTY_OR_WHITESPACE");

    const reportUnchanged = inspectTranslationQuality({
      sourceText: "海賊王に俺はなる！",
      translatedText: "海賊王に俺はなる！"
    });
    expect(reportUnchanged.passed).toBe(false);
    expect(reportUnchanged.issues[0]?.type).toBe("EMPTY_OR_WHITESPACE");
  });

  it("flags residual Japanese Kana in translated text", () => {
    const report = inspectTranslationQuality({
      sourceText: "ちょっと、ルフィ！",
      translatedText: "잠깐, ルフィ！"
    });

    expect(report.issues.some((i) => i.type === "UNTRANSLATED_ARTIFACT")).toBe(true);
  });

  it("flags missing glossary terms", () => {
    const report = inspectTranslationQuality({
      sourceText: "ゴムゴムの実を食べたの？",
      translatedText: "이상한 열매를 먹은 거야?",
      matchedTerms: glossary
    });

    const glossaryIssue = report.issues.find((i) => i.type === "GLOSSARY_MISMATCH");
    expect(glossaryIssue).toBeDefined();
    expect(glossaryIssue?.message).toContain("고무고무 열매");
  });

  it("warns about speech style inconsistency (honorific expected but banmal used)", () => {
    const report = inspectTranslationQuality({
      sourceText: "私がやります。",
      translatedText: "내가 할 거다.",
      speakerProfile: honorificProfile,
      dialogueType: "speech"
    });

    const styleIssue = report.issues.find((i) => i.type === "SPEECH_STYLE_MISMATCH");
    expect(styleIssue).toBeDefined();
    expect(styleIssue?.message).toContain("존댓말/경어");
  });

  it("flags mismatched Japanese quotes", () => {
    const report = inspectTranslationQuality({
      sourceText: "「こんにちは」",
      translatedText: "「안녕하세요"
    });

    expect(report.issues.some((i) => i.type === "BRACKET_MISMATCH")).toBe(true);
  });
});
