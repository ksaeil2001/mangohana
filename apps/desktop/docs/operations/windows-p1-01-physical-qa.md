# Trio P1-01 — Windows x64 실장비 세션·single-instance QA

> **목적:** 패키지된 Trio가 Windows 실제 사용자 환경에서 하나의 Main 인스턴스만 유지하고, 두 번째 실행 시 기존 창을 복원·포커스하며, 정상 종료 후 Project Session을 안전하게 정리하는지 검증한다.  
> **대상 artifact:** [Package, smoke test, and release Trio #16](https://github.com/ksaeil2001/trio/actions/runs/32117634774)의 `trio-windows-x64-16`  
> **판정:** `PASS`, `FAIL`, `BLOCKED`, `NOT RUN` 중 하나. 실제 Windows 증거가
> 없으면 자동 테스트·CI smoke를 근거로 완료 또는 physical PASS로 표시하지 않는다.

## 1. 구현 계약과 실장비 판정 원칙

일반 권한과 **관리자** 권한을 별도 결과로 기록한다. 어느 한 권한에서 수행하지
못하면 해당 시나리오는 `BLOCKED`이며 다른 권한의 결과로 대체하지 않는다.
편집·복구·업데이트 화면은 DPI 100%, 125%, 150%에서 별도 관찰하고, 잘림이나
겹침이 있으면 해당 DPI 결과를 `FAIL`로 기록한다.

Electron Main은 `requestSingleInstanceLock()`을 얻지 못한 프로세스를 창·세션 상태 생성 전에 종료한다. 두 번째 실행 이벤트는 기존 창이 최소화 상태면 restore하고 항상 focus한다. 앱 종료 이벤트에서는 모든 Project Session을 dispose하고 secret project protection buffer를 zeroize한다.

Electron은 renderer, GPU, utility 등 여러 보조 프로세스를 가질 수 있다. 따라서 Task Manager의 프로세스 개수만으로 PASS/FAIL을 판정하지 않는다. 이 QA의 합격 기준은 **두 번째 실행이 독립 작업 창이나 독립 Main 세션을 만들지 않고 기존 창을 활성화하는 사용자 경험**과 **정상 종료 후 같은 프로젝트를 재열 수 있는 데이터 보존 결과**다.

## 2. 준비

| 항목 | 수행 방법 | 통과 기준 |
| --- | --- | --- |
| Windows 환경 | Windows 10 또는 11 x64 실제 장비에서 별도 QA 사용자 프로필 또는 VM snapshot 준비 | OS edition·build·x64 여부를 결과표에 기록 |
| installer | Actions run #16의 `trio-windows-x64-16` artifact를 내려받아 압축 해제 후 NSIS setup `.exe` 확인 | 파일명·SHA-256만 기록; installer 자체를 공개 Issue에 재업로드하지 않음 |
| 설치 | setup을 실행하고 기본 또는 명시적으로 선택한 설치 위치에 설치 | 설치 경로는 결과표에 전체 경로가 아닌 `default/custom`만 기록 |
| synthetic 프로젝트 | 앱에서 빈 프로젝트를 만든 뒤 짧은 가짜 대사 하나를 넣어 저장하거나, source checkout이 있으면 `tests/fixtures/projects/plain-v1.ctp`를 복사해 사용 | 실제 원고·사용자 이미지·API key·개인정보를 사용하지 않음 |
| 증거 폴더 | 로컬의 비공개 QA 폴더에 화면 캡처·결과표 보관 | 민감한 경로·계정명·원고가 드러난 이미지는 가린 뒤에만 공유 |

> source checkout 없이 설치본만 사용하는 경우에는 fixture 경로를 찾으려 하지 말고 앱 UI로 생성한 synthetic 프로젝트를 사용한다.

## 3. 실행 절차

### QA-P101 — 기준 실행과 세션 생성

1. 모든 Trio 창을 닫고 Task Manager에서 Trio 관련 앱 창이 없는지 확인한다.
2. 설치된 Trio를 한 번 실행한다. Main 창이 하나 열리는지 확인한다.
3. synthetic 프로젝트를 생성하거나 열고, 가짜 대사 한 줄을 편집한 뒤 저장한다.
4. 프로젝트 제목·현재 페이지·편집한 가짜 대사를 결과표에 일반화해 기록한다. 예: `synthetic project saved`.

**PASS:** 한 개의 작업 창이 열리고 synthetic 프로젝트를 저장할 수 있다.  
**FAIL:** 시작 실패, 여러 작업 창의 자동 생성, synthetic 데이터 저장 실패 또는 민감 정보 노출.

### QA-P102 — 최소화 상태의 두 번째 실행

1. QA-P101의 기존 Trio 창을 최소화한다.
2. 시작 메뉴 바로 가기 또는 설치된 동일 실행 파일을 다시 한 번 실행한다.
3. 10초 이내에 기존 창이 restore되고 foreground로 focus되는지 확인한다.
4. 독립된 두 번째 작업 창, 초기 화면 또는 별도 프로젝트 세션이 생기지 않았는지 확인한다.

**PASS:** 기존 창이 복원·focus되고 기존 synthetic 프로젝트 문맥이 유지된다.  
**FAIL:** 두 번째 독립 창이 유지되거나, 기존 창이 최소화 상태로 남거나, 새 Main 세션처럼 초기화된 작업 창이 생긴다.

### QA-P103 — 반복·동시 실행 경계

1. 기존 Trio 창을 활성화한 채 시작 메뉴 또는 동일 실행 파일을 빠르게 세 번 실행한다. 가능하면 두 번째 시도부터 1초 이내 간격을 사용한다.
2. 각 실행 뒤 기존 창이 focus 상태인지, 독립 작업 창이 생기지 않았는지 관찰한다.
3. Task Manager는 보조 Electron 프로세스를 보여줄 수 있으므로 참고 증거로만 사용한다. 창 개수와 현재 프로젝트 문맥을 우선 판정한다.

**PASS:** 반복 실행에도 하나의 작업 창 경험이 유지되고 저장된 synthetic 프로젝트가 그대로 보인다.  
**FAIL:** 둘 이상의 독립 작업 창, 서로 다른 unsaved state, 저장 충돌 메시지 또는 두 번째 프로세스가 사용자에게 보이는 별도 앱 상태를 만든다.

### QA-P104 — 정상 종료·재실행·세션 정리

1. synthetic 프로젝트를 저장한 뒤 모든 Trio 창을 정상 종료한다.
2. 10초 기다린 후 시작 메뉴 또는 설치 경로에서 Trio를 다시 실행한다.
3. 최근 프로젝트를 통해 synthetic 프로젝트를 다시 열고, 저장한 가짜 대사가 남아 있는지 확인한다.
4. secret project를 사용한 경우에는 비밀번호·key를 기록하지 말고, 앱을 종료한 뒤 새 실행에서 정상 unlock만 가능한지 기록한다.

**PASS:** 재실행 후 앱이 정상 시작하며 synthetic 프로젝트를 다시 열 수 있다. UI·공개 로그·화면 캡처에 key·password·전체 로컬 경로가 노출되지 않는다.  
**FAIL:** 종료 후 재실행 불가, 프로젝트 손상, 예상치 못한 자동 unlock, 민감 정보 노출, 또는 이전 세션이 사용자에게 보이는 상태로 남는다.

### QA-P105 — 실패 증거 보존과 복구 경계

P101~P104 중 실패가 발생하면 앱을 즉시 강제 종료하기 전에 화면·시간·행동 순서·창 상태를 캡처한다. 그 뒤 정상 종료를 한 번 시도하고, 불가할 때만 Task Manager 종료를 사용한다. 강제 종료 후에는 synthetic 프로젝트를 다시 열어 데이터 보존 결과를 `PASS`, `FAIL`, `N/A`로 기록한다.

실제 고객 프로젝트, 원고, API key, private key, installer 전체, 사용자 계정명 또는 전체 경로를 Issue에 올리지 않는다.

## 4. 증거 수집표

| 필드 | 기록할 내용 | 기록 금지 |
| --- | --- | --- |
| 시험 ID | `P101-YYYYMMDD-01`처럼 임의 ID | 실사용자 이름·이메일 |
| 환경 | Windows edition/build, x64, clean profile/VM 여부 | 사용자 프로필 전체 경로 |
| artifact | `trio-windows-x64-16`, setup 파일명, SHA-256 앞 12자리 | credential·서명 키·download token |
| 설치 결과 | `default` 또는 `custom`, 설치 PASS/FAIL | 설치 전체 경로·계정명 |
| 실행 행동 | 최초 실행, 최소화, 두 번째 실행, 반복 실행, 종료·재실행 시각 | 실제 고객 원고·프로젝트 내용 |
| 창 결과 | 기존 창 restore/focus, 새 독립 창 여부, synthetic 문맥 유지 | 실제 화면의 민감 텍스트가 보이는 무편집 캡처 |
| 세션 결과 | 저장·재열기 PASS/FAIL, secret unlock PASS/FAIL/N/A | password·API key·memory dump |
| 실패 증거 | redacted screenshot ID, 재현 절차, 사용자 메시지 | 전체 경로가 포함된 raw log·stack trace |

## 5. 결과 보고 템플릿

`NOT RUN`은 아직 수행하지 않은 시나리오, `BLOCKED`는 장비·artifact·credential
등의 전제 부족으로 시작할 수 없는 시나리오다. 기존 QA-P102 기록은 부분 증거로만
취급하며 P1-01 전체 Gate를 PASS로 승격하지 않는다.

| 시나리오 | 결과 | 창/세션 관찰 | 프로젝트 보존 | 증거 ID | 후속 조치 |
| --- | --- | --- | --- | --- | --- |
| QA-P101 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |
| QA-P102 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |
| QA-P103 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |
| QA-P104 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |
| QA-P105 | PASS / FAIL / BLOCKED / NOT RUN |  | PASS / FAIL / N/A |  |  |

## 6. 결과 처리

모든 시나리오가 PASS이면 P1-01의 Windows 실장비 증거를 v0.1.4 마일스톤에 연결한다. FAIL이면 한 실패당 재현 가능한 최소 절차를 만들고 `electron/main.ts`, `projectSessions.ts`, 관련 IPC 또는 테스트 중 실제 원인을 가진 경계만 수정한다. BLOCKED이면 blocker와 담당자를 기록하되, 단위 테스트 통과만으로 P1-01을 완료 처리하지 않는다.

현재의 실제 실장비 결과는 [P1-01 QA 결과](p1-01-qa-results.md)에서, update 상태 UI의 별도 오류는 [업데이트 실패 진단](update-check-failure-diagnosis.md)에서 관리한다.
