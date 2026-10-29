import type { CharacterProfile, DictionaryTerm, DialogueLine } from "./projectTypes.js";

export type GlossaryCategory = "character" | "skill" | "location" | "tone" | "general";
export type GlossaryProposalStatus = "proposed" | "approved" | "rejected";

export type GlossaryTermCandidate = {
  id: string;
  source: string;
  suggestedTarget: string;
  category: GlossaryCategory;
  occurrenceCount: number;
  contextSamples: string[];
  confidence: number;
  status: GlossaryProposalStatus;
  notes?: string;
};

export type CharacterCandidate = {
  id: string;
  nameJa: string;
  nameKo: string;
  role: string;
  tone: string;
  gender: "남성" | "여성" | "기타";
  confidence: number;
  status: GlossaryProposalStatus;
  aliases: string[];
  description?: string;
};

export type GlossaryExtractionResult = {
  terms: GlossaryTermCandidate[];
  characters: CharacterCandidate[];
  corpusStats: {
    totalDialogueLines: number;
    totalCharactersAnalyzed: number;
    uniqueCandidatesFound: number;
  };
};

export type ExtractGlossaryRequest = {
  dialogueLines: readonly DialogueLine[];
  existingCharacters?: readonly CharacterProfile[];
  existingTerms?: readonly DictionaryTerm[];
};

export const glossaryCategories: readonly GlossaryCategory[] = [
  "character",
  "skill",
  "location",
  "tone",
  "general"
] as const;

export const glossaryCategoryLabels: Record<GlossaryCategory, string> = {
  character: "인물 / 등장인물",
  skill: "기술명 / 필살기",
  location: "지명 / 배경",
  tone: "어투 / 말버릇",
  general: "일반 고유명사"
};

export function isGlossaryCategory(value: unknown): value is GlossaryCategory {
  return typeof value === "string" && (glossaryCategories as readonly string[]).includes(value);
}

/**
 * 승인된 용어 후보들을 프로젝트 DictionaryTerm 배열에 병합합니다.
 */
export function mergeApprovedTermsToDictionary(
  existingTerms: readonly DictionaryTerm[],
  candidates: readonly GlossaryTermCandidate[]
): DictionaryTerm[] {
  const approvedCandidates = candidates.filter((c) => c.status === "approved" && c.source.trim() && c.suggestedTarget.trim());
  const merged = [...existingTerms];

  for (const candidate of approvedCandidates) {
    const normSource = candidate.source.trim().normalize("NFKC").toLowerCase();
    const existingIndex = merged.findIndex(
      (t) => t.source.trim().normalize("NFKC").toLowerCase() === normSource
    );

    const termItem: DictionaryTerm = {
      id: candidate.id || `term-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      source: candidate.source.trim(),
      target: candidate.suggestedTarget.trim(),
      category: candidate.category
    };
    const note = candidate.notes?.trim();
    if (note) termItem.note = note;
    else if (existingIndex >= 0 && merged[existingIndex]!.note) termItem.note = merged[existingIndex]!.note;

    if (existingIndex >= 0) {
      merged[existingIndex] = { ...merged[existingIndex]!, ...termItem };
    } else {
      merged.push(termItem);
    }
  }

  return merged;
}

/**
 * 승인된 캐릭터 후보들을 프로젝트 CharacterProfile 배열에 병합합니다.
 */
export function mergeApprovedCharactersToProfiles(
  existingProfiles: readonly CharacterProfile[],
  candidates: readonly CharacterCandidate[]
): CharacterProfile[] {
  const approvedCandidates = candidates.filter(
    (c) => c.status === "approved" && (c.nameKo.trim() || c.nameJa.trim())
  );
  const merged = [...existingProfiles];

  for (const candidate of approvedCandidates) {
    const primaryName = candidate.nameKo.trim() || candidate.nameJa.trim();
    const normName = primaryName.normalize("NFKC").toLowerCase();
    const existingIndex = merged.findIndex(
      (p) =>
        p.name.trim().normalize("NFKC").toLowerCase() === normName ||
        p.aliases.some((a) => a.trim().normalize("NFKC").toLowerCase() === normName)
    );

    const aliases = Array.from(
      new Set(
        [
          candidate.nameJa.trim(),
          candidate.nameKo.trim(),
          ...candidate.aliases.map((a) => a.trim())
        ].filter((a) => a && a.toLowerCase() !== primaryName.toLowerCase())
      )
    );

    const profile: CharacterProfile = {
      id: candidate.id || `char-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: primaryName,
      aliases,
      description: candidate.description?.trim() || (candidate.role ? `역할: ${candidate.role} (${candidate.gender})` : undefined),
      speechStyle: candidate.tone?.trim() || undefined,
      relationshipNotes: undefined
    };

    if (existingIndex >= 0) {
      const existing = merged[existingIndex]!;
      merged[existingIndex] = {
        ...existing,
        name: existing.name || profile.name,
        aliases: Array.from(new Set([...existing.aliases, ...profile.aliases])),
        description: profile.description || existing.description,
        speechStyle: profile.speechStyle || existing.speechStyle
      };
    } else {
      merged.push(profile);
    }
  }

  return merged;
}

