# A Grade Translation Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop-only character dialogue translation editor behave like a quiet, dense, repeatable translation workbench for the flow "image check -> line select -> source/AI/user comparison -> edit -> next line".

**Architecture:** Keep the existing React/Vite/Electron renderer structure and improve the current three-column workbench instead of redesigning as a landing page or dashboard. Fix broken Korean UI strings and invalid JSX first, then tighten the left start/status panel, image/list grid, dialogue row comparison, and right inspector so the list remains the primary work surface.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Testing Library, Electron preload APIs, gstack browse.

---

### File Structure

- Modify `src/renderer/App.tsx`: normalize status messages, disabled-image reasons, page/selection movement, and pass workflow props.
- Modify `src/renderer/components/ProjectActionsPanel.tsx`: reorder project actions by real workflow, show start/status guidance, expose disabled reasons through accessible labels/titles.
- Modify `src/renderer/components/ImageImportPanel.tsx`: make save-before-image and blocked-image states explicit near the upload action.
- Modify `src/renderer/components/PageImagePanel.tsx`: clarify image toolbar labels, image empty/error states, and constrain visual growth for 1440/1600/1920 desktop.
- Modify `src/renderer/components/DialogueTable.tsx`: make source/AI/user comparison faster in rows, keep filters compact, strengthen selected row affordance, and preserve accessible hidden fields for tests and form warnings.
- Modify `src/renderer/components/LineDetailPanel.tsx`: make the inspector a secondary edit panel with quick status and focused user translation.
- Modify `src/renderer/styles.css`: adjust desktop grid widths, image max dimensions, row density, selected row styling, compact filter/status layout, and overflow behavior.
- Modify `tests/renderer/App.test.tsx`: update or add assertions for workflow ordering, image guidance, selected-row comparison, keyboard flow, and accessible field ids/names if behavior changes.
- Modify `vite.config.ts`: keep localhost/ngrok host behavior documented if allowedHosts blocks the tunnel.
- Create `review-captures-20260624-a-workbench/`: store before/after/final screenshots, snapshots, console logs, selector metrics, ngrok result, and 50-item evaluation.

### Task 1: Baseline Audit With Real Image

**Files:**
- Create: `review-captures-20260624-a-workbench/before-*`
- Read: all listed renderer files

- [ ] **Step 1: Start the dev server**

Run:

```powershell
npm run dev
```

Expected: Vite serves `http://localhost:4173`.

- [ ] **Step 2: Connect real image without changing production code**

Use gstack browse to load the app. If the native upload flow is not available in browser mode, inject verification-only state through local browser APIs or a static file server so `.page-image-panel img` renders `review-assets/page-001.png`; do not add test-only code to the app.

- [ ] **Step 3: Capture desktop evidence**

For `1440x900`, `1600x900`, and `1920x1080`, save:

```text
before-real-image-<viewport>.png
before-snapshot-<viewport>.txt
before-metrics-<viewport>.json
before-console-warning-error.txt
```

Metrics must include `document`, `.left-panel`, `.right-panel`, `.table-panel`, `.page-workspace`, `.page-dialogue-workspace`, `.table-row`, `.row-metadata`, `.page-image-panel`, `.page-image-stage`, `.page-image-panel img`, `.line-detail-panel`, `.context-panel`, and `.button-grid`.

- [ ] **Step 4: Score the 50 user-convenience items**

Write `before-evaluation.md` with Pass/Partial/Fail and mark every Fail or A-blocking Partial as a blocker.

