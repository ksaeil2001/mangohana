# 이번 조사에서 상세 확인한 파일

전체 파일별 정적 확인은 CSV에 기록했다. 아래 파일은 핵심 본문/관련 구간·호출·계약·테스트를 추가로 읽어 확인했다. 부분 읽기와 전체 읽기를 모든 분기 실행으로 해석하지 않는다.

## 부모 담당 Carrot 기능

- `package.json`
- `README.md`
- `THIRD_PARTY_NOTICES.md`
- `LICENSE`
- `SECURITY.md`
- `scripts/check.cjs`
- `.github/workflows/check.yml`
- `src/main/inpainting/inpaintingEngine.ts`
- `src/main/inpainting/inpaintingEnginePool.ts`
- `src/main/inpainting/patternEngineRunner.ts`
- `src/main/inpainting/patternPage.ts`
- `src/main/inpainting/patternPageMask.ts`
- `src/main/inpainting/patternTextMask.ts`
- `src/main/inpainting/patternFluxCompositePlan.ts`
- `src/main/inpainting/koharuAssets.ts`
- `src/shared/inpaintingSettingsTypes.ts`
- `src/main/pageWorkflow/pageWorkflowImages.ts`
- `src/main/pageWorkflow/pageWorkflowTypography.ts`
- `src/shared/pageWorkflowStages.ts`
- `src/shared/pageWorkflowPolicy.ts`
- `src/shared/naturalTextLayout.ts`
- `src/shared/naturalTextLayoutHorizontal.ts`
- `src/shared/generatedLettering.ts`
- `src/renderer/src/lib/bubbleFontSizeFitting.ts`
- `src/renderer/src/lib/sourceFontSizeMatching.ts`
- `src/shared/textWrapping.ts`
- `src/main/pipeline/automaticFontMatchingV2.ts`
- `src/main/pipeline/automaticFontMatchingV2PageCoordinator.ts`
- `src/main/libraryStore/translationCheckpointStore.ts`
- `src/main/libraryStore/libraryTransactionRecovery.ts`
- `src/main/libraryStore/importSources.ts`
- `src/main/libraryStore/shareExportWorkflow.ts`
- `src/shared/archive.ts`
- `src/main/application/pageImageExportService.ts`
- `src/main/pageExport.ts`
- `src/main/pageExportCapture.ts`
- `src/main/pageExportWorkload.ts`
- `src/main/jobs/pageImageExportPorts.ts`
- `src/main/jobs/pagePsdExport.ts`
- `src/main/jobs/pagePsdExportRunner.ts`
- `src/renderer/src/pageExport/fontValidation.ts`
- `src/main/settingsSecretStore.ts`
- `src/main/networkBudgets.ts`
- `src/main/runtimeSupport/modelDownloads.ts`
- `src/main/runtimeSupport/downloadBudgets.ts`
- `src/main/runtimeSupport/modelWorkload.ts`
- `src/main/mcpRuntime.ts`
- `src/main/mcpDesktopRuntime.ts`
- `src/main/mcp/mcpToolSet.ts`
- `src/main/mcp/mcpHttpServer.ts`
- `src/main/application/codexTypesettingService.ts`
- `src/main/application/chatService.ts`
- `tools/mgt-koharu-inpaint-runner/Cargo.toml`
- `tests/patternTextMask.test.ts`
- `tests/naturalTextLayout.test.ts`
- `src/main/pipeline/automaticFontMatchingV2RuntimeGate.ts`
- `src/main/pageWorkflow/pageWorkflowTypographyMerge.ts`
- `src/main/linkedWorkspace/linkedWorkspacePaths.ts`
- `src/shared/blockStylePresets.ts`
- `src/main/libraryStore/librarySoundEffectRestore.ts`
- `src/shared/textTypes.ts`
- `third_party/fonts/README.md`

## Trio 담당의 확인 범위

 필요한 구간 읽기와 심볼 검색을 포함하며, 전체 파일 목록·해시는 다시 만들지 않았습니다.

