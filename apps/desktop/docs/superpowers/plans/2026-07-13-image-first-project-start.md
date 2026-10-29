# Image-First Project Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make image selection the first project action, persist the new project before importing its images, and keep image-only projects in the working UI.

**Architecture:** Extend the pure workspace presentation model with image count, then add a renderer-only orchestration module that composes the existing Electron APIs without changing IPC or storage schemas. `App.tsx` owns confirmation and React state, while `WorkspaceStartPanel` owns only the visible image-first controls and progress presentation.

**Tech Stack:** React 19, TypeScript 6, Electron 42, Vitest 4, Testing Library, existing CSS design tokens.

## Global Constraints

- Run every command in PowerShell from `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기`.
- Do not add packages or change the project file schema, IPC contract, security settings, or Electron build configuration.
- Preserve TXT import, project open/save/export, OCR, translation review, inpainting, and secret-project restrictions.
- Do not modify generated output, `node_modules`, lock files, `dist`, `dist-electron`, `dist-renderer`, `release`, or coverage files.
- An empty workspace means `dialogueLines.length === 0 && pageImages.length === 0`.
- The start order is image selection, save-location selection, initial project save, image import, final project save, then image workspace display.
- Canceling image selection or save-location selection must preserve the currently open project.
- Use the existing `choosePageImageFiles`, `chooseSaveFile`, `saveProject`, and `importPageImages` APIs.
- Use test-driven development and commit each independently reviewable task.

## File Map

- Modify `src/renderer/workspacePresentation.ts`: calculate empty/workspace visibility from both line and image counts.
- Modify `tests/renderer/workspacePresentation.test.ts`: lock the image-only and saved-empty presentation contracts.
- Create `src/renderer/imageProjectStart.ts`: pure async orchestration of existing Electron APIs with typed progress and results.
- Create `tests/renderer/imageProjectStart.test.ts`: verify call order, cancellation, failure, partial success, and page mapping.
- Modify `src/renderer/components/WorkspaceStartPanel.tsx`: render the image-first CTA, TXT fallback, open action, busy state, and visible status.
- Modify `tests/renderer/WorkspaceStartPanel.test.tsx`: lock copy, hierarchy, callbacks, busy behavior, and visible feedback.
- Modify `src/renderer/App.tsx`: connect the orchestrator, replace `newProject`, pass `imageCount`, apply results, and preserve current work on cancellation.
- Modify `tests/renderer/App.test.tsx`: cover the complete image-first flow and regressions.
- Modify `src/renderer/styles.css`: style the visible status without introducing a separate visual system.

---

### Task 1: Make Workspace Presentation Image-Aware

**Files:**
- Modify: `src/renderer/workspacePresentation.ts`
- Test: `tests/renderer/workspacePresentation.test.ts`

**Interfaces:**
- Consumes: `{ currentFilePath, lineCount, imageCount, isDirty, apiReady }`.
- Produces: unchanged `WorkspacePresentation`; `isEmptyWorkspace` is true only when both counts are zero.

- [ ] **Step 1: Add failing image-aware presentation tests**

Update every existing call with `imageCount: 0`, then add these cases:

```ts
it("shows the image workspace for a saved project with images but no dialogue", () => {
  expect(
    getWorkspacePresentation({
      currentFilePath: "C:\\work\\images.ctp",
      lineCount: 0,
      imageCount: 2,
      isDirty: false,
      apiReady: true
    })
  ).toMatchObject({
    isEmptyWorkspace: false,
    showStartPanel: false,
    showWorkspaceChrome: true,
    showPageControls: true,
    showBottomPanel: true,
    showInspector: true,
    showSave: true,
    showExport: false,
    saveLabel: "저장됨"
  });
});

it("keeps a saved project empty when it has neither lines nor images", () => {
  expect(
    getWorkspacePresentation({
      currentFilePath: "C:\\work\\empty.ctp",
      lineCount: 0,
      imageCount: 0,
      isDirty: false,
      apiReady: true
    })
  ).toMatchObject({ isEmptyWorkspace: true, showStartPanel: true });
});
```

- [ ] **Step 2: Run the focused test and verify the new contract fails**

```powershell
Set-Location 'C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기'
npx vitest run tests/renderer/workspacePresentation.test.ts
```

Expected: FAIL because `imageCount` is not accepted and an image-only project is still treated as empty.

- [ ] **Step 3: Implement the minimal presentation change**

Change the argument and content predicates in `getWorkspacePresentation`:

```ts
export function getWorkspacePresentation(args: {
  currentFilePath: string | null;
  lineCount: number;
  imageCount: number;
  isDirty: boolean;
  apiReady: boolean;
}): WorkspacePresentation {
  const hasSavedFile = Boolean(args.currentFilePath);
  const hasLines = args.lineCount > 0;
  const hasImages = args.imageCount > 0;
  const hasContent = hasLines || hasImages;
  const isEmptyWorkspace = !hasContent;

  return {
    isEmptyWorkspace,
    showStartPanel: isEmptyWorkspace,
    showWorkspaceChrome: !isEmptyWorkspace,
    showPageControls: !isEmptyWorkspace,
    showBottomPanel: !isEmptyWorkspace,
    showInspector: !isEmptyWorkspace,
    showSave: args.apiReady && (hasSavedFile || hasContent),
    showSaveAs: args.apiReady,
    showExport: args.apiReady && hasLines,
    saveLabel: !hasSavedFile
      ? isEmptyWorkspace
        ? "새 프로젝트"
        : "저장 필요"
      : args.isDirty
        ? "변경 있음"
        : "저장됨"
  };
}
```

- [ ] **Step 4: Run focused tests and typecheck**

```powershell
npx vitest run tests/renderer/workspacePresentation.test.ts
npm run typecheck
```

Expected: presentation tests PASS; typecheck reports `App.tsx` as the only call site still missing `imageCount`. Add `imageCount: project.pageImages?.length ?? 0` to that call, rerun, and expect PASS.

- [ ] **Step 5: Commit the presentation contract**

```powershell
git add -- src/renderer/workspacePresentation.ts src/renderer/App.tsx tests/renderer/workspacePresentation.test.ts
git commit -m "fix: keep image-only projects in workspace"
```

---

### Task 2: Add a Typed Image Project Start Orchestrator

**Files:**
- Create: `src/renderer/imageProjectStart.ts`
- Create: `tests/renderer/imageProjectStart.test.ts`

**Interfaces:**
- Consumes: `startImageProject(args: StartImageProjectArgs): Promise<ImageProjectStartResult>`.
- Produces: progress phases plus `canceled`, `success`, `partial`, or `failed` results that `App.tsx` can apply without inspecting thrown errors.

- [ ] **Step 1: Write failing tests for cancellation and API order**

Create `tests/renderer/imageProjectStart.test.ts` with deterministic project/image fixtures and these assertions:

```ts
import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../../src/shared/projectValidation";
import type { PageImage } from "../../src/shared/projectTypes";
import { startImageProject } from "../../src/renderer/imageProjectStart";

const image: PageImage = {
  id: "page-image-1",
  pageNumber: 1,
  storedRelativePath: "Book-assets/images/page-001.jpg",
  originalFileName: "page-001.jpg",
  sha256: "a".repeat(64),
  byteSize: 4,
  mimeType: "image/jpeg",
  copiedAt: "2026-07-13T00:00:00.000Z"
};

function setup() {
  return {
    project: createEmptyProject("새 프로젝트", false),
    chooseImageFiles: vi.fn().mockResolvedValue(["C:\\images\\page-001.jpg"]),
    chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
    saveProject: vi.fn().mockResolvedValue(undefined),
    importPageImages: vi.fn().mockResolvedValue([{ ok: true as const, pageImage: image }]),
    onProgress: vi.fn(),
    now: () => "2026-07-13T00:00:00.000Z"
  };
}

describe("startImageProject", () => {
  it("stops before choosing a save path when image selection is canceled", async () => {
    const args = setup();
    args.chooseImageFiles.mockResolvedValue(null);

    await expect(startImageProject(args)).resolves.toEqual({ kind: "canceled", step: "image-selection" });
    expect(args.chooseSaveFile).not.toHaveBeenCalled();
    expect(args.saveProject).not.toHaveBeenCalled();
    expect(args.importPageImages).not.toHaveBeenCalled();
  });

  it("saves, imports ordered pages, and saves the completed project", async () => {
    const args = setup();
    args.chooseImageFiles.mockResolvedValue(["C:\\images\\01.jpg", "C:\\images\\02.png"]);
    args.importPageImages.mockResolvedValue([{ ok: true, pageImage }, { ok: false, sourcePath: "C:\\images\\02.png", message: "bad image" }]);

    const result = await startImageProject(args);

    expect(args.importPageImages).toHaveBeenCalledWith({
      projectFilePath: "C:\\projects\\Book.ctp",
      files: [
        { sourcePath: "C:\\images\\01.jpg", pageNumber: 1 },
        { sourcePath: "C:\\images\\02.png", pageNumber: 2 }
      ]
    });
    expect(args.saveProject).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ kind: "partial", importedCount: 1, failedCount: 1 });
  });
});
```

Complete the result matrix with these tests:

```ts
it("reports image chooser failure without mutating storage", async () => {
  const args = setup();
  args.chooseImageFiles.mockRejectedValueOnce(new Error("chooser failed"));
  await expect(startImageProject(args)).resolves.toEqual({ kind: "failed", stage: "image-selection", message: "chooser failed" });
  expect(args.chooseSaveFile).not.toHaveBeenCalled();
  expect(args.saveProject).not.toHaveBeenCalled();
});

it("reports save chooser failure before writing the project", async () => {
  const args = setup();
  args.chooseSaveFile.mockRejectedValueOnce(new Error("save chooser failed"));
  await expect(startImageProject(args)).resolves.toEqual({ kind: "failed", stage: "save-selection", message: "save chooser failed" });
  expect(args.saveProject).not.toHaveBeenCalled();
  expect(args.importPageImages).not.toHaveBeenCalled();
});

it("stops before saving when save selection is canceled", async () => {
  const args = setup();
  args.chooseSaveFile.mockResolvedValue(null);
  await expect(startImageProject(args)).resolves.toEqual({ kind: "canceled", step: "save-selection" });
  expect(args.saveProject).not.toHaveBeenCalled();
  expect(args.importPageImages).not.toHaveBeenCalled();
});

it("does not import when the initial save fails", async () => {
  const args = setup();
  args.saveProject.mockRejectedValueOnce(new Error("save failed"));
  await expect(startImageProject(args)).resolves.toEqual({ kind: "failed", stage: "initial-save", message: "save failed" });
  expect(args.importPageImages).not.toHaveBeenCalled();
});

it("returns the saved empty project when import rejects", async () => {
  const args = setup();
  args.importPageImages.mockRejectedValueOnce(new Error("import failed"));
  await expect(startImageProject(args)).resolves.toMatchObject({
    kind: "failed",
    stage: "image-import",
    filePath: "C:\\projects\\Book.ctp",
    importedCount: 0,
    failedCount: 1,
    dirty: false,
    message: "import failed"
  });
  expect(args.saveProject).toHaveBeenCalledOnce();
});

it("distinguishes all returned imports failing from cancellation", async () => {
  const args = setup();
  args.importPageImages.mockResolvedValue([{ ok: false, sourcePath: "C:\\images\\page-001.jpg", message: "bad image" }]);
  await expect(startImageProject(args)).resolves.toMatchObject({
    kind: "failed",
    stage: "image-import",
    importedCount: 0,
    failedCount: 1,
    message: "bad image"
  });
});

it("returns success after saving all imported images", async () => {
  const args = setup();
  await expect(startImageProject(args)).resolves.toMatchObject({
    kind: "success",
    importedCount: 1,
    failedCount: 0,
    dirty: false,
    project: { pageImages: [image] }
  });
  expect(args.saveProject).toHaveBeenCalledTimes(2);
});

it("returns imported images as dirty when the final save fails", async () => {
  const args = setup();
  args.saveProject.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("final save failed"));
  await expect(startImageProject(args)).resolves.toMatchObject({
    kind: "failed",
    stage: "final-save",
    importedCount: 1,
    failedCount: 0,
    dirty: true,
    message: "final save failed",
    project: { pageImages: [image] }
  });
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

```powershell
npx vitest run tests/renderer/imageProjectStart.test.ts
```

Expected: FAIL because `src/renderer/imageProjectStart.ts` does not exist.

- [ ] **Step 3: Create the orchestrator types and implementation**

Create `src/renderer/imageProjectStart.ts` with these public types and control flow:

```ts
import type { ElectronProjectApi } from "./electronApi";
import type { PageImage, TranslationProject } from "../shared/projectTypes";

type ImportPageImages = NonNullable<ElectronProjectApi["importPageImages"]>;

export type ImageProjectStartPhase = "image-selection" | "save-selection" | "initial-save" | "image-import" | "final-save";

export type StartImageProjectArgs = {
  project: TranslationProject;
  chooseImageFiles: () => Promise<string[] | null>;
  chooseSaveFile: ElectronProjectApi["chooseSaveFile"];
  saveProject: ElectronProjectApi["saveProject"];
  importPageImages: ImportPageImages;
  onProgress: (phase: ImageProjectStartPhase) => void;
  now?: () => string;
};

type AppliedProject = {
  filePath: string;
  project: TranslationProject;
  importedCount: number;
  failedCount: number;
  dirty: boolean;
};

export type ImageProjectStartResult =
  | { kind: "canceled"; step: "image-selection" | "save-selection" }
  | ({ kind: "success" | "partial" } & AppliedProject)
  | ({ kind: "failed"; stage: "image-selection" | "save-selection" | "initial-save"; message: string })
  | ({ kind: "failed"; stage: "image-import"; message: string } & AppliedProject)
  | ({ kind: "failed"; stage: "final-save"; message: string } & AppliedProject);

