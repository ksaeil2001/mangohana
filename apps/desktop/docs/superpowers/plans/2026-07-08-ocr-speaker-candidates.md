# OCR Speaker Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OCR review modal에서 각 OCR 항목의 화자 후보를 보여주고, 사용자가 즉시 선택/수정한 speaker를 적용된 dialogue line에 반영한다.

**Architecture:** `speakerCandidates`와 `selectedSpeaker`는 저장 스키마가 아닌 OCR/review-only 데이터로 둔다. 공용 OCR 타입과 normalize 단계에서 후보를 안전하게 정규화하고, 기존 `validateSpeechBubbles` IPC 요청에 선택적 캐릭터 문맥만 추가해 Gemini/OpenAI 검증 프롬프트가 후보를 만들 수 있게 한다. Renderer는 review dialog의 editable item에 선택 speaker를 보관하고 기존 apply flow로 `DialogueLine.speaker`에 전달한다.

**Tech Stack:** Electron IPC, TypeScript, React 19, Vitest, Testing Library, existing Gemini/OpenAI validation flow.

## Global Constraints

- Windows PowerShell 기준으로 명령을 실행한다.
- 작업 폴더: `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor`
- 이 계획 단계에서는 코드 수정, 테스트 추가, 리팩터링을 하지 않는다.
- 구현은 사용자 승인 후에만 `superpowers:executing-plans`와 `superpowers:test-driven-development` 방식으로 진행한다.
- 기존 IPC 이름과 기본 흐름은 가능하면 유지한다.
- 새 `dialogueType`은 추가하지 않는다.
- 기존 OCR 분류 정책, review modal 그룹 정책, crop reOCR 흐름은 유지한다.
- 저장 스키마 변경, 외부 패키지 추가, DB/마이그레이션/보안/배포 설정 변경은 하지 않는다.
- `.env`, API key, 비밀번호, 토큰, 개인정보는 출력하지 않는다.
- dirty worktree의 기존 변경은 되돌리지 않는다.

---

## Verified Current State

확인일: 2026-07-08

| Area | Current file | Observed behavior |
|---|---|---|
| OCR shared model | `src/shared/speechBubbleExtraction.ts:27`, `src/shared/speechBubbleExtraction.ts:38`, `src/shared/speechBubbleExtraction.ts:241` | `ExtractedSpeechBubble`과 `ExtractedNonSpeechText`에는 text/type/bbox/confidence/notes만 있고 speaker 후보 필드가 없다. Normalize는 알 수 없는 필드를 보존하지 않는다. |
| OCR prompts | `src/shared/speechBubbleExtraction.ts:86`, `src/shared/speechBubbleExtraction.ts:169` | extraction/validation prompt는 단일 이미지 기준 OCR, 분류, bbox, readingOrder만 요구한다. 화자 후보 JSON shape나 "확정하지 말라"는 요구가 없다. |
| Gemini/OpenAI validation | `src/main/geminiSpeechBubbleExtraction.ts:111`, `src/main/openAiSpeechBubbleValidation.ts:33` | 두 provider 모두 `buildSpeechBubbleValidationPrompt(geminiExtraction)`만 사용한다. 프로젝트 캐릭터 문맥은 전달되지 않는다. |
| IPC flow | `src/main/ipcHandlers.ts:183` | `project:validateSpeechBubbles`는 기존 IPC 이름으로 validation 후 Gemini key가 있으면 low confidence/`[?]` 대상 crop reOCR를 병합한다. |
| Crop reOCR merge | `src/shared/speechBubbleReocr.ts:55` | crop reOCR는 text/confidence/notes만 덮어쓴다. speaker 후보는 현재 없으며, 구현 시 merge에서 보존해야 한다. |
| Review UI | `src/renderer/components/SpeechBubbleReviewDialog.tsx:14`, `src/renderer/components/SpeechBubbleReviewDialog.tsx:175` | review item은 text editing, checkbox, confidence, notes, bbox/language 메타만 지원한다. speech items는 기본 선택, optional/context groups는 기존 정책대로 분리된다. |
| Apply flow | `src/renderer/App.tsx:423`, `src/renderer/App.tsx:718` | apply는 선택 item을 `createDialogueLineFromBubble`에 전달하지만 `DialogueLine.speaker`를 세팅하지 않는다. `sourceText`, `dialogueType`, `notes`, `warnings`, `bbox`, `readingOrder` 흐름은 여기서 만들어진다. |
| Project character context | `src/shared/projectTypes.ts:34`, `src/shared/projectTypes.ts:50` | `TranslationProject.characters`에 `name`, `aliases`, `description`, `speechStyle`, `relationshipNotes`가 이미 있다. 저장 스키마 변경 없이 prompt context로 재사용 가능하다. |
| Tests | `tests/main/geminiSpeechBubbleExtraction.test.ts:41`, `tests/renderer/App.test.tsx:435` | OCR normalize/prompt/provider request와 review modal/apply flow를 검증하는 테스트가 이미 있다. 여기에 speaker candidate 실패 테스트를 추가하는 방식이 가장 작다. |

