# Ichigo 최종 공개 공백 재검색

관찰 기준일: 2026-09-27 (KST)

이 문서는 기존 Ichigo source map/ledger의 공개 증거를 덮어쓰지 않고, 마지막 재검색에서 얻은 `I-200`대 단서와 실패 검색만 기록한다. Architecture 결론이나 독립 구현 설계는 포함하지 않는다. 공개 페이지와 Reddit 원문만 열었으며 로그인 브라우저, extension 설치, API 호출, 토큰·쿠키 수집은 수행하지 않았다.

## 추가 증거

| ID | URL / 출처 | author / published·updated | observed / version | 증거와 기술적 의미 | 판정 | 범위·제한 |
|---|---|---|---|---|---|---|
| I-200 | https://www.reddit.com/r/mangapiracy/comments/1o4z0tm/near_human_level_ai_manga_translation_coming_soon/ | Reddit post author `InTheSamePlaces`; 본문 서명 `mangatranslator.ai team`; 2025-10-12 | 2026-09-27; 당시 공개 UI URL `mangatranslator.ai/upload` | 작성자는 일본어-영어 만화쌍 4TB 이상을 수집해 여러 모델을 fine-tune할 계획이라고 설명하고, `ichigo-gemma-3-27b-it`, `ichigo-qwen3-vl-235b-A22b-instruct`라는 모델명을 공개했다. 전체 volume의 이미지와 context를 입력으로 삼고, 이후 series 단위 unified context를 목표로 한다고 명시한다. | STRONGLY INFERRED (개발자 공개 발언으로 보이는 제품 기술 방향) | Reddit 계정과 현재 Ichigo LLC/Ichigo Dev의 법적·운영적 동일성은 직접 확인되지 않았다. 2026 Q1 출시 목표도 계획 시점의 발언이며 실제 출시·현재 production 사용을 증명하지 않는다. 모델의 실제 endpoint, prompt, token budget, 페이지/패널 순서 schema는 공개되지 않았다. |
| I-201 | 같은 Reddit 원문, 댓글 | 댓글 작성자 `InTheSamePlaces`로 표시; 2025-10-12 | 2026-09-27 | “zip 또는 pdf volume을 업로드하면 별도 transcript 없이 작동한다”는 질문에 작성자가 그렇게 답했다. full-context 입력 경로가 적어도 PDF/ZIP volume 단위 UX로 설계되었다는 공개 발언이다. | STRONGLY INFERRED | 댓글은 당시 `mangatranslator.ai` UI에 대한 답변이다. 현재 `ichigo.moe`의 내부 request schema, 페이지 정렬, OCR 결과와 번역 결과의 연결 방식까지 증명하지 않는다. |
| I-202 | https://github.com/Ichigo-Labs | GitHub organization `ichigo.moe`; updated repository metadata observed 2026-09-27 | `ichigo-annotate` updated 2026-07-27; public repositories 4개 | 조직 공개 저장소 목록은 `ichigo-annotate`를 “tablet-first YOLO data annotation” TypeScript web app으로 설명하고, 별도의 translator/production API repository나 dependency link를 보여주지 않는다. `ave`, `lint`, `snn`도 공개 목록에 있으나 translator service 연결 표시는 없다. | CONFIRMED (공개 목록의 부재와 설명 범위) | GitHub 조직에 비공개 저장소가 있을 수 있고, repository description만으로 내부 production 연결의 부재를 증명할 수 없다. 공개 멤버가 없어 maintainer 신원도 확인 불가다. |
| I-203 | https://github.com/Ichigo-Labs/ichigo-annotate | README/repository files; author identity not publicly resolved; commit/update date observed 2026-09-27 | TypeScript; repository page observed current | README와 공개 파일은 YOLO annotation용 Vite/TypeScript 앱으로 설명된다. Ichigo web app URL, extension package, `/translate`, OCR provider, model artifact 또는 deployment workflow를 직접 import/link하는 공개 근거를 찾지 못했다. | CONFIRMED (repository content); production linkage UNKNOWN | 공개 repository가 내부 annotation pipeline의 일부일 가능성은 배제할 수 없지만, 현재 translator runtime 사용은 확인되지 않는다. “같은 GitHub 조직”만으로 서비스 연결을 확정하지 않는다. |
| I-204 | https://play.google.com/store/apps/details?hl=en&id=com.ichigoreadermobile | Google Play publisher `Ichigo LLC`; update shown 2026-09-09; observed 2026-09-27 | package `com.ichigoreadermobile` | 공개 Android listing은 일본어·한국어·중국어→영어, PDF/ZIP/image upload, manga OCR, 그리고 “Kiwi browser plugin” 사용자를 위한 browser integration을 제품 기능으로 명시한다. 이는 제3자 browser integration이 제품 표면에 존재한다는 근거다. | CONFIRMED (스토어 설명); integration internals UNKNOWN | Kiwi plugin의 package/source, authentication handoff, API contract, extension과 Android app의 상태 공유 방식은 listing만으로 알 수 없다. |
| I-205 | https://ichigo.gumroad.com/l/ichigo-reader | 판매 페이지; author/date/version not exposed in fetched page; observed 2026-09-27 | historical Ichigo Reader subscription page | 페이지는 각 manga image가 “multiple paid OCR and translation services”를 거친다고 설명한다. 복수의 외부 유료 OCR/translation provider 사용을 제품의 과거 공개 설명으로 확인할 수 있지만 provider명과 현재 ichigo.moe 경로는 공개하지 않는다. | CONFIRMED (historical product claim) | provider 이름, 호출 순서, fallback, 이미지 보존·삭제, 현재 서비스와의 연속성은 UNKNOWN. 리뷰의 ChatGPT/Gemini 언급은 사용자 제안·경험이지 공식 backend contract가 아니다. |

