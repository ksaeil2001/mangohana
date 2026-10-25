# 만화 번역 웹 서비스의 기술 요구·후보 비교·격리 실험

작성일: 2026-10-03. 상태: **공식 조사·연구용 실험 완료, Q20-A 실행·저장 기반과 Q21-A/Q22-A 파일 방향 선정, 나머지 기술 상세 준비 중**. 첫 기반은 Postgres+별도 TypeScript 실행서버다. 호스팅·인증 제품·스토리지·AI·실제 파일 형식·배포는 아직 선정하지 않았다.

업무 선택의 단일 기준은 [Domain Story](../../manga-translation-domain-story.md)다. 입력 계약은 [웹 워크스페이스 계약·검증 명세](2026-10-02-manga-web-workspace-contracts.md) R01~R24/C01~C13/E01~E10/K01~K12/U01~U12/S01~S31, 학습 방법은 [주 설계 초안](2026-10-02-manga-translation-web-service-draft.md) 15절이다. 진행은 [기존 플랜](../plans/2026-10-02-manga-web-workspace-contracts-and-validation-plan.md) 6절의 연구 기록과 9절의 전체 준비에 이어 기록한다.

## 1. 유지하는 계약과 이번 조사 범위

- 단절은 서비스가 확인한 시점부터 5분, 확실한 미실행 공급사 제한은 한 번의 연속 대기부터 10분이다. 조회·재접속·인계·저장 종료로 공급사 기한을 새로 세지 않는다.
- 기한 전/후의 판단은 서비스가 소유한다. 기한 처리 작업의 지연은 새 발행을 허용하거나 시간을 연장하는 근거가 아니다. 실제 발행·시작을 이미 확인한 사실도 늦은 만료로 지우지 않는다.
- 수행불명·정산 미확정은 두 시계와 독립이다. 자동 재호출·0비용·무료 복구·확인 전 활성 요청 해제를 하지 않는다.
- 한 탭 편집·명시 인계, 만든 계정만 파일 복원, 새 복원 맥락의 저장 시점 구성, 원 모델 자동 대체 금지, 다운로드 뒤 사용자 보관 확인을 유지한다.
- 무료 첫 실제 시작과 유료 실제 비용 차감은 서로 다른 기록이다. 처리 전 예상 크레딧·선차감을 만들지 않는다.

이번 작업은 요구 추출, 공식 기술 보장 대조, 합성 자료·가짜 공급사의 로컬 실험, 후보 비교와 다음 범위 제안이다. 제품 `src/`, `tests/`, `package.json`이나 기존 Electron 저장·복구 계약은 수정하지 않았다. 실제 AI·결제·클라우드 계정·사용자 파일 접근은 없었다.

## 2. 확정 계약에서 추출한 기술 요구

TR은 이번 기술 조사 ID다. R/C/E/K/S는 기존 계약의 의미와 식별자를 유지한다. 아래 구현 방향은 확정 정책을 만족시키는 후보 설계다.

| ID | 필요한 능력과 검사 지점 | 계약·검증 연결 | 기술적으로 확인할 것 |
| --- | --- | --- | --- |
| TR01 | 단절 회차·서비스 확인 시각·절대 기한을 영속 보존. 숨김/휴면은 별도 관측. 재접속은 `< 기한`, 기한 도달은 `>=` | R01~R04/R06, C05, E01/E02/E05, K01/K03/K04, S01~S04/S20/S27 | 서비스 시계, 현재 접속 주체, 실제 브라우저 신호·누락/지연, 기한 전후 동시 처리 |
| TR02 | 확실한 미실행 제한의 회차·대상 단계·10분 기한과 보류 이유를 분리. 회복은 해당 이유만 해소, 실제 다음 시작이 회차 종료 | R05/R06, E03~E05, K03/K04, S06/S07/S27 | 회복 후 다른 보류/재제한·재시작에도 원 기한 유지. 오래된 단계 근거가 새 대기를 해제하지 않는 검사 |
| TR03 | 의도·발행·시작·종료/불명과 공급사 참조를 구분. 재전달은 실행 권한이 아니며 비용 없는 확인을 우선 | R08/R10, E05/E06, K04/K06, S08/S20/S22 | 실제 공급사별 조회·멱등 키·보존 결과/사용량 지원, 확인 불가 때 자동 재호출 차단 |
| TR04 | 같은 계정의 명령 ID와 정규화 의도·접수 결과를 함께 확정. 동일 의도는 재조회, 다른 의도는 충돌 | R10/R21, C01/C06, K02/K03, S17/S28 | DB 유일성·동시 수락·응답 유실. 인증/현재 접근과 명령 중복 검사를 별개로 유지 |
| TR05 | 계정·프로젝트/페이지 계보당 단일 활성 요청과 현재 소유권 세대를 검사. 인계가 기존 요청을 재생하지 않음 | R07/R13/R21/R23, C06/C11~C13, K01/K03/K08, S12/S17/S26/S30 | 조건부 갱신/트랜잭션·읽기 일관성. 재시작 후에도 유지되는 활성 참조 |
| TR06 | 첫 실제 시작의 사실·무료 사용 또는 유료 수행별 비용을 귀속. 같은 요청 내부 재개는 무료 추가 사용 없음 | R08/R09, E06/E08, K04/K06/K07, S09/S22 | 실제 시작과 내부 기록 인계 틈, 임시 실행 여력, 무료/유료 경로별 중복 방지 |
| TR07 | 결과 성공·적용, 요청 종결, 비용 정산·계정 새 유료 보류를 독립 확정. 같은 비용 차감과 적용은 각각 한 번 | R09/R10/R14, E07/E08, K06~K08, S08/S13/S22/S24 | 원장 트랜잭션·적용 ID·현재 결과 버전. 파일에서 과거 원장/무료 값을 재생하지 않음 |
| TR08 | 재시작 후 확정 기록과 미완료 인계를 조회해 해당 경계만 처리. 큐·실행기 수명과 도메인 사실을 분리 | R06/R08~R10/R16/R18, K01~K10, S20/S22/S23/S24/S28/S29 | DB/자산/외부 호출 사이 복구, 중복 wake-up, 유효 작업 claim, 실행 코드 버전·운영 대조 |
| TR09 | 파일의 믿을 수 있는 발행 출처·만든 계정·현재 접근 확인. 파일이 제공한 ID/공개키/해시만 믿지 않음 | R13, C11, K01/K12, S18/S26 | 신뢰 키 또는 서버 발행 등록부, 현재 인증/접근, 보존·회전/폐기·계정 삭제의 영향 |
| TR10 | 같은 시점 snapshot·필수 편집 자산·지원 구조 검사와 선택 checkpoint 호환성을 분리. 복원은 새 맥락 | R11~R14/R23, C07/C11/C12, K05/K09/K12, S10~S13/S18/S23/S30 | 필수 자산 전체 내용·크기/입력 한도, 버전 지원, stage별 소비 의존성, 현재 요청/정산 대조 |
| TR11 | DB 기록·객체 저장·파일 생성·전달·보관 확인 사이 성공/실패·미확정 인계와 참조를 보존 | R15~R20, C02/C07~C10, K09~K11, S14~S16/S23/S25/S29 | 원자적 캡처·자산 확보, 같은 인계 재처리, 실제 초안/다운로드/확인 UI. OS 저장을 증명했다고 표시하지 않음 |
| TR12 | 완료/실패/안전한 중단과 원 모델 사용 불가를 근거로 종결. 불명 수행이나 시간만으로 종결하지 않음 | R07/R22/R24, E06/E10, K03/K04/K08, S19/S21/S31 | 일시 제한/사용 불가 구분, 안전한 경계·잠금/활성 해제, 기존 재번역의 명시 새 요청 |

공통 구현 원칙의 제안은 **순수 판정 → 유스케이스의 조회/변경·외부 인계 조정 → DB/공급사/자산 어댑터**다. 전 명령을 순수 함수로 만들지 않는다. 영속 저장에서 사건 순서·현재 권한·기한·유일성을 검사하고, 스케줄러는 검사할 기회를 제공한다. DB 변경과 외부 AI를 하나의 트랜잭션에 넣을 수 있다는 가정은 하지 않는다.

