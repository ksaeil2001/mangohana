# P01-C C2 전체 비용·검증 귀속 검증

상태: C2의 승인된 구현·SQL 소스 추가·정상 migration 경로의 격리 검증·최종 독립 검토를 완료했다. 사용자가 승인한 0019를 소스에 추가했고, 분리 실행 결과를 합친 PG9파일152개 사례의 유효한 통과 근거를 확보했다. 운영 DB에는 적용하지 않았다.

작업 유형은 제품 개선과 합성 포트를 이용한 격리 제품 검증이다. 실제 외부 API·OCR/번역/LaMa 모델·native host·일반 worker 시작·운영 활성화·설치·commit/push·배포는 수행하지 않았다. C3~C5와 전체 웹 처리·새 만화의 무보정 품질은 미검증이다.

## 기준과 변경 범위

[기존 계획 10.150과 C2 기록 10.152.1~2](C:/Users/ksaei/OneDrive/문서/trio-main/docs/superpowers/plans/2026-10-02-manga-web-workspace-contracts-and-validation-plan.md)를 따른다. 원 INPUT·최초 claim·단계별 가격 snapshot을 보존하고 첫 검증 전 BASIS를 commit한다. 원 작업 종료→기존 계산→정확한 계산 ID/digest를 참조하는 불변 closure→원 실행의 STAGE_TOTAL·기존 한도 expense 연결이 완료 조건이다.

| 파일 범위 | 책임 |
| --- | --- |
| packages/domain/src/pipeline-stage-cost.ts, full-stage-cost-journal.ts | 고정 비용 기준·원 작업/종료·정확한 계산/closure·같은 트랜잭션 조회 |
| packages/domain/src/checkpoint-validation.ts | 원 INPUT/BASIS·실제 검증 사건·정확한 checkpoint 집합·현재 게시/선행 검증/역사 비용 구분 |
| packages/domain/src/execution.ts | INPUT/BASIS 순서·늦은 전체 비용 투영·중복/취소/실패·완료 경계 |
| packages/domain/src/local-lama-native-preparation.ts, local-lama-attempt-journal.ts | helper가 확인한 정확한 evidence/job ID만 기존 두 fence에 연결 |
| db/migrations/0019_stage_cost_projection.sql | 승인된 원 전체 비용 근거와 한도 expense·예약 해제 연결 |

직접 검사는 기존 C2의 7파일과 신규 migration에 필요한 기존 tests/postgres/migrations.test.ts의 fixture 한 곳이다. TypeScript 14파일과 신규 SQL 1파일, 이 결과 문서 및 기존 계획을 변경했다. migration fixture는 예상 버전에 0019를 추가하고 정확한 reconcile(uuid)의 본문 변경을 구분하면서 OID/owner/ACL/SECURITY DEFINER/search_path, 나머지 함수 본문·업무 사실·이전 migration hash·중복 원자료 보존을 계속 확인한다.

## 확인한 동작

- 같은 계정 잠금에서 INPUT과 RECONCILE를 저장한다. 다른 실행의 INPUT은 BASIS 생성 전에도 다음 준비를 막는다. 첫 비용 가능 I/O 전에 기준을 commit하고 재시작 조회에서 현재 가격으로 새 기준을 만들지 않는다.
- 가격·수량·배분·실제 원 작업/종료가 확인된 계산만 closure에 연결한다. 자료 누락은 UNCONFIRMED/null이다. 같은 operation/event의 중복 귀속과 joined/termination 참조 중복을 거부한다. 정확히 봉인된 계산만 사용하며 동일 금액의 다른 계산으로 대체하지 않는다.
- 중복 observation·native WAIT·lookup null에서도 원 비용을 같은 실행으로 대조한다. 비용 충돌은 원 actual과 근거를 보존하고 evidence_conflict를 남긴다. 미봉인 충돌 계산은 새 actual이나 RECONCILE DONE의 근거가 되지 않는다. UNKNOWN을 0원·실패·재전송으로 추정하지 않는다.
- 검증 helper는 이번 attempt의 실제 semantic/storage 사건과 원 native GO/receipt/termination을 대조한다. 부족한 원자료는 WAIT다. CACHE는 원 job/claim/source를 보존하며 추가 GO가 없다. 역사 비용 조회는 요청/context 종료·owner 변경·자산 삭제/만료 뒤에도 봉인된 FINAL ATTEMPT/VERIFIED/각 OP와 원자료를 확인한다. 현재 게시 권한과 새 GET/GO는 생기지 않는다.
- TYPESET의 준비 실패·취소·거부와 dispatch FAILED/실제 START 없는 REJECTED는 원 작업·종료 근거로 비용을 닫는다. 성공 TYPESET의 FINAL 요구를 유지한다. 종료 근거 누락·START 모순·FINAL 없는 UNKNOWN은 보류한다. 전체 비용 BASIS 모드의 용량/예산은 원 비용·종료 봉인 뒤 해제하며 모델 미시작 이후 준비 비용도 실제 금액으로 기록한다.

