import {expect,it} from 'vitest';
import type {Block} from '../../packages/contracts/src/wire.generated.js';
import {translationReviewNotes} from '../../apps/web/src/translation-review-notes.js';

type ReviewBlock = Pick<Block, 'sourceText' | 'translatedText' | 'appliedTranslation'>;
const applied: NonNullable<Block['appliedTranslation']> = {
  sourceLanguage: 'ja', targetLanguage: 'ko', modelId: 'unit-review-fixture',
  reasoningLevel: 'LOW', modelContract: 'fixture', promptContract: 'fixture', originExecutionId: null,
};
const block = (source: string, text: string, metadata: Block['appliedTranslation'] = applied): ReviewBlock => ({
  sourceText: {value: source, status: 'AI_PROPOSED'},
  translatedText: {value: text, status: 'AI_PROPOSED'},
  appliedTranslation: metadata,
});
// Stored provider-output excerpts from translation-review-signals.json; no new model execution or human GT.
const observed = [
  {
    "id": "150465624_p0-r05",
    "source": "なるほどわかった！\nもーかはほんとかしこいねぇ",
    "text": "그렇습니다! 그런데 그건 정말 어려운 문제인가요?','그건 정말 어려운 문제인가요?",
    "note": "문자열 구분 조각"
  },
  {
    "id": "150465624_p3-r02",
    "source": "イルカ！\nイルカ←\nかるいなので!!",
    "text": "イルカ！\nイルカ←\nかるいので!!",
    "note": "일본어 가나"
  },
  {
    "id": "150465624_p3-r09",
    "source": "一万円を両替したら千円札十枚になります",
    "text": "만원을 교환하면 천원 지폐 열 장이 됩니다",
    "note": "엔 금액"
  }
];
it.each(observed)('gives a nonblocking hint for saved observation $id', ({source,text,note}) => {
  expect(translationReviewNotes(block(source,text),false)).toEqual([expect.stringContaining(note)]);
});
it('hints about the literal unknown token without requiring historical language metadata', () => {
  expect(translationReviewNotes(block('…ぅ',' <unk>',null),false)).toEqual([expect.stringContaining('<unk>')]);
  expect(translationReviewNotes(block('原文','알 수 없음',null),false)).toEqual([]);
});
it.each(["첫 문장','다음 문장",'첫 문장", "다음 문장'])('hints about serialized string separators: %s', text => {
  expect(translationReviewNotes(block('原文',text,null),false)).toEqual([expect.stringContaining('문자열 구분 조각')]);
});
it('does not warn about ordinary punctuation or classify normal Korean as readable', () => {
  expect(translationReviewNotes(block('原文','안녕, 다시 만나요.'),false)).toEqual([]);
});
it('uses only the stored target language for kana and leaves names or terms for review', () => {
  const text='モーカ라는 이름이에요.';
  expect(translationReviewNotes(block('もーか',text),false)).toEqual([expect.stringContaining('이름·용어 표기인지')]);
  for (const metadata of [null,{...applied,targetLanguage:'ja' as const},{...applied,targetLanguage:'en' as const}]) {
    expect(translationReviewNotes(block('もーか',text,metadata),false)).toEqual([]);
  }
});
it('does not infer historical languages from missing appliedTranslation', () => {
  expect(translationReviewNotes(block('一万円','만원 カナ',null),false)).toEqual([]);
});
it('limits the currency hint to stored ja→ko metadata and a yen source', () => {
  expect(translationReviewNotes(block('一万円','만원'),false)).toEqual([expect.stringContaining('엔 금액')]);
  expect(translationReviewNotes(block('一万円','10000원'),false)).toEqual([expect.stringContaining('엔 금액')]);
  expect(translationReviewNotes(block('一万円','만원',{...applied,sourceLanguage:'en'}),false)).toEqual([]);
  expect(translationReviewNotes(block('一万円','만원',{...applied,targetLanguage:'en'}),false)).toEqual([]);
  expect(translationReviewNotes(block('原文','만원'),false)).toEqual([]);
  expect(translationReviewNotes(block('一万円','일만 엔'),false)).toEqual([]);
});
it.each(['USER_MODIFIED','USER_CONFIRMED'] as const)('leaves %s translation without old AI hints', status => {
  const saved=block('一万円',"<unk> カナ','만원");
  saved.translatedText.status=status;
  expect(translationReviewNotes(saved,false)).toEqual([]);
});
it('suppresses all old AI hints while any editor draft is present', () => {
  expect(translationReviewNotes(block('一万円',"<unk> カナ','만원"),true)).toEqual([]);
});
it('returns hints without changing saved values, status or applied provider metadata', () => {
  const saved=block('一万円',"<unk> カナ','만원");
  const before=JSON.stringify(saved);
  Object.freeze(saved.sourceText);Object.freeze(saved.translatedText);Object.freeze(saved.appliedTranslation);Object.freeze(saved);
  const notes=translationReviewNotes(saved,false);
  expect(notes).toHaveLength(4);
  expect(JSON.stringify(saved)).toBe(before);
});
