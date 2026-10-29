# Real-Use A-Grade Workbench Audit Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect real-use evidence for the desktop character dialogue translation editor and identify every blocker to an A-grade personal translation workbench.

**Architecture:** Use Electron/main-process storage paths for real file operations and gstack browse for renderer evidence. Keep all audit evidence in `review-captures-20260624-real-use-workbench/` and do not use ngrok. Apply only narrowly scoped fixes that are directly supported by captured evidence, then rerun the same checks.

**Tech Stack:** Electron 42, Vite 8, React 19, TypeScript 6, Vitest, gstack browse.

---

### Task 1: Establish Baseline Evidence

**Files:**
- Create: `review-captures-20260624-real-use-workbench/baseline-typecheck.txt`
- Create: `review-captures-20260624-real-use-workbench/baseline-test.txt`
- Create: `review-captures-20260624-real-use-workbench/baseline-notes.md`

- [ ] **Step 1: Create audit directory**

Run:
```powershell
New-Item -ItemType Directory -Force review-captures-20260624-real-use-workbench
```
Expected: directory exists.

- [ ] **Step 2: Run typecheck and save output**

Run:
```powershell
npm run typecheck *> review-captures-20260624-real-use-workbench/baseline-typecheck.txt
```
Expected: exit code 0, or record the non-zero exit code in `baseline-notes.md`.

- [ ] **Step 3: Run tests and save output**

Run:
```powershell
npm test *> review-captures-20260624-real-use-workbench/baseline-test.txt
```
Expected: exit code 0, or record the non-zero exit code in `baseline-notes.md`.

### Task 2: Verify Real File Workflows Outside Browser Mocks

**Files:**
- Create: `review-captures-20260624-real-use-workbench/real-file-workflow.mjs`
- Create: `review-captures-20260624-real-use-workbench/real-file-work-log.json`
- Create: `review-captures-20260624-real-use-workbench/fixtures/stress-dialogue.txt`
- Create: `review-captures-20260624-real-use-workbench/real-file-workspace/`

- [ ] **Step 1: Write a Node workflow script**

The script must import built main/storage modules after `npm run build:electron`, create a 50+ line, 2+ page project, copy the real image from `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\review-assets\page-001.png`, save a `.ctp`, reopen it, export `.txt`, and write JSON with pass/fail booleans for TXT import, project save, project reopen, image import, image reload persistence, user edit persistence, and TXT export.

- [ ] **Step 2: Run the script**

Run:
```powershell
npm run build:electron
node review-captures-20260624-real-use-workbench/real-file-workflow.mjs
```
Expected: `real-file-work-log.json` includes file paths, SHA values, and no failed assertions. If an assertion fails, record it as an A-grade blocker.

### Task 3: Run Local Renderer With gstack Browse

**Files:**
- Create: `review-captures-20260624-real-use-workbench/before-screenshot-1440x900.png`
- Create: `review-captures-20260624-real-use-workbench/before-screenshot-1600x900.png`
- Create: `review-captures-20260624-real-use-workbench/before-screenshot-1920x1080.png`
- Create: `review-captures-20260624-real-use-workbench/before-snapshot-1440x900.txt`
- Create: `review-captures-20260624-real-use-workbench/before-snapshot-1600x900.txt`
- Create: `review-captures-20260624-real-use-workbench/before-snapshot-1920x1080.txt`
- Create: `review-captures-20260624-real-use-workbench/before-console-warning-error.txt`
- Create: `review-captures-20260624-real-use-workbench/before-metrics-1440x900.json`
- Create: `review-captures-20260624-real-use-workbench/before-metrics-1600x900.json`
- Create: `review-captures-20260624-real-use-workbench/before-metrics-1920x1080.json`

- [ ] **Step 1: Start Vite only on localhost**

Run:
```powershell
npm run dev
```
Expected: local URL is `http://localhost:4173/`. Do not start or configure ngrok.

- [ ] **Step 2: Capture each desktop viewport with gstack browse**

For each viewport `1440x900`, `1600x900`, `1920x1080`, run gstack browse `viewport`, `goto`, `snapshot`, `console --errors`, `screenshot`, and JavaScript selector metrics.

The selector metrics must include `document`, `.left-panel`, `.right-panel`, `.table-panel`, `.page-workspace`, `.page-dialogue-workspace`, `.table-row`, `.row-metadata`, `.page-image-panel`, `.page-image-stage`, `.page-image-panel img`, `.line-detail-panel`, `.context-panel`, and `.button-grid`, with `clientWidth`, `scrollWidth`, `overflowX`, `clientHeight`, `scrollHeight`, and `overflowY`.

Image metrics must include `.page-image-panel img` `naturalWidth`, `naturalHeight`, `clientWidth`, `clientHeight`, `currentSrc`, and load failure state.

### Task 4: Exercise Renderer Interaction Flow

