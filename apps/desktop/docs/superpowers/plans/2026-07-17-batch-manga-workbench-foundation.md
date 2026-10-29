# Batch Manga Workbench Foundation Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task. If the user chooses Subagent-Driven execution, additionally use `superpowers:subagent-driven-development`. Complete the red test, minimal implementation, verification, and commit sequence for every task before moving on.

**Goal:** Replace the single-action empty screen with a desktop project home and multi-image preparation flow, then rebuild the existing editor shell so the full page image is never cropped and every supporting panel can be collapsed without removing current save, OCR, inpainting, dialogue, or settings behavior.

**Architecture:** Keep the Electron main process responsible for Windows file selection, path validation, preview protocol registration, asset copying, and project persistence. Add an explicit renderer-only entry state (`home | setup | workspace`) and a setup draft that holds ordered image references until the user confirms creation. Refactor the current `FocusDeckShell` in place into a collapsible image workbench; preserve legacy components during rollout as a rollback path. Store only an optional translation mode in the existing project document, so old projects remain valid without migration.

**Tech Stack:** Electron 42, React 19, TypeScript 6, Vite 8, Vitest 4, Testing Library, existing `translation-image://asset` protocol, existing `.ctp` storage.

**Design source:** `docs/superpowers/specs/2026-07-17-batch-manga-translation-workbench-design.md`

## Global Constraints

- Desktop Windows only. Do not add phone-specific breakpoints or interactions.
- Never overwrite an original image. Continue copying selected files through `importPageImages`.
- Do not remove or change current save/open/TXT/OCR/inpainting/dialogue/settings behavior unless a task explicitly relocates its UI.
- The center image uses `contain` by default. No `cover`, clipping, or aspect-ratio distortion is allowed.
- Left page panel, right task panel, and bottom result panel must collapse independently. Focus mode must hide all three and restore their previous states.
- Fast/precise automated translation engines are not implemented in this foundation plan. The selected mode is persisted for the following pipeline plans; UI copy must not claim automation has run.
- Existing projects without `settings.translationMode` must open normally and default to `precise` only when a mode-dependent UI needs a value.
- Keep the legacy `WorkspaceStartPanel` and `ToolDrawer` files until the final integration task passes; remove only dead imports/usages, not the files themselves.
- Do not add a package, schema migration, database, or new secret store.
- Do not print source image paths, project paths, Gemini keys, or project contents in logs or test output.
- Use `npm.cmd` in PowerShell commands because `npm.ps1` may be blocked by Windows execution policy.

## Completion Boundary

This plan is complete when a user can:

1. Open the app and see a project home without an automatic file dialog.
2. Select or drop many images, preview every page, naturally sort, reorder, remove, and add pages.
3. Choose Fast or Precise, choose the `.ctp` save location only after confirmation, and enter the workspace with the mode stored.
4. See the entire current page without cropping.
5. Collapse pages, task details, and results independently; enter and exit focus mode without losing their prior states.
6. Open an old project and use existing OCR, inpainting, text editing, save, and settings functions.

The plan does **not** claim completion of automatic OCR→translation→composition. Those are follow-up plans after the shared project mode and workspace contracts exist.

---

## Task 1: Add backward-compatible workflow and image-draft contracts

**Files:**

- Modify: `src/shared/projectTypes.ts`
- Create: `src/shared/pageImageSelection.ts`
- Test: `tests/shared/pageImageSelection.test.ts`
- Modify: `tests/shared/projectValidation.test.ts`

### Step 1: Write failing tests

Add tests proving:

```ts
expect(naturalSortPageFiles(["page-10.jpg", "page-2.jpg", "page-1.jpg"]))
  .toEqual(["page-1.jpg", "page-2.jpg", "page-10.jpg"]);

expect(dedupePageFiles([first, duplicate, second]))
  .toEqual({ files: [first, second], duplicateIds: [duplicate.id] });
```

