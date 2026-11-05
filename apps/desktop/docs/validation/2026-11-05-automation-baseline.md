# 망고하나 자동 처리 기준선 — 2026-11-05

이번 작업은 **원인 분석, 검수 판정·식자 계산의 제품 개선, 실제 로컬 모델·앱 검증**이다. 특정 이미지의 번역·좌표·줄바꿈 보정은 하지 않는다. **처음 보는 만화에서 한 번 실행으로 최종 한국어 이미지를 만드는 전체 목표는 아직 미완료**다. 아래 최초 기준선 이후의 발견·실행은 문서 끝의 후속 검증 기록으로 구분한다.

## 보존 범위

작업 시작의 `main@2a754df6feb5b99299267565b1953b08a687293f`와 미커밋 변경을 기준으로 코드·문서·설정·자산 697개, 22,698,425바이트를 물리 복사하고 SHA-256을 대조했다. 기존 삭제 상태 15개도 기록했다. 과거 `artifacts/`, 검증용 `qa/tmp-worker*`, 화면 캡처는 기존 위치에 유지했다. 이 수치는 사용자 디스크 전체나 과거 산출물 전체의 추가 백업을 뜻하지 않는다.

- 사본·소스 해시·시작 Git 상태·기존 변경 patch: `C:/Users/ksaei/.codex/visualizations/2026/11/05/01a1ab48-5a49-7fa1-bf68-4ab76a004836/automation-baseline/`.
- 이번 실행 근거: `C:/trio-main/artifacts/automation-quality-20261105/`.
- 기존 UI/V2 작업, 원본 `.ctp`, 사용자 설정, 설치 모델, 기존 증거, 전역 지침과 의존성은 이번 변경으로 교체하지 않는다. 생성물은 이번 전용 하위 폴더에 둔다.

## 최초 조사 시의 제품 연결 상태

| 단계 | 현재 코드·설정 | 이번에 직접 확인한 실행 범위 |
| --- | --- | --- |
| DETECTION | `ProductionOcrService`의 `PP-OCRv6_medium_det@8e0f56fb…`, CPU. 전체 페이지와 1200px 타일 검출 | 서명된 설치 팩 전체 검증 후 두 원본에서 실제 검출 실행 |
| GROUPING / READING_ORDER | 방향·간격·두께·겹침에 따른 기존 공통 규칙 | 같은 제품 모듈로 그룹화·순서 생성. 의미상 순서 정답은 사람 검수 대기 |
| CROP / RECOGNITION | 기존 공통 crop geometry, 회전 0, `Baberu@d9cc1315…`, ONNX CPU | 기존 geometry와 실제 recognizer 사용. Electron `nativeImage` 대신 Pillow로 디코딩·crop한 분리 진단이므로 앱 실행과 구별 |
| TRANSLATION | 저장된 설정은 `local_ai / ollama / qwen2.5:7b-instruct`, `localhost:11434` | 해당 주소 연결 거절. 표준 Ollama 실행파일·모델 manifest 경로에서 설치를 찾지 못함. 다른 설치 위치는 미확인. 실제 번역 호출은 하지 않음 |
| MASK / INPAINT | 현재 작업대는 사용자 브러시 마스크. provider 기본값·선택값과 서버의 실제 모델은 별개 | 자동 OCR 마스크 연결 없음. `local-lama`는 설정값이며 서버 checkpoint 증거가 아님. 8080/7860의 검사 주소 연결 거절. 실제 인페인팅 미실행 |
| TYPESETTING / 저장 | 한국어 공통 줄바꿈·도형 배치와 Canvas 렌더링. AI 식자 모델 없음. `userTranslation`·검토된 배경·폰트·준비 상태 검사 후 PNG/ZIP 저장 | 관련 저장·검토·내보내기 회귀 확인. 이번 원본에서 최종 식자 이미지 생성·저장·재열기는 미실행 |

근거 위치는 `electron/main.ts:240`, `src/main/productionOcrService.ts`, `src/main/ocr/`, `src/main/imageCrop.ts`, `src/main/batch/batchExecutionCoordinator.ts`, `src/shared/batchAutomation.ts`, `src/renderer/imageBurnInRenderer.ts`, `src/main/projectImageExport.ts`다. 저장된 provider 설정에서는 필요한 비밀 아닌 선택값만 확인했으며 설정을 변경하지 않았다.

`PP-OCRv6_manga`와 Hayai의 모델 정의·런타임·테스트는 있지만, 현재 앱 생성자에 `mangaOcr` 옵션이 전달되지 않는다. **코드 존재를 실제 선택이나 설치 완료로 계산하지 않는다.** 기존 웹의 Gemma/Flux 실험 경로도 현재 Electron 기본 번역·인페인팅 경로가 아니다. 웹이 기대하는 Gemma/Flux 가중치 경로는 이번 조사에서 존재하지 않았고, 이는 다른 위치의 설치까지 없다는 주장은 아니다.

현재 batch는 OCR·인페인팅 활성 요청을 거부하고 번역 제안과 기존 사용자 번역의 식자 배치를 처리한다. AI 제안을 `userTranslation`으로 자동 승격하지 않으며 최종 이미지 출력도 별도 동작이다. 이 때문에 **현재 제품에는 OCR→자동 마스크→인페인팅→번역→최종 출력의 한 번 실행 경로가 없다.** 사용자 검토·확정 계약과 기존 편집값을 우회해 연결하지 않았다.

