# 인증 후보·명시적 연결·앱 세션의 상세 설계 초안

작성일: 2026-10-03. 상태: **Q38-A의 Auth0 우선 적합성 검증 후보 — 최종 채택·tenant/메일/OAuth·ASV 실행 NOT RUN**.

정책 원본은 [Domain Story25·59절](../../manga-translation-domain-story.md)이다. Q24-B/Q26-A/Q27-A의 Google+화면 입력 이메일 코드/명시적 연결, Q38-A의 우선 검토 순서, Q39-A의 명시적 새 인증부터 앱7일 절대 상한을 입력으로 한다. [Postgres 요청 설계](2026-10-03-manga-web-postgres-execution-design.md)의 Account/LoginBinding과 [파일 상세](2026-10-03-manga-web-edit-output-file-design.md)의 현재 만든 계정 접근을 잇는다. 진행은 [기존 플랜](../plans/2026-10-02-manga-web-workspace-contracts-and-validation-plan.md)에 둔다.

아래 기록/흐름/검증은 기술 후보이며 실제 SDK·HTTP 계약/설정·코드·DDL·호스팅/플랜을 확정하거나 실행하지 않는다. provider 인증 성공과 내부 계정 접근은 별개다. 현재 지정 내부 테스트 계정 gate를 로그인·연결·보호 요청에 적용하고 provider의 일반 가입/동일 이메일만으로 앱 계정·무료 사용을 새로 만들지 않는다. 최초 테스트 계정의 bootstrap/등록 근거는 운영 설정 전 반드시 확정한다.

## 1. 공식 근거와 한계

