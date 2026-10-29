# Trio v0.1.4 — 이번 주 남은 P1 실행 계획

> 2026-09-17 범위 갱신: 이 문서의 macOS 항목은 **non-MVP / future scope**이며 현재 MVP 지원이나 Release Gate 요구가 아닙니다. Linux 범위는 변경하지 않습니다. [현재 플랫폼 정책](mvp-platform-scope.md)을 우선합니다.
> 이전 시점의 실행 결과와 gate 상태는 역사적 기록이며 현재 후보 판정은 [최신 Release Gate 보고서](../release/2026-09-17-mvp-release-gate.md)를 따릅니다.

> **기준:** v0.1.4 P1-01 ~ P1-04  
> **원칙:** 이미 구현·테스트된 세션·revision·저장 구조는 재작성하지 않는다. 먼저 Windows 실제 OS 검증과 계약 대조를 수행하고, 재현 가능한 gap만 최소 PR로 수정한다.

## 1. 현황과 우선순위

P1-01부터 P1-03은 코드가 없는 백로그가 아니다. `projectSessions.ts`, `projectRevision.ts`, `projectSaveTransaction.ts`, `projectRecovery.ts`, `projectProtection.ts`, `electron/main.ts`와 관련 회귀 테스트가 이미 존재한다. 이번 주의 남은 일은 구현 존재 여부를 다시 논의하는 것이 아니라 **실제 Windows 설치 환경에서 데이터 보존과 다중 실행 경계를 증명하는 것**이다.

P1-01의 설치·다중 실행·세션 종료·재실행 절차와 결과표는 [Windows P1-01 실장비 QA](windows-p1-01-physical-qa.md)에서 관리한다.

실제 실장비 결과는 [P1-01 QA 결과](p1-01-qa-results.md)에 누적한다. 자동 업데이트 상태 오류는 세션 판단과 분리하며 [업데이트 실패 진단](update-check-failure-diagnosis.md)에서 추적한다.

| 우선순위 | ID | 이번 주 목표 | 주된 산출물 |
| --- | --- | --- | --- |
| 1 | P1-01 | single-instance·세션 종료의 Windows 실제 동작 확인 | QA 기록, 실패 시 최소 Electron main 수정 PR |
| 2 | P1-03 | 원자 저장·backup·Save As/rekey의 Windows 파일 시스템 복구 확인 | QA 기록, fixture 기반 회귀 테스트 또는 복구 수정 PR |
| 3 | P1-02 | 지연된 처리 결과와 사용자 편집의 revision 계약을 현실적 fixture로 보강 | conflict/rebase 회귀 테스트와 필요한 최소 수정 |
| 4 | P1-04 | Trio 표기·Linux Graphics 분류·아이콘 준비 범위 확정 | asset brief, package metadata PR 또는 승인 대기 blocker |

## 2. P1-01 — Project Session Manager와 single-instance lock

현재 `requestSingleInstanceLock()`, second-instance restore/focus, session별 queue, 종료 시 dispose/zeroization의 구현·단위 테스트가 있다. 남은 검증은 Windows의 프로세스·창·파일 동작이 이 계약과 같은지 확인하는 것이다.

| 단계 | 수행 작업 | 통과 기준 | 증거 |
| --- | --- | --- | --- |
| 준비 | Windows x64 장비의 깨끗한 사용자 프로필에 Trio preview/dev 설치 | 설치 버전·OS build·시험 ID 기록 | QA 표의 환경 행 |
| 다중 실행 | 시작 메뉴 또는 설치 경로에서 Trio를 실행한 뒤 같은 실행 파일을 다시 실행 | 새 앱 창 대신 기존 창이 restore/focus되며 새 Main 상태가 생기지 않음 | 시간 포함 화면 캡처, 창 수 관찰 |
| 세션 정리 | synthetic `.ctp`를 열고 저장 후 정상 종료·재실행 | 프로젝트가 다시 열리고 비밀번호·키·절대 경로가 UI/로그에 노출되지 않음 | reopen PASS/FAIL, redacted 로그 |
| 회귀 판단 | 실제 시험 결과와 `tests/electron/main.test.ts`, `tests/main/projectSessions.test.ts`를 대조 | 차이가 없으면 코드 변경 없음; 차이가 있으면 실패 사례 하나당 최소 재현 테스트 추가 | QA ID·테스트 이름·후속 issue |

**차단 조건:** 실제 Windows 장비에서 검증해야 한다. Electron renderer/utility process 수 자체는 판정 기준이 아니며, “한 개의 Main 인스턴스와 한 개의 활성 창 경험”을 관찰한다.

## 3. P1-03 — Save As·원자 저장·backup 복구

현재 candidate 작성, 재열기 검증, backup 이동, 최종 rename, 복구 경로와 Save As/rekey 구현이 있다. Linux CI의 파일 잠금만으로는 Windows NTFS rename·잠금 경계를 증명할 수 없으므로 실제 파일 기반 확인을 우선한다.

