# Trio 전체 화면 Stitch 재설계와 Electron 검증

사용자 승인: 남은 모든 화면과 앱 내 대화상자를 Google Stitch에서 새로 설계하고 실제 Electron에 반영하며 UI·UX 평가와 검증까지 완료한다. Q1~Q10과 기존 재설계 spec의 만화 중심·사용자 통제·신뢰 원칙을 재사용한다.

## 완료 기준

- 10개 주요 route와 연결된 dialog·작업대 보조 영역에 시안, 구현, 상태·행동 검증 근거를 연결한다. 화면 수나 테스트 수로 전체 완료를 대신하지 않는다.
- 기존 데이터·콜백·저장·복구·IPC·AI 제안/사용자 확정 계약을 보존한다. 실제 기능에 없는 수치·모델·진척·폴더·자동 저장·전역 Undo·수정 이력을 표시하지 않는다.
- 새 배치와 목적별 정보 구조를 실제 컴포넌트에 반영한다. 색상만 덮어쓰는 변경으로 완료 처리하지 않는다.
- 사용자 선호 light/dark를 유지하며 1440×900·1280×900·900×900에서 주행동과 상태·키보드 접근을 확인한다. 긴 내용·낮은 dialog 높이·포커스 복귀·취소·설정 이탈·지연 응답을 검증한다.
- 전체 회귀 suite(`artifacts/**` 제외), typecheck, lint, build와 실제 Electron UI 과제를 실행한다. 가짜 제공자를 사용하는 부분, 프로덕션 renderer/preload/IPC/session/storage 경로, 실제 AI 품질·설치 검증의 미포함 범위를 구분한다.
- 마지막 독립 architect 검토의 조치를 마무리하고 누락된 실행 항목이 없는지 대조한다.

## 범위와 단일 담당

| 범위 | 담당 파일 | 필수 행동·상태 |
| --- | --- | --- |
| 공통 관리 탐색·홈·프로젝트·파일·AI·도구·사전 | worker 1: `AppShell`, `ProjectHomeScreen`, `ProjectsPage`, `FileBrowserPage`, `AiDashboardPage`, `ToolsPage`, `DictionaryPage`, `stitch-suite.css` 및 해당 테스트 | 새 프로젝트·열기·최근 전환, 검색/정렬/선택, 빈 결과·재시도, 모델·키·연결 의미 분리, 캐릭터/용어 편집·추출 승인 연결. AppShell 안내, Tools 도구 실행, Dictionary 추가·편집 dialog도 해당 파일 담당자가 수정한다. |
| 생성·환경·설정·작업용 dialog/패널 | worker 2: `ProjectSetupScreen`, `EnvironmentPreparationScreen`, `SettingsPage`, `BatchAutomationModal`, `GlossaryApprovalModal`, `SpeechBubbleReviewDialog`, `Ui`, `CharacterDictionaryPanel`, `InpaintingEditor`, `stitch-flow.css`, `stitch-dialogs.css` 및 해당 테스트 | 이미지 순서·취소·저장 실패 초안, 구성요소 상태·위치·repair, 설정 6탭·이탈·키 별도 적용, 일괄 설정/진행/부분실패/취소/정지, OCR/화자 후보와 인페인팅의 승인 경계. |
| 통합·기존 native confirm/prompt·실행 검증 | main: `App`, `AppDialogs`, `useProjectSaveWorkflow`, 새 dialog 회귀, 실제 Electron 하네스와 검증 기록 | 삭제·미저장 폐기·암호·legacy 경로 입력을 async 앱 dialog로 통일. dialog 전 snapshot/session/generation/line identity 캡처, 대기 후 재검사, 단일 pending·배경 inert·전역 키 차단·IME·focus 복귀. |

기존 ToolDrawer는 현재 App 진입 경로가 없는 비모달 구현이다. 새 기능처럼 연결하지 않으며 현재 제품의 실행 대상은 아님을 기록한다. 식자 Portal·오버레이 메뉴·프로젝트 설정·문맥·큐·인페인팅은 별도 모달이 아닌 작업대 보조 영역으로 검사한다. OS 파일/폴더 열기·저장 창 자체는 renderer 디자인 대상이 아니며 진입·취소·실패 주변 UI를 포함한다.

## 진행 순서

1. [완료] 현재 route·dialog·상태 owner·기존 테스트 조사와 dirty baseline 156개 파일 보존. 초기 architect 검토 및 native dialog 전환 검토 반영.
2. [완료] Stitch에서 9개 관리/집중 화면, 앱 dialog와 상태 시안을 생성하고 실제 기능과 대응한다. 생성 설명만으로 성공을 기록하지 않는다.
3. [완료] 담당 파일을 분리해 병렬 구현하고 App 통합. 새 CSS는 명시적 suite/flow/dialog root로 한정한다.
4. [완료] 관련 검사와 전체 회귀·타입·lint·build. 실제 Electron에서 10개 route와 연결 dialog·실패·복구·키보드 과제를 수행해 문제를 수정한다.
5. [완료] 시안/구현/실행 증거 coverage, UI·UX 평가와 최종 독립 검토를 대조해 완료 판정한다.

## 실행 기록 위치

단일 설계 기록은 `docs/superpowers/specs/2026-10-19-trio-stitch-ui-ux-redesign.md`를 갱신한다. 작업별 baseline·하네스·스크린샷·상태/측정/평가 자료는 이 대화의 승인된 visualizations root 안 `trio-stitch-full/`에 둔다. 소스/빌드 해시로 현재 실행 대상을 고정한다. commit·push·외부 게시·설치 프로그램 교체는 이 로컬 구현 승인과 구분한다.


## 완료 판정

2026-10-19 최종 `verified-ui`는 18개 과제·240회 측정·255개 캡처, 정상 종료와 격리 경계 위반 0회를 기록했다. 입력 216개·산출물 132개의 시작/완료 해시가 일치한다. 전체 회귀 193파일/2,284개 후 마지막 App 283개와 정지 race modal 40개를 각각 통과했다. typecheck/build 통과, lint 오류 0·경고 90. 독립 architect가 coverage·현재 해시·실행 기록·대비 재집계를 확인했으며 추가 차단 결함이 없다고 판단했다.

최종 범위/한계와 실행 증거는 spec 후속 기록 및 visualizations root의 `trio-stitch-full/REPORT.md`, `coverage.json`, `runs/verified-ui/`에 둔다. 자동 저장·전역 Undo·이력의 신규 저장 기능, 실제 AI 품질, 설치된 EXE·릴리스는 이번 UI 재설계 완료로 확대하지 않는다.