신규 SQL은 원 INPUT/BASIS·정확한 계산 ID/digest·closure·실제 작업/종료 참조를 대조한다. 다른 계정/실행·자기 참조·누락/중복·잘못된 보호 참조·1 MiB 초과를 거부한다. START/미시작 모순은 비용 확정 전에도 즉시 HALT한다. 실제 한도 초과 금액은 축소하지 않고 보존한다. 기존 일반 경로의 잠금·한도·충돌·권한을 유지한다. JS canonical hash·계산 재현은 기존 TS journal/reader가 검증하며 PostgreSQL jsonb::text 해시로 대신하지 않는다.

## 정상 경로 검증

정상 scripts/test-postgres.ts에서 testDatabase→기존 migrate를 사용했다. Temp setup으로 SQL을 덮는 후보 검사와 구분한다.

| 검증 | 최종 결과 | 증거 |
| --- | --- | --- |
| 비용 직접 PG | 45 통과 | c2-approved-postgres-01 |
| 기존 실행·한도 PG | 17+14 통과 | 같은 실행 |
| helper·LaMa PG | 14+9 통과 | 같은 실행 |
| 실행/완료·비용 준비·journal PG | 23+16+7 통과 | 같은 실행 |
| migration·업그레이드 PG | 7 통과 | c2-approved-migrations-final |
| 전체 TypeScript / 변경 TS14 lint | 각각 exit 0 | c2-approved-typecheck-final / c2-approved-lint-01(13파일) + c2-approved-migrations-lint(1파일) |

위 PG 통과 근거는 9파일의 152개 사례다. 최초 전체 실행은 150통과·migration fixture 2실패였다. 실패는 예상 적용 목록의 0019 누락을 실제로 확인한 RED다. 최소 fixture 수정 뒤 해당 파일 7개를 재검증했다. 첫 실행의 migration 5통과를 중복 합산하지 않고, 나머지 8파일 145통과와 최종 migration 7통과만 집계한다. 실패 로그도 보존했다.

정상 원 비용은 0.016 USD·expense 1개·원 OUTCOME 0개·provider 0회였고 3회 추가 대조에도 행·금액·근거·시각이 같았다. 모델 미시작의 준비 비용 0.006 USD는 봉인 전 예약 유지, 봉인 후 원 closure의 ID/시각으로 해제를 확인했다. START 모순은 비용 미확정·closure/expense 없음·예약 유지·즉시 HALT다. 한도 초과 실제 1.016 USD는 그대로 기록하고 발급을 중단했다.

원 비용 domain 24, helper/관련 LaMa domain 116, operational pipeline 101 및 기존 비용 준비/calculator/journal 364의 유효한 기존 결과는 관련 TypeScript 제품 소스가 바뀌지 않아 재사용했다. SQL 회귀 16개와 기존 양성의 반복 대조를 실제 검사 파일에 통합했다. 이번에는 외부 가격 측정이나 모델 추론을 수행하지 않았다.

