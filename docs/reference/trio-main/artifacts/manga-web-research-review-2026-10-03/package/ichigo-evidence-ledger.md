# Ichigo Evidence Ledger

관찰 기준일: 2026-09-27 (KST). Ichigo에만 귀속한다. CONFIRMED는 원문/공식 store metadata 직접 사실, STRONGLY INFERRED는 여러 공개 단서가 가리키나 내부 구현 직접 증명 아님, UNKNOWN은 공개 자료 미확인이다.

| ID | Source / date | Author | Evidence | Technical implication | Classification | Limitation |
|---|---|---|---|---|---|---|
| I-001 | https://ichigo.moe/ observed 2026-09-27 | Ichigo.moe | Manga Translator; JP/CN/KR AI translation; all-platform | image/manga translation product, multi-platform UX | CONFIRMED | internal stack absent |
| I-002 | https://ichigo.moe/upload observed | Ichigo.moe | PDF, ZIP, image input; English target; model selector | document/image ingestion and multi-file workflow | CONFIRMED | queue/provider unknown |
| I-003 | https://ichigo.moe/subscription observed | Ichigo.moe | Free Trial; Tier 1 $5.99; Tier 2 $19.99; quotas/OCR language tiers | entitlement tiers gate models/throughput/features | CONFIRMED | pricing may change |
| I-004 | Chrome listing updated 2026-08-11 | Ichigo.moe | ID lepcfgkehgeiblekejomdmdklmjdmflp; v0.0.95; 40,000 users; 5.93 MiB | maintained browser client with release artifact | CONFIRMED | store snapshot |
| I-005 | Chrome listing | Ichigo.moe | every manga site with Unlocker or Panel Tool | content-script/panel integration across reader pages | CONFIRMED | marketing wording; matching unknown |
| I-006 | Chrome listing | Ichigo.moe | PDF/ZIP/image uploads and full-context on PDF/ZIP | chapter context likely preserved across pages | STRONGLY INFERRED | token strategy unknown |
| I-007 | Chrome listing | Ichigo.moe | handles PII, authentication information, website content | extension handles page/account data | CONFIRMED | fields/retention/endpoint unspecified |
| I-008 | Firefox listing updated 2026-09-22 | Ichigo Dev | GUID manga-translator@mangatranslator.ai; v0.0.96 | cross-browser extension packaging | CONFIRMED | direct page not fully indexed |
| I-009 | https://chrome-stats.com/d/ichigo-manga-translator observed | secondary metadata | menus/cookies/scripting/storage/tabs/declarativeNetRequest; all_urls and ichigo.moe host | page interception, persistence, session/network handling enabled | CONFIRMED metadata | non-official mirror |
| I-010 | same mirror | secondary metadata | removed old ichigoreader.com host; added ichigo.moe host | domain migration in extension | CONFIRMED historical | timing from mirror |
| I-011 | Google Play observed | Google Play/ICHIGO LLC | package com.ichigoreadermobile; browser sign-in; reliable sessions; subscription; overlay crash fix | mobile shares web account/subscription and overlay path | CONFIRMED | transport/rendering absent |
| I-012 | Google Play observed | ICHIGO LLC | support ichigo.moe; cs@eriklanning.com; help@ichigo.moe; Bellingham address | public app/service identity linkage | CONFIRMED | individual identity not independently proven |
| I-013 | Play data safety | Google Play | no third-party sharing; optional email; encrypted transit; deletion request | remote account service and privacy controls | CONFIRMED | self-declared |
| I-014 | Apple App Store JP | Apple/Ichigo LLC | iPhone/iPad/Mac/Vision; iOS17+; IAP tiers; 37+ languages; no data collected | native Apple client and platform billing | CONFIRMED | app declaration differs by surface |
| I-015 | Apple App Store GB | Apple/Erik Lanning | OCR, PDF/ZIP/image, full-context PDF/ZIP, free trial | core pipeline exposed in native app | CONFIRMED | backend steps unknown |
| I-016 | Apple release history | Apple | v2.4 vertical-text clipping fix; v2.5 auto-download/settings/mobile panel | renderer handles vertical Japanese; panel reused mobile | CONFIRMED | algorithm absent |
| I-017 | https://ichigoreader.com/TOS2 updated 2025-01-20 | Ichigo LLC | commercial app; email may be required; policy covers websites/apps/widgets/APIs | online account/service boundary | CONFIRMED | legal copy has legacy wording |
| I-018 | Gumroad historical | Ichigo Reader | each image through multiple paid OCR and translation services; $8.99/month | multi-provider OCR/translation fan-out historically | CONFIRMED historical | not proof current providers |
| I-019 | Gumroad user review | Soraga Nishino | multi-image upload added; PDF problems; current ChatGPT errors | batch images and ChatGPT path in historical UX | STRONGLY INFERRED historical | user report |
| I-020 | https://github.com/Ichigo-Labs | Ichigo-Labs | four public repos; no public members; annotation/C/Python/TS traces | public adjacent code footprint, no production repo | CONFIRMED metadata | relationship unknown |
| I-021 | ichigo-annotate repo | Ichigo-Labs | tablet-first YOLO data annotation, TypeScript, updated Jul 27 2026 | possible detector data workflow | STRONGLY INFERRED clue | no production linkage |
| I-022 | CRX archive historical | archive/Erik Lanning | v0.0.27 permissions contextMenus/scripting/downloads/storage/tabs | earlier page scripting/download/storage client | CONFIRMED historical | third-party archive |
| I-023 | Reddit manga comment 2023-04-02 | self-identified product author | paid extension covers server costs; free trial; ZIP easiest bulk | server-backed billing and ZIP batch existed by 2023 | CONFIRMED statement; identity inferred | account linkage not cryptographic |
| I-024 | Reddit mangadex 2024 | Reddit users | Chrome extension; AI real-time translation; upload warning | in-place translated overlay/output page workflow | STRONGLY INFERRED | community report |
| I-025 | Reddit machinetranslation | Reddit user | asks whether text replacement is Google Translate-like; no authoritative answer | replacement/provider remains unresolved | UNKNOWN | never infer Google API |
| I-026 | GitHub issue 43 | third-party project user | names Ichigo Reader with OCR overlays; limited pages before payment | historical paywall/category evidence | CONFIRMED historical | no implementation evidence |
| I-027 | Reddit fuufuijou 2025 | Reddit user | older Chromium-only report; conflicts current Firefox listing | browser support changed over time | CONFIRMED historical | do not apply current |
| I-028 | Reddit animepiracy 2024 | Reddit users | paid/expensive perception; OCR/context discussion | visible user concerns, no architecture | CONFIRMED sentiment | no internals |
| I-029 | Reddit mangapiracy 2024 | Reddit users | good quality but subscription after pages | historical quota/paywall | CONFIRMED historical | no provider evidence |
| I-030 | APKPure 2026-07-15 | APK mirror | v2.0.62.1 overlay resumes after suspend/quit; landscape tablet | mobile lifecycle/background overlay handling | STRONGLY INFERRED | mirror not official |
| I-031 | Reddit manga thread | users/author | Firefox request, Android use, trial activation, bulk ZIP answer | feature evolution from platform/batch/entitlement requests | CONFIRMED history | no roadmap proof |
| I-032 | Reddit mangapiracy 2026 | Reddit user | Ichigo and Torii both used in current reading workflow | current market comparison signal | CONFIRMED user report | no benchmark |

