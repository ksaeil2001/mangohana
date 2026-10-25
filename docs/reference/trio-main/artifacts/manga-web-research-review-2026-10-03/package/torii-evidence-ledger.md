# Torii Evidence Ledger

관찰일: 2026-09-27 KST. `CONFIRMED`는 공개 원문에 직접 기재된 사실, `STRONGLY INFERRED`는 여러 공개 사실에서 제한적으로 도출한 운영 의미, `HYPOTHESIS`는 검증되지 않은 구조 가정, `UNKNOWN`은 공개 자료만으로 판정 불가다. 이 ledger는 Architecture 결론이 아니라 원자료 기록이다.

| ID | Source / author | Date | Evidence (요약) | Technical meaning | Classification | Scope / limitation |
|---|---|---|---|---|---|---|
| T-001 | Official main | observed 2026-09-27 | 웹사이트가 manga/manhwa/webtoon을 웹에서 번역하고 파일 업로드도 제공 | 이미지 번역 web surface + in-page workflow | CONFIRMED | UI/marketing; runtime 성공 증명 아님 |
| T-002 | Official install guide | observed 2026-09-27 | hover click, auto translate all images, download, screen crop | 확장 프로그램 content interaction과 capture 경로 존재 | CONFIRMED | 실제 브라우저 실행은 미검증 |
| T-003 | Official install guide | observed 2026-09-27 | website가 multi-image batch, cleaning, ZIP/PDF 다운로드, context sharing 제공 | batch asset pipeline과 context 입력이 제품 기능으로 노출 | CONFIRMED | 내부 queue/worker는 UNKNOWN |
| T-004 | Official image workspace | observed 2026-09-27 | PNG/JPG/WEBP/ZIP/PDF/TORII 파일 입력 | 정규화/프로젝트 파일 입력 계약이 존재 | CONFIRMED | parsing 구현은 공개되지 않음 |
| T-005 | Official image workspace | observed 2026-09-27 | 모델, reasoning effort, font, target language, context sharing, bubbles only, prompt, BYOK UI | 번역 요청이 모델·렌더링·context 옵션을 함께 전달 | CONFIRMED | UI가 실제 provider 선택을 보장하지 않음 |
| T-006 | Official API docs | observed 2026-09-27 | `/api/v2/upload` image translation endpoint, multipart form fields | 공개된 번역 API 계약, 이미지→translated/inpainted/text/context 응답 | CONFIRMED | key 없는 호출 및 live response 미실행 |
| T-007 | Official API docs | observed 2026-09-27 | `/api/v2/ocr`가 paragraph text, polygon, fontsize, angle, colors 등 반환 | OCR 결과가 region geometry/스타일 메타데이터를 포함 | CONFIRMED | OCR provider/model 이름은 UNKNOWN |
| T-008 | Official API docs | observed 2026-09-27 | `/api/inpaint` image+mask, `/api/typeset` text boxes | text removal과 render 단계가 별도 API로 분리 | CONFIRMED | 서비스 내부 orchestration은 UNKNOWN |
| T-009 | Official API docs | observed 2026-09-27 | typeset text box에 OBB polygon, direction, angle, source_lang, fontsize | 세로쓰기/회전/OBB 렌더링 계약 존재 | CONFIRMED | 자동 font-fit 알고리즘은 UNKNOWN |
| T-010 | Official API docs | observed 2026-09-27 | context 최대 10,000 chars, chain 시작 `None`, 이전 context 응답 반환 | 페이지 간 context chaining을 API 수준에서 지원 | CONFIRMED | 실제 품질 개선 수치는 없음 |
| T-011 | Official API docs | observed 2026-09-27 | BYOK header `x-byok-openrouter/openai/google/anthropic/deepseek/xai/local`, local URL | 사용자 provider key/self-hosted OpenAI-compatible endpoint 경로 | CONFIRMED | 키 값은 수집하지 않음; 보안 저장 방식은 privacy 문서와 함께 봐야 함 |
| T-012 | Official API docs | observed 2026-09-27 | default 1 req/s, burst 100, burst queued sequentially | API throttle와 순차 처리 정책 공개 | CONFIRMED | 실제 rate-limit 응답은 실행하지 않음 |
| T-013 | Official API docs | observed 2026-09-27 | file 50 MB, side 100,000 px, total 100 MP; 429/503 가능 | 업로드 validation 및 overload 계약 | CONFIRMED | 다른 endpoint에도 동일 적용인지는 문서 표현 범위 내에서만 확인 |
| T-014 | Official API docs | observed 2026-09-27 | credits/usage/share endpoints와 Bearer auth | account-scoped metering 및 credit transfer API | CONFIRMED | auth/ledger DB 구현은 UNKNOWN |
| T-015 | Official image workspace | observed 2026-09-27 | inpaint가 dialogue/narration/SFX text를 지우고 배경을 redraw; 1 credit | AI inpainting 단계가 text category를 폭넓게 대상으로 함 | CONFIRMED | 모델명·품질·GPU는 UNKNOWN |
| T-016 | Official image workspace | observed 2026-09-27 | editor modes: erase, paint, AI inpaint, OCR area, text, warp, image; ZIP/PDF/PSD/TORII export | 번역 후 수동 보정과 프로젝트/export workflow 존재 | CONFIRMED | UI 목록이 runtime 성공을 증명하지 않음 |
| T-017 | Official updates, v2.0.6.1 | 2025-07-09 | rotation, padding/border radius, legacy non-GPU inpaint, PDF upload, project import/export | 과거 버전에서 editor/inpaint/PDF/project 기능이 추가됨 | CONFIRMED | historical record; current behavior must be rechecked |
| T-018 | Official updates, v2.0.7.1 | 2025-08-11 | GPT-5, DeepSeek 0324, Claude 4 Sonnet, transparent PNG, Ctrl+S, screenshot repeat | model lineup 및 image handling 변화 기록 | CONFIRMED | update note self-reported; exact current model list may drift |
| T-019 | Official updates, v2.0.9.1 | 2025-10-09 (원문 `09/10/25`) | manual OCR, Gemini 2.5 Flash, GPT-5 only, Claude 4.5; removed Gemini variants | provider/model migration과 manual OCR feature | CONFIRMED | historical model snapshot |
| T-020 | Official updates, v2.0.17.1 | 2026-05-22 | BYOK, self-hosted mode, global editing, Claude Sonnet 4.6 | provider routing/cost mode와 all-images edit 확대 | CONFIRMED | future-dated relative to older pages; current as observed |
| T-021 | Official updates v2.22.2 | 2026-09-13 (원문 `13/09/26`) | details panel shows model, reasoning, credit breakdown, stage timing, fallback; new models Gemini 3.8 Flash/Luna/Kimi/OneOCR | per-request execution metadata and fallback UI | CONFIRMED | release-note/UI claim; runtime 미검증 |
| T-022 | Official updates, v1.0.28.1 | 2025-01-03 | pricing changed to one image=one credit, subscriptions removed for new users | historical billing migration from text-dependent credits/subscription to image credits | CONFIRMED | current pricing page may differ; active legacy subscriptions preserved per note |
| T-023 | Official pricing/FAQ | observed 2026-09-27 | credits account-wide across devices; API also available through RapidAPI; unique image-settings cache; local browser cache and auto-delete after a week configurable | account entitlement + client-side result cache behavior is documented | CONFIRMED | cache behavior is documentation claim, no runtime test |
| T-024 | Official privacy | last updated 2026-07-17 | Firebase Auth, image/URL/language collection, diagnostics with browser/OS/version/IP on error | account + content + error telemetry data classes | CONFIRMED | policy disclosure, not observed network traffic |
| T-025 | Official privacy | last updated 2026-07-17 | Chrome storage local/sync; Firebase Auth/Firestore; temporary `torii-bucket` GCS; Lemon Squeezy; AI providers | named vendors and storage/retention architecture clues | CONFIRMED | policy may change; bucket existence not independently tested |
| T-026 | Chrome Web Store | updated 2026-08-01; observed 2026-09-27 | ID `gkdekajjngdkocgiealohleibhdjhoed`, publisher `stringieee`, version 2.21.4, 10k users, 7.16 MiB, in-app purchases | production Chromium extension identity and release metadata | CONFIRMED | store metadata; permissions not fully enumerated in opened official page |
| T-027 | Firefox Add-ons | released 2026-09-20; observed 2026-09-27 | slug `torii-image-translator`, developer `stringie`, v2.22.4, Firefox 115+/Android 120+, 7.54 MB | Firefox/Android extension distribution and rapid releases | CONFIRMED | Firefox developer spelling differs from Chrome; no source code available (All Rights Reserved) |
| T-028 | Reddit r/mangapiracy, OP `stringiee` (username as shown) | 2025-01-21 | creator states Chromium/Firefox desktop/mobile, in-page hover, 120+ languages; Chrome image restrictions workaround via screenshot | developer-origin product claim plus platform limitation | CONFIRMED (self-authored public statement) | Reddit post not official docs; do not treat as independent validation |
| T-029 | Reddit comments / RapidAPI link | date unknown; thread observed 2026-09-27 | developer links `rapidapi.com/stringieee/api/torii-ocr`; says OCR-only API released | username→API evidence chain | CONFIRMED | comment date was not independently established; RapidAPI listing and Reddit link establish publication, not internal code ownership |
| T-030 | Reddit user feedback | date unknown; thread observed 2026-09-27 | reports over-detection of buttons/background and English-to-English restyling | records a user-reported failure mode for future testing | CONFIRMED (user-reported statement only) | comment date and independent reproduction unavailable; no benchmark/sample attached |
| T-031 | Reddit r/u_-Zaraky- / MangaBridge | 2026-08-30 | third-party app optionally connects own Torii API key and exports PDF/CBZ/ZIP | public integration surface exists | CONFIRMED | integration code/repository not verified in this pass |
| T-032 | Chrome Web Store description | observed 2026-09-27 | multiple models GPT-5/Gemini/Claude/DeepSeek, screen crop, editor/inpaint, PDF/ZIP, 120+ style product claims | store-facing capability inventory | CONFIRMED | description is marketing metadata and may lag runtime |
| T-033 | Official site community link | observed 2026-09-27 | `Join the community` links a Discord invite | public Discord existence | CONFIRMED | server posts/technical channels require login or are not indexed; contents UNKNOWN |
| T-034 | GitHub searches (`toriitranslate`, `torii-ocr`, publisher names) | observed 2026-09-27 | no verified Torii-owned public repository found | source code/deployment internals unavailable from this search | UNKNOWN | absence of search result is not proof repository does not exist |
| T-035 | Firefox listing | observed 2026-09-27 | source code status says All Rights Reserved | extension is not publicly open-source via listing | CONFIRMED | does not rule out private source or separate repositories |
| T-036 | Firefox Add-ons listing | observed 2026-09-27; page version 2.21.6 updated 2026-08-24 | required permission: access data for all websites; optional downloads/download history and all-sites access; 2,542 users on fetched listing | broad host access and optional download integration are part of published browser permission contract | CONFIRMED | Firefox listing metadata; does not reveal runtime message flow |
| T-037 | Firefox Add-ons review thread | date unknown; observed 2026-09-27 | developer reply says text-detection GPU models and LLM calls such as GPT-5 contribute to cost, and local/API-key mode was not supported in that historical response | records a historical developer statement about cost and capability | CONFIRMED (developer statement, historical) | exact review date not established; does not independently prove GPU/provider implementation; later BYOK/self-hosted update supersedes capability claim |
| T-038 | Official Terms of Service | last updated 2026-07-17; effective 2024-03-19 | refund requires support request within 30 days and fewer than 20 used credits; account deletion cancels remaining credits; unauthorized use may suspend account | billing/refund and entitlement termination rules are public | CONFIRMED | legal policy, not payment webhook/runtime evidence |
| T-039 | Official Cookie Policy | observed 2026-09-27 | login cookies and aggregate analytics cookies cover visits, time, audience, errors, response time and interactions | session + product analytics collection is disclosed | CONFIRMED | policy does not name analytics vendor or prove runtime events |
| T-040 | Official Apple App Store | observed 2026-09-27; listing metadata crawled ~2 weeks prior | Torii Image Translator app ID `6780277628`, developer Antony Kaloferov, iPhone/iPad/Mac, 15.7 MB, age 4+, 6 ratings; Safari in-image translation, warp/vertical/context/BYOK claims | native Apple distribution is confirmed separately from old Reddit-linked app ID | CONFIRMED | store metadata/description; developer identity differs from store publisher stringieee and needs reconciliation |
| T-041 | Official Text Translator | observed 2026-09-27 | Gemini/GPT/Claude/DeepSeek LLMs, 10,000 character request limit, preserved line breaks, BYOK/local endpoint UI | standalone text path and document batching boundary are publicly described | CONFIRMED | page/UI description; no live request |
| T-042 | Official Visual Novel page | observed 2026-09-27 | Windows desktop app offers memory hook mode for Japanese/Renpy engines, real-time OCR mode, image/text overlay, selectable OCR engine/model, context sharing; version 1.0.1 | separate desktop capture modes and shared account/credits are product claims | CONFIRMED | no installer execution or memory hook inspection |
| T-043 | Official Updates v2.22.2 | 2026-09-13 | website/extension rebuilt around one shared editor; renderer rewritten to match server; mobile/touch, streaming downloads, local brush allocation, details panel and fallback metadata described | current release claims shared editor/rendering and performance changes | CONFIRMED (release note) | documentation claim; not a live parity test |
| T-044 | Official Updates v2.0.20.1 | 2026-06-06 | oriented and vertical rendering added for rotated/top-to-bottom text | historical renderer capability and manga vertical-writing support | CONFIRMED | update note; exact current algorithm UNKNOWN |
| T-045 | Official Updates v2.0.13.1 | 2026-02-17 | context sharing passes summary of prior pages to future translations; extension maintains running context reset on page/site change | explicit product behavior for context state lifecycle | CONFIRMED | release note, not network trace |
| T-046 | Official Updates v2.0.11.1 | 2026-01-26 | translation history/cache added; note says images no longer stored on servers and storage is local on device, with configurable retention | current-vs-old image retention migration | CONFIRMED (historical release statement) | conflicts in wording with privacy temporary debug uploads; retain both and resolve by scope |
| T-047 | Official Updates v2.0.5.1 | 2025-06-05 | inpainting moved from legacy CPU model to GPU-backed server model | direct historical evidence of GPU inpainting and prior CPU fallback | CONFIRMED (release note) | GPU vendor/model/size UNKNOWN |
| T-048 | Official Updates v2.22.2 | 2026-09-13 | model lineup adds Gemini 3.8 Flash, Luna, Kimi, OneOCR; details panel reports selected model/reasoning/credits/timing/fallback | OneOCR is confirmed as a named selectable lineup item in current release note, but not necessarily OCR provider or a separate model class | CONFIRMED (feature listing) | no OneOCR vendor, model card, API endpoint, or OCR-only behavior found; provider remains UNKNOWN |
| T-049 | GitHub MangaBridge-Releases | observed 2026-09-27 | Reddit source links `https://github.com/Zaraky-project/MangaBridge-Releases`; repository is a release/download trace for third-party app | third-party integration repository identity confirmed from source post | CONFIRMED (linked repository existence) | source code/API adapter not established; repository may contain binaries only |

