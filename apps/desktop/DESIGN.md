# Trio UI Design Rules — 초안

상태: 검토용 초안 · 2026-09-21 · 적용 대상: 앞으로의 Trio UI 설계와 리뷰.

이 문서는 `Trio Manga Workspace` 이미지 템플릿의 시각 언어를 재사용 가능한 판단 규칙으로 정리한다. Windows에서 요청한 `design.md`와 기존 `DESIGN.md`는 같은 파일을 가리키므로 기존 파일명을 유지한다. 제품 코드, 데이터 계약, 승인 흐름의 변경 또는 구현 완료를 의미하지 않는다. 아래 수치는 CSS 논리 px 기준의 설계 제안이며, 참고 PNG에서 정확히 추출한 측정값이 아니다.

## 1. 기준과 적용 범위

- 시각 참고: 개인 템플릿 `artifact-template-trio-manga-workspace`의 `assets/reference.png`. 어두운 중성 표면, 이미지 중심 작업대, 페이지 탐색과 선택 대사 편집의 분리, 절제된 파란 강조를 계승한다.
- 현재 구현 확인: [design-tokens.css](src/renderer/design-tokens.css), [design-system.css](src/renderer/design-system.css), [Ui.tsx](src/renderer/components/Ui.tsx).
- 기존 설명: [디자인 시스템](docs/design-system.md). 이 문서와 현재 CSS는 일부 값이 다르다. 예를 들어 설명 문서는 페이지 제목 28px·컨트롤 radius 8px, 현재 토큰은 22px·4px다. 이번 초안은 현재 22px·4px를 출발점으로 삼는다.
- 현재 데이터·보안·검토 계약은 [AGENTS.md](AGENTS.md)를 따른다. 이미지의 `In Progress / Reviewed / Approved` 문구를 새 저장 상태나 자동 승인 절차로 도입하지 않는다.
- 이 초안은 Home, 설정, 환경 준비, 작업대와 부속 표면에 공통으로 적용할 시각 규칙이다. 화면 재배치, 기능 추가, 새 테마 엔진, Figma 원본 변경은 승인 범위에 포함하지 않는다.
- 이미지의 3열은 역할 분리의 예시다. 고정 폭 3열, 모든 패널 상시 노출, 표를 반드시 Inspector 안에 배치하는 규칙으로 해석하지 않는다. 기존 패널 접힘과 작업 문맥 보존을 유지한다.
- 이 초안 아래의 기존 설계·구현 단계는 과거 참고로 보존한다. 현재 구현 상태나 이번 작업의 실행 지시로 사용하지 않는다. 이번 초안도 검토 전에는 기존 제품 계약을 대체하지 않는다.

## 2. 핵심 원칙: 정보량과 주의 요구량을 분리한다

> Clean ≠ sparse. Compact ≠ cramped.
>
> Do not optimize for the minimum number of visible elements.
> Optimize for the minimum number of elements demanding attention.

정보를 지워 단순하게 보이게 하지 않는다. 읽는 순서, 같은 속성의 정렬, 반복 구조, 안정적인 위치와 단계별 강조로 이해 비용을 낮춘다. 많은 행이 조용히 보이는 화면은 허용하지만, 모든 행이 카드·배지·강조 버튼으로 경쟁하는 화면은 허용하지 않는다.

### 주의의 우선순위

1. 검토 대상 이미지와 현재 선택된 대사·영역.
2. 현재 작업을 끝내는 행동 및 그 작업을 막는 오류.
3. 인접 대사, 페이지 목록, 진행과 저장 상태.
4. 설명, 부가 속성, 낮은 빈도의 관리 행동.

현재 작업과 관계없는 경고가 전역 주의를 빼앗지 않도록 해당 위치에 배치한다. 데이터 손실 위험처럼 지금 판단해야 하는 문제만 작업을 중단시키는 수준으로 올린다. 강한 채움 버튼은 활성 작업 영역마다 최대 하나를 기본으로 하며, 모달이 열리면 배경의 행동은 비활성화한다. 이것은 정보나 버튼 개수를 줄이라는 뜻이 아니다.

### 조직화 순서와 장식의 허용 조건

먼저 정렬 → 근접 배치 → 제목·서체 위계 → 간격을 적용한다. 그래도 경계나 상태가 불명확할 때 구분선·표면·색을 추가한다.

| 수단 | 추가할 수 있는 기능적 이유 | 사용하지 않는 경우 |
| --- | --- | --- |
| 카드 | 독립적인 대상·선택·열기 행동을 가진 프로젝트나 자산 묶음 | Inspector의 모든 필드, 단순 설정 행, 표의 각 행을 포장할 때 |
| Border | 입력 가능 영역, 리사이즈 경계, 실제 작업 구역 분리 | 같은 영역 안의 제목·본문·버튼에 중첩 사각형을 만들 때 |
| 색상 | 선택, 현재 도구, 실행 결과, 조치가 필요한 상태를 구분 | 카테고리마다 장식색 지정, 모든 아이콘과 제목 강조 |
| Shadow | 메뉴·팝오버·대화상자가 다른 콘텐츠 위에 떠 있음을 표현 | 고정 패널, 행, 카드의 중요도를 높이려는 목적 |
| Radius | 독립 컨트롤과 떠 있는 표면의 경계를 인지시키기 | 도킹된 패널 전체, 표의 셀마다 둥근 모서리 부여 |

반복 정보는 기본적으로 보인다. 낮은 빈도의 보조 행동은 더보기로 모을 수 있지만 현재 값·오류·선택 상태·저장 상태·필수 다음 행동을 hover나 tooltip에만 숨기지 않는다.

## 3. Typography

현재 시스템 폰트 스택을 유지한다. 새 폰트 의존성은 이 초안에서 도입하지 않는다. 한글·일본어·영문 혼합을 기준으로 검증하며 영문 이미지에 맞춰 글자 폭을 강제로 압축하지 않는다. 본문 자간은 0, 굵기는 400/500/600으로 제한한다. 숫자 비교 열은 tabular numerals를 사용하고 코드·식별자에만 기존 mono 스택을 쓴다.

| 역할 | 기본값: 크기 / 줄 높이 / 굵기 | 사용할 때 | 사용하지 않을 때 |
| --- | --- | --- | --- |
| Title | 22 / 28 / 600; 작업대의 프로젝트명은 16 / 24 / 600 | Home·설정 등 화면 정체성, 작업대의 현재 프로젝트 | 모든 패널에 페이지 제목 크기 적용, 28px 이상 hero 제목으로 캔버스 압박 |
| Section title | 16 / 24 / 600; 조밀한 하위 그룹은 14 / 20 / 600 | 서로 다른 목적의 설정·편집 그룹 | 모든 필드에 제목을 반복하거나 굵기만으로 클릭 가능성 표현 |
| Body | 14 / 22 / 400 | 설명과 사용자 판단에 필요한 본문; OCR·번역 편집은 14 / 24 | 편집 대사를 caption으로 축소, 고정 한 줄 높이로 다국어 자르기 |
| Secondary text | 13 / 20 / 400 | 현재 값의 설명·부가 문맥 | 오류 원인, 승인 조건, 필수 행동을 낮은 대비로 숨기기 |
| Metadata | 12 / 18 / 400 | 페이지 크기·개수·시간·배율 | 원문·번역·버튼의 핵심 라벨, 12px 미만으로 더 많은 정보 넣기 |
| Label | 13 / 20 / 500 | 입력·선택의 지속적인 이름 | placeholder만으로 이름 대체, 영어 대문자로 위계 과장 |
| Table/list text | 13 / 20 / 400; 열 제목 12 / 18 / 500 | 반복 비교·탐색, 선택 행 식별자는 500 | 선택 행 전체를 600으로 바꾸거나 원문 내용을 흐리게 처리 |

제목·탐색용 이름은 한 줄 말줄임을 허용하되 전체 값에 키보드로 접근할 수 있어야 한다. 원문·번역 편집과 오류 설명은 줄바꿈한다. 표의 미리보기는 말줄임을 허용하지만 선택하면 전체 내용을 Inspector에서 읽고 편집할 수 있어야 한다. 폰트 확대 시 행·패널이 늘어나야 하며 line-height를 고정 높이 상자에 가두지 않는다.

## 4. Spacing

| 역할 | 기본값 | 사용할 때 | 사용하지 않을 때 |
| --- | --- | --- | --- |
| Base spacing unit | 4; 척도 4/8/12/16/20/24/32/40/48 | 패딩·간격·그룹 정렬의 공통 단위 | 화면마다 7·11·19px 같은 별도 척도 생성 |
| Compact spacing | 4는 같은 컨트롤 내부, 8은 관련 컨트롤 사이 | 아이콘+라벨, 라벨+입력, 같은 목적의 도구 | 무관한 섹션을 4px로 붙이거나 클릭 영역을 중첩 |
| Section spacing | 조밀한 편집 16, 일반 설정 24, 화면 대분류 32 | 목적이 다른 그룹 간 분리 | 모든 행 사이 24px, 빈 공간을 채우려고 간격 확대 |
| Panel padding | 작업대 12, 일반 패널 16, 대화상자 24 | 콘텐츠와 패널 경계 분리 | 중첩 wrapper마다 16px 누적; 도킹 캔버스 가장자리에 카드 패딩 |
| Row height | 일반 단일 행 최소 36, compact 최소 32, 보조 문구 포함 최소 48 | 같은 종류의 반복 행; 높이는 내용에 따라 증가 | 긴 대사·오류·확대 글자를 고정 높이에 잘라 넣기 |
| Toolbar spacing | 내부 도구 간 4, 기능 그룹 간 12, 외곽 8 | 연관 도구를 묶고 그룹 경계 인지 | 버튼 사이마다 divider, 도구마다 별도 컨테이너 |

