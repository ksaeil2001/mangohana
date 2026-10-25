# Ichigo.moe Source Discovery Map

> 후속 확인: 초기 접근 제한·미실행 상태는 [ichigo-runtime-evidence.md](ichigo-runtime-evidence.md)에서 갱신했다. 아래 정적 관찰은 당시 상태로 보존한다.


관찰일: 2026-09-27 (KST). 공개 원문을 열어 확인한 URL을 우선 기록했다. 검색 snippet은 후보 발견에만 사용했다. 동명 Sanrio/애니메이션 자료는 제외했다.

## Official / product surfaces

| Source | URL | 확인한 공개 단서 | 시점 | 신뢰도 |
|---|---|---|---|---|
| Main site | https://ichigo.moe/ | “Manga Translator”; Japanese/Chinese/Korean AI translation; all-platform positioning | observed 2026-09-27 | 1 |
| Upload | https://ichigo.moe/upload | PDF, ZIP, image input; target English; model selector | observed | 1 |
| Subscription | https://ichigo.moe/subscription | Free Trial; Tier 1 $5.99/month; Tier 2 $19.99/month; free quotas and OCR language claims | observed | 1 |
| Terms/privacy | https://ichigoreader.com/TOS2 | commercial service; email for service/account; policy updated 2025-01-20; terms effective 2022-02-01 | 2025/2026 | 1 |
| Historical payment page | https://ichigo.gumroad.com/l/ichigo-reader | historical $8.99/month; each image through multiple paid OCR and translation services; reviews mention multi-image upload and PDF issues | historical | 4 |

## Store listings

| Store | URL / ID | Public evidence | Version/date |
|---|---|---|---|
| Chrome Web Store | https://chromewebstore.google.com/detail/manga-translator%F0%9F%8D%93/lepcfgkehgeiblekejomdmdklmjdmflp | Extension ID lepcfgkehgeiblekejomdmdklmjdmflp; 40,000 users; JP/KR/CN; Unlocker/Panel Tool; PDF/ZIP/image; full-context; handles PII, authentication information, website content | v0.0.95; updated 2026-08-11 |
| Firefox Add-ons official page | https://addons.mozilla.org/en-US/firefox/addon/ichigo-manga-translator/ | Add-on; GUID manga-translator@mangatranslator.ai; publisher Ichigo Dev | v0.0.96; updated 2026-09-22; observed 2026-09-27 |
| Firefox Add-ons official API | https://addons.mozilla.org/api/v5/addons/addon/ichigo-manga-translator/ | AMO id 2965030; official XPI URL; permissions menus/cookies/scripting/storage/tabs/declarativeNetRequest; host permissions ichigo.moe, *://*/*, all_urls; all-frames content script; websiteContent data collection declaration | v0.0.96; observed 2026-09-27 |
| Firefox XPI | https://addons.mozilla.org/firefox/downloads/file/5049619/ichigo_manga_translator-0.0.96.xpi | SHA-256 b47ec80f56532071ddc26726317f0b32a9dac7d936a4be048bce055ee1daa195; 2,798,453 bytes; JS files listed in ichigo-extension-evidence.md | v0.0.96; observed 2026-09-27 |
| Firefox metadata mirror | https://chrome-stats.com/d/ichigo-manga-translator | Secondary discovery only for historical publisher/permission changes; current permissions are confirmed by official API/XPI | observed 2026-09-27 |
| Google Play | https://play.google.com/store/apps/details?hl=en&id=com.ichigoreadermobile | Android package com.ichigoreadermobile; browser sign-in; session reliability; subscription management; overlay crash fix; ICHIGO, LLC | observed 2026-09-27 |
| Google Play data safety | https://play.google.com/store/apps/details?hl=en_US&id=com.ichigoreadermobile | no third-party sharing declaration; optional email; encrypted in transit; deletion request | observed |
| Apple App Store | https://apps.apple.com/jp/app/ichigoreader-%E6%BC%AB%E7%94%BB%E7%BF%BB%E8%A8%B3/id1641432177 | Ichigo LLC; iPhone/iPad/Mac/Vision; iOS 17+; Tier 1 ¥1,500/Tier 2 ¥4,000; no data collected declaration | v2.5 |
| Apple App Store GB | https://apps.apple.com/gb/app/ichigoreader-translate-manga/id1641432177?platform=mac | auto translate, OCR, PDF/ZIP/image, full-context PDFs/ZIPs, free trial; mobile panel and vertical-text fixes | version history |
| APK metadata | https://apkpure.net/manga-translator-%E2%80%94-ichigo/com.ichigoreadermobile/download | Android v2.0.62.1; overlay after suspend/quit; tablet landscape | 2026-07-15; secondary |

## Developer / code traces