## 실제 OCR 기준선

| 입력 | 용도 | 실제 호출 | 결과 | 시간·자원 |
| --- | --- | --- | --- | --- |
| 기존 `07` 원본 | 이미 개발에 쓴 자료 | probe 1 / detect 7 / recognize 23 | 23개 제안, 경고 0. 그림 일부가 문자로 인식됨 | pipeline 176.95초, 이 중 진단용 crop 13.58초. 별도 서명·파일 검증 48.76초. 메모리 측정 불가 |
| 제공 폴더의 `원본 이미지 1.png` | 이번에 확보한 개발 자료 | probe 1 / detect 7 / recognize 4 | 대사·이름표 4개 제안, 경고 0. 사람 정답 대조 전 | pipeline 67.88초, 이 중 진단용 crop 4.72초. 별도 서명·파일 검증 30.31초. OCR 자식 프로세스 peak working set 약 1.19GiB, peak commit 약 1.92GiB |

시간은 다른 입력 간 기준선이며 전후 성능 향상 수치가 아니다. Pillow crop 비용이 포함되어 일반 Electron 성능으로 전용하지 않는다. 두 실행 모두 원본 SHA-256 유지와 소유한 OCR 자식 프로세스의 종료를 관측했다. `close()`가 요청한 SIGTERM 종료를 자연 종료 코드 0으로 표현하지 않는다. 자원은 `GetProcessMemoryInfo`, 500ms 간격과 OS 프로세스별 peak 값으로 관측했으며 전체 시스템·GPU 사용량이나 동시에 합산한 메모리 peak는 측정하지 않았다.

실제 Electron 진단은 CJS 진입과 ready 대기 기록 후 `0x80000003`으로 종료됐다. 진단 launcher의 인자 파싱과 모듈 로딩 순서는 바로잡았지만 기동 실패 원인은 미확정이다. `--no-sandbox`는 격리 진단에만 사용했고 배포 설정을 변경하지 않았다. Node에서 성공한 구성요소 실행을 Electron 앱 E2E나 일반 기동 성공으로 보고하지 않는다.

### 첫 오류 단계의 분류

| 관찰 | 분류와 근거 | 현재 결론 |
| --- | --- | --- |
| `07`의 땀방울·옷 단추 crop이 `00`, `0`, `D`로 인식됨 | **DETECTION**: recognizer에 전달되기 전부터 글자가 아닌 그림이 검출 영역에 들어옴. 저장된 crop을 원본과 대조 | 인식 모델 교체나 특정 출력문 삭제로 해결하지 않는다. 공통 검출·문자 존재 판별을 이후 비교할 우선 대상 |
| `おやご` 후리가나가 본문과 별도 제안으로 나옴 | **GROUPING / TRANSLATION 분류** 후보: 실제 작은 글자이므로 단순 오인식·삭제 대상으로 취급할 수 없음 | 본문에 대한 읽기 보조 역할·중복 번역 여부를 사람 검수해야 함 |
| 인식 점수처럼 보이는 confidence와 경고 0 | provenance의 `confidenceSource`는 `detector_min`. 인식 텍스트 정확도 확률이 아님 | 경고 0을 OCR 정답·전체 품질 합격으로 계산하지 않음 |
| 현재 입력에서 CROP·RECOGNITION·READING_ORDER 오류 여부 | 실행은 관측했으나 사람 정답 OCR·좌표·순서 없음 | 오류율 미측정. 이 단계가 모두 정확하다고 판정하지 않음 |
| TRANSLATION / MASK / INPAINT / TYPESETTING | 새 입력에서 실제 후단 실행 없음 | NOT RUN. 후단 원인이나 새 이미지 품질 향상을 추정하지 않음 |

`DETECTION, GROUPING, CROP, RECOGNITION, READING_ORDER, TRANSLATION, MASK, INPAINT, TYPESETTING` 각각에서 첫 잘못된 입력·출력과 다음 단계로 전달된 자료를 근거로 분류한다. 기동·설치·서버 미준비는 실행 환경 차단으로 기록하며 검출 모델의 품질 실패와 혼동하지 않는다.

## 이번 제품 수정: 검사하지 않은 결과의 허위 통과 방지

원인 코드와 직접 회귀는 `src/main/inpaintingQaInspector.ts`, `tests/main/inpaintingQaInspector.test.ts`다.