## 3. 후보 비교표

후보는 실행·저장 구성의 비교 단위이며 완성 스택이나 성능 순위가 아니다. 파일 발행 검증은 세 후보에 공통으로 필요한 별도 책임이다. A에서 Supabase는 관리형 Postgres/Auth/Storage/Queues의 후보이며 worker 호스팅은 미선정이다. C에서는 모든 데이터를 여러 서비스에 나누는 것을 필수로 삼지 않고 권위 저장의 주체를 먼저 정해야 한다.

| 비교 항목 | A. Postgres + TypeScript 실행기, Supabase 관리형 기능 후보 | B. Temporal + Postgres 원장 + 객체 저장 | C. Cloudflare Workflows, D1/R2 및 필요한 DO |
| --- | --- | --- | --- |
| 5/10분 기한 | DB에 절대 기한·회차 보존, 실행기에서 판단. overdue 대조기를 직접 설계 | 영속 Timer/history 지원. 장애 때는 복구 뒤 처리하므로 도메인 기한 검사는 계속 필요 | `sleepUntil`/alarm 지원. retry/attempt timeout과 도메인 총 대기 기한을 따로 구현 |
| 명령·활성 요청·정산 확정 | 관련 도메인 행을 한 Postgres 트랜잭션에 모을 수 있음. 유일키/잠금·충돌 재시도 설계 필요 | Postgres의 확정과 Temporal history 사이 인계가 추가됨 | 한 D1 DB 또는 한 DO 저장 내부 트랜잭션. D1/DO/R2 사이 인계는 별도 |
| 재시작 복구 | 확정 기록·작업 claim·큐 대조와 복구기를 직접 구현 | history replay가 제어 흐름을 복원. Activity의 외부 수행·원장 인계는 별도 대조 | step 상태·alarm 재실행 지원. store 간 미완료 인계는 별도 대조 |
| 외부 수행불명/중복 | 큐 visibility 만료를 재호출 권한으로 쓰지 않음 | Activity 기본 자동 재시도를 비용 단계에 그대로 적용하지 않음 | step/alarm 자동 재시도를 비용 단계에 그대로 적용하지 않음 |
| 실행 수명 | 일반 worker는 선택 호스트에 따름. 단일 hosted Edge Function 수명으로 10분 대기를 구현할 수 없음 | Temporal Cloud 외에 사용자 worker를 운영해야 함 | 일반 HTTP worker와 durable workflow 수명이 다름. 이미지/큰 파일은 CPU·메모리·payload 한도 검토 |
| 운영 책임 — 추론 | DB/자산 관리와 별도 worker·기한 스캔·대조기. 업무 기록을 한곳에서 검증하기 쉬운 구성이 가능 | durable orchestration 운영/구입과 별도 worker/DB/자산. 장시간 제어 흐름이 복잡해질수록 재검토 가치 | 관리형 서비스 결합. 권위 저장과 여러 서비스 인계·용량/복제 읽기 규칙을 명확히 해야 함 |
| 비용 구성 | DB/Auth/Storage·전송 + 별도 worker 컴퓨트/운영 | workflow action/history + 별도 worker/DB/객체 저장 | Workers/Workflows/DO/D1/R2의 실행·요청·저장 등 구성별 사용량 |
| 이번 로컬 실험의 의미 | 공통 판정/프로토콜의 연구용 구현만 확인. Postgres/Supabase 실행 PASS 아님 | Temporal 실행 NOT RUN | Cloudflare 실행 NOT RUN. 로컬 SQLite는 D1/DO 구현 증거가 아님 |
| 다음 필수 후보 실험 | 실제 PG 트랜잭션·기한/lock 대기·동시 수락·worker 종료·원장 보완 | Activity retry 정책·history replay·PG 인계·worker version 변경/취소 | workflow retry·alarm 중복/지연·D1 transaction/읽기·R2 인계·한도 |

**추천 제안: A를 첫 후보 런타임 검증의 기준으로 둔다.** 이유는 많은 확정 경계가 계정·명령·페이지 활성·소유권·정산의 관계를 한 저장소에서 함께 판정해야 하기 때문이다. Postgres에 이를 모으고 외부 인계를 명시하는 방향이 현재 계약을 추적하기 쉽다는 설계 판단이다. SQLite 실험 결과로 A가 더 빠르거나 싸다고 결론내린 것은 아니다. worker·스케줄/대조기 직접 구현의 부담은 남는다.

B는 제어 흐름의 내구성을 제공하지만 현재 계약에서도 별도 worker와 원장 대조가 필요하다. C는 관리형 실행을 제공하지만 여러 저장 책임과 인계를 먼저 정해야 한다. 특정 제품을 제외한 판정은 아니며 선택 뒤 같은 인수 목표로 해당 런타임에서 검증한다.

