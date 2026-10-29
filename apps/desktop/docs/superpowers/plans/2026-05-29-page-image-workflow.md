# Page Image Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build page-based comic translation so users can work one page at a time and later attach page images copied into project assets with SHA-256 verification.

**Architecture:** Extend the existing project schema with page-aware dialogue lines and page image metadata, then layer page navigation into the renderer before adding image asset storage and upload IPC. Keep OCR, bubble detection, and image editing out of this implementation.

**Tech Stack:** Electron main process, React renderer, TypeScript, Vitest, Node `fs/promises`, Node `crypto`, existing IPC and project validation patterns.

---

## File Structure

- `src/shared/projectTypes.ts`: add `pageNumber` to `DialogueLine`; add `PageImage`; add `pageImages` to `TranslationProject`.
- `src/shared/projectValidation.ts`: normalize old projects by defaulting missing `pageNumber` to `1`; validate `pageImages`.
- `tests/shared/projectValidation.test.ts`: cover default page migration and page image validation.
- `src/main/dialogueParser.ts`: detect page markers and assign `pageNumber`.
- `tests/parser/dialogueParser.test.ts`: cover English/Korean markers and no-marker default.
- `src/renderer/App.tsx`: own `currentPage`, derived page count, page-scoped line updates, page navigation, page number edits.
- `src/renderer/components/DialogueTable.tsx`: accept visible current-page lines; expose editable page number field on each row.
- `src/renderer/components/PageNavigator.tsx`: new focused page control component.
- `src/renderer/components/PageImagePanel.tsx`: new focused image preview/empty state component.
- `tests/renderer/App.test.tsx`: cover page navigation, page filtering, page number edits, and empty page states.
- `src/main/pageImageAssets.ts`: new asset-copy/hash-verification module.
- `tests/storage/pageImageAssets.test.ts`: cover copy success, hash mismatch cleanup, unsupported extension.
- `src/main/ipcHandlers.ts`: add image upload IPC validation and handler.
- `src/renderer/electronApi.ts`: expose image upload API to renderer.
- `src/renderer/components/ImageImportPanel.tsx`: new image upload control.
- `src/renderer/styles.css`: page workspace, image panel, page controls, and page number field styling.

---

### Task 1: Add Page Fields To Project Schema

**Files:**
- Modify: `src/shared/projectTypes.ts`
- Modify: `src/shared/projectValidation.ts`
- Modify: `tests/shared/projectValidation.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add these tests to `tests/shared/projectValidation.test.ts`:

```ts
it("defaults legacy dialogue lines to page 1", () => {
  const project = createEmptyProject("Legacy", false);
  const legacyProject = {
    ...project,
    dialogueLines: [
      {
        id: "line-legacy-page",
        order: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "こんにちは",
        parseConfidence: 0.95,
        parseWarnings: []
      }
    ]
  };

  expect(normalizeProject(legacyProject).dialogueLines[0]?.pageNumber).toBe(1);
});

it("validates page image metadata", () => {
  const project = createEmptyProject("Images", false);
  const normalized = normalizeProject({
    ...project,
    pageImages: [
      {
        id: "page-image-1",
        pageNumber: 1,
        storedRelativePath: "Images-assets/images/page-001.jpg",
        originalFileName: "scan_001.jpg",
        sha256: "a".repeat(64),
        byteSize: 1234,
        mimeType: "image/jpeg",
        copiedAt: "2026-05-29T00:00:00.000Z"
      }
    ]
  });

  expect(normalized.pageImages[0]?.pageNumber).toBe(1);
  expect(normalized.pageImages[0]?.storedRelativePath).toBe("Images-assets/images/page-001.jpg");
});

