import type {Block} from '../../../packages/contracts/src/wire.generated.js';

export function translationReviewNotes(
  block: Pick<Block, 'sourceText' | 'translatedText' | 'appliedTranslation'>,
  hasDraft: boolean,
): string[] {
  if (hasDraft || block.translatedText.status !== 'AI_PROPOSED') return [];

  const text = block.translatedText.value;
  const applied = block.appliedTranslation;
  const notes: string[] = [];
  if (text.includes('<unk>')) {
    notes.push('번역문에 <unk> 토큰이 남아 있어요. 원문과 비교해 주세요.');
  }
  if (/['"]\s*,\s*['"]/.test(text)) {
    notes.push('번역문에 문자열 구분 조각이 섞였을 수 있어요. 원문과 비교해 주세요.');
  }
  if (applied?.targetLanguage === 'ko' && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) {
    notes.push('한국어 번역문에 일본어 가나가 있어요. 이름·용어 표기인지 원문 잔여인지 확인해 주세요.');
  }
  if (applied?.sourceLanguage === 'ja' && applied.targetLanguage === 'ko'
      && block.sourceText.value.includes('円')
      && /[0-9일이삼사오육칠팔구십백천만억]\s*원/.test(text) && !text.includes('엔')) {
    notes.push('원문의 엔 금액이 원으로 바뀌었을 수 있어요. 금액과 단위를 비교해 주세요.');
  }
  return notes;
}
