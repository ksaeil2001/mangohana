# Trio 인페인팅 및 마스크 파이프라인 아키텍처 고도화 구현 계획

> **상태**: 구현 완료, 공개 릴리스 검증 진행 중
> **작성일**: 2026-08-21
> **대상**: Windows x64 데스크톱 앱 (Trio)
> **상위 사양서**: [`docs/superpowers/specs/2026-08-21-inpainting-and-mask-pipeline-architecture-design.md`](../specs/2026-08-21-inpainting-and-mask-pipeline-architecture-design.md)
> **관련 계획**: [`docs/superpowers/plans/2026-08-03-carrot-local-model-integration-plan.md`](2026-08-03-carrot-local-model-integration-plan.md)

제품 전체 테스트, 패키지 smoke와 실제 Windows 설치 검증 상태는 `docs/release/v0.1.4-readiness.md`에서 별도로 추적한다.

---

## 1. 개요 및 실행 목표

본 계획은 6대 오픈소스 벤치마크(PanelCleaner, DedubbleBot, BallonsTranslator-vibe, ErmangaInpaint, IOPaint, MangaTranslator)로부터 도출된 핵심 설계 원칙을 Trio의 인페인팅 및 마스크 서브시스템에 단계적으로 구현하고 검증하는 로드맵을 정의한다.

```text
[Phase 1: 마스크 독립 자산 분리] (DedubbleBot)  ─── 완료
               │
               ▼
[Phase 2: 보수적 마스킹 & Fail-Soft] (PanelCleaner) ─── 완료
               │
               ▼
[Phase 3: 2차 잔여 텍스트 QA & 자동 재시도] (BallonsTranslator-vibe) ─── 완료
               │
               ▼
[Phase 4: 환각 감지 & 다단계 Fallback] (MangaTranslator) ─── 완료
               │
               ▼
[Phase 5: 스크린톤·선화 & 실행 비용 벤치마크] (Ermanga / IOPaint) ─── 완료
               │
               ▼
[Phase 6: UI/UX 연동 및 통합 검증] ─── 완료
```

---

## 2. 단계별 구현 세부 계획

### Phase 1: 마스크의 독립 자산화 및 데이터 모델 확장 (DedubbleBot 원칙)
- **목적**: 마스크 데이터를 임시 메모리가 아닌 독립된 `.ctp` 프로젝트 자산으로 영속화하여 마스크 재사용, 수동 수정 및 작업 이력 복원력을 보장한다.
- **수행 작업**:
  1. [`src/shared/projectTypes.ts`](../../../src/shared/projectTypes.ts):
     - `DerivedImageAsset` 타입 내 마스크 자산 메타데이터(`maskAssetId`, `sourcePageImageId`, `isUserModified`) 및 `role: "mask"` 확장.
  2. [`src/main/inpaintingAssets.ts`](../../../src/main/inpaintingAssets.ts):
     - `writeInpaintingMaskAsset()`으로 마스크 PNG 자산을 `assets/images/page-XXX-mask-YYY.png` 형태로 원자적 저장 및 SHA-256 해시 계산.
     - 기존 마스크 불러오기 및 캔버스 로드 IPC 핸들러 연동.
  3. **테스트**:
     - `tests/storage/inpaintingAssets.test.ts`: 마스크 독립 자산 생성, 경로 격리 및 무결성 검증 통과.

### Phase 2: 보수적 마스킹 및 불확실 영역 Fail-Soft 정책 (PanelCleaner 원칙)
- **목적**: 불확실한 배경 텍스트나 복잡한 선화 겹침 영역을 무리하게 지우지 않고 원본을 안전하게 보존한다.
- **수행 작업**:
  1. [`src/shared/maskMorphology.ts`](../../../src/shared/maskMorphology.ts):
     - `applyConservativeMaskDilation()`으로 외곽선 침범을 방지하고 최대 6px 이내로 안전 팽창 및 안전 영역 클리핑 지원.
  2. [`src/renderer/components/InpaintingEditor.tsx`](../../../src/renderer/components/InpaintingEditor.tsx):
     - "보수적 경계 보존 (PanelCleaner)" 옵션 기본 활성화 및 툴바 토글 제공.
  3. **테스트**:
     - `tests/main/maskMorphology.test.ts`, `tests/renderer/InpaintingEditor.test.tsx`: 팽창 픽셀 제어 및 경계 안전 여유폭 검증 통과.