**Files:**
- Create: `review-captures-20260624-real-use-workbench/after-screenshot-1440x900.png`
- Create: `review-captures-20260624-real-use-workbench/after-screenshot-1600x900.png`
- Create: `review-captures-20260624-real-use-workbench/after-screenshot-1920x1080.png`
- Create: `review-captures-20260624-real-use-workbench/after-snapshot-1440x900.txt`
- Create: `review-captures-20260624-real-use-workbench/after-snapshot-1600x900.txt`
- Create: `review-captures-20260624-real-use-workbench/after-snapshot-1920x1080.txt`
- Create: `review-captures-20260624-real-use-workbench/after-console-warning-error.txt`
- Create: `review-captures-20260624-real-use-workbench/after-metrics-1440x900.json`
- Create: `review-captures-20260624-real-use-workbench/after-metrics-1600x900.json`
- Create: `review-captures-20260624-real-use-workbench/after-metrics-1920x1080.json`

- [ ] **Step 1: Seed the browser with realistic renderer data**

Use the renderer API or a temporary in-browser `window.projectApi` shim only for renderer interaction checks. Mark this evidence as browser-renderer evidence, not final real-use file evidence.

- [ ] **Step 2: Verify interaction flow**

Use gstack browse to select a row, edit user translation, change status to draft/complete/review, move next/previous, cross a page boundary, search, speaker filter, status filter, and issue-only filter. Capture screenshots, snapshots, console, and metrics after the flow.

### Task 5: Run Electron Path

**Files:**
- Create: `review-captures-20260624-real-use-workbench/electron-run-log.txt`

- [ ] **Step 1: Start Electron dev command**

Run:
```powershell
npm run dev:electron
```
Expected: Electron main process builds and launches against `http://localhost:4173/`. If the app cannot be automated through OS dialogs in headless tooling, record that limitation and rely on IPC integration tests plus real file workflow script for file persistence evidence.

### Task 6: Apply Evidence-Backed Fixes

**Files:**
- Modify only files required by captured blockers, expected candidates:
- `src/renderer/App.tsx`
- `src/renderer/styles.css`
- `src/renderer/components/ProjectActionsPanel.tsx`
- `src/renderer/components/ImageImportPanel.tsx`
- `src/renderer/components/PageImagePanel.tsx`
- `src/renderer/components/DialogueTable.tsx`
- `src/renderer/components/LineDetailPanel.tsx`
- `src/renderer/components/CharacterDictionaryPanel.tsx`
- `tests/renderer/App.test.tsx`
- `vite.config.ts`

- [ ] **Step 1: Fix only verified A-grade blockers**

For each fix, record the blocker, changed file, and expected evidence in `fix-log.md`. Do not perform landing-page redesign, mobile/tablet QA, or ngrok changes.

- [ ] **Step 2: Add or update focused tests**

Add renderer or storage tests only for changed behavior that can regress, such as disabled reasons, dirty-state labels, image persistence, filter behavior, or export priority.

### Task 7: Reverify and Produce Final Audit Report

**Files:**
- Create: `review-captures-20260624-real-use-workbench/final-screenshot-1440x900.png`
- Create: `review-captures-20260624-real-use-workbench/final-screenshot-1600x900.png`
- Create: `review-captures-20260624-real-use-workbench/final-screenshot-1920x1080.png`
- Create: `review-captures-20260624-real-use-workbench/final-snapshot-1440x900.txt`
- Create: `review-captures-20260624-real-use-workbench/final-snapshot-1600x900.txt`
- Create: `review-captures-20260624-real-use-workbench/final-snapshot-1920x1080.txt`
- Create: `review-captures-20260624-real-use-workbench/final-console-warning-error.txt`
- Create: `review-captures-20260624-real-use-workbench/final-metrics-1440x900.json`
- Create: `review-captures-20260624-real-use-workbench/final-metrics-1600x900.json`
- Create: `review-captures-20260624-real-use-workbench/final-metrics-1920x1080.json`
- Create: `review-captures-20260624-real-use-workbench/evaluation-table.md`
- Create: `review-captures-20260624-real-use-workbench/a-grade-blockers.md`
- Create: `review-captures-20260624-real-use-workbench/final-report.md`

- [ ] **Step 1: Rerun command verification**

Run:
```powershell
npm run typecheck
npm test
```
Expected: record exact exit codes and summaries.

- [ ] **Step 2: Rerun real file workflow**

Run:
```powershell
node review-captures-20260624-real-use-workbench/real-file-workflow.mjs
```
Expected: record exact pass/fail values.

- [ ] **Step 3: Rerun gstack browse evidence**

Repeat the three desktop viewport captures. Fail A-grade eligibility if any required selector has horizontal overflow, `.page-image-panel img` does not render the real image, console warnings/errors exist, or image persistence/file workflow evidence is missing.

- [ ] **Step 4: Fill all 60 evaluation rows**

Each row must be `Pass`, `Partial`, or `Fail` with evidence path references. If any row is `Partial` or `Fail`, do not call the app A-grade.
