# Compound Engineering Lessons

## 2026-07-08 - Keep OCR Review Data Backward-Compatible

Context:
- Task: Add review-only speaker candidates to the OCR review modal and apply flow.
- Files/areas: `src/shared/speechBubbleExtraction.ts`, `src/renderer/components/SpeechBubbleReviewDialog.tsx`, `src/renderer/App.tsx`, `tests/renderer/App.test.tsx`.

Mistake or risk:
- What happened: After adding `speakerCandidates` to the shared OCR type, an existing renderer test crashed because older OCR review fixtures did not include that field.
- Why it mattered: OCR review data is review-only and may come from older mocked/provider results; a missing optional-looking candidate list must not blank the entire modal.

Correction:
- What changed: `SpeechBubbleReviewDialog` normalizes missing review speaker candidates to `[]` before deriving the selected speaker.
- Verification: `npm test -- tests/renderer/App.test.tsx`, full `npm test`, `npm run typecheck`, and `npm run build`.

Next plan/review checks:
- Before coding: When adding review-only fields to shared OCR result types, identify all UI entry points that may receive older provider/test objects.
- During review: Search for direct `.field[0]` access on new OCR fields and require an empty/default normalization path.
- Before final handoff: Run at least one renderer test where OCR items omit the new field.

## 2026-07-08 - Treat gstack Electron IPC Checks as Renderer Smoke Tests

Context:
- Task: Verify OCR button, review modal, speaker candidate selection, and apply flow after changing renderer/main/shared OCR code.
- Files/areas: Electron preload IPC, Vite renderer, `SpeechBubbleReviewDialog`, `App` OCR flow.

Mistake or risk:
- What happened: gstack could verify the Vite renderer and modal UI after injecting a browser `window.projectApi` stub, but server/tab resets made ref-based click continuation unreliable and it cannot exercise real Electron preload IPC.
- Why it mattered: Reporting gstack as full Electron verification would overstate the evidence; real apply behavior still needs component/integration tests unless a headed Electron automation path is available.

Correction:
- What changed: Used gstack as a renderer smoke test for button/modal/candidate visibility, and relied on Testing Library plus IPC/provider tests for apply and data flow.
- Verification: gstack snapshot showed enabled OCR button, review modal, `Mika 82%`, `Ren 61%`, speaker input, narration candidate, and apply button; automated tests verified apply output.

Next plan/review checks:
- Before coding: Decide whether UI verification targets Electron IPC or renderer-only behavior.
- During review: If using gstack against Vite, inject `window.projectApi` and force a rerender before checking buttons that are disabled without preload APIs.
- Before final handoff: Separate "gstack renderer smoke" evidence from automated apply-flow evidence in the report.

## 2026-06-09 - Verify Desktop Workbench Convenience With Real Image State

Context:
- Task: Raise the desktop character dialogue translation editor from B- convenience to A-grade workbench convenience.
- Files/areas: `src/renderer/styles.css`, `src/renderer/components/DialogueTable.tsx`, `src/renderer/components/PageImagePanel.tsx`, `src/renderer/components/LineDetailPanel.tsx`, verification assets under `review-captures-20260608-a-workbench/`.

Mistake or risk:
- What happened: The first side-by-side layout pass still produced small horizontal overflow at `1440x900` on `.table-panel` and `.page-workspace`.
- Why it mattered: A desktop workbench can look acceptable in a screenshot while still forcing tiny horizontal scroll, which breaks long-session translation ergonomics.

Correction:
- What changed: Reduced fixed side panel widths and central grid minimums so `document`, `.table-panel`, `.page-workspace`, `.page-dialogue-workspace`, `.table-row`, `.row-metadata`, `.page-image-panel`, `.page-image-stage`, `.page-image-panel img`, `.line-detail-panel`, `.context-panel`, and `.button-grid` all report `overflowX: false`.
- Verification: Re-ran real image screenshots and DOM metrics at `1440x900`, `1600x900`, and `1920x1080`; final screenshots are `review-captures-20260608-a-workbench/final-real-image-*.png`.

Next plan/review checks:
- Before coding: Include all user-required selectors in a reusable DOM metrics snippet before making A-grade claims.
- During review: At `1440x900`, reject the layout if `.table-panel` or `.page-workspace` has `scrollWidth > clientWidth + 1`.
- Before final handoff: Report the exact `overflowX` result for every required selector, not just `document`.