대표 정상 명령은 다음과 같다. 위 정상 전체 실행에는 추가로 tests/postgres/execution.test.ts와 migrations.test.ts를 포함했다.

    node node_modules/tsx/dist/cli.mjs scripts/test-postgres.ts tests/postgres/pipeline-stage-cost.test.ts tests/postgres/full-stage-cost-journal.test.ts tests/postgres/execution-cost-preparation.test.ts tests/postgres/execution-limits.test.ts tests/postgres/execution-checkpoint-completion.test.ts tests/postgres/local-lama-attempt-journal.test.ts tests/postgres/local-lama-native-preparation.test.ts
    node node_modules/tsx/dist/cli.mjs scripts/test-postgres.ts tests/postgres/migrations.test.ts
    node node_modules/typescript/bin/tsc --noEmit

## 격리·보존·증거의 한계

필수 OS 변수만 전달하는 전용 실행기를 사용했고 운영 자격정보·활성화 변수를 상속하지 않았다. PG18.6의 새 OS Temp cluster·127.0.0.1·무작위 임시 credential·합성 계정/자료와 제한된 worker/API LOGIN을 사용했다. 이번 정상 검증에 사용한 PG3개는 shutdown 로그와 postmaster.pid 부재로 종료를 확인했다. 실제 원가 reader/사건은 합성 fixture이며 실제 제공자 요금 측정의 권한 근거가 아니다.

기존 migration 18개 파일은 원본 hash와 동일하다. 신규0019의 SQL 실행문과 AS $$~$$; 함수 정의는 승인 후보와 동일하며 설명 헤더와 실행문 바깥 EOF 빈 줄만 정리했다. 최종 SQL SHA-256은 91603f361dff23d20edd719fa5b7f6fcb1ae93bcfc9f4eed271a80e18188aaaf다. 함수 OID·owner·ACL·SECURITY DEFINER·search_path와 다른 함수 본문·기존 데이터/업무 사실·이전 migration hash·중복 원자료 HOLD를 실제 업그레이드에서 확인했다.

c2-approved-audit-final은 고유 원 파일 362개(동일 hash의 중복을 포함한 snapshot681항목)를 확인했다. 허용 기존 파일9곳 변경·신규소스6곳과 결과 문서1곳, 범위 밖 변경·누락·신규 파일0이다. 계획의 기존1051817바이트 prefix를 보존했고 UTF-8·diff 공백 검사를 통과했다. 소스15파일 manifest SHA-256은 2749fc6351fa88d691ae3b2d76bdfa78eabb8adeca02fd7730d8abf6159b8bde다.

로그·변경 전 사본·최종 manifest는 [C2 전용 Temp](C:/Users/ksaei/AppData/Local/Temp/trio-p01c-c2-20261015-9211fefb663d4f889751de4895febaa8)에 있다. environment.json의 realProviderCalls=0은 실행기의 고정 문구이므로 그 값만으로 외부 호출 없음이나 실제 품질을 입증하지 않는다. 저수준 포트·합성 사건·조회/제출 횟수는 직접 회귀에서 별도로 확인했다.

역사 PG는 request COMPLETED/context CLOSED·owner NULL/revision 변경·자산 삭제 CONFIRMED/만료 뒤 비용 VERIFIED, 현재 finalCommitIn WAIT, 새 object.read/native GO0을 확인했다. 참조 누락/다른 digest는 WAIT이며 제한 worker UPDATE42501을 유지했다. 다른 과거 REQUEST_CHECKPOINT target CACHE의 별도 PG 양성 검사는 실행하지 않았다.

## 독립 판정과 다음 범위

architect가 실제 적용된 SQL·직접 검사·upgrade fixture와 최종 로그·15파일 hash를 독립 대조했다. 추가 Critical/Important는 없고 C2 구현·승인된 SQL 소스 추가·격리 검증을 완료로 판정했다. 145개 결과와 migration7개의 분리 집계 및 SQL 실행문 동일성에 따른 재사용도 타당하다고 확인했다. 메인은 PG3개 종료와 문서·참조·계획 원문 보존까지 확인했다.

다음 단위는 C3의 기존 네 단계와 준비 hook 서버 조립이다. 이번에는 C3~C5를 구현하지 않았다. C2의 격리 합격은 실제 웹 업로드→다운로드, 번역 의미·원문 제거·그림 보존·식자 품질이나 새 만화 자동 적용의 증거가 아니다.