Also extend project validation tests with both cases:

```ts
expect(validateProject(oldProjectWithoutTranslationMode)).toEqual(oldProjectWithoutTranslationMode);
expect(validateProject(projectWithMode("fast")).settings.translationMode).toBe("fast");
```

### Step 2: Run the focused tests and confirm failure

Run from:

```powershell
Set-Location 'C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\crop-reocr-fail-soft'
npm.cmd test -- tests/shared/pageImageSelection.test.ts tests/shared/projectValidation.test.ts
```

Expected: failure because the selection module and optional mode do not exist.

### Step 3: Add minimal shared types

Add these contracts:

```ts
export type TranslationMode = "fast" | "precise";

export type PreparedPageImage = {
  id: string;
  sourcePath: string;
  fileName: string;
  previewSrc: string;
  byteSize: number;
};
```

Extend project settings without increasing `schemaVersion`:

```ts
settings: {
  defaultSourceLanguage: SourceLanguage;
  translationMode?: TranslationMode;
};
```

Implement `naturalSortPageFiles`, `dedupePageFiles`, and `movePageFile`. Natural sorting must use `Intl.Collator("ko", { numeric: true, sensitivity: "base" })` on `fileName`; duplicate detection uses normalized source paths and must preserve the first occurrence.

### Step 4: Keep old projects valid

Update validation so only present values are checked. Reject any present value other than `fast` or `precise`; do not write a default into old project data during load.

### Step 5: Run tests

```powershell
npm.cmd test -- tests/shared/pageImageSelection.test.ts tests/shared/projectValidation.test.ts
npm.cmd run typecheck
```

Expected: focused tests and both TypeScript projects pass.

### Step 6: Commit

```powershell
git add src/shared/projectTypes.ts src/shared/pageImageSelection.ts tests/shared/pageImageSelection.test.ts tests/shared/projectValidation.test.ts
git commit -m "feat: add manga project setup contracts"
```

---

## Task 2: Expose safe multi-image previews for picker and drag/drop

**Files:**

- Modify: `src/main/ipcHandlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/renderer/electronApi.ts`
- Modify: `tests/main/ipcHandlers.integration.test.ts`
- Create: `tests/electron/preload.test.ts`

### Step 1: Write failing IPC tests

Keep the existing `project:choosePageImageFiles` raw-string contract temporarily so the current image-first flow remains functional until Task 4. Add `project:choosePreparedPageImageFiles` and assert it returns ordered `PreparedPageImage[]` with opaque preview URLs:

```ts
expect(result).toEqual([
  expect.objectContaining({
    sourcePath: firstPath,
    fileName: "page-001.jpg",
    previewSrc: expect.stringMatching(/^translation-image:\/\/asset\//)
  })
]);
```

Add tests for:

- unsupported extensions rejected by `project:preparePageImageFiles`;
- duplicate paths returned once;
- `project:releasePreparedPageImages` invalidates only supplied preview tokens;
- picker cancellation returns `null`;
- preload exposes `getPathForFile(file)` through Electron `webUtils.getPathForFile` and never parses a browser fake path.

### Step 2: Run and confirm failure

```powershell
npm.cmd test -- tests/main/ipcHandlers.integration.test.ts tests/electron/preload.test.ts
```

Expected: tests fail on missing structured preview and drop-path APIs.

### Step 3: Implement one preparation path in main

Create internal helpers in `ipcHandlers.ts`:

```ts
async function preparePageImageFiles(sourcePaths: string[]): Promise<PreparedPageImage[]>
function releasePreparedPageImages(ids: string[]): void
```

For each validated image:

1. Resolve to an absolute Windows path.
2. Check the existing allowed image extensions.
3. Read metadata with `stat`; do not read the whole image into renderer memory.
4. Generate a random opaque id.
5. Register the absolute path in the existing `pageImageProtocolPaths` map.
6. Return `translation-image://asset/<id>` as `previewSrc`.

