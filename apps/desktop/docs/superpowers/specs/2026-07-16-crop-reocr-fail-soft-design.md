# Crop ReOCR Fail-Soft Design

## 목적

전체 이미지 OCR과 검증이 성공한 뒤 실행되는 Crop ReOCR 하나가 실패해도 전체 OCR 결과를 폐기하지 않는다. 성공한 Crop ReOCR 결과는 적용하고, 실패한 대상은 전체 이미지 검증 결과를 유지한 채 사용자에게 경고한다.

## 확인된 원인

`project:validateSpeechBubbles`는 전체 이미지 검증 후 낮은 신뢰도 또는 `[?]`가 포함된 영역마다 Crop ReOCR을 순차 실행한다. 현재 루프에는 대상별 오류 격리가 없어 Gemini가 잘린 이미지 하나에 `Unable to process input image`를 반환하면 IPC 전체가 reject되고 renderer는 이미 성공한 OCR 결과를 표시하지 못한다.

## 선택한 처리 방식

Crop ReOCR은 보조 품질 향상 단계다. 각 대상의 이미지 자르기와 Gemini 호출을 하나의 `try/catch`로 격리한다.

```text
전체 이미지 OCR
→ 전체 이미지 검증
→ Crop 대상별 처리
   → 성공: 결과 병합 후보에 추가
   → 실패: 원본 검증 결과 유지 + 경고 추가
→ 성공한 Crop 결과만 병합
→ OCR 검토 화면 표시
```

하나의 Crop이 실패해도 나머지 대상의 Crop ReOCR은 계속 실행한다. 모든 Crop이 실패해도 검증된 전체 이미지 결과를 반환한다.

## 결과 및 경고

성공한 Crop 결과는 기존 `mergeCropReocrResults` 규칙을 그대로 사용한다. 실패한 대상은 텍스트, confidence, bbox, readingOrder, speakerCandidates를 변경하지 않는다.

실패 경고는 결과의 `warnings` 배열 끝에 다음 형식으로 추가한다.

```text
Crop ReOCR skipped for #<readingOrder>: <safe error message>
```

오류가 `Error`가 아니거나 메시지가 비어 있으면 다음 fallback을 사용한다.

```text
Crop ReOCR skipped for #<readingOrder>: Unable to re-OCR this crop.
```

API 키, 요청 헤더, 이미지 데이터, 로컬 절대 경로는 경고에 포함하지 않는다.

## 변경 범위

### `src/main/ipcHandlers.ts`

- Crop 대상별 이미지 자르기와 Gemini 호출을 `try/catch`로 격리한다.
- 성공 결과와 실패 경고를 별도로 수집한다.
- 성공 결과를 병합한 뒤 실패 경고를 기존 warnings 뒤에 추가한다.

### `tests/main/ipcHandlers.integration.test.ts`

- 전체 이미지 검증은 성공하지만 Crop ReOCR API가 실패하는 응답을 재현한다.
- IPC가 reject되지 않고 검증된 전체 이미지 결과를 반환하는지 확인한다.
- 원본 텍스트와 confidence가 유지되는지 확인한다.
- 실패 경고에 readingOrder와 안전한 오류 메시지가 포함되는지 확인한다.
- 여러 Crop 중 하나가 실패해도 다음 Crop이 실행되고 성공 결과가 병합되는지 확인한다.

## 보존 사항

- 전체 이미지 OCR 및 전체 이미지 검증 실패는 기존처럼 오류로 처리한다.
- `GEMINI_API_KEY`, `GEMINI_TEXT_MODEL` 및 provider 선택 방식은 변경하지 않는다.
- Crop 선택 기준, crop padding, 병합 판단 규칙은 변경하지 않는다.
- IPC 계약, 프로젝트 스키마, 패키지, 보안 설정은 변경하지 않는다.
- OpenAI 검증 경로는 변경하지 않는다.

## 테스트 및 완료 기준

- Crop ReOCR 오류를 재현하는 테스트가 수정 전 실패한다.
- 수정 후 해당 테스트와 기존 Crop ReOCR 성공 테스트가 통과한다.
- 전체 테스트, 타입 검사, 프로덕션 빌드가 통과한다.
- 실제 Electron에서 같은 이미지로 OCR을 실행했을 때 진행 상태가 사라진 뒤 OCR 검토 결과가 표시된다.
- 실패한 Crop이 있으면 검토 결과에 경고가 보이지만 전체 OCR 작업은 계속할 수 있다.