| 기록 항목 | 결과 |
| --- | --- |
| 변경 전 | 키가 없고 바이트 길이가 64 이상이면 잔여 검사를 실행하지 않고 `pass / 1.0`. 누락·손상 QA JSON도 빈 잔여 목록으로 이어질 수 있음 |
| 원인 | 검사 미실행·응답 검증 실패를 실제 검출 결과 `[]`와 동일하게 처리 |
| 공통 수정 | 미실행·요청 실패·JSON·영역 필드 검증 실패는 `manual_review`. 잔여 후보가 있지만 낮은 confidence로 공유 필터에서 모두 사라지는 경우도 원후보를 보존해 `manual_review`로 남김. 유효한 명시적 빈 목록의 기존 PASS와 기존 RETRY/MANUAL_REVIEW는 보존. 원문 응답·키를 경고에 노출하지 않음 |
| 변경 후 | 실제 PNG 4개에 대한 로컬 검사 호출 비교에서 이전 `pass` → 현재 `manual_review`. 모델·인페인팅 호출은 0이며 원본은 동일 |
| 다른 이미지·회귀 | `07` 원본/과거 결과와 제공 1번 원본/참고에 공통 적용. 이는 이미지 생성 품질·원문 제거율 개선이나 전체 평가 합격 증거가 아님. 정상 QA 응답과 기존 저장·내보내기 차단 계약을 회귀 검사 |
| 시간·자원 | 실제 PNG의 분기 실행 시간을 기록했으나 단일 JS 호출·초기화 영향이 있어 성능 향상 수치로 사용하지 않음. 모델 자원 변화는 미측정 |

기존 필수 숫자 DTO를 유지하기 위해 검사 불가 결과의 `cleanlinessScore`는 보수적 표시값 0을 유지하고 reason에 **미측정**을 표시한다. 이는 실제 청결도 0이라는 측정값이 아니다. 이번 별도 평가 자료는 검사 실행 여부를 명시하고 해당 품질 점수를 `null`로 기록한다. 기존 프로젝트를 일괄 재검사·재저장하지 않았다.

## Golden Test Set 입고와 정답 상태

사용자가 지정한 `C:/Users/ksaei/Downloads/새 폴더 (2)`에서 원본 6개와 번역 참고 6개를 별도 폴더에 복사하고 크기·SHA를 고정했다. 원본은 2040×2880, 참고는 1771×2500이다. 참고 이미지가 다른 크기이므로 정답 마스크·좌표나 픽셀 단위 복원 정답으로 곧바로 쓰지 않는다.

- 개발 자료: 과거 `07`과 제공 1번. 모델 결과와 OCR 좌표는 **AI 제안**이며 정답 칸과 분리한다.
- 제공 1~6번 모두 **이전에 본 자료**다. 사용자가 폴더 전체를 과거에도 제공했다고 정정했고, 기존 `2026-10-02-manga-web-workspace-contracts-and-validation-plan.md` 10.86절(2026-10-11)에 6쌍 전부 확인, 1/3/5 개발·2/4/6 후속 평가 사용 계획이 기록돼 있다. 독립 미사용 holdout은 0페이지다. 이번 초기 입고 기록의 2~6번 미사용 후보 표시는 `continuation/prior-use-correction.json`으로 정정하며 원기록은 보존한다.
- 사람이 검증한 OCR·좌표·번역 정답: **0페이지**. `groundTruth.status=pending`, 미검증 점수 `null`. AI가 본 이미지나 참고 이미지의 파일명을 사람 검수 사실로 대체하지 않는다.
- 검수 자료: `artifacts/automation-quality-20261105/supplied-corpus/review-dev01.html`, `dev01-human-review.json`, `intake-manifest.json`. 원본/참고/OCR 제안을 대조하되 확인한 사람·시각·정답 텍스트·좌표·순서·번역을 별도로 남긴다.
- 홀드아웃 결과를 보고 코드를 조정했다면 해당 페이지·crop·재인코딩본·동일 작품의 개발 사용 관계를 재분류하고, 다음 최종 평가에는 별도의 미사용 자료를 확보한다.

따라서 **실제 자료 입고와 평가 기반은 만들었지만 Golden 정답 세트 구축은 아직 미완료**다.

## 반복 가능한 평가

평가 도구는 [evaluate-automation-quality.mjs](../../scripts/evaluate-automation-quality.mjs)다. 모델을 실행하거나 제품 상태를 바꾸지 않고 명시한 corpus와 run의 아티팩트를 읽는다. 제품 IPC·`.ctp`·승인 schema를 추가하지 않는다.

```powershell
node scripts/evaluate-automation-quality.mjs artifacts/automation-quality-20261105/corpus/corpus-final.json artifacts/automation-quality-20261105/corpus/run-baseline-final.json artifacts/automation-quality-20261105/corpus/new-report.json
```

출력 파일은 새 경로만 허용한다. 정답은 사람 검수 상태·검수자·시각·영역별 텍스트/번역/정규화 좌표/순서로 구성한다. 개발·평가의 작품 ID·원본 해시·중복 그룹 교차를 거부하고, 원본·OCR·최종 PNG의 SHA와 corpus digest를 검증한다. OCR의 해시 고정 provenance 기록도 현재 run ID·원본 SHA·OCR SHA와 대조한다. 정답 후보와 실제 제품 입력은 분리한다. 초기 `v2`와 `reviewed` 산출물은 중간 기록으로 보존하며, 최종 비교에는 입고 기록의 시각·해시를 연결한 `corpus-final.json`, `run-baseline-final.json`, `baseline-report-final.json`을 사용한다. 정식 holdout 분할은 아직 대기 상태다.

