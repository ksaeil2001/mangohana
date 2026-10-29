# Windows 업데이트 전환 QA 체크리스트 및 로그 수집표

> 2026-09-17 범위 갱신: 이 문서의 macOS 항목은 **non-MVP / future scope**이며 현재 MVP 지원이나 Release Gate 요구가 아닙니다. Linux 범위는 변경하지 않습니다. [현재 플랫폼 정책](mvp-platform-scope.md)을 우선합니다.
> 이전 시점의 실행 결과와 gate 상태는 역사적 기록이며 현재 후보 판정은 [최신 Release Gate 보고서](../release/2026-09-17-mvp-release-gate.md)를 따릅니다.

> **범위:** Gate 4, Windows x64 우선
> **기준 설치본:** v0.1.3 source에서 재빌드한 signed `0.1.3-transition.1`
> **후보 채널:** signed `0.1.4-preview.1` transition QA feed
> **현재 판정:** PASS (code-side) / BLOCKED (live QA)

## 1. 전제와 현재 차단 요소

stable Release는 Windows 클라우드 서명이 구현·검증되기 전까지 생성하지 않는다. 따라서 이번 QA는 preview 후보에 한정하며, production stable 신뢰성을 증명하는 시험이 아니다. `0.1.3-transition.1`은 v0.1.3 source에서 재빌드한 **transition baseline**이고 실제 과거 v0.1.3 artifact와 bit-identical하지 않다는 한계를 release evidence에 기록한다.

현재 Main-owned 자동 업데이트 정책은 `stable | preview | dev | transition` 채널을 앱 버전과 Main 설정에서 파생한다. stable Windows/macOS만 signed public feed를 사용하고, preview/dev는 updater network request를 하지 않으며, transition만 immutable `TRIO_TRANSITION_QA_FEED_URL`을 `setFeedURL()`로 지정해 signed `v0.1.4-preview.1` metadata를 조회한다. Linux stable updater는 비활성이다. stable 사용자에게 미리보기(preview)를 노출하는 변경은 허용하지 않는다. transition feed와 channel은 renderer·환경변수에서 선택할 수 없다.

transition baseline packaging은 [`transition-update-qa.yml`](../../.github/workflows/transition-update-qa.yml)의 수동 dispatch만 사용한다. workflow는 `refs/tags/v0.1.3`의 peeled commit과 `refs/tags/v0.1.3-transition.1`의 peeled commit을 각각 입력 SHA에 exact-match시키고, baseline SHA가 transition tag의 ancestor인지 추가 확인한다. 패키지 source는 transition tag의 immutable checkout에서만 빌드한다. v0.1.4 전용 검증 도구는 필수 `release_tooling_sha`로 지정한 별도 `.trio-release-tooling` checkout에서만 읽고, 그 checkout의 HEAD·필수 파일·`npm ci`/`js-yaml` 의존성을 확인한다. tooling checkout은 package source checkout을 대체하거나 변경하지 않으며, `transition.json`에 tooling SHA와 경로를 기록한다. 고정된 preview Release의 실제 `latest.yml`·installer·blockmap을 다운로드해 tag/prerelease 상태를 확인하며, `js-yaml` strict schema parser로 duplicate key, 다중/arch-specific `files`, `packages`, absolute/external URL과 허용 목록 밖 metadata reference를 거부한다. 허용된 installer filename·size·SHA-512와 blockmap filename·bytes를 SHA-256으로 evidence에 bind하고, pinned tooling checkout의 `verify-windows-signing.ps1`가 `signtool verify /pa /all /v` 경계로 SHA-256 digest, trusted timestamp, Authenticode chain과 expected publisher를 검증한다. 모든 검증을 통과한 뒤에만 package source checkout에서 `--publish never`로 signed Windows artifact를 만들고 sanitized evidence를 private Actions artifact로 남긴다. public Release, tag, stable pointer는 만들거나 수정하지 않는다.

### 1.1 code-side candidate binding과 live evidence 경계

transition workflow의 입력은 다음 네 값으로 고정한다. 실제 값은 설정된
private Environment와 성공한 hosted run이 없으므로 아직 기록하지 않는다.

