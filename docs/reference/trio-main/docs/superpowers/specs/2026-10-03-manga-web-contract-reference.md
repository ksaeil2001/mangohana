# 만화 웹 서비스의 구현 전 계약·schema·저장 인계

작성일: 2026-10-03. 범위: **구현 전 설계 원본·오프라인 문서 검사 / 실제 제품·Postgres·외부 인증/AI·파일 파서·호스팅 NOT RUN / 새 범위 독립 검토 미완료**.

업무 정책은 [Domain Story](../../manga-translation-domain-story.md), 선택과 비교 근거는 [추천 선정/인계](2026-10-03-manga-web-recommended-selections-and-handoff.md), 진행·준비 완료 기준은 [준비 명세](2026-10-03-manga-web-preimplementation-readiness.md)와 [기존 플랜](../plans/2026-10-02-manga-web-workspace-contracts-and-validation-plan.md)을 따른다. 별도 웹 제품의 구현 인계 자료이며 기존 Electron의 `.ctp`·IPC·출시 범위를 변경하지 않는다.

2026-10-11 사용자 방향 교정: 현재 구현의 목표와 보고 기준은 [AGENTS.md의 웹서비스 목표](../../../AGENTS.md#웹서비스-목표와-작업-보고)를 따른다. 첫 내부 테스트 계정용 MVP에서도 다양한 새 이미지의 자동 OCR·문맥 번역·원문 제거·말풍선 식자와 검수·수정·재번역·취소·복구·저장·재개·ZIP 다운로드를 실제 웹 경로에서 확인해야 한다. 샘플 번역문·좌표·개행 보정은 원인 분석용 실험이며 공통 자동 성능 개선이나 완료 근거로 계산하지 않는다. 기존 12장과 별도의 새로운 자료에서 번역 의미, 미번역·원문 잔여, 그림 보존, 식자 위치·넘침·가독성을 각각 검토한다. 자동 신호와 실제 시각·언어 검토를 구분하고 사람 미확인 초안을 정답으로 확정하지 않는다. 아래의 작성 당시 NOT RUN 기록과 보호 계약은 보존하며 현재 구현·실행 상태는 기존 플랜의 최신 기록으로 판단한다.

## 1. 위임으로 고른 추가 답과 대안

다음 D16~D20은 사용자의 ‘남은 질문은 추천대로 진행하고 답을 모두 문서화’ 지시로 선정했다. 실제 Q58 이후의 질문/사용자 직접 응답으로 기록하지 않는다. 설치·계정·비용·제품 실행의 승인은 포함하지 않는다.

| ID | 선정한 답 | 추천 이유와 대안·조건 |
| --- | --- | --- |
| D16 화면/API 배치 | 첫 Node API가 Vite build의 공개 정적 파일과 `/api/v1`을 같은 origin에서 제공. 서버 opaque AppSession cookie와 현재 owner channel의 별도 capability를 사용 | 초기 CSRF/CORS·파일 전달 책임을 좁힌다. 별도 CDN/frontend origin은 측정상 이점과 CORS·cookie/철회 검증이 있을 때 검토. 인증 토큰/개인키를 browser bundle에 넣지 않는다. |
| D17 데이터·의도·참조 | 아래 Draft7 schema/typed command·UTC 시각·bigint/Decimal 문자열, 명령 의도는 RFC8785 JCS+SHA-256, 계정/맥락/페이지 복합 FK·revision/CAS, JSON body256KiB/표시명256자 상한을 첫 계약으로 선정 | 재전송의 같은 의도와 과거 실행 귀속을 보존한다. 이 protocol cap은 이미지 실측 한도를 대신하지 않는다. ORM/불투명 JSON 단일 저장은 동일 제약·운영 이점이 확인될 때 대안. 파일 서명은 JCS가 아니라 **원 manifest bytes**를 사용한다. |
| D18 연결 감지·claim 초기값 | owner heartbeat 15초, 마지막 유효 통신45초 초과를 서비스가 현재 row에서 확인하면 그 **확인 시각부터5분**. deadline/claim 탐색5초, 작업 lease30초/renew10초를 초기 실험값으로 선정 | 숨김 탭 이벤트·로컬 타이머를 종료 근거로 쓰지 않는다. 단절 확인의45초와 확인 후5분, lease와 수행 사실은 별개. 기기 휴면·DB/host 지연으로 조정할 수 있는 값이고 기존5분/10분의 reset·연장을 만들지 않는다. |
| D19 측정·품질·활성화 | versioned server parameter profile의 필수 수치를 미측정 NULL로 두고 관련 실제 경로를 차단. 7방향×3유형 평가에서 의미·읽기순서·배경·glyph/넘침·자원/원가를 각각 판정 | 임의 업로드 한도·월예산·원가0을 만들지 않는다. 더 넓은 corpus와 engine 교체는 실패/지원 범위에 따라 검토. 실제 모델/자료/비용 활성화는 명시 실행 범위와 RSG gate를 통과해야 한다. |
| D20 계정 bootstrap·키·운영·root | 안정 AccountId와 정확한 issuer/subject를 검증한 지정 계정만 운영 설정에 등록. API signer에만 Render secret file의 발행키를 주는 방식을 첫 검증 후보로 선정. 별도 예정 root는 `C:/Users/ksaei/Documents/Codex/trio-manga-web`. 새 프로젝트는 `진행 중`·빈 페이지이며 번역 설정은 명시 선택 전 미설정 | 이메일 일치 자동 등록/합병·기본 콘텐츠 열람·worker 개인키 접근 없음. 외부 KMS는 필요/비용 검증 뒤 대안. 실제 root는 미생성(부모 존재/대상 없음만 확인), provider 주체·키/secret 설정·운영 복구는 실행 gate다. |

D05의 추가 앱 limiter 초기값은 recipient별 발송5회/rolling1시간·IP별20회/1시간, 오입력은 attempt당5회와 recipient별5회/IP별20회/rolling15분이다. 새 attempt·재접속으로 창을 reset하지 않는다. provider가 더 엄격하면 그 제한도 적용한다. 잠시 제한됨을 안내하며 영구 계정 잠금/새 무료 할당을 만들지 않는다. recipient는 provider의 검증/전달용 canonical 값에 서버 HMAC을 적용한 limiter 키이고 원 메일/IP를 일반 로그에 남기지 않는다. 실제 발송 비용·provider TTL/코드 형식은 검증 전이다.

## 2. 기계 판독 계약의 위치와 의미

아래 파일은 설계 자료다. `trio.invalid`의 schema ID는 로컬 식별자이며 네트워크에서 불러오지 않는다. source hash는 [목록](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/contract-reference/source-index.json)에 보존한다.

| 설계 자료 | 구체화한 범위 | 아직 증명하지 않는 것 |
| --- | --- | --- |
| [wire v1 schema](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/contract-reference/wire-v1.schema.json) | 생성/import·인증/연결/제거·두logout·업로드·owner heartbeat·RECONNECT 포함 명령22종·명령 응답/계정/워크스페이스/활성페이지/작업/라이브러리 투영과 내부 stage/proposal 정의 | 권한·현재 revision·가격·지원 한도·외부 수행. schema를 통과해도 현재 서비스 가드가 필요하다. |
| [manifest v1 schema](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/contract-reference/manifest-v1.schema.json), [signature schema](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/contract-reference/signature-v1.schema.json) | 발행/계정·페이지/순서·원본/현재 대사/geometry·수동 식자·폰트/라이선스/렌더 계약·누적 baseline/미정산 참조·optional checkpoints | 실제 ZIP parsing·서명/현재 접근·자산 존재·decode·호환성. 빈 구조 fixture는 유효 편집 파일의 예제가 아니다. |
| [SQL 설계](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/contract-reference/storage-design.sql), [열/FK 목록](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/contract-reference/storage-structure.json) | 47개 기록의 열/PK/unique/복합 FK/check·현재 수행·기한/시각·정산/이력/캡처/보관/권한 인계 | PostgreSQL 구문/실행·role/grant·migration·race·복원 PASS. 실제 migration 적용 전 격리 PG18에서 확인한다. |
| [수치 profile](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/contract-reference/measurement-profile.json), [21개 자료 계획](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/contract-reference/quality-specimen-plan.json) | 무엇을 측정해야 하는지, 미측정 값/비활성 플래그, 언어·형태별 자료와 판정 기록 | 실제 입력 제한값/품질·21회 무료 사용 승인·추가 quota·실제 원가. |
| [오프라인 검사 결과](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/contract-reference/validation-results.json) | 이미 존재하는 Ajv로 schema/모든 정의 컴파일·합성25개 유효/무효 입력·FK 키/열/type/계정 귀속·finite money 제약 정적 대조 | 새 dependency 설치, 웹 코드 실행, 실제 DB/파일/로그인/브라우저/AI·호스팅 검증. |

JSON Schema는 앱이 작성한 고정 schema만 컴파일한다. file/provider/client에서 schema나 실행 코드를 받아 적용하지 않는다. object는 `additionalProperties:false`이며 미지원 명령/major/필드를 명시 거부한다. 첫 v1 이후 optional 추가도 version/읽기·쓰기 호환/보존 검증 없이 조용히 적용하지 않는다. semantic 가드는 SREF01~SREF08에 별도로 둔다. [Draft7 원문](https://json-schema.org/draft-07/json-schema-validation)은 구조 검증 근거이며 전체 파일/계정 소유권 보증이 아니다.

## 3. HTTP·화면·현재 권한

명령은 JSON `commandId/intentVersion/target/operation`과 같은 session의 CSRF header를 받는다. 계정은 cookie로 조회한 현재 서버 AppSession에서 얻는다. 편집은 서버가 발급한 owner capability·tab/connection generation·OwnerRevision을 추가 검사하며 raw capability는 HTTPS header에만 전달하고 일반 로그/프로젝트 파일에 넣지 않는다. capability만으로 현재 계정·수명·revision을 생략하지 않는다. 한 탭의 현재 owner channel만 유지하며 채널 중복/복제는 명시 인계 전 보기 전용으로 안내한다.

| 경로·method | 입력 schema → 응답/행동 | 주요 현재 가드 |
| --- | --- | --- |
| POST `/api/v1/auth/attempts`, `/auth/otp/verify`, `/auth/callback/complete` | authAttempt/verifyOtp/completeAuthCallback → commandReply·operationView | 고정 목적·상관관계·실제 증명/allowlist·한 소비. OTP 발송ACK/재처리로 LOGIN 성공을 만들지 않음 |
| POST `/api/v1/auth/bindings/link`, `/auth/bindings/unlink` | linkBinding/unlinkBinding → commandReply | 현재 계정/각 목적 proof·현재 binding 집합/마지막 수단·원자적 unique. 목적 proof로7일 reset 없음 |
| POST `/api/v1/auth/logout-current`, `/auth/logout-all` | logoutCurrent/logoutAll → commandReply | Q55 정상 file gate/current 귀속 또는 Q56 새 CONFIRM_ALL_LOGOUT/손실 확인·전체 철회. closed context≠request safe terminal |
| POST `/api/v1/workspaces`, `/project-files/imports` | createWorkspace/importProjectFile → commandReply·workspaceView | 계정 단일 slot/verified import·현재 만든 계정. 기존 작업 자동 폐기/원장 재생 없음 |
| POST `/api/v1/uploads`, PUT `/uploads/{id}/entries/{candidateId}`, POST `/uploads/{id}/commit` | prepareUpload, 제한 streaming bytes, COMMIT_UPLOAD payload → uploadView/commandReply | staged upload/entry 귀속·bytes/decode·서버 수치 profile·중복/순서/구성/owner/current busy. JSON base64 전체 파일/임의 path 없음 |
| POST `/api/v1/workspaces/{id}/commands`, `/workspaces/{id}/handoffs` | workspaceCommand(HANDOFF 포함) → commandReply | kind별 active/batch/페이지·원 설정/현재 편집 잠금·동일 의도/예상 revision. HANDOFF는 새 탭 현재 auth와 C06의 명시 의도/단절 기한 확인 |
| POST `/api/v1/workspaces/{id}/heartbeat` | ownerHeartbeat → 현재 connection generation/seq·serverTime | 현재 owner/session/channel만 renew. content revision은 heartbeat로 바꾸지 않음·낡은 seq/조회는 renew 불가 |
| GET `/api/v1/me`, `/commands/{id}`, `/workspaces/{id}`, `/workspaces/{id}/pages/{pageId}`, `/operations/{id}`, `/library`, `/ledger` | accountView/commandReply/workspaceView/pageView/operationView/libraryList/ledgerList | 전체 projection은 pageSummary, 활성/인접 페이지의 대사/자산만 별도 hydrate. 현재 접근·계정 귀속·종료/만료·원장 cursor. 철회 후 원 결과 확인은 새 valid LOGIN 뒤 같은 AccountId로 수행 |
| GET `/api/v1/workspaces/{id}/events` | 최소 SSE eventId/참조·revision 알림 → 권위 GET | event replay는 명령이 아니다. 현재 권한/owner와 DB 변경 대조, SSE 유실은 조회 fallback·시계 reset 없음 |
| GET `/api/v1/exports/{id}/content`, `/library/{id}/content`, `/assets/{id}/content` | 권한/목적/기한 확인 뒤 binary stream·attachment 또는 실패 | immutable bytes/hash·필수 entry 전체 성공, 만료/철회/사본 대조. D10 ongoing transfer 중단·수신 bytes 회수 없음 |

`/api/v1`을 생략한 표의 후속 경로도 같은 prefix다. protected JSON/binary는 `Cache-Control:no-store`, 정적 hashed JS/CSS만 immutable cache 후보로 둔다. cookie는 `__Host-trio_web_session`, Secure/HttpOnly/SameSite=Lax/Path=/, Domain 없음이다. cross-origin credential CORS는 초기 제공하지 않고 변경 POST의 Origin/CSRF를 확인한다. OAuth callback은 별도의 state/nonce/issuer 검증 경로로 처리한다. CSP/attachment/nosniff·proxy timeout/헤더/실제 iPad 동작은 RSG02/07에서 확인한다.

HTTP202/ACCEPTED는 접수,200/EXISTING은 원 결과 조회다. 409는 의도/owner/revision/slot 경합,422는 확인된 입력 불가,401/403은 현재 인증/권한 거부,5xx/응답 유실은 원 CommandId 조회 대상이다. 작업/결과/정산/보관·파일 전달 상태는 별개 필드/안내를 유지한다. unknown은 `처리 결과를 확인하고 있어요`, stale snapshot은 `변경된 내용을 저장한 파일이 필요해요`, whole ZIP 실패는 실패 페이지/같은 캡처 재시도, 만료는 새 다운로드/재시도 불가 이유를 안내한다. internal lease/table/provider raw error를 최종 문구로 노출하지 않는다.

새 context는 IN_PROGRESS/빈 pages/settings=NULL로 시작하고 사용자가 지원 가능한 원문/목표·모델/수준/식자 설정을 명시 선택하기 전 AI 요청을 받지 않는다. 목표 언어를 한국어로 고정하거나 원문을 조용히 추정하지 않는다. 복원 파일의 현재 설정은 그대로 보존하되 원 모델/계약의 사용 불가를 별도 표시한다. 업로드는 AI 시작 의도가 아니다. 실제 판매/구매 endpoint는 현재 활성화하지 않고 잔액·원장 조회와 과금 인수 설계만 준비한다.

## 4. 명령 의도·DB 원자적 경계·금액

JSON parse는 duplicate key·유효하지 않은 Unicode/숫자를 먼저 거부한다. schema/semantic 검사 뒤 명령 의도는 version·kind/payload·맥락/대상·예상 owner/content version을 포함한 JCS bytes에 SHA-256을 적용한다. `commandId`, cookie/CSRF/owner capability/전송 header는 의도 본문에서 제외하되 현재 접근은 매번 검사한다. 다른 모델·순서·범위·예상 version은 다른 의도다. 문자열/대사의 Unicode·줄바꿈을 정규화해 뜻을 바꾸지 않는다. [RFC8785](https://www.rfc-editor.org/rfc/rfc8785)는 결정적 직렬화와 큰 정수의 문자열 표현 근거이며 서비스에 자동 멱등성을 주지 않는다.

revision/generation/bytes는 wire에서 10진 문자열·내부 BigInt이며 실제 PG bigint 범위0~9223372036854775807도 semantic 검사한다. money는 지수 없는 Decimal 문자열·`NUMERIC(28,12)`에 대응한다. 금액 계산에 JS float를 사용하지 않고 NaN/Infinity·과도한 정밀도·overflow를 거부한다. [Postgres numeric 원문](https://www.postgresql.org/docs/current/datatype-numeric.html)은 declared scale에서 반올림될 수 있음을 설명한다. 원장 쓰기 전에 versioned 산식의 명시 quantization을 적용하고 round trip 값이 같은지 확인하며 DB의 묵시 반올림에 의존하지 않는다. 판매 환산/표시/상품 값은 현재 미측정이고 D15의 활성화 gate를 따른다.

47개 SQL 설계 기록은 요청·실행·비용·결과·맥락/이력·보관 사실을 구분하는 저장 인계다. 47개 배포 서비스가 필요하다는 의미가 아니며 H02~H04의 해당 subset부터 migration으로 검증한다. account FK만으로 권한을 허가하지 않는다. page/result/application/history/export/library 참조는 가능한 계정/맥락/페이지 복합 키로 제한하고 나머지 의미 의존성도 아래 service transaction에서 검사한다. 실제 role/grant와 SQL 구문·FK/race는 NOT RUN이다.

| DB-only transaction·현재 lock/CAS | 같은 commit의 사실 | 밖에서 처리/금지 행동 |
| --- | --- | --- |
| 계정→binding/session→context/slot→page→request/step/execution→cost/ledger→history/export/store→receipt/work item 순서 | 각 명령이 사용하는 현재 row만 잠그고 조건 재검사·의도 receipt/변경/wake-up 확정 | 이 순서의 deadlock/race는 PG 검증. 외부 OAuth/AI/SMTP/object 호출을 transaction retry 안에 넣지 않음 |
| 새 요청/일괄·새 재시도 접수 | stableAccount/currentContext/page/busy, 원 설정/범위/대상·순서, Request/ActivePageRequest, free/headroom 임시 확보 | retry는 새 CommandId/RequestId·retryOf 원 설정, 호환 성공 checkpoint 읽기 참조. 같은 요청 재개는 기존 ID 유지 |
| 현재 단계 prepare/dispatch authorization | 원 step/current execution·claim/current clock/모든 holds·captured dependency/실행 여력 확인 | 준비/lease 만료≠외부 미실행. 발행 경계·철회/만료 경합을 실제로 입증하기 전 비용 경로 비활성 |
| 첫 실제 시작/성공 증거 대조 | 원 Execution fact, 첫 Request 시작/무료 1회 전환, matching wait round 종료 | 첫 cost stage는 로컬 공정도 포함. 이전/다른 단계 증거로 현재 wait 종료/무료 반환 없음 |
| 결과 적용·수동 편집/이력 | 현재 context/page/result revision·범위, 새로운 immutable result·적용 ID·workspace revision, 유효 history/cursor | 종료된 원 수행의 증거는 보존하되 새 복원 맥락 자동 적용 없음. 수동 수정 외의 AI/제외/import를 Undo로 뒤집지 않음 |
| 비용 정산 | 원 CostItem·확인 비용/단가/basis version·단일 Settlement·실제 잔액/ledger 변경 | unknown은 NULL+명시 상태, 무료 비용도 원 사실 보존. 결과/보관과 별개 첫 정산 가능·같은 비용 중복 차감 없음 |
| 정상 종료/current logout | 최신 file/export/draft barrier/사용자 보관 확인·실제 closed/slot 해제 및 해당 session 철회 | 조회/download click만으로 종료 안 됨. other-session owner context 보존·무효 파일/unknown 처리 성공으로 표시 없음 |
| 전체 logout·새 로그인 | 새 현재 연결 수단 proof/손실 확인·account auth generation/전 session 철회·closed reason/slot | 원 running/unknown/request 잠금·free/cost/hold는 별도. 새 valid LOGIN은 새 권한이며 옛 맥락 부활 없음 |

service role은 API identity/context/명령과 worker 수행/정산/보관의 최소 write를 구분한다. 일반 운영자는 메타데이터/보류 사유/원 evidence 대조만 허용하고 콘텐츠·secret 열람, 원장 직접 수정/무료 복구/unknown 강제성공 권한을 기본 제공하지 않는다. 금전/무료/실행 evidence는 append-only 사실이며 정정은 근거 있는 새 조정 사실로 남긴다. role 분리·필드 권한·로그 canary는 실제 PG/배포 검증 사항이다.

C안의 산식 인터페이스는 `실제AI USD + Σ(실측 image/render/storage 처리량 × versioned USD 단가) + 해당 유료 처리의 공통비 배분`을 원 cost에 연결하고, 검증한 net USD→credit 환산/수익 기준으로 명시 quantization하는 것이다. 각 입력의 단위·버전·측정/evidence와 원 실행 귀속이 필수이며 미확정 입력은 계산 보류다. 무료 운영비는 해당 유료 비용 항목에 전가하지 않는다. 사용자에게 선예상치/선차감을 제공하지 않고 실제 비용 정산과 내부 여력 확보를 구분한다. 구매는 후속의 상품/PG 실수령·확인 webhook/거래 unique·실패/환불/중복 처리 계약이 확정될 때 별도 활성화한다. 현재 실제 SKU/환산율/수익률·총지출 상한은 미정이라 구매·실비 유료 처리 OFF다.

## 5. 파일·자산·연결의 semantic 계약

manifest 페이지 배열이 확정 순서다. 현재 제외 페이지는 내보내지 않고 과거 유효 파일은 새 context에서 그 시점 구성을 복원한다. font bytes/version/hash/license, 각 block의 실제 원 모델/수준/언어/contract는 현재 미래 설정과 별도로 보존한다. 원본/필수 편집 자산은 참조된 entry의 실제 bytes/길이/hash/decode로 대조하고 폰트/영역 좌표·ID/reading order의 중복과 page bounds를 검증한다. geometry/render/cleanup QA와 사용자 값의 provenance를 유지한다. 원 file의 잔액/무료/active request/Undo를 현재 권위로 재생하지 않는다.

파일 누적 baseline은 저장 시점의 확인된 정상 유료 완료분과 contribution ID·미확정 상태/참조를 보존한다. 미정산 참조의 원 request/page/실제 정상 완료 여부는 서비스의 원 사실과 대조하고, 저장 후 다른 맥락에서 발생한 새 처리분을 합치지 않는다. 숫자가 미확정이면 unknown/NULL 또는 부분 기준임을 명시하며 ‘비용0’으로 표시하지 않는다. 현재 페이지 누적 projection은 baseline과 복원한 맥락의 새 정상 완료분을 구분해 계산한다.

업로드 최초 정렬은 `natural-sort-v1`: 표시 basename의 NFC와 ASCII 영문 소문자 비교키를 만들고 ASCII 숫자 token은 leading zero를 제외한 자릿수/문자열로 수치를 비교한다. 수치 동률은 전체 비교키의 Unicode scalar 순서, 다시 같으면 원 입력 ordinal로 정한다. 이 정규화는 정렬키에만 적용하며 원본 bytes/표시 이름·대사·서명 bytes는 바꾸지 않는다. 서버 확정 미리보기/순서 version을 UI와 commit이 공유하고 브라우저 locale/파일 선택 클릭 순서를 권위로 쓰지 않는다.

서명은 `UTF8("trio.manga-project.v1\u0000") || manifestRawBytes`의 Ed25519 detached signature다. envelope/manifest algorithm·keyId 일치, 서비스의 믿는 issuer/catalog/key 상태와 현재 creatorAccount access를 모두 대조한다. 파일의 공개키/URL/AccountId/hash를 신뢰 anchor로 쓰지 않는다. 서명은 암호화가 아니므로 이 평문 파일을 가진 사람은 내용을 읽을 수 있다. 발행키 회전 후 verify-only 공개키/최소 근거 유지, 유출키 보류, 지원 v1/새 major migration·원 bytes 보존을 분리한다. [Node24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)의 sign/verify 지원과 실제 안전한 parser/키 운영은 별도 증거다.

[Render secret file 원문](https://render.com/docs/configure-environment-variables)을 첫 전달 후보로 삼되 실제 계정/비밀 파일을 만들지 않았다. API signer의 제한된 로딩·worker/browser/로그/파일 제외, verifier catalog 백업/회전·키 유출 drill을 RSG03에서 확인한다. 발행 private key와 OAuth/SMTP·R2·limiter HMAC 자격 증명은 별도 secret이며 파일/프롬프트에 포함하지 않는다.

ZIP은 entry 수/중복·경로 정규화/탈출·symlink·압축/확장량/비율·메모리·실제 decode·manifest 한도를 해제 전/중간/후에 검사한다. 선언된 `assets/`, `fonts/`, `licenses/`의 opaque ID entry만 참조하고 임의 외부 URL/원 경로로 보충하지 않는다. 필수 편집 자산 실패는 복원 보류/실패, optional checkpoint만 호환/자산 실패면 편집 상태는 보존하고 재사용 불가를 별도로 안내한다. 원/손상 파일은 덮어쓰거나 삭제하지 않는다.

normal exit는 owner UI가 마지막 mutation ACK까지 초안을 flush하고 `DECLARE_DRAFT_BARRIER → CAPTURE_PROJECT_FILE → 전달 → ATTEST_PROJECT_FILE`로 연결한다. 서비스는 barrier의 owner/content version·mutation receipt/최신 export/hash를 검사하고 새 초안/수정/AI result 적용이 있으면 이전 확인을 무효화한다. client의 ‘미전송 초안 없음’ 선언과 ‘보관했어요’는 사용자의 확인이며, 서비스가 브라우저 내부 초안 부재나 OS 저장을 직접 증명한 것으로 표현하지 않는다. 정산만 바뀐 것은 과거 content snapshot을 바꾸지 않는다.

library store identity는 account+source context+page+immutable result+render digest+목적이다. 같은 성공의 재조회/재요청은 원 성공시각/기한을 유지한다. import baseline 자체를 기존 library 재저장/TTL 연장 신호로 쓰지 않는다. 실제 새 결과 revision의 별도 성공과 과거 만료 record 부활을 구분한다. 늦은 이전 저장은 최신 head를 덮지 못하며 비head/orphan/temp/cache/백업 사본도 각 목적의 실제삭제 대조 대상이다. lifecycle/access403만으로 모든 사본 삭제를 PASS로 표시하지 않는다.

owner heartbeat는 현재 session/owner channel/generation·증가하는 seq만 수락하고 last valid 시간을 저장한다. read-only 조회/SSE 수신·같은 seq 재전송은 renew하지 않는다. 실제 owner channel 단절/철회 확인 또는45초 stale 확인을 DB 사건으로 기록하고 confirmedAt+5분을 저장한다. 아직 살아 있는 다른 channel을 조용히 대신하지 않으며 C05 재접속은 같은 살아 있는 context/원 owner 근거와 원 deadline 안에서, C06 인계는 현재 계정의 명시 의도로 처리한다. 종료/기한 도달 뒤 재개는 거부한다. lease/탐색 주기와 browser suspend/host restart·DB failover/skew 검증은 기한 자체의 연장 근거가 아니다.

## 6. 어댑터·측정 입력·실행 계획

첫 공정은 영역/OCR→번역→cleanup→typeset/canonical raster다. 각 단계에는 원본/crop·영역/좌표/mask·원 설정/계약과 immutable input/output digest, 실제 첫 시작/finish/usage/처리량·checkpoint dependency가 있다. 비용 발생 횟수·서버 resource 상한도 adapter capability/profile에 연결한다. reuse는 소비 의존성이 모두 맞을 때만 읽고 호환성 불명에 새 AI를 자동 실행하지 않는다. 모델/계약 소멸은 Q19의 safe terminal 뒤 기존 재번역 기능으로 안내한다.

| Gate/담당 실행 시점 | 구체 입력·관측 | 통과 판정/미충족 처리 |
| --- | --- | --- |
| RSG01 H02·H03 환경/PG | Node24 exact patch/Fastify5/pg/lockfile·PG18 migration subset·sameclient transaction, FK/race/restart/permission·영구 receipt | 같은 명령1사실/다른 의도 거부·계정/페이지 혼입0·기한/unknown/원장 invariants. 미통과 fake flow까지만·실 권한/비용 활성화 없음 |
| RSG02 H04/H06 인증·기기 | Auth0 정확 tenant/connection/client·OTP 실제 exchange/TTL/limit·fresh proof correlation·Google auth_time/state/nonce·clock skew, 단일owner/복제 탭·absolute7일/두logout | 본인 stable subject/현재접근·한 목적 소비/철회·ownership 우회0. fresh 증거/allowlist/동시 제거/활성 channel 불명은 새 권한 보류. 첫 provider 허용 skew30초는 검증 기준이고 auth_time/이번 attempt·5분창 검사를 생략하지 않음 |
| RSG03 H04 객체/파일 | 합성 v1·raw bytes/signature/catalog·필수/optional·duplicate/ZipSlip/폭탄/폰트/원본 hash·키 회전/유출·30분/30일 및 실제 모든 사본 | 구조/출처/계정/자산·원 bytes/삭제·만료전달 각각 통과. 실제 parser/key/사본 retention 불명이면 해당 import/보관/전달 경로 보류 |
| RSG04 H05 provider/비용 | 정확3.5Flash-Lite generateContent request/Low·Medium·High 매핑/finish reason/usage·권위 조회/멱등 범위·429 미시작 vs unknown·전체 cost bound | 미지원 매핑/부정확 usage/조회/상한은 실행불가. MAX_TOKENS/구조 실패는 확인된 실패·실제 사용 보존, partial을 성공으로 바꾸지 않음. unknown 자동 재발행0·원 모델 유지·발행/철회 경합 미입증이면 실제 비용 OFF |
| RSG05 H05 이미지 품질·한도 | 21계획별 권리/원문/목표 의미·이름/부정/화자·reading order·mask/background·font glyph/linebreak/최소크기·preview/PNG·peak RAM/temp/time/input/output/전체 원가 | 원본 bytes/범위밖 변경0·누락 glyph0·필수자산/PNG 대응0결함. 평가 자료의 주요 의미/읽기순서 실패는 해당 조합 지원대기, 사소한 표현은 별도 검토. 번역 평가는 해당 언어 이해자의 근거가 필요하며 기계 점수만으로 확정하지 않음 |
| RSG06 H05·배포/유료 활성화 | 크기/대사량 단계 증가 N-1/N/N+1·페이지/총bytes/해제/ratio/시간·기기/host reserve, C안 Decimal/단가 version·worker/storage/auth/mail/공통비/PG 실수령 | 안정 측정 최대값에서 명시 여유·host/기기 경계를 적용해 profile을 확정. SKU/환산/판매/유료조건·총지출 범위 없으면 해당 경로 OFF. profile 없음을 무제한/0으로 치환하지 않음 |
| RSG07 H06 전체 흐름·운영 | Windows Chrome/Edge·Android Chrome·iPad Safari의 실제 version/device, 키보드·터치·두탭·파일 보관/복원·설정/ZIP/library·재시작/복구 drills | 지원 matrix에 정확 version/device·결과를 기록. fake/PG/protocol/host/browser/실 provider·release 증거를 분리하고 미확보 환경은 NOT RUN·지원 미검증 |

상한 실험은 작은 권리/합성 이미지부터 width/height·파일수/bytes·대사/영역수·최대 번역량을 하나씩 증가시키며 CPU/peak RAM/temp/처리시간/파일 정확성과 원가를 기록한다. 첫 내부 운영 목표는 지출 승인 범위·복구 drill에서 실제 중단/RPO/RTO/삭제를 측정하고 수치 SLO를 꾸미지 않는 것이다. safe 실패/사본 삭제 불명에는 새 실행/접근을 보류하고 메타데이터 경보를 남긴다. 복구로 clock·session7일·receipt·무료/원장·과거 library 만료를 되돌리거나 무효 context를 살리지 않는다.

## 7. 추가 검증 설계 — 제품 실행 모두 NOT RUN

| ID | 입력/사건 | 기대 결과·관측 |
| --- | --- | --- |
| SREF01 | counter 2^53+1/PG bigint 초과·NaN/Infinity·12자리 초과/roundtrip·같은 CommandId 다른 모델/순서 | 정밀도/의도 유지 또는 명시 거부. 단위·version/원장 변화 대조·0 치환/묵시 반올림 없음 |
| SREF02 | 타 계정/다른 context/page의 request/result/history/export/store 참조와 동시 슬롯/정산 | composite FK/current guard·한 원 fact/ledger, orphan 적용/이력/최신 head 혼입0. 실제 PG 오류/row/CAS 관측 |
| SREF03 | schema 통과하나 font/asset 누락·bounds/방향/duplicate·잘못된 날짜·raw manifest 변경/다른 key | semantic/출처/필수 validation에서 거부/보류. optional-only 실패는 편집/재개 구별. 구조 PASS를 파일 성공으로 사용하지 않음 |
| SREF04 | iframe/cross-origin cookie 명령·같은 계정의 read-only/복제 channel·낡은 capability/seq | 현재 Origin/CSRF/session/owner·channel 한도/명시 인계. 조회/중복 HB로45초/5분/7일 renew 없음 |
| SREF05 | 45초 stale·확인 후5분/공급사10분 경계·탐색 지연·DB 후퇴/접근불가·worker kill/lease expiry | 서비스 현재 회차/deadline 먼저 검사·원 실제 수행 보존/새 발행 보류. timer/host 복구로 기한 reset/unknown 재호출 없음 |
| SREF06 | file 캡처 후 새 수동 초안/AI 결과·정산만 변경·attestation 다른 snapshot·current/all logout | content snapshot/owner/barrier와 현 proof를 구분. 최신 파일 필요 또는 정산 독립, 정상/전체 종료 사유·slot/request/hold 각각 대조 |
| SREF07 | old-file import baseline/같은 성공 보관 재요청·옛 저장 late success·30일 경계 ongoing stream·복구 사본 | 새 context/기존 기한 분리·자동 TTL reset/만료 부활/old head 덮기 없음. 실제 전달 중단/모든 사본 삭제는 개별 검증 |
| SREF08 | 미측정 profile·미지원 model 수준/MAX_TOKENS·원가 bound 불명·cleanup mask 밖 변경·glyph 누락 | 모델 대체/부분 성공/새 무료 없음, 기존 편집 값·원 비용 보존. 지원/비용/실제 입력 활성화 보류·언어/자원별 근거 |

기존 S/APV/SEC/AUTHV/FILEV/PGV/EOV/ASV/FAV/HOV/RSG를 대체하지 않고 해당 위험에 연결한다. 현재 오프라인 schema/구조 검사는 `validation-results.json`의 범위만 확인했다. SREF01~08의 실제 제품/DB/브라우저/외부 시스템 인수 실행은 NOT RUN이다.

## 8. 첫 구현 흐름과 다음 단계

예정 root `C:/Users/ksaei/Documents/Codex/trio-manga-web`에서 [추천 인계7절](2026-10-03-manga-web-recommended-selections-and-handoff.md#7-새-웹-프로젝트의-파일명령순서-인계)의 파일 구조를 사용한다. 현재 root를 생성/설치/초기화하지 않았다. 실제 구현 요청 후 해당 workspace의 지침·기존 파일/권한을 먼저 확인하고 본 설계의 schema/SQL을 실제 contracts/migration으로 옮기며 정확 patch/lockfile/실제 npm scripts를 기록한다. 별도 웹 repo에 현재 Trio의 dirty 작업을 이동/초기화하지 않는다.

첫 구현 I-A는 H02/H03의 **합성 한 계정·한 페이지·두 fake 단계**다. 요청/실제 시작/무료1회·비용/결과/정산을 만들고5분/10분·응답유실·worker 재시작·동일 명령/unknown·late result·안전종결의 부작용을 먼저 검증한다. 그 뒤 H04의 파일/owner/두logout, H05의 승인된 실제 공정·font/품질·상한/원가, H06의 로그인/페이지 묶음/수동편집/ZIP/library·선택 기기 전체 흐름으로 이어간다. I-A 완료는 Q23-A 전체 제품 완료가 아니다.

각 작업은 인수 실패/기대값 확인→해당 파일 구현→관련 domain/PG/protocol/browser 검증→diff/독립 검토를 거친다. 계정·provider·키·host·유료/자료 전송은 그 단계의 실제 gate/명시 실행 범위 안에서만 진행한다. 새 scripts는 실제 package.json에 존재함을 확인한 뒤 `npm.cmd run typecheck/lint/test:domain/test:postgres/test:protocol/test:browser/build` 중 변경 위험에 맞는 것을 선택한다. fake PASS를 실서비스/번역 품질·패키징/출시 PASS로 올리지 않는다.

이 설계 원본과 선정 기록을 G01~G08의 준비 기준에 대조한 최종 결과는 준비 명세의 최신 절/기존 플랜에 기록한다. architect 호출 한도로 Q52~Q57·D01~D20/이 schema·DDL의 최종 독립 검토는 미완료이며, 사용자의 계속 진행 지시에 따라 메인의 내용·참조 검사를 수행한다. 제품 구현/실측이 남았다는 사실과 준비 문서의 작성 상태를 구분한다.