OCR은 최종 제안 영역을 IoU 0.5 이상의 일대일 매칭으로 대응한다. 매칭 수를 먼저 최대화하고 그 안에서 전체 IoU 합을 최대화하며 텍스트나 예측 순서를 매칭 가중치에 사용하지 않는다. 문자 오류는 Unicode codepoint·NFKC 기준으로 공백·문장부호를 보존하며 누락 영역은 삭제, 추가 영역은 삽입으로 계산한다. **이는 원시 검출기의 recall이 아니다.** 기하 정보만으로 구별할 수 없는 동일 영역의 대응은 사람 검토가 필요하다. 읽기 순서 오류도 별도 기록하며 사람 검수 전에는 계산하지 않는다.

무수정 한 번 실행 성공에는 `actual_product`, 전체 9단계 수행, OCR 근거, 최종 PNG 저장·재열기, 수동 수정 0·자동 재시도 0, 사람 정답과 품질 5항목의 검수가 모두 필요하다. 품질 항목은 의미, 누락·중복, 원문 잔여, 그림 보존, 식자 가독성이다. 최종 품질 검토는 run ID·원본 SHA·최종 PNG SHA와 일치해야 한다. 구성요소 실행·과거 결과 재사용·fixture·pending은 성공으로 세지 않는다. 미실행 대상도 명시하며 분모에서 조용히 제외하지 않는다.

이 도구는 실제 모델 실행·검수자의 신원·숨겨진 수동 보정 여부를 자체 인증하지 않는다. PNG 검사는 헤더·크기·해시 수준이며 전체 디코딩을 대신하지 않는다. 실행 로그·저장/재열기 근거·사람의 검수 기록을 함께 유지한다. 이번 run은 실제 제품 완주 0개, 구성요소 실행 2개, 사람 검수 대기 2개다. 이는 번역 품질 0%라는 측정값이 아니다.

## 검증과 남은 일

직접 QA 회귀는 처음 수정 전 76실패/8통과에서 수정 후 84통과를 확인했다. 이후 낮은 신뢰도 후보의 허위 PASS 경로를 추가로 재현해 1실패/85통과 → 최종 86통과를 확인했다. 평가기는 독립 검토의 매칭·출처 결함 보완을 포함해 합성 회귀 18개가 통과했다.

관련 8파일 86개 회귀의 첫 실행은 84통과/2실패였다. 실패 2개는 격리 임시 폴더 내 export staging 디렉터리의 `rename EPERM`이며, assertion·제품 코드를 바꾸지 않고 같은 격리 환경의 해당 2개만 샌드박스 밖에서 실행해 2통과를 확인했다. 두 로그를 보존하고 이를 단일 실행의 무조건 통과로 합쳐 표현하지 않는다. 이 회귀는 공유 저장·검토·내보내기·사용자 소유권 경로를 검사하며 최종 inspector 보완에서 해당 경로의 코드는 바뀌지 않았다. Renderer와 Main 타입 검사, 최종 독립 검토·보존 비교의 결과는 `artifacts/automation-quality-20261105/verification-final.json`에 남긴다.

정답의 사람 검수와 독립 평가 분할은 계속 미완료다. 아래 후속 실행과 단위 테스트 성공으로 완전 자동 번역 제품의 완료를 선언하지 않는다.

## 후속 검증: 기존 로컬 설치 연결과 실제 앱 후보 실행

사용자는 기존 설치를 직접 찾아 재사용하고, 없으면 로컬 환경을 설치·연결하며 제공 이미지에서 한국어 PNG 저장까지 실행하도록 승인했다. `C:/Users/ksaei/.mangohana`에서 기존 Gemma4-E2B GGUF(3,106,738,272바이트), LaMa ONNX(208,044,816바이트), llama.cpp CUDA 런타임을 찾았다. 설치 provenance와 실제 SHA를 대조했다. **최초 연결 시점에는** 신규 모델·의존성을 설치하지 않았으며, 후속 격리 GPU 실행 환경 설치는 아래에 따로 기록한다. 모델 가중치와 실사용 provider 설정은 교체하지 않았다. 정확한 경로·해시는 `continuation/reused-assets-pins.json`에 고정한다. Hayai·만화 전용 PP 모델도 설치되어 있지만 현재 기본 앱 생성자의 OCR 경로에는 연결되지 않는다.

제한된 도구 실행 환경에서는 같은 프로세스 안의 Python 로컬 HTTP 자가 검사도 WinError 10013으로 실패했지만, 승인된 호스트 실행에서는 같은 검사가 200이었다. 같은 최소 Electron 진입도 호스트 실행에서 ready/종료 0을 확인했다. 전역 방화벽·보안 정책을 바꾸지 않고 실제 앱과 모델을 로컬 통신이 가능한 같은 실행 환경에서 구동한다. 최초 `0x80000003`의 모든 원인이 증명됐다는 주장은 아니다.

`scripts/local-preview/` 실행기는 실제 Main·preload·서명 검증 OCR·기존 번역 adapter·로컬 인페인팅 adapter·기존 Canvas 식자를 연결한다. 자신이 만든 `.ctp`·profile·temp·자산만 사용하고 외부 전송·키·사용자 확정 IPC를 차단한다. OCR·번역은 메모리의 AI 제안이며 사용자 대사로 채택하지 않는다. 로컬 LaMa 브리지는 앱의 제거 알파 0을 모델의 흰색 제거 마스크로 변환하고, 원본 크기·알파·마스크 밖 RGB 보존을 검사한다. 모델 성공과 QA 합격·사용자 승인을 분리한다.

