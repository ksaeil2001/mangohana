# Focus Deck Structural Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current competing multi-column editor with an image-first Focus Deck featuring an overlay tool drawer, resizable single-stage editor, and five-line dialogue filmstrip while preserving translation behavior and OCR geometry.

**Architecture:** Keep `App.tsx` as the existing domain-state owner while extracting focused presentation and UI-state boundaries. Add pure layout/preference utilities first, then independently tested shell, drawer, resize, filmstrip, and stage-editor components before switching the application composition and visual system.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Electron 42, Vitest 4, Testing Library, CSS custom properties, browser `localStorage`, Pointer Events.

## Global Constraints

- Preserve translation content, OCR boxes, speakers, pages, project files, IPC payloads, persistence schemas, and storage behavior.
- Add no package, remote font, database migration, authentication, security, deployment, or hosting change.
- Remove no existing user-facing capability; regroup secondary controls into Work, Pages, Context, and Settings destinations.
- Use a 52px top bar, 54px left rail, 86px desktop filmstrip, 280px overlay drawer, and 8px resizer.
- Default to a 72% canvas / 28% editor ratio; clamp the editor to 320–520px and persist the last valid width per project.
- Use a five-line logical window: two previous, current, and two next; use three visible positions at narrow widths.
- Keep side-by-side layout at 1100px and switch to an overlay stage editor at 1099px.
- Keep OCR fit and actual-size overlay geometry unchanged relative to the final canvas rectangle.
- Maintain WCAG AA 4.5:1 normal-text contrast, visible focus, labeled state, keyboard resizing, and logical focus order.
- Use exact visual tokens from the approved spec; no decorative gradients, bubbly card system, or decorative entrance animation.
- Store UI preferences separately from project translation content; preference failures are nonfatal.
- Run every command from `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-editorial-workbench` in PowerShell.

---

### Task 1: Pure Focus Deck UI State and Preference Utilities

**Files:**
- Create: `src/renderer/focusDeck.ts`
- Create: `tests/renderer/focusDeck.test.ts`

**Interfaces:**
- Produces: `ToolDestination`, `FocusDeckPreferences`, `DEFAULT_EDITOR_WIDTH`, `MIN_EDITOR_WIDTH`, `MAX_EDITOR_WIDTH`, `clampEditorWidth`, `getFocusDeckPreferenceKey`, `loadFocusDeckPreferences`, and `saveFocusDeckPreferences`.
- Consumes later: `ResizableWorkspace` and `App.tsx` use these functions; translation-domain state never imports them.

- [ ] **Step 1: Write failing preference tests**

Create `tests/renderer/focusDeck.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EDITOR_WIDTH,
  clampEditorWidth,
  getFocusDeckPreferenceKey,
  loadFocusDeckPreferences,
  saveFocusDeckPreferences
} from "../../src/renderer/focusDeck";

describe("Focus Deck preferences", () => {
  it.each([[100, 320], [420, 420], [900, 520]])("clamps %s to %s", (value, expected) => {
    expect(clampEditorWidth(value)).toBe(expected);
  });

  it("uses a stable project-specific key", () => {
    expect(getFocusDeckPreferenceKey("C:/projects/story.txt")).toBe("focus-deck:C:/projects/story.txt");
  });

  it("falls back when storage is missing or invalid", () => {
    const storage = { getItem: vi.fn().mockReturnValue("not-json"), setItem: vi.fn() };
    expect(loadFocusDeckPreferences(storage, "story")).toEqual({ editorWidth: DEFAULT_EDITOR_WIDTH, drawer: null, zoom: 1 });
  });

  it("clamps loaded width and saves only UI preferences", () => {
    const storage = { getItem: vi.fn().mockReturnValue('{"editorWidth":999,"drawer":"pages","zoom":1.25}'), setItem: vi.fn() };
    expect(loadFocusDeckPreferences(storage, "story")).toEqual({ editorWidth: 520, drawer: "pages", zoom: 1.25 });
    saveFocusDeckPreferences(storage, "story", { editorWidth: 400, drawer: null, zoom: 1 });
    expect(storage.setItem).toHaveBeenCalledWith("focus-deck:story", '{"editorWidth":400,"drawer":null,"zoom":1}');
  });
});
```

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run tests/renderer/focusDeck.test.ts
```

Expected: FAIL because `src/renderer/focusDeck.ts` does not exist.

- [ ] **Step 3: Implement the pure utility**

Create `src/renderer/focusDeck.ts` with these public types and constants:

```ts
export type ToolDestination = "work" | "pages" | "context" | "settings";
export type DrawerDestination = Exclude<ToolDestination, "work">;

