# Empty Workspace Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대사가 0개인 모든 상태에서는 시작 행동만 표시하고, TXT를 불러온 뒤에는 현재 작업 단계의 다음 행동 하나만 시각적으로 강조한다.

**Architecture:** `getWorkspacePresentation`을 빈 상태와 영역 표시 정책의 단일 기준으로 확장한다. `App.tsx`와 `FocusDeckShell`은 이 모델을 소비해 페이지 제어, 작업 레일, 검사 영역, 하단 패널을 DOM에서 제거하거나 복원하며 기존 IPC와 작업 핸들러는 유지한다.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Vite, Electron renderer

## Global Constraints

- Windows 데스크톱만 대상으로 하며 모바일 전용 변경은 하지 않는다.
- 빈 상태는 저장 경로나 프로젝트 종류와 무관하게 정확히 `lineCount === 0`이다.
- 프로젝트 저장 형식, IPC, OCR·인페인팅 API와 기존 핸들러 동작을 변경하지 않는다.
- 새 패키지, 스키마 변경, 마이그레이션, 파일 삭제를 추가하지 않는다.
- 숨기는 영역은 CSS로 가리지 않고 DOM에서 렌더링하지 않는다.
- 빈 상태 설명은 `WorkspaceStartPanel` 한곳에만 둔다.
- 한 작업 단계에서 `.primary-button`으로 강조하는 다음 행동은 하나만 둔다.
- 모든 PowerShell 명령은 다음 폴더에서 실행한다.

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기"
```

---

## File Structure

| 파일 | 책임 |
| --- | --- |
| `src/renderer/workspacePresentation.ts` | 빈 상태와 영역 표시 정책 계산 |
| `src/renderer/App.tsx` | 표시 정책을 실제 앱 영역에 연결 |
| `src/renderer/components/FocusDeckShell.tsx` | 빈 상태에서 작업 크롬 생략 |
| `src/renderer/components/WorkspaceStartPanel.tsx` | 통합 시작 안내와 행동 제공 |
| `src/renderer/components/StageEditor.tsx` | 단계별 단일 주요 CTA 제공 |
| `src/renderer/styles.css` | 빈 상태 데스크톱 레이아웃 |
| `tests/renderer/workspacePresentation.test.ts` | 표시 정책 단위 테스트 |
| `tests/renderer/App.test.tsx` | 빈 상태와 작업 상태 전환 통합 테스트 |
| `tests/renderer/StageEditor.test.tsx` | 단계별 단일 CTA 테스트 |

---

### Task 1: 빈 상태 표시 모델 확장

**Files:**
- Modify: `src/renderer/workspacePresentation.ts`
- Test: `tests/renderer/workspacePresentation.test.ts`

**Interfaces:**
- Consumes: `{ currentFilePath, lineCount, isDirty, apiReady }`
- Produces: `WorkspacePresentation`의 `isEmptyWorkspace`, 영역별 표시 불리언, 파일 행동과 저장 레이블

- [ ] **Step 1: 저장된 빈 프로젝트도 빈 상태가 되는 실패 테스트 작성**

```ts
it("treats every zero-line project as an empty workspace", () => {
  const result = getWorkspacePresentation({
    currentFilePath: "C:\\work\\empty.ctp",
    lineCount: 0,
    isDirty: false,
    apiReady: true
  });
  expect(result).toMatchObject({
    isEmptyWorkspace: true,
    showStartPanel: true,
    showWorkspaceChrome: false,
    showPageControls: false,
    showBottomPanel: false,
    showInspector: false,
    showExport: false
  });
});

it("shows work regions when at least one line exists", () => {
  const result = getWorkspacePresentation({
    currentFilePath: null,
    lineCount: 1,
    isDirty: true,
    apiReady: true
  });
  expect(result).toMatchObject({
    isEmptyWorkspace: false,
    showWorkspaceChrome: true,
    showPageControls: true,
    showBottomPanel: true,
    showInspector: true
  });
});
```

- [ ] **Step 2: 실패 확인**

```powershell
npm test -- tests/renderer/workspacePresentation.test.ts
```

Expected: 새 표시 필드가 없어 FAIL.

- [ ] **Step 3: 최소 구현**

```ts
export type WorkspacePresentation = {
  isEmptyWorkspace: boolean;
  showStartPanel: boolean;
  showWorkspaceChrome: boolean;
  showPageControls: boolean;
  showBottomPanel: boolean;
  showInspector: boolean;
  showSave: boolean;
  showSaveAs: boolean;
  showExport: boolean;
  saveLabel: "새 프로젝트" | "저장 필요" | "변경 있음" | "저장됨";
};