| 근거 | 확인된 설명과 우리 적용 범위 |
| --- | --- |
| [Auth0 OTP Authenticate User](https://auth0.com/docs/api/authentication/passwordless/authenticate-user) | `/oauth/token`의 이메일/코드/realm·regular web client secret·openid 지원. 현재 reference는 form body/등록 redirect_uri도 명시. OTP의 auth_time/nonce·우리 challenge ID 서명/echo 보장은 확인하지 않음. 실제 요청/응답/설정 미검증 |
| [Auth0 max_age 재인증](https://auth0.com/docs/authenticate/login/max-age-reauthentication) | max_age/auth_time 확인 지원, prompt=login만으로 freshness 검증하지 않음. upstream 교환은 Google credential 재입력을 보장하지 않음. 이번 명시 로그인 의도와 Auth0 교환을 검증하는 후보 |
| [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html) | issuer/subject·ID Token 검증과 refresh의 원 인증시각. Auth0 broker callback의 기대 issuer/client와 Google 직접 인증 경로를 섞지 않음. 새 iat/refresh를 새 로그인으로 사용하지 않음 |
| [Auth0 native linking](https://auth0.com/docs/manage-users/user-accounts/user-account-linking) | 기본 identity 분리와 양쪽 인증 권고. 앱의 여러 subject→하나 AccountId 바인딩과 native profile 합병은 별개. native linking 채택/플랜 권한으로 확대하지 않음 |
| [Auth0 Sessions API](https://auth0.com/docs/manage-users/sessions/manage-user-sessions-with-auth0-management-api) | Enterprise 조건과 비동기 삭제·session 종료 뒤 refresh 잔존 가능. 앱 철회를 이 API의 성공/완료에 의존시키거나 무료 기본 기능으로 간주하지 않음 |
| [Provider logout](https://auth0.com/docs/authenticate/login/logout/log-users-out-of-idps), [refresh 철회](https://auth0.com/docs/secure/tokens/refresh-tokens/revoke-refresh-tokens) | 앱/provider session·refresh 철회는 서로 다른 결과. 한 ACK로 Google/발급 토큰/앱의 모든 접근이 즉시 끝났다고 표시하지 않음 |

[추가 공식 조사 기록](../../../artifacts/manga-web-preimplementation-2026-10-03/decisions-q23-q25/auth0-fresh-auth-evidence.md)은 researcher가 확인한8개 원출처와 메인이 직접 대조한 핵심4개를 구분한다. 실제 적합성 PASS는 아니다. 이미 선택한 정책을 provider 기본값/가격 기능에 맞춰 바꾸지 않는다.

## 2. 후보 기록과 신뢰 경계

| 기록 | 의미 | 핵심 제한 |
| --- | --- | --- |
| AuthAttempt | 서버 소유 목적/브라우저 상관관계·issuer/client/connection·시작/만료·소비 상태. OAuth state/nonce 또는 OTP의 고정 email/realm·직접 exchange 참조 | LOGIN/REAUTH_LOGIN, CONFIRM_CURRENT_ACCOUNT, PROVE_LOGIN_BINDING 목적 분리. 브라우저의 기존 token/email을 이번 인증 성공으로 받아들이지 않음 |
| VerifiedAuthEvidence | 검증된 응답/issuer+subject·대상 client/목적·attempt 귀속·검증시각·일회 소비 결과 | 원 token/OTP/secret을 일반 로그/파일/fixture에 저장하지 않음. 서명/필요 claim/실제 exchange 근거 검증 전 evidence 발급 없음 |
| LoginBinding | 안정된 내부 AccountId에 속하는 검증된 issuer+subject/수단·active/revocation 상태 | 동일 email은 identity 아님. 다른 AccountId 소유 subject 거부·불명 보류. 동시 연결의 유일성/원자적 결과 |
| AppSession | AccountId·로그인 evidence/원 수단 참조·freshLoginVerifiedAt·absoluteExpiresAt·revocation 상태 | 서버가 LOGIN evidence 검증/소비한 시각부터7일. callback/refresh/연결용 proof/last-seen으로 시각 초기화 없음 |

브라우저 cookie는 제한된 앱 세션 참조이며 authoritative 계정/binding/session 상태를 대체하지 않는다. secret 저장소·cookie/CSRF/세션 전달·token 필요 최소 보존의 실제 구현은 host/인증 상세 선정 뒤 작성한다. 원본 프로젝트/대사/이미지·키를 auth 로그/외부 profile로 보내지 않는다.

## 3. 명시적 로그인과7일 상한

Google 후보는 서버가 명시 LOGIN/REAUTH_LOGIN attempt를 기록하고 `/authorize`의 `max_age=0`·state/nonce를 연결한다. callback에서 서명·정확한 Auth0 issuer/audience·expiry·필요 azp·nonce와 이번 attempt의 auth_time/시각을 검증한다. max_age0을 falsy로 취급해 검사를 생략하지 않는다. 허용 clock skew/시각 정밀도·attempt 만료는 후속 수치 계약이다. 누락/오래된/다른 attempt 결과로 새7일을 만들지 않는다. 성공 의미는 이번 Auth0 인증 교환 검증이며 Google 비밀번호 재입력의 증명은 아니다.

이메일 OTP 후보는 서버가 목적·브라우저·email/realm을 고정하고 사용자 코드 제출 뒤 직접 `/oauth/token`을 수행한다. HTTP 성공만 보지 않고 실제 응답 구조/ID Token 서명·issuer/subject/audience/expiry를 검증해 이번 내부 attempt에 성공을 한 번 기록한다. 발송 ACK·기존 email_verified·새 iat로 성공을 대신하지 않는다. OTP grant에 OIDC authorize의 nonce/auth_time을 항상 제공한다고 가정하지 않고 로컬 attempt/CSRF 상관관계와 provider가 서명한 claim의 증거를 구분한다.

유효 LOGIN evidence 소비와 AppSession 최초 생성/절대 시각을 DB-only 경계에서 함께 확정한다. provider 교환을 DB 재시도 callback 안에서 반복하지 않는다. 응답 유실은 원 attempt/session 결과를 대조하며 새 AppSession/새7일을 몰래 만들지 않는다. 코드 재발급·동시 제출·이미 쓴 코드·provider 응답 유실의 실제 의미는 검증 대상이다.

서비스는 매 보호 요청/다음 실제 단계 권한 확인에서 현재 Account/Binding/AppSession·절대 만료·서비스가 확정한 철회를 검사한다. cookie 재발급/자동 refresh/조용한 SSO/일반 작업/연결용 proof는 absoluteExpiresAt을 바꾸지 않는다. 서비스 시각이 기한 이상이면 새 접근을 허용하지 않고 다시 로그인 안내한다. 워크스페이스5분/공급사10분과 수행/정산 사실은 별도다. 외부 철회의 감지 범위/지연·현재 운영 접근 대조는 아직 미정이며 provider 전체의 실시간 철회를 보장한다고 표현하지 않는다.

## 4. 새 로그인 수단의 명시적 추가

연결 intent는 현재 내부 계정·현재 권한·현재 계정 접근 증명과 새 수단 evidence·의도/예상 binding revision을 연결한다. CONFIRM_CURRENT_ACCOUNT는 현재 AccountId에 속한 binding을, PROVE_LOGIN_BINDING은 새 issuer+subject를 검증하는 후보다. 정확한 재인증 강도/수명은 후속이다. 수단 상실은 Q47-A의 원 provider 복구, 수단 제거는 Q48-A의 남길 수단 재인증/명시 제거로 좁혔다.

두 증명과 명시적 연결을 확인하고 transaction에서 subject 소유/현재 권한/유일성을 재검사해 같은 AccountId에 추가한다. 이미 다른 앱 계정에 연결됐으면 거부하고 기존 두 계정을 보존한다. 증명/관계 불명은 보류한다. 같은 command/의도 재전송은 원 결과 조회, 동시 다른 계정 연결은 한 소유자만 확정한다. 연결이 원 잔액/무료 원장/파일 만든 계정을 재생하거나 새 할당을 만들지 않는다.

연결용 proof 성공을 AppSession7일 갱신으로 사용하지 않는다. 다른 목적 evidence를 LOGIN으로 다시 소비하지 않으며 오래된 callback으로 로그아웃/만료된 session을 되살리지 않는다. Q47-A/Q48-A의 복구/제거는 아래5.1절을 따른다. Q52-B의 현재/모든 앱 session logout 범위는 선택 완료이고 작업 파일/진행 요청·proof 상세는 후속이다. 일반 제품 기본값으로 정책을 조용히 도입하지 않는다.

## 5. 로그아웃·철회와 파일 접근

앱 로그아웃/서비스에서 확정한 접근 철회는 먼저 서버의 앱 접근을 차단하고 cookie를 끝내는 후보로 설계한다. Auth0/Google logout·refresh 철회는 별도 요청/결과다. 외부 실패/비동기 처리 중 앱 철회를 되돌리지 않는다. 이미 발급된 token 하나의 exp나 외부 API ACK를 앱 전체 접근의 현재 근거로 쓰지 않는다.

여러 외부 subject가 한 App AccountId에 연결될 수 있으므로 Auth0 사용자 하나의 session 종료가 앱 계정 전체 외부 session 종료를 뜻하지 않는다. Q48-A의 수단 제거는 그 binding으로 로그인한 모든 앱 세션의 철회까지 포함한다. Q52-B의 일반 logout은 현재 앱 session과 같은 AccountId 모든 앱 session의 별도 명시 동작이다. 작업 파일/종료 순서·proof 강도와 외부 감지/철회는 후속으로 좁힌다. 외부 Session Management API entitlement가 없으면 이를 전체 철회/조회 기능의 무료 구현 수단으로 가정하지 않는다.

프로젝트 파일의 만든 계정은 내부 AccountId다. 유효한 어느 연결 수단으로 로그인했는지와 별개로 현재 앱 접근/서명/필수 자산을 검증한다. 파일 속 email/AccountId·같은 이메일·과거 로그인 evidence는 현재 접근을 대신하지 않는다. 수단을 잃었다고 파일의 계정/원장을 다른 계정으로 합치거나 수정하지 않는다.

### 5.1 모든 수단 상실과 남길 수단 증명 뒤 제거

Q47-A로 모든 연결 수단을 잃고 사용할 앱 session이 없으면 원래 Google/이메일 제공자의 계정 복구 후 원 binding으로 돌아온다. 별도 앱 복구 코드/파일 소지·동일 email만의 이전 경로는 제공하지 않는다. provider의 복구 성공을 보장하지 않으며 복구 전 원 계정/무료·잔액·파일 소유를 다른 내부 계정으로 옮기지 않는다.

Q48-A의 후보 제거 intent는 현재 계정·제거 binding·남길 다른 active binding·별도 CONFIRM_UNLINK evidence와 예상 revision을 연결한다. 남길 수단 재인증/명시 선택을 확인하고 동일 DB-only 경계에서 현재 접근·마지막 active binding 수·revision/의도 소비를 재검사한 뒤 대상 binding을 inactive로 만들고 그 binding으로 로그인한 앱 세션의 철회를 확정한다. 두 동시 제거가 서로 다른 남길 수단의 과거 증명을 사용해 마지막 수단을 없애지 않도록 현재 binding 집합을 직렬화하는 방식은 실제 DDL/transaction 검증 대상으로 둔다. 새 로그인/session 발급도 같은 binding의 현재 active/revocation을 대조한다.

현재 앱 session이 제거 대상 binding에서 만들어졌다면 그 session도 철회한다. 남길 수단의 연결 제거용 proof를 새 LOGIN/7일로 승격하지 않고 필요한 경우 명시 새 로그인을 안내한다. 응답 유실/같은 명령 재전송은 원 제거/철회 결과 조회이며 새 binding·무료/계정/시각을 만들지 않는다. Google/이메일 provider 계정 삭제나 모든 외부 기기 logout을 의미하지 않는다. 요청 수행/정산/불명 기록은 보존하고 제거를 이유로 처리 성공/무료 환급·잠금 조기 해제를 만들지 않는다. workspace/provider clock을 자동 초기화하거나 단절 확인 사건 없이5분 시계를 새로 만들지 않는다.

### 5.2 현재/모든 앱 session 범위와 단일 live context

Q52-B는 현재 AppSession의 logout과 같은 AccountId의 모든 앱 session logout을 별도 명시 명령으로 제공한다. 현재 세션을 공유하는 여러 탭은 같은 session 철회에 따라 접근이 끝나고, 다른 valid session은 current-only 철회로 끝내지 않는다. all-session 철회는 같은 AccountId의 모든 binding으로 만든 앱 session을 포함한다. 후보 transaction/revocation generation은 새 보호 요청/기존 cookie·refresh/옛 callback으로 철회 상태를 우회하지 않게 하며 중복 명령/응답 유실은 원 결과를 조회한다. 이것은 provider 계정/Google 전체 기기·미래의 유효한 명시 새 LOGIN을 영구 차단하는 명령이 아니다.

Q55-A의 정상 current logout은 이 session이 소유한 맥락의 C02~C04 저장 종료/최신 파일 보관 확인 뒤 철회한다. 소유하지 않은 session의 current-only logout은 기존 owner 작업을 종료하지 않는다. 같은 session의 보기 탭은 owner 탭/명시 인계를 거쳐야 하며 원 파일 gate를 우회하지 않는다. Q56-B의 all logout은 현재 active binding에 대한 별도 새 CONFIRM_ALL_LOGOUT evidence와 미저장 손실/명시 확인 뒤 파일 대기 없이 전체 app session 철회·현재 편집 맥락을 종료한다. 이 보안 종료는 정상 저장 종료와 구분하며 원 발행/불명/정산 사실을 보존하고 새 비용 단계 허가를 차단한다. proof/intent는 한 번 소비하고 새 LOGIN/7일 갱신으로 재사용하지 않으며 증명 불가 때 보류한다. 기한/revocation/동시 발행/처리 중 종료의 실제 기술 검증은 후속이다.

Q53-A의 계정 전체 한 live context는 AccountId 권위에서 동시 새 프로젝트/파일 열기를 대조한다. active login 수/credential provider/기기 수로 별도의 맥락 슬롯을 만들지 않는다. conflict 때 기존 작업으로 돌아가기/기존 종료·파일 확인을 안내하고 자동 폐기/권한 인계/새 AI 시작을 하지 않는다. Q15의 같은 live context explicit owner 인계는 그대로다. actual 종료/5분 만료와 원 수행/정산 hold를 구분해 새 맥락 생성이 옛 hold/기한/무료 사실을 지우지 않는다.

### 5.3 정상 logout과 명시 전체 보안 종료의 원자적 경계

current logout intent는 AccountId/AppSessionId·owner context/generation·ExitOperationId·최신 snapshot/보관 확인을 연결한다. 서비스가 실제 종료/최신 파일 gate를 확인하기 전에는 session logout 완료로 표시하지 않는다. 원 요청 중단/unknown과 file 실패는 기존 조회/안내를 유지한다. 무맥락/다른session owner의 경우 current session 철회로 끝내되 다른 맥락 변경은 없다.

all logout intent는 같은 계정의 현재 session·현재 binding/revision·CONFIRM_ALL_LOGOUT evidence·명시 손실 확인을 연결한다. 실제 session generation/revocation·현재 context closed(reason=ALL_SESSIONS_LOGOUT)·owner 권한 철회/슬롯 해제·새 단계 허가 차단/StopRequested를 DB-only 경계에서 확인하는 후보를 둔다. 이미 발행한 호출/unknown·cost/settlement는 이 transaction에서 성공/안전한 중단으로 조작하지 않는다. 호출/late result는 원 실행에만 대조하며 closed 맥락/새 context에 적용하지 않는다. 같은 명령 응답 유실은 원 결과 조회이고 옛 callback/proof는 session/맥락을 부활시키지 않는다. 새 명시 LOGIN과 동시 경합의 승인 순서/철회 generation 대조는 PGV20으로 검증한다.

## 6. 인수 사례 — 모두 NOT RUN

| ID | 기대 결과/관측 근거 |
| --- | --- |
| ASV01 명시 Google 로그인+기존 Google 세션 | one-use intent·Auth0 issuer/client/nonce/auth_time 검증. 이번 교환과 Google credential 재입력을 구분 |
| ASV02 silent SSO·refresh·작업·연결용 proof | 원 앱 absoluteExpiresAt 유지, 다른 목적 evidence로 새7일/LOGIN 생성 없음 |
| ASV03 state/nonce/issuer/audience/서명·auth_time 불일치/누락/지연 | 새 session 없음. token/attempt/client·max_age0 검사 결과와 거부 사유 |
| ASV04 OTP 실제 payload/encoding·redirect_uri/claim·발송 ACK | 실제 설정/문서 차이 기록, 발송≠인증. OIDC nonce/auth_time 가정 없이 직접 exchange/검증 연결 |
| ASV05 OTP 재발급/만료/오입력/사용 코드·동시 제출/응답 유실 | 같은 attempt/목적 한 소비, 명령 유실을 새 인증/7일로 자동 승격 없음 |
| ASV06 Google↔OTP 연결·동일 email·다른 앱 계정/동시 연결 | 두 증명/explicit intent·단일 binding·stable AccountId/파일 소유/무료 원장 유지·내부 테스트 계정 gate |
| ASV07 정확7일/로그아웃/철회·callback 재전송·외부 철회 지연 | 앱 기한/철회 우회 없음. 외부 결과와 앱 차단 분리·workspace/provider clock 불변 |
| ASV08 모든 수단/사용 앱 session 상실·file/email 소지 | 원 provider 복구/원 binding 전 현재 접근 없음·계정 이전/앱 복구 코드/무료 원장 재생 없음 |
| ASV09 남길 수단 재인증·다른 계정/오래된 proof·마지막 수단/두 동시 제거 | 목적/계정/현재 active 집합·revision 대조. 최소 하나 유지·한 번 제거/철회·남길 수단의 LOGIN 시각 갱신 없음 |
| ASV10 대상 binding session/새 로그인과 제거 동시·응답 유실/철회 callback 재처리 | 대상 binding 관련 앱 session 전부 철회·옛 발급/접근 거부·동일 결과 조회. 다른 binding/원장/파일 유지·provider 계정 삭제 없음 |
| ASV11 current/all 앱 logout·다른 binding/공유 탭·재전송/옛 callback | 현재 session만/같은 계정 모든 앱 session 범위 정확·원 결과 조회·철회 우회/옛 session 부활 없음. provider logout/새 명시 LOGIN과 구분 |
| ASV12 같은 계정 다른 subject/기기에서 새 맥락 동시·인계/종료/5분 만료 | 계정 전체 한 live context·기존 작업 자동 폐기/파일 확인 생략 없음·명시 동일 맥락 인계 유지·원 수행/정산 hold 보존 |
| ASV13 current logout·실행/제한10분/unknown·파일 실패/새 편집 | C02 정상 current page 보호·최신 file/보관 확인/종료 뒤 철회. 미확인일 때 logout 완료/파일 gate 생략 없음 |
| ASV14 보기 탭/같은session·다른session owner·명시 인계 | 원 편집 탭/인계 후 file gate, current session 공유 탭만 종료·다른session 소유 작업 보존 |
| ASV15 all logout proof·다른계정/비활성 binding/오래된 evidence·증명 불가 | 현재 계정/active binding·목적/명시 손실 확인, 한 소비. 새LOGIN/7일 갱신/파일이 계정 proof 대체 없음·증명 불가 보류 |
| ASV16 전체 철회/발행·새LOGIN/새context·late result·응답 유실 | session/context 보안 종료와 원 실행/불명/정산 보존·새 단계 허가 차단, 원 맥락 부활/새 맥락 결과 오염 없음·원 명령 결과 조회 |

이 사례/기록은 실제 tenant/API·메일·token 검증 결과가 아니다. Auth0 최종 채택/플랜·API shape/반환값·fresh proof·cookie·binding·revocation·bootstrap·Q47-A/Q48-A 복구/해제·Q52-B 일반 로그아웃 범위의 실제 철회/파일·종료·proof 적합성을 검증하고 상세 구현 인계에 연결해야 한다. 전체 G01~G08 준비 완료를 이 후보 초안으로 선언하지 않는다.

## 7. 추천 위임의 proof/통신 상세 기준

D04의 서버opaque app cookie/REST·SSE조회와 CSRF/Origin·state/nonce, D05의 목적별앱evidence5분·한소비/OTP발송재요청60초/attempt오입력5회·별도계정/수단/IP limiter는 [추천 인계](2026-10-03-manga-web-recommended-selections-and-handoff.md)1/4/6절을 따른다. provider의 실제코드수명/형식/제한은별도확인해더엄격한조건을사용한다. Googlecredential재입력/OTPnonce/auth_time가정을꾸미지않으며binding/UNLINK/ALL_LOGOUT proof를LOGIN/7일갱신으로소비하지않는다.5분app proof와단절clock은다른사건/시각이며ASV/RSG02실행은NOT RUN이다.

## 8. 완성된 wire·서버세션·bootstrap 인계

[최종 계약](2026-10-03-manga-web-contract-reference.md)1/3~7절의D16~20/추가D05 limiter·sameorigin opaque cookie/current owner channel·purposeproof/explicitbinding/두logout schema와PG기록·allowlist bootstrap/role·RSG02/ASV를연결했다. 미측정/외부fresh proof·현재 철회/실제tenant/code/Google증거/기기channel은실제활성화gate이며Q38의Auth0검토우선을최종fit PASS로승격하지않는다. 문서준비는완료했고새account/메일/OAuth·code/ASV/실세션은NOT RUN이다.