## Root Cause

OCR 파이프라인은 텍스트 정확도와 영역 분류에 집중되어 있고, 모델 출력 스키마와 review item 타입이 speaker 후보를 담지 않는다. 그 결과 모델이 말풍선과 캐릭터를 연결할 근거가 있어도 UI까지 전달되지 않고, 사용자는 적용 후 line detail에서 speaker를 별도로 수정해야 한다.

## File Structure

| File | Responsibility in this change |
|---|---|
| `src/shared/speechBubbleExtraction.ts` | `SpeakerCandidate` 타입 추가, OCR 결과 타입 확장, prompt JSON schema/규칙 확장, 후보 normalize helper 추가, validation prompt에 character context 인자 추가 |
| `src/shared/speechBubbleReocr.ts` | crop reOCR merge가 기존 speaker candidates를 잃지 않도록 object copy 보존 |
| `src/main/geminiSpeechBubbleExtraction.ts` | validation args에 선택적 character context를 받아 prompt builder로 전달 |
| `src/main/openAiSpeechBubbleValidation.ts` | Gemini fallback과 동일하게 validation prompt에 선택적 character context 전달 |
| `src/main/ipcHandlers.ts` | 기존 IPC 이름 유지, `validateSpeechBubbleValidationArgs`에서 선택적 characters context 검증/압축, provider args로 전달 |
| `src/renderer/electronApi.ts` | `ValidateSpeechBubbleExtractionRequest` 타입 변경을 그대로 노출 |
| `electron/preload.ts` | IPC 이름 변경 없음, 타입 변경만 따라감 |
| `src/renderer/App.tsx` | `validateSpeechBubbles` 호출에 `project.characters` 전달, `createDialogueLineFromBubble`에서 selected speaker를 `DialogueLine.speaker`에 반영, low/unknown speaker warning 추가 |
| `src/renderer/components/SpeechBubbleReviewDialog.tsx` | `SpeechBubbleReviewItem`에 후보/선택 speaker 추가, 후보 버튼/직접 입력 UI 추가, reason/low confidence 표시 |
| `src/renderer/styles.css` | speaker 후보 UI와 low-confidence 상태 스타일 추가 |
| `tests/main/geminiSpeechBubbleExtraction.test.ts` | extraction/validation JSON normalize, prompt 요구사항, provider request 테스트 추가/갱신 |
| `tests/main/openAiSpeechBubbleValidation.test.ts` | OpenAI validation prompt에도 speaker candidate 요구사항과 character context가 들어가는지 확인 |
| `tests/shared/speechBubbleReocr.test.ts` | crop reOCR merge가 speaker 후보를 보존하는지 확인 |
| `tests/main/ipcHandlers.integration.test.ts` | validation IPC가 characters context를 provider까지 전달하는지 확인 |
| `tests/renderer/App.test.tsx` | review modal speaker 후보 표시/선택/apply 결과 speaker 반영 테스트 추가/갱신 |

## Data Interfaces

Add review-only shared types in `src/shared/speechBubbleExtraction.ts`:

```ts
export type SpeakerCandidate = {
  speaker: string;
  confidence: number;
  reason: string;
};
```

Extend OCR regions without changing saved `DialogueLine` schema:

