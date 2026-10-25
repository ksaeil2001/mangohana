# P01-C 서버 조립 검증 기록

## C3 — 구현 및 격리 검증 완료 (2026-10-16, KST)

작업 유형은 **제품 개선**이다. 승인된 10.153 설계에 따라 서버가 이미 준비한 자원으로 OCR → TRANSLATE → CLEANUP → TYPESET 처리기와 비용·준비 포트를 조립하는 내부 `createPreparedPipelineWorker`를 구현했다. factory 호출은 worker를 반환하며 자동 실행을 시작하지 않는다. 실제 API·모델/native host 실행, 일반 worker 시작, 운영 활성화는 하지 않았다.

승인 근거와 완료 판정은 [기존 plan 10.153~10.154](C:/Users/ksaei/OneDrive/문서/trio-main/docs/superpowers/plans/2026-10-02-manga-web-workspace-contracts-and-validation-plan.md:3543)에 있다. 이 문서의 날짜가 포함된 파일명은 승인된 이름을 유지했다. 현재 제품의 번역 의미·그림 보존·가독성이나 새 만화 자동 성능을 합격시킨 기록은 아니다.

### 변경 범위

기준 경로는 `C:/Users/ksaei/Documents/Codex/trio-manga-web`다.

| 구분 | 승인 파일 | 결과 |
| --- | --- | --- |
| 신규 제품 | packages/operations/src/pipeline-runtime.ts | 고정 자원, 원 gateway 신원, 두 owner journal, 네 단계 처리기, 입력 검사 및 CLEANUP 전용 준비 hook |
| 수정 제품 | apps/api/src/runtime.ts | worker/composed factory가 원 OperationalStageCost를 ExecutionService 여섯째 인자로 전달 |
| 수정 제품 | packages/operations/src/runtime-startup.ts | 선택 비용 포트를 첫 await 전에 검사·고정·전달; native 메서드를 getter 실행 없이 검사 |
| 신규 검사 | tests/domain/pipeline-runtime.test.ts | 조립·미실행·지원 범위·사본·binding·거부·정리 책임 검사 34건 |
| 수정 검사 | tests/domain/runtime-config.test.ts | 비용 포트·native descriptor 검사 등 포함 전체 51건 |
| 수정 검사 | tests/postgres/execution-cost-preparation.test.ts | 기존 16건 본문 보존, 신규 C3 준비·실패·ACK·취소·claim·null 사실 12건 |

기존 실행기·비용/helper·LaMa verifier·19 migration·권한·가격·모델/provider·native host·설정 schema·UI·의존성·전역 설정은 수정하지 않았다. 결과 기록은 이 문서와 기존 plan에만 추가했다.

### 입력과 실행 경계

- 독립된 서버 identity, 등록 identity, 현재 DB 한도 원 기록과 정책을 대조한다. 역할 검증이 한도 조회보다 먼저다. 폰트·bucket·media/profile·등록 언어/모델/계약을 검사한다.
- 지원 입력은 현재 계약의 ja → ko, PAGE다. OCR은 기존 대사·region 없는 입력으로 제한하고, 뒤 단계의 선행 OCR 결과는 허용한다. 누락/초과/불명 입력을 다른 모델이나 호출 범위로 바꾸지 않는다.
- 첫 await 전에 plain 설정·등록값·상한과 폰트 catalog/Buffer를 소유 사본으로 고정하고 직접 사용할 메서드는 원 this에 bind한다. 원 native 객체는 private brand를 위해 같은 참조로 유지한다. opaque 자원 내부의 원 설정·DB·reader 동일성은 신뢰된 서버 부모의 책임이다.
- INPUT/RECONCILE 저장 뒤 기존 ExecutionService가 비용.prepare를 1회 수행해 BASIS를 저장한다. BASIS 확정 뒤 공통 hook이 입력을 검사하고 CLEANUP에서만 원 claim으로 준비한다. hook이 비용.prepare를 다시 호출하지 않는다. 이후 기존 checkpoint 검증·native INPUT·dispatch 경계를 사용한다.
- 조립은 PIPELINE_V1 outer와 LOCAL_OCR_V1 raw OCR journal을 구분한다. null 원가·검증 사건은 성공/0원으로 보충하지 않는다. factory 위임 전후 실패의 DB pool 정리 책임을 나누고 close 실패도 보고한다.

### 완료 조건 대조

| 조건 | 확인한 근거 | 판정과 한계 |
| --- | --- | --- |
| C3-01 조립 | 신규 factory 단위 34건과 기존 실제 TextStagesProvider/OperationalPipelineProvider 검사; factory 호출의 provider/engine/native/objects/tick I/O 0 | 완료. 실제 모델 결과 품질은 미검증 |
| C3-02 준비 순서 | worker/composed 정상 요청 → tick의 실제 C2 비용/준비/journal과 빈 PRE 검증; INPUT/RECONCILE → BASIS → hook → PRE → native INPUT 순서·cost.prepare 1회 | 완료. 실제 CLEANUP capture와 비어 있지 않은 전체 chain은 C5 미검증 |
| C3-03 실패 보존 | 준비 예외, 실제 COMMIT 반환 후 ACK 유실, REQUEST_STOP, foreign claim 뒤 원 INPUT/BASIS/RECONCILE와 비용 미확정 보존·새 I/O 0 | 완료. 원 실행 조회·재대조만 확인 |
| C3-04 고정·거부 | 첫 await 중 입력/자원/메서드/폰트 bytes 변경, metadata 상한·중첩 accessor, 잘못된 gateway, 역할 실패 조회0, 위임 전후 close1·close 실패 | 완료. opaque 내부 사후 변경 방어를 증명하지 않음 |
| C3-05 기존 경계 | null checkpoint 사실 PRE WAIT, null whole-cost 사실 UNCONFIRMED/null, public ready:false 조기 차단, native 권한 거부, 보존 감사·독립 검토 | 완료. 운영 reader·실측·활성화 완료가 아님 |

