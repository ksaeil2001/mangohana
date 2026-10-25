# LaMa 원 invocation 및 순서 있는 metadata journal 수정안

작성일: 2026-10-04. 상태: **독립 계획 검토 반영 / 사용자 승인 대상 / 제품 source 미구현**.

현재 private executor는 `LocalLaMaAttemptStore`에 최초 원 invocation과 START·ENGINE_REPLY·FULL_COST·HOLD를 보존하도록 요구한다. 실제 SQL backend는 아직 연결하지 않았다. 메모리 map이나 새 instance에서 원 identity를 다시 만들면 재실행을 초래할 수 있고, reply metadata만으로 이미지나 원 작업 종료를 복원하면 성공을 잘못 확정할 수 있다. 이번 수정은 기존 보호 `execution_evidence`에 원 identity와 순서 있는 metadata를 보존하는 제한된 backend를 만든다.

9.41의 binding reader는 원 identity 조회이고 mutation 권위를 부여하지 않는다. 9.36 checkpoint 수정 승인은 현재 요청과 원 수행의 결과 출처 보존에 한정된다. 이번 수정은 durable identity·append 순서·최초 생성 ACK·HOLD의 저장 의미를 추가하므로, 저장 형식 변경 전에 승인을 요구하는 현재 [AGENTS.md](C:/Users/ksaei/OneDrive/문서/trio-main/AGENTS.md)의 조건을 적용한다.

## 변경 범위와 선택 이유

| 파일 | 책임 |
| --- | --- |
| 새 `packages/domain/src/local-lama-binding-verifier.ts` | 기존 reader의 bounded INPUT/core/evidence/cost basis/candidate/LaMa capture 검증과 dispatch fence를 private transaction helper로 추출 |
| 기존 `packages/domain/src/local-lama-binding-reader.ts` | 기존 `readOriginal`·`readForDispatch`의 입력 소유·예약·오류·반환 계약을 유지하며 helper 사용 |
| 새 `packages/domain/src/local-lama-attempt-journal.ts` | 원 invocation과 순서 있는 metadata를 보호 evidence에 추가·재조회 |
| 새 `tests/domain/local-lama-attempt-journal.test.ts` | 소유 복사·metadata/hash/chain·상한·충돌·ACK 의미 회귀 |
| 새 `tests/postgres/local-lama-attempt-journal.test.ts` | 실제 restricted worker/RLS·경쟁·lease fence·멱등·원 사실 보존 회귀 |

reader의 SQL을 복제하면 두 경로의 소유·capture·fence 조건이 갈라진다. reader에 mutation callback을 열면 조회 계약이 흐려진다. transaction 내부 private verifier를 공유하는 최소 추출을 선택한다. 기존 reader 조건을 정리·확장하는 별도 리팩터링은 하지 않는다. source 3개와 새 test 2개를 owning 범위로 둔다.

기존 `execution_evidence`의 자유로운 private kind와 worker SELECT/INSERT·계정 RLS를 사용한다. 새 table·migration·grant·공개 DTO·IPC·의존성·asset purpose를 만들지 않는다. 원 START/free_start/cost/settlement·checkpoint 출처 계약과 원 migration bytes도 보존한다. 기존 unique는 digest 중복만 제한하므로 singleton과 순서는 trusted writer의 account 잠금 및 전체 이력 검증으로 유지한다.

## 저장 및 재조회 계약

