import { describe, expect, it } from "vitest";
import type { ConditionalDictionaryTerm } from "../../../src/shared/translation/trieMatcher";
import { createTrieMatcher } from "../../../src/shared/translation/trieMatcher";

describe("trieMatcher", () => {
  const terms: ConditionalDictionaryTerm[] = [
    { id: "1", source: "先輩", target: "선배" }, // default
    {
      id: "2",
      source: "先輩",
      target: "선배님",
      condition: { speaker: "후배A" },
      priority: 20
    },
    {
      id: "3",
      source: "先輩",
      target: "형",
      condition: { speaker: "남동생" },
      priority: 20
    },
    {
      id: "4",
      source: "お前",
      target: "당신",
      condition: { dialogueType: "thought" },
      priority: 15
    },
    {
      id: "5",
      source: "月華一閃",
      target: "월화일섬"
    }
  ];

  it("matches unconditional default term when no specific context matches", () => {
    const trie = createTrieMatcher(terms);
    const matches = trie.findMatches("先輩、おはようございます！", { speaker: "일반인" });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.target).toBe("선배");
  });

  it("applies speaker-conditional term with higher priority", () => {
    const trie = createTrieMatcher(terms);
    const matchesA = trie.findMatches("先輩、おはようございます！", { speaker: "후배A" });
    expect(matchesA).toHaveLength(1);
    expect(matchesA[0]?.target).toBe("선배님");

    const matchesBrother = trie.findMatches("先輩、飯食おうぜ", { speaker: "남동생" });
    expect(matchesBrother).toHaveLength(1);
    expect(matchesBrother[0]?.target).toBe("형");
  });

  it("applies dialogueType-conditional term", () => {
    const trie = createTrieMatcher(terms);
    const matchesSpeech = trie.findMatches("お前は何者だ？", { dialogueType: "speech" });
    // "お前" without condition doesn't exist, only thought condition exists
    expect(matchesSpeech).toHaveLength(0);

    const matchesThought = trie.findMatches("お前は何者だ？", { dialogueType: "thought" });
    expect(matchesThought).toHaveLength(1);
    expect(matchesThought[0]?.target).toBe("당신");
  });

  it("matches multiple terms in a single scan", () => {
    const trie = createTrieMatcher(terms);
    const text = "先輩！月華一閃を使え！";
    const matches = trie.findMatches(text, { speaker: "후배A" });

    expect(matches).toHaveLength(2);
    const targets = matches.map((m) => m.target);
    expect(targets).toContain("선배님");
    expect(targets).toContain("월화일섬");
  });
});