Use the helper for both IPCs:

```ts
project:choosePageImageFiles -> existing raw string[] picker remains unchanged through Task 3
project:choosePreparedPageImageFiles -> dialog -> preparePageImageFiles(filePaths)
project:preparePageImageFiles -> validate string[] -> preparePageImageFiles(paths)
project:releasePreparedPageImages -> validate string[] -> delete map entries
```

Do not expose a new filesystem protocol or raw image bytes.

Expose both picker methods in `ElectronProjectApi` and preload during the transition. Task 4 removes the renderer's dependency on the raw picker after `createImageProject` accepts prepared files.

### Step 4: Add the supported Electron drop bridge

In preload, import `webUtils` and expose:

```ts
getPathForFile: (file: File) => webUtils.getPathForFile(file)
```

Renderer drop handling must call this API once per `File`, discard empty results, then call `preparePageImageFiles`. Do not use `file.path`, which is no longer a public renderer property.

### Step 5: Run focused verification

```powershell
npm.cmd test -- tests/main/ipcHandlers.integration.test.ts tests/electron/preload.test.ts
npm.cmd run typecheck
```

Expected: structured previews work for picker and drop contracts; typecheck passes.

### Step 6: Commit

```powershell
git add src/main/ipcHandlers.ts electron/preload.ts src/renderer/electronApi.ts tests/main/ipcHandlers.integration.test.ts tests/electron/preload.test.ts
git commit -m "feat: prepare multi-image project previews"
```

---

## Task 3: Build the multi-image project setup screen

**Files:**

- Create: `src/renderer/projectSetupState.ts`
- Create: `src/renderer/components/ProjectSetupScreen.tsx`
- Create: `tests/renderer/projectSetupState.test.ts`
- Create: `tests/renderer/ProjectSetupScreen.test.tsx`
- Modify: `src/renderer/styles.css`

### Step 1: Write state tests first

Test the reducer or pure update functions for:

- picker files naturally sorted on first add;
- dropped files appended and then naturally sorted only when the user selects “자동 정렬”;
- manual move left/right updates stable order;
- remove leaves remaining order intact;
- duplicate id warning is count-based and dismissible;
- default mode is `precise`;
- confirm is disabled when there are zero images or preparation is busy.

### Step 2: Write component tests first

Required accessible behavior:

```ts
expect(screen.getByRole("heading", { name: "새 번역 프로젝트" })).toBeVisible();
expect(screen.getByRole("radio", { name: /빠른 번역/ })).not.toBeChecked();
expect(screen.getByRole("radio", { name: /정확 번역/ })).toBeChecked();
expect(screen.getByRole("button", { name: "프로젝트 만들기" })).toBeDisabled();
```

After adding three files, assert all thumbnails and `1 / 3`, `2 / 3`, `3 / 3` labels are visible. Test keyboard-accessible reorder/remove buttons; do not make drag gestures the only reorder mechanism.

### Step 3: Run and confirm failure

```powershell
npm.cmd test -- tests/renderer/projectSetupState.test.ts tests/renderer/ProjectSetupScreen.test.tsx
```

### Step 4: Implement the screen

The screen contains exactly these primary regions:

1. Header: back, title, image count.
2. Wide drop zone: “이미지 선택” plus drop support.
3. Thumbnail grid: full uncropped thumbnails using `object-fit: contain`, page number, filename, move, remove.
4. Mode cards: Fast and Precise, with time/quality tradeoff copy. Precise selected by default.
5. Footer: secondary “취소”, single primary “프로젝트 만들기”.

Do not show TXT import or OCR controls here. Do not open the save dialog before the primary confirm action.

### Step 5: Add visual constraints

Use existing colors/tokens. Add no third-party component library. At desktop width, thumbnails should be dense enough to review 10–20 pages without horizontal scrolling. Every thumbnail must remain fully visible. At narrower desktop widths, reduce columns, not functionality.

