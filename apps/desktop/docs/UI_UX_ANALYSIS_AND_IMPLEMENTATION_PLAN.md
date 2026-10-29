# Trio UI/UX 통합 분석 및 구현 계획

> **분석 기준:** `ksaeil2001/trio` 기본 브랜치의 실제 코드와 1440×900 Launcher 실행 캡처를 기준으로 정리했다. 이 문서는 Renderer UI를 변경하기 전에 작성했으며, Main·Preload·IPC·처리 파이프라인·스토리지 계약의 보존 범위를 명확히 한다.

## 1. 현재 아키텍처와 안전 경계

Trio는 Electron 42, React 19, TypeScript 6, Vite 8, Vitest 4 기반의 데스크톱 애플리케이션이다. Electron 메인은 1400×900 기본 창과 1200×720 최소 창을 생성하고, `contextIsolation: true` 및 `nodeIntegration: false`로 Renderer를 분리한다. Main은 프로젝트 세션, 최근 프로젝트, API 키 저장소, 자동 업데이트를 초기화한 뒤 IPC handler를 등록한다. 따라서 이번 UI 통합은 원칙적으로 **Renderer와 CSS 계층에 한정**하며, Main·Preload·IPC의 변경은 금지한다.

| 계층 | 실제 구현 | 보존 원칙 |
|---|---|---|
| Electron Main | `electron/main.ts`, `src/main/ipcHandlers.ts`, 세션·저장·보호·복구 모듈 | 창 설정, 프로젝트 세션, 파일 선택, 저장, 복구, 암호화, 자동 업데이트를 수정하지 않는다. |
| Preload | `electron/preload.ts`의 `window.projectApi` | 프로젝트 생성/열기/저장/내보내기, 이미지 준비·연결, OCR, 인페인팅, 이미지 URL 해석, 환경 준비 IPC 이름과 payload를 바꾸지 않는다. |
| Renderer 진입 | `src/renderer/App.tsx` | 기존 상태, 이벤트, 비동기 작업의 최신성 방어를 유지하고 UI 조립 및 표시 계층을 재구성한다. |
| Workspace 셸 | `FocusDeckShell`, `ResizableWorkspace`, `workspaceAdaptation`, `focusDeck` | 기존 접기, focus mode, Inspector 너비, 협소 창 대응을 재사용한다. |
| Canvas | `PageImagePanel`, overlay·viewport·inpainting·typesetting 모듈 | Fit/Width/100%/줌/팬/비교/레이어/선택 영역/마스크 기능을 보존한다. |
| 편집·검수 | `StageEditor`, `LineDetailPanel`, issue navigation/editor 모듈 | 원문/OCR, AI 제안, 사용자 번역, 화자, 상태, 이전·다음/이슈 순환과 저장 mutation을 보존한다. |

## 2. 현재 실제 UI 구조

### 2.1 최상위 화면과 진입 흐름

현재 `entryFlow`의 최상위 상태는 `home`, `setup`, `preparation`, `workspace`다. Home은 `ProjectHomeScreen`으로 구현되어 최근 프로젝트 재개, 새 프로젝트, 기존 프로젝트 열기, TXT 시작, 환경 준비를 제공한다. Setup은 `ProjectSetupScreen`으로, 이미지 선택·드롭, 정렬/순서 검토, 번역 작업 방식 선택 후 프로젝트 생성을 수행한다. Environment Preparation은 독립 화면이며, Workspace 또는 Home으로 복귀할 수 있다. Workspace는 `FocusDeckShell`로 구성된다.

현재 New Project는 이미지 우선의 전체 화면 Setup이다. 사용자의 목표 UI는 프로젝트명, 이미지 또는 폴더, 저장 위치를 우선하는 컴팩트한 생성 경험이지만, 현재 연결된 프로젝트 세션 생성과 prepared-image batch 흐름은 유지해야 한다. 따라서 첫 통합 단계에서는 생성 로직을 바꾸지 않고 Launcher 표현과 Setup의 정보 밀도를 정리하며, 파일 선택/저장 위치 선택을 기존 Main 대화상자 계약에 맞춰 연결할 수 있는지 별도로 확인한다.

### 2.2 Workspace의 실제 영역

이미 Workspace는 다음 영역을 갖고 있으며, 요청된 Master Workspace의 구조와 호환된다.

