# OCR·인페인팅 실제 비교 기록 — 2026-10-04

이번 기록은 메인 구현과 분리한 기술 비교 시험이다. 제품 소스·설정·저장 형식·운영 DB·배포를 변경하지 않았다. 측정 결과로 후보와 후속 검증을 좁혔으며 최종 제품 모델을 확정하지 않았다.

## 현재 판단

- **일본어 로컬 OCR에는 Manga OCR을 우선 비교 후보로 유지한다.** 같은 정답 crop에서 Baberu의 반복 오인식이 있었고 Manga OCR은 이 작은 표본에서 오류가 없었다.
- **PP-OCRv6 탐지·그룹화 공정은 재사용 후보로 유지한다.** 합성 9장에 대한 영역 연결 대조에서는 누락이 없었고 중국어 밀집 사례 한 곳이 나뉘었다. 픽셀 검출 recall이나 실제 만화 검출 정확도를 뜻하지 않는다.
- **방향 처리와 인식기를 분리해 평가해야 한다.** Baberu의 회전 영어 실패 두 건은 정답 방향으로 돌린 제어 시험에서 해결됐다. 자동 각도 추정은 시험하지 않았다.
- **CTD 자동 마스크 + LaMa를 다음 실제 자료 검증 후보로 권고한다.** 정답 마스크의 이점뿐 아니라 자동 마스크의 결과도 확인했다. 이 시험은 CTD의 raw segmentation에 임계값·팽창·선택 영역 제한을 적용했으며 공식 `refine_mask` 전체 공정은 실행하지 않았다.
- **CTD CPU 후보는 OpenCV DNN을 먼저 검토한다.** 같은 가중치·입력에서 OpenCV의 세 이진 마스크가 ONNX Runtime 결과와 일치했고, 관측 시간 차이가 컸다. 웹 호스트 성능 보장은 아니다.
- **Gemini도 유효한 품질 비교 후보다.** 합성 자료 12회가 모두 정상 응답했다. 같은 crop 48개에서는 일본어 2문자 오류, 중국어·영어 오류 0이었다. 전체 페이지 좌표는 공식 0~1000 규칙으로 해석한 오프라인 대조에서 연결되었으며, 처음 픽셀 좌표 요청의 실패를 별도로 보존했다.

## 자료와 실행 범위

| 항목 | 실제 수행 |
| --- | --- |
| 직접 만든 합성 자료 | 일본어·중국어 간체·영어 × 단순·혼합 방향·밀집 = 9장, 정답 영역 48개 |
| Baberu 인식 | 같은 정답 crop 48개 |
| Manga OCR 인식 | 일본어 정답 crop 16개, 실제 자료 crop 29개 |
| PP-OCRv6 인식 | 정답 line crop으로 46개 영역 구성. 회전 영어 2개는 line 정답이 없어 제외 |
| Gemini 3.5 Flash Lite · LOW | 합성 전체 페이지 9회 + 같은 crop 16개씩 언어별 batch 3회 = API 요청 12회 |
| 전체 페이지 공정 | 합성 9장 + 사용자가 지정한 실제 일본어 자료 중 3장 |
| 실제 자료 보존 | 세 페이지 모두 읽기 전·후 SHA-256 일치. 원본·crop 외부 전송 0 |
| LaMa | 영역 마스크 3회 + 정답 글자 마스크 3회 + 자동 CTD 마스크 3회 = 9회 실제 추론 |
| 자동 마스크 | CTD ONNX Runtime 3회, OpenCV DNN 3회 대조 |
| 영어 방향 제어 | 기존 실패 crop 2개에 알려진 -90도 회전 적용 후 Baberu 2회 |

각 언어는 8개의 고유 문장을 모양을 바꿔 반복한다. 16개 crop을 16개의 독립적인 실제 만화 표본으로 취급하지 않는다. 일본어·중국어 세로쓰기는 글자를 세로로 쌓았고 영어 혼합 사례는 일부 문장 전체를 90도 돌렸다. 후리가나·효과음·저해상도·손글씨·여러 실제 글꼴을 대표하지 않는다.

## OCR 문자 비교

CER은 NFKC와 공백 제거 뒤 문자 편집 거리 / 정답 문자 수다. 아래는 문장부호를 유지하는 비교다. 낮을수록 좋다. 문장부호를 제외한 별도 결과도 `evaluation.json`에 기록했다.

