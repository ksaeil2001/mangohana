# 누락 정보원 재검색·개입 대기 목록

> **2026-09-27 최종 갱신:** 아래 초기 로그인 대기 기록은 해소된 역사적 상태다. 사용자가 정상 로그인 및 Torii 기존 credit 한 장 사용을 허용했고, Torii Discord 원문과 양쪽 한 장 실제 번역을 확인했다. 현재 필요한 사용자 개입은 없다. 최신 판정은 [Torii 추가 원장](torii-discord-runtime-evidence.md), [Ichigo 실행](ichigo-runtime-evidence.md), [최종 보고서](10-final-report.md)를 우선한다.

## 최종 미확인 범위와 탐색 종료 기준

- Torii 자체 OCR 진술, optimized LaMa, Pillow는 T-205/206/207로 보강했다. 정확한 checkpoint·최적화·private prompt·queue/GPU topology는 UNKNOWN이다.
- Ichigo의 named model/Ichigo-Labs annotation/Android package까지 추가 추적했으나 production import·provider·DB·queue·inpaint로 이어지는 직접 근거가 없다. [재검색 세부](ichigo-final-gaps.md).
- 새로 얻은 `Torii + LaMa/Pillow`, `ichigo-gemma-3-27b-it`, `ichigo-qwen3-vl-235b-A22b-instruct`를 재검색했다. 추가 독립 검증 자료를 찾지 못했고 base model/원래 댓글로 되돌아왔다. 검색 실패는 기술 부재의 증명이 아니다.
- public API 직접 유료 호출, extension 설치/runtime, native app 실행, PDF/ZIP·full-context 품질, 서버 데이터 삭제 실효성은 미검증이다. 한 장 성공이 이 범위를 대신하지 않는다.
- 원 서비스의 비공개 코드/credential 접근이나 권한 확대 없이 조사할 수 있는 핵심 단서는 원문 확인·재검색 결과를 남겼다. 이후 새 공개 release/source가 나오면 evidence revision으로 갱신할 수 있다. 인터넷 전체를 소진했다는 뜻은 아니다.
- 계정 잔액으로 Torii 추가 테스트, 새 결제/구독, third-party 계정 변경은 하지 않았다. 사용자가 승인한 Torii 한 장 1.10 credit과 Ichigo 익명 한 장만 수행했다.

## 이하 초기 단계 기록 (현재 상태로 해석하지 말 것)


기준: 2026-09-27 KST. 공개 자료 수집을 전체 조사 완료나 Production 설계 완료로 표시하지 않는다. 현재는 사용자 지정 순서 중 1~5단계의 산출물을 저장한 상태다.

## 실제 개입이 필요한 지점

