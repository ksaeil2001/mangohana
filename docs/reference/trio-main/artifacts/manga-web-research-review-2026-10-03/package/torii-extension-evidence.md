# Torii Firefox Extension 공개 배포 Evidence

관찰일: 2026-09-27 KST. 공식 AMO metadata와 XPI Manifest를 확인하고 공개 배포 JS의 필요한 호출 경로를 메모리에서만 읽었다. 설치, 보호 우회 실행, proprietary 코드 복사, 자격증명 수집은 하지 않았다. 정적 코드가 존재한다는 사실과 실제 요청 성공을 구분한다.

## 배포 식별


| 항목 | 관찰값 | 분류 | 제한 |
|---|---|---|---|
| AMO API | `https://addons.mozilla.org/api/v5/addons/addon/torii-image-translator/` | CONFIRMED | 공개 metadata |
| slug / GUID | `torii-image-translator` / `stringieee@gmail.com` | CONFIRMED | GUID가 개발자 실명 증명은 아님 |
| version | `2.22.4` | CONFIRMED | 관찰 시점 값 |
| XPI | `torii_image_translator-2.22.4.xpi` | CONFIRMED | 공개 배포 파일 |
| SHA-256 | `a2ad439c7391cbe2870d3a752fc41212ab5495ea5a891d774b4e44fd22768afb` | CONFIRMED | root가 계산한 XPI hash를 인용 |
| size | 7,908,402 bytes | CONFIRMED | AMO API metadata |
| file URL | https://addons.mozilla.org/firefox/downloads/file/5043580/torii_image_translator-2.22.4.xpi | CONFIRMED | 다운로드 URL; 인증 불필요 공개 배포 |
| manifest | Manifest V3, background page `bg.html`, popup `popup/popup.html` | CONFIRMED | manifest 선언만 의미 |

## Manifest 확인

| 항목 | 선언 | 의미와 범위 |
|---|---|---|
| 버전 | Manifest V3 | Firefox 배포 아티팩트에 한정 |
| Background | bg.html | Chrome service worker 구조로 일반화하지 않음 |
| 기본 권한 | activeTab, storage, contextMenus, declarativeNetRequestWithHostAccess, unlimitedStorage | 선언된 capability; 실제 사용 경로는 아래 별도 기록 |
| 선택 권한 | downloads | 다운로드 권한은 optional |
| Host | all_urls | 모든 사이트 content 대상 |
| Content | scripts/untaint.js: document_start, MAIN; scripts/content.js | early canvas 관련 script와 content script 분리 |
| Popup | popup/popup.html | 사용자 설정 UI 진입 |
| Web accessible resources | images/css/fonts/html/scripts | 페이지 내 UI·편집 자산 참조 |

단순 symbol count는 library 사용이나 기능 구현의 근거로 채택하지 않았다. 특히 Firebase bundle의 fabric 문자열은 editor dependency 증거가 아니다.

## 선별 source path 확인


아래 offset은 `torii_image_translator-2.22.4.xpi` 내부 UTF-8 JS 문자열의 관찰 위치(문자 offset)다. 원문 코드는 보관하지 않고, 함수명·호출 관계·동작 요지만 기록했다. 모든 항목은 동일한 XPI version/SHA(위 표)를 기준으로 한다.

