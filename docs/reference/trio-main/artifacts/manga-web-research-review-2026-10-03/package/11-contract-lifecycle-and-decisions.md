# 계약 보충 — lifecycle, 진행률, worker 선택

전부 **PROPOSED**이며 실제 서비스 내부 구조나 배포된 시스템을 뜻하지 않는다. [SQL](schema.sql), [OpenAPI](api.openapi.yaml), [설계](07-production-blueprint.md)의 해석과 후속 구현 gate를 고정한다.

## 1. 테이블과 lifecycle

SQL의 각 table에는 column/type/PK가 있고 관계가 있는 경우 FK, unique/index를 명시했다. 원문 명칭 `credit_transactions`는 append-only `credit_ledger`, `text_regions`는 `translation_regions`로 대응한다. OCR/translation 원본 결과와 사용자 수정 revision을 분리했다. 아래 보존일은 제안이며 법정 보존·지역 규정이 확정되면 정책 버전을 고정해야 한다.

| Table | 역할 / lifecycle |
|---|---|
| tenants | 조직 경계. active→suspended→deleted soft-delete; financial 참조가 있으면 cascade hard-delete 금지 |
| users | 계정. 탈퇴 후 법적 보존 사유가 없는 email/display name 가명화 |
| memberships | 사용자·tenant·role. 탈퇴/역할 회수 즉시 권한 취소 |
| oidc_identities | issuer+subject unique. unlink/탈퇴 후 삭제; token 저장 안 함 |
| sessions | refresh hash/generation/expiry/revocation. 30일 상한 예시, rotation 재사용이면 family revoke; 만료 후 7일 cleanup |
| plans | 가격·quota snapshot. 과거 plan 수정 대신 새 code/version, 참조 중 삭제 금지 |
| subscriptions | provider 상태 projection. 종료 상태 보존·정합성 재조회 |
| credit_accounts | ledger의 materialized 잔액. ledger와 주기적 대조, 직접 임의 수정 금지 |
| uploads | presign→completed/quarantined/deleted. 미완료 24h 정리, 원본 기본 7일 |
| upload_parts | multipart ETag/size. complete/abort 후 24h metadata 정리 |
| model_versions | revision/config/provenance. job 참조 중 보존, active flag로 선택 제한 |
| translation_jobs | immutable config/input + 상태. 결과 보존기간과 함께 관리; 비용 원장은 별도 보존 |
| job_stages | page별 stage 상태. `(job,stage,page)` NULLS NOT DISTINCT unique; terminal 이력 보존 |
| stage_leases | 현재 worker/fencing/expiry. reclaim 때 token 증가, stage terminal 후 제거 가능 |
| job_cancellations | cancel 요청 주체·시점·관찰 결과. terminal job과 함께 보존 |
| artifacts | hash/private key/type/expiry. object 삭제 확인 후 tombstone; orphan sweeper 필요 |
| translation_regions | stable region ID와 current revision. page/job 기간 동안 보존 |
| region_revisions | geometry/text/manual edits immutable history. current/parent는 동일 region FK |
| context_sessions | page/chapter/volume/series scope. reset generation 증가, 관련 job 범위로 보존 |
| context_items | 정렬된 원문/번역/힌트. reset 때 이전 generation 조회 차단; 보존기한 후 삭제 |
| glossaries | tenant 용어집. 사용자 명시 삭제/탈퇴 처리 |
| glossary_entries | source→target unique. 수정은 미래 job에만 적용하고 기존 job snapshot 유지 |
| idempotency_keys | request hash+response metadata. 24h TTL, secret response는 저장 금지 |
| credit_ledger | grant/debit/refund/expire/adjustment 불변 이벤트. 법정/정산 보존기간, 가명화 적용 |
| credit_reservations | active→settled/released. 미확정 provider 비용은 reconciliation까지 유지·운영 알림 |
| outbox_events | DB commit 뒤 적어도 한 번 전송. 완료 후 7일 보존 예시, consumer dedupe 필수 |
| webhook_events | 서명 확인된 receipt 불변. payload는 필요한 billing 필드만 보존하고 PII 최소화; 인증 서명 자체는 저장 안 함 |
| webhook_processing | pending/processed/failed와 retry. receipt와 분리; effects+processed 같은 transaction |
| api_keys | prefix/hash/scopes/revocation. secret 1회 응답, revoke 즉시 효력; 만료·회전 정책 |
| usage_events | stage/provider usage. billing reconciliation 기간 후 원문 없는 집계로 축약 |
| audit_events | 권한/금전/삭제 감사 불변. 보존 정책별 가명화, secret·image·OCR text 금지 |
| documents | source upload와 format/title/revision. 페이지 묶음, soft-delete 후 artifact lifecycle |
| pages | document 내 순서와 extraction 상태. 실패 page도 manifest에 유지 |
| images | original/normalized pixel size·좌표변환과 artifact. binary는 object storage |
| ocr_results | 모델 revision/input hash별 OCR 원본. 수동 수정은 region revision에 별도 저장 |
| translations | region revision/model/prompt/input hash별 결과. 원문 job 수명과 동일 |
| payment_events | provider receipt와 연결한 paid/refunded/disputed 불변 이벤트. 금액 minor unit+currency; 법정 보존 |

