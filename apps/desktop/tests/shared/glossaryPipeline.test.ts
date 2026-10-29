import { describe, expect, it } from "vitest";
import {
  exportGlossaryFile,
  isGlossaryCategory,
  mergeApprovedCharactersToProfiles,
  mergeApprovedTermsToDictionary,
  parseGlossaryFile,
  reconcileGlossaryTerms,
  type CharacterCandidate,
  type GlossaryTermCandidate
} from "../../src/shared/glossaryPipeline.js";
import type { CharacterProfile, DictionaryTerm } from "../../src/shared/projectTypes.js";

describe("glossaryPipeline", () => {
  it("validates glossary categories correctly", () => {
    expect(isGlossaryCategory("character")).toBe(true);
    expect(isGlossaryCategory("skill")).toBe(true);
    expect(isGlossaryCategory("location")).toBe(true);
    expect(isGlossaryCategory("tone")).toBe(true);
    expect(isGlossaryCategory("general")).toBe(true);
    expect(isGlossaryCategory("invalid")).toBe(false);
    expect(isGlossaryCategory(null)).toBe(false);
  });

  it("merges approved glossary terms into existing dictionary terms without duplicates", () => {
    const existingTerms: DictionaryTerm[] = [
      { id: "t1", source: "月華一閃", target: "월화일섬", note: "기존 용어" }
    ];

    const candidates: GlossaryTermCandidate[] = [
      {
        id: "c1",
        source: "月華一閃",
        suggestedTarget: "월화일섬 (개정)",
        category: "skill",
        occurrenceCount: 5,
        contextSamples: ["月華一閃を受けろ！"],
        confidence: 0.95,
        status: "approved",
        notes: "새로운 번역어"
      },
      {
        id: "c2",
        source: "黒妖の森",
        suggestedTarget: "흑요의 숲",
        category: "location",
        occurrenceCount: 3,
        contextSamples: ["黒妖の森へ向かう"],
        confidence: 0.9,
        status: "approved"
      },
      {
        id: "c3",
        source: "〜じゃのう",
        suggestedTarget: "~인 게지",
        category: "tone",
        occurrenceCount: 10,
        contextSamples: ["そうじゃのう"],
        confidence: 0.85,
        status: "proposed" // Not approved yet!
      }
    ];

    const result = mergeApprovedTermsToDictionary(existingTerms, candidates);

    expect(result).toHaveLength(2);
    // Updated existing term
    expect(result[0]).toEqual({
      id: "c1",
      source: "月華一閃",
      target: "월화일섬 (개정)",
      note: "새로운 번역어",
      category: "skill"
    });
    // Added new term
    expect(result[1]).toEqual({
      id: "c2",
      source: "黒妖の森",
      target: "흑요의 숲",
      category: "location"
    });
  });

  it("merges approved character candidates into profiles correctly", () => {
    const existingProfiles: CharacterProfile[] = [
      {
        id: "p1",
        name: "세실",
        aliases: ["セシル"],
        description: "주인공",
        speechStyle: "거친 반말"
      }
    ];

    const candidates: CharacterCandidate[] = [
      {
        id: "c1",
        nameJa: "セシル・ヴァレンタイン",
        nameKo: "세실",
        role: "흑기사",
        tone: "호전적인 반말",
        gender: "남성",
        confidence: 0.98,
        status: "approved",
        aliases: ["セシル", "발렌타인"],
        description: "흑기사 세실"
      },
      {
        id: "c2",
        nameJa: "夜刀 神無",
        nameKo: "야토 칸나",
        role: "퇴마사",
        tone: "고풍스러운 말투",
        gender: "여성",
        confidence: 0.92,
        status: "approved",
        aliases: ["神無"],
        description: "신사 퇴마사"
      },
      {
        id: "c3",
        nameJa: "通行人A",
        nameKo: "행인 A",
        role: "엑스트라",
        tone: "평범",
        gender: "기타",
        confidence: 0.5,
        status: "rejected",
        aliases: []
      }
    ];

    const result = mergeApprovedCharactersToProfiles(existingProfiles, candidates);

    expect(result).toHaveLength(2);
    // Updated existing profile aliases and description
    expect(result[0]!.name).toBe("세실");
    expect(result[0]!.aliases).toContain("セシル・ヴァレンタイン");
    expect(result[0]!.aliases).toContain("발렌타인");
    expect(result[0]!.description).toBe("흑기사 세실");

    // Added new profile
    expect(result[1]!.name).toBe("야토 칸나");
    expect(result[1]!.aliases).toContain("夜刀 神無");
    expect(result[1]!.speechStyle).toBe("고풍스러운 말투");
  });

  it("parses TSV, TXT, and JSON glossary formats correctly", () => {
    const tsvContent = "先輩\t선배\t존칭\n月華一閃\t월화일섬";
    const tsvTerms = parseGlossaryFile(tsvContent, "tsv");
    expect(tsvTerms).toHaveLength(2);
    expect(tsvTerms[0]).toMatchObject({ source: "先輩", target: "선배", note: "존칭" });
    expect(tsvTerms[1]).toMatchObject({ source: "月華一閃", target: "월화일섬" });

    const txtContent = "先輩 -> 선배 // 존칭\n黒妖の森 => 흑요의 숲\n魔法 = 마법";
    const txtTerms = parseGlossaryFile(txtContent, "txt");
    expect(txtTerms).toHaveLength(3);
    expect(txtTerms[0]).toMatchObject({ source: "先輩", target: "선배", note: "존칭" });
    expect(txtTerms[1]).toMatchObject({ source: "黒妖の森", target: "흑요의 숲" });
    expect(txtTerms[2]).toMatchObject({ source: "魔法", target: "마법" });

    const jsonContent = JSON.stringify([
      { source: "先輩", target: "선배", note: "존칭" },
      { source: "黒妖の森", target: "흑요의 숲" }
    ]);
    const jsonTerms = parseGlossaryFile(jsonContent, "json");
    expect(jsonTerms).toHaveLength(2);
    expect(jsonTerms[0]).toMatchObject({ source: "先輩", target: "선배" });
  });

  it("exports dictionary terms to TSV, TXT, and JSON correctly", () => {
    const terms: DictionaryTerm[] = [
      { id: "t1", source: "先輩", target: "선배", note: "존칭" },
      { id: "t2", source: "月華一閃", target: "월화일섬" }
    ];

    const tsvExport = exportGlossaryFile(terms, "tsv");
    expect(tsvExport).toContain("先輩\t선배\t존칭");
    expect(tsvExport).toContain("月華一閃\t월화일섬");

    const txtExport = exportGlossaryFile(terms, "txt");
    expect(txtExport).toContain("先輩 -> 선배 // 존칭");
    expect(txtExport).toContain("月華一閃 -> 월화일섬");

    const jsonExport = exportGlossaryFile(terms, "json");
    const parsedJson = JSON.parse(jsonExport);
    expect(parsedJson).toHaveLength(2);
    expect(parsedJson[0]).toEqual({ source: "先輩", target: "선배", note: "존칭" });
  });

  it("reconciles glossary terms and reports missing target terms", () => {
    const terms: DictionaryTerm[] = [
      { id: "t1", source: "月華一閃", target: "월화일섬" },
      { id: "t2", source: "黒妖の森", target: "흑요의 숲" }
    ];

    const source = "月華一閃を受けろ！";
    const goodTranslation = "월화일섬을 받아라!";
    const result1 = reconcileGlossaryTerms(source, goodTranslation, terms);
    expect(result1.replacements).toHaveLength(0);

    const badTranslation = "달빛 베기를 받아라!";
    const result2 = reconcileGlossaryTerms(source, badTranslation, terms);
    expect(result2.replacements).toEqual([
      { source: "月華一閃", target: "월화일섬" }
    ]);
  });
});