export interface FocusDeckPreferences {
  editorWidth: number;
  drawer: DrawerDestination | null;
  zoom: number;
}

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const MIN_EDITOR_WIDTH = 320;
export const MAX_EDITOR_WIDTH = 520;
export const DEFAULT_EDITOR_WIDTH = 392;

export const clampEditorWidth = (value: number) =>
  Math.min(MAX_EDITOR_WIDTH, Math.max(MIN_EDITOR_WIDTH, Number.isFinite(value) ? value : DEFAULT_EDITOR_WIDTH));

export const getFocusDeckPreferenceKey = (projectKey: string) => `focus-deck:${projectKey || "unsaved"}`;
```

Implement loading with `try/catch`, validate drawer against `pages/context/settings`, validate positive finite zoom, and fall back to `{ editorWidth: 392, drawer: null, zoom: 1 }`. Implement saving with one `JSON.stringify` call and swallow storage errors so editing never blocks.

- [ ] **Step 4: Verify GREEN and regression safety**

```powershell
npx vitest run tests/renderer/focusDeck.test.ts
npm run typecheck
```

Expected: 4 tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/focusDeck.ts tests/renderer/focusDeck.test.ts
git commit -m "feat: add focus deck UI preferences"
```

---

### Task 2: App Shell, Workflow Header, Rail, and Overlay Drawer

**Files:**
- Create: `src/renderer/components/FocusDeckShell.tsx`
- Create: `src/renderer/components/ToolDrawer.tsx`
- Create: `tests/renderer/FocusDeckShell.test.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- `FocusDeckShell` accepts `topBar`, `canvas`, `editor`, `filmstrip`, `drawer`, `activeTool`, `onToolSelect`, and `editorWidth` slots/values.
- `ToolDrawer` accepts `destination: DrawerDestination`, `onClose`, and `children`; it renders an overlay without changing grid columns.

- [ ] **Step 1: Write failing shell/drawer tests**

Test that the shell renders `data-testid="focus-deck-shell"`, four rail buttons with `aria-pressed`, the top workflow label, and all content slots. Test that selecting the active non-work tool calls `onToolSelect("work")`; Escape and backdrop click call `onClose`; clicks inside the drawer do not close it.

```tsx
render(<ToolDrawer destination="pages" onClose={onClose}><button>inside</button></ToolDrawer>);
fireEvent.keyDown(document, { key: "Escape" });
expect(onClose).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run tests/renderer/FocusDeckShell.test.tsx
```

Expected: FAIL because both components are missing.

- [ ] **Step 3: Implement the shell contract**

Use semantic `<header>`, `<nav aria-label="작업 도구">`, `<main>`, and `<footer aria-label="현재 대사 주변 작업 큐">`. Render destinations from this exact array:

```ts
const tools = [
  ["work", "작업"],
  ["pages", "페이지"],
  ["context", "문맥"],
  ["settings", "설정"]
] as const;
```

The drawer backdrop is a sibling overlay inside the shell workspace. Give the panel `role="dialog"`, `aria-modal="false"`, `aria-label={`${label} 도구 서랍`}`, and a close button.

- [ ] **Step 4: Integrate only shell ownership into `App.tsx`**

Add `activeTool` state and map existing project/page/context/settings content into drawer destinations without deleting handlers. Keep the current `PageImagePanel`, guided panel, inspector content, and `DialogueTable` intact as slots during this task. The initial destination is `work`; drawer selection is UI state only.

- [ ] **Step 5: Verify**

```powershell
npx vitest run tests/renderer/FocusDeckShell.test.tsx tests/renderer/App.test.tsx
npm run typecheck
npm test -- --reporter=dot
```

Expected: focused tests and all 179+ repository tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/renderer/components/FocusDeckShell.tsx src/renderer/components/ToolDrawer.tsx tests/renderer/FocusDeckShell.test.tsx src/renderer/App.tsx
git commit -m "feat: introduce focus deck application shell"
```

