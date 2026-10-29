# Shadcn Lint 설정

`@shadcn/lint`는 `.oxlintrc.json`에서 Oxlint의 `jsPlugins`로 등록한다. 일반 CSS는 `scripts/design-system-audit.mjs`의 보조 검사로 확인한다. 검사 대상은 `src/renderer`이며 전체 명령은 다음과 같다.

```powershell
npm.cmd run lint
```

이 명령은 JSX 검사와 일반 CSS 보조 검사를 모두 실행한다. 첫 검사에서 위반이 나와도 두 번째 검사를 실행하며, 어느 검사든 오류·실행 실패가 있으면 종료 코드는 `1`이다. 기존 `test`, `typecheck`, build 및 CI 설정은 유지한다. Oxlint의 기본 `correctness` category는 계속 비활성화하고 아래 요청된 디자인 규칙만 활성화했다.

```powershell
# JSX 규칙만 검사
npm.cmd run lint:jsx

# 일반 CSS 색상 및 공통 컴포넌트 소비처 검사
npm.cmd run lint:design-system

# 도구별 JSON 결과
npm.cmd run lint:jsx -- --format=json
npm.cmd run lint:design-system -- --json
```

## 현재 디자인 시스템 위치

| 역할 | 파일 |
| --- | --- |
| 색상·폰트·간격·radius 및 light/dark 테마 토큰 | `src/renderer/design-tokens.css` |
| 버튼·입력·피드백 등 공통 스타일 | `src/renderer/design-system.css` |
| `Button`, `PageHeader`, `SettingsRow`, `Feedback`, `ModalSurface`, `handleTabKeys` | `src/renderer/components/Ui.tsx` |
| 작업 화면 구조와 추가 스타일 | `src/renderer/styles.css`, `src/renderer/studio.css` |
| CSS import 순서, 테마 상태·전환·저장 | `src/renderer/App.tsx` |

현재 프로젝트에는 Tailwind, `components.json`, tsconfig import alias가 없다. 컴포넌트는 `./Ui.js`처럼 상대 경로로 import하므로 `settings.shadcn.componentImports`에 해당 모듈만 인식하는 패턴을 등록했다. 화면별 컴포넌트 전체를 공통 디자인 시스템으로 등록하지 않는다.

## 활성화한 규칙

| 규칙 | 검사 정책 |
| --- | --- |
| `shadcn/no-raw-colors` | Tailwind palette 색과 SVG `fill`·`stroke`·`stopColor` 등의 색상 리터럴을 오류로 보고한다. |
| `shadcn/no-arbitrary-values` | 임의 **색상** 값만 오류로 보고한다. 임의 width·margin 등 geometry 값은 이 규칙으로 제한하지 않는다. |
| `shadcn/no-restyle` | 공통 UI에 적용하는 Tailwind 외관 클래스는 오류로 보고한다. 일반 CSS 클래스는 Shadcn이 내부 선언을 읽지 못하므로 보조 검사에 맡긴다. |
| `shadcn/no-inline-styles` | `Button`, `SettingsRow`, `Feedback`, `ModalSurface` 소비처의 색·폰트·테두리·패딩 등 외관 지정은 오류로 보고한다. width·margin·position·transform 등 배치는 허용한다. |
| 보조 `raw-color` | 일반 CSS 선언과 JSX inline style의 hex·색상 함수·named color를 보고한다. shorthand·gradient·shadow·`var()` fallback도 검사한다. |
| 보조 `unknown-variable` | CSS 및 정적으로 읽을 수 있는 JSX style에서 선언 또는 fallback이 없는 CSS 변수 참조를 보고한다. |
| 보조 `component-restyle` | 실제 `Ui.tsx` import를 따라 소비처의 inline 외관과 `className`에 연결된 CSS 루트 외관 선언을 보고한다. |

테마 색상의 리터럴 정의는 `design-tokens.css`에서만 허용한다. 그 파일도 변수 참조는 검사한다. `transparent`, `currentColor`, 상속·초기화 값 및 시스템 색은 허용하며, `url(...)`과 CSS 문자열 안의 내용은 색으로 오인하지 않는다. 다른 CSS 또는 inline custom property에서 선언한 변수도 참조할 수 있지만, 거기에 새 색상 리터럴을 넣으면 보고한다. 변수 이름 존재 확인은 테마별 값·타입이나 실제 computed style 검증을 뜻하지 않는다.