### Step 6: Verify and commit

```powershell
npm.cmd test -- tests/renderer/projectSetupState.test.ts tests/renderer/ProjectSetupScreen.test.tsx
npm.cmd run typecheck
git add src/renderer/projectSetupState.ts src/renderer/components/ProjectSetupScreen.tsx tests/renderer/projectSetupState.test.ts tests/renderer/ProjectSetupScreen.test.tsx src/renderer/styles.css
git commit -m "feat: add multi-image project setup screen"
```

---

## Task 4: Split image selection from project persistence

**Files:**

- Modify: `src/renderer/imageProjectStart.ts`
- Modify: `tests/renderer/imageProjectStart.test.ts`
- Modify: `src/shared/projectValidation.ts`

### Step 1: Write failing orchestration tests

Replace the selection-coupled API with:

```ts
createImageProject({
  project,
  preparedImages,
  translationMode,
  chooseSaveFile,
  saveProject,
  importPageImages,
  releasePreparedPageImages,
  onProgress
});
```

Tests must prove:

- it never calls the image picker;
- save cancel returns `canceled/save-selection` and retains setup draft in the caller;
- import order exactly matches manual thumbnail order;
- `settings.translationMode` is saved in both initial and final project documents;
- partial imports enter the workspace with successes and report failed count;
- failed initial save imports nothing;
- preview registrations are released only after success, explicit setup cancel, or explicit replacement—not after save-dialog cancel.

### Step 2: Run and confirm failure

```powershell
npm.cmd test -- tests/renderer/imageProjectStart.test.ts
```

### Step 3: Implement minimal split

Add `createImageProject` and remove the `image-selection` phase from that new API. Accept the ordered prepared list and map its `sourcePath` values to page numbers at import time. Preserve the existing initial-save → copy assets → final-save sequence and all current partial/failure result shapes. Keep the existing `startImageProject` export as a temporary compatibility wrapper until Task 5 migrates `App.tsx`; do not break the current empty-screen flow between tasks.

Use one helper to apply the mode:

```ts
const projectWithMode = {
  ...project,
  settings: { ...project.settings, translationMode }
};
```

Do not start OCR or translation in this task.

`releasePreparedPageImages` receives the prepared IDs and is called only after the final save returns a `success` or `partial` result. Save-dialog cancellation and every failure result retain the draft previews. Explicit setup cancel/replacement remains the Task 5 caller's responsibility.

### Step 4: Verify and commit

```powershell
npm.cmd test -- tests/renderer/imageProjectStart.test.ts
npm.cmd run typecheck
git add src/renderer/imageProjectStart.ts tests/renderer/imageProjectStart.test.ts src/shared/projectValidation.ts
git commit -m "refactor: separate project setup from image import"
```

---

## Task 5: Replace the empty screen with Project Home and explicit app entry states

**Files:**

