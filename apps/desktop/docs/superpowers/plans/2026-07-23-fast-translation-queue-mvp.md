# Fast Translation Queue MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a newly created Fast project automatically process every page through OCR, validation, Korean translation, and stable project save while isolating failures and supporting pause, retry, and restart recovery.

**Architecture:** Keep orchestration in a focused renderer service that calls the existing OCR/validation IPC methods and one new Gemini page-translation IPC method sequentially. Persist an optional, backward-compatible queue checkpoint in the `.ctp` project after every page transition; normalize interrupted `running` work to `paused/pending` when reopening. Existing manual OCR, review, editing, inpainting, export, and Precise mode remain unchanged.

**Tech Stack:** React 19, Electron 42, TypeScript 6, Vitest 4, Gemini Interactions API, existing encrypted `.ctp` storage

## Global Constraints

- Work from `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기`.
- Complete `2026-07-23-vitest-worktree-exclusion.md` first.
- Do not add packages, change database/security/deployment settings, or modify `package-lock.json`.
- Do not bump `schemaVersion`; all new project fields are optional and old `.ctp` files must open unchanged.
- Never persist or display API keys, provider request bodies, or full internal image paths.
- Reuse the existing Gemini key store and `fetchWithGeminiRetry`; required Gemini calls retain three total attempts.
- Process one page at a time. A page failure must not stop later pending pages.
- Pause only at page boundaries; do not attempt to cancel an in-flight remote request.
- Auto-save after each stable page result. Auto-save failure pauses the queue immediately.
- Do not automatically inpaint, compose, or export images in this MVP.
- Do not change Precise mode behavior.
- Do not delete or bypass the existing manual OCR review flow.

---

## File Structure

### New files

- `src/shared/pageTranslation.ts`: page-translation request/result types, prompt, and strict response normalization.
- `src/main/geminiPageTranslation.ts`: Gemini text request using the existing retry policy.
- `src/renderer/fastTranslationQueue.ts`: pure queue state transitions and sequential coordinator.
- `src/renderer/components/FastTranslationQueuePanel.tsx`: compact progress, pause/resume, and failed-page retry UI.
- Matching unit/component tests under `tests/main`, `tests/shared`, and `tests/renderer`.

### Existing files modified

- `src/shared/projectTypes.ts`: optional queue checkpoint and automated line origin.
- `src/shared/projectValidation.ts`: validate optional fields and recover interrupted work safely.
- `src/main/ipcHandlers.ts`, `src/renderer/electronApi.ts`, `electron/preload.ts`: add one validated translation IPC contract.
- `src/renderer/App.tsx`: start, pause, resume, checkpoint, and display the queue.
- `src/renderer/styles.css`: queue panel layout and status colors.
- `README.md`: state exactly what Fast MVP automates and what remains manual.

---

### Task 1: Add backward-compatible queue checkpoint types

**Files:**
- Modify: `src/shared/projectTypes.ts`
- Modify: `src/shared/projectValidation.ts`
- Modify: `tests/shared/projectValidation.test.ts`

**Interfaces:**
- Produces: `FastTranslationQueueState`, `FastPageJob`, `DialogueLine.automationOrigin`, and `TranslationProject.fastTranslationQueue`.
- Recovery contract: persisted queue/page `running` values normalize to queue `paused` and page `pending`.

- [ ] **Step 1: Add failing validation and recovery tests**

Append these exact cases in `tests/shared/projectValidation.test.ts`:

```ts
import type { TranslationProject } from "../../src/shared/projectTypes";

it("opens legacy projects without a fast queue", () => {
  const project = createEmptyProject("Legacy", false);
  expect(normalizeProject(structuredClone(project)).fastTranslationQueue).toBeUndefined();
});

it("accepts a completed fast queue checkpoint", () => {
  const project = createEmptyProject("Fast", false);
  project.settings.translationMode = "fast";
  project.fastTranslationQueue = {
    runStatus: "completed",
    pages: [{ pageNumber: 1, stage: "complete", status: "completed", attemptCount: 1 }],
    lastStableAt: "2026-07-23T00:00:00.000Z"
  };
  expect(normalizeProject(structuredClone(project)).fastTranslationQueue).toEqual(project.fastTranslationQueue);
});

it("recovers interrupted fast work at the last stable boundary", () => {
  const project = createEmptyProject("Interrupted", false);
  project.fastTranslationQueue = {
    runStatus: "running",
    pages: [{ pageNumber: 2, stage: "translation", status: "running", attemptCount: 1 }]
  };
  const normalized = normalizeProject(structuredClone(project));
  expect(normalized.fastTranslationQueue?.runStatus).toBe("paused");
  expect(normalized.fastTranslationQueue?.pages[0]).toMatchObject({
    pageNumber: 2,
    stage: "translation",
    status: "pending"
  });
});

it("rejects malformed fast queue fields", () => {
  const project = createEmptyProject("Invalid", false) as TranslationProject & { fastTranslationQueue: unknown };
  project.fastTranslationQueue = { runStatus: "teleporting", pages: [] };
  expect(() => normalizeProject(project)).toThrow(/fastTranslationQueue/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기"
npm.cmd test -- tests/shared/projectValidation.test.ts
```

