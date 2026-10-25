# Ichigo — 직접 관찰한 웹·클라이언트 추가 증거

> 후속 확인: 초기 접근 제한·미실행 상태는 [ichigo-runtime-evidence.md](ichigo-runtime-evidence.md)에서 갱신했다. 아래 정적 관찰은 당시 상태로 보존한다.


관찰일 2026-09-27 KST. 본 장부 I-001~I-038과 구분되는 추가 ID다. 공식 UI에 모델명이 보이는 사실과 실제 provider/model 실행은 다르다.

| ID | 원문 / 작성자 | 날짜·버전 | 확인한 사실 | 기술적 의미와 한계 | 분류 |
|---|---|---|---|---|---|
| I-100 | [공식 홈페이지](https://ichigo.moe/) / Ichigo | 2026-09-27 관찰 | 웹 UI 직접 열람; 정적 본문 추출 도구에서는 내용 없음 | client-rendered web surface. 이것만으로 SPA framework 특정하지 않음 | CONFIRMED — browser UI |
| I-101 | [공개 JS](https://ichigo.moe/public/assets/index-5d230f12.js) / Ichigo | bundle SHA 별도 표기 | React production license, React/ReactDOM 18.2.0 version, createRoot, styled-components error reference 확인 | 현재 배포 웹 번들에 해당 라이브러리 포함. 전체 source framework/build version은 별도 | CONFIRMED — public asset |
| I-102 | [공개 JS](https://ichigo.moe/public/assets/index-5d230f12.js) / Ichigo | 같은 관찰 | modulepreload polyfill이 MutationObserver를 사용 | 이 발생 위치는 이미지 탐지 증거가 아님. Vite는 유사 패턴이나 단독 확정 불가 | CONFIRMED — limited code context |
| I-103 | [홈페이지](https://ichigo.moe/) / Ichigo | HTTP last-modified 2026-09-25 | Server=uvicorn header, Stripe buy-button.js 로드 | header 표기와 결제 스크립트 존재. FastAPI/DB/실제 결제·webhook을 특정할 수 없음 | CONFIRMED — HTTP/HTML |
| I-104 | [업로드 화면](https://ichigo.moe/upload) / Ichigo | 2026-09-27 | 다중 file input의 accept는 PDF/CBZ/ZIP 및 PNG/WEBP/AVIF/JPEG/JPG/GIF/BMP/TIF/TIFF | 브라우저 입력 계약. 모든 형식 처리 성공을 시험한 것은 아님 | CONFIRMED — DOM |
| I-105 | [업로드 화면](https://ichigo.moe/upload) / Ichigo | 같은 관찰 | 로그인 전 남은 사용량 5, 자동 다운로드 기본 체크 | 익명 UX의 관찰. 기간·quota backend enforcement는 UNKNOWN | CONFIRMED — browser UI |
| I-106 | [모델 메뉴](https://ichigo.moe/upload) / Ichigo | 같은 관찰 | GPT-6 Luna, Kimi K2.6, Muse Spark 1.2, DeepSeek v4 Pro, Gemini 3.7 Flash, GPT-6 Sol, Gemini 3.1 Pro 표시; 일부 tier 잠금 | 서비스가 노출한 표시명만 기록. 실제 공급자·model ID·실행 모델은 검증되지 않음 | CONFIRMED — UI labels only |
| I-107 | [구독 화면](https://ichigo.moe/subscription) / Ichigo | 같은 관찰 | 무료 표시 40 extension/20 upload; 월 Tier1 $5.99, Tier2 $19.99; 시간당 이미지 수 제약 표기 | 광고 quota와 I-105가 다름. 계정/모델/세션 차이 가설을 사실로 채우지 않음 | CONFIRMED — published UI |
| I-108 | [Unlocker](https://ichigo.moe/unlocker) / Ichigo | 같은 관찰 | Windows Chrome/Opera용 별도 브라우저 바로가기·프로필 생성 후 extension 재설치라는 안내 | 정상 UI 설명. 실제 실행/flags/DRM 관련 기능은 UNKNOWN; EXE 미실행 | CONFIRMED — product instructions |
| I-109 | [Unlocker](https://ichigo.moe/unlocker) / Ichigo | 같은 관찰 | 설치 파일은 f005.backblazeb2.com의 ichigo-public 링크 | 배포 파일 저장소 단서. 사용자 이미지 저장소로 주장하지 않음 | CONFIRMED — official link |
| I-110 | [웹 번들](https://ichigo.moe/public/assets/index-5d230f12.js) / Ichigo | 같은 관찰 | canvas/WebGL 위치는 브라우저 식별 특성 확인에 쓰임; indexedDB 첫 위치는 기능 존재 검사 | 단어 출현으로 renderer·영속 저장 사용을 확정할 수 없음 | CONFIRMED — limited code context |
| I-111 | [공식 웹 origin](https://ichigo.moe/) / Ichigo | 같은 브라우저 세션 | 자동 POST /auth/refresh→401, GET /metrics→200 관찰 | 익명 세션 초기화 요청만 확인. query의 식별 값/쿠키/토큰/헤더는 장부에 남기지 않음 | CONFIRMED — normal initial network |
| I-112 | [api 경로](https://ichigo.moe/api) / Ichigo | 같은 관찰 | 번들에 등장한 경로를 정상 열었으나 HTTP404 화면 | 해당 페이지에 문서 없음. API 자체 부재를 증명하지 않음 | CONFIRMED — HTTP/UI |
| I-113 | [AMO 공식 JSON](https://addons.mozilla.org/api/v5/addons/addon/ichigo-manga-translator/) / Mozilla + publisher | v0.0.96 | 현재 공식 XPI hash 검증. locale별 홈페이지는 ichigo.moe 또는 mangatranslator.ai | 배포 identity/domain migration 단서. 모두 같은 배포 backend라는 증거는 아님 | CONFIRMED — metadata |
| I-114 | [공식 XPI](https://addons.mozilla.org/firefox/downloads/file/5049619/ichigo_manga_translator-0.0.96.xpi) / publisher | v0.0.96 | MV3, background.scripts, all_frames content scripts, cookies/scripting/storage/tabs/DNR/all_urls | Firefox 배포 아티팩트 구조. Chrome binary 구조는 별도 검증 필요 | CONFIRMED — manifest |
| I-115 | [GitHub annotation repo](https://github.com/Ichigo-Labs/ichigo-annotate) / Ichigo-Labs | observed 2026-09-27 | tablet-oriented YOLO annotation 도구, Vite 설정·TypeScript source·tests·architecture 문서 공개 | 보조 데이터 도구 증거. Ichigo 서비스가 YOLO를 production detector로 쓴다는 근거는 없음 | CONFIRMED — adjacent repository |
| I-116 | [GitHub SNN repo](https://github.com/Ichigo-Labs/snn) / Ichigo-Labs | 같은 관찰 | C/CUDA spiking neural network library와 MNIST/KMNIST 실험 설명 | OCR 서비스 구현과 연결되지 않음. 조직의 모든 repo를 production 기술 스택으로 합치지 않음 | CONFIRMED — adjacent repository |

## 재현 식별자

- 웹 JS SHA-256: `592dfc0ba375a309b05905e2564eda160a15ede3203878776b0c04ba07dc76ee`.
- Firefox XPI SHA-256: `b47ec80f56532071ddc26726317f0b32a9dac7d936a4be048bce055ee1daa195`.
- [확장 프로그램 상세 증거](ichigo-extension-evidence.md)에 code path와 파일 offset을 별도 기록했다.

## 테스트 실행의 제한

사용자가 합성 이미지 1장 무료 업로드를 승인했다. 첫 브라우저는 파일 선택 단계에서 연결이 종료됐고, 대체 in-app browser에서는 file chooser가 열리지 않았다. 반환된 번역 결과나 성공한 서버 요청이 없으므로 업로드 성공·OCR 품질·latency를 기록하지 않는다. 이는 관찰 환경의 제한이며 서비스 전체 장애라고 단정할 근거가 아니다. **RUNTIME-UNVERIFIED**.
