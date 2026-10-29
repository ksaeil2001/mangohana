# Gemini Crop ReOCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve one-page Gemini OCR accuracy by selectively re-OCRing only uncertain detected text regions from bbox crops, then surfacing the merge rationale in the existing review modal.

**Architecture:** Keep the current renderer flow: `extractSpeechBubbles` runs whole-image Gemini OCR, `validateSpeechBubbles` runs provider validation, and the existing review dialog receives a `SpeechBubbleExtractionResult`. Add main-process helpers for target selection and conservative merge, add Electron-native image cropping, then run crop ReOCR inside `project:validateSpeechBubbles` only when `GEMINI_API_KEY` is configured. Do not add a new IPC, dialogue type, or large schema.

**Tech Stack:** Electron main process, TypeScript, React renderer, Vitest, Gemini `v1beta/interactions`, Electron `nativeImage` for image crops.

## Global Constraints

- Development environment is Windows; commands below are PowerShell commands run from `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor`.
- Do not print API keys, passwords, tokens, or personal data.
- Do not revert dirty worktree changes; existing uncommitted files must be preserved.
- No new package unless Electron `nativeImage` is proven insufficient and user approves first.
- Preserve existing IPC names and renderer flow where possible.
- Do not add a new `dialogueType`.
- Preserve existing OCR classification and review-modal grouping policy.
- First OCR and validation prompts must remain grounded in a single current page image.
- Crop ReOCR prompt must state that only the crop image is the OCR target and must not infer from other areas.
- Translation is out of scope.
- Final verification commands: `npm run typecheck`, `npm test`, `npm run build`; run UI verification with gstack if feasible.

---

## Verified Current State

| File | Observed State |
|------|----------------|
| `src/shared/speechBubbleExtraction.ts` | Defines `SpeechBubbleExtractionResult`, bbox/readingOrder/confidence/notes, whole-image extraction prompt, and validation prompt. Validation already says the original page image is the single source. |
| `src/main/geminiSpeechBubbleExtraction.ts` | Contains `extractSpeechBubblesWithGemini` and `validateSpeechBubblesWithGemini`, both posting image+prompt to Gemini and normalizing JSON. |
| `src/main/openAiSpeechBubbleValidation.ts` | Existing fallback validator using OpenAI when Gemini key is not configured. |
| `src/main/ipcHandlers.ts` | `project:extractSpeechBubbles` reads one stored page image and calls Gemini. `project:validateSpeechBubbles` reads the same stored page image and already prefers Gemini validation when `GEMINI_API_KEY` exists, otherwise OpenAI. |
| `src/renderer/App.tsx` | Renderer calls `extractSpeechBubbles`, then `validateSpeechBubbles`, then shows `SpeechBubbleReviewDialog`; no renderer crop hook exists. |
| `src/renderer/components/SpeechBubbleReviewDialog.tsx` | Existing modal displays result warnings and per-item notes; grouping depends only on existing text types. |
| `tests/main/geminiSpeechBubbleExtraction.test.ts` | Tests Gemini extraction and validation request shapes and prompt requirements. |
| `tests/main/ipcHandlers.integration.test.ts` | Tests Gemini extraction, OpenAI fallback validation, and Gemini-priority validation when only Gemini key is configured. |
| `tests/renderer/App.test.tsx` | Tests OCR button, review modal, optional non-speech selection, and apply flow. |

## Root Cause

The current pipeline has only whole-image OCR and whole-image validation. If Gemini returns a low-confidence region or `[?]`, there is no second narrow pass over the original bbox crop, so the review modal can only expose the uncertain whole-image result. Because `project:validateSpeechBubbles` already owns the provider validation step and has access to the original image bytes, it is the smallest place to add Gemini-only selective crop ReOCR without changing the renderer or IPC surface.

## File Structure

