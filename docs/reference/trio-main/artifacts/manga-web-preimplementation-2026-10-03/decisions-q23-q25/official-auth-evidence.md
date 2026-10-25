# 이번 인증 후보 공식 문서 근거

확인일: 2026-10-03. 공개 원문 읽기만 수행했다. 제품 채택·메일 발송·OAuth/세션 생성·Auth 설정 변경을 하지 않았다.

| 원출처 | 직접 확인한 설명 | 선택과 연결할 점·미확인 |
| --- | --- | --- |
| [Supabase 이메일 passwordless](https://supabase.com/docs/guides/auth/auth-email-passwordless) | 이메일 일회용 코드와 magic link 지원. 메일 전송 성공 응답의 user/session과 코드 검증 후의 로그인 세션을 구분. 기본 자동 가입 동작은 설정 대상 | Q26-A의 OTP 후보. 코드 길이·시간·재발급/시도 제한·메일 제공자·실제 가입 제한은 미선정. 전송 성공이 로그인 완료는 아님 |
| [Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking) | 동일 이메일 identity 자동 연결과 로그인 사용자의 OAuth identity 수동 추가를 설명 | Q27-A의 명시적 앱 계정 연결과 별도 비교. 자동 연결 비활성화, Google 계정에 이메일 수단을 추가하는 방향까지 실제 지원/정합성은 미확인 |
| [Supabase 이메일 password](https://supabase.com/docs/guides/auth/passwords) | 비밀번호 가입·이메일 확인·비밀번호 재설정 및 메일 전달 설정의 책임 | Q26-C의 비교 근거였으며 사용자는 Q26-A를 선택했다. 비밀번호 기능을 이번 계약에 추가하지 않음 |

후보의 기능 설명과 앱의 안정된 내부 AccountId 계약을 구분한다. 같은 이메일이나 제공자 identity 자동 연결만으로 앱 원장/파일 소유권의 합병을 허가하지 않는다. Q20-A는 Postgres+TypeScript 실행 기반의 선택이며 Supabase Auth의 선택이 아니다.

인증 제품/버전의 최종 선정, 자동 연결 제어, 양방향 수단 추가, 현재/새 수단의 접근 증명, 충돌·동시 추가·확인 불명의 실제 처리, 코드·세션·메일 운영은 후속 상세 설계와 격리 검증의 대상이다. 문서 읽기로 기능 적합성이나 실행 PASS를 선언하지 않는다.