```ts
export type ExtractedSpeechBubble = {
  id: string;
  type: SpeechBubbleTextType;
  text: string;
  language: ExtractionLanguage;
  bbox: NormalizedBbox;
  readingOrder: number;
  confidence: number;
  notes: string;
  speakerCandidates: SpeakerCandidate[];
};

export type ExtractedNonSpeechText = {
  type: NonSpeechTextType;
  text: string;
  bbox: NormalizedBbox;
  confidence: number;
  notes: string;
  readingOrder: number;
  speakerCandidates: SpeakerCandidate[];
};
```

Extend validation request with optional, non-persistent context:

```ts
export type OcrCharacterContext = {
  name: string;
  aliases: string[];
  description?: string;
  speechStyle?: string;
  relationshipNotes?: string;
};

export type ValidateSpeechBubbleExtractionRequest = {
  projectFilePath: string;
  pageImage: PageImage;
  geminiExtraction: SpeechBubbleExtractionResult;
  characters?: OcrCharacterContext[];
};
```

Review item shape:

```ts
export type SpeechBubbleReviewItem = {
  id: string;
  textType: OcrTextType;
  text: string;
  language: ExtractionLanguage;
  bbox: NormalizedBbox;
  readingOrder: number;
  confidence: number;
  notes: string;
  speakerCandidates: SpeakerCandidate[];
  selectedSpeaker: string;
};
```

## Task 1: Normalize Speaker Candidates in Shared OCR Types

**Files:**
- Modify: `src/shared/speechBubbleExtraction.ts`
- Test: `tests/main/geminiSpeechBubbleExtraction.test.ts`

**Interfaces:**
- Produces: `SpeakerCandidate`, `OcrCharacterContext`, region `speakerCandidates`, `normalizeSpeakerCandidates(value: unknown): SpeakerCandidate[]`
- Consumes: existing `normalizeSpeechBubbleExtractionResult`

- [ ] **Step 1: Write failing normalization test**

Add a test in `tests/main/geminiSpeechBubbleExtraction.test.ts` inside `"posts an extraction request and normalizes Gemini JSON"` or as a new focused test:

```ts
it("normalizes speakerCandidates from OCR JSON", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      output_text: JSON.stringify({
        pageNumber: 1,
        speechBubbles: [
          {
            id: "bubble-001",
            type: "speech_bubble",
            text: "Hello",
            language: "en",
            bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
            readingOrder: 1,
            confidence: 0.9,
            notes: "",
            speakerCandidates: [
              { speaker: "Mika", confidence: 1.2, reason: "tail points to Mika" },
              { speaker: "", confidence: 0.5, reason: "blank speaker should be ignored" },
              { speaker: "Ren", confidence: -1, reason: 123 },
              { speaker: "A", confidence: 0.2, reason: "extra" },
              { speaker: "B", confidence: 0.2, reason: "extra" }
            ]
          }
        ],
        nonSpeechText: [
          {
            type: "narration_box",
            text: "Later",
            bbox: { x: 0, y: 0, width: 0.2, height: 0.1 },
            readingOrder: 2,
            confidence: 0.8,
            notes: "",
            speakerCandidates: [{ speaker: "Narrator", confidence: 0.8, reason: "boxed narration" }]
          }
        ],
        warnings: []
      })
    })
  }) as unknown as typeof fetch;

  const result = await extractSpeechBubblesWithGemini({
    imageBytes: Buffer.from([1]),
    sourceMimeType: "image/png",
    pageNumber: 1
  });

  expect(result.speechBubbles[0]?.speakerCandidates).toEqual([
    { speaker: "Mika", confidence: 1, reason: "tail points to Mika" },
    { speaker: "Ren", confidence: 0, reason: "" },
    { speaker: "A", confidence: 0.2, reason: "extra" }
  ]);
  expect(result.nonSpeechText[0]?.speakerCandidates).toEqual([
    { speaker: "Narrator", confidence: 0.8, reason: "boxed narration" }
  ]);
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run from `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor`:

```powershell
npm test -- tests/main/geminiSpeechBubbleExtraction.test.ts
```

Expected: fail because `speakerCandidates` is missing.

- [ ] **Step 3: Implement minimal shared normalization**

In `src/shared/speechBubbleExtraction.ts`, add the types above, include `speakerCandidates` in `ExtractedSpeechBubble`, `ExtractedNonSpeechText`, and `NormalizedOcrTextRegion`, and normalize with these rules:

```ts
function normalizeSpeakerCandidates(value: unknown): SpeakerCandidate[] {
  if (!Array.isArray(value)) return [];

  const candidates: SpeakerCandidate[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.speaker !== "string") continue;
    const speaker = candidate.speaker.trim();
    if (!speaker) continue;
    candidates.push({
      speaker,
      confidence: normalizeConfidence(candidate.confidence),
      reason: typeof candidate.reason === "string" ? candidate.reason.trim() : ""
    });
    if (candidates.length >= 3) break;
  }
  return candidates;
}
```

Update `normalizeOcrTextRegion` to set `speakerCandidates: normalizeSpeakerCandidates(record.speakerCandidates)`, then pass it through both region builders.

- [ ] **Step 4: Run focused test and verify pass**

Run:

```powershell
npm test -- tests/main/geminiSpeechBubbleExtraction.test.ts
```

Expected: pass.

## Task 2: Update OCR Prompts and Character Context

**Files:**
- Modify: `src/shared/speechBubbleExtraction.ts`
- Modify: `src/main/geminiSpeechBubbleExtraction.ts`
- Modify: `src/main/openAiSpeechBubbleValidation.ts`
- Modify: `src/main/ipcHandlers.ts`
- Test: `tests/main/geminiSpeechBubbleExtraction.test.ts`
- Test: `tests/main/openAiSpeechBubbleValidation.test.ts`
- Test: `tests/main/ipcHandlers.integration.test.ts`

**Interfaces:**
- Consumes: `OcrCharacterContext[]`
- Produces: `buildSpeechBubbleValidationPrompt(geminiExtraction, characters?)`

- [ ] **Step 1: Write failing prompt tests**

Add expectations in Gemini validation prompt test:

```ts
expect(requestBody.input[0]?.text).toContain("speakerCandidates");
expect(requestBody.input[0]?.text).toContain("Do not decide or finalize the speaker");
expect(requestBody.input[0]?.text).toContain("tail direction");
expect(requestBody.input[0]?.text).toContain("unknown");
```

Add a new direct prompt test:

```ts
it("includes character context when building validation prompt", () => {
  const prompt = buildSpeechBubbleValidationPrompt(emptyExtraction(1), [
    { name: "Mika", aliases: ["M"], description: "short hair", speechStyle: "casual" }
  ]);

  expect(prompt).toContain("Project character context");
  expect(prompt).toContain("Mika");
  expect(prompt).toContain("short hair");
  expect(prompt).toContain("casual");
});
```

Add the same prompt shape expectation to `tests/main/openAiSpeechBubbleValidation.test.ts` because OpenAI fallback uses the same builder.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
npm test -- tests/main/geminiSpeechBubbleExtraction.test.ts tests/main/openAiSpeechBubbleValidation.test.ts
```

Expected: fail because prompt does not mention speaker candidates/context.

- [ ] **Step 3: Implement prompt requirements**

In `SPEECH_BUBBLE_EXTRACTION_PROMPT` and `SPEECH_BUBBLE_VALIDATION_PROMPT`, add a speaker candidate section:

```text
Speaker candidate rules:
- Do not decide or finalize the speaker.
- For each speechBubbles item, provide 1 to 3 speakerCandidates.
- Each candidate must include speaker, confidence, and reason.
- Use visual evidence only: bubble tail direction, nearest face/character, panel position, and provided project character context.
- If evidence is weak, include unknown with low confidence instead of guessing.
- For narration_box or caption_time_place in nonSpeechText, speakerCandidates may include Narrator or unknown.
- Keep reasons short and specific, including why it is uncertain when confidence is low.
```

Update the returned JSON examples to include:

```json
"speakerCandidates": [
  { "speaker": "unknown", "confidence": 0.0, "reason": "tail is not visible" }
]
```

Change validation prompt builder signature:

```ts
export function buildSpeechBubbleValidationPrompt(
  geminiExtraction: SpeechBubbleExtractionResult,
  characters: OcrCharacterContext[] = []
): string
```

Append character context only when provided:

```ts
const characterContext = characters.length
  ? ["Project character context:", JSON.stringify(characters, null, 2)].join("\n")
  : "Project character context: none provided.";
```

- [ ] **Step 4: Pass context through providers**

Update provider args:

```ts
type ValidateSpeechBubblesWithGeminiArgs = {
  imageBytes: Buffer;
  sourceMimeType: string;
  geminiExtraction: SpeechBubbleExtractionResult;
  characters?: OcrCharacterContext[];
};
```

Use `buildSpeechBubbleValidationPrompt(args.geminiExtraction, args.characters ?? [])` in both provider files.

- [ ] **Step 5: Validate IPC request context**

In `src/main/ipcHandlers.ts`, allow optional `characters` on validation request. Normalize only safe strings and cap context to prevent prompt bloat:

```ts
function normalizeOcrCharacterContext(value: unknown): OcrCharacterContext[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((character) => ({
      name: typeof character.name === "string" ? character.name.trim() : "",
      aliases: Array.isArray(character.aliases)
        ? character.aliases.filter((alias): alias is string => typeof alias === "string").map((alias) => alias.trim()).filter(Boolean).slice(0, 5)
        : [],
      description: typeof character.description === "string" ? character.description.trim() : undefined,
      speechStyle: typeof character.speechStyle === "string" ? character.speechStyle.trim() : undefined,
      relationshipNotes: typeof character.relationshipNotes === "string" ? character.relationshipNotes.trim() : undefined
    }))
    .filter((character) => character.name.length > 0)
    .slice(0, 20);
}
```

Return `characters: normalizeOcrCharacterContext(args.characters)` from `validateSpeechBubbleValidationArgs` and include it in `validationArgsForProvider`.

- [ ] **Step 6: Run focused tests and verify pass**

Run:

```powershell
npm test -- tests/main/geminiSpeechBubbleExtraction.test.ts tests/main/openAiSpeechBubbleValidation.test.ts tests/main/ipcHandlers.integration.test.ts
```

Expected: pass.

## Task 3: Preserve Speaker Candidates Through Crop ReOCR Merge

**Files:**
- Modify: `src/shared/speechBubbleReocr.ts`
- Test: `tests/shared/speechBubbleReocr.test.ts`

**Interfaces:**
- Consumes: `ExtractedSpeechBubble.speakerCandidates`, `ExtractedNonSpeechText.speakerCandidates`
- Produces: merged result preserving existing candidates

- [ ] **Step 1: Write failing preservation test**

Add to `tests/shared/speechBubbleReocr.test.ts`:

```ts
it("preserves speaker candidates while merging crop reOCR text", () => {
  const result = extractionResult({
    speechText: "Hel[?]o"
  });
  result.speechBubbles[0] = {
    ...result.speechBubbles[0]!,
    speakerCandidates: [{ speaker: "Mika", confidence: 0.82, reason: "tail points left" }]
  };
  const [target] = selectCropReocrTargets(result);

  const merged = mergeCropReocrResults(result, [
    { target: target!, result: { text: "Hello", confidence: 0.9, notes: "clear crop" } }
  ]);

  expect(merged.speechBubbles[0]?.speakerCandidates).toEqual([
    { speaker: "Mika", confidence: 0.82, reason: "tail points left" }
  ]);
});
```

- [ ] **Step 2: Run focused test and verify failure if spread does not satisfy types**

Run:

```powershell
npm test -- tests/shared/speechBubbleReocr.test.ts
```

Expected: either TypeScript/test failure until fixture includes `speakerCandidates`, or pass if object spreads already preserve after Task 1. If it passes, keep the test as regression coverage.

- [ ] **Step 3: Implement only if needed**

If clone logic needs explicit deep copy, update:

```ts
speechBubbles: result.speechBubbles.map((bubble) => ({
  ...bubble,
  bbox: { ...bubble.bbox },
  speakerCandidates: bubble.speakerCandidates.map((candidate) => ({ ...candidate }))
})),
```

Apply equivalent copy for `nonSpeechText`.

- [ ] **Step 4: Run focused test and verify pass**

Run:

```powershell
npm test -- tests/shared/speechBubbleReocr.test.ts
```

Expected: pass.

## Task 4: Add Speaker Selection UI to Review Modal

**Files:**
- Modify: `src/renderer/components/SpeechBubbleReviewDialog.tsx`
- Modify: `src/renderer/styles.css`
- Test: `tests/renderer/App.test.tsx`

**Interfaces:**
- Consumes: `SpeakerCandidate[]`
- Produces: `SpeechBubbleReviewItem.selectedSpeaker`

