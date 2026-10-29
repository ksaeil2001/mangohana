import { fetchWithGeminiRetry } from "./geminiTransientRetry.js";
import type {
  CharacterCandidate,
  GlossaryExtractionResult,
  GlossaryTermCandidate
} from "../shared/glossaryPipeline.js";
import type { CharacterProfile, DictionaryTerm, DialogueLine } from "../shared/projectTypes.js";

export type ExtractGlossaryOptions = {
  dialogueLines: readonly DialogueLine[];
  existingCharacters?: readonly CharacterProfile[];
  existingTerms?: readonly DictionaryTerm[];
  apiKey?: string;
  model?: string;
};

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const JAPANESE_STOPWORDS = new Set([
  "これ", "それ", "あれ", "この", "その", "あの", "ここ", "そこ", "あそこ",
  "私", "僕", "俺", "自分", "あなた", "あんた", "お前",
  "する", "いる", "ある", "なる", "いう", "思う", "見る",
  "から", "まで", "より", "ほど", "など", "って", "でも", "けど", "なら",
  "こと", "もの", "ため", "よう", "そう", "どう"
]);

/**
 * 프로젝트 내 대사 코퍼스를 분석하여 고빈도 용어, 인명, 기술명, 어투 패턴을 추출합니다.
 */
export async function extractGlossaryFromCorpus(
  options: ExtractGlossaryOptions
): Promise<GlossaryExtractionResult> {
  const { dialogueLines, existingCharacters = [], existingTerms = [], apiKey, model } = options;

  if (dialogueLines.length === 0) {
    return {
      terms: [],
      characters: [],
      corpusStats: {
        totalDialogueLines: 0,
        totalCharactersAnalyzed: 0,
        uniqueCandidatesFound: 0
      }
    };
  }

  const effectiveApiKey = apiKey || process.env.GEMINI_API_KEY;

  if (effectiveApiKey) {
    try {
      return await extractGlossaryWithGemini({
        dialogueLines,
        existingCharacters,
        existingTerms,
        apiKey: effectiveApiKey,
        model: model || process.env.GEMINI_TEXT_MODEL || DEFAULT_GEMINI_MODEL
      });
    } catch (error) {
      console.warn("Gemini 용어집 추출 실패, 로컬 규칙 기반 추출로 폴백합니다:", error);
    }
  }

  return extractGlossaryWithRuleBasedFallback({
    dialogueLines,
    existingCharacters,
    existingTerms
  });
}

/**
 * Gemini LLM을 통한 구조화된 용어집 및 캐릭터 추출
 */
