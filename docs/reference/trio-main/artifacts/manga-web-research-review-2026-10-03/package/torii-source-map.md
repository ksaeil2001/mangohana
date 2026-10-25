# Torii Source Discovery Map

> 후속 확인: 초기 접근 제한·미실행 상태는 [torii-discord-runtime-evidence.md](torii-discord-runtime-evidence.md)에서 갱신했다. 아래 정적 관찰은 당시 상태로 보존한다.
> 공식 Discord에서 자체 OCR/optimized LaMa/Pillow 발언과 최신 공지를 확인했다. 초기의 서버 renderer UNKNOWN은 해당 진술 범위만 보강되었으며 정확한 구현은 여전히 미확인이다.


조사 기준일: 2026-09-27 (KST). 이 문서는 Torii만 다루며 Ichigo 자료를 혼합하지 않는다. 검색 결과 snippet은 후보 발견에만 사용했고, 아래 핵심 항목은 원문 페이지를 열어 확인했다.

## Official

- [Main](https://toriitranslate.com/) — manga/manhwa/webtoon 이미지 번역, 웹 업로드, 확장 프로그램, 다중 플랫폼 설명.
- [Image workspace](https://toriitranslate.com/image) — PNG/JPG/WEBP/ZIP/PDF/TORII 입력, 모델·폰트·언어·context/BYOK 설정, 편집기/내보내기 UI.
- [How to use](https://toriitranslate.com/install) — hover 번역, 자동 페이지 번역, 다운로드, 화면 crop, batch, cleaning, context sharing, edit/OCR/inpaint 도구.
- [API documentation](https://toriitranslate.com/api) — 공개 endpoint와 form-data/응답 구조를 확인할 수 있으나 호출에는 API key가 필요하다.
- [Pricing/FAQ](https://toriitranslate.com/pricing) — credit, 로그인, API/RapidAPI, 캐시 및 Discord 관련 FAQ.
- [Updates](https://toriitranslate.com/updates) — 2024–2026 버전별 기능·가격·모델 변경 기록.
- [Privacy](https://toriitranslate.com/privacy) — Firebase Auth/Firestore, GCP/Cloud Storage, Lemon Squeezy, AI provider, local extension storage와 데이터 처리 고지.
- [Products](https://toriitranslate.com/products) — Images, Visual Novels, Text, Documents, API 제품군.
- 공개 커뮤니티 링크: 사이트/문서의 `Join the community`가 Discord 초대 링크로 연결된다. 서버 내부 게시물은 비로그인 원문 확인이 불가해 UNKNOWN으로 남긴다.

## API / Developer

- [Torii Image Translator API](https://toriitranslate.com/api): `POST https://api.toriitranslate.com/api/v2/upload`, `/api/v2/ocr`, `/api/inpaint`, `/api/typeset`, `GET /api/credits`, `/api/usage`, `POST /api/credits/share`가 문서에 제시된다. 인증은 Bearer API key.
- [RapidAPI Torii OCR](https://rapidapi.com/stringieee/api/torii-ocr/playground): 개발자 username `stringieee`와 OCR API 상품 단서. RapidAPI 원문 페이지는 playground/API 문서이며 Torii 내부 구현 코드의 증거는 아니다.
- BYOK provider 명칭: OpenRouter, OpenAI, Google Gemini, Anthropic Claude, DeepSeek, xAI Grok, local OpenAI-compatible URL.

## Extension Stores

- [Chrome Web Store](https://chromewebstore.google.com/detail/torii-image-translator-%E2%80%94/gkdekajjngdkocgiealohleibhdjhoed?hl=en): extension ID `gkdekajjngdkocgiealohleibhdjhoed`, publisher `stringieee`, 10,000 users, version 2.21.4 / updated 2026-08-01 at observed page, 7.16 MiB, in-app purchases, website toriitranslate.com.
- [Firefox Add-ons version history](https://addons.mozilla.org/en-US/firefox/addon/torii-image-translator/versions/): add-on slug `torii-image-translator`, publisher `stringie`, latest page record version 2.22.4 / 2026-09-20, Firefox 115+ and Android 120+, 7.54 MB. Firefox listing and Chrome listing use slightly different developer spelling; do not silently normalize it.
- [Historical Apple App Store link](https://apps.apple.com/us/app/manga-translate/id6502868308): the developer's historical Reddit post links `Manga Translate`, app ID `6502868308`. This is retained as a historical developer-linked identifier and is not merged with the current official site's App Store destination.
- [Current official-site App Store destination](https://apps.apple.com/us/app/torii-image-translator/id6780277628): the current Torii site links to this listing; app ID `6780277628`, iPhone/iPad/Mac, developer displayed as Antony Kaloferov, 15.7 MB; listing advertises Safari in-image translation, warp/vertical/context/BYOK. The relationship to historical ID `6502868308` is UNKNOWN.
- [Terms](https://toriitranslate.com/terms) and [Cookie Policy](https://toriitranslate.com/cookies): refund/termination/copyright terms and login/analytics cookie purposes.
- [Text Translator](https://toriitranslate.com/text) and [Visual Novel Translator](https://toriitranslate.com/visualnovel): text LLM path, 10,000-character limit, document batching, Windows memory-hook/OCR desktop path.

## Reddit and developer traces

- [r/mangapiracy developer launch](https://www.reddit.com/r/mangapiracy/comments/1i6ksgh): OP says they created Torii Image Translator; Chromium/Firefox desktop/mobile, hover in-page translation, 120+ languages, site bulk translation; comments include a direct RapidAPI OCR link and limitations around protected images/GPU cost.
- [r/manga extension discussion](https://www.reddit.com/r/manga/comments/zb53l5): developer comment says Torii has website bulk translation, and later links Apple app; useful historical product trace, but claims are self-authored Reddit statements.
- [r/mangapiracy OCR discussion](https://www.reddit.com/r/mangapiracy/comments/1i6ksgh): comment feedback describes OCR over-detection and occasional English-to-English restyling; user report, not benchmark evidence.
- [MangaBridge integration post](https://www.reddit.com/r/u_-Zaraky-/comments/1w2q7h0/weebcentral_and_sushiscan_downloader_volume/): third-party desktop app advertises optional Torii translation via own API key and exports PDF/CBZ/ZIP. Integration existence is supported; internal API implementation is not.

## GitHub / third-party

- Searches for `toriitranslate`, `Torii Image Translator`, `torii-ocr`, `toriitranslate.com` did not produce a verified Torii-owned public GitHub repository in this pass. Do not infer source availability from the store's “source code released” wording; Firefox marks it All Rights Reserved.
- Confirmed public third-party clues: RapidAPI OCR and MangaBridge Reddit integration. No verified SDK/package/repository was found.
- The MangaBridge source post links the release repository [Zaraky-project/MangaBridge-Releases](https://github.com/Zaraky-project/MangaBridge-Releases). This confirms a repository/release identity, but its Torii adapter implementation was not independently verified.

## Search chaining performed

1. Product names → official pages, extension stores, Reddit.
2. Store publisher `stringieee` / Firefox developer `stringie` → RapidAPI `stringieee`, Reddit author traces, Chrome metadata.
3. API term `torii-ocr` → RapidAPI OCR page and official API OCR endpoint.
4. Feature terms `BYOK`, `context`, `inpaint`, `typeset`, `TORII file`, `PWA`, `Gemini 3.8 Flash`, `Luna`, `Kimi`, `OneOCR` → official image/API/updates pages.
5. Third-party query `Torii API integration` → MangaBridge public post.

## Login/intervention queue

- Discord server contents and developer identity beyond public store/Reddit traces require login or a browser Take Over; no credentials or cookies were collected.
- Authenticated dashboard/network behavior, API key issuance, billing checkout and real translation execution remain unverified.