별도 connection role은 migration/admin, API, worker, billing으로 분리한다. `users/tenants/oidc_identities/plans/model_versions` 같은 global table은 자동으로 tenant RLS가 해결하지 않는다. 조회 view·명시적 권한과 server membership 검증이 필수다. CREATE TABLE 스크립트가 이러한 운영 role을 이미 배포한 것은 아니다.

page/job/document/region의 같은 tenant FK는 SQL에 있지만 **같은 document와 job upload의 일치**, page index와 manifest 일치, creator membership, stage별 의존성은 application transaction에서 추가 검증한다. migration integration test에 cross-tenant와 same-tenant/wrong-document 사례를 모두 넣는다. 원문 결과와 revision 삭제 순서는 순환 FK를 고려한 retention worker로 구현한다.

## 2. Polling / SSE / WebSocket 결정

| 방식 | 장점 | 비용·제약 | 선택 |
|---|---|---|---|
| Polling | 재접속·모바일·proxy 단순, 상태 GET이 권위 기록 | 빈 요청, 갱신 지연 | MVP 기본: 1→2→5초 backoff+jitter, background 15초, terminal 중단 |
| SSE | batch의 서버→client 진행률에 적합, event cursor 재연결 | proxy timeout, connection 수, 단방향 | Production 기본 알림, GET status fallback |
| WebSocket | 양방향 협업/실시간 편집 | auth/reconnect/state 관리 복잡 | 동시 협업 필요성이 입증될 때만 |

`GET /v1/jobs/{jobId}/events`는 SSE hint이며 `GET /status`가 권위 상태다. event_id 단조 증가, Last-Event-ID 지원, 15초 heartbeat, 24h replay window 예시, cursor 만료 시 reset→GET snapshot. `completed_units/total_units`, page/stage를 전송하고 LLM의 알 수 없는 시간을 가짜 percent로 보이지 않는다. terminal 이후 late event는 revision/generation 검증으로 무시한다. native EventSource에 bearer header를 넣기 어려우므로 same-origin secure session 또는 header 가능한 fetch stream을 사용하며 URL query에 token을 넣지 않는다.

## 3. Queue 후보와 단계 배치

| 후보 | 적합성 | 도입 조건 |
|---|---|---|
| Celery+Redis | Python ML worker와 작은 팀 MVP에 적합 | DB outbox/lease/fencing로 전달 중복·broker 손실 대응 |
| BullMQ | TypeScript control plane에 자연스러움 | Python inference와 경계를 추가해야 함; 현재 안의 이점 적음 |
| SQS | managed delivery/visibility/DLQ | cloud 선택 후 Redis broker 운영 부담이 커질 때 |
| Cloud Tasks | HTTP task scheduling/rate limit | GCP 고정이며 stage runtime 제한이 맞을 때 |
| Temporal | 장시간 workflow/replay/compensation | 복잡한 workflow와 운영 인력이 비용을 정당화할 때 |

MVP는 Python worker의 논리 queue를 `cpu`, `gpu_ocr`, `translation`, `gpu_inpaint`, `render_export`로 구분하되 첫 배포에서 각각 독립 서비스 수를 늘릴 필요는 없다. detector/OCR은 동일 GPU process에서 model warm reuse, order/context는 DB/CPU, translator는 provider RPM/TPM limiter, mask는 CPU, complex inpaint는 GPU, renderer/export는 memory-bound CPU pool이다. GPU 동시성은 초기 1/model worker 후 VRAM benchmark로 증가한다. CPU는 memory cap과 core 수 중 더 낮은 한계로 정한다.

autoscaling은 queue depth만 아니라 oldest ready job age, stage service time, GPU utilization/VRAM, provider budget을 함께 본다. pending context dependency는 ready queue에 넣지 않아 비어 있는 GPU가 dependency blocked job을 잡지 않게 한다. tenant별 공정 queue와 최대 concurrent job을 적용한다. scale-to-zero cold start는 사용자에게 표시하고 warm pool 비용을 계산한다.

## 4. Object key와 삭제 계약

`tenant/{tenant_id}/job/{job_id}/{original|normalized|masks|inpainted|rendered|exports|temporary}/{artifact_id}`를 사용하고 원래 파일명·email·OCR text를 key에 넣지 않는다. DB에 SHA-256·size·media type·expiry를 보관한다. private CDN은 authorization 후 short signed URL만 제공하고 cache key가 tenant object path를 보존하도록 한다. 전역 content hash만으로 tenant 간 이미지를 공유하지 않는다.

