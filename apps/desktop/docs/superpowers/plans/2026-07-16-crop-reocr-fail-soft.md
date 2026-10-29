# Crop ReOCR Fail-Soft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve validated whole-image OCR results when one or more optional Gemini Crop ReOCR requests fail.

**Architecture:** Keep the existing extraction, validation, crop selection, and merge pipeline. Add per-target failure isolation inside the main-process validation handler so successful crops merge normally while failed crops retain their validated whole-image data and append a safe warning.

**Tech Stack:** Electron 42 main process, TypeScript 6, Vitest 4, existing Gemini Interactions API helpers.

## Global Constraints

- Run every command in PowerShell from the repository root (the current workspace directory).
- Do not add packages or change the project schema, IPC contract, provider selection, API-key handling, security settings, or Electron build configuration.
- Whole-image extraction and whole-image validation failures must continue to reject as errors.
- Catch errors only around each Crop ReOCR target's crop generation and Gemini request.
- Continue processing later Crop ReOCR targets after an earlier target fails.
- Merge successful Crop ReOCR results with the existing `mergeCropReocrResults` function.
- Preserve failed targets' validated text, confidence, bbox, readingOrder, and speakerCandidates.
- Append `Crop ReOCR skipped for #<readingOrder>: <safe error message>` after existing warnings.
- Never include API keys, request headers, image bytes, or local absolute paths in warnings.
- Do not modify generated output, lock files, `node_modules`, `dist`, `dist-electron`, `dist-renderer`, or release files.

## File Map

- Modify `src/main/ipcHandlers.ts`: isolate each Crop ReOCR attempt and append failure warnings after merging successful results.
- Modify `tests/main/ipcHandlers.integration.test.ts`: reproduce a failed crop and a mixed failed/successful multi-target sequence.

---

### Task 1: Make Crop ReOCR Fail Soft Per Target

**Files:**
- Modify: `src/main/ipcHandlers.ts:205-223`
- Test: `tests/main/ipcHandlers.integration.test.ts:545-648`

**Interfaces:**
- Consumes: `selectCropReocrTargets`, `cropImageToPng`, `reocrSpeechBubbleCropWithGemini`, and `mergeCropReocrResults` without changing their signatures.
- Produces: the existing `SpeechBubbleExtractionResult` shape with successful crop merges and appended skip warnings.

- [ ] **Step 1: Add a failing integration test for one rejected Crop ReOCR request**

Add this test after the existing Gemini Crop ReOCR success test. Reuse the existing `electronMocks` crop setup and IPC `invoke` helper exactly as shown:

```ts
it("keeps validated OCR when Gemini crop reOCR cannot process one crop", async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  delete process.env.OPENAI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  electronMocks.nativeImageToPNG.mockReturnValue(Buffer.from([7, 7, 7]));
  electronMocks.nativeImageCrop.mockReturnValue({ toPNG: electronMocks.nativeImageToPNG });
  electronMocks.nativeImageGetSize.mockReturnValue({ width: 100, height: 100 });
  electronMocks.nativeImageCreateFromBuffer.mockReturnValue({
    getSize: electronMocks.nativeImageGetSize,
    crop: electronMocks.nativeImageCrop
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output_text: JSON.stringify({
          pageNumber: 1,
          speechBubbles: [{
            id: "bubble-001",
            type: "speech_bubble",
            text: "Hel[?]o",
            language: "en",
            bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
            readingOrder: 1,
            confidence: 0.62,
            notes: "uncertain",
            speakerCandidates: [{ speaker: "Mika", confidence: 0.8, reason: "tail" }]
          }],
          nonSpeechText: [],
          warnings: ["whole-image warning"]
        })
      })
    })
    .mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        error: { message: "Unable to process input image." }
      }))
    });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  try {
    const projectFilePath = join(tempDir, "Project.ctp");
    await writeFile(projectFilePath, "{}", "utf8");
    await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
    await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));

    const result = (await invoke("project:validateSpeechBubbles", {
      projectFilePath,
      pageImage: pageImageFixture(),
      geminiExtraction: emptyExtractionFixture()
    })) as SpeechBubbleExtractionResult;

    expect(result.speechBubbles[0]).toMatchObject({
      text: "Hel[?]o",
      confidence: 0.62,
      bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      readingOrder: 1,
      speakerCandidates: [{ speaker: "Mika", confidence: 0.8, reason: "tail" }]
    });
    expect(result.warnings).toEqual([
      "whole-image warning",
      "Crop ReOCR skipped for #1: Gemini crop reOCR request failed: Unable to process input image."
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    globalThis.fetch = originalFetch;
  }
});
```

Add these exact helpers at the bottom of the test file:

```ts
function pageImageFixture() {
  return {
    id: "page-image-1",
    pageNumber: 1,
    storedRelativePath: "Project-assets/images/page-001.png",
    originalFileName: "page-001.png",
    sha256: "a".repeat(64),
    byteSize: 4,
    mimeType: "image/png",
    copiedAt: "2026-06-30T00:00:00.000Z"
  };
}

function emptyExtractionFixture() {
  return { pageNumber: 1, speechBubbles: [], nonSpeechText: [], warnings: [] };
}
```