| 대상 | 확인한 차단점 | 필요한 사용자 행동 | 개입 뒤 확인할 범위 |
|---|---|---|---|
| Torii 실번역 | 이미지 업로드 클릭 → `/login?to=image`로 이동 | [Torii 로그인](https://toriitranslate.com/login?to=image)을 브라우저에서 직접 완료 | 승인된 합성 이미지 한 장만, 무료 credits 범위. 요청 method/path/schema, 결과 유형, 단계별 표시, 전체 소요시간 |
| Torii Discord | [공식 초대](https://discord.gg/HGQngYJ4VZ)는 정상 열림; 기술 채널은 로그인 필요 | 기존 계정으로 정상 로그인 및 서버 접근 | 개발자 공지/업데이트/API/OCR/renderer/GPU 관련 게시물. 일반 사용자 대화 일괄 수집 금지 |
| Ichigo 실번역 | 첫 브라우저의 파일 선택 도구 연결 종료; 대체 브라우저의 파일 선택기 열기 실패 | 필요하면 사용자 Take Over로 파일 선택. 현재 실패를 로그인 문제로 단정하지 않음 | 승인된 합성 이미지 한 장. 성공 응답·OCR·렌더링·quota 변화를 확인하기 전까지 미검증 |

로그인과 2FA는 사용자 직접 입력. 비밀번호·인증코드·쿠키·토큰·API key 값을 채팅으로 요구하지 않는다. 기존 무료 사용량으로 불가능하면 결제·구독을 시작하지 않는다. 사용자는 합성 이미지 무료 업로드만 승인했으며 paid 호출·extension 설치의 광범위 권한 부여는 수행하지 않았다.

## 동일 기준 정보원 점검

| 정보원 | Torii | Ichigo | 남은 한계 |
|---|---|---|---|
| 공식 제품·기능 | 메인/image/install/text/document/VN/API/updates | 메인/upload/subscription/unlocker | 노출 UI·광고와 runtime 결과 구분 |
| Privacy/Terms | policy/cookies/terms 원문 | TOS/EULA + store declarations | 데이터 보관 실측·삭제 검증 없음 |
| Chrome Store | ID·게시자·버전·날짜 | ID·게시자·버전·날짜 | Chrome package 자체를 Firefox package와 동일시하지 않음 |
| Firefox Add-ons | 공식 API·XPI SHA·Manifest·선별 code path | 공식 API·XPI SHA·Manifest·선별 code path | extension 설치/runtime 미검증 |
| Apple/Android | Apple listing, Firefox Android 안내 | App Store + Google Play package/release | 네이티브 앱 내부 프레임워크 UNKNOWN |
| Reddit | 원문·개발자 댓글·사용자 보고 | 원문·자기소개 댓글·사용자 보고 | 개별 댓글 시각 미확인 항목을 게시물 날짜로 덮지 않음 |
| 개발자 연결 | 공식 사이트→store→Discord; Reddit 자기소개 | 공식 store 회사·historical publisher·org | 유사 username만으로 동일인 확정 금지 |
| GitHub | 제품 소유 repo 미발견, integration 단서 추적 | Ichigo-Labs 보조 repo | production 서버 source 확인되지 않음 |
| 제3자 integration | RapidAPI, MangaBridge-Releases 단서 | 공개 issue mention; SDK 미발견 | 관련 언급과 실제 adapter 구현 증거 분리 |
| 공개 API | 문서 endpoint/schema 확인 | 지원되는 public developer API 문서 미발견 | 내부 client route가 지원 API라는 뜻은 아님 |
| 공개 client | HTML dependency·official XPI path | React bundle·official XPI path | raw secret 값·auth storage contents는 조사하지 않음 |
| Network | 정적 request construction, 로그인 gate | 초기 익명 요청 + 정적 request construction | translation 성공 응답 아직 미관찰 |
| Discord | 공식 초대 확인·로그인 대기 | 여러 제품명/domain 변형 검색했으나 공식 공개 초대 미발견 | 검색 부재를 Discord 부재로 단정하지 않음 |

## 재검색으로 좁혀진 질문

1. **Torii OCR가 무엇인가?** API geometry 계약과 과거 OCR/GPU 비용 발언 확인. 업데이트의 OneOCR 및 manual OCR 모델 표기는 범위를 제한해야 한다. 전체 자동 pipeline의 detector/OCR 단일 엔진 이름은 아직 확정하지 못했다.
2. **Torii renderer는 어디에 있는가?** 최신 업데이트의 공유 editor·서버 일치 renderer 주장과 Firefox client Canvas 경로 확인. 실제 서버 renderer 언어/library와 pixel parity는 아직 UNKNOWN.
3. **Ichigo가 YOLO를 쓰는가?** annotation repository는 YOLO format 도구다. production 모델 사용·훈련 데이터·배포 경로로 이어지는 증거가 없어 실제 detector는 UNKNOWN.
4. **Ichigo 저장소가 Backblaze인가?** 공개 URL은 Unlocker 배포 파일이다. 사용자 이미지 object store 기술로 확정하지 않는다.
5. **Ichigo Backend가 FastAPI인가?** `Server: uvicorn` header 확인. header 단독으로 application framework를 특정하지 않는다.
6. **각 서비스 queue 기술은?** client retry/concurrency와 실제 worker queue 구현을 구분한다. Redis/Celery/BullMQ/SQS 어느 것도 확정하지 않았다.
7. **웹 모델 메뉴가 실제 모델 증거인가?** 해당 문자열을 제공한다는 사실만 CONFIRMED. 선택→server execution→provider evidence가 확보되기 전에는 실제 모델 실행으로 확대하지 않는다.

## 증거 충돌·시간축

- Torii 과거 fast/CPU inpainting 발언과 이후 GPU inpainting release는 migration으로 다룬다.
- Torii 과거 BYOK 미지원 발언과 이후 BYOK/self-hosted 지원 역시 시점 차이를 남긴다.
- Torii 2026년 local image history 전환과 privacy의 debug storage 예외는 별도로 기록한다. “서버에 아무 이미지도 안 남는다”로 요약하지 않는다.
- Ichigo 구독 안내의 무료 20 upload와 익명 UI의 Remaining 5는 서로 다른 관찰이다. 이유는 확인 전까지 UNKNOWN.
- Chrome/Firefox/store index/crawl 날짜는 다를 수 있으므로 단일 “현재 최신 버전”으로 합치지 않는다.
- 개발자의 경쟁 서비스 품질 평가는 이해관계자의 주장이다. 독립 head-to-head 품질 점수로 사용하지 않는다.

## 재개 순서

1. 사용자 로그인/보류 선택을 반영하고, 승인 범위의 한 장 테스트를 완료하거나 불가 사유를 확정한다.
2. Discord에서 공개적으로 접근 가능한 개발자 기술 자료만 조사하여 시점·permalink·짧은 evidence를 기록한다.
3. 양쪽 source/ledger와 최신 XPI의 code path를 대조하고 남은 중요한 공개 단서를 다시 추적한다.
4. 그 뒤 서비스별 Confirmed/Inferred/Unknown architecture를 각각 재구성한다.
5. 동일 component matrix → 독립 PROPOSED 설계 → 기술 prototype → MVP/Production roadmap 순서로 계속한다.

현재 독립 기술 prototype이나 Production blueprint를 완성했다고 주장하지 않는다. 생성한 일본어 이미지는 조사용 fixture이며 실제 OCR·번역 구현체가 아니다.
