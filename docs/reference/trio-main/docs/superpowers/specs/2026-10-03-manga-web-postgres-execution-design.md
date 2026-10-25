# Postgres·TypeScript 실행 기반의 요청 수명 상세 설계 초안

작성일: 2026-10-03. 상태: **Q20-A 기반의 설계 초안 — 실제 DDL·어댑터/제품 코드·Postgres 검증 NOT RUN**.

업무 원본은 [Domain Story](../../manga-translation-domain-story.md)다. 입력은 [워크스페이스 계약](2026-10-02-manga-web-workspace-contracts.md)의 R/C/E/K/S와 [기술 후보](2026-10-03-manga-web-technical-options.md)의 TR01~TR12다. 이 문서는 요청 수명의 물리 저장·명령·발행·복구 경계를 먼저 좁힌다. 파일 container/서명·실제 인증 제품·이미지 공정·호스팅/버전·전체 화면 계약까지 완료한 문서는 아니다. 진행은 [기존 플랜 9절](../plans/2026-10-02-manga-web-workspace-contracts-and-validation-plan.md)에 둔다.

첫 제품은 지정된 내 내부 테스트 계정의 전체 흐름(Q23-A)이다. 선행 I-A의 한 합성 계정/페이지·두 fake 단계 검증은 구현 순서를 나누는 방법이며 전체 완료 범위를 줄이지 않는다. 현재 작성은 준비 작업이고 새 DB·계정·dependency·제품 파일을 만들지 않는다.

## 1. 공식 근거와 우리 설계의 구분

확인한 `/current/` 공식 문서는 PostgreSQL18로표시됐다. 후속D02로Render/같은Singapore PG18을첫상세검증기준으로선정했다. actualpatch/host설정·자원/적합성/지출은검증전이다. 다음 설계는 공식 기능을 업무 계약에 연결한 제안이며 해당 DB에서 검증한 결과는 아니다.

