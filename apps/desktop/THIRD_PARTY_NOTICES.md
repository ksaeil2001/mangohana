# Trio 제3자 출처 및 라이선스 고지

대상 릴리스: Trio v0.1.4
기준선 시각: 2026-08-22T19:21:13+09:00

## 적용 범위

이 문서는 현재 작업 트리에서 확인된 외부 프로젝트·모델·데이터셋의 출처와
라이선스 조사 상태를 기록합니다. 현재 저장소에는 모델 가중치나 데이터셋을
vendoring하거나 npm runtime dependency로 직접 포함한 흔적이 없습니다.
`font_ko_fallback` 준비를 위해 Pretendard 폰트 파일과 OFL 원문은 출처·태그·
commit·SHA-256을 고정해 보관합니다. production CMS 서명과 publisher allowlist가
준비되기 전에는 이 자산을 Trio 배포본에 활성화하지 않습니다. 그 밖의 아래
프로젝트들은 설계 문서와 어댑터 경계에서 참고한 출처이며, 별도 승인·라이선스
검토 없이 Trio 바이너리에 복사하거나 번들하지 않습니다.

`.git`이 없는 작업 트리이므로 외부 프로젝트의 적용 commit을 추정하지
않습니다. 원본 코드를 직접 가져오는 경우에는 반드시 원본 repository의
정확한 commit/tag, 가져온 파일, 변경분, 라이선스 파일과 배포 의무를 이
문서의 해당 항목에 추가해야 합니다.

## 제품 코드와 외부 코드의 구분

| 구분 | 현재 위치/상태 | 배포 판단 |
| --- | --- | --- |
| Trio 직접 작성 코드 | `src/`, `electron/`, `scripts/` | Trio proprietary license 적용. 외부 프로젝트 구현을 복사하지 않음 |
| 외부 프로젝트 원본 | Pretendard v1.3.9 폰트와 OFL 원문만 출처 고정 scaffold로 보관 | production CMS 서명 전에는 Trio artifact에 활성화하지 않음 |
| 어댑터/연결 경계 | `src/main/inpainting/adapters/`, `src/main/translation/adapters/` | provider-neutral DTO와 최소 연결층만 유지 |
| 모델·가중치·데이터셋 | 현재 작업 트리에서 bundled artifact 미발견 | 모델별·데이터셋별 license와 hash를 별도 고정한 뒤에만 추가 |

## 조사된 외부 출처

### 인페인팅·클린업