const hasSavedFile = Boolean(args.currentFilePath);
const hasLines = args.lineCount > 0;
const isEmptyWorkspace = !hasLines;

return {
  isEmptyWorkspace,
  showStartPanel: isEmptyWorkspace,
  showWorkspaceChrome: !isEmptyWorkspace,
  showPageControls: !isEmptyWorkspace,
  showBottomPanel: !isEmptyWorkspace,
  showInspector: !isEmptyWorkspace,
  showSave: args.apiReady && (hasSavedFile || hasLines),
  showSaveAs: args.apiReady,
  showExport: args.apiReady && hasLines,
  saveLabel: !hasSavedFile
    ? hasLines ? "저장 필요" : "새 프로젝트"
    : args.isDirty ? "변경 있음" : "저장됨"
};
```

- [ ] **Step 4: 단위 테스트 통과 확인**

```powershell
npm test -- tests/renderer/workspacePresentation.test.ts
```

Expected: PASS.

- [ ] **Step 5: 커밋**

```powershell
git add src/renderer/workspacePresentation.ts tests/renderer/workspacePresentation.test.ts
git commit -m "refactor: centralize empty workspace presentation"
```

---

### Task 2: 빈 상태에서 작업 크롬 제거

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/FocusDeckShell.tsx`
- Test: `tests/renderer/App.test.tsx`

**Interfaces:**
- Consumes: Task 1의 표시 필드
- Produces: `FocusDeckShell` prop `showWorkspaceChrome?: boolean`

- [ ] **Step 1: 최초 상태 통합 실패 테스트 작성**

```tsx
it("shows only start actions when no dialogue lines exist", () => {
  renderApp();
  expect(screen.getByRole("button", { name: "번역 시작: TXT 불러오기" })).toBeInTheDocument();
  expect(screen.queryByLabelText("페이지 이동")).not.toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "작업 도구" })).not.toBeInTheDocument();
  expect(screen.queryByRole("complementary", { name: "오른쪽 작업 패널" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "하단 대사 패널" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 저장된 빈 프로젝트 통합 실패 테스트 작성**

기존 `window.projectApi.openProject` mock과 프로젝트 팩토리를 사용해 `dialogueLines: []`인 `C:\projects\empty.ctp`를 연 뒤 동일한 숨김 조건을 검증한다. 새 테스트 팩토리는 만들지 않는다.

- [ ] **Step 3: 실패 확인**

```powershell
npm test -- tests/renderer/App.test.tsx -t "no dialogue lines|saved empty project"
```

Expected: 레일, 검사 영역 또는 하단 패널이 DOM에 남아 FAIL.

- [ ] **Step 4: `FocusDeckShell` 계약 구현**

```tsx
interface FocusDeckShellProps {
  // existing props
  showWorkflow?: boolean;
  showWorkspaceChrome?: boolean;
}

export function FocusDeckShell({
  // existing props
  showWorkflow = true,
  showWorkspaceChrome = true
}: FocusDeckShellProps) {
  const closeNarrowEditor = () => {
    setNarrowEditorOpen(false);
    requestAnimationFrame(() => workTriggerRef.current?.focus());
  };

  return (
    <div
      className={showWorkspaceChrome ? "focus-deck-shell" : "focus-deck-shell empty-workspace"}
      style={showWorkspaceChrome ? shellStyle : emptyShellStyle}
    >
      <header className="focus-deck-top-bar" style={topBarStyle}>{topBar}{/* workflow */}</header>
      {showWorkspaceChrome ? <nav aria-label="작업 도구">{/* existing buttons */}</nav> : null}
      <div className="focus-deck-workspace" style={showWorkspaceChrome ? workspaceStyle : emptyWorkspaceStyle}>
        {showWorkspaceChrome ? (
          <ResizableWorkspace
            editorWidth={editorWidth}
            onEditorWidthChange={onEditorWidthChange}
            canvas={canvas}
            editor={editor}
            editorOpen={!isNarrow || narrowEditorOpen}
            onEditorClose={isNarrow ? closeNarrowEditor : undefined}
          />
        ) : canvas}
        {showWorkspaceChrome ? drawer : null}
      </div>
      {showWorkspaceChrome ? <footer>{filmstrip}</footer> : null}
    </div>
  );
}