1px 선, 2px 포커스 링, 아이콘의 광학 보정은 4px 척도의 예외다. 예외를 전체 레이아웃 간격으로 확장하지 않는다. 필드 내부 가로 패딩은 8~12px, 텍스트와 끝 아이콘 사이 최소 8px를 확보한다.

## 5. Density

| 모드 | 구성 규칙 | 사용할 때 | 사용하지 않을 때 |
| --- | --- | --- | --- |
| Normal | 컨트롤 최소 36, 본문 14, 패널 16, 그룹 간격 24 | 초기 설정·환경 준비·설명과 결정이 필요한 폼 | 큰 빈 카드로 한 설정씩 분리하거나 화면 전체에 넓은 행 강제 |
| Compact | 컨트롤·단일 행 최소 32, 반복 텍스트 13, 패널 12, 그룹 간격 16 | 페이지 탐색·대사 비교·툴바·Inspector의 짧은 필드 | 본문 12px 이하 축소, 폼의 오류 설명 제거 |
| Highly repeated controls | 32px 행 안에 최소 28×28 조작 영역, 아이콘 16; 이웃 조작 영역 간 최소 4 | 각 행의 더보기·복사처럼 구조가 동일한 보조 행동 | 주 실행·위험 행동·설정 폼 전체, 28px 행 안에 편집기 압축 |

Normal과 Compact는 컨테이너 단위로 선택하고 같은 표 안에서 행마다 임의로 섞지 않는다. 28px는 반복 보조 버튼의 예외이며 기본 버튼 규격이 아니다. 직접 터치가 필요한 환경은 최소 44px 조작 영역으로 전환한다. 편집 대사, 안내·오류의 가독성은 밀도 모드와 무관하게 유지한다.

밀도를 높일 때는 먼저 반복 제목·중복 설명·불필요한 wrapper를 제거하고 열 정렬을 맞춘다. 그 다음 간격을 줄인다. 정보 삭제, 가로 스크롤 강제, 아이콘 의미 추측으로 공간을 확보하지 않는다.

## 6. Surface hierarchy와 Color hierarchy

아래 dark 값은 현재 토큰을 재사용하는 출발점이다. PNG의 색을 정확히 샘플링한 팔레트가 아니다. light 모드에는 현재 light 토큰의 동일한 의미를 매핑하며 dark 값을 그대로 반전하지 않는다. 캔버스·원본 이미지·식자·마스크의 색은 UI chrome과 별도다.

| Surface 역할 | 토큰과 dark 기준 | 사용할 때 | 사용하지 않을 때 |
| --- | --- | --- | --- |
| App background | `--trio-bg` #1c1c1e | 앱 프레임·일반 화면 바탕 | 섹션마다 다른 배경으로 장식 |
| Workspace | `--trio-canvas` #171719 | 이미지의 대비를 방해하지 않는 작업 무대 | 모든 폼을 검은 캔버스 표면으로 처리 |
| Panel | `--trio-panel` #242426 | Sidebar·Inspector·편집 구역 | 그룹마다 카드로 중첩; 밝기만으로 계층 무한 증가 |
| Raised surface | `--trio-panel-raised` #303033 | 메뉴·팝오버·국소 hover 및 보조 컨트롤 표면 | 모든 행을 떠 있는 카드로 표현; raised 색만으로 modal 의미 부여 |
| Selected state | `--trio-accent-soft` #293952 + accent 지시선 | 현재 편집 대상의 행·페이지 선택 | 완료·hover·오류를 선택색으로 표현 |

표면의 밝기는 중요도 점수가 아니다. Raised는 공간적 겹침 또는 컨트롤 구분에 쓰며 선택은 독립 상태다. 메뉴 표면과 hover가 같은 색 계열이어도 메뉴에는 경계·위치·포커스가 함께 있어야 한다.

| Color 역할 | 현재 dark 기준 | 사용 / 사용 금지 |
| --- | --- | --- |
| Primary text | `--trio-text` #f5f5f7 | 원문·번역·현재 값·행동 이름 / 모든 설명을 같은 굵기로 강조하지 않음 |
| Secondary text | `--trio-muted` #b9b9c0 | 설명·열 제목 / disabled 의미로 사용하지 않음 |
| Metadata text | `--trio-subtle` #aaaab3 | 개수·시간 / 필수 정보를 읽기 어렵게 흐리지 않음 |
| Accent | `--trio-accent` #8ab4ff, on-accent #10213e | 주 행동·활성 도구·선택 지시·포커스 / 모든 링크 아닌 텍스트·아이콘에 칠하지 않음 |
| Success | #85d6ac, soft #223a2e | 실제 완료 또는 명시적 사용자 확정에 정확한 라벨과 함께 / AI 응답 수신만으로 승인 표시 금지 |
| Warning | #edc17c, soft #3f3322 | 검토 필요·주의 조건 / 아직 작업하지 않은 모든 항목을 경고로 만들지 않음 |
| Error | #ffaaa4, soft #432c2d | 실패·유효하지 않은 입력·위험 행동 / 정상 미설정 상태를 장애로 단정하지 않음 |
| Neutral | muted + 중성 표면 | 대기·미실행·비선택 / 연결 미확인 상태를 성공색으로 표시하지 않음 |

각 상태는 색 외에 텍스트 또는 식별 가능한 아이콘을 동반한다. 작은 상태 점도 접근 가능한 이름과 화면 내 상태 설명 경로를 갖는다. 화면 전체 배경을 성공·실패색으로 채우지 않는다. 선택색과 오류색이 겹치면 행의 선택 배경을 유지하고 오류 아이콘·문구를 독립 슬롯에 둔다.

접근성 설계 목표: 일반 텍스트 대비 4.5:1 이상, 식별에 필요한 컨트롤 경계·포커스 표시 3:1 이상. 장식 구분선은 컨트롤 경계와 구분한다. 이는 이 초안의 인수 기준이며 모든 조합을 검증했다는 뜻이 아니다. 실제 적용 시 light/dark, hover/selection/error 조합과 forced-colors를 검증한다.

## 7. Borders / dividers, Radius, Shadow

| 항목 | 규칙 | 사용할 때 | 사용하지 않을 때 |
| --- | --- | --- | --- |
| Borders | 기본 1px; 입력 경계 `--trio-border` #777780 | 입력 윤곽, 편집 대상, 팝오버 경계 | 카드 안 카드·필드 안 외곽 카드로 이중 테두리 |
| Dividers | 1px `--trio-border-soft` #38383c | 도킹 패널 경계, 관련 행을 가로지르는 읽기 기준, 메뉴 그룹 | 제목 아래 관습적으로 추가; 같은 경계에 양쪽 border 겹침 |
| Focus ring | accent 2px + offset 2px; 레이아웃 크기 불변 | 키보드 포커스와 캔버스 위 조작점 식별 | 선택 border를 포커스 대체로 사용; outline 제거 |
| Radius | 도킹 표면 0, 컨트롤 4, 독립 카드·팝오버 6, dialog 10 | 요소의 종류와 경계를 일정하게 표시 | 작은 컨트롤에 큰 radius, 중첩 표면마다 다른 값 |
| Pill | 999px 예외 | 상태 토큰·카운트처럼 짧고 독립적인 표식 | 모든 버튼·탭·입력에 적용; 읽기 전용 badge를 버튼처럼 보이게 함 |
| Shadow | 고정 표면 none; popover `0 8px 32px rgb(0 0 0 / 20%)`; modal `0 24px 64px rgb(0 0 0 / 24%)` | 콘텐츠 위에 떠 있는 메뉴·대화상자 | 선택·hover·일반 버튼·고정 패널의 장식; glow로 강조 |

패널 사이에는 하나의 divider만 소유시킨다. 표는 필요할 때 수평 구분선만 사용하고 수직 격자는 열 비교가 실제로 어려울 때만 허용한다. 카드의 테두리·다른 배경·그림자를 기본 세트처럼 동시에 적용하지 않는다.

## 8. Interactive states

