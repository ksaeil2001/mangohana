# Focus Deck Structural Redesign Design

**Date:** 2026-07-11

**Status:** Approved in sections; awaiting written-spec review

**Supersedes:** `2026-07-11-editorial-workbench-visual-redesign-design.md` and its CSS-first implementation plan

## Objective

Replace the current multi-column translation editor with a coherent, image-first Focus Deck. The redesign must make the image → OCR correction → speaker confirmation → translation correction flow fast, visually stable, and predictable while preserving the existing data model, persistence, IPC, OCR geometry, and translation behavior.

This is a structural redesign, not a palette refresh. Existing features remain available, but their size, placement, hierarchy, and presentation may change to serve the approved workflow.

## Product Principles

1. The page image is the primary visual object.
2. The user makes one decision at a time.
3. Secondary tools remain reachable without permanently consuming workspace.
4. Navigation never hides where the user is in the page or workflow.
5. Size, spacing, and alignment come from shared scales rather than local exceptions.
6. Color reinforces a labeled state and is never the only state indicator.
7. A layout transition must not change translation data or OCR coordinates.

## Approved Layout

### Application shell

The desktop shell uses four stable bands:

- A 52px top bar spanning the viewport.
- A 54px left tool rail below the top bar.
- A central workspace split between the image canvas and current-stage editor.
- An 86px dialogue filmstrip below the workspace and to the right of the tool rail.

The top bar contains the product identity, current project/page context, the four-stage workflow indicator, save state, and export action. It does not contain project setup forms or long navigation controls.

### Tool rail and drawer

The left rail exposes four consistently sized destinations: Work, Pages, Context, and Settings. Selecting Pages, Context, or Settings opens a 280px overlay drawer above the canvas. The drawer does not resize the canvas or move the current-stage editor. Selecting the active destination again, pressing Escape, or clicking outside closes it.

The drawer contains the existing project controls, page list, context information, API-key controls, and settings. No existing capability is deleted. Controls are regrouped by destination and progressively disclosed instead of being permanently visible.

### Resizable workspace

The default desktop workspace ratio is 72% image canvas and 28% stage editor. A visible 8px separator supports pointer and keyboard resizing.

- The stage editor has a minimum width of 320px and maximum width of 520px.
- Pointer drag is clamped to those limits.
- The separator is keyboard focusable and supports ArrowLeft and ArrowRight adjustments.
- The last valid width is stored per project and restored on the next visit.
- Invalid or missing stored values fall back to the default ratio.

The image canvas consumes all remaining space. Its fit and actual-size calculations remain based on the final available canvas rectangle.

### Dialogue filmstrip

The bottom filmstrip shows exactly five logical positions when available: two previous lines, the current line, and two next lines. Near the beginning or end of a page, available items remain ordered and aligned around the current item without creating invalid placeholders.

Each item shows line number, labeled status, and a truncated translation or source preview. The current line receives position, border, label, and `aria-current` treatment. Completing or selecting a line recenters the five-item window.

## Single-Stage Editor

The right panel renders only the controls required by the current workflow stage.

### OCR correction

- The selected OCR region is highlighted and brought into view on the canvas.
- The panel shows OCR text, confidence, and correction controls.
- Approval persists the corrected source text and advances to speaker confirmation.

### Speaker confirmation

- The panel shows the corrected source, existing speaker candidates, relevant context, and one speaker decision.
- Approval persists the speaker and advances to translation correction.

### Translation correction

- The panel shows the corrected source, confirmed speaker, relevant context note, and translation editor.
- Approval persists the translation, marks the line complete, and advances to the next incomplete line.

### Completion

- The panel confirms page or project completion without replacing the workspace with a large empty success state.
- If unfinished work remains, the primary action advances to the next incomplete line or page.
- If the project is complete, export and review actions become primary.

Existing stage labels, numbered progress, text status, `data-state`, and `aria-current` remain available. Stage color never replaces these signals.

## Interaction Model

- `Enter` approves the current stage and advances when focus is not in a multiline text field.
- `Shift+Enter` inserts a newline in the translation editor.
- ArrowUp and ArrowDown move between available dialogue lines when focus is outside editable controls.
- Clicking a filmstrip item selects that line.
- Navigation automatically saves a valid dirty edit before moving.
- Invalid required data blocks advancement only inside the stage editor and moves focus to the first invalid field.
- API failures preserve all current input and provide an in-panel retry action.
- Full-screen blocking modals are reserved for destructive, difficult-to-reverse operations.
- Opening the overlay drawer does not resize the canvas.
- Editor width, drawer state, and image zoom are stored as UI preferences per project, separate from translation content.

## Visual System

### Color

- Frame: deep navy `#14213D`
- Raised navy surface: `#1B2A47`
- Workspace: warm ivory `#F7F2E8`
- Panel/paper: cream `#FFFDF8`
- Primary action: teal `#168C86`
- OCR accent: aqua `#2F80A8`
- Speaker accent: amber `#D39028`
- Translation accent: coral `#D7654F`
- Completion accent: emerald `#2E8B68`

Stage accents are used for progress lines, borders, icons, and compact markers. Large state surfaces use pale tints with dark text. Exact saturated stage colors are not used behind white body text unless measured contrast reaches 4.5:1. All normal text and controls must meet WCAG AA contrast.

### Type and size

- Availability-based Korean UI stack: Pretendard, Noto Sans KR, Malgun Gothic, sans-serif.
- Monospace metrics stack: Cascadia Mono, SFMono-Regular, Consolas, monospace.
- Stage title: 22px.
- Panel/section title: 18px.
- Body and editable text: 14px minimum.
- Supporting metadata: 12px minimum.
- Numeric metrics use tabular figures.