const emptyShellStyle = {
  display: "grid",
  gridTemplateRows: "52px minmax(0, 1fr)",
  minHeight: "100vh"
} as const;
const emptyWorkspaceStyle = { gridRow: 2, minWidth: 0, minHeight: 0 } as const;
```

`closeNarrowEditor`는 현재 inline callback의 본문인 `setNarrowEditorOpen(false)`와 focus 복귀를 함수로 옮긴 것이다. 동작은 변경하지 않는다.

- [ ] **Step 5: `App.tsx` 표시 정책 연결**

```tsx
<FocusDeckShell
  showWorkflow={workspacePresentation.showWorkspaceChrome}
  showWorkspaceChrome={workspacePresentation.showWorkspaceChrome}
  // existing props
/>
```

상단 파일 버튼 그룹은 작업 상태에서만 렌더링하고 빈 상태의 파일 행동은 `WorkspaceStartPanel`에만 둔다. `top-page-actions`는 `showPageControls`일 때만 렌더링한다. editor와 filmstrip은 셸이 빈 상태에서 소비하지 않도록 유지하며, 별도의 빈 inspector JSX는 삭제한다.

`tests/renderer/App.test.tsx`의 `renderApp()`은 현재 렌더 직후 `페이지` 버튼을 누른다. 빈 상태에서는 그 버튼이 없어지므로 아래처럼 책임을 분리한다.

```tsx
function renderApp() {
  return render(<App />);
}

function openPagesDrawer() {
  fireEvent.click(screen.getByRole("button", { name: "페이지" }));
}
```

기존 테스트 중 페이지 drawer가 필요한 테스트만 `openPagesDrawer()`를 명시적으로 호출한다. 시작 상태 테스트는 호출하지 않는다.

- [ ] **Step 6: 집중 테스트 통과 확인**

```powershell
npm test -- tests/renderer/App.test.tsx -t "no dialogue lines|saved empty project"
```

Expected: PASS.

- [ ] **Step 7: App 전체 테스트 확인**

```powershell
npm test -- tests/renderer/App.test.tsx
```

Expected: PASS. 기존 빈 하단 패널 테스트는 TXT를 한 줄 import한 뒤 하단 패널을 검사하도록 수정한다.

- [ ] **Step 8: 커밋**

```powershell
git add src/renderer/App.tsx src/renderer/components/FocusDeckShell.tsx tests/renderer/App.test.tsx
git commit -m "feat: hide workspace chrome until dialogue exists"
```

---

### Task 3: 중앙 시작 안내 통합과 레이아웃 정리

**Files:**
- Modify: `src/renderer/components/WorkspaceStartPanel.tsx`
- Modify: `src/renderer/styles.css`
- Test: `tests/renderer/WorkspaceStartPanel.test.tsx`
- Test: `tests/renderer/App.test.tsx`

**Interfaces:**
- Consumes: 기존 `WorkspaceStartPanelProps`
- Produces: 반복 설명이 없는 단일 시작 영역

- [ ] **Step 1: 중복 안내 방지 실패 테스트 작성**

```tsx
it("keeps all empty guidance in one start panel", () => {
  renderApp();
  expect(screen.getByRole("heading", { name: "번역할 TXT 파일을 불러오세요" })).toBeInTheDocument();
  expect(screen.getByText("TXT를 불러오면 첫 번째 미완료 대사부터 바로 검토할 수 있습니다.")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "시작 준비" })).not.toBeInTheDocument();
  expect(screen.getAllByText(/첫 번째 미완료 대사/)).toHaveLength(1);
});
```

- [ ] **Step 2: 실패 확인**

```powershell
npm test -- tests/renderer/WorkspaceStartPanel.test.tsx tests/renderer/App.test.tsx -t "empty guidance|start panel"
```

Expected: 중복 안내가 있거나 문구가 달라 FAIL.

- [ ] **Step 3: 시작 패널 문구 통합**

```tsx
<section className="workspace-start-panel" aria-labelledby="workspace-start-heading">
  <p className="workspace-start-eyebrow">TXT 불러오기 → 번역 검토 → 내보내기</p>
  <h2 id="workspace-start-heading">번역할 TXT 파일을 불러오세요</h2>
  <p className="workspace-start-description">
    TXT를 불러오면 첫 번째 미완료 대사부터 바로 검토할 수 있습니다.
  </p>
  {/* 기존 주요 CTA와 세 보조 행동: 핸들러 변경 없음 */}