### 실제 검증

작업 경로는 위 웹 root이며 아래 명령은 별도로 실행했다. 최종 직접 단위 237건과 native 거부 10건은 서로 다른 검사다. 검토 보완 선택 실행 9건은 237건에 포함되므로 중복 합산하지 않는다.

| 실행 | 실제 명령 | 결과 | 로그 |
| --- | --- | --- | --- |
| 직접 단위·기존 경로 | `node node_modules/vitest/vitest.mjs run tests/domain/pipeline-runtime.test.ts tests/domain/runtime-config.test.ts tests/domain/runtime-native-di.test.ts tests/domain/text-stages.test.ts tests/domain/operational-pipeline.test.ts` | exit 0, 237 PASS, 5파일 | c3-domain-final-01.log |
| native 용량 거부 | `node node_modules/vitest/vitest.mjs run tests/domain/native-capacity.test.ts` | exit 0, 8 PASS | c3-native-capacity-final-01.log |
| native controller 거부 | 아래 별도 명령 | exit 0, 선택 2 PASS / 나머지 6 SKIP | c3-native-controller-final-01.log |
| C3 실제 PG 준비 | `node node_modules/tsx/dist/cli.mjs scripts/test-postgres.ts tests/postgres/execution-cost-preparation.test.ts` | exit 0, 28 PASS = 기존16 + 신규12 | c3-pg-green-02.log / c3-pg-green-02-summary.json |
| 기존 checkpoint·운영 한도 PG | `node node_modules/tsx/dist/cli.mjs scripts/test-postgres.ts tests/postgres/execution-checkpoint-completion.test.ts tests/postgres/operational-execution-limits.test.ts` | exit 0, 38 PASS = 23 + 15 | c3-pg-main-01.log / c3-pg-main-01-summary.json |
| 전체 타입 | `node node_modules/typescript/bin/tsc --noEmit` | exit 0 | c3-type-final-01.log |
| 변경 TS lint | 아래 여섯 파일 명령 | exit 0 | c3-lint-final-01.log |

```text
node node_modules/vitest/vitest.mjs run tests/domain/native-controller.test.ts -t "refuses measured production|withholds Linux production"
node node_modules/eslint/bin/eslint.js packages/operations/src/pipeline-runtime.ts apps/api/src/runtime.ts packages/operations/src/runtime-startup.ts tests/domain/pipeline-runtime.test.ts tests/domain/runtime-config.test.ts tests/postgres/execution-cost-preparation.test.ts
```

PG는 합계 **66개 고유 사례, 3파일**을 두 실행으로 확인했다. 두 실행에서 TRIO_TEST_NAME_PATTERN은 미설정이며 TRIO_TEST_PG_BIN은 사용자가 승인한 Temp PG18.6 bin을 지정했다. PG 28건 이후 검토 수정은 신규 pipeline-runtime과 verified startup의 descriptor 검사에 한정되며, 28건이 사용하는 runtime.ts와 검사 파일 SHA가 그대로임을 최종 감사로 확인해 유효한 결과를 재사용했다.

격리 데이터는 loopback의 새 PG18.6, 합성 계정·자료, 임시 무작위 credential이며 현재 19 migration과 실제 서비스 LOGIN을 사용했다. credential과 연결 URL은 보고서에 기록하지 않았다. 담당 3회(red02/green01/green02)와 메인 1회의 소유 클러스터 모두 shutdown 로그와 postmaster.pid 부재를 확인했고 다른 클러스터는 조작하지 않았다.

### TDD와 독립 검토

- 비용 전달 단위는 구현 전 4 FAIL / 4 PASS / 40 SKIP을 확인했다. 신규 pipeline 모듈이 없는 import 실패는 별도 기록하며 실행된 사례 수로 계산하지 않았다.
- PG 기능 RED는 두 factory에서 비용.prepare 호출이 0회인 2 FAIL / 26 SKIP이었다. 그 후 제품 연결과 fixture 기대값 한 곳 수정 뒤 전체 28 PASS다. 최초 ENOENT(실행0건), 초기 단위 assertion 출력의 메모리 부족, 후보 fixture/타입 오류는 기능 RED나 성공 증거로 세지 않으며 과거 로그를 보존했다.
- PG 최초 전체 실행의 26 PASS / 2 FAIL은 native sourceInput.stageInputDigest 기대값을 full INPUT fingerprint로 잘못 쓴 fixture 문제였다. 실제 semantic input.inputDigest exact 기대값으로 한 곳 수정했고 다른 full fingerprint 검사는 유지했다. 비용.prepare 0회였던 원 기능 RED와 구분했다.
- architect가 native maintenance getter/Proxy 검사 누락과 사본·직접 메서드 고정의 검증 부족을 Important로 지적했다. 먼저 선택 회귀에서 5 FAIL / 4 PASS를 확인하고 승인된 제품 두 파일의 descriptor 검사를 보완해 9 PASS로 만들었다. metadata·폰트 Buffer·binding 3건은 기존 구현에서 통과한 검증 보강이다.
- architect는 실제 소스·검사·RED/GREEN 로그를 읽기 전용으로 재대조해 두 지적 해소 및 추가 수정 요구 없음을 확인했다. 최종 검증·인수 조건·범위 통합 판정은 메인이 수행했다.