### Phase 3: 2차 잔여 텍스트 QA 검출 및 자동 재시도 루프 (BallonsTranslator-vibe 원칙)
- **목적**: 인페인팅 후 남아있는 원문 글자나 번짐 잔여물을 자동으로 찾아내어 실패를 사전에 감지하고 재처리한다.
- **수행 작업**:
  1. [`src/shared/inpaintingQa.ts`](../../../src/shared/inpaintingQa.ts):
     - `InpaintingQaResult` 판정 기준 정밀화 (`PASS`, `RETRY`, `MANUAL_REVIEW`).
     - `recommendedAction` (`auto_retry_dilate`, `fallback_local`, `manual_brush`) 및 `recommendedDilation` 필드 추가.
  2. [`src/renderer/components/InpaintingQaStatusBadge.tsx`](../../../src/renderer/components/InpaintingQaStatusBadge.tsx):
     - 잔여물 상태별 배지 표기 및 1-클릭 마스크 확장 재시도 트리거 연결.
  3. **테스트**:
     - `tests/shared/inpaintingQa.test.ts`: QA 판정 및 권고 액션 계산 검증 통과.

### Phase 4: 생성형 환각 대응 및 다단계 Fallback 아키텍처 (MangaTranslator 원칙)
- **목적**: 생성형 모델이 불필요한 선이나 사물을 만들어낼 경우 즉시 비생성형 복원 모델로 전환하거나 롤백할 수 있게 한다.
- **수행 작업**:
  1. [`src/main/inpainting/inpaintingRegistry.ts`](../../../src/main/inpainting/inpaintingRegistry.ts):
     - Cloud GenAI(Gemini/OpenAI) $\to$ Local LaMa $\to$ Manual Retouch 순의 `executeWithFallback()` 체인 구축.
  2. **테스트**:
     - `tests/main/inpaintingRegistry.test.ts`: 실패 및 이상 발생 시 대체 어댑터 전환 테스트 통과.

### Phase 5: 스크린톤·선화 품질 및 로컬 실행 비용 벤치마크 체계 (Ermanga & IOPaint)
- **목적**: 만화 특화 배경 복원 품질 및 시스템 리소스 대비 처리 효율을 정량 평가하는 기준선을 구축한다.
- **수행 작업**:
  1. [`tests/main/pipelineBenchmark.test.ts`](../../../tests/main/pipelineBenchmark.test.ts):
     - 6대 원칙 파이프라인 E2E 벤치마크 테스트 스위트 작성 및 통합 실행.
  2. **테스트**:
     - `tests/main/pipelineBenchmark.test.ts`: 스크린톤/선화 보수적 마스킹 및 Fallback 전환 벤치마크 통과.

### Phase 6: UI/UX 통합 및 최종 워크스페이스 검증
- **목적**: 작업대에서 직관적으로 마스크를 다루고 QA 결과를 확인하며 원본/결과를 비교할 수 있게 완성한다.
- **수행 작업**:
  1. [`src/renderer/components/InpaintingEditor.tsx`](../../../src/renderer/components/InpaintingEditor.tsx):
     - 브러시/지우개 도구, 보수적 경계 보존 토글, 엔진 선택기 제공.
  2. [`src/renderer/components/PageImagePanel.tsx`](../../../src/renderer/components/PageImagePanel.tsx):
     - 원본/인페인팅/식자 레이어 전환 및 분할(Split)/슬라이더(Reveal)/투명도(Opacity) 비교 모드 유지.
  3. **테스트**:
     - `tests/renderer/InpaintingEditor.test.tsx`, `tests/main/ipcHandlers.integration.test.ts` 전체 통과.

---

## 3. 검증 기준 (Definition of Done)

- [x] `npm.cmd run typecheck`: TypeScript 오류 없음 (Strict mode 준수)
- [x] `npm.cmd test`: 전체 단위/통합 테스트 100% 통과
- [x] `npm.cmd run build`: Electron 메인 및 렌더러 프로덕션 빌드 성공
- [x] 원본 이미지 불변성 보장: 인페인팅 실행 후 원본 파일의 SHA-256 해시 변경 없음
- [x] 마스크 자산 독립성: 마스크 파일이 `.ctp` 프로젝트 내 별도 파일로 안전하게 관리됨
- [x] QA 자동 판정: 잔여물 유무에 따른 `PASS` / `RETRY` / `MANUAL_REVIEW` 상태 분기 정상 동작
- [x] 회귀 방지: 기존 프로젝트 로드, 저장, 내보내기 호환성 100% 유지