| 모델과 입력 준비 | 일본어 | 중국어 간체 | 영어 |
| --- | --- | --- | --- |
| Baberu · 말풍선 정답 crop | 3 / 225 (1.33%) | 3 / 196 (1.53%) | 63 / 459 (13.73%) |
| Manga OCR · 같은 말풍선 정답 crop | 0 / 225 (0.00%) | 시험 범위 아님 | 시험 범위 아님 |
| Gemini · 같은 crop, 언어별 batch | 2 / 225 (0.89%) | 0 / 196 (0.00%) | 0 / 459 (0.00%) |
| PP-OCRv6 · 정답 line crop, 세로 열은 원래 방향 | 27 / 225 (12.00%) | 23 / 196 (11.73%) | 0 / 412 (0.00%) |

PP-OCRv6는 줄 단위 입력이고 다른 모델은 말풍선 단위 입력이다. Gemini는 언어마다 crop 16개를 한 요청에 담았으며 정답 문자열은 보내지 않았다. 위 전체 수치만으로 인식기 우열을 확정하지 않는다. PP-OCRv6에는 upright 세로 열에 대한 reflow나 각도 보정 공정을 연결하지 않았다. 가로쓰기만 보면 일본어 2 / 200 (1.00%), 중국어 1 / 174 (0.57%), 영어 0 / 412 (0.00%)였다.

Baberu는 일본어 `沿って`를 `治って`로, 중국어 `沿着`를 `没着`로 읽는 오류가 세 모양에서 반복됐다. 정답 crop에서도 발생했으므로 이 사례의 오류를 전체 페이지 탐지 탓으로 돌릴 수 없다. Manga OCR은 일본어 16개 crop의 225문자 비교에서 오류가 없었다. 작은 합성 표본의 결과이며 일반 정확도 100%를 뜻하지 않는다.

Baberu 영어 가로쓰기 14개는 0 / 412 (0.00%)였다. 90도 회전 두 영역은 크게 실패했지만 알려진 각도로 되돌린 제어 시험에서는 47문자 모두 일치했다. 실제 페이지에서 그 각도를 자동으로 찾는 기능의 증거는 아니다.

실제 자료 3장에서 얻은 같은 crop 29개는 Baberu·Manga OCR 출력이 정규화 후 17개 일치하고 12개 달랐다. 사람 정답을 붙이지 않았으므로 어느 모델이 더 정확한지는 아직 판정하지 않았다. 원문·출력은 격리 임시 폴더에만 보관하고 이 저장소의 보고서에는 복제하지 않았다.

## Gemini 전체 페이지와 좌표 계약

`gemini-3.5-flash-lite / LOW`로 보낸 12회는 모두 `STOP`으로 끝났으며 JSON 구조·crop ID·좌표의 유한값·출력 cap 검증을 통과했다. 계정 무료 등급은 이번 사용자 확인에 근거한다. 계정 설정·유료 전환은 변경하지 않았고 청구서를 독립 조회하지 않았다. API 사용량은 입력 63,032, 출력 8,664, 보고된 thinking 0 token이었다.

