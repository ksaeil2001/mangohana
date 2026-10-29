# Trio 디자인 시스템

Trio의 사용자 인터페이스는 중성 표면, 명확한 서체 위계, 절제된 블루 액센트로 구성한다. 이미지와 대사 검토를 중심에 두고 사용자 확정, AI 제안, 실패와 재시도를 서로 다른 상태로 유지한다.

## 구현 위치

- `src/renderer/design-tokens.css`: 라이트/다크 색상, 서체, 간격, 모서리, 컨트롤 크기, 그림자, 전환 시간의 기준.
- `src/renderer/design-system.css`: 제품 전체의 공통 컨트롤, 네비게이션, 설정 행, 모달 및 반응형 규칙.
- `src/renderer/styles.css`: 기존 컴포넌트의 구조와 이미지 작업대의 레이아웃. 시각 값은 공통 토큰을 참조한다.
- `src/renderer/components/Ui.tsx`: Button, PageHeader, SettingsRow, Feedback, ModalSurface와 설정 탭 키보드 동작.

앱은 기존 `document.documentElement.dataset.theme` 선택을 사용한다. 별도 `.dark` 클래스나 새 테마 저장소를 만들지 않는다. 기존 `--ink`, `--panel`, `--focus-*`, `--inkline-*` 색상 이름은 동일한 토큰을 참조하는 호환 별칭이다.

## 화면 목록

URL 라우터 대신 `entryFlow.ts`의 화면 상태와 `App.tsx`의 분기 렌더링을 사용한다.

| 진입 화면 | 구성과 하위 상태 |
| --- | --- |
| home | ProjectHomeScreen, AppShell, 신규/최근 프로젝트, TXT 시작 접힘 영역, 환경 준비, 가이드·도움말·개인정보 안내 모달 |
| projects | ProjectsPage, 검색, 정렬, 카드/목록 보기, 최근 프로젝트 없음·검색 결과 없음 |
| files | FileBrowserPage, 폴더 탐색, 파일 목록, 검색/필터, 선택 파일 상세 패널, 빈 상태 |
| ai | AiDashboardPage, API 상태의 로딩/오류/재시도, 프로젝트 선택, 작업대 진입 |
| tools | ToolsPage, 도구 목록, 사용 가능/준비 중 상태, 프로젝트 선택 모달 코드 경로 |
| dictionary | DictionaryPage, 캐릭터/용어 분류, 검색, 캐릭터 프로필 모달, 용어 추가 모달, 용어집 추출 승인 모달 |
| settings | SettingsPage, 일반 / AI 번역 엔진 / 식자 오버레이 / 저장소 및 백업 / 키보드 단축키 / 앱 정보 |
| setup | ProjectSetupScreen, 프로젝트 이름·저장 위치, 이미지 추가, 빈 상태, 순서/제거, 중복·오류 안내, 생성 중 상태 |
| preparation | EnvironmentPreparationScreen, 구성요소별 준비/실패/복구, 진행률, 저장 위치, 새로고침, 돌아가기 |
| workspace | FocusDeckShell, 상단 명령·페이지 이동, 페이지 패널, 이미지 캔버스, 선택 대사 편집, OCR/화자 검토, 인페인팅, 식자, 검토 큐, 상태 표시줄 |

워크스페이스의 추가 설정은 ProjectActionsPanel의 **일반 / AI & API / 번역·내보내기 / 화면·캔버스 / 단축키 / 정보**까지 포함한다. 클라우드/로컬 번역 엔진, OCR·인페인팅 엔진, 키 입력, 로컬 연결 결과와 설치 모델 목록을 같은 입력·그룹 규칙으로 표현한다. 비활성 설정 패널은 `hidden`으로 화면과 키보드 탐색에서 제외한다.

추가 표면은 BatchAutomationModal, GlossaryApprovalModal, SpeechBubbleReviewDialog의 모달/패널 두 변형, CharacterDictionaryPanel, ProcessingQueuePanel, RuntimeStatusControl, AutoUpdateStatusControl, ToolDrawer, 이미지 오버레이 메뉴와 비교/레이어 컨트롤이다. 재사용되지 않는 독립 화면을 새로 만들지 않는다.