---

### Task 3: Accessible Resizable Workspace

**Files:**
- Create: `src/renderer/components/ResizableWorkspace.tsx`
- Create: `tests/renderer/ResizableWorkspace.test.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Props: `{ editorWidth: number; onEditorWidthChange(width: number): void; canvas: ReactNode; editor: ReactNode }`.
- Produces a separator with `role="separator"`, `aria-orientation="vertical"`, `aria-valuemin="320"`, `aria-valuemax="520"`, and `aria-valuenow`.

- [ ] **Step 1: Write failing resize tests**

Cover ArrowLeft/ArrowRight in 16px increments, Shift+Arrow in 48px increments, min/max clamping, pointer drag based on `containerRight - clientX`, and callback only with clamped values.

```tsx
fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
expect(onChange).toHaveBeenLastCalledWith(416);
```

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run tests/renderer/ResizableWorkspace.test.tsx
```

Expected: missing module failure.

- [ ] **Step 3: Implement pointer and keyboard resizing**

Use Pointer Events, `setPointerCapture`, and `getBoundingClientRect().right`. Apply `style={{ "--focus-editor-width": `${clampEditorWidth(editorWidth)}px` } as CSSProperties }`. Do not install a resize library.

- [ ] **Step 4: Connect project-specific persistence**

In `App.tsx`, derive a stable key from the selected project file path, falling back to the project title plus `unsaved`. Load when that key changes and save after width, drawer, or zoom changes. Guard `window.localStorage` access with the Task 1 utility.

- [ ] **Step 5: Verify**

```powershell
npx vitest run tests/renderer/ResizableWorkspace.test.tsx tests/renderer/focusDeck.test.ts tests/renderer/App.test.tsx
npm run typecheck
```

Expected: all focused tests pass; OCR component props and geometry code are unchanged.

- [ ] **Step 6: Commit**

```powershell
git add src/renderer/components/ResizableWorkspace.tsx tests/renderer/ResizableWorkspace.test.tsx src/renderer/App.tsx
git commit -m "feat: add accessible persisted workspace resizing"
```

---

### Task 4: Five-Line Dialogue Filmstrip

**Files:**
- Modify: `src/renderer/guidedWorkflow.ts`
- Modify: `tests/renderer/guidedWorkflow.test.ts`
- Create: `src/renderer/components/DialogueFilmstrip.tsx`
- Create: `tests/renderer/DialogueFilmstrip.test.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- `getQueueWindow(lines, selectedLineId, size = 5)` returns an ordered, contiguous window centered when possible.
- `DialogueFilmstrip` accepts `lines`, `selectedLineId`, `onSelectLine`, and `visibleCount?: 3 | 5`.

- [ ] **Step 1: Expand failing pure-window tests**

Assert IDs `1..5` at the start, `3..7` for selected `5`, `6..10` at the end, fewer than five unchanged, missing selection starts at the first item, and page-filtered input never leaks another page.

- [ ] **Step 2: Add failing component tests**

Assert five buttons, current item `aria-current="true"`, labeled status text, click selection, and source fallback when translation is empty.

- [ ] **Step 3: Verify RED**

```powershell
npx vitest run tests/renderer/guidedWorkflow.test.ts tests/renderer/DialogueFilmstrip.test.tsx
```

Expected: old default/count assertions and missing component fail.

- [ ] **Step 4: Implement the filmstrip**

Use page-filtered lines from `App.tsx`. Each item is a `<button>` with line ID, Korean status label, and `userTranslation.trim() || sourceText`. Do not render blank placeholder cards. Reuse `getQueueWindow`; do not duplicate window math.

- [ ] **Step 5: Replace only queue-mode `DialogueTable`**

Keep full-table mode and filters reachable from the Pages drawer. Replace the permanent bottom queue rendering with `DialogueFilmstrip`; preserve existing `selectLine` behavior.

- [ ] **Step 6: Verify and commit**

```powershell
npx vitest run tests/renderer/guidedWorkflow.test.ts tests/renderer/DialogueFilmstrip.test.tsx tests/renderer/App.test.tsx
npm test -- --reporter=dot
git add src/renderer/guidedWorkflow.ts tests/renderer/guidedWorkflow.test.ts src/renderer/components/DialogueFilmstrip.tsx tests/renderer/DialogueFilmstrip.test.tsx src/renderer/App.tsx
git commit -m "feat: add centered dialogue filmstrip"
```

Expected: full suite passes with the new test count.

---

### Task 5: Single-Stage Editor and Workflow Keyboard Model

**Files:**
- Create: `src/renderer/components/StageEditor.tsx`
- Create: `tests/renderer/StageEditor.test.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `tests/renderer/App.test.tsx`