Expected: FAIL because the optional queue and origin types do not exist.

- [ ] **Step 3: Add exact optional project types**

Add to `src/shared/projectTypes.ts`:

```ts
export type FastQueueRunStatus = "idle" | "running" | "paused" | "completed";
export type FastPageStage = "ocr" | "translation" | "complete";
export type FastPageStatus = "pending" | "running" | "completed" | "failed";

export type FastPageJob = {
  pageNumber: number;
  stage: FastPageStage;
  status: FastPageStatus;
  attemptCount: number;
  errorMessage?: string;
};

export type FastTranslationQueueState = {
  runStatus: FastQueueRunStatus;
  pages: FastPageJob[];
  lastStableAt?: string;
};

export type AutomationOrigin = {
  mode: "fast";
  pageImageId: string;
  sourceRegionId: string;
};
```

Add `automationOrigin?: AutomationOrigin` to `DialogueLine` and `fastTranslationQueue?: FastTranslationQueueState` to `TranslationProject`.

- [ ] **Step 4: Validate and recover the optional fields**

In `normalizeProject`, validate `fastTranslationQueue` when present, validate `automationOrigin` when present, then recover interrupted work:

```ts
if (input.fastTranslationQueue !== undefined && !isFastTranslationQueueState(input.fastTranslationQueue)) {
  throw new Error("Invalid project: malformed fastTranslationQueue");
}

if (input.fastTranslationQueue?.runStatus === "running") {
  input.fastTranslationQueue = {
    ...input.fastTranslationQueue,
    runStatus: "paused",
    pages: input.fastTranslationQueue.pages.map((page) =>
      page.status === "running" ? { ...page, status: "pending" } : page
    )
  };
}
```

Use explicit allow-lists for run status, stage, and page status; require positive integer page numbers, non-negative integer attempts, optional strings, and unique page numbers.

- [ ] **Step 5: Run validation tests and typecheck**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기"
npm.cmd test -- tests/shared/projectValidation.test.ts
npm.cmd run typecheck
```

Expected: PASS, including old-project compatibility.

- [ ] **Step 6: Commit the checkpoint model**

```powershell
git add src/shared/projectTypes.ts src/shared/projectValidation.ts tests/shared/projectValidation.test.ts
git commit -m "feat: add resumable fast queue checkpoints"
```

---

### Task 2: Define and normalize page translation contracts

**Files:**
- Create: `src/shared/pageTranslation.ts`
- Create: `tests/shared/pageTranslation.test.ts`

**Interfaces:**
- Produces: `TranslatePageRequest`, `PageTranslationResult`, `buildPageTranslationPrompt`, and `normalizePageTranslationResult`.
- Result IDs must exactly match request IDs; missing, duplicate, or unknown IDs are rejected.

- [ ] **Step 1: Write failing prompt and normalization tests**

```ts
import { describe, expect, it } from "vitest";
import {
  buildPageTranslationPrompt,
  normalizePageTranslationResult,
  type TranslatePageRequest
} from "../../src/shared/pageTranslation";

const request: TranslatePageRequest = {
  pageNumber: 1,
  items: [
    { id: "bubble-1", sourceText: "おはよう", sourceLanguage: "ja", dialogueType: "speech", speaker: "미사키" }
  ],
  dictionaryTerms: [{ source: "先輩", target: "선배", note: "호칭" }],
  previousTranslations: [{ speaker: "미사키", sourceText: "またね", translation: "또 보자" }]
};

it("builds a Korean translation prompt with page context and dictionary", () => {
  const prompt = buildPageTranslationPrompt(request);
  expect(prompt).toContain("Translate into natural Korean");
  expect(prompt).toContain("おはよう");
  expect(prompt).toContain("선배");
  expect(prompt).toContain("또 보자");
});

it("normalizes one translation for every requested id", () => {
  expect(normalizePageTranslationResult({ translations: [
    { id: "bubble-1", translation: "좋은 아침", reviewRequired: false, warnings: [] }
  ]}, request.items)).toEqual({ translations: [
    { id: "bubble-1", translation: "좋은 아침", reviewRequired: false, warnings: [] }
  ]});
});

