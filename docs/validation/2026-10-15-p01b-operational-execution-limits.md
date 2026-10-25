# P01-B 운영 한도 저장·조회·요청/실행기 연결

- 작업 유형: 제품 개선과 격리된 로컬 검증.
- 승인 근거: 사용자 승인 10.147과 기존 플랜의 [10.148 변경 범위·완료 조건](C:/Users/ksaei/OneDrive/문서/trio-main/docs/superpowers/plans/2026-10-02-manga-web-workspace-contracts-and-validation-plan.md#10148-p01-b-승인변경-범위와-완료-조건-2026-10-15).
- 최종 판정: B01~B06의 P01-B 구현·선택한 로컬 검증·독립 검토 완료. 번역 제품 전체의 완료 판정은 아니다.
- 실제 외부 API·모델, 운영 DB·활성화, 설치, commit/push·배포는 수행하지 않는다. 번역 품질과 새 만화의 자동 처리 성능은 미검증이다.

## 구현한 경로와 증거의 의미

운영자가 검토한 원자료의 정확한 bytes와 검토 주체·시각을 DB에 불변 보관하고, 그 자료와 연결된 운영 한도를 검증한다. API와 worker는 보호 테이블을 직접 읽거나 쓰지 않고 제한 조회 함수를 사용한다. 서버가 별도로 고정한 입력 한도·환경·처리 조합·버전이 일치해야 같은 운영 참조로 요청 정책을 만든다.

정상 요청은 기존 `WorkspaceService`와 `admitRequest` 경로에서 운영 참조를 보존한다. worker는 같은 참조와 원래 요청·INPUT을 대조하고 기존 준비·예약 경로를 사용한다. 예약 트랜잭션은 현재 발급 상태와 profile을 잠금 아래 다시 확인한다. 조회 후 HALTED·profile 교체·기간 만료가 생기면 새 예약을 거부한다. 과거 재시도의 참조 또는 누락, 기존 HELD 잔액·실제 비용 기록은 보존한다.

`MEASURED_EXECUTION_LIMITS_V1`은 OWNED 시험 한도와 별도 계약이다. 원자료의 strict JSON, 실제 bytes/hash, 네 단계의 원 실행·입력 귀속, 시각·단위·원가 내역, 단계/전체 상한 산출과 명시된 운영 기간을 SQL과 TypeScript에서 확인한다. 원자료 출처와 실제 측정의 진실성은 신뢰된 운영자의 검토 책임이다. hash나 DB row만으로 실제 측정 완료를 증명하지 않는다. 실제 운영 예산·가격·갱신 주기·서버/모델을 이번에 결정하지 않았다.

## 변경 파일

| 범위 | 파일 |
| --- | --- |
| DB | `db/migrations/0018_operational_execution_limits.sql` |
| 공통 한도·요청/worker | `packages/domain/src/operational-execution-limits.ts`, `execution-limits.ts`, `execution.ts` |
| 정책 조립 | `packages/operations/src/runtime-startup.ts` |
| 최소 DB 권한 검증 | `packages/storage/src/service-role.ts` |
| 합성 원자료 | `tests/fixtures/operational-execution-limits.ts` |
| 단위 회귀 | `tests/domain/operational-execution-limits.test.ts`, `execution-limits.test.ts`, `runtime-config.test.ts` |
| PG 회귀 | `tests/postgres/operational-execution-limits.test.ts`, `service-role.test.ts`, `migrations.test.ts` |
| 작업 기록 | 이 결과 문서와 기존 플랜의 10.148 이후 추가 기록 |

제품·검사 파일은 13개다. `requests.ts`, `runtime-config.ts`, `native-capacity.ts`, API runtime, 의존성·과거 migration 0001~0017과 기존 native/시계 검사 원본은 수정하지 않는다.

## 검토에서 재현한 문제와 조치

| 문제 | 직접 확인한 실패 | 조치와 확인 범위 |
| --- | --- | --- |
| 측정 단위 배열이 문자열로 변환되어 허용됨 | 배열·중첩 배열 2건 RED | 문자열 타입을 직접 확인. 원자료·reader 회귀 포함 |
| worker 검증 대기 중 호출자가 자원 한도를 바꿀 수 있음 | 대기 중 `maxTextLength` 변경이 실행기로 전달됨 | 첫 await 전에 값 사본을 만들고 같은 사본을 검증·전달 |
| 새 SQL이 기존 공개 예약 wrapper를 덮어씀 | native 슬롯·root·promotion 관련 기존 검사 4건 RED | 운영 분기를 내부 base에 적용하고 기존 native 보호 유지 |
| 정상 PostgreSQL 검토자 이름을 거부함 | `operator@example`, `운영 검토자` 단위 2건 RED | DB가 만든 검토자 이름을 그대로 보존. 실제 quoted LOGIN의 API/worker 조회도 확인 |
| 기존 공개 wrapper의 시계 역행 분기가 HALTED를 기록하지 않음 | 변경 전 0017만 적용해도 거부 뒤 OPEN 유지. 변경되지 않은 직접 검사 1건 실패 | architect가 기존 0012·승인 조건에 근거해 안전성 계약 복원으로 판정. 해당 분기만 최소 수정해 기존 검사 통과. 다른 함수·native 본문·ACL·HELD/비용·원 시계 기록 보존 |

## 검증 기록

검증 위치는 이 웹 폴더다. Node v24.11.1, 기존 Vitest·TypeScript·ESLint와 PostgreSQL 18.6을 사용한다. PG는 `127.0.0.1`의 임시 포트·OS Temp의 새 데이터·무작위 합성 자격 증명으로 실행한다. 기존 실행기와 의존성은 변경하지 않는다.

```powershell
$env:TEMP='C:\Users\ksaei\AppData\Local\Temp'
$env:TMP=$env:TEMP
$env:TRIO_TEST_PG_BIN='C:\Users\ksaei\AppData\Local\Temp\codex-trio-web-validation-01a1018a\tools\pg18.6-edb5-01a1018a\pgsql\bin'
```

```powershell
node node_modules/vitest/vitest.mjs run tests/domain/execution-limits.test.ts tests/domain/operational-execution-limits.test.ts tests/domain/runtime-config.test.ts
$env:TRIO_TEST_NAME_PATTERN='^(?!.*owned child cache hit).*'
node node_modules/tsx/dist/cli.mjs scripts/test-postgres.ts tests/postgres/operational-execution-limits.test.ts tests/postgres/execution-limits.test.ts tests/postgres/service-role.test.ts tests/postgres/migrations.test.ts tests/postgres/native-capacity.test.ts tests/postgres/runtime-claims-and-font.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js packages/domain/src/operational-execution-limits.ts packages/domain/src/execution-limits.ts packages/domain/src/execution.ts packages/operations/src/runtime-startup.ts packages/storage/src/service-role.ts tests/fixtures/operational-execution-limits.ts tests/domain/operational-execution-limits.test.ts tests/domain/execution-limits.test.ts tests/domain/runtime-config.test.ts tests/postgres/operational-execution-limits.test.ts tests/postgres/service-role.test.ts tests/postgres/migrations.test.ts
```

실제로는 확인한 Node 절대 경로를 사용했다. 위 `TRIO_TEST_NAME_PATTERN`은 기존 child-cache 1건의 고정 E: tmpdir 조건을 제외한다. 나머지 native DB 검사는 실행하며 제외한 사례를 통과로 계산하지 않는다.

| 검사 | 현재 확인 결과 | 로그 |
| --- | --- | --- |
| 한도·운영 원자료·runtime 단위 | 67개 통과, exit 0 | `green-unit-final.log` |
| wrapper 보존 후 중간 PG 통합 | 121개 통과·기존 시계 실패 1개·환경 제외 1개. 전체 성공 아님 | `worker-sql/green-native-preserved.log` |
| 실제 quoted operator LOGIN | 1개 통과, exit 0 | `worker-sql/green-reviewed-login.log` |
| 기존 요청·worker 5건 | 5개 통과, exit 0 | `runtime-claims-and-font-final.log` |
| 최종 시계 수정 후 PG 6파일 | 128개 통과·환경 제외 1개, exit 0 | `worker-sql/green-clock-contract-final.log` |
| 최종 전체 타입 검사 | 통과, exit 0 | `worker-sql/typecheck-clock-contract-final.log` |
| 변경 TS 파일 lint | 메인 변경 12개 TS 및 worker 최종 변경 검사 통과, exit 0 | `lint-final.log`, `worker-sql/lint-clock-contract-final.log` |

로그 루트: `C:/Users/ksaei/AppData/Local/Temp/trio-p01b-20261015-827a49e9ce2140d582e22a422b18248e`.

기본 PG 바이너리 경로가 없어서 시작 전에 종료한 최초 실행은 `runtime-claims-and-font.log`에 별도 보존했다. 이미 설치된 PG18.6 바이너리를 확인하고 환경 변수로 지정했으며 설치·대체 DB 사용은 없었다. `red-reviewed-login.log`는 TS 수정 뒤 실행되어 실제로 PASS였고, 이름과 달리 PG RED 근거로 사용하지 않는다. 검토자 이름의 RED 근거는 부모의 `red-review-principal.log`다.

최종 PG 실행 환경 기록은 `C:/Users/ksaei/AppData/Local/Temp/trio-manga-web-postgres-144zxk/environment.json`이다. PG18.6·loopback·6개 대상 파일·명시 필터·exitCode 0을 확인했다. 소유한 임시 PG 데이터는 `C:/Users/ksaei/AppData/Local/Temp/trio-manga-web-pg-Mt6dY6`이며 `postmaster.pid` 부재와 `database system is shut down` 로그를 확인했다. 기존 child-cache 1건은 고정 E: tmpdir 조건 때문에 실행 전에 실패한 환경 사례로 보존하고 최종 실행에서 제외했다. 그 검사의 원본·조건을 바꾸거나 통과로 계산하지 않았다.

## 변경·기록 보존과 독립 검토

기존 소스 782개(원본 Electron 경로 440개 포함)를 구현 전 SHA-256과 대조했다. 허용된 기존 파일 8개만 변경됐고 허용된 소스 5개가 추가됐다. 범위 밖 변경·누락 0, 과거 migration 0001~0017과 변경하지 않기로 한 요청/runtime/의존성 경계는 동일하다. 기존 플랜 원문 988117바이트도 그대로 보존했다. 선택표·비교·원 제품 계약·AGENTS·전역 설정은 수정하지 않았다.

상세 근거는 로그 루트의 `final-scope-check.json`이며, 최종 13개 소스 목록과 파일별 hash의 manifest SHA-256은 `c870009d411a49e06fac88b33489a07365240df5c4b3615b778824db84b48248`이다. 원문·이전 실패 로그는 보존하고 후속 결과를 추가했다.

architect는 원자료 검증·권한·정책 연결·요청/예약·OWNED 경계와 비용/자원 보호를 검토했다. 위 배열 단위·대기 중 값 변경·검토자 이름·공개 wrapper 관련 지적을 반영했다. 마지막 시계 수정은 기존 0015 본문과 비교해 해당 UPDATE 이외의 코드가 정확히 동일함을 독립 확인했다. 최종 실행·PG 종료·현재 13개 소스 hash와 문서의 연결까지 독립 확인했으며, 추가 완료 차단 지적 없이 B01~B06 완료로 판정했다.

`worker-sql/worker-result.json`은 시계 수정 전 중간 인계 기록이다. 최종 근거는 `final-scope-check.json`, `worker-sql/clock-preservation.json`, `worker-sql/green-clock-contract-final.log`로 구분한다. 타입/lint의 비어 있는 로그 파일만으로 성공을 추정하지 않고 명령의 종료 코드 0과 함께 기록했다.

## 완료 조건과 남은 경계

| 조건 | 현재 상태 |
| --- | --- |
| B01 불변 원자료/profile·SQL digest/검토 주체·시각·직접 접근 거부 | PASS |
| B02 원자료·상한·독립 identity·명시 기간 검증 | PASS |
| B03 정상 새 요청과 worker의 동일 참조, 과거 참조/누락 보존 | PASS |
| B04 예약 직전 재검사·경합·HELD/비용·기존 안전성 보호 | PASS |
| B05 외부 실행·START·무료 차감·PUT 없음, activation 차단 유지 | 금지 port·DB 사실·runtime 단위로 확인 |
| B06 관련 검증·보존 확인·독립 검토 완료 | PASS — 최종 소스·로그·PG 종료·제외·문서까지 독립 확인 |

금지 port가 연결된 정상 요청 검사는 예약까지만 수행한다. 이 경로에서 provider/native port 호출 0, START 0, 무료 차감 0, 비용·native GO·PUT 기록 0을 확인한다. 실행기가 출력하는 고정 `realProviderCalls: 0` 문구를 네트워크 차단이나 전체 외부 호출 관측의 증거로 사용하지 않는다.

일반 운영 시작의 `ready:false`와 조기 차단은 유지한다. 실제 운영 한도 발급·실측·실제 제공자/모델·host/native 운영 근거·인증/storage 전체 연결·웹 업로드부터 다운로드까지·번역 의미/원문 잔여/그림 보존/가독성·별도 새 이미지의 무보정 품질은 이번 검증 대상이 아니다. 다음 단계는 P01-C의 네 단계 조립·native/비용·취소 연결 설계를 구체화하는 것이다.