- Create: `src/renderer/entryFlow.ts`
- Create: `src/renderer/recentProjects.ts`
- Create: `src/renderer/components/ProjectHomeScreen.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `tests/renderer/App.test.tsx`
- Create: `tests/renderer/recentProjects.test.ts`
- Create: `tests/renderer/ProjectHomeScreen.test.tsx`
- Modify: `src/renderer/styles.css`

### Step 1: Write failing entry-flow tests

Cover these transitions:

```text
launch with no content -> home
home / New Translation Project -> setup (no file dialog)
setup / cancel -> home and release prepared previews
setup / confirm / save canceled -> setup with draft intact
setup / confirm / success -> workspace
home / open existing project -> workspace
empty saved legacy project -> home
```

Add an App test explicitly asserting that clicking “새 번역 프로젝트” does **not** call `choosePageImageFiles` until the setup screen’s “이미지 선택” button is clicked.

### Step 2: Add bounded recent-project history

Implement a renderer-local list with no new IPC or database:

```ts
type RecentProject = { filePath: string; title: string; openedAt: string };
```

Keep at most 8 entries, deduplicate case-insensitive Windows paths, and tolerate unavailable/corrupt localStorage. Never log paths. Update history only after a successful create or open. Selecting a recent item calls the existing `openProject({ filePath })`; a missing file shows an inline recoverable message and offers removal.

### Step 3: Build Project Home

Project Home has one primary CTA, “새 번역 프로젝트”; secondary “기존 프로젝트 열기”; recent projects; and a compact settings action. TXT import moves under a small “기타 시작 방법” disclosure so it does not compete with the main manga path.

No picker opens on mount. No empty workspace chrome, page controls, bottom panel, or workflow stepper is rendered on home/setup screens.

### Step 4: Integrate `ProjectSetupScreen`

Keep prepared files in App entry-flow state. On confirm, call `createImageProject`. On successful/partial result, install the returned project/file path using the same state setters currently used by opening a project. On save cancel, return control to setup with thumbnails and mode unchanged.

Ctrl+Enter rules:

- Home: New Translation Project.
- Setup with images: Project Create.
- Setup without images: Image Select.
- Workspace: existing current primary CTA behavior remains unchanged.

### Step 5: Run and commit

```powershell
npm.cmd test -- tests/renderer/recentProjects.test.ts tests/renderer/ProjectHomeScreen.test.tsx tests/renderer/ProjectSetupScreen.test.tsx tests/renderer/App.test.tsx
npm.cmd run typecheck
git add src/renderer/entryFlow.ts src/renderer/recentProjects.ts src/renderer/components/ProjectHomeScreen.tsx src/renderer/App.tsx tests/renderer/App.test.tsx tests/renderer/recentProjects.test.ts tests/renderer/ProjectHomeScreen.test.tsx src/renderer/styles.css
git commit -m "feat: add manga project home and setup flow"
```

---

## Task 6: Replace the fixed tool rail with independently collapsible workspace regions

**Files:**

- Modify: `src/renderer/focusDeck.ts`
- Modify: `src/renderer/components/FocusDeckShell.tsx`
- Modify: `src/renderer/components/ResizableWorkspace.tsx`
- Modify: `tests/renderer/FocusDeckShell.test.tsx`
- Modify: `tests/renderer/ResizableWorkspace.test.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

### Step 1: Write failing shell state tests

Replace `activeTool/drawer` preferences with:

```ts
type WorkspacePanelState = {
  pagesOpen: boolean;
  inspectorOpen: boolean;
  resultsOpen: boolean;
  focusMode: boolean;
  inspectorWidth: number;
};
```

Tests must cover:

- each region collapses independently;
- collapsed regions remain represented by a labeled reopen button and error/count badge;
- entering focus mode closes all supporting regions;
- exiting focus mode restores the exact pre-focus combination;
- Escape exits focus mode but does not stop OCR/inpainting jobs;
- preferences are isolated by project key and corrupt storage falls back safely;
- no fixed navigation with Work/Pages/Context/Settings remains.

### Step 2: Run and confirm failure

```powershell
npm.cmd test -- tests/renderer/FocusDeckShell.test.tsx tests/renderer/ResizableWorkspace.test.tsx
```

### Step 3: Refactor the shell in place

Use the existing slots but rename their presentation:

```text
topBar    -> minimal project/navigation bar
pages     -> collapsible left page filmstrip
canvas    -> center image stage
editor    -> collapsible right task inspector
filmstrip -> collapsible bottom result/progress dock
```

`FocusDeckShell` owns only layout and focus restoration. `App` owns semantic contents and badge values. Settings moves to the top bar; Context content becomes a section inside the right inspector when relevant. Do not render `ToolDrawer` from App after this change.

Keep resizable inspector width on desktop. The collapsed width must be zero except for the explicit edge reopen control, so the image stage receives the released space.