| 현재 영역 | 실제 컴포넌트와 내용 | 유지할 기능 | UI 통합 방향 |
|---|---|---|---|
| 상단 | `App.tsx`의 `app-top-bar`, 파일 작업, 런타임 상태, 업데이트, 테마, 설정, 페이지 이동 | New/Open/Save/Save As/Export, 환경 준비, 업데이트, 페이지 이동 | 지나친 텍스트 버튼과 workflow stepper를 절제하고 도구 그룹을 압축한다. |
| 좌측 | `FocusDeckShell`의 접이식 pages 영역, `PageStrip`, 이미지/TXT import, context/guide/settings navigator | 페이지 선택, 이미지 연결, TXT import, 등장인물·용어, 프로젝트 액션 | 페이지 썸네일과 번호를 기본으로 하는 compact rail로 수렴한다. Context/Guide/Settings는 보조 패널 또는 메뉴로 후퇴한다. |
| 중앙 | `PageImagePanel` | 이미지 Fit/Width/100%, 줌, 팬, 결과 레이어, 비교, OCR overlay, typesetting, inpainting | Manga Canvas를 시각적 중심으로 만들고, 보조 제어를 컴팩트한 캔버스 툴바에 묶는다. |
| 우측 | `StageEditor`, `LineDetailPanel`, 이미지 작업 버튼, GuidedWorkPanel, CharacterDictionaryPanel | OCR, 인페인팅, OCR/Speaker review, 원문/AI 제안/사용자 번역, 상태, 메타데이터 | 선택 시 Original/Translation/Speaker/기본 layout를 먼저 노출하고, confidence·coordinates·warnings 등은 details로 접는다. |
| 하단 | `DialogueTable`, `DialogueFilmstrip`, `IssueLinePanel` | 대사 목록, OCR 후보, 문제 라인, 이슈 이동 | 항상 큰 결과 패널을 점유하지 않도록 상태 바/접이식 review drawer로 정리한다. |

### 2.3 현재 UI의 강점과 교체 대상

현재 코드는 반응형 접기 정책, focus mode, 캔버스의 Fit/실제 크기/팬, 선택 오버레이, OCR 검수, 인페인팅 마스크, 타이프세팅 드래프트, 결과 비교, 이슈 내비게이션을 이미 갖고 있다. 그 결과 **도메인 동작을 새로 만들 필요는 없다.** 반면 화면은 `Inkline Production Bench`라는 이전 디자인 언어와 workflow stepper, 큰 안내문, 수많은 텍스트 버튼/패널이 혼합되어 있으며, Inspector에 이미지 작업·가이드·편집·문맥이 동시에 쌓인다. 이는 Manga First 및 Progressive Disclosure 요구와 충돌한다.

## 3. 데이터 흐름과 반드시 보존할 동작

### 3.1 프로젝트·이미지·처리 흐름

Renderer는 프로젝트 session을 생성·열고, mutation queue와 `baseRevision`을 통해 Main의 변경 결과를 다시 수용한다. 이미지 import는 선택 → prepared batch → session-backed import의 순서를 따른다. 저장·내보내기·이미지 URL 해석도 session 기반 API를 사용한다. OCR은 말풍선 추출 결과를 Renderer review 상태로 올리고, 사용자가 승인한 내용을 dialogue line mutation으로 기록한다. 인페인팅은 마스크 PNG·mode·provider·prompt만 Preload를 통해 Main으로 전송하고 결과 asset을 현재 페이지 result layer로 연결한다.

> UI는 기존 session mutation 및 async identity 보호 위에서만 동작해야 한다. 단순 React state의 새 데이터 모델로 프로젝트 저장을 우회하거나, Renderer가 직접 파일 경로를 관리하도록 바꾸면 안 된다.

### 3.2 사용자 수정값의 우선성

`LineDetailPanel`은 `sourceText`, 읽기 전용 `aiTranslation`, 편집 가능한 `userTranslation`을 분리하며, `translationOwnership`은 AI 초안/사용자 수정/확정 표현에 필요한 분류 기반을 제공한다. `App.tsx`는 project revision, session mutation queue, image render request key/generation, OCR request token, 프로젝트 생성/open token 등을 사용해 오래된 비동기 결과가 최신 상태를 덮어쓰는 위험을 줄인다.