async function extractGlossaryWithGemini(args: {
  dialogueLines: readonly DialogueLine[];
  existingCharacters: readonly CharacterProfile[];
  existingTerms: readonly DictionaryTerm[];
  apiKey: string;
  model: string;
}): Promise<GlossaryExtractionResult> {
  const corpusSample = args.dialogueLines
    .slice(0, 150)
    .map((l) => `[p.${l.pageNumber} ${l.speaker ? `(${l.speaker})` : ""}] ${l.sourceText}`)
    .join("\n");

  const existingTermSources = args.existingTerms.map((t) => t.source).join(", ");
  const existingCharNames = args.existingCharacters.map((c) => `${c.name}(${c.aliases.join("/")})`).join(", ");

  const prompt = [
    "당신은 일본어 만화/웹툰의 대사 코퍼스를 분석하여 작품의 공식 용어집(Glossary)과 캐릭터 프로필을 구축하는 번역 디렉터입니다.",
    "아래 제공된 만화 대사 목록을 정밀 분석하여 다음을 추출하십시오:",
    "1. 주요 고유명사 (terms): 기술명(skill), 지명(location), 특수 어투/어미(tone), 일반 고유명사(general)",
    "2. 주요 등장인물 (characters): 원문 이름, 한국어 표준 표기, 역할, 말투 특징(반말/존댓말/특수 어조), 성별",
    "",
    `[기존 등록된 용어]: ${existingTermSources || "없음"}`,
    `[기존 등록된 캐릭터]: ${existingCharNames || "없음"}`,
    "",
    "[대사 코퍼스 샘플]",
    corpusSample,
    "",
    "출력 규칙: 반드시 아래 JSON 스키마 형식으로만 응답하십시오 (마크다운 코드블록 제외, 순수 JSON):",
    JSON.stringify(
      {
        terms: [
          {
            source: "원문 단어",
            suggestedTarget: "한국어 권장 번역어",
            category: "skill | location | tone | general",
            occurrenceCount: 1,
            contextSamples: ["예문 대사"],
            confidence: 0.9,
            notes: "용어 설명"
          }
        ],
        characters: [
          {
            nameJa: "원문 인명",
            nameKo: "한국어 표준명",
            role: "주인공 / 흑기사 등",
            tone: "호전적인 반말, 거친 어조",
            gender: "남성 | 여성 | 기타",
            confidence: 0.95,
            aliases: ["별칭"],
            description: "인물 설명"
          }
        ]
      },
      null,
      2
    )
  ].join("\n");

  const url = `${GEMINI_API_URL}/${args.model}:generateContent?key=${args.apiKey}`;
  const response = await fetchWithGeminiRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    },
    { maxAttempts: 3 }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Gemini 용어집 추출 요청 실패 (HTTP ${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "{}";
  const parsed = safeParseJsonObject(rawText) as {
    terms?: Array<{
      source?: string;
      suggestedTarget?: string;
      category?: string;
      occurrenceCount?: number;
      contextSamples?: string[];
      confidence?: number;
      notes?: string;
    }>;
    characters?: Array<{
      nameJa?: string;
      nameKo?: string;
      role?: string;
      tone?: string;
      gender?: string;
      confidence?: number;
      aliases?: string[];
      description?: string;
    }>;
  };

  const terms: GlossaryTermCandidate[] = (parsed.terms || [])
    .filter((t) => t.source && t.source.trim())
    .map((t, idx) => ({
      id: `term-cand-${Date.now()}-${idx}`,
      source: t.source!.trim(),
      suggestedTarget: (t.suggestedTarget || t.source)!.trim(),
      category: normalizeCategory(t.category),
      occurrenceCount: t.occurrenceCount || countOccurrences(t.source!, args.dialogueLines),
      contextSamples: t.contextSamples || findContextSamples(t.source!, args.dialogueLines),
      confidence: Math.min(1.0, Math.max(0.1, t.confidence || 0.85)),
      status: "proposed",
      notes: t.notes
    }));

  const characters: CharacterCandidate[] = (parsed.characters || [])
    .filter((c) => (c.nameJa && c.nameJa.trim()) || (c.nameKo && c.nameKo.trim()))
    .map((c, idx) => ({
      id: `char-cand-${Date.now()}-${idx}`,
      nameJa: (c.nameJa || "").trim(),
      nameKo: (c.nameKo || c.nameJa || "").trim(),
      role: (c.role || "주요 인물").trim(),
      tone: (c.tone || "자연스러운 어조").trim(),
      gender: c.gender === "여성" ? "여성" : c.gender === "남성" ? "남성" : "기타",
      confidence: Math.min(1.0, Math.max(0.1, c.confidence || 0.9)),
      status: "proposed",
      aliases: (c.aliases || []).filter(Boolean),
      description: c.description
    }));

  const totalChars = args.dialogueLines.reduce((acc, l) => acc + (l.sourceText?.length || 0), 0);

  return {
    terms,
    characters,
    corpusStats: {
      totalDialogueLines: args.dialogueLines.length,
      totalCharactersAnalyzed: totalChars,
      uniqueCandidatesFound: terms.length + characters.length
    }
  };
}

/**
 * 오프라인/로컬 규칙 기반 추출 폴백 (빈도수, 화자 이름, 괄호/특수 패턴 분석)
 */
function extractGlossaryWithRuleBasedFallback(args: {
  dialogueLines: readonly DialogueLine[];
  existingCharacters: readonly CharacterProfile[];
  existingTerms: readonly DictionaryTerm[];
}): GlossaryExtractionResult {
  const { dialogueLines } = args;
  const terms: GlossaryTermCandidate[] = [];
  const characters: CharacterCandidate[] = [];

  // 1. 화자(Speaker) 태그 기반 캐릭터 후보 추출
  const speakerCounts = new Map<string, number>();
  for (const line of dialogueLines) {
    if (line.speaker && line.speaker.trim()) {
      const spk = line.speaker.trim();
      speakerCounts.set(spk, (speakerCounts.get(spk) || 0) + 1);
    }
  }

  let charIdx = 0;
  for (const [speaker, count] of speakerCounts.entries()) {
    if (count >= 2) {
      characters.push({
        id: `char-cand-rule-${charIdx++}`,
        nameJa: speaker,
        nameKo: speaker,
        role: count > 10 ? "주인공 / 주연" : "조연",
        tone: "자연스러운 어투",
        gender: "기타",
        confidence: Math.min(0.95, 0.6 + count * 0.05),
        status: "proposed",
        aliases: [],
        description: `등장 횟수 ${count}회`
      });
    }
  }

  // 2. 특수 괄호, 강조 기호, 어미 패턴 추출 (예: 『기술명』, 「고유명사」, ~じゃのう, ~っす)
  const patternRegex = /[『「【]([^』」】]+)[』」】]/g;
  const bracketCounts = new Map<string, { count: number; sample: string }>();

  for (const line of dialogueLines) {
    const text = line.sourceText || "";
    let match: RegExpExecArray | null;
    while ((match = patternRegex.exec(text)) !== null) {
      const term = match[1]?.trim();
      if (term && term.length >= 2 && !JAPANESE_STOPWORDS.has(term)) {
        const entry = bracketCounts.get(term) || { count: 0, sample: text };
        entry.count += 1;
        bracketCounts.set(term, entry);
      }
    }
  }

  let termIdx = 0;
  for (const [term, data] of bracketCounts.entries()) {
    terms.push({
      id: `term-cand-rule-${termIdx++}`,
      source: term,
      suggestedTarget: term,
      category: term.includes("の") || term.length > 4 ? "skill" : "general",
      occurrenceCount: data.count,
      contextSamples: [data.sample],
      confidence: 0.8,
      status: "proposed",
      notes: "강조 괄호 내 빈출 고유명사"
    });
  }

  // 3. 특수 어미/말버릇 패턴 감지 (예: 〜じゃのう, 〜っす, 〜でござる)
  const tonePatterns = [
    { pattern: /(じゃのう|じゃな|のう)[。！？!?…~～\s]*$/, name: "〜じゃのう", target: "~구먼 / ~인 게지", note: "노인/고풍 어투" },
    { pattern: /(っす|す)[。！？!?…~～\s]*$/, name: "〜っす", target: "~임다 / ~여요", note: "체육계/후배 어투" },
    { pattern: /(ござる|でござる)[。！？!?…~～\s]*$/, name: "〜でござる", target: "~이오 / ~이옵니다", note: "무사/사무라이 어투" }
  ];

  for (const tp of tonePatterns) {
    const matchingLines = dialogueLines.filter((l) => tp.pattern.test(l.sourceText.trim()));
    if (matchingLines.length >= 2) {
      terms.push({
        id: `term-cand-tone-${termIdx++}`,
        source: tp.name,
        suggestedTarget: tp.target,
        category: "tone",
        occurrenceCount: matchingLines.length,
        contextSamples: matchingLines.slice(0, 2).map((l) => l.sourceText),
        confidence: 0.85,
        status: "proposed",
        notes: tp.note
      });
    }
  }

  const totalChars = dialogueLines.reduce((acc, l) => acc + (l.sourceText?.length || 0), 0);

  return {
    terms,
    characters,
    corpusStats: {
      totalDialogueLines: dialogueLines.length,
      totalCharactersAnalyzed: totalChars,
      uniqueCandidatesFound: terms.length + characters.length
    }
  };
}

function normalizeCategory(cat?: string): GlossaryTermCandidate["category"] {
  if (cat === "skill" || cat === "location" || cat === "tone" || cat === "character" || cat === "general") {
    return cat;
  }
  return "general";
}

function countOccurrences(target: string, lines: readonly DialogueLine[]): number {
  if (!target) return 0;
  return lines.filter((l) => l.sourceText.includes(target)).length;
}

function findContextSamples(target: string, lines: readonly DialogueLine[]): string[] {
  if (!target) return [];
  return lines
    .filter((l) => l.sourceText.includes(target))
    .slice(0, 3)
    .map((l) => l.sourceText);
}

export function safeParseJsonObject(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Attempt to locate outermost { and }
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch {
        // parsing failed
      }
    }
    return {};
  }
}
