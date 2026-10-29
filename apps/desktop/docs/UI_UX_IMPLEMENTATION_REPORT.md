# Trio Master Workspace UI/UX 통합 구현 보고서

**작성일:** 2026-08-19  
**대상:** `ksaeil2001/trio`  
**작성자:** Manus AI

## 완료 요약

Trio를 여러 화면이 병렬로 놓인 도구에서 **하나의 Master Workspace**로 재구성했다. 기존 Electron, preload, session IPC, 프로젝트 저장, 이미지·OCR·번역·검수·인페인팅 흐름은 보존했다. 변경은 Renderer UI와 최소 범위의 저장 위치 선택 연결에 집중했으며, 새 프로젝트·빈 프로젝트·기존 프로젝트 모두 동일한 Workspace 문법을 사용하도록 정리했다.

> 빈 프로젝트는 더 이상 별도 Home으로 되돌아가지 않는다. 동일한 Workspace Canvas에서 `Drop manga images here`와 `Add Images`를 통해 즉시 이미지를 추가할 수 있다.

| 영역 | 구현 결과 | 기능 보존 방식 |
|---|---|---|
| Master Workspace | 상단 command bar, 좌측 page rail, 넓은 Manga Canvas, 우측 Inspector, 하단 검수 영역을 동일 셸로 통합 | 기존 `FocusDeckShell`, `PageImagePanel`, `StageEditor`, `LineDetailPanel`의 callback과 상태를 유지 |
| Launcher | Project Launcher를 New / Open / Recent 우선의 컴팩트한 진입점으로 정리 | New, Open, Recent, TXT, 환경 준비, Settings callback을 모두 보존 |
| New Project | 프로젝트명, 이미지 또는 폴더, 저장 위치, 페이지 순서, 검수 밀도를 한 화면에 배치 | 기존 prepared-image/session 생성 흐름과 저장 취소 처리를 유지 |
| 저장 위치 | 생성 전 native save dialog로 `.ctp` 위치를 선택하고 첫 저장에 재사용 | preload와 Main IPC에 제한된 `chooseSaveFile`/`saveAs` 연결을 추가하고 관련 검증을 갱신 |
| Canvas | 빈 상태에서도 검은 Canvas와 이미지 추가 affordance를 유지 | 이미지 import, viewport, layer, overlay, inpainting 경로를 변경하지 않음 |
| Inspector | Original, Translation, Speaker를 우선 배치하고 AI 제안·고급 메타데이터는 접이식 영역에 배치 | 원문·AI 제안·사용자 수정·화자·상태의 기존 데이터 모델과 editor callback을 보존 |
| 상태 표현 | AI Generated, Modified, Confirmed, Review Issue를 중립 badge로 표시 | 기존 ownership 상태와 보조 기술 텍스트를 유지해 회귀·접근성 계약을 보존 |
| Bottom Review | 대사/문제/결과 접근성은 유지하고 높이를 제한해 Canvas 중심성을 강화 | 기존 review issue 선택, 오류, retry, apply, export 흐름을 그대로 유지 |

## 디자인 시스템 적용

새 CSS layer는 쿨 다크 그레이 기반의 surface, border, typography, accent token을 정의했다. 충분한 대비를 유지하면서 과도한 그라데이션과 대형 소개형 카드를 제거했다. 상단 command bar는 프로젝트명·저장 상태·파일 작업·페이지 이동·Settings를 한 줄에 배치하고, 좌우 패널은 얇은 토글로 닫거나 다시 열 수 있다.

| 토큰 또는 규칙 | 적용 내용 |
|---|---|
| 배경 | `--trio-bg`, `--trio-panel`, `--trio-canvas`로 역할별 밝기를 분리 |
| 구분 | 1px border, 작은 radius, 낮은 그림자로 도구형 밀도 유지 |
| 강조 | `--trio-accent`를 선택, 주요 CTA, active control에만 사용 |
| 상태 | AI/수정/확정/검수 상태를 텍스트·badge로 함께 표현하여 색상만으로 구분하지 않음 |
| 반응형 | 좁은 폭에서는 보조 product/path text를 감추고 Launcher/Setup action을 세로 정렬 |

## 파일별 핵심 변경

| 파일 | 핵심 변경 |
|---|---|
| `src/renderer/styles.css` | Master Workspace, Launcher, Setup, Canvas, Inspector, status badge를 위한 900여 줄의 통합 스타일 layer 추가 |
| `ProjectHomeScreen.tsx` | New/Open/Recent 중심 Launcher 재구성 및 TXT 대체 흐름 유지 |
| `ProjectSetupScreen.tsx` | 프로젝트명·저장 위치·이미지 source·페이지 order가 있는 컴팩트 생성 UI 구현 |
| `App.tsx` | setup title/storage state, 저장 위치 선택, 첫 저장 경로 재사용, contextual Inspector open 연결 |
| `LineDetailPanel.tsx` | Original/Translation/Speaker 우선 Inspector와 고급 AI proposal 영역 구현 |
| `PageImagePanel.tsx` | 빈 Canvas 안내와 Add Images action 정리 |
| `entryFlow.ts`, `workspacePresentation.ts` | 빈 프로젝트도 공통 Workspace 셸을 유지하도록 전환 정책 변경 |
| `electron/preload.ts`, `ipcHandlers.ts`, `electronApi.ts` | 선택된 프로젝트 저장 경로를 최초 `saveAs`에 전달할 수 있는 최소 IPC 확장 |
| 테스트 | UI 문구·빈 Workspace·preload 계약·상태 편집 관련 회귀 기대값을 새 UX 정책에 맞춤 |

## 검증 결과

다음 검증을 모두 통과했다.

| 명령 | 결과 |
|---|---|
| `npm run typecheck` | 성공 |
| `npm run build` | 성공 — Electron main TypeScript와 Vite Renderer production bundle 생성 |
| `npm test` | 성공 — **86 test files, 1,055 passed, 1 skipped** |

전체 테스트 중 React `act(...)` 관련 기존 경고 출력은 남아 있으나, 테스트 실패는 없었다. 이는 비동기 이미지/처리 상태를 다루는 기존 테스트의 경고이며 이번 UI 통합으로 새 실패가 발생한 것은 아니다.

## 유지한 기존 기능

프로젝트 열기/저장/다른 이름 저장, 최근 프로젝트, TXT import/export, 이미지 import, page navigation, OCR 검토, speaker 확인, 번역 draft와 확정, review issue, image overlay, inpainting, environment preparation, theme, shortcut, session/revision mutation, 프로젝트 context와 restore 경로를 유지했다. 특히 사용자 수정 번역은 AI 제안보다 우선하며, AI 제안 재생성이나 비동기 처리 결과가 사용자가 수정한 텍스트를 덮어쓰지 않는 기존 규칙을 변경하지 않았다.

## 산출물

| 파일 | 용도 |
|---|---|
| `docs/UI_UX_ANALYSIS_AND_IMPLEMENTATION_PLAN.md` | 코드 기반 UI 분석 및 구현 전 계획 |
| `docs/UI_UX_VISUAL_CHECKS.md` | Launcher 전후 시각 검토 기록 |
| `docs/UI_UX_IMPLEMENTATION_REPORT.md` | 본 최종 구현·검증 보고서 |

프로젝트에는 커밋을 생성하지 않았으며, 모든 변경은 현재 작업 트리에 남아 있다.