이번 UI에서는 이 기반을 유지하고 다음 방식으로 표현을 정리한다.

| 사용자 상태 | 기존 근거 | 새 UI 표현 | 데이터 변경 |
|---|---|---|---|
| AI Generated | `aiTranslation`, `lineStatus: draft`, ownership 분류 | 절제된 `AI Generated` badge | 없음 |
| Modified | `userTranslation` 및 ownership 분류 | 선택된 번역 필드와 작은 `Modified` 상태 | 없음 |
| Confirmed | `lineStatus: complete`, `confirmTranslation` 흐름 | 작은 check indicator와 `Confirmed` 상태 | 없음 |
| Review Issue | `lineStatus: review`, `issueNavigation`, `ContextualIssueEditorControl` | 문제 영역 강조, Resolve/Ignore/Prev/Next | 기존 action과 navigation에 연결 |

현재 IPC에는 전체 AI translation rerun을 독립 호출로 수행하는 계약이 확인되지 않았다. 그러므로 사용자의 AI 재실행 충돌 보호 요구는 **현재 존재하는 OCR/인페인팅 비동기 작업 및 UI 표시 범위에서는 최신성 방어를 유지**하고, 번역 재생성 API가 실제로 추가될 때에만 `Keep my edit / Compare / Replace` conflict interaction을 연결한다. 존재하지 않는 대규모 translation pipeline을 UI만을 위해 가짜로 만들지 않는다.

## 4. 구현 파일과 구체적 변경 범위

| 파일 | 변경 여부 | 역할 및 변경 범위 |
|---|---:|---|
| `src/renderer/styles.css` | 변경 | 기존 Inkline 외관을 Trio desktop token, compact toolbar, page rail, image-first canvas, contextual inspector, minimal status area로 재정의한다. |
| `src/renderer/components/FocusDeckShell.tsx` | 변경 | workflow stepper를 줄이고, Master Workspace에 맞춘 안정된 top/left/center/right/bottom shell semantic을 적용한다. 기존 panel state·focus mode·responsive behavior는 유지한다. |
| `src/renderer/App.tsx` | 최소 변경 | 현재 top/left/right/bottom slot을 새 정보 구조에 맞게 재배열하고 기존 callbacks/state를 그대로 전달한다. 전체 business logic을 분리·삭제하지 않는다. |
| `src/renderer/components/PageImagePanel.tsx` | 최소 변경 | 현재 캔버스 도구의 정보 계층을 compact하게 만들고 빈 상태 문구를 `Drop manga images here`/`Add Images` 중심으로 조정한다. viewport/overlay/render logic은 보존한다. |
| `src/renderer/components/LineDetailPanel.tsx` | 변경 | Inspector의 우선순위를 Original → Translation → Speaker → basic layout로 바꾸고 advanced details에 메타데이터를 수렴한다. 필드와 callbacks는 유지한다. |
| `src/renderer/components/StageEditor.tsx` | 최소 변경 | 안내 중심 표면을 context-aware 상태 표현으로 축소하고, 기존 OCR/Speaker/translation action을 유지한다. |
| `src/renderer/components/ProjectHomeScreen.tsx` | 변경 | Launcher를 dashboard가 아닌 New/Open/Recent 중심의 compact desktop launcher로 수렴한다. |
| `src/renderer/components/ProjectSetupScreen.tsx` | 변경 | 현재 이미지 순서 검토 기능을 보존하면서 과도한 full-screen onboarding의 정보 밀도를 낮춘다. |
| `electron/main.ts`, `electron/preload.ts`, `src/main/**`, `src/shared/**` | 원칙적으로 변경하지 않음 | IPC, sidecar/AI 호출, project persistence, storage, protection, recovery, locking, data model을 보존한다. |

## 5. 상태별 구현 규칙

같은 Workspace 셸 안에서 다음 상태의 **내용만** 달라지도록 한다. 툴바 높이, Inspector 위치/기본 폭, Canvas 위치, typography/color/border/spacing/icon 시스템은 상태에 따라 바꾸지 않는다.

