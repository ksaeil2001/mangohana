# 만화 웹 서비스의 추천 선정과 구현 인계 상세

작성일: 2026-10-03. 상태: **사용자 위임 D01~D20의 상세 설계 선정·구현 전 인계 작성 완료 / 제품 구현·후속 실측 NOT RUN / 최종 독립 검토 미완료**.

사용자는 실제 Q55~Q57의 추천안을 수락하고 이후 남은 선택도 추천대로 진행하되 어떤 답인지 모두 문서화하라고 지시했다. 직접 질문/답의 원본은 [Domain Story59.20~21](../../manga-translation-domain-story.md#5920-실제-로그아웃-저장전체-종료-확인호스팅-우선-질문--추천안-수락)이다. 아래 D01~D20은 **후속 위임에 따른 설계 선정**이며 사용자가 Q58 이후에 직접 답했다는 기록이 아니다. 기존 확정 정책을 변경하지 않고, 실제 지원/가격·품질·한도/원가 PASS와 기술 선정을 구분한다.

이 문서는 기존 [준비 명세](2026-10-03-manga-web-preimplementation-readiness.md) G01~G08의 남은 입력과 [실행 설계](2026-10-03-manga-web-postgres-execution-design.md), [편집/출력/파일](2026-10-03-manga-web-edit-output-file-design.md), [인증/세션](2026-10-03-manga-web-auth-session-design.md)을 잇는다. 업무 규칙은 Domain Story, 진행·완료 경계는 [기존 플랜9절](../plans/2026-10-02-manga-web-workspace-contracts-and-validation-plan.md)을 따른다. 새 저장소·계정·설치·제품 코드·외부 설정·유료 실행/배포를 만들지 않는다.

## 1. 어떤 답을 선택했는지와 이유

| ID · 남은 설계 항목 | 위임에 따라 선정한 답 | 추천 이유·대안/조건 |
| --- | --- | --- |
| D01 런타임/API/DB 접근 | Node24 LTS 계열·Fastify5·앱이 작성한 JSON Schema Draft7·node-postgres(pg)와 SQL migration을 첫 기준으로 선정 | TypeScript API/worker와 명시 transaction/권한 검사에 맞춘다. ORM/Next 전환은 필수 이점이 확인될 때 재평가한다. 정확한 patch/의존성 버전은 새 프로젝트 설치 직전 호환/보안 확인과 lockfile로 고정하며 지금 설치하지 않는다. |
| D02 호스팅 상세 기준 | Render 유료 API/별도 worker·관리형 PG18, 같은 Singapore 지역을 첫 적합성 검증 기준으로 선정 | Q57-A의 운영 플랫폼 우선과 DB 운영 부담을 함께 줄이는 후보다. Railway는 PG 관리 책임/실사용 견적을 명시한 대안이다. 한국 이용자의 지연은 추론이며 미측정이다. 최종 구매 사양·월예산/실계정/지출 승인은 아니다. |
| D03 공유 객체 저장 | private Cloudflare R2를 첫 비교/적합성 검증 후보로 선정, API/worker가 같은 자산 참조를 사용 | 한 서비스 로컬 디스크보다 공유 자산 책임을 분명히 한다. R2 lifecycle만으로 실제30일 삭제를 보장하지 않는다. 실제 사본/복구 보존·삭제 적합성/전송비·지역 제약을 확인하기 전 활성화하지 않는다. |
| D04 세션/브라우저 통신 | 서버의 opaque app-session cookie, REST 명령/조회와 SSE 변경 알림·조회 fallback을 첫 설계로 선정 | DB가 권위이고 알림은 wake-up이다. browser token/localStorage를 권한 원본으로 두지 않는다. cookie는 Secure/HttpOnly/SameSite=Lax/Path=/, Domain 없이 구성하며 세션 내 CSRF token과 Origin 검사, 별도 OAuth state/nonce를 검증한다. D16으로 같은origin Node API의Vite build제공을첫기준으로정했고actualcookie/CSRF/channel·브라우저검증은후속이다. |
| D05 새 proof와 OTP 앱 제한 | 목적별 AuthAttempt·5분 앱 evidence 유효창·한 번 소비, OTP 발송 재요청 60초/attempt당 오입력5회·계정/수단/IP별 추가 limiter를 초기 검증 정책으로 선정 | 무한 재발급/동시 소비를 막고 CONFIRM_LINK/UNLINK/ALL_LOGOUT을 LOGIN과 구분한다. provider 코드 길이/수명·발송/시도 제한은 실제 Auth0 설정과 함께 더 엄격한 조건을 적용한다. 이5분은 워크스페이스 단절5분 시계와 별개이며 시도 만료만으로 맥락을 종료하지 않는다. |
| D06 파일 container/출처 | `.manga-project.zip` v1, 정확한 UTF-8 manifest bytes+목적 prefix의 detached Ed25519 서명, SHA-256/bytesLength 자산 대조로 선정 | 이미 작성한 OUTPUT6 후보를 구체화한다. 서비스 verifier catalog·현재 만든 계정 접근이 권위다. 파일 내 공개키/URL/AccountId/hash만으로 출처/소유권을 인정하지 않는다. `.ctp` 호환 약속이나 암호화 효과는 없다. |
| D07 로컬 파일 기밀성과 키 운영 | 첫 파일은 평문 container, 서비스 발행 private key는 별도 비밀 저장/제한된 signer만 접근, verifier catalog/지원 형식 동안 최소 공개 검증 근거 유지 | 복원/출처 검사와 파일 암호화를 분리한다. 파일을 가진 사람은 로컬 내용을 읽을 수 있고 타 계정의 앱 복원은 거부한다. 개인키 정상 회전과 과거 검증키 유지, 유출 키의 보류·사고 복구는 별도 상태로 관리한다. 백업/복구와 실제 secret host는 설정 전 검증한다. |
| D08 ZIP/파일 이름·캡처 수명 | ZIP entry는 확정 순서 `0001.png`부터, 순번 폭은 max(4,최종개수 자릿수). ExportSnapshot 재시도창은 생성부터30분 및 원 live 맥락/권한 유효 기간의 교집합 | 파일명 충돌/경로와 이전/새 캡처 혼합을 줄인다. PNG 압축6을 첫 측정값으로 쓰고 품질은 바꾸지 않는다. 만료 입력으로 같은 캡처 재시도를 허용하지 않고 새 캡처를 안내한다. 새 AI/무료 사용을 만들지 않는다. |
| D09 보관 실패 재시도 | 저장-only 작업은 최초1회+5초/30초 후 각1회, 총3회로 선정. 이후 유효 결과의 명시 재요청은 같은 보관 의도의 새 retry group | 같은 명령/worker 재가동으로 시도 수/원 성공 시각을 초기화하지 않는다. 실제 저장 성공 후 동일 page/result/render의 성공은 조회하며 TTL 연장용 재저장을 하지 않는다. 원 미정산 비용 최초 정산은 독립이다. |
| D10 라이브러리 만료 중 전달 | OB09는 기한 도달 때 새/재다운로드와 진행 중 전달도 중단하는 방향으로 선정 | 실제30일 삭제와 유한한 접근을 맞춘다. 이미 로컬에 받은 bytes는 회수하지 않는다. 일부 다운로드 실패를 완전한 파일로 표시하지 않는다. gateway chunk/기한 대조가 필요한 계약이며 presigned URL 만료만으로 진행 중 전달 취소를 보장하지 않는다. |
| D11 운영 기록/콘텐츠 접근 | 운영 로그는 원문/이미지/토큰/메일을 제외한 메타데이터30일, 오류 trace7일. 최소 명령 tombstone·발행 verifier·원장/무료 facts는 별도 목적, unresolved 사실은 해결 전 보존 | 콘텐츠 지원 열람은 초기 기본 권한에 포함하지 않는다. 완료 로그 정리로 중복 호출/파일/현재 원장 증거를 잃지 않는다. 계정 폐쇄·대중 출시/법정 결제 기록의 기간은 후속 출시 계약이며 현재 임의 기간/자동 계정 삭제를 도입하지 않는다. |
| D12 첫 이미지 공정 평가 | Gemini `gemini-3.5-flash-lite` generateContent의 OCR/구조 추출·번역을 첫 비교 기준, cleanup은 LaMa 계열의 별도 격리 공정 후보, typeset은 sharp 기반 canonical raster/동일 preview·PNG export로 선정 | 기존 작은 입력 관측과 연구의 영역/단계 의존성에 이어 평가한다. 상용 만화 품질/geometry·모델별 수준/사용량/조회·weights 출처/호환/메모리·mask QA는 미검증. 옛2.5 모델 접근이나 자동 fallback을 전제하지 않는다. 실제 새 비용/외부 전송 활성화 전에 전체 공정 상한/허용 자료를 검증한다. |
| D13 첫 폰트/레이아웃 | 서비스 제공 Noto Sans CJK KR/JP/SC+해당 Latin glyph를 첫 평가 기준, font bytes/version/hash와 저작권·OFL을 container/렌더에 연결 | 영어/한국어/일본어/간체 평가를 함께 준비한다. OS 대체 폰트에 기대지 않는다. 세로/회전/글자 넘침·줄바꿈은 renderer 실제 계약/자료 평가로 통과해야 한다. 사용자 폰트 업로드/새 수동 도구로 확대하지 않는다. |
| D14 품질/수치 산정 | 첫7번역 방향 각각 단순/세로·혼합/밀집 3유형, 최소21개 합성·권리 확인 자료의 평가표부터 준비. 안전/무결성은 위반0, 언어 품질은 항목별 판정 후 지원 조합 활성화 | 자료 계획은 실제21회 앱 무료 사용 승인/추가 무료 할당이 아니다. 언어/형태별 오류·peak RAM/CPU/temp/원가를 기록하고 한도는 측정 여유와 기기/host 경계를 적용한다. 어려운 배경/읽기 순서 실패를 평균값으로 숨기지 않는다. |
| D15 판매·예산·잔액 활성화 | 현재 내부 테스트 범위에서 실제 구매/상용 유료 호출은 비활성, C안 원가/상한·환산/상품/PG/손실 방지 검증 뒤 별도 실행 단계로 선정 | 크레딧 표시나 실제 비용 기록은 보존한다. 가격표의 $20 compute 등을 새 지출 상한/서비스 가격으로 꾸미지 않는다. 무료 공급사 API 관측도 전체 공정 원가0을 뜻하지 않는다. 미확정 값은 NULL/보류이며 처리 전 예상 크레딧·선차감/자동 유료 전환 없음이다. |
| D16 화면/API 배치 | 같은origin Node API+Vite 공개build·server session/currentowner channel | 초기통신/CSRF 책임을좁힌다. 별도CDN/cross-origin은측정/검증후대안. 상세는[최종 인계](2026-10-03-manga-web-contract-reference.md)1/3절. |
| D17 typed 의도/저장 | Draft7 명령22종/파일schema·JCS 의도·bigint/Decimal 문자열·47기록복합참조/JSON256KiB | 무결성·재전송/계정귀속을보존한다. actualmigration/DB/파서PASS아님. 최종인계2~5절. |
| D18 연결/claim | owner HB15초/45초stale 확인시각+원5분·탐색5초/lease30초/renew10초 | 초기실험값이며read-only/낡은seq/hostrestart로기한reset없음. actualchannel/clock/발행race는검증. 최종인계5~7절. |
| D19 측정/활성화 | 필수profile 미측정NULL/관련경로OFF·언어/형태/자원/원가별판정 | 임의한도/원가0/추가무료 없음. 실제RSG01~07을통과한지원/값만활성화. 최종인계6절. |
| D20 bootstrap/키/root·시작 | 검증subject/AccountId allowlist·API signer secret file 검증후보·별도예정Codex/trio-manga-web·진행중/빈페이지/설정명시선택 | 이메일자동등록/콘텐츠지원·worker개인키없음. actualroot/계정/설정미생성. 최종인계1/3/4/8절. |

D05/D08/D09/D11의 숫자는 **위임으로 고른 초기 정책/검증 기준**이며 실측 최적값이 아니다. 기존 Q13=5분/Q14=10분/Q39=7일/Q34=실제 저장30일을 바꾸거나 reset하지 않는다. 이미지 bytes/픽셀/페이지수·압축 폭탄/폰트 최소 크기·AI 전체 비용은 기존 답대로 자료 측정 뒤 확정하며 미정 상태로 활성화하지 않는다.

## 2. 공식 근거와 확인 범위

조회일은 2026-10-03이다. 아래는 관련 부분의 문서 확인이며 전체 문서/서비스 실행을 다 검증했다는 뜻이 아니다.

| 항목 | 공식 원출처·확인한 설명 | 우리 선정과 실제 검증의 차이 |
| --- | --- | --- |
| runtime | [Node 릴리스](https://nodejs.org/en/about/previous-releases)는24를 LTS로 표시하고 production에는 LTS 사용을 안내한다. [Fastify5 안내](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/), [validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)은 JSON Schema 기반·앱 schema의 코드 취급/비동기 DB 검사의 분리를 안내한다. | Node24·Fastify5 선정. 파일/provider가 보낸 JSON schema를 컴파일하거나 initial validation에서 DB를 호출하지 않는다. 실제 dependency 조합/build는 NOT RUN. |
| transaction | [node-postgres transaction](https://node-postgres.com/features/transactions)은 같은 client로 BEGIN/COMMIT/ROLLBACK을 실행해야 한다고 명시한다. | pg client를 명시 소유. pool.query로 여러 connection을 섞는 transaction 금지, 외부 호출/DB retry 분리·race는 PGV로 검증. |
| host/PG | [Render 지역](https://render.com/docs/regions)은 Singapore와 지역별 private network, 기존 서비스 지역 변경의 migration 필요를 안내한다. [PG 생성](https://render.com/docs/postgresql-creating-connecting)은18 지원과 같은 지역 연결을 안내한다. 가격/대안은 [기존 비교](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/hosting-primary-comparison.md)를 따른다. | 첫 상세 기준이며 실제 resource·private network/latency·backup/restore·spend는 미확인. |
| object | [R2 pricing](https://developers.cloudflare.com/r2/pricing/)은 Standard $0.015/GB-month와 operations 비용·egress 조건을 안내한다. [lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) 삭제는 보통 expiration 뒤24시간 안이며 더 늦을 수 있다. | DB deadline/삭제 실행·객체 대조/사본 범위 검증을 별도로 설계. lifecycle만으로 정각 실제 삭제/모든 사본 제거 PASS를 기록하지 않는다. |
| AI | [3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)는 안정 model ID, 이미지 입력/텍스트 출력·structured outputs/thinking을 안내한다. [2.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite)는 기존 사용자를 중심으로 접근을 제한하고 새 프로젝트에는 최신 모델을 안내한다. | 기존 REPORT/DS50~51의6+12관측은 그 작은 입력/계정/endpoint에 한정. Low/Medium/High의 실제 payload·finish/usage/전체 상한/조회는 같은 어댑터 version에서 재확인하며 불명이면 조합 활성화 보류. 2.5/3.8로 자동 대체하지 않는다. |
| image | [LaMa 원저자 repo](https://github.com/advimman/lama)는 이미지/마스크 입력·CPU/container 공정과 과거 배포 링크 문제를 안내한다. [sharp text](https://sharp.pixelplumbing.com/api-constructor/)는 fontfile/width/wrap 등 text raster 설정을 설명한다. | weights의 믿는 출처/hash·조건/실행 환경은 설치 전 확인. 서버 canonical raster를 browser에 보여 preview/export 일치를 검사한다. 모델 품질 순위·CPU 메모리 충분함/모든 세로 식자 지원을 문서만으로 주장하지 않는다. |
| font | [Noto CJK](https://github.com/notofonts/noto-cjk)와 [Sans LICENSE](https://github.com/notofonts/noto-cjk/blob/main/Sans/LICENSE)는 언어별 배포/버전과 OFL을 제공한다. | 실제 사용 font files의 copyright/license/hash를 함께 고정하고 필요한 glyph/linebreak/shaping을 평가한다. 폰트명을 안다는 사실만으로 누락0을 보장하지 않는다. |

thinking 원문을 직접 여는 두 URL은 조회 오류였고 모델 페이지 navigation의 Thinking은 Live API 문서로 연결됐다. Live의 수준 설명을 generateContent payload의 근거로 가져오지 않았다. 미확인 어댑터 매핑은 아래 activation gate에 남긴다. 키/토큰·계정 화면에는 접근하지 않았다.

## 3. 화면과 상태의 연결

| 화면/명령 | 표시/허용 행동 | 서비스·저장 확인/오류 |
| --- | --- | --- |
| 로그인/코드/Google·수단 관리 | 발송 중/코드 대기/오류·현재수단/남길수단 확인 | AuthAttempt 목적·기한·한 소비·stable AccountId/allowlist, 발송ACK≠로그인. AUTHV/ASV |
| 시작·새 프로젝트/파일 열기 | 계정 전체 기존 작업 존재 시 돌아가기/정상 종료 안내 | current AccountLiveContextSlot·file 검증. SLOT_OCCUPIED/FILE_INVALID/FILE_ACCESS_UNCONFIRMED 분리 |
| 업로드 미리보기/반영 | 숫자 정렬·파일별 실패·bytes 중복 선택/최종 순서 | EOV17~22 validation/후보 총량/현재 revision·활성 작업 검사. 초과 후보 전체 미반영/AI0 |
| 워크스페이스 | 페이지/이미지·원본 비교·대사/식자·설정·처리 상태/비활성 이유 | 결과 revision/owner·페이지 잠금, 다른 페이지 편집·보기/ZIP. 새 업로드/제외/스킵/순서 잠금, 미래 설정만 변경 |
| 번역·전체/페이지/영역/실패 재시도 | 원 설정/새 재번역 구분, 제한 대기/수행 확인/정산 확인 각각 안내 | request/batch captured targets/settings·execution/cost facts. unknown을 실패0비용으로 표시/자동 재호출 없음 |
| 탭·단절 | 보기 전용/명시 인계·재접속 가능 기한/만료 | ownerRevision/connection generation/원 deadline·모든 holds 검사. hidden event만으로 종료하지 않음 |
| ZIP | 캡처 시각/구성·생성/전체 실패/같은 캡처 재시도·만료 | immutable capture·PNG 모든 entries/자산/권한·30분창. 기존/원본 포함 여부 표시·AI 없음 |
| 저장하고 나가기/current logout | 현재 페이지 마무리/확인 중·file 준비/전달 오류·보관 확인 | C02~C04 최신 service revision+미전송 draft 확인/최신snapshot. attestation≠OS 저장 증명 |
| 모든 로그인 종료 | 미저장 손실·현재 연결 수단 새 proof·별도 명시 실행 | AUTH5.3/PGV19~20, 정상 저장 완료 표시 없음·원 실행/원장 보존 |
| 라이브러리·잔액/내역 | 페이지별 실제 보관/만료·저장 실패 재요청·현재잔액/사용 사실 | 실제StoreCompletedAt·deadline/delete status/원 cost. 라이브러리에서 편집 재개/조회로TTL연장 없음·실제 구매 비활성 |

timeout 문구는 `처리 결과를 확인하고 있어요`처럼 미확정 상태를 알리고 같은 CommandId를 조회한다. 이미 확인한 실패는 재시도 대상/원 설정·비용/실행 여부를 따로 보여준다. 내부 table/lease/provider raw 오류는 사용자 행동에 필요한 안정 코드와 문구로 매핑한다.

## 4. 첫 HTTP 계약과 타입/DB 인계

모든 경로는 `/api/v1` 기준 설계이며 아직 공개/구현하지 않았다. 권위 AccountId는 app session에서 얻는다. client body의 account/provider subject/email은 현재 접근 근거가 아니다. 명령 공통 입력은 `commandId`, `contextId/generation`(대상일 때), `expectedWorkspaceRevision/ownerRevision`(변경에 필요할 때), `intentVersion`, typed payload다. 의도 digest는 앱의 고정 직렬화로 계산하며 같은 ID/다른 의도는409다. asset bytes는 별도 제한 streaming 경로이고 JSON body에 전체 base64 프로젝트를 넣지 않는다.

| HTTP 경로/의도 | 입출력/현재 검사 |
| --- | --- |
| POST `/auth/attempts`, `/auth/otp/verify`, `/auth/callback/complete` | 목적/일회 intent→attempt/검증근거, 실제 증명 이후 LOGIN AppSession 발급/연결/제거/전체종료 의도 소비. raw callback 재처리≠새LOGIN |
| GET `/me`, `/commands/{commandId}` | 현재 access/권한을 대조한 계정/원 명령 상태. 이미 철회 후 결과 대조는 후속 새 valid LOGIN+원 AccountId 확인; 철회 token으로 새 보호 접근 없음 |
| POST `/workspaces`, `/project-files/imports`, `/workspaces/{id}/handoffs` | 한 슬롯/형식·현재 creator access/owner 인계. import는 파일검증 완료 뒤 새generation; 활동/이력/원장 재생 없음 |
| POST `/uploads`, `/uploads/{id}/commit` | 제한된 staged bytes→파일별 판정/후보·중복선택→현재 owner/revision/한도/활성 검사 후 페이지 반영 |
| POST `/workspaces/{id}/commands` | request/batch/region-retranslate·edit/undo/redo/settings/config/exit/export의 typed kind와 payload. kind별 현재 서비스 검사·기존 성공 조회 |
| GET `/workspaces/{id}`, `/workspaces/{id}/events` | 현재 투영/알림 revision. SSE는 DB 확인 필요 알림이며 replay를 상태 변경으로 실행하지 않는다. GET 조회는5분/10분 reset·새LOGIN이 아님 |
| POST `/auth/logout-current`, `/auth/logout-all` | current: 정상 file gate/해당 session 귀속. all: 새CONFIRM_ALL_LOGOUT+명시손실 확인/전체revocation. 인증 metadata/원장·old execution 보존 |
| GET `/exports/{id}/content`, `/library`, `/library/{id}/content` | 현재 계정/목적/기한/실제자산 확인. file/ZIP/library 저장 성공과 전달은 별도. 만료시 D10 transfer 중단/실제 삭제 대조 |

응답은 `commandId`, `disposition`(APPLIED/ACCEPTED/EXISTING/REJECTED/RECONCILING), `operationRef`, `observedRevision`, `reasonCode`, `nextAction`, `serverTime`을 갖는다. 202는 진행 접수,200은 조회/확정 결과,409는 의도/버전·슬롯/활성 경합,422는 검증된 입력 불가,401/403은 현재 인증/권한 실패다. 일시 HTTP5xx/네트워크 유실은 같은 명령 조회 대상이며 수행실패/새AI허가가 아니다. reasonCode는 `OWNER_CHANGED`, `REVISION_CONFLICT`, `ACTIVE_WORK`, `EXECUTION_UNKNOWN`, `COST_UNCONFIRMED`, `COST_BOUND_UNCONFIRMED`, `PROVIDER_LIMIT_WAIT`, `MODEL_CONTRACT_UNAVAILABLE`, `CAPTURE_EXPIRED`, `FILE_ACCESS_UNCONFIRMED`, `DELIVERY_EXPIRED`를 구분한다.

DB 테이블/열 인계는 PG3의 K01~K12/추가 binding/history/export/library에 연결한다. uuid ID, bigint revision/generation, timestamptz 절대시각, bigint bytesLength, SHA-256 digest, 정수 free-start count와 명시 상태를 사용한다. 금액은 `NUMERIC(28,12)` USD/credit Decimal 문자열로 처리하고 JS float를 원장 산식에 사용하지 않는다. 확인되지 않은 비용/상한·단가는 NULL+reason이며0대입 금지다. 실제 환산/표시 정밀도는 판매/정산 activation 전에 전체 산식 검증으로 고정한다.

아래는 중요한 constraint의 요약이다. 후속 [전체schema/SQL 설계](2026-10-03-manga-web-contract-reference.md)2~4절에47기록/복합FK/명시check를작성했다. 실제migration/PG 구문·DDL실행과권한/race는NOT RUN이며아래조각만완성migration으로사용하지않는다.

```sql
-- 각 테이블의 AccountId 귀속 FK/NOT NULL/CHECK도 migration에서 작성한다.
-- 같은 intent와 확정 상태 변경은 한 transaction/client에서 처리한다.
UNIQUE (account_id, command_id)                    -- CommandReceipt + intent digest
UNIQUE (issuer, subject)                          -- LoginBinding
PRIMARY KEY (account_id)                          -- AccountLiveContextSlot
PRIMARY KEY (account_id, project_lineage_id, page_lineage_id) -- ActivePageRequest
UNIQUE (account_id, request_id, logical_step_id)   -- RequestStepCurrent
UNIQUE (account_id, request_id)                    -- FreeStart
UNIQUE (execution_id, cost_component, ordinal)    -- CostItem
UNIQUE (cost_item_id)                             -- Settlement
UNIQUE (account_id, source_context_id, page_lineage_id, result_id, render_digest, purpose)
                                                  -- LibraryStoreOperation
```

claim은 짧은 `FOR UPDATE SKIP LOCKED` 경계에서 처리하고 실행 권위는 account/context/request/step의 고정 lock 순서와 CAS/revision으로 확인한다. queue payload는 실행 허가가 아니다. 외부 dispatch/object store/SMTP/OAuth/proof exchange를 transaction/retry callback 안에서 실행하지 않는다. prepared/dispatching/unknown의 현재 in-flight 수행을 확인한 뒤 발행한다. DB commit→외부 call 사이의 불명을 DB만으로 해결하는 exactly-once 보장을 만들지 않으며 PGV/S에서 kill/race를 주입해 검증한다.

## 5. 파일·자산·공정의 구체 입력

v1 container entry는 `manifest.json`, `signature.json`, `assets/<opaque-id>.bin`, `fonts/<opaque-id>.bin`, 필요한 `licenses/<opaque-id>.txt`다. manifest의 고정 schema는 format/schemaVersion, issuer/keyId/algorithm, exportId/createdAt, creatorAccountId, projectLineageId, pages/확정순서/skip, settings/version, page result/수동 대사·줄바꿈/폰트·크기, 원본/cleaned/render/font asset list와 bytesLength/SHA-256, Q8-A 정상 누적 기준/미정산 참조, optional checkpoints와 계약/소비 dependency를 포함한다. signature는 envelope keyId/algorithm과 signed 값의 일치를 검사한다.

서명 입력은 `UTF8("trio.manga-project.v1\u0000") || manifestRawBytes`로 선정한다. JSON 재직렬화 bytes로 검증하지 않는다. 중복 key/entry·case/Unicode 정규화 충돌/상위·절대경로/symlink/외부URL/미등록entry는 제한 parser로 거부한다. manifest/entry/total compressed·expanded/pixels/ratio·메모리 수치가 미설정이면 import 활성화 불가다. 직접 path 추출 대신 object ref를 검증하며 원 파일을 덮어쓰거나 migration 중 재서명·AI보충을 몰래 하지 않는다.

필수 편집 asset/hash/schema·현재 creator access 불명/실패는 편집 복원 보류/실패다. optional checkpoint의 호환/자산만 실패하면 편집 복원과 별도로 reuse 불가를 돌려준다. supported v1부터 시작하고 후속 major/migration은 원 bytes 보존·명시지원·검증산출물 뒤 활성화한다. issuing/verify-only/revoked/unconfirmed key상태, 과거 공개verifier 유지·private key rotation/backup·유출사고 file 보류를 구분한다.

object는 account/purpose/immutable asset ref로 관리하고 dedup raw digest가 다른 계정의 존재 여부/읽기 권한을 노출하지 않게 한다. live assets·upload temporary·exports·library용 별도 사본/폰트를 목적별로 구분한다. 업로드 미반영 temp는 생성1시간 뒤 정리하되 현재 valid import/commit pin 여부를 검사한다. export 입력/전달은 D08의30분/현재 권한, library는 실제 성공부터30일이다. pin/backup이 library 실제삭제를 연장하지 않게 사본 목적과 삭제 증거를 추적하며 불명은 삭제완료로 표시하지 않는다.

이미지 공정은 `Region/OCR → Translation → Cleanup → Typeset/Render`의 단계 계약/실제 소비 입력을 기록한다. 원본 bytes/dimensions/hash, service가 부여한 regionId/원본 px polygon/angle·reading order, OCR raw/검토 값, 번역 source/target/model+수준/prompt version, mask/cleaned asset/hash/QA, 최종 수동값·font/version/geometry/layout/render version을 연결한다. 재번역 교체 범위 밖 사용자 값·이력을 보존하고 invalid dependency만 무효화한다. OCR confidence나 HTTP200만으로 cleanup/최종적용/사용자 확정을 합치지 않는다.

mask는 서비스가 허용한 target 범위를 넘지 않게 crop→page 좌표 역변환·clip을 검사하고 mask밖 pixel변화0을 구조 인수 조건으로 둔다. LaMa engine/weights·Python/container 버전/메모리는 설치 전별도 적합성 gate다. TS worker는 전체 실행/권한을 소유하며 격리 이미지 공정은 검증된 immutable 입력/출력만 인계한다. 불명 외부 작업을 일반localretry로 처리하지 않는다. 텍스트는 escaped markup/고정 font allowlist이며 source/provider 문자열을 HTML/script/명령/schema로 실행하지 않는다.

server의 canonical raster 결과를 final preview와 PNG export가 같이 사용한다. 편집 중 즉시 browser overlay는 미확정 preview임을 구분하고 canonical 완료 전에 최종 export와 동일하다고 표시하지 않는다. baseline/linebreak/정렬/rotation/vertical 지원은 같은 renderer 입력/폰트 bytes로 검증한다. glyph 누락/읽기 어려운 최소 크기·허용 넘침/배경손상은 각각 품질 검토 항목이며 모든 overflow를 거부하거나 자동 의미 재작성하지 않는다.

## 6. 측정표·활성화 차단과 완료 증거

| Gate ID | 입력·측정 시점 | 통과/미충족 처리 |
| --- | --- | --- |
| RSG01 환경/의존성 | 새 프로젝트 승인 단계의 Node24/PG18·Fastify/pg/renderer·lockfile/native engine 호환 | 실제 typecheck/build/DB migration/transaction 통과 전 서비스 활성화 불가. 기존 Trio 성공을 전용하지 않음 |
| RSG02 인증/목적·owner/단일맥락 | fake proof/state/code races부터, 이후 승인된 Auth0/Google/OTP·Windows/Android/iPad | ASV/AUTHV·7일/두logout/새 binding/파일creator/두탭 우회0. fresh 근거/외부철회 불명시 새권한 부여 보류 |
| RSG03 파일/객체 | 합성 v1→손상/변조/duplicate/폭탄·원본 보존·키회전/유출·30일/삭제/전달기한 | FILEV/SEC/EOV/HOV·필수/optional 분리와 actual사본/복구삭제 확인. 불명 지원/삭제를 PASS로 표시하지 않음 |
| RSG04 모델/전체 비용 | 3.5 정확 model/endpoint·Low/Medium/High payload/finish/usage·공급사조회/멱등/한도·이미지/OCR/cleanup/raster 입력 비용 | model capability/mapping+valid rate/input·output/기타처리 전체 bound 확인 전 유료/외부비용 경로 보류. HTTP404/unsupported는Q19 안전중단, unknown 재호출금지 |
| RSG05 품질/자료·지원 한도 | 첫21자료 계획/7방향·3유형, 이후 승인된 권리자료·실제공정/폰트·원가·작은/큰 이미지 단계 증가 | 원본훼손/범위밖변화·틀린glyph/누락·무효파일성공0, 번역의미/읽기순서/배경/넘침 각각 판정. 통과 자료 최대치를 그대로 한도로 보장하지 않고 여유/기기/host 한계를 적용. 미통과 조합은 지원대기 |
| RSG06 과금/예산/운영 | 내부원장·동시잔액·최초정산/중복·C안 rate/version/Decimal 경계·PG/API·worker/objects/auth/mail·사용량 견적 | 판매/비용활성화 전 상품/환산·총상한/실지출범위 근거 필요. 초기host표 가격으로 원가를 꾸미지 않음·미정이면 비활성 |
| RSG07 전체 제품/증거 | 합성fake수명→파일/탭→공정→로그인/전체흐름·세기기 파일/터치/복원 | S/APV/PGV/EOV/ASV/FAV/HOV/FX/RSG를 환경·자료·결과별 기록. 현재 모든 새제품/후속실측 NOT RUN, 독립검토 한도는별도 제한 |

품질 평가는 source 원문/정답/region·목표 의미·이름/말투·원본 background/허용 mask·font/shaping·expected result와 실제문제/판정/원가를 한 specimenId에 연결한다. 처음3유형으로 언어 전체/특수모든만화를 보장하지 않는다. 실제실험은 같은범위에 대한 실패를 고쳐 필요검증을 반복하고 정상통과한 동일 코드/환경은 이유 없이 재실행하지 않는다.

## 7. 새 웹 프로젝트의 파일·명령·순서 인계

선정 프로젝트 폴더명은 별도 `trio-manga-web`이며 현재 Electron 저장소 밖에 만드는 구조를 설계한다. 후속 D20의예정절대root는`C:/Users/ksaei/Documents/Codex/trio-manga-web`이다. **새 웹 저장소/폴더는 아직 생성하지 않았다.** 아래는 그 root 안의 예정 경로이며 현재 존재 파일 링크가 아니다. 구현을 시작할 때 사용자가 승인한 workspace root로 치환해 정확한 절대경로를 기록한다.

| 구현 단위/예정 경로 | 책임·완료 조건 | 검증 연결 |
| --- | --- | --- |
| `packages/contracts/src/{ids,commands,errors,schemas}.ts` | Account/context/owner/request/execution/cost/snapshot ID와 wire schema·version/이유코드/검증을 앱 작성 코드로 소유 | 잘못된의도/bytes/권한값·schema injection 거부, 핵심기한/비용/무료/파일facts 보존 |
| `db/migrations/0001_identity_workspace.sql`·`0002_execution_cost.sql`·`0003_edit_export_library.sql` | PG3/본4절의 실제DDL/FK/check/index·unique/명령receipt·live slot/권위data와 additive migration/backup restore | 실제PG18·동시samecommand/다른intent·page/step/account race/rollback·PGV01~20 |
| `apps/api/src/{auth,workspace,uploads,files,exports,library}/` | 현재auth/owner/기한·body validation 뒤 DB-only명령/조회와 asset gateway, C02~C04/두logout/FILEV | AUTHV/ASV/SEC/EOV/FX·권한/session·유실/재전송·import malformed/actual deletion |
| `apps/worker/src/{claim,dispatch,reconcile,settle,finalize,storage}/` | 원request/step/기한/holds/claim generation 검사·외부수행대조/비용정산·저장-only재시도 | S/PGV/HOV·발행 전후 kill·lease/fencing·unknown/최초정산/중복0·원시계 |
| `apps/web/src/{pages,workspace,editor,auth,downloads}/` | React/Vite 작업화면·선택/터치·수동draft/Undo·서비스상태·비활성이유·file attestation/두logout | 실제pointer/keyboard/touch·WindowsChrome/Edge·AndroidChrome/iPadSafari·FAV/EOV/ASV |
| `packages/image-pipeline/src/{region,translate,cleanup,render}/`·`engines/cleanup/` | 불변asset/좌표·정확model mapping/usage·maskQA·canonical font/layout/raster·별도engine 계약 | APV01~16/RSG04~05·특히geometry/outside-mask/history교체·preview/export/PNG |
| `tests/{domain,postgres,protocol,browser,fixtures}/`·`docs/validation/` | 합성fake credential/data, 명시invariant/실제protocol·browser·결과/환경/관측근거와 NOT RUN | fake/renderer/PG/provider/host·release별증거분리, user변경/원본보존 |

예정 npm scripts는 `typecheck`, `lint`, `test:domain`, `test:postgres`, `test:protocol`, `test:browser`, `build`다. 선택한새프로젝트의 package.json/lockfile/script를 작성·확인한 뒤에만 `npm.cmd run <script>`를 실제명령으로 보고한다. 현재 Trio의 npm명령으로 웹테스트PASS를 만들지 않는다. PG는 격리local/container 데이터, fake proof/provider는 loopback·fakecredential을 사용하며 realendpoint opt-in 없이외부call0을 확인한다. Docker/Node/Python/브라우저·PG실환경의 설치/가용성은 지금 확인·변경하지 않았다.

환경변수설계는 `DATABASE_URL`, `AUTH_ISSUER/AUDIENCE/CALLBACK_ORIGIN`, `SESSION_COOKIE_NAME`, `INTERNAL_TEST_ACCOUNT_ALLOWLIST`, `OBJECT_ENDPOINT/BUCKET_*`, `SIGNING_KEY_ID`, `VERIFIER_CATALOG_VERSION`, `MODEL_CAPABILITY_VERSION`, `RATE_SNAPSHOT_VERSION`, `REAL_PROVIDER_ENABLED=false`, `PAID_EXECUTION_ENABLED=false`, `PURCHASE_ENABLED=false`다. 실제secret 값은 별도서버secret store/실행세션에만, frontend bundle/file/log/fixture에는없다. activation값을debug/UI입력만으로켜지않게서버가검사한다.

구현순서는 H02 골격/실제PG·권한·명령→H03 합성한계정/한페이지/두fake단계→H04 실제파일/같은계정복원·owner인계/두logout→H05 승인된공정/폰트/품질·원가→H06 로그인/업로드/설정/전체편집/ZIP/library·선택기기다. I-A가전체범위를줄이지않는다. realauth/provider/host계정·전송/비용활성화는각gate와승인범위에서진행한다. 후속전체schema/SQL·현재권한/측정gate와함께준비명세2절의문서준비를완료했다. 실제runtime/전체독립검토·제품PASS와구분하고기존플랜9.12/준비명세12절을최신판정으로사용한다.

## 8. 전체 schema·SQL/정밀도·활성화 인계의 완성

[최종 계약/schema·저장 인계](2026-10-03-manga-web-contract-reference.md)는 D16~D20의추가답/대안·D05추가limiter·emptycontext/default선택·sameorigin/ownerchannel·명령22종/내부stage DTO·filemanifest·47DB기록과currentguard/transaction·finiteDecimal/오류·activepage hydration/원장조회·C안산식입력·키/삭제/복구·측정/quality/RSG·별도예정root/첫I-A 구현순서를구체화한다. 실제제품/외부서비스를실행하거나새코드를연결한것은아니다.

문서준비기준은완료했으며product activation은RSG01~07을통과해야한다. 현재account/auth/provider/key/PG/parser/기기/host·미측정품질/한도/전체원가·유료/자료전송은NOT RUN/미승인실행범위다. 신규범위독립검토는호출한도로미완료이고이전완료검토와구분한다. 모든선정/응답/검증기록은프로젝트문서에남기며메모리저장없음이다.
