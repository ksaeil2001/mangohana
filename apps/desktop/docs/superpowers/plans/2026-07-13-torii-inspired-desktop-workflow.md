# Torii-Inspired Desktop Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows 데스크톱 번역 편집기의 최초 행동과 다음 작업을 명확히 하고, 구조 → 시각 → 동적 구현 → 최종 검증 순서로 디자인 품질을 A+ 목표 수준으로 높인다.

**Architecture:** 새 저장 방식이나 병렬 상태 시스템을 만들지 않는다. 기존 `App.tsx`의 `currentFilePath`, `project.dialogueLines`, `isDirty`, `selectedLine`, OCR 및 완료 이동 상태를 단일 진실 공급원으로 사용한다. 빈 프로젝트에서는 시작 패널을 표시하고, 작업이 시작되면 기존 이미지 canvas와 `StageEditor`를 그대로 사용한다.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Vitest 4, Testing Library, Electron 42, CSS

## Global Constraints

- 대상은 Windows 데스크톱 앱이며 스마트폰 전용 UI는 범위에서 제외한다.
- 프로젝트 저장 형식, IPC, OCR, 인페인팅, 캐릭터, 사용자 사전 및 내보내기 동작을 변경하지 않는다.
- 패키지, DB, 마이그레이션, 인증·보안 및 배포 설정을 변경하지 않는다.
- TXT import는 현재 메모리 프로젝트에 대사를 넣지만 자동 저장하지 않는다.
- 기존 기능을 삭제하지 않는다. 기능을 숨길 때도 접근 가능한 보조 경로를 유지한다.
- primary 버튼은 현재 작업 단계의 핵심 행동 하나에만 사용한다.
- 저장 필요 상태는 primary 버튼이 아니라 상단 상태 배지로 전달한다.
- 각 Phase의 검증 gate를 통과하기 전 다음 Phase로 이동하지 않는다.
- 기존 작업 트리의 `package-lock.json`, PNG 및 리뷰 산출물은 stage하거나 수정하지 않는다.
- 모든 PowerShell 명령은 프로젝트 루트에서 실행한다.

프로젝트 루트:

```text
C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기
```

---

## Primary Action Policy

| 상태 | Primary action | Secondary actions | 상태 표시 |
| --- | --- | --- | --- |
| 빈 프로젝트 | TXT 불러오기 | 새 프로젝트, 기존 프로젝트 열기 | 새 프로젝트 |
| TXT import 완료·미저장 | 완료하고 다음 대사 | 저장, 다른 이름 저장, 내보내기 | 저장 필요 |
| 저장된 프로젝트·이미지 없음 | 이미지 연결 | 파일 작업 | 저장됨 또는 변경 있음 |
| 이미지 있음·OCR 전 | OCR 검토 열기 | 인페인팅, 페이지 이동 | 현재 페이지 상태 |
| 번역 검토 중 | 완료하고 다음 대사 | 이전/다음 대사, 검토필요 | 진행 건수 |
| 현재 페이지 완료 | 남은 대사 또는 다음 페이지로 이동 | 프로젝트 검토 | 페이지 완료 |
| 프로젝트 완료 | TXT 내보내기 | 프로젝트 검토 | 전체 완료 |

규칙:

1. 상단의 `저장`은 primary 스타일을 사용하지 않는다.
2. `저장 필요` 배지는 눈에 띄되 번역 행동과 경쟁하지 않는다.
3. 프로젝트에 대사가 생기면 빈 시작 패널을 제거하고 기존 작업 공간으로 전환한다.
4. 완료할 대사가 있으면 `완료하고 다음 대사`가 가장 강한 행동이다.
5. 전체 대사가 완료된 뒤에만 `TXT 내보내기`가 primary가 된다.

---

## Existing Code to Reuse

| Existing code | Responsibility | Plan |
| --- | --- | --- |
| `App.tsx:replaceLines` | TXT 대사 교체, 첫 페이지/선택 갱신, dirty 처리 | 그대로 재사용 |
| `App.tsx:completeSelectedLineAndMoveNext` | 현재 대사 완료 및 다음 미완료 대사 이동 | 그대로 재사용 |
| `App.tsx:nextActionableProjectLine` | 프로젝트 전체의 다음 미완료 대사 탐색 | 그대로 재사용 |
| `App.tsx:saveProject/saveProjectAs` | 명시적 프로젝트 저장 | 그대로 재사용 |
| `App.tsx:exportTranslations` | TXT 내보내기 | 그대로 재사용 |
| `ImportPanel.tsx` | Electron TXT 파일 선택 | 호출 로직만 재사용 가능하게 추출 |
| `StageEditor.tsx` | OCR → 화자 → 번역 → 완료 단계 | 마크업과 강조만 보완 |
| `PageImagePanel.tsx` | 이미지, OCR, 인페인팅 및 canvas 상태 | 변경하지 않거나 props 연결만 유지 |

## NOT in Scope