저장 결과는 **검토용 후보 PNG**이며 정식 UI export 성공과 구별한다. 로컬 잔여 검사 결과는 여전히 `manual_review`, 프로젝트 최종 상태는 `needs_review`다. 후보에는 별도 resolver로 AI 번역을 표시하며 제품의 기본 사용자 번역 전용 식자와 승인 조건은 보존한다. 말풍선 크기 추정·자동 마스크는 helper의 후보 생성 실험이며 기존 제품 UI에 연결된 공통 기능 개선으로 세지 않는다.

실행 중단 기록도 보존한다. 최초 앱 실행은 inline helper가 CSP에 막혀 모델 호출 전 중단됐다. CSP를 완화하지 않고 외부 파일 script 방식으로 수정했다. 다음 실행은 실제 OCR 4개 영역 반환(330.35초) 후 비어 있던 페이지 결과 폴더 소실로 저장에 실패했다. 이는 모델 추론 실패가 아니며 번역·인페인팅은 호출하지 않았다. 이후 폴더 변경 관찰·원시 OCR 상위 기록·페이지 시작 메타데이터를 추가했다. 감시 로그 자체를 다시 기록하던 실행기 오류도 발견해 해당 전용 트리만 종료하고 자기 로그 제외 조건을 수정했다. 이를 첫 실행 성공이나 모델 자동 재시도 개선으로 계산하지 않는다.

### 공통 코드 수정의 전후 근거

| 변경 | 이전 결과·처음 잘못된 단계 | 실제 코드·알고리즘 | 이후 결과·다른 사례·회귀·비용 |
| --- | --- | --- | --- |
| 가로 식자 중심·폭 단위 | `relativeY`를 다시 중심 보정해 글줄이 아래로 밀림. 글꼴 크기는 높이 단위인데 폭을 정사각형처럼 비교. **TYPESETTING** | `imageBurnInRenderer.ts`, 공유 `typesettingGeometry.ts`: 중심 좌표 중복 제거, 실제 pixel width/height 비율로 줄바꿈·자동 글꼴·넘침 계산 | 80×400·600×100 등 합성 회귀의 수정 전 10실패→수정 후 핵심 40통과. 실제 1번에서 이름표가 2줄→1줄이지만 다른 대사는 88px→40px로 작아져 **전체 가독성 개선으로 판정하지 않음**. 같은 OCR·번역·배경의 전후 PNG를 저장. 모델 추가 호출 없이 식자만 비교 |
| 내보내기 준비 검사 일치 | 렌더러만 실제 비율을 쓰고 준비 검사는 정사각형으로 판단해 넓은 글상자를 잘못 차단할 수 있음. **TYPESETTING** | `typesettingReadiness.ts`, `App.tsx`의 기존 export 구간: 기존 이미지 로드 후 `beforeRender` 동기 검사에 실제 크기 전달. 다른 차단 조건·IPC 그대로 | 가로·세로 상자의 Canvas/준비 검사 일치, 기존 세로쓰기·명시 글꼴·사용자 값 보존 검사. App 선택 6통과·1기존 실패. 기존 실패는 변경 전 export 함수로도 입력란 조회 단계에서 재현. 이미지 중복 로드·새 모델 호출 없음 |
| 서명 한글 폰트 연결 | Main은 서명된 고정 폰트 6,739,336바이트를 200으로 반환하지만 실제 Browser는 먼저 CSP, 다음에는 미등록 CORS 스킴 때문에 차단. **TYPESETTING** | `index.html`: 고정 `trio-resource://font`만 font-src에 허용. `electron/main.ts`: 폰트 스킴만 corsEnabled. `productionTypesetFontResource.ts`: 정확한 고정 URL의 공개 폰트 200 응답에만 ACAO `*` | 실제 새 Electron의 `FontFace.load()` 및 제품 loader 성공. 관련 25검사 통과. 잘못된 URL·서명·junction은 차단 유지, private 이미지 스킴·CSP bypass는 변경하지 않음. 로딩 성공은 의미·식자 품질 합격과 별개 |
| 로컬 LaMa 마스크 연결 | 실제 Canvas PNG가 alpha=0 픽셀의 보이지 않는 RGB를 0으로 바꿔 bridge가 정상 마스크까지 400으로 거절. **MASK** | 검증 bridge `lama_http.py`: 제거 위치는 이진 alpha만 사용, 보존 RGB 흰색·크기·완전 이진 alpha 검사 유지. source bytes·mask 밖 결과 RGB·전체 alpha 검증 | 수정 전 투명 RGB 2경우 오류→합성 32검사 통과. 실제 1번에서 같은 mask SHA로 모델 실행·별도 자산 저장. 원본/사용자 승인 상태와 제품 IPC 계약 변경 없음 |
| CPU 인페인팅 작업량 | 1번 17타일, 세션 준비 7.41초·추론 51.90초·전체 worker 60.03초여서 bridge 55초/앱 60초 내 미완료. **INPAINT** | 검증 `lama_worker.py`: 원래 모델·512 타일·32 halo·추론·출력 검증은 유지, 일반 마스크의 격자 시작점 64개를 비교해 활성 core 수 최소화. 모든 제거 픽셀 1회 덮기·비중첩·동점 원래 격자 | 1번 17→8타일, 실제 Main 인페인팅 약 35초 성공. 서로 다른 측정 경계이므로 공정한 전체 제품 속도 향상률로 환산하지 않음. 2번은 24→20타일이어도 55초 초과. 합성 4검사 통과. 임시 int32 적분 배열 약 23.5MB가 추가되며 전후 전체 메모리 차이는 미측정. 타일 내부 138,259픽셀이 달라져 시각 품질 별도 검토 필요 |