### 증거와 보존

OS Temp 증거 root:

```text
C:/Users/ksaei/AppData/Local/Temp/trio-p01c-c3-20261016-fc96d8e003524ddc80da31a29315c77b
```

검증 raw 로그, PG environment/summary/postgres.log, 6파일 최종 diff·SHA manifest, c3-source-final-audit.json, c3-pg-final-audit.json, c3-pg-main-01-summary.json과 최종 문서 감사는 이 root에 보존한다. 366개 기존 웹 파일 중 승인된 기존 4파일만 변경하고 신규 source/test 2개와 이 결과 문서 1개만 추가했다. 나머지 362파일·migration19개와 기존 Electron Git dirty76항목은 그대로다. 기존 plan 1,087,963바이트 prefix를 보존하고 10.154에 이번 결과만 기록했다. UTF-8·실제 후행 공백·CRLF를 고려한 diff 검사도 확인했다.

기존 PG 실행 파일이 없어 사용자의 별도 승인으로 공식 EDB PG18.6-5 portable archive만 task Temp/tools에 복원했다. archive SHA-256은 `e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2`이며 384,620,317바이트다. 서비스 설치·전역 경로/설정·제품 의존성을 바꾸지 않았다. c3-pg-restoration.json은 검증 시작 전 복원 시점의 기록이고, 이후 소유 테스트 DB 시작·종료는 각 PG summary가 증명한다.

### 남은 범위와 다음 작업

C3의 서버 내부 조립과 격리 회귀는 완료했다. **C4의 stop/idle 전체 비용 대기 연결**, **C5의 실제 네 단계·비어 있지 않은 checkpoint/native chain 통합**은 별도 작업이다. 이번 PG fixture는 실제 C2 구성요소를 사용하지만 whole-cost reader=null, 빈 PRE facts와 동작하지 않는 저수준 provider/native 경계를 명시적으로 사용한다. 이를 운영 reader·실측·권한 또는 실제 CLEANUP 성공으로 확대하지 않는다.

실제 웹 업로드부터 다운로드까지의 흐름, 실제 외부 API·모델/native host, 운영 활성화와 새 만화의 수동 보정 없는 품질은 미검증이다. 다음은 기존 계획의 C4 입력·기대 결과·변경 파일·완료 조건·검증 방법을 구체화하는 설계다. C4 구현이나 운영 활성화는 이번 승인으로 진행하지 않았다.

## C4 — 종료·취소 시 원 처리와 비용 확인 대기 (2026-10-16)

**작업 유형: 제품 개선 + 격리 검증.** 사용자가 승인한 10.155 설계의 제품 7파일·검사 8파일 범위에서 구현했다. 서버의 종료 대기는 진행 중인 원 처리와 비용 확인을 함께 기다린다. 앞 단계가 실패해도 뒤의 대기를 시도하며, 미확정 실행·비용을 성공이나 0원으로 바꾸지 않는다. 기존 C3 절의 다음 작업은 당시 기록이며 이 C4로 이어졌다.

**완료 판정:** architect 최종 재검토에서 Important 1건 해소와 추가 Critical/Important 없음이 확인됐다. C4-01~05의 구현·선정 격리 검증을 충족했다. 실제 외부 API·모델/native host·일반 worker 시작·운영 활성화·설치·commit/push·배포는 하지 않았다. 실제 웹 전체 흐름과 새 만화의 자동 번역 품질은 미검증이다.

### 구현과 변경 범위

경로 기준은 C:/Users/ksaei/Documents/Codex/trio-manga-web이다.

| 구분 | 변경 파일 |
| --- | --- |
| 제공자 제품 3 | packages/providers/src/local-ocr.ts, local-translation.ts, gemini.ts |
| 서버 조립·종료 제품 4 | packages/operations/src/pipeline-runtime.ts, runtime-startup.ts, runtime-lifecycle.ts; apps/api/src/runtime.ts |
| 제공자 검사 3 | tests/domain/local-ocr.test.ts, local-translation.test.ts, providers.test.ts |
| 조립·종료 검사 4 | tests/domain/pipeline-runtime-lifecycle.test.ts(신규), pipeline-runtime.test.ts, runtime-config.test.ts, runtime-lifecycle.test.ts |
| 실제 비용 PG 검사 1 | tests/postgres/execution-cost-preparation.test.ts |