1. 첫 await 전에 입력·두 capture·서버의 NativeJobClaim·metadata를 제한된 소유 사본으로 만든다. getter/Proxy·비정상 shape·크기 초과를 허용하지 않으며 encoded/in-flight·동시 호출 상한을 둔다.
2. 기존 `accountTransaction(..., true)` 안에서 계정 잠금과 서버 clock을 사용한다. 원 execution/INPUT/candidate/cost basis/LaMa capture 관계를 검증하고, 기존 original 및 전체 bounded history를 먼저 읽는다. 외부 engine/object I/O는 transaction callback에서 실행하지 않는다.
3. 기존 original이 있으면 정확 같은 identity만 재조회한다. lease 만료·종료·계정 제한·새 instance·응답 유실은 새 original을 만드는 근거가 아니다. 최초 INSERT commit ACK를 확인한 호출에만 `created:true`를 반환하며, 재조회는 `created:false`다. 이 값 자체는 실제 submit/GO 권위가 아니다.
4. 새 original을 저장할 때만 같은 transaction에서 ACTIVE/current dispatch·정확 work item/owner/generation/live lease·step/request/context를 확인한다. 먼저 reader가 통과했다는 사실을 다른 transaction의 INSERT 권위로 쓰지 않는다.
5. journal이 없는데 LAMA_START/OUTCOME/RECONCILIATION·PLAN/OUTPUT·START 등 후행 수행 사실이 있으면 adoption 없이 HOLD한다. LAMA_INPUT만 있는 legacy 실행도 향후 실제 submit을 위한 ‘미실행’ 증거로 승격하지 않는다. 이번 backend는 실제 submit과 연결하지 않는다.
6. envelope는 기존 account/execution/inputDigest/inputFingerprint wrapper에 결속하고 원 invocation identity·명시 ordinal·이전 envelope digest를 포함한다. DB envelope digest와 원 recordDigest를 각각 검증한다. received_at/evidence_id 정렬을 append 순서로 쓰지 않는다.
7. 같은 original·recordDigest의 재호출은 기존 ordinal/digest를 유지한다. duplicate ordinal·gap·fork·다른 original·ref/SHA 불일치·동일 engine evidenceId의 다른 사실을 정상 이력으로 합치지 않는다. 기존 원 사실을 보존하고 충돌/HOLD를 드러낸다.
8. payload 및 가변 text/ref는 SQL `CASE octet_length`로 driver 반환 전에 제한하고 `LIMIT max+1`로 overflow를 검출한다. oversized 행을 숨겨 빈 이력으로 만들지 않는다.

## 성공과 원가의 의미

ENGINE_REPLY metadata에는 원 evidenceId·capture/runtime·state/providerSuccess·START·fullCost 주장과 proposal SHA/길이를 보존할 수 있다. 원 PNG bytes는 이 journal에 저장하지 않는다. journal 전용 metadata view를 반환하며 이를 기존 bytes 기반 `LocalLaMaInvocationRecord` 또는 `LocalLaMaAttemptStore`로 캐스팅하지 않는다.

`raw 복원 미확인`과 `원 lifetime 미확인`은 그대로 남는다. reply가 기록된 뒤 executor가 original joined/callback I/O를 기다리는 현재 순서를 고려하여, reply 존재만으로 작업 종료나 정상 snapshot을 만들지 않는다. raw/lifetime 누락을 proposal:null의 성공·NOT_STARTED·0원으로 치환하지 않는다. FULL_COST 기록은 원 주장의 보존이며 whole-stage closure·정산 권위를 새로 만들지 않는다.

이 범위에는 실제 engine submit/query·raw object allocation/PUT/GET 복원·original lifetime 종료 조회·전체 validation/storage 작업 집합 closure·runtime 조립/운영 활성화가 포함되지 않는다. 해당 책임은 후속 구현으로 남으며 실제 작업이 필요한 근거·영속 계약을 조사하고 승인 경계를 따로 적용한다.

## 완료 조건과 검증

- 기존 binding reader 단위·restricted PG 회귀에서 기존 조회·bounds·closed/expired 원 lookup을 보존한다.
- 두 제한 계정 연결의 동시 first claim에서 원 identity 하나·명확한 생성 ACK 하나를 확인한다.
- reader 통과 뒤 owner/generation/lease가 바뀐 경우 같은 transaction fence가 신규 claim을 거부한다.
- 실제 commit 후 ACK 유실·새 instance·lease 만료/종료/RESTRICTED 조회에서 같은 original/ordinal/digest를 보존한다.
- journal 없는 후행 실행 사실, chain의 duplicate/gap/fork, 교차 account/INPUT/두 capture, 잘못된 ref/SHA, oversized row·LIMIT+1 overflow를 거부한다.
- raw/lifetime 근거가 없는 성공 metadata가 재생성 후에도 정상 실행 snapshot으로 바뀌지 않음을 확인한다.
- API의 보호 payload 접근과 worker UPDATE/DELETE 거부, 기존 START/free_start/cost/settlement 불변을 확인한다.
- 제품 전체 typecheck·owning lint·최종 exact source 독립 검토와 hash/provenance를 단일 활성 ledger에 기록한다. PostgreSQL은 격리 cluster와 fake credential만 사용하고 정상 종료를 확인한다.

승인은 위 source 및 격리 검증 범위다. 운영 DB·실제 제공자·실제 LaMa engine·가격/정책·host 권위·배포는 실행하지 않는다. 선택을 기다리는 동안 기존 worker 초기화 결함의 구현·검증을 계속한다.