| 상태 | 시각·행동 규칙 | 사용 / 사용 금지 |
| --- | --- | --- |
| Default | 텍스트·아이콘과 필요한 최소 경계 | 실행 가능한 기본 상태 / 모든 컨트롤 accent 채움 금지 |
| Hover | 국소 중성 표면 변화; 크기·위치 불변 | 포인터가 누를 대상 예고 / 선택 상태를 덮거나 정보를 hover에만 제공 금지 |
| Pressed | 순간적인 명암 변화; 실행 중과 구별 | 누르는 동안 피드백 / scale로 주변 정렬 흔들기 금지 |
| Focus-visible | 2px ring, scroll 영역 안에서 잘리지 않음 | 키보드 조작 대상 / hover가 없어도 유지; 선택과 혼동 금지 |
| Selected / active | 선택 행은 soft 배경+지시선, 도구는 pressed 의미, 탭은 underline | 지속적인 대상·모드 / 단순 hover에 selected 의미 사용 금지 |
| Disabled | 중성화하고 이유를 근처에 제공; 데이터와 설명은 읽을 수 있게 유지 | 충족되지 않은 전제·중복 제출 방지 / 아직 설명하지 않은 행동을 숨기는 수단 금지 |
| Read-only | 정상 텍스트 대비, 편집 불가 설명, 복사·선택 가능 | 원문 보존·잠긴 확정값 / disabled처럼 흐리거나 내용 접근 차단 금지 |
| Busy | 크기 유지, spinner+동사 진행형, 동일 제출 차단 | 실행 중인 범위만 / 전체 화면을 무조건 잠그거나 성공으로 선표시 금지 |
| Invalid | 오류 경계+구체적 문구, 입력 보존 | 실제 검증 실패 / 필수값을 아직 입력하지 않았다는 이유로 첫 진입부터 붉게 채우기 금지 |

상태 조합: 선택 배경은 유지하고 hover는 미세하게 보강한다. focus ring은 선택·오류와 함께 남긴다. 오류는 별도 아이콘·문구로 표현하고 busy도 기존 오류 문맥을 지우지 않는다. 숨긴 컨트롤은 Tab 순서에서도 제외하되 focus-within에서는 보조 행동을 노출한다. disabled 사유는 비활성 요소의 tooltip만으로 전달하지 않는다.

전환은 색·opacity 중심 150ms, 패널 최대 200ms를 기본으로 한다. reduced-motion에서는 불필요한 전환을 제거한다. 상태 변화를 반복 점멸·맥박·자동 움직임으로 계속 강조하지 않는다.

## 9. 기본 컴포넌트

### Icons

- 규격: 컨트롤 16px, 주요 탐색 18px, 독립 상태 설명 최대 20px. 기존 아이콘 계열을 유지하고 선 굵기는 1.5~2px 범위에서 통일한다. 아이콘 크기와 클릭 영역 크기는 별개다.
- 사용: 확대·복사·더보기처럼 익숙한 행동, 텍스트와 함께 상태를 빠르게 찾는 보조 단서. 아이콘 전용 버튼에는 접근 가능한 이름과 tooltip을 제공한다.
- 금지: 모호한 OCR 적용·사용자 확정·재실행을 아이콘만으로 표현, emoji를 기능 아이콘으로 사용, 반복 행마다 장식 아이콘 추가. 새 라이브러리 도입은 별도 판단이다.

### Buttons

- 규격: normal 36, compact 32 높이; label 13/20/500, radius 4, 가로 패딩 12, 아이콘 간격 8. 텍스트 확대 시 min-height를 기준으로 증가한다.
- Primary는 현재 작업 완료에 사용한다. Secondary는 취소·대체 행동, tertiary는 낮은 빈도의 보조 행동이다. 선택 도구는 toggle 상태로 나타내며 실행 CTA와 구분한다.
- Destructive는 실제 삭제·되돌릴 수 없는 손실에만 쓴다. 오류 재시도를 빨간 버튼으로 만들지 않는다. 기존 확인 절차를 스타일 변경으로 없애지 않는다.
- 버튼 문구는 `적용`, `선택 항목 재시도`처럼 대상과 행동을 설명한다. 제출 중 너비를 유지하고 중복 실행을 막는다. 모든 행에 primary 버튼, label 생략, 비활성화 이유 누락은 금지한다.

### Inputs

- 규격: normal 최소 36, compact 최소 32, radius 4, 가로 패딩 8~12. 대사 textarea는 14/24와 최소 3줄을 출발점으로 하며 내용·가용 높이에 맞게 확장 또는 내부 스크롤한다.
- 사용: 사용자가 값을 직접 작성·수정하는 곳. visible label → 입력 → 도움말/오류 순서로 정렬한다. 원문과 번역은 같은 기준선을 갖고 번역 편집 영역을 우선 확보한다.
- 금지: placeholder-only label, 편집값 말줄임, 매 키 입력마다 강한 오류 표시, 실패 시 초안 초기화. 입력 내부 아이콘은 실제 동작이나 검증 의미가 있을 때만 둔다.

### Selects

- 규격: input과 높이·radius 일치, 오른쪽 chevron 슬롯 16 + 가장자리 여백 8. 긴 선택값을 위한 충분한 폭 또는 전체 값 확인 경로를 확보한다.
- 사용: 화자·유형처럼 유한한 단일 선택. 긴 목록은 검색 가능한 선택 패턴을 별도 적용하되 현재 값과 미선택을 구분한다. 기본 native select의 키보드·플랫폼 동작을 우선 보존한다.
- 금지: `번역 실행` 같은 행동을 값 목록으로 위장, 짧은 선택값에도 검색 UI 강제, 현재 선택값을 placeholder처럼 흐리게 표시. 세 필드를 한 줄에 넣을 수 없으면 다음 행으로 재배치한다.

### Tabs

- 규격: 최소 높이 36, label 13/20/500, 좌우 12, 활성 underline 2px. 기본은 평평한 탭이며 각 탭을 별도 카드로 만들지 않는다.
- 사용: 같은 작업 문맥에서 상호 배타적인 콘텐츠 패널 전환. 활성 label·underline과 selected 의미를 함께 제공한다. 방향키/Home/End 및 패널 진입 규칙을 일관되게 유지한다.
- 금지: 실행 명령·완료 단계·상태 badge를 탭처럼 표현. 전환 시 비동기 실행이나 초안 폐기를 암묵적으로 유발하지 않는다. 숨은 패널은 키보드 탐색에서 제외한다.

## 10. 작업대 구성 요소

### Toolbar

- 규격: compact 버튼 32, 바 최소 40, 내부 패딩 4~8; 도구 간 4, 그룹 간 12. 라벨·아이콘 기준선을 맞춘다.
- 사용: 상단에는 프로젝트·작업 단계, 캔버스 주변에는 이동·확대·레이어처럼 대상 범위가 분명한 도구를 둔다. 전역·페이지·선택 대사 범위를 이름이나 그룹으로 식별한다.
- 금지: 같은 명령을 여러 바에 중복 강조, 확대율과 처리 진행률을 같은 의미로 표시, 툴바 전체를 카드로 둘러싸기. 좁은 폭에서는 낮은 빈도의 행동을 overflow로 옮기되 현재 도구·주 실행·취소는 유지한다.

### Sidebar

- 규격: 열린 페이지 탐색 폭 208~260을 설계 출발점으로, 내부 패딩 12. 일반 탐색 행 최소 36, 썸네일 행 최소 72 + 내용 여유. 현재 구현의 리사이즈·접힘 가능 범위를 우선한다.
- 사용: 프로젝트 내 페이지 순서와 선택, 페이지별 진행을 빠르게 훑는 곳. 썸네일·페이지 번호·작업 수·상태 슬롯을 고정 정렬한다. 현재 페이지는 soft 배경+지시선으로 연결한다.
- 금지: 모든 썸네일 행에 카드 border, 미선택 페이지 흐림으로 식별성 감소, 페이지 탐색에 전역 환경 설정 상세를 섞기. 접으면 현재 페이지와 다시 여는 행동을 남긴다.

### Inspector

- 규격: 폭 320~440을 시작점으로, padding 12, 섹션 간격 16. 원문·번역의 가로 병렬은 각 편집 영역에 최소 220px를 확보할 수 있을 때만 사용하고 그 외에는 세로로 쌓는다.
- 사용: 선택 대상 이름·위치 → 원문/번역 → 화자·유형 등의 속성 → 검토 상태·행동 순서. 현재 페이지·영역과 Inspector 대상이 일치함을 지속적으로 보여준다. 선택 대사의 전체 내용은 여기서 확인한다.
- 금지: 필드마다 카드, 프로젝트 설정과 선택 항목 속성 혼합, 선택되지 않은 이전 항목을 현재 편집 대상처럼 유지. 기존 초안 보존·stale-result 방어 계약을 바꾸지 않는다.
- 검토 목록을 함께 배치할 경우 목록은 탐색, Inspector는 전체 편집 역할로 구분한다. 참고 이미지처럼 동일한 상태 선택기를 위아래 반복할 필요는 없다. 현재 값과 편집 행동을 한곳에 모은다.

### List rows

- 규격: 단일 행 normal 36/compact 32, 두 줄 행 최소 48; 가로 padding 8~12, 열 gap 8. 썸네일 목록은 Sidebar 규격을 따른다.
- 사용: 대상 하나를 선택·열어보는 탐색. 이름을 중심에 두고 metadata와 보조 행동은 정해진 위치에 배치한다. 선택·키보드 포커스·작업 상태를 구별한다.
- 금지: 모든 행을 독립 카드로 부각, 보조 행동 클릭이 행의 열기·선택을 함께 실행, 선택 표시를 색 점 하나에만 의존. hover 보조 버튼은 focus-within에서도 나타나고 폭을 미리 확보한다.