위 bridge·타일·후보 말풍선 배치·자원 해제 실험은 `scripts/local-preview/`의 검증 경로다. 기존 제품 UI에 자동 마스크·인페인팅 일괄 실행 기능이 연결됐다고 보고하지 않는다. 정상 동작을 통과시키기 위해 인식 결과·검수 assertion·모델 해시·외부 API·사용자 승인 조건을 완화하지 않았다.

### 실제 실행·실패와 후보 결과

`app-regression-run-04`의 1번은 OCR 4영역·번역 4건을 생성했지만 최초 마스크 변환에서 실패했다. 2~6번의 OCR은 각각 별도 sidecar PID로 시작해 native exit `0xC0000005`를 반환했다. 해당 호출은 약 57.36 / 54.90 / 26.40 / 15.78 / 11.61초였다. **같은 오류 메시지라고 해서 죽은 Promise를 재사용한 즉시 실패라고 판단하지 않는다.** 탐지 요청 경로로 좁혔지만 이미지 디코딩·Paddle 초기화·predict 중 정확한 내부 단계와 fault module은 미확인이다. 현재 기본 모델을 바꾸지 않았다.

`app-final-after-font`는 새 OCR 4영역(277.76초)·번역 4건(요청 합 1.69초)까지 도달했다. probe 1 / detect 7 / recognize 4의 응답을 모두 기록했다. 첫 요청 전 Main 준비 약 184.6초와 sidecar 요청 약 93.1초를 구분한다. 인페인팅 호출 중 renderer 자식이 사라지고 소유 세션 cleanup·HTTP 취소가 관측됐으나 renderer 종료 사유는 미확정이다. OCR private memory 약 2.05GB 상주·시스템 commit 압박은 원인 후보이며 OOM으로 확정하지 않는다. 검증 driver의 evaluate 대기에는 기본 20초 설정이 적용되지 않아 별도 IPC deadline·crash 감시를 추가했다. 응답 없는 이번 전용 트리만 정리했다.

`app-korean-candidate/page-01/`은 **기존 실제 OCR·번역 제안을 재사용**하여 실제 LaMa·Main 자산 저장·제품 Canvas 번인·2040×2880 PNG 저장·nativeImage 재열기를 완료했다. 후보 실행 시간 약 36.11초에는 재사용한 OCR·번역의 원래 추론 비용이 포함되지 않는다. 수정 전후 이미지를 같은 텍스트와 cleaned asset으로 비교했다. 마스크 밖 5,461,235픽셀의 변경 0, 전체 alpha 변경 0을 디코딩 후 확인했으며 이는 마스크 안의 그림·원문 제거 품질 합격을 뜻하지 않는다.

실제 시각 검토(AI 관찰, 사람 정답 아님)에서는 중간 말풍선의 줄 일부가 테두리와 겹치고, 페이지 경계에 닿는 말풍선은 OCR 글자 상자를 넓히지 못해 대사가 작아졌다. 배경 복원의 띠·작은 잔여 흔적, 호칭·이름 표기 불확실성과 이름표의 `(20)` 누락도 남는다. 원문 숫자가 빠졌는데 기존 번역 QA가 100점을 반환한 사례를 의미 검수 합격으로 사용하지 않는다. **무수정 최종 품질 합격은 아니다.**

private `translation-image://asset/<token>`는 실제 `crossOrigin=anonymous` Canvas 로딩이 CORS에 막혔다. 공개 폰트와 다른 개인정보 경계이므로 해당 스킴에 ACAO `*`/`null`을 추가하지 않았다. 후보 검증 host만 기존 소유 세션 검사로 얻은 token을 Main에서 읽고 data URL로 전달한다. 현재 코드에서는 자산 SHA·20MiB도 대조한다. **정식 UI의 직접 token 식자·내보내기는 여전히 미완료**다. 이 우회를 제품 수정 완료로 보고하지 않는다.

2번 자원 분리 실험은 새 OCR 11영역(218.98초), 자기 OCR child의 성공 결과 확보 후 SIGTERM 종료 관측(약 0.10초), 번역 11건까지 완료했으나 CPU LaMa 20타일이 55초를 초과했다. 이 실험은 제품 소스의 수명 변경이 아니며, 이전 renderer 종료의 원인 확정도 아니다. 실제 crop을 대조하면 `いい`는 원문에 존재하는 손글씨·효과음 성격이라 단순 그림 오검출로 삭제할 수 없고, `ならかあやしいし` 제안의 crop에는 `なんかあやしいし` 전체가 보여 **RECOGNITION** 오류 후보로 좁힐 수 있다. crop 누락·방향 오류·원문 후처리 삭제로 단정하지 않는다.

### 설치·실행 환경 비교