- Create `src/shared/speechBubbleReocr.ts`: pure helper functions and types for selecting uncertain regions and merging crop results.
- Create `tests/shared/speechBubbleReocr.test.ts`: unit tests for selection and merge behavior.
- Modify `src/shared/speechBubbleExtraction.ts`: add crop prompt builder and crop result normalizer; keep existing result schema unchanged.
- Modify `src/main/geminiSpeechBubbleExtraction.ts`: add `reocrSpeechBubbleCropWithGemini` using the crop prompt and same Gemini request parser.
- Create `src/main/imageCrop.ts`: Electron `nativeImage` crop utility that converts normalized bbox plus padding into PNG bytes.
- Create `tests/main/imageCrop.test.ts`: unit tests for bbox-to-pixel clamping via an injected image adapter or exported rectangle helper.
- Modify `src/main/ipcHandlers.ts`: after provider validation, if Gemini key exists, select uncertain targets, crop those regions, call Gemini crop ReOCR, merge, and return the merged result.
- Modify `tests/main/geminiSpeechBubbleExtraction.test.ts`: add crop ReOCR request/prompt/normalization tests.
- Modify `tests/main/ipcHandlers.integration.test.ts`: add Gemini-only end-to-end provider routing test covering whole OCR, Gemini validation, and crop ReOCR calls.
- Modify `tests/renderer/App.test.tsx`: keep or add a review/apply regression where merged notes/warnings appear and applying reviewed lines still works.

### Interface Targets

```ts
export type ReocrTargetKind = "speechBubbles" | "nonSpeechText";

export type ReocrTarget = {
  kind: ReocrTargetKind;
  index: number;
  type: OcrTextType;
  text: string;
  bbox: NormalizedBbox;
  readingOrder: number;
  confidence: number;
  notes: string;
};

export type CropReocrResult = {
  text: string;
  confidence: number;
  notes: string;
};

export function selectCropReocrTargets(
  result: SpeechBubbleExtractionResult,
  options?: { confidenceThreshold?: number }
): ReocrTarget[];

export function mergeCropReocrResults(
  result: SpeechBubbleExtractionResult,
  cropResults: Array<{ target: ReocrTarget; result: CropReocrResult }>
): SpeechBubbleExtractionResult;

export function buildSpeechBubbleCropReocrPrompt(target: ReocrTarget): string;

export async function reocrSpeechBubbleCropWithGemini(args: {
  cropImageBytes: Buffer;
  sourceMimeType: string;
  target: ReocrTarget;
}): Promise<CropReocrResult>;

export function cropImageToPng(args: {
  imageBytes: Buffer;
  bbox: NormalizedBbox;
  paddingRatio?: number;
}): Buffer;
```

### Merge Rules

- Target selection includes only `speechBubbles` and `nonSpeechText`.
- Select if `confidence < 0.75` or `text.includes("[?]")`.
- Preserve `bbox`, `type`, `readingOrder`, and speech bubble `id/language`.
- Prefer crop text when it reduces `[?]`.
- If crop text differs from existing text, append a warning unless the only meaningful change is reducing `[?]`.
- Append notes such as `Crop ReOCR applied: reduced uncertainty from "..." to "..."; crop confidence 0.84.`
- Confidence update is conservative: when applying crop text use `Math.min(Math.max(original.confidence, crop.confidence), 0.95)`; when not applying keep original confidence or lower it if crop is less confident.

## Task 1: Pure Selection And Merge Helpers

**Files:**
- Create: `src/shared/speechBubbleReocr.ts`
- Create: `tests/shared/speechBubbleReocr.test.ts`

**Interfaces:**
- Consumes: `SpeechBubbleExtractionResult`, `ExtractedSpeechBubble`, `ExtractedNonSpeechText`.
- Produces: `selectCropReocrTargets`, `mergeCropReocrResults`, `CropReocrResult`, `ReocrTarget`.

- [ ] **Step 1: Write failing tests**

Add tests covering:

```ts
it("selects low-confidence speech and non-speech text for crop reOCR", () => {});
it("selects text containing [?] for crop reOCR", () => {});
it("does not select confident text without uncertainty markers", () => {});
it("applies crop text when it reduces [?]", () => {});
it("records a warning when crop text conflicts with existing text", () => {});
it("preserves bbox type and readingOrder while merging", () => {});
```

