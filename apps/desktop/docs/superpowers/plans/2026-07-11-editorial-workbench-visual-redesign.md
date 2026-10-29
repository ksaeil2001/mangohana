# Editorial Workbench Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the existing translation editor as a deep-navy and warm-ivory editorial workbench with teal, aqua, amber, coral, and emerald workflow accents while preserving all behavior.

**Architecture:** Keep the current React structure and responsive grid unchanged. Implement the redesign as a CSS-first token and component-treatment layer in `src/renderer/styles.css`; add no dependencies and touch TSX only if rendered evidence proves a required state cannot be selected with existing classes or `data-*` attributes.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Electron 42, Vitest 4, CSS custom properties, Chromium/Electron visual verification.

## Global Constraints

- Preserve OCR, speaker, translation, completion, queue, storage, IPC, persistence, and keyboard behavior.
- Preserve the existing 1440, 1600, 1920 desktop grids and the 1100/1099 responsive boundary.
- Add no package, remote font, schema, authentication, migration, deployment, or hosting change.
- Use `Pretendard`, `Noto Sans KR`, and `Malgun Gothic` only as an availability-based font stack.
- Color must never be the only state signal; existing labels, numbers, `data-state`, and `aria-current` remain authoritative.
- Keep fit and actual-size OCR highlight geometry unchanged.
- Prefer CSS-only changes. Any TSX change requires rendered proof that CSS selectors cannot express the approved state.
- Store visual evidence under `.gstack/design-reports/editorial-workbench-2026-07-11/`; this directory remains ignored.
- Run commands from `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-editorial-workbench`.

---

### Task 1: Establish the Editorial Color Foundation and Application Frame

**Files:**
- Modify: `src/renderer/styles.css:5-190`
- Visual evidence: `.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/finding-001-before-1440.png`
- Visual evidence: `.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/finding-001-after-1440.png`

**Interfaces:**
- Consumes: existing `:root` tokens and the `.app-frame`, `.app-top-bar`, `.left-rail`, `.left-drawer`, `.workspace-main`, `.right-inspector`, and `.bottom-line-panel` selectors.
- Produces: structural tokens `--frame`, `--frame-raised`, `--paper`, `--paper-muted`, stage tokens, and the final navy/ivory shell used by Tasks 2–4.

- [ ] **Step 1: Capture the neutral baseline**

Start the renderer:

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-editorial-workbench"
npm run dev
```

Using the browser-control tool, open `http://localhost:4173`, set the viewport to 1440×900, and save the current first screen to:

```text
.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/finding-001-before-1440.png
```

Record these baseline observations in the design report:

```text
Expected RED evidence:
- top bar and panels are white or near-white;
- the left rail is light gray rather than a continuous frame;
- workspace surfaces have weak warm/cool separation;
- blue is the only meaningful accent.
```

- [ ] **Step 2: Replace the root palette and typography foundation**

Replace the current `:root` block and `body` typography declarations with:

```css
:root {
  --surface: #f7f2e8;
  --panel: #fffdf8;
  --panel-muted: #f1e8d8;
  --panel-strong: #e8dcc8;
  --ink: #172033;
  --ink-muted: #647083;
  --ink-soft: #7f8897;
  --line: #d8cdbb;
  --line-strong: #b7a993;
  --accent: #168c86;
  --accent-strong: #0f6f6b;
  --danger: #b83a32;
  --warning: #b9662b;
  --image-stage: #101827;
  --frame: #14213d;
  --frame-raised: #1b2a47;
  --paper: #fffdf8;
  --paper-muted: #f1e8d8;
  --stage-ocr: #2f80a8;
  --stage-ocr-tint: #e4f2f7;
  --stage-speaker: #d39028;
  --stage-speaker-tint: #fbf0d8;
  --stage-translation: #d7654f;
  --stage-translation-tint: #fae8e3;
  --stage-complete: #2e8b68;
  --stage-complete-tint: #e2f2eb;
  --font-body: Pretendard, "Noto Sans KR", "Malgun Gothic", sans-serif;
  --font-mono: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
}

body {
  margin: 0;
  font-family: var(--font-body);
  background: var(--surface);
  color: var(--ink);
}
```

- [ ] **Step 3: Style the continuous navy frame**

Update the structural selectors with the following declarations, preserving their existing grid sizing and responsive ownership:

```css
.app-frame {
  background: var(--surface);
}

.app-top-bar {
  border-bottom-color: rgba(255, 255, 255, 0.12);
  background: var(--frame);
  color: #f8f3e8;
  box-shadow: 0 8px 24px rgba(20, 33, 61, 0.14);
}

.app-top-brand h1 {
  color: #fffdf8;
  font-size: 19px;
  font-weight: 800;
  letter-spacing: -0.03em;
}

.top-file-path {
  color: #b9c5d8;
}

.top-file-actions button,
.top-page-actions button {
  border-color: rgba(255, 255, 255, 0.2);
  background: var(--frame-raised);
  color: #f8f3e8;
}

.top-file-actions button:hover:not(:disabled),
.top-page-actions button:hover:not(:disabled) {
  border-color: #65c4bd;
  background: #233657;
}

.left-rail {
  border-right-color: rgba(255, 255, 255, 0.12);
  background: var(--frame);
}

.left-rail button {
  color: #aebbd0;
}

.left-rail button:hover {
  background: rgba(255, 255, 255, 0.07);
  color: #ffffff;
}

.left-rail button[aria-pressed="true"] {
  border-color: rgba(101, 196, 189, 0.52);
  background: var(--accent);
  color: #ffffff;
  box-shadow: 0 6px 16px rgba(15, 111, 107, 0.28);
}

.left-drawer,
.right-inspector {
  background: var(--paper);
}

.workspace-main {
  background: var(--surface);
}

.bottom-line-panel {
  background: var(--paper);
}
```

- [ ] **Step 4: Verify frame contrast and capture the first after screenshot**

Reload the 1440×900 renderer and verify:

```text
- top bar computed background: rgb(20, 33, 61)
- left rail computed background: rgb(20, 33, 61)
- main workspace computed background: rgb(247, 242, 232)
- primary panels computed background: rgb(255, 253, 248)
- document horizontal overflow: 0px
```

Save:

```text
.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/finding-001-after-1440.png
```

- [ ] **Step 5: Run automated checks and commit**

```powershell
npm run typecheck
npm test -- --reporter=dot
npm run build
git diff --check
git add src/renderer/styles.css
git commit -m "style(design): FINDING-001 — establish editorial app frame"
```

Expected: typecheck exits 0, 20 test files and 179 tests pass, the production build exits 0, and the commit contains only `styles.css`.

---

### Task 2: Give the Four Workflow Stages Distinct Semantic Color

**Files:**
- Modify: `src/renderer/styles.css:203-381`
- Visual evidence: `.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/finding-002-before-guided.png`
- Visual evidence: `.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/finding-002-after-guided.png`

**Interfaces:**
- Consumes: `--stage-ocr`, `--stage-speaker`, `--stage-translation`, `--stage-complete`, their tint tokens, and existing `data-stage` / `data-state` attributes.
- Produces: stable semantic stage styling for guided and compact modes without TSX changes.

- [ ] **Step 1: Capture the current guided panel state**

Open a QA project or use the existing deterministic renderer fixture to show the guided work panel. Capture the guided rail before changes at 1440×900:

```text
.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/finding-002-before-guided.png
```

Record RED evidence: the current stage uses the same blue treatment regardless of whether it is OCR, speaker, translation, or complete.

- [ ] **Step 2: Map stage data attributes to color variables**

Add immediately before `.guided-stage-list li[data-state="current"]`:

```css
.guided-stage-list li {
  --stage-color: var(--ink-soft);
  --stage-tint: var(--panel-muted);
}

.guided-stage-list li[data-stage="ocr"] {
  --stage-color: var(--stage-ocr);
  --stage-tint: var(--stage-ocr-tint);
}

.guided-stage-list li[data-stage="speaker"] {
  --stage-color: var(--stage-speaker);
  --stage-tint: var(--stage-speaker-tint);
}

.guided-stage-list li[data-stage="translation"] {
  --stage-color: var(--stage-translation);
  --stage-tint: var(--stage-translation-tint);
}

.guided-stage-list li[data-stage="complete"] {
  --stage-color: var(--stage-complete);
  --stage-tint: var(--stage-complete-tint);
}
```

- [ ] **Step 3: Replace current, completed, and upcoming treatments**

Replace the existing state rules with:

```css
.guided-work-panel {
  background: var(--paper);
}

.guided-work-header {
  border-bottom-color: var(--line);
  background: var(--frame);
  color: #fffdf8;
}

.guided-work-header span {
  color: #b9c5d8;
}

.guided-work-header button {
  border-color: rgba(255, 255, 255, 0.22);
  background: var(--frame-raised);
  color: #ffffff;
}

.guided-stage-list {
  background: var(--paper-muted);
}

.guided-stage-list li[data-state="current"] {
  border-color: var(--stage-color);
  background: var(--stage-color);
  color: #ffffff;
  box-shadow: 0 7px 16px color-mix(in srgb, var(--stage-color) 24%, transparent);
}

.guided-stage-list li[data-state="complete"] {
  border-color: color-mix(in srgb, var(--stage-color) 28%, var(--line));
  background: var(--stage-tint);
  color: var(--ink);
}

.guided-stage-list li[data-state="upcoming"] {
  color: var(--ink-muted);
}

.guided-stage-number {
  border-color: color-mix(in srgb, var(--stage-color) 60%, var(--line-strong));
  color: var(--stage-color);
}

.guided-stage-list li[data-state="current"] .guided-stage-number {
  border-color: rgba(255, 255, 255, 0.62);
  background: rgba(255, 255, 255, 0.16);
  color: #ffffff;
}

.guided-stage-list li[data-state="complete"] .guided-stage-number {
  background: var(--stage-color);
  color: #ffffff;
}

.guided-stage-list li[data-state="current"] small {
  color: rgba(255, 255, 255, 0.82);
}
```

- [ ] **Step 4: Align guided actions and focus states**

Use teal for shared primary actions while retaining stage color in the rail:

```css
.guided-primary-action {
  background: var(--paper);
}

.guided-primary-action .primary-button,
.guided-complete-state .primary-button,
.guided-task-error button {
  border-color: var(--accent);
  background: var(--accent);
  color: #ffffff;
  box-shadow: 0 7px 16px rgba(22, 140, 134, 0.2);
}

.guided-work-content:focus-visible,
.guided-work-header button:focus-visible,
.guided-primary-action .primary-button:focus-visible,
.guided-task-error button:focus-visible,
.guided-complete-state .primary-button:focus-visible {
  outline: 2px solid #65c4bd;
  outline-offset: 2px;
}
```

- [ ] **Step 5: Verify all four stages and compact accessibility**

Render OCR, speaker, translation, and complete states. Confirm:

```text
- OCR current marker/background uses #2f80a8
- speaker current marker/background uses #d39028
- translation current marker/background uses #d7654f
- complete current marker/background uses #2e8b68
- compact mode keeps all four stage labels in the accessibility tree
- no text contrast ratio falls below 4.5:1
```

Save the after screenshot:

```text
.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/finding-002-after-guided.png
```

- [ ] **Step 6: Run checks and commit**

```powershell
npm run typecheck
npm test -- --reporter=dot
npm run build
git diff --check
git add src/renderer/styles.css
git commit -m "style(design): FINDING-002 — color the guided workflow stages"
```

Expected: all commands exit 0 and only `styles.css` is committed.

---

### Task 3: Restyle the Image Stage, Dialogue Queue, Forms, and Review Surfaces

**Files:**
- Modify: `src/renderer/styles.css:1033-2049`
- Visual evidence: `.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/finding-003-before-workspace.png`
- Visual evidence: `.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/finding-003-after-workspace.png`

**Interfaces:**
- Consumes: the editorial tokens from Task 1 and stage tokens from Task 2.
- Produces: the warm paper editing surface, teal selection language, richer image toolbar, semantic OCR/review treatments, and consistent form focus states.

- [ ] **Step 1: Capture a populated workspace baseline**

Open a saved QA project with a page image and at least five dialogue lines. Show queue mode with a selected line and capture:

```text
.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/finding-003-before-workspace.png
```

Record RED evidence: image tools are near-black, queue/table surfaces are white-gray, and selected lines use a generic blue tint.

- [ ] **Step 2: Restyle the image stage and OCR highlight**

Apply:

```css
.page-image-panel {
  border-color: #253656;
  background: var(--image-stage);
  box-shadow: 0 16px 34px rgba(20, 33, 61, 0.18);
}

.page-image-toolbar {
  border-bottom-color: rgba(255, 255, 255, 0.12);
  background: var(--frame-raised);
  color: #c9d4e4;
}

.page-image-toolbar .page-image-tools span,
.page-image-toolbar .page-image-tools button {
  border-color: rgba(255, 255, 255, 0.17);
  background: #233657;
  color: #e8eef7;
}

.page-image-toolbar .page-image-tools button:hover:not(:disabled) {
  border-color: #65c4bd;
  background: #294263;
}

.page-image-toolbar .page-image-tools button[aria-pressed="true"] {
  border-color: #65c4bd;
  background: var(--accent);
  color: #ffffff;
}

.page-image-ocr-highlight {
  border-color: var(--stage-ocr);
  background: rgba(47, 128, 168, 0.18);
  box-shadow: 0 0 0 2px rgba(16, 24, 39, 0.76), 0 0 22px rgba(47, 128, 168, 0.28);
}

.page-image-ocr-highlight span {
  background: var(--stage-ocr);
  color: #ffffff;
}
```

