# Torii — 직접 관찰한 웹·클라이언트 추가 증거

> 후속 확인: 초기 접근 제한·미실행 상태는 [torii-discord-runtime-evidence.md](torii-discord-runtime-evidence.md)에서 갱신했다. 아래 정적 관찰은 당시 상태로 보존한다.
> 공식 Discord에서 자체 OCR/optimized LaMa/Pillow 발언과 최신 공지를 확인했다. 초기의 서버 renderer UNKNOWN은 해당 진술 범위만 보강되었으며 정확한 구현은 여전히 미확인이다.


관찰일 2026-09-27 KST. 아래 ID는 본 장부 T-001~T-049와 별도 범위를 사용한다. CONFIRMED는 명시한 관찰 범위만 확정하며 서버 내부 구현이나 번역 품질을 확정하지 않는다.

| ID | 원문 / 작성자 | 날짜·버전 | 확인한 사실 | 기술적 의미와 한계 | 분류 |
|---|---|---|---|---|---|
| T-100 | [공식 홈페이지](https://toriitranslate.com/) / Torii | 2026-09-27 관찰 | 공개 HTML이 firebase-app/auth/firestore/analytics compat 스크립트와 tailwind.css를 참조 | 해당 클라이언트 자산 의존성 확인. 프레임워크 전체나 실제 DB 질의 실행 증거는 아님 | CONFIRMED — HTTP/HTML |
| T-101 | [공식 홈페이지](https://toriitranslate.com/) / Torii | 같은 관찰 | 응답 Server=cloudflare, CF-RAY 제공 | 해당 요청의 Cloudflare edge 확인. 원본 API/GPU 서버 위치를 의미하지 않음 | CONFIRMED — HTTP header |
| T-102 | [웹 이미지 작업장](https://toriitranslate.com/image) / Torii | 같은 관찰 | 업로드 파일 유형, 로컬 Translation History와 기본 1주 삭제 옵션을 UI에서 확인 | UI/기본값 확인. 실제 저장·삭제 실행은 하지 않음 | CONFIRMED — browser UI |
| T-103 | [로그인 이동](https://toriitranslate.com/login?to=image) / Torii | 같은 관찰 | 비로그인에서 업로드 영역 클릭 시 이 로그인 페이지로 이동 | 테스트 이미지 파일 선택·서버 전송 전에 인증이 요구됨. 이미지 번역은 아직 미실행 | CONFIRMED — observed navigation |
| T-104 | [로그인](https://toriitranslate.com/login?to=image) / Torii | 같은 관찰 | Google, Apple, email 진입 버튼 노출 | 인증 UX만 확인; 실제 로그인·세션 발급은 사용자 개입 대기 | CONFIRMED — browser UI |
| T-105 | [공식 Discord 초대](https://discord.gg/HGQngYJ4VZ) / Torii→Discord | 같은 관찰 | 서버명 Torii Image Translator, 초대자 stringie 표기. 비로그인에서는 계정 생성·로그인 진입만 제공 | 공식 사이트와 공개 서버 identity 연결. 내부 기술 채널 본문은 읽지 못함 | CONFIRMED — invite UI |
| T-106 | [AMO 공식 JSON](https://addons.mozilla.org/api/v5/addons/addon/torii-image-translator/) / Mozilla + publisher | v2.22.4 | 현재 파일 URL과 SHA-256를 받아 XPI bytes 해시가 일치하는지 검증 | 정상 공개 배포물의 provenance 확보. 설치하거나 실행하지 않음 | CONFIRMED — package metadata |
| T-107 | [공식 XPI](https://addons.mozilla.org/firefox/downloads/file/5043580/torii_image_translator-2.22.4.xpi) / publisher | v2.22.4 | MV3, background.page=bg.html, MAIN/document_start untaint script + content script, popup, all_urls와 선택 downloads | Firefox 아티팩트 구조. Chrome service worker 구조로 일반화할 수 없음 | CONFIRMED — manifest |
| T-108 | [Reddit 원문·댓글](https://www.reddit.com/r/mangapiracy/comments/1i6ksgh/i_made_a_browser_extension_that_translates_manga/) / stringiee | 과거 스레드; 개별 댓글 절대시각 미확인 | 개발자는 당시 OCR GPU가 비용 중심이고 LLM은 번역을 담당한다고 설명. 당시 빠른 inpaint의 번짐도 설명 | 과거 자기 진술. 현행 원가 비율, 모델명, GPU 수 증거로 확대하지 않음 | CONFIRMED — historical statement |

## 관찰의 재현 식별자

- 홈페이지 HTML SHA-256: `4bb0c3c967205150f4a26719c830aa4498d97feadd919a182fd70aec26526caa`.
- Firefox XPI SHA-256: `a2ad439c7391cbe2870d3a752fc41212ab5495ea5a891d774b4e44fd22768afb`.
- 공개 자산 이름은 추적했으나 원본 proprietary JS를 산출물에 복사하지 않았다. 본문 읽기를 403으로 거부한 자산은 우회하지 않았다.
- 상세 Manifest 및 정상 배포 JS 분석은 [Torii extension evidence](torii-extension-evidence.md) 참조.
- 당시 개발자 발언 중 “extension은 탭끼리 통신 불가능” 같은 일반론은 브라우저 플랫폼의 기술적 사실로 채택하지 않는다.

## 실행 경계

사용자는 양쪽 서비스에 합성 테스트 이미지 1장, 무료 범위 업로드를 승인했다. Torii는 파일 선택 이전에 로그인 요구가 확인됐다. 사용자의 인증정보는 읽거나 기록하지 않았다. 실제 OCR·번역·inpainting 결과와 latency는 **RUNTIME-UNVERIFIED**다.