가격 총액·처리량·이미지 크기·plan/region·운영 노동은 미확인이다. [Supabase 가격](https://supabase.com/pricing), [Temporal 가격](https://temporal.io/pricing), [Cloudflare Workflows 가격](https://developers.cloudflare.com/workflows/reference/pricing/)을 확인했지만 아직 workload가 없으므로 월 비용 우열이나 무료 운영 가능성을 제시하지 않는다. Temporal/Cloudflare 항목에는 다른 DB·storage·worker 제품의 비용을 자동 포함하지 않는다.

## 4. 공식 근거와 적용 한계

조회 기준일: 2026-10-03. 아래는 공식 문서의 설명과 그에 따른 설계 적용을 구분한 기록이다. 문서 조회는 해당 플랫폼의 실행 성공 증거가 아니다.

| ID | 확인한 공식 설명·출처 | 이번 계약에 적용할 판단·한계 |
| --- | --- | --- |
| B01 | 브라우저 frozen 상태에서 JS timer/fetch callback이 멈출 수 있고 종료/폐기 사건은 신뢰성 있게 관측되지 않을 수 있음. [Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) | 숨김이나 unload를 종료 확정으로 쓰지 않으며 실제 신호·서비스 감지 간격은 별도 브라우저 실측 |
| B02 | `now()`는 transaction 시작 시각, `clock_timestamp()`는 실제 현재 시각. Node timer도 정확한 callback 시각/순서를 보장하지 않음. [PG 시각 함수](https://www.postgresql.org/docs/18/functions-datetime.html), [Node timers](https://nodejs.org/api/timers.html#scheduling-timers) | lock 대기 뒤에도 실제 기한을 재검사할 시각의 출처를 명시. 늦은 wake-up으로 기한을 연장하지 않음 |
| B03 | 경합 UPDATE의 조건 재검사, `ON CONFLICT`의 insert/update 원자성, partial unique index 지원. [PG isolation](https://www.postgresql.org/docs/18/transaction-iso.html), [INSERT](https://www.postgresql.org/docs/18/sql-insert.html), [partial indexes](https://www.postgresql.org/docs/18/indexes-partial.html) | 한 저장소의 도메인 확정 수단 후보. 여러 행의 규칙·격리/실패 재시도와 외부 I/O를 자동 해결하지 않음. 실제 배포 PG 버전은 미선정 |
| B04 | Queues는 Postgres/pgmq 기반이며 문서의 exactly-once는 visibility window 안의 전달 범위. [Queues](https://supabase.com/docs/guides/queues), [API](https://supabase.com/docs/guides/queues/api) | 내부 전달과 실제 AI 부작용을 구분. window 이후 재전달은 기존 수행 조회부터 |
| B05 | hosted Edge Function wall clock Free150초/Paid400초, background task도 worker 한도 적용. [한도](https://supabase.com/docs/guides/functions/limits), [background](https://supabase.com/docs/guides/functions/background-tasks) | 10분짜리 열린 함수 하나를 기한 저장소로 쓰지 않음. 영속 기한과 짧은 실행/별도 worker 검토 |
| B06 | Temporal timer는 durable하며 기한 때 worker/service 장애라면 복구 뒤 resolve. history replay는 완료된 Activity/Timer 근거를 읽음. [Timers](https://docs.temporal.io/develop/typescript/workflows/timers), [Tasks](https://docs.temporal.io/tasks) | 장애 복구 지원과 정확한 시각의 handler 실행을 구분. replay 가능한 코드/버전·도메인 기록 인계 필요 |
| B07 | Temporal Activity retry의 기본 maximum attempts는 무제한, 1로 설정하면 자동 retry 없음. cancellation 전달/처리는 실제 수행 중단과 다름. Cloud는 사용자 worker를 별도로 필요로 함. [retry](https://docs.temporal.io/encyclopedia/retry-policies), [Activity execution](https://docs.temporal.io/activity-execution), [Workers](https://docs.temporal.io/workers) | retry를 꺼도 응답 유실 뒤 수행불명은 남음. Activity 시작/취소/timeout을 공급사 실제 시작/중단 근거로 승격하지 않음 |
| B08 | Cloudflare Workflows default step retry5회/timeout10분은 attempt별. 외부 요청 성공 후 step 실패로 retry될 수 있음. [sleep/retry](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/), [Rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) | 공급사 연속 총 대기10분과 분리. 비용 발생 step의 retry 정책·조회 수단을 명시 |
| B09 | DO alarm은 at-least-once/실패 retry, 한 object에 alarm하나. D1 batch는 한 DB 내부 transaction. R2는 객체 read-after-write 강한 일관성. [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [D1 batch/session](https://developers.cloudflare.com/d1/worker-api/d1-database/), [R2](https://developers.cloudflare.com/r2/reference/consistency/) | D1·DO·R2·외부 호출 전체가 하나의 transaction이 아님. 최신 권한 읽기·여러 기한 schedule·미완료 인계 검증 |
| B10 | Storage의 owner 값 자체는 접근 통제가 아니며 service key는 RLS를 우회. metadata와 실제 object 책임도 다름. [Ownership](https://supabase.com/docs/guides/storage/security/ownership), [접근](https://supabase.com/docs/guides/storage/security/access-control), [schema](https://supabase.com/docs/guides/storage/schema/design) | 현재 인증/접근과 프로젝트 파일의 발행 출처는 각각 검사. signed download URL만으로 로컬 파일 발행/복원을 인정하지 않음 |
| B11 | JWS는 서명/MAC과 payload를 연결하고, private key 보호·믿을 수 있는 key origin·허용 알고리즘 검증을 요구. EdDSA/Ed25519 관련 표준과 Node crypto 지원. [RFC7515](https://www.rfc-editor.org/rfc/rfc7515), [RFC8037](https://www.rfc-editor.org/rfc/rfc8037), [Node crypto](https://nodejs.org/api/crypto.html) | 서명은 발행/무결성 수단 후보이며 암호화·현재 계정 권한·schema/이미지 정상 여부를 대신하지 않음. P06은 표준 파일 형식/JWS 구현이 아닌 byte payload 서명 연산 실험 |
| B12 | Gemini batch API는 별도 batch resource/Operation 및 조회 가능한 batch 상태를 문서화. [Batch API](https://ai.google.dev/api/batch-api) | batch의 조회 지원을 일반 동기 호출의 멱등/응답 유실 복구로 확대하지 않음. 일반 생성 호출의 안전한 재발행·lookup 근거는 이번에 확보하지 못했으며 실제 공급사별 추가 확인 필요 |

부가 한도도 후보 선택 뒤 확인한다: [Temporal Cloud 한도](https://docs.temporal.io/evaluate/cloud/limits), [Cloudflare Workflows 한도](https://developers.cloudflare.com/workflows/reference/limits/), [Workers 한도](https://developers.cloudflare.com/workers/platform/limits/), [D1 한도](https://developers.cloudflare.com/d1/platform/limits/). history/state retention은 이미지 라이브러리30일이나 내부 비용 기록의 제품 보존 기간과 같지 않다. Cloudflare Workflows 한도 페이지는 concurrency 표/본문 숫자에 불일치가 있어 확정 처리량 근거로 사용하지 않았다.

## 5. 격리 실험의 실제 결과

실행: 2026-10-03 01:50 KST. [실험 코드](../../../artifacts/manga-web-technical-spikes-2026-10-03/protocol-spikes.mjs), [실행 결과 JSON](../../../artifacts/manga-web-technical-spikes-2026-10-03/results.json). 코드 SHA-256: `BD3C11C274CE52CCD7AA317CED54282449665861EABFEB7968C3D084A34502DA`.

환경은 현재 설치된 **Node v24.11.1 / SQLite3.50.4**다. 해당 Node의 `node:sqlite` API는 experimental 경고를 출력했다. 이 선택은 추가 설치 없이 로컬 연구 가정을 확인하기 위한 수단이며 production DB 채택이 아니다. DB는 OS 임시 전용 디렉터리에 생성·보존했고, 서버는 `127.0.0.1`의 임시 포트에만 열었다. 일회성 합성 키는 메모리에만 두었다. 자식 프로세스는 이 코드가 생성한 대상 하나만 종료했다.

실제 실행 명령은 `node --check artifacts/manga-web-technical-spikes-2026-10-03/protocol-spikes.mjs`와 `node artifacts/manga-web-technical-spikes-2026-10-03/protocol-spikes.mjs`이며 둘 다 exit0이었다. 실행기 종료/응답 유실은 실제 로컬 프로세스/HTTP 경계에서 발생시켰다. 5분·10분은 주입 시계의 경계이며 실제 10분 sleep·브라우저 휴면·플랫폼 schedule 지연 실측이 아니다.

| 실험 | 관측·결과 | 연결할 인수 목표·증거 한계 |
| --- | --- | --- |
| P01 · PASS | 5분·10분의 1ms 전/동일/후. 새 process에서 원 기한 유지. 공급사 회복→재제한에도 회차/기한 유지, 10분에 요청 종결 뒤 11분 맥락 재접속은 가능하나 요청 재생 없음. 늦은 대조 전에도 만료 발행 거부 | S03/S04/S06/S27의 모형 판정 일부. 실제 감지/분산 시계·실행 지연/재접속 UI는 미실행 |
| P02 · PASS | 두 child process 동일 명령은 수락1+기존 결과1, 다른 의도는 충돌, 두 새 명령은 활성 요청1. 같은 예상 소유권 갱신도 한 번 | S17/S28의 저장 판정 일부. 전체 탭 인계/5분 조건·현재 접속·옛 탭 write/heartbeat 차단은 미구현 |
| P03 · PASS | 가짜 공급사 성공 뒤 HTTP 응답 유실. 기존 수행 무재호출, 새 process 조회·동시 대조에서 수행1/유료 정산1·무료 사용0. 불명 때 활성 참조 유지, 근거 확인 뒤 안전한 중단 | S08/S20/S22의 수행/인계 일부. fake는 client reference 조회를 지원하며 실제 공급사 능력 증거가 아님 |
| P04 · PASS | 가짜 수행 뒤 직접 생성한 worker를 SIGTERM 종료. 다음 process는 새 호출 없이 대조. 조회 미지원 가짜 공급사는 불명으로 유지하며 호출1·정산/무료 사용 추정 없음 | 실제 process 종료·HTTP 부수 효과·lookup 한계 경로. 후보 workflow/queue replay·실제 공급사/운영 대조 미실행 |
| P05 · PASS | 무료 두 단계의 첫 시작/사용1·유료 정산0·잔액 불변. 단절/제한 해소 뒤 같은 요청 이어감. 첫 단계의 중복 근거가 둘째 단계 대기를 해제하지 않음. prepared 미발행 작업은 기한부터 발행0 | S02/S06/S09/S20/S22/S27의 일부. 총10회 경합·실제 실행 여력/원가 보호·전체 결과 적용은 미구현 |
| P06 · PASS | 실제 Ed25519/SHA256 연산. 변조·다른 계정·믿는 키 부재·현재 접근 불명·알고리즘 변경·필수 자산 누락/손상·지원 버전 불가를 구분. 선택 checkpoint 불일치는 편집 판정과 분리. 발행 등록부가 사라지면 등록부 방식 확인 불가, 믿는 key 유지 시 서명 판정 가능. 원 합성 envelope 보존 | S10/S11/S18/S26의 일부. 합성 byte 자산/접근 bool이며 실제 파일/이미지/계정 인증·키 관리·호환 migration 증거가 아님 |

6개는 실험 **그룹 수**이며 S01~S31 통과 수가 아니다. 기존 계약의 제품 V1~V5/S01~S31은 계속 **NOT RUN**이다. Postgres/Supabase·Temporal·Cloudflare runtime, 실제 AI/결제, 실제 브라우저 초안/다운로드/인계, production 파일 컨테이너·파서 한도·이미지 decode·키 운영은 NOT RUN이다.

실험 코드의 독립 사전 검토에서 무료/유료 기록 분리, 회복과 연속 대기 회차 분리, 오래된 수행 근거의 새 회차 해제 금지를 보완했다. 수정 후 읽기 전용 검토에서 실행 전 필수 사항이 해소된 것을 확인하고 실행했다. 최종 architect는 문서·실행 기록의 범위/계약 일관성을 검토해 필수 보완 없음으로 확인했다. 공식 자료의 재조회나 실험 재실행을 수행한 검토는 아니다. UTF-8·참조·ID/증거·공백과 기존 네 문서 보존도 검사했다.

## 6. 프로젝트 파일 출처 확인 후보

두 후보 모두 믿는 서비스의 발행 사실과 **현재 만든 계정/접근**을 확인하고 지원 구조·필수 자산·선택 checkpoint를 각각 검사한다. 파일의 ID·digest만으로 권한을 부여하지 않는다. Q16-A를 다른 계정 복사본 허용으로 바꾸지 않으며 암호화 도입도 확정하지 않는다.

| 항목 | F-A · 서비스가 서명한 manifest — 추천 제안 | F-B · 서비스의 발행 등록내역 + 전체 digest |
| --- | --- | --- |
| 출처 근거 | 믿는 발행 키로 만든 계정·snapshot·필수 자산 digest/크기 등 manifest를 서명. 검증 키는 서비스가 신뢰 경로로 관리 | 인증된 export 등록부에서 snapshot·만든 계정·파일 digest를 대조. file의 주장만으로 등록부 작성하지 않음 |
| 서버 의존 | 현재 인증/접근 대조는 필요. 서명 검증 자체는 export row 전체 없이 가능 | 현재 인증/접근과 그 파일의 발행 row가 모두 필요 |
| 유지 책임 | 검증용 key ID/공개키·신뢰/폐기·회전 규칙, schema/자산 검사 | 파일마다 최소 발행 기록의 보존·백업·접근, schema/자산 검사 |
| 잃은 근거 | 믿는 키를 확인 못 하면 출처 보류. 키 유출/폐기 이후 처리도 별도 운영 정책 | 발행 기록을 확인 못 하면 출처 보류. 기록 삭제가 파일 검증 가능 기간에 영향을 줌 |
| 이번 증거 | P06의 합성 서명 검증·현재 접근 분리. production envelope/JWS/키 관리는 NOT RUN | P06의 합성 등록부 유실·계정/접근 대조. 실제 DB/export 등록·백업은 NOT RUN |

추천 이유는 결과 라이브러리30일과 로컬 프로젝트 파일의 편집 복원을 분리하면서, 모든 파일별 등록내역을 발행 증명의 유일한 근거로 삼는 의존을 줄이는 방향이기 때문이다. 검증 키·현재 접근·지원 형식이 계속 확인될 것이라는 운영 가정은 별도 결정이 필요하다. 서명이 과거 파일의 무기한 복원을 자동 보장하지 않는다.

파일을 검증할 수 있는 기간, 검증 키/최소 발행 근거 보존과 계정 삭제·유출/폐기 이후 처리는 기술 수단으로 몰래 확정하지 않는다. 서비스의 내부 기록·키가 보존돼도 만료 이미지 제공이나 종료 맥락 편집 복구 경로로 사용하지 않는다.

## 7. 첫 구현 흐름 선정안

| 후보 | 첫 범위와 목적 | 다음으로 넘기는 경계 |
| --- | --- | --- |
| I-A · 한 페이지의 실행·대기·재접속·재시작 — 우선 선정 제안 | 한 합성 계정·한 페이지·두 fake 단계. 명령 수락/단일 활성 → 첫 실제 시작 근거/무료 또는 유료 기록 → 다음 단계 제한 → 단절/회복/재시작 → 같은 요청의 조회·조건부 재개 또는 안전 종결 | 실제 provider·결제·전체 이미지 공정·파일 전달·복수 탭 UI는 후속. 선택 런타임에서 command부터 durable record까지 검증 |
| I-B · 파일 캡처·보관 확인·같은 계정 복원 | 일관된 편집/자산 파일, 출처·구조/필수/선택 판정과 정상 저장 종료 연결 | 먼저 실행/종결·현재 요청 대조가 필요. 파일 지원/출처/보존 선택과 실제 브라우저 전달 검증 |
| I-C · 두 실제 탭의 명시 인계 | 원 요청 유지·옛 권한 거부·미전송 초안·결과 반영을 실제 UI/통신에서 검증 | 실행/저장 권위와 현재 버전 필요. UI 없이 CAS 실험만으로 완료할 수 없음 |

**I-A를 첫 제품 구현을 위한 기술 상세 설계의 범위로 추천한다.** 다른 두 흐름이 의존하는 요청·권한·기한·수행불명·종결 기록을 먼저 확인할 수 있기 때문이다. 이번에 완료한 P01~P06은 연구용 선행 실험이며 I-A의 제품 구현 완료가 아니다.

I-A의 완료 조건 제안은 다음과 같다.

1. 선택 런타임에서 C01의 조회와 한 페이지 요청 수락/발행/대조의 실제 타입·validation·저장/인계 경로를 정하고, 같은 계정·명령 의도·계보 페이지 단일 활성을 검증한다.
2. 한 권위 시계로 회차/절대 기한을 보존한다. 주입 경계와 실제 runtime restart/lock 대기·중복 wake-up을 모두 기록하며 다른 보류가 남으면 시작하지 않는다.
3. fake 공급사의 확실한 미시작·성공/응답 유실·조회 지원/미지원과 worker 종료를 구분한다. 불명에서 새 호출·0비용/무료 복구·조기 잠금 해제가 없고 미발행 작업은 기한부터 발행되지 않는다.
4. 무료 사용·유료 비용/정산·결과 적용/종결의 관련 subset을 명시한다. 성공/실패/안전한 중단의 확인 근거와 활성 해제 또는 불명 보류를 종료 조건으로 둔다. 모형 차감이나 file 숫자를 실제 계정 권한으로 쓰지 않는다.
5. 선택한 S 사례의 어떤 입력/금지 부작용을 실제 테스트했는지 기록한다. 실제 UI/파일/공급사·여타 인수 사례는 실행 범위를 별도로 유지한다.

## 8. 사용자에게 필요한 선택과 아직 확정하지 않은 것

기존 Q1~Q19를 다시 묻지 않는다. 아래는 처음 준비한 Q20~Q22의 비교 선택지다. 이후 사용자는 Q20-A·Q21-A·Q22-A를 선택했다. 실제 질문과 응답의 원본은 Domain Story 59.4~59.5절이며 선택한 방향의 상세·미검증은 12절을 따른다.

| 질문 | 선택지와 영향 |
| --- | --- |
| Q20 · 첫 상세 설계/후보 runtime 검증의 기반 | A Postgres+별도TS실행기/관리형보조: 업무 확정은 한 DB에 모으고 복구/대조기를 설계(추천). B Temporal+PG: history/timer 지원과 추가 서비스/worker·원장 인계. C Cloudflare: managed 실행/저장과 권위 저장·서비스간 인계/한도 검증 |
| Q21 · 프로젝트 파일의 발행 출처 | A 믿는 서비스 서명+현재 접근(추천), B 서버 발행 등록내역+전체digest/현재 접근. 두 선택 모두 파일 발행/지원·현재 접근 확인 불명은 보류, 원 파일 보존 |
| Q22 · 과거 파일의 지원/발행 검증 근거 보존 방향 | A 계정 접근이 유효하고 지원 파일 형식인 동안 필요한 최소 발행/검증 근거 유지(추천), B 별도 파일 지원 기간을 정해 그 뒤의 검증/복원 제한을 안내. 실제 기간·키 폐기/유출/회전·계정 삭제는 별도 구체화 |

Q22는 결과 라이브러리30일의 재선택이 아니라 로컬 프로젝트 파일 지원과 최소 발행 검증 근거의 정책이다. A도 모든 구형 schema·손상/변조·현재 접근 불명·검증 키 유출/폐기에 대해 무조건 복원을 보장하는 선택이 아니다. 지원 형식과 확인 가능한 출처/현재 접근 조건을 유지한다. B의 숫자 기간은 선택 뒤 비용·보존 요구에 따라 좁힌다.

선택 뒤 작성할 것은 선택 후보의 실제 타입/API·권위 저장/원자적 경계·실행/대조·파일 출처의 상세 설계와 I-A 구현 플랜이다. 유료 인프라·실제 AI 실행·계정 생성·배포는 그 선택 자체에 포함된 실행 작업이 아니다.

미확인 항목은 예상 workload/이미지 크기·region/지원 브라우저·감지 간격·분산 clock skew·배포 worker lifetime, 공급사별 수행 조회/멱등 지원·확인 비용, 실제 schema/파일 container·입력 한도/migration, 키/발행 근거와 내부 대조 기록의 상세 보존·접근·운영 보정 권한이다. 첫 흐름을 막는 항목부터 선정 후보의 공식 지원과 격리 runtime 실험으로 좁힌다.

## 9. Torii·Ichigo 기존 연구를 대조한 후속 보강

2026-10-03 사용자가 공급한 최종 보고서·연구 ZIP·Word 이해 보고서의 전체 내용은 [프로젝트 적용 검토](2026-10-03-torii-ichigo-project-application-review.md)에 정리했다. ZIP의 텍스트40개/5,125줄과 이미지17개, Word 본문·표·삽입 이미지까지 확인했고 실제 Word 페이지 레이아웃은 LibreOffice 부재로 미검증이다. 과거 실제 실행·독립 PROPOSED API/SQL·현재 보존 자료 검사와 공식 조회를 구분한다.

이번 자료는 TR01~TR12나 Q1~Q19를 바꾸는 근거가 아니다. 첫 I-A 요청 수명 흐름과 Q20의 A 추천은 유지하며 **영역·기하·산출물 의존성·품질 평가 계약을 상세 설계의 준비 항목으로 추가 제안**한다. 이 연구 반영을 작성한 당시 Q20~Q22 응답은 없었고 추천을 선택으로 기록하지 않았다. 이후의 실제 Q20-A·Q21-A·Q22-A 선택은 12절에 연결한다.

| 보강 지점 | 연결할 요구·검증 | 후속 설계에서 확인할 내용 |
| --- | --- | --- |
| 안정된 region·좌표/각도/색·mask·폰트/layout | TR10/TR11, K05/K08/K09/K12, 적용 검토 P01~P05 | provider별 중심점/좌상단·degree/radian·BGR/RGB 정규화, stage별 실제 입력 의존성, 필수 편집 자산·선택 checkpoint |
| 공급사 실제 모델·수행 조회·fallback | TR03/TR08/TR12, P07 | Torii 공개 API는 fallback metadata를 문서화하나 이번에 모델 고정/대체 금지 보장을 확보하지 못함. Q17/Q19를 만족하는지 별도 검사. Ichigo 내부 client 경로는 지원 외부 API로 확정하지 않음 |
| 품질과 시스템 상태의 독립 평가 | P03/P05/P08, 기존 S01~S31과 별도 품질 시나리오 | OCR 누락/읽기 순서·원문 제거 손상·한국어 줄바꿈·허용 넘침·preview/export를 구분. 보존 fixture 검사와 새 추론 성공을 구분 |

과거 연구의 공개 예약 잔액/예상 비용 필드·자동 provider fallback·60초 retry deadline·7일 보존·모든 overflow 거절·영속 Undo·JA→EN MVP 범위는 현재 정책으로 가져오지 않는다. 예약과 실제 debit이 다른 과거 설계였다는 점도 유지하며, 현재 K07의 비공개 실행 여력을 사전 실제 차감과 합치지 않는다. 기술·파일·지원 기간 선택이나 새 dependency/공급사 도입은 이번 자료 검토에서 확정하지 않았다.

### 9.1 연구 적용 검토의 마무리와 다음 선택

사용자의 후속 지시인 이 연구 적용 검토에 집중하여 끝내기에 따라, 적용 검토 12~16절에 P01~P08의 항목별 판단, 최소 논리 데이터·책임·실제 소비 입력별 의존성, 변경/복원 판정, APV01~APV16 검증 설계와 F01~F06 후속 단계를 작성했다. 연구의 내용·설계 적용 검토는 마무리했으며 실제 기술 상세 설계는 다음 단계다. APV와 제품 S사례는 NOT RUN이다. 이 연구 검토 당시 Q20~Q22는 미선택이었으며 이후의 실제 선택은 12절을 따른다.

초기 연구 적용 마무리 당시 architect 재호출은 같은 호출 한도로 거절됐다. 사용자는 그 제한 때문에 멈추지 말고 계속 진행하라고 명시했으며 당시 독립 검토 미완료로 내용 검토와 문서 검사를 마무리했다. 이후 전체 보고서의 독립 검토와 APV10/현재 질문 순서 보완은 [적용 보고서 17절](2026-10-03-torii-ichigo-project-application-review.md#17-전체-연구-적용-보고서의-후속-architect-검토)을 따른다. 현재는 Domain Story 59절·기존 플랜 9.3절에 따라 Q20~Q28의 아홉 선택을 반영하고 후속 상세 설계를 진행한다. 제한이나 계속 진행 지시는 기술 선택·운영 수치·새 의존성 도입의 승인으로 확대하지 않는다.

## 10. NotebookLM에서 확인한 기술 스택 선택 방법

학습일: 2026-10-03. Torii·Ichigo의 현재 설계 적용 검토를 종결한 뒤, 사용자가 요청한 다음 학습으로 [기존 NotebookLM 노트북](https://notebook.google.com/notebook/edd4a227-15b0-47e8-8f08-b9481c58a7b2)의 선택된 29개 강의를 사용했다. 관련 전사문 네 개를 직접 대조했으며, 원본 영상 재생이나 29개 전사문 전량 검토는 이번 범위가 아니다. 질문·생성 답변·전사문과 보정 근거는 [학습 근거 기록](../../../artifacts/manga-web-stack-selection-learning-2026-10-03/learning-evidence.md)에 연결한다.

### 10.1 원문 설명과 프로젝트 적용의 경계

| 근거 | 직접 확인한 강의 설명 | 이번 프로젝트에 적용할 판단 |
| --- | --- | --- |
| NR01 · 체계part001 | 기본 뼈대를 잡을 때 구현 방식·기술 스택·대략적 배포 인프라를 검토한다. 기술 특성과 자신의 상황을 알아야 AI의 제안을 평가할 수 있다고 설명한다. TypeScript 통일과 특정 프레임워크/DB는 강사의 추천이다 | 이번 목표인 웹 서비스의 실행·저장 책임부터 선택한다. 기존 React/TypeScript 경험은 비교 이점이지만 Electron 채택이나 새 프레임워크의 확정 근거는 아니다. TypeScript를 보편적 탈락 조건으로 만들지 않음 |
| NR02 · 체계part002 | 메인 웹·관리자·서버의 분리와 모노레포를 선호하면서 통합 구조도 가능하다고 설명한다. 특정 SDK/스토리지의 강한 결합이 이전 비용을 높인다는 의견을 제시한다 | 논리 책임 분리와 별도 배포 서비스를 구분한다. 모든 책임을 여러 서비스로 배포하거나 Supabase SDK/RLS를 피하는 것을 필수로 만들지 않음. 인증·접근 검사는 현재 계약을 유지 |
| NR03 · 로드맵part003 | 동기/비동기, 원자적 비교·쓰기, 외부 부수 효과, DB 트랜잭션과 Redis 도입을 사례로 토론한다. 장단점·상황을 비교하고 계획과 인프라가 불필요하게 커질 수 있음을 설명한다 | 필수 계약과 비교 우선순위를 구분하고, 후보의 지원·직접 설계 책임·미확인을 함께 적는다. 지금 필요하지 않은 큐·cache·추가 서비스는 먼저 도입하지 않음 |
| NR04 · 정석Part005 | 에이전트에게 도입 검토 실험과 효과 확인을 맡기고 보고를 읽어 피드백하는 사례를 설명한다. 코드에서 읽기 어려운 의도·판단 근거를 문서에 남기는 관점을 제시한다 | 코드 작성을 맡겨도 계약·근거·검증 결과를 확인한다. 이번 문서는 선택 전 비교와 채택 이유를 남기고, 이후 설치 패키지 목록을 제품 계약의 별도 원본으로 복제하지 않음 |

위 네 원문은 하나의 필수 선택 알고리즘을 제시하지 않는다. 아래 필수 조건 표·질문 시점·I-A 검증 순서는 강의의 일반 원리를 현재 계약에 적용한 **설계 제안**이다. 선택지를 2~3개로 좁히는 방식은 사용자의 요청이다. 강의의 과거 가격·무료 플랜·제품 선호를 현재 조건이나 최저 비용의 근거로 채택하지 않는다.

### 10.2 후보를 좁히는 절차와 결정 시점

1. **확정 계약을 필수 검사로 연결한다.** TR01~TR12를 입력으로 사용하고, 제안 구성이 만족시킬 수 없는 규칙이 확인되면 그 구성을 제외하거나 수정한다. 공식 지원은 실제 구현 PASS가 아니며 미확인은 탈락 확정과도 다르다. 공급사 수행 조회가 없더라도 자동 재호출을 막고 보류·대조하는 경로가 가능하면 평가를 이어간다.
2. **결정 책임과 비교 우선순위를 정한다.** 화면, 서비스/API, 권위 DB, 영속 실행·기한 대조, 프로젝트 파일/자산, AI 공급사를 비교 단위로 나눈다. 이 단위가 곧 별도 프로세스·호스팅·dependency 개수를 뜻하지 않는다. 현재 가장 큰 불확실성은 요청 수명과 저장·외부 호출의 인계이므로 Q20부터 좁히고, 실제 화면 프레임워크·worker 호스트·이미지 공정은 해당 흐름에 필요한 시점에 정한다.
3. **첫 상세 설계·실험 후보를 사용자에게 제시한다.** 기존 3절의 A/B/C 비교를 재사용하고, 공식 설명·직접 구현 책임·미확인·예상 운영 구성과 선택 이유를 함께 보여 준다. A 추천은 유지하되 운영 우선순위나 새 근거에 따라 재평가한다. Q20-A·Q21-A·Q22-A를 선택한 현재도, 질문 답변을 비용 발생·계정 생성·배포 승인으로 확대하지 않는다.
4. **선택한 후보의 I-A에서 실제 근거를 만든다.** 한 합성 계정·한 페이지·두 가짜 단계로 명령 수락, 단일 활성, 첫 실제 시작, 두 독립 기한, 응답 유실, 실행기 종료·재시작과 같은 수행의 대조를 검증한다. 실패·추가 운영 부담이 드러나면 구성을 수정하거나 다른 후보를 비교한다. 이전 SQLite 모형 PASS를 새 런타임 PASS로 쓰지 않으며 세 후보 전체를 먼저 구축하지 않는다.

### 10.3 필수 검사와 비교 기준

| 분류 | 이번에 비교할 내용 | 필요한 근거와 통과 의미 |
| --- | --- | --- |
| 필수 · TR01/TR02/TR08 | 5분 단절 회차와 10분 미실행 제한 회차의 절대 기한·재시작 보존 | 기한부터 새 비용 단계 발행 거부, 늦은 대조/중복 wake-up/lock 대기 뒤 재검사. 정각 콜백 실행이나 확인 전 실제 공급사 중단을 요구하지 않음 |
| 필수 · TR03~TR08/TR12 | 명령·실제 수행·무료/유료 기록·결과 적용/종결을 구분 | 응답 유실 때 조회/보류, 비용 단계 자동 재발행 금지, 중복 반영 방지와 안전한 종결 근거. 큐/워크플로우만으로 외부 exactly-once를 보장했다고 하지 않음 |
| 필수 · TR09~TR11 | 현재 만든 계정의 접근, 파일 발행 출처·같은 시점 필수 자산, 선택 checkpoint 호환성 | Q21/Q22 상세와 I-B에서 검증. 다운로드와 사용자 보관 확인은 구분하며 I-A 완료가 파일 검증 완료는 아님 |
| 비교 · 개발/검증 부담 | 기존 TypeScript 역량, 계약을 추적하기 쉬운 구조, 실패 재현·로그·local runtime 준비 | 필요한 새 지식·설정·직접 구현 목록과 실제 실험 보고. AI가 코드를 쉽게 생성한다는 주장만으로 우열을 정하지 않음 |
| 비교 · 운영/비용 | DB·자산·worker·대조기·백업/관측 구성, 관리형과 직접 운영의 책임, workload별 비용 | 우선순위 답변 뒤 적용. 현재 가격·사용 조건, 지역·자산 크기·실행량과 운영 노동의 가정을 명시. 내부 인프라 비교를 사용자 사전 크레딧 표시로 옮기지 않음 |
| 비교 · 이전 가능성 | 표준 데이터·내보내기, provider/호스트 교체 시 변경·migration·재검증 범위 | 단순 vendor 개수나 어댑터 이름 대신 실제 영향 범위. 여러 서비스로 나누면 이전이 쉬워진다는 가정은 하지 않음 |

각 후보의 기록 칸은 **요구 ID → 공식 설명/조회일 → 직접 설계할 책임 → 미확인 → 격리 실험/관측 → 선택 이유·재검토 조건**으로 유지한다. 비교 우선순위를 정하기 전에 숫자 점수나 비용·운영 순위를 만들어 채우지 않는다. 필수 검사를 유리한 점수로 상쇄하지 않는다.

### 10.4 NotebookLM 답변에서 채택하지 않은 일반화

- Node timer의 정확한 콜백 시각 보장은 없다. 서비스의 절대 기한 검사와 재시작 뒤 대조를 근거로 쓴다. [Node timers](https://nodejs.org/api/timers.html#scheduling-timers)
- Temporal Cloud 사용에 자체 클러스터 운영이 항상 필수인 것은 아니며 사용자 worker 책임은 남는다. 기본 Activity retry/history를 외부 AI 멱등 보장으로 취급하지 않는다. [Workers](https://docs.temporal.io/workers), [Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)
- Workers KV는 eventual consistency이며 원자적 갱신·단일 transaction이 필요한 권한/정산 잠금의 근거로 쓰지 않는다. Cloudflare 후보의 권위 저장과 원자적 경계는 3~4절처럼 별도로 정한다. [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- TypeScript 필수화, 특정 리전 배치의 보편 의무, 후보 운영/가격 순위, 1,000건이라는 실험량은 이번 학습으로 확정하지 않았다. 무료는 총10장 한도·요청 첫 실제 시작1회 사용·같은 요청 내부 재개 추가 사용 없음이며 기존 시간을 다시 질문하지 않는다.
- 마지막 생성 답변의 최소 흐름 스파이크 항목에 붙은 로드맵part005 인용을 직접적인 스파이크 강의 근거로 채택하지 않았다. 실험·피드백 사례의 직접 근거는 NR04이고, I-A의 최소 범위·시점은 현재 계약에 대한 프로젝트 제안이다. 생성 답변과 검증한 정리를 구분한다.

사용자에게는 필수 계약을 만족한다는 전제의 **운영 부담 / 초기 비용 / 이전 가능성** 중 비교 우선순위 한 질문을 제시했다. 응답 전에는 미결정이다. 이후 사용자는 가치·운영 제약과 Q20~Q22의 중요한 선택을 판단하고, 에이전트는 공식 지원·실험·타입/API/원자적 경계의 근거를 준비한다. 제품 정책·공개 계약·저장/보안 변경은 승인 없이 확정하지 않는다.


## 11. 전체 구현 전 준비에서 후보 비교를 보강할 입력

2026-10-03 후속 요청으로 노트북의 표시 전사문 29개 전체를 직접 읽고 전체 준비에 연결했다. 10절의 네 원문 확인은 당시 단계의 기록이며, 최신 전체 읽기 범위와 강의/제안 구분은 [구현 전 준비 명세 1절](2026-10-03-manga-web-preimplementation-readiness.md#1-notebooklm에서-배운-준비-방법과-근거)과 학습 기록을 따른다. 원본 MP4/음성의 정확성 검증은 아니다.

Q20~Q28의 아홉 선택은 사용자 응답으로 확정했고 12절에 연결한다. 운영/초기 비용/이전 우선순위, 브라우저 버전·언어 세부/실제 지원·포맷/자료량·처리 중 행동·운영과 나머지 기술은 후속이다. 첫 언어·OS/브라우저·파일별 업로드 실패는 Q29-B·Q30-B·Q31-B로 정했다. 다음 비교에는 선정한 첫 내부 테스트 범위·인증 수단·파일/일반 만화 입력과 실제 공정/모델·원가 제약을 연결한다. 강사 사례를 근거로 나머지 제품/버전을 조용히 확정하지 않는다.

공통 Google/OIDC 주체 검증, 파일/이미지 한도·권한과 로그 보호의 공식 근거 및 SEC01~SEC10 설계는 준비 명세 5절에 연결했다. 실제 선택 기술의 타입·API/schema·원자적 경계·발행/대조·파일 지원과 구현 인계는 선택 후 작성한다. 라이브러리30일과 로컬 파일 지원, fake PASS와 실제 품질, 내부 실행 여력과 사전 차감의 구분을 유지한다.

## 12. 명시적 선택 이후의 기반과 인증·파일 상세 경계

선택의 원본은 Domain Story 25·59절이다. Q20-A는 Postgres를 권위 저장으로, TypeScript 서버를 실행·발행/대조·재시작 복구 책임의 기반으로 선정한 것이다. 실행 기록·기한·계정 사용량·정산의 원자적 경계를 이제 해당 DB에 맞춰 준비할 수 있다. 실제 PG/TS runtime 실험은 아직 하지 않았다. 기존 P01~P06은 SQLite 기반 연구 모형이며 선정 기술의 증거로 바꾸지 않는다.

Q23-A는 지정된 내 내부 테스트 계정에서 전체 제품 흐름을 완성하는 범위다. 실제 크레딧 판매/일반 이용자는 후속이다. Q24-B/Q26-A/Q27-A에 따라 Google+이메일 코드와 검증 후 명시적 로그인 수단 추가가 필요하다. 안정된 앱 내부 계정 ID와 인증 제공자의 identity를 분리하고, 중복 바인딩/동시 추가·다른 계정 연결·접근 불명을 서비스에서 판정한다. 같은 이메일 자동 계정 합병이나 기존 두 앱 계정 합병은 제공하지 않는다.

공식 Supabase 자료는 인증 후보의 기능과 확인 과제를 찾기 위해 읽었다. 제품 채택이나 실제 OAuth/메일 실행의 근거가 아니다.

| 공식 근거 | 확인한 설명 | 이번 선택에 연결되는 판단·한계 |
| --- | --- | --- |
| [이메일 passwordless](https://supabase.com/docs/guides/auth/auth-email-passwordless) | 이메일 일회용 코드와 링크 지원. 전송 응답과 코드 검증 뒤 세션 반환은 별개. 자동 가입 동작의 설정도 존재 | Q26-A의 코드 방식 후보. 문서의 코드 길이·시간·제한 기본값은 사용자 정책으로 채택하지 않았으며 테스트 가입 제한과 메일 전달을 별도 설계 |
| [Identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking) | 같은 이메일 identity의 자동 연결과 로그인 중 OAuth 수단의 명시적 추가 설명 | 자동 identity 연결을 앱 계정 합병의 허가로 사용하지 않음. 자동 연결 비활성화와 Google→이메일 추가를 포함한 실제 적합성은 미확인. Q27-A와 맞지 않으면 후보 재평가 |
| [이메일 password](https://supabase.com/docs/guides/auth/passwords) | 비밀번호 가입·확인·재설정과 실제 메일 전달 설정의 책임 | Q26의 C 비교에만 사용. Q26-A 선택으로 비밀번호 기능은 이번 로그인 계약에 추가하지 않음 |

Q21-A/Q22-A의 서비스 서명은 발행 출처와 파일 무결성의 근거다. 현재 만든 계정의 접근과 지원 형식 검사는 별개다. container·서명 payload/필수 자산 포함 범위·믿는 발행 키·키 식별/회전·유출·폐기/불명 처리와 최소 근거의 운영은 실제 파일 상세에서 작성한다. 키나 schema 지원이 불명인 파일을 무조건 유효로 인정하지 않고 원 파일을 보존한다. 라이브러리 30일은 로컬 프로젝트 파일의 지원 기간이나 키 보존 기간이 아니다.

Q25-A의 PC·태블릿 편집과 Q28-A의 일반 만화 페이지 묶음을 우선 준비한다. 첫 OS/브라우저·언어와 파일별 일부 업로드 실패는 Q29-B/Q30-B/Q31-B로 정했다. Q43-A/Q44-A/Q45-A/Q46-A로 간체·다른 언어7방향·정지 PNG/JPEG 입력·PNG ZIP을 정했다. 정확한 버전·자료량 한도·모델/추론·OCR·인페인팅·식자·품질은 후속이다. 긴 세로 웹툰과 스마트폰 전체 편집을 현재 첫 완료 범위로 확대하지 않는다. 모든 실제 인증·저장/서명 파일·브라우저·AI/비용 사례는 **NOT RUN**이다.

### 12.1 지원·입력 후속 선택

Q29-B는 일본어·중국어·영어 원문→한국어·영어·일본어의 첫 지원/평가 준비 범위다. Q30-B는 Windows Chrome/Edge·Android 태블릿 Chrome·iPad Safari이며 실제 기기/버전 검증은 아직 없다. Q31-B는 파일별 검증 실패에 대해 유효분 반영·실패 목록·실패분 새 업로드를 선택했다. Q40-A/Q41-A/Q42-A로 숫자 정렬/새 묶음 맨뒤·중복 선택·반영 후보 초과 전체 미반영을 정했다. Q43-A/Q44-A/Q45-A/Q46-A는 간체·같은 언어 자동 제외·정지 PNG/JPEG 입력·PNG 출력을 정했다. 실제 수치/적합성은 후속이다. 선택의 원본은 Domain Story 59.6~59.7절, 설계·검증 연결은 준비 명세 11.3절이다.

### 12.2 선정 기반의 첫 상세 설계 초안

[Postgres·TypeScript 실행 설계](2026-10-03-manga-web-postgres-execution-design.md)는 Q20-A 이후 작성한 요청 수명 초안이다. 현재 row/유일성·명령 의도·계보 활성 요청·실제 시작/무료 임시 확보·결과/정산·기한·lease·외부 발행 틈·재시작 대조를 연결했다. DB-only 재시도와 외부 호출을 분리하며 실제 Postgres/PGV 검증은 **NOT RUN**이다. 남은 파일/Auth·공정/화면·호스팅/버전·운영의 전체 상세 완료를 뜻하지 않는다.

## 13. 인증 제품 후보의 공식 적합성 조사

Q24-B/Q26-A/Q27-A와 안정된 앱 AccountId 계약을 입력으로 researcher가 Supabase Auth·Auth0의 공식 문서/공개 코드를 조사했고 메인이 핵심 원출처를 대조했다. [상세 비교·출처·9개 검증 목표](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/auth-candidate-comparison.md)에 기능 설명·설계 추론·hosted/실제 미확인을 나눴다. 사용자는 이후 Q38-A로 Auth0+앱 명시적 binding을 우선 상세 설계/적합성 검증할 후보로 선택했다. 인증 제품 최종 채택은 아직 없다.

| 후보 | 첫 검증 방향·근거 | 미확인/선정 전 조건 |
| --- | --- | --- |
| Auth0 기본 분리된 인증 주체+앱 LoginBinding | 이메일 OTP의 앱 화면/서버 검증과 기본 identity 분리 설명. 두 검증 subject를 안정된 내부 AccountId에 명시적으로 추가하는 후보를 먼저 검증하도록 제안 | 양방향 실제 증명·의도/callback/nonce·경합·메일/플랜/지역. native Account Linking과 앱 DB 바인딩은 별개. 공식 가격표의 native linking entitlement 확인 필요 |
| Supabase Auth | 기존 Postgres 기반과 코드/OAuth 기능의 통합 후보. 공개 소스의 실험적 linking-domain 분리 설정은 발견 | hosted 자동 연결 제어/안정 배포와 Google→이메일 OTP 수단 증명 미확인. 같은 이메일 조회가 같은 사용자에 인증하는 경로를 명시 추가 완료로 사용하지 않음 |

Q38-A로 Auth0를 **우선 상세 설계/적합성 검증할 후보**로 선택했으며 제품 채택·native linking/paid plan·무료 운영/메일 전달 보장·계정 생성 승인이 아니다. 공개 코드와 운영 배포를 구분하고 실제 적합성은 9개 인증 사례로 확인한다. Q39-A의 앱7일 절대 상한을 적용할 fresh 인증 근거·OTP 코드 제한·Q47-A/Q48-A 복구/제거의 실제 계약·제품 최종 채택/버전/호스팅은 후속이다. Google의 기본 프로필 범위 Testing 예외 때문에 지정 내부 앱 계정 gate를 OAuth 테스트 사용자 목록만으로 구현하지 않는다. 실제 OAuth/메일/tenant/실험은 **NOT RUN**이다.

## 14. 편집·출력·파일 후보의 상세 연결

[추가 상세 초안](2026-10-03-manga-web-edit-output-file-design.md)은 Q32~Q37의 편집/출력/보관을 요청 수명과 연결하고 Q21-A/Q22-A의 파일 서명을 구체화할 후보를 작성했다. Node 내장 Ed25519/정확한 manifest bytes/detached signature와 자산 digest는 공식 API 지원에 근거한 설계 후보이며 제품 형식/알고리즘·키 호스팅 채택이 아니다. required 편집과 optional checkpoint·현재 접근/원장/활성 요청을 분리하며 실제 서명/복원·EOV·storage 삭제는 NOT RUN이다.

## 15. 새 인증 근거·7일·연결 제거의 상세 후보

[인증·세션 초안](2026-10-03-manga-web-auth-session-design.md)은 Q38-A/Q39-A의 후보와 AppSession을 공식8원출처/메인 핵심4직접 대조에 연결한다. Google callback freshness·OTP 직접 exchange·앱 목적별 proof/한 번 소비는 실제 API/claim 검증 전의 기술 후보다. Q47-A/Q48-A는 provider 계정 복구/남길 수단 재인증·마지막 binding 보호·제거 수단 관련 앱 세션 철회로 반영했다. 실제 ASV01~10·메일/tenant·fresh 근거/철회·최종 제품/플랜 적합성은 NOT RUN이다. 이후 새 Q40~Q51 독립 문서 검토/지적 재확인은 지정 범위에서 종결했다. 실제 제품·전체 준비는 계속 진행 전/중이다.

## 16. 첫 화면/API 기반의 비교와 선정 상세 기준

[공식 근거·후보 비교표](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/frontend-api-comparison.md)에 React+Vite+TypeScript 화면/Node API와 Next.js+TypeScript Node web/Route Handler를 같은 상세 설계 단계로 비교했다. 전자는 화면/API 경계가 명시적이고 후자는 화면·인증/API 경로를 같은 프레임워크에서 구성한다. 두 안 모두 Postgres 권위·별도 TypeScript worker·현재 인증/실행/비용 가드를 유지한다.

Vite의 React TS template/build/정적 배포와 Next의 Route Handler/self-host/cache를 공식 문서에서 확인했다. [Vite 배포](https://vite.dev/guide/static-deploy.html)의 preview는 운영 server 용도가 아니며 [Next self-host](https://nextjs.org/docs/app/guides/self-hosting)의 after/shutdown 설명은 durable 요청·불명 복구를 대체하지 않는다. 첫 내부 이미지 작업 화면/현재 책임 분리에 A를 우선 제안하지만 속도/가격/운영 우월의 실측 결론은 아니다. Q54-A로 React/Vite/TypeScript 화면+Node API를 첫 상세 기준으로 선택했다. 버전/API framework/host/설치·FAV01~04 실행은 전이며 전체 준비 진행 중이다.

Q52-B/Q53-A는 현재/모든 앱 session logout과 계정 전체 한 live 편집 맥락의 별도 정책이다. Q54-A의 첫 기준이 이 정책이나 Auth0 최종 제품/서비스 가격·버전 적합성을 자동으로 증명하지 않는다. 상세 매핑은 준비11.19·PG8.4·인증 초안5.2/ASV11~12를 따른다.

## 17. 첫 호스팅 검토 방향의 후보

Q54-A의 React/Vite static 화면·Node API와 Q20-A의 별도 TSworker/PG를 배치할 때 [공식 호스팅 후보 비교](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/hosting-primary-comparison.md)를 사용한다. Render 작은 유료 API/worker/PG의 compute 명목 합계 $20/월과 Railway $5 최소 구독/실제 사용료, VPS 예시 사양표를 전체 비용·충분한 이미지 공정 사양으로 확대하지 않는다. Railway DB 템플릿은 unmanaged이므로 플랫폼 배포와 관리형 PG 책임이 같은 선택이 아니다.

현재 제안은 API/worker 플랫폼을 먼저 비교하고 PG/객체 저장의 운영 책임을 별도로 대조하는 순서다. 직접 VPS 운영은 OS 보안/backup·DB/장애 복구 책임과 구성 제어의 trade-off가 있다. 이 순서는 제안이며 아직 실제 질문/사용자 선택이 아니다. 회사·지역·버전·사양·월예산·계정 생성/지출 승인은 별도다. HOV01~04/PGV/EOV/ASV·실제 이미지 품질/원가 검증은 NOT RUN이다.

### 17.1 실제 Q57-A와 후속 선정 위임

사용자는 Q55~Q57 추천안을 수락해 Q57-A(운영 플랫폼 우선 비교)를 선택했다. 17절의 미선택 비교 상태는 작성 당시 근거이며 현재 우선순위는 선택 완료다. 최종 host·지역/사양·월예산·PG/객체 저장 운영·실제 계정/지출은 아직 이 답으로 정해지지 않았다. 이후 구현 전 선정은 사용자의 추천 위임에 따라 선택값/이유/대안·미검증/활성화 조건을 문서에 명시한다(Domain Story59.21). 실제 가격/지원 적합성 확인과 공개 계약 작성 없이 제품 채택/지출을 활성화하지 않는다.

## 18. 이후 추천 위임의 선정표와 구현 인계

직접Q55~57수락과이후위임은Domain Story59.20~22를따른다. [선정/인계 상세](2026-10-03-manga-web-recommended-selections-and-handoff.md) D01~15의답/이유·대안/미검증을작성했다. 추가공식Node/Fastify/pg·Render region/PG18·R2 lifecycle·3.5/2.5 Flash-Lite·LaMa/sharp/Noto원출처는그문서2절이다. runtime/host상세기준과각적합성gate는선정됐지만정확patch/lockfile·실제host월예산/사양·AI7방향품질/전체원가·실파일/키/삭제·최종독립검토는완료하지않았다. 이전비교의미선택표기는당시근거이고후속선정을실제런타임PASS로승격하지않는다.

## 19. 전체 선정/계약 문서 준비의 최신 결과

실제Q20~57의38선택과후속추천위임D01~20의20선정을기록했다. 최종schema/SQL·HTTP/currentaccess/파일·단계어댑터와측정gate·새별도root/예정파일/명령·H02~H06은[최종 인계](2026-10-03-manga-web-contract-reference.md)/준비명세12절/플랜9.12절을따른다. 기술선정/문서준비는완료했으나host/auth/object/model capability·전체원가/품질/기기/키·actualmigration의적합성과지원·새범위독립검토는후속/미완료다. actual계정/설치/지출/제품구현/배포승인은이선정에포함하지않는다.
