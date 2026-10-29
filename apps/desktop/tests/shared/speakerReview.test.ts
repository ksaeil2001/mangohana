import { describe, expect, it } from "vitest";
import { buildSpeakerReviewProposals } from "../../src/shared/speakerReview";

describe("speaker review proposals", () => {
  it("connects candidates to panel reading order and Character Bank without selecting a speaker", () => {
    const proposals = buildSpeakerReviewProposals({
      panels: [
        { id: "panel-left", panelIndex: 1, bbox: { x: 0, y: 0, width: 0.5, height: 1 } },
        { id: "panel-right", panelIndex: 2, bbox: { x: 0.5, y: 0, width: 0.5, height: 1 } }
      ],
      characters: [{ id: "char-yuna", name: "유나", aliases: ["Yuna"] }],
      bubbles: [
        {
          id: "bubble-left",
          type: "speech_bubble",
          text: "왼쪽",
          language: "ko",
          bbox: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 },
          readingOrder: 2,
          confidence: 0.9,
          notes: "",
          speakerCandidates: [{ speaker: "unknown", confidence: 0.4, reason: "꼬리 없음" }]
        },
        {
          id: "bubble-right",
          type: "speech_bubble",
          text: "오른쪽",
          language: "ko",
          bbox: { x: 0.7, y: 0.2, width: 0.2, height: 0.1 },
          readingOrder: 1,
          confidence: 0.9,
          notes: "",
          speakerCandidates: [{ speaker: "Yuna", confidence: 0.92, reason: "얼굴과 꼬리 일치" }]
        }
      ]
    });

    expect(proposals.map((proposal) => proposal.bubbleId)).toEqual(["bubble-right", "bubble-left"]);
    expect(proposals[0]).toMatchObject({
      panelIndex: 2,
      associationStatus: "ready_for_user_selection",
      characterMatches: [{ match: { matchedProfile: { id: "char-yuna" }, matchType: "exact_alias" } }]
    });
    expect(proposals[1]?.associationStatus).toBe("needs_review");
    expect(proposals.every((proposal) => !Object.hasOwn(proposal, "selectedSpeaker"))).toBe(true);
  });

  it("keeps collision relations in needs_review even with a high-confidence candidate", () => {
    const [proposal] = buildSpeakerReviewProposals({
      relations: { "bubble-1": "collision" },
      bubbles: [{
        id: "bubble-1",
        type: "speech_bubble",
        text: "text",
        language: "en",
        bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        readingOrder: 1,
        confidence: 1,
        notes: "",
        speakerCandidates: [{ speaker: "A", confidence: 0.99, reason: "tail" }]
      }]
    });
    expect(proposal?.associationStatus).toBe("needs_review");
    expect(proposal?.relation).toBe("collision");
  });
});