| Source | URL | Finding | Classification |
|---|---|---|---|
| GitHub org | https://github.com/Ichigo-Labs | public org, no public members; ichigo-annotate TypeScript tablet-first YOLO annotation; ave fork; lint C; GitHub language metadata labels snn as Python, while its direct README describes C + optional CUDA | CONFIRMED repository metadata/content; production linkage not established |
| GitHub snn | https://github.com/Ichigo-Labs/snn | README directly describes a C + optional CUDA spiking neural network library; repository contains CMake, src, include/snn, tests, workflows; this is unrelated-by-proof to translator production | CONFIRMED repository content; production linkage UNKNOWN |
| GitHub ichigo-annotate | https://github.com/Ichigo-Labs/ichigo-annotate | README describes tablet-first YOLO annotation; repository exposes Vite config, TypeScript package files, tests and architecture.md | CONFIRMED repository content; production linkage UNKNOWN |
| Corporate identity | https://play.google.com/store/apps/details?hl=en&id=com.ichigoreadermobile | ICHIGO, LLC, Bellingham WA address, support contacts | CONFIRMED |
| Historical developer | https://www.crx4chrome.com/crx/290010/ | archived extension credits Erik Lanning; old permissions contextMenus/scripting/downloads/storage/tabs | CONFIRMED historical |
| Author statement | https://www.reddit.com/r/manga/comments/zb53l5/any_good_manga_translator_extension_out_there/ | commenter self-identifies as author; paid extension covers server costs; free trial; ZIP easiest for bulk | CONFIRMED statement |

## Community / third-party

| Source | URL | Finding | Reliability |
|---|---|---|---|
| Reddit animepiracy | https://www.reddit.com/r/animepiracy/comments/1bdicq3/does_anybody_know_a_good_manga_translator_software/ | users report paid/expensive; comments discuss OCR and alternatives | 10/11 |
| Reddit mangadex | https://www.reddit.com/r/mangadex/comments/1ap24zl/is_there_a_way_to_translate_foreign_translated_manga_chapters_with_a_tool_somewhere/ | Chrome extension, AI real-time translation reports, upload warning | 10 |
| Reddit mangapiracy | https://www.reddit.com/r/mangapiracy/comments/1d4nb7k | good quality but subscription after pages; historical comparison context | 10 |
| Reddit machine translation | https://www.reddit.com/r/machinetranslation/comments/1gqwp1g/how_does_ichigo_manga_translator_replace_text/ | asks whether replacement resembles Google Translate; no authoritative answer | 10; UNKNOWN |
| GitHub issue mention | https://github.com/Amiron49/Aris.Moe.Ocr.Translation.Overlay/issues/43 | names Ichigo Reader among OCR overlays; page limit before payment | 8 |
| Browser compatibility | https://www.reddit.com/r/fuufuijou/comments/1kawaw6/do_someone_know_a_good_way_to_translate_images_and_text_in_japanese/ | older Chromium-only report conflicts with current Firefox listing | 10; historical |
| External comparator | https://unrawmanga.com/comic-translator | third-party “vs Ichigo Reader” comparison link | 8 |

## Additional official observations

| Source | URL | Finding | Classification |
|---|---|---|---|
| Unlocker | https://ichigo.moe/unlocker | Official Windows Chrome/Opera unlocker flow creates a separate browser shortcut/profile and asks for extension reinstall | CONFIRMED product behavior; mechanism UNKNOWN |
| EULA | https://ichigo.moe/resources/eula/en.txt | Public English EULA text resource | CONFIRMED |

## Source metadata audit

| Source | Author/publisher | Publication/update date | Version | Observed |
|---|---|---|---|---|
| Official Firefox API/XPI | Ichigo Dev | API observed 2026-09-27; AMO update 2026-09-22 | 0.0.96 | 2026-09-27 |
| Chrome Web Store | Ichigo.moe / owner of listed website | update 2026-08-11 | 0.0.95 | 2026-09-27 |
| Google Play | ICHIGO, LLC | latest changelog date not exposed in captured text | app version not captured | 2026-09-27 |
| Apple App Store | Ichigo LLC; copyright Erik Lanning | version history dates shown; exact page publication date not captured | 2.5 current listing | 2026-09-27 |
| Reddit r/manga author comment | username not captured in source extract; self-identifies as author | comment 2023-04-02 | not applicable | 2026-09-27 |
| Reddit r/animepiracy | thread participants; usernames vary | post 2024-03-13 | not applicable | 2026-09-27 |
| Reddit r/mangadex | thread participants; usernames not captured | post 2024-02-12 | not applicable | 2026-09-27 |
| Reddit r/mangapiracy | thread participants; usernames vary | post 2024-05-31 | not applicable | 2026-09-27 |
| Reddit r/fuufuijou | thread participants; usernames not captured | post 2025-04-29 | not applicable | 2026-09-27 |
| Reddit r/machinetranslation | username/date not captured in source extract | publication date UNKNOWN | not applicable | 2026-09-27 |
| GitHub issue 43 | issue author/date not captured in source extract | publication date UNKNOWN | not applicable | 2026-09-27 |
| Unraw comparator | publisher/author/date not captured | publication date UNKNOWN | page version UNKNOWN | 2026-09-27 |

## Negative / missing discovery results

- No public Ichigo REST/API documentation, public SDK, deployment manifest, worker/queue documentation, OCR provider disclosure, or official production source was found.
- No public Discord invite/channel or searchable Ichigo developer Discord technical log was found. Login-gated material was not bypassed.
- Firefox current permissions and XPI metadata are confirmed from the official AMO API/XPI; the secondary mirror is retained only for historical change history.
- Old ichigoreader.com/Gumroad/Chrome archives and current ichigo.moe/store data are separated as historical/current evidence.