1. **원 작업 합류:** OCR은 원 invoke의 joined를 즉시 관찰하며 bounded reply와 원 START/RESULT를 유지한다. 번역은 기존 entry.promise의 close·callback을 기다린다. Gemini는 원 request/read/reader cancel/body cancel을 추적하며 기존 응답 timeout을 유지한다. 정상 응답 경로가 처리한 transport/read/abort 오류와 독립 cancel 실패를 구분한다.
2. **같은 자원 연결:** prepared factory가 원 OCR·번역 idle을 고정한 closure를 전달하고 verified factory가 own data/function을 검사한다. 누락·getter·Proxy·잘못된 메서드는 자원 사용 전에 거부한다. 공개 ProviderAdapter·설정/schema·원 OCR executor·도메인 비용 계약을 바꾸지 않았다.
3. **차단 후 전체 대기:** stopped를 동기적으로 고정하고 기존 admission barrier를 모두 시도한다. worker는 tick/maintenance→provider→native→원 cost 순서로, API는 tick/build→native 순서로 기다린다. composed는 두 역할을 모두 기다린다. 단일 오류의 원 identity와 다중 오류를 보존하며 비용 대기를 마지막에 수행한다.
4. **종료 전후 캐시:** 처리 시작 때 내부 작업 revision을 증가시키고 합류한 세대가 바뀌면 최신 producer부터 다시 기다린다. stop 전 대기를 최종 종료 성공으로 승격하지 않으며 같은 stopped 세대의 성공만 공유한다. 이미 시작된 자원 대기 중 새 처리가 끼면 그 처리가 등록한 늦은 비용까지 새 합류로 확인한다. 완료된 업무 오류는 후속 idle에서 영구 재생하지 않고 성공한 자원 합류는 재사용한다.
5. **사실에 맞는 종료:** admission/ingress/idle 실패에도 가능한 대기를 수행하고 미확정이면 pool을 닫지 않는다. timeout 보고는 미확정으로 남으며 원 대기가 나중에 안전하게 끝나면 그때 close할 수 있다. cost.idle은 진행 중인 확인 작업의 합류이며 모든 DB 비용의 확정이나 환불·물리 종료 증명이 아니다.

추적 완료 이력은 최초 실패 하나로 O(1)이다. pending Set은 미합류 작업 수에 비례하며 adapter 자체의 고정 상한은 없다. 기존 SQL 전역 slot은 정상 prepared 경로에서 원 permit이 보존된 경우에만 제한 근거다. heldBytes나 idle 성공을 잔여 HTTP I/O 상한·물리 종료·예산 해제 근거로 쓰지 않는다.

### 완료 조건과 직접 근거

| 조건 | 확인한 결과 |
| --- | --- |
| C4-01 원 합류 | 실제 adapter와 가짜 engine/child/HTTP/stream/cancel gate로 응답 후 남은 원 작업 대기, 원 START/RESULT·timeout 보존, 추가 요청 0 확인 |
| C4-02 전체 대기 | worker/API/composed의 순서·고정 this/인스턴스·앞 실패 뒤 대기·늦은 비용·동기 신규 claim 차단 확인 |
| C4-03 종료 보고 | timeout·실패 시 조기 close 0, 정상 뒤 close 1, 동시/반복 idle, 빈 idle과 새 처리의 stop 전후 전환, 과거 업무 오류 재생 방지 확인 |
| C4-04 취소·원 사실 | 실제 C2 pending 2, 시작 후 REQUEST_STOP/늦은 비용/재시작 2, HANDOFF owner/불변 대조 4와 기존 취소·claim·예약 독립 회귀 확인 |
| C4-05 범위·증거 | 원 gate/역할/등록/공개 시작 차단 보존, 아래 선정 검사·타입/lint·SHA/범위 감사 및 독립 검토 수행 |

PG 신규 8개는 실제 C2 준비·journal·OperationalStageCost와 원 INPUT/BASIS/RECONCILE을 사용한다. pending은 같은 cost.finishAttempt의 reader.workSetIn를 deferred null로 지연시켰다. 시작 후 취소는 실제 started callback을 기다린 가짜 provider와 API REQUEST_STOP을 사용하며, 늦은 보고금액은 원 evidence에 남고 STAGE_TOTAL은 UNCONFIRMED/null로 유지된다. 재시작에서 원 execution만 확인하고 재제출·무료사용 중복은 없다.

owner 검사는 실제 HANDOFF 뒤 제품 validated()가 가짜 provider.validateObservation의 DB owner session/tab/revision reader를 호출해 mismatch를 거부하며, 같은 원 tuple의 불변 대조군은 통과한다. 이것은 명시한 가짜 authority 경계다. 빈 PRE·whole-cost reader=null·동작하지 않는 저수준 native/provider를 실제 NativeGateway binding·양성 publication·물리 비용/종료·전체 네 단계 실행 증거로 세지 않는다.

### 수행한 검증

아래 명령은 웹 root에서 실행했다. 반복 실행은 최종 건수에 중복 합산하지 않았다.

| 실행 | 결과 | 최신 로그 |
| --- | --- | --- |
| 조립·종료 관련 단위 5파일 | 151 PASS, exit 0 | c4-main-full-04.log |
| 제공자 단위 3파일 전체 | 174 PASS / 기존 조건부 1 SKIP, exit 0 | c4-provider-green-final.log |
| 비용·실행·native 독립 회귀 7파일 | 301 PASS, exit 0 | c4-regression-domain-01.log |
| native-controller 거부 선택 2개 | 2 PASS / 선정 제외 6 SKIP, exit 0 | c4-native-denial-01.log |
| 비용 준비 PG 1파일 전체 | 36 PASS = 기존 28 + 신규 8, exit 0 | c4-pg-postreview-01.log |
| 기존 실행·비용·예약·checkpoint PG 5파일 | 106 PASS, exit 0 | c4-pg-regression-01.log |
| 전체 TypeScript | exit 0 | c4-type-final-02.log |
| 변경 TS 15파일 ESLint | exit 0 | c4-lint-final-02.log |

