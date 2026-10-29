# Queue-Guided Translation Workbench Redesign

## Summary

Redesign the existing Electron renderer into a queue-guided manga translation workbench optimized for the fastest repeatable flow:

```text
page image -> OCR review -> speaker confirmation -> translation correction -> next dialogue
```

The selected visual direction is **C: 작업 큐 가이드**. It keeps the page image visible throughout the workflow, makes the current stage explicit, and advances the user to the next decision after each apply action. To avoid slowing down experienced users, the guidance area can collapse to a compact status rail.

This is a renderer UI redesign. Existing project storage, Electron IPC, OCR providers, inpainting behavior, dialogue data, shortcuts, and export behavior remain intact.

## Product Context

- Product: local Windows manga and character-dialogue translation editor.
- Primary user: a power user reviewing page images, correcting OCR and speakers, editing Korean translations, and saving projects locally.
- Current implementation: React renderer inside Electron with an image canvas, left rail/drawer, right inspector, and bottom dialogue panel.
- Core problem: the current shell exposes the required features, but the user must move attention across several general-purpose panels. The next action in the OCR-to-translation loop is not consistently dominant.

## Goals

1. Make `이미지 -> OCR -> 화자 -> 번역 -> 다음 대사` the obvious default loop.
2. Keep the current page image visible during OCR review, speaker confirmation, and translation editing.
3. Present one primary action per stage and advance predictably after it succeeds.
4. Keep project management, inpainting, context, search, filters, and export discoverable without competing with the current task.
5. Preserve all existing data and backend behavior.
6. Support both guided use and a compact expert mode within the same layout.

## Non-Goals

- No project schema or migration changes.
- No Electron IPC contract changes.
- No OCR, Gemini, OpenAI, inpainting, storage, encryption, or export algorithm changes.
- No authentication, account, cloud sync, database, or deployment changes.
- No new package or font dependency.
- No arbitrary-image mode that bypasses saved project asset rules.
- No deletion or silent behavior change of existing features.

## Considered Directions

### A. Canvas Focus

Maximizes the page image and places the active OCR controls next to the selected bubble. This has the best local image focus but makes the broader work queue and progress harder to scan.

### B. Balanced Split Review Cockpit

Keeps a large image, persistent review inspector, and compact bottom queue visible at the same time. It is efficient for expert batch review but provides less explicit guidance about the sequence of decisions.

### C. Queue-Guided Workbench — Selected

Combines a large image, a short current-page dialogue queue, and an explicit four-stage work panel. It reduces decision load and clearly communicates the next action. Its main drawback—an oversized guidance region for experienced users—is addressed with a collapsible compact mode.

## Information Architecture

### Top Project Bar

The top bar remains the home for global state and file actions:

- app and project name;
- saved or unsaved state;
- current file state;
- open, save, save as, and export;
- previous page, `current / total`, and next page.

These controls remain visible but visually secondary to the active workflow action.

### Left Tool Rail

A narrow rail preserves access to the existing supporting areas:

- pages and image connection;
- OCR review;
- character and dictionary context;
- dialogue lines and issues;
- inpainting;
- guide and settings.

The rail changes supporting content but never replaces or hides the central page image.

### Central Image Workspace

The page image is the largest single region. It contains:

- the current manga page;
- page-level OCR and image tools;
- the active OCR bounding-box highlight when coordinates exist;
- a concise stage hint near the active region;
- the existing image-empty and image-load-failure states.

The image remains mounted and visible while the right work panel changes stages.

### Current-Page Dialogue Queue

A compact queue below the image shows a small number of nearby lines, normally the active line plus its immediate neighbors. Each row exposes only the information needed to choose the next item:

- order and speaker;
- source or OCR text;
- translation status;
- warning or low-confidence indicator.

Search, speaker filters, workflow filters, project-wide search, and issue-only views remain available through the existing bottom-panel modes. The compact default queue does not remove those capabilities.

### Right Guided Work Panel

The right panel contains a four-stage status rail and one current-stage surface:

1. `OCR 확인`
2. `화자 확인`
3. `번역 수정`
4. `완료`

Only the current stage receives the primary emphasis. Completed stages show their chosen values, and later stages provide a concise preview without exposing multiple competing actions.

The panel supports two session-local display modes:

- **Guided:** full stage labels, current task content, and next-action explanation.
- **Compact:** a narrow stage rail plus current task controls, leaving more width for the image.

No new persisted preference is required for the first version.

## Core Interaction Flow

### 1. Image and OCR