**Interfaces:**
- `StageEditor` consumes existing `GuidedStage`, active OCR review data, selected `DialogueLine`, busy/error state, and existing callbacks.
- It produces exactly one labeled section for `ocr`, `speaker`, `translation`, or `complete` and never owns domain state.

- [ ] **Step 1: Write failing stage tests**

Render each stage and assert only that stage heading/control set exists. Assert OCR and speaker approval callbacks, translation textarea/source/speaker context, incomplete-project continuation, project-complete export/review actions, in-panel `role="alert"`, and retry preserving typed input.

- [ ] **Step 2: Write failing keyboard integration tests**

In `App.test.tsx`, assert Enter approves outside multiline fields, Enter inside textarea does not approve, Shift+Enter remains available for newline, ArrowUp/ArrowDown change line outside form controls, and shortcuts ignore input/select/contenteditable targets.

- [ ] **Step 3: Verify RED**

```powershell
npx vitest run tests/renderer/StageEditor.test.tsx tests/renderer/App.test.tsx
```

Expected: missing component and missing shortcut behavior failures.

- [ ] **Step 4: Implement `StageEditor` as a dispatcher**

Keep stage sections private in the same file initially. Every section receives explicit props and calls existing handlers; it must not copy project-update logic from `App.tsx`. Use the exact headings `OCR 확인`, `화자 확인`, `번역 수정`, and `완료`.

- [ ] **Step 5: Replace the guided inspector composition**

Keep `GuidedWorkPanel` stage progress available in the top header, but remove its permanent vertical stage rail from the editor slot. Mount `StageEditor` as the only editor content. Move full review dialogs and inpainting controls to the appropriate stage or tool drawer without deleting them.

- [ ] **Step 6: Implement guarded shortcuts**

Use one document keydown effect with this predicate:

```ts
const target = event.target as HTMLElement | null;
const isEditable = target?.matches("input, textarea, select, [contenteditable='true']") ?? false;
```

Enter advances only when `!isEditable`; arrows navigate only when `!isEditable`; existing modifier shortcuts remain unchanged.

- [ ] **Step 7: Verify and commit**

```powershell
npx vitest run tests/renderer/StageEditor.test.tsx tests/renderer/App.test.tsx tests/renderer/GuidedWorkPanel.test.tsx
npm test -- --reporter=dot
npm run typecheck
git add src/renderer/components/StageEditor.tsx tests/renderer/StageEditor.test.tsx src/renderer/App.tsx tests/renderer/App.test.tsx
git commit -m "feat: focus editing on the current workflow stage"
```

---

### Task 6: Focus Deck Visual System and Responsive Composition

**Files:**
- Modify: `src/renderer/styles.css`
- Modify: `tests/renderer/App.test.tsx`

**Interfaces:**
- Consumes component class names and CSS variables from Tasks 2–5.
- Produces the approved desktop and narrow layout without changing domain logic.

- [ ] **Step 1: Add structural assertions before CSS changes**

Assert shell regions, separator accessible values, drawer dialog, stage editor, and filmstrip coexist in the rendered app. Record a 1440×900 before screenshot under `.gstack/design-reports/focus-deck-2026-07-11/screenshots/before-1440.png`.

- [ ] **Step 2: Replace layout ownership with exact tokens**

