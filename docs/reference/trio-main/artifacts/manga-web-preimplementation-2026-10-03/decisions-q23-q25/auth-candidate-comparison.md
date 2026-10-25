# Q24·Q26·Q27 인증 후보 적합성 조사

확인일: 2026-10-03. researcher의 공식 문서/공개 코드 조사 결과를 메인이 핵심 원출처와 대조했다. 계정 생성·OAuth/메일·설정 변경·설치·사용자 데이터/secret 접근·실제 지출은 없었다. 후보 제안이며 인증 제품의 사용자 선택은 아직 없다.

## 비교 결과

| 요구·조건 | Supabase Auth | Auth0 |
| --- | --- | --- |
| 앱 화면 이메일 일회용 코드 | 코드 전송/검증 API 지원. 전송 응답은 인증 세션과 별개 | Regular Web Application의 passwordless 시작→앱 코드 입력→OTP grant token 검증 설명. grant 설정 필요, confidential secret은 서버 소유 |
| 같은 이메일 기본 동작 | OAuth identity의 같은 이메일 자동 연결 설명. manual linking 옵션만으로 자동 연결 해제를 증명하지 못함 | 기본 identity 분리 설명. 별도 명시 연결 기능은 애플리케이션이 구현 |
| Google↔이메일 코드 추가 | 이메일 사용자→Google 수동 OAuth 추가 설명. Google→OTP의 독립 수단 증명과 hosted 자동 연결 통제는 미확인 | 별도 Google/OTP 인증 사용자를 앱 내부 AccountId에 명시적 바인딩하는 후보. 양쪽 접근 증명/의도/충돌 검사와 실제 양방향 검증 필요 |
| 안정된 앱 소유권 | provider user UUID/email/AMR 종류만으로 새 수단 접근 증명을 대체하지 않음 | provider native linking과 앱 내부 바인딩을 구분. 앱 AccountId는 provider primary/secondary 선택으로 바꾸지 않음 |
| 제품 고유 linking의 플랜 | hosted 지원/설정·hook 플랜별 제공 조건 확인 필요 | 현재 공식 가격표는 native Account Linking을 Free 제외·Essentials 이상 포함으로 표시. 앱 DB의 별도 바인딩을 이 제품 기능 사용/검증과 동일하게 부르지 않음 |
| 메일/테스트 접근 | 기본 메일의 수신 대상/전달 제한·custom SMTP/정확한 hook 지원 확인 | 기본 메일은 테스트용·전달 제한, OTP endpoint 제한/메일 템플릿·SMTP entitlement 확인 |
| 대상 지역 | 공식 지역 목록에 서울. 실제 선택 지역/메일 처리 위치 미선정 | 공식 tenant 지역 목록·sub-locality 제약 확인. 실제 선택 지역/메일 처리 위치 미선정 |

**첫 격리 검증 후보 제안은 Auth0의 기본 분리된 인증 주체+앱의 명시적 LoginBinding이다.** 같은 이메일 자동 연결에 기대지 않고 안정된 내부 AccountId를 통제할 수 있다는 설계 추론이다. native Account Linking 채택·paid plan·Auth0 제품 선정·무료 운영 보장으로 확대하지 않는다. 실제 OTP/OAuth 수단 증명·callback/nonce/인증 세션·binding 경합·메일/플랜은 검증 전이다.

Supabase도 조건부 비교 후보로 유지한다. 공개 소스의 실험적 제공자 linking-domain 분리 설정은 발견했지만 hosted 지원/안정 배포는 확인하지 않았다. 이를 근거로 Google 사용자의 이메일 OTP 경로까지 독립 수단으로 분리됐다고 추정하지 않는다.

## 핵심 원출처와 근거 경계