### Task 2: Restore Valid Korean UI and Workflow Clarity

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/ProjectActionsPanel.tsx`
- Modify: `src/renderer/components/ImageImportPanel.tsx`
- Test: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Fix broken UI strings and JSX**

Replace mojibake labels/messages with stable Korean strings already expected by tests: `대사 편집기`, `새 프로젝트`, `열기`, `저장`, `다른 이름 저장`, `TXT 내보내기`, `TXT 불러오기`, `이미지 업로드`, save/dirty messages, and image disabled reasons.

- [ ] **Step 2: Reorder actions by workflow**

Visible action order should be: `새 프로젝트`, `열기`, `저장`, `다른 이름 저장`, `TXT 내보내기`, while the left panel workflow text makes the actual work order explicit: `1 TXT 불러오기`, `2 프로젝트 저장`, `3 이미지 업로드`, `4 대사 수정`.

- [ ] **Step 3: Explain disabled image upload in the same location**

When no project file path exists, show `프로젝트를 저장하면 페이지 이미지를 업로드할 수 있습니다.` beside the disabled upload button. For secret projects, show `시크릿 프로젝트에서는 이미지 업로드가 아직 지원되지 않습니다.`

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: renderer tests either pass or reveal only issues addressed in later tasks.

### Task 3: Image/List Desktop Layout

**Files:**
- Modify: `src/renderer/components/PageImagePanel.tsx`
- Modify: `src/renderer/styles.css`
- Test: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Clarify image panel states**

Toolbar labels must communicate page number, filename or missing state, `다시 연결`, `화면 맞춤`, and `원본 100%`. Empty and failure states must tell the user what action to take next.

- [ ] **Step 2: Constrain desktop image growth**

Keep `.page-image-panel` useful as reference material without pushing the dialogue list below the fold: sticky on desktop, bounded max-width/max-height, contained image, no horizontal overflow at 1440/1600/1920.

- [ ] **Step 3: Verify first viewport composition**

At each required desktop viewport, confirm the screenshot shows actual image, page summary, and first dialogue row without scrolling.

### Task 4: Row Comparison and Inspector Flow

**Files:**
- Modify: `src/renderer/components/DialogueTable.tsx`
- Modify: `src/renderer/components/LineDetailPanel.tsx`
- Modify: `src/renderer/styles.css`
- Test: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Improve row comparison**

Each visible row must show source, AI translation, and user translation in a compact comparison structure. User translation should have enough width and two-line visibility to show meaningful differences.

- [ ] **Step 2: Strengthen selected-row affordance**

Selected row must visually read as the current edit target and include a compact summary that matches the right inspector line.

- [ ] **Step 3: Keep inspector secondary**

The right panel should provide focused detailed editing, quick status buttons, and metadata in collapsed sections; it should not duplicate a full second table workflow.

- [ ] **Step 4: Preserve keyboard flow**

Keep `Alt+ArrowDown` and `Alt+ArrowUp` line movement, `Ctrl+Enter` complete, and `Ctrl+R` review. Do not add modal or layout behavior that breaks row selection plus immediate editing.

### Task 5: Full Verification and Final Score

**Files:**
- Create: `review-captures-20260624-a-workbench/after-*`
- Create: `review-captures-20260624-a-workbench/final-*`
- Create: `review-captures-20260624-a-workbench/final-evaluation.md`
- Create: `review-captures-20260624-a-workbench/ngrok-url.txt` or `ngrok-allowed-hosts-block.txt`

- [ ] **Step 1: Run code verification**

Run:

```powershell
npm run typecheck
npm test
```

Expected: both exit with code 0 before any A-grade claim.

- [ ] **Step 2: Capture after/final browser evidence**

Using gstack browse and the real image rendered in `.page-image-panel img`, capture screenshot, snapshot, console warning/error output, and selector metrics for `1440x900`, `1600x900`, and `1920x1080`.

- [ ] **Step 3: Record image natural/client sizes**

For each viewport, record `.page-image-panel img` `naturalWidth`, `naturalHeight`, `clientWidth`, and `clientHeight`.

- [ ] **Step 4: Re-score all 50 items**

Write a Pass/Partial/Fail table. If any item is Fail or unapproved Partial, do not claim A. If all pass and typecheck/tests/browser evidence exist, report `User Convenience Score: A`.

- [ ] **Step 5: Final response**

Report score, one-sentence assessment, problems found, changes made, verification environment, localhost/ngrok status, image metrics, screenshot/snapshot evidence, overflow results, 50-item table, A-grade decision, files changed, commands run, and remaining risk.