it("rejects malformed page image metadata", () => {
  const project = createEmptyProject("Bad Images", false);

  expect(() =>
    normalizeProject({
      ...project,
      pageImages: [
        {
          id: "bad-page-image",
          pageNumber: 0,
          storedRelativePath: "Images-assets/images/page-001.jpg",
          originalFileName: "scan_001.jpg",
          sha256: "not-a-hash",
          byteSize: -1,
          mimeType: "image/jpeg",
          copiedAt: "2026-05-29T00:00:00.000Z"
        }
      ]
    })
  ).toThrow(/page image/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm test -- tests/shared/projectValidation.test.ts
```

Expected: tests fail because `pageNumber`, `pageImages`, and page image validation are not implemented.

- [ ] **Step 3: Extend shared project types**

Update `src/shared/projectTypes.ts` to include:

```ts
export type PageImage = {
  id: string;
  pageNumber: number;
  storedRelativePath: string;
  originalFileName: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  copiedAt: string;
};
```

Add `pageNumber` to `DialogueLine`:

```ts
export type DialogueLine = {
  id: string;
  order: number;
  pageNumber: number;
  speaker?: string;
  position?: string;
  dialogueType: DialogueType;
  lineStatus?: LineStatus;
  sourceLanguage: SourceLanguage;
  sourceText: string;
  referenceTranslation?: string;
  aiTranslation?: string;
  userTranslation?: string;
  notes?: string;
  parseConfidence: number;
  parseWarnings: string[];
};
```

Add `pageImages` to `TranslationProject`:

```ts
pageImages: PageImage[];
```

- [ ] **Step 4: Extend project normalization and validation**

In `src/shared/projectValidation.ts`, import `PageImage` and include `pageImages: []` in `createEmptyProject`.

In `normalizeProject`, accept legacy projects with no `pageImages`:

```ts
const pageImages = input.pageImages === undefined ? [] : input.pageImages;
if (!Array.isArray(pageImages)) throw new Error("Invalid project: missing pageImages");
if (!pageImages.every(isPageImage)) {
  throw new Error("Invalid project: malformed page image");
}
```

When normalizing lines, default missing page numbers:

```ts
dialogueLines: input.dialogueLines.map((line) => ({
  ...line,
  pageNumber: typeof line.pageNumber === "number" ? line.pageNumber : 1
})),
pageImages,
```

Add helpers:

```ts
function isPageImage(value: unknown): value is PageImage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Number.isInteger(value.pageNumber) &&
    value.pageNumber >= 1 &&
    typeof value.storedRelativePath === "string" &&
    typeof value.originalFileName === "string" &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(value.sha256) &&
    Number.isInteger(value.byteSize) &&
    value.byteSize >= 0 &&
    typeof value.mimeType === "string" &&
    typeof value.copiedAt === "string"
  );
}

function isDialogueLine(value: unknown): value is DialogueLine {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Number.isInteger(value.order) &&
    Number.isInteger(value.pageNumber) &&
    value.pageNumber >= 1 &&
    isOptionalString(value.speaker) &&
    isOptionalString(value.position) &&
    isDialogueType(value.dialogueType) &&
    isOptionalLineStatus(value.lineStatus) &&
    isSourceLanguage(value.sourceLanguage) &&
    typeof value.sourceText === "string" &&
    isOptionalString(value.referenceTranslation) &&
    isOptionalString(value.aiTranslation) &&
    isOptionalString(value.userTranslation) &&
    isOptionalString(value.notes) &&
    typeof value.parseConfidence === "number" &&
    Number.isFinite(value.parseConfidence) &&
    isStringArray(value.parseWarnings)
  );
}
```

If the existing `isDialogueLine` is used before defaulting, split validation into `isRawDialogueLine` and normalized output so legacy missing `pageNumber` passes. Keep the error message `Invalid project: malformed dialogue line`.

- [ ] **Step 5: Run schema tests**

Run:

```powershell
npm test -- tests/shared/projectValidation.test.ts
```

Expected: all tests in this file pass.

- [ ] **Step 6: Commit**

```powershell
git add src/shared/projectTypes.ts src/shared/projectValidation.ts tests/shared/projectValidation.test.ts
git commit -m "feat: add page metadata to project schema"
```

---

### Task 2: Parse Page Markers From TXT

**Files:**
- Modify: `src/main/dialogueParser.ts`
- Modify: `tests/parser/dialogueParser.test.ts`

- [ ] **Step 1: Write failing parser tests**

Add these tests to `tests/parser/dialogueParser.test.ts`:

```ts
it("assigns page numbers from English page markers", () => {
  const result = parseDialogueText(`
--- page 1 ---
Mika: First page line

[page 2]
Ren: Second page line
`);

  expect(result).toHaveLength(2);
  expect(result[0]?.pageNumber).toBe(1);
  expect(result[0]?.sourceText).toBe("First page line");
  expect(result[1]?.pageNumber).toBe(2);
  expect(result[1]?.sourceText).toBe("Second page line");
});

it("assigns page numbers from Korean page markers", () => {
  const result = parseDialogueText(`
페이지 3
Mika: Third page line

4페이지
Ren: Fourth page line
`);

  expect(result[0]?.pageNumber).toBe(3);
  expect(result[1]?.pageNumber).toBe(4);
});