| 입력/환경 | 계약 | 현재 기록 |
| --- | --- | --- |
| `preview_candidate_run_id` | exact `package-release.yml` `workflow_dispatch` 성공 run ID이며 run head SHA와 candidate artifact를 함께 고정 | 미정 — live run 없음 |
| `preview_evidence_sha256` | private `transition-candidate-evidence.json`의 lowercase SHA-256 sidecar와 exact-match | 미정 — private candidate 없음 |
| `release_tooling_sha` | full commit SHA; candidate run head, private evidence `sourceSha`, pinned tooling checkout HEAD와 일치 | 미정 — live run 없음 |
| `TRIO_APPROVED_RELEASE_TOOLING_SHA` | `transition-qa` Environment variable의 approved full SHA; `release_tooling_sha`와 exact-match | 미정 — Environment 값/승인 실행 없음 |

candidate artifact 이름은
`trio-preview-transition-candidate-<sourceSha>-<runId>`로만 허용하고,
`latest.yml`, `Trio-Setup-0.1.4-preview.1.exe`,
`Trio-Setup-0.1.4-preview.1.exe.blockmap`,
`transition-candidate-evidence.json`, 해당 `.sha256` sidecar만 private
candidate evidence로 취급한다. transition evidence는
`trio.transition-candidate-evidence.v1`와
`trio.git-source-integrity.v1`을 사용한다. source와 `.trio-release-tooling`은
install/build 전에 각각 `*-integrity-before.json`, build/signing/Pretendard/
package smoke 뒤에 각각 `*-integrity-after.json`을 만들고, `headSha`와
tracked `treeSha`가 before/after에 걸쳐 일치하는지 확인한다. 이 문서의
code-side 기록은 artifact/run/source binding을 정의할 뿐, 해당 값이 실제로
관찰되었다고 주장하지 않는다.

transition QA는 **latest workflow run, latest artifact, stable pointer 또는
public feed를 자동 선택하지 않는다**. exact run ID·artifact ID/name·source
SHA·evidence digest가 모두 맞지 않으면 중단한다. private candidate와
transition evidence는 public Release나 공개 update feed로 승격되지 않는다.

| 사전 조건 | 확인 방법 | 실패 시 처리 |
| --- | --- | --- |
| Windows 10 또는 11 x64 실제 장비 | OS edition·build만 로그에 기록 | VM/실장비가 없으면 물리 검증 보류 |
| transition private workflow 입력 | v0.1.3 baseline SHA, transition source SHA, `RUN TRANSITION QA` 확인 문구 | SHA가 없거나 ancestry가 맞지 않으면 package 중단 |
| `0.1.3-transition.1` 기준 설치본 | 앱 정보 화면의 버전·서명·transition feed 확인 | 다른 버전이면 제거 후 기준 설치본으로 재설치 |
| synthetic QA 프로젝트 | 민감하지 않은 이미지·번역문으로 새 `.ctp` 프로젝트 생성 | 실제 고객 원고·API key·개인정보 사용 금지 |
| `0.1.4-preview.1` QA 자산 | tag, SHA-256, QA feed, `latest.yml` 존재 여부 기록 | asset 또는 metadata 누락 시 시험 중단 |
| negative channel checks | unchanged v0.1.3 stable은 preview 미발견, preview/dev는 network 없음 | 실패하면 stable 전환 시험 중단 |

## 2. 시나리오 체크리스트

| ID | 시나리오 | 절차 | 합격 기준 |
| --- | --- | --- | --- |
| WU-01 | 업데이트 없음 | unchanged v0.1.3 stable feed만 보이는 상태에서 Trio를 실행하고 업데이트 확인 | stable 설치본이 preview를 발견하지 않으며 프로젝트에 변경 없음 |
| WU-02 | 정상 전환 | signed `0.1.3-transition.1`을 설치하고 transition channel로 signed `0.1.4-preview.1`을 확인·다운로드·명시적 재시작 설치 | `available → downloading → ready-to-install`을 거쳐 재실행 후 후보 버전 표시; synthetic 프로젝트를 다시 열 수 있음 |
| WU-03 | 확인 네트워크 실패 | 업데이트 확인 직전 네트워크를 차단하거나 QA proxy에서 요청을 실패시킴 | 상태가 `error`가 되고 사용자 메시지가 표시되며, 연결 복구 후 재시도가 가능 |
| WU-04 | 다운로드 중 실패 | download 단계에서 네트워크를 차단 | 손상된 installer를 실행하지 않고 `error` 상태와 재시도 UI가 표시; 프로젝트 파일이 보존됨 |
| WU-05 | 설치 전 종료·재실행 | `ready-to-install` 상태에서 앱을 종료하고 다시 실행 | 자동 설치를 주장하지 않으며, 명시적 설치 동작과 상태가 예측 가능하게 유지됨 |
| WU-06 | 설치 후 저장·복구 | 후보 버전 설치 뒤 synthetic 프로젝트를 열고 편집·저장·닫기·재열기 | `.ctp`와 `-assets`가 일관되게 열리고 저장·복구 회귀 없음 |
| WU-07 | 파일 잠금·single-instance | 후보 버전에서 프로젝트 파일을 열어 둔 상태로 두 번째 Trio 실행 및 저장 충돌 경계 시험 | 두 번째 실행은 기존 창 focus 동작을 따르고, 기존 유효 `.ctp`가 손상되지 않음 |
| WU-08 | 제거와 흔적 확인 | NSIS 제거 후 앱·프로젝트·업데이터 cache의 존재를 관찰 | 제거 범위가 명확하며 사용자 프로젝트를 임의 삭제하지 않음 |