Run:

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/shared/speechBubbleReocr.test.ts
```

Expected: fail because the helper file does not exist.

- [ ] **Step 2: Implement minimal helper code**

Create helpers with the interfaces above. Keep all logic pure and independent of Electron, fetch, or environment variables.

- [ ] **Step 3: Run helper tests**

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/shared/speechBubbleReocr.test.ts
```

Expected: pass.

## Task 2: Crop Prompt And Gemini Crop ReOCR

**Files:**
- Modify: `src/shared/speechBubbleExtraction.ts`
- Modify: `src/main/geminiSpeechBubbleExtraction.ts`
- Modify: `tests/main/geminiSpeechBubbleExtraction.test.ts`

**Interfaces:**
- Consumes: `ReocrTarget`.
- Produces: `buildSpeechBubbleCropReocrPrompt`, `normalizeCropReocrResult`, `reocrSpeechBubbleCropWithGemini`.

- [ ] **Step 1: Write failing Gemini crop tests**

Add tests asserting:

```ts
expect(prompt).toContain("OCR only this single crop image");
expect(prompt).toContain("Do not translate");
expect(prompt).toContain("[?]");
expect(prompt).toContain(target.type);
expect(requestBody.input).toHaveLength(2);
expect(requestBody.input[1]).toEqual(expect.objectContaining({ type: "image", mime_type: "image/png" }));
```

Run:

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/main/geminiSpeechBubbleExtraction.test.ts
```

Expected: fail because crop ReOCR is not implemented.

- [ ] **Step 2: Implement crop prompt and Gemini function**

Return strict JSON only:

```json
{ "text": "original text", "confidence": 0.0, "notes": "short uncertainty note" }
```

The prompt must state that classification context is provided only to improve OCR accuracy and that the model must not infer text outside the crop.

- [ ] **Step 3: Run Gemini tests**

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/main/geminiSpeechBubbleExtraction.test.ts
```

Expected: pass.

## Task 3: Electron Crop Utility

**Files:**
- Create: `src/main/imageCrop.ts`
- Create: `tests/main/imageCrop.test.ts`

**Interfaces:**
- Consumes: original image bytes and normalized bbox.
- Produces: PNG crop bytes for Gemini.

- [ ] **Step 1: Write failing crop rectangle tests**

Test that padding expands bbox, clamps to image bounds, and produces at least a 1x1 crop rectangle for tiny boxes.

Run:

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/main/imageCrop.test.ts
```

Expected: fail because `imageCrop.ts` does not exist.

- [ ] **Step 2: Implement with Electron nativeImage**

Use:

```ts
import { nativeImage } from "electron";
```

Implementation shape:

```ts
const image = nativeImage.createFromBuffer(args.imageBytes);
const size = image.getSize();
const rect = buildPaddedCropRect(args.bbox, size, args.paddingRatio ?? 0.08);
return image.crop(rect).toPNG();
```

- [ ] **Step 3: Run crop tests**

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/main/imageCrop.test.ts
```

Expected: pass.

## Task 4: Wire Crop ReOCR Into Validation IPC

**Files:**
- Modify: `src/main/ipcHandlers.ts`
- Modify: `tests/main/ipcHandlers.integration.test.ts`

**Interfaces:**
- Consumes: validated `SpeechBubbleExtractionResult` and original image bytes.
- Produces: final merged result returned by existing `project:validateSpeechBubbles`.

- [ ] **Step 1: Write failing integration test**

Add a test where:

1. `GEMINI_API_KEY` is set and `OPENAI_API_KEY` is unset.
2. Whole extraction call returns one low-confidence or `[?]` item.
3. Validation call returns the uncertain item.
4. Crop ReOCR call returns clearer text.
5. The final `project:validateSpeechBubbles` result contains the clearer text, preserved bbox/type/readingOrder, and crop notes or warnings.

Run:

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/main/ipcHandlers.integration.test.ts
```

Expected: fail because validation returns provider output without crop ReOCR.

- [ ] **Step 2: Implement main-process orchestration**

Inside `project:validateSpeechBubbles`:

```ts
const validated = hasGeminiApiKey()
  ? await validateSpeechBubblesWithGemini(validationArgsForProvider)
  : await validateSpeechBubblesWithOpenAI(validationArgsForProvider);