it("rejects missing or unknown translation ids", () => {
  expect(() => normalizePageTranslationResult({ translations: [] }, request.items)).toThrow(/missing/i);
  expect(() => normalizePageTranslationResult({ translations: [
    { id: "other", translation: "x", reviewRequired: false, warnings: [] }
  ]}, request.items)).toThrow(/unknown/i);
});
```

- [ ] **Step 2: Verify the new tests fail**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기"
npm.cmd test -- tests/shared/pageTranslation.test.ts
```

Expected: FAIL because the shared module is absent.

- [ ] **Step 3: Implement the exact shared types and prompt**

Define:

```ts
export type PageTranslationItem = {
  id: string;
  sourceText: string;
  sourceLanguage: SourceLanguage;
  dialogueType: DialogueType;
  speaker?: string;
};

export type TranslatePageRequest = {
  pageNumber: number;
  items: PageTranslationItem[];
  dictionaryTerms: Array<Pick<DictionaryTerm, "source" | "target" | "note">>;
  previousTranslations: Array<{
    speaker?: string;
    sourceText: string;
    translation: string;
  }>;
};

export type PageTranslation = {
  id: string;
  translation: string;
  reviewRequired: boolean;
  warnings: string[];
};

export type PageTranslationResult = { translations: PageTranslation[] };
```

The prompt must require Korean output, preserve meaning/tone, apply dictionary terms, avoid adding sexual-content censorship or embellishment, keep item IDs unchanged, and return strict JSON only. It must not contain API keys or filesystem paths.

- [ ] **Step 4: Implement strict normalization**

`normalizePageTranslationResult` must:

- require an object with a `translations` array;
- require each requested ID exactly once;
- reject empty translations, duplicate IDs, and unknown IDs;
- default `reviewRequired` to `true` if malformed;
- keep only string warnings;
- return results in request order.

- [ ] **Step 5: Run shared tests and typecheck**

```powershell
npm.cmd test -- tests/shared/pageTranslation.test.ts
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the translation contract**

```powershell
git add src/shared/pageTranslation.ts tests/shared/pageTranslation.test.ts
git commit -m "feat: define fast page translation contract"
```

---

### Task 3: Add Gemini page translation behind validated IPC

**Files:**
- Create: `src/main/geminiPageTranslation.ts`
- Create: `tests/main/geminiPageTranslation.test.ts`
- Modify: `src/main/ipcHandlers.ts`
- Modify: `tests/main/ipcHandlers.test.ts`
- Modify: `tests/main/ipcHandlers.integration.test.ts`
- Modify: `src/renderer/electronApi.ts`
- Modify: `electron/preload.ts`
- Modify: `tests/electron/preload.test.ts`

**Interfaces:**
- Consumes: `TranslatePageRequest`, the encrypted Gemini key exposed through `process.env.GEMINI_API_KEY`, and `fetchWithGeminiRetry`.
- Produces: `ElectronProjectApi.translatePageDialogues(args): Promise<PageTranslationResult>`.

- [ ] **Step 1: Write failing Gemini request tests**

Cover these exact contracts in `tests/main/geminiPageTranslation.test.ts`:

```ts
it("posts one page translation request with three-attempt retry policy", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    output_text: JSON.stringify({ translations: [
      { id: "bubble-1", translation: "좋은 아침", reviewRequired: false, warnings: [] }
    ] })
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const result = await translatePageWithGemini(request);
  expect(result.translations[0]?.translation).toBe("좋은 아침");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-goog-api-key": "test-key" });
});

it("does not include an API key in provider errors", async () => {
  process.env.GEMINI_API_KEY = "secret-key";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream failed", { status: 400 })));
  await expect(translatePageWithGemini(request)).rejects.not.toThrow(/secret-key/);
});
```

Also cover missing key, malformed JSON, missing IDs, and transient 429/503 retries.

- [ ] **Step 2: Verify the Gemini tests fail**

```powershell
npm.cmd test -- tests/main/geminiPageTranslation.test.ts
```

Expected: FAIL because `geminiPageTranslation.ts` is absent.

- [ ] **Step 3: Implement the Gemini adapter**

Implement `translatePageWithGemini(request)` using the same Interactions URL and text extraction shapes as `geminiSpeechBubbleExtraction.ts`:

```ts
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_GEMINI_TEXT_MODEL = "gemini-3.5-flash";