Add `SpeechBubbleExtractionResult` to the imports from `../../src/shared/speechBubbleExtraction`.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npx vitest run tests/main/ipcHandlers.integration.test.ts -t "keeps validated OCR when Gemini crop reOCR cannot process one crop"
```

Expected: FAIL because `project:validateSpeechBubbles` rejects with `Gemini crop reOCR request failed` instead of returning the validated extraction.

- [ ] **Step 3: Add a failing mixed-result integration test**

Add this complete second test:

```ts
it("continues later crop reOCR targets after one target fails", async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  delete process.env.OPENAI_API_KEY;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  electronMocks.nativeImageToPNG.mockReturnValue(Buffer.from([7, 7, 7]));
  electronMocks.nativeImageCrop.mockReturnValue({ toPNG: electronMocks.nativeImageToPNG });
  electronMocks.nativeImageGetSize.mockReturnValue({ width: 100, height: 100 });
  electronMocks.nativeImageCreateFromBuffer.mockReturnValue({
    getSize: electronMocks.nativeImageGetSize,
    crop: electronMocks.nativeImageCrop
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output_text: JSON.stringify({
          pageNumber: 1,
          speechBubbles: [
            {
              id: "bubble-001",
              type: "speech_bubble",
              text: "First[?]",
              language: "en",
              bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
              readingOrder: 1,
              confidence: 0.6,
              notes: "first uncertain"
            },
            {
              id: "bubble-002",
              type: "speech_bubble",
              text: "Second[?]",
              language: "en",
              bbox: { x: 0.5, y: 0.4, width: 0.3, height: 0.1 },
              readingOrder: 2,
              confidence: 0.61,
              notes: "second uncertain"
            }
          ],
          nonSpeechText: [],
          warnings: []
        })
      })
    })
    .mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        error: { message: "Unable to process input image." }
      }))
    })
    .mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output_text: JSON.stringify({ text: "Second fixed", confidence: 0.91, notes: "second crop clear" })
      })
    });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  try {
    const projectFilePath = join(tempDir, "Project.ctp");
    await writeFile(projectFilePath, "{}", "utf8");
    await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
    await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));

    const result = (await invoke("project:validateSpeechBubbles", {
      projectFilePath,
      pageImage: pageImageFixture(),
      geminiExtraction: emptyExtractionFixture()
    })) as SpeechBubbleExtractionResult;

    expect(result.speechBubbles[0]?.text).toBe("First[?]");
    expect(result.speechBubbles[0]?.confidence).toBe(0.6);
    expect(result.speechBubbles[1]?.text).toBe("Second fixed");
    expect(result.speechBubbles[1]?.confidence).toBe(0.91);
    expect(result.speechBubbles[1]?.notes).toContain("Crop ReOCR applied");
    expect(result.warnings).toContain(
      "Crop ReOCR skipped for #1: Gemini crop reOCR request failed: Unable to process input image."
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally {
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 4: Implement per-target error isolation**

Replace the current Crop ReOCR loop and return in `src/main/ipcHandlers.ts` with:

```ts
const cropResults = [];
const cropWarnings: string[] = [];
for (const target of reocrTargets) {
  try {
    const cropImageBytes = cropImageToPng({
      imageBytes,
      bbox: target.bbox,
      paddingRatio: 0.08
    });
    const result = await reocrSpeechBubbleCropWithGemini({
      cropImageBytes,
      sourceMimeType: "image/png",
      target
    });
    cropResults.push({ target, result });
  } catch (error) {
    const message = error instanceof Error && error.message.trim()
      ? error.message
      : "Unable to re-OCR this crop.";
    cropWarnings.push(`Crop ReOCR skipped for #${target.readingOrder}: ${message}`);
  }
}

const mergedExtraction = mergeCropReocrResults(validatedExtraction, cropResults);
return cropWarnings.length === 0
  ? mergedExtraction
  : { ...mergedExtraction, warnings: [...mergedExtraction.warnings, ...cropWarnings] };
```

Do not place the whole target loop in one `try/catch`; each target must fail independently.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
npx vitest run tests/main/ipcHandlers.integration.test.ts -t "crop reOCR"
```

Expected: the existing successful Crop ReOCR test and both new fail-soft tests PASS.

- [ ] **Step 6: Run task-level regression and typecheck**

```powershell
npx vitest run tests/main/ipcHandlers.integration.test.ts tests/main/geminiSpeechBubbleExtraction.test.ts tests/shared/speechBubbleReocr.test.ts
npm run typecheck
```

Expected: all selected tests and typecheck PASS with exit code 0.

- [ ] **Step 7: Commit the fail-soft behavior**

```powershell
git add -- src/main/ipcHandlers.ts tests/main/ipcHandlers.integration.test.ts
git commit -m "fix: preserve OCR when crop reocr fails"
```

---

### Task 2: Full Regression and Electron Verification

**Files:**
- No planned source changes.
- Modify only Task 1 files if verification reproduces a defect.

**Interfaces:**
- Consumes: the updated `project:validateSpeechBubbles` handler.
- Produces: evidence that the original image reaches OCR review even when one Crop ReOCR request fails.

- [ ] **Step 1: Run complete automated verification**

```powershell
npm run typecheck
npm test
npm run smoke:ipc
npm run build
```

Expected: every command exits 0; all Vitest suites pass; IPC smoke passes; production build completes.

- [ ] **Step 2: Restart the Electron application from the project root**

```powershell
npm run dev:electron
```

Expected: the `대사 편집기` Electron window opens, Vite is ready, and the Electron TypeScript watcher reports zero errors. Re-enter the Gemini API key through the application if the restart cleared the process-only key.

- [ ] **Step 3: Reproduce the original image OCR flow**

1. Open the same saved image project.
2. Run `빠른 OCR` on the same page.
3. Confirm the busy state ends and the OCR review panel appears.
4. Confirm the whole-image OCR candidates remain editable.
5. If Gemini rejects a crop, confirm a `Crop ReOCR skipped for #...` warning appears instead of the entire OCR result disappearing.
6. Do not print or capture the Gemini API key.

- [ ] **Step 4: Confirm repository hygiene**

```powershell
git status --short
git log -3 --oneline
```

Expected: no generated or unrelated files; only the intended implementation commit is added after this plan.