- TXT import 직후 자동 저장 또는 자동 파일명 생성.
- 프로젝트 저장 스키마나 파일 확장자 변경.
- 새로운 AI 모델 또는 번역 API 추가.
- OCR/인페인팅 알고리즘 변경.
- 스마트폰 레이아웃과 모바일 내비게이션.
- 웹폰트 또는 UI 패키지 추가.
- 실행 취소 시스템, 자동 복구 및 최근 프로젝트 목록 추가.
- 전체 `App.tsx` 리팩터링.

---

# Phase 0 — 기준선과 안전 확인

**Purpose:** 변경 전 동작과 화면을 기록해 회귀 여부를 판단할 기준을 만든다.

### Task 0.1: 작업 트리와 기존 검증 상태 기록

**Files:** 변경 없음.

- [ ] 현재 작업 트리를 확인한다.

```powershell
git status --short
```

Expected: 기존 사용자 변경을 확인만 하고 정리·stash·commit하지 않는다.

- [ ] 관련 기존 테스트를 실행한다.

```powershell
npx vitest run tests/renderer/App.test.tsx tests/renderer/StageEditor.test.tsx tests/renderer/guidedWorkflow.test.ts
```

Expected: PASS. 실패하면 구현을 시작하지 않고 기존 실패 테스트명과 오류를 기록한다.

- [ ] 타입 검사를 실행한다.

```powershell
npm run typecheck
```

Expected: exit code 0.

### Task 0.2: 현재 디자인 기준선 기록

**Files:**
- Create during execution: `.gstack/design-reports/torii-workflow-baseline.md`
- Create during execution: `.gstack/design-reports/screenshots/`

기준 캡처:

- 1440×900 빈 프로젝트
- 1440×900 TXT가 로드된 번역 검토 상태
- 1920×1080 번역 검토 상태

기준 보고서에는 다음을 기록한다.

```markdown
# Torii Workflow Baseline

- Design score:
- AI slop score:
- Primary actions visible:
- Horizontal overflow:
- Keyboard inaccessible actions:
- High-impact findings:
```

Phase 0 gate:

- 기존 테스트와 typecheck가 통과한다.
- 세 기준 캡처가 존재한다.
- 기존 primary 버튼 수와 주요 디자인 문제를 기록했다.

---

# Phase 1 — 구조: 마크업 및 컴포넌트 구조화

**Purpose:** 기능과 스타일을 바꾸기 전에 빈 상태와 작업 상태의 DOM 구조, 컴포넌트 책임과 접근성을 확정한다.

## Target Structure

```text
FocusDeckShell
├─ TopAppBar
│  ├─ ProductIdentity
│  ├─ SaveState
│  ├─ ContextualFileActions
│  └─ PageNavigation
├─ ToolRail / ToolDrawer
├─ MainWorkspace
│  ├─ WorkspaceStartPanel   (빈 프로젝트만)
│  └─ PageImagePanel        (작업 상태만)
├─ RightInspector
│  └─ StageEditor
└─ BottomLinePanel
```

### Task 1.1: 빈 상태 판정 함수 작성

**Files:**
- Create: `src/renderer/workspacePresentation.ts`
- Create: `tests/renderer/workspacePresentation.test.ts`

**Interfaces:**

```ts
export type WorkspacePresentation = {
  showStartPanel: boolean;
  showSave: boolean;
  showSaveAs: boolean;
  showExport: boolean;
  saveLabel: "새 프로젝트" | "저장 필요" | "변경 있음" | "저장됨";
};

export function getWorkspacePresentation(args: {
  currentFilePath: string | null;
  lineCount: number;
  isDirty: boolean;
  apiReady: boolean;
}): WorkspacePresentation;
```

이 함수는 UI 노출 상태만 계산한다. primary action을 별도 상태로 저장하지 않는다.

- [ ] 실패하는 테스트를 작성한다.

```ts
import { describe, expect, it } from "vitest";
import { getWorkspacePresentation } from "../../src/renderer/workspacePresentation";

describe("getWorkspacePresentation", () => {
  it("shows the start panel for an empty unsaved project", () => {
    expect(getWorkspacePresentation({
      currentFilePath: null,
      lineCount: 0,
      isDirty: false,
      apiReady: true
    })).toEqual({
      showStartPanel: true,
      showSave: false,
      showSaveAs: false,
      showExport: false,
      saveLabel: "새 프로젝트"
    });
  });

  it("shows file actions and a save-needed badge after TXT import", () => {
    expect(getWorkspacePresentation({
      currentFilePath: null,
      lineCount: 2,
      isDirty: true,
      apiReady: true
    })).toEqual({
      showStartPanel: false,
      showSave: true,
      showSaveAs: true,
      showExport: true,
      saveLabel: "저장 필요"
    });
  });

  it("supports a saved project with zero dialogue lines", () => {
    expect(getWorkspacePresentation({
      currentFilePath: "C:\\work\\empty.ctp",
      lineCount: 0,
      isDirty: false,
      apiReady: true
    })).toEqual({
      showStartPanel: false,
      showSave: true,
      showSaveAs: true,
      showExport: false,
      saveLabel: "저장됨"
    });
  });

  it("hides Electron actions when the API is unavailable", () => {
    expect(getWorkspacePresentation({
      currentFilePath: null,
      lineCount: 2,
      isDirty: true,
      apiReady: false
    })).toMatchObject({
      showSave: false,
      showSaveAs: false,
      showExport: false
    });
  });
});
```