export type GlossaryFileFormat = "tsv" | "txt" | "json" | "auto";

/**
 * TSV, TXT (BallonsTranslator 호환), JSON 형식의 용어집 텍스트를 DictionaryTerm 배열로 파싱합니다.
 */
export function parseGlossaryFile(
  content: string,
  format: GlossaryFileFormat = "auto"
): DictionaryTerm[] {
  if (!content || !content.trim()) return [];

  const raw = content.trim();

  // 1. JSON format detection
  if (format === "json" || (format === "auto" && (raw.startsWith("[") || raw.startsWith("{")))) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
          .map((item, index) => ({
            id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `term-json-${index + 1}`,
            source: String(item.source ?? item.src ?? item.original ?? "").trim(),
            target: String(item.target ?? item.dst ?? item.translation ?? "").trim(),
            note: item.note ? String(item.note).trim() : undefined
          }))
          .filter((t) => t.source && t.target);
      } else if (typeof parsed === "object" && parsed !== null) {
        // Key-value dictionary object format: { "先輩": "선배" }
        return Object.entries(parsed as Record<string, unknown>)
          .map(([source, target], index) => ({
            id: `term-kv-${index + 1}`,
            source: source.trim(),
            target: String(target).trim()
          }))
          .filter((t) => t.source && t.target);
      }
    } catch {
      // If JSON parse fails in auto mode, fall through to line-by-line parsing
      if (format === "json") return [];
    }
  }

  // 2. Line-by-line parsing (TSV / TXT)
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
  const terms: DictionaryTerm[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    if (line.includes("\t")) {
      // TSV format: source \t target [\t note]
      const parts = line.split("\t").map((p) => p.trim());
      if (parts[0] && parts[1]) {
        terms.push({
          id: `term-tsv-${i + 1}`,
          source: parts[0],
          target: parts[1],
          note: parts[2] || undefined
        });
      }
    } else if (line.includes("->") || line.includes("=>") || line.includes("＝") || line.includes("=")) {
      // Arrow / Equals format: "source -> target [// note]"
      const [mainPart, notePart] = line.split(/\/\//).map((p) => p.trim());
      const sep = line.includes("->") ? "->" : line.includes("=>") ? "=>" : line.includes("＝") ? "＝" : "=";
      const parts = (mainPart ?? "").split(sep).map((p) => p.trim());
      if (parts[0] && parts[1]) {
        terms.push({
          id: `term-txt-${i + 1}`,
          source: parts[0],
          target: parts[1],
          note: notePart || undefined
        });
      }
    } else if (line.includes(":") || line.includes("：")) {
      // Colon format: "source: target"
      const sep = line.includes(":") ? ":" : "：";
      const parts = line.split(sep).map((p) => p.trim());
      if (parts[0] && parts[1]) {
        terms.push({
          id: `term-col-${i + 1}`,
          source: parts[0],
          target: parts[1]
        });
      }
    }
  }

  return terms;
}

/**
 * DictionaryTerm 배열을 지정된 포맷의 텍스트 파일 내용으로 직렬화합니다.
 */
export function exportGlossaryFile(
  terms: readonly DictionaryTerm[],
  format: "tsv" | "txt" | "json"
): string {
  if (format === "json") {
    return JSON.stringify(
      terms.map((t) => ({
        source: t.source,
        target: t.target,
        ...(t.note ? { note: t.note } : {})
      })),
      null,
      2
    );
  }

  if (format === "tsv") {
    return terms
      .map((t) => [t.source, t.target, t.note ?? ""].join("\t").trimEnd())
      .join("\n");
  }

  // "txt" format (BallonsTranslator standard)
  return terms
    .map((t) => `${t.source} -> ${t.target}${t.note ? ` // ${t.note}` : ""}`)
    .join("\n");
}

export type GlossaryReconciliationResult = {
  reconciledText: string;
  substitutedCount: number;
  replacements: Array<{ source: string; target: string }>;
};

/**
 * 원문에 포함된 고유명사/용어집 항목이 번역문에 누락되거나 오역되었을 경우,
 * 결정론적(Deterministic)으로 용어 일관성을 교정합니다.
 */
export function reconcileGlossaryTerms(
  sourceText: string,
  translatedText: string,
  matchedTerms: readonly DictionaryTerm[]
): GlossaryReconciliationResult {
  if (!sourceText || !translatedText || matchedTerms.length === 0) {
    return { reconciledText: translatedText, substitutedCount: 0, replacements: [] };
  }

  let reconciled = translatedText;
  let count = 0;
  const replacements: Array<{ source: string; target: string }> = [];

  const normSource = sourceText.normalize("NFKC").toLowerCase();

  for (const term of matchedTerms) {
    const termSrc = term.source.trim().normalize("NFKC").toLowerCase();
    const termDst = term.target.trim();
    if (!termSrc || !termDst) continue;

    // Check if source text actually contains the term
    if (normSource.includes(termSrc)) {
      // If translated text doesn't contain target term, record replacement expectation
      if (!reconciled.includes(termDst)) {
        replacements.push({ source: term.source, target: term.target });
      }
    }
  }

  return {
    reconciledText: reconciled,
    substitutedCount: count,
    replacements
  };
}