고유 선정 합계는 **단위 628 PASS, PG 142 PASS**다. provider의 1 SKIP은 pinned V1 before-adapter 경로·SHA 환경변수가 없는 기존 조건부 검사다. controller의 6 SKIP은 실제 host 경로를 실행하지 않기 위해 명시적으로 고르지 않은 사례다. 이를 통과로 계산하지 않았다.

```text
node node_modules/vitest/vitest.mjs run tests/domain/pipeline-runtime-lifecycle.test.ts tests/domain/pipeline-runtime.test.ts tests/domain/runtime-config.test.ts tests/domain/runtime-native-di.test.ts tests/domain/runtime-lifecycle.test.ts
node node_modules/vitest/vitest.mjs run tests/domain/local-ocr.test.ts tests/domain/local-translation.test.ts tests/domain/providers.test.ts
node node_modules/vitest/vitest.mjs run tests/domain/operational-pipeline.test.ts tests/domain/execution-cost-preparation.test.ts tests/domain/pipeline-stage-cost.test.ts tests/domain/native-controller-attempts.test.ts tests/domain/local-ocr-executor.test.ts tests/domain/native-capacity.test.ts tests/domain/text-stages.test.ts
node node_modules/vitest/vitest.mjs run tests/domain/native-controller.test.ts -t "refuses measured production|withholds Linux production"
node node_modules/tsx/dist/cli.mjs scripts/test-postgres.ts tests/postgres/execution-cost-preparation.test.ts
node node_modules/tsx/dist/cli.mjs scripts/test-postgres.ts tests/postgres/execution.test.ts tests/postgres/pipeline-stage-cost.test.ts tests/postgres/native-execution-wait.test.ts tests/postgres/execution-checkpoint-completion.test.ts tests/postgres/execution-limits.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js packages/providers/src/local-ocr.ts packages/providers/src/local-translation.ts packages/providers/src/gemini.ts packages/operations/src/pipeline-runtime.ts packages/operations/src/runtime-startup.ts apps/api/src/runtime.ts packages/operations/src/runtime-lifecycle.ts tests/domain/pipeline-runtime-lifecycle.test.ts tests/domain/local-ocr.test.ts tests/domain/local-translation.test.ts tests/domain/providers.test.ts tests/domain/pipeline-runtime.test.ts tests/domain/runtime-config.test.ts tests/domain/runtime-lifecycle.test.ts tests/postgres/execution-cost-preparation.test.ts
```

PG는 기존 승인 PG18.6 bin을 TRIO_TEST_PG_BIN으로 지정하고 이름 필터 없이 각 파일 전체를 실행했다. 새 loopback 클러스터·합성 계정/자료·임시 무작위 credential·기존 19 migration과 서비스 LOGIN을 사용했다. credential이나 DB 연결 URL은 기록하지 않았다. 담당 4회와 메인 2회의 소유 클러스터 모두 shutdown 로그와 postmaster.pid 부재를 확인했고 다른 클러스터는 조작하지 않았다.

독립 검토 보완 뒤 runtime을 사용하는 PG 36개를 새로 실행하고 실행 전후 15파일 SHA 일치를 확인했다. 106개 PG는 runtime import가 없는 도메인 회귀이며 해당 코드·환경이 그대로라 재사용했다. provider·도메인 301개·native 거부 회귀도 보완으로 관련 소스가 바뀌지 않았다. 영향을 받는 main 5파일·전체 타입·15파일 lint는 보완 후 재검증했다.

### TDD·중간 실패와 독립 검토

- 제공자 초기 RED는 15 FAIL과 원 OCR joined의 미관찰 rejection 1건이었다. 추가 경계 RED 3건은 같은 턴 빈 idle 뒤 새 번역 누락 1건과 정상 처리된 stream 오류 오분류 2건이었다. 최종 신규 18개와 기존 검사를 함께 확인했다.
- runtime/config/lifecycle의 의미 있는 RED는 c4-runtime-red-02의 15 FAIL / 5 PASS / 55 SKIP, 조립은 c4-composition-red-01의 4 FAIL / 34 SKIP이다. 최초 c4-runtime-red-01의 fixture 대기/timeout은 별도로 보존하고 모두 기능 RED였다고 주장하지 않는다.
- PG 최초 실제 RED는 2 FAIL / 28 SKIP이며 준비 실패가 아니라 비용 pending을 기다리지 않은 실패였다. 중간 전체 PG 두 번의 34 PASS / 2 FAIL은 각각 native.idle 중복과 과거 업무 오류 재생을 검출했다. 직접 단위 RED를 남기고 제품을 보완했으며 기존 PG28 본문과 once assertion은 바꾸지 않았다.
- main 첫 전체 실행의 기존 lifecycle 2 FAIL은 불필요한 async wrapper의 추가 microtask로 생겼다. wrapper를 없애 원 직접 await 경계를 유지했고 기존 검사 본문을 약화하지 않았다.
- architect는 stop 전 빈 idle 직후 새 producer→stop→idle에서 최신 작업을 놓칠 수 있음을 Important 1건으로 지적했다. 새 회귀 7개 중 5 FAIL / 2 PASS를 확인한 뒤 승인된 runtime 한 파일을 보완해 7 PASS로 만들었다. 기본 같은 턴의 worker tick/maintenance·API tick과 이미 provider 대기가 시작된 뒤의 worker/composed 새 처리·늦은 비용을 검사한다. 기존에 통과한 composed 기본 2개를 새 결함의 RED로 부풀리지 않았다.