- [ ] 테스트가 실패하는지 확인한다.

```powershell
npx vitest run tests/renderer/workspacePresentation.test.ts
```

Expected: 모듈을 찾지 못해 FAIL.

- [ ] 최소 구현을 작성한다.

```ts
export type WorkspacePresentation = {
  showStartPanel: boolean;
  showSave: boolean;
  showSaveAs: boolean;
  showExport: boolean;
  saveLabel: "새 프로젝트" | "저장 필요" | "변경 있음" | "저장됨";
};

export function getWorkspacePresentation(args: {
  currentFilePath: string | null;
  lineCount: number;
  isDirty: boolean;
  apiReady: boolean;
}): WorkspacePresentation {
  const hasSavedFile = Boolean(args.currentFilePath);
  const hasLines = args.lineCount > 0;
  const showStartPanel = !hasSavedFile && !hasLines;

  return {
    showStartPanel,
    showSave: args.apiReady && (hasSavedFile || hasLines),
    showSaveAs: args.apiReady && (hasSavedFile || hasLines),
    showExport: args.apiReady && hasLines,
    saveLabel: showStartPanel
      ? "새 프로젝트"
      : !hasSavedFile
        ? "저장 필요"
        : args.isDirty
          ? "변경 있음"
          : "저장됨"
  };
}
```

- [ ] 테스트 통과를 확인한다.

```powershell
npx vitest run tests/renderer/workspacePresentation.test.ts
```

Expected: 4 tests PASS.

### Task 1.2: 시작 패널의 정적 마크업 작성

**Files:**
- Create: `src/renderer/components/WorkspaceStartPanel.tsx`
- Create: `tests/renderer/WorkspaceStartPanel.test.tsx`

**Interface:**

```ts
type WorkspaceStartPanelProps = {
  apiReady: boolean;
  onImportTxt: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
};
```

- [ ] 실패하는 컴포넌트 테스트를 작성한다.

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceStartPanel } from "../../src/renderer/components/WorkspaceStartPanel";

describe("WorkspaceStartPanel", () => {
  it("renders one primary action and two secondary actions", () => {
    const onImportTxt = vi.fn();
    const onNewProject = vi.fn();
    const onOpenProject = vi.fn();

    render(
      <WorkspaceStartPanel
        apiReady
        onImportTxt={onImportTxt}
        onNewProject={onNewProject}
        onOpenProject={onOpenProject}
      />
    );

    expect(screen.getByRole("heading", {
      name: "번역할 TXT 파일을 불러오세요"
    })).toBeInTheDocument();

    const importButton = screen.getByRole("button", { name: "TXT 불러오기" });
    expect(importButton).toHaveClass("primary-button");
    expect(screen.getByRole("button", { name: "새 프로젝트" }))
      .not.toHaveClass("primary-button");
    expect(screen.getByRole("button", { name: "기존 프로젝트 열기" }))
      .not.toHaveClass("primary-button");

    fireEvent.click(importButton);
    expect(onImportTxt).toHaveBeenCalledOnce();
  });

  it("disables Electron file actions when the API is unavailable", () => {
    render(
      <WorkspaceStartPanel
        apiReady={false}
        onImportTxt={vi.fn()}
        onNewProject={vi.fn()}
        onOpenProject={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "TXT 불러오기" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "기존 프로젝트 열기" }))
      .toBeDisabled();
  });
});
```

- [ ] 테스트 실패를 확인한다.

```powershell
npx vitest run tests/renderer/WorkspaceStartPanel.test.tsx
```

Expected: 컴포넌트를 찾지 못해 FAIL.

- [ ] 정적 마크업을 작성한다.

```tsx
type WorkspaceStartPanelProps = {
  apiReady: boolean;
  onImportTxt: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
};