export async function translatePageWithGemini(
  request: TranslatePageRequest
): Promise<PageTranslationResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini API 키가 필요합니다.");

  const response = await fetchWithGeminiRetry(
    GEMINI_INTERACTIONS_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        model: process.env.GEMINI_TEXT_MODEL || DEFAULT_GEMINI_TEXT_MODEL,
        input: [{ type: "text", text: buildPageTranslationPrompt(request) }]
      })
    },
    { maxAttempts: 3 }
  );

  if (!response.ok) throw new Error(`Gemini translation request failed with status ${response.status}.`);
  const payload = await response.json();
  return normalizePageTranslationResult(parseGeminiJson(findGeminiText(payload)), request.items);
}
```

Keep response parsing local or extract a shared main-process helper only if both callers can use it without changing existing OCR behavior.

- [ ] **Step 4: Add strict IPC argument validation**

Export `validateTranslatePageRequestArgs` from `src/main/ipcHandlers.ts`. Validate positive page number, 1–100 items, non-empty bounded strings, allow-listed source/dialogue values, dictionary and previous-context arrays, and reject extra filesystem/key fields.

Add:

```ts
ipcMain.handle("project:translatePageDialogues", async (_event, args) => {
  return translatePageWithGemini(validateTranslatePageRequestArgs(args));
});
```

- [ ] **Step 5: Expose the typed preload method**

Add to `ElectronProjectApi`:

```ts
translatePageDialogues?: (args: TranslatePageRequest) => Promise<PageTranslationResult>;
```

Add to `electron/preload.ts`:

```ts
translatePageDialogues: (args) => ipcRenderer.invoke("project:translatePageDialogues", args)
```

Update preload and IPC integration tests to assert the exact channel and returned value.

- [ ] **Step 6: Run focused IPC and main tests**

```powershell
npm.cmd test -- tests/shared/pageTranslation.test.ts tests/main/geminiPageTranslation.test.ts tests/main/ipcHandlers.test.ts tests/main/ipcHandlers.integration.test.ts tests/electron/preload.test.ts
npm.cmd run typecheck
```

Expected: PASS, with no real network request.

- [ ] **Step 7: Commit the translation boundary**

```powershell
git add src/shared/pageTranslation.ts src/main/geminiPageTranslation.ts src/main/ipcHandlers.ts src/renderer/electronApi.ts electron/preload.ts tests/shared/pageTranslation.test.ts tests/main/geminiPageTranslation.test.ts tests/main/ipcHandlers.test.ts tests/main/ipcHandlers.integration.test.ts tests/electron/preload.test.ts
git commit -m "feat: add Gemini page translation IPC"
```

---

### Task 4: Build the deterministic sequential queue coordinator

**Files:**
- Create: `src/renderer/fastTranslationQueue.ts`
- Create: `tests/renderer/fastTranslationQueue.test.ts`

**Interfaces:**
- Produces: `createFastTranslationQueue`, `runFastTranslationQueue`, `retryFailedFastPages`, and `summarizeFastTranslationQueue`.
- Consumes dependency callbacks for OCR, validation, translation, save, checkpoint notification, and pause checks.
- Does not import React or mutate input projects.

- [ ] **Step 1: Write failing queue behavior tests**

Create deterministic fixtures for three `PageImage` values and cover:

```ts
it("creates one pending OCR job per page in page order", () => {
  expect(createFastTranslationQueue(images).pages.map((page) => ({
    pageNumber: page.pageNumber,
    stage: page.stage,
    status: page.status
  }))).toEqual([
    { pageNumber: 1, stage: "ocr", status: "pending" },
    { pageNumber: 2, stage: "ocr", status: "pending" },
    { pageNumber: 3, stage: "ocr", status: "pending" }
  ]);
});

it("processes pages sequentially and checkpoints every stable completion", async () => {
  const calls: string[] = [];
  const result = await runFastTranslationQueue(makeArgs({
    extract: async ({ pageImage }) => { calls.push(`ocr:${pageImage.pageNumber}`); return extraction(pageImage.pageNumber); },
    validate: async ({ geminiExtraction }) => { calls.push(`validate:${geminiExtraction.pageNumber}`); return geminiExtraction; },
    translate: async ({ pageNumber, items }) => { calls.push(`translate:${pageNumber}`); return translations(items); },
    save: async ({ project }) => { calls.push(`save:${project.fastTranslationQueue?.pages.find((p) => p.status === "running")?.pageNumber ?? "stable"}`); }
  }));
  expect(calls.filter((call) => call.startsWith("ocr"))).toEqual(["ocr:1", "ocr:2", "ocr:3"]);
  expect(result.fastTranslationQueue?.runStatus).toBe("completed");
});
```

Also test:

- a page OCR/translation failure becomes `failed` and page 2 still runs;
- pause requested during page 1 takes effect before page 2;
- save failure returns a paused queue and does not start another page;
- completed pages are skipped after resume;
- retry resets only failed pages;
- deterministic `automationOrigin` IDs prevent duplicate lines after retry;
- low OCR confidence, `[?]`, unknown speaker, or translation `reviewRequired` produces line status `review`; otherwise line status is `draft`;
- at most the last 20 prior translations are sent as rolling context.

- [ ] **Step 2: Run the queue test and verify failure**

```powershell
npm.cmd test -- tests/renderer/fastTranslationQueue.test.ts
```

Expected: FAIL because the coordinator is absent.

- [ ] **Step 3: Implement queue initialization and summaries**

```ts
export function createFastTranslationQueue(pageImages: PageImage[]): FastTranslationQueueState {
  return {
    runStatus: "idle",
    pages: [...pageImages]
      .sort((left, right) => left.pageNumber - right.pageNumber)
      .map(({ pageNumber }) => ({
        pageNumber,
        stage: "ocr",
        status: "pending",
        attemptCount: 0
      }))
  };
}

