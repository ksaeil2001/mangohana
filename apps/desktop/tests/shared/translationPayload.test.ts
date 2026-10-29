import { describe, expect, it } from "vitest";
import type { CharacterProfile, DialogueLine, DictionaryTerm } from "../../src/shared/projectTypes";
import {
  buildTranslationContextPayload,
  computeTranslationContextFingerprint,
  computeTranslationPayloadFingerprint
} from "../../src/shared/translationContext";

describe("translation payload fingerprint", () => {
  it("uses the same stable fingerprint for a built Provider payload", () => {
    const lines = [dialogueLine("target", 1, "対象の台詞")];
    const payload = buildTranslationContextPayload({ dialogueLines: lines, targetLineId: "target" });

    expect(computeTranslationPayloadFingerprint(payload)).toBe(
      computeTranslationContextFingerprint({ dialogueLines: lines, targetLineId: "target" })
    );
  });

  it("changes when previous or next dialogue context sent to the provider changes", () => {
    const lines = [
      dialogueLine("previous", 1, "前の台詞", { userTranslation: "이전 번역" }),
      dialogueLine("target", 2, "対象の台詞"),
      dialogueLine("next", 3, "次の台詞", { userTranslation: "다음 번역" })
    ];
    const baseline = fingerprint(lines);

    const previousChanged = lines.map((line) =>
      line.id === "previous" ? { ...line, sourceText: "変更された前の台詞" } : line
    );
    const nextChanged = lines.map((line) =>
      line.id === "next" ? { ...line, userTranslation: "변경된 다음 번역" } : line
    );

    expect(fingerprint(previousChanged)).not.toBe(baseline);
    expect(fingerprint(nextChanged)).not.toBe(baseline);
  });

  it("changes when matched glossary, fuzzy TM, speaker profile, or style payload changes", () => {
    const target = dialogueLine("target", 2, "先輩、ありがとう", { speaker: "Hero" });
    const tmCandidate = dialogueLine("tm", 1, "先輩、ありがとう", {
      userTranslation: "선배, 고마워"
    });
    const glossary: DictionaryTerm[] = [{ id: "term", source: "先輩", target: "선배" }];
    const character: CharacterProfile = {
      id: "hero",
      name: "Hero",
      aliases: [],
      speechStyle: "정중한 말투"
    };
    const baseArgs = {
      dialogueLines: [tmCandidate, target],
      targetLineId: target.id,
      dictionaryTerms: glossary,
      characters: [character],
      stylePreset: "honorific",
      maxPreviousTurns: 0,
      maxNextTurns: 0
    } as const;
    const baseline = computeTranslationContextFingerprint(baseArgs);

    expect(computeTranslationContextFingerprint({
      ...baseArgs,
      dictionaryTerms: [{ ...glossary[0]!, target: "선배님" }]
    })).not.toBe(baseline);
    expect(computeTranslationContextFingerprint({
      ...baseArgs,
      dialogueLines: [{ ...tmCandidate, userTranslation: "선배님, 감사합니다" }, target]
    })).not.toBe(baseline);
    expect(computeTranslationContextFingerprint({
      ...baseArgs,
      characters: [{ ...character, speechStyle: "거친 반말" }]
    })).not.toBe(baseline);
    expect(computeTranslationContextFingerprint({
      ...baseArgs,
      stylePreset: "informal"
    })).not.toBe(baseline);
  });

  it("is stable when an equivalent speaker profile uses a different property insertion order", () => {
    const target = dialogueLine("target", 1, "対象", { speaker: "Hero" });
    const first: CharacterProfile = {
      id: "hero",
      name: "Hero",
      aliases: ["H"],
      speechStyle: "차분함",
      description: "주인공"
    };
    const second: CharacterProfile = {
      description: "주인공",
      speechStyle: "차분함",
      aliases: ["H"],
      name: "Hero",
      id: "hero"
    };

    const firstFingerprint = computeTranslationContextFingerprint({
      dialogueLines: [target],
      targetLineId: target.id,
      characters: [first]
    });
    const secondFingerprint = computeTranslationContextFingerprint({
      dialogueLines: [target],
      targetLineId: target.id,
      characters: [second]
    });

    expect(secondFingerprint).toBe(firstFingerprint);
  });

  it("returns an empty fingerprint when the target line does not exist", () => {
    expect(computeTranslationContextFingerprint({
      dialogueLines: [],
      targetLineId: "missing"
    })).toBe("");
  });
});

function fingerprint(dialogueLines: DialogueLine[]): string {
  return computeTranslationContextFingerprint({
    dialogueLines,
    targetLineId: "target"
  });
}

function dialogueLine(
  id: string,
  order: number,
  sourceText: string,
  overrides: Partial<DialogueLine> = {}
): DialogueLine {
  return {
    id,
    order,
    pageNumber: 1,
    sourceLanguage: "ja",
    sourceText,
    dialogueType: "speech",
    lineStatus: "draft",
    parseConfidence: 1,
    parseWarnings: [],
    ...overrides
  };
}