### Step 4: Add accessible collapse controls

Every control needs `aria-expanded`, `aria-controls`, Korean label, tooltip/title, and visible focus style. The bottom dock header remains visible only as a compact reopen strip when collapsed. Error badges must remain visible on collapsed controls.

### Step 5: Verify and commit

```powershell
npm.cmd test -- tests/renderer/FocusDeckShell.test.tsx tests/renderer/ResizableWorkspace.test.tsx tests/renderer/App.test.tsx
npm.cmd run typecheck
git add src/renderer/focusDeck.ts src/renderer/components/FocusDeckShell.tsx src/renderer/components/ResizableWorkspace.tsx tests/renderer/FocusDeckShell.test.tsx tests/renderer/ResizableWorkspace.test.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat: make manga workspace panels collapsible"
```

---

## Task 7: Guarantee a full-page, uncropped image canvas and compact layer controls

**Files:**

- Modify: `src/renderer/components/PageImagePanel.tsx`
- Create: `src/renderer/imageViewport.ts`
- Create: `tests/renderer/imageViewport.test.ts`
- Modify: `tests/renderer/PageImagePanel.test.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

### Step 1: Write failing viewport tests

Add pure tests for view state:

```ts
type ImageViewMode = "fit" | "width" | "actual";
type ImageLayerVisibility = {
  original: boolean;
  ocr: boolean;
  sourceText: boolean;
  translation: boolean;
  final: boolean;
};
```

Test fit is default, zoom is clamped to an explicit safe range, switching page resets fit but not layer visibility, and focus-mode transitions do not reset viewport or active OCR selection.

### Step 2: Add DOM/CSS contract tests

Assert:

- fit mode image has a semantic `data-view-mode="fit"`;
- the image is not placed in a `cover` class;
- Fit, Width Fit, 100%, zoom out, zoom in, and reset controls exist;
- unavailable Source/Translation/Final layers are disabled with a clear label instead of pretending content exists;
- original and OCR layers toggle independently;
- image error state preserves reconnect and OCR retry actions.

### Step 3: Implement viewport behavior

For fit mode, CSS must resolve to:

```css
.page-image-media img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
}
```

The containing stage must use `min-width: 0`, `min-height: 0`, and `overflow: hidden` only around the viewport—not on the image itself. Actual and width modes may scroll inside the stage. Preserve aspect ratio in all modes.

Use wheel + Ctrl for zoom and pointer drag for pan only when the image exceeds the viewport. Standard vertical wheel scrolling must not be captured.

### Step 4: Reduce image toolbar competition

Keep view/layer controls in a compact toolbar. Move inpainting and OCR actions to the right task inspector but preserve their handlers and disabled states. The image stage itself must remain visible while those tools run; no central blocking modal is introduced.

### Step 5: Verify and commit

```powershell
npm.cmd test -- tests/renderer/imageViewport.test.ts tests/renderer/PageImagePanel.test.tsx tests/renderer/App.test.tsx
npm.cmd run typecheck
git add src/renderer/components/PageImagePanel.tsx src/renderer/imageViewport.ts tests/renderer/imageViewport.test.ts tests/renderer/PageImagePanel.test.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat: add uncropped full-page image viewport"
```

---

## Task 8: Integration regression pass and legacy cleanup

**Files:**

- Modify: `tests/renderer/App.test.tsx`
- Modify: `tests/main/ipcHandlers.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-07-17-batch-manga-translation-workbench-design.md` only if verified behavior requires a factual implementation note; do not change locked design decisions.
- Remove imports/usages only: `src/renderer/App.tsx`

### Step 1: Add complete user-path integration tests

Cover these stories end-to-end at component/IPC boundaries:

1. Home → New → select 12 images → natural sort → move one → Precise → cancel save → draft remains → confirm → workspace.
2. Home → New → drop multiple images → Fast → create → ordered page assets and stored mode.
3. Home → recent project → missing file error → remove recent item.
4. Existing old project → workspace → OCR → OCR highlight → edit dialogue → save.
5. Workspace → collapse all regions → full canvas → focus mode → Escape → prior regions restored.
6. One failed image import → remaining pages still open and failure badge visible.

### Step 2: Remove only proven dead integration paths

After all new tests pass:

- remove `WorkspaceStartPanel` and `ToolDrawer` imports/usages from `App.tsx`;
- keep the component files for one release as rollback/reference;
- remove obsolete `activeTool` state only if no current handler reads it;
- do not delete OCR, inpainting, TXT, context, settings, or dialogue components.

### Step 3: Run the complete verification suite

From the worktree:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git status --short
```