| 공식 원문 | 확인한 설명 | 설계에 연결한 판단 |
| --- | --- | --- |
| [Transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html) | Read Committed의 문장별 snapshot과 갱신/잠금 대기 뒤 조건 재검사, Serializable의 재시도 필요 | 명령별로 현재 row·예상 revision·유일성 검사를 함께 둔다. 단순 조회→무조건 쓰기로 경쟁을 해결하지 않는다. DB 재시도 안에 외부 호출을 넣지 않는다 |
| [Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html) | PK·unique·FK로 중복/참조 제약 정의 | 요청/명령·비용/정산·identity 바인딩의 중복 방지는 DB 제약과 서비스 권한 판정을 함께 사용한다 |
| [SELECT의 locking clause](https://www.postgresql.org/docs/current/sql-select.html) | 행 잠금과 SKIP LOCKED의 잠긴 행 제외, 큐 같은 처리에 적합하지만 일관된 전체 조회는 아님 | 작업 후보 claim에만 SKIP LOCKED를 검토한다. 계정 잔액·전체 미정산·파일 캡처의 권위 조회에 이 방식을 쓰지 않는다 |
| [Date/time functions](https://www.postgresql.org/docs/current/functions-datetime.html) | now/CURRENT_TIMESTAMP는 transaction 시작 시각, clock_timestamp는 호출 당시 시각 | lock 대기/긴 transaction 시작 시각으로 기한을 통과시키지 않는다. 현재 row 잠금 뒤 판정 시각을 새로 얻고 저장된 절대 기한과 비교한다 |
| [INSERT / ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html) | 유일성 충돌의 동작을 제어하는 기능 | 충돌 회피가 동일 의도 증명은 아니다. 같은 CommandId의 정규화 의도와 기존 판정 결과를 별도로 대조한다 |

DB transaction은 외부 제공자의 실행이나 object 저장과 묶인 원자적 transaction이 아니다. 후속 절은 그 틈을 미확정 기록·조회·같은 인계 재처리로 다루는 계약이다.

## 2. TypeScript 책임·입출력의 초안

| 책임/인터페이스 후보 | 입력→출력 | 소유할 판단·금지 행동 |
| --- | --- | --- |
| `AuthenticateCurrentAccount` | 세션 근거→검증된 내부 AccountId/현재 접근 또는 거부·보류 | 이메일·파일/클라이언트 AccountId 단독 신뢰 금지. OTP/Google 제품 어댑터는 후속 |
| `HandleWorkspaceCommand` | 내부 AccountId·CommandId·의도·대상/예상 버전→기존/새 판정·참조/충돌 | 권한·명령 중복·row/버전 검사·해당 변경의 commit. HTTP 경로/공개 JSON은 아직 미정 |
| `ClaimWork` | worker identity·현재 시각→claim한 작업/lease·세대 또는 없음 | 큐 claim은 외부 실행 허가가 아니다. 만료 lease는 재검사할 권한만 준다 |
| `AuthorizeDispatch` | 작업/ExecutionId·claim 세대→현재 조건 판정/발행 준비 또는 보류 | DB 현재 수명·기한·요청/단계·입력/설정·여력 재검사. queue payload 단독 실행 금지 |
| `ProviderAdapter` | 같은 ExecutionId·검증 입력·원 설정→확인된 시작/거절/결과/사용량 또는 수행불명 | 공급사별 조회·멱등 계약이 확인될 때만 그 기능 사용. timeout/로컬 cancel을 미실행 증거로 바꾸지 않음 |
| `ReconcileExecution` | ExecutionId·새/보존 근거→원 수행 사실 갱신·미해결 상태 | 비용 없는 대조 우선. 자동 새 AI 호출·0비용·무료 반환 금지 |
| `ApplyResult` | 결과/자산 근거·원 요청/맥락·예상 page/result revision→적용/미적용 판정 | late result의 원 귀속 보존, 새 복원 맥락 자동 반영 금지. OwnerRevision은 UI 명령 권한이며 결과 맥락 검사와 별개 |
| `SettleCost` | CostItemId·확인 비용/내부 기준 버전→같은 비용 정산 여부 | 실제 잔액 변경+정산 기록 한 commit. 결과 적용과 독립, 응답 유실에 먼저 재조회 |
| `FinalizeRequest` | 요청·전체 수행/결과/종결 근거→종결/보류·활성 참조 해제 여부 | 수행 중/수행불명 없음 확인 전 해제 금지. 정산 미확정은 새 유료 실행의 별도 보류 |

타입은 의미가 다른 값을 섞지 않게 InternalAccountId·ContextId/Generation·OwnerRevision·RequestId·ExecutionId·PageLineageId·ResultRevision·CommandId를 구분한다. 실제 schema/validation 라이브러리와 코드 경로는 새 웹 프로젝트 환경을 정한 뒤 인계한다. 공급사 자격 증명·이미지/대사·프롬프트 원문은 작업 로그에 넣지 않는다.

## 3. 최소 물리 기록과 제약의 후보

아래는 필요한 열/키·원자적 경계의 설계다. 열거한 행이 모두 별도 테이블이어야 한다는 확정은 아니며 실제 DDL/인덱스·migration 검증은 후속이다. identity와 자산 접근은 모든 서비스 경로에서 내부 AccountId의 현재 권한을 검사한다. FK만으로 사용자 접근을 허가하지 않는다.

| 기록 후보·기존 K | 최소 열과 중복/참조 제약 | 변경·검사 경계 |
| --- | --- | --- |
| `Account`·K07 | 내부 AccountId PK·현재 접근 상태·revision. Auth subject와 다른 ID | 원장/무료/파일 소유권의 안정된 주체. 테스트 접근 gate와 삭제/소멸 정책 후속 |
| `LoginBinding` | 인증 issuer+subject의 unique, 내부 AccountId FK·연결 증명/명시 의도 참조 | Q27-A의 새 수단 추가. 다른 계정 바인딩 거부·불명 보류. 이메일 주소를 PK로 쓰지 않음 |
| `WorkspaceContext`·K01 | ContextId PK·AccountId·프로젝트 계보·generation·lifecycle·OwnerRevision/현재 owner·WorkspaceRevision·disconnect round/confirmedAt/deadline·exit intent·revision | 소유권 인계/단절/재접속/종료/기한을 같은 현재 row에서 검사 |
| `CommandReceipt`·K02 | (AccountId, CommandId) unique·정규화 의도 digest/버전·대상/예상 버전·판정·생성 참조 | 의도 비교+해당 상태 변경/접수 결과를 한 commit에 연결. 같은 ID·다른 의도 충돌 |
| `ProcessingRequest`·K03 | RequestId PK·AccountId/ContextId/generation·프로젝트/페이지 계보·범위·원 설정/계약·첫 실제 시작 근거·hold reasons·연속 대기 round/기한·종결 근거 | 현재 설정과 캡처 설정을 구분. wait round·대기 대상 LogicalStepId·대상 수행 연결을 보존하고 공급사 회복 조회로 회차 종료하지 않음 |
| `ActivePageRequest`·K03/K08 | (AccountId, ProjectLineageId, PageLineageId) PK·RequestId·revision. 계정/페이지 귀속 참조 검증 | 접수+유일 활성 참조를 한 commit. 다른 복원 ContextId로 잠금 우회 불가. 안전 종결에서만 제거/해제 |
| `Execution`·K04 | ExecutionId PK·RequestId/step/contract·입력 참조/digest·발행 준비/시도·시작/종료/거절/불명 근거·provider ref·claim generation·revision | lease와 실제 수행 사실 분리. 외부 인계 전 기록, 원 수행 대조만 해당 귀속에 갱신 |
| `RequestStepCurrent`·K03/K04 | (AccountId, RequestId, LogicalStepId) unique·현재 ExecutionId·수행 세대/revision. 실행 귀속 FK | 같은 요청/논리 단계의 현재 참조를 row 잠금/조건부 변경과 함께 검사. 준비·발행·실행·수행불명 수행이 있으면 다른 ExecutionId 생성/발행 금지 |
| `Checkpoint / AssetRef`·K05 | checkpoint ID·원 수행·step/input/geometry/settings/contract dependencies·자산 immutable ref/digest·검증 상태 | 필수 자산 확보/검증 뒤 성공 인정. 과거 실행을 새 요청 소유로 고치지 않음 |
| `CostItem`·K06 | (ExecutionId, cost component/ordinal) unique·사용량/단가·근거/기준 버전·confirmed/unknown | 동일 응답 중복 합산 금지. unknown 값은 NULL/명시 상태로 두며 0으로 저장하지 않음 |
| `FreeStart`·K07 | (AccountId, RequestId) unique·확인된 첫 시작/ExecutionId·사용 단위·confirmedAt | 첫 실제 시작 사실+무료 기록을 한 DB 경계에서 반영. 미확정 발행 의도는 소비 완료가 아님 |
| `AccountUsage / Headroom`·K07 | 현재 잔액/무료 이용의 revision·미정산/내부 여력 참조·요청별 임시 확보 | 잔액 선차감/예상치 표시와 구분. 동시 시작의 무료/여력 초과는 계정 row와 해당 기록을 같이 검사 |
| `Settlement`·K07 | (AccountId, CostItemId) unique·확정 금액/기준 버전·원장 entry ID·정산 완료 근거 | 확정 비용의 실제 잔액 변경+정산 완료 한 commit. 실패/응답 유실에 같은 비용 조회 |
| `PageResult / ResultApplication`·K08 | 현재 결과/편집 revision·범위·자산/레이아웃 참조·적용 ID unique·원 요청/수행 | page/context/version 검사+적용 사실+WorkspaceRevision 갱신. 정산·요청 종료와 별도 |
| `WorkItem / Claim`·TR08 | WorkItemId PK·원 참조·종류(dispatch/reconcile/apply/settle/deadline)·dueAt·lease/generation·재검사 상태 | 필요한 기록 변경과 wake-up 의도를 같은 DB transaction에 연결. 중복 전달에도 도메인 사실을 다시 검사 |

계정/맥락/페이지/수행 사이 FK와 계정 귀속의 복합 참조를 실제 DDL에서 확인한다. 단일 FK의 존재만으로 다른 계정 RequestId/자산 참조 삽입을 허용하지 않는다. `CommandReceipt`의 정규화 의도에는 동작·대상·범위·캡처 설정·예상 버전 등 의미에 영향을 주는 필드를 포함하고 secret·본문 원문을 로그에 노출하지 않는다.

같은 요청/논리 단계의 유효한 수행은 하나로 제한한다. RequestStepCurrent의 현재 수행 참조·세대를 같은 잠금/조건부 변경 경계에서 검사하며 준비·발행·실행·수행불명인 기존 수행이 있으면 다른 ExecutionId를 만들지 않는다. claim/lease 만료만으로 이 참조를 해제하지 않는다. 확실한 미실행 거절 또는 확인된 종결 뒤 허용된 다음 수행을 준비할 때에도 이전 귀속을 보존하고 현재 가드를 다시 검사한다. 상세 인덱스/DDL은 이 불변식을 구현해야 한다.

무료 실제 시작 확인 전에는 임시 확보 상태를 두어 동시 요청의 10단위 초과를 막는다. 공급사 첫 시작과 DB 반영의 틈이 있으면 그 임시 확보를 반환하거나 다른 요청에 넘기지 않고 수행 대조한다. 실제 시작 확인 시 같은 RequestId의 첫 무료 기록으로 한 번 전환한다. 유료 비용 unknown도 임시 여력 해제나 0원 확정으로 바꾸지 않는다. 여력의 금액/계산·운영 권한은 아직 미정이며 활성화 전 별도다.

## 4. 짧은 DB transaction과 외부 인계

| 동작 | 같은 DB commit에 둘 사실 | commit 밖의 일/실패 뒤 조회 |
| --- | --- | --- |
| 새 요청 접수 | 현재 권한·맥락/계보·CommandId 의도 검사, 원 설정/범위 Request 생성, ActivePageRequest, 접수 결과·wake-up | 동일 명령 응답 유실은 재조회. 외부 AI는 접수 transaction에서 호출하지 않음 |
| 인계/재접속 | 예상 OwnerRevision/기한 재검사, 새 현재 owner·접속 근거/세대 또는 보류, 명령 결과 | 이전 탭 변경/접속 유지 거부. 기존 요청 결과는 원 요청으로 대조 |
| 다음 단계 준비 | 현재 row 잠금 뒤 기한/수명/모든 holds/원 설정·checkpoint/여력과 RequestStepCurrent 검사, 허용된 Execution 준비/현재 수행 참조·발행 작업을 한 commit | 발행 직전 재검사 필요. 준비 commit이 실제 발행/시작 증거는 아님 |
| 첫 실제 시작 대조 | 같은 Execution의 시작 근거·Request 첫 시작·무료 기록/임시 확보 전환. 대기는 현재 열린 wait round·대상 단계에 연결된 수행의 시작 근거만 종료 | 응답이 없어도 새 수행 발행 금지. provider 조회/보존 응답으로 같은 수행 확인 |
| 결과 적용 | 현재 맥락/page/input/범위/result revision, 검증 자산 참조·적용 ID, page/WorkspaceRevision | 자산 저장과 DB 사이 틈은 같은 참조 조회/검증. 새 AI로 보충하지 않음 |
| 정산 | 확인된 CostItem·현재 계정/여력 row·같은 비용 Settlement/원장 반영 | 최초 미정산 비용은 다운로드 중에도 독립 정산 가능. 같은 비용 중복 차감만 금지 |
| 안전 종결 | 실행/불명 없음·결과/중단 근거 검사, 요청 종결·ActivePageRequest/잠금 해제, 관련 wake-up | 정산 상태는 별도 표시/새 유료 보류. 단순 lease/기한 만료로 종결하지 않음 |

서비스의 잠금 순서를 계정→맥락→프로젝트/페이지→요청/수행→원장 등 일관되게 정하고, 실제 명령의 읽기/쓰기 집합에 맞춰 deadlock·serialization 재시도를 검증한다. 이것은 lock 순서 초안이며 전체 기능의 확정 순서는 아니다. DB-only transaction만 같은 명령/의도로 재검사해 재시도한다. 외부 AI/자산 저장·메일 전송을 DB retry callback 안에서 반복하지 않는다.

`ON CONFLICT DO NOTHING`으로 무시한 뒤 성공을 반환하지 않는다. 충돌한 현재 참조·의도·귀속·판정 결과를 조회하고 해당 요청/정산/바인딩이 같은 것인지 확인한다. 조회 불명은 보류/재조회로 반환한다.

## 5. 시계·claim·발행 경계

서비스 권위 DB에 단절 회차의 `disconnectConfirmedAt/deadline=+5분`과 확실한 미실행 제한 회차의 `waitStartedAt/deadline=+10분`을 각각 보존한다. 클라이언트 시각·UI 카운트다운·worker timer는 결정 권한이 없다. 재접속·조회·탭 인계·저장하고 나가기는 공급사 회차/기한을 새로 시작하지 않는다. 현재 열린 wait round·대기 대상 LogicalStepId와 일치하고 그 회차에 연결된 수행의 실제 시작 근거로만 회차를 종료한다. 이전 단계나 다른 회차의 시작/성공 근거는 현재 회차를 끝내지 못한다. 일시 회복 뒤 다른 보류가 남으면 원 회차를 유지한다.

잠금 뒤 판정 시각은 `clock_timestamp()`를 한 번 읽어 동일 판정의 시각으로 사용한다. 기한 미만과 이상을 분리하고, 준비 시점에 통과했어도 실제 발행 경계에서 다시 검사한다. UTC timestamp 저장만으로 host 간 skew·DB failover/시계 후퇴가 해결되지는 않는다. 시계 불명·DB 접근 불가·현재 세대 확인 불가 때 새 비용 발행을 보류하는 운영 계약을 인계한다.

claim은 해당 DB 기록을 조정할 임시 권한이다. lease/generation 불일치 worker는 새로운 상태 변경/새 발행을 진행하지 않는다. 단, 원 수행의 늦은 응답은 폐기하거나 새 수행으로 바꾸지 않고 그 ExecutionId의 증거 수신 경로로 전달해 대조한다. row/job가 잠겨 claim에서 제외됐다는 사실은 요청이 종결됐다는 의미가 아니다.

**외부 발행과 DB 사이의 미해결 검증 지점:** DB에서 발행 준비를 commit한 뒤 네트워크를 시도하기 전에 단절/기한/종료가 바뀔 수 있다. 짧은 lease·outbox·사전 가드만으로 이 틈이나 외부 exactly-once가 해결됐다고 하지 않는다. 발행 직전의 현재 가드와 발행 시도 순서를 조정하는 실제 실행기, pause/expiry/동시 worker/재시작 실험 및 공급사 멱등·조회 근거를 확보해야 한다. 이미 실제 발행/시작한 수행은 만료 뒤에도 원 사실·비용을 대조하며, 아직 발행하지 않은 새 비용 단계는 막아야 한다. 이 조건을 입증하기 전 실제 비용 경로를 활성화하지 않는다.

발행 준비/시도 흔적이 있는 worker가 죽었다면 무조건 재발행하지 않는다. 확실히 발행 전임을 확인한 작업만 현재 모든 조건을 검사한 뒤 같은 준비를 진행할 수 있다. 발행 여부가 불명하면 reconcile 작업으로 옮긴다. provider idempotency key의 범위·기간·응답 보존·재호출 비용이 확인되지 않으면 같은 key를 넣었다는 이유로 안전한 재전송을 인정하지 않는다.

## 6. 재시작 복구의 사건별 행동

| 저장된 근거/중단 지점 | 다시 시작한 실행기가 할 일 | 금지 부작용 |
| --- | --- | --- |
| 요청/작업 commit 전 process 종료 | CommandId/현재 요청 조회, 기록 없는 의도는 현재 사용자 명령 재전송에서 검증 | 임의 새 요청/무료 사용 생성 |
| 접수 commit 후 응답 유실·queue wake-up 유실 | 기존 접수/원 요청 반환. DB의 작업 의도를 claim 후 현재 상태 검사 | 같은 page의 두 요청·새 설정 대체 |
| 확실한 발행 전 준비, lease 만료 | 현재 claim·세대·기한·권한/여력·입력을 확인하고 원 준비 경계 처리 | 오래된 권한으로 실행, 시계 초기화 |
| 발행 시도 후 시작/응답 기록 유실 | 원 ExecutionId로 수행·사용량 대조, 확인 불명 보류 | 자동 재발행·0원·무료 반환·조기 잠금 해제 |
| 결과/사용량 보존 후 적용·정산 일부 실패 | 같은 산출물/비용으로 실패한 인계만 재처리 | 새 AI/중복 합산·같은 비용 재차감 |
| 맥락 만료 뒤 늦은 성공 결과 | 원 수행/결과/비용 보존·정산 대조, 현재 적용 자격 별도 검사 | 만료 맥락 재활성화·새 복원 맥락 덮기 |
| 종결 commit 뒤 UI 응답 유실 | 원 요청 종결/활성 참조 해제 조회 | 취소/재번역 자동 생성 |
| 5분/10분 기한 worker 지연 | 현재 서비스 시각·회차/세대 검사, 새 발행 차단·안전 경계의 종결 대조 | 지연만큼 유예 연장·확인 전 수행 중단 확정 |

복구는 작업 목록의 빈 상태가 아니라 권위 기록·보존 근거에서 판정한다. polling/기한 작업의 주기·lease 길이·재시도 상한은 실험/host 제약으로 정할 기술 값이며 5분/10분 정책과 구분한다.

## 7. Postgres 기반의 인수 설계 — 모두 NOT RUN

격리 DB·가짜 credential·합성 계정/이미지·제공자 대역을 사용한다. 실제 선택 DB에서 두 연결/worker를 제어하고 row·원장·provider 대역 호출/시작·자산·응답의 ID별 근거를 모은다. 기존 S/APV/SEC와 연결하며 fake provider PASS를 실제 공급사 수행/비용/품질의 보장으로 확대하지 않는다.

| ID·사전 상태/장애 | 기대 결과·관측 근거 | 기존 연결 |
| --- | --- | --- |
| PGV01 같은/다른 의도 CommandId 두 동시 접수 | 같은 의도 한 요청·참조, 다른 의도 충돌. receipt/active/request와 호출 수 | TR04·S28 |
| PGV02 새 복원 맥락에서 같은 계보 페이지 동시 접수 | 계정+프로젝트+페이지 단일 활성 요청. ContextId 변경으로 우회 없음 | TR05·S12/S26 |
| PGV03 transaction/row 잠금 대기 중 5분·10분 도달 | lock 뒤 실제 판정 시각으로 새 발행 거부. now의 과거 시각으로 통과하지 않음 | TR01/02·S20/S27 |
| PGV04 반복 회복 조회·재접속·인계·재시작 후 재제한 | 원 wait round/대상 단계/deadline 보존, 그 회차/단계에 연결된 수행의 실제 시작 전 초기화 없음 | TR02·S07/S27 |
| PGV05 claim/준비 뒤 발행 전 pause→단절/기한/종료 | 다시 진행해도 아직 미발행 새 비용 호출 없음. 가드/사건 순서·DB 시각·대역 발행 근거 | TR01~03/08 |
| PGV06 외부 수행 시작 후 응답/DB 반영 전 worker kill | 원 Execution 대조, 자동 두 번째 수행/무료 복구·잠금 해제 없음 | TR03/06·S08/S22 |
| PGV07 lease 만료 뒤 이전/새 worker 동시 결과/작업 전달 | 새 발행 중복 없음, 늦은 원 수행 근거 보존·현재 권한으로 원 사실 대조 | TR08·S20/S24 |
| PGV08 무료 첫 시작 동시·사용 9단위·마지막 단위 확보 불명 | 임시 확보 포함 초과 시작 없음, RequestId별 실제 시작 무료 한 번. 불명 확보 자동 반환 없음 | TR06·S09/S22 |
| PGV09 같은 CostItem 정산 동시·commit 뒤 응답 유실 | 한 원장 entry/차감·같은 완료 조회. unknown 비용 0 확정 없음 | TR07·S08/S13 |
| PGV10 적용/정산 순서 변경·하나만 실패 | 성공 결과 표시/정산 확인 중·새 유료 보류 독립. 최초 미정산 비용 정산 가능 | TR07·APV10·S08/S24 |
| PGV11 만료/복원 뒤 late result·현재 result revision 변경 | 원 사실 보존, 자격 없는 맥락/버전에 적용 없음 | TR07/08·S12/S24 |
| PGV12 종료/모델 불가·안전 경계·불명 수행 각각 | 안전 근거 있을 때만 종결/active 해제·기존 명시 재번역 가능 | TR12·S21/S31 |
| PGV13 DB failover/접근 불가·시계 불명·stale claim | 새 발행 보류, 기록 조회/대조·복구 근거 보존. 자동 수명 연장/실행 없음 | TR01/08·S20 |
| PGV14 DB serialization/deadlock 재시도 | 같은 명령 DB-only 경계 재검사, 외부 제공자 호출 반복 없음 | TR03/04/07/08 |
| PGV15 동일 새 로그인 수단 동시 연결·다른 내부 계정 소유 | 한 내부 계정 binding, 다른 계정 거부·불명 보류, 무료/원장/파일 소유권 합병 없음 | Q27-A·AUTHV02/03 |
| PGV16 같은 요청/논리 단계의 중복 작업·동시 worker가 다른 ExecutionId 준비 | 현재 수행 참조 한 개, 준비/발행/실행/불명 기존 수행 동안 새 수행 생성·발행 없음. 참조/세대와 실제 대역 호출 수 관측 | TR03/08·K04 |
| PGV17 1단계 성공→2단계 제한→1단계 시작/성공 근거 재수신 | 2단계의 열린 wait round/대상/기한·보류 유지. 해당 회차의 2단계 수행 시작만 종료 근거 | TR02·S07/S27 |

이 표는 기대값과 관측 계획이다. Postgres 설치/기동·DDL 적용·PGV 실행·메일/OAuth·실제 외부 호출을 하지 않았다. 결과는 **NOT RUN**이다.

## 8. 구현 인계 전에 이어서 정리할 것

- 나머지 기술/버전·host·DB/client·새 웹 프로젝트 경로/환경을 근거와 trade-off로 선정하고 실제 DDL·마이그레이션·오류 코드·HTTP/validation·환경/명령을 작성한다.
- 외부 발행 직전 가드/사건 순서·불명 대조 어댑터의 실제 책임과 지원을 검증한다. 비용·수행 확인 불명 경로의 UI와 운영 권한/보존은 별도다.
- 파일/서명·현재 계정·최소 검증 근거, coherent snapshot/자산·다운로드/사용자 확인, 업로드·편집·ZIP·라이브러리의 남은 선택을 같은 기반에 연결한다.
- 언어/브라우저·일반 페이지 자료의 공정/품질·원가와 실제 비용 활성화 조건을 준비한다. 미정 권한·상한·단가/가격을 추천값으로 채워 실행하지 않는다.

G02/G04와 전체 G01~G08의 완료를 이 초안으로 선언하지 않는다. 선택의 문서 반영과 요청 수명 초안의 독립 검토 범위·검사 결과는 기존 플랜 및 이번 단계 기록에서 확인한다.

### 8.1 편집·출력·파일 상세의 연결

[편집·출력·파일 상세 초안](2026-10-03-manga-web-edit-output-file-design.md)이 ManualPageHistory/ExportCapture/LibraryStoreOperation·서명 파일/현재 접근/종료의 후보 경계를 잇는다. PG의 RequestStepCurrent·실제 수행/정산·외부 발행 틈을 대체하지 않는다. Q39-A의 앱7일 절대 상한과 현재 접근은 Auth adapter의 실제 검증 대상으로 두며 워크스페이스/공급사 시계와 분리한다. 실제 PG/파일/Auth/출력 검증은 계속 NOT RUN이다.

### 8.2 인증 attempt·앱 session·binding 철회 후보의 연결

[인증·세션 초안](2026-10-03-manga-web-auth-session-design.md)은 목적별 one-use evidence/앱7일 생성·명시 binding과 Q48-A의 마지막 수단/동시 제거·관련 앱 세션 철회를 DB-only 원자적 후보로 잇는다. 원 provider 호출을 transaction retry 안에 넣지 않는다. 보호 요청/새 비용 단계의 현재 접근 검사와 기존 수행/불명/정산 사실을 분리하며, 연결 제거 때문에 활성 요청을 임의 성공/중단 처리하거나 잠금을 조기 해제하지 않는다. 실제 ASV/PGV·새 schema/HTTP·provider 계약은 NOT RUN이다.

### 8.3 처리 중 변경과 요청 캡처의 현재 경계

Q49-A/Q50-B/Q51-A의 UI/명령은 [상세 초안11절](2026-10-03-manga-web-edit-output-file-design.md#11-처리-중-업로드구성-잠금과-미래-요청-설정)과 EOV22~24를 따른다. HandleWorkspaceCommand와 새 request/batch 접수·종결이 같은 현재 맥락 guard를 지켜 busy/구성·SettingsRevision/캡처를 DB-only 확정 순서로 검사하는 후보를 작성했다. projection/화면 busy만으로 권한·종결을 인정하지 않는다. 작업 페이지 교대 중 no-current-page를 일괄 종결로 쓰지 않고 이전 성공 command 조회와 새 변경 의도를 분리한다. 실제 DDL/lock/isolation/adapter/API·제품 경합 검증은 NOT RUN이다.

### 8.4 앱 세션 범위와 계정 전체 live 맥락 슬롯

Q52-B의 current/all AppSession 철회와 Q53-A의 AccountLiveContextSlot은 안정된 AccountId로 확인하는 후보 기록이다. 슬롯의 계정 유일성/맥락 세대와 실제 state를 같은 DB-only 경계에서 대조해 동시에 요청한 새 프로젝트/파일 복원이 서로 별도 live 맥락을 만들지 않도록 한다. 기존 슬롯 충돌은 원 맥락 복귀/기존 종료·파일 확인을 안내한다. client 선택/heartbeat/다른 provider subject나 worker lease 만료만으로 슬롯을 비우거나 owner를 인계하지 않는다.

Q55-A 정상 종료의 파일 확인/종료 확정, 단절5분 만료의 실제 사건/시각 또는 Q56-B 명시 전체 보안 종료의 새 접근 증명/손실 확인·종료 사건을 대조한 후에만 live 슬롯 해제를 판정한다. 원 context/execution/불명·원장/정산 hold는 슬롯과 별도이며 이전 수행 기록을 삭제하거나 새 맥락에 자동 연결하지 않는다. Q55/Q56의 서로 다른 종료 사유를 기록하고 workspace lifecycle/현재 요청 종결을 같은 사실로 합치지 않는다. React/Vite browser는 DB/secret/현재 권한을 소유하지 않고 Node API/worker가 각 기존 guard를 적용한다. ASV11~12/FAV·actual schema/HTTP/host/비용 활성화는 NOT RUN이다.

### 8.5 Q55 정상 저장 logout과 Q56 전체 보안 종료

현재 logout의 정상 file gate는 ExitOperationId/context generation·latest snapshot/보관 확인을 대조한 실제 맥락 종료와 current AppSession revocation을 연결한다. 다른session owner context는 current-only에서 변경하지 않는다. 전체 보안 종료는 현재 binding/revision과 목적별 새 proof/손실 명시 확인·AccountId를 DB-only 경계에서 대조해 account auth generation/세션 철회와 live context closed/owner 철회·슬롯 해제/새 단계 허가 차단을 기록한다. context 종료와 request StopRequested·원 발행/unknown/무료/정산 hold는 별개이며 원 요청의 안전한 terminal을 꾸며내지 않는다. 외부 dispatch 직전과 철회 경합은 이미 발행한 단계와 새 허가 단계를 구분할 선형화 지점을 검증해야 한다. DB transaction만으로 외부 취소/정확히 한 번을 보장하지 않는다.

| 추가 인수 ID | 관측과 기대 결과 — 모두 NOT RUN |
| --- | --- |
| PGV18 정상 logout/owner 인계·latest file/확인/철회 동시 | 정확한session/context/ExitOperation·최신snapshot/확인/종료 gate, 다른session context 보존. file 오류/unknown 중 완료/임의 슬롯 해제 없음 |
| PGV19 전체 logout proof/동시 연결 제거·현재 binding/revision | 한 목적 evidence/손실 명시 확인·현재active binding 재검사, 모든 app session 철회/closed reason·원 수행/원장 hold 별도. file 기다림/새LOGIN7일 없음 |
| PGV20 발행 직전/직후 철회·late result·새LOGIN/context/응답 유실 | 승인 순서/발행권한 대조·새 비용 단계 허가 차단·이미 발행 단계/불명/정산 보존. 원 맥락 부활/새 맥락 자동 연결 없음·중복 종료는 원 명령 조회 |

### 8.6 선정 runtime와 실제 schema/HTTP 인계의 위치

D01/D02의 Node24/Fastify/pg·PG18 상세 기준과 [추천 인계](2026-10-03-manga-web-recommended-selections-and-handoff.md)4/7절의 wire envelope/HTTP·금액Decimal/SQL constraint·예정migration/검증경로를 사용한다. PG3의 최소물리열/identity·현재step·AccountLiveContextSlot와C02/file gate/전체보안종료를실제DDL/FK/check/index로구현한것은아니다. 한client transaction과외부call/DB retry분리·fencing/원기한/unknown/정산보호는그대로다. 기존Trio의package/테스트를선정web runtime PASS로사용하지않는다.

### 8.7 전체SQL/typed schema의 후속 인계

[최종 계약](2026-10-03-manga-web-contract-reference.md)2~5절/SQL설계의47기록·현재step/FK/check/원free·Cost/Settlement/AccountLiveContextSlot·같은계정의context/page상호귀속·retryOf·history/export/library·liveness/evidence를작성했다. 오프라인metadata키/열/type·finite금액대조만PASS이며실제PG구문/DDL적용/권한/transaction/race·발행경합/복구는NOT RUN이다. 이문서앞의후속DDL필요표기는당시준비범위이며actualmigration은H02~H04에서작성·검증한다. 전체문서준비결과는준비명세12절을따르고제품실행/독립검토완료로확대하지않는다.