export function summarizeFastTranslationQueue(queue: FastTranslationQueueState) {
  return {
    total: queue.pages.length,
    completed: queue.pages.filter((page) => page.status === "completed").length,
    failed: queue.pages.filter((page) => page.status === "failed").length,
    pending: queue.pages.filter((page) => page.status === "pending").length
  };
}
```

- [ ] **Step 4: Implement automatic line mapping and idempotent upsert**

Map speech bubbles plus `narration_box`, `caption_time_place`, `handwritten_note`, and `letter_or_document`. Do not auto-translate signs, UI text, sound effects, decorative text, or background noise.

Use stable origins:

```ts
const automationOrigin = {
  mode: "fast" as const,
  pageImageId: pageImage.id,
  sourceRegionId: region.id || `${region.type}-${region.readingOrder}`
};
```

Upsert by all three origin fields. Never delete manual lines or automated lines belonging to a different page image.

- [ ] **Step 5: Implement the page-boundary runner**

`runFastTranslationQueue` must follow this order for each pending page:

1. checkpoint `runStatus=running`, page `stage=ocr,status=running`, increment attempt;
2. call existing `extractSpeechBubbles` then `validateSpeechBubbles`;
3. checkpoint page `stage=translation,status=running` without discarding validated OCR held in memory;
4. translate all eligible regions in one page request; if the page has zero eligible regions, skip the translation IPC and complete it with zero generated lines;
5. upsert generated lines and checkpoint page `stage=complete,status=completed` with `lastStableAt`;
6. save the checkpoint before selecting another page;
7. on page error, checkpoint that page as `failed`, sanitize the error to a user-safe message, save, and continue;
8. on save error, return immediately with queue `paused` and preserve the unsaved project in renderer memory;
9. when no pending pages remain, set `completed` even if failed pages remain, save, and return.

Check `shouldPause()` only before selecting the next page and after each save.

- [ ] **Step 6: Run queue tests and typecheck**

```powershell
npm.cmd test -- tests/renderer/fastTranslationQueue.test.ts
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the queue engine**

```powershell
git add src/renderer/fastTranslationQueue.ts tests/renderer/fastTranslationQueue.test.ts
git commit -m "feat: add sequential fast translation queue"
```

---

### Task 5: Add progress, pause, resume, and failed-page retry UI

**Files:**
- Create: `src/renderer/components/FastTranslationQueuePanel.tsx`
- Create: `tests/renderer/FastTranslationQueuePanel.test.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Props: queue state, `onPause`, `onResume`, `onRetryFailed`.
- Accessibility: named progressbar, textual counts, and buttons whose names describe the resulting action.

- [ ] **Step 1: Write failing component tests**

```tsx
it("shows completed and failed page counts", () => {
  render(<FastTranslationQueuePanel queue={queue} onPause={vi.fn()} onResume={vi.fn()} onRetryFailed={vi.fn()} />);
  expect(screen.getByRole("progressbar", { name: "빠른 번역 진행률" })).toHaveAttribute("aria-valuenow", "1");
  expect(screen.getByText("완료 1 / 3")).toBeInTheDocument();
  expect(screen.getByText("실패 1")).toBeInTheDocument();
});