| I-033 | https://ichigo.moe/unlocker observed 2026-09-27 | Ichigo.moe | Official unlocker creates separate Chrome/Opera shortcut/profile and asks for extension reinstall | Browser/profile distribution workflow; underlying mechanism unexposed | CONFIRMED behavior; HYPOTHESIS mechanism | Do not install/run |
| I-034 | https://ichigo.moe/resources/eula/en.txt observed | Ichigo.moe | Public English EULA text resource | Static legal/policy asset is directly addressable | CONFIRMED | Exact text may change |
| I-035 | Official upload live observation 2026-09-27 | Ichigo.moe | Anonymous input accepted pdf/cbz/zip/png/webp/avif/jpeg/jpg/gif/bmp/tif/tiff; UI showed Remaining 5 | Broad document/raster validation and anonymous quota | CONFIRMED | Counter differs from subscription page |
| I-036 | Official subscription live observation 2026-09-27 | Ichigo.moe | Free 40 extension/20 uploads; Tier 1 300 images/hour and JP/CN/KR OCR; Tier 2 150 tier-2/hour, English OCR, no watermark | Entitlement and throughput tiers | CONFIRMED | Anonymous Remaining 5 unexplained; preserve discrepancy |
| I-037 | Public client assets observed by parent agent 2026-09-27 | ichigo.moe bundle | React 18.2.0/react-dom license and styled-components marker | React client and styled-components supported | CONFIRMED marker | Not backend proof; WebGL/MutationObserver not detector/renderer proof |
| I-038 | Public client assets observed by parent agent 2026-09-27 | ichigo.moe bundle | Non-secret strings include /api, /unlocker, /resources/eula/en.txt and payment/vendor hostnames; Backblaze URL linked to unlocker distribution | Client route/vendor clues | CONFIRMED presence only | Host presence does not prove endpoint semantics |

## Explicit unknowns

OCR vendor, detector, reading order, inpainting, font fitting, prompt/schema, context token strategy, API semantics, object storage for user images, database, queue, cache, retention, rate limits, billing webhook, native framework, extension message protocol, Firefox source repository, and production use of Ichigo-Labs repos remain UNKNOWN.