## ID별 직접 원문 URL

아래 mapping은 표의 각 ID에 적용되는 direct source URL이다. 동일 URL의 여러 행도 각각 ID별로 원문 위치를 분리해 기록했으며, 날짜가 확인되지 않은 항목은 `date unknown`으로 표시했다.

T-001,T-032: https://toriitranslate.com/  
T-002,T-003: https://toriitranslate.com/install  
T-004,T-005,T-015,T-016: https://toriitranslate.com/image  
T-006,T-007,T-008,T-009,T-010,T-011,T-012,T-013,T-014: https://toriitranslate.com/api  
T-017,T-018,T-019,T-020,T-021,T-022,T-043,T-044,T-045,T-046,T-047,T-048: https://toriitranslate.com/updates  
T-023: https://toriitranslate.com/pricing  
T-024,T-025: https://toriitranslate.com/privacy  
T-026: https://chromewebstore.google.com/detail/torii-image-translator-%E2%80%94/gkdekajjngdkocgiealohleibhdjhoed  
T-027,T-035,T-036: https://addons.mozilla.org/en-US/firefox/addon/torii-image-translator/  
T-028,T-029,T-030: https://www.reddit.com/r/mangapiracy/comments/1i6ksgh/  
T-031,T-049: https://www.reddit.com/r/u_-Zaraky-/comments/1w2q7h0/weebcentral_and_sushiscan_downloader_volume/ and https://github.com/Zaraky-project/MangaBridge-Releases  
T-033: https://toriitranslate.com/ (Join the community link)  
T-034: https://github.com/search?q=toriitranslate&type=repositories  
T-037: https://addons.mozilla.org/en-US/firefox/addon/torii-image-translator/reviews/  
T-038: https://toriitranslate.com/terms  
T-039: https://toriitranslate.com/cookies  
T-040: https://apps.apple.com/us/app/torii-image-translator/id6780277628  
T-041: https://toriitranslate.com/text  
T-042: https://toriitranslate.com/visualnovel  

## 미확인/개입 필요

- OCR/text detector provider, inpainting model, translation prompt, queue technology, database schema, GCP deployment topology, CDN/GPU sizing, endpoint implementation and real latency는 공개 문서만으로 확정할 수 없다.
- API key가 필요한 live request, authenticated dashboard, checkout/webhook, extension runtime network trace는 실행하지 않았다.
- Discord 기술 채널/개발자 발언은 로그인 또는 브라우저 Take Over가 필요할 수 있다. 필요 시 사용자 개입을 요청해야 한다.