- [ ] **Step 3: Restyle queue and full-table hierarchy**

Apply:

```css
.dialogue-table {
  border-color: var(--line);
  background: var(--paper);
  box-shadow: 0 10px 28px rgba(71, 59, 39, 0.08);
}

.dialogue-queue-heading {
  border-bottom: 1px solid #b9dcd8;
  background: #e7f3f1;
  color: #486b6a;
}

.dialogue-queue-heading strong {
  color: var(--accent-strong);
  letter-spacing: -0.015em;
}

.table-toolbar {
  background: var(--paper-muted);
}

.table-header {
  background: #e9dfcf;
  color: var(--ink);
}

.table-row {
  background: var(--paper);
  transition: background-color 120ms ease, box-shadow 120ms ease;
}

.table-row:hover {
  background: #fbf6ec;
}

.table-row.selected {
  background: #e7f3f1;
  box-shadow: inset 4px 0 0 var(--accent);
}

.line-list-id strong,
.row-metadata,
.status-summary strong,
.status-summary span {
  font-family: var(--font-mono);
}
```

- [ ] **Step 4: Unify inputs, buttons, and visible status surfaces**

Add a scoped form/control layer after the existing form selectors:

```css
input,
select,
textarea {
  color: var(--ink);
}

.left-drawer input,
.left-drawer select,
.left-drawer textarea,
.right-inspector input,
.right-inspector select,
.right-inspector textarea,
.dialogue-table input,
.dialogue-table select,
.dialogue-table textarea {
  border-color: var(--line-strong);
  background: var(--paper);
}

.left-drawer input:focus,
.left-drawer select:focus,
.left-drawer textarea:focus,
.right-inspector input:focus,
.right-inspector select:focus,
.right-inspector textarea:focus,
.dialogue-table input:focus,
.dialogue-table select:focus,
.dialogue-table textarea:focus {
  border-color: var(--accent);
  outline: 3px solid rgba(22, 140, 134, 0.16);
}

.primary-button {
  border-color: var(--accent);
  background: var(--accent);
  color: #ffffff;
}

.secondary-button {
  border-color: var(--line-strong);
  background: var(--paper);
  color: var(--ink);
}

.status-message {
  border-color: #b9dcd8;
  background: #e7f3f1;
  color: var(--accent-strong);
}
```

- [ ] **Step 5: Align OCR review and semantic feedback without reducing contrast**

Keep dark review cards and apply only the following state accents:

```css
.speech-review-dialog {
  border-color: var(--line-strong);
  background: var(--paper);
}

.speech-review-group {
  border-color: var(--line);
  background: #f8f1e6;
}

.speech-review-item.active {
  border-color: #65c4bd;
  box-shadow: inset 4px 0 0 var(--accent), 0 0 0 1px rgba(22, 140, 134, 0.22);
}

.speech-review-warnings {
  border-color: #d39028;
  background: #3a2b12;
  color: #f8d893;
}

.guided-task-error {
  border-color: #e6aaa0;
  background: var(--stage-translation-tint);
  color: var(--danger);
}
```

Do not alter the verified white/dark foreground values inside `.speech-review-item`, inputs, textareas, metadata, or candidate buttons.

- [ ] **Step 6: Verify populated, review, and inpainting states**

At 1440×900 and 1600×900, verify:

```text
- image remains the strongest visual anchor;
- queue selection uses teal and keeps all text readable;
- full-table filters retain visible labels and focus rings;
- OCR item contrast remains >= 4.5:1;
- inpainting inspector retains 12px padding and vertical scrolling;
- fit and actual OCR wrapper/image deltas remain 0px;
- document horizontal overflow remains 0px.
```

Save:

```text
.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/finding-003-after-workspace.png
```

- [ ] **Step 7: Run checks and commit**

```powershell
npm run typecheck
npm test -- --reporter=dot
npm run build
git diff --check
git add src/renderer/styles.css
git commit -m "style(design): FINDING-003 — enrich editorial work surfaces"
```

Expected: all commands exit 0 and only `styles.css` is committed.

---

### Task 4: Add Restrained Motion, Recheck Responsive States, and Complete the Design Audit