- [ ] **Step 1: Write failing renderer test for candidate display and selection**

Extend the OCR review test data in `tests/renderer/App.test.tsx:453`:

```ts
speakerCandidates: [
  { speaker: "Mika", confidence: 0.82, reason: "tail points to Mika" },
  { speaker: "Ren", confidence: 0.61, reason: "Ren is nearby but tail is unclear" },
  { speaker: "unknown", confidence: 0.2, reason: "face is cropped" }
]
```

For narration item:

```ts
speakerCandidates: [{ speaker: "Narrator", confidence: 0.78, reason: "boxed narration" }]
```

Add assertions before apply:

```ts
expect(screen.getByRole("button", { name: "Mika 82%" })).toBeInTheDocument();
expect(screen.getByRole("button", { name: "Ren 61%" })).toBeInTheDocument();
expect(screen.getByText("tail points to Mika")).toBeInTheDocument();
expect(screen.getByLabelText("thought_bubble 1 화자")).toHaveValue("Mika");

fireEvent.click(screen.getByRole("button", { name: "Ren 61%" }));
expect(screen.getByLabelText("thought_bubble 1 화자")).toHaveValue("Ren");
```

Add direct edit assertion:

```ts
fireEvent.change(screen.getByLabelText("filtered_speech 2 화자"), { target: { value: "Radio" } });
expect(screen.getByLabelText("filtered_speech 2 화자")).toHaveValue("Radio");
```

- [ ] **Step 2: Run focused renderer test and verify failure**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: fail because speaker UI does not exist.

- [ ] **Step 3: Implement review item state**

In `createEditableItems`, set:

```ts
speakerCandidates: bubble.speakerCandidates,
selectedSpeaker: getDefaultSelectedSpeaker(bubble.speakerCandidates)
```

For non-speech:

```ts
speakerCandidates: textRegion.speakerCandidates,
selectedSpeaker: getDefaultSelectedSpeaker(textRegion.speakerCandidates)
```

Add helper:

```ts
function getDefaultSelectedSpeaker(candidates: SpeakerCandidate[]): string {
  return candidates[0]?.speaker ?? "";
}
```

- [ ] **Step 4: Implement speaker controls**

Inside each review item, render a compact speaker block between checkbox and textarea:

```tsx
<div className="speech-review-speaker">
  <label>
    <span>화자</span>
    <input
      aria-label={`${item.textType} ${item.readingOrder} 화자`}
      value={item.selectedSpeaker}
      onChange={(event) => onUpdateItem(item.reviewId, { selectedSpeaker: event.target.value })}
      list={`speaker-candidates-${item.reviewId}`}
    />
  </label>
  <datalist id={`speaker-candidates-${item.reviewId}`}>
    {item.speakerCandidates.map((candidate) => (
      <option value={candidate.speaker} key={`${item.reviewId}-${candidate.speaker}`} />
    ))}
  </datalist>
  <div className="speech-review-speaker-candidates" aria-label={`${item.textType} ${item.readingOrder} 화자 후보`}>
    {item.speakerCandidates.map((candidate) => (
      <button
        type="button"
        className={candidate.confidence < 0.7 || candidate.speaker.toLowerCase() === "unknown" ? "low-confidence" : undefined}
        key={`${item.reviewId}-${candidate.speaker}-${candidate.confidence}`}
        title={candidate.reason}
        onClick={() => onUpdateItem(item.reviewId, { selectedSpeaker: candidate.speaker })}
      >
        {candidate.speaker} {Math.round(candidate.confidence * 100)}%
      </button>
    ))}
  </div>
  {item.speakerCandidates[0]?.reason ? <small>{item.speakerCandidates[0].reason}</small> : null}
</div>
```

Keep textarea, checkbox, and group logic unchanged.

- [ ] **Step 5: Add CSS**

In `src/renderer/styles.css`, add compact styles near existing `.speech-review-*` rules:

```css
.speech-review-speaker {
  display: grid;
  gap: 0.4rem;
}

.speech-review-speaker label {
  display: grid;
  gap: 0.25rem;
  font-size: 0.85rem;
  color: var(--muted-text);
}

.speech-review-speaker input {
  width: 100%;
}

.speech-review-speaker-candidates {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.speech-review-speaker-candidates button {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 0.25rem 0.45rem;
  background: var(--panel-bg);
}

.speech-review-speaker-candidates button.low-confidence {
  border-color: #d97706;
  color: #92400e;
}
```