architect는 원 사본 대비 전체 패치와 실제 호출 경로를 검토하고, 보완 뒤 실제 소스·직접 RED/GREEN·main151·PG36·전체 타입/lint·현재15파일 SHA를 다시 대조했다. stop 전후 캐시의 유효 범위, 최신 producer 재합류와 과거 업무 오류/성공한 자원 합류의 분리를 확인해 Important1 해소와 추가 Critical/Important 없음을 판정했다. 독립 검토는 읽기 전용이었으며 최종 인수 조건·범위·증거 통합은 메인이 수행했다. 원 검토와 재검토는 c4-architect-review-01.txt / c4-architect-review-02.txt에 보존했다.

### 증거·보존과 남은 범위

증거 root:

```text
C:/Users/ksaei/AppData/Local/Temp/trio-p01c-c4-20261016-a1a7d7d5110548cb864158b9f234560d
```

원 RED·중간 실패·최종 GREEN, PG environment/summary/postgres.log, 제공자/PG manifest, architect 검토, 15파일 최종 diff/SHA, 소스와 문서 감사는 이 root에 보존했다. 기존 웹 369파일 중 승인된 코드/검사 14파일과 이 기존 결과 문서만 변경하고 신규 검사 1개를 추가했다. 나머지 354파일과 migration19개는 unchanged다. 원 검증 문서 11,777바이트와 원 plan 1,120,950바이트 prefix를 보존하고 기존 plan 10.156에 기록했다. 기존 Electron Git dirty76항목의 status 집합도 동일하다. 최종 UTF-8·공백·로컬 참조·diff/범위 검사는 c4-doc-final-audit.json에 남긴다.

C4는 서버 종료·취소 대기의 공통 연결을 개선했다. 실제 NativeGateway binding·물리 비용/종료·비어 있지 않은 checkpoint/native chain·네 단계 전체 실행은 **C5 미검증**이다. 실제 웹 업로드부터 다운로드까지의 결과, 운영 활성화와 새로운 만화의 수동 보정 없는 품질도 미검증이다. **다음 작업은 C5의 입력·기대 결과·변경 파일·완료 조건·검증 방법을 먼저 정하는 설계**다. C5 제품 구현이나 실제 외부 실행은 이번 승인에 포함하지 않는다.


## P01-C C5 — 네 단계·비어 있지 않은 checkpoint·native 원자료 연결 검증 (2026-10-16~17)

사용자가 승인한 10.157에 따라 제품 개선과 격리된 제품 검증을 수행했다. 이번 제품 변경은 `packages/domain/src/operational-pipeline.ts` 한 파일이며, 검사 범위는 `tests/domain/operational-pipeline.test.ts`, 신규 `tests/fixtures/pipeline-runtime.ts` 및 신규 `tests/postgres/pipeline-runtime.test.ts` 세 파일이다. 기존 계획 10.158과 이 결과 문서에 기록을 추가했다.

### 제품 변경과 먼저 확인한 실패

checkpoint의 원 관측을 재검증할 때 이전에는 출력 자산만 실제 bytes로 읽어 원 INPUT의 원본·font·license 의존성이 읽기 사건에서 빠졌다. `validateObservation`에서 기존 checkpoint임을 먼저 식별하고, 원 journal·계획·출력 무결성을 확인한 뒤 INPUT와 출력 의존성의 정확한 합집합을 검증한다. 같은 자산 ID의 hash/size 충돌은 I/O 전에 거부하고, 기존 출력 읽기와 중복하지 않으며 기존 bounds·원 제공자 경로를 보존한다. 제품 diff는 15줄 삽입·1줄 삭제이며 다른 메서드/SQL/schema/공개 포트는 바꾸지 않았다.

단위 `c5-unit-red-02`는 119개 중 기존 등 107 PASS·신규 실패 12개였다. 제품 수정 전 실제 prepared PG `c5-pg-red-02`에서는 원 OCR·START/INPUT/BASIS·native source/GO/receipt/termination·확정 비용이 통과한 뒤, 첫 PRE1의 원본/세 font/license 실제 읽기 5개가 누락돼 실패했다. import·설정·환경 실패를 기능 RED로 세지 않았다. 이후 동일 단위 119개와 관련 197개가 통과했다.

### C5 인수 대조와 신뢰 경계