기존 CPU Python·모델은 유지했다. 별도 DirectML 1.23.0 venv에는 공식 PyPI wheel 25.1MB를 설치했으나 첫 실제 타일에서 메시지가 없는 RuntimeException으로 실패했다. 프로파일에는 DML 46 / CPU 10 kernel 이벤트가 있고, 장치 0이 RTX라는 확인은 없다(Intel 내장 GPU와 RTX가 모두 있음). 세션 생성·provider 목록만으로 GPU 인페인팅 성공을 선언하지 않았다. 실패는 `directml-first-tile-diagnosis.json`과 실제 프로파일·설치 report에 남긴다.

후속 NVIDIA 환경은 기존 CPU와 같은 ONNX Runtime 1.23.2로 비교하며, 신규 환경·임시 다운로드는 `E:/Mangohana-Local-AI-Validation-20261105-01a1ab48/`에 제한한다. C 여유 부족으로 중단한 이번 설치의 특정 wheel 임시 파일만 확인·정리했다. 사용자 파일·기존 모델·기존 Python·전역 환경 설정은 삭제·교체하지 않았다. provider 비교의 공식 근거는 [ORT CUDA 설치·DLL preload](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)와 [DirectML 제약](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)이며, 실제 적용 결과는 별도 런타임 기록으로 판단한다.

CUDA의 첫 실패는 `cudnn_engines_tensor_ir64_9.dll`의 지연 로드 검색 경로 누락으로 확인했다. 설치된 NVIDIA DLL 디렉터리를 worker 프로세스의 DLL 검색·PATH에만 연결했다. 전역 PATH와 기존 Python은 변경하지 않았다. 동일한 20타일의 별도 프로파일은 CUDA 110,160 / CPU 54,720 kernel 이벤트를 기록했다. 이는 CUDA/CPU 혼합 실행이며 서로 다른 graph node 개수나 전 연산 GPU 실행 비율이 아니다. 첫 타일 약 5.71초, 나머지 약 0.2초의 모델 실행을 관측했지만 대량 프로파일을 포함한 실행은 55초를 넘었다. 기본 실행에서 프로파일 수집·파싱을 끄고 별도 `--profile` 진단으로 남긴 뒤 같은 입력의 정상 응답·저장을 확인했다.

| 실제 실행 | OCR·번역 재사용 | OCR / 번역 / 인페인팅 / 식자·재열기 | 결과와 해석 |
| --- | --- | --- | --- |
| 1번 CPU 후보 `app-korean-candidate` | 둘 다 재사용 | 신규 OCR·번역 0 / CPU 약 35초 / 나머지 포함 전체 36.11초 | 후보 PNG 저장. 원래 OCR·번역 비용을 포함한 End-to-End 시간이 아님 |
| 1번 CUDA 회귀 `app-page01-cuda-regression` | 둘 다 재사용 | 신규 OCR·번역 0 / CUDA 36.17초 / 식자·재열기 2.24초, 전체 38.76초 | 기존 성공도 유지됐지만 이 조건에서는 CPU보다 빨라지지 않음. 다른 OCR 준비와 병행·캐시·초기화 영향이 있어 단독 benchmark 아님 |
| 2번 CUDA 제안 재사용 `app-page02-cuda-normal` | 둘 다 재사용 | 신규 OCR·번역 0 / CUDA 13.53초 / 식자·재열기 1.91초, 전체 15.75초 | CPU에서 동일 20타일이 55초를 넘겼던 사례의 후보 생성 완료. 동일 원본·마스크·모델·타일 계획 유지 |
| 2번 새 실행 `app-fresh-cuda-02-03/page-01` | 없음 | OCR 264.97초 / 번역 2.67초 / CUDA 14.11초 / 식자·재열기 2.31초, 전체 284.45초 | 실제 새 OCR부터 PNG 저장·재열기 완료. 검증 host의 OCR 종료·data URL 전송을 포함한 실험 경로 |
| 3번 같은 명령의 후속 실행 `app-fresh-cuda-02-03/page-02` | 없음 | OCR 91.11초 / 번역 1.43초 / CUDA 13.69초 / 식자·재열기 2.30초, 전체 108.84초 | 7영역으로 후보 PNG 저장·재열기 완료. 이번 코드 조정에 쓰지 않은 기존 회귀 자료이며 처음 보는 만화는 아님 |

재사용 raw 기록의 `translationMs`에는 이전 제안 파일에 들어 있던 시간이 남아 있다. 위 표와 비교에서는 **새 번역 호출 0**으로 처리한다. 실행기를 보완해 이후에는 현재 실행 시간과 이전 제안의 시간을 별도 필드로 기록한다. 초기 실패·개발 재실행을 지우거나 최신 성공에 합쳐 무수정 첫 실행 성공률을 높이지 않는다.

최종 fresh 명령의 두 페이지는 자기 OCR child를 각각 종료 관측한 뒤 다음 모델을 시작했다. 이는 제품 기본 런타임의 수명을 바꾼 결과가 아니다. 재시작된 두 번째 child의 일부 요청 이미지 observer 파일은 이름 충돌 `EEXIST`로 저장되지 않았으며, 모델 응답·최종 OCR provenance·원본 SHA는 남아 있다. 향후 기록은 PID를 파일명에 포함해 충돌을 막는다. 이 누락을 OCR 오류나 완전한 crop 추적 성공으로 보고하지 않는다.

