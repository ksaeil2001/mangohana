# 성공 checkpoint만 재사용한 요청의 결과 적용 제안

상태: 2026-10-04 architect 독립 검토 조건을 반영한 승인 대상 제안. 제품 schema·migration·실행 코드는 아직 변경하지 않았다. 기존 Domain Story/spec/진행 plan을 대체하는 계약 원본이나 별도 ledger가 아니다. 최초 검토 전 내용은 before-architect 사본과 당시 source snapshot의 SHA로 보존했다.

2026-10-04 actual PG18.6에서 restricted API/worker LOGIN과 두 fake stage로 재현했다. 원 요청의 OCR·TRANSLATE 수행과 VERIFIED checkpoint 두 개를 보존한 뒤, 마지막 checkpoint semantic 검증만 한 번 거부했다. 새 RETRY_REQUEST는 두 checkpoint를 정상 재검증했지만 ACCEPTED에 남았다. provider 호출은 원 두 번뿐이고 새 수행0·새 결과 적용0이다. 임시 cluster P3qELa/PID88192는11:48:44.742 정상 종료했으며 원 PID/postmaster.pid 소멸과 postgres0을 확인했다. source/test 전체 타입과 해당 test lint는 exit0이지만 재현 인수 사례는1 FAIL이다.

현재 ExecutionService.applyComplete는 request_steps.current_execution_id에 속한 SUCCEEDED 수행만 찾는다. 모든 step이 reuse_checkpoint_id만 가진 재시도에는 이 행이 없다. 원 수행을 조회해 바로 삽입하는 방식도 result_applications의 `(account_id,request_id,execution_id) → executions(account_id,request_id,execution_id)` 복합 FK에 어긋난다. 새 수행을 SUCCEEDED로 합성하거나 원 수행·checkpoint·비용·시작 기록을 복제해서 해결하지 않는다.

권장안은 결과를 적용하는 현재 요청과 수행이 실제 속한 원 요청을 별도로 보존한다. 검토할 정확한 저장 변경은 다음과 같다.

- result_applications의 request_id는 결과를 적용하는 현재 요청을 그대로 참조한다.
- nullable origin_request_id는 다른 요청의 checkpoint를 선택해 재사용할 때만 그 원 요청을 기록한다. 일반 현재 수행 및 기존 행은 NULL을 유지한다.
- generated execution_origin_request_id는 `coalesce(origin_request_id, request_id)`다. 수행 FK는 `(account_id,execution_origin_request_id,execution_id)`로 바꿔 실제 원 요청·수행의 동일 계정 관계를 계속 강제한다. 기존 행과 일반 INSERT의 의미는 그대로다.
- 모든 적용 행은 현재 요청의 마지막 ordinal 단계에 정확히 결속한다. 일반 행은 그 최종 현재 수행, 외부 origin 행은 그 최종 단계가 실제 선택한 VERIFIED checkpoint의 SUCCEEDED 원 수행/request를 가리킨다. 중간 단계도 원 순서와 선택 규칙에 따라 모두 확인돼야 한다. 일부 단계를 새로 실행한 뒤 마지막 단계만 재사용한 혼합 경로에서도 가장 최근의 자체 수행을 최종 출력 출처로 대신 쓰지 않는다.
- 외부 origin은 별도의 DB relationship guard로 검증하며 restricted worker의 현재 account RLS를 보존한다. 같은 account/request 잠금으로 선택 checkpoint 변경과 적용을 직렬화한다. NOT_APPLICABLE에도 같은 출처 검증을 적용한다. 무관한 같은 계정 수행을 임의 연결하지 않는다. canonical INPUT/settings/scope/assets·semantic 검증과 현재 결과 revision·context applicability 검사는 서비스에서 유지한다.
- `(account_id,request_id)` 결과 적용 unique 제약을 추가해 새 result_id로 같은 요청을 다시 적용하지 못하게 한다. migration 시작 시 기존 중복은 읽기 전용으로 검사하며 발견하면 migration을 보류하고 원 행을 정리·삭제하지 않는다. 새 generated 수행 관계와 참조 검증이 성립한 뒤 원 FK를 교체하며 기존 NULL origin 행의 의미를 유지한다.
- applyComplete는 선택된 마지막 checkpoint/현재 수행에서 원 execution 및 그 원 request를 읽고 결과 적용을 멱등으로 기록한다. 비용·START·free_start·settlement를 새로 만들지 않는다. 실제 새 시작이 없는 새 요청의 임시 무료 예약은 기존 안전 종결 규칙으로 반환한다. 결과 행·page revision·history·STORE 작업·예약 반환은 기존 요청 잠금과 같은 transaction 안의 단일 효과로 유지한다.

반영한다면 새 순차 migration과 owning source/test를 함께 검증한다. 과거 행의 business facts를 UPDATE하지 않고 새 generated relation으로 참조를 보존한다. public HTTP/DTO·사용자 행동·원 가격/단가·provider/host 활성화는 이 제안의 변경 대상이 아니다. 실제 보관 중인 DB의 migration 실행이나 배포는 승인된 범위에 포함하지 않는다.

대안은 현재 저장 관계를 유지하고 전체 checkpoint 재사용 요청을 명시 보류하는 것이다. 참조 변경은 작지만 재사용만으로 완료할 수 있는 요청을 사용자에게 다시 처리하도록 요구하거나 보류시켜, 확정한 성공 checkpoint 재사용 방향을 충분히 구현하지 못한다.

반영 후 필요한 검증은 현재 failing 실제 PG 사례의 완료·추가 수행/시작/비용0, 일반 및 마지막 단계 재사용 혼합 경로의 정확한 최종 출처, 중간 미완료/다른 단계/무관한 origin/다른 계정/미선택·미검증 checkpoint 거부, 결과 적용 ACK 유실과 중복/동시 요청에서 결과·page/history/STORE·예약 반환 단일 효과, NOT_APPLICABLE 원 출처 보존, 기존 중복 발견 시 migration 보류, 원 비용/무료 사용 보존 및 기존 migration 멱등성이다. 이 제안 자체는 해당 검증의 통과 근거가 아니다.

적용되는 원 작업 지침 [AGENTS.md](../../../AGENTS.md)는 “Trio의 프로세스 경계·전체 아키텍처, 데이터 모델·저장 형식·migration, IPC·외부 API·공개 계약, 삭제·recovery·crypto·보안 모델, 새 의존성·대규모 refactor, 핵심 UI·승인 흐름, 인증·배포·업데이트·릴리스 방식 변경은 현재 구현·설계와 영향·trade-off를 확인하고 사용자 승인을 받는다”라고 정한다. 이번 수정은 원 결과 적용의 수행 귀속 FK를 변경하므로 승인이 필요한 범위로 판단했다. 이번 architect 재호출은 성공했고 위 최종 단계·전체 의존성·단일 적용·RLS·migration 보류·ACK 효과 조건을 반영했다. 과거 호출 불가와 구분하며 이 검토가 migration 승인이나 실제 host/provider 증거를 대신하지 않는다. 이 선택을 기다리는 동안 독립된 승인 범위의 구현은 계속한다.