**Files:**
- Modify: `src/renderer/styles.css:2053-2347`
- Create: `.gstack/design-reports/editorial-workbench-2026-07-11/design-audit-editorial-workbench.md`
- Create: `.gstack/design-reports/editorial-workbench-2026-07-11/design-baseline.json`
- Visual evidence: `.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/final-1440.png`
- Visual evidence: `.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/final-1600.png`
- Visual evidence: `.gstack/design-reports/editorial-workbench-2026-07-11/screenshots/final-1920.png`

**Interfaces:**
- Consumes: all structural, stage, image, queue, and form treatments from Tasks 1–3.
- Produces: final interaction polish, reduced-motion behavior, responsive evidence, and the completed design review report.

- [ ] **Step 1: Add restrained transitions**

Add before the first media query:

```css
.guided-stage-list li,
.guided-stage-number,
.table-row,
.primary-button,
.secondary-button,
.top-file-actions button,
.top-page-actions button,
.left-rail button,
.page-image-toolbar .page-image-tools button {
  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease,
    transform 140ms ease;
}

.primary-button:hover:not(:disabled),
.guided-primary-action .primary-button:hover:not(:disabled) {
  background: var(--accent-strong);
  transform: translateY(-1px);
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
```

- [ ] **Step 2: Protect responsive color ownership**

Inside the existing responsive blocks, retain grid declarations and add only these visual adjustments:

```css
@media (max-width: 1099px) {
  .right-inspector {
    border-top-color: var(--line);
    background: var(--paper);
  }
}

@media (max-width: 760px) {
  .left-rail {
    border-bottom-color: rgba(255, 255, 255, 0.12);
    background: var(--frame);
  }

  .app-top-bar {
    box-shadow: 0 6px 18px rgba(20, 33, 61, 0.16);
  }
}
```

Do not change any `grid-template-columns`, `grid-template-rows`, height, min-height, or panel-order declaration in this task.

- [ ] **Step 3: Run the complete visual matrix**

Capture final screenshots at:

```text
1440×900  -> .gstack/design-reports/editorial-workbench-2026-07-11/screenshots/final-1440.png
1600×900  -> .gstack/design-reports/editorial-workbench-2026-07-11/screenshots/final-1600.png
1920×1080 -> .gstack/design-reports/editorial-workbench-2026-07-11/screenshots/final-1920.png
```

Verify all ten states from the design spec: empty project, image project, OCR review, speaker review, translation editing, completed page with remaining work, project complete, queue/full, guided/compact, and inpainting.

For each desktop viewport record:

```text
- document horizontal overflow in pixels;
- frame/workspace/panel computed backgrounds;
- current stage computed background;
- focused primary control outline;
- console error and warning counts.
```

Also verify 1100px stays side-by-side and 1099px stacks without horizontal overflow.

- [ ] **Step 4: Score the final design**

Write `.gstack/design-reports/editorial-workbench-2026-07-11/design-baseline.json` using this schema and actual measured grades:

```json
{
  "date": "2026-07-11",
  "target": "editorial-workbench",
  "designScore": "B",
  "aiSlopScore": "B",
  "categoryGrades": {
    "hierarchy": "B",
    "typography": "B",
    "spacingLayout": "B",
    "colorContrast": "B",
    "interactionStates": "B",
    "responsive": "B",
    "contentQuality": "B",
    "motion": "B",
    "performanceFeel": "B"
  },
  "findings": []
}
```

Change a grade or add a finding when the rendered evidence does not support the initial value. Do not report an A without specific screenshot evidence.

- [ ] **Step 5: Write the final design report**

Create `.gstack/design-reports/editorial-workbench-2026-07-11/design-audit-editorial-workbench.md` with:

```markdown
# Editorial Workbench Design Audit

## Outcome

## Before / After

## Verified Viewports and States

## Accessibility and Contrast

## Responsive Results

## Deferred Findings

## Scores

- Design Score:
- AI Slop Score:

## PR Summary
```

Reference every before/after screenshot and list any state that could not be exercised without an API key as `best-effort`, not `verified`.

- [ ] **Step 6: Run fresh final automated verification**

```powershell
npm run typecheck
npm test -- --reporter=dot
npm run build
git diff --check
git status --short
```

Expected:

```text
typecheck: exit 0
tests: 20 files, 179 tests, 0 failures
build: exit 0, 31 renderer modules transformed
tracked source changes: src/renderer/styles.css only
```

- [ ] **Step 7: Commit the motion/responsive polish**

```powershell
git add src/renderer/styles.css
git commit -m "style(design): FINDING-004 — finish responsive editorial polish"
```

The ignored `.gstack` report and screenshots remain outside the source commit. Confirm the final tracked working tree is clean.
