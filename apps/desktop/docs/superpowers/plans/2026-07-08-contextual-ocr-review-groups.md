# Contextual OCR Review Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Gemini/GPT page OCR so translation-relevant non-dialogue text is extracted, reviewed in separate groups, and only checked items become project dialogue lines.

**Architecture:** Keep the current IPC flow (`extractSpeechBubbles` then `validateSpeechBubbles`) and current project `DialogueLine.dialogueType` union. Expand the shared OCR result type around `speechBubbles` plus `nonSpeechText`, normalize model output into the requested OCR categories, and let the review dialog convert selected OCR items into lines through explicit dialogue type mapping.

**Tech Stack:** Electron, React 19, TypeScript, Vitest, Testing Library, Gemini Interactions API, OpenAI Responses API.

## Global Constraints

- Windows development environment; commands below are PowerShell commands run from `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor`.
- Do not add a new `DialogueLine.dialogueType`; map OCR categories to existing `speech | thought | narration | unknown`.
- Avoid schema-scale changes; extend `nonSpeechText.type` and the existing OCR result shape only.
- Preserve existing IPC names and Gemini -> GPT flow.
- Do not delete existing lines when OCR results are applied; append checked items only.
- Do not touch unrelated dirty worktree changes.
- Do not add packages, migrations, security changes, deployment changes, or large refactors.

---

## Verified Current State

Checked on 2026-07-08 in `.worktrees\codex-mvp-editor`.

| File | Current behavior |
|------|------------------|
| `src/shared/speechBubbleExtraction.ts` | `NonSpeechTextType` only supports `caption`, `narration_box`, `background_text`, `sound_effect`, `sign`, `unknown`; prompt asks for speech bubbles only. |
| `src/renderer/components/SpeechBubbleReviewDialog.tsx` | Builds editable items only from `result.speechBubbles`; `nonSpeechText` is read-only in a details block. |
| `src/renderer/App.tsx` | `applySpeechBubbleReview()` appends lines, but `createDialogueLineFromBubble()` always sets `dialogueType: "speech"`. |
| `tests/main/geminiSpeechBubbleExtraction.test.ts` | Verifies prompt contains the old speech-bubble-only instruction and normalization keeps old `sound_effect`. |
| `tests/main/openAiSpeechBubbleValidation.test.ts` | Verifies validation prompt and non-speech normalization. |
| `tests/renderer/App.test.tsx` | Verifies the Gemini -> GPT -> review modal -> append line flow for speech bubbles only. |

Root cause: OCR categories are not represented as first-class extraction item types in the renderer. The model prompts, normalizer, modal state, and line creation function all assume only speech bubbles can be applied.

## File Structure

- Modify `src/shared/speechBubbleExtraction.ts`: define OCR category unions, expand `nonSpeechTextTypes`, add `type`/`notes`/`readingOrder` to normalized items where needed, classify speech-capable categories, and update Gemini/GPT prompts.
- Modify `src/renderer/components/SpeechBubbleReviewDialog.tsx`: create a unified review item model, render three grouped sections, default-select only speech-capable items, and submit checked items.
- Modify `src/renderer/App.tsx`: accept unified review items, map OCR category to existing `DialogueLine.dialogueType`, preserve notes/warnings, and keep appending lines.
- Modify `src/renderer/styles.css`: support grouped modal layout without changing the app shell.
- Modify tests in `tests/main/*.test.ts` and `tests/renderer/App.test.tsx`: TDD coverage for prompt category policy, normalization, grouped review, mapping, and append behavior.

## Spec

OCR category model:

```ts
export type OcrTextType =
  | "speech_bubble"
  | "thought_bubble"
  | "filtered_speech"
  | "narration_box"
  | "caption_time_place"
  | "sign_or_label"
  | "handwritten_note"
  | "letter_or_document"
  | "screen_text"
  | "ui_text"
  | "sound_effect"
  | "decorative_text"
  | "background_noise_text"
  | "unknown";
```

Speech-capable items stay in `speechBubbles`: `speech_bubble`, `thought_bubble`, `filtered_speech`.

Everything else stays in `nonSpeechText`, with `type` distinguishing the category. Compatibility aliases from existing model responses should normalize as:

```ts
caption -> caption_time_place
background_text -> background_noise_text
sign -> sign_or_label
```

Project line mapping:

```ts
speech_bubble -> speech
filtered_speech -> speech
thought_bubble -> thought
narration_box -> narration
caption_time_place -> narration
handwritten_note -> unknown
letter_or_document -> unknown
all other checked context text -> unknown
```

Review groups:

1. 기본 적용 대상: `speech_bubble`, `thought_bubble`, `filtered_speech`; checked by default.
2. 선택 적용 가능: `narration_box`, `caption_time_place`, `handwritten_note`, `letter_or_document`; unchecked by default.
3. 문맥 참고 / 기본 제외: `sign_or_label`, `screen_text`, `ui_text`, `sound_effect`, `decorative_text`, `background_noise_text`, `unknown`; unchecked by default, collapsed if possible.

## Task 1: Shared OCR Types, Normalization, and Prompts

