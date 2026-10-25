# Ichigo Firefox Extension Evidence

관찰일: 2026-09-27 KST. 공식 AMO API와 공식 XPI를 공개 URL에서 내려받아 메모리에서만 ZIP/JS를 읽었다. 설치·실행·endpoint 호출·로그인·토큰 출력은 하지 않았다.

## Package identity

| Field | Evidence |
|---|---|
| Official source | https://addons.mozilla.org/api/v5/addons/addon/ichigo-manga-translator/ |
| XPI | https://addons.mozilla.org/firefox/downloads/file/5049619/ichigo_manga_translator-0.0.96.xpi |
| Version / AMO id | 0.0.96 / 2965030 |
| GUID | manga-translator@mangatranslator.ai |
| SHA-256 | b47ec80f56532071ddc26726317f0b32a9dac7d936a4be048bce055ee1daa195 |
| Size | 2,798,453 bytes |
| Manifest | MV3; content scripts js/content.js and js/setExtensionIcon.js, all frames; background js/background.js; host permissions https://ichigo.moe/*, *://*/*, <all_urls>; required websiteContent data collection declaration |

## Runtime structure observed in normal distributed JS

Offsets are character offsets in the minified file, not source-map line numbers. They are reproducible anchors for this exact XPI SHA.

| File / offset | Observed code marker | What it supports | Classification / boundary |
|---|---|---|---|
| js/content.js 9,638–10,100 | image dimensions, canvas, drawImage, toDataURL, fitToTranslationSize | Page image acquisition rasterizes an image element into resized base64 before translation | CONFIRMED code path; exact selection policy unknown |
| js/content.js 46,376–47,559 | readElementImage, loadImage, base64Data, referrer, translateImage message | Content script packages src, width/height, optional base64, referrer and sends runtime message | CONFIRMED |
| js/content.js 11,638–12,100 | MutationObserver over document/shadow roots | DOM/shadow-root additions are observed for candidate content | CONFIRMED |
| js/content.js 25,687–26,015 | MutationObserver plus ResizeObserver on added image nodes | Newly added images are observed and translation work triggered when active | CONFIRMED |
| js/content.js 32,052–32,400 | IntersectionObserver around visible element | Visibility/lazy processing and overlay layout wait are present | CONFIRMED; batching policy unknown |
| js/content.js 28,551–28,650 | data attributes data-ichigo-original-src, srcset, background image, translated hash | Original/translated image state is written into DOM attributes for reversible tracking | CONFIRMED |
| js/content.js 47,087–47,420 | message kind translateImage with image, translateTo, translationModel, includeBase64Data true; FullQueue retry after 1s | Content/background protocol has a bounded in-extension queue response and retry loop | CONFIRMED |
| js/translationPanel.js 34,299 | message kind translateSnapshot with captureId, dimensions, translateTo, translationModel, viewport and calibration | Panel Tool sends viewport/capture calibration data to background for page snapshot translation | CONFIRMED |
| js/translationPanel.js 32,052 / 45,681 | IntersectionObserver + MutationObserver wait around panel/reader frame | Translation panel waits for visible/connected reader content | CONFIRMED |
| js/background.js 18,476 | captureVisibleTab; fetch(capture).blob(); region/viewport/calibration | Panel flow captures visible tab, crops/normalizes region in background | CONFIRMED |
| js/background.js 54,065 | GET https://ichigo.moe/translate/models/extension; JSON parsed by parseTranslationModelData | Extension retrieves available translation models from official origin | CONFIRMED; no request made |
| js/background.js 54,300–55,150 | POST https://ichigo.moe/translate JSON body | Request keys: base64Images array, translationModel, targetLangCode, fingerprint, clientUuid, pageHost, platform | CONFIRMED static client contract; server unverified |
| js/background.js 55,000–55,550 | response JSON images[0] passed to parseTranslationResults; returned translations | Successful response expected to contain images array; parsed result contains translation regions | CONFIRMED expected shape; exact region schema unknown |
| js/background.js 54,700–55,000 | status handling 400/detail.message, 429/detail.message, 500; 429 maps to out-of-translations | Quota/rate-limit and server errors have explicit UI branches | CONFIRMED |
| js/background.js 24,200–25,900 | accessToken, refreshToken, authSource; chrome.storage.local; localStorage fallback | Auth tokens are kept in extension local storage with fallback and change synchronization | CONFIRMED static code; values not read or printed |
| js/background.js 31,271–32,500 | cookie names/website origins; syncAuthFromWebsite; cookie removal/sync | Extension synchronizes web session cookies with ichigo.moe, ichigoreader.com, mangatranslator.ai | CONFIRMED static code; cookie values never accessed |
| js/background.js 56,000–56,700 | Authorization Bearer header, Client-Version 1.0.1, refresh on 401/403 | Authenticated API wrapper retries after token refresh | CONFIRMED static code; no authorization value collected |
| js/background.js 52,424 | GET /metrics?clientUuid=...&fingerprint=... | Current-user/usage metrics route referenced by client | CONFIRMED route string; no call made |
| js/background.js 52,424–53,100 | login/signup routes and token response tokens.accessToken/tokens.refreshToken | Login/signup client contract expects token object | CONFIRMED static code; auth flow not executed |
| js/translationPanel.js 50,991 | config keys fontFamily, activeUrls, clientUuid, translateToLanguage, translationModel, translationCacheClearFlag | User/client state includes language/model, active URL list, client UUID and cache-clear flag | CONFIRMED |
| js/background.js 28,700–30,600 | chrome.storage.local for config and active URLs; navigator.locks for ichigo-active-urls | Settings and active URL list persist locally; lock serializes URL updates | CONFIRMED |

## Architectural reading with strict limits

Static client evidence supports this current browser flow:

content script / reader frame observation -> image or visible-tab capture -> canvas normalization/base64 -> runtime message -> background auth/rate-limit wrapper -> POST /translate -> images[0] translation-region parsing -> DOM overlay or translation panel rendering.

The extension has explicit panel capture and ordinary image translation paths. The result path exposes translation region data and text placement fields to the renderer, but this XPI alone does not reveal detector/OCR/inpainting provider, reading-order algorithm, server queue, storage, or GPU.

The appearance of MutationObserver, IntersectionObserver, drawImage, OffscreenCanvas, indexedDB, or captureVisibleTab is evidence of those APIs being referenced in a particular file. It is not evidence that any one API is the production detector, OCR, renderer, or persistence backend. No runtime success, server response, or visual translation result was verified.

## Current versus historical migration clues

- Current XPI uses API origin https://ichigo.moe, includes legacy origins https://ichigoreader.com and https://mangatranslator.ai, and has current extension version 0.0.96.
- The public client still contains compatibility links for old Chrome/Firefox listings and legacy domains. This supports domain/brand migration history, not proof that all domains still serve the same backend.
- Current route names and request keys are public static contract observations. Direct endpoint invocation was intentionally skipped.

## Remaining gaps

parseTranslationResults exact schema, OCR/detector provider, mask/inpainting, full-context behavior, PDF/ZIP server pipeline, endpoint authentication policy for anonymous users, queue technology, database/object storage, retention, and current production API response examples remain UNKNOWN. Further evidence requires authorized runtime capture or official developer documentation.