export function WorkspaceStartPanel(props: WorkspaceStartPanelProps) {
  return (
    <section className="workspace-start-panel"
      aria-labelledby="workspace-start-heading">
      <p className="workspace-start-eyebrow">
        TXT 불러오기 → 번역 검토 → 내보내기
      </p>
      <h2 id="workspace-start-heading">번역할 TXT 파일을 불러오세요</h2>
      <p>파일을 불러오면 현재 프로젝트에서 바로 대사를 검토할 수 있습니다.</p>
      <button type="button"
        className="primary-button workspace-start-primary"
        onClick={props.onImportTxt}
        disabled={!props.apiReady}>
        TXT 불러오기
      </button>
      <div className="workspace-start-secondary" aria-label="다른 시작 방법">
        <button type="button" onClick={props.onNewProject}>
          새 프로젝트
        </button>
        <button type="button" onClick={props.onOpenProject}
          disabled={!props.apiReady}>
          기존 프로젝트 열기
        </button>
      </div>
    </section>
  );
}
```

- [ ] 컴포넌트 테스트 통과를 확인한다.

```powershell
npx vitest run tests/renderer/WorkspaceStartPanel.test.tsx
```

Expected: 2 tests PASS.

### Task 1.3: App의 빈 상태와 작업 상태 구조 분기

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `tests/renderer/App.test.tsx`

- [ ] App 구조 테스트를 추가한다.

검증 항목:

- 초기 상태에 `WorkspaceStartPanel`이 존재한다.
- 초기 상태에 `PageImagePanel`의 canvas empty state가 동시에 존재하지 않는다.
- 저장된 빈 프로젝트를 열면 시작 패널이 아니라 작업 canvas가 보인다.
- 시작 패널의 버튼 이름이 접근성 트리에서 식별된다.
- TopAppBar → MainWorkspace → RightInspector → BottomLinePanel landmark가 유지된다.

- [ ] `App.tsx`에서 presentation을 계산한다.

```ts
const workspacePresentation = getWorkspacePresentation({
  currentFilePath,
  lineCount: project.dialogueLines.length,
  isDirty,
  apiReady
});
```

- [ ] canvas slot을 조건부 렌더링한다.

```tsx
{workspacePresentation.showStartPanel ? (
  <WorkspaceStartPanel
    apiReady={apiReady}
    onImportTxt={() => undefined}
    onNewProject={newProject}
    onOpenProject={() => void openProjectFromFileDialog()}
  />
) : (
  <PageImagePanel
    currentPage={currentPage}
    currentFilePath={currentFilePath}
    image={currentPageImage}
    imageFit={workspaceZoom === 1 ? "fit" : "actual"}
    onImageFitChange={(fit) => setWorkspaceZoom(fit === "fit" ? 1 : 2)}
    uploadDisabledReason={imageImportDisabledReason}
    onImportImages={importPageImages}
    onInpaintImage={inpaintCurrentPageImage}
    onExtractSpeechBubbles={extractSpeechBubblesFromCurrentPage}
    isInpainting={isInpainting}
    isExtractingSpeechBubbles={isExtractingSpeechBubbles}
    activeOcrBbox={activeReviewItem?.bbox ?? null}
    stageHint={activeReviewItem ? `OCR 후보 #${activeReviewItem.readingOrder}` : undefined}
    primaryActionRef={imagePrimaryActionRef}
    inpaintingOpen={inpaintingEditorOpen}
    onInpaintingOpenChange={(open) => {
      setInpaintingEditorOpen(open);
      if (open) clearSpeechBubbleReview();
    }}
  />
)}
```

Phase 1에서는 `onImportTxt`를 실제 IPC에 연결하지 않는다. Task 3.1에서 연결한다. `PageImagePanel`에는 현재 사용 중인 props를 그대로 전달해 OCR·인페인팅 동작을 보존한다.

- [ ] 구조 테스트를 실행한다.

```powershell
npx vitest run tests/renderer/workspacePresentation.test.ts tests/renderer/WorkspaceStartPanel.test.tsx tests/renderer/App.test.tsx
```

Expected: PASS.

Phase 1 gate:

- 빈 상태와 작업 canvas가 동시에 렌더링되지 않는다.
- heading 순서가 `h1 → h2`다.
- 버튼 이름과 landmark가 접근성 트리에 존재한다.
- 기존 App 테스트가 통과한다.
- 기능 핸들러, 저장 정책 및 CSS 디자인은 변경하지 않았다.

Phase 1 commit:

```powershell
git add src/renderer/workspacePresentation.ts src/renderer/components/WorkspaceStartPanel.tsx src/renderer/App.tsx tests/renderer/workspacePresentation.test.ts tests/renderer/WorkspaceStartPanel.test.tsx tests/renderer/App.test.tsx
git commit -m "feat: structure the contextual desktop entry"
```

---

# Phase 2 — 시각: CSS 디자인 시스템과 A+ 목표 품질

**Purpose:** 승인된 구조에 시각 계층, 간격, 대비, 상태 표현을 적용한다. 기능 핸들러는 변경하지 않는다.

### Task 2.1: 기존 CSS 토큰과 반복값 조사

**Files:** 변경 전 조사만 수행.

```powershell
rg -n -- "--[a-zA-Z0-9-]+:|#[0-9a-fA-F]{3,8}|rgb\(" src/renderer/styles.css
rg -n "primary-button|secondary-button|top-save-state|guided-primary-action|workspace-main|right-inspector" src/renderer/styles.css
```

조사 결과를 Phase 0 기준 보고서에 추가한다.

- 기존 surface, text, border, accent 토큰
- 의미가 같은 중복 색상
- 버튼별 높이, radius, border 차이
- body 및 보조 텍스트 크기
- focus-visible 누락

새 hex 값은 기존 값이 대비 기준을 만족하지 않을 때만 도입한다.

### Task 2.2: 시작 패널과 상단 상태 스타일링

**Files:**
- Modify: `src/renderer/styles.css`

필수 결과:

- 시작 패널은 canvas 중앙에 위치하지만 마케팅 hero처럼 과장되지 않는다.
- `TXT 불러오기`만 primary 색상을 사용한다.
- 새 프로젝트와 기존 프로젝트 열기는 중립 버튼이다.
- 저장 상태 배지는 작고 명확하며 번역 작업과 경쟁하지 않는다.
- 빈 프로젝트에서 사용할 수 없는 파일 작업은 흐린 버튼으로 남기지 않는다.

권장 구조 값:

```css
.workspace-start-panel {
  align-self: center;
  justify-self: center;
  width: min(560px, calc(100% - 64px));
  padding: 48px;
  text-align: left;
}

