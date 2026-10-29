# Queue-Guided Translation Workbench Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current Electron renderer into a queue-guided workbench where the user moves from page image to OCR review, speaker confirmation, translation correction, and the next dialogue without losing image context.

**Architecture:** Preserve the existing Electron IPC, project model, provider calls, and renderer handlers. Add a small pure workflow module, make the existing OCR review panel stage-aware, wrap the right inspector in a focused guided panel, expose the active OCR bounding box on the image, and add a compact three-line queue mode to the existing dialogue table.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Electron 42, Vitest 4, Testing Library, existing CSS.

## Global Constraints

- Work only in `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor`.
- Preserve project storage, Electron IPC, OCR providers, inpainting behavior, dialogue data, shortcuts, and export behavior.
- Do not add packages, fonts, authentication, cloud sync, database, migrations, hosting, or deployment configuration.
- Do not change generated files, `node_modules`, `dist-electron`, `dist-renderer`, `release`, or `package-lock.json`.
- Keep the Windows desktop minimum supported width at 1100px.
- Validate 1440x900, 1600x900, and 1920x1080 with a real linked page image.
- Keep one visually dominant primary action per workflow stage.
- Keep the page image visible from OCR review through translation correction.
- Use PowerShell commands from the implementation worktree.

---

## File Responsibility Map

| File | Responsibility |
| --- | --- |
| `src/renderer/guidedWorkflow.ts` | Pure workflow types and deterministic queue/next-line selection. |
| `tests/renderer/guidedWorkflow.test.ts` | Unit coverage for workflow derivation and queue selection. |
| `src/renderer/components/SpeechBubbleReviewDialog.tsx` | Stage-aware OCR text review and speaker confirmation using the existing editable item state. |
| `tests/renderer/SpeechBubbleReviewDialog.test.tsx` | Focused component tests for stage preservation, apply payloads, and active item reporting. |
| `src/renderer/components/GuidedWorkPanel.tsx` | Four-stage rail, guided/compact density control, and current-stage content boundary. |
| `tests/renderer/GuidedWorkPanel.test.tsx` | Stage semantics, summaries, and density toggle behavior. |
| `src/renderer/components/PageImagePanel.tsx` | Existing image viewer plus optional normalized OCR bounding-box highlight and stage hint. |
| `tests/renderer/PageImagePanel.test.tsx` | Bounding-box rendering and no-overlay behavior. |
| `src/renderer/components/DialogueTable.tsx` | Existing full table plus a compact three-line queue presentation. |
| `src/renderer/App.tsx` | Workflow orchestration, stage transitions, completion/advance behavior, and layout composition. |
| `src/renderer/styles.css` | Queue-guided layout, compact guidance mode, OCR highlight, queue density, and desktop responsive rules. |
| `tests/renderer/App.test.tsx` | End-to-end renderer workflow and regression coverage. |

---

### Task 1: Add Pure Guided Workflow Rules

**Files:**
- Create: `src/renderer/guidedWorkflow.ts`
- Create: `tests/renderer/guidedWorkflow.test.ts`

**Interfaces:**
- Produces: `ReviewStage`, `GuidedStage`, `GuidanceDensity`, `getGuidedStage`, `getNextActionableLineId`, and `getQueueWindow`.
- Consumed by: `App.tsx`, `GuidedWorkPanel.tsx`, and `DialogueTable.tsx` in later tasks.

- [ ] **Step 1: Write the failing workflow tests**

Create `tests/renderer/guidedWorkflow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DialogueLine, LineStatus } from "../../src/shared/projectTypes";
import {
  getGuidedStage,
  getNextActionableLineId,
  getQueueWindow
} from "../../src/renderer/guidedWorkflow";

function dialogueLine(id: string, order: number, lineStatus: LineStatus = "untranslated", pageNumber = 1): DialogueLine {
  return {
    id,
    order,
    pageNumber,
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: `source-${id}`,
    lineStatus,
    parseConfidence: 0.95,
    parseWarnings: []
  };
}

describe("guided workflow", () => {
  it("derives OCR, speaker, translation, and complete stages", () => {
    expect(getGuidedStage({ hasReview: true, reviewStage: "ocr", hasSelectedLine: false })).toBe("ocr");
    expect(getGuidedStage({ hasReview: true, reviewStage: "speaker", hasSelectedLine: true })).toBe("speaker");
    expect(getGuidedStage({ hasReview: false, reviewStage: "ocr", hasSelectedLine: true })).toBe("translation");
    expect(getGuidedStage({ hasReview: false, reviewStage: "ocr", hasSelectedLine: false })).toBe("complete");
  });

  it("selects the next incomplete line on the same page and wraps once", () => {
    const lines = [
      dialogueLine("a", 1, "untranslated"),
      dialogueLine("b", 2, "complete"),
      dialogueLine("c", 3, "review")
    ];

    expect(getNextActionableLineId(lines, "a", 1)).toBe("c");
    expect(getNextActionableLineId(lines, "c", 1)).toBe("a");
  });

  it("does not select lines from another page", () => {
    const lines = [dialogueLine("page-1", 1, "complete", 1), dialogueLine("page-2", 2, "review", 2)];
    expect(getNextActionableLineId(lines, "page-1", 1)).toBeNull();
  });

  it("returns a three-line window centered around the selected line", () => {
    const lines = [1, 2, 3, 4, 5].map((order) => dialogueLine(String(order), order));
    expect(getQueueWindow(lines, "3").map((line) => line.id)).toEqual(["2", "3", "4"]);
    expect(getQueueWindow(lines, "5").map((line) => line.id)).toEqual(["3", "4", "5"]);
  });

  it("returns the first three lines when the selection is absent", () => {
    const lines = [1, 2, 3, 4].map((order) => dialogueLine(String(order), order));
    expect(getQueueWindow(lines, null).map((line) => line.id)).toEqual(["1", "2", "3"]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/guidedWorkflow.test.ts
```

Expected: FAIL because `src/renderer/guidedWorkflow.ts` does not exist.

- [ ] **Step 3: Implement the pure workflow module**

Create `src/renderer/guidedWorkflow.ts`:

```ts
import type { DialogueLine } from "../shared/projectTypes";

export type ReviewStage = "ocr" | "speaker";
export type GuidedStage = ReviewStage | "translation" | "complete";
export type GuidanceDensity = "guided" | "compact";

export function getGuidedStage(args: {
  hasReview: boolean;
  reviewStage: ReviewStage;
  hasSelectedLine: boolean;
}): GuidedStage {
  if (args.hasReview) return args.reviewStage;
  if (args.hasSelectedLine) return "translation";
  return "complete";
}

export function getNextActionableLineId(
  lines: DialogueLine[],
  currentLineId: string | null,
  currentPage: number
): string | null {
  const pageLines = lines.filter((line) => line.pageNumber === currentPage).sort((left, right) => left.order - right.order);
  if (pageLines.length === 0) return null;

  const currentIndex = pageLines.findIndex((line) => line.id === currentLineId);
  const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  const candidates = [...pageLines.slice(startIndex), ...pageLines.slice(0, startIndex)];
  return candidates.find((line) => line.id !== currentLineId && (line.lineStatus ?? "untranslated") !== "complete")?.id ?? null;
}

export function getQueueWindow(lines: DialogueLine[], selectedLineId: string | null, size = 3): DialogueLine[] {
  if (lines.length <= size) return lines;

  const selectedIndex = lines.findIndex((line) => line.id === selectedLineId);
  if (selectedIndex < 0) return lines.slice(0, size);

  const centeredStart = selectedIndex - Math.floor(size / 2);
  const start = Math.max(0, Math.min(centeredStart, lines.length - size));
  return lines.slice(start, start + size);
}
```