| 상태 | Canvas | Inspector | 하단 상태 |
|---|---|---|---|
| Default Viewing | 오버레이 최소, 이미지 최대 | 자동 collapse 또는 빈 contextual state | 기본 준비/저장 상태만 |
| Text Selected | 선택 bbox만 선명하게 | Original, Translation, Speaker, basic text layout | 작고 비침범적인 line state |
| AI Processing | 페이지 탐색 가능 범위에서 이미지 유지 | 작업에 필요한 취소/상태만 | `OCR 중 · Page n/m · Cancel` 형태의 진행 표시 |
| Review Issue | 문제 영역만 강조 | confidence, 필요한 원문/편집, Resolve/Ignore/Prev/Next | issue count 및 짧은 안내 |
| User Modified | Text Selected와 동일 | Modified 상태, 저장 보호 안내 | 저장 상태 |
| Confirmed | Text Selected와 동일 | Confirmed 상태 | 완료 상태 |
| Failure | 해당 페이지/결과의 문맥 오류 | Retry/Details | 전체 오류 페이지 없이 페이지 단위 실패 표시 |

## 6. 구현 순서 및 검증 기준

1. 기존 Renderer test/typecheck가 통과하는 기준선을 유지한다.
2. 공통 CSS token과 FocusDeck shell을 정리해 안정된 Master Workspace 골격을 만든다.
3. Launcher와 Setup을 New/Open/Recent 중심으로 재구성하되 callback을 바꾸지 않는다.
4. Canvas 툴바와 empty state를 compact하게 만들고 image-fit/zoom/pan/overlay/compare/inpainting/typesetting을 회귀 검증한다.
5. Inspector의 `LineDetailPanel`과 `StageEditor`를 선택 대상 중심으로 재배치해 AI Generated/Modified/Confirmed와 review context를 절제해 표현한다.
6. 좌측 navigator와 하단 review surface를 보조 영역으로 수렴하고, issue navigation과 dialogue list를 보존한다.
7. typecheck, 전체 test, build를 실행하고 Launcher/Setup/Workspace의 주요 상태를 시각 점검한다.

| 검증 흐름 | 보존/확인 대상 |
|---|---|
| Launcher → New Project → Setup → Create | 새 프로젝트 시작 callback, 이미지 선택/정렬/준비, 취소/생성 흐름 |
| Empty Workspace → Add Images | 동일 Workspace 셸에서 이미지 연결 action 사용 |
| Viewing → Text Select → Edit → Confirm | 원문·AI 제안·사용자 번역 필드, session mutation, status 변화 |
| OCR → Review → Apply | OCR review, Speaker review, overlay 및 line 생성 |
| Review Issue → Edit → Resolve/Next | issue navigation 및 contextual editor |
| Inpainting/결과 비교 | mask state, result layer, retry/fallback, comparison modes |
| Export/Save/Open | session-backed 파일 actions와 recent projects |

## 7. 확인된 제약과 의도적 비범위

제공된 요청문은 Text Selected Master Workspace의 이미지 자체를 참조하지만, 현재 작업 컨텍스트에는 그 이미지 파일이 없다. 이에 따라 구현은 요청문에 명시된 구조·visual direction·acceptance criteria와 실제 코드의 기존 Foundation을 기준으로 수렴하며, 기준 이미지와의 픽셀 단위 일치는 검증할 수 없다.

Settings는 현재 Home에서는 비활성적 안내 callback이고 Workspace에서는 `ProjectActionsPanel` 및 Environment Preparation으로 분산되어 있다. 이번 변경은 새 dashboard를 만들지 않고, 현존하는 설정/환경 준비 흐름을 compact preferences presentation으로 정리하는 데 한정한다. OCR, translation, inpainting, typesetting, review를 별도 페이지로 분리하지 않으며, 사용자 계정·협업·분석·구독·팀 기능·AI 사용량 dashboard는 추가하지 않는다.

## 8. 기준선 결과

의존성 설치 후 `npm run typecheck`는 성공했다. 현행 Launcher는 1440×900에서 가로로 넓은 introduction, 큰 heading, start card, empty recents, alternatives 영역을 차지하며, 현재 스타일은 compact desktop tool보다 onboarding/workbench 소개 성격이 더 강하다. 이 기준선 캡처는 `/home/ubuntu/trio_launcher_baseline.png`에 보관되어 있다.

> 다음 구현 단계에서는 위 문서의 변경 범위 밖의 Main·Preload·shared 모델을 수정하지 않는다. 기능 보존과 UI 수렴이 충돌하면 기능 보존, 문맥적 재배치, progressive disclosure 순서로 판단한다.