.workspace-start-primary {
  min-width: 220px;
  min-height: 44px;
  margin-top: 20px;
}

.workspace-start-secondary {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}
```

실제 색상, background 및 border는 Task 2.1에서 확인한 기존 토큰을 사용한다.

### Task 2.3: 번역 단계의 primary action 스타일 통일

**Files:**
- Modify: `src/renderer/components/StageEditor.tsx`
- Modify: `src/renderer/styles.css`
- Modify: `tests/renderer/StageEditor.test.tsx`

번역 단계:

```tsx
<div className="guided-primary-action">
  <button type="button" className="primary-button"
    disabled={props.busy}
    onClick={props.onApproveTranslation}>
    완료하고 다음 대사
  </button>
  <span className="keyboard-hint" aria-label="단축키 Ctrl+Enter">
    <kbd>Ctrl</kbd>+<kbd>Enter</kbd>
  </span>
</div>
```

완료 단계:

- 남은 대사가 있으면 이동 버튼만 primary.
- 모든 대사가 완료되면 `번역 내보내기`만 primary.
- `프로젝트 검토`는 secondary.

스타일 요구:

- primary 버튼 높이 44px 이상.
- sticky action이 inspector 내용을 가리지 않는다.
- disabled는 클릭 불가능함이 명확하지만 본문 대비를 해치지 않는다.
- `focus-visible`이 hover와 구분된다.

### Task 2.4: A+ 목표 시각 검증

**Design quality gate:**

| Category | Pass condition |
| --- | --- |
| Visual hierarchy | 첫 3초 안에 현재 작업, 작업 대상, 다음 행동을 식별 |
| Primary action | 화면에 primary 버튼 1개 |
| Typography | 본문 16px 이상, 보조 문구 판독 가능 |
| Contrast | 본문 4.5:1 이상, 큰 텍스트·focus indicator 3:1 이상 |
| Controls | primary 높이 44px 이상, hover/focus/active/disabled 구분 |
| Spacing | 기존 4px/8px 계열 리듬으로 통일 |
| Density | 이미지와 번역 본문이 파일 관리보다 강함 |
| Consistency | 버튼, border, radius, heading 규칙 일관 |
| AI slop | gradient hero, 장식 카드 grid, 과도한 radius 없음 |
| Desktop fit | 핵심 화면에서 앱 전체 가로 스크롤 없음 |

필수 캡처:

```text
.gstack/design-reports/torii-workflow-phase2/
├─ empty-1440x900.png
├─ imported-unsaved-1440x900.png
├─ translation-1440x900.png
├─ ocr-error-1440x900.png
├─ complete-1440x900.png
└─ translation-1920x1080.png
```

Windows 검증:

- 1280×720 최소 창 크기
- 1440×900 표준
- 1920×1080 넓은 화면
- Windows 배율 100%, 125%, 150%
- 브라우저 테스트 모드 200% 확대는 보조 검증

이 계획에서 A+는 별도 문자 등급을 임의로 만드는 뜻이 아니라, 아래 정량 gate를 전부 통과한 A 등급 상단의 완성도를 의미한다.

Phase 2 gate:

- Design Score A 이상.
- AI Slop Score A 이상.
- Critical 및 High-impact finding 0개.
- 대비 실패 0개.
- 키보드로 접근할 수 없는 행동 0개.
- 앱 전체 가로 overflow 0개.
- 위 10개 category 모두 PASS.

Phase 2 commit:

```powershell
git add src/renderer/components/StageEditor.tsx src/renderer/styles.css tests/renderer/StageEditor.test.tsx
git commit -m "style: establish the contextual desktop hierarchy"
```

---

# Phase 3 — 동적: 기능과 인터랙션 연결

**Purpose:** 승인된 구조와 스타일에 기존 핸들러를 연결하고 모든 경계 상태를 검증한다.

### Task 3.1: TXT import를 시작 패널에 연결

**Files:**
- Modify: `src/renderer/components/ImportPanel.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `tests/renderer/App.test.tsx`