| 조건 | 실제로 확인한 것 |
| --- | --- |
| C5-01 네 단계 | 정상 WorkspaceService 명령→원 prepared worker→OCR/TRANSLATE/CLEANUP/TYPESET SUCCESS 4개, PRE target 0/1/2/3, FINAL target 4, checkpoint 4·application 1·무료 시작 1. 합성 출력은 현재 원본과 분리 |
| C5-02 원 비용·native 귀속 | 원 INPUT/BASIS/단계 output/검증 attempt·operation·VERIFIED와 실제 source/claim/GO/RESULT/receipt/termination ID·digest를 대조. 처리·검증·I/O와 비용 closure의 exact refs, 측정 member IDs/수량, capacity/budget 근거 ID를 각각 검사. 합성 비용은 단계당 .006+.004=.01, fresh4 합계 .04 |
| C5-03 재구성·재사용 | INPUT/BASIS/candidate ACK 및 완료 ACK 손실 뒤 같은 DB/원 journal로 runtime 재구성, 중복 제출·비용·application 방지. 실제 RETRY_REQUEST 부분 재사용은 기존 OCR 비용/기록 보존·새 세 단계만 추가. 새 consumer 없는 전부 재사용은 실제 authorize null·재예약·추가 검증/실행/현재 결과0 |
| C5-04 한 원인씩 거부 | PRE semantic/storage/digest, native 원자료/receipt/종료 UNKNOWN, 다른 INPUT/account/claim, 원 bytes, FINAL live/역사 ref 누락·변조, HALTED/profile, 비용/배분 미확정·late GET/다른 비용, STOP 전후와 정상 HANDOFF/과거 권한을 분리. 원 known 사실 보존과 현재 결과·예산 보호를 별도 검사 |
| C5-05 종료·경계 | native/provider/cost deferred gate가 남으면 pool close0, join 뒤 close1. 읽기 어려운 합성 layout HOLD는 원 편집 자료·overlay 계획 보존. 현재성은 현재 권한으로 검사하고, context 종료/owner 소멸/자산 삭제·만료 뒤 역사 비용은 원 봉인 자료로 DB-only 재조회 |

가짜 부분은 OCR runner, 번역 응답·LaMa reply, native controller 계산, 고정 PNG·대사·합성 요율 및 검사 전용 신뢰 reader다. 실제 `NativeDatabaseGateway`·NativeJobStore/ReceiptStore·capacity·CheckpointValidationJournal·FullStageCostPreparation/Journal·OperationalStageCost·ExecutionService·서버 factory를 통과한다. reader는 실제 호출에서 관측한 원 사건과 원 DB source를 검증하며 사후에 임의 job/GO/owner/claim을 만들지 않는다. native 없는 checkpoint validation은 빈 배열이 맞다. 별도 CHECKPOINT native guard 2개는 명시한 합성 검사이며 정상 제품 경로의 native 작업 수로 세지 않는다.

저장 수량·native 수량의 합성 단가 0은 물리 작업이 없다는 뜻이 아니다. exact event/member 집합·quantity를 별도로 확인했다. OWNED capacity의 GO/종료/해제 SQL 상태는 가짜 계산 위의 실제 DB 계약 검증이며 물리 프로세스·격리·메모리/실제 가격의 실측 증거가 아니다. 재구성은 같은 DB·원 fixture 사건 journal을 보존한 runtime/reader 재조립이며 OS 충돌 복구 증거가 아니다. journal 소실·closure 뒤 추가 작업은 WAIT/미확정으로 남긴다.

### 실행·중간 실패·독립 검토

| 실행 | 결과 | 최종 근거 |
| --- | --- | --- |
| 직접/관련 단위 6파일 | 316 PASS, FAIL/SKIP 0, exit 0 | c5-unit-green-final-summary.json / .log |
| 신규 C5 PG 1파일 전체·이름 필터 없음 | 38 PASS, FAIL/SKIP 0, exit 0 | c5-pg-full-04-run.json / -execution-summary.json / .log |
| 기존 선정 PG 9파일 | 153 PASS = 122+31, FAIL/SKIP 0, exit 0 | c5-regression-pg-final-audit.json |
| 전체 TypeScript tsc --noEmit | exit 0 | c5-type-final-05-summary.json / .log |
| 변경 TS 4파일 ESLint | exit 0 | c5-lint-final-05-summary.json / .log |

선정 범위의 유효 합계는 단위 316·PG 191 PASS다. 반복 실행과 중간 이름 필터의 제외 사례는 합산하지 않았다. 단위 및 기존 PG는 현재와 같은 관련 소스/환경의 유효한 기록을 재사용했고, 신규 C5는 마지막 보완 후 전체 파일을 다시 실행했다.

원 명령은 10.157.6에 기록한 기존 runner/선정 파일을 사용했다. 신규 C5 PG는 최종 이름 필터 없이 전체 파일을 실행했다. PG18.6은 기존 승인 bin을 지정했고 새 loopback DB/임시 무작위 credential/원 19 migration과 실제 서비스 LOGIN을 사용했다. 시험 프로세스에서 fetch·HTTP(S)·child_process를 실패시키고 해당 DB의 정확한 127.0.0.1/port만 허용했다. 이 포트 관측을 호스트 전체 방화벽·실제 서비스/물리 host 증거로 확대하지 않는다.

중간 실패도 보존했다. 최초 fixture의 raw capacity·claim·ObjectReceipt 시각 오류는 fixture 경계로 분리했다. 확장01은 동시 fixture 수정으로 sourceStable=false였으므로 최종 근거에서 제외했다. FINAL history 공격 대상이 PRE operation이었던 선택 오류, 물리 종료 SQL enum 기대 오류, layout nullable output/기존 font 계약 오류, OUTCOME 별도 투영을 closure 집합에 섞은 기대 오류를 원 코드·계약에 맞게 바로잡았다. assertion/제품 보호를 약화해 성공시키지 않았다.