- [Supabase passwordless](https://supabase.com/docs/guides/auth/auth-email-passwordless), [identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking), [general configuration](https://supabase.com/docs/guides/auth/general-configuration): 기능 설명과 실제 제품 적합성은 별개다.
- [Supabase 고정 commit 설정 소스](https://github.com/supabase/auth/blob/ce9a8eee0cc042be8c7a42981a7ddae631e41d91/internal/conf/configuration.go#L327): 실험적 provider linking-domain 분리 설정. 이 공개 commit의 hosted 적용/지원은 미확인이다.
- [같은 commit MagicLink](https://github.com/supabase/auth/blob/ce9a8eee0cc042be8c7a42981a7ddae631e41d91/internal/api/magic_link.go#L63), [사용자 조회](https://github.com/supabase/auth/blob/ce9a8eee0cc042be8c7a42981a7ddae631e41d91/internal/models/user.go#L652): email/audience 기반 기존 사용자 조회에는 provider/linking-domain 필터가 없다. OAuth 분리 설정만으로 역방향 OTP 수단 증명 문제를 해결했다고 할 수 없다는 추론이다.
- [Auth0 embedded passwordless](https://auth0.com/docs/authenticate/passwordless/implement-login/embedded-login/webapps), [email OTP](https://auth0.com/docs/authenticate/passwordless/authentication-methods/email-otp): 앱 입력 코드의 서버 검증 후보 근거. 실제 실행은 NOT RUN이다.
- [Auth0 account linking](https://auth0.com/docs/manage-users/user-accounts/user-account-linking), [연결 API 조건](https://auth0.com/docs/manage-users/user-accounts/user-account-linking/link-user-accounts): 기본 분리·명시 연결 설명. 제품 프로필 연결과 앱의 두 subject→AccountId 바인딩은 다른 설계다.
- [Auth0 가격표](https://auth0.com/pricing), [Supabase 가격표](https://supabase.com/pricing): 현재 entitlement 비교. quota/금액을 운영 예산이나 실제 비용으로 채택하지 않았다. 제품 고유 linking·hook·메일/템플릿의 필요한 플랜을 선정 전에 확인한다.
- [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [Auth0 메일 제공자](https://auth0.com/docs/customize/email/smtp-email-providers), [OTP API 제한](https://auth0.com/docs/authenticate/passwordless/implement-login/embedded-login/relevant-api-endpoints): 실제 전달/운영 조건. 메일 전송 ACK는 로그인이나 전달 완료의 증거가 아니다.
- [Supabase 지역](https://supabase.com/docs/guides/platform/regions), [Auth0 tenant 지역](https://auth0.com/docs/get-started/auth0-overview/create-tenants): 인증 지역 후보와 메일/전체 서비스의 국내 보관을 구분한다.
- [Google App Audience](https://support.google.com/cloud/answer/15549945?hl=en): 기본 프로필 범위의 Sign in with Google에는 Testing 모드의 trusted user 목록 예외가 있다. Google Testing 설정을 지정 내부 계정의 최종 접근 gate로 사용하지 않고 앱 서비스가 현재 AccountId/허용 수단을 검사해야 한다.

상기 문서 기능·공개 코드·가격 조건은 확인 시점의 근거다. 원 source의 commit과 운영 배포의 버전이 같다고 가정하지 않는다. 일반 사용자 접근·계정 추가 기능의 운영 허가는 Q23-A에서 확대하지 않는다.

## 격리 검증의 준비 사례 — 모두 NOT RUN

1. 같은 이메일 Google/OTP를 추가 선택 없이 로그인: 기존 앱 계정 접근/무료 재지급 없음.
2. OTP→Google 추가: 현재/새 수단 접근·의도 증명 뒤 같은 AccountId 유지.
3. Google→OTP 추가: 동일/다른 이메일 각각 확인, email 일치만으로 추가 완료 없음.
4. 새 수단의 다른 앱 계정 바인딩: 거부·두 계정/파일 보존.
5. 증명/binding 조회 불명·충돌: 보류, 자동 생성/합병/권한 없음.
6. 두 탭 동시 같은 수단 추가: 한 binding·현재 권한/세대·원장/소유권 보존.
7. 오입력·만료·재발급 이전 코드·사용 코드: 인증/추가 성공 없음.
8. 증명 후 확인 전 취소·새로고침·callback 재전송: 다른 추가 의도에 증명 재사용 없음.
9. 연결 후 두 수단 재로그인·서명 파일 복원: 같은 앱 AccountId만 자기 파일 복원, 다른 계정 거부.

실험 대상 tenant·정확한 제품/버전·credential/메일 수신 범위·비용과 실행 승인은 아직 정하지 않았다. 현재는 공식 근거와 검증 목표를 준비했고 실제 인증 실행·제품 선정은 하지 않았다. 세션 수명·수단 상실 복구·해제 정책도 별도다.