it("defaults imported lines to page 1 without markers", () => {
  const result = parseDialogueText("Mika: Only page line");

  expect(result[0]?.pageNumber).toBe(1);
});
```

- [ ] **Step 2: Run parser tests to verify failure**

Run:

```powershell
npm test -- tests/parser/dialogueParser.test.ts
```

Expected: tests fail because parsed lines do not have correct page numbers.

- [ ] **Step 3: Implement page marker detection**

In `src/main/dialogueParser.ts`, set `pageNumber: 1` in the initial mutable line.

Add:

```ts
function parsePageMarker(line: string): number | null {
  const trimmed = line.trim();
  const patterns = [
    /^-+\s*page\s+(\d+)\s*-+$/i,
    /^page\s+(\d+)$/i,
    /^p\.(\d+)$/i,
    /^\[p\.(\d+)\]$/i,
    /^\[page\s+(\d+)\]$/i,
    /^페이지\s+(\d+)$/,
    /^(\d+)페이지$/
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const pageNumber = Number(match[1]);
    return Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber : null;
  }

  return null;
}
```

In the loop over normalized blocks, track current page:

```ts
let currentPageNumber = 1;
```

Before treating a block as dialogue, check whether the block is only a page marker:

```ts
const pageMarker = lines.length === 1 ? parsePageMarker(lines[0]) : null;
if (pageMarker !== null) {
  currentPageNumber = pageMarker;
  continue;
}
```

Set new parsed lines to the current page:

```ts
const parsed: MutableLine = {
  dialogueType: "speech",
  lineStatus: "untranslated",
  sourceLanguage: "unknown",
  sourceText: "",
  pageNumber: currentPageNumber,
  parseWarnings: []
};
```

- [ ] **Step 4: Run parser tests**

Run:

```powershell
npm test -- tests/parser/dialogueParser.test.ts
```

Expected: parser tests pass.

- [ ] **Step 5: Run schema tests**

Run:

```powershell
npm test -- tests/shared/projectValidation.test.ts
```

Expected: schema tests still pass.

- [ ] **Step 6: Commit**

```powershell
git add src/main/dialogueParser.ts tests/parser/dialogueParser.test.ts
git commit -m "feat: parse dialogue page markers"
```

---

### Task 3: Add Text-Only Page Navigation

**Files:**
- Create: `src/renderer/components/PageNavigator.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/DialogueTable.tsx`
- Modify: `src/renderer/styles.css`
- Modify: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Write failing renderer tests**

Add this test to `tests/renderer/App.test.tsx`:

```ts
it("shows one page of dialogue at a time and navigates pages", async () => {
  const firstLine: DialogueLine = {
    id: "line-page-one",
    order: 1,
    pageNumber: 1,
    speaker: "Mika",
    dialogueType: "speech",
    lineStatus: "complete",
    sourceLanguage: "en",
    sourceText: "Page one source",
    parseConfidence: 0.9,
    parseWarnings: []
  };
  const secondLine: DialogueLine = {
    id: "line-page-two",
    order: 2,
    pageNumber: 2,
    speaker: "Ren",
    dialogueType: "speech",
    lineStatus: "review",
    sourceLanguage: "en",
    sourceText: "Page two source",
    parseConfidence: 0.9,
    parseWarnings: []
  };

  window.projectApi = {
    importTxtFile: vi.fn().mockResolvedValue({ filePath: "pages.txt", lines: [firstLine, secondLine] }),
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn()
  };

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "TXT 불러오기" }));

  expect(await screen.findByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
  expect(screen.getByLabelText("원문 1")).toHaveValue("Page one source");
  expect(screen.queryByLabelText("원문 2")).not.toBeInTheDocument();
  expect(screen.getByLabelText("페이지 요약")).toHaveTextContent("대사 1");
  expect(screen.getByLabelText("페이지 요약")).toHaveTextContent("완료 1");

  fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));

  expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
  expect(screen.queryByLabelText("원문 1")).not.toBeInTheDocument();
  expect(screen.getByLabelText("원문 2")).toHaveValue("Page two source");
  expect(screen.getByLabelText("페이지 요약")).toHaveTextContent("검토필요 1");

  fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
  expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
});
```

- [ ] **Step 2: Run renderer test to verify failure**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: fails because page navigation controls are missing and table is not page-scoped.

- [ ] **Step 3: Create PageNavigator component**

Create `src/renderer/components/PageNavigator.tsx`:

```tsx
type Props = {
  currentPage: number;
  pageCount: number;
  dialogueCount: number;
  completeCount: number;
  reviewCount: number;
  onPreviousPage: () => void;
  onNextPage: () => void;
};