## 3. 실행 절차

1. QA 담당자는 깨끗한 Windows 프로필 또는 VM을 사용하고, 설치 전 OS build·`0.1.3-transition.1`·시험 ID를 기록한다.
2. synthetic `.ctp` 프로젝트와 연결된 `-assets` 폴더를 만들고, 파일명·크기·SHA-256만 기록한다. 실제 원고, API key, 사용자 이름, 경로 전체는 기록하지 않는다.
3. WU-01부터 WU-08을 순서대로 실행한다. 각 상태 전환은 앱 화면 캡처 또는 수동 상태표로 기록한다. 별도로 unchanged v0.1.3 stable의 preview 미발견과 preview/dev의 updater network 없음도 기록한다.
4. 오류가 발생하면 화면의 사용자 메시지, 시간, 실행한 행동, 네트워크 조건, 재시도 결과를 기록한다. token, authorization header, 실제 경로, 원고는 기록하지 않는다.
5. 실패한 시나리오는 clean baseline으로 되돌린 뒤 한 번만 재현한다. 재현 불가면 “미재현”으로 표시하고 추측으로 통과 처리하지 않는다.
6. 완료 후 QA 담당자는 log sheet, 관련 스크린샷, candidate tag, checksum, PASS/FAIL 판단을 issue 또는 비공개 QA 저장소에 남긴다. 민감 파일과 installer 전체는 공개 Issue에 올리지 않는다.

## 4. 로그 수집표

| 필드 | 기록 예시 | 기록 금지 |
| --- | --- | --- |
| 시험 ID·시각 | `WU-02-20260818-01`, 현지 시각·UTC | 실사용자 이름·이메일 |
| 환경 | Windows edition·build, x64, 깨끗한 VM 여부 | 사용자 프로필 전체 경로 |
| baseline·candidate | `0.1.3-transition.1 → 0.1.4-preview.1`, tag, QA feed URL | private Release URL 또는 credential |
| 자산 무결성 | installer 파일명·SHA-256·`latest.yml` 존재 | 인증서 private key·PFX·비밀번호 |
| 상태 전환 | `checking → available → downloading(0/100) → ready-to-install` | token, authorization header, 요청 전문 |
| 사용자 행동 | 확인·다운로드·설치·재시도 클릭 시각 | 실제 고객 원고·프로젝트 내용 |
| 오류 정보 | 사용자 메시지, HTTP status 범주, 재시도 결과 | API key·Cookie·전체 IP·원본 stack trace의 민감 경로 |
| 프로젝트 보존 | synthetic fixture SHA-256, reopen PASS/FAIL | 실제 `.ctp`, 이미지, 번역문 |
| 증거 링크 | 비밀이 제거된 화면 캡처·CI run URL | installer 전체 또는 사용자 파일 공개 첨부 |

## 5. 결과 보고 템플릿

| 시나리오 | 결과 | 관찰된 상태 | 프로젝트 보존 | 재현 여부 | 후속 조치 |
| --- | --- | --- | --- | --- | --- |
| WU-01 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |
| WU-02 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |
| WU-03 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |
| WU-04 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |
| WU-05 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |
| WU-06 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |
| WU-07 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |
| WU-08 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |

`BLOCKED`는 signing credential, transition/preview Release metadata 또는 QA 장비처럼 시험을 시작할 수 없는 전제 조건이 없는 상태를 의미한다. `NOT RUN`은 전제는 준비됐지만 아직 수행하지 않은 상태다. `FAIL`과 혼동하지 않으며, blocker를 해소한 뒤 재시험한다. 실제 과거 v0.1.3 artifact와 bit-identical하지 않은 transition baseline이라는 제한을 결과 문서에 남긴다.