Use existing CSS variables if names differ; do not introduce a new theme system.

- [ ] **Step 6: Run focused renderer test and verify pass**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: pass.

## Task 5: Apply Selected Speaker to Dialogue Lines

**Files:**
- Modify: `src/renderer/App.tsx`
- Test: `tests/renderer/App.test.tsx`

**Interfaces:**
- Consumes: `SpeechBubbleReviewItem.selectedSpeaker`
- Produces: `DialogueLine.speaker`

- [ ] **Step 1: Write failing apply assertions**

In the OCR review/apply test, after applying and selecting created lines:

```ts
fireEvent.click(screen.getByLabelText("원문 2"));
fireEvent.click(screen.getByText("라인 메타"));
expect(screen.getByLabelText("화자")).toHaveValue("Ren");

fireEvent.click(screen.getByLabelText("원문 3"));
expect(screen.getByLabelText("화자")).toHaveValue("Radio");

fireEvent.click(screen.getByLabelText("원문 4"));
expect(screen.getByLabelText("화자")).toHaveValue("Narrator");
```

Add unknown/low confidence warning expectation:

```ts
expect((screen.getByLabelText("파서 경고") as HTMLTextAreaElement).value).toContain("화자 후보");
```

- [ ] **Step 2: Run focused renderer test and verify failure**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: fail because `DialogueLine.speaker` is not set.

- [ ] **Step 3: Implement speaker apply**

In `createDialogueLineFromBubble`, add:

```ts
const speaker = args.item.selectedSpeaker.trim();
```

Return:

```ts
speaker: speaker || undefined,
```

Preserve existing fields:

```ts
sourceText: args.text,
dialogueType: mapOcrTextTypeToDialogueType(args.item.textType),
notes: args.item.notes || undefined,
parseConfidence: args.item.confidence,
parseWarnings
```

- [ ] **Step 4: Add speaker warnings without changing dialogueType**

Update `getSpeechBubbleWarnings`:

```ts
const selected = item.selectedSpeaker.trim().toLowerCase();
const selectedCandidate = item.speakerCandidates.find(
  (candidate) => candidate.speaker.trim().toLowerCase() === selected
);
if (selected === "unknown") warnings.push("화자 후보가 unknown입니다.");
if (selectedCandidate && selectedCandidate.confidence < 0.7) {
  warnings.push(`화자 후보 신뢰도가 낮습니다: ${selectedCandidate.speaker} ${Math.round(selectedCandidate.confidence * 100)}%.`);
}
if (selectedCandidate?.reason) warnings.push(`화자 후보 근거: ${selectedCandidate.reason}`);
```

Keep existing OCR confidence/text/notes warnings unchanged.

- [ ] **Step 5: Pass characters to validation request**

In `extractSpeechBubblesFromCurrentPage`, update validation call:

```ts
const validatedExtraction = await window.projectApi.validateSpeechBubbles({
  projectFilePath: requestFilePath,
  pageImage: requestPageImage,
  geminiExtraction,
  characters: project.characters
});
```

Update existing test expectation at `tests/renderer/App.test.tsx:535` to include:

```ts
characters: expect.any(Array)
```

- [ ] **Step 6: Run focused renderer test and verify pass**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: pass.

## Task 6: Regression Coverage for Existing Group and Apply Policies

**Files:**
- Modify only tests if gaps remain: `tests/renderer/App.test.tsx`, `tests/main/geminiSpeechBubbleExtraction.test.ts`, `tests/shared/speechBubbleReocr.test.ts`

**Interfaces:**
- Consumes: all prior tasks
- Produces: confidence that existing OCR review policies remain intact

- [ ] **Step 1: Confirm speech/default group behavior remains tested**

Ensure existing assertions still cover:

```ts
expect(screen.getByLabelText("thought_bubble 1 적용")).toBeChecked();
expect(screen.getByLabelText("filtered_speech 2 적용")).toBeChecked();
expect(screen.getByLabelText("narration_box 3 적용")).not.toBeChecked();
expect(screen.getByLabelText("screen_text 4 적용")).not.toBeChecked();
```