별도 계정·프로필·로그인·인증 라우트는 없다. 캐릭터 프로필은 계정 프로필과 다른 기능이다. 브라우저 기본 select, details/summary 및 운영체제 파일 선택기는 해당 플랫폼의 키보드 동작을 유지한다. 운영체제 파일 선택기와 타이틀 바의 외관은 렌더러 CSS의 적용 대상이 아니다.

## 시각 규칙

| 역할 | 기준 |
| --- | --- |
| 페이지 제목 | 28px, 600, 줄 높이 1.25; 작은 창에서는 24px |
| 섹션 제목 | 20px, 600 |
| 카드/패널 제목 | 16px, 600 |
| 본문 | 14px, 기본 줄 높이 1.5 |
| 보조 본문·입력·버튼 | 13px |
| 캡션·조밀한 작업대 컨트롤 | 12px |
| 간격 | 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48px |
| 모서리 | 작은 요소 6px, 컨트롤 8px, 카드 12px, 큰 패널 16px, 모달 20px |
| 컨트롤 높이 | 일반 36px, 조밀한 작업대 32px, 터치 44px |
| 모달 폭 | 기본 480px, 용어집·OCR 검토 840px; 작은 창에서는 가용 폭에 맞춤 |
| 전환 | 컨트롤 150ms, 패널 200ms; reduced-motion에서는 즉시 전환 |

시스템 폰트 스택을 사용하며 Apple 폰트 파일을 배포하지 않는다. 캔버스 이미지, 말풍선 좌표, 확대 배율, 브러시, 식자 텍스트의 크기와 색은 UI 토큰 변환 대상이 아니다. 작은 구분선, 아이콘의 광학 보정과 리사이즈 핸들의 픽셀 값도 콘텐츠 기하와 함께 유지한다.

일반 탐색의 선택은 중성 배경과 글자 굵기로 표시한다. 액센트는 주요 실행과 선택에 사용한다. 성공/경고/오류는 텍스트 설명과 함께 표현한다. AI 제안을 녹색 완료 상태로 바꾸지 않는다. 강한 장식용 그림자를 피하고 모달·팝오버에만 깊이를 부여한다.

## 컴포넌트 사용

`Button`의 `primary`, `secondary`, `tertiary`, `destructive`, `icon` 변형을 사용한다. 기존 네이티브 버튼의 동일 클래스도 같은 CSS 계약을 따른다. 아이콘 전용 버튼에는 `aria-label`이 필요하다. 파일 삭제나 확정 조건은 버튼 외관을 변경하는 과정에서 바꾸지 않는다.

`PageHeader`는 제목·설명·행동을, `SettingsRow`는 제목·설명·컨트롤을 묶는다. 모달에 맞춘 새 데이터 계층이나 저장 로직을 추가하지 않는다. `ModalSurface`는 기존 모달의 포커스 가두기와 닫힌 뒤 진입 버튼으로 복귀를 제공한다. 이미 독립적인 모달 수명주기를 가진 컴포넌트는 공통 모달 CSS와 기존 포커스 동작을 사용한다.

## 반응형과 접근성

- 390 / 768 / 1440 / 1920px를 기준으로 검증한다. 폭이 작은 홈 네비게이션은 메뉴 버튼으로 펼치며 Escape로 닫고 포커스를 복귀시킨다.
- 설정 분류는 좁은 창에서 가로 스크롤한다. 방향키/Home/End로 이동하고 Tab으로 선택한 패널에 진입한다.
- 파일 상세는 아래로 이동하고, 카드·폼은 한 열로 쌓는다. 긴 표는 해당 표 안에서만 스크롤한다.
- 이미지 도구의 가로 스크롤 영역과 오버레이 팝오버를 분리해 팝오버가 잘리지 않게 한다.
- 이미지 작업대의 기존 정밀 편집 제한, 패널 접힘과 dirty page 보호를 유지한다. 모바일 폭의 검증은 제품의 모바일 배포 지원을 의미하지 않는다.
- 본문·보조·캡션과 주요 행동의 대비는 4.5:1 이상, 입력 경계는 표면 대비 3:1 이상을 테스트한다. 구분선은 입력 경계와 다른 토큰을 사용한다.
- 포커스 테두리, 명시적인 입력 이름, pressed/current/selected 상태, reduced-motion 및 forced-colors를 지원한다.

디자인 원칙 참고: [Apple HIG 접근성](https://developer.apple.com/design/human-interface-guidelines/accessibility), [Apple HIG 타이포그래피](https://developer.apple.com/design/human-interface-guidelines/typography).
