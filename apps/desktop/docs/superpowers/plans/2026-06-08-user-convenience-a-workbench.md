# User Convenience A Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the desktop translation editor from B- convenience to an A-grade dense workbench for repeated image reference, line selection, comparison, editing, status marking, and next-line movement.

**Architecture:** Keep the existing React/Electron app structure. Improve the central page workspace, dialogue row comparison surface, left workflow guidance, and right inspector without adding landing-page or dashboard patterns. Verify every claim with desktop-only browser evidence using the real `review-assets/page-001.png` image.

**Tech Stack:** React 19, TypeScript, Vite, Electron preload IPC, CSS grid, Vitest, gstack browse.

---

### Task 1: Baseline Evidence

**Files:**
- Read: `src/renderer/App.tsx`
- Read: `src/renderer/components/*.tsx`
- Read: `src/renderer/styles.css`
- Output: `review-captures-20260608-a-workbench/before-*`

- [ ] **Step 1: Start the local dev server**

Run: `npm run dev`
Expected: Vite serves the renderer at `http://localhost:4173`.

- [ ] **Step 2: Open the app with gstack browse**

Run:
```powershell
$B goto http://localhost:4173
$B viewport 1440x900
$B screenshot review-captures-20260608-a-workbench/before-1440x900.png
$B snapshot -o review-captures-20260608-a-workbench/before-1440x900.snapshot.txt
$B console --errors
```

Expected: screenshot and snapshot show the current workbench state; console output is recorded.

- [ ] **Step 3: Inject a verification state with the real image**

Use browser JS to place realistic dialogue lines and a page image using `review-assets/page-001.png` through the existing renderer state or a local served path. Do not modify app code only for verification.

- [ ] **Step 4: Record selector metrics at 1440, 1600, 1920**

Run DOM measurement for: `document`, `.left-panel`, `.right-panel`, `.table-panel`, `.page-workspace`, `.page-dialogue-workspace`, `.table-row`, `.row-metadata`, `.page-image-panel`, `.page-image-stage`, `.page-image-panel img`, `.line-detail-panel`, `.context-panel`, `.button-grid`.

Expected: JSON includes `clientWidth`, `scrollWidth`, `overflowX`, `clientHeight`, `scrollHeight`, `overflowY`, plus image `naturalWidth`, `naturalHeight`, `clientWidth`, `clientHeight`.

### Task 2: Workbench Layout

**Files:**
- Modify: `src/renderer/styles.css`
- Modify if needed: `src/renderer/components/PageImagePanel.tsx`

- [ ] **Step 1: Keep image and list side-by-side on 1440+ desktops**

Remove the `:has(.page-image-stage)` rule that collapses the workspace to one column when an image exists. Use a stable two-column grid such as `minmax(420px, 0.72fr) minmax(540px, 1fr)`.

- [ ] **Step 2: Cap image growth at 1600 and 1920**

Set the image panel to a bounded height like `min(520px, calc(100vh - 88px))` and prevent width-only stretching. The image must be large enough for reference but must not push the page summary and first dialogue rows out of the first viewport.

- [ ] **Step 3: Prevent horizontal overflow**

Ensure central grid children use `min-width: 0`, toolbar chips truncate, and `.table-panel`/`.page-workspace` do not produce document-level `overflowX` at 1440, 1600, or 1920.

### Task 3: Repeated Line Editing Flow

**Files:**
- Modify: `src/renderer/components/DialogueTable.tsx`
- Modify: `src/renderer/components/LineDetailPanel.tsx`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Make each row compare source, AI, and user translation in-place**

Show all three text fields in the row with compact labels. Keep the selected row visually linked to the inspector with a strong left rail and background.

- [ ] **Step 2: Keep row height balanced**

Use two-line clamping for source/AI/user text. Keep unselected rows dense enough that several lines remain visible in the first viewport while selected text remains readable.

- [ ] **Step 3: Make the inspector a helper panel**

Keep the right panel focused on the selected line, quick status buttons, and detailed textareas. Push metadata and warnings behind details blocks so it does not feel like a second primary work area.

- [ ] **Step 4: Preserve keyboard flow**

Verify `Alt+ArrowUp/Down`, `Ctrl+Enter`, and `Ctrl+R` still update selection/status without console errors.

### Task 4: Start State, Save State, and Image State Clarity

**Files:**
- Modify: `src/renderer/components/ProjectActionsPanel.tsx`
- Modify: `src/renderer/components/ImageImportPanel.tsx`
- Modify: `src/renderer/components/ImportPanel.tsx`
- Modify: `src/renderer/components/PageImagePanel.tsx`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Show the workflow order**

Make the left panel communicate `1 TXT 불러오기`, `2 프로젝트 저장`, `3 이미지 연결`, `4 대사 수정` without verbose repeated copy.

- [ ] **Step 2: Explain disabled image upload**

When image upload is disabled, show whether the cause is unsaved project or secret project, and the next action.

- [ ] **Step 3: Keep file path from distracting**

Keep the project path one-line truncated and make unsaved changes visible near Save.

- [ ] **Step 4: Fix form field id/name warnings**

Add stable `id`/`name` attributes for visible inputs, selects, checkboxes, and textareas that lack them.

### Task 5: Verification and A-Grade Assessment

**Files:**
- Output: `review-captures-20260608-a-workbench/after-*`

- [ ] **Step 1: Run static verification**

Run:
```powershell
npm run typecheck
npm test
```

Expected: both commands exit 0 or any failure is recorded with the exact failing test.

- [ ] **Step 2: Run gstack browser verification with real image**

At 1440x900, 1600x900, and 1920x1080, capture screenshot, snapshot, console warning/error output, selector overflow metrics, and image natural/client dimensions after the real image is rendered in `.page-image-panel img`.

- [ ] **Step 3: Check ngrok**

If ngrok is available, expose the local server and record the URL. If Vite allowedHosts or another environment issue blocks it, record the exact reason and continue with localhost evidence.

- [ ] **Step 4: Score all 50 convenience items**

Create a Pass/Partial/Fail table. Do not report A if any Fail remains. Fix blockers and repeat Step 2 before final reporting.