### Table rows

- 규격: header 최소 32, body normal 36/compact 32; 셀 좌우 8, 내용 13/20. 여러 줄 검토 행은 높이를 늘린다. 숫자는 우측 정렬, 원문·번역·상태는 일관된 열로 유지한다.
- 사용: 대사별 원문·번역·유형·검토 상태를 비교할 때. 행 번호는 약하게, 현재 선택 행은 soft 배경, 오류는 해당 상태 셀에서 표시한다. 열 제목과 정렬 방향을 명시한다.
- 금지: 행마다 카드 radius·그림자, 모든 셀을 input처럼 테두리 처리, 색상만 있는 상태 열, 공간 부족을 이유로 원문 또는 오류 열 제거.
- 긴 값은 목록 미리보기에서만 축약하고 선택하면 전체 내용을 제공한다. 표 자체의 가로 스크롤 또는 사용자가 선택한 열 구성을 사용하되 식별자·현재 상태는 보존한다. 실제 표와 editable grid의 키보드 모델을 혼용하지 않는다.

## 11. 상태와 보조 표면

### Status indicators

- 규격: 점 8px 또는 의미 아이콘 16px + label 12/18~13/20. 반복 행은 작은 표식, 현재 항목과 요약에는 텍스트를 함께 둔다.
- 사용: 실행 대기·실행 중·실패, 사용자 검토 상태, 저장 상태를 각각 자신의 위치에 표시한다. `ai_proposed`는 제안, `user_modified`는 사용자 수정, `user_confirmed`는 사용자 확정이라는 의미를 보존한다.
- 금지: API 응답·QA 통과·최종 승인·저장 완료를 하나의 녹색 점으로 합치기. `처리 완료 · 검토 필요`, `사용자 확정 · 저장 중`처럼 독립 상태를 함께 설명할 수 있어야 한다. 취소를 오류로, 미실행을 실패로 표현하지 않는다.

### Badges

- 규격: 12/18, 가로 padding 6, 세로 2, radius 4 또는 count/status pill. 기본은 중성·낮은 채도다.
- 사용: 필터 결과 수, 예외 상태, 대사의 종류처럼 짧은 분류. 대상 가까이에 배치하며 읽기 전용인지 클릭 가능한 필터인지 구별한다.
- 금지: 본문 문장·긴 설명을 badge에 넣기, 모든 metadata에 색 badge, 한 행에 중복 상태 badge 나열. 개수는 0의 의미를 숨기지 않고 변화 시 레이아웃을 흔들지 않는다.

### Progress

- 규격: track 4px, 상세 진행은 최대 6px; 인접한 단계 이름·완료 수/전체 수·취소 행동. spinner는 16px로 실행 위치에 제한한다.
- 사용: 전체량이 알려지면 determinate, 알려지지 않으면 단계 문구+indeterminate. 페이지별 성공·실패·건너뜀은 별도 수로 보존한다.
- 금지: 추정치를 확정 백분율로 표현, 100%를 사용자 승인으로 해석, 모든 행에 spinner. 이미지의 글자 수 게이지는 작업 진행률이 아니며 `15 / 40자` 같은 용량 정보로 표시한다. 제한 근접·초과 때만 경고한다.

### Tooltip

- 규격: 12/18, padding 8, 최대 폭 280, radius 6, raised+popover shadow. hover 약 500ms 이후, keyboard focus에서도 제공한다.
- 사용: 아이콘 이름·단축키·보조 설명. 대상 옆에 배치하고 화면 경계를 피하며 Escape로 닫는다. 포인터가 tooltip으로 이동할 때 읽을 시간을 보장한다.
- 금지: 필수 label·오류 원인·비활성 사유의 유일한 전달 경로, 내부에 버튼·폼 배치. 상호작용 콘텐츠는 popover로 구분한다.

### Context menu

- 규격: 최소 폭 192, 항목 최소 높이 32, padding 4, radius 6. 관련 행동 그룹 사이에만 divider를 둔다.
- 사용: 현재 페이지·대사의 낮은 빈도 보조 행동. 우클릭 외 더보기 버튼·키보드 경로를 제공하고 대상 이름·선택 범위를 명확히 한다. 방향키 이동, Enter 실행, Escape 닫기, 호출 위치로 포커스 복귀를 제공한다.
- 금지: 핵심 실행·필수 복구 행동을 여기서만 제공, 메뉴 열기만으로 대상을 수정, 모든 항목에 아이콘. 삭제는 마지막 그룹에 두고 필요한 기존 확인을 유지한다.

### Dialog

- 규격: 기본 폭 480, 검토 비교는 840을 출발점으로 가용 폭 이내; padding 24, radius 10, modal shadow, backdrop 40%. 높이는 viewport 내부 스크롤을 허용한다.
- 사용: 작업을 잠시 중단해야 하는 명시적 결정, 데이터 손실 확인, 범위가 정해진 설정. 제목 → 결과·영향 설명 → 필요한 입력 → 행동 순서를 따른다.
- 금지: 일반 탐색·상태 안내·단순 성공 알림, 연쇄 모달, 배경 변경을 숨기는 용도. focus trap·호출자로 복귀·접근 가능한 제목을 제공한다. Escape/바깥 클릭은 기존 미저장 보호 정책을 따르며 초안을 조용히 폐기하지 않는다. 위험 확인은 안전한 초기 포커스를 둔다.

### Empty state

- 규격: 현재 영역 안에 16/24 제목, 14/22 설명, 다음 행동 하나를 중심으로 padding 24~32. 작은 Inspector는 12~16으로 축소한다.
- 사용: 최초 시작은 `이미지 추가`, 선택 없음은 `대사를 선택하세요`, 검색 결과 없음은 `필터 초기화`처럼 서로 다른 원인과 다음 행동을 제공한다. 필수 전제가 있으면 먼저 설명한다.
- 금지: 로딩·실패를 빈 상태로 표시, 작은 패널을 큰 일러스트로 채우기, 기존 페이지·필터·선택 문맥 제거. 전체 앱을 비우지 않고 해당 영역만 안내한다.

### Loading state

- 규격: 짧은 동작은 해당 버튼의 busy, 체감 지연 약 300ms 이상이면 안정적인 영역의 skeleton 또는 진행 문구. 알려진 레이아웃을 유지하고 shimmer는 기본 사용하지 않는다.
- 사용: 초기 데이터 로드 또는 기존 데이터 갱신. 갱신 중에는 기존 콘텐츠를 보존하고 현재 값이 갱신 중임을 표시한다. 장기 실행은 단계·취소·재시도를 실제 가능 범위에 맞게 제공한다.
- 금지: 이미 읽을 수 있는 콘텐츠를 매번 skeleton으로 교체, 로딩 중인 다른 페이지 결과를 현재 페이지에 표시, 무한 spinner만 남기기. timeout·실패로 전환될 때 원인과 복구 경로를 둔다.

### Error state

- 규격: 해당 위치의 error 아이콘+13/20 문구, 필요한 입력 경계; 넓은 오류 영역도 중성 표면에 국소 의미색만 쓴다.
- 사용: 무엇이 실패했는지 → 보존된 작업과 영향 → 가능한 다음 행동 순서. 필드 오류는 필드 아래, 페이지 작업 실패는 그 작업 패널, 앱 전체를 사용할 수 없는 오류만 전역 표면에 둔다.
- 금지: 정상 미설정을 빨간 전역 배너로 표시, 초안·이미지 제거, 실제로 불가능한 재시도·취소 버튼, raw stack·키·민감 경로 노출. 여러 행의 실패는 그룹 요약과 개별 상세를 연결하고 toast를 연속 발사하지 않는다.

## 12. 일관된 적용 예시

**대사 검토:** 조밀한 표에 번호·원문·번역·유형·상태를 정렬한다. 한 행만 선택 강조하고 원문·번역의 전체 편집은 Inspector에서 제공한다. 비선택 행도 읽을 수 있다. 모든 행의 복사·확정·재실행을 강조 버튼으로 늘어놓지 않는다. 현재 대상의 확정 행동과 관련 오류는 숨기지 않는다.

**AI 설정:** 섹션 제목과 SettingsRow 정렬로 provider·model·연결 상태를 묶는다. 필드마다 카드를 만들지 않는다. 키 저장, 연결 확인, 모델 접근, 기능 실행의 증거를 각각 정확한 문구로 구분한다. 설정값이 존재한다는 이유로 `사용 가능` 성공색을 표시하지 않는다.

**페이지 목록:** 동일한 크기 슬롯에 썸네일·번호·metadata·상태를 배치한다. 현재 페이지만 선택 지시를 갖는다. 실패한 페이지는 오류 표식과 상세 경로를 유지한다. 페이지가 많아져도 상태를 없애는 대신 반복 장식을 줄인다.

**좁은 작업대:** 먼저 낮은 빈도 행동을 overflow로, 병렬 필드를 세로로 옮긴다. 그 다음 기존 패널 접힘 기능을 사용한다. 현재 대상·작업 취소·오류·편집 중 초안은 접근 가능하게 남긴다. 글자를 줄여 3열을 강제하거나 원본 이미지를 읽을 수 없는 크기로 만들지 않는다.

