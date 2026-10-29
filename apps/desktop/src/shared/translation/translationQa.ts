import type { CharacterProfile, DialogueType, DictionaryTerm } from "../projectTypes.js";

export type TranslationQaIssueType =
  | "GLOSSARY_MISMATCH"
  | "SPEECH_STYLE_MISMATCH"
  | "UNTRANSLATED_ARTIFACT"
  | "BRACKET_MISMATCH"
  | "EMPTY_OR_WHITESPACE";

export type TranslationQaSeverity = "error" | "warning" | "info";

export type TranslationQaIssue = {
  type: TranslationQaIssueType;
  severity: TranslationQaSeverity;
  message: string;
  detail?: string;
  suggestedFix?: string;
};

export type TranslationQaReport = {
  passed: boolean;
  score: number; // 0 ~ 100
  issues: TranslationQaIssue[];
};

export type InspectTranslationQaArgs = {
  sourceText: string;
  translatedText: string;
  matchedTerms?: readonly DictionaryTerm[];
  speakerProfile?: CharacterProfile;
  dialogueType?: DialogueType;
};

const JAPANESE_CHAR_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/;
const REASONING_TAG_REGEX = /<think>|<\/think>|```/i;

/**
 * Inspects translation quality and consistency according to Glossarion rules.
 */
export function inspectTranslationQuality(
  args: InspectTranslationQaArgs
): TranslationQaReport {
  const { sourceText, translatedText, matchedTerms = [], speakerProfile, dialogueType } = args;
  const issues: TranslationQaIssue[] = [];

  const trimmedSource = sourceText?.trim() ?? "";
  const trimmedTrans = translatedText?.trim() ?? "";

  // 1. Empty or identical to source text
  if (!trimmedTrans) {
    issues.push({
      type: "EMPTY_OR_WHITESPACE",
      severity: "error",
      message: "번역문이 비어 있습니다."
    });
    return { passed: false, score: 0, issues };
  }

  if (trimmedSource === trimmedTrans && trimmedSource.length > 0 && JAPANESE_CHAR_REGEX.test(trimmedSource)) {
    issues.push({
      type: "EMPTY_OR_WHITESPACE",
      severity: "error",
      message: "원문이 번역되지 않고 그대로 복사되었습니다."
    });
  }

  // 2. Untranslated Artifacts / Residual Japanese / Codeblock leftovers
  if (REASONING_TAG_REGEX.test(trimmedTrans)) {
    issues.push({
      type: "UNTRANSLATED_ARTIFACT",
      severity: "error",
      message: "AI 추론 태그(<think>) 또는 마크다운 코드블록 잔재가 포함되어 있습니다."
    });
  }

  // Check for residual Japanese Hiragana/Katakana in Korean translation
  // (Ignore single katakana middle dot or common permitted symbols)
  const kanaMatches = trimmedTrans.match(/[\u3040-\u309F\u30A0-\u30FA\u30FD-\u30FF]{2,}/g);
  if (kanaMatches && kanaMatches.length > 0) {
    issues.push({
      type: "UNTRANSLATED_ARTIFACT",
      severity: "warning",
      message: `번역문에 미번역 일본어(${kanaMatches.join(", ")})가 남아있습니다.`,
      detail: kanaMatches.join(", ")
    });
  }

  // 3. Glossary & Terminology Compliance
  for (const term of matchedTerms) {
    const termSrc = term.source.trim();
    const termDst = term.target.trim();
    if (!termSrc || !termDst) continue;

    // Check if source text actually contains the term
    if (trimmedSource.toLowerCase().includes(termSrc.toLowerCase())) {
      // Check if translation contains target
      if (!trimmedTrans.toLowerCase().includes(termDst.toLowerCase())) {
        issues.push({
          type: "GLOSSARY_MISMATCH",
          severity: "warning",
          message: `지정된 용어집 단어 '${termSrc} -> ${termDst}'이(가) 번역문에 반영되지 않았습니다.`,
          detail: `기대 번역어: ${termDst}`,
          suggestedFix: termDst
        });
      }
    }
  }

  // 4. Speaker Tone & Speech Style Consistency
  if (speakerProfile?.speechStyle) {
    const style = speakerProfile.speechStyle.toLowerCase();

    // Check Honorific / Polite tone requirement
    if (style.includes("존댓말") || style.includes("경어") || style.includes("존칭")) {
      // Look for informal endings that conflict with honorific tone
      const informalEnding = /[가-힣](다|냐|냐고|자|어|라|마|았어|었어|겠어|마라|해라)[.!?~…\s]*$/;
      const politeEnding = /[가-힣](요|죠|니다|시오|세요|까요|바랍니다|드립니다|군요|네요|ㅂ니다)[.!?~…\s]*$/;

      if (
        dialogueType !== "thought" &&
        trimmedTrans.length >= 4 &&
        informalEnding.test(trimmedTrans) &&
        !politeEnding.test(trimmedTrans)
      ) {
        issues.push({
          type: "SPEECH_STYLE_MISMATCH",
          severity: "info",
          message: `화자(${speakerProfile.name})의 말투 설정은 '존댓말/경어'이나 반말 어미로 끝납니다.`,
          detail: speakerProfile.speechStyle
        });
      }
    }

    // Check Informal / Banmal requirement
    if (style.includes("반말") && !style.includes("존댓말")) {
      const politeEnding = /[가-힣](습니다|십니까|해요|하십니까|합니다|드려요|바랍니다)[.!?~…\s]*$/;
      if (dialogueType !== "thought" && trimmedTrans.length >= 4 && politeEnding.test(trimmedTrans)) {
        issues.push({
          type: "SPEECH_STYLE_MISMATCH",
          severity: "info",
          message: `화자(${speakerProfile.name})의 말투 설정은 '반말'이나 존댓말 어미(~습니다/해요)가 사용되었습니다.`,
          detail: speakerProfile.speechStyle
        });
      }
    }
  }

  // 5. Bracket and Quote Balance
  const openJpQuote = (trimmedTrans.match(/「/g) || []).length;
  const closeJpQuote = (trimmedTrans.match(/」/g) || []).length;
  if (openJpQuote !== closeJpQuote) {
    issues.push({
      type: "BRACKET_MISMATCH",
      severity: "warning",
      message: "일본어 따옴표(「」) 괄호 쌍이 일치하지 않습니다."
    });
  }

  const openDoubleJpQuote = (trimmedTrans.match(/『/g) || []).length;
  const closeDoubleJpQuote = (trimmedTrans.match(/』/g) || []).length;
  if (openDoubleJpQuote !== closeDoubleJpQuote) {
    issues.push({
      type: "BRACKET_MISMATCH",
      severity: "warning",
      message: "일본어 겹따옴표(『』) 괄호 쌍이 일치하지 않습니다."
    });
  }

  // Calculate overall score (100 minus penalty)
  let penalty = 0;
  for (const issue of issues) {
    if (issue.severity === "error") penalty += 40;
    else if (issue.severity === "warning") penalty += 15;
    else if (issue.severity === "info") penalty += 5;
  }

  const score = Math.max(0, 100 - penalty);
  const hasErrors = issues.some((i) => i.severity === "error");

  return {
    passed: !hasErrors && score >= 70,
    score,
    issues
  };
}
