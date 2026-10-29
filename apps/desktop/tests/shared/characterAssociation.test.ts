import { describe, expect, it } from "vitest";
import {
  calculateSpeakerAssociationMetrics,
  formatCharacterBankContext,
  matchCharacterFromBank,
  type SpeakerAssociationBenchmarkItem
} from "../../src/shared/characterBank/characterAssociation.js";
import type { CharacterProfile } from "../../src/shared/projectTypes.js";

describe("characterAssociation (Magi & Manga109Dialog principles)", () => {
  const mockBank: CharacterProfile[] = [
    {
      id: "char-1",
      name: "미카 (Mika)",
      aliases: ["미카", "Mika", "미카쨩"],
      description: "단발머리 여학생",
      speechStyle: "발랄한 존댓말",
      relationshipNotes: "렌의 소꿉친구"
    },
    {
      id: "char-2",
      name: "렌 (Ren)",
      aliases: ["렌", "Ren"],
      description: "과묵한 남학생",
      speechStyle: "무뚝뚝한 반말"
    }
  ];

  it("matches character from Character Bank by exact name", () => {
    const result = matchCharacterFromBank("미카 (Mika)", mockBank);
    expect(result.matchType).toBe("exact_name");
    expect(result.matchedProfile?.id).toBe("char-1");
    expect(result.confidenceBoost).toBe(0.2);
  });

  it("matches character from Character Bank by alias", () => {
    const result = matchCharacterFromBank("미카쨩", mockBank);
    expect(result.matchType).toBe("exact_alias");
    expect(result.matchedProfile?.id).toBe("char-1");
  });

  it("matches character by fuzzy/substring match", () => {
    const result = matchCharacterFromBank("미카", mockBank);
    // Even if query is "미카", it matches either alias or fuzzy substring
    expect(["exact_alias", "fuzzy_name"]).toContain(result.matchType);
    expect(result.matchedProfile?.id).toBe("char-1");
  });

  it("returns none when character is not in bank", () => {
    const result = matchCharacterFromBank("알 수 없는 행인", mockBank);
    expect(result.matchType).toBe("none");
    expect(result.matchedProfile).toBeUndefined();
    expect(result.confidenceBoost).toBe(0);
  });

  it("formats Character Bank context for prompt injection", () => {
    const formatted = formatCharacterBankContext(mockBank);
    expect(formatted).toContain("미카 (Mika)");
    expect(formatted).toContain("단발머리 여학생");
    expect(formatted).toContain("발랄한 존댓말");
    expect(formatted).toContain("렌 (Ren)");
  });

  it("calculates Manga109Dialog speaker-to-text association metrics", () => {
    const items: SpeakerAssociationBenchmarkItem[] = [
      {
        lineId: "line-1",
        groundTruthSpeaker: "Mika",
        predictedCandidates: [
          { speaker: "Mika", confidence: 0.9, reason: "tail pointing left" },
          { speaker: "Ren", confidence: 0.1, reason: "nearby" }
        ],
        isSpeech: true,
        panelIndex: 1
      },
      {
        lineId: "line-2",
        groundTruthSpeaker: "Ren",
        predictedCandidates: [
          { speaker: "Mika", confidence: 0.6, reason: "dominant character" },
          { speaker: "Ren", confidence: 0.3, reason: "speech style" }
        ],
        isSpeech: true,
        panelIndex: 1
      },
      {
        lineId: "line-3",
        groundTruthSpeaker: "Teacher",
        predictedCandidates: [
          { speaker: "unknown", confidence: 0.3, reason: "tail unclear" }
        ],
        isSpeech: true,
        panelIndex: 2
      }
    ];

    const metrics = calculateSpeakerAssociationMetrics(items);

    expect(metrics.totalLines).toBe(3);
    expect(metrics.speechLinesCount).toBe(3);
    expect(metrics.top1Accuracy).toBeCloseTo(1 / 3, 3); // line-1 is Top-1 correct
    expect(metrics.top3Recall).toBeCloseTo(2 / 3, 3);   // line-1 and line-2 have GT in Top-3
    expect(metrics.unknownRate).toBeCloseTo(1 / 3, 3);  // line-3 is unknown
    expect(metrics.intraPanelAssociationCount).toBe(3);
  });
});