## 13. 향후 UI 변경의 리뷰 기준

다음은 이 초안을 실제 UI에 적용할 때의 확인 항목이다. 이번 문서 작업에서 실제 화면 검증을 완료했다는 의미가 아니다.

1. 현재 대상·주 행동·조치할 오류를 즉시 식별할 수 있는가? 그 외 정보도 필요할 때 읽을 수 있는가?
2. 카드·border·색·shadow·radius 하나하나에 기능적 이유를 설명할 수 있는가? 정렬·간격으로 해결되는 중첩 장식이 남아 있는가?
3. Normal/Compact에서 같은 내용과 상태 의미가 보존되는가? 12px 미만 글자나 잘린 오류로 밀도를 확보하지 않았는가?
4. selected+hover, selected+focus, selected+error, busy+이전 결과 조합을 각각 구분할 수 있는가?
5. 키보드만으로 필수 행동·더보기·전체 텍스트에 접근하고, 메뉴·dialog 닫기 후 문맥으로 돌아오는가?
6. 한글·일본어·긴 이름·다중 행 대사와 200% 글자 확대에서 내용·주 행동이 잘리지 않는가?
7. 넓은 1440×900, 표준 1280×720, 제한된 1024×640 작업대에서 패널 접힘·스크롤·툴바 overflow가 서로 충돌하지 않는가? 이 크기는 리뷰 시나리오이며 새 배포 지원 계약이 아니다.
8. light/dark와 forced-colors에서 텍스트·입력·포커스·오류가 식별되는가? UI 테마가 원본 이미지와 마스크 의미색을 변경하지 않는가?
9. AI 제안·사용자 수정·사용자 확정, 실행 결과·QA·승인, 저장 중·저장 완료가 분리되어 있는가?
10. 로딩·빈 상태·실패·취소·부분 성공을 구분하고, 프로젝트·페이지 전환 후 이전 결과가 현재 성공처럼 나타나지 않는가?

새 UI를 설계할 때 먼저 역할과 정보 구조를 정하고, 이 문서에서 typography → density → surface → component → state 순서로 선택한다. 기존 토큰과 공통 컴포넌트를 우선 매핑하고, 필요한 새 값·예외는 사용 이유와 영향을 기록한 뒤 별도 구현 범위에서 검토한다. 이미지 모사를 위해 화면별 임의 스타일을 추가하지 않는다.

---

# 과거 설계 참고 — Design System - Manga Translation Editor

아래는 기존 문서를 보존한 기록이다. 과거 단계·명령·예시 상태는 현재 실행 지시나 구현 완료 증거가 아니다. 최신 시각 규칙 초안은 위 내용을 참조하고 실제 동작은 현재 코드·테스트와 적용 AGENTS.md로 확인한다.

## Product Context

- What this is: A Windows desktop manga/dialogue translation editor for page images, OCR review, inpainting, speaker correction, and line-by-line translation editing.
- Who it is for: A single power user translating manga pages with frequent visual inspection, OCR correction, speaker assignment, and text editing.
- Reference direction: Bandiview is the primary interaction reference for a large, fast, unobstructed image viewer. `manga-trans` remains a secondary workflow reference. Trio does not copy either product's colors or component styling.
- Project type: Dense productivity app, not a marketing site.

## Design Goal

The app should feel like an image-centered manga workbench. The page image is the primary object. File management, project context, OCR review, inpainting, and line editing are supporting tools that open around the image instead of permanently taking equal space.

## Core Principles

- Image first: the manga page gets the largest visual area on supported Windows desktop sizes.
- Tools on demand: settings, context, detail editing, OCR review, and inpainting live in collapsible panels.
- No fixed 3-column trap: the user can collapse side panels and keep the image readable.
- Fast review loop: keyboard and panel flows should support page/OCR review without hunting through sidebars.
- Human review owns the answer: AI proposes OCR, type, speaker, translation, typesetting, and inpainting, while user-confirmed values remain locked.
- Analysis and output stay separate: source OCR regions, containers, safe areas, preserve regions, and final Korean typesetting boxes are distinct objects and overlays.
- Existing behavior stays intact: no storage schema, IPC, dialogue type, OCR result, or inpainting API changes for this redesign unless separately approved and covered by tests.

## Target Layout

