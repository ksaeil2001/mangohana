/**
 * YSB Translator Tool 방식 한국어 형태소/조사·어미 결합도 인식 및 줄바꿈 후보 평가기 (Candidate Evaluator)
 * W3C KLReq 조판 표준 규칙과 연동되어 자연스러운 한국어 식자 레이아웃을 생성합니다.
 */

import {
  canBreakBetweenChars,
  sanitizeLineBreakByKlreq
} from "./typesettingKlreq.js";

// 주요 한국어 조사 패턴
const PARTICLES = new Set([
  "은", "는", "이", "가", "을", "를", "에", "에서", "에게", "한테", "께", "으로", "로",
  "와", "과", "도", "만", "까지", "부터", "마저", "조차", "보다", "처럼", "같이", "요",
  "네", "랑", "이랑", "야", "아", "의", "께서는", "에게서", "한테서", "보고", "대로", "만큼"
]);

// 주요 한국어 연결/종결 어미 패턴
const ENDINGS = new Set([
  "고", "며", "면", "서", "어서", "아서", "여서", "려고", "으려고", "는데", "은데", "ㄴ데",
  "지만", "거나", "도록", "자", "자마자", "니까", "으니까", "잖아", "거든", "네요", "군요",
  "구나", "텐데", "을텐데", "ㄹ텐데", "지요", "죠", "라면", "더라", "더군", "을까", "ㄹ까",
  "을래", "ㄹ래", "는다", "ㄴ다", "었다", "았다", "였다", "습니다", "ㅂ니다", "데요", "을게", "ㄹ게"
]);

export type BreakToken = {
  text: string;
  isSpace: boolean;
  canBreakAfter: boolean;
  breakPenalty: number; // 낮은 값일수록 자연스러운 줄바꿈 위치
};

/**
 * 텍스트를 어절 및 형태소 결합 단위 토큰으로 분절합니다.
 */
export function tokenizeKoreanText(text: string): BreakToken[] {
  if (!text) return [];

  const rawTokens = text.split(/(\s+)/);
  const tokens: BreakToken[] = [];

  for (const raw of rawTokens) {
    if (!raw) continue;

    const isSpace = /^\s+$/.test(raw);
    if (isSpace) {
      // 공백 뒤는 가장 이상적인 줄바꿈 지점 (패널티 0)
      tokens.push({
        text: raw,
        isSpace: true,
        canBreakAfter: true,
        breakPenalty: 0
      });
      continue;
    }

    // 어절 내 문장부호 분리 처리 (예: "정말이야...!")
    const match = raw.match(/^([^\s!?.,~…"]+)([\s!?.,~…"]*)$/);
    if (match && match[1] && match[2] && match[2].length > 0) {
      const wordPart = match[1];
      const punctPart = match[2];

      tokens.push({
        text: wordPart,
        isSpace: false,
        canBreakAfter: false, // 문장부호 앞에서는 끊지 않음
        breakPenalty: 30
      });

      tokens.push({
        text: punctPart,
        isSpace: false,
        canBreakAfter: true, // 문장부호 뒤는 줄바꿈 허용
        breakPenalty: 5
      });
      continue;
    }

    // 일반 어절
    tokens.push({
      text: raw,
      isSpace: false,
      canBreakAfter: true,
      breakPenalty: 10
    });
  }

  return tokens;
}

/**
 * 주어진 어절(word) 내에서 분절이 불가피할 때 조사/어미를 보존하는 최적 분할 지점을 탐색합니다.
 */