Define root tokens for `#14213D`, `#1B2A47`, `#F7F2E8`, `#FFFDF8`, `#168C86`, `#2F80A8`, `#D39028`, `#D7654F`, `#2E8B68`; define spacing 4/8/12/16/24/32, radii 4/6, top 52, rail 54, filmstrip 86, drawer 280, and resizer 8.

Style `.focus-deck-shell` with rows `52px minmax(0, 1fr) 86px` and columns `54px minmax(0, 1fr)`. Style `.resizable-workspace` with `grid-template-columns: minmax(0, 1fr) 8px var(--focus-editor-width)`. Do not apply saturated stage colors behind white body text; use tints plus dark text.

- [ ] **Step 3: Implement overlay drawer and editor motion**

Use 140–180ms transform/opacity/focus transitions, no gradients, and no shadow except drawer/popover. Add `prefers-reduced-motion` to reduce transition/animation duration to `0.01ms`.

- [ ] **Step 4: Implement responsive boundary**

At `max-width: 1099px`, make the editor a fixed/inset overlay and keep the canvas full width; at `min-width: 1100px`, keep side-by-side and minimum 320px. At narrow widths, visually show three filmstrip items while the component retains logical context.

- [ ] **Step 5: Verify computed layout**

At 1099, 1100, 1440, 1600, and 1920px record shell dimensions, canvas/editor rectangles, filmstrip height, drawer width, document overflow, focus outline, and contrast. Verify the editor is 320–520px on desktop and the drawer does not change the canvas rectangle.

- [ ] **Step 6: Run checks and commit**

```powershell
npx vitest run tests/renderer/App.test.tsx
npm run typecheck
npm test -- --reporter=dot
npm run build
git diff --check
git add src/renderer/styles.css tests/renderer/App.test.tsx
git commit -m "style: complete the focus deck visual system"
```

---

### Task 7: Full Behavioral, Geometry, Accessibility, and Visual Audit

**Files:**
- Modify only when a verified defect requires it: `src/renderer/App.tsx`, `src/renderer/components/*.tsx`, `src/renderer/styles.css`, corresponding focused test.
- Create ignored evidence: `.gstack/design-reports/focus-deck-2026-07-11/design-audit.md`
- Create ignored evidence: `.gstack/design-reports/focus-deck-2026-07-11/screenshots/*.png`

**Interfaces:**
- Consumes the complete Focus Deck.
- Produces final evidence and only defect-scoped source commits.

- [ ] **Step 1: Run the state matrix**

Exercise empty project, missing image, OCR, speaker, translation, page completion, project completion, API error/retry, every drawer destination, and min/default/custom/max editor widths. Label API-dependent states `best-effort` unless exercised against a deterministic fixture.

- [ ] **Step 2: Verify OCR geometry**

At fit and actual size, compare image and OCR overlay wrapper rectangles before/after resize and drawer open. Required delta is 0px for matched coordinate origins; actual-size scrolling must remain functional.

- [ ] **Step 3: Verify keyboard/accessibility**

Test tab order, visible focus, separator arrows, Escape drawer close, Enter approval guard, filmstrip `aria-current`, labeled workflow states, alert focus, and text contrast ≥4.5:1.

- [ ] **Step 4: Capture final matrix**

Save identical-state screenshots for 1099, 1100, 1440, 1600, and 1920px. Record console errors/warnings and horizontal overflow for each.

- [ ] **Step 5: Fix only verified defects with focused RED/GREEN tests**

For each defect, first add a focused failing test, run it to confirm RED, apply the smallest fix, rerun to GREEN, and commit with the exact message `fix(focus-deck): resolve verified audit defect`.

- [ ] **Step 6: Run fresh final verification**

```powershell
npm run typecheck
npm test -- --reporter=dot
npm run build
git diff --check
git status --short
```

Expected: typecheck, all tests, and build exit 0; no tracked working-tree changes remain; only ignored audit evidence is present.

- [ ] **Step 7: Write the audit report**

Document verified states, before/after paths, responsive measurements, OCR deltas, keyboard/accessibility results, test counts, console results, and any explicitly deferred best-effort state in `.gstack/design-reports/focus-deck-2026-07-11/design-audit.md`.