**Interface:**

```ts
export async function importTxtLines(args: {
  onImported: (lines: DialogueLine[]) => void;
  onCanceled: () => void;
}): Promise<void>;
```

구현:

```ts
export async function importTxtLines(args: {
  onImported: (lines: DialogueLine[]) => void;
  onCanceled: () => void;
}) {
  const result = await window.projectApi?.importTxtFile();
  if (!result) {
    args.onCanceled();
    return;
  }
  args.onImported(result.lines);
}
```

App 연결:

```ts
async function importTxt() {
  await importTxtLines({
    onImported: replaceLines,
    onCanceled: () => setStatusMessage("TXT 불러오기를 취소했습니다.")
  });
}
```

```tsx
<WorkspaceStartPanel
  apiReady={apiReady}
  onImportTxt={() => void importTxt()}
  onNewProject={newProject}
  onOpenProject={() => void openProjectFromFileDialog()}
/>
```

테스트 항목:

- import 성공 후 시작 패널이 사라진다.
- 첫 미완료 대사가 선택된다.
- import 취소 후 현재 프로젝트가 유지된다.
- Electron API가 없으면 import 버튼이 disabled다.
- 빈 배열 import 결과가 오더라도 crash하지 않고 빈 상태를 유지한다.
- import 버튼을 연속 클릭해도 두 dialog가 열리지 않도록 local busy 상태 또는 App의 import guard를 둔다.
- import 중 버튼에 `aria-busy="true"`와 disabled가 적용된다.

연속 클릭 처리는 다음 상태로 구현한다.

```ts
const [isImportingTxt, setIsImportingTxt] = useState(false);

async function importTxt() {
  if (isImportingTxt) return;
  setIsImportingTxt(true);
  try {
    await importTxtLines({
      onImported: replaceLines,
      onCanceled: () => setStatusMessage("TXT 불러오기를 취소했습니다.")
    });
  } finally {
    setIsImportingTxt(false);
  }
}
```

이에 맞춰 `WorkspaceStartPanelProps`에 `isImportingTxt: boolean`을 추가하고 버튼의 disabled 및 `aria-busy`에 반영한다.

### Task 3.2: 파일 작업 조건부 노출과 저장 상태 통합

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/ProjectActionsPanel.tsx`
- Modify: `tests/renderer/App.test.tsx`

상단 마크업:

```tsx
<span className={isDirty ? "top-save-state dirty" : "top-save-state"}>
  {workspacePresentation.saveLabel}
</span>

<div className="top-file-actions" role="group" aria-label="파일 작업">
  <button type="button" onClick={openProjectFromFileDialog}
    disabled={!apiReady}>열기</button>
  {workspacePresentation.showSave
    ? <button type="button" onClick={saveProject}>저장</button>
    : null}
  {workspacePresentation.showSaveAs
    ? <button type="button" aria-label="다른 이름 저장"
        onClick={saveProjectAs}>다른 이름</button>
    : null}
  {workspacePresentation.showExport
    ? <button type="button" aria-label="TXT 내보내기"
        onClick={exportTranslations}>내보내기</button>
    : null}