### Spacing and shape

- Base spacing scale: 4, 8, 12, 16, 24, and 32px.
- Standard control height: 40 or 44px according to emphasis.
- Standard radius: 4px for controls and 6px for primary panels.
- Shadows are limited to overlay drawers, popovers, and other genuinely elevated surfaces.
- No decorative gradients or uniformly bubbly card treatment.

### Motion

- Functional transitions last 140–180ms.
- Motion communicates drawer opening, selection change, focus, and resize feedback.
- There are no decorative entrance sequences.
- `prefers-reduced-motion` removes nonessential transition and animation duration.

## Component Architecture

The new composition uses these responsibilities:

- `AppShell`: top bar, rail, workspace, and filmstrip placement.
- `ToolDrawer`: overlay destination and close behavior.
- `WorkflowHeader`: stage progress and page/project context.
- `ResizableWorkspace`: split sizing, constraints, keyboard resizing, and UI preference persistence.
- `ImageCanvas`: existing image, zoom, OCR overlay, and inpainting behavior.
- `StageEditor`: selects one stage editor based on existing workflow state.
- `OcrStageEditor`, `SpeakerStageEditor`, `TranslationStageEditor`, and `CompletionStageEditor`: stage-specific presentation around existing data and actions.
- `DialogueFilmstrip`: five-item window, selection, recentering, and accessible status.

The design may extract these components from the current `App.tsx`, but it must not introduce a new state-management package. Existing application state and callbacks remain the source of truth. Layout state is isolated from translation-domain state.

## Responsive Behavior

- At 1440px and wider, use the complete Focus Deck with the persisted resizable editor.
- From 1100px through 1439px, keep the side-by-side workspace and enforce the 320px editor minimum.
- At 1099px and below, the canvas uses the workspace width and the stage editor opens as a dismissible overlay panel.
- The filmstrip remains available; on narrow screens it may show the current line plus one neighbor on either side while preserving the same logical window behavior.
- The 1100/1099 boundary must not introduce horizontal document overflow.
- At all breakpoints, top-level focus order follows the visual reading order.

## Data and Persistence Boundaries

Translation content, OCR boxes, speakers, pages, project files, IPC payloads, and storage schemas remain unchanged.

UI preferences may store:

- Stage editor width.
- Last open drawer destination or closed state.
- Image zoom mode and zoom value.

UI preference failures are nonfatal. The application falls back to approved defaults without blocking editing. No database migration, authentication change, package addition, or deployment change is part of this redesign.

## Error and Empty States

- Empty project: the canvas contains one focused setup action, while the stage editor explains the next required step.
- Missing image: preserve project context and provide image linking in the canvas.
- Invalid OCR or speaker result: show labeled warnings in the relevant stage editor.
- API failure: retain inputs, identify the failed operation, and offer retry.
- Unsaved local edits: indicate saving state in the top bar without obscuring work.
- Project completion: retain the image and history context while surfacing review/export actions.

## Verification Strategy

Automated verification covers:

- Stage selection and advancement.
- Enter, Shift+Enter, ArrowUp, and ArrowDown behavior.
- Five-item filmstrip at page start, middle, and end.
- Width clamping, keyboard resizing, storage, restoration, and invalid-value fallback.
- Drawer overlay behavior and Escape dismissal.
- API error preservation and retry.
- Existing persistence, workflow navigation, and component tests.
- Type checking, full test suite, and production build.

Rendered verification covers:

- Empty project, image project, OCR, speaker, translation, page completion, project completion, and API-error states.
- Drawer closed and each drawer destination open.
- Editor minimum, default, custom, and maximum widths.
- 1099, 1100, 1440, 1600, and 1920px viewport widths.
- Zero horizontal document overflow.
- OCR fit and actual-size overlay alignment.
- Visible focus, keyboard order, labels, and WCAG AA contrast.
- Before/after screenshots from identical deterministic states.

## Migration Sequence

1. Add structural layout state and preference boundaries without changing rendered behavior.
2. Introduce `AppShell`, top workflow header, rail, and overlay drawer.
3. Introduce `ResizableWorkspace` and move the existing image and inspector content into it.
4. Split the current inspector into stage-specific editors while reusing existing actions and state.
5. Replace the current bottom queue presentation with `DialogueFilmstrip`.
6. Apply the approved visual system and responsive behavior.
7. Run complete behavioral, accessibility, geometry, and rendered verification.

Each sequence step must preserve a working application and pass the relevant existing tests before the next structural move.

## Out of Scope

- New OCR, translation, or image-generation providers.
- Changes to translation algorithms or prompt content.
- Project-file schema or database migrations.
- Authentication, security, deployment, or hosting changes.
- Removal of existing user-facing capabilities.
- New third-party UI, state, resize, or persistence packages.

## Success Criteria

The redesign is complete when:

- The page image visibly dominates the workspace.
- Only the current stage's required controls occupy the right editor.
- The user can complete repeated dialogue work without opening project settings or moving across competing permanent panels.
- The filmstrip preserves immediate dialogue context in a stable five-item window.
- Desktop editor width is adjustable, accessible, constrained, and restored per project.
- All existing translation and persistence behavior remains intact.
- The approved dimensions, visual tokens, responsive boundaries, keyboard behavior, OCR geometry, and contrast requirements are verified with automated and rendered evidence.
