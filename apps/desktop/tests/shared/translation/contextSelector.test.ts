import { describe, expect, it } from "vitest";
import type { DialogueLine } from "../../../src/shared/projectTypes";
import { selectRelevantDialogueContext } from "../../../src/shared/translation/contextSelector";

const mockDialogue: DialogueLine[] = [
  {
    id: "l1",
    order: 1,
    pageNumber: 1,
    speaker: "루피",
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "肉はどこだ！？",
    userTranslation: "고기는 어디 있어!?",
    parseConfidence: 0.9,
    parseWarnings: []
  },
  {
    id: "l2",
    order: 2,
    pageNumber: 1,
    speaker: "상디",
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "待ってろ、今作ってやる。",
    userTranslation: "기다려, 지금 만들어 줄 테니까.",
    parseConfidence: 0.9,
    parseWarnings: []
  },
  {
    id: "l3",
    order: 3,
    pageNumber: 1,
    speaker: "루피",
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "早くしてくれ〜！",
    parseConfidence: 0.9,
    parseWarnings: []
  },
  {
    id: "l4",
    order: 4,
    pageNumber: 1,
    speaker: "나미",
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "ちょっと静かにしなさい！",
    userTranslation: "좀 조용히 해!",
    parseConfidence: 0.9,
    parseWarnings: []
  }
];

describe("contextSelector", () => {
  it("selects bidirectional context with previous turns and lookahead next turns", () => {
    const context = selectRelevantDialogueContext(mockDialogue, "l3", {
      maxPreviousTurns: 2,
      maxNextTurns: 1
    });

    expect(context.previousTurns).toHaveLength(2);
    expect(context.previousTurns[0]?.lineId).toBe("l1");
    expect(context.previousTurns[1]?.lineId).toBe("l2");

    expect(context.nextTurns).toHaveLength(1);
    expect(context.nextTurns[0]?.lineId).toBe("l4");
    expect(context.nextTurns[0]?.sourceText).toBe("ちょっと静かにしなさい！");
  });

  it("prioritizes conversational turn-taking interlocutors within token budget", () => {
    const context = selectRelevantDialogueContext(mockDialogue, "l2", {
      tokenBudget: 30
    });

    // Should include previous turn (l1 - speaker 루피 interacting with 상디)
    expect(context.previousTurns.length).toBeGreaterThan(0);
    expect(context.previousTurns[0]?.speaker).toBe("루피");
  });
});