export function findBestSubwordBreak(word: string): number {
  if (word.length <= 2) return -1;

  let bestIndex = -1;
  let minPenalty = 999;

  // 뒤에서부터 1~3글자 조사/어미 매칭
  for (let i = 1; i < word.length; i += 1) {
    const prefix = word.slice(0, i);
    const suffix = word.slice(i);
    const leftChar = prefix[prefix.length - 1]!;
    const rightChar = suffix[0]!;

    if (!canBreakBetweenChars(leftChar, rightChar)) {
      continue;
    }

    let penalty = 20;

    // 조사나 어미 바로 앞에서 자르면 높은 패널티 (예: "밥" | "을" -> 50)
    if (PARTICLES.has(suffix) || ENDINGS.has(suffix)) {
      penalty += 40;
    }

    // 외톨이 글자(1글자만 분리) 패널티
    if (prefix.length === 1 || suffix.length === 1) {
      penalty += 30;
    }

    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestIndex = i;
    }
  }

  return bestIndex;
}

export type CandidateEvaluationOptions = {
  estimateWidth: (text: string) => number;
  getAvailableWidth: (lineIndex: number, lineCount: number) => number;
  maxLines?: number;
};

/**
 * YSB Translator Tool 알고리즘: 여러 줄바꿈 후보를 생성하고 조사/어미 결합도, 외톨이 글자 방지,
 * KLReq 금칙, 말풍선 Span 균형을 종합 평가하여 최적의 줄바꿈 배열을 반환합니다.
 */
export function evaluateAndBreakKoreanText(
  text: string,
  options: CandidateEvaluationOptions
): string[] {
  const trimmed = text.trim().replace(/[\r\n]+/g, " ");
  if (!trimmed) return [];

  const { estimateWidth, getAvailableWidth, maxLines = 8 } = options;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  // 1단어인 경우
  if (words.length === 1) {
    const singleWord = words[0]!;
    const availableWidth = getAvailableWidth(0, 1);
    if (estimateWidth(singleWord) <= availableWidth) {
      return [singleWord];
    }
    // 1단어가 가용 너비를 초과하면 서브워드 분할
    const subIdx = findBestSubwordBreak(singleWord);
    if (subIdx > 0) {
      const line1 = singleWord.slice(0, subIdx);
      const line2 = singleWord.slice(subIdx);
      return sanitizeLineBreakByKlreq(line1, line2);
    }
    return [singleWord];
  }

  // 어절 단위 탐색 기반 동적 프로그래밍 / 그리디 + 후보 평가
  const lines: string[] = [];
  let currentWords: string[] = [];
  let lineIndex = 0;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const candidateWords = [...currentWords, word];
    const candidateText = candidateWords.join(" ");
    const candidateWidth = estimateWidth(candidateText);
    const availableWidth = getAvailableWidth(lineIndex, Math.min(maxLines, lines.length + 1));

    if (candidateWidth <= availableWidth || currentWords.length === 0) {
      currentWords.push(word);
    } else {
      // 현재 줄 확정 후 다음 줄로 이동
      let currentLineText = currentWords.join(" ");

      // 다음 줄 첫 단어와 KLReq 검사
      const [sanitizedLine1, remaining] = sanitizeLineBreakByKlreq(currentLineText, word);
      lines.push(sanitizedLine1);

      if (remaining.length > 0 && remaining !== word) {
        currentWords = [remaining];
      } else {
        currentWords = [word];
      }
      lineIndex += 1;
    }
  }

  if (currentWords.length > 0) {
    lines.push(currentWords.join(" "));
  }

  // 외톨이 글자(Orphan) 및 KLReq 후처리: 마지막 줄이 1~2자이고 이전 줄에 여유가 있다면 이전 줄로 통합 또는 균형 조정
  if (lines.length > 1) {
    const lastLine = lines[lines.length - 1]!;
    if (lastLine.length <= 2) {
      const prevLine = lines[lines.length - 2]!;
      const combined = `${prevLine} ${lastLine}`;
      const prevAvailableWidth = getAvailableWidth(lines.length - 2, lines.length - 1);
      if (estimateWidth(combined) <= prevAvailableWidth * 1.05) {
        lines[lines.length - 2] = combined;
        lines.pop();
      }
    }
  }

  return lines;
}