```text
TopAppBar
|-- file actions: new, open, save, save as, export
|-- project state: current file, dirty/saved status, current page
|-- primary tools: image connect, OCR, inpainting, guide/settings
|-- compact runtime status and original/result comparison controls

Workspace
|-- LeftRail / LeftDrawer: pages, project context, guide, settings
|-- ImageCanvas: central manga page viewer/editor stage
|-- RightInspector: selected line, OCR review, inpainting, empty state
`-- BottomLinePanel: dialogue lines, OCR candidates, issue list
```

## Visual Direction

- Aesthetic: restrained manga-reader workbench.
- Image stage: dark neutral canvas so page art has priority.
- App chrome: dark or low-contrast neutral panels with compact controls so bright panels do not compete with the page.
- Accent: use blue only for primary action, selected line, and active tool states.
- Borders: thin and functional; avoid stacked card borders where layout alone can separate areas.
- Density: compact, but text must remain readable. Prefer fewer always-visible controls over smaller controls.
- Shape: use 2-4px corner radii for tool surfaces; avoid large floating cards, gradients, glassmorphism, and dashboard styling.

## Typography

- Use the current Windows-friendly UI typography for v1 to avoid introducing new font dependencies.
- Table/data text should be compact and legible.
- Avoid hero-scale text. This is a production tool.
- Use visible labels, not placeholder-only labels.

## Component Plan

### TopAppBar

Move global project actions out of the left panel.

- Shows app name.
- Shows current file path or `선택된 프로젝트 파일이 없습니다`.
- Shows saved/dirty status.
- Contains `새 프로젝트`, `열기`, `저장`, `다른 이름`, `내보내기`.
- Contains compact page controls: previous, `current / total`, next.
- Contains primary image tools: image connect, OCR, inpainting.
- Contains compact model/runtime status; detailed installation management opens the separate environment-preparation screen.
- Contains layer and comparison controls without changing the current viewport transform.

### ImageCanvas

Promote `PageImagePanel` into the main workspace.

- Empty state uses strong central CTA copy, not a passive dark box.
- Image-present state keeps the page centered and readable.
- Image load error offers a clear reconnect action.
- Image toolbar remains available but visually secondary to the page.
- Original, inpainted, and translated views share one viewport transform.
- OCR, balloon, safe-area, typesetting, mask, preserve, and issue overlays use semantic line styles and labels.
- Selected overlay objects can be moved, resized, or otherwise edited directly on the page when the current stage permits it.

### BottomLinePanel

Move `DialogueTable` to a bottom panel.

- Header includes `대사`, line count, and collapse toggle.
- Default open on desktop.
- Collapsed state keeps a small status strip visible.
- Future tabs: `대사`, `OCR 후보`, `문제 라인`.

### RightInspector

Unify side work surfaces.

- `line-detail`: selected dialogue line editor.
- `ocr-review`: OCR review/apply surface.
- `inpainting`: inpainting controls and return action.
- `empty`: no selected line or active tool.
- Panel can be closed without losing the current page.

### LeftRail / LeftDrawer

Replace the always-wide left panel with a narrow navigation rail plus drawer.

- Rail buttons: `페이지`, `문맥`, `가이드`, `설정`.
- Pages drawer can start as page number/status list.
- Context drawer hosts character and dictionary tools.
- Guide drawer hosts image import workflow guidance.
- Settings drawer hosts project title/secret/Gemini key controls.

## Workspace State Model

```ts
type WorkspaceMode = "viewer" | "edit" | "ocr-review" | "inpainting";
type LeftPanel = "pages" | "context" | "guide" | "settings" | null;
type RightPanel = "line-detail" | "ocr-review" | "inpainting" | null;
type BottomPanel = "dialogue" | "ocr-candidates" | "issues" | null;
type ResultLayer = "original" | "inpainted" | "translated";
type ComparisonMode = "single" | "split" | "reveal" | "opacity";
```

Initial state:

```ts
workspaceMode = "viewer";
leftPanel = null;
rightPanel = null;
bottomPanel = "dialogue";
```

State transitions:

- Selecting a line opens `rightPanel = "line-detail"` and `workspaceMode = "edit"`.
- OCR completion opens `rightPanel = "ocr-review"` and `bottomPanel = "ocr-candidates"`.
- Inpainting opens `rightPanel = "inpainting"` or an image-stage tool panel.
- Escape or close returns to the previous stable viewer/edit state.
- Selecting an issue changes page, centers the affected region, selects its overlay, and opens the matching inspector unless the inspector is pinned.
- Editing creates an auto-saved user draft; only an explicit confirmation changes it to user-confirmed and AI-protected.
- Result-layer and comparison-mode changes preserve page, zoom, pan, selection, and panel state.

## Implementation Phases

### Phase 0 - Baseline

- Capture supported Windows desktop screenshots at wide, standard, and compact widths.
- Record current dirty state.
- Run current renderer regression tests before layout work.

### Phase 1 - Layout Shell

- Introduce the app-frame structure in `App.tsx`.
- Add top app bar, left rail/drawer, central workspace, right inspector, and bottom panel containers.
- Keep existing components mounted; move placement only.

### Phase 2 - Top App Bar

- Move file/project actions into the top bar.
- Keep existing handler functions and disabled policies.
- Keep project title/secret/API key in settings drawer.

### Phase 3 - Image Canvas

- Make image canvas the largest desktop region.
- Improve image empty state CTA.
- Keep OCR, inpainting, reconnect, fit, and actual-size behavior intact.

### Phase 4 - Bottom Line Panel

- Move `DialogueTable` into the bottom panel.
- Add collapse/open state.
- Keep filtering, selected line sync, and line editing behavior intact.

### Phase 5 - Right Inspector

- Move `LineDetailPanel` into the right inspector.
- Keep OCR review modal functional in v1, then optionally embed into right inspector in a later pass.
- Keep inpainting close/return behavior intact.

### Phase 6 - Left Rail / Drawer

- Move guide/context/settings into drawer tabs.
- Keep all existing forms and actions.
- Do not add thumbnail generation in this phase.

### Phase 7 - Responsive Layout

- 1440px and wider: app bar + pages + canvas + inspector + bottom panel may be visible together.
- 1200-1439px: pages collapse first while the canvas, inspector, and bottom panel remain available.
- 1024-1199px: only one auxiliary panel opens at a time and never covers the image stage.
- Below 1024px: image viewing remains available, while precision editing asks the user to enlarge the window.

### Phase 8 - Regression and Visual QA

- Run typecheck, full tests, build.
- Capture screenshots at 1440x900, 1280x720, and 1024x640, including Windows scaling at 100%, 125%, and 150%.
- Verify image import, OCR review modal, speaker candidate selection, inpainting return, and apply flows.

## Test Plan

- Top app bar renders global file actions.
- Image connect keeps current disabled rules before project save.
- Empty image canvas shows clear image CTA.
- Dialogue table is in the bottom panel.
- Bottom panel can collapse and reopen.
- Selecting a line opens the right inspector.
- Existing line detail editing still updates selected line.
- Existing OCR review apply flow still creates dialogue lines.
- Existing inpainting apply flow still replaces the page image.
- Compact desktop layout preserves a usable image stage and never clips the primary action.
- Original/result comparison preserves zoom, pan, current selection, and overlay alignment.
- Selecting an issue performs the page/viewport/selection/inspector transition as one operation.

## Acceptance Criteria

- The first desktop viewport is dominated by the page image area.
- File actions live in the top app bar.
- Left-side content is no longer a permanently wide settings column.
- Dialogue lines appear in a bottom work panel and can be collapsed.
- Detail editing appears in a right inspector.
- All existing renderer tests pass after migration.
- `npm run typecheck`, `npm test`, and `npm run build` pass.

## Decisions Log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-07-09 | Use manga-trans as interaction reference, not a full clone | The app needs image-first speed, but still has editor-grade OCR, speaker, and inpainting workflows. |
| 2026-07-09 | Keep IPC and storage schemas unchanged | This is a layout redesign, not a data model change. |
| 2026-07-09 | Move toward collapsible panels before adding persisted panel sizes | Reduces layout rigidity with lower implementation risk. |
| 2026-07-13 | Apply Torii's contextual-action principle to desktop entry | One primary action is shown for the current work state. |
| 2026-07-13 | Keep save secondary during translation | Save state is communicated by a badge so it does not compete with completing the current line. |
| 2026-07-13 | Keep TXT import and project save separate | Import updates the in-memory project; explicit save preserves existing storage behavior. |
| 2026-07-13 | Exclude smartphone-specific layout work | The target is a Windows desktop workbench. |
| 2026-08-03 | Use Bandiview as the primary interaction reference | The desired behavior is an unobstructed, immediate image viewer combined with contextual professional review tools. |
| 2026-08-03 | Keep installation outside the image workbench | A separate environment-preparation screen prevents downloads and recovery UI from covering the page. |
| 2026-08-03 | Use one synchronized canvas for all comparisons | Layer and comparison changes must preserve zoom, pan, selection, and page context. |
| 2026-08-03 | Put OCR exceptions in a bottom queue with contextual editing | One selection navigates to the page and region and opens the correct inspector unless it is pinned. |
| 2026-08-03 | Separate AI proposals from user confirmation | User edits auto-save as drafts; explicit confirmation locks them against AI overwrite. |
| 2026-08-03 | Adopt the detailed three-surface plan | See `docs/superpowers/plans/2026-08-03-install-compare-ocr-review-design-plan.md`. |

## Remaining UX Roadmap - Bandiview Interaction + Specialist Workbench

### Reference Observations

The current implementation roadmap below originally used `manga-trans` as a workflow reference. As of 2026-08-03, Bandiview-style image viewing is the primary interaction reference and the dedicated installation/comparison/OCR design plan is authoritative when the documents differ.

Verified secondary reference on 2026-07-09:

- `izure1/manga-trans` presents itself as a viewer program for Japanese manga images translated to Korean.
- Its core user loop is deliberately short: open an image, press Space, see translated text over the image.
- Translation is off by default so plain image viewing does not waste CPU or memory.
- It supports multiple OCR/translation paths: built-in Windows OCR, optional Manga-OCR, Google Translate, and ezTrans.
- Release `v1.1.0` adds archive-file viewing, page-count configuration for pre-translation, and web-page image translation.
- Release `v1.1.0` also fixes real viewer/editor problems: lingering process cleanup, deleting all translated speech-bubble text, and translated text being covered by speech bubbles.

Design implication for this app:

- Copy the interaction philosophy, not the product scope.
- Our app is not just a translation viewer; it is a page OCR, correction, speaker assignment, inpainting, and dialogue editing workbench.
- The main workflow should still feel like `image -> action -> visible result`, with editing panels appearing only when the user needs them.

### Current Gap Inventory

| Area | Current State | Gap | Priority |
| --- | --- | --- | --- |
| App entry | Project editor can open with settings/import controls competing with the image in a compact window | User does not immediately feel "open page image and work" | High |
| Left rail | Rail buttons are visible | Buttons do not yet switch drawer content or collapse drawer | High |
| Image stage | Page image is central after 1st layout pass | Tool state is still embedded in `PageImagePanel`; no dedicated viewer/action mode | High |
| OCR review | Review still opens as modal | Good for safety, but it interrupts the image-first work surface | High |
| Inpainting | Editor opens inside image panel and can return | Tool is not yet modeled as a workspace mode with persistent stage controls | High |
| Bottom panel | Dialogue table is moved and collapsible | No tabs yet for dialogue, OCR candidates, issues | Medium |
| Right inspector | Line detail and project context share the right side | Inspector does not yet switch by active task | Medium |
| Keyboard flow | Existing row shortcuts exist, but global viewer shortcuts are not formalized | No Space-driven manga-trans-style quick action | Medium |
| EXE validation | Browser/gstack validation exists | Packaged Windows app validation is not yet a first-class checklist | Medium |
| Web/archive import | Not currently supported | Useful reference from manga-trans, but out of scope without new import/storage decisions | Low |

### North Star Workflow

The desired default loop:

```text
Open/saved project
  -> connect images
  -> page image dominates the screen
  -> press/click OCR
  -> OCR candidates appear beside/below the page
  -> user corrects text and speaker quickly
  -> apply candidates to dialogue lines
  -> edit selected line in inspector
  -> optional inpaint on the same page stage
  -> save