**Files:**
- Modify: `src/shared/speechBubbleExtraction.ts`
- Test: `tests/main/geminiSpeechBubbleExtraction.test.ts`
- Test: `tests/main/openAiSpeechBubbleValidation.test.ts`

**Interfaces:**
- Produces: `OcrTextType`, `speechBubbleTextTypes`, `optionalApplyTextTypes`, `contextOnlyTextTypes`, normalized `ExtractedSpeechBubble.type`, normalized `ExtractedNonSpeechText.notes`, normalized `ExtractedNonSpeechText.readingOrder`.
- Consumes: existing `SpeechBubbleExtractionResult`.

- [ ] **Step 1: Write failing tests for expanded category normalization and prompt policy**

Add assertions to existing main tests:

```ts
expect(requestBody.input[0]?.text).toContain("speech_bubble");
expect(requestBody.input[0]?.text).toContain("thought_bubble");
expect(requestBody.input[0]?.text).toContain("filtered_speech");
expect(requestBody.input[0]?.text).toContain("caption_time_place");
expect(requestBody.input[0]?.text).toContain("Do not translate");
```

Add a normalizer-focused expectation in the Gemini JSON test:

```ts
speechBubbles: [{ text: "thinking", type: "thought_bubble", language: "en", bbox: {}, readingOrder: 1, confidence: 0.7 }],
nonSpeechText: [
  { type: "caption", text: "Later", bbox: {}, confidence: 0.8, notes: "old alias" },
  { type: "screen_text", text: "CALL", bbox: {}, confidence: 0.6, notes: "phone UI", readingOrder: 5 }
]
```

Expected result:

```ts
expect(result.speechBubbles[0]?.type).toBe("thought_bubble");
expect(result.nonSpeechText[0]?.type).toBe("caption_time_place");
expect(result.nonSpeechText[0]?.notes).toBe("old alias");
expect(result.nonSpeechText[1]?.type).toBe("screen_text");
expect(result.nonSpeechText[1]?.readingOrder).toBe(5);
```

Add OpenAI prompt assertions:

```ts
expect(requestBody.input[0]?.content[0]?.text).toContain("Move narration_box and caption_time_place to nonSpeechText");
expect(requestBody.input[0]?.content[0]?.text).toContain("sound_effect");
expect(requestBody.input[0]?.content[0]?.text).toContain("[?]");
```

- [ ] **Step 2: Run red tests**

Run:

```powershell
npm test -- tests/main/geminiSpeechBubbleExtraction.test.ts tests/main/openAiSpeechBubbleValidation.test.ts
```

Expected: FAIL because old prompts and types do not include the new categories.

- [ ] **Step 3: Implement shared OCR types, aliases, and prompts**

In `src/shared/speechBubbleExtraction.ts`, replace the non-speech type union with `OcrTextType`, keep `NonSpeechTextType = Exclude<OcrTextType, SpeechBubbleTextType>`, add speech bubble `type`, add non-speech `notes` and `readingOrder`, and update both prompt constants with the full category policy.

- [ ] **Step 4: Run green tests**

Run:

```powershell
npm test -- tests/main/geminiSpeechBubbleExtraction.test.ts tests/main/openAiSpeechBubbleValidation.test.ts
```

Expected: PASS.

## Task 2: Review Dialog Grouping and Selection

**Files:**
- Modify: `src/renderer/components/SpeechBubbleReviewDialog.tsx`
- Modify: `src/renderer/styles.css`
- Test: `tests/renderer/App.test.tsx`

**Interfaces:**
- Produces: `SpeechBubbleReviewItem` with `textType`, `text`, `bbox`, `confidence`, `notes`, `source`.
- Consumes: `SpeechBubbleExtractionResult`.

- [ ] **Step 1: Write failing renderer test for grouped review and default selections**

Extend the OCR renderer test to include:

```ts
speechBubbles: [
  { id: "bubble-001", type: "thought_bubble", text: "考え中", language: "ja", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, readingOrder: 1, confidence: 0.91, notes: "inner monologue" },
  { id: "bubble-002", type: "filtered_speech", text: "ザザ...聞こえる?", language: "ja", bbox: { x: 0.2, y: 0.4, width: 0.3, height: 0.1 }, readingOrder: 2, confidence: 0.72, notes: "radio" }
],
nonSpeechText: [
  { type: "narration_box", text: "翌朝", bbox: { x: 0.1, y: 0.05, width: 0.4, height: 0.08 }, confidence: 0.88, notes: "box", readingOrder: 3 },
  { type: "screen_text", text: "CALL", bbox: { x: 0.7, y: 0.2, width: 0.1, height: 0.08 }, confidence: 0.81, notes: "phone", readingOrder: 4 }
]
```

Assert:

```ts
expect(screen.getByText("기본 적용 대상")).toBeInTheDocument();
expect(screen.getByText("선택 적용 가능")).toBeInTheDocument();
expect(screen.getByText("문맥 참고 / 기본 제외")).toBeInTheDocument();
expect(screen.getByLabelText("thought_bubble 1 적용")).toBeChecked();
expect(screen.getByLabelText("filtered_speech 2 적용")).toBeChecked();
expect(screen.getByLabelText("narration_box 3 적용")).not.toBeChecked();
expect(screen.getByLabelText("screen_text 4 적용")).not.toBeChecked();
expect(screen.getByLabelText("thought_bubble 1 원문")).toHaveValue("考え中");
expect(screen.getByText("inner monologue")).toBeInTheDocument();
```