디코딩 후 1번 CPU·CUDA 및 fresh 2·3번의 cleaned 이미지에서 **모두 마스크 밖 픽셀 변경 0, 전체 alpha 변경 0**을 확인했다. 1번의 같은 8타일 CPU/CUDA 출력은 39픽셀에서 채널 차이 최대 1이었다. 모델 내부 수치 차이가 작다는 근거이며 의미·원문 제거·가독성 합격과는 다르다. 2번에서는 작은 효과음의 뜻을 대사처럼 번역한 사례와 판독 오류가 남고, 3번에서는 서로 다른 말풍선·화자의 텍스트가 한 그룹으로 묶여 패널 경계를 넘는 배치가 관측됐다. **GROUPING**을 먼저 검토하고, 그림 위/작은 글씨의 **DETECTION·RECOGNITION**, 안전 영역이 없는 **MASK·TYPESETTING**, 번역 의미와 인페인팅 잔여를 별도 검토한다. 아직 사람이 확인한 정답이 없으므로 오류율 수치는 만들지 않는다.

자원 표본은 `resource-summary-final.json`에 있다. fresh 실행 전용 프로세스 트리에서 동시 sampled working set 최대 약 2.58GiB, sampled private memory 합 최대 약 6.35GiB, 장치 전체 GPU 최대 4,237MiB를 관측했다. 샘플 간격·동시에 진행한 검증·다른 프로그램의 장치 사용이 포함되므로 단독 전체 자원 peak나 공정한 전후 메모리 향상률이 아니다. CUDA arena 2GiB 설정도 전체 VRAM 제한이 아니다.

### 이번 차수의 판정과 다음 우선순위

기존 사용자 작업을 보존한 채 실제 모델 경로를 찾고, **검증 host에서 fresh 2페이지와 제안 재사용 후보·회귀 1페이지**의 한국어 PNG를 확보했다. 제품 공통 코드에는 허위 인페인팅 PASS 방지, 식자 좌표·폭 단위와 준비 검사 일치, 서명 한글 폰트 연결 수정을 반영했다. 자동 마스크·GPU bridge·OCR 자원 해제·후보 전송은 별도 검증 경로이며 제품 UI의 한 번 실행 기능으로 채택하지 않았다.

평가 자료는 `corpus/corpus-current.json`, `run-followup-current.json`, `followup-quality-report.json`, `human-review-template-current.json`이다. 과거 corpus/run은 덮어쓰지 않았다. 7페이지 모두 사람 정답·품질 검수 대기, 정식 UI 실제 제품 완주·자동 품질 합격·독립 미사용 holdout은 각각 0이다. 평가기의 자격 충족 성공 0을 번역 정확도 0%라는 측정으로 읽지 않는다. AI 제안은 정답 칸에 자동 복사하지 않았다.

남은 우선순위는 (1) 소유 세션·폐기 안전성을 유지하는 private 이미지 Canvas 전달과 제품 자동 후보 연결, (2) 패널·화자 경계를 넘는 그룹 및 말풍선 안전 영역, (3) 사람이 확인한 OCR·번역·품질 정답과 독립 미사용 작품 평가, (4) cold OCR 준비 비용·반복 native 종료와 자원 공존 원인 분리다. **새 만화 무수정 한 번 실행의 개발 완료 판정은 내리지 않는다.**

관련 최종 검사는 renderer/helper/runner 68개, 폰트/Main 등록 25개, Python bridge·tile·CUDA 메타데이터 57개가 통과했다. App 선택 검사 6통과·1기존 실패와 변경 전 동일 재현 기록은 그대로 남긴다. 기존 QA 86개·평가기 18개는 앞선 기록과 구별하며 관련 소스를 바꾸지 않았으므로 이유 없이 재실행하지 않았다. Main/renderer 타입 검사, 격리 mirror 빌드, 실제 저장 PNG 재열기, 보존·모델 SHA·프로세스 정리와 독립 검토의 근거는 `continuation/`에 보존한다. 이 검사 성공을 정식 export·출시·사람 품질 합격으로 확대하지 않는다.

최종 독립 검토에서 검증 실행기의 timeout 이후 후속 페이지 진행과 번역·식자 evaluate 무기한 대기 경로가 추가로 발견됐다. 공통 deadline·fatal 취소 신호를 모든 실제 Main/renderer evaluate에 적용하고, timeout·renderer 유실·OCR 종료 미확인은 전체 실행을 중단하도록 수정했다. 이후 페이지 요청을 금지하고 소유 앱의 실제 종료를 확인한다. 강제 종료 명령 자체에도 4초 timeout과 별도 응답 제한을 적용해, 명령 미응답 뒤에도 자식 종료 관찰과 실패 기록까지 도달하게 했다. 합성 지연/미응답·후속 호출 0·정상 페이지 오류 guard 5개, 종료 3개, 종료 미확인 실패를 포함한 집계 5개, 총 13개가 통과했다(`request-cleanup-final.log`). 이 변경은 실행기의 실패 처리이며 AI 알고리즘을 바꾸지 않아 모델을 재실행하지 않았다.