정상 HANDOFF에 후속 실행0을 요구했던 기대는 기존 Q15-A(진행 중 요청 유지) 및 상세 계약의 OwnerRevision/UI 권한·원 응답 적용 구분과 충돌했다. 독립 검토로 이를 확인하고 정상 인계 완료와 A 탭 명령/heartbeat·A CURRENT PRE attempt 거부, B의 후속 PRE/FRESH native/FINAL 현재 권한을 분리했다. 원 SUCCESS와 원 비용을 보존하며 같은 요청이 한 번 완료된다. HANDOFF 조회의 SQL column 오류와 authorize/applyComplete의 원 FINAL guard 2회를 1회로 오인한 검사 기대도 각각 수정했다. 설계 C5-04의 짧은 문구가 Q15-A를 폐기했다는 해석은 채택하지 않았다.

전부 재사용 검사에서 임의 hold 문자열을 느슨한 상태 검사로 대체하려던 1차 변경은 자동 승인 검토가 보호 assertion 약화 우려로 거부했다. 적용하지 않았고, 독립 검토 뒤 실제 authorize null·재예약·검증/실행/현재 결과0을 직접 확인하는 더 강한 검사를 구체화해 승인 검토를 통과했다.

초기 full01의 DB 접속0 진단은 기본 postgres DB에 한정되어 있었으므로 클러스터 전체 활동0의 근거로 사용하지 않는다. full01은 중복 spy가 이미 감싼 함수를 다시 호출해 재귀·정체한 검사 결함이었다. 본인 Vitest PID/부모/시작 시각과 자식만 확인해 중단하고 원 runner의 finally로 소유 PG를 종료했다. exit -1(Windows 환경 값 4294967295), 집계 미완료이며 성공으로 세지 않았다. 두 wrapper는 덮어쓰기 전 실제 구현 snapshot을 고정해 원 검증과 두 관찰을 모두 보존하도록 수정했다. 독립 검토가 추가 지적한 live FINAL ref 공백은 최초 VERIFIED 전 원 FINAL4 facts의 ref 하나만 손상시키고, 후속 실제 finalCommit WAIT·application0·원 SUCCESS/앞3 확정 비용·TYPESET 미확정/예산 보류를 검사해 보완했다. 자동 복귀 경로를 만들거나 보장하지 않았다. 독립 검토에서 최초 fault 처리 뒤에만 잡았던 보존 기준의 공백도 확인했다. 같은 transaction에서 ref 손상 전 원 INPUT/BASIS·known output·앞3비용·page/results를 캡처하고, 첫 실패 tick 직후와 후속 완료 시도 뒤를 모두 그 원자료와 대조하도록 보완했다. 중간 full02의36 PASS와 full03의38 PASS는 해당 소스의 근거로 보존하며 최종 소스는 full04로 구분한다.

제품 최소 변경은 별도 architect가 원 사본·직접 RED/GREEN·현재 SHA·기존 101개 보존을 검토했고 추가 Critical/Important 없음을 판정했다(c5-architect-product-final.txt). 통합 architect는 실제 native/cost 원자료와 실패 집합·Q15-A 인계·전부 재사용 guard를 검토했다. Important로 지적한 live FINAL 실제 완료 차단 및 최초 fault 이전 보존 기준 공백을 보완한 뒤 최종38 PASS·현재4파일 SHA·타입/lint와 대조해 해소·추가 Critical/Important 없음을 확인했다(c5-architect-integration-final.txt/.json). 두 검토는 읽기 전용이며 검토자가 제품/검사를 변경하거나 테스트를 별도 실행하지 않았다. 최종 범위·인수 통합은 메인이 수행했다.

### 증거·보존과 다음 경계

증거 root는 `C:/Users/ksaei/AppData/Local/Temp/trio-p01c-c5-20261016-5e314ea7cf7542dbbedb9455e6cddd77`다. RED·중간 실패·최종 실행, 실행 전후 source SHA, PG environment/postgres.log·소유 cluster 종료, 독립 검토, 최종 diff/범위 감사가 여기에 있다. 웹 기준 374개 파일 중 승인된 제품·기존 단위·기존 결과 문서 3개만 변경하고 신규 검사 2개를 추가했다(현재 376개). 나머지 371개와 migration 19개를 bytes/SHA로 대조한다. 원 계획 1161616바이트와 원 결과 문서 25643바이트 접두부를 보존한다. 초기 기준의 tracked dirty47개 status는 같은 옵션으로 대조하고, 일반 status76개 중 untracked29개는 별도 목록으로 기록한다. 옵션 차이로 생긴 목록 차이를 이번 신규 변경으로 계산하지 않는다. 최종 UTF-8·whitespace·diff·source SHA/실행 근거·소유 PG 종료 감사는 c5-final-scope-and-evidence-audit.json에 남긴다. node_modules의 Vitest 결과 cache 갱신은 c5-regression-pg-cache-audit.json에 별도 기록했다.

이번에 실제 외부 API·모델/native child·일반 worker 진입점·운영 활성화·설치·commit/push·배포는 하지 않았다. 실제 웹 업로드부터 다운로드까지의 흐름, OCR/번역 의미·원문 제거·그림 보존·식자 가독성, 새로운 만화의 수동 보정 없는 품질은 미검증이다. C5의 합성 연결 검증을 전체 번역 제품의 품질 완료로 확대하지 않는다.

다음은 P01-D 진입 전에 필요한 실제 한 페이지 검증의 입력·격리 환경·물리 native 종료/용량·원 프로세스 측정·전체 비용 근거·별도 승인 조건을 설계하는 것이다. 이번 승인으로 실제 외부 실행이나 운영 gate를 열지 않는다.