original/result 기본 7일, intermediate 24h, temporary 1h를 초기 정책으로 제안한다. 삭제는 권한 차단/URL 만료→delete intent→object 확인→metadata tombstone→backup 보관 만료 순이다. signed URL을 이미 발급하면 만료 전 회수에 별도 proxy 검사가 필요하므로 5분 이하 TTL을 사용한다. tenant 탈퇴 시 이미지 삭제와 financial/audit 보관은 분리한다.

## 5. API 공통 규칙과 stage 재실행

OpenAPI 각 사용자 operation은 tenant scope, 401/403/429와 rate policy를 가진다. write는 tenant-scoped idempotency key+request hash(24h), DTO 검증 오류 422, 변경된 key payload 409다. MVP 제안 quota는 read 60/min, write 10/min, job 3 concurrent, SSE 3 streams이며 실제 provider/plan에 맞춰 조정한다. server byte cap 20MiB, raster 25MP를 decode 전후 검증한다. PDF/ZIP 전체에는 별도 archive aggregate cap을 적용한다.

예시의 `/ocr`, `/translations`, `/inpaint`, `/typeset` 네 가지 동기 endpoint 대신 `/jobs/{id}/reruns`의 stage enum으로 같은 안전 계약을 재사용한다. 예상 region revision 불일치는 409, 실행은 새 immutable job, 영향받는 downstream stage만 재계산, 필요한 비용만 예약한다. OCR 재실행은 수동 번역을 덮어쓰지 않고 새 revision 검수로 제시한다. upload, job, stage, credit 권한은 UI 버튼 상태가 아니라 서버에서 검증한다.

API key 발급은 secret을 최초 응답에서만 보여준다. idempotency replay에는 metadata만 응답한다. 최초 응답이 유실되면 해당 key를 revoke 후 새 key를 발급하며 평문 secret을 보관해 재응답하지 않는다. 구현 전에 client가 이 동작을 명시적으로 처리해야 한다.

## 6. 최소 비교표 — 실제 / 공통점 / 차이 / 독립 선택

| Component | Torii Actual | Ichigo Actual | Similarity | Difference | My Implementation |
|---|---|---|---|---|---|
| Acquire | Canvas/Blob, CORS fallback | Canvas/base64, panel capture | 페이지 이미지 취득 | request 형식·fallback 공개 정도 | optional host+selected crop |
| OCR | 자체 engine 개발자 진술 | provider UNKNOWN | 글자 인식 제품 기능 | intermediate/API 공개 차이 | benchmarked replaceable OCR |
| Context | chained context API | volume/full-context 광고 | 페이지 간 문맥 목표 | 계약 공개 vs 내부 UNKNOWN | ordered session+budget+reset |
| Inpaint | optimized LaMa 진술 | 모델 UNKNOWN, 제거 출력 관찰 | 글자 제거 | 모델 근거 유무 | flat fill+LaMa 후보 |
| Render | Pillow 진술+typeset API | renderer UNKNOWN, 결과 JPG | 이미지 식자 | geometry/editor 노출 | measured Pillow+revision |
| Billing | credits/BYOK | quota/subscription | 유료 사용량 관리 | 계량 표면 | reservation+ledger+inbox |
| Data | Firebase/Firestore/GCS 고지 | backend store UNKNOWN | 저장이 필요한 서비스 표면 | 공개 근거 깊이 | Postgres+private object store |

| Component | Torii Evidence | Ichigo Evidence | Confidence |
|---|---|---|---|
| Acquire | 공식 XPI path | 공식 XPI path | 배포 code CONFIRMED, extension runtime 미검증 |
| OCR | T-205, T-214 | I-014/I-018, I-302 | Torii 진술/출력 CONFIRMED, 양쪽 정확한 model UNKNOWN |
| Context | T-010/T-210/T-211 | I-006/I-200 | 기능/진술 CONFIRMED; Ichigo 내부 state UNKNOWN |
| Inpaint | T-206 | I-302 | Torii 진술 CONFIRMED; Ichigo 모델 UNKNOWN |
| Render | T-207/T-009 | I-302 | 출력 CONFIRMED, Ichigo library UNKNOWN |
| Billing | T-201/T-213 | I-300/I-036 | UI·진술 CONFIRMED, 내부 transaction UNKNOWN |
| Data | T-025 | I-110 capability만 | Torii 고지 CONFIRMED; Ichigo store UNKNOWN |

세부 23개 head-to-head 항목과 24개 technology 선택 행은 [전체 비교](06-service-architecture-comparison.md)에서 유지한다.