</section>
```

- [ ] **Step 4: 빈 상태 데스크톱 스타일 구현**

```css
.focus-deck-shell.empty-workspace .focus-deck-workspace {
  display: grid;
  place-items: center;
  padding: clamp(24px, 5vw, 64px);
  overflow: auto;
}

.focus-deck-shell.empty-workspace .workspace-main,
.focus-deck-shell.empty-workspace .image-canvas-shell {
  width: 100%;
  min-height: 100%;
  display: grid;
  place-items: center;
}

.workspace-start-panel {
  width: min(100%, 640px);
  margin: 0;
}
```

기존 배경 토큰을 재사용하고 고정 높이는 추가하지 않는다.

- [ ] **Step 5: 관련 테스트 통과 확인**

```powershell
npm test -- tests/renderer/WorkspaceStartPanel.test.tsx tests/renderer/App.test.tsx
```

Expected: PASS.

- [ ] **Step 6: 커밋**

```powershell
git add src/renderer/components/WorkspaceStartPanel.tsx src/renderer/styles.css tests/renderer/WorkspaceStartPanel.test.tsx tests/renderer/App.test.tsx
git commit -m "style: unify empty workspace guidance"
```

---

### Task 4: 작업 단계별 단일 주요 CTA 보장

**Files:**
- Modify: `src/renderer/components/StageEditor.tsx`
- Test: `tests/renderer/StageEditor.test.tsx`
- Test: `tests/renderer/App.test.tsx`

**Interfaces:**
- Consumes: 기존 `StageEditor` props
- Produces: 현재 단계에서 최대 하나의 `[data-primary-action="true"]`

- [ ] **Step 1: 공용 검증 함수와 실패 테스트 작성**

```tsx
function expectSinglePrimaryAction(container: HTMLElement, name: string) {
  const actions = container.querySelectorAll('[data-primary-action="true"]');
  expect(actions).toHaveLength(1);
  expect(actions[0]).toHaveAccessibleName(name);
}

it("emphasizes only approve-and-next while translating", () => {
  const { container } = render(<StageEditor {...props} stage="translation" line={line} />);
  expectSinglePrimaryAction(container, "완료하고 다음 대사");
});

it("emphasizes only export when all dialogue is complete", () => {
  const { container } = render(
    <StageEditor
      {...props}
      stage="complete"
      hasProjectLines
      hasActionableProjectLines={false}
      nextActionableLine={null}
    />
  );
  expectSinglePrimaryAction(container, "번역 내보내기");
});
```

기존 `props`와 `line` fixture를 그대로 사용한다.

- [ ] **Step 2: 실패 확인**

```powershell
npm test -- tests/renderer/StageEditor.test.tsx
```

Expected: 식별 속성이 없어 FAIL.

- [ ] **Step 3: 분기별 주요 버튼에 속성 추가**

```tsx
<button
  type="button"
  className="primary-button"
  data-primary-action="true"
  disabled={props.busy}
  onClick={props.onApproveTranslation}
>
  완료하고 다음 대사