공통 컴포넌트의 외관은 variant 및 공통 구현에서 관리한다. `Button`, `SettingsRow`, `ModalSurface`는 className·style 소비처를 검사한다. `Feedback`은 className을 전달하지 않으므로 style만 검사하고, 해당 props를 받지 않는 `PageHeader`는 이 소비처 검사에서 제외한다. `Ui.tsx` 내부의 자체 스타일은 소비처 덮어쓰기로 보고하지 않는다.

밀집된 편집 화면의 작은 버튼은 `size="compact"`를 사용한다. 기본 크기와 compact 크기의 글꼴·패딩·높이는 `design-system.css`가 소유하며, 터치 환경의 최소 높이를 유지한다. 삭제 등 위험 설정 행은 `SettingsRow tone="danger"`로 표현한다. 일반 섹션 구분선은 주변 컨테이너에서 관리하며 위험 상태와 구분한다.

```tsx
<Button variant="secondary" size="compact" onClick={onRetry}>다시 시도</Button>
<SettingsRow tone="danger" title="설정 초기화" description="저장된 설정을 초기화합니다.">
  <Button variant="destructive" onClick={onReset}>초기화</Button>
</SettingsRow>
```

이 규칙은 UI 검사 정책이며 프로젝트 이미지·주석·조판 결과를 변경하지 않는다. 기존 SVG 그림이나 캔버스 색상이 검출되면 실제 역할과 별도 계약을 확인한 뒤 토큰화 또는 좁은 예외 여부를 결정한다. 위반을 숨기는 자동 예외나 기존 위반 기준선은 두지 않는다.

## 지원 범위와 검증

보조 검사는 기존 TypeScript AST와 승인된 개발 의존성 `postcss@8.5.26`을 사용한다. 명명·namespace UI import, 같은 scope의 const, 조건부·template 문자열, 알려진 class helper, 정적으로 읽을 수 있는 style 객체·spread를 지원한다. 공통 컴포넌트의 재수출·wrapper를 보조 검사에서 추적하지 않으며, 외부 값·함수·동적 객체·복잡한 class helper 인자는 일부를 읽지 못할 수 있다.

CSS selector는 마지막 compound의 클래스에 한해 소비처에 연결하며, 공통 컴포넌트 루트 태그와 명백히 불일치하는 selector는 제외한다. `.consumer .child`의 스타일을 `.consumer` 자체 외관으로 보고하지 않는다. `:is`, `:where`, `:not`, `:has` 및 pseudo-element selector는 소비처 연결에서 제외하고 coverage에 기록한다. 조상·상태·추가 클래스·미디어 조건이 있는 연결은 `component-restyle-review` **경고**, 조상 selector 아래 `button` 또는 기본 버튼 클래스 외관은 `scoped-button-review` **경고**로 남긴다. 전체 JSX 트리, selector 적용 조건, specificity·로드 순서·cascade, 실제 computed style을 계산하지 않으므로 이러한 경고를 확정된 덮어쓰기 오류로 해석하지 않는다.

읽지 못한 style 객체·className·동적 색상 값과 복잡한 selector는 JSON의 `coverage`에 기록한다. CSS 색상 검사는 복잡한 selector 안의 선언에도 적용된다. 파싱 오류는 검사 실패이며 성공으로 대체하지 않는다.

조상 selector 경고는 공통 `Button`과 독립된 native 탐색 버튼 모두를 후보로 보고한다. 선택·비활성·forced-colors 규칙은 실제 소비처를 확인한 뒤 보존한다. 2026-10-08 테마 일관화 작업의 selector별 검토 근거는 `artifacts/theme-consistency/css-review.json`에 있다. 검토 완료 기록은 검사에서 경고를 숨기거나 해당 selector를 자동 허용하지 않는다.

```powershell
npm.cmd test -- tests/scripts/shadcnLint.test.mjs tests/scripts/designSystemAudit.test.mjs --experimental.fsModuleCache=false
```

회귀 fixture는 색상 리터럴·토큰·fallback·URL, geometry, UI import·props 전달, 후손 selector, 동적 값의 미검사 기록과 두 검사 실행기의 실패 전파를 확인한다. 실제 Electron 화면 검증은 포함하지 않는다.

Shadcn 규칙 정책은 `.oxlintrc.json`의 `rules`, 일반 CSS 정책은 `scripts/design-system-audit.mjs`에 있다. [공식 규칙 목록](https://github.com/shadcn-ui/lint/blob/main/README.md#rules), [설정 예제](https://github.com/shadcn-ui/lint/blob/main/README.md#settings), [발견 방식과 검사 한계](https://github.com/shadcn-ui/lint/blob/main/docs/how-it-works.md)를 참고한다.