최초 시험은 이미지 픽셀 좌표를 요청했다. 반환된 값을 그대로 픽셀로 해석하면 정답 48영역 중 34영역을 연결하지 못한다. 이후 원출력을 변경하지 않고 0~1000 좌표로 해석하여 원래 이미지 크기로 환산했다. 이 규칙은 [Google의 공식 이미지 좌표 문서](https://ai.google.dev/gemini-api/docs/generate-content/image-understanding)와 일치한다. 추가 API 호출은 없다.

환산 대조에서는 합성 9장의 48영역 모두 연결됐고 연결된 원문의 문자 오류는 0 / 880이었다. 이는 사후 좌표 대조 결과이며 처음 요청한 픽셀 계약의 성공으로 바꾸지 않는다. 영역 연결은 bbox 교집합 기준이고 픽셀 검출 정확도·읽기 순서·각도 추정의 품질은 별도 검증이 필요하다. 한 번의 합성 시험에서 전체 페이지 문맥이 잘린 crop보다 좋았다는 관측을 모든 만화에 일반화하지 않는다.

Gemini 요청별 관측 시간은 전체 페이지 2.82~4.84초(중앙값 3.36초), 16 crop batch 3.89~4.14초였다. batch 시간을 crop 1개 시간이나 로컬 모델의 순수 추론 시간과 직접 비교하지 않는다. 로컬 모델의 실패 결과를 본 뒤 모델을 대체하거나 Gemini를 재시도하지 않았다.

## 마스크와 LaMa 비교

![합성 배경별 실제 인페인팅 비교](inpainting/comparison-final.png)

배경 오차는 동일한 평가 영역에서 글자 픽셀을 제외한 위치의 RGB 절대 오차 평균(0~255)이다. 깨끗한 원본 배경을 직접 만들었기 때문에 계산할 수 있다. 마스크 밖은 원래 입력 픽셀로 합성했다. 이 불변 검사는 마스크 안의 복원 품질·최종 사용자 승인을 대신하지 않는다.

| 배경 | 영역 전체 마스크 | 정답 글자 마스크 | 자동 CTD 마스크 | 자동 마스크 글자 픽셀 recall |
| --- | ---: | ---: | ---: | ---: |
| WHITE | 0.938 | 0.235 | 0.264 | 100.00% |
| HATCH | 8.442 | 2.542 | 3.339 | 99.44% |
| LINE_ART | 2.328 | 0.478 | 0.580 | 98.48% |

전체 9회에서 합성 후 마스크 밖 픽셀 변경은 0이었다. 자동 마스크에는 일부 글자 픽셀 누락이 있었고 선택 영역은 합성 시의 정답 bbox로 제한했다. 실제 검출 영역·전체 페이지에서의 잘못된 제거 성능은 미검증이다.

정답 글자 마스크는 렌더러의 글자 픽셀을 이용한 상한 비교다. 자동 마스크는 CTD 확률 > 0.3, 5×5 팽창, 선택 영역 제한이다. 0.5·0.7 민감도도 기록했지만 제품 기본값으로 결정하지 않았다. 픽셀 precision은 팽창으로 의도적으로 포함한 주변 배경도 오탐 픽셀로 센다. 따라서 이를 텍스트 영역 오탐률처럼 해석하지 않는다.

## 실행 엔진·시간·메모리

| CTD 입력 | ONNX Runtime CPU | OpenCV DNN CPU | 두 이진 마스크의 차이 |
| --- | ---: | ---: | ---: |
| WHITE | 67.78초 | 2.57초 | 0픽셀 |
| HATCH | 76.11초 | 2.21초 | 0픽셀 |
| LINE_ART | 62.26초 | 2.21초 | 0픽셀 |

CTD 입력은 1024×1024, LaMa 입력은 512×512였다. CTD 두 backend는 같은 모델 SHA와 RGB 정규화, 임계값, 팽창, 선택 영역을 사용했다. 가중치 SHA는 `1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f`다. backend당 사례별 1회 값이며 격리 CPU 점유·p95·운영 실행 상한을 정하지 않는다.

LaMa 관측은 추론당 2.82~3.39초, 해당 Python 프로세스에서 샘플링한 최대 RSS는 810.7 MiB였다. CPU 4 threads의 고정 512 ONNX port이며 원래 PyTorch LaMa와의 수치 parity나 운영 호스트 성능은 이번 범위 밖이다.

실제 일본어 페이지의 PP-OCRv6 + grouping + Baberu 공정은 15.58~18.16초였다. 원래 Baberu sidecar는 ONNX Runtime 기본 thread 설정을 유지했다. 다른 인식기는 4 threads였고 Manga OCR은 전처리를 제외한 추론 시간이므로 각 crop 시간을 그대로 비교 순위로 쓰지 않는다.

Node + child 프로세스 트리는 관측 후반 76.5초 동안 0.25초 간격으로 273회 샘플링했다. 샘플링 구간의 최대 RSS 합계는 2.01 GiB다. 초기 로딩부터 전체 실행 최대값을 측정한 것은 아니다. 호스트는 Windows, 논리 CPU 20개, RAM 15.63 GiB다. 호스팅·전기·유휴 시간·공통비 금액은 측정하지 않았다.

## 실행 근거와 한계

- 기존 OCR의 CMS 서명·publisher pin·파일 체크섬·runtime probe를 유지했다. 검증에는 160.02초가 걸렸다.
- 관련 생성 JS 23개를 현재 TypeScript emit과 비교했고 최종 파일 해시도 재확인했다. 실제 탐지·그룹화·인식 코드를 사용했다.
- Electron 앱 직접 실행은 그래픽 초기화 오류로 실패했다. Node 시험에서는 이미지 decoding/crop만 sharp·PNGJS 어댑터로 제공했다. 합성·실제 자료의 78개 crop 좌표를 변경하지 않은 제품 함수와 대조해 모두 일치했다. native image decoding의 픽셀 parity, Electron UI·IPC·저장·검토 흐름의 완료 증거는 아니다.
- 기존 Manga OCR 가중치의 cache revision과 SHA가 일치함을 재검증했다. 추가 PP-OCRv6·LaMa 가중치는 공개 revision 고정·upstream LFS SHA 검증 후 임시 폴더에 받았다. CTD release asset은 공개 digest가 없어 크기를 대조하고 받은 바이트의 SHA를 기록했다.
- [CTD 코드 저장소](https://github.com/dmMaze/comic-text-detector)의 라이선스는 GPL-3.0이다. 이번 실행용 exported 가중치의 제품 배포 조건까지 확인한 것은 아니다. 코드와 가중치의 라이선스·제품 통합 범위는 실제 채택 판단에서 확인해야 한다.
- 제품 dependencies·설치된 모델 팩·사용자 설정은 수정하지 않았다. 실제 자료와 모델 바이너리는 격리 임시 폴더에 두고 이 artifacts 폴더에는 원본 합성 자료·스크립트·익명 측정 기록만 남겼다.
- Gemini 시험은 합성 페이지 9회 + crop batch 3회로 완료했다. 같은 모델/LOW, 요청당 출력 cap 8192, 모델 대체·자동 재시도·유료 전환 없음이다. 실제 만화 이미지·crop·원문은 외부 API로 보내지 않았다.
- 실제 자료의 인간 정답·제거 대상 mask·선화 보존 검수가 필요하다. 이번 실제 자료는 일본어 한 작품의 3페이지다. 실제 중국어·영어 작품·여러 작가 holdout·자동 각도·full mask refinement·전체 번역/식자 공정은 미검증이다.
- Linux/실제 웹 서버 환경, 동시 요청, 전체 실행 상한, 전체 원가와 출시 품질은 미검증이다. 로컬 WSL 서비스 조회는 접근 제한으로 사용할 수 없었다.
- 이 사이드 대화의 제약상 하위 에이전트 독립 검토는 수행하지 않았다. 제품 채택·아키텍처 변경을 승인한 기록으로 사용하지 않는다.

## 근거 파일

- [평가 JSON](results/evaluation.json), [합성 자료 명세](synthetic-manifest.json)
- [OCR 공정·정답 crop 기록](results/node-ocr.json), [Manga OCR](results/manga-ocr.json), [PP-OCRv6 인식](results/paddle-rec.json)
- [실제 자료 인식기 일치/불일치](results/manga-real-summary.json), [방향 제어](results/rotation-control.json)
- [LaMa](results/lama.json), [CTD](results/ctd.json), [OpenCV 대조 1](results/ctd-opencv-control.json), [OpenCV 대조 2](results/ctd-opencv-remaining.json)
- [다운로드 검증](model-download-receipts.json), [Manga 모델 검증](results/manga-model-receipt.json), [메모리 표본](results/node-process-memory.json)
- [Gemini 준비 요청](results/gemini-plan.json), [실제 Gemini 응답](results/gemini.json), [crop 좌표 대조](results/crop-parity.json), [대화형 합성 결과 비교](comparison.html)
- [최종 검증](results/final-validation.json), [Electron 실패 종료 기록](results/electron-attempts-reconciliation.json), [보고서 검사](results/report-audit.json)

공식 원출처: [Manga OCR](https://github.com/kha-white/manga-ocr), [Baberu](https://huggingface.co/genshiai-daichi/baberu-ocr), [PaddleOCR](https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec), [CTD](https://github.com/dmMaze/comic-text-detector), [LaMa ONNX port](https://huggingface.co/Carve/LaMa-ONNX), [원래 LaMa](https://github.com/advimman/lama).

## 후속 개발 인계

사용자 의도, StoneCandy·Carrot 소스 조사, 클라우드 운영과 조판/폰트 평가의 후속 방향은 [클라우드 운영·페이지 품질 개발 인계](../../docs/superpowers/specs/2026-10-04-manga-web-cloud-quality-development-handoff.md)에 연결했다. 이 링크 추가는 본 보고서의 측정 결과·품질 한계·실행 범위를 변경하지 않는다.