## Full-context / reading-order 공백

- 현재 공개된 공식/스토어 표현은 “full-context on PDFs and ZIPs”, “entire volume of context” 수준이다. 페이지 배열, 이미지 전처리, reading order, 대화/패널 grouping, OCR box-to-translation alignment, 결과 저장 schema, context window/토큰 제한은 공개되지 않았다.
- I-200/I-201은 volume 단위 입력과 전체 이미지 context라는 개발자 발언을 보강하지만, 실제 현재 runtime의 request body나 response object를 제공하지 않는다. 따라서 `full-context`를 “전체 파일을 multimodal model에 그대로 한 번에 전달”로 해석하면 안 된다.
- 기존 XPI의 현재 `/translate` request는 단일 `base64Images` 배열과 `translationModel`, `targetLangCode` 등을 정적으로 확인할 수 있지만, 이 배열이 페이지 순서·OCR 결과·full-context batching을 어떻게 표현하는지는 runtime capture 없이는 UNKNOWN이다.

## 누락 단서 재검색 및 실패

| 검색어/경로 | 결과 |
|---|---|
| `site:ichigo.moe "full-context"`, `site:ichigo.moe Kiwi browser Ichigo plugin` | 공식 검색 결과에서 full-context schema, reading-order 문서, Kiwi integration API를 찾지 못했다. 스토어 설명만 확인됐다. |
| `"ichigo-annotate" "ichigo.moe"` | repository와 서비스 간 직접 URL/import/deployment 연결을 찾지 못했다. 같은 GitHub 조직 소속만 확인됐다. |
| `Ichigo manga translator API integration OCR developer` | Ichigo 공식 API 문서나 개발자 기술 블로그는 찾지 못했다. 검색 결과는 제3자 translator 문서와 일반 manga translation 자료가 주로 반환됐다. |
| 공개 Discord / `Ichigo Reader Discord` / `mangatranslator.ai Discord` | 검색 가능한 공개 초대·메시지·개발자 기술 발언을 확인하지 못했다. 로그인/초대가 필요한 공간은 우회하지 않았다. |
| GitHub code search for `/translate`, `Ichigo Dev`, `manga-translator@mangatranslator.ai` | 공개 production source, OpenAPI schema, provider adapter, deployment manifest를 확인하지 못했다. extension에 남은 static route 문자열만 기존 증거로 유지한다. |

## 현재 종료 경계

이번 유한 재검색으로 새로 좁혀진 것은 (1) 과거/전환기 개발자 공개 발언에서 volume-level multimodal context와 명명된 fine-tuned model 계획, (2) Android listing의 Kiwi browser integration 표면, (3) `ichigo-annotate`가 공개 annotation 앱이라는 사실과 translator runtime linkage 부재다. 실제 full-context 전달 schema, reading order, OCR provider의 현재 구성, `ichigo-annotate`의 production 사용, 제3자 integration handshake는 공개 근거가 없어 `UNKNOWN`으로 남긴다.