it("offers pause while running and retry when failures exist", () => {
  const onPause = vi.fn();
  const onRetryFailed = vi.fn();
  render(<FastTranslationQueuePanel queue={runningQueue} onPause={onPause} onResume={vi.fn()} onRetryFailed={onRetryFailed} />);
  fireEvent.click(screen.getByRole("button", { name: "빠른 번역 일시 중지" }));
  fireEvent.click(screen.getByRole("button", { name: "실패한 페이지 다시 실행" }));
  expect(onPause).toHaveBeenCalledOnce();
  expect(onRetryFailed).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Verify the component test fails**

```powershell
npm.cmd test -- tests/renderer/FastTranslationQueuePanel.test.tsx
```

- [ ] **Step 3: Implement the compact panel**

Render:

- title `빠른 번역`;
- current page/stage when one is running;
- `완료 N / T`, `실패 F`, `대기 P`;
- `<progress>` with completed count and total;
- pause button only while running;
- resume button while idle/paused with pending pages;
- retry button only when failed pages exist;
- failure page numbers in an accessible list, without internal paths or provider bodies.

- [ ] **Step 4: Add scoped styles**

Use `.fast-translation-queue` and descendant classes only. Reuse existing color variables; do not change global layout, fixed workbench dimensions, or manual-stage colors.

- [ ] **Step 5: Run component tests**

```powershell
npm.cmd test -- tests/renderer/FastTranslationQueuePanel.test.tsx
npm.cmd run typecheck
```

- [ ] **Step 6: Commit the queue UI**

```powershell
git add src/renderer/components/FastTranslationQueuePanel.tsx tests/renderer/FastTranslationQueuePanel.test.tsx src/renderer/styles.css
git commit -m "feat: show fast translation progress"
```

---

### Task 6: Integrate automatic start and safe resume in App

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `tests/renderer/App.test.tsx`

**Interfaces:**
- New Fast projects auto-start only after imported images and final project save succeed.
- Reopened interrupted projects show a paused queue and require `빠른 번역 재개`.
- Precise projects and legacy projects never auto-start.

- [ ] **Step 1: Write failing end-to-end renderer tests**

Add the following helper and tests, reusing the existing `pageImage`, `preparedPageImage`, `openedProjectWithImages`, `emptyOcrExtraction`, and `validatedReviewExtraction` fixtures in `App.test.tsx`:

```ts
function installFastQueueApi(pageCount = 1) {
  const saveProject = vi.fn().mockResolvedValue(undefined);
  const extractSpeechBubbles = vi.fn().mockImplementation(
    ({ pageImage: image }: { pageImage: PageImage }) =>
      Promise.resolve(emptyOcrExtraction(image.pageNumber))
  );
  const validateSpeechBubbles = vi.fn().mockImplementation(
    ({ pageImage: image }: { pageImage: PageImage }) =>
      Promise.resolve(validatedReviewExtraction(image.pageNumber))
  );
  const translatePageDialogues = vi.fn().mockImplementation(
    ({ items }: { items: Array<{ id: string }> }) =>
      Promise.resolve({
        translations: items.map(({ id }) => ({
          id,
          translation: "자동 번역",
          reviewRequired: false,
          warnings: []
        }))
      })
  );
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Fast.ctp"),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject,
    choosePreparedPageImageFiles: vi.fn().mockResolvedValue(
      Array.from({ length: pageCount }, (_, index) => preparedPageImage({
        id: `prepared-${index + 1}`,
        sourcePath: `C:\\images\\page-${index + 1}.jpg`,
        fileName: `page-${index + 1}.jpg`
      }))
    ),
    releasePreparedPageImages: vi.fn().mockResolvedValue(undefined),
    importPageImages: vi.fn().mockImplementation(
      ({ files }: { files: Array<{ pageNumber: number }> }) =>
        Promise.resolve(files.map(({ pageNumber }) => ({
          ok: true as const,
          pageImage: pageImage({ id: `image-${pageNumber}`, pageNumber })
        })))
    ),
    resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-current"),
    getGeminiApiKeyStatus: vi.fn().mockResolvedValue({
      configured: true,
      source: "encrypted",
      persistence: "encrypted",
      requiresReentry: false
    }),
    extractSpeechBubbles,
    validateSpeechBubbles,
    translatePageDialogues
  };
  return { saveProject, extractSpeechBubbles, validateSpeechBubbles, translatePageDialogues };
}

async function createImageProjectFromSetup(mode: "fast" | "precise") {
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
  fireEvent.click(screen.getByRole("button", { name: "이미지 선택" }));
  await screen.findByRole("img", { name: "page-1.jpg" });
  fireEvent.click(screen.getByRole("radio", { name: mode === "fast" ? /빠른 번역/ : /정확 번역/ }));
  fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));
  await screen.findByRole("img", { name: "1페이지 이미지" });
}

it("starts the fast queue after a Fast image project is durably created", async () => {
  const api = installFastQueueApi();
  await createImageProjectFromSetup("fast");

  await waitFor(() => expect(api.translatePageDialogues).toHaveBeenCalledOnce());
  expect(api.extractSpeechBubbles).toHaveBeenCalledOnce();
  expect(api.validateSpeechBubbles).toHaveBeenCalledOnce();
  expect(api.saveProject.mock.invocationCallOrder[1]).toBeLessThan(
    api.extractSpeechBubbles.mock.invocationCallOrder[0]!
  );
  expect(api.extractSpeechBubbles.mock.invocationCallOrder[0]).toBeLessThan(
    api.validateSpeechBubbles.mock.invocationCallOrder[0]!
  );
  expect(api.validateSpeechBubbles.mock.invocationCallOrder[0]).toBeLessThan(
    api.translatePageDialogues.mock.invocationCallOrder[0]!
  );
  expect(await screen.findByText("완료 1 / 1")).toBeVisible();
});

it("does not start automation for Precise projects", async () => {
  const api = installFastQueueApi();
  await createImageProjectFromSetup("precise");
  await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(2));
  expect(api.extractSpeechBubbles).not.toHaveBeenCalled();
  expect(api.validateSpeechBubbles).not.toHaveBeenCalled();
  expect(api.translatePageDialogues).not.toHaveBeenCalled();
});

it("pauses before calling providers when the Gemini key is unavailable", async () => {
  const api = installFastQueueApi();
  vi.mocked(window.projectApi.getGeminiApiKeyStatus!).mockResolvedValue({
    configured: false,
    source: "none",
    persistence: "encrypted",
    requiresReentry: false
  });
  await createImageProjectFromSetup("fast");
  expect(await screen.findByText(/Gemini API 키/)).toBeVisible();
  expect(api.extractSpeechBubbles).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "빠른 번역 재개" })).toBeVisible();
});

it("opens an interrupted Fast project paused and resumes only after user action", async () => {
  const api = installFastQueueApi();
  const base = openedProjectWithImages([pageImage()]);
  const opened = {
    ...base,
    project: {
      ...base.project,
      settings: { ...base.project.settings, translationMode: "fast" as const },
      fastTranslationQueue: {
        runStatus: "paused" as const,
        pages: [{ pageNumber: 1, stage: "ocr" as const, status: "pending" as const, attemptCount: 1 }]
      }
    }
  };
  vi.mocked(window.projectApi.openProject).mockResolvedValue(opened);
  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
  await screen.findByRole("img", { name: "1페이지 이미지" });
  expect(api.extractSpeechBubbles).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "빠른 번역 재개" }));
  await waitFor(() => expect(api.translatePageDialogues).toHaveBeenCalledOnce());
});

it("continues page 2 after page 1 fails and retries only page 1", async () => {
  const api = installFastQueueApi(2);
  api.extractSpeechBubbles
    .mockRejectedValueOnce(new Error("page 1 failed"))
    .mockResolvedValueOnce(emptyOcrExtraction(2))
    .mockResolvedValueOnce(emptyOcrExtraction(1));
  await createImageProjectFromSetup("fast");
  expect(await screen.findByText("실패 1")).toBeVisible();
  expect(api.extractSpeechBubbles).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "실패한 페이지 다시 실행" }));
  await waitFor(() => expect(api.extractSpeechBubbles).toHaveBeenCalledTimes(3));
  expect(api.extractSpeechBubbles.mock.calls.map(([args]) => args.pageImage.pageNumber)).toEqual([1, 2, 1]);
});
```

- [ ] **Step 2: Run the focused App tests and verify failure**

```powershell
npm.cmd test -- tests/renderer/App.test.tsx -t "fast queue|Fast project|interrupted Fast"
```

Expected: FAIL because App does not orchestrate Fast mode.

- [ ] **Step 3: Add guarded queue lifecycle state**

In `App.tsx`, add:

```ts
const fastQueueRunTokenRef = useRef(0);
const fastQueuePauseRequestedRef = useRef(false);
const [isFastQueueRunning, setIsFastQueueRunning] = useState(false);
```

Increment the token and request pause when opening/creating another project or unmounting. Use the existing current-file/project refs to reject stale checkpoints, matching the current OCR and inpainting stale-result pattern.

- [ ] **Step 4: Implement one `startFastQueue` integration function**

The function must:

- verify file path, Fast mode, page images, all three API methods, and configured Gemini key;
- initialize a queue only when absent;
- set running UI state;
- call `runFastTranslationQueue` with existing Electron API methods;
- on every checkpoint, update React project state and dirty state consistently;
- let the coordinator save the exact checkpoint project;
- reject stale updates if file path, project ID, or run token changed;
- end with a Korean summary containing completed and failed counts;
- never print provider payloads or internal paths.

- [ ] **Step 5: Start only after durable Fast project creation**

After `applyImageProjectStartResult(result)` for a successful/partial Fast result, call `startFastQueue(result.project, result.filePath)` only when:

```ts
result.project.settings.translationMode === "fast" &&
result.project.pageImages.length > 0 &&
result.kind !== "failed"
```

Do not start before the final image-project save completes.

- [ ] **Step 6: Add explicit pause, resume, and retry handlers**

Pause sets `fastQueuePauseRequestedRef.current = true` and announces that the current page will finish first. Resume clears the flag and runs pending pages. Retry maps failed pages to `{ stage: "ocr", status: "pending", errorMessage: undefined }`, saves that reset checkpoint, then resumes.

- [ ] **Step 7: Render `FastTranslationQueuePanel` without replacing manual tools**

Render the panel in the existing task inspector when `project.fastTranslationQueue` exists. Keep `GuidedWorkPanel`, OCR review, line editor, settings, inpainting, and result dock mounted and behaviorally unchanged.

- [ ] **Step 8: Run App regression tests**

```powershell
npm.cmd test -- tests/renderer/App.test.tsx tests/renderer/FastTranslationQueuePanel.test.tsx tests/renderer/fastTranslationQueue.test.ts
npm.cmd run typecheck
```

Expected: all existing and new App tests pass.

- [ ] **Step 9: Commit App integration**

```powershell
git add src/renderer/App.tsx tests/renderer/App.test.tsx
git commit -m "feat: run and resume fast translation projects"
```

---

### Task 7: Document limits and verify the complete MVP

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-17-batch-manga-translation-workbench-design.md` only if acceptance wording must reflect the smaller MVP boundary.

**Interfaces:**
- Documentation must distinguish implemented Fast OCR/translation from deferred composition/export.

- [ ] **Step 1: Update README truthfully**

Replace the statement that both modes always enter the same manual flow with:

```markdown
- `빠른 번역`: 페이지를 순서대로 OCR·검증·한국어 번역하고 각 페이지 결과를 프로젝트에 자동 저장합니다. 페이지 하나가 실패해도 다음 페이지를 계속 처리하며 실패 페이지만 다시 실행할 수 있습니다.
- `정확 번역`: 현재는 모드만 저장하고 이미지 중심 수동 작업 화면으로 이동합니다. 작품 전체 문맥 분석 파이프라인은 후속 개발 대상입니다.

빠른 번역 MVP에는 자동 인페인팅, 번역문 이미지 합성, 완성 이미지 일괄 내보내기가 포함되지 않습니다.
```

Also document pause-at-page-boundary behavior, restart recovery, Gemini key requirement, and failed-page retry.

- [ ] **Step 2: Run the complete automated suite**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기"
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git status --short
```

Expected:

- no `.worktrees/**` tests collected;
- all tests pass;
- typecheck and build pass;
- no `dist`, lock, API key, `.ctp`, imported image, or generated result is staged.

- [ ] **Step 3: Perform manual Electron acceptance with a low-cost fixture**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기"
npm.cmd run dev:electron
```

Verify:

- [ ] A 2–3 page Fast project starts only after save/import completes.
- [ ] Exactly one page is processed at a time.
- [ ] Completed page dialogue appears with AI translation and draft/review state.
- [ ] Pausing during a page prevents the next page from starting.
- [ ] Closing and reopening shows interrupted work paused; resume skips completed pages.
- [ ] One induced page failure does not block later pages.
- [ ] `실패한 페이지 다시 실행` reruns only failures.
- [ ] A forced save failure pauses the queue and preserves visible in-memory results.
- [ ] Precise mode performs no automatic OCR or translation.
- [ ] Manual OCR review, editing, save/open, TXT export, and inpainting still work.
- [ ] No original image changes.
- [ ] No API key, request body, or full image path appears in status messages or project content.

Stop the development process after verification.

- [ ] **Step 4: Review project-file compatibility**

Open one legacy `.ctp` without `translationMode`, one existing Fast project without queue fields, and one newly completed Fast project. Confirm all three open and the two older files are not rewritten until the user saves.

- [ ] **Step 5: Commit documentation and any acceptance-only corrections**

```powershell
git add README.md docs/superpowers/specs/2026-07-17-batch-manga-translation-workbench-design.md
git status --short
git commit -m "docs: explain fast translation queue MVP"
```

Do not include the spec file if it did not need a change.

---

## Final Acceptance Checklist

- [ ] Test discovery maintenance is merged first.
- [ ] Fast queue fields are optional and legacy projects open unchanged.
- [ ] New Fast projects auto-start only after durable project creation.
- [ ] OCR and validation reuse existing IPC behavior and retry policy.
- [ ] One Gemini translation request is made per page.
- [ ] Pages run sequentially; failures are isolated.
- [ ] Every stable page completion/failure is auto-saved.
- [ ] Save failure pauses the queue.
- [ ] Restart recovery never repeats completed pages.
- [ ] Pause occurs at page boundaries.
- [ ] Failed-page retry does not rerun successful pages.
- [ ] Automated lines are idempotently upserted and never delete manual lines.
- [ ] Low-confidence/uncertain results enter review status.
- [ ] Precise and manual workflows are unchanged.
- [ ] Automatic composition/export remains explicitly deferred.
- [ ] No secret or sensitive path is persisted or displayed.
- [ ] Full tests, typecheck, build, and Electron acceptance pass.

## Deferred Follow-up

The next separate plan should implement translation-image composition and completed-image batch export. It must reuse the Fast queue checkpoint model by adding a later `composition` stage, preserve original assets, and add overflow review rather than expanding this MVP during implementation.