- [ ] **Step 4: Run the focused test and typecheck**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/guidedWorkflow.test.ts
npm run typecheck
```

Expected: five workflow tests PASS and typecheck exits with code 0.

- [ ] **Step 5: Commit the workflow rules**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
git add src/renderer/guidedWorkflow.ts tests/renderer/guidedWorkflow.test.ts
git commit -m "feat: add guided translation workflow rules"
```

---

### Task 2: Split OCR Text Review and Speaker Confirmation

**Files:**
- Modify: `src/renderer/components/SpeechBubbleReviewDialog.tsx:15-295`
- Create: `tests/renderer/SpeechBubbleReviewDialog.test.tsx`

**Interfaces:**
- Consumes: `ReviewStage` from `src/renderer/guidedWorkflow.ts`.
- Produces: stage-aware `SpeechBubbleReviewDialog` props `stage`, `submitLabel`, `onBack`, and `onActiveItemChange`.
- Preserves: existing `SpeechBubbleReviewItem` payload and `onApply(items)` semantics.

- [ ] **Step 1: Write the failing stage-preservation tests**

Create `tests/renderer/SpeechBubbleReviewDialog.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction";
import { SpeechBubbleReviewDialog } from "../../src/renderer/components/SpeechBubbleReviewDialog";

const result: SpeechBubbleExtractionResult = {
  pageNumber: 1,
  speechBubbles: [
    {
      id: "bubble-1",
      type: "speech_bubble",
      text: "誰なの？",
      language: "ja",
      bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.12 },
      readingOrder: 1,
      confidence: 0.92,
      notes: "",
      speakerCandidates: [
        { speaker: "유나", confidence: 0.92, reason: "말풍선 꼬리가 유나를 향합니다." },
        { speaker: "unknown", confidence: 0.31, reason: "얼굴 일부가 가려졌습니다." }
      ]
    }
  ],
  nonSpeechText: [],
  warnings: []
};

describe("SpeechBubbleReviewDialog stages", () => {
  it("preserves corrected OCR text when moving from OCR to speaker stage", () => {
    const onApply = vi.fn();
    const { rerender } = render(
      <SpeechBubbleReviewDialog
        currentPage={1}
        result={result}
        variant="panel"
        stage="ocr"
        submitLabel="OCR 적용 · 화자 확인"
        onApply={onApply}
        onCancel={vi.fn()}
      />
    );

    expect(screen.queryByLabelText("speech_bubble 1 화자")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("speech_bubble 1 원문"), { target: { value: "誰なの、そこ？" } });
    fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));
    expect(onApply).toHaveBeenCalledWith([expect.objectContaining({ text: "誰なの、そこ？" })]);

    rerender(
      <SpeechBubbleReviewDialog
        currentPage={1}
        result={result}
        variant="panel"
        stage="speaker"
        submitLabel="화자 적용 · 번역 수정"
        onBack={vi.fn()}
        onApply={onApply}
        onCancel={vi.fn()}
      />
    );

    expect(screen.queryByLabelText("speech_bubble 1 원문")).not.toBeInTheDocument();
    expect(screen.getByLabelText("speech_bubble 1 화자")).toHaveValue("유나");
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    expect(onApply).toHaveBeenLastCalledWith([expect.objectContaining({ text: "誰なの、そこ？", selectedSpeaker: "유나" })]);
  });

  it("reports the active OCR item for image highlighting", async () => {
    const onActiveItemChange = vi.fn();
    render(
      <SpeechBubbleReviewDialog
        currentPage={1}
        result={result}
        variant="panel"
        stage="ocr"
        onActiveItemChange={onActiveItemChange}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(onActiveItemChange).toHaveBeenCalledWith(
        expect.objectContaining({ id: "bubble-1", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.12 } })
      );
    });
  });
});
```

- [ ] **Step 2: Run the focused component test and verify the expected failure**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/SpeechBubbleReviewDialog.test.tsx
```

Expected: FAIL because the new stage and active-item props do not exist.

- [ ] **Step 3: Add the stage-aware props and active item state**

Update the props and component state in `SpeechBubbleReviewDialog.tsx`:

```tsx
import type { ReviewStage } from "../guidedWorkflow";

type Props = {
  currentPage: number;
  result: SpeechBubbleExtractionResult;
  onApply: (items: SpeechBubbleReviewItem[]) => void;
  onCancel: () => void;
  onBack?: () => void;
  onActiveItemChange?: (item: SpeechBubbleReviewItem | null) => void;
  stage?: ReviewStage | "combined";
  submitLabel?: string;
  variant?: "modal" | "panel";
};