| 단계 | 수행 작업 | 통과 기준 | 증거 |
| --- | --- | --- | --- |
| 정상 저장 | synthetic plain·secret 프로젝트를 각각 열고 편집·저장·재열기 | `.ctp`와 연결 `-assets`가 일관되게 열림 | fixture checksum, reopen PASS |
| Save As | 새 경로로 Save As 후 원본·새 파일을 각각 재열기 | 원본이 손상되지 않고 새 경로가 같은 보호 모드·프로젝트 상태를 유지 | 두 파일의 redacted 이름·checksum |
| 파일 잠금 | synthetic 프로젝트 또는 backup/candidate에 의도적인 Windows 잠금 경계를 만든 뒤 저장 | 실패 시 기존 유효 `.ctp`가 보존되거나 `.bak`에서 복구되며 추측 삭제가 없음 | QA ID, lock 방법, recovery 결과 |
| rekey | secret fixture를 새 비밀번호로 rekey 후 기존·새 비밀번호 경계를 확인 | 새 비밀번호로만 열리고 artifact master key 보호 계약이 회귀하지 않음 | PASS/FAIL만 기록, 비밀번호 기록 금지 |

실패가 실제로 재현되면 해당 순서와 파일 상태를 축소해 `projectSaveTransaction` 또는 `projectRecovery` 회귀 테스트로 만든다. 잠금 주입이 플랫폼 전용이라면 Linux 테스트에 억지로 맞추지 않고 Windows 전용 test 또는 물리 QA 기록으로 보존한다.

## 4. P1-02 — revision journal과 stale mutation 충돌 처리

현재 stale `baseRevision`에 대해 changed path가 겹치지 않으면 rebase하고, 겹치거나 journal 범위를 벗어나면 최신 DTO가 포함된 `REVISION_CONFLICT`를 반환하는 구조가 있다. 이번 주에는 실제 provider 호출 없이 지연된 OCR·인페인팅 완료 결과를 Main patch seam으로 모사한다. 세부 fixture 순서, changed path 검토 포인트, `needs_recovery` 경계와 완료 기준은 [P1-02 revision journal 실행 계획](p1-02-revision-plan.md)에서 관리한다.

| 단계 | 수행 작업 | 통과 기준 | 증거 |
| --- | --- | --- | --- |
| 계약 대조 | `projectRevision`, `projectReplay`, `projectSessions`, renderer revision 관련 테스트를 표로 매핑 | changed path, pending mutation, 최신 DTO, conflict UI의 책임이 중복·누락 없이 설명됨 | 계약 대조표 |
| non-conflict fixture | 사용자가 한 대사를 편집한 뒤 다른 경로의 지연 Main patch를 적용 | 사용자의 pending edit가 유지되고 revision이 단조 증가 | 독립 회귀 테스트 |
| conflict fixture | 사용자의 편집 경로와 같은 경로에 지연 Main patch를 적용 | `REVISION_CONFLICT`, 최신 DTO, 충돌 경로가 표시되고 draft가 조용히 덮어써지지 않음 | 독립 회귀 테스트 |
| bounded journal | 오래된 `baseRevision`을 `MAX_REVISION_JOURNAL` 밖으로 이동 | 안전한 conflict가 반환되고 임의 rebase가 일어나지 않음 | 독립 회귀 테스트 |

코드 수정은 위 계약이 깨지는 경우에만 한다. provider·pipeline 전체를 새로 만들거나 P2의 자동화 작업 큐를 앞당기지 않는다.

## 5. P1-04 — 배포 자산 브랜딩

제품 표기명은 **Trio**, Linux category는 **Graphics**로 확정됐다. 다만 승인된 아이콘 원본과 사용 권한은 아직 없다. 따라서 아이콘을 추측해 생성하거나 기본 Electron 아이콘을 상용 자산처럼 포장하지 않는다.

| 작업 | 즉시 수행 가능 범위 | blocker | 완료 기준 |
| --- | --- | --- | --- |
| 메타데이터 설계 | `productName`, Linux `category: Graphics`, About 표기, artifact 이름 영향 분석 | 없음 | 변경 후보·회귀 범위가 PR 설명에 정리됨 |
| 아이콘 asset brief | SVG 또는 1024px 이상 PNG 원본, 단색/다크/라이트 사용, 상표 권한 요구사항 정의 | 브랜드 원본·권한 미정 | 승인 가능한 brief와 담당자 결정 |
| 파생물 | Windows `.ico`, macOS `.icns`, Linux hicolor PNG 계층 생성 | 승인된 원본 필요 | 각 패키지에서 아이콘·셸 통합 확인 |
| 설치 검증 | Windows 시작 메뉴·창 아이콘, Linux `.desktop` category 확인 | 패키징 자산 완성 | 실제 설치 화면 증거와 smoke 회귀 0 |

## 6. 권장 순서와 병합 기준

| 순서 | PR 또는 QA 묶음 | 선행 조건 | 병합·완료 기준 |
| --- | --- | --- | --- |
| A | Windows P1-01·P1-03 물리 QA | Windows x64 장비, synthetic fixture | 각 시나리오 PASS/FAIL/BLOCKED와 재현 근거 기록 |
| B | P1-02 revision fixture PR | 현재 session/revision test 실행 | non-conflict·conflict·bounded journal 테스트 통과 |
| C | P1-01/03 최소 수정 PR | A에서 재현된 결함이 있을 때만 | 새 회귀 테스트, 기존 `.ctp` 보존, Windows 재검증 |
| D | P1-04 metadata PR | Trio 표기·Graphics 범위 검토 | 플랫폼 패키징·smoke 통과, release 자산명 영향 승인 |
| E | P1-04 icon PR | 승인된 원본·권한 | Windows·macOS·Linux 설치 후 셸 통합 증거 |

이번 주 종료 시 P1-01~03은 **Windows 실증 결과가 없으면 완료로 표시하지 않는다**. P1-04는 icon asset이 미정이면 metadata/brief까지만 완료로 기록하고, 아이콘 파생물은 blocker 상태를 유지한다.