```

The user should rarely need to hunt in permanent sidebars. The interface should answer:

- What page am I on?
- Is the image loaded?
- What is the next likely action?
- What text/speaker candidate is being reviewed?
- What will be applied if I press Apply?
- How do I return to image view?

## Phase 9 - Workspace State and Panel Switching

Goal: make the new shell behave like a real workbench instead of static regions.

### Target Behavior

- Left rail buttons switch visible drawer content:
  - `페이지`: page list/status/import hints.
  - `문맥`: character dictionary and user dictionary.
  - `가이드`: image import/OCR/inpainting guide.
  - `설정`: project title, secret flag, Gemini API key, file status.
- Drawer can collapse to rail-only.
- Right inspector switches by active task:
  - selected line -> line detail.
  - OCR review active -> OCR review.
  - inpainting active -> inpainting controls.
  - nothing selected -> compact empty state.
- Bottom panel switches by active list:
  - dialogue lines.
  - OCR candidates.
  - issue lines.

### Files

| File | Planned Change |
| --- | --- |
| `src/renderer/App.tsx` | Add `leftPanel`, `rightPanel`, `bottomPanel`, `workspaceMode` state and transitions. |
| `src/renderer/components/ProjectActionsPanel.tsx` | Keep settings-only role when rendered inside settings drawer. |
| `src/renderer/components/CharacterDictionaryPanel.tsx` | Move to context drawer or inspector context tab depending on selected rail. |
| `src/renderer/styles.css` | Add drawer collapsed/open states, active rail styles, inspector mode styles. |
| `tests/renderer/App.test.tsx` | Add rail switching, drawer collapse, inspector mode tests. |

### State Model

```ts
type WorkspaceMode = "viewer" | "line-edit" | "ocr-review" | "inpainting";
type LeftPanel = "pages" | "context" | "guide" | "settings" | null;
type RightPanel = "line-detail" | "ocr-review" | "inpainting" | null;
type BottomPanel = "dialogue" | "ocr-candidates" | "issues" | null;
```

State rules:

- `leftPanel` defaults to `"pages"` at wide desktop widths and `null` in compact desktop mode.
- Clicking the active rail item toggles `leftPanel` to `null`.
- Selecting a dialogue line sets `workspaceMode = "line-edit"` and `rightPanel = "line-detail"`.
- Opening OCR review sets `workspaceMode = "ocr-review"`, `rightPanel = "ocr-review"`, `bottomPanel = "ocr-candidates"`.
- Opening inpainting sets `workspaceMode = "inpainting"`, `rightPanel = "inpainting"`, keeps `bottomPanel` unchanged.
- Closing OCR/inpainting returns to the previous stable mode: selected line if any, otherwise viewer.

### Tests First

- Rail buttons render with correct pressed state.
- Clicking `문맥` shows character dictionary and hides project settings.
- Clicking active `문맥` collapses drawer.
- Selecting a line opens right inspector line detail.
- Opening OCR review switches bottom panel to OCR candidates.
- Opening inpainting switches right inspector to inpainting controls.
- Closing inpainting returns to page image view without losing selected line.

### Acceptance Criteria

1. No rail button is decorative; each changes visible UI state.
2. Drawer collapse never hides the image stage.
3. Existing file actions, image import, OCR, inpainting, and line edit handlers stay unchanged.
4. `npm run typecheck`, `npm test -- tests/renderer/App.test.tsx`, and `npm run build` pass.

## Phase 10 - Image-First Entry and Quick Action Loop

Goal: make the app feel closer to manga-trans: open/view first, then invoke heavy work only when requested.

### Target Behavior

- Empty project state shows a clear "start here" strip near the image stage:
  - `TXT 불러오기`
  - `프로젝트 저장`
  - `이미지 연결`
  - `말풍선 OCR`
- If a project is saved and images are missing, primary CTA is image connection.
- If an image is loaded, primary CTA becomes OCR.
- Heavy OCR/inpainting actions remain idle until clicked or shortcut-triggered.
- Add a small quick-action hint near the image stage:
  - `Space: OCR 검토 열기` when image is available and OCR review is closed.
  - `Esc: 현재 작업 닫기` when OCR/inpainting is active.

### Important Constraint

Do not add a direct "open arbitrary image without project" mode in this phase. That would bypass current project asset storage rules and likely needs a new temporary-project or unsaved-image policy. If direct image-open is wanted later, write a separate storage/IPC design first.

### Files

| File | Planned Change |
| --- | --- |
| `src/renderer/components/PageImagePanel.tsx` | Add contextual primary CTA state and shortcut hint copy. |
| `src/renderer/App.tsx` | Add guarded keyboard handler for Space/Escape. |
| `src/renderer/styles.css` | Add quick-action strip and image-stage CTA styling. |
| `tests/renderer/App.test.tsx` | Add Space/Escape behavior and disabled-state tests. |

### Shortcut Rules

- Space does not trigger OCR while focus is inside input, textarea, select, or contenteditable.
- Space triggers OCR only when:
  - current page image exists,
  - current project file path exists,
  - OCR is not already running,
  - inpainting editor is not active.
- Escape closes OCR review or inpainting if one is active.
- Escape does not clear edited text in focused fields.

### Tests First

- Pressing Space with image loaded calls speech bubble OCR.
- Pressing Space in a textarea does not call OCR.
- Pressing Space without image does nothing and does not throw.
- Pressing Escape closes inpainting and keeps the page image visible.
- Pressing Escape closes OCR review without applying candidates.

### Acceptance Criteria

1. The first usable action is visible from the image area, not buried in side panels.
2. Space/Escape shortcuts are discoverable and safe.
3. No OCR/inpainting work starts automatically on image load.

## Phase 11 - OCR Review as Workbench Surface

Goal: keep OCR review powerful but less modal, inspired by manga-trans overlay immediacy.

### Target Behavior

- OCR results appear in a right inspector or bottom `OCR 후보` tab.
- The page image stays visible while reviewing candidates.
- Candidate list groups remain:
  - speech bubbles selected by default,
  - narration/caption optional,
  - screen text optional.
- Each item shows:
  - checkbox,
  - text textarea,
  - selected speaker,
  - speaker candidate buttons,
  - confidence indicator,
  - notes/warnings.
- Clicking an OCR item should optionally focus/mark its bbox on the image stage when bbox exists.
- Apply button remains explicit: no automatic dialogue line creation.

### Layout Decision

Use a hybrid layout:

- Right inspector: selected OCR item detail and speaker candidates.
- Bottom panel: compact OCR candidate list and group filters.
- Existing modal remains as rollback path until inspector version is stable.

### Files

| File | Planned Change |
| --- | --- |
| `src/renderer/components/SpeechBubbleReviewDialog.tsx` | Extract review item state/helpers into reusable review surface component. |
| `src/renderer/components/OcrReviewPanel.tsx` | New inspector/bottom-compatible review component. |
| `src/renderer/App.tsx` | Route `speechBubbleReview` into `rightPanel = "ocr-review"` and `bottomPanel = "ocr-candidates"`. |
| `src/renderer/components/PageImagePanel.tsx` | Accept optional bbox highlight overlays for active OCR item. |
| `src/renderer/styles.css` | Add OCR candidate strip, confidence, bbox overlay, selected OCR item styles. |
| `tests/renderer/App.test.tsx` | Verify OCR review still applies lines and speaker selections. |

### Tests First

- OCR completion opens OCR review panel without hiding page image.
- Speech bubble items remain checked by default.
- Narration/caption items follow existing group policy.
- Speaker candidate buttons update selected speaker.
- Applying candidates creates dialogue lines with selected speaker, source text, notes, warnings, bbox, reading order.
- Cancelling OCR review removes panel and does not create lines.
- Active OCR item shows bbox overlay when bbox exists.
- Existing modal tests remain or are replaced only after equivalent panel tests pass.

### Acceptance Criteria

1. OCR review can be completed while the page image remains visible.
2. Existing OCR apply behavior is unchanged.
3. Speaker candidate review is faster than opening each item in a modal-only flow.
4. Low-confidence or unknown speaker remains visually marked.

## Phase 12 - Inpainting as Image Stage Tool

Goal: make inpainting feel like editing the current page, not entering a hidden sub-screen.

### Target Behavior

- Inpainting opens as an image-stage mode.
- The image remains in the same central stage.
- Tool controls are split:
  - top/overlay toolbar: brush size, undo/clear mask, mode, provider.
  - right inspector: prompt/context detail, run button, result/failure notes.
- `이미지로 돌아가기` is always visible.
- Run success applies the new page image and returns to viewer mode.
- Run failure keeps inpainting mode open and preserves mask unless the user clears it.

### Files

| File | Planned Change |
| --- | --- |
| `src/renderer/components/InpaintingEditor.tsx` | Separate canvas stage from controls if needed. |
| `src/renderer/components/PageImagePanel.tsx` | Host inpainting stage mode and mask overlay. |
| `src/renderer/App.tsx` | Manage `workspaceMode = "inpainting"` and right inspector state. |
| `src/renderer/styles.css` | Add tool overlay and inspector control styles. |
| `tests/renderer/App.test.tsx` | Expand inpainting open/close/success/failure tests. |

### Tests First

- Inpainting opens without replacing the whole page layout.
- `이미지로 돌아가기` closes mode and keeps original image.
- Failure leaves inpainting controls and mask canvas visible.
- Success applies returned page image metadata, marks project dirty, and closes mode.
- Escape closes inpainting only when no text field has focus.

### Acceptance Criteria

1. User never has to guess how to get back to the image.
2. Failed generation does not discard user mask.
3. Successful generation preserves the existing "new asset, original unchanged" policy.

## Phase 13 - Bottom Panel Tabs and Issue Queue

Goal: turn the bottom panel into a fast work queue, not only a table container.

### Tabs

| Tab | Contents | Opens When |
| --- | --- | --- |
| `대사` | Current `DialogueTable` | Default |
| `OCR 후보` | Compact candidate rows from OCR result | OCR review active |
| `문제 라인` | Lines with warnings, review status, unknown speaker, low confidence OCR | User clicks tab or after apply with warnings |

### Files

| File | Planned Change |
| --- | --- |
| `src/renderer/App.tsx` | Add `bottomPanel` tab state and derived issue line list. |
| `src/renderer/components/DialogueTable.tsx` | Keep as dialogue tab body. |
| `src/renderer/components/IssueLinePanel.tsx` | New focused issue queue component. |
| `src/renderer/styles.css` | Add tab header and compact issue row styles. |
| `tests/renderer/App.test.tsx` | Verify tab switching and issue list filtering. |

### Issue Definition

A line appears in `문제 라인` if any of these is true:

- `lineStatus === "review"`.
- parser warnings are non-empty.
- OCR warnings include low confidence.
- speaker is missing or `unknown` for speech/narration lines where a speaker matters.
- user translation is empty while AI/source text exists and status is not complete.

### Tests First

- Bottom panel defaults to `대사`.
- OCR review switches to `OCR 후보`.
- Applying low-confidence OCR lines makes `문제 라인` available with the affected line.
- Clicking an issue selects that dialogue line and opens line detail inspector.
- Collapsing bottom panel preserves selected tab state.

### Acceptance Criteria

1. User can find unresolved work without scanning the whole table.
2. Existing filters/search remain available in `대사`.
3. No new dialogue status values are added.

## Phase 14 - Viewer-Grade Page Navigation

Goal: make page movement feel like a viewer while preserving editor context.

### Target Behavior

- Page controls remain in the top bar.
- Add optional page strip inside `페이지` drawer:
  - page number,
  - image present/missing,
  - line count,
  - issue count.
- Keyboard:
  - Left/Right arrows move page when focus is not in a text field.
  - Ctrl+Left/Ctrl+Right can move to previous/next issue page if implemented.
- Changing pages preserves:
  - bottom panel open/collapsed state,
  - selected bottom tab,
  - left drawer state.
- Changing pages clears active OCR review if it belongs to the previous page, after confirmation if edits are dirty.

### Files

| File | Planned Change |
| --- | --- |
| `src/renderer/App.tsx` | Add page strip derived data and safe page-change guard. |
| `src/renderer/components/PageStrip.tsx` | New compact page list component. |
| `src/renderer/styles.css` | Add page strip row styles. |
| `tests/renderer/App.test.tsx` | Add keyboard/page strip tests. |

### Tests First

- Page drawer lists pages with image and issue state.
- Clicking page row changes current page.
- ArrowRight changes page outside text fields.
- ArrowRight in textarea does not change page.
- Page change with active OCR review asks/cancels safely or closes cleanly according to chosen implementation.

### Acceptance Criteria

1. Page navigation is possible without using the mouse.
2. Editing text fields never loses cursor behavior to global shortcuts.
3. OCR review cannot accidentally apply to the wrong page.

## Phase 15 - EXE/Electron Verification Plan

Goal: validate the app like a Windows program, not only a Vite page.

### Why This Matters

`manga-trans` is distributed as a release program, and many important failures only appear in the actual desktop environment: file dialogs, Windows paths, asset copying, preload IPC, packaged resources, long-running OCR/inpainting processes, and process cleanup.

### Verification Commands

Use PowerShell from:

```powershell
cd "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor"
```

Fast checks:

```powershell
npm run typecheck
npm test
npm run build
```

Electron dev app:

```powershell
npm run dev:electron
```

Packaged app smoke:

```powershell
npm run pack:win
```

### Manual Electron Checklist

1. Launch `npm run dev:electron`.
2. Create a new project.
3. Import TXT.
4. Save `.ctp`.
5. Connect multiple page images.
6. Navigate pages by buttons and keyboard.
7. Open guide/settings/context drawers and return to image.
8. Run OCR with a test image or mocked provider path if API keys are not available.
9. Verify OCR review shows candidates, speaker options, warnings, and apply button.
10. Apply selected OCR items and confirm dialogue lines include selected speaker.
11. Open inpainting, draw mask, close with `이미지로 돌아가기`.
12. Run inpainting failure path without changing the current image.
13. Run inpainting success path when provider credentials are available.
14. Save, close, reopen, and verify image metadata and lines persist.
15. Build packaged app with `npm run pack:win`.
16. Launch packaged app from `release/win-unpacked` if available.
17. Repeat file open/save/image connection smoke.
18. Close app and verify no lingering Electron/node child process from the app remains.

### Evidence to Capture

- Desktop screenshot after image connected.
- Desktop screenshot during OCR review.
- Desktop screenshot during inpainting.
- Compact Windows-width screenshot for adaptive layout.
- Console errors from gstack browser.
- Electron terminal output if dev app logs errors.
- Any packaged app launch errors.

### Acceptance Criteria

1. Browser/gstack validation passes for layout.
2. Electron dev app validates file dialogs and IPC.
3. Packaged app launches and can open/save a project.
4. No obvious lingering app process remains after normal close.

## Phase 16 - Deferred manga-trans Inspired Features

These are useful ideas from `manga-trans`, but they should not be included in the next UI polish batch without separate approval.

### Archive Viewer

Reference: `manga-trans v1.1.0` added archive-file viewer support.

Why defer:

- This app currently stores project images as explicit project assets.
- Archive browsing would need extraction, temp file lifetime, page ordering, and asset import decisions.

Separate design required:

- Supported archive types.
- Whether archive pages are temporary references or imported assets.
- How secret projects handle extracted images.
- Cleanup policy for extracted files.

### Web Page Image Translation

Reference: `manga-trans v1.1.0` added web-page image translation.

Why defer:

- This app is local project based.
- Web import has security, CORS, download, source attribution, and storage implications.

Separate design required:

- Whether URLs are stored.
- Download sandbox and file validation.
- User consent for external network access.
- Retry/cache policy.

### Pre-Translation Page Count / Background Processing

Reference: `manga-trans v1.1.0` added a setting for pre-translation page count.

Why defer:

- Our OCR/review flow is intentionally user-confirmed.
- Background OCR could create stale candidates if project images or character context changes.

Separate design required:

- Queue model.
- Cancellation.
- Per-page candidate freshness.
- CPU/API cost guardrails.

## Phase 17 - Priority Order and Dependency Graph

Recommended order:

```text
Phase 9 Workspace state
  -> Phase 10 Image-first quick action
  -> Phase 11 OCR review workbench
  -> Phase 12 Inpainting stage tool
  -> Phase 13 Bottom tabs/issues
  -> Phase 14 Viewer-grade navigation
  -> Phase 15 EXE/Electron verification