export function SpeechBubbleReviewDialog({
  currentPage,
  result,
  onApply,
  onCancel,
  onBack,
  onActiveItemChange,
  stage = "combined",
  submitLabel = "현재 페이지에 적용",
  variant = "modal"
}: Props) {
  const [items, setItems] = useState<EditableReviewItem[]>(() => createEditableItems(result));
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const selectedItems = items.filter((item) => item.selected && item.text.trim().length > 0);
  const stageItems = stage === "speaker" ? items.filter((item) => item.selected) : items;
  const groups = createGroups(stageItems);

  useEffect(() => {
    const nextItems = createEditableItems(result);
    setItems(nextItems);
    setActiveReviewId(nextItems.find((item) => item.selected)?.reviewId ?? nextItems[0]?.reviewId ?? null);
  }, [result]);

  useEffect(() => {
    const activeItem = items.find((item) => item.reviewId === activeReviewId);
    onActiveItemChange?.(activeItem ? toReviewItem(activeItem) : null);
  }, [activeReviewId, items, onActiveItemChange]);
```

Add this converter below `ReviewItemList`:

```ts
function toReviewItem(item: EditableReviewItem): SpeechBubbleReviewItem {
  const { reviewId: _reviewId, selected: _selected, ...reviewItem } = item;
  return reviewItem;
}
```

Use `role={variant === "modal" ? "dialog" : "region"}` and keep `aria-modal` only for the modal variant.

- [ ] **Step 4: Make the review list render only controls for the current stage**

Pass `stage`, `activeReviewId`, and `onActivate` to every `ReviewItemList` call. Update its interface:

```tsx
<ReviewItemList
  items={group.items}
  stage={stage}
  activeReviewId={activeReviewId}
  onActivate={setActiveReviewId}
  onUpdateItem={updateItem}
/>
```

```tsx
function ReviewItemList({
  items,
  stage,
  activeReviewId,
  onActivate,
  onUpdateItem
}: {
  items: EditableReviewItem[];
  stage: ReviewStage | "combined";
  activeReviewId: string | null;
  onActivate: (reviewId: string) => void;
  onUpdateItem: (id: string, patch: Partial<EditableReviewItem>) => void;
}) {
```

Update each item article and its stage-specific controls:

```tsx
<article
  className={`speech-review-item ${item.reviewId === activeReviewId ? "active" : ""}`}
  key={item.reviewId}
  onClick={() => onActivate(item.reviewId)}
  onFocusCapture={() => onActivate(item.reviewId)}
>
  {stage === "speaker" ? (
    <div className="speech-review-check" aria-label={`${item.textType} ${item.readingOrder} 선택됨`}>
      <span>#{item.readingOrder}</span>
      <small>{Math.round(item.confidence * 100)}%</small>
    </div>
  ) : (
    <label className="speech-review-check">
      <input
        aria-label={`${item.textType} ${item.readingOrder} 적용`}
        type="checkbox"
        checked={item.selected}
        onChange={(event) => onUpdateItem(item.reviewId, { selected: event.target.checked })}
      />
      <span>#{item.readingOrder}</span>
      <small>{Math.round(item.confidence * 100)}%</small>
    </label>
  )}

  {stage !== "ocr" ? renderSpeakerControls(item, onUpdateItem) : null}
  {stage !== "speaker" ? (
    <textarea
      aria-label={`${item.textType} ${item.readingOrder} 원문`}
      value={item.text}
      onChange={(event) => onUpdateItem(item.reviewId, { text: event.target.value })}
    />
  ) : null}
  <div className="speech-review-item-meta">
    <span>{item.textType}</span>
    <span>{formatBbox(item.bbox)}</span>
    <span>{item.language}</span>
    {item.notes ? <span>{item.notes}</span> : null}
  </div>
</article>
```

Extract the existing speaker markup without changing its labels or candidate behavior:

```tsx
function renderSpeakerControls(
  item: EditableReviewItem,
  onUpdateItem: (id: string, patch: Partial<EditableReviewItem>) => void
) {
  return (
    <div className="speech-review-speaker">
      <label>
        <span>화자</span>
        <input
          aria-label={`${item.textType} ${item.readingOrder} 화자`}
          value={item.selectedSpeaker}
          onChange={(event) => onUpdateItem(item.reviewId, { selectedSpeaker: event.target.value })}
          list={`speaker-candidates-${item.reviewId}`}
        />
      </label>
      <datalist id={`speaker-candidates-${item.reviewId}`}>
        {item.speakerCandidates.map((candidate) => (
          <option value={candidate.speaker} key={`${item.reviewId}-${candidate.speaker}`} />
        ))}
      </datalist>
      {item.speakerCandidates.length > 0 ? (
        <div className="speech-review-speaker-candidates" aria-label={`${item.textType} ${item.readingOrder} 화자 후보`}>
          {item.speakerCandidates.map((candidate) => (
            <button
              type="button"
              className={candidate.confidence < 0.7 || candidate.speaker.toLowerCase() === "unknown" ? "low-confidence" : undefined}
              key={`${item.reviewId}-${candidate.speaker}-${candidate.confidence}`}
              title={candidate.reason}
              onClick={() => onUpdateItem(item.reviewId, { selectedSpeaker: candidate.speaker })}
            >
              {candidate.speaker} {Math.round(candidate.confidence * 100)}%
            </button>
          ))}
        </div>
      ) : null}
      {item.speakerCandidates[0]?.reason ? <small>{item.speakerCandidates[0].reason}</small> : null}
    </div>
  );
}
```

- [ ] **Step 5: Update the footer for back, cancel, and stage submit**

Replace the footer with:

```tsx
<footer className="speech-review-actions">
  <div>
    {onBack ? (
      <button type="button" onClick={onBack}>
        이전 단계
      </button>
    ) : null}
    <button type="button" onClick={onCancel}>
      취소
    </button>
  </div>
  <button
    type="button"
    className="primary-button"
    disabled={selectedItems.length === 0}
    onClick={() => onApply(selectedItems.map(toReviewItem).map((item) => ({ ...item, text: item.text.trim() })))}
  >
    {submitLabel}
  </button>
</footer>
```

- [ ] **Step 6: Run the component tests and renderer regression test**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/SpeechBubbleReviewDialog.test.tsx tests/renderer/App.test.tsx
npm run typecheck
```

Expected: focused component tests PASS, the existing App OCR test still PASSes through the default `combined` stage, and typecheck exits with code 0.

- [ ] **Step 7: Commit the stage-aware OCR review**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
git add src/renderer/components/SpeechBubbleReviewDialog.tsx tests/renderer/SpeechBubbleReviewDialog.test.tsx
git commit -m "feat: split OCR and speaker review stages"
```

---

### Task 3: Build the Guided Work Panel Boundary

**Files:**
- Create: `src/renderer/components/GuidedWorkPanel.tsx`
- Create: `tests/renderer/GuidedWorkPanel.test.tsx`

**Interfaces:**
- Consumes: `GuidedStage` and `GuidanceDensity` from `guidedWorkflow.ts`.
- Produces: `GuidedWorkPanel({ stage, density, summaries, onDensityChange, children })`.

- [ ] **Step 1: Write the failing guided panel tests**

Create `tests/renderer/GuidedWorkPanel.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GuidedWorkPanel } from "../../src/renderer/components/GuidedWorkPanel";

describe("GuidedWorkPanel", () => {
  it("marks the current stage and shows completed summaries", () => {
    render(
      <GuidedWorkPanel
        stage="speaker"
        density="guided"
        summaries={{ ocr: "誰なの？", speaker: "유나 92%" }}
        onDensityChange={vi.fn()}
      >
        <p>speaker controls</p>
      </GuidedWorkPanel>
    );

    expect(screen.getByText("화자 확인", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("誰なの？")).toBeInTheDocument();
    expect(screen.getByText("speaker controls")).toBeInTheDocument();
  });

  it("requests compact mode without changing the active stage", () => {
    const onDensityChange = vi.fn();
    render(
      <GuidedWorkPanel stage="translation" density="guided" onDensityChange={onDensityChange}>
        <p>translation controls</p>
      </GuidedWorkPanel>
    );

    fireEvent.click(screen.getByRole("button", { name: "가이드 패널 접기" }));
    expect(onDensityChange).toHaveBeenCalledWith("compact");
    expect(screen.getByText("번역 수정", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("moves focus to the new stage content after a stage transition", () => {
    const { rerender } = render(
      <GuidedWorkPanel stage="ocr" density="guided" onDensityChange={vi.fn()}>
        <p>OCR controls</p>
      </GuidedWorkPanel>
    );

    rerender(
      <GuidedWorkPanel stage="speaker" density="guided" onDensityChange={vi.fn()}>
        <p>speaker controls</p>
      </GuidedWorkPanel>
    );

    expect(screen.getByRole("region", { name: "화자 확인 작업" })).toHaveFocus();
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/GuidedWorkPanel.test.tsx
```

Expected: FAIL because `GuidedWorkPanel.tsx` does not exist.

- [ ] **Step 3: Implement the complete guided panel component**

Create `src/renderer/components/GuidedWorkPanel.tsx`:

```tsx
import { useEffect, useRef, type PropsWithChildren } from "react";
import type { GuidedStage, GuidanceDensity } from "../guidedWorkflow";

type Props = PropsWithChildren<{
  stage: GuidedStage;
  density: GuidanceDensity;
  summaries?: Partial<Record<GuidedStage, string>>;
  onDensityChange: (density: GuidanceDensity) => void;
}>;

const stages: Array<{ id: GuidedStage; label: string; description: string }> = [
  { id: "ocr", label: "OCR 확인", description: "적용할 텍스트와 범위를 확인합니다." },
  { id: "speaker", label: "화자 확인", description: "화자 후보와 신뢰도를 확인합니다." },
  { id: "translation", label: "번역 수정", description: "사용자 수정문을 확정합니다." },
  { id: "complete", label: "완료", description: "다음 대사 또는 페이지로 이동합니다." }
];

export function GuidedWorkPanel({ stage, density, summaries = {}, onDensityChange, children }: Props) {
  const currentIndex = stages.findIndex((item) => item.id === stage);
  const compact = density === "compact";
  const contentRef = useRef<HTMLDivElement>(null);
  const previousStageRef = useRef(stage);

  useEffect(() => {
    if (previousStageRef.current !== stage) contentRef.current?.focus();
    previousStageRef.current = stage;
  }, [stage]);

  return (
    <section className={`guided-work-panel ${compact ? "compact" : "guided"}`} aria-label="번역 작업 단계">
      <header className="guided-work-header">
        <div>
          <strong>현재 작업</strong>
          <span>{stages[currentIndex].label}</span>
        </div>
        <button
          type="button"
          aria-pressed={compact}
          aria-label={compact ? "가이드 패널 펼치기" : "가이드 패널 접기"}
          onClick={() => onDensityChange(compact ? "guided" : "compact")}
        >
          {compact ? "펼치기" : "접기"}
        </button>
      </header>

      <ol className="guided-stage-list" aria-label="번역 작업 순서">
        {stages.map((item, index) => {
          const state = index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming";
          return (
            <li key={item.id} data-stage={item.id} data-state={state} aria-current={state === "current" ? "step" : undefined}>
              <span className="guided-stage-number">{index + 1}</span>
              <div>
                <strong>{item.label}</strong>
                {!compact ? <small>{summaries[item.id] || item.description}</small> : null}
              </div>
            </li>
          );
        })}
      </ol>

      <div
        ref={contentRef}
        className="guided-work-content"
        data-active-stage={stage}
        role="region"
        aria-label={`${stages[currentIndex].label} 작업`}
        tabIndex={-1}
      >
        {children}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the focused tests and typecheck**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/GuidedWorkPanel.test.tsx tests/renderer/guidedWorkflow.test.ts
npm run typecheck
```

Expected: guided panel and workflow tests PASS; typecheck exits with code 0.

- [ ] **Step 5: Commit the guided panel**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
git add src/renderer/components/GuidedWorkPanel.tsx tests/renderer/GuidedWorkPanel.test.tsx
git commit -m "feat: add guided work panel"
```

---

### Task 4: Highlight the Active OCR Region on the Page Image

**Files:**
- Modify: `src/renderer/components/PageImagePanel.tsx:1-178`
- Create: `tests/renderer/PageImagePanel.test.tsx`

**Interfaces:**
- Consumes: `NormalizedBbox` from `src/shared/speechBubbleExtraction.ts` and a React ref for the current primary image action.
- Produces: optional `activeOcrBbox`, `stageHint`, and `primaryActionRef` props.

- [ ] **Step 1: Write the failing image overlay tests**

Create `tests/renderer/PageImagePanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PageImage } from "../../src/shared/projectTypes";
import { PageImagePanel } from "../../src/renderer/components/PageImagePanel";

const image: PageImage = {
  id: "page-image-1",
  pageNumber: 1,
  storedRelativePath: "/review-assets/page-001.png",
  originalFileName: "page-001.png",
  sha256: "hash",
  byteSize: 100,
  mimeType: "image/png",
  copiedAt: "2026-07-10T00:00:00.000Z"
};

const baseProps = {
  currentPage: 1,
  currentFilePath: null,
  image,
  onImportImages: vi.fn().mockResolvedValue(undefined),
  onInpaintImage: vi.fn().mockResolvedValue(false),
  onExtractSpeechBubbles: vi.fn().mockResolvedValue(undefined)
};

describe("PageImagePanel OCR highlight", () => {
  it("renders a normalized OCR bounding box over the page image", () => {
    render(
      <PageImagePanel
        {...baseProps}
        activeOcrBbox={{ x: 0.1, y: 0.2, width: 0.3, height: 0.12 }}
        stageHint="OCR 후보 #1"
      />
    );

    const overlay = screen.getByLabelText("선택된 OCR 영역");
    expect(overlay).toHaveStyle({ left: "10%", top: "20%", width: "30%", height: "12%" });
    expect(screen.getByText("OCR 후보 #1")).toBeInTheDocument();
  });

  it("omits the overlay when no OCR item is active", () => {
    render(<PageImagePanel {...baseProps} activeOcrBbox={null} />);
    expect(screen.queryByLabelText("선택된 OCR 영역")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/PageImagePanel.test.tsx
```

Expected: FAIL because `activeOcrBbox` and `stageHint` do not exist.

- [ ] **Step 3: Add the overlay props and image-relative wrapper**

Update imports and props:

```tsx
import type { Ref } from "react";
import type { NormalizedBbox } from "../../shared/speechBubbleExtraction";

type Props = {
  currentPage: number;
  currentFilePath: string | null;
  image: PageImage | null;
  activeOcrBbox?: NormalizedBbox | null;
  stageHint?: string;
  primaryActionRef?: Ref<HTMLButtonElement>;
  uploadDisabledReason?: string;
  onImportImages: () => Promise<void>;
  onInpaintImage: (args: {
    maskPngBase64: string;
    mode: InpaintingMode;
    provider: InpaintingProvider;
    promptOverride?: string;
  }) => Promise<boolean>;
  onExtractSpeechBubbles: () => Promise<void>;
  isInpainting?: boolean;
  isExtractingSpeechBubbles?: boolean;
  inpaintingOpen?: boolean;
  onInpaintingOpenChange?: (open: boolean) => void;
};
```

Destructure the three new props. Replace the image inside `.page-image-stage` with:

```tsx
<div className="page-image-media">
  <img
    alt={`${currentPage}페이지 이미지`}
    hidden={imageLoadFailed}
    key={image.storedRelativePath}
    className={imageFit === "actual" ? "actual-size" : undefined}
    src={resolvedImageSrc ?? image.storedRelativePath}
    onError={() => setImageLoadFailed(true)}
    onLoad={() => setImageLoadFailed(false)}
  />
  {activeOcrBbox && !imageLoadFailed ? (
    <div
      className="page-image-ocr-highlight"
      aria-label="선택된 OCR 영역"
      style={{
        left: `${activeOcrBbox.x * 100}%`,
        top: `${activeOcrBbox.y * 100}%`,
        width: `${activeOcrBbox.width * 100}%`,
        height: `${activeOcrBbox.height * 100}%`
      }}
    >
      {stageHint ? <span>{stageHint}</span> : null}
    </div>
  ) : null}
</div>
```

Attach `ref={primaryActionRef}` to the button in `.page-quick-action-strip`. This gives `App.tsx` a deterministic focus target after OCR review closes.

- [ ] **Step 4: Run the image tests and current renderer image tests**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/PageImagePanel.test.tsx tests/renderer/App.test.tsx
npm run typecheck
```

Expected: overlay tests PASS, existing image and inpainting App tests PASS, and typecheck exits with code 0.

- [ ] **Step 5: Commit the OCR highlight**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
git add src/renderer/components/PageImagePanel.tsx tests/renderer/PageImagePanel.test.tsx
git commit -m "feat: highlight active OCR region"
```

---

### Task 5: Integrate the Four-Stage Flow in `App.tsx`

**Files:**
- Modify: `src/renderer/App.tsx:1-955`
- Modify: `tests/renderer/App.test.tsx:135-974`

**Interfaces:**
- Consumes: workflow helpers from Task 1, stage-aware review from Task 2, `GuidedWorkPanel` from Task 3, and image overlay props from Task 4.
- Produces: deterministic OCR-to-speaker-to-translation transitions and `완료하고 다음 대사` behavior.

- [ ] **Step 1: Update the OCR integration test to require two explicit review stages**

Add this test helper after `openedProjectWithImages` in `tests/renderer/App.test.tsx`:

```tsx
function rendererLine(id: string, order: number, sourceText: string, pageNumber = 1): DialogueLine {
  return {
    id,
    order,
    pageNumber,
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText,
    lineStatus: "untranslated",
    parseConfidence: 0.95,
    parseWarnings: []
  };
}
```

In the existing test `runs speech bubble OCR through Gemini and GPT before applying reviewed lines`, replace the one-step review interaction with these assertions and actions:

```tsx
expect(await screen.findByLabelText("1페이지 말풍선 OCR 검토")).toBeInTheDocument();
expect(screen.getByText("OCR 확인", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
expect(screen.queryByLabelText("thought_bubble 1 화자")).not.toBeInTheDocument();
expect(screen.getByLabelText("thought_bubble 1 적용")).toBeChecked();
expect(screen.getByLabelText("filtered_speech 2 적용")).toBeChecked();
expect(screen.getByLabelText("narration_box 3 적용")).not.toBeChecked();

fireEvent.click(screen.getByLabelText("narration_box 3 적용"));
fireEvent.change(screen.getByLabelText("narration_box 3 원문"), { target: { value: "翌朝、駅で" } });
fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));

expect(screen.getByText("화자 확인", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
expect(screen.getByRole("button", { name: "Mika 82%" })).toBeInTheDocument();
fireEvent.click(screen.getByRole("button", { name: "Ren 61%" }));
fireEvent.change(screen.getByLabelText("filtered_speech 2 화자"), { target: { value: "Radio" } });
fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));

expect(await screen.findByText("번역 수정", { selector: "li strong" })).toBeInTheDocument();
expect(screen.getByText("번역 수정", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
expect(screen.getByLabelText("원문 2")).toHaveValue("考え中");
expect(screen.getByLabelText("원문 3")).toHaveValue("ザザ...聞こえる?");
expect(screen.getByLabelText("원문 4")).toHaveValue("翌朝、駅で");
```

Add a test for completion and advancement after the existing line-status tests:

```tsx
it("completes the selected translation and advances to the next actionable line", async () => {
  window.projectApi = {
    importTxtFile: vi.fn().mockResolvedValue({
      filePath: "C:\\input.txt",
      lines: [rendererLine("line-1", 1, "第一声"), rendererLine("line-2", 2, "第二声")]
    }),
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn()
  };

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "TXT 불러오기" }));
  expect(await screen.findByLabelText("사용자 수정문 1")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "첫 번째 번역" } });
  fireEvent.click(screen.getByRole("button", { name: "완료하고 다음 대사" }));

  expect(screen.getByText(/#2 ·/)).toBeInTheDocument();
  expect(screen.getByText("번역을 완료하고 다음 대사로 이동했습니다.")).toBeInTheDocument();
});
```

Add coverage for the completed-page action:

```tsx
it("offers the next page after the current page has no actionable line", async () => {
  const lines = [rendererLine("page-1-line", 1, "第一頁", 1), rendererLine("page-2-line", 2, "第二頁", 2)];
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProject: vi.fn().mockResolvedValue(
      openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })], lines)
    ),
    saveProject: vi.fn()
  };

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "열기" }));
  expect(await screen.findByText(/#1 ·/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "완료하고 다음 대사" }));

  expect(screen.getByText("완료", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
  fireEvent.click(screen.getByRole("button", { name: "다음 페이지로 이동" }));
  expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
});
```

Add coverage for contextual OCR retry:

```tsx
it("keeps the page image visible and offers retry after OCR failure", async () => {
  const extractSpeechBubbles = vi.fn().mockRejectedValue(new Error("OCR 서비스 응답 실패"));
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
    saveProject: vi.fn(),
    extractSpeechBubbles,
    validateSpeechBubbles: vi.fn()
  };

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "열기" }));
  expect(await screen.findByAltText("1페이지 이미지")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("OCR 서비스 응답 실패");
  expect(screen.getByAltText("1페이지 이미지")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "OCR 다시 실행" }));
  await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledTimes(2));
});
```

- [ ] **Step 2: Run the four focused App tests and verify the expected failures**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/App.test.tsx -t "runs speech bubble OCR through Gemini and GPT|completes the selected translation|offers the next page|offers retry after OCR failure"
```

Expected: FAIL because the guided stages and completion action are not integrated.

- [ ] **Step 3: Add workflow imports, state, and derived values**

At the top of `App.tsx`, import:

```tsx
import { GuidedWorkPanel } from "./components/GuidedWorkPanel";
import {
  getGuidedStage,
  getNextActionableLineId,
  type GuidanceDensity,
  type ReviewStage
} from "./guidedWorkflow";
```

Delete the `RightPanel` type and the derived `rightPanel` value. Add state beside the existing panel state:

```tsx
const [reviewStage, setReviewStage] = useState<ReviewStage>("ocr");
const [guidanceDensity, setGuidanceDensity] = useState<GuidanceDensity>("guided");
const [activeReviewItem, setActiveReviewItem] = useState<SpeechBubbleReviewItem | null>(null);
const [ocrError, setOcrError] = useState<string | null>(null);
const imagePrimaryActionRef = useRef<HTMLButtonElement>(null);
```

Derive the stage and summaries after `selectedLine`:

```tsx
const guidedStage = getGuidedStage({
  hasReview: Boolean(speechBubbleReview),
  reviewStage,
  hasSelectedLine: Boolean(selectedLine)
});

const guidedSummaries = {
  ocr: activeReviewItem?.text.trim() || selectedLine?.sourceText || "OCR 후보를 선택하세요.",
  speaker: activeReviewItem?.selectedSpeaker.trim() || selectedLine?.speaker || "화자를 확인하세요.",
  translation: selectedLine?.userTranslation?.trim() || selectedLine?.sourceText || "번역할 대사가 없습니다.",
  complete: `현재 페이지 완료 ${pageSummary.completeCount}개`
};
```

- [ ] **Step 4: Centralize OCR review reset and stage advancement**

Add these functions near the existing OCR handlers:

```tsx
function clearSpeechBubbleReview() {
  setSpeechBubbleReview(null);
  setReviewStage("ocr");
  setActiveReviewItem(null);
  setOcrError(null);
}

function advanceReviewToSpeaker(items: SpeechBubbleReviewItem[]) {
  if (items.length === 0) {
    setStatusMessage("화자를 확인할 OCR 텍스트가 없습니다.");
    return;
  }
  setReviewStage("speaker");
  setStatusMessage(`OCR 텍스트 ${items.length}개를 확인했습니다. 화자를 검토하세요.`);
}
```

Replace every direct `setSpeechBubbleReview(null)` used for page changes, OCR start, cancellation, and inpainting entry with `clearSpeechBubbleReview()`. After validated OCR succeeds, use this sequence so the page image gains space for active work:

```tsx
setReviewStage("ocr");
setActiveReviewItem(null);
setOcrError(null);
setSpeechBubbleReview(validatedExtraction);
setLeftPanel(null);
setBottomPanel("ocr-candidates");
```

After either project-open handler stores `result.project`, set the drawer from the loaded image state:

```tsx
setLeftPanel((result.project.pageImages?.length ?? 0) > 0 ? null : "pages");
```

Update `cancelSpeechBubbleReview`:

```tsx
function cancelSpeechBubbleReview() {
  clearSpeechBubbleReview();
  setOcrError(null);
  setBottomPanel("dialogue");
  setStatusMessage("말풍선 OCR 적용을 취소했습니다.");
  requestAnimationFrame(() => imagePrimaryActionRef.current?.focus());
}
```

At OCR start call `setOcrError(null)`. Replace the OCR catch block with:

```tsx
} catch (error) {
  const message = error instanceof Error ? error.message : "말풍선 OCR을 실행하지 못했습니다.";
  setOcrError(message);
  setStatusMessage(message);
} finally {
  setIsExtractingSpeechBubbles(false);
}
```

At the end of successful `applySpeechBubbleReview`, replace the direct review clear with:

```tsx
setSelectedLineId(newLines[0]?.id ?? selectedLineId);
clearSpeechBubbleReview();
setBottomPanel("dialogue");
setIsDirty(true);
setStatusMessage(`말풍선 OCR 결과 ${newLines.length}개를 현재 페이지에 추가했습니다. 번역을 수정하세요.`);
```

- [ ] **Step 5: Add deterministic complete-and-next behavior**

Add this function beside `updateSelectedLineStatus`:

```tsx
function completeSelectedLineAndMoveNext() {
  if (!selectedLineId) return;

  const updatedLines = project.dialogueLines.map((line) =>
    line.id === selectedLineId ? { ...line, lineStatus: "complete" as const } : line
  );
  const nextLineId = getNextActionableLineId(updatedLines, selectedLineId, currentPage);

  setIsDirty(true);
  setProject((current) => ({
    ...current,
    dialogueLines: current.dialogueLines.map((line) =>
      line.id === selectedLineId ? { ...line, lineStatus: "complete" } : line
    ),
    metadata: { ...current.metadata, updatedAt: new Date().toISOString() }
  }));

  if (nextLineId) {
    setSelectedLineId(nextLineId);
    setStatusMessage("번역을 완료하고 다음 대사로 이동했습니다.");
    return;
  }

  setSelectedLineId(null);
  setStatusMessage(
    currentPage < pageCount
      ? "현재 페이지의 번역 대사를 모두 확인했습니다. 다음 페이지로 이동할 수 있습니다."
      : "현재 프로젝트의 번역 대사를 모두 확인했습니다."
  );
}
```

- [ ] **Step 6: Connect the active OCR item to the image**

Add these props to `PageImagePanel`:

```tsx
activeOcrBbox={activeReviewItem?.bbox ?? null}
stageHint={activeReviewItem ? `OCR 후보 #${activeReviewItem.readingOrder}` : undefined}
primaryActionRef={imagePrimaryActionRef}
```

- [ ] **Step 7: Replace the right-inspector branches with the guided panel**

Keep the existing inpainting task panel for `workspaceMode === "inpainting"`. For all other states, render:

```tsx
<GuidedWorkPanel
  stage={guidedStage}
  density={guidanceDensity}
  summaries={guidedSummaries}
  onDensityChange={setGuidanceDensity}
>
  {ocrError ? (
    <div className="guided-task-error" role="alert">
      <strong>OCR을 완료하지 못했습니다.</strong>
      <p>{ocrError}</p>
      <button type="button" onClick={extractSpeechBubblesFromCurrentPage}>
        OCR 다시 실행
      </button>
    </div>
  ) : null}
  {speechBubbleReview ? (
    <SpeechBubbleReviewDialog
      currentPage={currentPage}
      result={speechBubbleReview}
      variant="panel"
      stage={reviewStage}
      submitLabel={reviewStage === "ocr" ? "OCR 적용 · 화자 확인" : "화자 적용 · 번역 수정"}
      onActiveItemChange={setActiveReviewItem}
      onBack={reviewStage === "speaker" ? () => setReviewStage("ocr") : undefined}
      onApply={reviewStage === "ocr" ? advanceReviewToSpeaker : applySpeechBubbleReview}
      onCancel={cancelSpeechBubbleReview}
    />
  ) : selectedLine ? (
    <>
      <LineDetailPanel
        line={selectedLine}
        onUpdateLine={updateLine}
        onDeleteLine={deleteSelectedLine}
        onMoveLine={moveSelectedLine}
        canMovePrevious={Boolean(selectedLineId && project.dialogueLines.findIndex((line) => line.id === selectedLineId) > 0)}
        canMoveNext={Boolean(
          selectedLineId &&
            project.dialogueLines.findIndex((line) => line.id === selectedLineId) >= 0 &&
            project.dialogueLines.findIndex((line) => line.id === selectedLineId) < project.dialogueLines.length - 1
        )}
      />
      <div className="guided-primary-action">
        <button type="button" className="primary-button" onClick={completeSelectedLineAndMoveNext}>
          완료하고 다음 대사
        </button>
      </div>
    </>
  ) : project.dialogueLines.length > 0 ? (
    <section className="panel-section guided-complete-state">
      <h2>현재 페이지 확인 완료</h2>
      <p>
        {currentPage < pageCount
          ? "다음 페이지로 이동해 작업을 계속하세요."
          : "현재 프로젝트의 번역 대사를 모두 확인했습니다."}
      </p>
      {currentPage < pageCount ? (
        <button type="button" className="primary-button" onClick={goToNextPage}>
          다음 페이지로 이동
        </button>
      ) : null}
    </section>
  ) : (
    <section className="panel-section inspector-empty-state">
      <h2>작업 준비</h2>
      <p>이미지를 연결하고 OCR을 실행하거나 기존 대사를 선택하세요.</p>
    </section>
  )}
</GuidedWorkPanel>
```

Set the root class from both collapsible surfaces:

```tsx
const frameClassName = [
  "app-frame",
  leftPanel ? "" : "left-drawer-collapsed",
  guidanceDensity === "compact" ? "guidance-compact" : ""
]
  .filter(Boolean)
  .join(" ");
```

Use `<div className={frameClassName}>` at the root.

- [ ] **Step 8: Run the guided workflow tests, full renderer tests, and typecheck**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/App.test.tsx tests/renderer/SpeechBubbleReviewDialog.test.tsx tests/renderer/GuidedWorkPanel.test.tsx tests/renderer/PageImagePanel.test.tsx tests/renderer/guidedWorkflow.test.ts
npm run typecheck
```

Expected: all renderer workflow tests PASS and typecheck exits with code 0.

- [ ] **Step 9: Commit the App integration**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
git add src/renderer/App.tsx tests/renderer/App.test.tsx
git commit -m "feat: guide OCR through translation completion"
```

---

### Task 6: Add the Three-Line Queue and Full-Table Toggle

**Files:**
- Modify: `src/renderer/components/DialogueTable.tsx:1-237`
- Modify: `src/renderer/App.tsx:25-951`
- Modify: `tests/renderer/App.test.tsx:330-2285`

**Interfaces:**
- Consumes: `getQueueWindow` from Task 1.
- Produces: `DialogueTable` prop `variant?: "queue" | "full"` and App state `dialogueView`.
- Preserves: all current search, filter, status summary, row selection, and inline editing behavior in full mode.

- [ ] **Step 1: Write the failing queue/full-table test**

Add to `tests/renderer/App.test.tsx` after `places dialogue lines in a collapsible bottom panel`:

```tsx
it("shows a three-line work queue by default and preserves the full dialogue table", async () => {
  window.projectApi = {
    importTxtFile: vi.fn().mockResolvedValue({
      filePath: "C:\\queue.txt",
      lines: [1, 2, 3, 4, 5].map((order) => rendererLine(`queue-${order}`, order, `대사 ${order}`))
    }),
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn()
  };

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "TXT 불러오기" }));
  expect(await screen.findByLabelText("사용자 수정문 1")).toBeInTheDocument();

  expect(screen.getByText("3개 대사 작업 큐")).toBeInTheDocument();
  expect(screen.queryByLabelText("대사 검색")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("사용자 수정문 4")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "전체 대사 보기" }));
  expect(screen.getByLabelText("대사 검색")).toBeInTheDocument();
  expect(screen.getByLabelText("사용자 수정문 5")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused queue test and verify the expected failure**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/App.test.tsx -t "shows a three-line work queue"
```

Expected: FAIL because queue mode and the full-table toggle do not exist.

- [ ] **Step 3: Add the `variant` prop and queue window to `DialogueTable`**

Import the helper:

```tsx
import { getQueueWindow } from "../guidedWorkflow";
```

Extend props and default the variant:

```tsx
type Props = {
  lines: DialogueLine[];
  allLines: DialogueLine[];
  currentPage: number;
  hasProjectLines: boolean;
  selectedLineId: string | null;
  variant?: "queue" | "full";
  onSelectLine: (id: string) => void;
  onUpdateLine: (line: DialogueLine) => void;
};

export function DialogueTable({
  lines,
  allLines,
  currentPage,
  hasProjectLines,
  selectedLineId,
  variant = "full",
  onSelectLine,
  onUpdateLine
}: Props) {
```

Keep the existing filters and compute the final display list:

```tsx
const displayLines = variant === "queue" ? getQueueWindow(visibleLines, selectedLineId, 3) : visibleLines;
```

Render the existing `.table-toolbar` only for `variant === "full"`. For queue mode render this concise heading:

```tsx
{variant === "queue" ? (
  <div className="dialogue-queue-heading">
    <strong>{displayLines.length}개 대사 작업 큐</strong>
    <span>선택한 대사와 가까운 작업만 표시합니다.</span>
  </div>
) : (
  <div className="table-toolbar">
    <div className="status-summary" aria-label="상태 요약">
      <strong>진행률 {statusSummary.progress}%</strong>
      <span>미번역 {statusSummary.untranslated}</span>
      <span>AI 초안 {statusSummary.draft}</span>
      <span>완료 {statusSummary.complete}</span>
      <span>검토필요 {statusSummary.review}</span>
    </div>
    <div className="table-filters" aria-describedby="table-filter-scope">
      <label>
        범위
        <select
          id="filter-scope"
          name="filter-scope"
          value={filterScope}
          onChange={(event) => setFilterScope(event.target.value as FilterScope)}
          aria-label="필터 범위"
        >
          <option value="current-page">현재 페이지</option>
          <option value="project">전체 프로젝트</option>
        </select>
      </label>
      <label>
        {filterScope === "project" ? "전체 프로젝트 검색" : "현재 페이지 검색"}
        <input
          id="dialogue-search"
          name="dialogue-search"
          type="search"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          aria-label="대사 검색"
        />
      </label>
      <label>
        {filterScope === "project" ? "전체 프로젝트 화자" : "현재 페이지 화자"}
        <input
          id="speaker-filter"
          name="speaker-filter"
          type="search"
          value={speakerFilter}
          onChange={(event) => setSpeakerFilter(event.target.value)}
          aria-label="화자 필터"
        />
      </label>
      <label>
        상태
        <select
          id="status-filter"
          name="status-filter"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          aria-label="상태 필터"
        >
          <option value="all">전체</option>
          <option value="untranslated">미번역</option>
          <option value="draft">AI 초안</option>
          <option value="complete">완료</option>
          <option value="review">검토필요</option>
        </select>
      </label>
      <label className="issue-filter">
        <input
          id="issues-only"
          name="issues-only"
          type="checkbox"
          checked={showIssuesOnly}
          onChange={(event) => setShowIssuesOnly(event.target.checked)}
          aria-label="문제 라인만 보기"
        />
        문제 라인만 보기
      </label>
    </div>
    <small id="table-filter-scope" className="filter-scope-note">
      {filterScope === "project"
        ? `전체 프로젝트 ${allLines.length}개 라인에서 검색합니다. 다른 페이지 라인을 선택하면 해당 페이지로 이동합니다.`
        : `필터는 현재 ${currentPage}페이지 ${lines.length}개 라인에만 적용됩니다. 전체 프로젝트 검색이 필요하면 범위를 바꾸세요.`}
    </small>
    <span>
      {scopedLines.length}개 중 {visibleLines.length}개 표시
    </span>
  </div>
)}
```

Map `displayLines` instead of `visibleLines`. Keep the existing empty-state checks against `scopedLines` and `visibleLines` so filter feedback remains correct in full mode.

- [ ] **Step 4: Add the App queue/full state and toggle**

Add state next to `bottomPanel`:

```tsx
const [dialogueView, setDialogueView] = useState<"queue" | "full">("queue");
```

Add this button to `.bottom-panel-tabs` when `bottomPanel === "dialogue"`:

```tsx
{bottomPanel === "dialogue" ? (
  <button
    type="button"
    aria-pressed={dialogueView === "full"}
    onClick={() => setDialogueView((current) => (current === "queue" ? "full" : "queue"))}
  >
    {dialogueView === "queue" ? "전체 대사 보기" : "작업 큐 보기"}
  </button>
) : null}
```

Pass `variant={dialogueView}` to `DialogueTable`.

- [ ] **Step 5: Preserve existing filter tests by explicitly opening the full table**

Add this helper near the test utilities in `tests/renderer/App.test.tsx`:

```tsx
function openFullDialogueTable() {
  const button = screen.queryByRole("button", { name: "전체 대사 보기" });
  if (button) fireEvent.click(button);
}
```

Call `openFullDialogueTable()` after data is loaded in these existing tests:

- `filters the dialogue table to parser warning and low confidence lines`
- `filters dialogue lines by search text and speaker`
- `searches the whole project and moves to the matched line page`
- `filters dialogue lines by workflow status`
- `summarizes workflow status counts and completion progress`

- [ ] **Step 6: Run the queue test, all renderer tests, and typecheck**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm test -- tests/renderer/App.test.tsx tests/renderer/guidedWorkflow.test.ts
npm run typecheck
```

Expected: queue/full-table test and all existing filter/status/search tests PASS; typecheck exits with code 0.

- [ ] **Step 7: Commit the queue presentation**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
git add src/renderer/components/DialogueTable.tsx src/renderer/App.tsx tests/renderer/App.test.tsx
git commit -m "feat: add compact dialogue work queue"
```

---

### Task 7: Apply the Selected Queue-Guided Layout and Verify the Product

**Files:**
- Modify: `src/renderer/styles.css:36-230`
- Modify: `src/renderer/styles.css:927-1289`
- Modify: `src/renderer/styles.css:1776-1905`
- Test: all renderer, main-process, storage, and shared tests

**Interfaces:**
- Consumes: class names from Tasks 2–6.
- Produces: the selected C visual direction, guided/compact widths, active OCR treatment, and desktop-safe responsive behavior.

- [ ] **Step 1: Run the complete automated baseline before CSS changes**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm run typecheck
npm test
```

Expected: typecheck exits with code 0 and the full suite PASSes.

- [ ] **Step 2: Replace the desktop grid widths and make collapsed surfaces free space**

Update the grid rules:

```css
.app-frame {
  display: grid;
  grid-template-columns: 52px 260px minmax(520px, 1fr) minmax(380px, 420px);
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-height: 100vh;
  background: var(--surface);
}

.app-frame.left-drawer-collapsed {
  grid-template-columns: 52px 0 minmax(520px, 1fr) minmax(380px, 420px);
}

.app-frame.guidance-compact {
  grid-template-columns: 52px 260px minmax(620px, 1fr) 260px;
}

.app-frame.left-drawer-collapsed.guidance-compact {
  grid-template-columns: 52px 0 minmax(620px, 1fr) 260px;
}

.left-drawer-collapsed .left-drawer {
  width: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
  visibility: hidden;
}
```

Keep `.bottom-line-panel` in grid column 3 so it remains directly below the image and queue.

- [ ] **Step 3: Style the guided work panel and its compact state**

Add:

```css
.right-inspector {
  overflow: hidden;
  padding: 0;
}

.guided-work-panel {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  background: var(--panel);
}

.guided-work-panel.compact {
  grid-template-columns: 58px minmax(0, 1fr);
}

.guided-work-header {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-muted);
}

.guided-work-header div {
  display: grid;
  gap: 2px;
}

.guided-work-header span {
  color: var(--ink-muted);
  font-size: 12px;
}

.guided-work-header button {
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  padding: 6px 8px;
  background: var(--panel);
  color: var(--ink);
  cursor: pointer;
}

.guided-stage-list {
  min-height: 0;
  display: grid;
  align-content: start;
  gap: 8px;
  margin: 0;
  padding: 10px 8px;
  border-right: 1px solid var(--line);
  list-style: none;
  background: var(--panel-muted);
}

.guided-stage-list li {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 6px;
  align-items: start;
  padding: 7px 6px;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--ink-muted);
}

.guided-stage-list li[data-state="current"] {
  border-color: var(--accent);
  background: #eff6ff;
  color: var(--accent-strong);
}

.guided-stage-list li[data-state="complete"] {
  color: var(--ink);
}

.guided-stage-number {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--panel);
  font-size: 12px;
}

.guided-stage-list strong,
.guided-stage-list small {
  display: block;
}

.guided-stage-list small {
  margin-top: 3px;
  color: var(--ink-muted);
  font-size: 11px;
  line-height: 1.3;
}

.guided-work-panel.compact .guided-stage-list li {
  grid-template-columns: 1fr;
  justify-items: center;
  padding-inline: 4px;
}

.guided-work-panel.compact .guided-stage-list li div {
  display: none;
}

.guided-work-content {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}

.guided-primary-action {
  position: sticky;
  bottom: 0;
  padding: 10px 0 0;
  background: var(--panel);
}

.guided-primary-action .primary-button {
  width: 100%;
  border: 1px solid var(--accent);
  border-radius: 6px;
  padding: 9px 12px;
  background: var(--accent);
  color: #ffffff;
  cursor: pointer;
}

.guided-task-error {
  display: grid;
  gap: 8px;
  margin-bottom: 10px;
  border: 1px solid #fecaca;
  border-radius: 7px;
  padding: 10px;
  background: #fef2f2;
  color: var(--danger);
}

.guided-task-error p,
.guided-complete-state p {
  margin: 0;
}

.guided-task-error button,
.guided-complete-state .primary-button {
  width: 100%;
  border: 1px solid var(--accent);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--accent);
  color: #ffffff;
  cursor: pointer;
}
```

- [ ] **Step 4: Style the stage-aware OCR review, image highlight, and queue**

Add:

```css
.speech-review-item.active {
  border-color: #8bb7ff;
  box-shadow: inset 3px 0 0 var(--accent);
}

.speech-review-actions > div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.page-image-media {
  position: relative;
  display: inline-block;
  max-width: 100%;
  max-height: 100%;
}

.page-image-ocr-highlight {
  position: absolute;
  z-index: 2;
  border: 2px solid #8bb7ff;
  background: rgba(31, 111, 235, 0.14);
  box-shadow: 0 0 0 2px rgba(16, 20, 24, 0.72);
  pointer-events: none;
}

.page-image-ocr-highlight span {
  position: absolute;
  left: 0;
  bottom: 100%;
  width: max-content;
  max-width: 180px;
  padding: 3px 6px;
  background: var(--accent);
  color: #ffffff;
  font-size: 11px;
}

.dialogue-queue-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  color: var(--ink-muted);
  font-size: 12px;
}

.dialogue-queue-heading strong {
  color: var(--ink);
}

.dialogue-table:has(.dialogue-queue-heading) .table-row {
  min-height: 68px;
}
```

- [ ] **Step 5: Replace the current 1180px stacking breakpoint with the 1100px product boundary**

Change `@media (max-width: 1180px)` to `@media (max-width: 1099px)` so the 1100px desktop target retains image and work panel side by side.

Add an overlay drawer rule for widths where a 260px drawer would squeeze the image:

```css
@media (min-width: 1100px) and (max-width: 1300px) {
  .app-frame:not(.left-drawer-collapsed) {
    grid-template-columns: 52px 0 minmax(520px, 1fr) minmax(360px, 400px);
  }

  .app-frame:not(.left-drawer-collapsed) .left-drawer {
    position: relative;
    z-index: 5;
    width: 260px;
    box-shadow: 12px 0 28px rgba(32, 36, 42, 0.18);
  }
}
```

Do not add a new mobile product mode. Keep the existing sub-760px fallback working for browser diagnostics.

- [ ] **Step 6: Run typecheck, full tests, and production build**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm run typecheck
npm test
npm run build
```

Expected: typecheck exits with code 0, all tests PASS, and Vite plus Electron TypeScript build complete without errors.

- [ ] **Step 7: Run real-image desktop visual validation**

Start the Electron development app from the implementation worktree and keep it running:

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm run dev:electron
```

Use a temporary non-secret QA project under `.superpowers\qa` and link `public\review-assets\page-001.png`. Validate these states at 1440x900, 1600x900, and 1920x1080:

1. OCR stage with a visible active bounding box.
2. Speaker stage with image still visible.
3. Translation stage with selected line and `완료하고 다음 대사` visible.
4. Compact guidance mode with a measurably wider image region.
5. Full dialogue table restored from `전체 대사 보기`.

For each viewport, inspect the app frame, image stage, guided panel, queue, and top actions for clipped controls or horizontal overflow. Confirm the Electron console and dev-server logs contain no new warning or error.

Save temporary evidence only under `.superpowers\qa`; do not add it to Git.

- [ ] **Step 8: Run the final verification commands after visual fixes**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
npm run typecheck
npm test
npm run build
git status --short
```

Expected: typecheck, full tests, and build succeed; Git status lists only intended source and test changes for this task before commit.

- [ ] **Step 9: Commit the final layout and verification fixes**

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
git add src/renderer/styles.css
git commit -m "feat: apply queue-guided workbench layout"
```

---

## Final Completion Checklist

- [ ] The page image remains visible in OCR, speaker, and translation stages.
- [ ] OCR text corrections persist into speaker application.
- [ ] Unknown or low-confidence speakers keep existing review warnings.
- [ ] `완료하고 다음 대사` completes the line and selects the next actionable line on the current page.
- [ ] The default bottom view shows at most three nearby lines.
- [ ] The full table restores search, speaker filter, status filter, issue filter, and progress summary.
- [ ] Guided and compact modes preserve the active item and stage.
- [ ] Existing OCR, inpainting, storage, save, export, keyboard, and unsaved-change behavior remains intact.
- [ ] 1440x900, 1600x900, and 1920x1080 have no blocking clipping or horizontal overflow with a real page image.
- [ ] No packages, lockfiles, schemas, IPC contracts, authentication, or deployment settings changed.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass from the implementation worktree.
