# Auth0 새 인증 근거·앱7일·명시 연결의 추가 공식 근거

확인일: 2026-10-03. researcher `/root/auth0_fresh_auth_evidence`가 공식 원문을 읽기 전용 조사했고 메인이 핵심4개를 직접 재조회했다. 실제 tenant/메일/OAuth/API·token·설정/비용은 NOT RUN이다. 가격/쿼터·제품 채택·복구 정책을 확정하지 않았다.

| 원출처 | 확인한 사실/적용 경계 | 직접 대조 |
| --- | --- | --- |
| [OTP authenticate-user](https://auth0.com/docs/api/authentication/passwordless/authenticate-user) | email/realm/OTP·regular web secret·openid. 현재 reference의 form body/등록 redirect_uri와 실제 허용 shape는 검증해야 함. auth_time/nonce·앱challenge 서명/echo 보장 미확인 | researcher+메인 |
| [max_age reauthentication](https://auth0.com/docs/authenticate/login/max-age-reauthentication) | Auth0의 max_age/auth_time은 이번 교환 근거. Google 기존 session 이용 가능하며 upstream credential 강제 재입력 보장 아님. prompt=login만으로 freshness 판단 금지 | researcher+메인 |
| [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html) | iss/sub·ID Token 검증, refresh auth_time은 원 인증시각. 새 iat/refresh로 앱 새7일 생성 없음 | researcher+메인 |
| [Sessions Management API](https://auth0.com/docs/manage-users/sessions/manage-user-sessions-with-auth0-management-api) | Enterprise·비동기/eventual deletion·session 종료 뒤 refresh 잔존 가능. 앱철회와 분리 | researcher+메인 |
| [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect) | prompt 계정 선택/동의≠credential 재입력. Google claim 설정과 Auth0 connection 전달/검증은 별도 미확인 | researcher |
| [Auth0 native linking](https://auth0.com/docs/manage-users/user-accounts/user-account-linking) | 기본 identity 분리·양쪽 접근 증명. 앱 LoginBinding과 native profile 합병을 구분 | researcher; 앞선 후보 비교의 메인 대조도 별도 보존 |
| [IdP logout](https://auth0.com/docs/authenticate/login/logout/log-users-out-of-idps) | provider logout과 앱logout은 별개이며 social 동작 차이 있음. 전체 Google 기기 즉시 철회로 확대 금지 | researcher |
| [Refresh revocation](https://auth0.com/docs/secure/tokens/refresh-tokens/revoke-refresh-tokens) | API/설정에 따른 token/grant 철회 범위. token 철회·session 종료·앱 접근을 한 ACK로 합치지 않음 | researcher |

## 앱 설계 추론 — 실제 구현/적합성 미검증

- 명시 LOGIN/REAUTH_LOGIN의 서버 소유 일회 AuthAttempt를 저장하고 callback/직접 exchange 성공·claim을 그 목적에 연결한다. 연결용 현재 계정/새 수단 증명과 LOGIN 목적을 분리한다.
- Google 후보는 이번 Auth0 issuer/client·state/nonce·auth_time을 검증한다. max_age0을 falsy로 처리해 freshness 검사를 생략하지 않는다. upstream Google 비밀번호 새 입력 요구를 Q39에 추가하지 않는다.
- OTP 후보는 서버가 고정한 목적/email/realm/브라우저 attempt에서 직접 코드 교환하고 검증된 ID Token을 성공 사실에 연결한다. 브라우저가 준 기존 token·발송 ACK·email_verified·iat를 이번 성공으로 간주하지 않는다. nonce/auth_time의 실제 제공 여부와 provider가 우리 challenge ID를 암호학적으로 결박하는지는 미확인이다.
- Postgres AppSession의 freshLoginVerifiedAt/absoluteExpiresAt를 LOGIN evidence 소비와 함께 한 번 확정한다. refresh/SSO/callback 재전송·연결용 proof는 새7일 근거가 아니다. 로그아웃/철회 뒤 옛 callback으로 session을 재생하지 않는다.
- 명시 두 수단 증명 뒤 stable AccountId에 issuer+subject를 transaction으로 추가한다. 같은 email 자동 앱합병/이미 만든 두 계정 합병/새 무료 할당을 하지 않는다. unknown·다른 계정 binding은 각각 보류·거부한다.
- 앱 철회는 외부 Session API/Google logout 완료를 기다리는 구조로 만들지 않는다. 외부 철회 감지/전달·실제 권한은 검증 대상이며 앱/provider 전체의 실시간 철회 보장으로 확대하지 않는다.

연결 문서는 [인증·세션 상세 초안](../../../docs/superpowers/specs/2026-10-03-manga-web-auth-session-design.md)이다. ASV01~ASV07은 기대값/관측 계획이고 전부 NOT RUN이다. OTP 만료/재발급/시도 한도·bootstrap·복구/해제·로그아웃 범위·실제 secret/cookie·product/플랜 선정은 미완료다.
