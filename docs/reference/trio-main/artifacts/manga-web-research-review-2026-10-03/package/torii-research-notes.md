# Torii 조사 메모

## 핵심 발견

Torii 공개 자료는 단순 이미지 번역기보다 브라우저 확장 + 웹 batch/editor + API 제품군으로 자신을 제시한다. 다만 이 문서는 제품 UI와 문서에 노출된 계약을 기록할 뿐, 내부 구현을 실제로 실행해 증명한 것은 아니다.

가장 강한 기술 근거는 API 문서다. `/api/v2/upload`가 multipart 이미지와 모델·font·alignment·bubbles-only·prompt·context를 받고, 번역 이미지·inpaint 이미지·text objects·context·잔액·실행 metadata를 반환한다고 명시한다. `/api/v2/ocr`의 polygon/fontsize/angle/color와 `/api/typeset`의 OBB/direction/angle은 manga 텍스트 geometry가 1급 데이터임을 확인한다. 이것은 API 계약에 대한 CONFIRMED evidence이며, OCR 엔진이나 renderer 구현을 뜻하지 않는다.

Privacy 문서는 Firebase Auth/Firestore, GCP/Cloud Storage(`torii-bucket`), Lemon Squeezy, AI provider를 명시한다. 이는 vendor/data-flow 고지로는 강하지만 실제 배포 topology·queue·GPU·DB query를 증명하지 않는다. 이미지와 URL, 언어 설정, error diagnostics를 처리한다고 고지하므로 독립 구현 시 retention·BYOK·민감 이미지 정책을 별도 설계해야 한다.

추가 확인한 법률/제품 원문은 Terms(2026-07-17 갱신), Cookie Policy, Text Translator, Visual Novel Translator, Apple App Store다. 현재 Torii 공식 사이트가 연결하는 Apple listing은 ID `6780277628`이고 developer 표기가 `Antony Kaloferov`로 나타나 Chrome/Firefox publisher 표기와 불일치한다. 과거 Reddit 게시물의 `Manga Translate` ID `6502868308`도 별도 historical 단서이며, 두 앱의 동일성이나 migration 관계는 UNKNOWN으로 유지했다.

확장 프로그램은 Chrome ID `gkdekajjngdkocgiealohleibhdjhoed`, Firefox slug `torii-image-translator`로 식별된다. Chrome publisher가 `stringieee`, Firefox author가 `stringie`로 표기되어 username을 같은 사람으로 단정하지 않고 연결 단서로만 기록했다. Reddit의 자기소개와 RapidAPI username `stringieee`가 연결되지만 법적/계정 동일성은 확인하지 않았다.

## 시간축

- 2024-08: Chrome 제한으로 원본 이미지를 재다운로드할 수 없는 사이트를 위해 screenshot capture 경로를 추가했다는 업데이트.
- 2025-01: 가격을 text-dependent credit에서 image=1 credit으로 단순화하고 신규 subscription을 제거했다는 업데이트.
- 2025-07~09: PDF/project export, legacy inpaint, manual OCR, 모델 교체가 이어졌다.
- 2026-05: BYOK, self-hosted OpenAI-compatible URL, all-images editing이 공개 업데이트에 등장.
- 2026-08~09: Chrome/Firefox store release가 계속되고, latest updates에는 detail/fallback/timing panel과 추가 모델이 기록된다.

이 시간축은 “현재 구조”를 단일 시점으로 확정하지 말아야 함을 보여준다. 예전 subscription, GPT-4, Gemini variants 관련 자료는 historical record로만 사용한다.

날짜는 업데이트 원문 표기 `DD/MM/YY`를 기준으로 정정했다. 예를 들어 v2.0.9.1의 `09/10/25`는 2025-10-09이며, v2.0.6.1의 `09/07/25`에는 PDF 업로드·legacy inpaint·project import/export가 함께 기재되어 있다. v2.0.7.1의 `11/08/25`는 별도의 GPT-5/DeepSeek/Claude/PNG/shortcut 변경 묶음이다.

## 재검색 결과와 남은 단서

1차 키워드: `Torii Translate`, `toriitranslate.com`, `Torii Image Translator` → 공식 페이지/스토어/Reddit.

2차 키워드: `stringieee`, `stringie`, `torii-ocr`, `Torii API`, `RapidAPI` → RapidAPI OCR와 개발자 Reddit 댓글.

3차 키워드: `BYOK`, `self-hosted`, `x-byok`, `context chain`, `inpaint`, `typeset`, `TORII file`, `PWA`, `MangaBridge` → API 세부 계약·업데이트·제3자 integration.

GitHub에서는 검증된 Torii 소유 repository를 발견하지 못했다. 검색 부재를 negative proof로 사용하지 않는다. Discord 초대 링크는 존재하지만 내부 자료는 로그인/Take Over 대상이다.

MangaBridge는 Reddit 원문이 `Zaraky-project/MangaBridge-Releases` 저장소를 직접 연결하므로 release repository 존재까지 확인했다. 다만 저장소의 Torii API adapter 코드는 아직 독립 검증하지 않았고, integration은 Reddit 작성자의 공개 설명 수준이다.

OneOCR는 2026-09-13 공식 v2.22.2 release note의 “new models” lineup에 이름으로 들어간다. 따라서 `OneOCR가 현재 선택 가능한 lineup item으로 공개됐다`는 것은 CONFIRMED다. 반면 vendor, model card, endpoint, OCR-only 역할은 찾지 못했으므로 `Torii OCR provider=OneOCR` 또는 `OneOCR가 detector 구현`은 UNKNOWN/HYPOTHESIS로 유지한다. 같은 release note가 Gemini 3.8 Flash/Luna/Kimi와 함께 이를 모델 목록으로 표현하지만, 모델과 OCR provider의 구분은 공개되지 않는다.

## 분석자가 유지해야 할 경계

- UI에 모델 목록이 보인다는 사실은 해당 모델의 live execution 증명이 아니다.
- API 문서의 endpoint/response는 공개 contract이며, 실제 서버 성공·queue·provider routing은 미검증이다.
- Reddit 사용자 평가와 developer claim은 각각 출처 수준을 낮춰 기록한다.
- API key, cookie, token, 로그인 정보는 요청하거나 수집하지 않는다.

## 원문 링크 묶음

[Main](https://toriitranslate.com/) · [API](https://toriitranslate.com/api) · [Image](https://toriitranslate.com/image) · [Install](https://toriitranslate.com/install) · [Updates](https://toriitranslate.com/updates) · [Pricing](https://toriitranslate.com/pricing) · [Privacy](https://toriitranslate.com/privacy) · [Chrome](https://chromewebstore.google.com/detail/torii-image-translator-%E2%80%94/gkdekajjngdkocgiealohleibhdjhoed) · [Firefox](https://addons.mozilla.org/en-US/firefox/addon/torii-image-translator/versions/) · [RapidAPI OCR](https://rapidapi.com/stringieee/api/torii-ocr/playground) · [Reddit developer post](https://www.reddit.com/r/mangapiracy/comments/1i6ksgh/)