| 범위 | 확인 파일 |
|---|---|
| 웹 진입점·UI | `AGENTS.md`, `package.json`, `docs/source-reference.json`, `apps/api/src/{main.ts,runtime.ts,server.ts}`, `apps/worker/src/main.ts`, `apps/web/src/{App.tsx,PageCanvas.tsx,api.ts,translation-review-notes.ts}`, `scripts/{dev.ts,owned-03-cleanup-runtime.ts}`, `packages/operations/src/{runtime-startup.ts,runtime-config.ts}` |
| 웹 domain | `packages/domain/src/{image-pipeline.ts,operational-pipeline.ts,provider.ts,scope.ts,manual.ts,workspace.ts,requests.ts,batch.ts,execution.ts,execution-limits.ts,liveness.ts,auth.ts,files.ts,library.ts,export-build.ts,raster.ts,full-stage-cost.ts,full-stage-cost-preparation.ts,full-stage-cost-journal.ts}` |
| 웹 providers·media | `packages/providers/src/{text-stages.ts,gemini.ts,gemini-material.ts,local-ocr.ts,local-ocr-worker.py,local-ocr-proposal.ts,local-translation.ts,lama.ts,local-lama.ts,r2.ts}`; `packages/media/src/{images.ts,zip.ts,project-file.ts,mask.ts,profile.ts,render.ts,render-policy.ts,balloon-area.ts}` |
| 웹 테스트 | `tests/domain/{runtime-config.test.ts,runtime-native-di.test.ts,operational-pipeline.test.ts,local-ocr.test.ts,local-translation.test.ts,confirmed-values.test.ts,render.test.ts,balloon-policy-flow.test.ts}`; `tests/postgres/{operational-pipeline.test.ts,pipeline.test.ts,files.test.ts,execution.test.ts,auth.test.ts,library.test.ts,export-build.test.ts}`; `tests/browser/workspace.spec.ts` |
| Electron 소스 | `AGENTS.md`, `electron/{main.ts,preload.ts}`, `src/renderer/{App.tsx,useTranslationWorkflow.ts,useOcrWorkflow.ts,useInpaintingWorkflow.ts,typesettingReadiness.ts,typesettingKoreanBreak.ts}`, `src/renderer/components/ImageImportPanel.tsx`, `src/main/{ipcHandlers.ts,productionOcrService.ts,projectStorage.ts,incrementalProjectStorage.ts,projectRecovery.ts,projectImageExport.ts}`, `src/main/ocr/{pipeline/productionOcrPipeline.ts,grouping/productionRegionGrouping.ts}`, `src/main/translation/adapters/geminiAdapter.ts`, `src/main/inpainting/inpaintingRegistry.ts`, `src/main/batch/batchExecutionCoordinator.ts`, `src/shared/{productionOcr.ts,inpainting.ts}`, `src/shared/translation/{translationPayload.ts,contextSelector.ts,translationMemory.ts}` |
| Electron 테스트·기록 | `tests/main/{productionOcrPipeline.test.ts,geminiTranslationAdapter.test.ts,inpaintingRegistry.test.ts,batchExecutionCoordinator.test.ts,projectImageExport.test.ts,projectRecovery.test.ts}`; 기존 `2026-10-02-manga-web-workspace-contracts-and-validation-plan.md`의 관련 기록 구간; 위 p0 `result.json`과 p3 `execution-result.json` |



## Carrot 텍스트 담당의 대표 상세 근거

본문·관련 구간 확인과 심볼 추적을 구분한다. 아래는 비교표 근거에 연결된 대표 경로이며, 모든 파일의 전문·모든 분기를 검증했다는 의미는 아니다.

- `src/main/bootstrap.ts`
- `src/main/libraryStore/importSourceRunner.ts`
- `src/main/libraryStore/libraryFiles.ts`
- `src/main/textDetection/hayaiRegionPrepass.ts`
- `src/main/bubbleLayout/constants.ts`
- `src/main/textDetection/hayaiRegionGeometry.ts`
- `src/main/runtime/hayai-bboxes.py`
- `src/main/runtime/paddleocr-bboxes.py`
- `src/main/settings/appSettingsDefaults.ts`
- `src/main/runtime/semantic-ocr/fixed-block-translation.cjs`
- `src/main/runtime/simple-page-ocr-commands.cjs`
- `src/shared/blockReadingOrder.ts`
- `src/main/runtime/semantic-ocr/group-only-review.cjs`
- `src/main/pipeline/workContextPrompt.ts`
- `src/shared/workContextBudget.ts`
- `src/main/pipeline/cumulativePageContext.ts`
- `src/main/previousChapterContext.ts`
- `src/main/pipeline/runtimeModules.ts`
- `src/main/runtime/transport/translation-request.cjs`
- `src/main/pageWorkflow/pageWorkflowTranslation.ts`
- `src/main/workContextResearch.ts`
- `src/renderer/src/components/styleGuide/useStyleGuideInternetResearch.ts`
- `src/main/ipc/workContextIpc.ts`
- `src/main/wholePagePipeline.ts`
- `src/main/pipeline/wholePagePipelinePorts.ts`
- `src/main/pipeline/wholePageInputHandoff.ts`
- `src/main/pipeline/wholePageCheckpointFlow.ts`
- `src/main/pipeline/translatePageWithRetries.ts`
- `src/main/pageWorkflow/pageWorkflowOcr.ts`
- `src/main/application/pageWorkflowService.ts`
- `src/main/pipeline/pageResponseParser.ts`
- `tests/translationRuntimePort.test.ts`
- `tests/pageWorkflowAdapters.test.ts`
- `tests/fixedBlockFallbackReview.test.ts`
- `tests/previousChapterContext.test.ts`

범위 밖: 모델 가중치/custom model code 내부의 전체 수학적 동작, 외부 API 서버, 모든 화면·장치·언어·실행 분기의 실제 동작. 정적 색인만 한 파일은 CSV에서 별도 상태로 남겼다.