Expected:

- all Vitest suites pass;
- renderer and Electron typechecks pass;
- Vite/Electron build succeeds;
- only intended source/test/doc changes are present; no `dist`, `node_modules`, coverage, lock-file, API key, or user project files are staged.

### Step 4: Manual Electron acceptance pass

Launch:

```powershell
npm.cmd run dev:electron
```

Verify against this locked checklist:

- [ ] Startup shows Project Home and no file dialog.
- [ ] New project opens Setup, not an immediate picker.
- [ ] 10–20 images can be selected together and all thumbnails are visible uncropped.
- [ ] Numeric filename order is natural; manual reorder is preserved in page numbering.
- [ ] Save dialog appears only after Project Create.
- [ ] Save cancel preserves setup state.
- [ ] Fast/Precise selection is stored, but no false “automatic translation started” message appears.
- [ ] Existing `.ctp` without mode opens.
- [ ] Current image is fully visible in Fit mode at normal desktop sizes.
- [ ] Pages, task inspector, and result dock collapse independently.
- [ ] Focus mode shows only top bar + full image and Escape restores previous panel states.
- [ ] Collapsed panels retain counts/errors on their reopen controls.
- [ ] OCR, crop re-OCR retry, inpainting, dialogue editing, settings, save, open, and TXT import still work.
- [ ] Originals are unchanged; imported assets remain project copies.

Stop the dev process after verification.

### Step 5: Final commit

```powershell
git add src tests docs/superpowers/specs/2026-07-17-batch-manga-translation-workbench-design.md
git status --short
git commit -m "feat: establish batch manga translation workbench"
```

Do not commit if manual acceptance has an unresolved image-cropping, state-loss, or legacy-workflow regression.

---

## Self-Review Checklist

- [x] Every foundation acceptance rule maps to a task and a test.
- [x] Existing multi-selection and project asset-copy mechanisms are reused.
- [x] No package, database, schema migration, or security-setting change is required.
- [x] `translationMode` is optional for backward compatibility.
- [x] File picker and save picker are separated.
- [x] Drag/drop uses Electron `webUtils.getPathForFile`, not deprecated renderer file paths.
- [x] Preview URLs are opaque and releasable.
- [x] Image `contain`, independent collapse, and focus restoration are explicit test contracts.
- [x] Existing functions are relocated, not deleted.
- [x] Automated translation is explicitly deferred and not misrepresented in UI.
- [x] All commands include the Windows worktree location and use `npm.cmd`.
- [x] No placeholder file paths, test names, or unspecified implementation steps remain.

## Follow-up Plan Order

After this foundation is merged and visually accepted:

1. **Fast pipeline:** bounded page queue, OCR → translate → clean → compose → save, rolling glossary context, isolated failures, end-only failure review.
2. **Precise pipeline:** all-page OCR, scene/reading-order analysis, speaker linkage, intermediate TXT script, global-context translation, composition, uncertainty review.
3. **Recovery and completion:** per-stage resumable state, autosave checkpoints, batch progress, failed-page badges, export/final gallery.

Each follow-up receives its own plan, tests, and acceptance pass; none may alter the locked image-first layout without a new user-approved design change.