- [ ] **Step 2: Run red renderer test**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: FAIL because the dialog does not render groups or non-speech editable items.

- [ ] **Step 3: Implement grouped modal**

Convert `SpeechBubbleReviewDialog` to build editable review items from both arrays, render group sections, and default-select only `speech_bubble`, `thought_bubble`, and `filtered_speech`. Use `<details>` for the context-only group and keep textarea/type/confidence/bbox/notes visible per item.

- [ ] **Step 4: Add CSS for grouped modal**

Add scoped styles for `.speech-review-group`, `.speech-review-group-heading`, `.speech-review-item-meta`, and context details. Keep the modal within current max width and scrolling behavior.

- [ ] **Step 5: Run green renderer test**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: PASS.

## Task 3: Apply Checked OCR Items With Dialogue Mapping and Warnings

**Files:**
- Modify: `src/renderer/App.tsx`
- Test: `tests/renderer/App.test.tsx`

**Interfaces:**
- Consumes: `SpeechBubbleReviewItem[]`.
- Produces: appended `DialogueLine[]` with mapped `dialogueType`, `position`, `notes`, `parseConfidence`, and `parseWarnings`.

- [ ] **Step 1: Write failing assertions for mapping and preserving old lines**

In the grouped OCR test, pre-load one existing line in `openedProjectWithImages`, check `narration_box`, edit its text, leave `screen_text` unchecked, then apply:

```ts
fireEvent.click(screen.getByLabelText("narration_box 3 적용"));
fireEvent.change(screen.getByLabelText("narration_box 3 원문"), { target: { value: "翌朝、駅で" } });
fireEvent.click(screen.getByRole("button", { name: "현재 페이지에 적용" }));
expect(await screen.findByLabelText("원문 1")).toHaveValue("Existing line");
expect(screen.getByLabelText("원문 2")).toHaveValue("考え中");
expect(screen.getByLabelText("원문 3")).toHaveValue("ザザ...聞こえる?");
expect(screen.getByLabelText("원문 4")).toHaveValue("翌朝、駅で");
fireEvent.click(screen.getByLabelText("원문 4"));
fireEvent.click(screen.getByText("라인 메타"));
expect(screen.getByLabelText("라인 유형")).toHaveValue("narration");
```

Assert low-confidence/notes warnings for the filtered speech line:

```ts
fireEvent.click(screen.getByLabelText("원문 3"));
expect(screen.getByLabelText("파서 경고")).toHaveValue(expect.stringContaining("OCR"));
expect(screen.getByLabelText("상세 메모")).toHaveValue("radio");
```

- [ ] **Step 2: Run red renderer test**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: FAIL because all created lines are currently `speech` and non-speech items cannot be applied.

- [ ] **Step 3: Implement mapping and warnings**

Replace `createDialogueLineFromBubble()` with a generic OCR item factory. Map `textType` to existing `DialogueType`, use `position` as `${textType} ${readingOrder} (...)`, keep notes, and generate warnings when confidence < 0.75, text contains `[?]`, or notes exist.

- [ ] **Step 4: Run green renderer test**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: PASS.

## Task 4: Final Verification

**Files:**
- No code edits unless verification exposes a focused defect.

- [ ] **Step 1: Typecheck**

Run:

```powershell
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 2: Test suite**

Run:

```powershell
npm test
```

Expected: exit code 0.

- [ ] **Step 3: Production build**

Run:

```powershell
npm run build
```

Expected: exit code 0.

- [ ] **Step 4: Optional UI smoke with gstack/browser**

If the dev server and browser tooling are available, run:

```powershell
npm run dev
```

Then verify the first screen renders and the page image panel still exposes the `말풍선 OCR` button. If browser tooling is unavailable or the OCR modal needs API keys/images, record that limitation.

## Acceptance Criteria

1. Gemini prompt asks for all 14 requested OCR categories and says not to translate.
2. GPT validation prompt asks to separate speech, thought, filtered speech, narration/caption, document/note, screen/UI/sign, effects/decorative/background text.
3. `speechBubbles` contains only `speech_bubble`, `thought_bubble`, and `filtered_speech` after normalization.
4. Other recognized categories are preserved in `nonSpeechText.type`.
5. The review modal shows the three requested groups with per-item checkbox, textarea, type, confidence, bbox, and notes.
6. Only the first group is checked by default.
7. Applying checked items appends lines without deleting existing project lines.
8. Dialogue type mapping matches the requested table and does not add a new `DialogueLine.dialogueType`.
9. Low confidence, `[?]`, and notes are retained through `parseWarnings` and/or `notes`.
10. `npm run typecheck`, `npm test`, and `npm run build` are run and reported.

## Out of Scope

- New database or project file schema version.
- New IPC names.
- New package dependencies.
- Automatic translation of OCR text.
- Automatic application of context-only text without user checkbox selection.