- [ ] **Step 2: Confirm dialogue type mapping remains tested**

Ensure existing assertions still cover:

```ts
expect(screen.getByLabelText("라인 유형")).toHaveValue("narration");
```

Do not add a new `dialogueType`.

- [ ] **Step 3: Confirm crop reOCR prompt remains scoped**

Keep existing assertions:

```ts
expect(prompt).toContain("OCR only this single crop image");
expect(prompt).toContain("Do not translate");
```

Do not add speaker inference to crop reOCR prompt because crop-only context is insufficient and the user asked speaker inference to be image/page/context based.

- [ ] **Step 4: Run targeted suite**

Run:

```powershell
npm test -- tests/main/geminiSpeechBubbleExtraction.test.ts tests/main/openAiSpeechBubbleValidation.test.ts tests/shared/speechBubbleReocr.test.ts tests/main/ipcHandlers.integration.test.ts tests/renderer/App.test.tsx
```

Expected: pass.

## Task 7: Final Verification

**Files:**
- No code changes in this task.

**Interfaces:**
- Consumes: completed implementation
- Produces: final pass/fail report

- [ ] **Step 1: Run typecheck**

Run from `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor`:

```powershell
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 2: Run full tests**

Run:

```powershell
npm test
```

Expected: exit code 0.

- [ ] **Step 3: Run build**

Run:

```powershell
npm run build
```

Expected: exit code 0.

- [ ] **Step 4: UI verification with gstack if available**

Start app/dev server only after implementation:

```powershell
npm run dev
```

Verify these UI paths:

- OCR button is still visible and starts OCR.
- OCR review modal opens.
- Each OCR item still has checkbox and text textarea.
- Speaker candidate buttons/input are visible.
- Candidate click updates the speaker input immediately.
- Optional narration/caption item can be selected and applies with selected speaker.
- Apply closes modal and creates dialogue lines with source text, dialogue type, notes/warnings, bbox-derived position, and selected speaker.

If gstack cannot attach to Electron UI, record that limitation and rely on Testing Library coverage plus manual command.

## Acceptance Criteria

1. `speechBubbles` OCR JSON accepts and normalizes `speakerCandidates` with 1-3 `{ speaker, confidence, reason }` candidates.
2. Invalid candidate entries are ignored, blank speakers are removed, confidence is clamped to `0..1`, and candidate count is capped at 3.
3. extraction/validation prompts require speaker candidates, forbid speaker finalization, require visual/context evidence, allow `unknown`, and forbid translation.
4. Current project character context is passed to validation prompt when available without changing the saved project schema.
5. OCR review modal displays candidate buttons/input for each OCR item without removing existing checkbox, textarea, notes, confidence, or grouping behavior.
6. User can click a candidate button or type a speaker manually, and the editable review item reflects that value immediately.
7. Applying review items creates dialogue lines whose `speaker` equals the selected/manual speaker.
8. `sourceText`, `dialogueType`, `notes`, `parseWarnings`, `position` from bbox/readingOrder, and existing group default selection behavior remain intact.
9. Low-confidence or `unknown` speaker selections surface review evidence through UI and/or parse warnings.
10. Crop reOCR still only updates text/confidence/notes and preserves speaker candidate data from the whole-page validation result.
11. `npm run typecheck`, `npm test`, and `npm run build` pass after implementation.

## Out of Scope

- No saved project schema migration.
- No new `dialogueType`.
- No external package addition.
- No replacement of existing Gemini/OpenAI IPC names.
- No automatic speaker finalization outside the review modal.
- No speaker inference from crop-only reOCR.
- No redesign of the full review modal layout beyond compact candidate controls.

## Rollback Plan

Revert the implementation commit(s). Because the plan keeps speaker data review-only and does not change saved project schema, rollback should not require migration or project file repair.

## Self-Review

- Spec coverage: covered model candidate shape, prompt requirements, character context, review UI, apply flow, crop reOCR preservation, and full verification.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: `SpeakerCandidate`, `OcrCharacterContext`, `speakerCandidates`, and `selectedSpeaker` names are consistent across tasks.
- Risk: current worktree is dirty and contains existing OCR feature changes. Implementer must not revert unrelated changes and should inspect conflicts before editing touched files.