</div>
```

규칙:

- 상단 저장 버튼은 primary class를 사용하지 않는다.
- 스크린리더용 `statusMessage` announcer는 유지한다.
- `ProjectActionsPanel`의 중복 일반 상태 문구는 제거한다.
- API Key 저장 결과처럼 설정 패널에서만 의미 있는 피드백은 유지한다.
- 저장 실패 후 `isDirty`가 true로 유지되고 오류가 status announcer에 전달되는지 테스트한다.

테스트 항목:

- 빈 프로젝트에 저장·다른 이름·내보내기가 없다.
- TXT import 후 저장·다른 이름·내보내기가 나타난다.
- 저장된 빈 프로젝트에는 저장·다른 이름이 있지만 내보내기는 없다.
- 저장 후 배지가 `저장됨`으로 바뀐다.
- 수정 후 `변경 있음`으로 바뀐다.
- 저장 실패 후 `변경 있음`을 유지한다.
- 긴 Windows 경로는 잘리지만 전체 레이아웃을 넓히지 않는다.

### Task 3.3: 다음 번역 행동과 최종 내보내기 검증

**Files:**
- Modify: `src/renderer/components/StageEditor.tsx`
- Modify: `tests/renderer/StageEditor.test.tsx`
- Modify: `tests/renderer/App.test.tsx`

기존 함수를 그대로 사용한다.

- `completeSelectedLineAndMoveNext`
- `goToRemainingActionableLine`
- `getNextActionableLineId`
- `nextActionableProjectLine`
- `exportTranslations`

필수 테스트:

1. `완료하고 다음 대사` 클릭 시 현재 대사가 complete가 된다.
2. 같은 페이지의 다음 미완료 대사가 선택된다.
3. 현재 페이지가 끝나면 다른 페이지의 미완료 대사 이동 버튼이 나타난다.
4. 이전 페이지에 미완료 대사가 남아 있어도 프로젝트 완료로 잘못 표시하지 않는다.
5. 모든 대사가 완료되면 `TXT 내보내기`만 primary다.
6. `Ctrl+Enter`는 textarea, input, select 안에서 실행되지 않는다.
7. `Ctrl+Enter`와 버튼 클릭 결과가 동일하다.
8. 완료된 대사만 있는 프로젝트를 열면 완료 화면이 나타난다.
9. 긴 번역문에서도 sticky action이 본문을 가리지 않는다.
10. 화면 전체에서 primary 버튼이 둘 이상 존재하지 않는다.

관련 테스트 실행:

```powershell
npx vitest run tests/renderer/StageEditor.test.tsx tests/renderer/App.test.tsx tests/renderer/guidedWorkflow.test.ts
```

Expected: PASS.

Phase 3 gate:

- Primary Action Policy의 모든 상태를 자동 또는 수동 검증했다.
- import 취소·빈 결과·연속 클릭·저장 실패를 검증했다.
- editable field에서 전역 단축키가 실행되지 않는다.
- 기존 OCR, 인페인팅, 캐릭터 및 사전 테스트가 통과한다.

Phase 3 commit:

```powershell
git add src/renderer/components/ImportPanel.tsx src/renderer/components/WorkspaceStartPanel.tsx src/renderer/components/ProjectActionsPanel.tsx src/renderer/components/StageEditor.tsx src/renderer/App.tsx tests/renderer/WorkspaceStartPanel.test.tsx tests/renderer/StageEditor.test.tsx tests/renderer/App.test.tsx
git commit -m "feat: connect the contextual translation workflow"
```

---

# Phase 4 — 최종 회귀 및 디자인 검증

### Task 4.1: 전체 자동 검증

```powershell
npm run typecheck
npm test
npm run build
```

Expected: 모두 exit code 0.

빌드 결과물인 `dist-renderer`와 `dist-electron`은 직접 수정하거나 stage하지 않는다.

### Task 4.2: Windows Electron 전체 흐름 검증

```powershell
npm run dev:electron
```

검증 순서:

1. 빈 프로젝트에서 `TXT 불러오기`만 primary인지 확인.
2. TXT dialog 취소 후 화면과 프로젝트가 유지되는지 확인.
3. TXT import 후 첫 미완료 대사가 선택되는지 확인.
4. `저장 필요` 배지와 secondary 저장 버튼 확인.
5. 프로젝트 저장 후 `저장됨` 확인.
6. 이미지 연결과 OCR 실행.
7. OCR 실패 시 retry가 가능하고 이미지가 유지되는지 확인.
8. 번역 수정 후 `완료하고 다음 대사` 실행.
9. 현재 페이지 종료 후 다른 페이지 남은 대사로 이동.
10. 전체 완료 후 `TXT 내보내기`가 primary로 바뀌는지 확인.
11. OCR, 인페인팅, 캐릭터, 사용자 사전 동작 확인.
12. 1280×720, 1440×900, 1920×1080에서 overflow 확인.
13. Windows 100%, 125%, 150% 배율에서 잘림 확인.

### Task 4.3: 최종 A+ 목표 디자인 재평가

최종 보고서:

```text
.gstack/design-reports/torii-workflow-final/
├─ design-audit.md
├─ design-baseline.json
└─ screenshots/
   ├─ empty-1440x900.png
   ├─ imported-unsaved-1440x900.png
   ├─ translation-1440x900.png
   ├─ ocr-error-1440x900.png
   ├─ complete-1440x900.png
   └─ translation-1920x1080.png
```

최종 합격 조건:

- Design Score A 이상.
- AI Slop Score A 이상.
- Critical/High finding 0개.
- Phase 0보다 category grade 하락 없음.
- Primary Action Policy 위반 0개.
- 가로 overflow 0개.
- 키보드 접근 불가 행동 0개.
- 자동 검증 3종 통과.

### Task 4.4: 디자인 결정 문서화

**Files:**
- Modify: `DESIGN.md`

Decisions Log에 다음을 추가한다.

```markdown
| 2026-07-13 | Apply Torii's contextual-action principle to desktop entry | One primary action is shown for the current work state. |
| 2026-07-13 | Keep save secondary during translation | Save state is communicated by a badge so it does not compete with completing the current line. |
| 2026-07-13 | Keep TXT import and project save separate | Import updates the in-memory project; explicit save preserves existing storage behavior. |
| 2026-07-13 | Exclude smartphone-specific layout work | The target is a Windows desktop workbench. |
```

완료된 roadmap 항목은 삭제하지 않고 `Implemented`로 표시한다.

커밋:

```powershell
git add DESIGN.md
git commit -m "docs: record the contextual desktop workflow"
```

---

## Test Coverage Map

```text
Workspace presentation
├─ empty + unsaved                    [unit]
├─ imported + unsaved                 [unit]
├─ saved + empty                      [unit]
└─ API unavailable                    [unit]