export function PageNavigator({
  currentPage,
  pageCount,
  dialogueCount,
  completeCount,
  reviewCount,
  onPreviousPage,
  onNextPage
}: Props) {
  return (
    <section className="page-navigator" aria-label="페이지 이동">
      <button type="button" onClick={onPreviousPage} disabled={currentPage <= 1}>
        이전 페이지
      </button>
      <strong aria-label="현재 페이지">
        {currentPage} / {pageCount}
      </strong>
      <button type="button" onClick={onNextPage} disabled={currentPage >= pageCount}>
        다음 페이지
      </button>
      <div className="page-summary" aria-label="페이지 요약">
        <span>대사 {dialogueCount}</span>
        <span>완료 {completeCount}</span>
        <span>검토필요 {reviewCount}</span>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Add page derivation to App**

In `src/renderer/App.tsx`, import `PageNavigator`.

Add helpers after imports:

```ts
function getLinePageNumber(line: DialogueLine) {
  return line.pageNumber ?? 1;
}

function getPageCount(lines: DialogueLine[]) {
  return Math.max(1, ...lines.map(getLinePageNumber));
}

function getLineStatus(line: DialogueLine): LineStatus {
  return line.lineStatus ?? "untranslated";
}
```

Add state:

```ts
const [currentPage, setCurrentPage] = useState(1);
```

Add derived values:

```ts
const pageCount = useMemo(() => getPageCount(project.dialogueLines), [project.dialogueLines]);
const currentPageLines = useMemo(
  () => project.dialogueLines.filter((line) => getLinePageNumber(line) === currentPage),
  [project.dialogueLines, currentPage]
);
const pageSummary = useMemo(
  () => ({
    dialogueCount: currentPageLines.length,
    completeCount: currentPageLines.filter((line) => getLineStatus(line) === "complete").length,
    reviewCount: currentPageLines.filter((line) => getLineStatus(line) === "review").length
  }),
  [currentPageLines]
);
```

When replacing lines:

```ts
setCurrentPage(lines[0]?.pageNumber ?? 1);
```

Add navigation handlers:

```ts
function previousPage() {
  setCurrentPage((page) => Math.max(1, page - 1));
}

function nextPage() {
  setCurrentPage((page) => Math.min(pageCount, page + 1));
}
```

Render `PageNavigator` above `DialogueTable`:

```tsx
<PageNavigator
  currentPage={currentPage}
  pageCount={pageCount}
  dialogueCount={pageSummary.dialogueCount}
  completeCount={pageSummary.completeCount}
  reviewCount={pageSummary.reviewCount}
  onPreviousPage={previousPage}
  onNextPage={nextPage}
/>
```

Pass `currentPageLines` to `DialogueTable`:

```tsx
<DialogueTable
  lines={currentPageLines}
  selectedLineId={selectedLineId}
  onSelectLine={setSelectedLineId}
  onUpdateLine={updateLine}
/>
```

- [ ] **Step 5: Add basic styles**

Add to `src/renderer/styles.css`:

```css
.page-navigator {
  display: grid;
  grid-template-columns: auto auto auto minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
}

.page-navigator button {
  border: 1px solid #1f6feb;
  border-radius: 6px;
  background: #1f6feb;
  color: #fff;
  padding: 8px 12px;
  cursor: pointer;
}

.page-navigator button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.page-summary {
  display: flex;
  gap: 8px;
  color: #4c5560;
  font-size: 12px;
  justify-content: flex-end;
}
```

- [ ] **Step 6: Run renderer tests**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: renderer tests pass or reveal existing tests that need `pageNumber: 1` added to test fixtures.

- [ ] **Step 7: Commit**

```powershell
git add src/renderer/App.tsx src/renderer/components/PageNavigator.tsx src/renderer/components/DialogueTable.tsx src/renderer/styles.css tests/renderer/App.test.tsx
git commit -m "feat: navigate dialogue by page"
```

---

### Task 4: Add Editable Page Number Per Line

**Files:**
- Modify: `src/renderer/components/DialogueTable.tsx`
- Modify: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Write failing page edit test**

Add to `tests/renderer/App.test.tsx`:

```ts
it("moves a dialogue line to another page when its page number changes", async () => {
  const line: DialogueLine = {
    id: "line-page-edit",
    order: 1,
    pageNumber: 1,
    speaker: "Mika",
    dialogueType: "speech",
    sourceLanguage: "en",
    sourceText: "Move me",
    parseConfidence: 0.9,
    parseWarnings: []
  };

  window.projectApi = {
    importTxtFile: vi.fn().mockResolvedValue({ filePath: "page-edit.txt", lines: [line] }),
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn()
  };

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "TXT 불러오기" }));
  expect(await screen.findByLabelText("원문 1")).toHaveValue("Move me");

  fireEvent.change(screen.getByLabelText("테이블 페이지 1"), { target: { value: "2" } });

  expect(screen.queryByLabelText("원문 1")).not.toBeInTheDocument();
  expect(screen.getByText("현재 페이지에 대사가 없습니다.")).toBeInTheDocument();
  expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
  expect(screen.getByLabelText("원문 1")).toHaveValue("Move me");
});
```

- [ ] **Step 2: Run renderer test to verify failure**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: fails because page number editor is missing.

- [ ] **Step 3: Add page number field to row metadata**

In `src/renderer/components/DialogueTable.tsx`, add a metadata field before speaker:

```tsx
<div className="metadata-field">
  <span>페이지</span>
  <input
    type="number"
    min={1}
    value={line.pageNumber ?? 1}
    onChange={(event) =>
      onUpdateLine({
        ...line,
        pageNumber: Math.max(1, Number.parseInt(event.target.value, 10) || 1)
      })
    }
    aria-label={`테이블 페이지 ${line.order}`}
  />
</div>
```

Update `.row-metadata` columns in `src/renderer/styles.css` to make room:

```css
.row-metadata {
  grid-template-columns: minmax(72px, 0.5fr) minmax(104px, 1fr) minmax(104px, 1fr) minmax(92px, 0.7fr) minmax(104px, 0.8fr) minmax(96px, 0.7fr) auto;
}
```

- [ ] **Step 4: Add empty current page copy**

In `DialogueTable`, change the empty filtered-state branch so it distinguishes an empty page:

```tsx
) : visibleLines.length === 0 ? (
  <div className="empty-state">{lines.length === 0 ? "현재 페이지에 대사가 없습니다." : "현재 필터와 일치하는 라인이 없습니다."}</div>
) : (
```

If `lines.length === 0` is already handled by the top-level empty import state, split props by adding `hasProjectLines: boolean` to `DialogueTable`. Use:

```tsx
{!hasProjectLines ? (
  <div className="empty-state">TXT 파일을 불러오면 편집을 시작할 수 있습니다.</div>
) : lines.length === 0 ? (
  <div className="empty-state">현재 페이지에 대사가 없습니다.</div>
) : visibleLines.length === 0 ? (
  <div className="empty-state">현재 필터와 일치하는 라인이 없습니다.</div>
) : (
```

- [ ] **Step 5: Run renderer tests**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: renderer tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/renderer/components/DialogueTable.tsx src/renderer/styles.css tests/renderer/App.test.tsx
git commit -m "feat: edit dialogue page numbers"
```

---

### Task 5: Add Image Asset Copy And Hash Verification

**Files:**
- Create: `src/main/pageImageAssets.ts`
- Create: `tests/storage/pageImageAssets.test.ts`

- [ ] **Step 1: Write failing storage tests**

Create `tests/storage/pageImageAssets.test.ts`:

```ts
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyPageImageAsset } from "../../src/main/pageImageAssets";

let tempDir: string;

beforeEach(async () => {
  tempDir = join(tmpdir(), `page-image-assets-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await import("node:fs/promises").then(({ rm }) => rm(tempDir, { recursive: true, force: true }));
});

describe("copyPageImageAsset", () => {
  it("copies image bytes and returns verified metadata", async () => {
    const sourcePath = join(tempDir, "scan_001.jpg");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));

    const result = await copyPageImageAsset({
      sourcePath,
      projectFilePath: join(tempDir, "Project.ctp"),
      pageNumber: 1,
      now: new Date("2026-05-29T00:00:00.000Z")
    });

    expect(result.pageImage.pageNumber).toBe(1);
    expect(result.pageImage.originalFileName).toBe("scan_001.jpg");
    expect(result.pageImage.mimeType).toBe("image/jpeg");
    expect(result.pageImage.byteSize).toBe(4);
    expect(result.pageImage.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(result.absoluteStoredPath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects unsupported image extensions", async () => {
    const sourcePath = join(tempDir, "notes.txt");
    await writeFile(sourcePath, "not an image");

    await expect(
      copyPageImageAsset({
        sourcePath,
        projectFilePath: join(tempDir, "Project.ctp"),
        pageNumber: 1,
        now: new Date("2026-05-29T00:00:00.000Z")
      })
    ).rejects.toThrow(/unsupported image/i);
  });

  it("creates collision-free stored file names", async () => {
    const sourcePath = join(tempDir, "scan_001.jpg");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));

    const first = await copyPageImageAsset({
      sourcePath,
      projectFilePath: join(tempDir, "Project.ctp"),
      pageNumber: 1,
      now: new Date("2026-05-29T00:00:00.000Z")
    });
    const second = await copyPageImageAsset({
      sourcePath,
      projectFilePath: join(tempDir, "Project.ctp"),
      pageNumber: 1,
      now: new Date("2026-05-29T00:00:00.000Z")
    });

    expect(first.pageImage.storedRelativePath).not.toBe(second.pageImage.storedRelativePath);
    await expect(stat(first.absoluteStoredPath)).resolves.toBeTruthy();
    await expect(stat(second.absoluteStoredPath)).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run storage test to verify failure**

Run:

```powershell
npm test -- tests/storage/pageImageAssets.test.ts
```

Expected: fails because `pageImageAssets.ts` does not exist.

- [ ] **Step 3: Implement page image asset copying**

Create `src/main/pageImageAssets.ts`:

```ts
import { copyFile, mkdir, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, dirname, extname, join, parse, relative } from "node:path";
import type { PageImage } from "../shared/projectTypes.js";

type CopyPageImageArgs = {
  sourcePath: string;
  projectFilePath: string;
  pageNumber: number;
  now?: Date;
};

const mimeTypes = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);

export async function copyPageImageAsset(args: CopyPageImageArgs): Promise<{
  pageImage: PageImage;
  absoluteStoredPath: string;
}> {
  if (!Number.isInteger(args.pageNumber) || args.pageNumber < 1) {
    throw new Error("Invalid image page number");
  }

  const extension = extname(args.sourcePath).toLowerCase();
  const mimeType = mimeTypes.get(extension);
  if (!mimeType) throw new Error("Unsupported image file extension");

  const project = parse(args.projectFilePath);
  const assetRoot = join(project.dir, `${project.name}-assets`, "images");
  await mkdir(assetRoot, { recursive: true });

  const absoluteStoredPath = await nextStoredPath(assetRoot, args.pageNumber, extension);
  await copyFile(args.sourcePath, absoluteStoredPath);

  const [sourceHash, copiedHash] = await Promise.all([sha256File(args.sourcePath), sha256File(absoluteStoredPath)]);
  if (sourceHash !== copiedHash) {
    await import("node:fs/promises").then(({ rm }) => rm(absoluteStoredPath, { force: true }));
    throw new Error("Image copy verification failed");
  }

  const copiedStat = await stat(absoluteStoredPath);
  const storedRelativePath = relative(dirname(args.projectFilePath), absoluteStoredPath).replaceAll("\\", "/");
  return {
    absoluteStoredPath,
    pageImage: {
      id: randomUUID(),
      pageNumber: args.pageNumber,
      storedRelativePath,
      originalFileName: basename(args.sourcePath),
      sha256: copiedHash,
      byteSize: copiedStat.size,
      mimeType,
      copiedAt: (args.now ?? new Date()).toISOString()
    }
  };
}

async function nextStoredPath(assetRoot: string, pageNumber: number, extension: string) {
  const pageName = `page-${String(pageNumber).padStart(3, "0")}`;
  let suffix = "";
  let attempt = 1;

  while (true) {
    const candidate = join(assetRoot, `${pageName}${suffix}${extension}`);
    try {
      await stat(candidate);
      attempt += 1;
      suffix = `-${attempt}`;
    } catch {
      return candidate;
    }
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
```

- [ ] **Step 4: Run storage tests**

Run:

```powershell
npm test -- tests/storage/pageImageAssets.test.ts
```

Expected: storage tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/main/pageImageAssets.ts tests/storage/pageImageAssets.test.ts
git commit -m "feat: copy page image assets with hash verification"
```

---

### Task 6: Add Image Upload IPC

**Files:**
- Modify: `src/main/ipcHandlers.ts`
- Modify: `src/renderer/electronApi.ts`
- Modify: `tests/main/ipcHandlers.test.ts`
- Modify: `tests/main/ipcHandlers.integration.test.ts`

- [ ] **Step 1: Write failing IPC validation tests**

Add to `tests/main/ipcHandlers.test.ts`:

```ts
import { validateImportPageImagesArgs } from "../../src/main/ipcHandlers";

it("validates page image import payloads", () => {
  expect(
    validateImportPageImagesArgs({
      projectFilePath: "C:\\projects\\Book.ctp",
      files: [
        { sourcePath: "C:\\images\\one.jpg", pageNumber: 1 },
        { sourcePath: "C:\\images\\two.png", pageNumber: 2 }
      ]
    })
  ).toEqual({
    projectFilePath: "C:\\projects\\Book.ctp",
    files: [
      { sourcePath: "C:\\images\\one.jpg", pageNumber: 1 },
      { sourcePath: "C:\\images\\two.png", pageNumber: 2 }
    ]
  });

  expect(() => validateImportPageImagesArgs({ projectFilePath: "Book.txt", files: [] })).toThrow(/\.ctp/);
  expect(() => validateImportPageImagesArgs({ projectFilePath: "Book.ctp", files: [{ sourcePath: 1, pageNumber: 1 }] })).toThrow(/sourcePath/);
  expect(() => validateImportPageImagesArgs({ projectFilePath: "Book.ctp", files: [{ sourcePath: "one.jpg", pageNumber: 0 }] })).toThrow(/pageNumber/);
});
```

- [ ] **Step 2: Run IPC validation tests to verify failure**

Run:

```powershell
npm test -- tests/main/ipcHandlers.test.ts
```

Expected: fails because `validateImportPageImagesArgs` does not exist.

- [ ] **Step 3: Add IPC types and validator**

In `src/main/ipcHandlers.ts`, import `copyPageImageAsset`.

Add:

```ts
export type ImportPageImagesArgs = {
  projectFilePath: string;
  files: Array<{
    sourcePath: string;
    pageNumber: number;
  }>;
};

export function validateImportPageImagesArgs(args: unknown): ImportPageImagesArgs {
  if (!isRecord(args)) throw new Error("Invalid image import request: expected object");
  if (typeof args.projectFilePath !== "string") {
    throw new Error("Invalid image import request: projectFilePath must be a string");
  }
  assertFileExtension(args.projectFilePath, ".ctp", "Image import project path must end with .ctp");
  if (!Array.isArray(args.files)) throw new Error("Invalid image import request: files must be an array");

  return {
    projectFilePath: args.projectFilePath,
    files: args.files.map((file) => {
      if (!isRecord(file)) throw new Error("Invalid image import request: file must be an object");
      if (typeof file.sourcePath !== "string") {
        throw new Error("Invalid image import request: sourcePath must be a string");
      }
      if (!Number.isInteger(file.pageNumber) || file.pageNumber < 1) {
        throw new Error("Invalid image import request: pageNumber must be a positive integer");
      }
      return { sourcePath: file.sourcePath, pageNumber: file.pageNumber };
    })
  };
}
```

- [ ] **Step 4: Add handler**

In `registerIpcHandlers`, add:

```ts
ipcMain.handle("project:importPageImages", async (_event, args) => {
  const imageArgs = validateImportPageImagesArgs(args);
  const results = [];

  for (const file of imageArgs.files) {
    try {
      const result = await copyPageImageAsset({
        sourcePath: file.sourcePath,
        projectFilePath: imageArgs.projectFilePath,
        pageNumber: file.pageNumber
      });
      results.push({ ok: true as const, pageImage: result.pageImage });
    } catch (error) {
      results.push({
        ok: false as const,
        sourcePath: file.sourcePath,
        message: error instanceof Error ? error.message : "Failed to import image"
      });
    }
  }

  return results;
});
```

- [ ] **Step 5: Extend renderer API type**

In `src/renderer/electronApi.ts`, import `PageImage`.

Add:

```ts
importPageImages: (args: {
  projectFilePath: string;
  files: Array<{ sourcePath: string; pageNumber: number }>;
}) => Promise<Array<{ ok: true; pageImage: PageImage } | { ok: false; sourcePath: string; message: string }>>;
```

- [ ] **Step 6: Add preload exposure**

In `electron/preload.ts`, add this method to the existing `projectApi` exposure:

```ts
importPageImages: (args: { projectFilePath: string; files: Array<{ sourcePath: string; pageNumber: number }> }) =>
  ipcRenderer.invoke("project:importPageImages", args),
```

Use the existing `projectApi` exposure style exactly.

- [ ] **Step 7: Run IPC tests**

Run:

```powershell
npm test -- tests/main/ipcHandlers.test.ts tests/main/ipcHandlers.integration.test.ts
```

Expected: IPC tests pass.

- [ ] **Step 8: Commit**

```powershell
git add src/main/ipcHandlers.ts src/renderer/electronApi.ts electron/preload.ts tests/main/ipcHandlers.test.ts tests/main/ipcHandlers.integration.test.ts
git commit -m "feat: add page image import ipc"
```

---

### Task 7: Add Left/Right Page Workspace And Image Panel

**Files:**
- Create: `src/renderer/components/PageImagePanel.tsx`
- Create: `src/renderer/components/ImageImportPanel.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`
- Modify: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Write failing renderer tests for image states**

Add to `tests/renderer/App.test.tsx`:

```ts
it("shows the current page image when page image metadata exists", async () => {
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProject: vi.fn().mockResolvedValue({
      filePath: "C:\\projects\\Book.ctp",
      encrypted: false,
      project: {
        schemaVersion: 1,
        metadata: {
          id: "project-images",
          title: "Image Project",
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:00.000Z",
          secret: false
        },
        characters: [],
        dictionaryTerms: [],
        dialogueLines: [],
        pageImages: [
          {
            id: "page-image-1",
            pageNumber: 1,
            storedRelativePath: "Book-assets/images/page-001.jpg",
            originalFileName: "scan_001.jpg",
            sha256: "a".repeat(64),
            byteSize: 4,
            mimeType: "image/jpeg",
            copiedAt: "2026-05-29T00:00:00.000Z"
          }
        ],
        settings: { defaultSourceLanguage: "unknown" }
      }
    }),
    saveProject: vi.fn(),
    importPageImages: vi.fn()
  };
  vi.spyOn(window, "prompt").mockReturnValue("");

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "열기" }));

  expect(await screen.findByAltText("1페이지 이미지")).toHaveAttribute("src", expect.stringContaining("Book-assets/images/page-001.jpg"));
});
```

Add:

```ts
it("disables image upload for secret projects", () => {
  render(<App />);

  fireEvent.click(screen.getByLabelText("시크릿 프로젝트"));

  expect(screen.getByRole("button", { name: "이미지 업로드" })).toBeDisabled();
  expect(screen.getByText("시크릿 프로젝트에서는 이미지 업로드가 아직 지원되지 않습니다.")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run renderer tests to verify failure**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: fails because image panel and image upload control do not exist.

- [ ] **Step 3: Create PageImagePanel**

Create `src/renderer/components/PageImagePanel.tsx`:

```tsx
import type { PageImage } from "../../shared/projectTypes";

type Props = {
  currentPage: number;
  image: PageImage | null;
};

export function PageImagePanel({ currentPage, image }: Props) {
  return (
    <section className="page-image-panel" aria-label="페이지 이미지">
      {image ? (
        <img alt={`${currentPage}페이지 이미지`} src={image.storedRelativePath} />
      ) : (
        <div className="page-image-empty">현재 페이지 이미지가 없습니다.</div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Create ImageImportPanel**

Create `src/renderer/components/ImageImportPanel.tsx`:

```tsx
type Props = {
  disabled: boolean;
  onImportImages: () => Promise<void>;
};

export function ImageImportPanel({ disabled, onImportImages }: Props) {
  return (
    <section className="panel-section">
      <button type="button" onClick={onImportImages} disabled={disabled}>
        이미지 업로드
      </button>
      {disabled ? (
        <p>시크릿 프로젝트에서는 이미지 업로드가 아직 지원되지 않습니다.</p>
      ) : (
        <p>페이지 이미지를 프로젝트 asset 폴더로 복사합니다.</p>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Wire page image state in App**

In `src/renderer/App.tsx`, import both new components.

Derive current image:

```ts
const currentPageImage = useMemo(
  () => project.pageImages.find((image) => image.pageNumber === currentPage) ?? null,
  [project.pageImages, currentPage]
);
```

Add a temporary import handler that returns a clear status message until Task 8 wires the full import flow:

```ts
async function importPageImages() {
  setStatusMessage("이미지 업로드는 파일 선택 연결 후 사용할 수 있습니다.");
}
```

Render in left panel below `ImportPanel`:

```tsx
<ImageImportPanel disabled={project.metadata.secret} onImportImages={importPageImages} />
```

Wrap table area:

```tsx
<section className="page-workspace">
  <PageImagePanel currentPage={currentPage} image={currentPageImage} />
  <div className="page-dialogue-workspace">
    <PageNavigator
      currentPage={currentPage}
      pageCount={pageCount}
      dialogueCount={pageSummary.dialogueCount}
      completeCount={pageSummary.completeCount}
      reviewCount={pageSummary.reviewCount}
      onPreviousPage={previousPage}
      onNextPage={nextPage}
    />
    <DialogueTable
      lines={currentPageLines}
      selectedLineId={selectedLineId}
      onSelectLine={setSelectedLineId}
      onUpdateLine={updateLine}
      hasProjectLines={project.dialogueLines.length > 0}
    />
  </div>
</section>
```

- [ ] **Step 6: Add styles**

Add:

```css
.page-workspace {
  display: grid;
  grid-template-columns: minmax(260px, 0.9fr) minmax(520px, 1.1fr);
  gap: 16px;
  min-width: 0;
}

.page-dialogue-workspace {
  min-width: 0;
}

.page-image-panel {
  min-height: 420px;
  border: 1px solid #d7dce2;
  background: #111827;
  display: grid;
  place-items: center;
  overflow: auto;
}

.page-image-panel img {
  max-width: 100%;
  height: auto;
  display: block;
}

.page-image-empty {
  color: #d1d5db;
  font-size: 13px;
}
```

- [ ] **Step 7: Run renderer tests**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: renderer tests pass.

- [ ] **Step 8: Commit**

```powershell
git add src/renderer/App.tsx src/renderer/components/PageImagePanel.tsx src/renderer/components/ImageImportPanel.tsx src/renderer/styles.css tests/renderer/App.test.tsx
git commit -m "feat: add page image workspace"
```

---

### Task 8: Wire Renderer Image Import Results

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Write failing import result test**

Add to `tests/renderer/App.test.tsx`:

```ts
it("adds imported page image metadata to the current project", async () => {
  const importPageImages = vi.fn().mockResolvedValue([
    {
      ok: true,
      pageImage: {
        id: "page-image-imported",
        pageNumber: 1,
        storedRelativePath: "Book-assets/images/page-001.jpg",
        originalFileName: "scan_001.jpg",
        sha256: "b".repeat(64),
        byteSize: 4,
        mimeType: "image/jpeg",
        copiedAt: "2026-05-29T00:00:00.000Z"
      }
    }
  ]);
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn(),
    importPageImages
  };
  vi.spyOn(window, "prompt").mockReturnValue("C:\\images\\scan_001.jpg");

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "다른 이름 저장" }));
  await screen.findByText("프로젝트를 저장했습니다.");

  fireEvent.click(screen.getByRole("button", { name: "이미지 업로드" }));

  expect(importPageImages).toHaveBeenCalledWith({
    projectFilePath: "C:\\projects\\Book.ctp",
    files: [{ sourcePath: "C:\\images\\scan_001.jpg", pageNumber: 1 }]
  });
  expect(await screen.findByAltText("1페이지 이미지")).toBeInTheDocument();
  expect(screen.getByText("이미지 1개를 등록했습니다.")).toBeInTheDocument();
});
```

For the first implementation, using `window.prompt` for a single image path is acceptable because native multi-file picker UI can be improved later. This keeps the end-to-end metadata path testable.

- [ ] **Step 2: Run renderer test to verify failure**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: fails because `importPageImages` only reports that file selection is not connected yet.

- [ ] **Step 3: Implement renderer import result handling**

In `src/renderer/App.tsx`, replace `importPageImages` with:

```ts
async function importPageImages() {
  if (!window.projectApi?.importPageImages) return;
  if (project.metadata.secret) {
    setStatusMessage("시크릿 프로젝트에서는 이미지 업로드가 아직 지원되지 않습니다.");
    return;
  }
  if (!currentFilePath) {
    setStatusMessage("이미지를 업로드하려면 먼저 프로젝트를 저장하세요.");
    return;
  }

  const sourcePath = window.prompt("업로드할 이미지 파일 경로")?.trim();
  if (!sourcePath) {
    setStatusMessage("이미지 업로드를 취소했습니다.");
    return;
  }

  const results = await window.projectApi.importPageImages({
    projectFilePath: currentFilePath,
    files: [{ sourcePath, pageNumber: currentPage }]
  });
  const importedImages = results.flatMap((result) => (result.ok ? [result.pageImage] : []));
  if (importedImages.length === 0) {
    setStatusMessage(results[0]?.ok === false ? results[0].message : "이미지를 등록하지 못했습니다.");
    return;
  }

  setProject((current) => ({
    ...current,
    pageImages: [
      ...current.pageImages.filter((image) => !importedImages.some((nextImage) => nextImage.pageNumber === image.pageNumber)),
      ...importedImages
    ],
    metadata: { ...current.metadata, updatedAt: new Date().toISOString() }
  }));
  setIsDirty(true);
  setStatusMessage(`이미지 ${importedImages.length}개를 등록했습니다.`);
}
```

- [ ] **Step 4: Run renderer tests**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: renderer tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/App.tsx tests/renderer/App.test.tsx
git commit -m "feat: register imported page images"
```

---

### Task 9: Full Verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run full test suite**

Run:

```powershell
npm test
```

Expected: all test files pass.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: TypeScript exits 0.

- [ ] **Step 3: Run IPC smoke**

Run:

```powershell
npm run smoke:ipc
```

Expected: IPC integration smoke tests pass.

- [ ] **Step 4: Run audit**

Run:

```powershell
npm audit --omit=optional
```

Expected: `found 0 vulnerabilities`.

- [ ] **Step 5: Run production build**

Run:

```powershell
$env:PATH='C:\Users\ksaei\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH; npm run build
```

Expected: Vite build succeeds and emits `dist-renderer`.

- [ ] **Step 6: Browser verification**

Open:

```text
http://localhost:4173/
```

Verify:

- Page navigation controls are visible.
- Empty current page state appears when a page has no dialogue.
- Image panel appears on the left side of the workspace.
- Secret project disables image upload.
- Console has no warnings or errors.

- [ ] **Step 7: Final commit if verification required changes**

If any verification fix was needed:

```powershell
git add src/shared/projectTypes.ts src/shared/projectValidation.ts src/main/dialogueParser.ts src/main/pageImageAssets.ts src/main/ipcHandlers.ts src/renderer/App.tsx src/renderer/electronApi.ts src/renderer/components src/renderer/styles.css electron/preload.ts tests
git commit -m "fix: stabilize page image workflow"
```

If no changes were needed, do not create an empty commit.

---

## Self-Review

- Spec coverage: The plan covers `pageNumber`, parser page markers, manual page correction, page navigation, page summaries, image metadata, byte-preserving asset copy, SHA-256 verification, image count page expansion through `pageImages`, left/right layout, secret-project upload disabling, and verification.
- Scope control: OCR, bubble detection, image re-encoding, thumbnails, reordering, and encrypted image assets remain out of scope.
- Type consistency: `DialogueLine.pageNumber`, `PageImage`, `TranslationProject.pageImages`, and `importPageImages` use the same names across schema, IPC, renderer, and tests.