```

Rationale:

- Phase 9 creates the state model that every later panel depends on.
- Phase 10 makes the default loop feel image-first before moving complex OCR UI.
- Phase 11 should happen before issue tabs because OCR candidates define many issue sources.
- Phase 12 can reuse the same workspace mode mechanics as OCR review.
- Phase 13 uses outputs from OCR and line editing.
- Phase 14 is safer after panel state is stable.
- Phase 15 should run after each meaningful milestone, and must run at the end.

## Phase 18 - TDD and Regression Matrix

### Required TDD Pattern

For every phase:

1. Add or update the failing renderer test first.
2. Run the focused test and confirm it fails for the expected missing behavior.
3. Implement the smallest UI/state change.
4. Run the focused test and confirm it passes.
5. Run related regression tests.
6. Run full verification before claiming the phase complete.

### Regression Matrix

| Flow | Must Remain Working |
| --- | --- |
| TXT import | Browser fallback and Electron import still populate dialogue lines. |
| Project save/open | Dirty state, file path, secret password prompts, and project metadata stay intact. |
| Image import | Disabled-before-save and secret-project restriction stay intact. |
| OCR extraction | Whole-page OCR, validation, crop reOCR, speaker candidates, notes/warnings stay intact. |
| OCR apply | Selected items become dialogue lines with source text, type, speaker, bbox, reading order, notes, warnings. |
| Inpainting | Open, close, failure, success apply, and new asset behavior stay intact. |
| Dialogue editing | Select line, edit source/AI/user text, status, speaker, metadata, delete, move previous/next. |
| Character context | Character/dictionary edits still update project context and prompts. |
| Adaptive desktop layout | 1440x900, 1280x720, and 1024x640 do not overlap, cover the image stage, clip primary buttons, or hide return actions. |
| Packaged app | Launch, open/save, import image, close without process leak. |

### Standard Verification Commands

Use PowerShell from:

```powershell
Set-Location "C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기"
```

Run:

```powershell
npm run typecheck
npm test
npm run build
```

For UI phases, also run:

```powershell
npm run dev
```

Then capture with gstack at:

- 1440x900
- 1280x720
- 1024x640

For release-like verification, run:

```powershell
npm run dev:electron
npm run pack:win
```

## Phase 19 - Final Definition of Done

The remaining UI redesign is complete only when all of these are true:

1. Left rail buttons switch real drawer content or collapse the drawer.
2. Image stage remains visible during OCR review and inpainting.
3. OCR review can be completed without losing visual page context.
4. Inpainting always has a visible return action and preserves mask on failure.
5. Bottom panel supports dialogue, OCR candidates, and issue queue or a documented decision explains why a tab was deferred.
6. Keyboard shortcuts exist for safe viewer actions and never hijack text editing.
7. Supported Windows desktop screenshots show no clipped primary controls or auxiliary panels covering the image stage.
8. Existing OCR speaker candidate flow still applies selected speaker to dialogue lines.
9. Existing storage schema, IPC names, and dialogue type policy remain unchanged unless separately approved.
10. `npm run typecheck`, `npm test`, and `npm run build` pass.
11. `npm run dev:electron` manual checklist passes.
12. `npm run pack:win` packaged smoke either passes or has a documented blocker with exact error output.