TXT entry flow
├─ successful import                  [App integration]
├─ canceled import                    [App integration]
├─ empty import result                [App integration]
├─ rapid double click                 [App integration]
└─ API unavailable                    [component + App]

File action visibility
├─ empty project                      [App integration]
├─ imported unsaved                   [App integration]
├─ saved empty                        [App integration]
├─ saved clean                        [existing + regression]
├─ edited dirty                       [existing + regression]
└─ save failure                       [App integration]

Translation progression
├─ complete current line              [existing + regression]
├─ next line on same page             [existing + regression]
├─ next incomplete page               [existing + regression]
├─ earlier page still incomplete      [existing + regression]
├─ project complete                   [existing + regression]
├─ Ctrl+Enter outside editor          [existing + regression]
└─ Ctrl+Enter inside editable field   [existing + regression]

Visual states
├─ empty                              [design screenshot]
├─ imported unsaved                   [design screenshot]
├─ translation                        [design screenshot]
├─ OCR error                          [design screenshot]
└─ complete                           [design screenshot]
```

## Failure Modes

| Failure | Protection | Test | User experience |
| --- | --- | --- | --- |
| TXT dialog canceled | 현재 프로젝트를 변경하지 않음 | App integration | 취소 상태 안내 |
| TXT import double click | `isImportingTxt` guard | App integration | 버튼 disabled/busy |
| TXT returns zero lines | 빈 상태 유지 | App integration | 파일에 대사가 없음을 안내 |
| Electron API unavailable | 버튼 disabled | unit + component | 기능을 실행할 수 없음이 명확 |
| Save rejected | dirty 유지 | App integration | 오류 안내 후 재시도 가능 |
| Long file path | ellipsis/overflow containment | visual | 작업 영역 폭 유지 |
| Long translation | inspector scroll + sticky action | visual + component | 버튼이 본문을 가리지 않음 |
| Earlier page incomplete | project-wide next line lookup | existing regression | 완료 오판 없음 |
| OCR failure | 기존 retry와 image retention | existing regression | 이미지 유지, 재시도 가능 |

## Sequential Execution

모든 Phase가 `App.tsx`, renderer components 및 `styles.css`를 공유하므로 병렬 worktree 실행은 권장하지 않는다.

```text
Phase 0 baseline
  ↓
Phase 1 structure
  ↓
Phase 2 visual
  ↓
Phase 3 interactions
  ↓
Phase 4 final verification
```

## Final Acceptance Checklist

- [ ] Phase 0 기준선 테스트와 캡처 완료.
- [ ] 빈 프로젝트에서 `TXT 불러오기`만 primary.
- [ ] TXT import 후 저장은 secondary이고 `저장 필요` 배지가 표시됨.
- [ ] 번역 중 `완료하고 다음 대사`만 primary.
- [ ] 프로젝트 완료 후 `TXT 내보내기`만 primary.
- [ ] 저장·다른 이름·내보내기는 사용할 수 있을 때만 표시.
- [ ] import 취소·빈 결과·연속 클릭·API unavailable 처리 완료.
- [ ] 저장 실패 후 dirty 상태와 사용자 데이터 유지.
- [ ] 저장된 빈 프로젝트가 시작 화면으로 잘못 돌아가지 않음.
- [ ] 기존 OCR, 인페인팅, 캐릭터 및 사용자 사전 기능 유지.
- [ ] 본문 대비 4.5:1, focus indicator 3:1 목표 충족.
- [ ] primary control 높이 44px 이상.
- [ ] 1280×720, 1440×900, 1920×1080 가로 overflow 없음.
- [ ] Windows 배율 100%, 125%, 150% 검증.
- [ ] Design Score A 이상, AI Slop Score A 이상이며 A+ 정량 gate를 모두 충족.
- [ ] Critical/High design finding 0개.
- [ ] `npm run typecheck`, `npm test`, `npm run build` 통과.
- [ ] 계획 범위 밖 사용자 파일과 빌드 결과물을 stage하지 않음.

## Self-Review Result

- Phase와 Task 순서를 완전히 일치시켰다.
- 저장과 번역 완료가 primary 자리를 경쟁하지 않도록 정책을 확정했다.
- 기존 코드의 import, 저장, OCR, 완료 이동 및 내보내기 흐름을 재사용한다.
- 저장된 빈 프로젝트, API unavailable, 빈 import, 연속 클릭 및 저장 실패를 테스트 범위에 포함했다.
- A+ 목표 디자인 기준을 캡처, 점수, finding과 해상도 gate로 측정 가능하게 만들었다.
- 모바일, 저장 스키마, 신규 패키지와 대규모 리팩터링을 명시적으로 제외했다.