## 2026-06-09 - Shortcut Verification Must Follow Focused Row Behavior

Context:
- Task: Keep repeated translation flow fast with row selection, next/previous movement, status shortcuts, and inspector editing.
- Files/areas: `src/renderer/components/DialogueTable.tsx`, global keyboard handler in `src/renderer/App.tsx`.

Mistake or risk:
- What happened: After `Alt+ArrowDown` moved selection to the next line, `Ctrl+Enter` was intercepted by the focused old row's `onKeyDown` as a normal row activation and moved selection back.
- Why it mattered: The UI appeared to support keyboard movement and status changes independently, but the combined workflow `select row -> next line -> mark complete/review` was broken.

Correction:
- What changed: Row-level Enter/Space handling now ignores `altKey`, `ctrlKey`, and `metaKey`, leaving global shortcuts to operate on the selected line.
- Verification: Browser verification showed `Alt+ArrowDown` selected `#2`, `Ctrl+Enter` changed `#2` to complete, and `Ctrl+R` changed `#2` to review without jumping back.

Next plan/review checks:
- Before coding: List combined keyboard sequences, not only individual shortcuts.
- During review: Run `Alt+ArrowDown`, then `Ctrl+Enter`, then `Ctrl+R`, and assert the inspector heading remains on the same line number after each status change.
- Before final handoff: Include the observed inspector heading text for each shortcut step.

## 2026-06-09 - Record Browser Tool Failures Without Weakening Evidence

Context:
- Task: The user required gstack browse evidence, ngrok check, screenshots, snapshots, console, and selector overflow metrics.
- Files/areas: gstack browse invocation, Playwright fallback, `review-captures-20260608-a-workbench/gstack-browse-failure.txt`, `review-captures-20260608-a-workbench/ngrok-allowed-hosts-block.txt`.

Mistake or risk:
- What happened: `browse.exe` could not start in this Windows/OneDrive worktree because `.gstack` was a reparse directory, and it also timed out from a temp directory. ngrok was available but Vite blocked the ngrok host through `server.allowedHosts`.
- Why it mattered: A tool failure can accidentally become a reason to skip real rendering evidence or silently change app config for a verification-only URL.

Correction:
- What changed: Recorded exact gstack and ngrok failure text, kept app code focused on UX changes, and used Playwright to collect equivalent localhost screenshots, snapshot text, console output, image natural/client dimensions, and selector metrics.
- Verification: `final-console-warning-error.txt` reported 0 warnings/errors; real image natural size was `2880x1620`; final screenshots and metrics were captured for `1440x900`, `1600x900`, and `1920x1080`.

Next plan/review checks:
- Before coding: If gstack browse fails, save the raw failure log under the review capture directory before using a fallback.
- During review: Do not edit `vite.config.ts` only to satisfy a temporary ngrok URL unless the user explicitly asks for public dev-server access.
- Before final handoff: Report both the requested tool failure and the fallback evidence path so the verification chain is auditable.

## 2026-06-08 - Keep Manga Image Anchors Below the Workflow Fold

Context:
- Task: Desktop UI design review fixes for the character dialogue translation editor.
- Files/areas: `src/renderer/styles.css`, page image panel, dialogue table, desktop viewports `1440x900`, `1600x900`, `1920x1080`.

Mistake or risk:
- What happened: The page image was treated as the strongest visual anchor, but the first implementation let it grow too large on wider desktop screens. The user correctly pointed out that the image no longer fit the working screen well.
- Why it mattered: This made the app feel closer to an image viewer than a page translation workbench. A user needs to see the manga page and the first dialogue rows together.

Correction:
- What changed: The connected image panel received a tighter height cap, `max-height: min(620px, calc(100vh - 380px))`, and the image uses `object-fit: contain` so the full page remains visible without internal scroll.
- Verification: Rechecked actual `page-001.png` rendering. At `1600x900`, image was `1000x465` and table started around `y=610`. At `1920x1080`, image was `1335x565` and table started around `y=709`. Image stage overflow was false.

Next plan/review checks:
- Before coding: Define the desired first-viewport composition, including whether the dialogue table must be visible below the page image.
- During review: Measure `.page-image-panel img`, `.page-image-stage`, and `.dialogue-table` top at `1440x900`, `1600x900`, and `1920x1080`.
- Before final handoff: Confirm the full image is visible, there is no internal image-stage overflow, and at least the page summary plus dialogue table start are visible in the first viewport.
