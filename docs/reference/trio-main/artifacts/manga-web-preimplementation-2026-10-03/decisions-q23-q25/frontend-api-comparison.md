# 첫 화면·API 상세 설계 후보 비교

확인일: 2026-10-03. 범위: 공식 문서 읽기와 기존 확정 계약의 적합성 비교. 최초 작성 시점은 아직 선택 질문을 발송/확정하지 않았고 프로젝트 생성·설치·실행·배포는 하지 않았다.

NotebookLM 준비 원칙의 '필요한 전체 흐름·책임·근거를 먼저 연결'을 적용한다. 인기나 강사의 선호만으로 제품을 채택하지 않는다. Q20-A의 Postgres 권위/별도 TypeScript 실행서버, Q38-A의 Auth0 우선 검토, 내부 테스트 계정 전체 흐름·현재 정책을 두 안에 같은 입력으로 둔다.

| 공식 원출처 | 확인한 설명 | 이번 후보에 적용하는 범위/한계 |
| --- | --- | --- |
| [Vite 시작 가이드](https://vite.dev/guide/) | 개발 서버/빌드 도구, React TypeScript template과 Node 최소 호환 조건 설명 | React/TypeScript 화면 빌드 후보의 근거. API/인증/DB·브라우저 실제 적합성이나 최종 버전 선택의 증거는 아님 |
| [Vite 정적 배포](https://vite.dev/guide/static-deploy.html) | 정적 build 배포와 preview 용도. preview를 production server로 사용하지 않음 | 실제 정적 파일 제공/API/auth proxy를 별도 운영 경계로 설계. deploy 가이드를 이번 배포 지시로 실행하지 않음 |
| [Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers) | app 안의 route.ts, Request/Response 기반 HTTP method, 기본 uncached와 GET 명시 cache/Cache Components의 조건 | Node web/API를 같은 프로젝트에 작성하는 후보의 근거. 기본 cache를 현재 계정/편집 권한의 대체 근거로 사용하지 않음 |
| [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting) | next start/자체 호스팅, proxy·환경/이미지·cache/여러 instance 운영과 shutdown/after 설명 | Next.js 후보에 Vercel 구매를 전제로 하지 않음. after callback/짧은 drain 설명이 durable AI request/재시작/수행불명 복구 보장은 아님 |

원출처는 기능 설명이다. 아래 책임 분리·우선 추천과 검증은 우리 프로젝트의 제안/추론이다. 특정 SDK/hosting/가격/무료 운영·이미지 품질을 확인한 결과가 아니다. 조회한 웹 문서는 날짜 기준이며 실제 채택 버전의 호환 문서/lockfile를 구현 인계에서 다시 확인한다.

| 비교 | A: React+Vite+TypeScript 화면/Node API | B: Next.js+TypeScript Node 화면/API |
| --- | --- | --- |
| 화면/API 책임 | browser UI는 현재 상태/명령/파일 전달을 표시. 별도 Node API가 인증/계정/명령/권한·Postgres를 소유 | Client UI와 server Route Handler의 같은 web 프로젝트. server 코드가 인증/계정/명령/권한·Postgres를 소유 |
| 긴 AI/이미지 처리 | 두 안 모두 별도 TypeScript worker·Postgres의 실행/기한/정산 권위. 브라우저 타이머/HTTP 응답 생명주기에 맡기지 않음 | A와 같음. Route Handler/after를 원 수행/비용 대조 및 durable step 저장의 대체 수단으로 쓰지 않음 |
| 배포/브라우저 세션 | 정적 UI/API를 같은 앱 origin의 경로로 제공하는 후보. API/auth server/cookie·CSRF/배포 방법은 상세 확인 필요 | Node web/API를 같은 앱 origin으로 제공하는 후보. server/client·user-specific cache/secret 경계를 상세 확인 |
| 기존 맥락 | 현재 Trio의 React/TypeScript 경험을 새 웹의 화면 구현에 활용할 후보. Electron IPC/로컬 파일/현재 App.tsx를 그대로 연결하거나 변경하지 않음 | React 경험 유지. App Router/server-client 경계·Route Handler/cache·build/운영을 새 프로젝트에 적용 |
| 첫 범위와 검증 부담 | 로그인 뒤 이미지 편집 워크벤치 중심 범위에서 화면과 API/worker 책임을 직접 드러냄. routing/projection/상태 갱신/validation은 별도 구성 | 화면/API/routing 구성의 통합 후보. 현재 계정 상태/직접 명령·보호 자산·캐시/여러 instance/서버 경계를 추가로 확인 |
| 선택으로 정하지 않는 것 | API framework/DB driver/validation·canvas/font·host/storage/버전/명령·인증 제품 최종 채택·설치/지출 | 같은 경계. SDK 기본 session/cache가 Q39/Q48을 충족한다고 가정하지 않음 |

첫 상세 설계 기준으로 A를 우선 제안한다. 첫 범위가 내부 계정의 PC/태블릿 이미지 작업 화면이며, 화면은 projection/명령을 쓰고 권한/실행은 API/worker/Postgres가 소유하는 현재 책임 모델에 대응하기 때문이다. 이것은 A가 더 빠르거나 저렴하다는 실측 결론이 아니다. B도 Node 호스팅/별도 worker/서비스 검증 경계를 유지하는 같은 단계의 대안이다.

## 선택 뒤의 첫 구현 흐름 준비

1. 로그인 evidence→지정 내부 AccountId/AppSession→현재 계정/접근 조회. fake credential/isolated fixture 단계와 실제 provider 단계 구분.
2. 한 live context/명시 owner→정지 PNG/JPEG 검증/순서 미리보기·중복 선택→원자적 후보 반영.
3. 설정/version·대상 캡처→DB claim/외부 발행 guard/수행불명 대조→확정 결과/독립 정산 표시.
4. 다른 페이지 편집·잠금/미래 설정·Undo·현재 결과 ZIP·실제 library 보관과 삭제.
5. 프로젝트 파일 서명/현재 접근/필수 자산→사용자 보관 확인/정상 종료→새 맥락 복원.

이 순서는 새 첫 기준 흐름이며 구현 승인/전체 기능 완료가 아니다. 기존 G01~G08/H01~H06의 남은 정책·공정·기술/환경·구체 인터페이스·검증·비용/권한 gate를 먼저 연결한다.

## 적합성 사례 — 모두 NOT RUN

| ID | 확인할 경계 |
| --- | --- |
| FAV01 | refresh/깊은 경로/앱 origin·OTP/Google callback/session cookie와 iPad Safari를 실제 확인. 브라우저/서버 secret·현재 AccountId guard·앱7일 우회 없음 |
| FAV02 | stale projection/탭 인계/HTTP 응답 유실/서버 restart. 현재 service 권한/동일 명령 조회와 worker/PG 수행·대기 clock 보존 |
| FAV03 | build·API/server client/환경·user-specific cache/자산 URL·30일 삭제·동시 instance. public bundle secret/project content 누출·다른 계정 결과·만료 자산 제공 없음 |
| FAV04 | Chrome/Edge/Android/iPad의 실제 pointer/touch·입력·대형 이미지·파일 전달/원본 비교와 새 설정/구성 잠금. 자동화 엔진 PASS를 실제 기기 PASS로 확대하지 않음 |

현재 계정 동시 context 수/로그아웃 범위는 아직 미선택이며 후보 UI 구조로 조용히 확정하지 않는다. 서비스 응답/오류 타입·코드/host/container/버전·실행 명령·CI와 이 사례의 관측·실패 대응은 선정 뒤 구현 인계에서 좁힌다.

후속 Q54-A를 실제 응답으로 선택해 React/Vite/TypeScript 화면+Node API를 첫 상세 기준으로 정했다. architect는 두 후보의 같은 계약/단계·추천의 실측 아님·미선택 정책 보존 경계를 재확인했으며 공식 웹 원출처를 외부 재조회한 결과는 아니다.

현재 Q53-A 계정 전체 한 live 맥락·Q52-B 현재/모든 앱 logout은 별도 선택으로 연결했다. 버전/API framework/host/설치·FAV 실제 적합성은 NOT RUN이다. 이 비교표 최초 미선택 상태/대안은 질문 당시 근거이며 선택의 원본은 Domain Story59.19다.