- The user selects a saved project page with an attached image.
- `말풍선 OCR` or the existing Space shortcut runs OCR under current guard conditions.
- OCR success opens the guided work panel at `OCR 확인` without covering the page.
- The candidate list preserves existing grouping and default-selection policies.
- Selecting a candidate highlights its bounding box when available.
- The user may correct the detected source text before applying.

Primary action: `OCR 적용 · 화자 확인`.

### 2. Speaker Confirmation

- The selected OCR candidate and image highlight remain visible.
- Speaker candidates display name and confidence.
- Existing character context informs the candidate list without changing the underlying OCR result contract.
- `미상` remains a valid choice.
- A low-confidence or unknown selection adds or preserves a visible `검토 필요` signal instead of blocking progress.

Primary action: `화자 적용 · 번역 수정`.

### 3. Translation Correction

- Source text, AI draft, and user translation remain available.
- The user translation remains the authoritative editable output.
- Character speech-style and dictionary context appear only as supporting information.
- Editing marks the project dirty through the existing state path.

Primary action: `적용하고 다음 대사`.

### 4. Completion and Queue Advance

- The current line receives the chosen workflow status through existing line update behavior.
- The next actionable line on the current page becomes selected.
- If the page has no remaining actionable line, the work panel clearly offers the next page rather than silently navigating.
- Page and selection synchronization continues to use the existing page-navigation rules.

## State Model

The redesign reuses the existing renderer state boundaries:

```ts
type WorkspaceMode = "viewer" | "line-edit" | "ocr-review" | "inpainting";
type LeftPanel = "pages" | "context" | "guide" | "settings" | null;
type BottomPanel = "dialogue" | "ocr-candidates" | "issues";
type GuidedStage = "ocr" | "speaker" | "translation" | "complete";
type GuidanceDensity = "guided" | "compact";
```

`GuidedStage` and `GuidanceDensity` are renderer-only UI state. They do not enter the saved project payload.

State rules:

- OCR completion enters `workspaceMode = "ocr-review"` and `guidedStage = "ocr"`.
- Applying OCR advances to `guidedStage = "speaker"` while preserving the review candidate.
- Applying a speaker advances to `guidedStage = "translation"`.
- Applying the translation updates the line through existing handlers, selects the next actionable line, and returns the stage to the appropriate state for that line.
- Opening inpainting changes the existing workspace mode but does not discard the current line selection.
- Escape closes the active OCR or inpainting task using existing cancellation semantics.

## Component Boundaries

### `App.tsx`

- Owns the current guided stage and compact/guided display state.
- Coordinates transitions between the image, OCR review, speaker selection, translation editor, and dialogue queue.
- Reuses existing import, OCR, line-update, page-navigation, save, export, and inpainting handlers.
- Does not absorb provider or storage logic.

### `PageImagePanel.tsx`

- Continues to own page-image presentation and current image actions.
- Accepts optional active OCR highlight data and current-stage action hints.
- Does not mutate dialogue or OCR result data directly.

### Reusable OCR Work Surface

- Extracts the current review-item editing and selection behavior from the modal presentation.
- Renders safely inside the right work panel while preserving the existing apply/cancel data semantics.
- Keeps the current modal available as a rollback path until the work-surface tests cover equivalent behavior.

### Guided Work Panel

- Presents the stage rail, selected values, current task content, primary action, retry/cancel affordances, and guided/compact toggle.
- Receives data and callbacks from `App.tsx`.
- Contains no Electron or provider calls.

### Dialogue Queue

- Reuses existing dialogue selection, filtering, status, search, and update logic.
- Adds a compact current-page presentation for the default workflow.
- Keeps the full table and issue modes available.

## Data Flow

```text
Electron OCR result
  -> App speechBubbleReview state
  -> active OCR item in guided work panel
  -> corrected OCR text + selected speaker
  -> existing apply review handler
  -> DialogueLine update
  -> selected line translation editor
  -> existing updateLine handler
  -> current-page queue and page summary
  -> existing save/export paths
```

The renderer remains a consumer of the current Electron API. No filesystem or provider access moves into React components.

## Error and Cancellation Behavior

### OCR

- OCR failure leaves the page image, dialogue lines, and current selection unchanged.
- The right panel shows the existing error message in context and offers retry or close.
- Cancelling review creates no dialogue lines and returns to the previous stable viewer or line-edit state.

### Speaker Confidence

- Missing or low-confidence speaker information is visible and filterable.
- The user may continue with `미상`; the line keeps a review signal.
- No candidate is silently selected when the provider result does not justify it.

### Translation and Save