</button>
```

동일 속성을 각 분기 안의 `OCR 다시 실행`, `남은 대사로 이동` 또는 `다음 페이지로 이동`, `번역 내보내기`에만 추가한다. `프로젝트 검토`, 저장, 이동, 삭제에는 추가하지 않는다.

- [ ] **Step 4: TXT 이후 전환 통합 테스트 작성**

```tsx
it("switches from import to one translation primary action", async () => {
  window.projectApi = {
    importTxtFile: vi.fn().mockResolvedValue({
      filePath: "C:\\dialogue.txt",
      lines: [rendererLine("line-1", 1, "원문")]
    }),
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProject: vi.fn(),
    saveProject: vi.fn()
  };
  const { container } = renderApp();
  fireEvent.click(screen.getByRole("button", { name: "번역 시작: TXT 불러오기" }));
  expect(await screen.findByRole("button", { name: "완료하고 다음 대사" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "번역 시작: TXT 불러오기" })).not.toBeInTheDocument();
  expect(container.querySelectorAll('[data-primary-action="true"]')).toHaveLength(1);
});
```

이 테스트에서는 `renderApp()`만 호출하고 `openPagesDrawer()`는 호출하지 않는다.

- [ ] **Step 5: 관련 테스트 통과 확인**

```powershell
npm test -- tests/renderer/StageEditor.test.tsx tests/renderer/App.test.tsx
```

Expected: PASS.

- [ ] **Step 6: 커밋**

```powershell
git add src/renderer/components/StageEditor.tsx tests/renderer/StageEditor.test.tsx tests/renderer/App.test.tsx
git commit -m "feat: keep one primary workflow action"
```

---

### Task 5: 전체 회귀와 데스크톱 시각 검증

**Files:**
- Modify only for a reproduced defect: `src/renderer/styles.css`, affected test
- Verify: entire repository

**Interfaces:**
- Consumes: Tasks 1–4 결과
- Produces: 타입·테스트·빌드 및 1280×720, 1440×900 검증 증거

- [ ] **Step 1: diff 확인**

```powershell
git status --short
git diff --check
```

Expected: 계획된 파일만 변경, 공백 오류 없음.

- [ ] **Step 2: 전체 자동 검증**

```powershell
npm run typecheck
npm test
npm run build
```

Expected: 세 명령 모두 exit code 0.

- [ ] **Step 3: 개발 서버 실행**

```powershell
npm run dev -- --host 127.0.0.1 --port 4173
```

Expected: `http://127.0.0.1:4173` 로드.

- [ ] **Step 4: 1280×720 빈 상태 검증**

- `TXT 불러오기`가 유일한 주요 CTA다.
- 상단 페이지 제어, 왼쪽 레일, 오른쪽 안내, 하단 패널이 없다.
- 카드가 화면 안에서 자연스럽게 중앙 정렬된다.
- `scrollWidth === innerWidth`이며 콘솔 오류가 없다.

- [ ] **Step 5: 1440×900 빈 상태 검증**

Step 4 항목과 함께 카드가 상단에 치우치거나 주변 여백이 과도하지 않은지 확인한다.

- [ ] **Step 6: TXT 불러오기 후 작업 상태 검증**

- 레일, 페이지 제어, 검사 영역, 하단 패널이 나타난다.
- 첫 미완료 대사가 선택된다.
- `완료하고 다음 대사`만 주요 CTA다.
- Ctrl+Enter가 다음 대사로 이동한다.
- 전체 완료 시 주요 CTA가 `번역 내보내기`로 바뀐다.

- [ ] **Step 7: 결함이 있을 때만 테스트 우선 최소 수정**

재현 테스트를 먼저 추가하고 관련 파일만 수정한 뒤 Step 2–6을 다시 실행한다. 변경이 있었을 때만 다음을 커밋한다.

```powershell
git add src/renderer/styles.css tests/renderer
git commit -m "fix: polish focused workspace states"
```

빈 커밋은 만들지 않는다.

---

## Definition of Done

- [ ] 저장 여부와 무관하게 대사 0개면 시작 화면만 렌더링된다.
- [ ] 빈 상태에서 페이지 제어, 레일, 검사 영역, 하단 패널은 DOM에 없다.
- [ ] 시작 설명이 중앙 패널 한곳에만 존재한다.
- [ ] TXT 불러오기 성공 후 작업 셸과 첫 미완료 대사가 즉시 나타난다.
- [ ] 각 작업 단계에서 주요 CTA가 하나다.
- [ ] 마지막 대사를 삭제하면 다시 빈 상태로 전환된다.
- [ ] 기존 저장, OCR, 인페인팅, 번역 수정, 내보내기 테스트가 통과한다.
- [ ] 1280×720과 1440×900에서 잘림, 겹침, 가로 스크롤이 없다.
- [ ] `npm run typecheck`, `npm test`, `npm run build`가 모두 성공한다.