export async function startImageProject(args: StartImageProjectArgs): Promise<ImageProjectStartResult> {
  args.onProgress("image-selection");
  let sourcePaths: string[];
  try {
    sourcePaths = (await args.chooseImageFiles()) ?? [];
  } catch (error) {
    return { kind: "failed", stage: "image-selection", message: toMessage(error, "이미지 선택 창을 열지 못했습니다.") };
  }
  if (sourcePaths.length === 0) return { kind: "canceled", step: "image-selection" };

  args.onProgress("save-selection");
  let filePath: string | null;
  try {
    filePath = await args.chooseSaveFile({ defaultPath: `${args.project.metadata.title || "새 프로젝트"}.ctp` });
  } catch (error) {
    return { kind: "failed", stage: "save-selection", message: toMessage(error, "프로젝트 저장 위치를 선택하지 못했습니다.") };
  }
  if (!filePath) return { kind: "canceled", step: "save-selection" };

  args.onProgress("initial-save");
  try {
    await args.saveProject({ filePath, project: args.project });
  } catch (error) {
    return { kind: "failed", stage: "initial-save", message: toMessage(error, "프로젝트를 저장하지 못했습니다.") };
  }

  args.onProgress("image-import");
  let results: Awaited<ReturnType<ImportPageImages>>;
  try {
    results = await args.importPageImages({
      projectFilePath: filePath,
      files: sourcePaths.map((sourcePath, index) => ({ sourcePath, pageNumber: index + 1 }))
    });
  } catch (error) {
    return failedImport(filePath, args.project, sourcePaths.length, toMessage(error, "이미지를 불러오지 못했습니다."));
  }

  const importedImages = results.flatMap((result) => result.ok ? [result.pageImage] : []);
  const failedCount = results.length - importedImages.length;
  if (importedImages.length === 0) {
    const firstFailure = results.find((result) => !result.ok);
    return failedImport(filePath, args.project, failedCount, firstFailure?.message ?? "이미지를 불러오지 못했습니다.");
  }

  const project = withImages(args.project, importedImages, (args.now ?? (() => new Date().toISOString()))());
  args.onProgress("final-save");
  try {
    await args.saveProject({ filePath, project });
  } catch (error) {
    return {
      kind: "failed",
      stage: "final-save",
      message: toMessage(error, "가져온 이미지를 프로젝트에 저장하지 못했습니다."),
      filePath,
      project,
      importedCount: importedImages.length,
      failedCount,
      dirty: true
    };
  }

  return {
    kind: failedCount > 0 ? "partial" : "success",
    filePath,
    project,
    importedCount: importedImages.length,
    failedCount,
    dirty: false
  };
}

function withImages(project: TranslationProject, images: PageImage[], updatedAt: string): TranslationProject {
  return { ...project, pageImages: images, metadata: { ...project.metadata, updatedAt } };
}