| Package file + offset | 직접 확인한 path | Evidence / technical meaning | Classification |
|---|---|---|---|
| `scripts/content.js` @ 13,368 | `toriiObserver = new MutationObserver`; observes `document.documentElement` with `childList` | overlay가 document root에서 제거되면 다시 붙이는 DOM lifecycle guard | CONFIRMED (source path) |
| `scripts/content.js` @ 44,000 | `processElement`; scans `img`/`canvas`, checks dimensions and `src/currentSrc` before cache/auto processing | auto mode의 대상은 큰 이미지/캔버스로 제한되고 빈 source는 건너뜀 | CONFIRMED (source path) |
| `scripts/content.js` @ 1,178,000-range | `getImageBlob` | canvas 대상은 `toBlob`; loaded image는 intrinsic dimensions로 canvas draw + blob 추출; 16,000px 초과 또는 tainted/draw 오류면 network fallback | CONFIRMED (source path) |
| `scripts/content.js` @ 1,183,000 | `getImageBlob` network branch | HTTP(S) image는 background에 `prepare-cors`를 보내고 `credentials: include` fetch 후 blob 반환; finally에서 `cleanup-cors` | CONFIRMED (source path) |
| `scripts/content.js` @ 1,186,000 | `getHighestResolutionFromSrcset` / `getTargetUrl` | `srcset` width/density descriptor 중 후보를 고르고 `currentSrc`/`src` fallback; `blob:`은 canvas extraction, canvas element는 `toDataURL` | CONFIRMED (source path) |
| `scripts/content.js` @ 1,189,000 | `translateImage` response handling | background response의 `original`, `inpainted`, `text`, `context`, `translated`를 UI state/DOM에 반영; data URL을 `srcset`에서 제거 | CONFIRMED (source path) |
| `scripts/content.js` @ 1,177,500 | `executePromise` | concurrent promise set과 limit(기본 3), context enabled 시 limit 1/2 등 호출부 제한이 존재 | CONFIRMED (source path) |
| `scripts/background.js` @ 1,494 | startup `declarativeNetRequest.updateSessionRules` | image resource에 `access-control-allow-origin: *` response header를 넣는 session rule을 설치 | CONFIRMED (source path) |
| `scripts/background.js` @ 3,081 | `fetchWithReferer` | referer를 origin으로 정리하고, DNR 사용 시 host별 temporary header rule을 설치한 뒤 `credentials: include` fetch; finally rule 삭제 | CONFIRMED (source path) |
| `scripts/background.js` @ 7,900 | temporary request-header rule | URL host와 resource types `xmlhttprequest/other/image` 조건으로 request headers를 조정하고, cookie header가 있을 때 rule에 포함 | CONFIRMED (source path) |
| `scripts/background.js` @ 25,000 | `handleMessage` `translate` branch | message의 buffer(base64/number array) 우선 사용; 없으면 `msg.url`을 `fetchWithReferer`로 가져와 >3,072-byte blob 기준으로 성공 판단 | CONFIRMED (source path) |
| `scripts/background.js` @ 50,500 | translation upload | multipart form에 blob/url/metadata를 넣고 `POST https://api.toriitranslate.com/api/v2/upload`; 180s timeout; local mode 조건에 따라 direct-api host 선택 | CONFIRMED (source path) |
| `scripts/background.js` @ 31,000 | inpaint branch | multipart inpaint request와 BYOK provider headers를 준비하고 `/api/inpaint` 호출 | CONFIRMED (source path) |
| `scripts/background.js` @ 36,000 | `prepare-cors` / `cleanup-cors` message branch | content script가 요청한 host/origin에 temporary response header rule을 만들고 cleanup한다 | CONFIRMED (source path) |
| `scripts/background.js` @ 17,000 | message chunk reconstruction | `transferId`가 있는 translate/inpaint 등 message를 chunk store에서 재조립한 뒤 처리 | CONFIRMED (source path) |
| `scripts/background.js` @ 87,652 | runtime listener allow-list | `login`, `translate`, `inpaint`, `screenshot`, `prepare-cors`, `cleanup-cors`, cache/account commands를 background handler로 라우팅 | CONFIRMED (source path) |
| `scripts/translationCache.js` @ 1,863 | `TranslationCache` constructor | IndexedDB `TranslationCacheDB`, object store `translations`, schema version 3 | CONFIRMED (source path) |
| `scripts/translationCache.js` @ 4,200 | `onupgradeneeded` | object store 생성 및 `timestamp` index 생성 | CONFIRMED (source path) |
| `scripts/translationCache.js` @ 7,700 / 12,000 | `get` / `put` | key 조회와 timestamp 갱신 저장; timeout/retry/reset 경로 존재 | CONFIRMED (source path) |
| `scripts/translationCache.js` @ 11,512 | `deleteDatabase` | cache reset/cleanup 시 DB 삭제 경로 | CONFIRMED (source path) |
| `scripts/untaint.js` @ 113 / 2,192 | `drawImage` patch | cross-origin source를 판별해 anonymous copy를 비동기 준비하고, draw call을 replay하는 MAIN-world canvas hook | CONFIRMED (source path) |

### 직접 확인했지만 확정하지 않은 것

- `declarativeNetRequest` rule과 `untaint.js`는 이미지/CORS/canvas acquisition을 지원하는 실제 코드 경로가 확인되지만, 이것을 DRM 또는 access-control 우회로 표현하지 않는다. 공개 source가 요청 header/cookie 및 CORS header를 다루는 범위까지만 기록한다.
- `MutationObserver`의 확인된 target은 document root overlay guard이며, image discovery의 전체 callback/threshold는 여러 함수에 걸쳐 있어 이번 좁은 inspection에서 완전한 selector 목록을 만들지 않았다. image auto path의 dimension gate와 source selection은 확인했다.
- API endpoint와 multipart payload 구성(`file`/`url`/metadata), response 주요 키의 소비 경로는 source에서 확인했으나, 인증 header 값·API key·cookie 값은 기록하거나 출력하지 않는다. 실제 live response/credits deduction은 실행하지 않았다.
- `TranslationCacheDB` schema/index와 get/put/cleanup 경로는 확인했지만 실제 cache key의 semantic composition과 payload 전체 schema는 기록하지 않는다.

## 재현 가능한 공개 원문

- AMO metadata: https://addons.mozilla.org/api/v5/addons/addon/torii-image-translator/
- XPI: https://addons.mozilla.org/firefox/downloads/file/5043580/torii_image_translator-2.22.4.xpi
- AMO listing: https://addons.mozilla.org/en-US/firefox/addon/torii-image-translator/

## 남은 미확인 범위

- 전체 image discovery selector, IntersectionObserver threshold 및 모든 site-specific branch.
- 실서비스 요청 성공·오류 응답·credits 변화·latency·provider/model 실행.
- Firebase Auth/Firestore의 실제 persistence 동작과 schema.
- captureVisibleTab의 모든 활성 조건, 공유 editor의 브라우저/서버 renderer parity.
- cache key의 의미 구성과 저장 payload 전체 schema.

API route/multipart 구성, CORS rule 경로, cache DB/object store/index는 위 표의 정적 근거로 확인했다. 이를 다시 UNKNOWN으로 분류하지 않는다. 실제 서비스 호출과 구현 결과는 별도 검증이 필요하다.
