# Carrot 탐지·OCR·문맥·번역 상세 근거

**지정 커밋 `721e709d3706f15ed1ef62270460d4b8ab5d5312`에서 확인한 정적 구현 근거입니다.** 파일 수정과 모델·테스트·앱·제품 API 실행은 하지 않았으며, 전수 분석이나 제품 품질 완료를 주장하지 않습니다. 아래 경로는 별도 표기가 없으면 `src/main/` 기준입니다.

1. **탐지**  
   기본 Hayai 경로는 `prepareHayaiRegions` → `detectPageTextRegions` → Koharu ONNX 탐지입니다. 앱이 text/onoma/bubble/panel 결과를 일반 텍스트 영역과 효과음 후보로 구성합니다. 모델은 `ShiniShiho/koharu-layout-rfdetr-seg-2xl-1152-onnx`이며 revision·파일 검증 정보가 고정돼 있습니다.  
   근거: `textDetection/hayaiRegionPrepass.ts:18,69`, `pageTextRegionDetector.ts:19`, `bubbleLayout/constants.ts:5,7,17`, `hayaiRegionGeometry.ts:126`. 탐지 모델 내부·실제 누락률은 미검증입니다.

2. **OCR·언어 자동 판별**  
   Hayai는 탐지 bbox를 잘라 `JustANormalTinkerer/hayai-ocr-v2`로 읽고 일반 대사와 효과음 결과를 분리합니다. 기본 recognition batch는 8입니다. Paddle 대안은 언어·품질·backend 설정으로 인식기를 구성합니다.  
   근거: `runtime/hayai-bboxes.py:47,79,343,368,405`, `runtime/paddleocr-bboxes.py:855`.  
   **`auto`는 독립 언어 탐지 모델의 결과가 아닙니다.** Paddle는 `auto`를 `ch` 인식기로 연결하고, Hayai 명령은 source-language를 전달하지 않습니다. 번역 프롬프트가 블록별 문자·원문에서 언어를 판단하도록 지시합니다.  
   근거: `paddleocr-bboxes.py:790`, `simple-page-ocr-commands.cjs:101`, `semantic-ocr/fixed-block-translation.cjs:349`. 언어별 정확도·혼합 언어 성능은 미검증입니다.

3. **읽기순서·후리가나**  
   Hayai 초기 영역은 위쪽 y부터, 동률이면 오른쪽 영역부터 정렬됩니다. 별도 공통 함수는 행을 묶어 RTL/LTR 정렬하고 저장된 `blockOrder`를 처리합니다. UI에 순서 이동·자동 정렬이 있습니다.  
   근거: `textDetection/hayaiRegionGeometry.ts:1752`, `src/shared/blockReadingOrder.ts:19,53`, `src/renderer/src/hooks/useBlockReadingOrderActions.ts:21,70`.  
   Paddle 일본어 semantic 경로는 body/ruby를 구분하여 번역 원문에는 body, bbox에는 ruby를 포함합니다. `runtime/semantic-ocr/fixed-block-translation.cjs:274`. 전역 패널 관계를 판단하는 별도 읽기순서 모델은 확인하지 못했고, 수동 순서가 모든 프롬프트에 반영되는지는 미확인입니다.

4. **문맥**  
   기존 작품 용어집·인물 말투·지침과 최근 페이지 기억을 전달합니다. 표준 번역도 기존 문맥을 사용하며, 누적 실행은 앞선 화의 저장 기억을 읽고 새 용어·인물 후보를 원문·번역문 근거에 대조해 병합합니다. 이전 화 이미지를 보내는 경로는 아닙니다.  
   근거: `pipeline/workContextPrompt.ts:18,58`, `previousChapterContext.ts:29`, `cumulativePageContext.ts:39`, `groundedPageContextCandidates.ts:4,25`.  
   최근 기억은 6페이지 중심이며 예산 부족 시 문맥을 생략하고 사용자 지침·말투는 보호합니다. `src/shared/workContextBudget.ts:80,127,328`. 인터넷 조사는 사용자 선택 후 초안 반영·저장하는 제안 경로입니다. 텍스트 AI 분석 백엔드는 있으나 조사한 UI·IPC 연결은 찾지 못했습니다: `ipc/workContextIpc.ts:85,217`.

5. **번역·제공자**  
   새 Hayai workflow는 탐지 → OCR → 원문 규칙 → 번역 등의 고정 단계 순서를 사용합니다. 번역 단계는 **저장·교정된 `sourceText`를 재사용**합니다. 기존 일괄 실행은 OCR을 묶어 준비한 뒤 페이지별 번역과 문맥 갱신을 순차 수행합니다.  
   근거: `application/pageWorkflowService.ts:109`, `pageWorkflow/pageWorkflowTranslation.ts:39`, `wholePagePipeline.ts:520,666,683`.  
   제공자는 로컬 Gemma와 원격 OpenAI 호환 API·Codex·Claude Code로 분기합니다. `pipeline/runtimeModules.ts:64,68,69,72,75`. 고정 블록 응답은 모델의 좌표 재작성을 제한하며, 구조 오류 복구 후 저하된 결과에는 `needs_review`를 남깁니다. `runtime/semantic-ocr/fixed-block-translation.cjs:355`, `pipeline/pageResponseParser.ts:149`. 취소·revision 검사도 있으나 실제 원격 취소 보장은 미검증입니다.

관련 테스트 **존재와 일부 assertion**은 확인했습니다: `tests/translationRuntimePort.test.ts:223`, `pageWorkflowAdapters.test.ts:168`, `fixedBlockFallbackReview.test.ts:39`, `previousChapterContext.test.ts:11`. 실행·통과 근거는 없습니다.

대표적으로 읽은 파일은 위 탐지/OCR 래퍼, `wholePagePipeline.ts`, `pipeline/pageResultBuilder.ts`, `pageWorkflow/pageWorkflowOcr.ts`, `pageWorkflowTranslation.ts`, `previousChapterContext.ts`, `runtime/transport/translation-request.cjs`입니다. 외부 모델/API 내부와 제공자별 의미 정확도·속도·비용·품질 우위는 모두 미검증입니다.