if (!hasGeminiApiKey()) return validated;

const targets = selectCropReocrTargets(validated);
if (targets.length === 0) return validated;

const cropResults = [];
for (const target of targets) {
  const cropImageBytes = cropImageToPng({ imageBytes, bbox: target.bbox, paddingRatio: 0.08 });
  const result = await reocrSpeechBubbleCropWithGemini({ cropImageBytes, sourceMimeType: "image/png", target });
  cropResults.push({ target, result });
}
return mergeCropReocrResults(validated, cropResults);
```

Keep the existing OpenAI fallback unchanged.

- [ ] **Step 3: Run integration tests**

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/main/ipcHandlers.integration.test.ts
```

Expected: pass.

## Task 5: Renderer Review/Apply Regression

**Files:**
- Modify: `tests/renderer/App.test.tsx`
- Modify only if necessary: `src/renderer/App.tsx` or `src/renderer/components/SpeechBubbleReviewDialog.tsx`

**Interfaces:**
- Consumes: existing `SpeechBubbleExtractionResult` with crop notes/warnings.
- Produces: unchanged review modal and apply behavior.

- [ ] **Step 1: Add or adjust failing regression test**

Use the existing OCR review test and include a validated result with:

```ts
notes: "Crop ReOCR applied: reduced uncertainty from \"聞こ[?]る\" to \"聞こえる\"; crop confidence 0.84."
warnings: ["Crop ReOCR disagreement for #2: whole image \"A\" vs crop \"B\"."]
```

Assert that notes/warnings render and applying still creates dialogue lines.

- [ ] **Step 2: Run renderer test**

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/App.test.tsx
```

Expected: pass without renderer code changes. If it fails only because notes are not visible, make the smallest modal rendering fix.

## Task 6: Full Verification

**Files:**
- No code files unless verification finds a defect.

- [ ] **Step 1: Typecheck**

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm run typecheck
```

Expected: pass.

- [ ] **Step 2: Test**

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test
```

Expected: pass.

- [ ] **Step 3: Build**

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm run build
```

Expected: pass.

- [ ] **Step 4: UI verification**

If gstack is available, run the app and verify:

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm run dev
```

Use gstack or Playwright against `http://localhost:4173` to check:

1. The `말풍선 OCR` button is still visible and clickable.
2. The OCR review modal opens for a mocked/available OCR result.
3. `warnings` and per-item `notes` are visible.
4. Selecting optional non-speech text and pressing `현재 페이지에 적용` still adds lines.

## Acceptance Criteria

1. Low-confidence `speechBubbles` and `nonSpeechText` are selected for crop ReOCR.
2. Items containing `[?]` are selected for crop ReOCR.
3. Confident items without `[?]` are not selected.
4. Crop text that reduces `[?]` updates the final item text.
5. Crop text conflicts leave a visible `warnings` or `notes` trace.
6. `bbox`, `type`, and `readingOrder` are preserved after merge.
7. With only `GEMINI_API_KEY`, whole OCR, Gemini validation, and crop ReOCR all use Gemini.
8. Without `GEMINI_API_KEY`, existing OpenAI validation fallback remains unchanged and no crop ReOCR runs.
9. Existing review modal grouping and apply flow continue to pass tests.
10. No API key or secret is printed in logs or test output.

## Rollback Plan

Revert the new helper files and the small `project:validateSpeechBubbles` orchestration change. The renderer and IPC contract remain unchanged, so rollback returns the app to whole-image OCR plus provider validation.

## Out Of Scope

- Adding a new OCR provider.
- Adding new dialogue types.
- Adding persistent crop artifacts to project files.
- Changing review-modal grouping policy.
- Changing page-image import, inpainting, or translation behavior.
- Adding a third-party image-processing dependency without user approval.

## Self-Review

- Spec coverage: all requested pipeline stages are covered by Tasks 1-4; modal/apply regression is covered by Task 5; full verification and UI checks are covered by Task 6.
- Placeholder scan: no task relies on unspecified “appropriate” behavior; selection threshold, merge rules, and commands are explicit.
- Type consistency: `ReocrTarget`, `CropReocrResult`, and helper names are reused consistently across tasks.