function failedImport(filePath: string, project: TranslationProject, failedCount: number, message: string): ImageProjectStartResult {
  return { kind: "failed", stage: "image-import", message, filePath, project, importedCount: 0, failedCount, dirty: false };
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
```

- [ ] **Step 4: Run focused tests and typecheck**

```powershell
npx vitest run tests/renderer/imageProjectStart.test.ts
npm run typecheck
```

Expected: all new orchestrator tests PASS and typecheck PASS.

- [ ] **Step 5: Commit the orchestrator**

```powershell
git add -- src/renderer/imageProjectStart.ts tests/renderer/imageProjectStart.test.ts
git commit -m "feat: orchestrate image project creation"
```

---

### Task 3: Replace the TXT-First Start Panel and Integrate App

**Files:**
- Modify: `src/renderer/components/WorkspaceStartPanel.tsx`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/App.tsx`
- Test: `tests/renderer/WorkspaceStartPanel.test.tsx`
- Test: `tests/renderer/App.test.tsx`

**Interfaces:**
- Consumes: `apiReady`, `isStartingImageProject`, `isImportingTxt`, `statusMessage`, `onStartImageProject`, `onImportTxt`, and `onOpenProject`.
- Produces: one image-first primary CTA, two secondary actions, and `startNewImageProject()` as the sole new-project state transition.

- [ ] **Step 1: Replace start-panel tests with the image-first contract**

Use these props in every render:

```tsx
<WorkspaceStartPanel
  apiReady
  isStartingImageProject={false}
  isImportingTxt={false}
  statusMessage="준비됨"
  onStartImageProject={onStartImageProject}
  onImportTxt={onImportTxt}
  onOpenProject={onOpenProject}
/>
```

Assert the exact hierarchy and callbacks:

```ts
expect(screen.getByText("이미지 불러오기 → 말풍선 OCR → 번역 검토")).toBeInTheDocument();
expect(screen.getByRole("heading", { name: "이미지로 번역 프로젝트 시작" })).toBeInTheDocument();
expect(screen.getByText("페이지 이미지를 선택하면 프로젝트 저장 위치를 정한 뒤 OCR 작업 화면으로 이동합니다.")).toBeInTheDocument();
expect(screen.getByText("준비됨")).toBeVisible();

const imageButton = screen.getByRole("button", { name: "이미지 프로젝트 시작: 이미지 불러오기" });
expect(imageButton).toHaveClass("primary-button");
expect(screen.getByRole("button", { name: "기존 프로젝트 열기" })).not.toHaveClass("primary-button");
expect(screen.getByRole("button", { name: "TXT로 시작" })).not.toHaveClass("primary-button");
expect(screen.queryByRole("button", { name: "새로 만들기" })).not.toBeInTheDocument();
expect(screen.queryByRole("button", { name: "다른 이름 저장" })).not.toBeInTheDocument();

fireEvent.click(imageButton);
expect(onStartImageProject).toHaveBeenCalledOnce();
```

Add a busy test that expects all three actions disabled, the primary button to have `aria-busy="true"`, and its accessible name to be `이미지 프로젝트 시작: 이미지 불러오는 중`.

- [ ] **Step 2: Run the focused component test and verify failure**

```powershell
npx vitest run tests/renderer/WorkspaceStartPanel.test.tsx
```

Expected: FAIL because the old TXT-first props and copy are still rendered.

- [ ] **Step 3: Implement the image-first start panel**

Replace the component props and JSX with:

```tsx
type WorkspaceStartPanelProps = {
  apiReady: boolean;
  isStartingImageProject: boolean;
  isImportingTxt: boolean;
  statusMessage: string;
  onStartImageProject: () => void;
  onImportTxt: () => void;
  onOpenProject: () => void;
};

export function WorkspaceStartPanel(props: WorkspaceStartPanelProps) {
  const isBusy = props.isStartingImageProject || props.isImportingTxt;

  return (
    <section className="workspace-start-panel" aria-labelledby="workspace-start-heading">
      <p className="workspace-start-eyebrow">이미지 불러오기 → 말풍선 OCR → 번역 검토</p>
      <h2 id="workspace-start-heading">이미지로 번역 프로젝트 시작</h2>
      <p className="workspace-start-description">
        페이지 이미지를 선택하면 프로젝트 저장 위치를 정한 뒤 OCR 작업 화면으로 이동합니다.
      </p>
      <button
        type="button"
        className="primary-button workspace-start-primary"
        aria-label={props.isStartingImageProject ? "이미지 프로젝트 시작: 이미지 불러오는 중" : "이미지 프로젝트 시작: 이미지 불러오기"}
        aria-busy={props.isStartingImageProject}
        onClick={props.onStartImageProject}
        disabled={!props.apiReady || isBusy}
      >
        {props.isStartingImageProject ? "이미지 불러오는 중" : "이미지 불러오기"}
      </button>
      <div className="workspace-start-secondary" aria-label="다른 시작 방법">
        <button type="button" className="secondary-button" onClick={props.onOpenProject} disabled={!props.apiReady || isBusy}>
          기존 프로젝트 열기
        </button>
        <button type="button" className="secondary-button" onClick={props.onImportTxt} disabled={!props.apiReady || isBusy}>
          {props.isImportingTxt ? "TXT 불러오는 중" : "TXT로 시작"}
        </button>
      </div>
      <p className="workspace-start-status">{props.statusMessage}</p>
    </section>
  );
}
```

Add styling that reuses existing tokens:

```css
.workspace-start-status {
  min-height: 1.5em;
  margin: var(--focus-space-4) 0 0;
  color: var(--ink-muted);
  font-size: 14px;
  line-height: 1.5;
}
```

- [ ] **Step 4: Run the focused component test**

```powershell
npx vitest run tests/renderer/WorkspaceStartPanel.test.tsx
```

Expected: component tests PASS. Continue directly to the App integration steps below before typechecking or committing, because the component's public props and its only consumer must change atomically.

- [ ] **Step 5: Keep the component changes uncommitted until App integration is complete**

Do not leave this task at this checkpoint. The independently testable deliverable includes the following App integration steps and one final commit.

#### App integration steps

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `tests/renderer/App.test.tsx`
- Include uncommitted changes from: `src/renderer/components/WorkspaceStartPanel.tsx`, `src/renderer/styles.css`, `tests/renderer/WorkspaceStartPanel.test.tsx`

**Interfaces:**
- Consumes: `startImageProject` and `ImageProjectStartPhase` from Task 2, plus the new start-panel props from Task 3.
- Produces: `startNewImageProject()` as the sole new-project path and a stable React state transition for every orchestrator result.

- [ ] **Step 6: Add failing App integration tests**

Add this helper near `renderApp()` and replace existing start-screen TXT click queries with it. Assertions that intentionally test the old TXT-first heading or `빈 프로젝트 저장` must be replaced by the image-first assertions from Task 3 rather than retained.

```ts
function clickTxtStart() {
  fireEvent.click(screen.getByRole("button", { name: "TXT로 시작" }));
}
```

In existing tests, replace:

```ts
fireEvent.click(screen.getByRole("button", { name: "번역 시작: TXT 불러오기" }));
```

with:

```ts
clickTxtStart();
```

Tests that previously expected `새 프로젝트` to synchronously clear state must instead mock `choosePageImageFiles`, `chooseSaveFile`, `saveProject`, and `importPageImages`, then wait for the imported image workspace. Cancellation tests must keep asserting that current state remains intact.

Add a success test with existing `pageImage()` and API mocks:

```ts
it("starts with image selection and opens an image-only workspace", async () => {
  const choosePageImageFiles = vi.fn().mockResolvedValue(["C:\\images\\page-001.jpg"]);
  const chooseSaveFile = vi.fn().mockResolvedValue("C:\\projects\\Book.ctp");
  const saveProject = vi.fn().mockResolvedValue(undefined);
  const importPageImages = vi.fn().mockResolvedValue([{ ok: true, pageImage: pageImage() }]);
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile,
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject,
    choosePageImageFiles,
    importPageImages,
    resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
  };

  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "이미지 프로젝트 시작: 이미지 불러오기" }));

  expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "이미지로 번역 프로젝트 시작" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "빠른 OCR" })).toHaveClass("primary-button");
  expect(saveProject).toHaveBeenCalledTimes(2);
  expect(importPageImages).toHaveBeenCalledWith({
    projectFilePath: "C:\\projects\\Book.ctp",
    files: [{ sourcePath: "C:\\images\\page-001.jpg", pageNumber: 1 }]
  });
});
```

Add this cancellation test to prove that confirming the dialog does not mutate the old project until file selection succeeds:

```ts
it("preserves the current workspace when image selection is canceled", async () => {
  const choosePageImageFiles = vi.fn().mockResolvedValue(null);
  const saveProject = vi.fn();
  window.projectApi = {
    importTxtFile: vi.fn().mockResolvedValue({
      filePath: "old.txt",
      lines: [rendererLine("old-line", 1, "기존 대사")]
    }),
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject,
    choosePageImageFiles,
    importPageImages: vi.fn()
  };
  vi.spyOn(window, "confirm").mockReturnValue(true);

  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "TXT로 시작" }));
  expect(await screen.findByDisplayValue("기존 대사")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("이미지 불러오기를 취소했습니다."));
  expect(screen.getByDisplayValue("기존 대사")).toBeInTheDocument();
  expect(saveProject).not.toHaveBeenCalled();
});
```

Add these start-screen outcome tests:

```ts
it("does not create a project when save selection is canceled", async () => {
  const saveProject = vi.fn();
  const importPageImages = vi.fn();
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile: vi.fn().mockResolvedValue(null),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject,
    choosePageImageFiles: vi.fn().mockResolvedValue(["C:\\images\\page-001.jpg"]),
    importPageImages
  };

  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "이미지 프로젝트 시작: 이미지 불러오기" }));

  expect(await screen.findByText("프로젝트 만들기를 취소했습니다.", { selector: ".workspace-start-status" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "이미지로 번역 프로젝트 시작" })).toBeInTheDocument();
  expect(saveProject).not.toHaveBeenCalled();
  expect(importPageImages).not.toHaveBeenCalled();
});

it("shows a saved empty start state when every image import fails", async () => {
  const saveProject = vi.fn().mockResolvedValue(undefined);
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject,
    choosePageImageFiles: vi.fn().mockResolvedValue(["C:\\images\\bad.jpg"]),
    importPageImages: vi.fn().mockResolvedValue([
      { ok: false, sourcePath: "C:\\images\\bad.jpg", message: "지원하지 않는 이미지입니다." }
    ])
  };

  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "이미지 프로젝트 시작: 이미지 불러오기" }));

  expect(await screen.findByText("지원하지 않는 이미지입니다.", { selector: ".workspace-start-status" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "이미지로 번역 프로젝트 시작" })).toBeInTheDocument();
  expect(saveProject).toHaveBeenCalledOnce();
});

it("shows successful images and reports a partial import", async () => {
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn().mockResolvedValue(undefined),
    choosePageImageFiles: vi.fn().mockResolvedValue(["C:\\images\\01.jpg", "C:\\images\\02.jpg"]),
    importPageImages: vi.fn().mockResolvedValue([
      { ok: true, pageImage: pageImage() },
      { ok: false, sourcePath: "C:\\images\\02.jpg", message: "bad image" }
    ]),
    resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
  };

  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "이미지 프로젝트 시작: 이미지 불러오기" }));

  expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("이미지 1개를 불러왔고 1개를 불러오지 못했습니다.");
});

it("keeps imported images dirty when final save fails", async () => {
  const saveProject = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("최종 저장 실패"));
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject,
    choosePageImageFiles: vi.fn().mockResolvedValue(["C:\\images\\01.jpg"]),
    importPageImages: vi.fn().mockResolvedValue([{ ok: true, pageImage: pageImage() }]),
    resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
  };

  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "이미지 프로젝트 시작: 이미지 불러오기" }));

  expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeInTheDocument();
  expect(screen.getByText("변경 있음")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("최종 저장 실패");
});
```

Add shortcut and TXT fallback tests:

```ts
it("routes Ctrl+Enter to image import on the start screen", async () => {
  const choosePageImageFiles = vi.fn().mockResolvedValue(null);
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn(),
    choosePageImageFiles,
    importPageImages: vi.fn()
  };

  renderApp();
  fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });

  await waitFor(() => expect(choosePageImageFiles).toHaveBeenCalledOnce());
});

it("keeps TXT import as a secondary start path", async () => {
  const importTxtFile = vi.fn().mockResolvedValue({
    filePath: "dialogue.txt",
    lines: [rendererLine("txt-line", 1, "TXT 대사")]
  });
  window.projectApi = {
    importTxtFile,
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn()
  };

  renderApp();
  fireEvent.click(screen.getByRole("button", { name: "TXT로 시작" }));

  expect(await screen.findByDisplayValue("TXT 대사")).toBeInTheDocument();
  expect(importTxtFile).toHaveBeenCalledOnce();
});
```

- [ ] **Step 7: Run focused App tests and verify failure**

```powershell
npx vitest run tests/renderer/App.test.tsx
```

Expected: FAIL on old TXT-first copy, missing image flow, and image-only empty-workspace behavior.

- [ ] **Step 8: Connect state, progress, and result application in App**

Add imports and state:

```ts
import { startImageProject, type ImageProjectStartPhase, type ImageProjectStartResult } from "./imageProjectStart";

const [isStartingImageProject, setIsStartingImageProject] = useState(false);
```

Add `imageCount` to the presentation call:

```ts
const workspacePresentation = getWorkspacePresentation({
  currentFilePath,
  lineCount: project.dialogueLines.length,
  imageCount: project.pageImages?.length ?? 0,
  isDirty,
  apiReady
});
```

Replace `newProject()` with an async image-first function. Keep the current project untouched until the orchestrator returns a result containing `filePath` and `project`:

```ts
async function startNewImageProject() {
  if (isStartingImageProject) return;
  if (!confirmDiscardUnsavedChanges()) {
    setStatusMessage("새 프로젝트 생성을 취소했습니다.");
    return;
  }
  if (!window.projectApi?.choosePageImageFiles || !window.projectApi.importPageImages) {
    setStatusMessage("이미지 프로젝트 기능을 사용할 수 없습니다.");
    return;
  }

  setIsStartingImageProject(true);
  try {
    const result = await startImageProject({
      project: createEmptyProject("새 프로젝트", false),
      chooseImageFiles: window.projectApi.choosePageImageFiles,
      chooseSaveFile: window.projectApi.chooseSaveFile,
      saveProject: window.projectApi.saveProject,
      importPageImages: window.projectApi.importPageImages,
      onProgress: (phase) => setStatusMessage(progressMessage(phase))
    });
    applyImageProjectStartResult(result);
  } finally {
    setIsStartingImageProject(false);
  }
}

function progressMessage(phase: ImageProjectStartPhase): string {
  if (phase === "image-selection") return "이미지를 선택하세요.";
  if (phase === "save-selection") return "프로젝트 저장 위치를 선택하세요.";
  if (phase === "initial-save") return "프로젝트를 만드는 중입니다.";
  if (phase === "image-import") return "이미지를 불러오는 중입니다.";
  return "이미지를 프로젝트에 저장하는 중입니다.";
}
```

Implement result application as one function so cancellation cannot accidentally clear state:

```ts
function applyImageProjectStartResult(result: ImageProjectStartResult) {
  if (result.kind === "canceled") {
    setStatusMessage(result.step === "image-selection" ? "이미지 불러오기를 취소했습니다." : "프로젝트 만들기를 취소했습니다.");
    return;
  }
  if (result.kind === "failed" && !("filePath" in result)) {
    setStatusMessage(result.message);
    return;
  }

  setProject(result.project);
  setCurrentFilePath(result.filePath);
  clearSpeechBubbleReview();
  setPageAndSelection(1, { lines: result.project.dialogueLines, pageImages: result.project.pageImages, selectedLineId: null });
  setActiveTool(result.importedCount > 0 ? "work" : "pages");
  setIsDirty(result.dirty);

  if (result.kind === "success") {
    setStatusMessage(`이미지 ${result.importedCount}개를 불러왔습니다.`);
  } else if (result.kind === "partial") {
    setStatusMessage(`이미지 ${result.importedCount}개를 불러왔고 ${result.failedCount}개를 불러오지 못했습니다.`);
  } else {
    setStatusMessage(result.message);
  }
}
```

Every existing `onNewProject={newProject}` and top-bar `onClick={newProject}` becomes `() => void startNewImageProject()`. Pass the new start-panel props:

```tsx
<WorkspaceStartPanel
  apiReady={apiReady}
  isStartingImageProject={isStartingImageProject}
  isImportingTxt={isImportingTxt}
  statusMessage={statusMessage}
  onStartImageProject={() => void startNewImageProject()}
  onImportTxt={() => void importTxt()}
  onOpenProject={() => void openProjectFromFileDialog()}
/>
```

Keep the existing global Ctrl+Enter lookup. The start panel has exactly one enabled `.primary-button`, so the shortcut automatically routes to image import; add no second keyboard code path.

- [ ] **Step 9: Run component, App, and presentation tests**

```powershell
npx vitest run tests/renderer/WorkspaceStartPanel.test.tsx tests/renderer/workspacePresentation.test.ts tests/renderer/imageProjectStart.test.ts tests/renderer/App.test.tsx
npm run typecheck
```

Expected: all focused tests PASS and typecheck PASS.

- [ ] **Step 10: Commit the complete UI integration**

```powershell
git add -- src/renderer/App.tsx src/renderer/components/WorkspaceStartPanel.tsx src/renderer/styles.css tests/renderer/App.test.tsx tests/renderer/WorkspaceStartPanel.test.tsx
git commit -m "feat: start projects from page images"
```

---

### Task 4: Full Regression and Electron Verification

**Files:**
- No planned source changes.
- Modify only the nearest relevant source/test from Tasks 1–4 if verification exposes a defect.

**Interfaces:**
- Consumes: completed image-first flow.
- Produces: evidence that existing desktop workflows remain intact.

- [ ] **Step 1: Run the full automated suite**

```powershell
Set-Location 'C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기'
npm run typecheck
npm test
npm run smoke:ipc
npm run smoke:storage
npm run build
```

Expected: every command exits with code 0; all Vitest suites pass; storage smoke prints `storage smoke passed`; Vite production build completes.

- [ ] **Step 2: Start the actual Electron application**

```powershell
npm run dev:electron
```

Expected: the visible `대사 편집기` window opens with no renderer/preload error. Do not use a plain browser preview for file-dialog verification.

- [ ] **Step 3: Verify the successful image-first path manually**

From the Electron start screen:

1. Confirm `이미지 불러오기` is the only visually primary action.
2. Click it and select two supported images.
3. Choose a `.ctp` save location.
4. Confirm the first image appears immediately.
5. Confirm page navigation reports `1 / 2` and the next page shows the second image.
6. Confirm `빠른 OCR` is now the primary action.
7. Close and reopen the `.ctp` file, then confirm the image-only workspace reappears instead of the start panel.

- [ ] **Step 4: Verify cancellation and fallback paths manually**

1. Open a populated project, modify a line, click `새 프로젝트`, and reject the discard confirmation; verify the current project remains.
2. Retry, accept discard, then cancel image selection; verify the current project still remains.
3. Retry, choose an image, then cancel save-location selection; verify the current project still remains.
4. Return to the empty start screen and use `TXT로 시작`; verify the existing TXT translation workspace opens.
5. Press `Ctrl+Enter` on the empty start screen; verify the image chooser opens once.

- [ ] **Step 5: Confirm repository hygiene**

```powershell
git status --short
git log -4 --oneline
```

Expected: no generated or unrelated changes; the task commits are visible. If verification required a code correction, rerun Step 1 and commit only the focused correction with a descriptive `fix:` message.