- Translation edits mark the project dirty using the existing update path.
- Save failure keeps the editor contents in memory, keeps the dirty state, and leaves the user on the same line.
- Unsaved-change close and project-switch guards remain unchanged.

### Image and Inpainting

- Missing or failed images retain the existing reconnect guidance.
- Inpainting errors leave the editor open and do not replace the current page image.
- Entering or closing inpainting preserves the selected dialogue line.

## Keyboard and Accessibility

- Existing Space, Escape, page-arrow, line-move, and status shortcuts remain guarded against input, textarea, select, and contenteditable focus.
- Each stage and primary action has a visible label and accessible name.
- Stage state is communicated by text and semantics, not color alone.
- The work panel follows native tab order.
- Focus moves to the next stage heading or first editable control after a successful apply action.
- Closing a task returns focus to the control that opened it when that control is still mounted; otherwise focus moves to the image canvas's current primary action.
- Selected OCR candidates, dialogue rows, warnings, and disabled actions remain keyboard discoverable.

## Responsive Behavior

The production target remains the Windows desktop app with a minimum supported width of 1100px.

- At 1440px and above, the image and guided work panel remain side by side.
- At 1100–1439px, the left rail stays narrow, the work panel reduces width, and secondary top-bar labels may compact without hiding primary actions.
- The central image retains a usable minimum width and never disappears behind the work panel.
- No mobile-specific product mode is introduced in this redesign.

## Implementation Surface

Expected renderer changes are limited to:

- `src/renderer/App.tsx`
- `src/renderer/styles.css`
- `src/renderer/components/PageImagePanel.tsx`
- `src/renderer/components/SpeechBubbleReviewDialog.tsx`, refactored to expose a reusable review surface while retaining the modal wrapper during transition
- a new `src/renderer/components/GuidedWorkPanel.tsx` for the stage rail and current-stage controls
- `src/renderer/components/DialogueTable.tsx`, extended with an explicit compact queue presentation
- `tests/renderer/App.test.tsx`

No generated files, build output, lockfile, package manifest, Electron main-process code, or shared project schema should change for this work.

## Testing Strategy

### Renderer Regression

- Keep the existing renderer test suite passing.
- Verify file actions, image import rules, page navigation, OCR review apply/cancel, speaker selection, translation editing, line statuses, save guards, export, and inpainting behavior.

### New Workflow Tests

- OCR success opens the guided work panel without hiding the page image.
- Applying OCR advances to speaker confirmation.
- Applying a speaker advances to translation correction.
- Applying a translation updates the line and selects the next actionable line.
- Low-confidence or unknown speakers preserve a review-needed signal.
- Cancelling or failing OCR does not create or mutate dialogue lines.
- Guided and compact panel modes retain the same active item and stage.
- Keyboard focus and shortcuts remain safe in editable fields.

### Visual and Layout Validation

Validate with a real linked page image at:

- 1440x900
- 1600x900
- 1920x1080

For each viewport, confirm:

- the page image remains visible during all four stages;
- the current page, line, and stage are immediately identifiable;
- one primary action is visually dominant per stage;
- no required area has horizontal overflow or clipped controls;
- the compact guidance mode materially enlarges the image area;
- no console warnings or errors are introduced.

### Project Commands

Run from the implementation worktree:

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm run typecheck
npm test
npm run build
```

## Acceptance Criteria

1. The page image stays visible from OCR review through translation correction.
2. The right work panel communicates the current stage and next action without relying on a modal.
3. Successful apply actions advance predictably to the next stage or next actionable line.
4. The user can collapse guidance to a compact expert mode without losing the active task.
5. Supporting tools remain discoverable and all existing behavior remains available.
6. No project data, IPC, provider, storage, authentication, package, or deployment changes are introduced.
7. Existing and new renderer tests pass.
8. Typecheck, full tests, and production build pass.
9. The three required desktop viewports show no blocking overflow, clipping, or console errors with a real image loaded.

## Approved Decisions

| Decision | Approved Result |
| --- | --- |
| Product surface | Redesign the current Electron renderer UI, not a separate marketing site. |
| Primary goal | Optimize `이미지 -> OCR -> 화자 확인 -> 번역 수정`. |
| Visual direction | C: 작업 큐 가이드. |
| Expert-use adjustment | Allow the guidance region to collapse to a compact stage rail. |
| Image behavior | Keep the current page visible throughout review and editing. |
| Workflow behavior | One dominant action per stage with explicit advancement. |
| Error behavior | Preserve current data on failure or cancellation and allow contextual retry. |
| Technical boundary | Minimal renderer changes; no schema, IPC, provider, package, or deployment changes. |
