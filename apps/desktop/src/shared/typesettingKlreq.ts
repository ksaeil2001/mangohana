/**
 * W3C Korean Layout Requirements (KLReq) 조판 규칙 표준 구현
 *
 * - 전치 금칙 문자 (Line-start prohibited / Kinsoku Shori): 줄의 시작에 올 수 없는 문자 (닫는 괄호, 구두점 등)
 * - 후치 금칙 문자 (Line-end prohibited): 줄의 끝에 올 수 없는 문자 (여는 괄호, 통화 기호 등)
 * - 분리 금칙 단위 (Non-breakable characters/sequences): 둘 사이에 줄바꿈을 넣을 수 없는 문자열 (연속 부호, 숫자 등)
 */

// 줄 시작 금칙 문자 (전치 금칙 문자)
export const LINE_START_PROHIBITED_CHARS = new Set([
  ")", "]", "}", ">", "》", "’", "”", "」", "』", "】", "〉", "〕", "）", "］", "｝",
  "!", "?", ".", ",", ":", ";", "…", "‥", "·", "―", "—", "~",
  "！", "？", "。", "、", "・", "%", "‰", "°", "℃", "℉"
]);

// 줄 끝 금칙 문자 (후치 금칙 문자)
export const LINE_END_PROHIBITED_CHARS = new Set([
  "(", "[", "{", "<", "《", "‘", "“", "「", "『", "【", "〈", "〔", "（", "［", "｛",
  "\\", "₩", "$", "€", "£", "¥", "#", "№", "§"
]);

/**
 * 주어진 문자가 전치 금칙 문자(줄 시작 불가)인지 검사합니다.
 */
export function isLineStartProhibited(char: string): boolean {
  if (!char || char.length === 0) return false;
  return LINE_START_PROHIBITED_CHARS.has(char);
}

/**
 * 주어진 문자가 후치 금칙 문자(줄 끝 불가)인지 검사합니다.
 */
export function isLineEndProhibited(char: string): boolean {
  if (!char || char.length === 0) return false;
  return LINE_END_PROHIBITED_CHARS.has(char);
}

/**
 * 두 문자 사이가 분리 금칙(줄바꿈 불가)인지 검사합니다.
 * 예: 연속된 구두점 (..., !?, ??, !!), 숫자와 단위/소수점 사이, 여는 괄호 바로 뒤 등
 */
export function canBreakBetweenChars(left: string, right: string): boolean {
  if (!left || !right) return true;

  // 1. 왼쪽 문자가 줄 끝 금칙 문자인 경우 줄바꿈 불가
  if (isLineEndProhibited(left)) return false;

  // 2. 오른쪽 문자가 줄 시작 금칙 문자인 경우 줄바꿈 불가
  if (isLineStartProhibited(right)) return false;

  // 3. 연속된 문장부호 (..., !?, ?!, !!, ??, ~~)
  const isPunct = (c: string) => /[!?.\-~…‥―—]/.test(c);
  if (isPunct(left) && isPunct(right)) {
    return false;
  }

  // 4. 숫자와 소수점, 숫자와 숫자, 숫자와 퍼센트 등
  const isDigit = (c: string) => /[0-9]/.test(c);
  if (isDigit(left) && (isDigit(right) || right === "." || right === "," || right === "%" || right === ":")) {
    return false;
  }
  if ((left === "." || left === "," || left === ":") && isDigit(right)) {
    return false;
  }

  // 5. 영문 단어 중간 분리 방지 (영문자 연속)
  const isAlpha = (c: string) => /[A-Za-z]/.test(c);
  if (isAlpha(left) && isAlpha(right)) {
    return false;
  }

  return true;
}

/**
 * 줄바꿈된 두 줄(currentLine, nextLine) 사이의 KLReq 금칙 위반을 교정합니다.
 * - nextLine의 첫 글자가 전치 금칙 문자이면 currentLine 끝으로 당겨옵니다.
 * - currentLine의 마지막 글자가 후치 금칙 문자이면 nextLine의 첫머리로 넘깁니다.
 */
export function sanitizeLineBreakByKlreq(currentLine: string, nextLine: string): [string, string] {
  let line1 = currentLine.trimEnd();
  let line2 = nextLine.trimStart();

  // 1. line1 마지막 문자가 후치 금칙(여는 괄호, 따옴표 등)인 경우 line2로 이동
  while (line1.length > 0) {
    const lastChar = line1[line1.length - 1]!;
    if (isLineEndProhibited(lastChar)) {
      line2 = lastChar + line2;
      line1 = line1.slice(0, -1).trimEnd();
    } else {
      break;
    }
  }

  // 2. line2 첫 문자가 전치 금칙(닫는 괄호, 구두점 등)이거나 분리 금지 시 line1으로 이동
  while (line2.length > 0) {
    const firstChar = line2[0]!;
    if (isLineStartProhibited(firstChar)) {
      line1 += firstChar;
      line2 = line2.slice(1).trimStart();
    } else if (line1.length > 0 && !canBreakBetweenChars(line1[line1.length - 1]!, firstChar) && !isLineEndProhibited(line1[line1.length - 1]!)) {
      line1 += firstChar;
      line2 = line2.slice(1).trimStart();
    } else {
      break;
    }
  }

  return [line1, line2];
}