| 출처 | 정확한 commit/tag | 라이선스 상태 | Trio 사용·변경 내용 | 배포 의무/판정 |
| --- | --- | --- | --- | --- |
| [PanelCleaner](https://github.com/VoxelCubes/PanelCleaner) | 적용 없음 — 설계 참고만 확인 | upstream README의 GPL-3.0 고지 확인 | `src/shared/maskMorphology.ts`의 보수적 mask 원칙을 참고했으나 원본 코드는 복사하지 않음 | GPL 코드를 Trio proprietary artifact에 복사하지 않음 |
| [DebubbleBot](https://github.com/wecassidy/debubblebot) | 적용 없음 — 설계 참고만 확인 | 이 기준선에서 LICENSE와 적용 commit을 별도 확인하지 못함 | 자동 말풍선 제거 아이디어의 참고 출처. 직접 호출·복사 없음 | 실제 통합 전 upstream LICENSE와 commit 고정 필요 |
| [BallonsTranslator-vibe](https://github.com/CoSciBlog/BallonsTranslator-vibe) | 적용 없음 — 설계 참고만 확인 | 이 기준선에서 적용 LICENSE/commit 미확정 | OCR·번역·말풍선 흐름의 참고 출처. 직접 호출·복사 없음 | 실제 통합 전 LICENSE와 모델·runtime 의무 분리 필요 |
| ErmangaInpaint | 적용 없음 — 식별 가능한 upstream URL 미확정 | 미확정 | 설계 문서의 이름만 확인되며 runtime import·vendored 파일은 없음 | 이름만으로 배포 출처를 만들지 않음. 통합 전 정확한 URL/commit 필요 |
| [IOPaint](https://github.com/Sanster/IOPaint) | 적용 없음 — 설계 참고만 확인 | upstream LICENSE를 실제 통합 전에 다시 고정해야 함 | inpainting provider 후보. Trio 코드에 원본 복사·dependency 추가 없음 | license, 모델, native runtime을 각각 검토한 후 어댑터로만 연결 |
| [MangaTranslator](https://github.com/meangrinch/MangaTranslator) | 적용 없음 — 설계 참고만 확인 | upstream LICENSE와 적용 commit 미확정 | inpainting registry/provider 경계의 참고 출처. 직접 복사 없음 | 실제 연결 전 license와 배포 파일 분리 필요 |

### OCR·화자·말풍선 연관

| 출처 | 정확한 commit/tag | 라이선스/데이터 상태 | Trio 사용·변경 내용 | 배포 의무/판정 |
| --- | --- | --- | --- | --- |
| [Magi](https://github.com/ragavsachdeva/magi) | 적용 없음 — 연구/모델 참고만 확인 | upstream code와 model license를 통합 시 별도 확인 | 패널·텍스트·캐릭터·화자 연결 아이디어의 참고. `speakerCandidates`는 Trio DTO로 독립 구현 | 모델·가중치·CUDA/native runtime을 자동 포함하지 않음 |
| [Magi ONNX community port](https://github.com/masoniis/magi-onnx) | 적용 없음 — 참고만 확인 | upstream license/model provenance 미확정 | ONNX 변환 가능성의 참고. 현재 dependency/resource pack 없음 | 실제 사용 전 원본 repo와 model provenance를 따로 고정 |
| [Manga109Dialog](https://github.com/liyingxuan1012/Manga109Dialog) | 적용 없음 — golden fixture 참고만 확인 | 코드·annotation·Manga109 원본 데이터의 조건을 분리 확인해야 함 | `calculateSpeakerAssociationMetrics` 테스트 의미의 참고. Manga109 원본 자료를 포함하지 않음 | 데이터셋·annotation을 배포 artifact에 넣지 않음 |
| bubble-detector | 적용 없음 — 정확한 upstream 식별자 미확정 | 미확정 | 설계 문서의 일반적인 검출기 출처명만 확인 | 정확한 URL/license 확인 전 사용 금지 |

### 번역·식자 참고 출처

| 출처 | 정확한 commit/tag | 라이선스 상태 | Trio 사용·변경 내용 | 배포 의무/판정 |
| --- | --- | --- | --- | --- |
| [CarrotMangaTranslator](https://github.com/ucx0204/CarrotMangaTranslator) | 적용 없음 — reference only | 설계 문서상 GPL-3.0으로 기록되어 있으나 실제 통합 없음 | 로컬 모델·식자 UX를 참고. 코드·binary·model을 복사하지 않음 | GPL boundary를 유지하고 실제 provider는 별도 계약으로 검토 |
| [comic-translate](https://github.com/ogkalu2/comic-translate) | 적용 없음 — reference only | 설계 문서상 Apache-2.0으로 기록되어 있으나 실제 통합 없음 | 이미지 번역 흐름을 참고. 원본 코드·asset 미포함 | 통합 시 NOTICE와 변경분 기록 필요 |
| [manga-translator-ui](https://github.com/faldez/manga-translator-ui) | 적용 없음 — reference only | 설계 문서상 GPL-3.0으로 기록되어 있으나 실제 통합 없음 | UI/식자 아이디어를 참고. 원본 코드 미포함 | Trio proprietary code에 GPL source를 복사하지 않음 |

### 배포 준비 중인 한글 fallback 폰트

| 출처 | 정확한 commit/tag | 라이선스 상태 | Trio 사용·변경 내용 | 배포 의무/판정 |
| --- | --- | --- | --- | --- |
| [Pretendard](https://github.com/orioncactus/pretendard) | tag `v1.3.9`, commit `5c41199ea0024a9e0b2cb31735265056e5472d76` | SIL Open Font License 1.1. 원문은 `resources/font_ko_fallback/pretendard-1.3.9/LICENSE.txt`에 보존 | 공식 `Pretendard-1.3.9.zip`에서 `PretendardVariable.ttf`를 변경 없이 추출. 파일·archive SHA-256은 같은 폴더의 `source-manifest.json`에 고정 | OFL과 copyright 고지를 보존합니다. production CMS 서명과 publisher allowlist가 준비될 때까지 package 활성화와 typeset 신뢰 승격을 차단합니다. |

## 현재 npm 의존성

## Production OCR resource pack (external staging)

2026-09-15 기준으로 실제 Production OCR resource pack은 저장소 밖의
`C:\TRIO-Resources\production-ocr\1.0.0\` staging 영역에서 생성·검증했다.
모델 가중치, embedded Python과 Python wheel은 Git repository에 넣지 않는다.
배포 시에는 signed pack 안의 `production-ocr-source-lock.json`과
`licenses/THIRD_PARTY_NOTICES.txt`를 함께 보존해야 하며, 이 두 파일은 CMS
서명된 `resource-manifest.json`의 file hash에 포함된다.

| component | fixed source | license / redistribution decision | required notice or source treatment |
| --- | --- | --- | --- |
| PP-OCRv6 medium detector weight | Hugging Face `PaddlePaddle/PP-OCRv6_medium_det`, revision `8e0f56fb2ef86b461d99cfc7ac5c137738985f61` | Apache-2.0. Model card license가 Apache-2.0으로 고지된 실제 weight만 변경 없이 포함 | Apache-2.0 원문과 exact file SHA-256를 pack에 포함 |
| Baberu OCR weight/tokenizer | Hugging Face `genshiai-daichi/baberu-ocr`, revision `d9cc13153e9a1cd8fdfa3b7b1cc329da2020aeae` | Apache-2.0. repository LICENSE와 exact ONNX/tokenizer SHA-256가 확인된 파일만 변경 없이 포함 | upstream LICENSE와 Apache attribution을 pack에 포함 |
| CPython embedded runtime | official `python-3.10.10-embed-amd64.zip` | PSF-2.0; binary redistribution permitted | Python LICENSE를 포함. `python310._pth`에서 `Lib/site-packages`와 `import site`만 활성화하며 Python binary는 변경하지 않음 |
| PaddlePaddle 3.3.1, PaddleOCR 3.7.0, PaddleX 3.7.2 | exact PyPI wheels recorded in source lock | Apache-2.0 | wheel license files/Apache 원문 및 PyPI version metadata URL을 pack에 포함 |
| ONNX Runtime 1.23.2 | exact PyPI wheel recorded in source lock | MIT | `onnxruntime/LICENSE`, `ThirdPartyNotices.txt`를 pack에 포함 |
| NumPy 2.2.6, Pillow 12.1.0, pypdfium2 5.13.0 and remaining resolved runtime wheels | exact wheel version and SHA-256 recorded for all 79 distributions | respective wheel-declared permissive or notice-bearing licenses | each wheel의 preserved LICENSE/COPYING/NOTICE path와 PyPI version metadata URL을 source lock에 기록 |
| certifi 2026.7.22 | exact PyPI wheel and source distribution | MPL-2.0 | MPL source-availability archive `licenses/source/certifi-2026.7.22.tar.gz`와 SHA-256를 pack에 포함 |
| crc32c 2.9.post0 | exact PyPI wheel and source distribution | LGPL-2.1-or-later | license 원문과 `licenses/source/crc32c-2.9.post0.tar.gz`를 pack에 포함 |
| python-bidi 0.6.11 | exact PyPI wheel and source distribution | LGPL | COPYING/COPYING.LESSER와 `licenses/source/python_bidi-0.6.11.tar.gz`를 pack에 포함 |
| tqdm 4.70.1 | exact PyPI wheel recorded in source lock | MPL-2.0 AND MIT; distribution is used under its MIT option | preserved license path와 source metadata URL을 pack에 포함 |

각 Python dependency의 package/version, wheel filename/byteSize/SHA-256,
declared license, license file path, PyPI release metadata URL은 signed source
lock에 전부 기록된다. 라이선스가 확인되지 않거나 license file을 보존할 수 없는
wheel은 generator가 fail-closed로 pack 생성을 중단한다. LGPL·MPL source
availability archive는 actual release artifact SHA-256와 함께 resource pack에
포함했고, user-visible Production pack을 수정할 때는 해당 고지와 source archive를
같이 갱신해야 한다.

현재 runtime dependency에는 PanelCleaner, IOPaint, MangaTranslator, Magi,
Manga109Dialog 또는 해당 모델 패키지가 없습니다. `package.json`의 직접
runtime dependency와 개발·패키징 dependency는 공개 배포 전에 `npm audit`
결과와 함께 재검토합니다. npm package 자체의 license와 upstream package
notice는 실제 release artifact를 만들 때 lockfile 기준으로 SBOM/notice를
생성해야 하며, 이 문서의 외부 모델 표와 혼합하지 않습니다.

## Trio license와 충돌 가능성

- GPL 계열 프로젝트의 소스 또는 배포 binary를 Trio proprietary artifact에
  복사·번들하는 것은 금지합니다.
- Apache 계열 프로젝트를 실제로 사용하더라도 NOTICE, copyright와 변경
  고지를 별도로 보존해야 합니다.
- 모델 가중치, tokenizer, OCR 데이터와 annotation은 원본 소스 license와
  별개일 수 있으므로 각각의 license, 사용 제한, 재배포 가능 여부와 hash를
  고정합니다.
- 현재 문서는 “참고만 확인된 출처”를 기록한 것이며, 실제 통합 승인이나
  법률 검토를 대체하지 않습니다.

## 실제 통합 시 기록 템플릿

```text
프로젝트:
원본 URL:
적용 commit/tag:
LICENSE/NOTICE URL:
사용 파일:
Trio 변경 파일:
직접 변경 내용:
모델/가중치/데이터셋 출처:
배포 의무:
검토자/검토일:
```
