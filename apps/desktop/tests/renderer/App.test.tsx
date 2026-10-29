import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import type { DialogueLine, PageImage, PreparedPageImage, TranslationProjectV2 } from "../../src/shared/projectTypes";
import type { ApplyProjectMutationArgs, ProjectChangeResult, ProjectSessionResult } from "../../src/shared/projectSessionTypes";
import type { BatchProgressEvent } from "../../src/shared/processingQueue";
import { createInitialEnvironmentSnapshot } from "../../src/shared/environmentPreparation";
import { DEFAULT_PROVIDER_SETTINGS } from "../../src/shared/providerSettings";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";
import { validateAndNormalizeProjectMutation } from "../../src/main/projectMutations";
import { applyMainProjectPatch, applyNormalizedProjectMutation } from "../../src/main/projectReplay";
import { buildProductionOcrReviewMergePatch } from "../../src/main/ocr/pipeline/productionOcrReviewMerge";
import { PRODUCTION_OCR_CONTRACT } from "../../src/shared/productionOcr";
import { calculateTypesettingSafeArea } from "../../src/shared/geometry/panelAndBubbleLayout";
import { buildTranslationContextPayload, computeTranslationPayloadFingerprint } from "../../src/shared/translationContext";
vi.mock("../../src/renderer/imageBurnInRenderer", () => ({
  burnTypesettingFromUrl: vi.fn()
}));
import App from "../../src/renderer/App";
import { burnTypesettingFromUrl } from "../../src/renderer/imageBurnInRenderer";
import { resetProductionTypesetFontLoaderForTests } from "../../src/renderer/productionTypesetFont";
import { saveTypesettingDraft } from "../../src/renderer/typesettingDrafts";
import { createTranslationSourceIdentity, saveTranslationDraft } from "../../src/renderer/translationDrafts";
import { createWorkspaceSessionSnapshot, WORKSPACE_SESSION_STORAGE_KEY } from "../../src/renderer/workspaceSession";
import { createImageViewportState } from "../../src/renderer/imageViewport";
import { DEFAULT_WORKSPACE_PANELS } from "../../src/renderer/focusDeck";
import { findWorkStatus, openTxtStartActions, openWorkspacePanel, selectWorkspaceEditingTool } from "./workspaceTestActions";

const focusDeckStyles = readFileSync("src/renderer/styles.css", "utf8");
const appSource = readFileSync("src/renderer/App.tsx", "utf8");

describe("App", () => {
  let restoreInpaintingMocks: (() => void) | null = null;
  let restoreDocumentFontsMock: (() => void) | null = null;
  let restoreFontFaceMock: (() => void) | null = null;
  let previousInnerWidth = window.innerWidth;

  beforeEach(() => {
    previousInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    vi.mocked(burnTypesettingFromUrl).mockReset();
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: previousInnerWidth });
    cleanup();
    restoreInpaintingMocks?.();
    restoreInpaintingMocks = null;
    restoreDocumentFontsMock?.();
    restoreDocumentFontsMock = null;
    restoreFontFaceMock?.();
    restoreFontFaceMock = null;
    resetProductionTypesetFontLoaderForTests();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "projectApi");
    window.localStorage.clear();
    Reflect.deleteProperty(document.documentElement.dataset, "theme");
  });

  async function answerAppPrompt(value: string) {
    const dialog = await screen.findByRole("dialog");
    if (value) {
      fireEvent.change(within(dialog).getByLabelText(/프로젝트 암호|이미지 파일 경로/), { target: { value } });
      fireEvent.submit(within(dialog).getByRole("button", { name: /프로젝트 열기|보호 모드 적용|이미지 선택/ }).closest("form")!);
    } else {
      fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    }
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  }

  async function answerAppConfirmation(label: string) {
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: label }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  }

  function pageImage(overrides: Partial<PageImage> = {}): PageImage {
    return {
      id: "page-image-1",
      pageNumber: 1,
      storedRelativePath: "Book-assets/images/page-001.jpg",
      originalFileName: "scan_001.jpg",
      sha256: "a".repeat(64),
      byteSize: 4,
      mimeType: "image/jpeg",
      copiedAt: "2026-05-29T00:00:00.000Z",
      ...overrides
    };
  }

  function preparedPageImage(overrides: Partial<PreparedPageImage> = {}): PreparedPageImage {
    return {
      id: "prepared-page-1",
      sourcePath: "C:\\images\\page-001.jpg",
      fileName: "page-001.jpg",
      previewSrc: "translation-preview://prepared-page-1",
      byteSize: 4,
      ...overrides
    };
  }

  function openedProjectWithImages(
    images: PageImage[],
    dialogueLines: DialogueLine[] = [rendererLine("opened-project-line", 1, "Opened project line")]
  ) {
    return {
      filePath: "C:\\projects\\Book.ctp",
      encrypted: false,
      project: {
        schemaVersion: 1,
        metadata: {
          id: "project-images",
          title: "Image Project",
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:00.000Z",
          secret: false
        },
        characters: [],
        dictionaryTerms: [],
        dialogueLines,
        pageImages: images,
        settings: { defaultSourceLanguage: "unknown" }
      }
    };
  }

  function openedProjectWithInpaintedResult(
    images: PageImage[],
    dialogueLines: DialogueLine[] = [rendererLine("opened-project-line", 1, "Opened project line")]
  ) {
    const base = openedProjectWithImages(images, dialogueLines);
    const sourceImage = images[0];
    if (!sourceImage) return base;
    const resultImage = pageImage({
      id: `${sourceImage.id}-inpainted`,
      pageNumber: sourceImage.pageNumber,
      storedRelativePath: `Book-assets/images/page-${String(sourceImage.pageNumber).padStart(3, "0")}-inpainted.png`,
      originalFileName: `scan_${String(sourceImage.pageNumber).padStart(3, "0")}_inpainted.png`,
      sha256: "c".repeat(64),
      mimeType: "image/png"
    });
    const runId = `${sourceImage.id}-run`;
    const assetId = `${sourceImage.id}-asset`;
    return {
      ...base,
      project: {
        ...base.project,
        schemaVersion: 2,
        dialogueLines: dialogueLines.map((line) => ({ ...line, origin: { kind: "manual" as const } })),
        processing: {
          pages: [{
            pageImageId: sourceImage.id,
            latestCompletedRunId: runId,
            approvedCleanedAssetId: assetId,
            finalStatus: "auto_approved" as const,
            updatedAt: "2026-05-30T00:00:00.000Z"
          }],
          runs: [{
            runId,
            pageImageId: sourceImage.id,
            source: "manual_openai" as const,
            status: "completed" as const,
            sourceSha256: sourceImage.sha256,
            appVersion: "0.1.0",
            queuedAt: "2026-05-30T00:00:00.000Z",
            completedAt: "2026-05-30T00:00:00.000Z"
          }],
          assets: [{
            assetId,
            source: "manual_openai" as const,
            sourcePageImageId: sourceImage.id,
            runId,
            role: "cleaned" as const,
            storedRelativePath: resultImage.storedRelativePath,
            sha256: resultImage.sha256,
            byteSize: resultImage.byteSize,
            mimeType: "image/png" as const,
            createdAt: "2026-05-30T00:00:00.000Z"
          }]
        }
      }
    };
  }

  function namedOpenedProject(filePath: string, title: string, sourceText: string) {
    const result = openedProjectWithImages([], [rendererLine(`${title}-line`, 1, sourceText)]);
    return {
      ...result,
      filePath,
      project: {
        ...result.project,
        metadata: { ...result.project.metadata, id: `${title}-project`, title }
      }
    };
  }

  function rendererLine(id: string, order: number, sourceText: string, pageNumber = 1): DialogueLine {
    return {
      id,
      order,
      pageNumber,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText,
      lineStatus: "untranslated",
      parseConfidence: 0.95,
      parseWarnings: []
    };
  }

  function openFullDialogueTable() {
    const openResults = screen.queryByRole("button", { name: "결과 및 진행 열기" });
    if (openResults) fireEvent.click(openResults);
    fireEvent.click(screen.getByRole("button", { name: "전체 대사 보기" }));
  }

  function renderApp() {
    installProductionOcrResultTestAdapter();
    installProductionOcrSessionTestBoundary();
    if (window.projectApi && !window.projectApi.getProviderSettings) {
      window.projectApi.getProviderSettings = vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS);
    }
    return render(<App />);
  }

  function installProductionOcrResultTestAdapter() {
    const api = window.projectApi;
    const extraction = api?.extractSpeechBubbles;
    if (!api || !extraction || "productionOcrTestAdapter" in extraction) return;
    const adapter = vi.fn(async (request: Parameters<typeof extraction>[0]) => {
      const result = await extraction(request);
      return {
        ...result,
        speechBubbles: result.speechBubbles.map((bubble, index) => ({
          ...bubble,
          ...(bubble.productionOcrProvenance
            ? {}
            : productionOcrCandidateMetadata(
                `${bubble.id || "speech"}-${index}`,
                bubble.bbox.height > bubble.bbox.width ? "vertical" : "horizontal",
                bubble.bbox
              ))
        })),
        nonSpeechText: result.nonSpeechText.map((item, index) => ({
          ...item,
          ...(item.productionOcrProvenance
            ? {}
            : productionOcrCandidateMetadata(
                `non-speech-${index}`,
                item.bbox.height > item.bbox.width ? "vertical" : "horizontal",
                item.bbox
              ))
        })),
        productionOcrContext: {
          runId: request.requestId,
          pageImageId: request.pageImageId,
          sourceSha256: request.sourceSha256
        }
      };
    });
    Object.defineProperty(adapter, "productionOcrTestAdapter", { value: true });
    api.extractSpeechBubbles = adapter;
  }

  function installProductionOcrSessionTestBoundary() {
    const api = window.projectApi;
    if (!api?.extractSpeechBubbles || !api.openProject || api.openProjectFromDialog) return;
    const legacyOpenProject = api.openProject;
    const legacySaveProject = api.saveProject;
    let activeProject = normalizeProject(createEmptyProject("OCR test project", false));
    let activeFilePath: string | undefined;
    let revision = 0;
    const toSessionResult = async (
      legacyResult: Awaited<ReturnType<typeof legacyOpenProject>>
    ): Promise<ProjectSessionResult | null> => {
      if (!legacyResult || !("project" in legacyResult)) return null;
      activeProject = normalizeProject(legacyResult.project);
      activeFilePath = legacyResult.filePath;
      revision = 0;
      return {
        projectSessionId: "ocr-test-session",
        encrypted: legacyResult.encrypted,
        project: {
          revision,
          project: activeProject,
          pendingPageImages: [],
          dirty: false,
          status: "active" as const
        }
      };
    };
    api.openProjectFromDialog = vi.fn(async () => toSessionResult(await legacyOpenProject()));
    api.openRecentProject = vi.fn(async () => toSessionResult(await legacyOpenProject()));
    api.unlockProject = vi.fn(async () => {
      const result = await toSessionResult(await legacyOpenProject());
      if (!result) throw new Error("OCR test project could not be unlocked");
      return result;
    });
    api.closeProject = api.closeProject ?? vi.fn().mockResolvedValue(undefined);
    api.applyProjectMutation = api.applyProjectMutation ?? vi.fn().mockImplementation(async ({ mutation }) => {
      const { mutation: normalizedMutation } = validateAndNormalizeProjectMutation(activeProject, mutation);
      activeProject = applyNormalizedProjectMutation(activeProject, normalizedMutation);
      revision += 1;
      return {
        status: "applied" as const,
        revision,
        project: {
          revision,
          project: activeProject,
          pendingPageImages: [],
          dirty: true,
          status: "active" as const
        }
      };
    });
    api.applyProductionOcrReview = api.applyProductionOcrReview ?? vi.fn().mockImplementation(async (request) => {
      const sourceImage = activeProject.pageImages.find((image) => image.id === request.pageImageId);
      if (!sourceImage) throw new Error("OCR test page image is missing");
      activeProject = applyProductionOcrReviewForTest(activeProject, request);
      revision += 1;
      return {
        projectSessionId: "ocr-test-session",
        project: {
          revision,
          project: activeProject,
          pendingPageImages: [],
          dirty: true,
          status: "active" as const
        }
      };
    });
    api.saveProject = vi.fn(async () => {
      if (legacySaveProject && activeFilePath) {
        await legacySaveProject({ filePath: activeFilePath, project: activeProject });
      }
      return {
        projectSessionId: "ocr-test-session",
        project: {
          revision,
          project: activeProject,
          pendingPageImages: [],
          dirty: false,
          status: "active" as const
        }
      };
    });
  }

  function applyProductionOcrReviewForTest(
    project: TranslationProjectV2,
    request: Parameters<NonNullable<NonNullable<typeof window.projectApi>["applyProductionOcrReview"]>>[0]
  ): TranslationProjectV2 {
    const sourceImage = project.pageImages.find((image) => image.id === request.pageImageId);
    if (!sourceImage) throw new Error("OCR test page image is missing");
    const patch = buildProductionOcrReviewMergePatch({
      existingLines: project.dialogueLines,
      candidates: request.candidates.map((candidate) => ({
        id: candidate.id,
        text: candidate.text,
        sourceLanguage: candidate.language === "ja" || candidate.language === "en"
          ? candidate.language
          : "unknown",
        dialogueType: candidate.textType === "thought_bubble"
          ? "thought"
          : candidate.textType === "narration_box" || candidate.textType === "caption_time_place"
            ? "narration"
            : candidate.textType === "speech_bubble" || candidate.textType === "filtered_speech"
              ? "speech"
              : "unknown",
        bbox: candidate.bbox,
        polygon: candidate.polygon,
        readingOrder: candidate.readingOrder,
        confidence: candidate.confidence,
        orientation: candidate.orientation,
        selectedSpeaker: candidate.selectedSpeaker,
        notes: candidate.notes,
        provenance: candidate.productionOcrProvenance,
        typesetting: candidate.typesetting
      })),
      pageNumber: sourceImage.pageNumber,
      pageImageId: sourceImage.id,
      runId: request.runId
    });
    return applyMainProjectPatch(project, patch);
  }

  function installSessionSetupApi(options: {
    choosePageImages?: unknown;
    saveProjectAs?: unknown;
    importPageImages?: unknown;
    saveProject?: unknown;
  } = {}) {
    type ProjectApi = NonNullable<typeof window.projectApi>;
    const initialProject = normalizeProject(createEmptyProject("새 프로젝트", false));
    const savedProject = structuredClone(initialProject);
    savedProject.pageImages = [pageImage()];
    const dto = (project: typeof initialProject, dirty: boolean, revision = 0) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const choosePageImages = (options.choosePageImages ?? vi.fn().mockResolvedValue({
      importBatchId: "batch-1",
      images: [{
        preparedImageId: "prepared-1",
        importBatchId: "batch-1",
        originalFileName: "page-001.jpg",
        byteSize: 4,
        mimeType: "image/jpeg",
        previewToken: "preview-1"
      }]
    })) as ReturnType<typeof vi.fn> & NonNullable<ProjectApi["choosePageImages"]>;
    const saveProjectAs = (options.saveProjectAs ?? vi.fn().mockResolvedValue({
      projectSessionId: "session-1",
      project: dto(initialProject, false)
    })) as ReturnType<typeof vi.fn> & NonNullable<ProjectApi["saveProjectAs"]>;
    const importPageImages = (options.importPageImages ?? vi.fn().mockResolvedValue([{
      ok: true,
      pendingPageImage: {
        importBatchId: "batch-1",
        preparedImageId: "prepared-1",
        pageImageId: "pending-page-1",
        pageNumber: 1,
        originalFileName: "page-001.jpg",
        byteSize: 4,
        mimeType: "image/jpeg",
        previewToken: "preview-1"
      }
    }])) as ReturnType<typeof vi.fn> & NonNullable<ProjectApi["importPageImages"]>;
    const saveProject = (options.saveProject ?? vi.fn().mockResolvedValue({
      projectSessionId: "session-1",
      project: dto(savedProject, false, 1)
    })) as ReturnType<typeof vi.fn> & ProjectApi["saveProject"];
    const releasePageImageImportBatch = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "session-1",
        project: dto(initialProject, false),
        encrypted: false
      }),
      applyProjectMutation: vi.fn().mockResolvedValue({
        status: "applied",
        revision: 0,
        project: dto(initialProject, false)
      }),
      saveProjectAs,
      saveProject,
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      openProjectFromDialog: vi.fn(),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      rekeyProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      choosePageImages,
      releasePageImageImportBatch,
      importPageImages,
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
    };
    return {
      choosePageImages,
      dto,
      importPageImages,
      initialProject,
      releasePageImageImportBatch,
      savedProject,
      saveProject,
      saveProjectAs
    };
  }

  async function clickTxtStart() {
    openTxtStartActions();
    const button = screen.getByRole("button", { name: "TXT로 시작" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
  }

  function openPagesPanel() {
    const pages = within(screen.getByRole("navigation", { name: "작업 영역" })).getByRole("button", { name: "페이지" });
    if (pages.getAttribute("aria-expanded") !== "true") fireEvent.click(pages);
    expect(screen.getByRole("complementary", { name: "페이지 목록" })).toBeInTheDocument();
  }

  function openSettings() {
    const settings = within(screen.getByRole("navigation", { name: "작업 영역" })).getByRole("button", { name: "설정" });
    if (settings.getAttribute("aria-expanded") !== "true") fireEvent.click(settings);
    expect(screen.getByRole("region", { name: "프로젝트 설정" })).toBeInTheDocument();
  }

  async function renderWorkspaceApp() {
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "workspace.txt",
        lines: [rendererLine("workspace-line", 1, "Workspace line")]
      }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };
    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("페이지");
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
  }

  async function importWorkspaceLine() {
    window.projectApi = {
      ...window.projectApi!,
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "workspace.txt",
        lines: [rendererLine("workspace-line", 1, "Workspace line")]
      })
    };
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
  }

  function emptyOcrExtraction(pageNumber = 1) {
    return {
      pageNumber,
      speechBubbles: [],
      nonSpeechText: [],
      warnings: [],
      productionOcrContext: {
        runId: "ocr-test-run",
        pageImageId: `page-image-${pageNumber}`,
        sourceSha256: "a".repeat(64)
      }
    };
  }

  function validatedReviewExtraction(pageNumber = 1) {
    return {
      pageNumber,
      speechBubbles: [
        {
          id: "review-bubble-1",
          type: "speech_bubble" as const,
          text: "첫 번째 OCR",
          language: "ja" as const,
          bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
          readingOrder: 1,
          confidence: 0.92,
          notes: "",
          speakerCandidates: [{ speaker: "Mika", confidence: 0.82, reason: "first bubble" }],
          ...productionOcrCandidateMetadata("review-bubble-1", "horizontal", {
            x: 0.1, y: 0.1, width: 0.2, height: 0.1
          })
        },
        {
          id: "review-bubble-2",
          type: "thought_bubble" as const,
          text: "두 번째 OCR",
          language: "ja" as const,
          bbox: { x: 0.4, y: 0.3, width: 0.25, height: 0.12 },
          readingOrder: 2,
          confidence: 0.88,
          notes: "",
          speakerCandidates: [{ speaker: "Ren", confidence: 0.79, reason: "second bubble" }],
          ...productionOcrCandidateMetadata("review-bubble-2", "horizontal", {
            x: 0.4, y: 0.3, width: 0.25, height: 0.12
          })
        }
      ],
      nonSpeechText: [],
      warnings: [],
      productionOcrContext: {
        runId: "ocr-test-run",
        pageImageId: `page-image-${pageNumber}`,
        sourceSha256: "a".repeat(64)
      }
    };
  }

  function productionOcrCandidateMetadata(
    groupId: string,
    orientation: "horizontal" | "vertical",
    bbox: { x: number; y: number; width: number; height: number }
  ) {
    const sourceBboxPx = {
      x: bbox.x * 1000,
      y: bbox.y * 1000,
      width: bbox.width * 1000,
      height: bbox.height * 1000
    };
    const sourceQuadPx = [
      { x: sourceBboxPx.x, y: sourceBboxPx.y },
      { x: sourceBboxPx.x + sourceBboxPx.width, y: sourceBboxPx.y },
      { x: sourceBboxPx.x + sourceBboxPx.width, y: sourceBboxPx.y + sourceBboxPx.height },
      { x: sourceBboxPx.x, y: sourceBboxPx.y + sourceBboxPx.height }
    ] as const;
    return {
      orientation,
      polygon: sourceQuadPx.map((point) => ({ x: point.x / 1000, y: point.y / 1000 })),
      productionOcrProvenance: {
        contractVersion: 1 as const,
        detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId,
        detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision,
        recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId,
        recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision,
        groupId,
        sourceDetectionIds: [`detection-${groupId}`],
        sourceDetectionScores: [0.93],
        sourceQuadsPx: [sourceQuadPx],
        orientation,
        cropTransform: {
          sourceBboxPx,
          cropBboxPx: sourceBboxPx,
          paddingRatio: 0.08 as const,
          rotationDegrees: 0 as const,
          imageWidth: 1000,
          imageHeight: 1000
        },
        confidenceSource: "detector_min" as const
      }
    };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    return { promise, resolve, reject };
  }

  type UiBatchResult = Awaited<ReturnType<NonNullable<Window["projectApi"]["runBatchJob"]>>>;

  async function renderBatchControlApp(initialQueue: "none" | "completed" | "running" = "none") {
    const initial = normalizeProject(createEmptyProject("Initial", false));
    const opened = normalizeProject(createEmptyProject("Batch controls", false));
    opened.pageImages = [pageImage()];
    opened.dialogueLines = [{ ...rendererLine("batch-control-line", 1, "원래 원문"), origin: { kind: "manual" } }];
    const makeQueue = (queueId: string, status: "running" | "paused" | "completed" | "cancelled") => ({
      schemaVersion: 1 as const, queueId, projectSessionId: "batch-session", status,
      pageImageIds: [opened.pageImages[0]!.id], currentPageIndex: 0,
      pages: [{ pageImageId: opened.pageImages[0]!.id, status, stage: "translation" as const, revision: 1, updatedAt: "2026-10-18T00:00:00.000Z" }],
      lastUpdatedAt: "2026-10-18T00:00:00.000Z"
    });
    if (initialQueue !== "none") opened.processing.queue = makeQueue("old-queue", initialQueue);
    const dto = (project: TranslationProjectV2, revision: number, status: "active" | "needs_recovery" = "active") => ({ project, revision, pendingPageImages: [], dirty: false, status });
    const result = (project: TranslationProjectV2, revision: number): UiBatchResult => ({
      updatedProject: project,
      sessionChange: { status: "applied", revision, project: dto(project, revision) },
      progress: { stage: project.processing.queue?.status === "paused" ? "partial" : "completed", currentPageIndex: 0, totalPages: 1, percent: 100, currentMessage: "검증용 Batch 종료", pageStatuses: {}, errors: [], isCanceled: false }
    });
    const run = deferred<UiBatchResult>();
    const runBatchJob = vi.fn().mockReturnValue(run.promise);
    const updateProcessingQueue = vi.fn();
    const applyProjectMutation = vi.fn();
    let listener: ((event: BatchProgressEvent) => void) | undefined;
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(initial, 0), encrypted: false }),
      openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "batch-session", project: dto(opened, 1), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(),
      applyProjectMutation, runBatchJob, updateProcessingQueue,
      onBatchProgress: vi.fn((callback) => { listener = callback; return vi.fn(); }),
      cancelBatchJob: vi.fn().mockResolvedValue({ canceled: true }),
      closeProject: vi.fn().mockResolvedValue(undefined), listRecentProjects: vi.fn().mockResolvedValue([]),
      importTxtFile: vi.fn(), exportTranslations: vi.fn(), saveProject: vi.fn(), resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://asset/page")
    };
    const rendered = renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
    const start = async () => {
      fireEvent.click(screen.getByRole("button", { name: "일괄 자동화" }));
      fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
      await waitFor(() => expect(runBatchJob).toHaveBeenCalledOnce());
    };
    const metadata = (queueId = "actual-queue") => {
      listener?.({ requestId: runBatchJob.mock.calls[0]![0].requestId, projectSessionId: "batch-session", queueId,
        progress: { ...result(opened, 1).progress, stage: "translate", percent: 0, currentMessage: "실제 큐 준비" } });
    };
    return { ...rendered, opened, dto, result, makeQueue, run, runBatchJob, updateProcessingQueue, applyProjectMutation, start, metadata };
  }

  function mockCanvasForInpainting(withMaskAlpha = false, onPutImageData?: (imageData: ImageData) => void) {
    const imageNaturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth");
    const imageNaturalHeight = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalHeight");
    const canvasGetBoundingClientRect = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getBoundingClientRect"
    );
    const canvasSetPointerCapture = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "setPointerCapture");
    const canvasHasPointerCapture = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "hasPointerCapture");
    const canvasReleasePointerCapture = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "releasePointerCapture"
    );
    const canvasToDataURL = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "toDataURL");
    const canvasGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");

    function restoreDescriptor<T extends object>(target: T, key: keyof T, descriptor: PropertyDescriptor | undefined) {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else {
        delete target[key];
      }
    }

    restoreInpaintingMocks = () => {
      restoreDescriptor(HTMLImageElement.prototype, "naturalWidth", imageNaturalWidth);
      restoreDescriptor(HTMLImageElement.prototype, "naturalHeight", imageNaturalHeight);
      restoreDescriptor(HTMLCanvasElement.prototype, "getBoundingClientRect", canvasGetBoundingClientRect);
      restoreDescriptor(HTMLCanvasElement.prototype, "setPointerCapture", canvasSetPointerCapture);
      restoreDescriptor(HTMLCanvasElement.prototype, "hasPointerCapture", canvasHasPointerCapture);
      restoreDescriptor(HTMLCanvasElement.prototype, "releasePointerCapture", canvasReleasePointerCapture);
      restoreDescriptor(HTMLCanvasElement.prototype, "toDataURL", canvasToDataURL);
      restoreDescriptor(HTMLCanvasElement.prototype, "getContext", canvasGetContext);
    };

    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 80 });
    HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      top: 0,
      right: 100,
      bottom: 80,
      left: 0,
      toJSON: () => ({})
    }));
    HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
    HTMLCanvasElement.prototype.hasPointerCapture = vi.fn(() => true);
    HTMLCanvasElement.prototype.releasePointerCapture = vi.fn();
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,mask-png");
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4);
        if (withMaskAlpha && data.length >= 4) data[3] = 255;
        return { data };
      }),
      putImageData: vi.fn((imageData: ImageData) => onPutImageData?.(imageData))
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  }

  it("renders the editor shell", async () => {
    await renderWorkspaceApp();
    openFullDialogueTable();

    expect(screen.getByText("대사 편집기")).toBeInTheDocument();
    expect(screen.getAllByText("원문").length).toBeGreaterThan(0);
    expect(screen.getAllByText("AI 번역").length).toBeGreaterThan(0);
    expect(screen.getAllByText("사용자 수정문").length).toBeGreaterThan(0);
  });

  it.each(["none", "completed"] as const)("adopts the actual final queue from an initial %s queue before any metadata arrives", async (initialQueue) => {
    const h = await renderBatchControlApp(initialQueue);
    const completed = structuredClone(h.opened);
    completed.processing.queue = h.makeQueue("actual-queue", "completed");
    completed.dialogueLines[0]!.sourceText = "새 실행의 원문";
    try {
      await h.start();
      expect(within(screen.getByRole("dialog")).getByRole("button", { name: "일시정지" })).toBeDisabled();
      await act(async () => { h.run.resolve(h.result(completed, 3)); await h.run.promise; });
      await screen.findByRole("button", { name: "완료 및 닫기" });
      expect(screen.getByLabelText("원문 1")).toHaveValue("새 실행의 원문");
      expect(screen.getByText("검증용 Batch 종료")).toBeInTheDocument();
    } finally { await act(async () => { h.run.resolve(h.result(completed, 3)); }); }
  });

  it("preserves an already adopted pause when the final run returns the identical revision", async () => {
    const h = await renderBatchControlApp();
    const paused = structuredClone(h.opened);
    paused.processing.queue = h.makeQueue("actual-queue", "paused");
    paused.dialogueLines[0]!.sourceText = "일시정지 때 저장한 원문";
    const dto = h.dto(paused, 3);
    h.updateProcessingQueue.mockResolvedValue({ project: dto, queue: paused.processing.queue, control: { status: "settled" } });
    try {
      await h.start();
      act(() => { h.metadata(); });
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "일시정지" }));
      await waitFor(() => expect(screen.getByLabelText("원문 1")).toHaveValue("일시정지 때 저장한 원문"));
      const staleFinal = structuredClone(paused);
      staleFinal.dialogueLines[0]!.sourceText = "같은 revision의 버릴 원문";
      await act(async () => { h.run.resolve(h.result(staleFinal, 3)); await h.run.promise; });
      await screen.findByRole("button", { name: "작업 큐에서 현재 페이지·단계 재개" });
      expect(screen.getByText("일시정지됨")).toBeInTheDocument();
      expect(screen.queryByText("최신 변경을 유지했습니다.")).not.toBeInTheDocument();
      expect(screen.getByLabelText("원문 1")).toHaveValue("일시정지 때 저장한 원문");
      fireEvent.click(screen.getByRole("button", { name: "작업 큐에서 현재 페이지·단계 재개" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const panel = within(screen.getByRole("region", { name: "페이지 작업 큐" }));
      expect(panel.getByText(/일시정지 · 1페이지/)).toBeInTheDocument();
      expect(panel.getByRole("button", { name: "Provider 재개" })).toBeEnabled();
    } finally { await act(async () => { h.run.resolve(h.result(paused, 3)); }); }
  });

  it.each(["actual-queue", "foreign-queue"])("keeps a newer %s adopted by a concurrent mutation when the older run returns", async (queueId) => {
    const h = await renderBatchControlApp("completed");
    const latest = structuredClone(h.opened);
    latest.processing.queue = h.makeQueue(queueId, "paused");
    latest.dialogueLines[0]!.sourceText = "최신 편집";
    const mutation = deferred<{ status: "applied"; revision: number; project: ReturnType<typeof h.dto> }>();
    h.applyProjectMutation.mockReturnValue(mutation.promise);
    const old = structuredClone(h.opened);
    old.processing.queue = h.makeQueue("actual-queue", "completed");
    old.dialogueLines[0]!.sourceText = "버릴 Batch 원문";
    try {
      await h.start();
      fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "최신 편집" } });
      await waitFor(() => expect(h.applyProjectMutation).toHaveBeenCalledOnce());
      await act(async () => { mutation.resolve({ status: "applied", revision: 8, project: h.dto(latest, 8) }); await mutation.promise; });
      await act(async () => { h.run.resolve(h.result(old, 7)); await h.run.promise; });
      await screen.findByText(queueId === "actual-queue" ? "일시정지됨" : "최신 변경을 유지했습니다.");
      expect(screen.getByLabelText("원문 1")).toHaveValue("최신 편집");
      expect(screen.queryByText("검증용 Batch 종료")).not.toBeInTheDocument();
      const following = structuredClone(latest);
      following.dialogueLines[0]!.sourceText = "후속 편집";
      h.applyProjectMutation.mockResolvedValue({ status: "applied", revision: 9, project: h.dto(following, 9) });
      fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "후속 편집" } });
      await waitFor(() => expect(h.applyProjectMutation).toHaveBeenLastCalledWith(expect.objectContaining({ baseRevision: 8 })));
    } finally { await act(async () => { mutation.resolve({ status: "applied", revision: 8, project: h.dto(latest, 8) }); h.run.resolve(h.result(old, 7)); }); }
  });

  it("rejects a session run's raw project when no sessionChange was returned", async () => {
    const h = await renderBatchControlApp();
    const raw = structuredClone(h.opened);
    raw.dialogueLines[0]!.sourceText = "세션을 우회하는 원문";
    try {
      await h.start();
      const response = { ...h.result(raw, 20), sessionChange: undefined };
      await act(async () => { h.run.resolve(response); await h.run.promise; });
      await screen.findByText("최신 변경을 유지했습니다.");
      expect(screen.getByLabelText("원문 1")).toHaveValue("원래 원문");
      expect(screen.queryByRole("button", { name: "완료 및 닫기" })).not.toBeInTheDocument();
    } finally { await act(async () => { h.run.resolve(h.result(h.opened, 1)); }); }
  });

  it("drops a run DTO if a new edit enters while App drains the previously pending mutation", async () => {
    const h = await renderBatchControlApp();
    const first = deferred<{ status: "applied"; revision: number; project: ReturnType<typeof h.dto> }>();
    const second = deferred<{ status: "applied"; revision: number; project: ReturnType<typeof h.dto> }>();
    h.applyProjectMutation.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const firstProject = structuredClone(h.opened);
    firstProject.dialogueLines[0]!.sourceText = "첫 편집";
    const secondProject = structuredClone(firstProject);
    secondProject.dialogueLines[0]!.sourceText = "대기 중 새 편집";
    const batch = structuredClone(h.opened);
    batch.processing.queue = h.makeQueue("actual-queue", "completed");
    batch.dialogueLines[0]!.sourceText = "버릴 고revision 원문";
    try {
      await h.start();
      act(() => { h.metadata(); });
      fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "첫 편집" } });
      await waitFor(() => expect(h.applyProjectMutation).toHaveBeenCalledOnce());
      await act(async () => { h.run.resolve(h.result(batch, 100)); await h.run.promise; });
      expect(screen.queryByRole("button", { name: "완료 및 닫기" })).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "대기 중 새 편집" } });
      await act(async () => { first.resolve({ status: "applied", revision: 2, project: h.dto(firstProject, 2) }); await first.promise; });
      await waitFor(() => expect(h.applyProjectMutation).toHaveBeenCalledTimes(2));
      await act(async () => { second.resolve({ status: "applied", revision: 3, project: h.dto(secondProject, 3) }); await second.promise; });
      await screen.findByText("최신 변경을 유지했습니다.");
      expect(screen.getByLabelText("원문 1")).toHaveValue("대기 중 새 편집");
      expect(screen.queryByText("검증용 Batch 종료")).not.toBeInTheDocument();
    } finally {
      await act(async () => { first.resolve({ status: "applied", revision: 2, project: h.dto(firstProject, 2) }); second.resolve({ status: "applied", revision: 3, project: h.dto(secondProject, 3) }); h.run.resolve(h.result(batch, 100)); });
    }
  });

  it.each(["cancel", "unmount"] as const)("rechecks a queue adoption after mutation drain and %s", async (change) => {
    const h = await renderBatchControlApp("running");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const mutation = deferred<{ status: "applied"; revision: number; project: ReturnType<typeof h.dto> }>();
    h.applyProjectMutation.mockReturnValue(mutation.promise);
    const edited = structuredClone(h.opened);
    edited.dialogueLines[0]!.sourceText = "보존할 편집";
    const paused = structuredClone(edited);
    paused.processing.queue!.status = "paused";
    const cancelled = structuredClone(edited);
    cancelled.processing.queue!.status = "cancelled";
    h.updateProcessingQueue.mockResolvedValueOnce({ project: h.dto(paused, 4), queue: paused.processing.queue, control: { status: "settled" } })
      .mockResolvedValueOnce({ project: h.dto(cancelled, 5), queue: cancelled.processing.queue, control: { status: "settled" } });
    try {
      fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "보존할 편집" } });
      await waitFor(() => expect(h.applyProjectMutation).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
      await waitFor(() => expect(h.updateProcessingQueue).toHaveBeenCalledOnce());
      if (change === "cancel") {
        fireEvent.click(screen.getByRole("button", { name: "큐 취소" }));
        await waitFor(() => expect(h.updateProcessingQueue).toHaveBeenCalledTimes(2));
        expect(screen.getByRole("button", { name: "큐 취소" })).toBeDisabled();
      } else fireEvent.click(screen.getByRole("button", { name: "전체 대사 보기" }));
      await act(async () => { mutation.resolve({ status: "applied", revision: 2, project: h.dto(edited, 2) }); await mutation.promise; });
      expect(screen.getByLabelText("원문 1")).toHaveValue("보존할 편집");
      if (change === "cancel") {
        await screen.findByText(/취소됨 · 1페이지/);
        expect(screen.queryByText(/일시정지 · 1페이지/)).not.toBeInTheDocument();
      } else {
        fireEvent.click(screen.getByRole("button", { name: "작업 큐 보기" }));
        expect(screen.getByText(/실행 중 · 1페이지/)).toBeInTheDocument();
      }
      const revision = change === "cancel" ? 5 : 2;
      const following = structuredClone(change === "cancel" ? cancelled : edited);
      following.dialogueLines[0]!.sourceText = "후속 편집";
      h.applyProjectMutation.mockResolvedValue({ status: "applied", revision: revision + 1, project: h.dto(following, revision + 1) });
      fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "후속 편집" } });
      await waitFor(() => expect(h.applyProjectMutation).toHaveBeenLastCalledWith(expect.objectContaining({ baseRevision: revision })));
    } finally { await act(async () => { mutation.resolve({ status: "applied", revision: 2, project: h.dto(edited, 2) }); }); }
  });

  it.each(["conflict", "recovery"] as const)("preserves the current %s state discovered while draining a batch adoption", async (failure) => {
    const h = await renderBatchControlApp();
    const mutation = deferred<ProjectChangeResult>();
    h.applyProjectMutation.mockReturnValue(mutation.promise);
    const edited = structuredClone(h.opened);
    edited.dialogueLines[0]!.sourceText = "안전하게 보존한 원문";
    const completed = structuredClone(h.opened);
    completed.processing.queue = h.makeQueue("actual-queue", "completed");
    completed.dialogueLines[0]!.sourceText = "충돌 뒤 버릴 원문";
    const response: ProjectChangeResult = failure === "conflict"
      ? { status: "revision_conflict", code: "REVISION_CONFLICT", conflictingPaths: ["dialogueLines"], revision: 2, project: h.dto(edited, 2) }
      : { status: "applied", revision: 2, project: h.dto(edited, 2, "needs_recovery") };
    try {
      await h.start();
      act(() => { h.metadata(); });
      fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "안전하게 보존한 원문" } });
      await waitFor(() => expect(h.applyProjectMutation).toHaveBeenCalledOnce());
      await act(async () => { h.run.resolve(h.result(completed, 100)); await h.run.promise; });
      expect(screen.queryByRole("button", { name: "완료 및 닫기" })).not.toBeInTheDocument();
      await act(async () => { mutation.resolve(response); await mutation.promise; });
      expect(screen.getByLabelText("원문 1")).toHaveValue("안전하게 보존한 원문");
      expect(screen.queryByText("검증용 Batch 종료")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "완료 및 닫기" })).not.toBeInTheDocument();
      if (failure === "recovery") expect(screen.getByRole("button", { name: "일괄 자동화" })).toBeDisabled();
      else expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("다른 변경과 충돌했습니다");
    } finally { await act(async () => { mutation.resolve(response); h.run.resolve(h.result(completed, 100)); }); }
  });

  it("keeps a partial batch result visible and opens its failed page in the processing queue", async () => {
    await renderWorkspaceApp();
    const updatedProject = normalizeProject(createEmptyProject("Batch partial", false));
    updatedProject.pageImages = [pageImage({ id: "batch-failed-page", pageNumber: 2 })];
    updatedProject.dialogueLines = [{
      ...rendererLine("batch-line", 1, "Batch source", 2),
      origin: { kind: "manual" },
      aiTranslation: "부분 번역"
    }];
    updatedProject.processing.queue = {
      schemaVersion: 1,
      queueId: "batch-queue-1",
      projectSessionId: "batch-fallback",
      status: "failed",
      pageImageIds: ["batch-failed-page"],
      pages: [{
        pageImageId: "batch-failed-page",
        status: "failed",
        stage: "translation",
        revision: 1,
        error: {
          code: "BATCH_TRANSLATION_FAILED",
          message: "페이지 2 번역 Provider 응답 시간이 초과되었습니다.",
          retryable: true,
          stage: "translation"
        },
        updatedAt: "2026-08-28T00:00:00.000Z"
      }],
      currentPageIndex: 0,
      failureReason: "페이지 2 번역 Provider 응답 시간이 초과되었습니다.",
      lastUpdatedAt: "2026-08-28T00:00:00.000Z"
    };
    const runBatchJob = vi.fn().mockImplementation(async ({ project: startedProject }) => ({
      progress: {
        stage: "partial",
        currentPageIndex: 0,
        totalPages: 1,
        percent: 100,
        currentMessage: "일괄 자동화 부분 완료: 1개 적용, 1개 번역 실패",
        pageStatuses: {},
        errors: [{ pageNumber: 2, message: "페이지 2 번역 Provider 응답 시간이 초과되었습니다." }],
        isCanceled: false
      },
      updatedProject: { ...updatedProject, metadata: { ...updatedProject.metadata, id: startedProject.metadata.id } }
    }));
    window.projectApi = { ...window.projectApi!, runBatchJob };

    const batchButton = screen.getByRole("button", { name: "일괄 자동화" });
    expect(batchButton).toHaveAttribute("title", "전체 페이지 번역·식자 일괄 실행");
    expect(batchButton.getAttribute("title")).not.toMatch(/OCR|인페인팅/);
    fireEvent.click(batchButton);
    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));

    expect(await screen.findByRole("alert", { name: "일괄 처리 오류 요약" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /전 페이지 일괄 자동화/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "실패 페이지를 작업 큐에서 확인" }));

    expect(screen.queryByRole("dialog", { name: /전 페이지 일괄 자동화/ })).not.toBeInTheDocument();
    const queuePanel = screen.getByRole("region", { name: "페이지 작업 큐" });
    const failedPage = within(queuePanel).getByRole("listitem", { name: "페이지 2" });
    expect(within(failedPage).getByText("페이지 2 번역 Provider 응답 시간이 초과되었습니다.")).toBeInTheDocument();
    expect(within(failedPage).getByRole("button", { name: "실패 번역 다시 실행" })).toBeInTheDocument();
  });

  it("opens a project with panels closed and keeps selecting a line separate from editing", async () => {
    const opened = openedProjectWithImages([pageImage()], [
      rendererLine("reading-first", 1, "첫 번째 대사"),
      rendererLine("reading-second", 2, "두 번째 대사")
    ]);
    window.localStorage.setItem(`focus-deck:${opened.filePath}`, JSON.stringify({
      pagesOpen: true, inspectorOpen: true, resultsOpen: true, focusMode: false, inspectorWidth: 400, zoom: 1.25
    }));
    window.projectApi = {
      importTxtFile: vi.fn(), chooseSaveFile: vi.fn(), exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(opened), saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
    };
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 열었습니다."));
    expect(screen.getByRole("button", { name: "페이지 목록 열기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /작업 인스펙터 열기|번역 편집기 열기/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "결과 및 진행 열기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("complementary", { name: "오른쪽 작업 패널" })).not.toBeInTheDocument();
    expect(await screen.findByText("125%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const second = screen.getByRole("button", { name: /두 번째 대사/ });
    fireEvent.click(second);
    expect(second).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("complementary", { name: "오른쪽 작업 패널" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /작업 인스펙터 열기|번역 편집기 열기/ }));
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "400");
    expect(await within(screen.getByRole("complementary", { name: "오른쪽 작업 패널" })).findByLabelText("원문 2")).toHaveValue("두 번째 대사");
  });

  it("opens pages, context, progress and editing from the workspace navigation", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
    window.projectApi = {
      importTxtFile: vi.fn(), chooseSaveFile: vi.fn(), exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])), saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
    };
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    const navigation = screen.getByRole("navigation", { name: "작업 영역" });

    fireEvent.click(within(navigation).getByRole("button", { name: "페이지" }));
    expect(screen.getByRole("complementary", { name: "페이지 목록" })).toBeVisible();
    fireEvent.click(within(navigation).getByRole("button", { name: "문맥" }));
    expect(screen.getByRole("region", { name: "등장인물과 용어 문맥" })).toBeVisible();
    fireEvent.click(within(navigation).getByRole("button", { name: "수정" }));
    expect(await screen.findByRole("complementary", { name: "오른쪽 작업 패널" })).toBeVisible();
    fireEvent.click(within(navigation).getByRole("button", { name: "수정" }));
    expect(screen.queryByRole("complementary", { name: "오른쪽 작업 패널" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "페이지 목록" })).not.toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole("button", { name: "진행" }));
    expect(screen.getByRole("region", { name: "하단 대사 패널" })).toBeVisible();
    fireEvent.click(within(navigation).getByRole("button", { name: "설정" }));
    expect(screen.getByRole("region", { name: "프로젝트 설정" })).toBeVisible();
  });

  it.each([
    { name: "empty user text and empty proposal", userTranslation: "", aiTranslation: "" },
    { name: "whitespace user text beside an AI proposal", userTranslation: "   ", aiTranslation: "AI가 제안한 번역" }
  ])("keeps $name unconfirmed through the selected-line actions", async ({ userTranslation, aiTranslation }) => {
    const saveProject = vi.fn();
    const applyProjectMutation = vi.fn();
    window.projectApi = {
      importTxtFile: vi.fn(), chooseSaveFile: vi.fn(), exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([], [{
        ...rendererLine("empty-confirmation", 1, "확인할 원문"),
        lineStatus: "draft", userTranslation, aiTranslation
      }])),
      saveProject, applyProjectMutation
    };
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await findWorkStatus("프로젝트를 열었습니다.");
    const actions = await screen.findByLabelText("선택한 대사 작업");
    fireEvent.click(within(actions).getByText("대사 1 확인", { selector: "summary" }));
    expect(within(actions).getByText("확인할 원문")).toBeVisible();
    const confirm = within(actions).getByRole("button", { name: "선택 대사 검수 확정" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(screen.queryByRole("complementary", { name: "오른쪽 작업 패널" })).not.toBeInTheDocument();

    fireEvent.click(within(actions).getByRole("button", { name: "대사 수정" }));
    const inspector = await screen.findByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(await within(inspector).findByLabelText("사용자 수정문 1")).toHaveValue(userTranslation);
    expect(within(inspector).getByLabelText("AI 번역 1")).toHaveValue(aiTranslation);
    expect(within(inspector).getByRole("button", { name: "검수 확정" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(within(inspector).getByRole("button", { name: "완료 표시" })).toHaveAttribute("aria-pressed", "false");
    expect(within(inspector).getByLabelText("사용자 수정문 1")).toHaveValue(userTranslation);
    expect(applyProjectMutation).not.toHaveBeenCalled();
    expect(saveProject).not.toHaveBeenCalled();
  });

  it("opens page and editor regions explicitly and keeps results available on demand without a tool drawer", async () => {
    await renderWorkspaceApp();

    expect(screen.getByRole("button", { name: "페이지 목록 접기" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /작업 인스펙터 접기|번역 편집기 접기/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "결과 및 진행 열기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "하단 대사 패널" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("preserves an existing light theme without a workspace version marker", async () => {
    window.localStorage.setItem("trio:ui-theme", "light");

    await renderWorkspaceApp();

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("trio:ui-theme")).toBe("light");
  });

  it("keeps a direct workspace theme choice when Settings loads a different Main theme", async () => {
    await renderWorkspaceApp();
    fireEvent.click(screen.getByRole("button", { name: "라이트 테마로 전환" }));
    fireEvent.click(screen.getByRole("button", { name: "다크 테마로 전환" }));
    const updateProviderSettings = vi.fn();
    window.projectApi!.updateProviderSettings = updateProviderSettings;

    fireEvent.click(screen.getByText("도구", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "작업실 홈" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "메뉴" })).getByRole("button", { name: "설정" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("trio:ui-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "다크" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    expect(screen.queryByRole("dialog", { name: "저장하지 않은 설정" })).not.toBeInTheDocument();
    expect(updateProviderSettings).not.toHaveBeenCalled();
  });

  it("switches the contextual navigator and persists an explicit workspace theme choice", async () => {
    await renderWorkspaceApp();

    expect(screen.getByRole("button", { name: "탐색: 페이지" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "탐색: 문맥" }));
    expect(screen.getByRole("button", { name: "탐색: 문맥" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("현재 프로젝트의 등장인물과 용어를 관리합니다.")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "라이트 테마로 전환" })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "라이트 테마로 전환" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("trio:ui-theme")).toBe("light");
  });

  it("starts with one primary manga action on Project Home", () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    render(<App />);

    expect(screen.queryByTestId("focus-deck-shell")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "번역 프로젝트" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "새 번역 프로젝트" })).toHaveClass("primary-button");
    expect(screen.queryByText("현재 페이지 이미지가 없습니다.")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "작업 진행 단계" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "작업 도구" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("오른쪽 작업 패널")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("하단 대사 패널")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("페이지 이동")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "시작 준비" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "완료" })).not.toBeInTheDocument();
  });

  it("starts with image selection and opens an image-only workspace", async () => {
    const choosePreparedPageImageFiles = vi.fn().mockResolvedValue([preparedPageImage()]);
    const chooseSaveFile = vi.fn().mockResolvedValue("C:\\projects\\Book.ctp");
    const saveProject = vi.fn().mockResolvedValue(undefined);
    const importPageImages = vi.fn().mockResolvedValue([{ ok: true, pageImage: pageImage() }]);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile,
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject,
      choosePreparedPageImageFiles,
      releasePreparedPageImages: vi.fn().mockResolvedValue(undefined),
      importPageImages,
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    const createButton = screen.getByRole("button", { name: "프로젝트 만들기" });
    const createClick = vi.spyOn(createButton, "click");
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });

    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeInTheDocument();
    expect(createClick).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "이미지로 번역 프로젝트 시작" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "빠른 OCR" })).not.toBeInTheDocument();
    await openWorkspacePanel("수정");
    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(within(inspector).getByRole("button", { name: "말풍선 OCR" })).toBeInTheDocument();
    expect(saveProject).toHaveBeenCalledTimes(2);
    expect(importPageImages).toHaveBeenCalledWith({
      projectFilePath: "C:\\projects\\Book.ctp",
      files: [{ sourcePath: "C:\\images\\page-001.jpg", pageNumber: 1 }]
    });
  });

  it("does not create a project when save selection is canceled", async () => {
    const saveProject = vi.fn();
    const importPageImages = vi.fn();
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue(null),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject,
      choosePreparedPageImageFiles: vi.fn().mockResolvedValue([preparedPageImage()]),
      releasePreparedPageImages: vi.fn(),
      importPageImages
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByText("프로젝트 만들기를 취소했습니다.", { selector: ".project-setup-status" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeInTheDocument();
    expect(saveProject).not.toHaveBeenCalled();
    expect(importPageImages).not.toHaveBeenCalled();
  });

  it("shows a saved empty start state when every image import fails", async () => {
    const saveProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject,
      choosePreparedPageImageFiles: vi.fn().mockResolvedValue([
        preparedPageImage({ sourcePath: "C:\\images\\bad.jpg", fileName: "bad.jpg" })
      ]),
      releasePreparedPageImages: vi.fn(),
      importPageImages: vi.fn().mockResolvedValue([
        { ok: false, sourcePath: "C:\\images\\bad.jpg", message: "지원하지 않는 이미지입니다." }
      ])
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "bad.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByText("지원하지 않는 이미지입니다.", { selector: ".project-setup-status" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeInTheDocument();
    expect(saveProject).toHaveBeenCalledOnce();
  });

  it("Task 8 user path: keeps successful pages open and exposes a badge when one image import fails", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn().mockResolvedValue(undefined),
      choosePreparedPageImageFiles: vi.fn().mockResolvedValue([
        preparedPageImage({ id: "one", sourcePath: "C:\\images\\01.jpg", fileName: "01.jpg" }),
        preparedPageImage({ id: "two", sourcePath: "C:\\images\\02.jpg", fileName: "02.jpg" })
      ]),
      releasePreparedPageImages: vi.fn().mockResolvedValue(undefined),
      importPageImages: vi.fn().mockResolvedValue([
        { ok: true, pageImage: pageImage() },
        { ok: false, sourcePath: "C:\\images\\02.jpg", message: "bad image" }
      ]),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "01.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("이미지 1개를 불러왔고 1개를 불러오지 못했습니다.");
    await openWorkspacePanel("페이지");
    expect(screen.getByRole("complementary", { name: "페이지 목록" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 접기" }));
    expect(within(screen.getByRole("button", { name: "페이지 목록 열기" })).getByText("페이지 1 · 실패 1")).toBeVisible();
  });

  it("keeps partial-import failures badged when final save fails", async () => {
    const saveProject = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("최종 저장 실패"));
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject,
      choosePreparedPageImageFiles: vi.fn().mockResolvedValue([
        preparedPageImage({ id: "one", sourcePath: "C:\\images\\01.jpg", fileName: "01.jpg" }),
        preparedPageImage({ id: "two", sourcePath: "C:\\images\\02.jpg", fileName: "02.jpg" })
      ]),
      releasePreparedPageImages: vi.fn().mockResolvedValue(undefined),
      importPageImages: vi.fn().mockResolvedValue([
        { ok: true, pageImage: pageImage() },
        { ok: false, sourcePath: "C:\\images\\02.jpg", message: "bad image" }
      ]),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "01.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeInTheDocument();
    expect(screen.getByText("변경 있음")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("최종 저장 실패");
    await openWorkspacePanel("페이지");
    expect(screen.getByRole("complementary", { name: "페이지 목록" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 접기" }));
    expect(within(screen.getByRole("button", { name: "페이지 목록 열기" })).getByText("페이지 1 · 실패 1")).toBeVisible();
  });

  it("routes Ctrl+Enter from Home to Setup and then to image selection", async () => {
    const choosePreparedPageImageFiles = vi.fn().mockResolvedValue(null);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      choosePreparedPageImageFiles,
      importPageImages: vi.fn()
    };

    renderApp();
    const newButton = screen.getByRole("button", { name: "새 번역 프로젝트" });
    const newClick = vi.spyOn(newButton, "click");
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });

    expect(newClick).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toHaveFocus();
    expect(choosePreparedPageImageFiles).not.toHaveBeenCalled();
    const chooseButton = screen.getByRole("button", { name: "이미지 선택" });
    const chooseClick = vi.spyOn(chooseButton, "click");
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(choosePreparedPageImageFiles).toHaveBeenCalledOnce());
    expect(chooseClick).not.toHaveBeenCalled();
  });

  it("does not use document selectors to route keyboard business actions", () => {
    const appSource = readFileSync("src/renderer/App.tsx", "utf8");

    expect(appSource).not.toContain("document.querySelector");
  });

  it("uses the shared neutral home surface without an accent shadow", () => {
    const productStyles = readFileSync("src/renderer/design-system.css", "utf8");
    const heroRule = productStyles.match(/\.trio-hero-banner-card \{([^}]+)\}/)?.[1];
    expect(heroRule).toContain("background: var(--trio-panel)");
    expect(heroRule).toContain("box-shadow: none");
  });

  it("keeps TXT import as a secondary start path", async () => {
    const importTxtFile = vi.fn().mockResolvedValue({
      filePath: "dialogue.txt",
      lines: [rendererLine("txt-line", 1, "TXT 대사")]
    });
    window.projectApi = {
      importTxtFile,
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("TXT 대사")).toBeInTheDocument();
    expect(importTxtFile).toHaveBeenCalledOnce();
  });

  it("keeps the empty Focus Deck full-width with a minimum toolbar row that can grow with content", () => {
    const emptyWorkspaceRule = focusDeckStyles.match(/^\.focus-deck-shell\.empty-workspace\s*\{([^}]+)\}/m)?.[1];
    const productStyles = readFileSync("src/renderer/design-system.css", "utf8");
    const toolbarOverride = productStyles.match(/^\.inkline-command-bar\.app-top-bar\s*\{([^}]+)\}/m)?.[1];
    const toolbarLayout = [...focusDeckStyles.matchAll(/^\.inkline-command-bar\.app-top-bar\s*\{([^}]+)\}/gm)].at(-1)?.[1];
    const headerRules = [...focusDeckStyles.matchAll(/^\.focus-deck-top-bar\s*\{([^}]+)\}/gm)]
      .map((match) => match[1]).join("\n");

    // jsdom has no layout engine: guard the CSS sizing contract, not mocked pixel geometry.
    // The first row keeps its shared minimum but grows with content; the second takes the remaining space.
    expect(emptyWorkspaceRule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*!important/);
    expect(emptyWorkspaceRule).toMatch(/grid-template-rows:\s*minmax\(var\(--trio-toolbar-height\),\s*auto\)\s+minmax\(0,\s*1fr\)\s*!important/);
    expect(headerRules).toContain("min-height: var(--trio-toolbar-height)");

    // The later product stylesheet removes the toolbar's fixed height while preserving a positive minimum.
    expect(toolbarOverride).toMatch(/(?:^|;)\s*height:\s*auto\s*;/);
    const minimumHeight = toolbarOverride?.match(/min-height:\s*([\d.]+)px\s*;/)?.[1];
    expect(Number(minimumHeight)).toBeGreaterThan(0);
    expect(toolbarLayout).toMatch(/display:\s*flex\s*;/);
    expect(toolbarLayout).toMatch(/flex-wrap:\s*wrap\s*;/);

    // Wrapped controls must not be capped or clipped by the toolbar/header.
    expect(headerRules).toContain("overflow: visible");
    for (const rule of [headerRules, toolbarLayout, toolbarOverride]) {
      expect(rule).not.toMatch(/(?:^|;)\s*(?:height|max-height):\s*(?!auto\b|none\b)\S[^;]*;/);
      expect(rule).not.toMatch(/overflow(?:-y)?:\s*(?:hidden|clip)\b/);
    }
  });

  it("keeps the shared Workspace shell for a saved project with no dialogue lines", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([], [])),
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    expect(await screen.findByText("만화 원본 이미지를 여기에 드롭하세요")).toBeInTheDocument();
    await openWorkspacePanel("수정");
    expect(screen.getByLabelText("이미지 중심 작업 영역")).toBeInTheDocument();
    expect(screen.getByLabelText("오른쪽 작업 패널")).toBeInTheDocument();
    expect(screen.queryByLabelText("하단 대사 패널")).not.toBeInTheDocument();
    expect(screen.getByLabelText("페이지 이동")).toBeInTheDocument();
  });

  it("leaves the start state and selects the first line after TXT import", async () => {
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "dialogue.txt",
        lines: [rendererLine("line-entry", 1, "첫 대사")]
      }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    render(<App />);
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("첫 대사");
    expect(screen.queryByRole("heading", { name: "이미지로 번역 프로젝트 시작" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "TXT로 시작" })).not.toBeInTheDocument();
    const primaryActions = document.querySelectorAll('[data-primary-action="true"]');
    expect(primaryActions).toHaveLength(1);
    expect(primaryActions[0]).toHaveAccessibleName("검수 확정");
  });

  it("keeps the shared Workspace shell when TXT import contains no dialogue lines", async () => {
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "empty.txt", lines: [] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    render(<App />);
    await clickTxtStart();

    expect(await screen.findByText("만화 원본 이미지를 여기에 드롭하세요")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("대사 0개를 불러왔습니다.");
  });

  it("blocks repeated TXT import while the file dialog is pending", async () => {
    const pendingImport = deferred<{ filePath: string; lines: DialogueLine[] } | null>();
    const importTxtFile = vi.fn().mockReturnValue(pendingImport.promise);
    window.projectApi = {
      importTxtFile,
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    render(<App />);
    openTxtStartActions();
    const importButton = screen.getByRole("button", { name: "TXT로 시작" });
    fireEvent.click(importButton);
    fireEvent.click(importButton);

    expect(importTxtFile).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "TXT 불러오는 중" })).toBeDisabled();

    pendingImport.resolve(null);
    await waitFor(() => expect(screen.getByRole("button", { name: "TXT로 시작" })).toBeEnabled());
  });

  it("keeps Setup when a pending TXT import resolves after New starts", async () => {
    const pendingImport = deferred<{ filePath: string; lines: DialogueLine[] } | null>();
    window.projectApi = {
      importTxtFile: vi.fn().mockReturnValue(pendingImport.promise),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toHaveFocus();

    await act(async () => {
      pendingImport.resolve({ filePath: "late.txt", lines: [rendererLine("late-txt", 1, "Late TXT line")] });
      await pendingImport.promise;
    });

    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeVisible();
    expect(screen.queryByDisplayValue("Late TXT line")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not let a pending TXT import mutate a newer opened Workspace", async () => {
    const pendingImport = deferred<{ filePath: string; lines: DialogueLine[] } | null>();
    const opened = namedOpenedProject("C:\\projects\\Opened.ctp", "Opened", "Opened project line");
    window.projectApi = {
      importTxtFile: vi.fn().mockReturnValue(pendingImport.promise),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(opened),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("Opened project line")).toBeVisible();

    await act(async () => {
      pendingImport.resolve({ filePath: "late.txt", lines: [rendererLine("late-txt", 1, "Late TXT line")] });
      await pendingImport.promise;
    });

    expect(screen.getByDisplayValue("Opened project line")).toBeVisible();
    expect(screen.queryByDisplayValue("Late TXT line")).not.toBeInTheDocument();
    expect(screen.getByText("C:\\projects\\Opened.ctp")).toBeVisible();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 열었습니다.");
  });

  it("keeps a newer TXT import busy when an invalidated import settles", async () => {
    const importA = deferred<{ filePath: string; lines: DialogueLine[] } | null>();
    const importB = deferred<{ filePath: string; lines: DialogueLine[] } | null>();
    const importTxtFile = vi.fn()
      .mockReturnValueOnce(importA.promise)
      .mockReturnValueOnce(importB.promise);
    window.projectApi = {
      importTxtFile,
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "취소" }));
    openTxtStartActions();

    const nextImportButton = screen.getByRole("button", { name: "TXT로 시작" });
    expect(nextImportButton).toBeEnabled();
    fireEvent.click(nextImportButton);
    expect(importTxtFile).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "TXT 불러오는 중" })).toBeDisabled();

    await act(async () => {
      importA.resolve(null);
      await importA.promise;
    });
    expect(screen.getByRole("button", { name: "TXT 불러오는 중" })).toBeDisabled();

    importB.resolve(null);
    await waitFor(() => expect(screen.getByRole("button", { name: "TXT로 시작" })).toBeEnabled());
  });

  it("keeps the Empty Workspace after the final content line is deleted", async () => {
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "workspace.txt",
        lines: [rendererLine("workspace-line", 1, "Workspace line")]
      }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
    fireEvent.click(screen.getByRole("button", { name: "라인 삭제" }));
    await answerAppConfirmation("대사 삭제");
    expect(await screen.findByText("만화 원본 이미지를 여기에 드롭하세요")).toBeVisible();
    expect(screen.getByTestId("focus-deck-shell")).toBeInTheDocument();
    expect(screen.getByLabelText("이미지 중심 작업 영역")).toBeInTheDocument();
  });

  it("renders the image-first workspace landmarks", async () => {
    await renderWorkspaceApp();

    expect(screen.getByRole("banner", { name: "앱 상단 바" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "작업 도구" })).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "이미지 중심 작업 영역" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "페이지 목록" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "오른쪽 작업 패널" })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo", { name: "결과 및 진행" })).toBeInTheDocument();
  });

  it("collapses workspace regions independently and keeps settings and context reachable", async () => {
    await renderWorkspaceApp();

    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 접기" }));
    expect(screen.queryByRole("complementary", { name: "페이지 목록" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "오른쪽 작업 패널" })).toBeInTheDocument();

    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(within(inspector).getByText("프로젝트 문맥")).toBeInTheDocument();

    openSettings();
    expect(screen.getByRole("region", { name: "프로젝트 설정" })).toBeInTheDocument();
  });

  it("opens the right inspector for the selected line and otherwise shows an empty state", async () => {
    const line: DialogueLine = {
      id: "line-inspector-switch",
      order: 1,
      pageNumber: 1,
      speaker: "Mika",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Open inspector",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "inspector.txt", lines: [line] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();

    expect(screen.queryByLabelText("오른쪽 작업 패널")).not.toBeInTheDocument();

    await clickTxtStart();
    await openWorkspacePanel("수정");
    fireEvent.click(await screen.findByLabelText("원문 1"));

    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(within(inspector).getByText(/라인 상세|페이지 · 대사/)).toBeInTheDocument();
    expect(within(inspector).getByText("프로젝트 문맥")).toBeInTheDocument();
  });

  it("runs speech bubble OCR with Space when a saved page image is available", async () => {
    const extractSpeechBubbles = vi.fn().mockResolvedValue({
      pageNumber: 1,
      speechBubbles: [],
      nonSpeechText: [],
      warnings: []
    });
    const validateSpeechBubbles = vi.fn().mockResolvedValue({
      pageNumber: 1,
      speechBubbles: [],
      nonSpeechText: [],
      warnings: []
    });
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage()], [rendererLine("export-line", 1, "내보낼 대사")])
      ),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg"),
      extractSpeechBubbles,
      validateSpeechBubbles
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    expect(await screen.findByAltText("1페이지 이미지")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: " " });

    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledTimes(1));
    expect(validateSpeechBubbles).not.toHaveBeenCalled();
  });

  it("keeps Production OCR candidates reviewable without Cloud validation", async () => {
    const extraction = validatedReviewExtraction();
    const validateSpeechBubbles = vi.fn().mockRejectedValue(new Error("validation provider failed"));
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage()], [rendererLine("degraded-line", 1, "검증 실패")])
      ),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg"),
      extractSpeechBubbles: vi.fn().mockResolvedValue(extraction),
      validateSpeechBubbles
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));

    expect(await screen.findByLabelText("speech_bubble 1 원문")).toHaveValue("첫 번째 OCR");
    fireEvent.click(screen.getByRole("button", { name: /^thought_bubble 2 검토:/ }));
    expect(await screen.findByLabelText("thought_bubble 2 원문")).toHaveValue("두 번째 OCR");
    expect(screen.getByRole("button", { name: /^thought_bubble 2 검토:/ })).toHaveAttribute("aria-current", "true");
    expect(validateSpeechBubbles).not.toHaveBeenCalled();
    expect(document.querySelector('[data-validation-status="degraded"]')).not.toBeInTheDocument();
  });

  it("keeps an unfinished OCR draft when the user closes the tool and visits another page", async () => {
    const extractSpeechBubbles = vi.fn().mockResolvedValue(validatedReviewExtraction());
    window.projectApi = {
      importTxtFile: vi.fn(), chooseSaveFile: vi.fn(), exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([
        pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })
      ])),
      saveProject: vi.fn(), importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg"),
      extractSpeechBubbles
    };
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: /작업 인스펙터 열기|번역 편집기 열기/ }));
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    const original = await screen.findByLabelText("speech_bubble 1 원문");
    fireEvent.change(original, { target: { value: "직접 고친 OCR 원문" } });

    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR 검토 닫기" }));
    expect(screen.queryByRole("region", { name: "1페이지 말풍선 OCR 검토" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /작업 인스펙터 열기|번역 편집기 열기/ }));
    expect(await screen.findByLabelText("speech_bubble 1 원문")).toHaveValue("직접 고친 OCR 원문");

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(screen.queryByRole("region", { name: "1페이지 말풍선 OCR 검토" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    expect(await screen.findByLabelText("speech_bubble 1 원문")).toHaveValue("직접 고친 OCR 원문");
    expect(extractSpeechBubbles).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    expect(await screen.findByRole("region", { name: "1페이지 인페인팅 편집기" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "1페이지 말풍선 OCR 검토" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "OCR 검토 계속" }));
    expect(await screen.findByLabelText("speech_bubble 1 원문")).toHaveValue("직접 고친 OCR 원문");
    expect(screen.queryByRole("region", { name: "1페이지 인페인팅 편집기" })).not.toBeInTheDocument();
    expect(extractSpeechBubbles).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("미적용 OCR 검토 초안");
    await answerAppConfirmation("계속 검토");
    expect(extractSpeechBubbles).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("speech_bubble 1 원문")).toHaveValue("직접 고친 OCR 원문");

    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("미적용 OCR 검토 초안");
    await answerAppConfirmation("계속 편집");
    expect(screen.getByLabelText("speech_bubble 1 원문")).toHaveValue("직접 고친 OCR 원문");
    const closeEvent = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(closeEvent)).toBe(false);
  });

  it("runs Production OCR independently of translation Provider settings", async () => {
    const extractSpeechBubbles = vi.fn().mockResolvedValue(emptyOcrExtraction());
    const validateSpeechBubbles = vi.fn();
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage()], [rendererLine("provider-error-line", 1, "설정 오류")])
      ),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg"),
      getProviderSettings: vi.fn().mockRejectedValue(new Error("settings IPC failed")),
      extractSpeechBubbles,
      validateSpeechBubbles
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));

    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledOnce());
    expect(window.projectApi.getProviderSettings).not.toHaveBeenCalled();
    expect(validateSpeechBubbles).not.toHaveBeenCalled();
  });

  it("clears a completed Production OCR review when the page changes", async () => {
    const pendingSettings = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const extractSpeechBubbles = vi.fn().mockResolvedValue(emptyOcrExtraction(2));
    const validateSpeechBubbles = vi.fn().mockResolvedValue(emptyOcrExtraction(2));
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })])
      ),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg"),
      getProviderSettings: vi.fn().mockReturnValue(pendingSettings.promise),
      extractSpeechBubbles,
      validateSpeechBubbles
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledOnce());
    expect(window.projectApi.getProviderSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");

    expect(extractSpeechBubbles).toHaveBeenCalledOnce();
    expect(validateSpeechBubbles).not.toHaveBeenCalled();
    expect(screen.queryByText(/추출하는 중입니다/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OCR 취소" })).not.toBeInTheDocument();
    expect(screen.queryAllByText("Provider 설정을 불러오지 못해 작업을 시작하지 않았습니다.")).toHaveLength(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "오른쪽 작업 패널" })).getByRole("button", { name: "말풍선 OCR" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledTimes(2));
    expect(extractSpeechBubbles).toHaveBeenCalledWith(expect.objectContaining({
      pageImageId: "page-image-2",
      sourceSha256: "a".repeat(64)
    }));
  });

  it("does not carry a Production OCR review into a replacement project", async () => {
    const pendingSettings = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const extractSpeechBubbles = vi.fn().mockResolvedValue(emptyOcrExtraction());
    const validateSpeechBubbles = vi.fn().mockResolvedValue(emptyOcrExtraction());
    const projectA = openedProjectWithImages([pageImage()], [rendererLine("project-a-ocr", 1, "프로젝트 A")]);
    const projectB = openedProjectWithImages(
      [pageImage({ id: "page-image-b", storedRelativePath: "Replacement-assets/images/page-001.jpg" })],
      [rendererLine("project-b-ocr", 1, "프로젝트 B")]
    );
    projectB.filePath = "C:\\projects\\Replacement.ctp";
    projectB.project.metadata.id = "replacement-project";
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValueOnce(projectA).mockResolvedValueOnce(projectB),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg"),
      getProviderSettings: vi.fn().mockReturnValue(pendingSettings.promise),
      extractSpeechBubbles,
      validateSpeechBubbles
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledOnce());

    await screen.findByRole("region", { name: "1페이지 말풍선 OCR 검토" });
    fireEvent.click(within(screen.getByRole("banner", { name: "앱 상단 바" })).getByRole("button", { name: "열기" }));
    await answerAppConfirmation("버리고 이동");
    await screen.findByText(projectB.project.metadata.title, { selector: ".workspace-product-type" });
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("프로젝트 B");

    expect(extractSpeechBubbles).toHaveBeenCalledOnce();
    expect(screen.queryByText(/추출하는 중입니다/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OCR 취소" })).not.toBeInTheDocument();
    expect(screen.queryAllByText("Provider 설정을 불러오지 못해 작업을 시작하지 않았습니다.")).toHaveLength(0);
    expect(screen.getByLabelText("원문 1")).toHaveValue("프로젝트 B");
    expect(within(screen.getByRole("complementary", { name: "오른쪽 작업 패널" })).getByRole("button", { name: "말풍선 OCR" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledTimes(2));
    expect(extractSpeechBubbles).toHaveBeenCalledWith(expect.objectContaining({
      pageImageId: "page-image-b"
    }));
  });

  it("does not consult a pending translation Provider settings request for OCR", async () => {
    const pendingSettings = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const extractSpeechBubbles = vi.fn().mockResolvedValue(emptyOcrExtraction());
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })])
      ),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg"),
      getProviderSettings: vi.fn().mockReturnValue(pendingSettings.promise),
      extractSpeechBubbles,
      validateSpeechBubbles: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledOnce());
    expect(window.projectApi.getProviderSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(screen.queryAllByText("Provider 설정을 불러오지 못해 작업을 시작하지 않았습니다.")).toHaveLength(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OCR 취소" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
  });

  it("starts Production OCR immediately while translation Provider settings are pending", async () => {
    const pendingSettings = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const extractSpeechBubbles = vi.fn().mockResolvedValue(emptyOcrExtraction());
    const validateSpeechBubbles = vi.fn().mockResolvedValue(emptyOcrExtraction());
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg"),
      getProviderSettings: vi.fn().mockReturnValue(pendingSettings.promise),
      extractSpeechBubbles,
      validateSpeechBubbles
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledTimes(1));
    expect(window.projectApi.getProviderSettings).not.toHaveBeenCalled();
    expect(extractSpeechBubbles).toHaveBeenCalledWith({
      pageImageId: "page-image-1",
      projectSessionId: "ocr-test-session",
      requestId: expect.any(String),
      sourceSha256: "a".repeat(64)
    });
    expect(await screen.findByLabelText("1페이지 말풍선 OCR 검토")).toBeInTheDocument();
  });

  it("does not route Production OCR through a selected Legacy OCR Provider", async () => {
    const extraction = emptyOcrExtraction();
    const extractSpeechBubbles = vi.fn().mockResolvedValue(extraction);
    window.projectApi = {
      importTxtFile: vi.fn(), chooseSaveFile: vi.fn(), exportTranslations: vi.fn(), saveProject: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg"),
      getProviderSettings: vi.fn().mockResolvedValue({
        ...DEFAULT_PROVIDER_SETTINGS,
        ocrEngine: "manga-ocr",
        mangaOcrEndpoint: "http://127.0.0.1:5500/ocr"
      }),
      extractSpeechBubbles,
      validateSpeechBubbles: vi.fn().mockResolvedValue(extraction)
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));

    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledOnce());
    expect(window.projectApi.getProviderSettings).not.toHaveBeenCalled();
    const request = extractSpeechBubbles.mock.calls[0]?.[0];
    expect(request).toEqual({
      pageImageId: "page-image-1",
      projectSessionId: "ocr-test-session",
      requestId: expect.any(String),
      sourceSha256: "a".repeat(64)
    });
    expect(request).not.toHaveProperty("engine");
    expect(request).not.toHaveProperty("ocrEndpoint");
  });

  it("disables current-page image relinking while OCR is running", async () => {
    const pendingExtraction = deferred<ReturnType<typeof emptyOcrExtraction>>();
    const extractSpeechBubbles = vi.fn().mockReturnValue(pendingExtraction.promise);
    const validateSpeechBubbles = vi.fn().mockResolvedValue(emptyOcrExtraction());
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage()], [rendererLine("relink-line", 1, "다시 연결 테스트")])
      ),
      saveProject: vi.fn(),
      choosePageImages: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg"),
      extractSpeechBubbles,
      validateSpeechBubbles
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    fireEvent.click(within(inspector).getByRole("button", { name: "말풍선 OCR" }));
    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledOnce());

    const relinkButton = within(inspector).getByRole("button", { name: "다시 연결" });
    expect(relinkButton).toBeDisabled();
    await openWorkspacePanel("페이지");
    expect(screen.getAllByText("현재 페이지 처리가 끝난 뒤 이미지를 다시 연결하세요.").length).toBeGreaterThan(0);

    await act(async () => {
      pendingExtraction.resolve(emptyOcrExtraction());
      await pendingExtraction.promise;
    });
    await waitFor(() => expect(relinkButton).toBeEnabled());
  });

  it("keeps the original fallback while a translated result is still processing", async () => {
    const source = pageImage();
    const base = openedProjectWithImages([source], [rendererLine("processing-line", 1, "처리 중 테스트")]);
    const activeRun = {
      runId: "active-run",
      pageImageId: source.id,
      source: "automatic_pipeline" as const,
      status: "running" as const,
      sourceSha256: source.sha256,
      appVersion: "0.1.0",
      queuedAt: "2026-08-03T00:00:00.000Z",
      startedAt: "2026-08-03T00:01:00.000Z"
    };
    const activeProject = normalizeProject({
      ...base.project,
      schemaVersion: 2,
      dialogueLines: base.project.dialogueLines.map((line) => ({
        ...line,
        origin: { kind: "manual" as const }
      })),
      processing: {
        pages: [{
          pageImageId: source.id,
          activeRunId: activeRun.runId,
          finalStatus: "pending" as const,
          updatedAt: "2026-08-03T00:01:00.000Z"
        }],
        runs: [activeRun],
        assets: []
      }
    });
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue({
        ...base,
        project: activeProject
      }),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue(source.storedRelativePath)
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: /식자\/번역 결과|Translated result/i }));

    const resultStatus = screen.getByText("번역 결과 처리 중입니다.").closest("[data-result-status]");
    expect(resultStatus).toHaveAttribute("data-result-status", "processing");
    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", source.storedRelativePath);
  });

  it("falls back to the original when an approved cleaned result reference is corrupt", async () => {
    const source = pageImage();
    const opened = openedProjectWithInpaintedResult([source]);
    const corruptProject = normalizeProject(opened.project);
    const cleanedAsset = corruptProject.processing.assets[0];
    if (!cleanedAsset) throw new Error("expected a cleaned asset fixture");
    cleanedAsset.sourcePageImageId = "missing-source-page";
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue({
        ...opened,
        project: corruptProject
      }),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue(source.storedRelativePath)
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i }));

    const resultStatus = screen
      .getByText("저장된 인페인팅 결과 연결이 유효하지 않아 원본을 표시합니다. 다시 생성하세요.")
      .closest("[data-result-status]");
    expect(resultStatus).toHaveAttribute("data-result-status", "missing");
    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", source.storedRelativePath);
  });

  it("does not run Space OCR while a text field has focus", async () => {
    const extractSpeechBubbles = vi.fn();
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg"),
      extractSpeechBubbles,
      validateSpeechBubbles: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    expect(await screen.findByAltText("1페이지 이미지")).toBeInTheDocument();

    openPagesPanel();
    openSettings();
    await openWorkspacePanel("수정");
    const titleInput = screen.getByLabelText("프로젝트 제목");
    titleInput.focus();
    fireEvent.keyDown(window, { key: " " });

    expect(extractSpeechBubbles).not.toHaveBeenCalled();
  });

  it("opens OCR review in the right inspector while keeping the page image visible", async () => {
    const validatedExtraction = {
      pageNumber: 1,
      speechBubbles: [
        {
          id: "bubble-panel-1",
          type: "speech_bubble" as const,
          text: "こんにちは",
          language: "ja" as const,
          bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
          readingOrder: 1,
          confidence: 0.9,
          notes: "",
          speakerCandidates: [{ speaker: "Mika", confidence: 0.8, reason: "tail points to Mika" }]
        }
      ],
      nonSpeechText: [],
      warnings: []
    };
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg"),
      extractSpeechBubbles: vi.fn().mockResolvedValue(validatedExtraction),
      validateSpeechBubbles: vi.fn().mockResolvedValue(validatedExtraction)
    };

    saveTypesettingDraft(window.localStorage, {
      projectId: "project-images",
      pageImageId: "page-image-1",
      sourceOcrId: "bubble-panel-1"
    }, {
      id: "outdated-typeset-draft",
      sourceOcrId: "bubble-panel-1",
      bbox: { x: 0.01, y: 0.01, width: 0.1, height: 0.1 },
      rotationDegrees: 25,
      writingMode: "horizontal-tb"
    });

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    expect(await screen.findByAltText("1페이지 이미지")).toBeInTheDocument();

    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));

    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(await within(inspector).findByLabelText("1페이지 말풍선 OCR 검토")).toBeInTheDocument();
    expect(screen.getByAltText("1페이지 이미지")).toBeInTheDocument();
    await screen.findByRole("region", { name: "1페이지 말풍선 OCR 검토" });
    await selectWorkspaceEditingTool("글자 배치");
    expect(await screen.findByTestId("typesetting-box-editor")).toHaveStyle({ left: "10%", top: "20%", width: "30%", height: "10%" });
  });

  it("commits every OCR typesetting draft into Main session lines and keeps it after save and reopen", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Typeset OCR", false));
    openedProject.metadata.id = "typeset-ocr-project";
    openedProject.pageImages = [pageImage({ id: "typeset-ocr-image" })];
    const firstBubble = {
      id: "bubble-typeset-1",
      type: "speech_bubble" as const,
      text: "こんにちは",
      language: "ja" as const,
      bbox: { x: 0.3, y: 0.3, width: 0.2, height: 0.15 },
      readingOrder: 1,
      confidence: 0.95,
      notes: "",
      speakerCandidates: [{ speaker: "Mika", confidence: 0.9, reason: "first" }]
    };
    const secondBubble = {
      id: "bubble-typeset-2",
      type: "thought_bubble" as const,
      text: "考え中",
      language: "ja" as const,
      bbox: { x: 0.55, y: 0.5, width: 0.2, height: 0.14 },
      readingOrder: 2,
      confidence: 0.9,
      notes: "",
      speakerCandidates: [{ speaker: "Ren", confidence: 0.8, reason: "second" }]
    };
    const thirdBubble = {
      id: "bubble-typeset-3",
      type: "speech_bubble" as const,
      text: "未編集",
      language: "ja" as const,
      bbox: { x: 0.1, y: 0.7, width: 0.18, height: 0.1 },
      readingOrder: 3,
      confidence: 0.91,
      notes: "",
      speakerCandidates: []
    };
    const extraction = {
      pageNumber: 1,
      speechBubbles: [firstBubble, secondBubble, thirdBubble],
      nonSpeechText: [],
      warnings: []
    };
    const secondDraft = {
      id: "draft-typeset-2",
      sourceOcrId: "bubble-typeset-2",
      bbox: { x: 0.56, y: 0.51, width: 0.16, height: 0.12 },
      rotationDegrees: 6,
      writingMode: "vertical-rl" as const,
      shape: "rectangle" as const
    };
    let sessionProject = structuredClone(openedProject);
    let sessionRevision = 1;
    let persistedProject = structuredClone(openedProject);
    const dto = (project: TranslationProjectV2, revision: number, dirty: boolean) => ({
      revision,
      project: structuredClone(project),
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const applyProjectMutation = vi.fn(async (args: ApplyProjectMutationArgs) => {
      if (args.mutation.type === "add_dialogue_line") {
        const input = args.mutation.input;
        sessionProject = {
          ...sessionProject,
          dialogueLines: [
            ...sessionProject.dialogueLines,
            {
              id: `main-${input.sourceText}`,
              order: sessionProject.dialogueLines.length + 1,
              pageNumber: input.pageNumber,
              sourceLanguage: input.sourceLanguage,
              sourceText: input.sourceText,
              dialogueType: input.dialogueType,
              lineStatus: input.lineStatus ?? "untranslated",
              parseConfidence: 1,
              parseWarnings: [],
              origin: { kind: "manual" as const },
              ...(input.speaker === undefined ? {} : { speaker: input.speaker }),
              ...(input.typesetting === undefined ? {} : { typesetting: input.typesetting })
            }
          ]
        };
      }
      sessionRevision += 1;
      return {
        status: "applied" as const,
        revision: sessionRevision,
        project: dto(sessionProject, sessionRevision, true)
      };
    });
    const applyProductionOcrReview = vi.fn(async (
      request: Parameters<NonNullable<NonNullable<typeof window.projectApi>["applyProductionOcrReview"]>>[0]
    ) => {
      sessionProject = applyProductionOcrReviewForTest(sessionProject, request);
      sessionRevision += 1;
      return {
        projectSessionId: "opened-session",
        project: dto(sessionProject, sessionRevision, true)
      };
    });
    const saveProject = vi.fn(async () => {
      persistedProject = structuredClone(sessionProject);
      return {
        projectSessionId: "opened-session",
        project: dto(sessionProject, sessionRevision, false)
      };
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(initialProject, 0, false),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn()
        .mockResolvedValueOnce({
          projectSessionId: "opened-session",
          project: dto(openedProject, 1, false),
          encrypted: false
        })
        .mockImplementation(async () => ({
          projectSessionId: "reopened-session",
          project: dto(persistedProject, sessionRevision, false),
          encrypted: false
        })),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      applyProductionOcrReview,
      saveProject,
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      extractSpeechBubbles: vi.fn().mockResolvedValue(extraction),
      validateSpeechBubbles: vi.fn().mockResolvedValue(extraction),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg")
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await screen.findByRole("region", { name: "1페이지 말풍선 OCR 검토" });
    await selectWorkspaceEditingTool("글자 배치");
    expect(await screen.findByTestId("typesetting-box-editor")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "식자 상자 이동" }), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("button", { name: "식자 상자 회전" }), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "세로쓰기로 전환" }));
    fireEvent.click(screen.getByRole("button", { name: "생각/독백 구름" }));
    saveTypesettingDraft(window.localStorage, {
      projectId: "typeset-ocr-project",
      pageImageId: "typeset-ocr-image",
      sourceOcrId: "bubble-typeset-2"
    }, secondDraft);

    await selectWorkspaceEditingTool("원문");
    fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));

    await waitFor(() => expect(applyProductionOcrReview).toHaveBeenCalledOnce());
    const addedInputs = applyProductionOcrReview.mock.calls[0]?.[0].candidates ?? [];
    expect(addedInputs.find((input) => input.text === "こんにちは")?.typesetting).toMatchObject({
      bbox: { x: 0.31, y: 0.3, width: 0.2, height: 0.15 },
      writingMode: "vertical-rl",
      rotationDegrees: 5,
      shape: "cloud"
    });
    expect(addedInputs.find((input) => input.text === "考え中")?.typesetting).toEqual({
      bbox: secondDraft.bbox,
      writingMode: "vertical-rl",
      rotationDegrees: 6,
      shape: "rectangle"
    });
    expect(addedInputs.find((input) => input.text === "未編集")?.typesetting).toEqual({
      bbox: calculateTypesettingSafeArea(thirdBubble.bbox),
      writingMode: "horizontal-tb"
    });

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(saveProject).toHaveBeenCalledWith({ projectSessionId: "opened-session" }));
    expect(persistedProject.dialogueLines.map((line) => line.typesetting)).toEqual(
      addedInputs.map((input) => input.typesetting)
    );

    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await waitFor(() => expect(window.projectApi.openProjectFromDialog).toHaveBeenCalledTimes(2));
    expect(persistedProject.dialogueLines.find((line) => line.sourceText === "こんにちは")?.typesetting).toMatchObject({
      writingMode: "vertical-rl",
      shape: "cloud"
    });
    expect(persistedProject.dialogueLines.find((line) => line.sourceText === "考え中")?.typesetting).toMatchObject({
      rotationDegrees: 6,
      writingMode: "vertical-rl",
      shape: "rectangle"
    });
  });

  it("does not apply a previous project's typesetting draft to a new session OCR line", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Fresh OCR", false));
    openedProject.metadata.id = "fresh-ocr-project";
    openedProject.pageImages = [pageImage({ id: "fresh-ocr-image" })];
    const bubble = {
      id: "shared-bubble-id",
      type: "speech_bubble" as const,
      text: "新しい",
      language: "ja" as const,
      bbox: { x: 0.2, y: 0.2, width: 0.25, height: 0.12 },
      readingOrder: 1,
      confidence: 0.93,
      notes: "",
      speakerCandidates: []
    };
    const extraction = { pageNumber: 1, speechBubbles: [bubble], nonSpeechText: [], warnings: [] };
    saveTypesettingDraft(window.localStorage, {
      projectId: "old-ocr-project",
      pageImageId: "fresh-ocr-image",
      sourceOcrId: "shared-bubble-id"
    }, {
      id: "stale-draft",
      sourceOcrId: "shared-bubble-id",
      bbox: { x: 0.7, y: 0.7, width: 0.15, height: 0.1 },
      rotationDegrees: 25,
      writingMode: "vertical-rl",
      shape: "spiky"
    });
    const applyProjectMutation = vi.fn(async (args: ApplyProjectMutationArgs) => ({
      status: "applied" as const,
      revision: 2,
      project: {
        revision: 2,
        project: openedProject,
        pendingPageImages: [] as [],
        dirty: true,
        status: "active" as const
      }
    }));
    const applyProductionOcrReview = vi.fn(async (
      request: Parameters<NonNullable<NonNullable<typeof window.projectApi>["applyProductionOcrReview"]>>[0]
    ) => {
      const mergedProject = applyProductionOcrReviewForTest(openedProject, request);
      return {
        projectSessionId: "opened-session",
        project: {
          revision: 2,
          project: mergedProject,
          pendingPageImages: [] as [],
          dirty: true,
          status: "active" as const
        }
      };
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: {
          revision: 0,
          project: initialProject,
          pendingPageImages: [] as [],
          dirty: false,
          status: "active" as const
        },
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: {
          revision: 1,
          project: openedProject,
          pendingPageImages: [] as [],
          dirty: false,
          status: "active" as const
        },
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      applyProductionOcrReview,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      extractSpeechBubbles: vi.fn().mockResolvedValue(extraction),
      validateSpeechBubbles: vi.fn().mockResolvedValue(extraction),
      resolvePageImageSrc: vi.fn().mockResolvedValue("Book-assets/images/page-001.jpg")
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await screen.findByRole("region", { name: "1페이지 말풍선 OCR 검토" });
    await selectWorkspaceEditingTool("글자 배치");
    expect(await screen.findByTestId("typesetting-box-editor")).toHaveStyle({ left: "20%", top: "20%" });
    await selectWorkspaceEditingTool("원문");
    fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));

    await waitFor(() => expect(applyProductionOcrReview).toHaveBeenCalledOnce());
    expect(applyProductionOcrReview.mock.calls[0]?.[0].candidates[0]).toMatchObject({
      text: "新しい",
      typesetting: {
        bbox: calculateTypesettingSafeArea(bubble.bbox),
        writingMode: "horizontal-tb"
      }
    });
  });

  it("clears page-scoped OCR review when an issue selection changes pages", async () => {
    const lines = [
      { ...rendererLine("issue-page-1", 1, "첫 페이지 문제", 1), lineStatus: "review" as const },
      { ...rendererLine("issue-page-2", 2, "둘째 페이지 문제", 2), lineStatus: "review" as const }
    ];
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })], lines)
      ),
      saveProject: vi.fn(),
      extractSpeechBubbles: vi.fn().mockResolvedValue(validatedReviewExtraction()),
      validateSpeechBubbles: vi.fn().mockResolvedValue(validatedReviewExtraction())
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    expect(await screen.findByLabelText("1페이지 말풍선 OCR 검토")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    fireEvent.click(within(bottomPanel).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 2 선택" }));

    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(screen.queryByLabelText("2페이지 말풍선 OCR 검토")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OCR 적용 · 화자 확인" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "오른쪽 작업 패널" })).getByLabelText("원문 2")).toHaveValue(
      "둘째 페이지 문제"
    );
  });

  it("clears page-scoped OCR review when keyboard line movement changes pages", async () => {
    const lines = [rendererLine("keyboard-page-1", 1, "첫 페이지", 1), rendererLine("keyboard-page-2", 2, "둘째 페이지", 2)];
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })], lines)
      ),
      saveProject: vi.fn(),
      extractSpeechBubbles: vi.fn().mockResolvedValue(emptyOcrExtraction()),
      validateSpeechBubbles: vi.fn().mockResolvedValue(validatedReviewExtraction())
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    expect(await screen.findByLabelText("1페이지 말풍선 OCR 검토")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }));
    });

    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(screen.queryByLabelText("2페이지 말풍선 OCR 검토")).not.toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "오른쪽 작업 패널" })).getByLabelText("원문 2")).toHaveValue(
      "둘째 페이지"
    );
  });

  it("clears an OCR error whenever the page changes", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })])
      ),
      saveProject: vi.fn(),
      extractSpeechBubbles: vi.fn().mockRejectedValue(new Error("첫 페이지 OCR 실패")),
      validateSpeechBubbles: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("첫 페이지 OCR 실패");

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));

    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OCR 다시 실행" })).not.toBeInTheDocument();
  });

  it("keeps file actions on Project Home until a Workspace is installed", () => {
    renderApp();

    expect(screen.queryByRole("banner", { name: "앱 상단 바" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 번역 프로젝트" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "기존 프로젝트 열기" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "저장" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "TXT 내보내기" })).not.toBeInTheDocument();
  });

  it("announces save feedback while the project drawer remains collapsed", async () => {
    const saveProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "status-feedback.txt",
        lines: [rendererLine("status-feedback-line", 1, "Status feedback")]
      }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage()], [rendererLine("export-line", 1, "내보낼 대사")])
      ),
      saveProject
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1));
    expect(screen.getAllByRole("status", { name: "작업 상태" })).toHaveLength(1);
    expect(screen.getAllByRole("status", { name: "작업대 현황" })).toHaveLength(1);
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 저장했습니다.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("preserves local editing and stops save when a narrow mutation hits a revision conflict", async () => {
    const initialProject = createEmptyProject("새 프로젝트", false);
    const openedProject = createEmptyProject("Session project", false);
    openedProject.dialogueLines = [{
      ...rendererLine("session-line", 1, "Main baseline"),
      origin: { kind: "manual" }
    }];
    const latestProject = structuredClone(openedProject);
    latestProject.dialogueLines[0]!.sourceText = "Main latest";
    const dto = (project: typeof openedProject, revision: number, dirty: boolean) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const applyProjectMutation = vi.fn().mockResolvedValue({
      status: "revision_conflict",
      code: "REVISION_CONFLICT",
      revision: 4,
      project: dto(latestProject, 4, true),
      conflictingPaths: ["dialogueLines/session-line/sourceText"]
    });
    const saveProject = vi.fn();
    const closeProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(initialProject, 0, false),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, 3, false),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject,
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject,
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    const sourceInput = await screen.findByLabelText("원문 1");
    fireEvent.change(sourceInput, { target: { value: "Local edit" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledWith({
      projectSessionId: "opened-session",
      baseRevision: 3,
      mutation: {
        type: "update_dialogue_line",
        lineId: "session-line",
        patch: { sourceText: "Local edit" }
      }
    }));
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(
      "다른 변경과 충돌했습니다: dialogueLines/session-line/sourceText"
    ));
    expect(screen.getByLabelText("원문 1")).toHaveValue("Local edit");
    expect(screen.queryByDisplayValue("Main latest")).not.toBeInTheDocument();
    expect(saveProject).not.toHaveBeenCalled();
    expect(closeProject).toHaveBeenCalledWith({ projectSessionId: "initial-session" });
  });

  it("does not let a delayed initial session replace a project opened first", async () => {
    const pendingInitial = deferred<{
      projectSessionId: string;
      project: {
        revision: number;
        project: ReturnType<typeof normalizeProject>;
        pendingPageImages: [];
        dirty: boolean;
        status: "active";
      };
      encrypted: boolean;
    }>();
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Opened", false));
    openedProject.dialogueLines = [{
      ...rendererLine("opened-line", 1, "Opened line"),
      origin: { kind: "manual" }
    }];
    const closeProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      createProjectSession: vi.fn().mockReturnValue(pendingInitial.promise),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: {
          revision: 1,
          project: openedProject,
          pendingPageImages: [] as [],
          dirty: false,
          status: "active"
        },
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation: vi.fn(),
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject,
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("Opened line")).toBeVisible();

    await act(async () => {
      pendingInitial.resolve({
        projectSessionId: "initial-session",
        project: {
          revision: 0,
          project: initialProject,
          pendingPageImages: [],
          dirty: false,
          status: "active"
        },
        encrypted: false
      });
      await pendingInitial.promise;
    });

    expect(screen.getByDisplayValue("Opened line")).toBeVisible();
    expect(closeProject).toHaveBeenCalledWith({ projectSessionId: "initial-session" });
    expect(closeProject).not.toHaveBeenCalledWith({ projectSessionId: "opened-session" });
  });

  it("rolls back a newly opened session when closing the current session fails", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Opened", false));
    openedProject.dialogueLines = [{
      ...rendererLine("opened-line", 1, "Opened line"),
      origin: { kind: "manual" }
    }];
    const dto = (project: typeof initialProject, revision = 0) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty: false,
      status: "active" as const
    });
    const closeProject = vi.fn(({ projectSessionId }: { projectSessionId: string }) => {
      if (projectSessionId === "initial-session") return Promise.reject(new Error("current close failed"));
      return Promise.resolve();
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(initialProject),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, 1),
        encrypted: false
      }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation: vi.fn(),
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject,
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(window.projectApi!.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(
      "기존 프로젝트를 닫지 못해 전환을 취소했습니다. 다시 시도하세요."
    ));
    expect(closeProject).toHaveBeenCalledWith({ projectSessionId: "initial-session" });
    expect(closeProject).toHaveBeenCalledWith({ projectSessionId: "opened-session" });
    expect(screen.queryByDisplayValue("Opened line")).not.toBeInTheDocument();
  });

  it("quarantines a failed switch rollback and cleans it before the next open", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Opened", false));
    openedProject.dialogueLines = [{
      ...rendererLine("opened-line", 1, "Recovered switch"),
      origin: { kind: "manual" }
    }];
    const dto = (project: typeof initialProject, revision = 0) => ({
      revision, project, pendingPageImages: [] as [], dirty: false, status: "active" as const
    });
    const openProjectFromDialog = vi.fn()
      .mockResolvedValueOnce({ projectSessionId: "orphan-session", project: dto(openedProject, 1), encrypted: false })
      .mockResolvedValueOnce({ projectSessionId: "opened-session", project: dto(openedProject, 1), encrypted: false });
    const closeAttempts = new Map<string, number>();
    const closeProject = vi.fn(({ projectSessionId }: { projectSessionId: string }) => {
      const attempt = (closeAttempts.get(projectSessionId) ?? 0) + 1;
      closeAttempts.set(projectSessionId, attempt);
      if (projectSessionId === "initial-session" && attempt === 1) {
        return Promise.reject(new Error("current close failed"));
      }
      if (projectSessionId === "orphan-session" && attempt === 1) {
        return Promise.reject(new Error("rollback close failed"));
      }
      return Promise.resolve();
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session", project: dto(initialProject), encrypted: false
      }),
      openProjectFromDialog,
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation: vi.fn(),
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject,
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(window.projectApi!.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("새 세션 정리도 완료하지 못했습니다"));

    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("Recovered switch")).toBeVisible();
    expect(closeProject.mock.calls.map(([args]) => args.projectSessionId)).toEqual([
      "initial-session",
      "orphan-session",
      "orphan-session",
      "initial-session"
    ]);
    expect(openProjectFromDialog).toHaveBeenCalledTimes(2);
  });

  it("waits for a saved session to close before entering Setup from New Project", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Opened", false));
    openedProject.dialogueLines = [{
      ...rendererLine("opened-line", 1, "Saved workspace line"),
      origin: { kind: "manual" }
    }];
    const dto = (project: typeof initialProject, revision = 0) => ({
      revision, project, pendingPageImages: [] as [], dirty: false, status: "active" as const
    });
    const pendingClose = deferred<void>();
    const closeProject = vi.fn(({ projectSessionId }: { projectSessionId: string }) => {
      if (projectSessionId === "opened-session") return pendingClose.promise;
      return Promise.resolve();
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session", project: dto(initialProject), encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session", project: dto(openedProject, 1), encrypted: false
      }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation: vi.fn(),
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject,
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(window.projectApi!.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("Saved workspace line")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    await waitFor(() => expect(closeProject).toHaveBeenCalledWith({ projectSessionId: "opened-session" }));
    expect(closeProject.mock.calls.filter(([args]) => args.projectSessionId === "opened-session")).toHaveLength(1);
    expect(screen.getByDisplayValue("Saved workspace line")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "새 번역 프로젝트" })).not.toBeInTheDocument();

    await act(async () => {
      pendingClose.resolve();
      await pendingClose.promise;
    });
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeVisible();
    expect(screen.queryByDisplayValue("Saved workspace line")).not.toBeInTheDocument();
    expect(closeProject.mock.calls.filter(([args]) => args.projectSessionId === "opened-session")).toHaveLength(1);
  });

  it("keeps the saved session and stays on the workspace when New Project close rejects", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Opened", false));
    openedProject.dialogueLines = [{
      ...rendererLine("opened-line", 1, "Keep this session"),
      origin: { kind: "manual" }
    }];
    const dto = (project: typeof initialProject, revision = 0) => ({
      revision, project, pendingPageImages: [] as [], dirty: false, status: "active" as const
    });
    const closeAttempts = new Map<string, number>();
    const closeProject = vi.fn(({ projectSessionId }: { projectSessionId: string }) => {
      const attempt = (closeAttempts.get(projectSessionId) ?? 0) + 1;
      closeAttempts.set(projectSessionId, attempt);
      if (projectSessionId === "opened-session" && attempt === 1) {
        return Promise.reject(new Error("saved close failed"));
      }
      return Promise.resolve();
    });
    const saveProject = vi.fn().mockResolvedValue({
      projectSessionId: "opened-session",
      project: dto(openedProject, 2)
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session", project: dto(initialProject), encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session", project: dto(openedProject, 1), encrypted: false
      }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation: vi.fn(),
      saveProject, saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject,
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(window.projectApi!.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("Keep this session")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(
      "이전 프로젝트를 닫지 못해 새 프로젝트로 전환하지 못했습니다."
    ));
    expect(screen.getByDisplayValue("Keep this session")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "새 번역 프로젝트" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새로 만들기" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(saveProject).toHaveBeenCalledWith({ projectSessionId: "opened-session" }));

    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeVisible();
    expect(closeProject.mock.calls.filter(([args]) => args.projectSessionId === "opened-session")).toHaveLength(2);
    expect(screen.queryByDisplayValue("Keep this session")).not.toBeInTheDocument();
  });

  it("preserves the unsaved startup session when Home starts a new image project", async () => {
    const harness = installSessionSetupApi();

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeVisible();
    expect(window.projectApi.closeProject).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    expect(await screen.findByRole("img", { name: "page-001.jpg" })).toBeVisible();
    expect(harness.choosePageImages).toHaveBeenCalledWith({ projectSessionId: "session-1" });
  });

  it("sends a narrow mutation immediately when a session-backed line is edited", async () => {
    const initialProject = createEmptyProject("Initial", false);
    const openedProject = createEmptyProject("Opened", false);
    openedProject.dialogueLines = [{
      ...rendererLine("session-line", 1, "Before"),
      origin: { kind: "manual" }
    }];
    const editedProject = structuredClone(openedProject);
    editedProject.dialogueLines[0]!.sourceText = "After";
    const dto = (project: typeof openedProject, revision: number, dirty: boolean) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const applyProjectMutation = vi.fn().mockResolvedValue({
      status: "applied",
      revision: 2,
      project: dto(editedProject, 2, true)
    });
    const saveProject = vi.fn();
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(initialProject, 0, false),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, 1, false),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject,
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    fireEvent.change(await screen.findByLabelText("원문 1"), { target: { value: "After" } });

    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledWith({
      projectSessionId: "opened-session",
      baseRevision: 1,
      mutation: {
        type: "update_dialogue_line",
        lineId: "session-line",
        patch: { sourceText: "After" }
      }
    }));
    expect(saveProject).not.toHaveBeenCalled();
  });

  it("keeps a local edit after a transient mutation IPC failure and retries it on Save", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Opened", false));
    openedProject.dialogueLines = [{
      ...rendererLine("session-line", 1, "Before"),
      origin: { kind: "manual" }
    }];
    const editedProject = structuredClone(openedProject);
    editedProject.dialogueLines[0]!.sourceText = "After";
    const dto = (project: typeof openedProject, revision: number, dirty: boolean) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const applyProjectMutation = vi.fn()
      .mockRejectedValueOnce(new Error("temporary mutation failure"))
      .mockResolvedValueOnce({
        status: "applied",
        revision: 2,
        project: dto(editedProject, 2, true)
      });
    const saveProject = vi.fn().mockResolvedValue({
      projectSessionId: "opened-session",
      project: dto(editedProject, 2, false)
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(initialProject, 0, false),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, 1, false),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject,
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    const sourceInput = await screen.findByLabelText("원문 1");
    fireEvent.change(sourceInput, { target: { value: "After" } });

    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("temporary mutation failure"));
    expect(screen.getByDisplayValue("After")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(saveProject).toHaveBeenCalledOnce());
    expect(screen.getByDisplayValue("After")).toBeVisible();
  });

  it("coalesces double-clicked session saves into one Main save operation", async () => {
    const initialProject = createEmptyProject("Initial", false);
    const openedProject = createEmptyProject("Opened", false);
    openedProject.dialogueLines = [{
      ...rendererLine("session-line", 1, "Line"),
      origin: { kind: "manual" }
    }];
    const dto = {
      revision: 1,
      project: openedProject,
      pendingPageImages: [] as [],
      dirty: false,
      status: "active" as const
    };
    let finishSave!: (value: { projectSessionId: string; project: typeof dto }) => void;
    const saveProject = vi.fn().mockReturnValue(new Promise((resolve) => {
      finishSave = resolve;
    }));
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: { ...dto, revision: 0, project: initialProject },
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto,
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation: vi.fn(),
      saveProject,
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
    const saveButton = screen.getByRole("button", { name: "저장" });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1));
    finishSave({ projectSessionId: "opened-session", project: dto });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 저장했습니다."));
  });

  it("recreates an unsaved session with secret protection before saving", async () => {
    const plainProject = normalizeProject(createEmptyProject("Initial", false));
    const secretProject = normalizeProject(createEmptyProject("Initial", true));
    const secretSessionResult = {
      projectSessionId: "secret-session",
      project: {
        revision: 0,
        project: secretProject,
        pendingPageImages: [] as [],
        dirty: false,
        status: "active" as const
      },
      encrypted: true
    };
    const pendingSecretSession = deferred<typeof secretSessionResult>();
    const createProjectSession = vi.fn()
      .mockResolvedValueOnce({
        projectSessionId: "plain-session",
        project: {
          revision: 0,
          project: plainProject,
          pendingPageImages: [] as [],
          dirty: false,
          status: "active"
        },
        encrypted: false
      })
      .mockReturnValueOnce(pendingSecretSession.promise);
    const sessionProjects = new Map([
      ["plain-session", structuredClone(plainProject)],
      ["secret-session", structuredClone(secretProject)]
    ]);
    const sessionRevisions = new Map([["plain-session", 0], ["secret-session", 0]]);
    const applyProjectMutation = vi.fn(async (args: ApplyProjectMutationArgs) => {
      const project = sessionProjects.get(args.projectSessionId)!;
      if (args.mutation.type === "add_dialogue_line") {
        project.dialogueLines = [{
          ...rendererLine(`${args.projectSessionId}-line`, 1, args.mutation.input!.sourceText),
          origin: { kind: "manual" }
        }];
      } else if (args.mutation.type === "update_dialogue_line") {
        const mutation = args.mutation;
        const line = project.dialogueLines.find(
          (candidate) => candidate.id === mutation.lineId
        );
        if (line) Object.assign(line, mutation.patch);
      }
      const revision = (sessionRevisions.get(args.projectSessionId) ?? 0) + 1;
      sessionRevisions.set(args.projectSessionId, revision);
      return {
        status: "applied" as const,
        revision,
        project: {
          revision,
          project: structuredClone(project),
          pendingPageImages: [] as [],
          dirty: true,
          status: "active" as const
        }
      };
    });
    const closeProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      createProjectSession,
      openProjectFromDialog: vi.fn(),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject,
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "secret-source.txt",
        lines: [rendererLine("renderer-line", 1, "Secret line")]
      }),
      exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(createProjectSession).toHaveBeenCalledTimes(1));
    await clickTxtStart();
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("대사 1개를 불러왔습니다."));
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(2));
    openFullDialogueTable();
    await openWorkspacePanel("수정");
    const sourceInput = screen.getByLabelText("원문 1");
    openSettings();
    fireEvent.click(screen.getByLabelText("시크릿 프로젝트"));
    await answerAppPrompt("session password");

    await waitFor(() => expect(createProjectSession).toHaveBeenNthCalledWith(2, {
      title: "Initial",
      secret: true,
      password: "session password"
    }));
    fireEvent.change(sourceInput, {
      target: { value: "Edited during secret transition" }
    });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(3));
    await act(async () => {
      pendingSecretSession.resolve(secretSessionResult);
      await pendingSecretSession.promise;
    });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSessionId: "secret-session",
        mutation: expect.objectContaining({
          type: "add_dialogue_line",
          input: expect.objectContaining({
            sourceText: "Edited during secret transition"
          })
        })
      })
    ));
    await waitFor(() => expect(closeProject).toHaveBeenCalledWith({
      projectSessionId: "plain-session"
    }));
    expect(screen.getByLabelText("시크릿 프로젝트")).toBeChecked();
  });

  it("does not create or install a secret session for project B after a stale toggle drain from project A", async () => {
    const projectA = normalizeProject(createEmptyProject("Project A", false));
    const projectB = normalizeProject(createEmptyProject("Project B", false));
    projectB.dialogueLines = [{
      ...rendererLine("b-line", 1, "B line"),
      origin: { kind: "manual" }
    }];
    const dto = (project: TranslationProjectV2, revision: number, dirty = false) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const pendingDrainMutation = deferred<{
      status: "applied";
      revision: number;
      project: ReturnType<typeof dto>;
    }>();
    let holdMutation = false;
    const sessionProject = structuredClone(projectA);
    const createProjectSession = vi.fn().mockResolvedValue({
      projectSessionId: "session-a",
      project: dto(projectA, 0),
      encrypted: false
    });
    const applyProjectMutation = vi.fn(async (args: ApplyProjectMutationArgs) => {
      if (holdMutation) return pendingDrainMutation.promise;
      if (args.mutation.type === "add_dialogue_line") {
        sessionProject.dialogueLines = [{
          ...rendererLine("a-line", 1, args.mutation.input.sourceText),
          origin: { kind: "manual" }
        }];
      } else if (args.mutation.type === "update_dialogue_line") {
        const mutation = args.mutation;
        const line = sessionProject.dialogueLines.find((candidate) => candidate.id === mutation.lineId);
        if (line) Object.assign(line, mutation.patch);
      }
      return {
        status: "applied" as const,
        revision: 1,
        project: dto(structuredClone(sessionProject), 1, true)
      };
    });
    const closeProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      createProjectSession,
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "session-b",
        project: dto(projectB, 3),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject,
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "project-a.txt",
        lines: [rendererLine("a-line", 1, "A line")]
      }),
      exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(createProjectSession).toHaveBeenCalledTimes(1));
    await clickTxtStart();
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("대사 1개를 불러왔습니다."));
    openFullDialogueTable();
    await openWorkspacePanel("수정");
    expect(screen.getByDisplayValue("A line")).toBeVisible();
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalled());
    const mutationCountBeforeEdit = applyProjectMutation.mock.calls.length;
    holdMutation = true;
    fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "A line edited" } });
    await waitFor(() => expect(applyProjectMutation.mock.calls.length).toBeGreaterThan(mutationCountBeforeEdit));
    openSettings();
    fireEvent.click(screen.getByLabelText("시크릿 프로젝트"));
    await answerAppPrompt("session password");
    await act(async () => {
      await Promise.resolve();
    });
    expect(createProjectSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await answerAppConfirmation("버리고 이동");
    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("B line")).toBeVisible();

    await act(async () => {
      pendingDrainMutation.resolve({
        status: "applied",
        revision: 2,
        project: dto(projectA, 2, true)
      });
      await pendingDrainMutation.promise;
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createProjectSession).toHaveBeenCalledTimes(1);
    expect(createProjectSession).not.toHaveBeenCalledWith(expect.objectContaining({ secret: true }));
    expect(screen.getByDisplayValue("B line")).toBeVisible();
    expect(screen.getByLabelText("시크릿 프로젝트")).not.toBeChecked();
    expect(screen.queryByRole("status", { name: "작업 상태" })).not.toHaveTextContent("프로젝트 보호 모드를 바꾸지 못했습니다.");
  });

  it("closes a secret session created for A when the project switches to B before install", async () => {
    const projectA = normalizeProject(createEmptyProject("Project A", false));
    const projectB = normalizeProject(createEmptyProject("Project B", false));
    projectB.dialogueLines = [{
      ...rendererLine("b-line", 1, "B line"),
      origin: { kind: "manual" }
    }];
    const dto = (project: TranslationProjectV2, revision: number) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty: false,
      status: "active" as const
    });
    const secretSessionResult = {
      projectSessionId: "secret-session-a",
      project: dto(normalizeProject(createEmptyProject("Project A", true)), 0),
      encrypted: true
    };
    const pendingSecretSession = deferred<typeof secretSessionResult>();
    const createProjectSession = vi.fn()
      .mockResolvedValueOnce({
        projectSessionId: "session-a",
        project: dto(projectA, 0),
        encrypted: false
      })
      .mockReturnValueOnce(pendingSecretSession.promise);
    const closeProject = vi.fn().mockResolvedValue(undefined);
    const sessionProject = structuredClone(projectA);
    window.projectApi = {
      createProjectSession,
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "session-b",
        project: dto(projectB, 4),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation: vi.fn(async (args: ApplyProjectMutationArgs) => {
        if (args.mutation.type === "add_dialogue_line") {
          sessionProject.dialogueLines = [{
            ...rendererLine("a-line", 1, args.mutation.input.sourceText),
            origin: { kind: "manual" as const }
          }];
        }
        return {
          status: "applied" as const,
          revision: 1,
          project: dto(structuredClone(sessionProject), 1)
        };
      }),
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject,
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "project-a.txt",
        lines: [rendererLine("a-line", 1, "A line")]
      }),
      exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(createProjectSession).toHaveBeenCalledTimes(1));
    await clickTxtStart();
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("대사 1개를 불러왔습니다."));
    openFullDialogueTable();
    await openWorkspacePanel("수정");
    expect(screen.getByDisplayValue("A line")).toBeVisible();
    openSettings();
    fireEvent.click(screen.getByLabelText("시크릿 프로젝트"));
    await answerAppPrompt("session password");
    await waitFor(() => expect(createProjectSession).toHaveBeenCalledTimes(2));
    expect(createProjectSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      secret: true,
      password: "session password"
    }));

    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("B line")).toBeVisible();
    expect(screen.getByLabelText("시크릿 프로젝트")).not.toBeChecked();

    await act(async () => {
      pendingSecretSession.resolve(secretSessionResult);
      await pendingSecretSession.promise;
    });
    await waitFor(() => expect(closeProject).toHaveBeenCalledWith({
      projectSessionId: "secret-session-a"
    }));
    expect(screen.getByDisplayValue("B line")).toBeVisible();
    expect(screen.getByLabelText("시크릿 프로젝트")).not.toBeChecked();
    expect(screen.queryByRole("status", { name: "작업 상태" })).not.toHaveTextContent("프로젝트 보호 모드를 바꾸지 못했습니다.");
  });

  it("treats a same session id with a new generation as a stale secret toggle", async () => {
    const projectA = normalizeProject(createEmptyProject("Project A", false));
    const conflictProject = structuredClone(projectA);
    conflictProject.dialogueLines = [{
      ...rendererLine("a-line", 1, "Main latest"),
      origin: { kind: "manual" }
    }];
    const dto = (project: TranslationProjectV2, revision: number, dirty = false) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const pendingDrainMutation = deferred<{
      status: "revision_conflict";
      code: "REVISION_CONFLICT";
      revision: number;
      project: ReturnType<typeof dto>;
      conflictingPaths: string[];
    }>();
    let holdMutation = false;
    const createProjectSession = vi.fn().mockResolvedValue({
      projectSessionId: "session-a",
      project: dto(projectA, 0),
      encrypted: false
    });
    const sessionProject = structuredClone(projectA);
    const applyProjectMutation = vi.fn(async (args: ApplyProjectMutationArgs) => {
      if (holdMutation) return pendingDrainMutation.promise;
      if (args.mutation.type === "add_dialogue_line") {
        sessionProject.dialogueLines = [{
          ...rendererLine("a-line", 1, args.mutation.input.sourceText),
          origin: { kind: "manual" }
        }];
      } else if (args.mutation.type === "update_dialogue_line") {
        const mutation = args.mutation;
        const line = sessionProject.dialogueLines.find((candidate) => candidate.id === mutation.lineId);
        if (line) Object.assign(line, mutation.patch);
      }
      return {
        status: "applied" as const,
        revision: 1,
        project: dto(structuredClone(sessionProject), 1, true)
      };
    });
    window.projectApi = {
      createProjectSession,
      openProjectFromDialog: vi.fn(),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "project-a.txt",
        lines: [rendererLine("a-line", 1, "A line")]
      }),
      exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(createProjectSession).toHaveBeenCalledTimes(1));
    await clickTxtStart();
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("대사 1개를 불러왔습니다."));
    openFullDialogueTable();
    await openWorkspacePanel("수정");
    expect(screen.getByDisplayValue("A line")).toBeVisible();
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalled());
    const mutationCountBeforeEdit = applyProjectMutation.mock.calls.length;
    holdMutation = true;
    fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "A line edited" } });
    await waitFor(() => expect(applyProjectMutation.mock.calls.length).toBeGreaterThan(mutationCountBeforeEdit));
    openSettings();
    fireEvent.click(screen.getByLabelText("시크릿 프로젝트"));
    await answerAppPrompt("session password");
    await act(async () => {
      await Promise.resolve();
    });
    expect(createProjectSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingDrainMutation.resolve({
        status: "revision_conflict",
        code: "REVISION_CONFLICT",
        revision: 4,
        project: dto(conflictProject, 4, true),
        conflictingPaths: ["dialogueLines/a-line/sourceText"]
      });
      await pendingDrainMutation.promise;
    });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(
      "다른 변경과 충돌했습니다: dialogueLines/a-line/sourceText"
    ));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createProjectSession).toHaveBeenCalledTimes(1);
    expect(createProjectSession).not.toHaveBeenCalledWith(expect.objectContaining({ secret: true }));
    expect(screen.getByDisplayValue("A line edited")).toBeVisible();
    expect(screen.queryByDisplayValue("Main latest")).not.toBeInTheDocument();
    expect(screen.getByLabelText("시크릿 프로젝트")).not.toBeChecked();
  });

  it("does not let a failed stale secret toggle overwrite project B status", async () => {
    const projectA = normalizeProject(createEmptyProject("Project A", false));
    const projectB = normalizeProject(createEmptyProject("Project B", false));
    projectB.dialogueLines = [{
      ...rendererLine("b-line", 1, "B line"),
      origin: { kind: "manual" }
    }];
    const dto = (project: TranslationProjectV2, revision: number) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty: false,
      status: "active" as const
    });
    const pendingSecretSession = deferred<never>();
    const sessionProject = structuredClone(projectA);
    const createProjectSession = vi.fn()
      .mockResolvedValueOnce({
        projectSessionId: "session-a",
        project: dto(projectA, 0),
        encrypted: false
      })
      .mockReturnValueOnce(pendingSecretSession.promise);
    window.projectApi = {
      createProjectSession,
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "session-b",
        project: dto(projectB, 2),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation: vi.fn(async (args: ApplyProjectMutationArgs) => {
        if (args.mutation.type === "add_dialogue_line") {
          sessionProject.dialogueLines = [{
            ...rendererLine("a-line", 1, args.mutation.input.sourceText),
            origin: { kind: "manual" as const }
          }];
        }
        return {
          status: "applied" as const,
          revision: 1,
          project: dto(structuredClone(sessionProject), 1)
        };
      }),
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "project-a.txt",
        lines: [rendererLine("a-line", 1, "A line")]
      }),
      exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(createProjectSession).toHaveBeenCalledTimes(1));
    await clickTxtStart();
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("대사 1개를 불러왔습니다."));
    openFullDialogueTable();
    await openWorkspacePanel("수정");
    expect(screen.getByDisplayValue("A line")).toBeVisible();
    openSettings();
    fireEvent.click(screen.getByLabelText("시크릿 프로젝트"));
    await answerAppPrompt("session password");
    await waitFor(() => expect(createProjectSession).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("B line")).toBeVisible();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 열었습니다.");

    await act(async () => {
      pendingSecretSession.reject(new Error("secret session failed"));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByDisplayValue("B line")).toBeVisible();
    expect(screen.getByLabelText("시크릿 프로젝트")).not.toBeChecked();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 열었습니다.");
    expect(screen.queryByRole("status", { name: "작업 상태" })).not.toHaveTextContent("프로젝트 보호 모드를 바꾸지 못했습니다.");
    expect(screen.queryByRole("status", { name: "작업 상태" })).not.toHaveTextContent("secret session failed");
  });

  it("announces export feedback while the project drawer remains collapsed", async () => {
    const exportTranslations = vi.fn().mockResolvedValue("C:\\projects\\Image Project.txt");
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations,
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage()], [rendererLine("export-line", 1, "내보낼 대사")])
      ),
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: "TXT 내보내기" }));

    await waitFor(() => expect(exportTranslations).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("번역문을 내보냈습니다.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("exports every project page sequentially while omitting pages blocked by render readiness", async () => {
    const firstPage = pageImage({
      id: "export-page-1",
      storedRelativePath: "Book-assets/images/page-001.jpg"
    });
    const secondPage = pageImage({
      id: "export-page-2",
      pageNumber: 2,
      storedRelativePath: "Book-assets/images/page-002.jpg",
      originalFileName: "scan_002.jpg"
    });
    const blockedPage = pageImage({
      id: "export-page-3",
      pageNumber: 3,
      storedRelativePath: "Book-assets/images/page-003.jpg",
      originalFileName: "scan_003.jpg"
    });
    const cleanQa = {
      qaStatus: "pass" as const,
      cleanlinessScore: 1,
      residualRegions: [],
      attemptCount: 1,
      maxRetryAttempts: 2,
      evaluatedAt: "2026-08-22T00:00:00.000Z"
    };
    const exportProject = normalizeProject({
      ...createEmptyProject("Export Project", false),
      pageImages: [firstPage, secondPage, blockedPage],
      dialogueLines: [
        {
          ...rendererLine("export-line-1", 1, "첫 페이지 원문"),
          userTranslation: "첫 페이지 번역",
          typesetting: { bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 }, writingMode: "horizontal-tb" },
          origin: { kind: "manual" as const }
        },
        {
          ...rendererLine("blocked-line-3", 1, "셋째 페이지 원문", 3),
          aiTranslation: "AI 초안",
          typesetting: { bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 }, writingMode: "horizontal-tb" },
          origin: { kind: "manual" as const }
        }
      ],
      processing: {
        pages: [{
          pageImageId: firstPage.id,
          approvedCleanedAssetId: "export-cleaned-1",
          latestCompletedRunId: "export-run-1",
          finalStatus: "auto_approved" as const,
          updatedAt: "2026-08-22T00:00:00.000Z",
          inpaintingQa: cleanQa
        }],
        runs: [{
          runId: "export-run-1",
          pageImageId: firstPage.id,
          source: "manual_openai" as const,
          status: "completed" as const,
          sourceSha256: firstPage.sha256,
          appVersion: "0.1.4",
          queuedAt: "2026-08-22T00:00:00.000Z",
          startedAt: "2026-08-22T00:00:00.000Z",
          completedAt: "2026-08-22T00:00:00.000Z"
        }],
        assets: [{
          assetId: "export-cleaned-1",
          source: "manual_openai" as const,
          sourcePageImageId: firstPage.id,
          runId: "export-run-1",
          role: "cleaned" as const,
          storedRelativePath: "Book-assets/images/page-001-cleaned.png",
          sha256: "c".repeat(64),
          byteSize: 4,
          mimeType: "image/png" as const,
          createdAt: "2026-08-22T00:00:00.000Z",
          inpaintingQa: cleanQa
        }]
      }
    });
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const sessionDto = (project: TranslationProjectV2, revision: number) => ({
      revision,
      project,
      pendingPageImages: [],
      dirty: false,
      status: "active" as const
    });
    const resolvePageImageSrc = vi.fn().mockImplementation(
      async ({ storedRelativePath }: { storedRelativePath: string }) => `resolved:${storedRelativePath}`
    );
    const exportProjectImages = vi.fn().mockResolvedValue({
      exportRoot: "C:\\exports\\Export Project",
      report: {
        status: "partial",
        failures: [{ code: "TYPESET_RENDER_NOT_PROVIDED" }]
      },
      manifest: {}
    });
    vi.mocked(burnTypesettingFromUrl).mockImplementation(
      async (imageSrc, lines) => new Blob([`${imageSrc}:${lines.map((line) => line.id).join(",")}`], { type: "image/png" })
    );
    const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add: vi.fn(), check: vi.fn(() => true) }
    });
    const originalFontFace = Object.getOwnPropertyDescriptor(globalThis, "FontFace");
    class TestFontFace {
      status = "unloaded";

      constructor(public readonly family: string, public readonly source: string) {}

      async load(): Promise<this> {
        this.status = "loaded";
        return this;
      }
    }
    Object.defineProperty(globalThis, "FontFace", {
      configurable: true,
      value: TestFontFace
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
      measureText: vi.fn(() => ({
        width: 24,
        actualBoundingBoxAscent: 12,
        actualBoundingBoxDescent: 4
      }))
    }) as unknown as CanvasRenderingContext2D);
    restoreDocumentFontsMock = () => {
      if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
      else Reflect.deleteProperty(document, "fonts");
    };
    restoreFontFaceMock = () => {
      if (originalFontFace) Object.defineProperty(globalThis, "FontFace", originalFontFace);
      else Reflect.deleteProperty(globalThis, "FontFace");
    };
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: sessionDto(initialProject, 0),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "export-session",
        project: sessionDto(exportProject, 7),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation: vi.fn(),
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      exportProjectImages,
      resolvePageImageSrc
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    const exportButton = screen.getByRole("button", { name: "전체 프로젝트 이미지 내보내기" });
    expect(exportButton).toHaveTextContent("이미지 내보내기");
    expect(exportButton.getAttribute("title")).toMatch(/전체 페이지/);
    expect(exportButton.getAttribute("title")).toMatch(/original/);
    expect(exportButton.getAttribute("title")).toMatch(/ZIP/);
    expect(exportButton.getAttribute("title")).not.toMatch(/현재 페이지/);
    fireEvent.click(exportButton);

    await waitFor(() => expect(exportProjectImages).toHaveBeenCalledOnce());
    const [exportArgs] = exportProjectImages.mock.calls[0] as [{
      projectSessionId: string;
      typesetPages: Array<{ pageImageId: string; readiness: { ready: boolean; lineIds: string[] }; pngBase64: string }>;
    }];
    expect(exportArgs.projectSessionId).toBe("export-session");
    expect(exportArgs.typesetPages.map((page) => page.pageImageId)).toEqual([firstPage.id, secondPage.id]);
    expect(exportArgs.typesetPages.map((page) => page.readiness.lineIds)).toEqual([
      ["export-line-1"],
      []
    ]);
    expect(exportArgs.typesetPages.every((page) => page.readiness.ready && page.pngBase64.length > 0)).toBe(true);
    expect(vi.mocked(burnTypesettingFromUrl).mock.calls.map(([imageSrc, lines]) => [imageSrc, lines.map((line) => line.id)])).toEqual([
      ["resolved:Book-assets/images/page-001-cleaned.png", ["export-line-1"]],
      ["resolved:Book-assets/images/page-002.jpg", []]
    ]);
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("이미지 내보내기 일부 완료: 1건 실패.");
  });

  it("still calls Main export after a ready page burn failure and keeps later page renders", async () => {
    const firstPage = pageImage({
      id: "burn-ok-page-1",
      storedRelativePath: "Book-assets/images/page-001.jpg"
    });
    const failedPage = pageImage({
      id: "burn-fail-page-2",
      pageNumber: 2,
      storedRelativePath: "Book-assets/images/page-002.jpg",
      originalFileName: "scan_002.jpg"
    });
    const laterPage = pageImage({
      id: "burn-ok-page-3",
      pageNumber: 3,
      storedRelativePath: "Book-assets/images/page-003.jpg",
      originalFileName: "scan_003.jpg"
    });
    const typesetting = { bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 }, writingMode: "horizontal-tb" as const };
    const exportProject = normalizeProject({
      ...createEmptyProject("Partial Burn Export", false),
      pageImages: [firstPage, failedPage, laterPage],
      dialogueLines: [
        {
          ...rendererLine("burn-line-1", 1, "첫 페이지 원문"),
          userTranslation: "첫 페이지 번역",
          typesetting,
          origin: { kind: "manual" as const }
        },
        {
          ...rendererLine("burn-line-2", 2, "둘째 페이지 원문", 2),
          userTranslation: "둘째 페이지 번역",
          typesetting,
          origin: { kind: "manual" as const }
        },
        {
          ...rendererLine("burn-line-3", 3, "셋째 페이지 원문", 3),
          userTranslation: "셋째 페이지 번역",
          typesetting,
          origin: { kind: "manual" as const }
        }
      ]
    });
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const sessionDto = (project: TranslationProjectV2, revision: number) => ({
      revision,
      project,
      pendingPageImages: [],
      dirty: false,
      status: "active" as const
    });
    const resolvePageImageSrc = vi.fn().mockImplementation(
      async ({ storedRelativePath }: { storedRelativePath: string }) => `resolved:${storedRelativePath}`
    );
    const exportProjectImages = vi.fn().mockImplementation(async (args: {
      typesetPages?: Array<{ pageImageId: string; pngBase64: string; readiness: { ready: boolean } }>;
    }) => {
      const providedIds = new Set((args.typesetPages ?? []).map((page) => page.pageImageId));
      const failures = [firstPage.id, failedPage.id, laterPage.id]
        .filter((pageImageId) => !providedIds.has(pageImageId))
        .map((pageImageId) => ({
          pageImageId,
          kind: "typeset" as const,
          code: "TYPESET_RENDER_NOT_PROVIDED"
        }));
      return {
        exportRoot: "C:\\exports\\Partial Burn Export",
        report: {
          status: failures.length === 0 ? "completed" as const : "partial" as const,
          failures
        },
        manifest: {}
      };
    });
    vi.mocked(burnTypesettingFromUrl).mockImplementation(async (imageSrc, lines) => {
      if (imageSrc === `resolved:${failedPage.storedRelativePath}`) {
        throw new Error("식자 내보내기용 이미지 로드에 실패했습니다.");
      }
      return new Blob([`${imageSrc}:${lines.map((line) => line.id).join(",")}`], { type: "image/png" });
    });
    const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add: vi.fn(), check: vi.fn(() => true) }
    });
    const originalFontFace = Object.getOwnPropertyDescriptor(globalThis, "FontFace");
    class TestFontFace {
      status = "unloaded";

      constructor(public readonly family: string, public readonly source: string) {}

      async load(): Promise<this> {
        this.status = "loaded";
        return this;
      }
    }
    Object.defineProperty(globalThis, "FontFace", {
      configurable: true,
      value: TestFontFace
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
      measureText: vi.fn(() => ({
        width: 24,
        actualBoundingBoxAscent: 12,
        actualBoundingBoxDescent: 4
      }))
    }) as unknown as CanvasRenderingContext2D);
    restoreDocumentFontsMock = () => {
      if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
      else Reflect.deleteProperty(document, "fonts");
    };
    restoreFontFaceMock = () => {
      if (originalFontFace) Object.defineProperty(globalThis, "FontFace", originalFontFace);
      else Reflect.deleteProperty(globalThis, "FontFace");
    };
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: sessionDto(initialProject, 0),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "partial-burn-session",
        project: sessionDto(exportProject, 4),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation: vi.fn(),
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      exportProjectImages,
      resolvePageImageSrc
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: "전체 프로젝트 이미지 내보내기" }));

    await waitFor(() => expect(exportProjectImages).toHaveBeenCalledOnce());
    const [exportArgs] = exportProjectImages.mock.calls[0] as [{
      projectSessionId: string;
      typesetPages: Array<{ pageImageId: string; readiness: { ready: boolean }; pngBase64: string }>;
    }];
    expect(exportArgs.projectSessionId).toBe("partial-burn-session");
    expect(exportArgs.typesetPages.map((page) => page.pageImageId)).toEqual([firstPage.id, laterPage.id]);
    expect(exportArgs.typesetPages.every((page) => page.readiness.ready && page.pngBase64.length > 0)).toBe(true);
    expect(exportArgs.typesetPages.some((page) => page.pageImageId === failedPage.id)).toBe(false);
    expect(vi.mocked(burnTypesettingFromUrl).mock.calls.map(([imageSrc, lines]) => [imageSrc, lines.map((line) => line.id)])).toEqual([
      [`resolved:${firstPage.storedRelativePath}`, ["burn-line-1"]],
      [`resolved:${failedPage.storedRelativePath}`, ["burn-line-2"]],
      [`resolved:${laterPage.storedRelativePath}`, ["burn-line-3"]]
    ]);
    const returnedReport = await exportProjectImages.mock.results[0]?.value as {
      report: { status: string; failures: Array<{ pageImageId: string; code: string }> };
    };
    expect(returnedReport.report.status).toBe("partial");
    expect(returnedReport.report.failures).toEqual([{
      pageImageId: failedPage.id,
      kind: "typeset",
      code: "TYPESET_RENDER_NOT_PROVIDED"
    }]);
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("이미지 내보내기 일부 완료: 1건 실패.");
    expect(screen.getByRole("status", { name: "작업 상태" })).not.toHaveTextContent("전체 3페이지");
  });

  it("preserves the Main original/cleaned export when the document font set accessor throws", async () => {
    resetProductionTypesetFontLoaderForTests();
    const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      get: () => {
        throw new Error("font set unavailable");
      }
    });
    class TestFontFace {
      status = "unloaded";

      constructor(public readonly family: string, public readonly source: string) {}

      async load(): Promise<this> {
        this.status = "loaded";
        return this;
      }
    }
    const originalFontFace = Object.getOwnPropertyDescriptor(globalThis, "FontFace");
    Object.defineProperty(globalThis, "FontFace", {
      configurable: true,
      value: TestFontFace
    });
    restoreDocumentFontsMock = () => {
      if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
      else Reflect.deleteProperty(document, "fonts");
    };
    restoreFontFaceMock = () => {
      if (originalFontFace) Object.defineProperty(globalThis, "FontFace", originalFontFace);
      else Reflect.deleteProperty(globalThis, "FontFace");
    };

    const exportedPage = pageImage({ id: "font-failure-page" });
    const exportedProject = normalizeProject({
      ...createEmptyProject("Font Failure Export", false),
      pageImages: [exportedPage],
      dialogueLines: [{
        ...rendererLine("font-failure-line", 1, "원문"),
        userTranslation: "번역",
        typesetting: {
          bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
          writingMode: "horizontal-tb"
        },
        origin: { kind: "manual" as const }
      }]
    });
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const sessionDto = (project: TranslationProjectV2, revision: number) => ({
      revision,
      project,
      pendingPageImages: [],
      dirty: false,
      status: "active" as const
    });
    const exportProjectImages = vi.fn().mockResolvedValue({
      exportRoot: "C:\\exports\\Font Failure Export",
      report: {
        status: "completed",
        failures: []
      },
      manifest: {}
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: sessionDto(initialProject, 0),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "font-failure-session",
        project: sessionDto(exportedProject, 1),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation: vi.fn(),
      saveProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      exportProjectImages
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: "전체 프로젝트 이미지 내보내기" }));

    await waitFor(() => expect(exportProjectImages).toHaveBeenCalledOnce());
    const [exportArgs] = exportProjectImages.mock.calls[0] as [{
      projectSessionId: string;
      typesetPages: unknown[];
    }];
    expect(exportArgs.projectSessionId).toBe("font-failure-session");
    expect(exportArgs.typesetPages).toEqual([]);
    expect(vi.mocked(burnTypesettingFromUrl)).not.toHaveBeenCalled();
  });

  describe("saved session export synchronization", () => {
    function sessionDto(project: TranslationProjectV2, revision: number, dirty = false) {
      return {
        revision,
        project,
        pendingPageImages: [] as [],
        dirty,
        status: "active" as const
      };
    }

    function applyUpdateDialogueMutation(
      project: TranslationProjectV2,
      mutation: ApplyProjectMutationArgs["mutation"]
    ): TranslationProjectV2 {
      if (mutation.type !== "update_dialogue_line") return project;
      return {
        ...project,
        dialogueLines: project.dialogueLines.map((line) =>
          line.id === mutation.lineId ? { ...line, ...mutation.patch } : line
        )
      };
    }

    function installTypesetFontMocks() {
      const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: { add: vi.fn(), check: vi.fn(() => true) }
      });
      const originalFontFace = Object.getOwnPropertyDescriptor(globalThis, "FontFace");
      class TestFontFace {
        status = "unloaded";

        constructor(public readonly family: string, public readonly source: string) {}

        async load(): Promise<this> {
          this.status = "loaded";
          return this;
        }
      }
      Object.defineProperty(globalThis, "FontFace", {
        configurable: true,
        value: TestFontFace
      });
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
        measureText: vi.fn(() => ({
          width: 24,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4
        }))
      }) as unknown as CanvasRenderingContext2D);
      restoreDocumentFontsMock = () => {
        if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
        else Reflect.deleteProperty(document, "fonts");
      };
      restoreFontFaceMock = () => {
        if (originalFontFace) Object.defineProperty(globalThis, "FontFace", originalFontFace);
        else Reflect.deleteProperty(globalThis, "FontFace");
      };
    }

    it("waits for a pending dialogue mutation before TXT export uses the saved session", async () => {
      const initialProject = normalizeProject(createEmptyProject("Initial", false));
      const openedProject = normalizeProject(createEmptyProject("Export Session", false));
      openedProject.dialogueLines = [{
        ...rendererLine("export-line", 1, "원문"),
        userTranslation: "이전 번역",
        origin: { kind: "manual" }
      }];
      let sessionProject = structuredClone(openedProject);
      let sessionRevision = 7;
      const pendingMutation = deferred<void>();
      const callOrder: string[] = [];
      const applyProjectMutation = vi.fn().mockImplementation(async (args: ApplyProjectMutationArgs) => {
        callOrder.push("mutation-start");
        await pendingMutation.promise;
        sessionProject = applyUpdateDialogueMutation(sessionProject, args.mutation);
        sessionRevision += 1;
        callOrder.push("mutation-done");
        return {
          status: "applied" as const,
          revision: sessionRevision,
          project: sessionDto(sessionProject, sessionRevision, true)
        };
      });
      const exportTranslations = vi.fn().mockImplementation(async () => {
        callOrder.push("export");
        return "C:\\projects\\Export Session.txt";
      });
      window.projectApi = {
        createProjectSession: vi.fn().mockResolvedValue({
          projectSessionId: "initial-session",
          project: sessionDto(initialProject, 0),
          encrypted: false
        }),
        openProjectFromDialog: vi.fn().mockResolvedValue({
          projectSessionId: "export-session",
          project: sessionDto(openedProject, 7),
          encrypted: false
        }),
        openRecentProject: vi.fn(),
        unlockProject: vi.fn(),
        applyProjectMutation,
        saveProject: vi.fn(),
        saveProjectAs: vi.fn(),
        rekeyProject: vi.fn(),
        closeProject: vi.fn().mockResolvedValue(undefined),
        listRecentProjects: vi.fn().mockResolvedValue([]),
        removeRecentProject: vi.fn(),
        importTxtFile: vi.fn(),
        exportTranslations
      };

      renderApp();
      await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
      await openWorkspacePanel("수정");
      fireEvent.change(await screen.findByLabelText("사용자 수정문 1"), { target: { value: "최신 번역" } });
      fireEvent.click(screen.getByRole("button", { name: "TXT 내보내기" }));

      await waitFor(() => expect(applyProjectMutation).toHaveBeenCalled());
      expect(exportTranslations).not.toHaveBeenCalled();
      expect(applyProjectMutation).toHaveBeenCalledWith(expect.objectContaining({
        projectSessionId: "export-session",
        mutation: expect.objectContaining({
          type: "update_dialogue_line",
          lineId: "export-line",
          patch: expect.objectContaining({ userTranslation: "최신 번역" })
        })
      }));

      await act(async () => {
        pendingMutation.resolve();
        await pendingMutation.promise;
      });

      await waitFor(() => expect(exportTranslations).toHaveBeenCalledTimes(1));
      expect(callOrder).toEqual(["mutation-start", "mutation-done", "export"]);
      expect(exportTranslations).toHaveBeenCalledWith(expect.objectContaining({
        projectSessionId: "export-session"
      }));
      expect(sessionProject.dialogueLines[0]?.userTranslation).toBe("최신 번역");
      expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("번역문을 내보냈습니다.");
    });

    it("does not run stale TXT export after a pending mutation hits a revision conflict", async () => {
      const initialProject = normalizeProject(createEmptyProject("Initial", false));
      const openedProject = normalizeProject(createEmptyProject("Conflict Export", false));
      openedProject.dialogueLines = [{
        ...rendererLine("conflict-line", 1, "원문"),
        userTranslation: "이전 번역",
        origin: { kind: "manual" }
      }];
      const latestProject = structuredClone(openedProject);
      latestProject.dialogueLines[0]!.userTranslation = "Main 최신";
      const pendingMutation = deferred<{
        status: "revision_conflict";
        code: string;
        revision: number;
        project: ReturnType<typeof sessionDto>;
        conflictingPaths: string[];
      }>();
      const applyProjectMutation = vi.fn().mockImplementation(() => pendingMutation.promise);
      const exportTranslations = vi.fn().mockResolvedValue("C:\\projects\\stale.txt");
      window.projectApi = {
        createProjectSession: vi.fn().mockResolvedValue({
          projectSessionId: "initial-session",
          project: sessionDto(initialProject, 0),
          encrypted: false
        }),
        openProjectFromDialog: vi.fn().mockResolvedValue({
          projectSessionId: "conflict-session",
          project: sessionDto(openedProject, 3),
          encrypted: false
        }),
        openRecentProject: vi.fn(),
        unlockProject: vi.fn(),
        applyProjectMutation,
        saveProject: vi.fn(),
        saveProjectAs: vi.fn(),
        rekeyProject: vi.fn(),
        closeProject: vi.fn().mockResolvedValue(undefined),
        listRecentProjects: vi.fn().mockResolvedValue([]),
        removeRecentProject: vi.fn(),
        importTxtFile: vi.fn(),
        exportTranslations
      };

      renderApp();
      await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
      await openWorkspacePanel("수정");
      fireEvent.change(await screen.findByLabelText("사용자 수정문 1"), { target: { value: "로컬 편집" } });
      fireEvent.click(screen.getByRole("button", { name: "TXT 내보내기" }));

      await waitFor(() => expect(applyProjectMutation).toHaveBeenCalled());
      expect(exportTranslations).not.toHaveBeenCalled();

      await act(async () => {
        pendingMutation.resolve({
          status: "revision_conflict",
          code: "REVISION_CONFLICT",
          revision: 4,
          project: sessionDto(latestProject, 4, true),
          conflictingPaths: ["dialogueLines/conflict-line/userTranslation"]
        });
        await pendingMutation.promise;
      });

      await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("다른 변경과 충돌했습니다"));
      expect(exportTranslations).not.toHaveBeenCalled();
      expect(screen.getByRole("status", { name: "작업 상태" })).not.toHaveTextContent("번역문을 내보냈습니다.");
    });

    it("does not run stale TXT export after a pending mutation fails", async () => {
      const initialProject = normalizeProject(createEmptyProject("Initial", false));
      const openedProject = normalizeProject(createEmptyProject("Failed Export", false));
      openedProject.dialogueLines = [{
        ...rendererLine("fail-line", 1, "원문"),
        userTranslation: "이전 번역",
        origin: { kind: "manual" }
      }];
      const pendingMutation = deferred<never>();
      const applyProjectMutation = vi.fn().mockImplementation(() => pendingMutation.promise);
      const exportTranslations = vi.fn().mockResolvedValue("C:\\projects\\stale.txt");
      window.projectApi = {
        createProjectSession: vi.fn().mockResolvedValue({
          projectSessionId: "initial-session",
          project: sessionDto(initialProject, 0),
          encrypted: false
        }),
        openProjectFromDialog: vi.fn().mockResolvedValue({
          projectSessionId: "fail-session",
          project: sessionDto(openedProject, 2),
          encrypted: false
        }),
        openRecentProject: vi.fn(),
        unlockProject: vi.fn(),
        applyProjectMutation,
        saveProject: vi.fn(),
        saveProjectAs: vi.fn(),
        rekeyProject: vi.fn(),
        closeProject: vi.fn().mockResolvedValue(undefined),
        listRecentProjects: vi.fn().mockResolvedValue([]),
        removeRecentProject: vi.fn(),
        importTxtFile: vi.fn(),
        exportTranslations
      };

      renderApp();
      await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
      await openWorkspacePanel("수정");
      fireEvent.change(await screen.findByLabelText("사용자 수정문 1"), { target: { value: "로컬 편집" } });
      fireEvent.click(screen.getByRole("button", { name: "TXT 내보내기" }));

      await waitFor(() => expect(applyProjectMutation).toHaveBeenCalled());
      expect(exportTranslations).not.toHaveBeenCalled();

      await act(async () => {
        pendingMutation.reject(new Error("mutation IPC failed"));
      });

      await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("mutation IPC failed"));
      expect(exportTranslations).not.toHaveBeenCalled();
      expect(screen.getByRole("status", { name: "작업 상태" })).not.toHaveTextContent("번역문을 내보냈습니다.");
    });

    it("does not apply a previous TXT export after switching sessions while mutations drain", async () => {
      const initialProject = normalizeProject(createEmptyProject("Initial", false));
      const firstProject = normalizeProject(createEmptyProject("First Export", false));
      firstProject.dialogueLines = [{
        ...rendererLine("first-line", 1, "첫 프로젝트 원문"),
        userTranslation: "첫 번역",
        origin: { kind: "manual" }
      }];
      const secondProject = normalizeProject(createEmptyProject("Second Export", false));
      secondProject.dialogueLines = [{
        ...rendererLine("second-line", 1, "둘째 프로젝트 원문"),
        userTranslation: "둘째 번역",
        origin: { kind: "manual" }
      }];
      const pendingMutation = deferred<void>();
      const applyProjectMutation = vi.fn().mockImplementation(async () => {
        await pendingMutation.promise;
        return {
          status: "applied" as const,
          revision: 8,
          project: sessionDto(firstProject, 8, true)
        };
      });
      const exportTranslations = vi.fn().mockResolvedValue("C:\\projects\\First Export.txt");
      window.projectApi = {
        createProjectSession: vi.fn().mockResolvedValue({
          projectSessionId: "initial-session",
          project: sessionDto(initialProject, 0),
          encrypted: false
        }),
        openProjectFromDialog: vi.fn()
          .mockResolvedValueOnce({
            projectSessionId: "first-session",
            project: sessionDto(firstProject, 7),
            encrypted: false
          })
          .mockResolvedValueOnce({
            projectSessionId: "second-session",
            project: sessionDto(secondProject, 1),
            encrypted: false
          }),
        openRecentProject: vi.fn(),
        unlockProject: vi.fn(),
        applyProjectMutation,
        saveProject: vi.fn(),
        saveProjectAs: vi.fn(),
        rekeyProject: vi.fn(),
        closeProject: vi.fn().mockResolvedValue(undefined),
        listRecentProjects: vi.fn().mockResolvedValue([]),
        removeRecentProject: vi.fn(),
        importTxtFile: vi.fn(),
        exportTranslations
      };

      renderApp();
      await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
      await openWorkspacePanel("수정");
      fireEvent.change(await screen.findByLabelText("사용자 수정문 1"), { target: { value: "첫 프로젝트 최신" } });
      fireEvent.click(screen.getByRole("button", { name: "TXT 내보내기" }));
      await waitFor(() => expect(applyProjectMutation).toHaveBeenCalled());
      expect(exportTranslations).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await answerAppConfirmation("버리고 이동");
      await openWorkspacePanel("수정");
      expect(await screen.findByDisplayValue("둘째 프로젝트 원문")).toBeVisible();

      await act(async () => {
        pendingMutation.resolve();
        await pendingMutation.promise;
      });

      await waitFor(() => expect(screen.getByDisplayValue("둘째 번역")).toBeVisible());
      expect(exportTranslations).not.toHaveBeenCalled();
      expect(screen.getByRole("status", { name: "작업 상태" })).not.toHaveTextContent("번역문을 내보냈습니다.");
    });

    it("builds completed image export readiness from the drained session revision", async () => {
      installTypesetFontMocks();
      const exportedPage = pageImage({ id: "sync-export-page" });
      const typesetting = { bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 }, writingMode: "horizontal-tb" as const };
      const initialProject = normalizeProject(createEmptyProject("Initial", false));
      const openedProject = normalizeProject({
        ...createEmptyProject("Image Sync Export", false),
        pageImages: [exportedPage],
        dialogueLines: [{
          ...rendererLine("sync-export-line", 1, "원문"),
          userTranslation: "이전 번역",
          typesetting,
          origin: { kind: "manual" as const }
        }]
      });
      let sessionProject = structuredClone(openedProject);
      let sessionRevision = 5;
      const pendingMutation = deferred<void>();
      const applyProjectMutation = vi.fn().mockImplementation(async (args: ApplyProjectMutationArgs) => {
        await pendingMutation.promise;
        sessionProject = applyUpdateDialogueMutation(sessionProject, args.mutation);
        sessionRevision += 1;
        return {
          status: "applied" as const,
          revision: sessionRevision,
          project: sessionDto(sessionProject, sessionRevision, true)
        };
      });
      const exportProjectImages = vi.fn().mockResolvedValue({
        exportRoot: "C:\\exports\\Image Sync Export",
        report: { status: "completed", failures: [] },
        manifest: {}
      });
      vi.mocked(burnTypesettingFromUrl).mockImplementation(
        async (_imageSrc, lines) => new Blob([lines.map((line) => line.userTranslation).join("|")], { type: "image/png" })
      );
      window.projectApi = {
        createProjectSession: vi.fn().mockResolvedValue({
          projectSessionId: "initial-session",
          project: sessionDto(initialProject, 0),
          encrypted: false
        }),
        openProjectFromDialog: vi.fn().mockResolvedValue({
          projectSessionId: "image-sync-session",
          project: sessionDto(openedProject, 5),
          encrypted: false
        }),
        openRecentProject: vi.fn(),
        unlockProject: vi.fn(),
        applyProjectMutation,
        saveProject: vi.fn(),
        saveProjectAs: vi.fn(),
        rekeyProject: vi.fn(),
        closeProject: vi.fn().mockResolvedValue(undefined),
        listRecentProjects: vi.fn().mockResolvedValue([]),
        removeRecentProject: vi.fn(),
        importTxtFile: vi.fn(),
        exportTranslations: vi.fn(),
        exportProjectImages,
        resolvePageImageSrc: vi.fn().mockResolvedValue("resolved:page")
      };

      renderApp();
      await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
      await screen.findByAltText("1페이지 이미지");
      await openWorkspacePanel("수정");
      fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "최신 식자 번역" } });
      fireEvent.click(screen.getByRole("button", { name: "전체 프로젝트 이미지 내보내기" }));

      await waitFor(() => expect(applyProjectMutation).toHaveBeenCalled());
      expect(exportProjectImages).not.toHaveBeenCalled();
      expect(vi.mocked(burnTypesettingFromUrl)).not.toHaveBeenCalled();

      await act(async () => {
        pendingMutation.resolve();
        await pendingMutation.promise;
      });

      await waitFor(() => expect(exportProjectImages).toHaveBeenCalledOnce());
      const [exportArgs] = exportProjectImages.mock.calls[0] as [{
        projectSessionId: string;
        typesetPages: Array<{ readiness: { revision: number }; pngBase64: string }>;
      }];
      expect(exportArgs.projectSessionId).toBe("image-sync-session");
      expect(exportArgs.typesetPages).toHaveLength(1);
      expect(exportArgs.typesetPages[0]?.readiness.revision).toBe(6);
      expect(vi.mocked(burnTypesettingFromUrl).mock.calls[0]?.[1][0]?.userTranslation).toBe("최신 식자 번역");
    });

    it("burns the saved line typesetting instead of a renderer-only localStorage draft", async () => {
      installTypesetFontMocks();
      const exportedPage = pageImage({ id: "typeset-authority-page" });
      const lineTypesetting = {
        bbox: { x: 0.18, y: 0.22, width: 0.3, height: 0.16 },
        writingMode: "vertical-rl" as const,
        rotationDegrees: 7,
        shape: "cloud" as const
      };
      const exportedProject = normalizeProject(createEmptyProject("Typeset Authority Export", false));
      exportedProject.metadata.id = "typeset-authority-project";
      exportedProject.pageImages = [exportedPage];
      exportedProject.dialogueLines = [{
        ...rendererLine("typeset-authority-line", 1, "원문"),
        userTranslation: "저장된 번역",
        typesetting: lineTypesetting,
        origin: { kind: "manual" as const }
      }];
      saveTypesettingDraft(window.localStorage, {
        projectId: "typeset-authority-project",
        pageImageId: "typeset-authority-page",
        sourceOcrId: "typeset-authority-line"
      }, {
        id: "stale-export-draft",
        sourceOcrId: "typeset-authority-line",
        bbox: { x: 0.01, y: 0.01, width: 0.08, height: 0.08 },
        rotationDegrees: 40,
        writingMode: "horizontal-tb",
        shape: "spiky"
      });
      const initialProject = normalizeProject(createEmptyProject("Initial", false));
      const exportProjectImages = vi.fn().mockResolvedValue({
        exportRoot: "C:\\exports\\Typeset Authority Export",
        report: { status: "completed", failures: [] },
        manifest: {}
      });
      vi.mocked(burnTypesettingFromUrl).mockImplementation(
        async () => new Blob(["typeset-authority"], { type: "image/png" })
      );
      window.projectApi = {
        createProjectSession: vi.fn().mockResolvedValue({
          projectSessionId: "initial-session",
          project: sessionDto(initialProject, 0),
          encrypted: false
        }),
        openProjectFromDialog: vi.fn().mockResolvedValue({
          projectSessionId: "typeset-authority-session",
          project: sessionDto(exportedProject, 4),
          encrypted: false
        }),
        openRecentProject: vi.fn(),
        unlockProject: vi.fn(),
        applyProjectMutation: vi.fn(),
        saveProject: vi.fn(),
        saveProjectAs: vi.fn(),
        rekeyProject: vi.fn(),
        closeProject: vi.fn().mockResolvedValue(undefined),
        listRecentProjects: vi.fn().mockResolvedValue([]),
        removeRecentProject: vi.fn(),
        importTxtFile: vi.fn(),
        exportTranslations: vi.fn(),
        exportProjectImages,
        resolvePageImageSrc: vi.fn().mockResolvedValue("resolved:Book-assets/images/page-001.jpg")
      };

      renderApp();
      await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
      await screen.findByAltText("1페이지 이미지");
      fireEvent.click(screen.getByRole("button", { name: "전체 프로젝트 이미지 내보내기" }));

      await waitFor(() => expect(exportProjectImages).toHaveBeenCalledOnce());
      const burnedLines = vi.mocked(burnTypesettingFromUrl).mock.calls[0]?.[1];
      expect(burnedLines?.[0]?.typesetting).toEqual(lineTypesetting);
      expect(burnedLines?.[0]?.typesetting).not.toMatchObject({ rotationDegrees: 40, shape: "spiky" });
    });

    it("does not start a second project image export while one is in flight", async () => {
      installTypesetFontMocks();
      const exportedPage = pageImage({ id: "inflight-export-page" });
      const exportedProject = normalizeProject(createEmptyProject("In-flight Export", false));
      exportedProject.pageImages = [exportedPage];
      exportedProject.dialogueLines = [{
        ...rendererLine("inflight-export-line", 1, "원문"),
        userTranslation: "번역",
        typesetting: { bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 }, writingMode: "horizontal-tb" },
        origin: { kind: "manual" as const }
      }];
      const initialProject = normalizeProject(createEmptyProject("Initial", false));
      const pendingExport = deferred<{
        exportRoot: string;
        report: { status: string; failures: unknown[] };
        manifest: Record<string, never>;
      }>();
      const exportProjectImages = vi.fn().mockReturnValue(pendingExport.promise);
      vi.mocked(burnTypesettingFromUrl).mockImplementation(
        async () => new Blob(["inflight-export"], { type: "image/png" })
      );
      window.projectApi = {
        createProjectSession: vi.fn().mockResolvedValue({
          projectSessionId: "initial-session",
          project: sessionDto(initialProject, 0),
          encrypted: false
        }),
        openProjectFromDialog: vi.fn().mockResolvedValue({
          projectSessionId: "inflight-export-session",
          project: sessionDto(exportedProject, 1),
          encrypted: false
        }),
        openRecentProject: vi.fn(),
        unlockProject: vi.fn(),
        applyProjectMutation: vi.fn(),
        saveProject: vi.fn(),
        saveProjectAs: vi.fn(),
        rekeyProject: vi.fn(),
        closeProject: vi.fn().mockResolvedValue(undefined),
        listRecentProjects: vi.fn().mockResolvedValue([]),
        removeRecentProject: vi.fn(),
        importTxtFile: vi.fn(),
        exportTranslations: vi.fn(),
        exportProjectImages,
        resolvePageImageSrc: vi.fn().mockResolvedValue("resolved:Book-assets/images/page-001.jpg")
      };

      renderApp();
      await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
      await screen.findByAltText("1페이지 이미지");
      const exportButton = screen.getByRole("button", { name: "전체 프로젝트 이미지 내보내기" });
      fireEvent.click(exportButton);
      await waitFor(() => expect(exportProjectImages).toHaveBeenCalledOnce());
      expect(exportButton).toBeDisabled();
      fireEvent.click(exportButton);
      expect(exportProjectImages).toHaveBeenCalledOnce();

      await act(async () => {
        pendingExport.resolve({
          exportRoot: "C:\\exports\\In-flight Export",
          report: { status: "completed", failures: [] },
          manifest: {}
        });
        await pendingExport.promise;
      });
      await waitFor(() => expect(exportButton).not.toBeDisabled());
      fireEvent.click(exportButton);
      await waitFor(() => expect(exportProjectImages).toHaveBeenCalledTimes(2));
    });

    it("re-enables project image export after a failed attempt", async () => {
      installTypesetFontMocks();
      const exportedPage = pageImage({ id: "failed-export-page" });
      const exportedProject = normalizeProject(createEmptyProject("Failed Export", false));
      exportedProject.pageImages = [exportedPage];
      exportedProject.dialogueLines = [{
        ...rendererLine("failed-export-line", 1, "원문"),
        userTranslation: "번역",
        typesetting: { bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 }, writingMode: "horizontal-tb" },
        origin: { kind: "manual" as const }
      }];
      const initialProject = normalizeProject(createEmptyProject("Initial", false));
      const exportProjectImages = vi.fn()
        .mockRejectedValueOnce(new Error("EXPORT_ROOT_EXISTS"))
        .mockResolvedValue({
          exportRoot: "C:\\exports\\Failed Export",
          report: { status: "completed", failures: [] },
          manifest: {}
        });
      vi.mocked(burnTypesettingFromUrl).mockImplementation(
        async () => new Blob(["failed-export"], { type: "image/png" })
      );
      window.projectApi = {
        createProjectSession: vi.fn().mockResolvedValue({
          projectSessionId: "initial-session",
          project: sessionDto(initialProject, 0),
          encrypted: false
        }),
        openProjectFromDialog: vi.fn().mockResolvedValue({
          projectSessionId: "failed-export-session",
          project: sessionDto(exportedProject, 1),
          encrypted: false
        }),
        openRecentProject: vi.fn(),
        unlockProject: vi.fn(),
        applyProjectMutation: vi.fn(),
        saveProject: vi.fn(),
        saveProjectAs: vi.fn(),
        rekeyProject: vi.fn(),
        closeProject: vi.fn().mockResolvedValue(undefined),
        listRecentProjects: vi.fn().mockResolvedValue([]),
        removeRecentProject: vi.fn(),
        importTxtFile: vi.fn(),
        exportTranslations: vi.fn(),
        exportProjectImages,
        resolvePageImageSrc: vi.fn().mockResolvedValue("resolved:Book-assets/images/page-001.jpg")
      };

      renderApp();
      await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
      await screen.findByAltText("1페이지 이미지");
      const exportButton = screen.getByRole("button", { name: "전체 프로젝트 이미지 내보내기" });
      fireEvent.click(exportButton);
      expect(await findWorkStatus(/EXPORT_ROOT_EXISTS/)).toBeInTheDocument();
      expect(exportButton).not.toBeDisabled();
      fireEvent.click(exportButton);
      await waitFor(() => expect(exportProjectImages).toHaveBeenCalledTimes(2));
    });
  });

  it("shows status feedback in top-bar Settings without duplicate announcers", async () => {
    const saveProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "status-feedback.txt",
        lines: [rendererLine("status-feedback-line", 1, "Status feedback")]
      }),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\status-feedback.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
    openPagesPanel();
    openSettings();
    const settings = screen.getByRole("region", { name: "프로젝트 설정" });

    fireEvent.click(screen.getByRole("button", { name: "다른 이름 저장" }));

    await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1));
    expect(within(settings).getByText("프로젝트를 저장했습니다.")).toBeVisible();
    expect(screen.getAllByRole("status", { name: "작업 상태" })).toHaveLength(1);
    expect(screen.getAllByRole("status", { name: "작업대 현황" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "설정" })).toHaveAttribute("aria-expanded", "true");
  });

  it("places dialogue lines in a collapsible bottom panel", async () => {
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "bottom-panel.txt",
        lines: [rendererLine("bottom-panel-line", 1, "Bottom panel line")]
      }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };
    renderApp();
    await clickTxtStart();

    fireEvent.click(await screen.findByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = await screen.findByRole("region", { name: "하단 대사 패널" });

    expect(within(bottomPanel).getByRole("heading", { name: "대사" })).toBeInTheDocument();
    expect(within(bottomPanel).getByRole("tab", { name: "대사" })).toHaveAttribute("aria-selected", "true");
    expect(within(bottomPanel).getByRole("tab", { name: "OCR 후보" })).toHaveAttribute("aria-selected", "false");
    expect(within(bottomPanel).getByRole("tab", { name: "문제 라인" })).toHaveAttribute("aria-selected", "false");
    expect(within(bottomPanel).getByText("Bottom panel line")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 접기" }));

    expect(screen.getByRole("button", { name: "결과 및 진행 열기" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "하단 대사 패널" })).not.toBeInTheDocument();
  });

  it("shows a five-line filmstrip by default and preserves the full dialogue table", async () => {
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "C:\\queue.txt",
        lines: [1, 2, 3, 4, 5].map((order) => rendererLine(`queue-${order}`, order, `대사 ${order}`))
      }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    fireEvent.click(await screen.findByRole("button", { name: "결과 및 진행 열기" }));
    expect(await screen.findByRole("list", { name: "대사 작업 큐" })).toBeInTheDocument();

    expect(within(screen.getByRole("list", { name: "대사 작업 큐" })).getAllByRole("button")).toHaveLength(5);
    expect(screen.queryByLabelText("대사 검색")).not.toBeInTheDocument();

    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    const tablist = within(bottomPanel).getByRole("tablist", { name: "하단 패널 탭" });
    const selectedItem = screen.getByRole("button", { name: /#3.*대사 3/ });
    fireEvent.click(selectedItem);
    expect(selectedItem).toHaveAttribute("aria-current", "true");

    const fullViewAction = within(bottomPanel).getByRole("button", { name: "전체 대사 보기" });
    expect(tablist).not.toContainElement(fullViewAction);
    expect(fullViewAction).not.toHaveAttribute("aria-pressed");

    fireEvent.click(fullViewAction);
    await openWorkspacePanel("수정");
    const searchInput = screen.getByLabelText("대사 검색");
    expect(searchInput).toBeInTheDocument();
    expect(screen.getByLabelText("사용자 수정문 5")).toBeInTheDocument();
    fireEvent.change(searchInput, { target: { value: "대사 5" } });
    await waitFor(() =>
      expect(within(bottomPanel).getByText("대사 5", { selector: "p" }).closest('[role="button"]')).toHaveClass("selected")
    );

    const queueViewAction = within(bottomPanel).getByRole("button", { name: "작업 큐 보기" });
    expect(queueViewAction).not.toHaveAttribute("aria-pressed");
    fireEvent.click(queueViewAction);

    expect(screen.getByRole("list", { name: "대사 작업 큐" })).toBeInTheDocument();
    expect(screen.queryByLabelText("대사 검색")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("사용자 수정문 3")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /#5.*대사 5/ })).toHaveAttribute("aria-current", "true");

    fireEvent.click(within(bottomPanel).getByRole("button", { name: "전체 대사 보기" }));
    expect(screen.getByLabelText("대사 검색")).toBeInTheDocument();
    expect(within(bottomPanel).getByText("대사 5", { selector: "p" }).closest('[role="button"]')).toHaveClass("selected");
  });

  it("shows issue lines in the bottom issue tab and opens the inspector when clicked", async () => {
    const cleanLine: DialogueLine = {
      id: "phase13-clean",
      order: 1,
      pageNumber: 1,
      speaker: "Mika",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Clean line",
      lineStatus: "complete",
      userTranslation: "Done",
      parseConfidence: 0.95,
      parseWarnings: []
    };
    const issueLine: DialogueLine = {
      id: "phase13-issue",
      order: 2,
      pageNumber: 1,
      speaker: "unknown",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Needs review",
      lineStatus: "review",
      parseConfidence: 0.62,
      parseWarnings: ["OCR confidence is low"]
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "issues.txt", lines: [cleanLine, issueLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 2")).toHaveValue("Needs review");

    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    fireEvent.click(within(bottomPanel).getByRole("tab", { name: "문제 라인" }));

    expect(within(bottomPanel).getByRole("tab", { name: "문제 라인" })).toHaveAttribute("aria-selected", "true");
    expect(within(bottomPanel).getByText("Needs review")).toBeInTheDocument();
    expect(within(bottomPanel).queryByText("Clean line")).not.toBeInTheDocument();
    expect(within(bottomPanel).getByText("검토필요")).toBeInTheDocument();
    expect(within(bottomPanel).getByText("화자 unknown")).toBeInTheDocument();
    expect(within(bottomPanel).getByText("OCR confidence is low")).toBeInTheDocument();

    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 2 선택" }));

    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(within(inspector).getByText(/라인 상세|페이지 · 대사/)).toBeInTheDocument();
    expect(within(inspector).getByLabelText("원문 2")).toHaveValue("Needs review");
  });

  it("reports when txt import is canceled", async () => {
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue(null),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("TXT 불러오기를 취소했습니다."));
  });

  it("atomically exposes issue context and keeps the current issue after the results panel is collapsed and reopened", async () => {
    const cleanLine = rendererLine("ui07-clean", 1, "Clean line");
    const issueLine: DialogueLine = {
      ...rendererLine("ui07-issue", 2, "Needs issue", 1),
      speaker: "unknown",
      lineStatus: "review",
      parseWarnings: ["needs speaker"]
    };
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "ui07.txt", lines: [cleanLine, issueLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    fireEvent.click(within(bottomPanel).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 2 선택" }));

    expect(screen.getByTestId("current-issue")).toHaveAttribute("data-issue-id", "ui07-issue");
    expect(screen.getByRole("complementary", { name: "오른쪽 작업 패널" })).toHaveAttribute(
      "data-issue-editor",
      "ocr"
    );
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 접기" }));
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const reopened = screen.getByRole("region", { name: "하단 대사 패널" });
    expect(within(reopened).getByRole("button", { name: "문제 라인 2 선택" })).toHaveAttribute(
      "aria-current",
      "true"
    );
    expect(screen.getByTestId("current-issue")).toHaveAttribute("data-issue-id", "ui07-issue");
  });

  it("exposes the confirmed issue editor surface and pin affordance", async () => {
    const cleanLine = rendererLine("ui08-clean", 1, "Clean line");
    const issueLine: DialogueLine = {
      ...rendererLine("ui08-issue", 2, "Needs OCR editor", 1),
      speaker: "unknown",
      lineStatus: "review",
      parseConfidence: 0.42,
      parseWarnings: ["OCR warning"]
    };
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "ui08.txt", lines: [cleanLine, issueLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    fireEvent.click(within(bottomPanel).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 2 선택" }));

    expect(screen.getByTestId("contextual-issue-editor-control")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /편집기 pin/i })).toBeInTheDocument();
    expect(within(screen.getByTestId("contextual-issue-editor-control")).getByRole("heading", { name: "문제 편집기" })).toBeInTheDocument();
    expect(screen.getByTestId("stage-editor")).toHaveAttribute("data-stage", "ocr");
    expect(screen.queryByRole("heading", { name: "번역 수정" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "검수 확정" })).not.toBeInTheDocument();
  });

  it("keeps a pinned editor across issue changes until the user explicitly switches or unpins", async () => {
    const ocrIssue: DialogueLine = {
      ...rendererLine("ui08-pin-ocr", 1, "OCR issue"),
      speaker: "Mika",
      parseConfidence: 0.4,
      parseWarnings: ["low confidence"]
    };
    const speakerIssue: DialogueLine = {
      ...rendererLine("ui08-pin-speaker", 2, "Speaker issue"),
      speaker: "",
      lineStatus: "complete",
      userTranslation: "done"
    };
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "ui08-pin.txt", lines: [ocrIssue, speakerIssue] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    fireEvent.click(within(bottomPanel).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 1 선택" }));
    const control = await screen.findByTestId("contextual-issue-editor-control");
    expect(control).toHaveAttribute("data-active-editor", "ocr");
    fireEvent.click(within(control).getByRole("button", { name: /편집기 pin/i }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 2 선택" }));
    expect(await screen.findByTestId("current-issue")).toHaveAttribute("data-issue-id", "ui08-pin-speaker");
    expect(screen.getByTestId("contextual-issue-editor-control")).toHaveAttribute("data-active-editor", "ocr");
    expect(screen.getByRole("status", { name: "" })).toHaveAttribute("data-editor-mismatch", "true");

    fireEvent.click(screen.getByRole("button", { name: "필요한 화자 편집기 열기" }));
    expect(screen.getByTestId("contextual-issue-editor-control")).toHaveAttribute("data-active-editor", "speaker");
    expect(screen.getByTestId("stage-editor")).toHaveAttribute("data-stage", "speaker");
    expect(screen.queryByRole("heading", { name: "번역 수정" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "검수 확정" })).not.toBeInTheDocument();
    expect(within(screen.getByTestId("contextual-issue-editor-control")).getByRole("button", { name: /pin 해제/i })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(screen.getByTestId("contextual-issue-editor-control")).getByRole("button", { name: /pin 해제/i }));
    expect(screen.getByTestId("contextual-issue-editor-control")).toHaveAttribute("data-active-editor", "speaker");
  });

  it("preserves the confirmed editor and pin when a cross-page issue render fails", async () => {
    const firstIssue: DialogueLine = {
      ...rendererLine("ui08-fail-first", 1, "First issue", 1),
      speaker: "Mika",
      parseConfidence: 0.4,
      parseWarnings: ["first warning"]
    };
    const secondIssue: DialogueLine = {
      ...rendererLine("ui08-fail-second", 2, "Second issue", 2),
      speaker: "",
      lineStatus: "complete",
      userTranslation: "done"
    };
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })], [firstIssue, secondIssue])
      ),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockImplementation(({ storedRelativePath }: { storedRelativePath: string }) => Promise.resolve(storedRelativePath))
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    const firstImage = await screen.findByAltText("1페이지 이미지");
    fireEvent.load(firstImage);
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    fireEvent.click(within(bottomPanel).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 1 선택" }));
    await openWorkspacePanel("수정");
    const control = await screen.findByTestId("contextual-issue-editor-control");
    fireEvent.click(within(control).getByRole("button", { name: /편집기 pin/i }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 2 선택" }));
    fireEvent.error(await screen.findByAltText("2페이지 이미지"));

    expect(screen.getByTestId("current-issue")).toHaveAttribute("data-issue-id", "ui08-fail-first");
    expect(screen.getByTestId("contextual-issue-editor-control")).toHaveAttribute("data-active-editor", "ocr");
    expect(within(screen.getByTestId("contextual-issue-editor-control")).getByRole("button", { name: /pin 해제/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("rolls a cross-page issue transaction back when the target image fails and ignores an older failure", async () => {
    const firstIssue: DialogueLine = {
      ...rendererLine("ui07-first", 1, "First issue", 1),
      speaker: "unknown",
      lineStatus: "review",
      parseWarnings: ["first warning"]
    };
    const secondIssue: DialogueLine = {
      ...rendererLine("ui07-second", 2, "Second issue", 2),
      speaker: "",
      lineStatus: "draft",
      parseWarnings: []
    };
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })], [firstIssue, secondIssue])
      ),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockImplementation(({ storedRelativePath }: { storedRelativePath: string }) => Promise.resolve(storedRelativePath))
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    const firstImage = await screen.findByAltText("1페이지 이미지");
    fireEvent.load(firstImage);
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    fireEvent.click(within(bottomPanel).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 1 선택" }));
    expect(screen.getByTestId("current-issue")).toHaveAttribute("data-issue-id", "ui07-first");

    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 2 선택" }));
    await openWorkspacePanel("수정");
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    fireEvent.error(screen.getByAltText("2페이지 이미지"));
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
    expect(screen.getByTestId("current-issue")).toHaveAttribute("data-issue-id", "ui07-first");
    expect(within(screen.getByRole("complementary", { name: "오른쪽 작업 패널" })).getByLabelText("원문 1")).toHaveValue("First issue");
  });

  it("restores the actual zoom and pan after a failed cross-page issue render", async () => {
    const firstIssue: DialogueLine = {
      ...rendererLine("ui07-viewport-first", 1, "First viewport issue", 1),
      speaker: "unknown",
      lineStatus: "review",
      parseWarnings: []
    };
    const secondIssue: DialogueLine = {
      ...rendererLine("ui07-viewport-second", 2, "Second viewport issue", 2),
      speaker: "",
      lineStatus: "draft",
      parseWarnings: []
    };
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })], [firstIssue, secondIssue])
      ),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockImplementation(({ storedRelativePath }: { storedRelativePath: string }) => Promise.resolve(storedRelativePath))
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    const firstImage = await screen.findByAltText("1페이지 이미지");
    fireEvent.load(firstImage);
    fireEvent.click(screen.getByRole("button", { name: /확대|Zoom in/i }));
    expect(screen.getByText("125%", { selector: ".page-image-zoom" })).toBeInTheDocument();
    const viewport = screen.getByTestId("page-image-viewport");
    Object.defineProperty(viewport, "scrollLeft", { configurable: true, writable: true, value: 37 });
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 29 });
    fireEvent.scroll(viewport);

    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    fireEvent.click(within(bottomPanel).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 1 선택" }));
    // The successful same-page transaction must preserve the user's higher
    // zoom so the subsequent failed transaction can restore it.
    expect(screen.getByText("125%", { selector: ".page-image-zoom" })).toBeInTheDocument();
    const restoredViewport = screen.getByTestId("page-image-viewport");
    Object.defineProperty(restoredViewport, "scrollLeft", { configurable: true, writable: true, value: 37 });
    Object.defineProperty(restoredViewport, "scrollTop", { configurable: true, writable: true, value: 29 });
    fireEvent.scroll(restoredViewport);
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 2 선택" }));
    fireEvent.error(screen.getByAltText("2페이지 이미지"));

    await openWorkspacePanel("수정");
    await waitFor(() => expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("1 / 2"));
    await waitFor(() => expect(screen.getByText("125%", { selector: ".page-image-zoom" })).toBeInTheDocument());
    await waitFor(() => expect((restoredViewport as HTMLElement).scrollLeft).toBe(37));
    await waitFor(() => expect((restoredViewport as HTMLElement).scrollTop).toBe(29));
  });

  it("ignores a stale same-page issue render callback after a newer issue transaction starts", async () => {
    const firstIssue: DialogueLine = {
      ...rendererLine("ui07-stale-first", 1, "First stale issue", 1),
      speaker: "unknown",
      lineStatus: "review",
      parseWarnings: ["first warning"]
    };
    const secondIssue: DialogueLine = {
      ...rendererLine("ui07-stale-second", 2, "Second stale issue", 1),
      speaker: "",
      lineStatus: "draft",
      parseWarnings: []
    };
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()], [firstIssue, secondIssue])),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("/review-assets/page-001.png")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    fireEvent.click(within(bottomPanel).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 1 선택" }));
    const staleImage = screen.getByAltText("1페이지 이미지");
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 2 선택" }));
    const latestImage = screen.getByAltText("1페이지 이미지");
    expect(latestImage).not.toBe(staleImage);
    fireEvent.error(staleImage);
    expect(screen.queryByTestId("current-issue")).not.toBeInTheDocument();
    fireEvent.load(latestImage);
    await waitFor(() => expect(screen.getByTestId("current-issue")).toHaveAttribute("data-issue-id", "ui07-stale-second"));
  });

  it("supersedes a pending image transaction when the newer issue has no page image", async () => {
    const baselineLine: DialogueLine = {
      ...rendererLine("ui07-supersede-base", 3, "Baseline", 1),
      speaker: "Narrator",
      lineStatus: "draft",
      userTranslation: "Done"
    };
    const imageIssue: DialogueLine = {
      ...rendererLine("ui07-supersede-image", 1, "Image pending", 2),
      speaker: "unknown",
      lineStatus: "review",
      parseWarnings: ["warning"]
    };
    const textIssue: DialogueLine = {
      ...rendererLine("ui07-supersede-text", 2, "Text only", 3),
      speaker: "",
      lineStatus: "draft",
      parseWarnings: []
    };
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })], [baselineLine, imageIssue, textIssue])
      ),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("/review-assets/page.png")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    fireEvent.load(await screen.findByAltText("1페이지 이미지"));
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    fireEvent.click(within(bottomPanel).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 1 선택" }));
    const staleImage = screen.getByAltText("2페이지 이미지");
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 2 선택" }));
    expect(screen.getByTestId("current-issue")).toHaveAttribute("data-issue-id", "ui07-supersede-text");
    await openWorkspacePanel("수정");
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("3 / 3");
    fireEvent.error(staleImage);
    expect(screen.getByTestId("current-issue")).toHaveAttribute("data-issue-id", "ui07-supersede-text");
  });

  it("supersedes a pending image transaction when the newer issue targets a ready same-page image", async () => {
    const baselineLine: DialogueLine = {
      ...rendererLine("ui07-supersede-ready-base", 3, "Baseline", 1),
      speaker: "Narrator",
      lineStatus: "draft",
      userTranslation: "Done"
    };
    const readyIssue: DialogueLine = {
      ...rendererLine("ui07-supersede-ready", 2, "Ready same page", 1),
      speaker: "",
      lineStatus: "draft",
      parseWarnings: []
    };
    const imageIssue: DialogueLine = {
      ...rendererLine("ui07-supersede-image-ready", 1, "Image pending", 2),
      speaker: "unknown",
      lineStatus: "review",
      parseWarnings: ["warning"]
    };
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })], [baselineLine, imageIssue, readyIssue])
      ),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("/review-assets/page.png")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    fireEvent.load(await screen.findByAltText("1페이지 이미지"));
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    fireEvent.click(within(bottomPanel).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 1 선택" }));
    const staleImage = screen.getByAltText("2페이지 이미지");
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 2 선택" }));
    expect(screen.getByTestId("current-issue")).toHaveAttribute("data-issue-id", "ui07-supersede-ready");
    await openWorkspacePanel("수정");
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
    fireEvent.error(staleImage);
    expect(screen.getByTestId("current-issue")).toHaveAttribute("data-issue-id", "ui07-supersede-ready");
  });

  it("invalidates a pending issue transaction when its target line is removed", async () => {
    const issueLine: DialogueLine = {
      ...rendererLine("ui07-pending-remove", 1, "Pending remove", 1),
      speaker: "unknown",
      lineStatus: "review",
      parseWarnings: ["warning"]
    };
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()], [issueLine])),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("/review-assets/page-001.png")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    const bottomPanel = screen.getByRole("region", { name: "하단 대사 패널" });
    fireEvent.click(within(bottomPanel).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(within(bottomPanel).getByRole("button", { name: "문제 라인 1 선택" }));
    expect(screen.queryByTestId("current-issue")).not.toBeInTheDocument();
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "라인 삭제" }));
    await answerAppConfirmation("대사 삭제");
    await waitFor(() => expect(screen.queryByTestId("current-issue")).not.toBeInTheDocument());
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("라인을 삭제했습니다.");
    fireEvent.load(screen.getByAltText("1페이지 이미지"));
    expect(screen.queryByTestId("current-issue")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("원문 1")).not.toBeInTheDocument();
  });

  it("imports a txt file and reflects table edits while using the detail panel", async () => {
    const line: DialogueLine = {
      id: "line-workflow",
      order: 7,
      pageNumber: 1,
      speaker: "Narrator",
      position: "열기ing",
      dialogueType: "narration",
      sourceLanguage: "en",
      sourceText: "Original source",
      parseConfidence: 0.65,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "workflow.txt", lines: [line] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();

    await clickTxtStart();

    await openWorkspacePanel("수정");
    const sourceCell = await screen.findByLabelText("원문 7");
    expect(sourceCell).toHaveValue("Original source");

    fireEvent.change(sourceCell, { target: { value: "Edited source" } });
    expect(screen.getByLabelText("원문 7")).toHaveValue("Edited source");

    fireEvent.click(screen.getByLabelText("AI 번역 7"));
    expect(screen.getByText(/라인 상세|페이지 · 대사/)).toBeInTheDocument();
    expect(screen.getByText("파싱 신뢰도")).toBeInTheDocument();

    fireEvent.click(screen.getByText("라인 메타"));
    fireEvent.change(screen.getByLabelText("라인 화자"), { target: { value: "Editor" } });
    expect(screen.getByText("#7 · Editor · 미번역")).toBeInTheDocument();
    expect(screen.getByLabelText("원문 7")).toHaveValue("Edited source");
  });

  it("keeps selected row metadata compact and moves metadata editing into a collapsed inspector section", async () => {
    const line: DialogueLine = {
      id: "line-focused-inspector",
      order: 1,
      pageNumber: 1,
      speaker: "Mika",
      position: "좌상단 말풍선",
      dialogueType: "speech",
      lineStatus: "complete",
      sourceLanguage: "en",
      sourceText: "Original",
      aiTranslation: "AI draft",
      userTranslation: "User edit",
      parseConfidence: 0.92,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "focused.txt", lines: [line] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    fireEvent.click(await screen.findByRole("button", { name: "결과 및 진행 열기" }));
    await screen.findByRole("list", { name: "대사 작업 큐" });
    openFullDialogueTable();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
    fireEvent.click(screen.getByText("#1"));
    expect(await screen.findByText("#1 · Mika · 완료")).toBeInTheDocument();
    expect(screen.queryByLabelText("테이블 화자 1")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("테이블 페이지 1")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("테이블 상태 1")).not.toBeInTheDocument();
    expect(screen.getByText("라인 메타")).toBeInTheDocument();
    expect(screen.getByLabelText("라인 화자")).toBeVisible();
    expect(screen.getByLabelText("라인 화자")).toHaveValue("Mika");
    fireEvent.click(screen.getByText("라인 메타"));
    expect(screen.getByLabelText("라인 위치")).toHaveValue("좌상단 말풍선");
    expect(screen.getByLabelText("라인 유형")).toHaveValue("speech");
    expect(screen.getByLabelText("라인 언어")).toHaveValue("en");
    expect(screen.queryByLabelText("라인 상태")).not.toBeInTheDocument();
    expect(screen.getByLabelText("상세 메모")).toBeInTheDocument();
  });

  it("shows one page of dialogue at a time and navigates pages", async () => {
    const firstLine: DialogueLine = {
      id: "line-page-one",
      order: 1,
      pageNumber: 1,
      speaker: "Mika",
      dialogueType: "speech",
      lineStatus: "complete",
      sourceLanguage: "en",
      sourceText: "Page one source",
      parseConfidence: 0.9,
      parseWarnings: []
    };
    const secondLine: DialogueLine = {
      id: "line-page-two",
      order: 2,
      pageNumber: 2,
      speaker: "Ren",
      dialogueType: "speech",
      lineStatus: "review",
      sourceLanguage: "en",
      sourceText: "Page two source",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "pages.txt", lines: [firstLine, secondLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("현재 페이지");
    openFullDialogueTable();

    expect(await screen.findByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
    screen.getByRole("button", { name: "집중 모드 켜기" }).focus();
    expect(screen.getByLabelText("원문 1")).toHaveValue("Page one source");
    expect(screen.queryByLabelText("원문 2")).not.toBeInTheDocument();
    expect(screen.getByLabelText("페이지 요약")).toHaveTextContent("대사 1");
    expect(screen.getByLabelText("페이지 요약")).toHaveTextContent("완료 1");

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));

    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(screen.queryByLabelText("원문 1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("원문 2")).toHaveValue("Page two source");
    expect(screen.getByLabelText("페이지 요약")).toHaveTextContent("검토필요 1");

    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
  });

  it("lists page status in the page drawer and navigates from the strip", async () => {
    const firstLine: DialogueLine = {
      id: "line-page-strip-one",
      order: 1,
      pageNumber: 1,
      speaker: "Mika",
      dialogueType: "speech",
      lineStatus: "complete",
      sourceLanguage: "en",
      sourceText: "Page strip one",
      userTranslation: "Done",
      parseConfidence: 0.94,
      parseWarnings: []
    };
    const secondLine: DialogueLine = {
      id: "line-page-strip-two",
      order: 2,
      pageNumber: 2,
      speaker: "unknown",
      dialogueType: "speech",
      lineStatus: "review",
      sourceLanguage: "en",
      sourceText: "Page strip two",
      parseConfidence: 0.6,
      parseWarnings: ["needs speaker"]
    };

    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()], [firstLine, secondLine])),
      saveProject: vi.fn(),
      importPageImages: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    await screen.findByAltText("1페이지 이미지");
    openFullDialogueTable();
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("Page strip one");

    openPagesPanel();
    const drawer = screen.getByRole("complementary", { name: "왼쪽 보조 패널" });
    const pageStrip = within(drawer).getByRole("list", { name: "페이지 목록" });

    expect(within(pageStrip).getByRole("button", { name: "페이지 1 선택" })).toHaveTextContent("이미지 있음");
    expect(within(pageStrip).getByRole("button", { name: "페이지 1 선택" })).toHaveTextContent("라인 1");
    expect(within(pageStrip).getByRole("button", { name: "페이지 1 선택" })).toHaveTextContent("문제 0");
    expect(within(pageStrip).getByRole("button", { name: "페이지 2 선택" })).toHaveTextContent("이미지 없음");
    expect(within(pageStrip).getByRole("button", { name: "페이지 2 선택" })).toHaveTextContent("라인 1");
    expect(within(pageStrip).getByRole("button", { name: "페이지 2 선택" })).toHaveTextContent("문제 1");

    fireEvent.click(within(pageStrip).getByRole("button", { name: "페이지 2 선택" }));

    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(screen.getByLabelText("원문 2")).toHaveValue("Page strip two");
  });

  it("moves pages with ArrowRight and ArrowLeft only outside text fields", async () => {
    const firstLine: DialogueLine = {
      id: "line-arrow-page-one",
      order: 1,
      pageNumber: 1,
      speaker: "Mika",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Arrow page one",
      parseConfidence: 0.9,
      parseWarnings: []
    };
    const secondLine: DialogueLine = {
      id: "line-arrow-page-two",
      order: 2,
      pageNumber: 2,
      speaker: "Ren",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Arrow page two",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "arrow-pages.txt", lines: [firstLine, secondLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
    const workspaceButton = screen.getByRole("button", { name: "집중 모드 켜기" });
    workspaceButton.focus();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(screen.getByLabelText("원문 2")).toHaveValue("Arrow page two");

    const sourceField = screen.getByLabelText("원문 2");
    sourceField.focus();
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");

    workspaceButton.focus();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
    expect(screen.getByLabelText("원문 1")).toHaveValue("Arrow page one");
  });

  it("moves a dialogue line to another page when its page number changes", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Page edit", false));
    openedProject.dialogueLines = [{
      ...rendererLine("line-page-edit", 1, "Move me"),
      speaker: "Mika",
      sourceLanguage: "en",
      origin: { kind: "manual" }
    }];
    openedProject.pageImages = [
      pageImage(),
      pageImage({ id: "page-image-2", pageNumber: 2, storedRelativePath: "Book-assets/images/page-002.jpg" })
    ];
    let sessionProject = structuredClone(openedProject);
    let sessionRevision = 1;
    let persistedProject = structuredClone(openedProject);
    const dto = (project: TranslationProjectV2, revision: number, dirty: boolean) => ({
      revision,
      project: structuredClone(project),
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const applyProjectMutation = vi.fn(async (args: ApplyProjectMutationArgs) => {
      if (args.mutation.type === "update_dialogue_line") {
        const mutation = args.mutation;
        sessionProject = {
          ...sessionProject,
          dialogueLines: sessionProject.dialogueLines.map((line) =>
            line.id === mutation.lineId ? { ...line, ...mutation.patch } : line
          )
        };
      }
      sessionRevision += 1;
      return {
        status: "applied" as const,
        revision: sessionRevision,
        project: dto(sessionProject, sessionRevision, true)
      };
    });
    const saveProject = vi.fn(async () => {
      persistedProject = structuredClone(sessionProject);
      return {
        projectSessionId: "opened-session",
        project: dto(sessionProject, sessionRevision, false)
      };
    });
    const closeProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(initialProject, 0, false),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn()
        .mockResolvedValueOnce({
          projectSessionId: "opened-session",
          project: dto(openedProject, 1, false),
          encrypted: false
        })
        .mockImplementation(async () => ({
          projectSessionId: "reopened-session",
          project: dto(persistedProject, sessionRevision, false),
          encrypted: false
        })),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject,
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject,
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("Move me");
    openFullDialogueTable();

    fireEvent.click(screen.getByText("라인 메타"));
    fireEvent.change(screen.getByLabelText("라인 페이지"), { target: { value: "2" } });

    expect(screen.queryByLabelText("원문 1")).not.toBeInTheDocument();
    expect(screen.getByText("현재 페이지에 대사가 없습니다.")).toBeInTheDocument();
    openPagesPanel();
    openSettings();
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();

    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledWith({
      projectSessionId: "opened-session",
      baseRevision: 1,
      mutation: {
        type: "update_dialogue_line",
        lineId: "line-page-edit",
        patch: { pageNumber: 2 }
      }
    }));

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(saveProject).toHaveBeenCalledWith({ projectSessionId: "opened-session" }));
    expect(persistedProject.dialogueLines[0]?.pageNumber).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await waitFor(() => expect(closeProject).toHaveBeenCalledWith({ projectSessionId: "opened-session" }));
    await waitFor(() => expect(window.projectApi.openProjectFromDialog).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("Move me");
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    fireEvent.click(screen.getByText("라인 메타"));
    expect(screen.getByLabelText("라인 페이지")).toHaveValue(2);
  });

  it("applies the latest Main DTO when a pageNumber mutation hits a revision conflict", async () => {
    const initialProject = createEmptyProject("새 프로젝트", false);
    const openedProject = createEmptyProject("Session page conflict", false);
    openedProject.dialogueLines = [{
      ...rendererLine("session-line", 1, "Stay on page 1"),
      origin: { kind: "manual" }
    }];
    const latestProject = structuredClone(openedProject);
    latestProject.dialogueLines[0]!.pageNumber = 3;
    const dto = (project: typeof openedProject, revision: number, dirty: boolean) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const applyProjectMutation = vi.fn().mockResolvedValue({
      status: "revision_conflict",
      code: "REVISION_CONFLICT",
      revision: 4,
      project: dto(latestProject, 4, true),
      conflictingPaths: ["dialogueLines/session-line/pageNumber"]
    });
    const saveProject = vi.fn();
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(initialProject, 0, false),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, 1, false),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject,
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("Stay on page 1");
    openFullDialogueTable();
    fireEvent.click(screen.getByText("라인 메타"));
    fireEvent.change(screen.getByLabelText("라인 페이지"), { target: { value: "2" } });

    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledWith({
      projectSessionId: "opened-session",
      baseRevision: 1,
      mutation: {
        type: "update_dialogue_line",
        lineId: "session-line",
        patch: { pageNumber: 2 }
      }
    }));
    expect(await screen.findByRole("status", { name: "작업 상태" })).toHaveTextContent(
      "다른 변경과 충돌했습니다: dialogueLines/session-line/pageNumber"
    );
    expect(saveProject).not.toHaveBeenCalled();
  });

  it("shows the current page image when page image metadata exists", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue({
        filePath: "C:\\projects\\Book.ctp",
        encrypted: false,
        project: {
          schemaVersion: 1,
          metadata: {
            id: "project-images",
            title: "Image Project",
            createdAt: "2026-05-29T00:00:00.000Z",
            updatedAt: "2026-05-29T00:00:00.000Z",
            secret: false
          },
          characters: [],
          dictionaryTerms: [],
          dialogueLines: [rendererLine("image-workspace-line", 1, "Image workspace line")],
          pageImages: [
            {
              id: "page-image-1",
              pageNumber: 1,
              storedRelativePath: "Book-assets/images/page-001.jpg",
              originalFileName: "scan_001.jpg",
              sha256: "a".repeat(64),
              byteSize: 4,
              mimeType: "image/jpeg",
              copiedAt: "2026-05-29T00:00:00.000Z"
            }
          ],
          settings: { defaultSourceLanguage: "unknown" }
        }
      }),
      saveProject: vi.fn(),
      importPageImages: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    expect(await screen.findByAltText("1페이지 이미지")).toHaveAttribute(
      "src",
      expect.stringContaining("Book-assets/images/page-001.jpg")
    );
    await openWorkspacePanel("수정");
    expect(screen.getByRole("button", { name: "다시 연결" })).toBeEnabled();
  });

  it("hides inpainting before a project has a saved page image", () => {
    const inpaintPageImage = vi.fn();
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      inpaintPageImage
    };

    renderApp();

    expect(screen.queryByRole("button", { name: "인페인팅" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "번역 프로젝트" })).toBeInTheDocument();
    expect(inpaintPageImage).not.toHaveBeenCalled();
  });

  const noKeyStatus = {
    configured: false,
    source: "none" as const,
    persistence: "encrypted" as const,
    requiresReentry: false
  };
  const encryptedStatus = {
    configured: true,
    source: "encrypted" as const,
    persistence: "encrypted" as const,
    requiresReentry: false
  };
  const environmentStatus = {
    configured: true,
    source: "environment" as const,
    persistence: "session-only" as const,
    requiresReentry: false
  };
  const unavailableStatus = {
    configured: true,
    source: "session" as const,
    persistence: "unavailable" as const,
    requiresReentry: false
  };

  it.each([
    [noKeyStatus, "Gemini API 키 미설정"],
    [encryptedStatus, "Gemini API 키 암호화 저장됨"],
    [environmentStatus, "환경변수의 Gemini API 키 사용 중"],
    [unavailableStatus, "암호화 저장을 사용할 수 없어 이번 실행에서만 사용됩니다"],
    [{ ...encryptedStatus, requiresReentry: true }, "저장된 키를 복원하지 못했습니다. Gemini API 키를 다시 입력해 주세요"]
  ])("shows the Gemini API key status without redisplaying the key", async (status, label) => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      getGeminiApiKeyStatus: vi.fn().mockResolvedValue(status)
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();
    openSettings();

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByLabelText("Gemini API 키")).toHaveValue("");
  });

  it("launches on Project Home without workspace chrome or opening a picker", () => {
    const choosePageImageFiles = vi.fn();
    const choosePreparedPageImageFiles = vi.fn();
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      choosePageImageFiles,
      releasePreparedPageImages: vi.fn().mockResolvedValue(undefined),
      choosePreparedPageImageFiles
    };

    renderApp();

    expect(screen.getByRole("heading", { name: "번역 프로젝트" })).toHaveFocus();
    expect(screen.queryByTestId("focus-deck-shell")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "작업 도구" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("페이지 이동")).not.toBeInTheDocument();
    expect(choosePageImageFiles).not.toHaveBeenCalled();
    expect(choosePreparedPageImageFiles).not.toHaveBeenCalled();
  });

  it("moves Home to Setup without a dialog and opens the prepared picker only on Image Select", async () => {
    const choosePageImageFiles = vi.fn();
    const choosePreparedPageImageFiles = vi.fn().mockResolvedValue([preparedPageImage()]);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      choosePageImageFiles,
      choosePreparedPageImageFiles,
      releasePreparedPageImages: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));

    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeVisible();
    expect(choosePageImageFiles).not.toHaveBeenCalled();
    expect(choosePreparedPageImageFiles).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    expect(await screen.findByRole("img", { name: "page-001.jpg" })).toBeVisible();
    expect(choosePreparedPageImageFiles).toHaveBeenCalledOnce();
    expect(choosePageImageFiles).not.toHaveBeenCalled();
  });

  it("uses the opaque PR 1-B import batch for a session-backed image project", async () => {
    const initialProject = normalizeProject(createEmptyProject("새 프로젝트", false));
    const savedProject = structuredClone(initialProject);
    savedProject.pageImages = [pageImage()];
    const dto = (project: typeof initialProject, dirty: boolean) => ({
      revision: 0,
      project,
      pendingPageImages: [],
      dirty,
      status: "active" as const
    });
    const choosePageImages = vi.fn().mockResolvedValue({
      importBatchId: "batch-1",
      images: [{
        preparedImageId: "prepared-1",
        importBatchId: "batch-1",
        originalFileName: "page-001.jpg",
        byteSize: 4,
        mimeType: "image/jpeg",
        previewToken: "preview-1"
      }]
    });
    const importPageImages = vi.fn().mockResolvedValue([{
      ok: true,
      pendingPageImage: {
        importBatchId: "batch-1",
        preparedImageId: "prepared-1",
        pageImageId: "pending-page-1",
        pageNumber: 1,
        originalFileName: "page-001.jpg",
        byteSize: 4,
        mimeType: "image/jpeg",
        previewToken: "preview-1"
      }
    }]);
    const releasePageImageImportBatch = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "session-1",
        project: dto(initialProject, false),
        encrypted: false
      }),
      applyProjectMutation: vi.fn().mockResolvedValue({
        status: "applied",
        revision: 0,
        project: dto(initialProject, false)
      }),
      saveProjectAs: vi.fn().mockResolvedValue({
        projectSessionId: "session-1",
        project: dto(initialProject, false)
      }),
      saveProject: vi.fn().mockResolvedValue({
        projectSessionId: "session-1",
        project: dto(savedProject, false)
      }),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      openProjectFromDialog: vi.fn(),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      rekeyProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      choosePageImages,
      releasePageImageImportBatch,
      importPageImages,
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));

    expect(await screen.findByRole("img", { name: "page-001.jpg" })).toHaveAttribute(
      "src",
      "translation-image://asset/preview-1"
    );
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeVisible();
    expect(choosePageImages).toHaveBeenCalledWith({ projectSessionId: "session-1" });
    expect(importPageImages).toHaveBeenCalledWith({
      projectSessionId: "session-1",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
    });
    expect(JSON.stringify(importPageImages.mock.calls)).not.toContain("sourcePath");
    expect(releasePageImageImportBatch).toHaveBeenCalledWith({
      projectSessionId: "session-1",
      importBatchId: "batch-1"
    });
  });

  function installSessionSetupApiWithModeTracking() {
    const harness = installSessionSetupApi();
    let sessionProject = structuredClone(harness.initialProject);
    let revision = 0;
    const applyProjectMutation = vi.fn(async (args: ApplyProjectMutationArgs) => {
      if (args.mutation.type === "update_project_settings") {
        sessionProject = {
          ...sessionProject,
          settings: { ...sessionProject.settings, ...args.mutation.patch }
        };
      }
      if (args.mutation.type === "set_project_title") {
        sessionProject = {
          ...sessionProject,
          metadata: { ...sessionProject.metadata, title: args.mutation.title }
        };
      }
      revision += 1;
      return {
        status: "applied" as const,
        revision,
        project: harness.dto(sessionProject, true, revision)
      };
    });
    harness.saveProjectAs.mockImplementation(async () => ({
      projectSessionId: "session-1",
      project: harness.dto(sessionProject, false, revision)
    }));
    harness.saveProject.mockImplementation(async () => ({
      projectSessionId: "session-1",
      project: harness.dto({ ...sessionProject, pageImages: harness.savedProject.pageImages }, false, revision)
    }));
    window.projectApi = {
      ...window.projectApi,
      applyProjectMutation
    };
    return { ...harness, applyProjectMutation, getSessionProject: () => sessionProject };
  }

  it("does not ask for Fast/Precise during session project creation", async () => {
    const harness = installSessionSetupApiWithModeTracking();
    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    expect(screen.queryByRole("radio", { name: /빠른 시작/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /세밀한 검토/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeVisible();
    expect(harness.applyProjectMutation.mock.calls.some(
      ([args]) => args.mutation.type === "update_project_settings" && "translationMode" in (args.mutation.patch ?? {})
    )).toBe(false);
    expect(harness.getSessionProject().settings).not.toHaveProperty("translationMode");
    expect(harness.saveProjectAs.mock.calls.length).toBeGreaterThan(0);
    expect(harness.saveProject).toHaveBeenCalled();
  });

  it("retries Save As without inventing a translationMode", async () => {
    const harness = installSessionSetupApiWithModeTracking();
    harness.saveProjectAs
      .mockReset()
      .mockRejectedValueOnce(new Error("save-as unavailable"))
      .mockImplementation(async () => ({
        projectSessionId: "session-1",
        project: harness.dto(harness.getSessionProject(), false)
      }));

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByText("프로젝트 저장 위치를 만들지 못했습니다. 다시 시도하세요.")).toBeVisible();
    expect(harness.getSessionProject().settings).not.toHaveProperty("translationMode");
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeVisible();
    expect(harness.getSessionProject().settings).not.toHaveProperty("translationMode");
  });

  it("keeps session project creation working when some images fail to import", async () => {
    const harness = installSessionSetupApiWithModeTracking();
    harness.importPageImages.mockResolvedValue([
      {
        ok: true,
        pendingPageImage: {
          importBatchId: "batch-1",
          preparedImageId: "prepared-1",
          pageImageId: "pending-page-1",
          pageNumber: 1,
          originalFileName: "page-001.jpg",
          byteSize: 4,
          mimeType: "image/jpeg",
          previewToken: "preview-1"
        }
      },
      {
        ok: false,
        message: "두 번째 이미지를 연결하지 못했습니다."
      }
    ]);

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await findWorkStatus("이미지 1개를 불러왔고 1개를 불러오지 못했습니다.")).toBeInTheDocument();
    expect(harness.getSessionProject().settings).not.toHaveProperty("translationMode");
  });

  it("does not write translationMode in session or legacy project creation", () => {
    expect(appSource).not.toContain("translationMode: projectSetup.mode");
  });

  it("keeps the Setup draft after Save As rejects and retries without an unhandled rejection", async () => {
    const harness = installSessionSetupApi();
    harness.saveProjectAs
      .mockReset()
      .mockRejectedValueOnce(new Error("save-as unavailable"))
      .mockResolvedValueOnce({
        projectSessionId: "session-1",
        project: harness.dto(harness.initialProject, false)
      });
    const unhandledRejection = vi.fn();
    window.addEventListener("unhandledrejection", unhandledRejection);

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByText("프로젝트 저장 위치를 만들지 못했습니다. 다시 시도하세요.")).toBeVisible();
    expect(screen.getByRole("img", { name: "page-001.jpg" })).toBeVisible();
    expect(harness.importPageImages).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });

    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeVisible();
    expect(harness.saveProjectAs).toHaveBeenCalledTimes(2);
    expect(harness.importPageImages).toHaveBeenCalledOnce();
    expect(unhandledRejection).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandledRejection);
  });

  it("resumes sequential opaque imports after a later batch rejects without repeating Save As", async () => {
    const choosePageImages = vi.fn()
      .mockResolvedValueOnce({
        importBatchId: "batch-1",
        images: [{
          preparedImageId: "prepared-1",
          importBatchId: "batch-1",
          originalFileName: "page-001.jpg",
          byteSize: 4,
          mimeType: "image/jpeg",
          previewToken: "preview-1"
        }]
      })
      .mockResolvedValueOnce({
        importBatchId: "batch-2",
        images: [{
          preparedImageId: "prepared-2",
          importBatchId: "batch-2",
          originalFileName: "page-002.jpg",
          byteSize: 4,
          mimeType: "image/jpeg",
          previewToken: "preview-2"
        }]
      });
    const successfulImport = (batchId: string, preparedImageId: string, pageNumber: number) => [{
      ok: true,
      pendingPageImage: {
        importBatchId: batchId,
        preparedImageId,
        pageImageId: `pending-${pageNumber}`,
        pageNumber,
        originalFileName: `page-${String(pageNumber).padStart(3, "0")}.jpg`,
        byteSize: 4,
        mimeType: "image/jpeg",
        previewToken: `preview-${pageNumber}`
      }
    }];
    const importPageImages = vi.fn()
      .mockResolvedValueOnce(successfulImport("batch-1", "prepared-1", 1))
      .mockRejectedValueOnce(new Error("second batch failed"))
      .mockResolvedValueOnce(successfulImport("batch-1", "prepared-1", 1))
      .mockResolvedValueOnce(successfulImport("batch-2", "prepared-2", 2));
    const harness = installSessionSetupApi({ choosePageImages, importPageImages });

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-002.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByText("이미지 연결 중 실패했습니다. 이미 연결된 항목은 유지됩니다.")).toBeVisible();
    expect(harness.saveProjectAs).toHaveBeenCalledOnce();
    expect(harness.saveProject).not.toHaveBeenCalled();
    expect(harness.releasePageImageImportBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeVisible();
    expect(harness.saveProjectAs).toHaveBeenCalledOnce();
    expect(importPageImages).toHaveBeenCalledTimes(4);
    expect(importPageImages.mock.calls.map(([args]) => args.importBatchId)).toEqual([
      "batch-1",
      "batch-2",
      "batch-1",
      "batch-2"
    ]);
  });

  it("keeps imported Main state after final save rejects and completes on retry", async () => {
    const harness = installSessionSetupApi();
    harness.saveProject
      .mockReset()
      .mockRejectedValueOnce(new Error("final save unavailable"))
      .mockResolvedValueOnce({
        projectSessionId: "session-1",
        project: harness.dto(harness.savedProject, false, 1)
      });

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByText("이미지 연결 후 최종 저장에 실패했습니다. 다시 저장할 수 있습니다.")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeVisible();
    expect(harness.releasePageImageImportBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeVisible();
    expect(harness.saveProjectAs).toHaveBeenCalledOnce();
    expect(harness.importPageImages).toHaveBeenCalledTimes(2);
    expect(harness.saveProject).toHaveBeenCalledTimes(2);
    expect(harness.releasePageImageImportBatch).toHaveBeenCalledOnce();
  });

  it("abandons a session-backed Setup with Escape while initial Save As is pending", async () => {
    const pendingSaveAs = deferred<ReturnType<ReturnType<typeof installSessionSetupApi>["dto"]> extends never ? never : unknown>();
    const saveProjectAs = vi.fn().mockReturnValue(pendingSaveAs.promise);
    const harness = installSessionSetupApi({ saveProjectAs });
    const createProjectSession = window.projectApi!.createProjectSession as ReturnType<typeof vi.fn>;
    createProjectSession
      .mockReset()
      .mockResolvedValueOnce({
        projectSessionId: "session-1",
        project: harness.dto(harness.initialProject, false),
        encrypted: false
      })
      .mockResolvedValueOnce({
        projectSessionId: "session-2",
        project: harness.dto(harness.initialProject, false),
        encrypted: false
      });

    renderApp();
    await waitFor(() => expect(createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));
    await waitFor(() => expect(saveProjectAs).toHaveBeenCalledOnce());

    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByRole("heading", { name: "번역 프로젝트" })).toBeVisible();
    await act(async () => {
      pendingSaveAs.resolve({
        projectSessionId: "session-1",
        project: harness.dto(harness.initialProject, false)
      });
      await pendingSaveAs.promise;
    });

    await waitFor(() => expect(createProjectSession).toHaveBeenCalledTimes(2));
    expect(window.projectApi!.closeProject).toHaveBeenCalledWith({ projectSessionId: "session-1" });
    expect(harness.importPageImages).not.toHaveBeenCalled();
    expect(screen.queryByTestId("focus-deck-shell")).not.toBeInTheDocument();
  });

  it("does not continue to final save or install Workspace after Cancel during opaque import", async () => {
    const pendingImport = deferred<Awaited<ReturnType<NonNullable<NonNullable<typeof window.projectApi>["importPageImages"]>>>>();
    const harness = installSessionSetupApi({
      importPageImages: vi.fn().mockReturnValue(pendingImport.promise)
    });
    const createProjectSession = window.projectApi!.createProjectSession as ReturnType<typeof vi.fn>;
    createProjectSession
      .mockReset()
      .mockResolvedValueOnce({
        projectSessionId: "session-1",
        project: harness.dto(harness.initialProject, false),
        encrypted: false
      })
      .mockResolvedValueOnce({
        projectSessionId: "session-2",
        project: harness.dto(harness.initialProject, false),
        encrypted: false
      });

    renderApp();
    await waitFor(() => expect(window.projectApi!.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));
    await waitFor(() => expect(harness.importPageImages).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(await screen.findByRole("heading", { name: "번역 프로젝트" })).toBeVisible();
    await act(async () => {
      pendingImport.resolve([{
        ok: true,
        pendingPageImage: {
          importBatchId: "batch-1",
          preparedImageId: "prepared-1",
          pageImageId: "pending-page-1",
          pageNumber: 1,
          originalFileName: "page-001.jpg",
          byteSize: 4,
          mimeType: "image/jpeg",
          previewToken: "preview-1"
        }
      }]);
      await pendingImport.promise;
    });

    expect(harness.saveProject).not.toHaveBeenCalled();
    expect(screen.queryByTestId("focus-deck-shell")).not.toBeInTheDocument();
    expect(harness.releasePageImageImportBatch).toHaveBeenCalledWith({
      projectSessionId: "session-1",
      importBatchId: "batch-1"
    });
    await waitFor(() => expect(createProjectSession).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await waitFor(() => expect(harness.choosePageImages).toHaveBeenLastCalledWith({
      projectSessionId: "session-2"
    }));
  });

  it("does not install a late final session save after Setup is canceled", async () => {
    const pendingFinalSave = deferred<Awaited<ReturnType<NonNullable<NonNullable<typeof window.projectApi>["saveProject"]>>>>();
    const harness = installSessionSetupApi({
      saveProject: vi.fn().mockReturnValue(pendingFinalSave.promise)
    });

    renderApp();
    await waitFor(() => expect(window.projectApi!.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));
    await waitFor(() => expect(harness.saveProject).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(await screen.findByRole("heading", { name: "번역 프로젝트" })).toBeVisible();
    await act(async () => {
      pendingFinalSave.resolve({
        projectSessionId: "session-1",
        project: harness.dto(harness.savedProject, false, 1)
      });
      await pendingFinalSave.promise;
    });

    expect(screen.queryByTestId("focus-deck-shell")).not.toBeInTheDocument();
    expect(window.projectApi!.closeProject).toHaveBeenCalledWith({ projectSessionId: "session-1" });
  });

  it("releases prepared previews when Setup is canceled and returns Home", async () => {
    const releasePreparedPageImages = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      choosePreparedPageImageFiles: vi.fn().mockResolvedValue([preparedPageImage()]),
      releasePreparedPageImages
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));

    expect(await screen.findByRole("heading", { name: "번역 프로젝트" })).toBeVisible();
    expect(releasePreparedPageImages).toHaveBeenCalledWith(["prepared-page-1"]);
  });

  it("keeps the Setup draft when save selection is canceled", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue(null),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      choosePreparedPageImageFiles: vi.fn().mockResolvedValue([preparedPageImage()]),
      releasePreparedPageImages: vi.fn(),
      importPageImages: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByText("프로젝트 만들기를 취소했습니다.")).toBeVisible();
    expect(screen.getByRole("img", { name: "page-001.jpg" })).toBeVisible();
    expect(screen.queryByRole("radio", { name: /빠른 시작/ })).not.toBeInTheDocument();
    expect(window.projectApi.releasePreparedPageImages).not.toHaveBeenCalled();
  });

  it("does not install a late project result after Setup is canceled", async () => {
    const savePath = deferred<string | null>();
    const saveProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockReturnValue(savePath.promise),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject,
      choosePreparedPageImageFiles: vi.fn().mockResolvedValue([preparedPageImage()]),
      releasePreparedPageImages: vi.fn().mockResolvedValue(undefined),
      importPageImages: vi.fn().mockResolvedValue([{ ok: true, pageImage: pageImage() }]),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.getByRole("heading", { name: "번역 프로젝트" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toHaveFocus();

    savePath.resolve("C:\\projects\\Late.ctp");
    await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeVisible();
    expect(screen.queryByTestId("focus-deck-shell")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("creates an image project from Setup and installs the Workspace", async () => {
    const prepared = preparedPageImage();
    const saveProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject,
      choosePreparedPageImageFiles: vi.fn().mockResolvedValue([prepared]),
      releasePreparedPageImages: vi.fn().mockResolvedValue(undefined),
      importPageImages: vi.fn().mockResolvedValue([{ ok: true, pageImage: pageImage() }]),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-001.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeVisible();
    expect(screen.getByTestId("focus-deck-shell")).toBeInTheDocument();
    expect(saveProject).toHaveBeenCalledTimes(2);
    expect(window.projectApi.importPageImages).toHaveBeenCalledWith({
      projectFilePath: "C:\\projects\\Book.ctp",
      files: [{ sourcePath: prepared.sourcePath, pageNumber: 1 }]
    });
    const recentProject = JSON.parse(
      window.localStorage.getItem("translation-editor:recent-projects:v1") ?? "[]"
    )[0];
    expect(recentProject).toEqual(
      expect.objectContaining({ recentProjectId: expect.any(String), title: "새 프로젝트" })
    );
    expect(recentProject).not.toHaveProperty("filePath");
  });

  it("uses getPathForFile and preparePageImageFiles for dropped browser files", async () => {
    const preparePageImageFiles = vi.fn().mockResolvedValue([preparedPageImage({ fileName: "dropped.png" })]);
    const droppedFile = new File(["page"], "dropped.png", { type: "image/png" });
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      getPathForFile: vi.fn().mockReturnValue("C:\\images\\dropped.png"),
      preparePageImageFiles,
      releasePreparedPageImages: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.drop(await screen.findByTestId("project-image-drop-zone"), { dataTransfer: { files: [droppedFile] } });

    expect(await screen.findByRole("img", { name: "dropped.png" })).toBeVisible();
    expect(window.projectApi.getPathForFile).toHaveBeenCalledWith(droppedFile);
    expect(preparePageImageFiles).toHaveBeenCalledWith(["C:\\images\\dropped.png"]);
  });

  it("opens an empty saved legacy project in the shared Workspace", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([], [])),
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    expect(await screen.findByText("만화 원본 이미지를 여기에 드롭하세요")).toBeVisible();
    expect(screen.getByTestId("focus-deck-shell")).toBeInTheDocument();
  });

  it("keeps Setup when a pending Open resolves after New starts", async () => {
    const pendingOpen = deferred<ReturnType<typeof openedProjectWithImages> | null>();
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockReturnValue(pendingOpen.promise),
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toHaveFocus();

    await act(async () => {
      pendingOpen.resolve(namedOpenedProject("C:\\projects\\Late.ctp", "Late", "Late line"));
      await pendingOpen.promise;
    });

    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeVisible();
    expect(screen.queryByDisplayValue("Late line")).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("translation-editor:recent-projects:v1") ?? "[]")).toEqual([]);
  });

  it("keeps the newer Open result and history when Opens settle out of order", async () => {
    const openA = deferred<ReturnType<typeof openedProjectWithImages> | null>();
    const openB = deferred<ReturnType<typeof openedProjectWithImages> | null>();
    const resultA = namedOpenedProject("C:\\projects\\A.ctp", "A", "Project A line");
    const resultB = namedOpenedProject("C:\\projects\\B.ctp", "B", "Project B line");
    const openProject = vi.fn()
      .mockReturnValueOnce(openA.promise)
      .mockReturnValueOnce(openB.promise);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject,
      saveProject: vi.fn()
    };

    renderApp();
    const openButton = screen.getByRole("button", { name: "기존 프로젝트 열기" });
    fireEvent.click(openButton);
    await waitFor(() => expect(openProject).toHaveBeenCalledTimes(1));
    fireEvent.click(openButton);
    await waitFor(() => expect(openProject).toHaveBeenCalledTimes(2));

    await act(async () => {
      openB.resolve(resultB);
      await openB.promise;
    });
    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("Project B line")).toBeVisible();

    await act(async () => {
      openA.resolve(resultA);
      await openA.promise;
    });

    expect(screen.getByDisplayValue("Project B line")).toBeVisible();
    expect(screen.queryByDisplayValue("Project A line")).not.toBeInTheDocument();
    expect(screen.getByText("C:\\projects\\B.ctp")).toBeVisible();
    const recentProjects = JSON.parse(
      window.localStorage.getItem("translation-editor:recent-projects:v1") ?? "[]"
    );
    expect(recentProjects).toEqual([
      expect.objectContaining({ recentProjectId: expect.any(String), title: "B" })
    ]);
    expect(recentProjects[0]).not.toHaveProperty("filePath");
  });

  it("does not prompt for a password from an Open invalidated by New", async () => {
    const pendingOpen = deferred<{ filePath: string; passwordRequired: true } | null>();
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockReturnValue(pendingOpen.promise),
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));

    await act(async () => {
      pendingOpen.resolve({ filePath: "C:\\projects\\Secret.ctp", passwordRequired: true });
      await pendingOpen.promise;
    });

    expect(screen.queryByRole("dialog", { name: "시크릿 프로젝트 암호" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("프로젝트 암호")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeVisible();
  });

  it("keeps a secret recent card retryable after a wrong password and opens it on the second attempt", async () => {
    const recent = { recentProjectId: "secret-recent", title: "Secret", openedAt: "2026-09-01T00:00:00.000Z" };
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const secretProject = normalizeProject(createEmptyProject("Secret", true));
    secretProject.dialogueLines = [{
      ...rendererLine("secret-line", 1, "Secret opened"),
      origin: { kind: "manual" }
    }];
    const dto = (project: typeof initialProject, revision = 0) => ({
      revision, project, pendingPageImages: [] as [], dirty: false, status: "active" as const
    });
    const openRecentProject = vi.fn()
      .mockResolvedValueOnce({ passwordRequired: true, unlockToken: "unlock-1" })
      .mockResolvedValueOnce({ passwordRequired: true, unlockToken: "unlock-2" });
    const unlockProject = vi.fn()
      .mockResolvedValueOnce({
        openFailed: true,
        code: "INVALID_PASSWORD",
        retryable: true,
        message: "암호가 올바르지 않습니다. 다시 입력하세요."
      })
      .mockResolvedValueOnce({
        projectSessionId: "secret-session",
        project: dto(secretProject, 1),
        encrypted: true,
        recentProject: recent
      });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session", project: dto(initialProject), encrypted: false
      }),
      openProjectFromDialog: vi.fn(), openRecentProject, unlockProject,
      applyProjectMutation: vi.fn(), saveProject: vi.fn(), saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([recent]), removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };

    renderApp();
    const recentButton = await screen.findByRole("button", { name: "최근 프로젝트 Secret 열기" });
    fireEvent.click(recentButton);
    await answerAppPrompt("wrong");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("암호가 올바르지 않습니다"));
    expect(screen.getByRole("button", { name: "최근 프로젝트 Secret 열기" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "최근 프로젝트 Secret 열기" }));
    await answerAppPrompt("correct");
    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("Secret opened")).toBeVisible();
    expect(unlockProject).toHaveBeenNthCalledWith(1, { unlockToken: "unlock-1", password: "wrong" });
    expect(unlockProject).toHaveBeenNthCalledWith(2, { unlockToken: "unlock-2", password: "correct" });
  });

  it("marks only missing recent projects unavailable and leaves busy failures retryable", async () => {
    const missing = { recentProjectId: "missing-recent", title: "Missing", openedAt: "2026-09-01T00:00:00.000Z" };
    const busy = { recentProjectId: "busy-recent", title: "Busy", openedAt: "2026-08-31T00:00:00.000Z" };
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const dto = { revision: 0, project: initialProject, pendingPageImages: [] as [], dirty: false, status: "active" as const };
    const openRecentProject = vi.fn(({ recentProjectId }: { recentProjectId: string }) => Promise.resolve(
      recentProjectId === missing.recentProjectId
        ? { openFailed: true as const, code: "PROJECT_FILE_NOT_FOUND" as const, retryable: false, message: "최근 프로젝트 파일이 이동되었거나 삭제되었습니다." }
        : { openFailed: true as const, code: "PROJECT_BUSY" as const, retryable: true, message: "프로젝트의 이미지 복구 작업이 진행 중입니다. 잠시 후 다시 시도하세요." }
    ));
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto, encrypted: false }),
      openProjectFromDialog: vi.fn(), openRecentProject, unlockProject: vi.fn(),
      applyProjectMutation: vi.fn(), saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined), listRecentProjects: vi.fn().mockResolvedValue([missing, busy]),
      removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "최근 프로젝트 Missing 열기" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "최근 프로젝트 Missing 열기" })).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "최근 프로젝트 Busy 열기" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("이미지 복구 작업이 진행 중"));
    expect(screen.getByRole("button", { name: "최근 프로젝트 Busy 열기" })).toBeEnabled();
  });

  it("Task 8 user path: removes a recent project from Home after its file is unavailable", async () => {
    const recentProjectId = "recent-missing";
    window.localStorage.setItem(
      "translation-editor:recent-projects:v1",
      JSON.stringify([{ recentProjectId, title: "Missing", openedAt: "2026-07-17T00:00:00.000Z" }])
    );
    const openProject = vi.fn().mockRejectedValue(new Error("missing"));
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject,
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "최근 프로젝트 Missing 열기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("파일이 이동되었거나 삭제되었을 수 있습니다");
    expect(openProject).toHaveBeenCalledWith({ filePath: recentProjectId });
    fireEvent.click(screen.getByRole("button", { name: "Missing 최근 목록에서 제거" }));
    expect(screen.getByRole("heading", { name: "최근 프로젝트 없음" })).toBeVisible();
    expect(screen.getByRole("button", { name: "빈 상태에서 기존 .ctp 프로젝트 선택" })).toBeVisible();
    expect(JSON.parse(window.localStorage.getItem("translation-editor:recent-projects:v1") ?? "[]")).toEqual([]);
  });

  it("saves a trimmed Gemini API key and clears the password input", async () => {
    const getGeminiApiKeyStatus = vi.fn().mockResolvedValue(noKeyStatus);
    const setGeminiApiKey = vi.fn().mockResolvedValue(encryptedStatus);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      getGeminiApiKeyStatus,
      setGeminiApiKey
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();
    openSettings();

    expect(await screen.findByText("Gemini API 키 미설정")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Gemini API 키"), { target: { value: "  test-gemini-key  " } });
    fireEvent.click(screen.getByRole("button", { name: "Gemini 키 적용" }));

    await waitFor(() => {
      expect(setGeminiApiKey).toHaveBeenCalledWith({ apiKey: "test-gemini-key" });
    });
    expect(screen.getByLabelText("Gemini API 키")).toHaveValue("");
    expect(await screen.findAllByText("Gemini API 키 암호화 저장됨")).toHaveLength(2);
  });

  it("shows the environment key status after clearing a stored key", async () => {
    const clearGeminiApiKey = vi.fn().mockResolvedValue(environmentStatus);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      getGeminiApiKeyStatus: vi.fn().mockResolvedValue(encryptedStatus),
      clearGeminiApiKey
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();
    openSettings();
    expect(await screen.findByText("Gemini API 키 암호화 저장됨")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "키 삭제" }));

    await waitFor(() => {
      expect(clearGeminiApiKey).toHaveBeenCalled();
    });
    expect(await screen.findAllByText("환경변수의 Gemini API 키 사용 중")).toHaveLength(2);
  });

  it("keeps the configured status when clearing the Gemini API key fails", async () => {
    const clearGeminiApiKey = vi.fn().mockRejectedValue(new Error("Gemini API 키를 삭제할 수 없습니다."));
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      getGeminiApiKeyStatus: vi.fn().mockResolvedValue(encryptedStatus),
      clearGeminiApiKey
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();
    openSettings();
    expect(await screen.findByText("Gemini API 키 암호화 저장됨")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "키 삭제" }));

    expect(await screen.findByText("Gemini API 키를 삭제할 수 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("Gemini API 키 암호화 저장됨")).toBeInTheDocument();
  });

  it("reviews and applies Production OCR candidates without Cloud OCR", async () => {
    const geminiExtraction = {
      pageNumber: 1,
      speechBubbles: [
        {
          id: "bubble-001",
          type: "speech_bubble" as const,
          text: "こんにちは",
          language: "ja" as const,
          bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
          readingOrder: 1,
          confidence: 0.92,
          notes: ""
        }
      ],
      nonSpeechText: [],
      warnings: []
    };
    const validatedExtraction = {
      pageNumber: 1,
      speechBubbles: [
        {
          id: "bubble-001",
          type: "thought_bubble" as const,
          text: "考え中",
          language: "ja" as const,
          bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
          readingOrder: 1,
          confidence: 0.91,
          notes: "inner monologue",
          speakerCandidates: [
            { speaker: "Mika", confidence: 0.82, reason: "tail points to Mika" },
            { speaker: "Ren", confidence: 0.61, reason: "Ren is nearby but tail is unclear" },
            { speaker: "unknown", confidence: 0.2, reason: "face is cropped" }
          ]
        },
        {
          id: "bubble-002",
          type: "filtered_speech" as const,
          text: "ザザ...聞こえる?",
          language: "ja" as const,
          bbox: { x: 0.2, y: 0.4, width: 0.3, height: 0.1 },
          readingOrder: 2,
          confidence: 0.72,
          notes:
            'radio Crop ReOCR applied: reduced uncertainty from "Za[?]" to "Zaza"; crop confidence 0.84.',
          speakerCandidates: [{ speaker: "unknown", confidence: 0.42, reason: "radio voice has no visible speaker" }]
        }
      ],
      nonSpeechText: [
        {
          type: "narration_box" as const,
          text: "翌朝",
          bbox: { x: 0.1, y: 0.05, width: 0.4, height: 0.08 },
          confidence: 0.88,
          notes: "box",
          readingOrder: 3,
          speakerCandidates: [{ speaker: "Narrator", confidence: 0.78, reason: "boxed narration" }]
        },
        {
          type: "screen_text" as const,
          text: "CALL",
          bbox: { x: 0.7, y: 0.2, width: 0.1, height: 0.08 },
          confidence: 0.81,
          notes: "phone",
          readingOrder: 4,
          speakerCandidates: []
        }
      ],
      warnings: ['확인 필요 영역 있음', 'Crop ReOCR disagreement for #2: whole image "A" vs crop "B".']
    };
    const extractSpeechBubbles = vi.fn().mockResolvedValue(validatedExtraction);
    const validateSpeechBubbles = vi.fn().mockResolvedValue(validatedExtraction);
    const existingLine: DialogueLine = {
      id: "existing-line",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "Existing line",
      parseConfidence: 0.95,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()], [existingLine])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      extractSpeechBubbles,
      validateSpeechBubbles
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));

    await waitFor(() => {
      expect(extractSpeechBubbles).toHaveBeenCalledWith({
        pageImageId: "page-image-1",
        projectSessionId: "ocr-test-session",
        requestId: expect.any(String),
        sourceSha256: "a".repeat(64)
      });
    });
    expect(validateSpeechBubbles).not.toHaveBeenCalled();

    expect(await screen.findByLabelText("1페이지 말풍선 OCR 검토")).toBeInTheDocument();
    expect(screen.getByText("OCR 확인", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.queryByLabelText("thought_bubble 1 화자")).not.toBeInTheDocument();
    expect(screen.getByLabelText("thought_bubble 1 적용")).toBeChecked();
    expect(screen.getByLabelText("filtered_speech 2 적용")).toBeChecked();
    expect(screen.getByLabelText("narration_box 3 적용")).not.toBeChecked();

    fireEvent.click(screen.getByLabelText("narration_box 3 적용"));
    fireEvent.click(screen.getByRole("button", { name: /^narration_box 3 검토:/ }));
    fireEvent.change(screen.getByLabelText("narration_box 3 원문"), { target: { value: "翌朝、駅で" } });
    fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));

    expect(screen.getByText("화자 확인", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
    fireEvent.click(screen.getByRole("button", { name: /^thought_bubble 1 검토:/ }));
    expect(screen.getByRole("button", { name: "Mika 82%" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ren 61%" }));
    fireEvent.click(screen.getByRole("button", { name: /^narration_box 3 검토:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Narrator 78%" }));
    fireEvent.click(screen.getByRole("button", { name: /^filtered_speech 2 검토:/ }));
    fireEvent.change(screen.getByLabelText("filtered_speech 2 화자"), { target: { value: "Radio" } });
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));

    expect(await screen.findByText("번역 수정", { selector: "li strong" })).toBeInTheDocument();
    openFullDialogueTable();
    expect(screen.getByText("번역 수정", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByDisplayValue("考え中")).toBeInTheDocument();
    expect(screen.getByDisplayValue("ザザ...聞こえる?")).toBeInTheDocument();
    expect(screen.getByDisplayValue("翌朝、駅で")).toBeInTheDocument();

    fireEvent.click(screen.getByDisplayValue("考え中"));
    fireEvent.click(screen.getByText("라인 메타"));
    expect(screen.getByLabelText("라인 화자")).toHaveValue("Ren");
    expect(screen.getByLabelText("파서 경고")).toHaveValue("");

    fireEvent.click(screen.getByDisplayValue("ザザ...聞こえる?"));
    expect(screen.getByLabelText("라인 화자")).toHaveValue("Radio");

    fireEvent.click(screen.getByDisplayValue("翌朝、駅で"));
    fireEvent.click(screen.getByText("라인 메타"));
    expect(screen.getByLabelText("라인 화자")).toHaveValue("Narrator");
    expect(screen.getByLabelText("라인 유형")).toHaveValue("narration");

    fireEvent.click(screen.getByDisplayValue("ザザ...聞こえる?"));
    expect(screen.getByLabelText("상세 메모")).toHaveValue(
      'radio Crop ReOCR applied: reduced uncertainty from "Za[?]" to "Zaza"; crop confidence 0.84.'
    );
    expect(screen.getByLabelText("파서 경고")).toHaveValue("");
  });

  it("uses Ctrl+Enter to apply the OCR review exactly once without triggering unrelated actions", async () => {
    const extractSpeechBubbles = vi.fn().mockResolvedValue(validatedReviewExtraction());
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      extractSpeechBubbles,
      validateSpeechBubbles: vi.fn().mockResolvedValue(validatedReviewExtraction())
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));

    const applyButton = await screen.findByRole("button", { name: "OCR 적용 · 화자 확인" });
    const cancelButton = screen.getByRole("button", { name: "닫기" });
    const closeButton = screen.getByRole("button", { name: "말풍선 OCR 검토 닫기" });
    const applyClick = vi.spyOn(applyButton, "click");
    const cancelClick = vi.spyOn(cancelButton, "click");
    const closeClick = vi.spyOn(closeButton, "click");
    const applyEvent = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true });
    const preventDefault = vi.spyOn(applyEvent, "preventDefault");

    act(() => {
      window.dispatchEvent(applyEvent);
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(applyClick).toHaveBeenCalledOnce();
    expect(cancelClick).not.toHaveBeenCalled();
    expect(closeClick).not.toHaveBeenCalled();
    expect(extractSpeechBubbles).toHaveBeenCalledOnce();
    expect(screen.getByText("화자 확인", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("uses Ctrl+Enter to apply the speaker review exactly once without triggering unrelated actions", async () => {
    const extractSpeechBubbles = vi.fn().mockResolvedValue(validatedReviewExtraction());
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      extractSpeechBubbles,
      validateSpeechBubbles: vi.fn().mockResolvedValue(validatedReviewExtraction())
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    fireEvent.click(await screen.findByRole("button", { name: "OCR 적용 · 화자 확인" }));

    const applyButton = screen.getByRole("button", { name: "화자 적용 · 번역 수정" });
    const backButton = screen.getByRole("button", { name: "이전 단계" });
    const cancelButton = screen.getByRole("button", { name: "닫기" });
    const candidateButton = screen.getByRole("button", { name: "Mika 82%" });
    const applyClick = vi.spyOn(applyButton, "click");
    const backClick = vi.spyOn(backButton, "click");
    const cancelClick = vi.spyOn(cancelButton, "click");
    const candidateClick = vi.spyOn(candidateButton, "click");
    const applyEvent = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true });
    const preventDefault = vi.spyOn(applyEvent, "preventDefault");

    act(() => {
      window.dispatchEvent(applyEvent);
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(applyClick).toHaveBeenCalledOnce();
    expect(backClick).not.toHaveBeenCalled();
    expect(cancelClick).not.toHaveBeenCalled();
    expect(candidateClick).not.toHaveBeenCalled();
    expect(extractSpeechBubbles).toHaveBeenCalledOnce();
    await waitFor(() => expect(
      screen.getByText("번역 수정", { selector: "li strong" }).closest("li")
    ).toHaveAttribute("aria-current", "step"));
  });

  it("keeps review items independent when OCR returns duplicate bubble ids", async () => {
    const geminiExtraction = {
      pageNumber: 1,
      speechBubbles: [],
      nonSpeechText: [],
      warnings: []
    };
    const validatedExtraction = {
      pageNumber: 1,
      speechBubbles: [
        {
          id: "duplicate-bubble",
          type: "speech_bubble" as const,
          text: "First bubble",
          language: "en" as const,
          bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
          readingOrder: 1,
          confidence: 0.92,
          notes: ""
        },
        {
          id: "duplicate-bubble",
          type: "thought_bubble" as const,
          text: "Second bubble",
          language: "en" as const,
          bbox: { x: 0.4, y: 0.1, width: 0.2, height: 0.1 },
          readingOrder: 2,
          confidence: 0.9,
          notes: ""
        }
      ],
      nonSpeechText: [],
      warnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      extractSpeechBubbles: vi.fn().mockResolvedValue(validatedExtraction),
      validateSpeechBubbles: vi.fn().mockResolvedValue(validatedExtraction)
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    expect(await screen.findByLabelText("1페이지 말풍선 OCR 검토")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("speech_bubble 1 적용"));
    fireEvent.change(screen.getByLabelText("speech_bubble 1 원문"), { target: { value: "Edited first bubble" } });

    expect(screen.getByLabelText("speech_bubble 1 적용")).not.toBeChecked();
    expect(screen.getByLabelText("thought_bubble 2 적용")).toBeChecked();
    expect(screen.getByLabelText("speech_bubble 1 원문")).toHaveValue("Edited first bubble");
    fireEvent.click(screen.getByRole("button", { name: /^thought_bubble 2 검토:/ }));
    expect(screen.getByLabelText("thought_bubble 2 원문")).toHaveValue("Second bubble");

    fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));

    fireEvent.click(await screen.findByRole("button", { name: "결과 및 진행 열기" }));
    const queue = await screen.findByRole("list", { name: "대사 작업 큐" });
    const retainedLine = await within(queue).findByRole("button", { name: /Second bubble/ });
    fireEvent.click(retainedLine);
    openFullDialogueTable();
    expect(await screen.findByLabelText("원문 2")).toHaveValue("Second bubble");
    expect(screen.queryByDisplayValue("Edited first bubble")).not.toBeInTheDocument();
  });

  it("moves the active OCR highlight to the first retained item at the speaker transition", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      extractSpeechBubbles: vi.fn().mockResolvedValue(validatedReviewExtraction()),
      validateSpeechBubbles: vi.fn().mockResolvedValue(validatedReviewExtraction())
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    expect(await screen.findByLabelText("1페이지 말풍선 OCR 검토")).toBeInTheDocument();
    expect(await screen.findByLabelText("선택된 OCR 영역")).toHaveTextContent("OCR 후보 #1");

    fireEvent.click(screen.getByLabelText("speech_bubble 1 적용"));
    fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));

    expect(screen.getByText("화자 확인", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByLabelText("선택된 OCR 영역")).toHaveTextContent("OCR 후보 #2");
    expect(screen.getByLabelText("선택된 OCR 영역")).toHaveStyle({
      left: "40%",
      top: "30%",
      width: "25%",
      height: "12%"
    });
  });

  it("closes and reopens the inpainting editor without losing the current page mask draft", async () => {
    const restoredMaskPixels = vi.fn<(imageData: ImageData) => void>();
    mockCanvasForInpainting(true, restoredMaskPixels);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      inpaintPageImage: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));

    expect(await screen.findByLabelText("1페이지 인페인팅 편집기")).toBeInTheDocument();
    expect(screen.getByText("1페이지 인페인팅")).toBeInTheDocument();
    const targetImage = screen.getByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(screen.getByTestId("semantic-overlay-inpainting-mask:active")).toBeInTheDocument();
    const maskBounds = screen.getByTestId("semantic-overlay-inpainting-mask:active").getAttribute("style");
    fireEvent.click(screen.getByRole("button", { name: "인스펙터에서 이미지로 돌아가기" }));
    expect(screen.queryByLabelText("1페이지 인페인팅 편집기")).not.toBeInTheDocument();
    // App hides the overlay while this tool is closed; the actual draft must
    // restore both its pixels and bounds when the user opens it again below.
    expect(screen.queryByTestId("semantic-overlay-inpainting-mask:active")).not.toBeInTheDocument();
    expect(screen.getByAltText("1페이지 이미지")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const reopenedTargetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    restoredMaskPixels.mockClear();
    fireEvent.load(reopenedTargetImage);
    expect(restoredMaskPixels).toHaveBeenCalledOnce();
    expect(restoredMaskPixels.mock.calls[0]?.[0].data[3]).toBe(255);
    expect(screen.getByTestId("semantic-overlay-inpainting-mask:active")).toHaveAttribute("style", maskBounds);
    expect(screen.getByRole("button", { name: /OpenAI/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Gemini/ })).toBeEnabled();
    expect(window.projectApi.inpaintPageImage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "계속 이동하면 미적용 OCR 검토 초안, 배경 마스크 또는 글자 배치 초안과 저장하지 않은 프로젝트 변경사항이 사라집니다."
    );
    await answerAppConfirmation("계속 편집");
    expect(screen.getByTestId("semantic-overlay-inpainting-mask:active")).toHaveAttribute("style", maskBounds);
    expect(window.projectApi.openProject).toHaveBeenCalledOnce();
    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
  });

  it("restores each page mask draft after navigation without carrying it onto another page", async () => {
    mockCanvasForInpainting(true);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([
        pageImage(),
        pageImage({ id: "page-image-2", pageNumber: 2, storedRelativePath: "Book-assets/images/page-002.jpg" })
      ])),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page"),
      importPageImages: vi.fn(),
      inpaintPageImage: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(screen.getByTestId("semantic-overlay-inpainting-mask:active")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByAltText("2페이지 이미지");
    expect(screen.queryByTestId("semantic-overlay-inpainting-mask:active")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const secondTarget = await screen.findByAltText("2페이지 인페인팅 대상");
    fireEvent.load(secondTarget);
    const secondMask = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(secondMask, { pointerId: 2, clientX: 40, clientY: 30 });
    fireEvent.pointerUp(secondMask, { pointerId: 2, clientX: 40, clientY: 30 });
    expect(screen.getByTestId("semantic-overlay-inpainting-mask:active")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const reopenedTargetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(reopenedTargetImage);
    expect(screen.getByTestId("semantic-overlay-inpainting-mask:active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OpenAI/ })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    fireEvent.load(await screen.findByAltText("2페이지 인페인팅 대상"));
    expect(screen.getByTestId("semantic-overlay-inpainting-mask:active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OpenAI/ })).toBeEnabled();
    expect(window.projectApi.inpaintPageImage).not.toHaveBeenCalled();
  });

  it("applies a successful inpainting result to the current page image", async () => {
    mockCanvasForInpainting();
    const replacementImage = pageImage({
      id: "page-image-1-inpainted",
      storedRelativePath: "Book-assets/images/page-001-inpainted.png",
      originalFileName: "scan_001_inpainted.png",
      sha256: "c".repeat(64),
      mimeType: "image/png",
      copiedAt: "2026-05-30T00:00:00.000Z"
    });
    const otherImage = pageImage({
      id: "page-image-2",
      pageNumber: 2,
      storedRelativePath: "Book-assets/images/page-002.jpg",
      originalFileName: "scan_002.jpg",
      sha256: "b".repeat(64)
    });
    const inpaintPageImage = vi.fn().mockResolvedValue({
      pageImage: replacementImage,
      run: {
        runId: "manual-run-1",
        pageImageId: "page-image-1",
        source: "manual_openai",
        status: "completed",
        sourceSha256: "a".repeat(64),
        appVersion: "0.1.0",
        queuedAt: "2026-05-30T00:00:00.000Z",
        startedAt: "2026-05-30T00:00:00.000Z",
        completedAt: "2026-05-30T00:00:00.000Z"
      },
      asset: {
        assetId: replacementImage.id,
        source: "manual_openai",
        sourcePageImageId: "page-image-1",
        runId: "manual-run-1",
        role: "cleaned",
        storedRelativePath: replacementImage.storedRelativePath,
        sha256: replacementImage.sha256,
        byteSize: replacementImage.byteSize,
        mimeType: "image/png",
        createdAt: "2026-05-30T00:00:00.000Z"
      }
    });
    const saveProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage(), otherImage])),
      saveProject,
      importPageImages: vi.fn(),
      inpaintPageImage
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));

    await waitFor(() => {
      expect(inpaintPageImage).toHaveBeenCalledWith(expect.objectContaining({
        requestId: expect.any(String),
        projectFilePath: "C:\\projects\\Book.ctp",
        pageImage: expect.objectContaining({ id: "page-image-1" }),
        maskPngBase64: "mask-png",
        mode: "speech-bubble",
        provider: "openai",
        promptOverride: undefined,
        options: {
          conservative: true
        }
      }));
    });
    expect(await screen.findByRole("status", { name: "작업 상태" })).toHaveTextContent(
      "OpenAI 인페인팅 결과 레이어로 전환했습니다."
    );
    expect(screen.getByText("변경 있음")).toBeInTheDocument();
    expect(screen.getByText("scan_001_inpainted.png")).toBeInTheDocument();
    expect(screen.queryByLabelText("1페이지 인페인팅 편집기")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => {
      expect(saveProject).toHaveBeenCalledWith(
        expect.objectContaining({
          project: expect.objectContaining({
            pageImages: expect.arrayContaining([
              expect.objectContaining({ id: "page-image-1" }),
              expect.objectContaining({ id: "page-image-2" })
            ]),
            processing: {
              runs: [expect.objectContaining({ runId: "manual-run-1", pageImageId: "page-image-1" })],
              assets: [expect.objectContaining({ assetId: "page-image-1-inpainted", sourcePageImageId: "page-image-1" })],
              pages: [expect.objectContaining({
                pageImageId: "page-image-1",
                latestCompletedRunId: "manual-run-1",
                approvedCleanedAssetId: "page-image-1-inpainted",
                finalStatus: "auto_approved"
              })]
            }
          })
        })
      );
    });
  });

  it("wires extraction-backed semantic overlays into the live page image", async () => {
    const extraction = {
      pageNumber: 1,
      speechBubbles: [{
        id: "semantic-bubble-1",
        type: "speech_bubble" as const,
        text: "검토 필요",
        language: "ja" as const,
        bbox: { x: 0.2, y: 0.25, width: 0.3, height: 0.2 },
        readingOrder: 1,
        confidence: 0.4,
        notes: "문자 일부 불명확",
        speakerCandidates: []
      }],
      nonSpeechText: [{
        type: "sign_or_label" as const,
        text: "간판",
        bbox: { x: 0.65, y: 0.1, width: 0.2, height: 0.1 },
        confidence: 0.92,
        notes: "",
        readingOrder: 2,
        speakerCandidates: []
      }],
      warnings: ["저해상도"]
    };
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      extractSpeechBubbles: vi.fn().mockResolvedValue(extraction),
      validateSpeechBubbles: vi.fn().mockResolvedValue(extraction)
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await screen.findByLabelText("1페이지 말풍선 OCR 검토");

    expect(screen.getByTestId("semantic-overlay-balloon:semantic-bubble-1")).toBeInTheDocument();
    expect(screen.getByTestId("semantic-overlay-preserve:2:0")).toBeInTheDocument();
    expect(screen.getByTestId("semantic-overlay-issue:semantic-bubble-1")).toBeInTheDocument();
    expect(screen.getByTestId("semantic-overlay-typeset:semantic-bubble-1")).toHaveTextContent("초안");
  });

  it("adopts the committed session processing revision before the next user edit", async () => {
    mockCanvasForInpainting();
    const sourceImage = pageImage();
    const replacementImage = pageImage({
      id: "page-image-1-session-inpainted",
      storedRelativePath: "Book-assets/images/page-001-session-inpainted.png",
      originalFileName: "scan_001_session_inpainted.png",
      sha256: "c".repeat(64),
      mimeType: "image/png"
    });
    const openedProject = normalizeProject(openedProjectWithImages([sourceImage]).project);
    const run = {
      runId: "manual-session-run",
      pageImageId: sourceImage.id,
      source: "manual_openai" as const,
      status: "completed" as const,
      sourceSha256: sourceImage.sha256,
      appVersion: "0.1.0",
      queuedAt: "2026-08-03T00:00:00.000Z",
      startedAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T00:00:00.000Z"
    };
    const asset = {
      assetId: replacementImage.id,
      source: "manual_openai" as const,
      sourcePageImageId: sourceImage.id,
      runId: run.runId,
      role: "cleaned" as const,
      storedRelativePath: replacementImage.storedRelativePath,
      sha256: replacementImage.sha256,
      byteSize: replacementImage.byteSize,
      mimeType: "image/png" as const,
      createdAt: "2026-08-03T00:00:00.000Z"
    };
    const committedProject = {
      ...openedProject,
      processing: {
        runs: [run],
        assets: [asset],
        pages: [{
          pageImageId: sourceImage.id,
          latestCompletedRunId: run.runId,
          approvedCleanedAssetId: asset.assetId,
          finalStatus: "auto_approved" as const,
          updatedAt: asset.createdAt
        }]
      }
    };
    const applyProjectMutation = vi.fn().mockImplementation(async (args: ApplyProjectMutationArgs) => ({
      status: "applied" as const,
      revision: args.baseRevision + 1,
      project: {
        revision: args.baseRevision + 1,
        project: committedProject,
        pendingPageImages: [],
        dirty: true,
        status: "active" as const
      }
    }));
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: {
          revision: 0,
          project: normalizeProject(createEmptyProject("Initial", false)),
          pendingPageImages: [],
          dirty: false,
          status: "active"
        },
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: {
          revision: 4,
          project: openedProject,
          pendingPageImages: [],
          dirty: false,
          status: "active"
        },
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      resolvePageImageSrc: vi.fn().mockImplementation(async ({ storedRelativePath }) => storedRelativePath),
      inpaintPageImage: vi.fn().mockResolvedValue({
        pageImage: replacementImage,
        run,
        asset,
        sessionResult: {
          projectSessionId: "opened-session",
          project: {
            revision: 5,
            project: committedProject,
            pendingPageImages: [],
            dirty: false,
            status: "active"
          }
        }
      })
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
    await screen.findByText("scan_001_session_inpainted.png");

    fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "Edited after inpainting" } });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledWith(
      expect.objectContaining({ projectSessionId: "opened-session", baseRevision: 5 })
    ));
  });

  it("shows a pending manual inpainting result without hiding the previous result", async () => {
    mockCanvasForInpainting();
    const sourceImage = pageImage();
    const otherImage = pageImage({ id: "page-image-2", pageNumber: 2, storedRelativePath: "Book-assets/images/page-002.jpg" });
    const pendingResult = deferred<PageImage>();
    const inpaintPageImage = vi.fn()
      .mockResolvedValueOnce(pageImage({
        id: "page-image-1-inpainted",
        storedRelativePath: "Book-assets/images/page-001-inpainted.png",
        originalFileName: "scan_001_inpainted.png",
        sha256: "c".repeat(64),
        mimeType: "image/png"
      }))
      .mockReturnValueOnce(pendingResult.promise);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([sourceImage, otherImage])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      inpaintPageImage
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    async function runInpainting() {
      fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
      const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
      fireEvent.load(targetImage);
      const maskCanvas = screen.getByLabelText("인페인팅 마스크");
      fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
    }

    await runInpainting();
    await waitFor(() => expect(inpaintPageImage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute(
      "src",
      "Book-assets/images/page-001-inpainted.png"
    ));

    await runInpainting();
    await waitFor(() => expect(inpaintPageImage).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.getByText("결과 처리 중입니다.").closest("[data-result-status]")).toHaveAttribute(
        "data-result-status",
        "processing"
      );
    });
    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute(
      "src",
      "Book-assets/images/page-001-inpainted.png"
    );

    pendingResult.resolve(pageImage({
      id: "page-image-1-inpainted-again",
      storedRelativePath: "Book-assets/images/page-001-inpainted-again.png",
      originalFileName: "scan_001_inpainted_again.png",
      sha256: "d".repeat(64),
      mimeType: "image/png"
    }));
    await waitFor(() => expect(screen.getByText("scan_001_inpainted_again.png")).toBeInTheDocument());
  });

  it("keeps dialogue editing and the selected result layer through fallback and page navigation", async () => {
    const sourceImage = pageImage();
    const otherImage = pageImage({ id: "page-image-2", pageNumber: 2, storedRelativePath: "Book-assets/images/page-002.jpg" });
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithInpaintedResult([
        sourceImage,
        otherImage
      ])),
      saveProject: vi.fn(),
      importPageImages: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    const userTranslation = await screen.findByLabelText("사용자 수정문 1");
    fireEvent.change(userTranslation, { target: { value: "edited while viewing result" } });

    fireEvent.click(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i }));
    const resultImage = screen.getByAltText("1페이지 이미지");
    expect(resultImage).toHaveAttribute("src", "Book-assets/images/page-001-inpainted.png");
    fireEvent.error(resultImage);

    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", sourceImage.storedRelativePath);
    expect(screen.getByRole("button", { name: /인페인팅 결과 다시 시도|Retry inpainted result/i })).toBeInTheDocument();
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("edited while viewing result");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    expect(screen.getByRole("button", { name: /edited while viewing result/ })).toHaveAttribute("aria-current", "true");

    openPagesPanel();
    const pageStrip = within(screen.getByRole("complementary", { name: "왼쪽 보조 패널" }))
      .getByRole("list", { name: "페이지 목록" });
    fireEvent.click(within(pageStrip).getByRole("button", { name: "페이지 2 선택" }));
    expect(screen.getByAltText("2페이지 이미지")).toHaveAttribute("src", otherImage.storedRelativePath);
    expect(screen.getByText("인페인팅 결과가 아직 없습니다.").closest("[data-result-status]")).toHaveAttribute(
      "data-result-status",
      "missing"
    );

    fireEvent.click(within(pageStrip).getByRole("button", { name: "페이지 1 선택" }));
    expect(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute(
      "src",
      "Book-assets/images/page-001-inpainted.png"
    );
  });

  it("clears derived result context when reconnecting a page in the same project", async () => {
    const sourceImage = pageImage();
    const replacementImage = pageImage({
      id: "page-image-1-reconnected",
      storedRelativePath: "Book-assets/images/reconnected-page-001.jpg",
      originalFileName: "reconnected-page-001.jpg",
      sha256: "f".repeat(64)
    });
    const importPageImages = vi.fn().mockResolvedValue([{ ok: true, pageImage: replacementImage }]);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithInpaintedResult([sourceImage])),
      saveProject: vi.fn(),
      choosePageImageFiles: vi.fn().mockResolvedValue(["C:\\images\\reconnected-page-001.jpg"]),
      importPageImages
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i }));
    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", "Book-assets/images/page-001-inpainted.png");

    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "다시 연결" }));
    await waitFor(() => expect(importPageImages).toHaveBeenCalledWith({
      projectFilePath: "C:\\projects\\Book.ctp",
      files: [{ sourcePath: "C:\\images\\reconnected-page-001.jpg", pageNumber: 1 }]
    }));

    await waitFor(() => expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute(
      "src",
      replacementImage.storedRelativePath
    ));
    expect(screen.getByText("인페인팅 결과가 아직 없습니다.").closest("[data-result-status]")).toHaveAttribute(
      "data-result-status",
      "missing"
    );
  });

  it("keeps the inpainting editor open when IPC fails", async () => {
    mockCanvasForInpainting();
    const inpaintPageImage = vi.fn().mockRejectedValue(new Error("인페인팅 실패"));
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      inpaintPageImage
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));

    fireEvent.click(screen.getByRole("button", { name: "설정" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("인페인팅 실패"));
    expect(screen.getByLabelText("1페이지 인페인팅 편집기")).toBeInTheDocument();
  });

  it("runs inpainting through Gemini when the Gemini action is selected", async () => {
    mockCanvasForInpainting();
    const replacementImage = pageImage({
      id: "page-image-1-gemini",
      storedRelativePath: "Book-assets/images/page-001-gemini.png",
      originalFileName: "scan_001_gemini.png",
      sha256: "e".repeat(64),
      mimeType: "image/png",
      copiedAt: "2026-05-30T00:00:00.000Z"
    });
    const inpaintPageImage = vi.fn().mockResolvedValue(replacementImage);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      inpaintPageImage
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "Gemini 실행" }));

    await waitFor(() => {
      expect(inpaintPageImage).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "gemini",
          mode: "speech-bubble",
          maskPngBase64: "mask-png"
        })
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "설정" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("Gemini 인페인팅 결과 레이어로 전환했습니다.")
    );
    expect(screen.getByText("scan_001_gemini.png")).toBeInTheDocument();
  });

  it("does not apply an inpainting result after the project changes", async () => {
    mockCanvasForInpainting();
    const inpaintingResult = deferred<PageImage>();
    const inpaintPageImage = vi.fn().mockReturnValue(inpaintingResult.promise);
    const cancelInpainting = vi.fn().mockResolvedValue({ canceled: true });
    const initialProject = openedProjectWithImages([pageImage()]);
    const replacementProject = openedProjectWithImages(
      [pageImage({ id: "replacement-page-image" })],
      [rendererLine("replacement-line", 1, "Replacement line")]
    );
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn()
        .mockResolvedValueOnce(initialProject)
        .mockResolvedValueOnce(replacementProject),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      inpaintPageImage,
      cancelInpainting
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
    await waitFor(() => expect(inpaintPageImage).toHaveBeenCalledTimes(1));

    fireEvent.click(within(screen.getByRole("banner", { name: "앱 상단 바" })).getByRole("button", { name: "열기" }));
    await openWorkspacePanel("수정");
    await screen.findByDisplayValue("Replacement line");
    await waitFor(() => expect(cancelInpainting).toHaveBeenCalledOnce());
    const replacementStatus = screen.getByRole("status", { name: "작업 상태" }).textContent;

    inpaintingResult.resolve(
      pageImage({
        id: "stale-inpainted-image",
        storedRelativePath: "Book-assets/images/stale-inpainted.png",
        originalFileName: "stale-inpainted.png",
        sha256: "d".repeat(64),
        mimeType: "image/png"
      })
    );

    await waitFor(() => expect(screen.queryByText("stale-inpainted.png")).not.toBeInTheDocument());
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(replacementStatus ?? "");
    expect(screen.queryByText("stale-inpainted.png")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "설정" }));
    expect(screen.getByText("저장하지 않은 변경사항이 없습니다.")).toBeInTheDocument();
  });

  it("reports an unconfirmed inpainting cancel when cancel IPC rejects and ignores the late result", async () => {
    mockCanvasForInpainting();
    const inpaintingResult = deferred<PageImage>();
    const inpaintPageImage = vi.fn().mockReturnValue(inpaintingResult.promise);
    const cancelInpainting = vi.fn().mockRejectedValue(new Error("inpainting cancel IPC failed"));
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      inpaintPageImage,
      cancelInpainting
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
    await waitFor(() => expect(inpaintPageImage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "인페인팅 실행 취소" }));

    expect(await findWorkStatus("결과 적용은 중단했지만 backend 취소를 확인하지 못했습니다.")).toBeInTheDocument();
    expect(cancelInpainting).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("인페인팅 요청을 취소했습니다.")).not.toBeInTheDocument();

    inpaintingResult.resolve(pageImage({
      id: "late-inpainted-image",
      storedRelativePath: "Book-assets/images/late-inpainted.png",
      originalFileName: "late-inpainted.png",
      sha256: "d".repeat(64),
      mimeType: "image/png"
    }));
    await waitFor(() => expect(screen.queryByText("late-inpainted.png")).not.toBeInTheDocument());
    expect(screen.queryByText("late-inpainted.png")).not.toBeInTheDocument();
  });

  it("reports when inpainting cancel cannot find an active Main request", async () => {
    mockCanvasForInpainting();
    const inpaintingResult = deferred<PageImage>();
    const inpaintPageImage = vi.fn().mockReturnValue(inpaintingResult.promise);
    const cancelInpainting = vi.fn().mockResolvedValue({ canceled: false });
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      inpaintPageImage,
      cancelInpainting
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
    await waitFor(() => expect(inpaintPageImage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "인페인팅 실행 취소" }));

    expect(await findWorkStatus(
      "결과 적용은 중단했지만 이미 종료되었거나 활성 요청을 찾지 못해 backend 취소를 확인하지 못했습니다."
    )).toBeInTheDocument();
    expect(screen.queryByText("인페인팅 요청을 취소했습니다.")).not.toBeInTheDocument();
  });

  it("uses the Electron-resolved file URL for saved page images", async () => {
    const resolvePageImageSrc = vi.fn().mockResolvedValue("translation-image://asset/page-image-token");
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue({
        filePath: "C:\\projects\\Book.ctp",
        encrypted: false,
        project: {
          schemaVersion: 1,
          metadata: {
            id: "project-resolved-images",
            title: "Resolved Image Project",
            createdAt: "2026-05-29T00:00:00.000Z",
            updatedAt: "2026-05-29T00:00:00.000Z",
            secret: false
          },
          characters: [],
          dictionaryTerms: [],
          dialogueLines: [rendererLine("image-workspace-line", 1, "Image workspace line")],
          pageImages: [
            {
              id: "page-image-1",
              pageNumber: 1,
              storedRelativePath: "Book-assets/images/page-001.jpg",
              originalFileName: "scan_001.jpg",
              sha256: "a".repeat(64),
              byteSize: 4,
              mimeType: "image/jpeg",
              copiedAt: "2026-05-29T00:00:00.000Z"
            }
          ],
          settings: { defaultSourceLanguage: "unknown" }
        }
      }),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    const image = await screen.findByAltText("1페이지 이미지");
    await waitFor(() => {
      expect(image).toHaveAttribute("src", "translation-image://asset/page-image-token");
    });
    expect(resolvePageImageSrc).toHaveBeenCalledWith({
      projectFilePath: "C:\\projects\\Book.ctp",
      storedRelativePath: "Book-assets/images/page-001.jpg"
    });
  });

  it("guards browser or Electron window close when there are unsaved changes", async () => {
    await renderWorkspaceApp();
    openPagesPanel();
    openSettings();

    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "Dirty Close Guard" } });
    const event = new Event("beforeunload", { cancelable: true });
    const prevented = !window.dispatchEvent(event);

    expect(prevented).toBe(true);
  });

  it("shows a page image failure state when the linked image cannot load", async () => {
    const extractSpeechBubbles = vi.fn().mockResolvedValue(validatedReviewExtraction());
    const validateSpeechBubbles = vi.fn().mockResolvedValue(validatedReviewExtraction());
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue({
        filePath: "C:\\projects\\Book.ctp",
        encrypted: false,
        project: {
          schemaVersion: 1,
          metadata: {
            id: "project-image-error",
            title: "Image Error Project",
            createdAt: "2026-05-29T00:00:00.000Z",
            updatedAt: "2026-05-29T00:00:00.000Z",
            secret: false
          },
          characters: [],
          dictionaryTerms: [],
          dialogueLines: [rendererLine("image-workspace-line", 1, "Image workspace line")],
          pageImages: [
            {
              id: "page-image-error",
              pageNumber: 1,
              storedRelativePath: "missing/page-001.jpg",
              originalFileName: "missing-page.jpg",
              sha256: "b".repeat(64),
              byteSize: 4,
              mimeType: "image/jpeg",
              copiedAt: "2026-05-29T00:00:00.000Z"
            }
          ],
          settings: { defaultSourceLanguage: "unknown" }
        }
      }),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      extractSpeechBubbles,
      validateSpeechBubbles
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    const image = await screen.findByAltText("1페이지 이미지");
    fireEvent.error(image);

    await waitFor(() => {
      expect(screen.getByText("이미지 파일을 불러오지 못했습니다.")).toBeInTheDocument();
    });
    expect(screen.getByText("missing-page.jpg 파일을 다시 연결하세요.")).toBeInTheDocument();
    await openWorkspacePanel("수정");
    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(within(inspector).getByRole("button", { name: "말풍선 OCR" })).toBeEnabled();
    fireEvent.keyDown(document, { key: " " });
    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledTimes(1));
  });

  it("disables image upload for secret projects", async () => {
    await renderWorkspaceApp();
    openPagesPanel();
    openSettings();

    fireEvent.click(screen.getByLabelText("시크릿 프로젝트"));

    expect(screen.getByRole("button", { name: "이미지 업로드" })).toBeDisabled();
    expect(screen.getByText("시크릿 프로젝트에서는 이미지 업로드가 아직 지원되지 않습니다.")).toBeInTheDocument();
  });

  it("disables image upload until the project has been saved", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn().mockResolvedValue(undefined),
      choosePageImageFiles: vi.fn(),
      importPageImages: vi.fn()
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();

    expect(screen.getByRole("button", { name: "이미지 업로드" })).toBeDisabled();
    expect(screen.getByText("먼저 프로젝트를 저장해야 이미지 업로드를 사용할 수 있습니다.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다른 이름 저장" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 저장했습니다."));
    expect(screen.getByRole("button", { name: "이미지 업로드" })).toBeEnabled();
  });

  it("shows an image workflow guide next to the project file state", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn().mockResolvedValue(undefined),
      choosePageImageFiles: vi.fn(),
      importPageImages: vi.fn()
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();
    openSettings();

    fireEvent.click(screen.getByRole("button", { name: "가이드 열기" }));

    expect(screen.getByText("이미지 불러오기 가이드")).toBeInTheDocument();
    expect(screen.getByText("프로젝트 저장 전이라 이미지 연결 불가")).toBeInTheDocument();
    expect(screen.getAllByText("TXT 불러오기 → 프로젝트 저장 → 이미지 연결 → OCR/인페인팅 → 적용/저장")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "다른 이름 저장" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 저장했습니다."));
    expect(screen.getByText("이미지 연결 가능")).toBeInTheDocument();
  });

  it("explains that saved projects import selected images from the current page onward", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn().mockResolvedValue(undefined),
      choosePageImageFiles: vi.fn(),
      importPageImages: vi.fn()
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();

    expect(screen.getByText("먼저 프로젝트를 저장해야 이미지 업로드를 사용할 수 있습니다.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다른 이름 저장" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 저장했습니다."));
    expect(screen.getByText("현재 페이지부터 선택한 이미지가 순서대로 연결됩니다.")).toBeInTheDocument();
  });

  it("adds imported page image metadata to the current project", async () => {
    const importPageImages = vi.fn().mockResolvedValue([
      {
        ok: true,
        pageImage: {
          id: "page-image-imported",
          pageNumber: 1,
          storedRelativePath: "Book-assets/images/page-001.jpg",
          originalFileName: "scan_001.jpg",
          sha256: "b".repeat(64),
          byteSize: 4,
          mimeType: "image/jpeg",
          copiedAt: "2026-05-29T00:00:00.000Z"
        }
      }
    ]);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn().mockResolvedValue(undefined),
      importPageImages
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();
    fireEvent.click(screen.getByRole("button", { name: "다른 이름 저장" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 저장했습니다."));

    fireEvent.click(screen.getByRole("button", { name: "이미지 업로드" }));
    await answerAppPrompt("C:\\images\\scan_001.jpg");

    await waitFor(() => {
      expect(importPageImages).toHaveBeenCalledWith({
        projectFilePath: "C:\\projects\\Book.ctp",
        files: [{ sourcePath: "C:\\images\\scan_001.jpg", pageNumber: 1 }]
      });
    });
    expect(await screen.findByAltText("1페이지 이미지")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("이미지 1개를 등록했습니다.");
  });

  it("uses the native image picker when importing page images", async () => {
    const choosePageImageFiles = vi.fn().mockResolvedValue(["C:\\images\\page-001.jpg", "C:\\images\\page-002.png"]);
    const importPageImages = vi.fn().mockResolvedValue([
      {
        ok: true,
        pageImage: {
          id: "page-image-one",
          pageNumber: 1,
          storedRelativePath: "Book-assets/images/page-001.jpg",
          originalFileName: "page-001.jpg",
          sha256: "c".repeat(64),
          byteSize: 4,
          mimeType: "image/jpeg",
          copiedAt: "2026-05-29T00:00:00.000Z"
        }
      },
      {
        ok: true,
        pageImage: {
          id: "page-image-two",
          pageNumber: 2,
          storedRelativePath: "Book-assets/images/page-002.png",
          originalFileName: "page-002.png",
          sha256: "d".repeat(64),
          byteSize: 4,
          mimeType: "image/png",
          copiedAt: "2026-05-29T00:00:00.000Z"
        }
      }
    ]);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn().mockResolvedValue(undefined),
      choosePageImageFiles,
      importPageImages
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();
    fireEvent.click(screen.getByRole("button", { name: "다른 이름 저장" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 저장했습니다."));

    fireEvent.click(screen.getByRole("button", { name: "이미지 업로드" }));

    expect(choosePageImageFiles).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "업로드할 이미지 파일 경로" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(importPageImages).toHaveBeenCalledWith({
        projectFilePath: "C:\\projects\\Book.ctp",
        files: [
          { sourcePath: "C:\\images\\page-001.jpg", pageNumber: 1 },
          { sourcePath: "C:\\images\\page-002.png", pageNumber: 2 }
        ]
      });
    });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("이미지 2개를 등록했습니다."));
  });

  it("registers existing-session uploads through an opaque pending import batch", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(openedProjectWithImages([]).project);
    const dto = (project: typeof initialProject, pendingPageImages: unknown[] = []) => ({
      revision: 0,
      project,
      pendingPageImages,
      dirty: pendingPageImages.length > 0,
      status: "active" as const
    });
    const choosePageImages = vi.fn().mockResolvedValue({
      importBatchId: "upload-batch",
      images: [{
        preparedImageId: "upload-prepared",
        importBatchId: "upload-batch",
        originalFileName: "upload.png",
        byteSize: 4,
        mimeType: "image/png",
        previewToken: "upload-preview"
      }]
    });
    const importPageImages = vi.fn().mockResolvedValue([{
      ok: true,
      pendingPageImage: {
        importBatchId: "upload-batch",
        preparedImageId: "upload-prepared",
        pageImageId: "pending-upload",
        pageNumber: 1,
        originalFileName: "upload.png",
        byteSize: 4,
        mimeType: "image/png",
        previewToken: "upload-preview"
      }
    }]);
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(initialProject),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation: vi.fn(),
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      choosePageImages,
      importPageImages
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    await screen.findByDisplayValue("Opened project line");
    openPagesPanel();
    fireEvent.click(screen.getByRole("button", { name: "이미지 업로드" }));

    await waitFor(() => expect(choosePageImages).toHaveBeenCalledWith({
      projectSessionId: "opened-session"
    }));
    expect(importPageImages).toHaveBeenCalledWith({
      projectSessionId: "opened-session",
      importBatchId: "upload-batch",
      pages: [{ preparedImageId: "upload-prepared", pageNumber: 1 }]
    });
    expect(JSON.stringify(importPageImages.mock.calls)).not.toContain("sourcePath");
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(
      "이미지 1개를 저장 대기 상태로 등록했습니다."
    );
  });

  it("reports a rejected TXT import, releases loading state, and succeeds on retry", async () => {
    const importTxtFile = vi.fn()
      .mockRejectedValueOnce(new Error("filesystem denied"))
      .mockResolvedValueOnce({
        filePath: "retry.txt",
        lines: [rendererLine("retry-line", 1, "Retry succeeded")]
      });
    const unhandledRejection = vi.fn();
    window.addEventListener("unhandledrejection", unhandledRejection);
    window.projectApi = {
      importTxtFile,
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("TXT 파일을 불러오지 못했습니다"));
    expect(screen.getByRole("button", { name: "TXT로 시작" })).toBeEnabled();

    await clickTxtStart();
    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("Retry succeeded")).toBeVisible();
    expect(importTxtFile).toHaveBeenCalledTimes(2);
    expect(unhandledRejection).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandledRejection);
  });

  it("serializes manual session image import failures, releases unlinked batches, and retries", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Opened", false));
    openedProject.dialogueLines = [{
      ...rendererLine("opened-line", 1, "Opened line"),
      origin: { kind: "manual" }
    }];
    const dto = (project: typeof initialProject, revision = 0) => ({
      revision, project, pendingPageImages: [] as [], dirty: false, status: "active" as const
    });
    const firstBatch = {
      importBatchId: "failed-batch",
      images: [{
        preparedImageId: "failed-prepared",
        importBatchId: "failed-batch",
        originalFileName: "failed.png",
        byteSize: 4,
        mimeType: "image/png",
        previewToken: "failed-preview"
      }]
    };
    const secondBatch = {
      importBatchId: "retry-batch",
      images: [{
        preparedImageId: "retry-prepared",
        importBatchId: "retry-batch",
        originalFileName: "retry.png",
        byteSize: 4,
        mimeType: "image/png",
        previewToken: "retry-preview"
      }]
    };
    const choosePageImages = vi.fn()
      .mockRejectedValueOnce(new Error("picker failed"))
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce(secondBatch);
    const pendingLink = deferred<Awaited<ReturnType<NonNullable<NonNullable<typeof window.projectApi>["importPageImages"]>>>>();
    const importPageImages = vi.fn()
      .mockReturnValueOnce(pendingLink.promise)
      .mockResolvedValueOnce([{
        ok: true,
        pendingPageImage: {
          importBatchId: "retry-batch",
          preparedImageId: "retry-prepared",
          pageImageId: "retry-page",
          pageNumber: 1,
          originalFileName: "retry.png",
          byteSize: 4,
          mimeType: "image/png",
          previewToken: "retry-preview"
        }
      }]);
    const releasePageImageImportBatch = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session", project: dto(initialProject), encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session", project: dto(openedProject, 1), encrypted: false
      }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation: vi.fn(),
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined), listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
      choosePageImages, importPageImages, releasePageImageImportBatch
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    await screen.findByDisplayValue("Opened line");
    openPagesPanel();
    const upload = screen.getByRole("button", { name: "이미지 업로드" });

    fireEvent.click(upload);
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("이미지 파일을 불러오지 못했습니다"));
    expect(upload).toBeEnabled();

    fireEvent.click(upload);
    await waitFor(() => expect(importPageImages).toHaveBeenCalledOnce());
    expect(upload).toBeDisabled();
    fireEvent.click(upload);
    expect(choosePageImages).toHaveBeenCalledTimes(2);
    await act(async () => {
      pendingLink.reject(new Error("link failed"));
      try {
        await pendingLink.promise;
      } catch {
        // App owns and reports this rejection.
      }
    });
    await waitFor(() => expect(releasePageImageImportBatch).toHaveBeenCalledWith({
      projectSessionId: "opened-session",
      importBatchId: "failed-batch"
    }));
    expect(upload).toBeEnabled();

    fireEvent.click(upload);
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("이미지 1개를 저장 대기 상태로 등록했습니다"));
    expect(choosePageImages).toHaveBeenCalledTimes(3);
    expect(importPageImages).toHaveBeenCalledTimes(2);
  });

  it("refreshes the original result after saving a session reconnect over an existing result context", async () => {
    const sourceImage = pageImage({
      id: "session-source-image",
      storedRelativePath: "Book-assets/images/session-source.jpg"
    });
    const replacementImage = pageImage({
      id: "session-reconnected-image",
      storedRelativePath: "Book-assets/images/session-reconnected.jpg",
      originalFileName: "session-reconnected.jpg",
      sha256: "f".repeat(64)
    });
    const initialProject = normalizeProject(
      openedProjectWithInpaintedResult([sourceImage]).project
    );
    const savedProject = normalizeProject(
      openedProjectWithImages([replacementImage]).project
    );
    const dto = (project: typeof initialProject, pendingPageImages: unknown[] = []) => ({
      revision: 0,
      project,
      pendingPageImages,
      dirty: pendingPageImages.length > 0,
      status: "active" as const
    });
    const choosePageImages = vi.fn().mockResolvedValue({
      importBatchId: "session-reconnect-batch",
      images: [{
        preparedImageId: "session-reconnect-prepared",
        importBatchId: "session-reconnect-batch",
        originalFileName: "session-reconnected.jpg",
        byteSize: 4,
        mimeType: "image/jpeg",
        previewToken: "session-reconnect-preview"
      }]
    });
    const importPageImages = vi.fn().mockResolvedValue([{
      ok: true,
      pendingPageImage: {
        importBatchId: "session-reconnect-batch",
        preparedImageId: "session-reconnect-prepared",
        pageImageId: "pending-session-reconnect",
        pageNumber: 1,
        originalFileName: "session-reconnected.jpg",
        byteSize: 4,
        mimeType: "image/jpeg",
        previewToken: "session-reconnect-preview"
      }
    }]);
    const saveProject = vi.fn().mockResolvedValue({
      project: {
        ...dto(savedProject),
        revision: 1,
        project: savedProject,
        dirty: false
      }
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(normalizeProject(createEmptyProject("Initial", false))),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(initialProject),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation: vi.fn(),
      saveProject,
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      choosePageImages,
      importPageImages
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i }));
    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute(
      "src",
      "Book-assets/images/page-001-inpainted.png"
    );

    openPagesPanel();
    fireEvent.click(screen.getByRole("button", { name: "이미지 업로드" }));
    await waitFor(() => expect(importPageImages).toHaveBeenCalledWith({
      projectSessionId: "opened-session",
      importBatchId: "session-reconnect-batch",
      pages: [{ preparedImageId: "session-reconnect-prepared", pageNumber: 1 }]
    }));

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(saveProject).toHaveBeenCalledWith({
      projectSessionId: "opened-session"
    }));
    await waitFor(() => expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute(
      "src",
      replacementImage.storedRelativePath
    ));
    expect(screen.getByText("인페인팅 결과가 아직 없습니다.")).toBeInTheDocument();
  });

  it("selects the first visible line when navigating to another page", async () => {
    const firstLine: DialogueLine = {
      id: "line-page-select-one",
      order: 1,
      pageNumber: 1,
      speaker: "Mika",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Page one source",
      parseConfidence: 0.9,
      parseWarnings: []
    };
    const secondLine: DialogueLine = {
      id: "line-page-select-two",
      order: 2,
      pageNumber: 2,
      speaker: "Ren",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Page two source",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "page-selection.txt", lines: [firstLine, secondLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByText("#1 · Mika · 미번역")).toBeInTheDocument();
    expect(screen.getByLabelText("원문 1")).toHaveValue("Page one source");

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));

    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(screen.getByText("#2 · Ren · 미번역")).toBeInTheDocument();
    expect(screen.getByLabelText("원문 2")).toHaveValue("Page two source");

    fireEvent.click(screen.getByText("라인 메타"));
    fireEvent.change(screen.getByLabelText("라인 화자"), { target: { value: "Ren Edited" } });

    expect(screen.getByText("#2 · Ren Edited · 미번역")).toBeInTheDocument();
    expect(screen.queryByText("#1 · Mika · 미번역")).not.toBeInTheDocument();
  });

  it("clamps the current page and selection after deleting the only line on the last page", async () => {
    const firstLine: DialogueLine = {
      id: "line-delete-clamp-one",
      order: 1,
      pageNumber: 1,
      speaker: "Mika",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Page one source",
      parseConfidence: 0.9,
      parseWarnings: []
    };
    const secondLine: DialogueLine = {
      id: "line-delete-clamp-two",
      order: 2,
      pageNumber: 2,
      speaker: "Ren",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Page two source",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "page-delete.txt", lines: [firstLine, secondLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("현재 페이지")).toHaveTextContent("1 / 2");

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");

    fireEvent.click(screen.getByRole("button", { name: "라인 삭제" }));
    await answerAppConfirmation("대사 삭제");

    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("1 / 1");
    expect(screen.queryByText("2 / 1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("원문 1")).toHaveValue("Page one source");
    expect(screen.queryByLabelText("원문 2")).not.toBeInTheDocument();
    expect(screen.getByText("#1 · Mika · 미번역")).toBeInTheDocument();
  });

  it("edits parser metadata from the collapsed line detail section", async () => {
    const line: DialogueLine = {
      id: "line-inline-metadata",
      order: 3,
      pageNumber: 1,
      speaker: "Auto 화자",
      position: "Panel 2",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Inline metadata source",
      parseConfidence: 0.55,
      parseWarnings: ["No speaker detected"]
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "metadata.txt", lines: [line] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();

    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByText("#3 · Auto 화자 · 미번역")).toBeInTheDocument();
    expect(screen.queryByLabelText("테이블 화자 3")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("라인 메타"));
    expect(screen.getByLabelText("라인 위치")).toHaveValue("Panel 2");

    fireEvent.change(screen.getByLabelText("라인 화자"), { target: { value: "Mika" } });
    fireEvent.change(screen.getByLabelText("라인 위치"), { target: { value: "Top left" } });
    fireEvent.change(screen.getByLabelText("라인 유형"), { target: { value: "thought" } });
    fireEvent.change(screen.getByLabelText("라인 언어"), { target: { value: "ja" } });

    expect(screen.getByText("#3 · Mika · 미번역")).toBeInTheDocument();
    expect(screen.getByLabelText("라인 위치")).toHaveValue("Top left");
    expect(screen.getByLabelText("라인 유형")).toHaveValue("thought");
    expect(screen.getByLabelText("라인 언어")).toHaveValue("ja");
    openPagesPanel();
    openSettings();
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
  });

  it("edits line status from the detail panel", async () => {
    const line: DialogueLine = {
      id: "line-status-edit",
      order: 4,
      pageNumber: 1,
      dialogueType: "speech",
      lineStatus: "draft",
      sourceLanguage: "en",
      sourceText: "Status source",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "status.txt", lines: [line] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByText("#4 · 화자 없음 · AI 초안")).toBeInTheDocument();
    expect(screen.queryByLabelText("테이블 상태 4")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "검토필요 표시" }));
    expect(screen.getByText("#4 · 화자 없음 · 검토필요")).toBeInTheDocument();
    openPagesPanel();
    openSettings();
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
  });

  it("quickly marks the selected line status from detail actions", async () => {
    const line: DialogueLine = {
      id: "line-quick-status",
      order: 5,
      pageNumber: 1,
      dialogueType: "speech",
      lineStatus: "draft",
      sourceLanguage: "en",
      sourceText: "Quick status source",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "quick-status.txt", lines: [line] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByText("#5 · 화자 없음 · AI 초안")).toBeInTheDocument();
    openFullDialogueTable();
    fireEvent.change(within(screen.getByRole("complementary", { name: "오른쪽 작업 패널" })).getByLabelText("사용자 수정문 5"), { target: { value: "검수할 번역" } });
    fireEvent.click(screen.getByRole("button", { name: "완료 표시" }));

    expect(screen.getByText("#5 · 화자 없음 · 완료")).toBeInTheDocument();
    expect(screen.getByLabelText("상태 요약")).toHaveTextContent("진행률 100%");

    fireEvent.click(screen.getByRole("button", { name: "검토필요 표시" }));
    expect(screen.getByText("#5 · 화자 없음 · 검토필요")).toBeInTheDocument();
    expect(screen.getByLabelText("상태 요약")).toHaveTextContent("검토필요 1");
  });

  it("updates selected line status with keyboard shortcuts", async () => {
    const line: DialogueLine = {
      id: "line-shortcut-status",
      order: 6,
      pageNumber: 1,
      dialogueType: "speech",
      lineStatus: "draft",
      sourceLanguage: "en",
      sourceText: "Shortcut status source",
      userTranslation: "단축키로 확정할 번역",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "shortcut-status.txt", lines: [line] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByText("#6 · 화자 없음 · 초안 작성")).toBeInTheDocument();
    openFullDialogueTable();

    const reviewEvent = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true });
    const reviewPreventDefault = vi.spyOn(reviewEvent, "preventDefault");
    act(() => {
      window.dispatchEvent(reviewEvent);
    });

    expect(reviewPreventDefault).toHaveBeenCalled();
    expect(screen.getByText("#6 · 화자 없음 · 검토필요")).toBeInTheDocument();
    expect(screen.getByLabelText("상태 요약")).toHaveTextContent("검토필요 1");

    const completeEvent = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true });
    const completePreventDefault = vi.spyOn(completeEvent, "preventDefault");
    act(() => {
      window.dispatchEvent(completeEvent);
    });

    expect(completePreventDefault).toHaveBeenCalled();
    expect(screen.getByText("#6 · 화자 없음 · 완료")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "완료 표시" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("상태 요약")).toHaveTextContent("진행률 100%");
  });

  it("uses Ctrl+Enter to confirm the selected translation in place before explicit navigation", async () => {
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "C:\\input.txt",
        lines: [rendererLine("line-1", 1, "第一声"), rendererLine("line-2", 2, "第二声")]
      }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("사용자 수정문 1")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "첫 번째 번역" } });
    const completeEvent = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true });
    const completePreventDefault = vi.spyOn(completeEvent, "preventDefault");
    act(() => {
      window.dispatchEvent(completeEvent);
    });

    expect(completePreventDefault).toHaveBeenCalled();
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("첫 번째 번역");
    expect(screen.getByRole("button", { name: "완료 표시" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("선택한 대사의 검수를 확정했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "다음 라인" }));
    expect(screen.getByLabelText("원문 2")).toHaveValue("第二声");
  });

  it("allows explicit next-page navigation after the current page has no actionable line", async () => {
    const lines = [rendererLine("page-1-line", 1, "第一頁", 1), rendererLine("page-2-line", 2, "第二頁", 2)];
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })], lines)
      ),
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByText(/#1 ·/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "검수를 마친 번역문" } });
    fireEvent.click(screen.getByRole("button", { name: "검수 확정" }));

    expect(screen.getByRole("button", { name: "완료 표시" })).toHaveAttribute("aria-pressed", "true");
    await openWorkspacePanel("수정");
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
    expect(screen.getByRole("button", { name: "다음 페이지" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(screen.getByLabelText("원문 2")).toHaveValue("第二頁");
  });

  it("reports whole-project completion on a non-final page when every line is complete", async () => {
    const lines = [
      { ...rendererLine("page-1-complete", 1, "첫 페이지 완료 대사", 1), lineStatus: "complete" as const },
      { ...rendererLine("page-2-complete", 2, "둘째 페이지 완료 대사", 2), lineStatus: "complete" as const }
    ];
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })], lines)
      ),
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
    const workPanel = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(within(workPanel).getByText("현재 프로젝트의 번역 대사를 모두 확인했습니다.")).toBeInTheDocument();
    expect(within(workPanel).queryByRole("button", { name: "다음 페이지로 이동" })).not.toBeInTheDocument();
  });

  it("opens a completed page without selecting a completed line and selects the first actionable line on navigation", async () => {
    const lines = [
      { ...rendererLine("page-1-complete-1", 1, "완료된 첫 대사", 1), lineStatus: "complete" as const },
      { ...rendererLine("page-1-complete-2", 2, "완료된 둘째 대사", 1), lineStatus: "complete" as const },
      { ...rendererLine("page-2-complete", 3, "둘째 페이지 완료 대사", 2), lineStatus: "complete" as const },
      rendererLine("page-2-actionable", 4, "둘째 페이지 작업 대사", 2)
    ];
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })], lines)
      ),
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
    expect(screen.getByText("완료", { selector: "li strong" }).closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.queryByRole("button", { name: "검수 확정" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지로 이동" }));

    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(screen.getByText(/#4 ·/)).toBeInTheDocument();
    expect(screen.queryByText(/#3 ·/)).not.toBeInTheDocument();
  });

  it("does not report project completion on the final page while an earlier page remains actionable", async () => {
    const lines = [rendererLine("earlier-actionable", 1, "앞 페이지 남은 대사", 1), rendererLine("final-actionable", 2, "마지막 페이지 대사", 2)];
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })], lines)
      ),
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    await screen.findByText(/#1 ·/);
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(screen.getByText(/#2 ·/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("사용자 수정문 2"), { target: { value: "검수를 마친 번역문" } });
    fireEvent.click(screen.getByRole("button", { name: "검수 확정" }));

    expect(screen.getByRole("button", { name: "완료 표시" })).toHaveAttribute("aria-pressed", "true");
    await openWorkspacePanel("수정");
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(screen.queryByText("현재 프로젝트의 번역 대사를 모두 확인했습니다.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
    expect(screen.getByText(/#1 ·/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "완료 표시" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the page image visible and offers retry after OCR failure", async () => {
    const extractSpeechBubbles = vi.fn().mockRejectedValue(new Error("OCR 서비스 응답 실패"));
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      extractSpeechBubbles,
      validateSpeechBubbles: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    expect(await screen.findByAltText("1페이지 이미지")).toBeInTheDocument();
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("OCR 서비스 응답 실패");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByAltText("1페이지 이미지")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "OCR 다시 실행" }));
    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledTimes(2));
  });

  it("preserves an edited translation when OCR failure focus and retry interrupt the editor", async () => {
    const line = rendererLine("preserved-translation", 1, "Original dialogue");
    const extractSpeechBubbles = vi.fn().mockRejectedValue(new Error("OCR 서비스 응답 실패"));
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()], [line])),
      saveProject: vi.fn(),
      extractSpeechBubbles,
      validateSpeechBubbles: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    const translation = await screen.findByLabelText("사용자 수정문 1");
    fireEvent.change(translation, { target: { value: "사용자가 편집 중인 번역" } });
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("사용자가 편집 중인 번역");

    const retryEvent = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true });
    const retryPreventDefault = vi.spyOn(retryEvent, "preventDefault");
    act(() => {
      window.dispatchEvent(retryEvent);
    });

    expect(retryPreventDefault).toHaveBeenCalled();
    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("사용자가 편집 중인 번역");
    expect(screen.getByText("#1 · 화자 없음 · 초안 작성")).toBeInTheDocument();
  });

  it("ignores a stale OCR rejection after the page image context changes", async () => {
    const extraction = deferred<ReturnType<typeof emptyOcrExtraction>>();
    const cancelSpeechBubbleOcr = vi.fn().mockResolvedValue({ canceled: true });
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(
        openedProjectWithImages([pageImage(), pageImage({ id: "page-image-2", pageNumber: 2 })])
      ),
      saveProject: vi.fn(),
      extractSpeechBubbles: vi.fn()
        .mockReturnValueOnce(extraction.promise)
        .mockResolvedValueOnce(emptyOcrExtraction(2)),
      validateSpeechBubbles: vi.fn().mockResolvedValue(emptyOcrExtraction(2)),
      cancelSpeechBubbleOcr
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await waitFor(() => expect(window.projectApi.extractSpeechBubbles).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(cancelSpeechBubbleOcr).toHaveBeenCalledWith({ requestId: expect.any(String) }));
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await waitFor(() => expect(window.projectApi.extractSpeechBubbles).toHaveBeenCalledTimes(2));

    await act(async () => {
      extraction.reject(new Error("늦게 도착한 첫 페이지 OCR 실패"));
      await Promise.resolve();
    });

    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(window.projectApi.validateSpeechBubbles).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OCR 다시 실행" })).not.toBeInTheDocument();
  });

  it("reports an unconfirmed OCR cancel when cancel IPC rejects and ignores the late result", async () => {
    const extraction = deferred<ReturnType<typeof emptyOcrExtraction>>();
    const cancelSpeechBubbleOcr = vi.fn().mockRejectedValue(new Error("ocr cancel IPC failed"));
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      extractSpeechBubbles: vi.fn().mockReturnValue(extraction.promise),
      validateSpeechBubbles: vi.fn(),
      cancelSpeechBubbleOcr
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await waitFor(() => expect(window.projectApi.extractSpeechBubbles).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "OCR 취소" }));
    await waitFor(() => expect(cancelSpeechBubbleOcr).toHaveBeenCalledWith({ requestId: expect.any(String) }));

    expect(await findWorkStatus("결과 적용은 중단했지만 backend 취소를 확인하지 못했습니다.")).toBeInTheDocument();
    expect(cancelSpeechBubbleOcr).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("말풍선 OCR 요청을 취소했습니다.")).not.toBeInTheDocument();

    await act(async () => {
      extraction.resolve(emptyOcrExtraction());
      await extraction.promise;
    });
    expect(screen.queryByLabelText("1페이지 말풍선 OCR 검토")).not.toBeInTheDocument();
    expect(window.projectApi.validateSpeechBubbles).not.toHaveBeenCalled();
  });

  it("reports when OCR cancel cannot find an active Main request", async () => {
    const extraction = deferred<ReturnType<typeof emptyOcrExtraction>>();
    const cancelSpeechBubbleOcr = vi.fn().mockResolvedValue({ canceled: false });
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      extractSpeechBubbles: vi.fn().mockReturnValue(extraction.promise),
      validateSpeechBubbles: vi.fn(),
      cancelSpeechBubbleOcr
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    fireEvent.click(await screen.findByRole("button", { name: "OCR 취소" }));

    expect(await findWorkStatus(
      "결과 적용은 중단했지만 이미 종료되었거나 활성 요청을 찾지 못해 backend 취소를 확인하지 못했습니다."
    )).toBeInTheDocument();
    expect(screen.queryByText("말풍선 OCR 요청을 취소했습니다.")).not.toBeInTheDocument();
  });

  it("invalidates OCR synchronously when a replacement project and rejection resolve in the same turn", async () => {
    const extraction = deferred<ReturnType<typeof emptyOcrExtraction>>();
    const replacementOpen = deferred<ReturnType<typeof openedProjectWithImages>>();
    const initialProject = openedProjectWithImages([pageImage()]);
    const replacementProject = openedProjectWithImages([
      pageImage({ id: "replacement-page-image", storedRelativePath: "Replacement-assets/images/page-001.jpg" })
    ]);
    replacementProject.filePath = "C:\\projects\\Replacement.ctp";
    replacementProject.project.metadata.id = "replacement-project";
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValueOnce(initialProject).mockReturnValueOnce(replacementOpen.promise),
      saveProject: vi.fn(),
      extractSpeechBubbles: vi.fn().mockReturnValue(extraction.promise),
      validateSpeechBubbles: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await waitFor(() => expect(window.projectApi.extractSpeechBubbles).toHaveBeenCalledTimes(1));
    fireEvent.click(within(screen.getByRole("banner", { name: "앱 상단 바" })).getByRole("button", { name: "열기" }));
    await waitFor(() => expect(window.projectApi.openProject).toHaveBeenCalledTimes(2));

    await act(async () => {
      replacementOpen.resolve(replacementProject);
      await Promise.resolve();
      extraction.reject(new Error("교체 중 도착한 이전 프로젝트 OCR 실패"));
      await Promise.resolve();
    });

    expect(screen.getByText("session:ocr-test-session")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OCR 다시 실행" })).not.toBeInTheDocument();
  });

  it("moves the selected line with keyboard shortcuts", async () => {
    const firstLine: DialogueLine = {
      id: "line-shortcut-first",
      order: 1,
      pageNumber: 1,
      speaker: "First",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "First source",
      parseConfidence: 0.9,
      parseWarnings: []
    };
    const secondLine: DialogueLine = {
      id: "line-shortcut-second",
      order: 2,
      pageNumber: 1,
      speaker: "Second",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Second source",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "move-shortcuts.txt", lines: [firstLine, secondLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByText("#1 · First · 미번역")).toBeInTheDocument();

    const nextEvent = new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true });
    const nextPreventDefault = vi.spyOn(nextEvent, "preventDefault");
    act(() => {
      window.dispatchEvent(nextEvent);
    });

    expect(nextPreventDefault).toHaveBeenCalled();
    expect(screen.getByText("#2 · Second · 미번역")).toBeInTheDocument();

    const previousEvent = new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true });
    const previousPreventDefault = vi.spyOn(previousEvent, "preventDefault");
    act(() => {
      window.dispatchEvent(previousEvent);
    });

    expect(previousPreventDefault).toHaveBeenCalled();
    expect(screen.getByText("#1 · First · 미번역")).toBeInTheDocument();
  });

  it("keeps the page image and table aligned when keyboard navigation crosses pages", async () => {
    const firstLine: DialogueLine = {
      id: "line-cross-page-first",
      order: 1,
      pageNumber: 1,
      speaker: "First",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Page one source",
      parseConfidence: 0.9,
      parseWarnings: []
    };
    const secondLine: DialogueLine = {
      id: "line-cross-page-second",
      order: 2,
      pageNumber: 2,
      speaker: "Second",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Page two source",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "cross-page-shortcuts.txt", lines: [firstLine, secondLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
    expect(screen.getByLabelText("원문 1")).toHaveValue("Page one source");
    await waitFor(() => {
      expect(screen.getByText("#1 · First · 미번역")).toBeInTheDocument();
    });

    const nextEvent = new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(nextEvent);
    });

    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(screen.queryByLabelText("원문 1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("원문 2")).toHaveValue("Page two source");
    expect(screen.getByText("#2 · Second · 미번역")).toBeInTheDocument();
  });

  it("scrolls the newly selected table row into view", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const firstLine: DialogueLine = {
      id: "line-scroll-first",
      order: 1,
      pageNumber: 1,
      speaker: "First",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "First source",
      parseConfidence: 0.9,
      parseWarnings: []
    };
    const secondLine: DialogueLine = {
      id: "line-scroll-second",
      order: 2,
      pageNumber: 1,
      speaker: "Second",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Second source",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "scroll-shortcuts.txt", lines: [firstLine, secondLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    expect(await screen.findByText("#1 · First · 미번역")).toBeInTheDocument();
    openPagesPanel();
    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 접기" }));
    expect(screen.queryByRole("complementary", { name: "페이지 목록" })).not.toBeInTheDocument();
    openFullDialogueTable();
    scrollIntoView.mockClear();

    const nextEvent = new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true });
    act(() => {
      window.dispatchEvent(nextEvent);
    });

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    });
    expect(screen.getByText("#2 · Second · 미번역")).toBeInTheDocument();
  });

  it("deletes the selected line and selects the next available line", async () => {
    const firstLine: DialogueLine = {
      id: "line-delete-first",
      order: 1,
      pageNumber: 1,
      speaker: "First",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "First source",
      parseConfidence: 0.9,
      parseWarnings: []
    };
    const secondLine: DialogueLine = {
      id: "line-delete-second",
      order: 2,
      pageNumber: 1,
      speaker: "Second",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Second source",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "delete-line.txt", lines: [firstLine, secondLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    expect(await screen.findByText("#1 · First · 미번역")).toBeInTheDocument();
    openFullDialogueTable();

    fireEvent.click(screen.getByRole("button", { name: "라인 삭제" }));
    await answerAppConfirmation("대사 삭제");

    expect(screen.queryByLabelText("원문 1")).not.toBeInTheDocument();
    expect(screen.getByText("#2 · Second · 미번역")).toBeInTheDocument();
    expect(screen.getByText("1개 중 1개 표시")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("라인을 삭제했습니다.");
    openPagesPanel();
    openSettings();
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
  });

  it("filters the dialogue table to parser warning and low confidence lines", async () => {
    const cleanLine: DialogueLine = {
      id: "line-clean",
      order: 1,
      pageNumber: 1,
      speaker: "Mika",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Clean source",
      parseConfidence: 0.95,
      parseWarnings: []
    };
    const issueLine: DialogueLine = {
      id: "line-issue",
      order: 2,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "unknown",
      sourceText: "Needs review",
      parseConfidence: 0.45,
      parseWarnings: ["No speaker detected"]
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "filter.txt", lines: [cleanLine, issueLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("Clean source");
    openFullDialogueTable();
    expect(screen.getByLabelText("원문 2")).toHaveValue("Needs review");
    expect(screen.getByText("2개 중 2개 표시")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("문제 라인만 보기"));

    expect(screen.queryByLabelText("원문 1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("원문 2")).toHaveValue("Needs review");
    expect(screen.getByText("2개 중 1개 표시")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("문제 라인만 보기"));
    expect(screen.getByLabelText("원문 1")).toHaveValue("Clean source");
    expect(screen.getByText("2개 중 2개 표시")).toBeInTheDocument();
  });

  it("filters dialogue lines by search text and speaker", async () => {
    const mikaLine: DialogueLine = {
      id: "line-mika-search",
      order: 1,
      pageNumber: 1,
      speaker: "Mika",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Find the silver key",
      userTranslation: "은색 열쇠를 찾아",
      parseConfidence: 0.95,
      parseWarnings: []
    };
    const renLine: DialogueLine = {
      id: "line-ren-search",
      order: 2,
      pageNumber: 1,
      speaker: "Ren",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Wait near the gate",
      aiTranslation: "문 근처에서 기다려",
      parseConfidence: 0.9,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "search.txt", lines: [mikaLine, renLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("Find the silver key");
    openFullDialogueTable();
    expect(screen.getByText("필터는 현재 1페이지 2개 라인에만 적용됩니다. 전체 프로젝트 검색이 필요하면 범위를 바꾸세요.")).toBeInTheDocument();
    expect(screen.getByLabelText("원문 2")).toHaveValue("Wait near the gate");

    fireEvent.change(screen.getByLabelText("대사 검색"), { target: { value: "gate" } });
    expect(screen.queryByLabelText("원문 1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("원문 2")).toHaveValue("Wait near the gate");
    expect(screen.getByText("2개 중 1개 표시")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("대사 검색"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("화자 필터"), { target: { value: "Mika" } });
    expect(screen.getByLabelText("원문 1")).toHaveValue("Find the silver key");
    expect(screen.queryByLabelText("원문 2")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("대사 검색"), { target: { value: "gate" } });
    expect(screen.getByText("현재 필터와 일치하는 라인이 없습니다.")).toBeInTheDocument();
  });

  it("searches the whole project and moves to the matched line page", async () => {
    const firstLine: DialogueLine = {
      id: "line-project-search-one",
      order: 1,
      pageNumber: 1,
      speaker: "Mika",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Stay on the first page",
      parseConfidence: 0.95,
      parseWarnings: []
    };
    const secondPageLine: DialogueLine = {
      id: "line-project-search-two",
      order: 2,
      pageNumber: 2,
      speaker: "Ren",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Hidden project-wide target",
      parseConfidence: 0.95,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "project-search.txt", lines: [firstLine, secondPageLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
    openFullDialogueTable();
    expect(screen.queryByLabelText("원문 2")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("필터 범위"), { target: { value: "project" } });
    expect(screen.getByText("전체 프로젝트 2개 라인에서 검색합니다. 다른 페이지 라인을 선택하면 해당 페이지로 이동합니다.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("대사 검색"), { target: { value: "target" } });
    expect(screen.queryByLabelText("원문 1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("원문 2")).toHaveValue("Hidden project-wide target");
    expect(screen.getByText("2개 중 1개 표시")).toBeInTheDocument();

    fireEvent.click(screen.getByText("#2"));
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
  });

  it("filters dialogue lines by workflow status", async () => {
    const draftLine: DialogueLine = {
      id: "line-draft-status",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      lineStatus: "draft",
      sourceLanguage: "en",
      sourceText: "Draft source",
      parseConfidence: 0.95,
      parseWarnings: []
    };
    const completeLine: DialogueLine = {
      id: "line-complete-status",
      order: 2,
      pageNumber: 1,
      dialogueType: "speech",
      lineStatus: "complete",
      sourceLanguage: "en",
      sourceText: "Complete source",
      parseConfidence: 0.95,
      parseWarnings: []
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "status-filter.txt", lines: [draftLine, completeLine] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("Draft source");
    openFullDialogueTable();
    expect(screen.getByLabelText("원문 2")).toHaveValue("Complete source");

    fireEvent.change(screen.getByLabelText("상태 필터"), { target: { value: "complete" } });

    expect(screen.queryByLabelText("원문 1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("원문 2")).toHaveValue("Complete source");
    expect(screen.getByText("2개 중 1개 표시")).toBeInTheDocument();
  });

  it("summarizes workflow status counts and completion progress", async () => {
    const lines: DialogueLine[] = [
      {
        id: "line-status-missing",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "en",
        sourceText: "Untranslated source",
        parseConfidence: 0.95,
        parseWarnings: []
      },
      {
        id: "line-status-draft",
        order: 2,
        pageNumber: 1,
        dialogueType: "speech",
        lineStatus: "draft",
        sourceLanguage: "en",
        sourceText: "Draft source",
        parseConfidence: 0.95,
        parseWarnings: []
      },
      {
        id: "line-status-complete",
        order: 3,
        pageNumber: 1,
        dialogueType: "speech",
        lineStatus: "complete",
        sourceLanguage: "en",
        sourceText: "Complete source",
        parseConfidence: 0.95,
        parseWarnings: []
      },
      {
        id: "line-status-review",
        order: 4,
        pageNumber: 1,
        dialogueType: "speech",
        lineStatus: "review",
        sourceLanguage: "en",
        sourceText: "Review source",
        parseConfidence: 0.95,
        parseWarnings: []
      }
    ];

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "status-summary.txt", lines }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();

    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
    openFullDialogueTable();
    expect(await screen.findByLabelText("상태 요약")).toHaveTextContent("진행률 25%");
    expect(screen.getByLabelText("상태 요약")).toHaveTextContent("미번역 1");
    expect(screen.getByLabelText("상태 요약")).toHaveTextContent("초안 1");
    expect(screen.getByLabelText("상태 요약")).toHaveTextContent("완료 1");
    expect(screen.getByLabelText("상태 요약")).toHaveTextContent("검토필요 1");
  });

  it("allows parser warnings to be edited as newline-separated text", async () => {
    const line: DialogueLine = {
      id: "line-1",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "Sample source",
      parseConfidence: 0.8,
      parseWarnings: ["ambiguous speaker", "low confidence"]
    };

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "sample.txt", lines: [line] }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();

    await clickTxtStart();

    await openWorkspacePanel("수정");
    expect(await screen.findByText("파싱 신뢰도")).toBeInTheDocument();

    const warningsField = await screen.findByLabelText("파서 경고");
    expect(warningsField).toHaveValue("ambiguous speaker\nlow confidence");

    fireEvent.change(warningsField, { target: { value: " first warning \n\n second warning " } });
    expect(screen.getByLabelText("파서 경고")).toHaveValue("first warning\nsecond warning");

    fireEvent.change(screen.getByLabelText("파서 경고"), { target: { value: " \n " } });
    expect(screen.getByText("파서 경고 없음")).toBeInTheDocument();
  });

  it("saves normal projects through a selected project file path", async () => {
    const saveProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\draft.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();
    openSettings();

    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "Draft Project" } });
    fireEvent.click(screen.getByRole("button", { name: "다른 이름 저장" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 저장했습니다."));
    expect(window.projectApi.chooseSaveFile).toHaveBeenCalledWith({ defaultPath: "Draft Project.ctp" });
    expect(saveProject).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "C:\\projects\\draft.ctp",
        project: expect.objectContaining({
          metadata: expect.objectContaining({ title: "Draft Project", secret: false })
        })
      })
    );
  });

  it("exits focus mode with Escape without dismissing OCR review", async () => {
    const review = validatedReviewExtraction();
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      extractSpeechBubbles: vi.fn().mockResolvedValue(review),
      validateSpeechBubbles: vi.fn().mockResolvedValue(review)
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    expect(await screen.findByLabelText("1페이지 말풍선 OCR 검토")).toBeInTheDocument();
    expect(await screen.findByLabelText("선택된 OCR 영역")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /확대|Zoom in/i }));
    expect(screen.getByText("125%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "집중 모드 켜기" }));
    expect(screen.getByTestId("focus-deck-shell")).toHaveClass("focus-mode");
    expect(screen.getByLabelText("1페이지 말풍선 OCR 검토")).toBeInTheDocument();
    expect(screen.getByText("125%")).toBeInTheDocument();
    expect(screen.getByLabelText("선택된 OCR 영역")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("button", { name: "집중 모드 켜기" })).toBeInTheDocument();
    expect(screen.getByLabelText("1페이지 말풍선 OCR 검토")).toBeInTheDocument();
    expect(screen.getByText("125%")).toBeInTheDocument();
    expect(screen.getByLabelText("선택된 OCR 영역")).toBeInTheDocument();
  });

  it("keeps a pending OCR job alive through focus toggle and Escape", async () => {
    const extraction = deferred<ReturnType<typeof validatedReviewExtraction>>();
    const review = validatedReviewExtraction();
    const openProject = vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()]));
    const saveProject = vi.fn();
    const exportTranslations = vi.fn();
    const extractSpeechBubbles = vi.fn().mockReturnValue(extraction.promise);
    const validateSpeechBubbles = vi.fn().mockResolvedValue(review);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations,
      openProject,
      saveProject,
      importPageImages: vi.fn(),
      extractSpeechBubbles,
      validateSpeechBubbles
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "집중 모드 켜기" }));
    fireEvent.click(screen.getByRole("button", { name: "집중 모드 끄기" }));
    fireEvent.click(screen.getByRole("button", { name: "집중 모드 켜기" }));
    fireEvent.keyDown(document, { key: "Escape" });

    await act(async () => extraction.resolve(review));

    expect(await screen.findByLabelText("1페이지 말풍선 OCR 검토")).toBeInTheDocument();
    expect(validateSpeechBubbles).not.toHaveBeenCalled();
    expect(extractSpeechBubbles).toHaveBeenCalledTimes(1);
    expect(openProject).toHaveBeenCalledTimes(1);
    expect(saveProject).not.toHaveBeenCalled();
    expect(exportTranslations).not.toHaveBeenCalled();
  });

  it("keeps a pending inpainting job alive through focus toggle and Escape", async () => {
    mockCanvasForInpainting();
    const inpainting = deferred<PageImage>();
    const openProject = vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()]));
    const saveProject = vi.fn();
    const exportTranslations = vi.fn();
    const inpaintPageImage = vi.fn().mockReturnValue(inpainting.promise);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations,
      openProject,
      saveProject,
      importPageImages: vi.fn(),
      inpaintPageImage
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
    await waitFor(() => expect(inpaintPageImage).toHaveBeenCalledTimes(1));

    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    const relinkButton = within(inspector).getByRole("button", { name: "다시 연결" });
    expect(relinkButton).toBeDisabled();
    await openWorkspacePanel("페이지");
    expect(screen.getByRole("button", { name: "이미지 업로드" })).toBeDisabled();
    expect(screen.getAllByText("현재 페이지 처리가 끝난 뒤 이미지를 다시 연결하세요.").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "집중 모드 켜기" }));
    fireEvent.click(screen.getByRole("button", { name: "집중 모드 끄기" }));
    fireEvent.click(screen.getByRole("button", { name: "집중 모드 켜기" }));
    fireEvent.keyDown(document, { key: "Escape" });

    await act(async () => inpainting.resolve(pageImage({
      id: "page-image-focus-inpainted",
      storedRelativePath: "Book-assets/images/page-001-focus-inpainted.png",
      originalFileName: "scan_001_focus_inpainted.png",
      sha256: "f".repeat(64),
      mimeType: "image/png"
    })));

    expect(await screen.findByText("scan_001_focus_inpainted.png")).toBeInTheDocument();
    expect(inpaintPageImage).toHaveBeenCalledTimes(1);
    expect(openProject).toHaveBeenCalledTimes(1);
    expect(saveProject).not.toHaveBeenCalled();
    expect(exportTranslations).not.toHaveBeenCalled();
  });

  it("renders the complete Focus Deck structure with accessible independent panels", async () => {
    await renderWorkspaceApp();
    openPagesPanel();

    const shell = screen.getByTestId("focus-deck-shell");
    expect(shell.querySelector(".focus-deck-top-bar")).toBeInTheDocument();
    expect(shell.querySelector(".focus-deck-rail")).not.toBeInTheDocument();
    expect(shell.querySelector(".focus-deck-pages")).toBeInTheDocument();
    expect(shell.querySelector(".focus-deck-canvas")).toBeInTheDocument();
    expect(shell.querySelector(".focus-deck-editor")).toBeInTheDocument();
    expect(shell.querySelector(".focus-deck-filmstrip")).toBeInTheDocument();

    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("aria-valuemin", "320");
    expect(separator).toHaveAttribute("aria-valuemax", "520");
    expect(separator).toHaveAttribute("aria-valuenow");

    expect(screen.getByRole("complementary", { name: "페이지 목록" })).toBeInTheDocument();
    expect(screen.getByLabelText("현재 작업 편집기")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo", { name: "결과 및 진행" })).toBeInTheDocument();
  });

  it("keeps collapsed panel space released at desktop and narrow widths", () => {
    expect(focusDeckStyles).not.toContain(".focus-deck-rail");
    expect(focusDeckStyles).toContain(".resizable-workspace.inspector-collapsed");
    expect(focusDeckStyles).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(focusDeckStyles).toContain(".focus-deck-shell.results-collapsed");

    const responsiveContract = focusDeckStyles.slice(focusDeckStyles.lastIndexOf("/* UI-11 responsive contract."));

    expect(responsiveContract).toContain(".focus-deck-shell .focus-deck-workspace .resizable-workspace");
    expect(responsiveContract).toContain("display: grid");
    expect(responsiveContract).toContain("position: static");
    expect(responsiveContract).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(responsiveContract).not.toContain("position: fixed");
    expect(responsiveContract).not.toContain("display: block !important");
  });

  it("guards SettingsPage exits through App entryFlow and reloads the saved destination values", async () => {
    let saved = { ...DEFAULT_PROVIDER_SETTINGS, defaultStoragePath: "" };
    const updateProviderSettings = vi.fn(async (patch) => (saved = { ...saved, ...patch }));
    window.projectApi = {
      getProviderSettings: vi.fn(async () => saved), updateProviderSettings,
      getEnvironmentSnapshot: vi.fn().mockResolvedValue(createInitialEnvironmentSnapshot("C:\\SIM", "0.1.4")),
      importTxtFile: vi.fn(), chooseSaveFile: vi.fn(), exportTranslations: vi.fn(), openProject: vi.fn(), saveProject: vi.fn()
    };
    renderApp();
    fireEvent.click(within(screen.getByRole("navigation", { name: "메뉴" })).getByRole("button", { name: "설정" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "시작 화면" }), { target: { value: "projects" } });
    fireEvent.click(screen.getByRole("tab", { name: "AI 번역 엔진" }));
    fireEvent.click(screen.getByRole("button", { name: "환경 준비 확인" }));
    expect(screen.getByRole("dialog", { name: "저장하지 않은 설정" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "저장하고 이동" }));
    await screen.findByRole("heading", { name: "망고하나 환경 준비" });
    expect(updateProviderSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: "이전 화면으로" })[0]);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "시작 화면" })).toHaveValue("projects"));
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    expect(screen.queryByRole("dialog", { name: "저장하지 않은 설정" })).not.toBeInTheDocument();
    expect(screen.getByRole("main", { name: "홈 대시보드" })).toBeInTheDocument();
  });

  it("limits plain Enter to the noninteractive workspace context", async () => {
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "keys.txt", lines: [{ ...rendererLine("key-1", 1, "First"), userTranslation: "확정할 첫 번역" }, rendererLine("key-2", 2, "Second")] }),
      chooseSaveFile: vi.fn(), exportTranslations: vi.fn(), openProject: vi.fn(), saveProject: vi.fn()
    };
    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByText("#1 · 화자 없음 · 미번역");
    const settings = screen.getByRole("button", { name: "설정" });
    settings.focus();
    expect(fireEvent.keyDown(settings, { key: "Enter" })).toBe(true);
    expect(screen.getByText("#1 · 화자 없음 · 미번역")).toBeInTheDocument();
    fireEvent.click(settings); // jsdom does not synthesize the native Enter click.
    expect(settings).toHaveAttribute("aria-expanded", "true");
    const workspace = screen.getByRole("region", { name: "이미지 중심 작업 영역" });
    settings.blur();
    fireEvent.keyDown(workspace, { key: "Enter" });
    expect(screen.getByText("#1 · 화자 없음 · 미번역")).toBeInTheDocument();
    fireEvent.click(settings);
    fireEvent.keyDown(workspace, { key: "Enter", isComposing: true });
    fireEvent.keyDown(workspace, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(workspace, { key: "Enter", repeat: true });
    const handled = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    handled.preventDefault();
    fireEvent(workspace, handled);
    expect(screen.getByText("#1 · 화자 없음 · 미번역")).toBeInTheDocument();
    fireEvent.keyDown(workspace, { key: "Enter" });
    expect(screen.getByText("#1 · 화자 없음 · 완료")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "완료 표시" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "다음 라인" }));
    expect(screen.getByText("#2 · 화자 없음 · 미번역")).toBeInTheDocument();
  });

  it("keeps plain Enter in editable controls but completes from the focused translation with Ctrl+Enter", async () => {
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "keys.txt", lines: [{ ...rendererLine("key-1", 1, "First"), userTranslation: "확정할 첫 번역" }, rendererLine("key-2", 2, "Second")] }),
      chooseSaveFile: vi.fn(), exportTranslations: vi.fn(), openProject: vi.fn(), saveProject: vi.fn()
    };
    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    expect(await screen.findByText("#1 · 화자 없음 · 미번역")).toBeInTheDocument();
    openPagesPanel();
    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 접기" }));
    expect(screen.queryByRole("complementary", { name: "페이지 목록" })).not.toBeInTheDocument();

    const translation = screen.getByRole("textbox", { name: "사용자 수정문 1" });
    fireEvent.keyDown(translation, { key: "Enter" });
    expect(screen.getByText("#1 · 화자 없음 · 미번역")).toBeInTheDocument();
    fireEvent.keyDown(translation, { key: "Enter", shiftKey: true });
    expect(screen.getByText("#1 · 화자 없음 · 미번역")).toBeInTheDocument();
    translation.focus();
    fireEvent.keyDown(translation, { key: "Enter", ctrlKey: true });
    expect(screen.getByText("#1 · 화자 없음 · 완료")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "사용자 수정문 1" })).toBe(translation);
    expect(translation).toHaveFocus();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("선택한 대사의 검수를 확정했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "다음 라인" }));
    expect(screen.getByText("#2 · 화자 없음 · 미번역")).toBeInTheDocument();
  });

  it("keeps panels closed on project entry while restoring panel width and zoom", async () => {
    const opened = openedProjectWithImages([pageImage()]);
    window.localStorage.setItem(
      `focus-deck:${opened.filePath}`,
      JSON.stringify({ pagesOpen: false, inspectorOpen: true, resultsOpen: false, focusMode: false, inspectorWidth: 400, zoom: 1.25 })
    );
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(opened),
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "페이지 목록 열기" })).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "오른쪽 작업 패널" })).not.toBeInTheDocument();
    await openWorkspacePanel("수정");
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "400");
    expect(screen.getByRole("button", { name: "결과 및 진행 열기" })).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(screen.getByText("125%")).toBeInTheDocument());
    expect(screen.getByTestId("page-image-viewport")).toHaveAttribute("data-view-mode", "actual");
    fireEvent.click(screen.getByRole("button", { name: /확대|Zoom in/i }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(`focus-deck:${opened.filePath}`) ?? "null").zoom).toBe(1.5));
    fireEvent.click(screen.getByRole("button", { name: /화면 맞춤|Fit/i }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(`focus-deck:${opened.filePath}`) ?? "null").zoom).toBe(1));
  });

  it("saves resized workspace preferences under the newly selected project key", async () => {
    window.localStorage.setItem(
      "focus-deck:C:\\projects\\preferences.ctp",
      JSON.stringify({ pagesOpen: true, inspectorOpen: true, resultsOpen: true, focusMode: false, inspectorWidth: 392, zoom: 1 })
    );
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\preferences.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn().mockResolvedValue(undefined)
    };

    render(<App />);
    await importWorkspaceLine();
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft", shiftKey: true });
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "368");
    fireEvent.click(screen.getByRole("button", { name: "다른 이름 저장" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 저장했습니다."));
    await openWorkspacePanel("페이지");
    await openWorkspacePanel("진행");
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 접기" }));

    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem("focus-deck:C:\\projects\\preferences.ctp") ?? "null"))
        .toEqual({ pagesOpen: false, inspectorOpen: true, resultsOpen: true, focusMode: false, inspectorWidth: 352, zoom: 1 });
    });
  });

  it("tracks unsaved changes and clears the indicator after saving", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\dirty.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([], [rendererLine("dirty-line", 1, "Dirty line")])),
      saveProject: vi.fn().mockResolvedValue(undefined)
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
    openSettings();

    expect(await screen.findByText("저장하지 않은 변경사항이 없습니다.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "Dirty Project" } });
    expect(await screen.findByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다른 이름 저장" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 저장했습니다."));
    expect(await screen.findByText("저장하지 않은 변경사항이 없습니다.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "캐릭터 추가" }));
    fireEvent.change(screen.getByLabelText("캐릭터 이름 1"), { target: { value: "Mika" } });
    expect(screen.getByText("변경 있음")).toBeInTheDocument();
  });

  it("keeps the current project when new project is canceled with unsaved changes", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();
    openSettings();

    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "Keep This Project" } });
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));

    expect(screen.getByRole("alertdialog", { name: "저장하지 않은 변경사항을 버릴까요?" })).toBeVisible();
    await answerAppConfirmation("계속 편집");
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("Keep This Project");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
  });

  it("moves Workspace New to Setup without opening image selection", async () => {
    const choosePreparedPageImageFiles = vi.fn().mockResolvedValue(null);
    const saveProject = vi.fn();
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "old.txt",
        lines: [rendererLine("old-line", 1, "기존 대사")]
      }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject,
      choosePreparedPageImageFiles,
      importPageImages: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("기존 대사")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    await answerAppConfirmation("버리고 이동");

    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeVisible();
    expect(choosePreparedPageImageFiles).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.getByRole("heading", { name: "번역 프로젝트" })).toBeVisible();
    expect(saveProject).not.toHaveBeenCalled();
  });

  it("does not open another project when open is canceled with unsaved changes", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();
    openSettings();

    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "Do Not Replace" } });
    fireEvent.click(within(screen.getByRole("banner", { name: "앱 상단 바" })).getByRole("button", { name: "열기" }));

    expect(screen.getByRole("alertdialog", { name: "저장하지 않은 변경사항을 버릴까요?" })).toBeVisible();
    await answerAppConfirmation("계속 편집");
    expect(window.projectApi.openProject).not.toHaveBeenCalled();
    await openWorkspacePanel("수정");
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("Do Not Replace");
  });

  it("explains a project file that disappears after selection without exposing the technical path", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(), chooseSaveFile: vi.fn(), exportTranslations: vi.fn(), saveProject: vi.fn(),
      openProject: vi.fn().mockRejectedValue(new Error("ENOENT: fixture-only/missing.ctp"))
    };
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    expect(await screen.findByText("프로젝트 파일을 찾을 수 없습니다. 파일이 이동되었거나 삭제되었는지 확인한 뒤 다시 선택하세요.")).toBeVisible();
    expect(screen.queryByText(/ENOENT|fixture-only\/missing/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "기존 프로젝트 열기" })).toBeEnabled();
  });

  it("opens the project file dialog before asking for a secret project password", async () => {
    const openProject = vi.fn().mockResolvedValue(null);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject,
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    await waitFor(() => expect(openProject).toHaveBeenCalledWith());
    expect(screen.queryByRole("dialog", { name: "시크릿 프로젝트 암호" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("프로젝트 암호")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("열기를 취소했습니다.");
  });

  it("opens projects and replaces the active editor state", async () => {
    const openedLine: DialogueLine = {
      id: "opened-line",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "開いた台詞",
      parseConfidence: 0.9,
      parseWarnings: []
    };
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue({
        filePath: "C:\\projects\\opened.ctp",
        encrypted: false,
        project: {
          schemaVersion: 1,
          metadata: {
            id: "project-opened",
            title: "열린 프로젝트",
            createdAt: "2026-05-27T00:00:00.000Z",
            updatedAt: "2026-05-27T00:00:00.000Z",
            secret: false
          },
          characters: [],
          dictionaryTerms: [],
          dialogueLines: [openedLine],
          settings: { defaultSourceLanguage: "unknown" }
        }
      }),
      saveProject: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));

    await openWorkspacePanel("수정");
    expect(await screen.findByDisplayValue("開いた台詞")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 열었습니다.");
    expect(screen.getByText("C:\\projects\\opened.ctp")).toBeInTheDocument();
  });

  it("exports the current project translations to txt", async () => {
    const exportTranslations = vi.fn().mockResolvedValue("C:\\projects\\draft.txt");
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "draft.txt",
        lines: [rendererLine("draft-line", 1, "Draft source")]
      }),
      chooseSaveFile: vi.fn(),
      exportTranslations,
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await importWorkspaceLine();
    openPagesPanel();
    openSettings();
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "Draft Project" } });
    fireEvent.click(within(screen.getByRole("complementary", { name: "왼쪽 보조 패널" })).getByRole("button", { name: "TXT 불러오기" }));
    await screen.findByLabelText("원문 1");
    fireEvent.click(screen.getByRole("button", { name: "TXT 내보내기" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("번역문을 내보냈습니다."));
    expect(exportTranslations).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "Draft Project.txt",
        project: expect.objectContaining({
          metadata: expect.objectContaining({ title: "Draft Project" })
        })
      })
    );
  });

  it("keeps project action controls accessible while using compact visible labels", () => {
    renderApp();
    openTxtStartActions();

    expect(screen.getByRole("button", { name: "새 번역 프로젝트" })).toHaveTextContent("새 번역 프로젝트");
    expect(screen.getByRole("button", { name: "TXT로 시작" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "새로 만들기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다른 이름 저장" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "TXT 내보내기" })).not.toBeInTheDocument();
  });

  it("edits character profiles and dictionary terms in project context", async () => {
    await renderWorkspaceApp();

    fireEvent.click(screen.getByRole("button", { name: "캐릭터 추가" }));
    fireEvent.change(screen.getByLabelText("캐릭터 이름 1"), { target: { value: "Mika" } });
    fireEvent.change(screen.getByLabelText("캐릭터 별칭 1"), { target: { value: "Mi, M" } });
    fireEvent.change(screen.getByLabelText("캐릭터 설명 1"), { target: { value: "Lead character" } });
    fireEvent.change(screen.getByLabelText("캐릭터 말투 1"), { target: { value: "blunt, casual" } });
    expect(screen.getByDisplayValue("Mika")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Lead character")).toBeInTheDocument();
    expect(screen.getByText(/캐릭터 1명 · 사용자 사전 0개/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "용어 추가" }));
    fireEvent.change(screen.getByLabelText("원문 용어 1"), { target: { value: "senpai" } });
    fireEvent.change(screen.getByLabelText("번역 용어 1"), { target: { value: "선배" } });
    fireEvent.change(screen.getByLabelText("용어 메모 1"), { target: { value: "Keep relationship tone" } });
    expect(screen.getByDisplayValue("선배")).toBeInTheDocument();
    expect(screen.getByText(/캐릭터 1명 · 사용자 사전 1개/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "캐릭터 1 삭제" }));
    fireEvent.click(screen.getByRole("button", { name: "용어 1 삭제" }));
    expect(screen.getByText(/캐릭터 0명 · 사용자 사전 0개/)).toBeInTheDocument();
  });

  it("keeps Context expanded after character edits rerender a non-viewer workspace", async () => {
    expect(appSource).toContain("const [contextOpen, setContextOpen] = useState<boolean | null>(null)");
    expect(appSource).toContain("open={contextOpen ?? false}");
    expect(appSource).toContain("onToggle={(event) => setContextOpen(event.currentTarget.open)}");
    expect(appSource).not.toContain('open={workspaceMode === "viewer"}');
    await renderWorkspaceApp();
    const summary = screen.getByText("등장인물·용어").closest("summary");
    const context = summary?.closest("details");
    expect(summary).not.toBeNull();
    expect(context).not.toBeNull();

    fireEvent.click(summary!);
    expect(context).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "캐릭터 추가" }));
    fireEvent.change(screen.getByLabelText("캐릭터 이름 1"), { target: { value: "Mika" } });

    expect(context).toHaveAttribute("open");
    expect(screen.getByDisplayValue("Mika")).toBeInTheDocument();
  });

  function installSessionGlossaryWorkspace(options: {
    characters?: TranslationProjectV2["characters"];
    dictionaryTerms?: TranslationProjectV2["dictionaryTerms"];
  } = {}) {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Glossary Session", false));
    openedProject.dialogueLines = [{
      ...rendererLine("session-line", 1, "대사"),
      origin: { kind: "manual" }
    }];
    openedProject.characters = options.characters ?? [];
    openedProject.dictionaryTerms = options.dictionaryTerms ?? [];
    let sessionProject = structuredClone(openedProject);
    let sessionRevision = 1;
    let persistedProject = structuredClone(openedProject);
    const dto = (project: TranslationProjectV2, revision: number, dirty: boolean) => ({
      revision,
      project: structuredClone(project),
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const applyProjectMutation = vi.fn(async (args: ApplyProjectMutationArgs) => {
      const normalized = validateAndNormalizeProjectMutation(sessionProject, args.mutation);
      sessionProject = applyNormalizedProjectMutation(sessionProject, normalized.mutation);
      sessionRevision += 1;
      return {
        status: "applied" as const,
        revision: sessionRevision,
        project: dto(sessionProject, sessionRevision, true)
      };
    });
    const saveProject = vi.fn(async () => {
      persistedProject = structuredClone(sessionProject);
      return {
        projectSessionId: "opened-session",
        project: dto(sessionProject, sessionRevision, false)
      };
    });
    const openProjectFromDialog = vi.fn()
      .mockResolvedValueOnce({
        projectSessionId: "opened-session",
        project: dto(openedProject, 1, false),
        encrypted: false
      })
      .mockImplementation(async () => ({
        projectSessionId: "reopened-session",
        project: dto(persistedProject, sessionRevision, false),
        encrypted: false
      }));
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(initialProject, 0, false),
        encrypted: false
      }),
      openProjectFromDialog,
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject,
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };
    return {
      applyProjectMutation,
      saveProject,
      getSessionProject: () => sessionProject,
      getPersistedProject: () => persistedProject,
      characterUpserts: () =>
        applyProjectMutation.mock.calls
          .map(([args]) => args.mutation)
          .filter((mutation) => mutation.type === "upsert_character"),
      termUpserts: () =>
        applyProjectMutation.mock.calls
          .map(([args]) => args.mutation)
          .filter((mutation) => mutation.type === "upsert_dictionary_term")
    };
  }

  async function openSessionGlossaryWorkspace() {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
  }

  it("does not send an invalid upsert_character when only adding a character in the session workflow", async () => {
    const harness = installSessionGlossaryWorkspace();
    await openSessionGlossaryWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "캐릭터 추가" }));
    expect(screen.getByLabelText("캐릭터 이름 1")).toHaveValue("");
    await waitFor(() => expect(harness.characterUpserts()).toEqual([]));

    fireEvent.change(screen.getByLabelText("캐릭터 이름 1"), { target: { value: "나미" } });
    await waitFor(() => {
      expect(harness.characterUpserts()).toEqual([
        expect.objectContaining({
          type: "upsert_character",
          character: expect.objectContaining({ name: "나미", aliases: [] })
        })
      ]);
    });
    expect(harness.getSessionProject().characters).toEqual([
      expect.objectContaining({ name: "나미" })
    ]);
  });

  it("does not send an invalid upsert_dictionary_term until source and target are both valid", async () => {
    const harness = installSessionGlossaryWorkspace();
    await openSessionGlossaryWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "용어 추가" }));
    fireEvent.change(screen.getByLabelText("원문 용어 1"), { target: { value: "先輩" } });
    await waitFor(() => expect(harness.termUpserts()).toEqual([]));

    fireEvent.change(screen.getByLabelText("번역 용어 1"), { target: { value: "선배님" } });
    await waitFor(() => {
      expect(harness.termUpserts()).toEqual([
        expect.objectContaining({
          type: "upsert_dictionary_term",
          term: expect.objectContaining({ source: "先輩", target: "선배님" })
        })
      ]);
    });
  });

  it("does not fail Main validation while replacing a persisted character name or term source in the session workflow", async () => {
    const harness = installSessionGlossaryWorkspace({
      characters: [{
        id: "char-luffy",
        name: "루피",
        aliases: ["ルフィ"],
        description: "선장",
        speechStyle: "활발한 반말",
        relationshipNotes: "밀짚모자 선장"
      }],
      dictionaryTerms: [{
        id: "term-fruit",
        source: "ゴムゴムの実",
        target: "고무고무 열매",
        note: "악마의 열매",
        priority: 5,
        condition: { speaker: "루피", targetContext: "능력" }
      }]
    });
    await openSessionGlossaryWorkspace();

    fireEvent.change(screen.getByLabelText("캐릭터 이름 1"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("원문 용어 1"), { target: { value: "" } });
    await waitFor(() => {
      expect(harness.characterUpserts()).toEqual([]);
      expect(harness.termUpserts()).toEqual([]);
    });
    expect(harness.getSessionProject().characters[0]?.name).toBe("루피");
    expect(harness.getSessionProject().dictionaryTerms[0]?.source).toBe("ゴムゴムの実");

    fireEvent.change(screen.getByLabelText("캐릭터 이름 1"), { target: { value: "몽키 D. 루피" } });
    fireEvent.change(screen.getByLabelText("원문 용어 1"), { target: { value: "ゴムゴム" } });
    await waitFor(() => {
      expect(harness.getSessionProject().characters[0]).toEqual(expect.objectContaining({
        id: "char-luffy",
        name: "몽키 D. 루피",
        aliases: ["ルフィ"],
        relationshipNotes: "밀짚모자 선장"
      }));
      expect(harness.getSessionProject().dictionaryTerms[0]).toEqual(expect.objectContaining({
        id: "term-fruit",
        source: "ゴムゴム",
        target: "고무고무 열매",
        note: "악마의 열매",
        priority: 5,
        condition: { speaker: "루피", targetContext: "능력" }
      }));
    });

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(harness.saveProject).toHaveBeenCalled());
    fireEvent.click(within(screen.getByRole("banner", { name: "앱 상단 바" })).getByRole("button", { name: "열기" }));
    expect(await screen.findByDisplayValue("몽키 D. 루피")).toBeInTheDocument();
    expect(screen.getByDisplayValue("ゴムゴム")).toBeInTheDocument();
    expect(harness.getPersistedProject().characters[0]?.name).toBe("몽키 D. 루피");
    expect(harness.getPersistedProject().dictionaryTerms[0]?.source).toBe("ゴムゴム");
  });

  it("Task 8 user path: creates a naturally sorted 12-page project after save cancel preserves the draft", async () => {
    const prepared = [10, 2, 12, 1, 11, 4, 7, 3, 8, 6, 9, 5].map((pageNumber) =>
      preparedPageImage({
        id: `prepared-${pageNumber}`,
        sourcePath: `C:\\images\\page-${pageNumber}.jpg`,
        fileName: `page-${pageNumber}.jpg`,
        previewSrc: `translation-image://asset/prepared-${pageNumber}`
      })
    );
    const chooseSaveFile = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("C:\\projects\\Twelve Pages.ctp");
    const saveProject = vi.fn().mockResolvedValue(undefined);
    const importPageImages = vi.fn().mockImplementation(
      ({ files }: { files: Array<{ sourcePath: string; pageNumber: number }> }) =>
        Promise.resolve(files.map((file) => ({
          ok: true as const,
          pageImage: pageImage({
            id: `page-image-${file.pageNumber}`,
            pageNumber: file.pageNumber,
            originalFileName: file.sourcePath.split("\\").at(-1) ?? "page.jpg"
          })
        })))
    );
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile,
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject,
      choosePreparedPageImageFiles: vi.fn().mockResolvedValue(prepared),
      releasePreparedPageImages: vi.fn().mockResolvedValue(undefined),
      importPageImages,
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-current")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "page-1.jpg" });

    expect(screen.getAllByRole("img").map((image) => image.getAttribute("alt"))).toEqual(
      Array.from({ length: 12 }, (_, index) => `page-${index + 1}.jpg`)
    );
    fireEvent.click(screen.getByRole("button", { name: "page-12.jpg 왼쪽으로 이동" }));
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByText("프로젝트 만들기를 취소했습니다.")).toBeVisible();
    expect(screen.getAllByRole("img")).toHaveLength(12);
    expect(screen.queryByRole("radio", { name: /세밀한 검토/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));
    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeVisible();
    expect(importPageImages).toHaveBeenCalledWith({
      projectFilePath: "C:\\projects\\Twelve Pages.ctp",
      files: [
        ...Array.from({ length: 10 }, (_, index) => ({
          sourcePath: `C:\\images\\page-${index + 1}.jpg`,
          pageNumber: index + 1
        })),
        { sourcePath: "C:\\images\\page-12.jpg", pageNumber: 11 },
        { sourcePath: "C:\\images\\page-11.jpg", pageNumber: 12 }
      ]
    });
    expect(saveProject).toHaveBeenCalledTimes(2);
    for (const [args] of saveProject.mock.calls) {
      expect(args.project.settings).not.toHaveProperty("translationMode");
    }
  });

  it("Task 8 user path: creates a dropped multi-image project in drop order", async () => {
    const droppedFiles = ["page-3.png", "page-1.png", "page-2.png"].map(
      (name) => new File([name], name, { type: "image/png" })
    );
    const sourcePaths = droppedFiles.map((file) => `C:\\images\\${file.name}`);
    const preparePageImageFiles = vi.fn().mockImplementation((paths: string[]) =>
      Promise.resolve(paths.map((sourcePath, index) => preparedPageImage({
        id: `dropped-${index}`,
        sourcePath,
        fileName: sourcePath.split("\\").at(-1) ?? "page.png",
        previewSrc: `translation-image://asset/dropped-${index}`
      })))
    );
    const saveProject = vi.fn().mockResolvedValue(undefined);
    const importPageImages = vi.fn().mockImplementation(
      ({ files }: { files: Array<{ sourcePath: string; pageNumber: number }> }) =>
        Promise.resolve(files.map((file) => ({
          ok: true as const,
          pageImage: pageImage({ id: `dropped-page-${file.pageNumber}`, pageNumber: file.pageNumber })
        })))
    );
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Dropped.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject,
      getPathForFile: vi.fn((file: File) => `C:\\images\\${file.name}`),
      preparePageImageFiles,
      releasePreparedPageImages: vi.fn().mockResolvedValue(undefined),
      importPageImages,
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-current")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.drop(await screen.findByTestId("project-image-drop-zone"), { dataTransfer: { files: droppedFiles } });
    await screen.findByRole("img", { name: "page-3.png" });
    expect(screen.getAllByRole("img").map((image) => image.getAttribute("alt"))).toEqual(
      droppedFiles.map((file) => file.name)
    );
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 만들기" }));

    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeVisible();
    expect(preparePageImageFiles).toHaveBeenCalledWith(sourcePaths);
    expect(importPageImages).toHaveBeenCalledWith({
      projectFilePath: "C:\\projects\\Dropped.ctp",
      files: sourcePaths.map((sourcePath, index) => ({ sourcePath, pageNumber: index + 1 }))
    });
    expect(saveProject).toHaveBeenCalledTimes(2);
    for (const [args] of saveProject.mock.calls) {
      expect(args.project.settings).not.toHaveProperty("translationMode");
    }
  });

  it("Task 8 user path: opens an old project, reviews highlighted OCR, edits dialogue, and saves", async () => {
    const saveProject = vi.fn().mockResolvedValue(undefined);
    const review = validatedReviewExtraction();
    const opened = openedProjectWithImages([pageImage()]);
    expect(opened.project.settings).not.toHaveProperty("translationMode");
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(opened),
      saveProject,
      extractSpeechBubbles: vi.fn().mockResolvedValue(review),
      validateSpeechBubbles: vi.fn().mockResolvedValue(review),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));

    expect(await screen.findByLabelText("선택된 OCR 영역")).toHaveTextContent("OCR 후보 #1");
    fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await waitFor(() => expect(
      screen.getByText("번역 수정", { selector: "li strong" }).closest("li")
    ).toHaveAttribute("aria-current", "step"));
    openFullDialogueTable();
    fireEvent.click(await screen.findByTitle(/\] 첫 번째 OCR/));
    const translation = await screen.findByLabelText("사용자 수정문 2");
    fireEvent.change(translation, { target: { value: "첫 번째 번역 수정" } });
    await waitFor(() => expect(window.projectApi.applyProjectMutation).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        type: "update_dialogue_line",
        patch: expect.objectContaining({ userTranslation: "첫 번째 번역 수정" })
      })
    })));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("프로젝트를 저장했습니다."));
    expect(saveProject).toHaveBeenCalledWith(expect.objectContaining({
      filePath: "C:\\projects\\Book.ctp",
      project: expect.objectContaining({
        dialogueLines: expect.arrayContaining([expect.objectContaining({ userTranslation: "첫 번째 번역 수정" })])
      })
    }));
  });

  it("Task 8 user path: restores all previously collapsed regions after focus mode exits with Escape", async () => {
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    expect(await screen.findByAltText("1페이지 이미지")).toBeVisible();
    await openWorkspacePanel("페이지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 접기" }));
    fireEvent.click(screen.getByRole("button", { name: /작업 인스펙터 접기|번역 편집기 접기/ }));
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 접기" }));

    const shell = screen.getByTestId("focus-deck-shell");
    expect(shell).toHaveClass("pages-collapsed", "inspector-collapsed", "results-collapsed");
    expect(screen.getByTestId("page-image-viewport")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "집중 모드 켜기" }));
    expect(shell).toHaveClass("focus-mode");
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("button", { name: "집중 모드 켜기" })).toBeVisible();
    expect(screen.getByRole("button", { name: "페이지 목록 열기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /작업 인스펙터 열기|번역 편집기 열기/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "결과 및 진행 열기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("page-image-viewport")).toBeVisible();
  });

  it("loads runtime status on workspace entry and returns from preparation without losing the workbench route", async () => {
    const environmentSnapshot = createInitialEnvironmentSnapshot("C:\\resources", "0.1.0");
    const getEnvironmentSnapshot = vi.fn().mockResolvedValue(environmentSnapshot);
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "workspace.txt",
        lines: [rendererLine("runtime-status-line", 1, "Runtime status line")]
      }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      getEnvironmentSnapshot
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");

    expect(await screen.findByTestId("runtime-status-control")).toBeInTheDocument();
    await waitFor(() => expect(getEnvironmentSnapshot).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("runtime-status-control"));
    expect(await screen.findByRole("heading", { name: "망고하나 환경 준비" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "작업대로 돌아가기" })[0]);
    expect(await screen.findByTestId("focus-deck-shell")).toBeInTheDocument();
    expect(screen.getByTestId("runtime-status-control")).toBeInTheDocument();
  });

  it("ignores a stale preparation snapshot after returning to a newer workspace request", async () => {
    const baseline = createInitialEnvironmentSnapshot("C:\\resources", "0.1.0");
    const stale = deferred<typeof baseline>();
    const latest = deferred<typeof baseline>();
    const readySnapshot = {
      ...baseline,
      components: baseline.components.map((component) => ({
        ...component,
        status: "ready" as const,
        disabledReason: undefined,
        message: "준비됨"
      }))
    };
    const getEnvironmentSnapshot = vi.fn()
      .mockResolvedValueOnce(baseline)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001"),
      getEnvironmentSnapshot
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await waitFor(() => expect(getEnvironmentSnapshot).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("runtime-status-control"));
    expect(await screen.findByRole("heading", { name: "망고하나 환경 준비" })).toBeInTheDocument();
    await waitFor(() => expect(getEnvironmentSnapshot).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getAllByRole("button", { name: "작업대로 돌아가기" })[0]);
    await screen.findByTestId("focus-deck-shell");
    await waitFor(() => expect(getEnvironmentSnapshot).toHaveBeenCalledTimes(3));

    await act(async () => latest.resolve(readySnapshot));
    expect(screen.getByTestId("runtime-status-control")).toHaveAttribute("data-status", "ready");
    await act(async () => stale.resolve(baseline));
    expect(screen.getByTestId("runtime-status-control")).toHaveAttribute("data-status", "ready");
  });

  it("restores the same project, page, selected line, collapsed panels, and image viewport after preparation", async () => {
    const putImageData = vi.fn();
    mockCanvasForInpainting(true, putImageData);
    const opened = openedProjectWithImages(
      [
        pageImage(),
        pageImage({ id: "page-image-2", pageNumber: 2, storedRelativePath: "Book-assets/images/page-002.jpg", originalFileName: "scan_002.jpg" })
      ],
      [
        rendererLine("roundtrip-line-1", 1, "First page line"),
        rendererLine("roundtrip-line-2", 2, "Second page line", 2)
      ]
    );
    const readyEnvironment = createInitialEnvironmentSnapshot("C:\\resources", "0.1.0");
    const environmentSnapshot = {
      ...readyEnvironment,
      components: readyEnvironment.components.map((component) => ({
        ...component,
        status: "ready" as const,
        disabledReason: undefined,
        message: "준비됨"
      }))
    };
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(opened),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page"),
      getEnvironmentSnapshot: vi.fn().mockResolvedValue(environmentSnapshot)
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByAltText("2페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByText("#2 · 화자 없음 · 미번역"));
    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    fireEvent.click(screen.getByRole("button", { name: /확대|Zoom in/i }));
    expect(screen.getByTestId("page-image-viewport")).toHaveAttribute("data-view-mode", "actual");
    expect(screen.getByText("125%", { selector: ".page-image-zoom" })).toBeInTheDocument();
    const stage = screen.getByTestId("page-image-viewport");
    stage.scrollLeft = 37;
    stage.scrollTop = 19;
    fireEvent.scroll(stage);
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("2페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(screen.getByTestId("semantic-overlay-inpainting-mask:active")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    await openWorkspacePanel("페이지");
    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 접기" }));
    fireEvent.click(screen.getByRole("button", { name: /작업 인스펙터 접기|번역 편집기 접기/ }));
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 접기" }));
    const shell = screen.getByTestId("focus-deck-shell");
    expect(shell).toHaveClass("pages-collapsed", "inspector-collapsed", "results-collapsed");

    fireEvent.click(screen.getByTestId("runtime-status-control"));
    expect(await screen.findByRole("heading", { name: "망고하나 환경 준비" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "작업대로 돌아가기" })[0]);
    await screen.findByTestId("focus-deck-shell");

    expect(screen.getByText("C:\\projects\\Book.ctp")).toBeInTheDocument();
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    const returnedTargetImage = screen.getByAltText("2페이지 인페인팅 대상");
    fireEvent.load(returnedTargetImage);
    expect(putImageData).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /OpenAI/ })).toBeEnabled();
      expect(screen.getByRole("button", { name: /Gemini/ })).toBeEnabled();
    });
    const returnedShell = screen.getByTestId("focus-deck-shell");
    expect(returnedShell).toHaveClass("pages-collapsed", "inspector-collapsed", "results-collapsed");
    expect(screen.getByTestId("page-image-viewport")).toHaveAttribute("data-view-mode", "actual");
    expect(screen.getByText("125%", { selector: ".page-image-zoom" })).toBeInTheDocument();
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollLeft", 37);
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollTop", 19);
    expect(screen.getByTestId("semantic-overlay-inpainting-mask:active")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("2페이지 인페인팅 편집기")).not.toBeInTheDocument();
    // Closing the tool hides its overlay; page-specific draft restoration is
    // verified by reopening both pages in the mask draft navigation test.
    expect(screen.queryByTestId("semantic-overlay-inpainting-mask:active")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /작업 인스펙터 열기|번역 편집기 열기/ }));
    expect(await screen.findByLabelText("사용자 수정문 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /작업 인스펙터 접기|번역 편집기 접기/ }));
    expect(screen.getByTestId("focus-deck-shell")).toHaveClass("inspector-collapsed");
  });

  it("keeps capability actions disabled with a concrete status reason until the first environment snapshot arrives", async () => {
    const pending = deferred<ReturnType<typeof createInitialEnvironmentSnapshot>>();
    const ready = createInitialEnvironmentSnapshot("C:\\resources", "0.1.0");
    const readySnapshot = {
      ...ready,
      components: ready.components.map((component) => ({
        ...component,
        status: "ready" as const,
        disabledReason: undefined,
        message: "준비됨"
      }))
    };
    const getEnvironmentSnapshot = vi.fn().mockReturnValue(pending.promise);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001"),
      getEnvironmentSnapshot
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await waitFor(() => expect(getEnvironmentSnapshot).toHaveBeenCalledTimes(1));
    await openWorkspacePanel("수정");
    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(within(inspector).getByRole("button", { name: "말풍선 OCR" })).toBeDisabled();
    expect(within(inspector).getByRole("button", { name: "인페인팅" })).toBeDisabled();
    expect(screen.getByText(/환경 상태를 확인하는 중입니다.*환경 준비에서 다시 확인하세요/, { selector: "#inspector-ocr-disabled-reason" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /화면 맞춤|Fit/i })).toBeEnabled();

    await act(async () => pending.resolve(readySnapshot));
    await waitFor(() => {
      expect(within(inspector).getByRole("button", { name: "말풍선 OCR" })).toBeEnabled();
      expect(within(inspector).getByRole("button", { name: "인페인팅" })).toBeEnabled();
    });
  });

  it("retains ready capabilities when a later environment refresh fails", async () => {
    const ready = createInitialEnvironmentSnapshot("C:\\resources", "0.1.0");
    const readySnapshot = {
      ...ready,
      components: ready.components.map((component) => ({
        ...component,
        status: "ready" as const,
        disabledReason: undefined,
        message: "준비됨"
      }))
    };
    const getEnvironmentSnapshot = vi.fn()
      .mockResolvedValueOnce(readySnapshot)
      .mockRejectedValue(new Error("환경 확인 실패"));
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001"),
      getEnvironmentSnapshot
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await waitFor(() => expect(getEnvironmentSnapshot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("runtime-status-control")).toHaveAttribute("data-status", "ready"));

    fireEvent.click(screen.getByTestId("runtime-status-control"));
    expect(await screen.findByRole("heading", { name: "망고하나 환경 준비" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "환경 다시 확인" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("환경 확인 실패");
    fireEvent.click(screen.getAllByRole("button", { name: "작업대로 돌아가기" })[0]);
    await screen.findByTestId("focus-deck-shell");
    await waitFor(() => expect(screen.getByTestId("runtime-status-control")).toHaveAttribute("data-status", "ready"));
    await openWorkspacePanel("수정");
    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(within(inspector).getByRole("button", { name: "말풍선 OCR" })).toBeEnabled();
    expect(within(inspector).getByRole("button", { name: "인페인팅" })).toBeEnabled();
  });

  it("disables only blocked OCR while ready inpainting and manual editing remain available", async () => {
    const extractSpeechBubbles = vi.fn();
    const inpaintPageImage = vi.fn();
    const environmentSnapshot = createInitialEnvironmentSnapshot("C:\\resources", "0.1.0");
    const mixedEnvironmentSnapshot = {
      ...environmentSnapshot,
      components: environmentSnapshot.components.map((component) =>
        component.id === "inpainting"
          ? {
              ...component,
              status: "ready" as const,
              disabledReason: undefined,
              message: "인페인팅이 준비되었습니다."
            }
          : component
      )
    };
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([pageImage()])),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001"),
      extractSpeechBubbles,
      validateSpeechBubbles: vi.fn(),
      inpaintPageImage,
      getEnvironmentSnapshot: vi.fn().mockResolvedValue(mixedEnvironmentSnapshot)
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    const ocrButton = within(inspector).getByRole("button", { name: "말풍선 OCR" });
    const inpaintingButton = within(inspector).getByRole("button", { name: "인페인팅" });

    await waitFor(() => {
      expect(ocrButton).toBeDisabled();
      expect(inpaintingButton).toBeEnabled();
    });
    expect(screen.getByText(/환경 준비에서 OCR 상태를 확인하세요/, { selector: "#inspector-ocr-disabled-reason" })).toBeInTheDocument();
    expect(ocrButton).toHaveAttribute("aria-describedby", "inspector-ocr-disabled-reason");
    fireEvent.keyDown(window, { key: " " });
    expect(extractSpeechBubbles).not.toHaveBeenCalled();
    expect(screen.getByText(/서명 검증된 Production OCR 리소스가 준비될 때까지 OCR을 사용할 수 없습니다\./, { selector: "#inspector-ocr-disabled-reason" })).toBeInTheDocument();
    expect(inpaintPageImage).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /화면 맞춤|Fit/i })).toBeEnabled();
    const translation = await screen.findByLabelText("사용자 수정문 1");
    expect(translation).toBeEnabled();
  });

  it("creates and focuses a manual dialogue line without calling OCR when OCR resources are blocked", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(openedProjectWithImages([pageImage()], []).project);
    const sessionDto = (project: TranslationProjectV2, revision: number, dirty = false) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const extractSpeechBubbles = vi.fn();
    const applyProjectMutation = vi.fn(async (args: ApplyProjectMutationArgs) => {
      if (args.mutation.type !== "add_dialogue_line") throw new Error("unexpected mutation");
      const input = args.mutation.input;
      const createdLine = {
        ...rendererLine("manual-main-line", 1, input.sourceText, input.pageNumber),
        sourceLanguage: input.sourceLanguage,
        dialogueType: input.dialogueType,
        lineStatus: input.lineStatus,
        parseConfidence: 1,
        origin: { kind: "manual" as const }
      };
      return {
        status: "applied" as const,
        revision: 2,
        project: sessionDto({ ...openedProject, dialogueLines: [createdLine] }, 2, true)
      };
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: sessionDto(initialProject, 0),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: sessionDto(openedProject, 1),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://page-001"),
      extractSpeechBubbles,
      getEnvironmentSnapshot: vi.fn().mockResolvedValue(createInitialEnvironmentSnapshot("C:\\resources", "0.1.0"))
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(screen.getByTestId("focus-deck-shell")).not.toHaveClass("canvas-priority");
    expect(await within(inspector).findByRole("button", { name: "환경 준비" })).toBeEnabled();
    fireEvent.click(within(inspector).getByRole("button", { name: "수동 대사 추가" }));
    const manualSource = within(inspector).getByLabelText("수동 대사 원문");
    const createManualLine = within(inspector).getByRole("button", { name: "대사 만들기" });
    expect(createManualLine).toBeDisabled();
    fireEvent.change(manualSource, { target: { value: "   " } });
    expect(createManualLine).toBeDisabled();
    fireEvent.change(manualSource, {
      target: { value: "  手動の台詞  " }
    });
    fireEvent.click(createManualLine);

    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledWith(expect.objectContaining({
      projectSessionId: "opened-session",
      baseRevision: 1,
      mutation: {
        type: "add_dialogue_line",
        input: {
          pageNumber: 1,
          sourceLanguage: "unknown",
          sourceText: "手動の台詞",
          dialogueType: "speech",
          lineStatus: "untranslated"
        }
      }
    })));
    const translation = await screen.findByLabelText("사용자 수정문 1");
    await waitFor(() => expect(translation).toHaveFocus());
    expect(screen.getByText(/식자 영역 미지정/)).toBeVisible();
    expect(extractSpeechBubbles).not.toHaveBeenCalled();
  });

  it("gates only OCR and inpainting on the current page until a pending image is saved", async () => {
    const sourcePage = pageImage();
    const secondPage = pageImage({
      id: "page-image-2",
      pageNumber: 2,
      storedRelativePath: "Book-assets/images/page-002.jpg"
    });
    const openedProject = normalizeProject(openedProjectWithImages([
      sourcePage,
      secondPage
    ], [
      rendererLine("page-one-line", 1, "page-one-text", 1),
      rendererLine("page-two-line", 1, "page-two-text", 2)
    ]).project);
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const dto = (project: typeof openedProject, pendingPageImages: unknown[] = []) => ({
      revision: pendingPageImages.length > 0 ? 1 : 2,
      project,
      pendingPageImages,
      dirty: pendingPageImages.length > 0,
      status: "active" as const
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(initialProject),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, [{ pageNumber: 1, pageImageId: sourcePage.id }]),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation: vi.fn(),
      saveProject: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject)
      }),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      extractSpeechBubbles: vi.fn(),
      validateSpeechBubbles: vi.fn(),
      inpaintPageImage: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(within(inspector).getByRole("button", { name: "말풍선 OCR" })).toBeDisabled();
    expect(within(inspector).getByRole("button", { name: "인페인팅" })).toBeDisabled();
    expect(screen.getAllByText(/새로 연결한 이미지를 먼저 저장해야 OCR\/인페인팅할 수 있습니다\./).length).toBeGreaterThan(0);
    expect(within(inspector).getByLabelText("사용자 수정문 1")).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByAltText("2페이지 이미지");
    expect(within(inspector).getByRole("button", { name: "말풍선 OCR" })).toBeEnabled();
    expect(within(inspector).getByRole("button", { name: "인페인팅" })).toBeEnabled();
    expect(screen.getAllByText("page-two-text").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(window.projectApi.saveProject).toHaveBeenCalledWith({
      projectSessionId: "opened-session"
    }));
    await waitFor(() => {
      expect(within(inspector).getByRole("button", { name: "말풍선 OCR" })).toBeEnabled();
      expect(within(inspector).getByRole("button", { name: "인페인팅" })).toBeEnabled();
    });
  });

  it("adopts a late same-session inpainting result without changing the current page or viewport", async () => {
    mockCanvasForInpainting();
    const sourcePage = pageImage();
    const secondPage = pageImage({
      id: "page-image-2",
      pageNumber: 2,
      storedRelativePath: "Book-assets/images/page-002.jpg"
    });
    const lines = [
      rendererLine("page-one-line", 1, "page-one-text", 1),
      rendererLine("page-two-line", 1, "page-two-text", 2)
    ];
    const openedProject = normalizeProject(openedProjectWithInpaintedResult([
      sourcePage,
      secondPage
    ], lines).project);
    const committedProject = normalizeProject(openedProjectWithInpaintedResult([
      sourcePage,
      secondPage
    ], lines).project);
    const committedAsset = committedProject.processing.assets[0];
    if (!committedAsset) throw new Error("expected a committed inpainting asset");
    const committedRun = committedProject.processing.runs[0];
    if (!committedRun) throw new Error("expected a committed inpainting run");
    const latePath = "Book-assets/images/page-001-late-inpainted.png";
    committedAsset.storedRelativePath = latePath;
    const lateImage = pageImage({
      id: "page-image-1-late-inpainted",
      storedRelativePath: latePath,
      originalFileName: "scan_001_late_inpainted.png",
      sha256: "d".repeat(64),
      mimeType: "image/png"
    });
    const pending = deferred<unknown>();
    const dto = (project: typeof openedProject, revision: number) => ({
      revision,
      project,
      pendingPageImages: [],
      dirty: false,
      status: "active" as const
    });
    const inpaintPageImage = vi.fn().mockReturnValue(pending.promise);
    const cancelInpainting = vi.fn().mockResolvedValue({ canceled: true });
    const applyProjectMutation = vi.fn().mockResolvedValue({
      status: "applied" as const,
      revision: 10,
      project: dto(committedProject, 10)
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(normalizeProject(createEmptyProject("Initial", false)), 0),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, 7),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      resolvePageImageSrc: vi.fn().mockImplementation(async ({ storedRelativePath }) => storedRelativePath),
      inpaintPageImage,
      cancelInpainting
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
    await waitFor(() => expect(inpaintPageImage).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByAltText("2페이지 이미지");
    await waitFor(() => expect(cancelInpainting).toHaveBeenCalledWith({ requestId: expect.any(String) }));
    const viewport = screen.getByTestId("page-image-viewport");
    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    fireEvent.click(screen.getByRole("button", { name: /확대|Zoom in/i }));
    viewport.scrollLeft = 31;
    viewport.scrollTop = 17;
    fireEvent.scroll(viewport);
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    expect(screen.getAllByText("page-two-text").length).toBeGreaterThan(0);

    await act(async () => {
      pending.resolve({
        pageImage: lateImage,
        run: committedRun,
        asset: committedAsset,
        sessionResult: {
          projectSessionId: "opened-session",
          project: dto(committedProject, 9)
        }
      });
    });

    await waitFor(() => expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2"));
    expect(screen.getAllByText("page-two-text").length).toBeGreaterThan(0);
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollLeft", 31);
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollTop", 17);
    expect(screen.getByRole("button", { name: /원본 결과|Original result/i })).toHaveAttribute("aria-pressed", "true");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인스펙터에서 이미지로 돌아가기" }));
    fireEvent.change(await screen.findByLabelText("사용자 수정문 1"), {
      target: { value: "edited while late result was pending" }
    });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledWith(
      expect.objectContaining({ projectSessionId: "opened-session", baseRevision: 9 })
    ));

    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i }));
    await waitFor(() => expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", latePath));
  });

  it("does not let an older transient result context override a newer approved processing asset", async () => {
    mockCanvasForInpainting();
    const sourceImage = pageImage();
    const openedProject = normalizeProject(openedProjectWithImages([sourceImage]).project);
    const approvedImage = pageImage({
      id: "page-image-1-approved-b",
      storedRelativePath: "Book-assets/images/page-001-approved-b.png",
      originalFileName: "scan_001_approved_b.png",
      sha256: "b".repeat(64),
      mimeType: "image/png"
    });
    const staleImage = pageImage({
      id: "page-image-1-stale-a",
      storedRelativePath: "Book-assets/images/page-001-stale-a.png",
      originalFileName: "scan_001_stale_a.png",
      sha256: "c".repeat(64),
      mimeType: "image/png"
    });
    const approvedRun = {
      runId: "approved-run-b",
      pageImageId: sourceImage.id,
      source: "manual_openai" as const,
      status: "completed" as const,
      sourceSha256: sourceImage.sha256,
      appVersion: "0.1.0",
      queuedAt: "2026-08-04T00:00:00.000Z",
      completedAt: "2026-08-04T00:00:00.000Z"
    };
    const approvedAsset = {
      assetId: approvedImage.id,
      source: "manual_openai" as const,
      sourcePageImageId: sourceImage.id,
      runId: approvedRun.runId,
      role: "cleaned" as const,
      storedRelativePath: approvedImage.storedRelativePath,
      sha256: approvedImage.sha256,
      byteSize: approvedImage.byteSize,
      mimeType: "image/png" as const,
      createdAt: "2026-08-04T00:00:00.000Z"
    };
    const approvedProject = normalizeProject({
      ...openedProject,
      schemaVersion: 2,
      processing: {
        pages: [{
          pageImageId: sourceImage.id,
          latestCompletedRunId: approvedRun.runId,
          approvedCleanedAssetId: approvedAsset.assetId,
          finalStatus: "auto_approved" as const,
          updatedAt: approvedAsset.createdAt
        }],
        runs: [approvedRun],
        assets: [approvedAsset]
      }
    });
    const dto = (project: typeof openedProject, revision: number) => ({
      revision,
      project,
      pendingPageImages: [],
      dirty: false,
      status: "active" as const
    });
    const inpaintPageImage = vi.fn().mockResolvedValue({
      pageImage: staleImage,
      run: {
        ...approvedRun,
        runId: "stale-run-a"
      },
      asset: {
        ...approvedAsset,
        assetId: staleImage.id,
        runId: "stale-run-a",
        storedRelativePath: staleImage.storedRelativePath,
        sha256: staleImage.sha256,
        createdAt: "2026-08-04T00:01:00.000Z"
      },
      sessionResult: {
        projectSessionId: "opened-session",
        project: dto(approvedProject, 2)
      }
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(normalizeProject(createEmptyProject("Initial", false)), 0),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, 1),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation: vi.fn(),
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      resolvePageImageSrc: vi.fn().mockImplementation(async ({ storedRelativePath }) => storedRelativePath),
      inpaintPageImage
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: /^인페인팅$/ }));
    const targetImage = await screen.findByAltText(/인페인팅 대상/);
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText(/인페인팅 마스크/);
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: /OpenAI 실행/ }));

    await waitFor(() => expect(inpaintPageImage).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", approvedImage.storedRelativePath);
    });
    expect(screen.getByAltText("1페이지 이미지")).not.toHaveAttribute("src", staleImage.storedRelativePath);
  });

  it("keeps processing, stale, and partial-failure facts visible for an existing result", async () => {
    const sourceImage = pageImage();
    const opened = normalizeProject(openedProjectWithInpaintedResult([sourceImage]).project);
    const processing = opened.processing;
    if (!processing) throw new Error("expected processing state");
    const pageRecord = processing.pages[0];
    const run = processing.runs[0];
    if (!pageRecord || !run) throw new Error("expected processing fixtures");
    pageRecord.activeRunId = run.runId;
    pageRecord.finalStatus = "needs_review";
    run.status = "running";
    run.sourceSha256 = "d".repeat(64);

    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue({
        ...openedProjectWithImages([sourceImage]),
        project: opened
      }),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      resolvePageImageSrc: vi.fn().mockImplementation(async ({ storedRelativePath }) => storedRelativePath)
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.click(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i }));

    const resultStatus = document.querySelector<HTMLElement>("[data-result-status]");
    expect(resultStatus).not.toBeNull();
    expect(resultStatus).toHaveTextContent("결과 처리 중입니다.");
    expect(resultStatus).toHaveTextContent("이전 원본");
    expect(resultStatus).toHaveTextContent("일부 영역");
    expect(resultStatus).toHaveAttribute("data-result-status", "partial-failure");
  });

  it("keeps the latest optimistic edit while a late processing snapshot arrives with queued mutations", async () => {
    mockCanvasForInpainting();
    const sourcePage = pageImage();
    const lines = [
      rendererLine("session-line", 1, "Before"),
      rendererLine("other-line", 2, "Other line")
    ];
    const openedProject = normalizeProject(openedProjectWithImages([sourcePage], lines).project);
    const committedProject = normalizeProject(openedProjectWithInpaintedResult([sourcePage], lines).project);
    const firstEditedProject = structuredClone(openedProject);
    firstEditedProject.dialogueLines[0]!.sourceText = "First optimistic edit";
    const committedAsset = committedProject.processing.assets[0];
    if (!committedAsset) throw new Error("expected a committed inpainting asset");
    const committedRun = committedProject.processing.runs[0];
    if (!committedRun) throw new Error("expected a committed inpainting run");
    const latePath = "Book-assets/images/page-001-queued-inpainted.png";
    committedAsset.storedRelativePath = latePath;
    const processingFirstProject = structuredClone(committedProject);
    processingFirstProject.dialogueLines[0]!.sourceText = "First optimistic edit";
    const processingSecondProject = structuredClone(committedProject);
    processingSecondProject.dialogueLines[0]!.sourceText = "Second optimistic edit";
    const lateImage = pageImage({
      id: "page-image-1-queued-inpainted",
      storedRelativePath: latePath,
      originalFileName: "scan_001_queued_inpainted.png",
      sha256: "d".repeat(64),
      mimeType: "image/png"
    });
    const pendingInpainting = deferred<unknown>();
    const pendingFirstMutation = deferred<unknown>();
    const pendingSecondMutation = deferred<unknown>();
    const dto = (project: typeof openedProject, revision: number, dirty: boolean) => ({
      revision,
      project,
      pendingPageImages: [],
      dirty,
      status: "active" as const
    });
    const applyProjectMutation = vi.fn()
      .mockReturnValueOnce(pendingFirstMutation.promise)
      .mockReturnValueOnce(pendingSecondMutation.promise);
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(normalizeProject(createEmptyProject("Initial", false)), 0, false),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, 7, false),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      resolvePageImageSrc: vi.fn().mockImplementation(async ({ storedRelativePath }) => storedRelativePath),
      inpaintPageImage: vi.fn().mockReturnValue(pendingInpainting.promise)
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    openFullDialogueTable();
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByLabelText("원문 2").closest('[role="button"]')!);

    fireEvent.click(screen.getByRole("button", { name: /^인페인팅$/ }));
    const targetImage = await screen.findByAltText(/인페인팅 대상/);
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText(/인페인팅 마스크/);
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: /OpenAI 실행/ }));
    await waitFor(() => expect(window.projectApi.inpaintPageImage).toHaveBeenCalledOnce());

    const sourceInput = screen.getByLabelText("원문 1");
    fireEvent.change(sourceInput, { target: { value: "First optimistic edit" } });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(1));

    await act(async () => {
      pendingFirstMutation.resolve({
        status: "applied" as const,
        revision: 8,
        project: dto(firstEditedProject, 8, true)
      });
      await pendingFirstMutation.promise;
    });
    await waitFor(() => expect(screen.getByLabelText("원문 1")).toHaveValue("First optimistic edit"));

    fireEvent.change(sourceInput, { target: { value: "Second optimistic edit" } });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(2));
    expect(applyProjectMutation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      projectSessionId: "opened-session",
      baseRevision: 8,
      mutation: {
        type: "update_dialogue_line",
        lineId: "session-line",
        patch: { sourceText: "Second optimistic edit" }
      }
    }));

    await act(async () => {
      pendingInpainting.resolve({
        pageImage: lateImage,
        run: committedRun,
        asset: committedAsset,
        sessionResult: {
          projectSessionId: "opened-session",
          project: dto(processingFirstProject, 9, true)
        }
      });
      await pendingInpainting.promise;
    });

    expect(screen.getByLabelText("원문 1")).toHaveValue("Second optimistic edit");
    expect(screen.getByLabelText("원문 1")).not.toHaveValue("Before");
    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", latePath);

    await act(async () => {
      pendingSecondMutation.resolve({
        status: "applied" as const,
        revision: 10,
        project: dto(processingSecondProject, 10, true)
      });
      await pendingSecondMutation.promise;
    });
    await waitFor(() => expect(screen.getByLabelText("원문 1")).toHaveValue("Second optimistic edit"));
    expect(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", latePath);
    expect(screen.getByText("변경 있음")).toBeInTheDocument();
  });

  it("ignores a lower-revision mutation response after a newer processing session snapshot", async () => {
    mockCanvasForInpainting();
    const sourcePage = pageImage();
    const lines = [
      rendererLine("session-line", 1, "Before"),
      rendererLine("other-line", 2, "Other line")
    ];
    const openedProject = normalizeProject(openedProjectWithImages([sourcePage], lines).project);
    const committedProject = normalizeProject(openedProjectWithInpaintedResult([sourcePage], lines).project);
    const canonicalProject = structuredClone(committedProject);
    canonicalProject.dialogueLines[0]!.sourceText = "Optimistic edit";
    const staleMutationProject = structuredClone(openedProject);
    staleMutationProject.dialogueLines[0]!.sourceText = "Optimistic edit";
    const reconciledProject = structuredClone(committedProject);
    reconciledProject.dialogueLines[0]!.sourceText = "Post-reconcile edit";
    const committedAsset = committedProject.processing.assets[0];
    if (!committedAsset) throw new Error("expected a committed inpainting asset");
    const committedRun = committedProject.processing.runs[0];
    if (!committedRun) throw new Error("expected a committed inpainting run");
    const latePath = "Book-assets/images/page-001-inverse-order-inpainted.png";
    committedAsset.storedRelativePath = latePath;
    canonicalProject.processing.assets[0]!.storedRelativePath = latePath;
    reconciledProject.processing.assets[0]!.storedRelativePath = latePath;
    const lateImage = pageImage({
      id: "page-image-1-inverse-order-inpainted",
      storedRelativePath: latePath,
      originalFileName: "scan_001_inverse_order_inpainted.png",
      sha256: "d".repeat(64),
      mimeType: "image/png"
    });
    const pendingInpainting = deferred<unknown>();
    const pendingMutation = deferred<unknown>();
    const pendingReconciliationMutation = deferred<unknown>();
    const dto = (project: typeof openedProject, revision: number, dirty: boolean) => ({
      revision,
      project,
      pendingPageImages: [],
      dirty,
      status: "active" as const
    });
    const applyProjectMutation = vi.fn()
      .mockReturnValueOnce(pendingMutation.promise)
      .mockReturnValueOnce(pendingReconciliationMutation.promise);
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(normalizeProject(createEmptyProject("Initial", false)), 0, false),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, 7, false),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      resolvePageImageSrc: vi.fn().mockImplementation(async ({ storedRelativePath }) => storedRelativePath),
      inpaintPageImage: vi.fn().mockReturnValue(pendingInpainting.promise)
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    openFullDialogueTable();
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByLabelText("원문 2").closest('[role="button"]')!);

    fireEvent.click(screen.getByRole("button", { name: /^인페인팅$/ }));
    const targetImage = await screen.findByAltText(/인페인팅 대상/);
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText(/인페인팅 마스크/);
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: /OpenAI 실행/ }));
    await waitFor(() => expect(window.projectApi.inpaintPageImage).toHaveBeenCalledOnce());

    const sourceInput = screen.getByLabelText("원문 1");
    fireEvent.change(sourceInput, { target: { value: "Optimistic edit" } });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(1));

    await act(async () => {
      pendingInpainting.resolve({
        pageImage: lateImage,
        run: committedRun,
        asset: committedAsset,
        sessionResult: {
          projectSessionId: "opened-session",
          project: dto(canonicalProject, 9, true)
        }
      });
      await pendingInpainting.promise;
    });
    expect(screen.getByLabelText("원문 1")).toHaveValue("Optimistic edit");

    await act(async () => {
      pendingMutation.resolve({
        status: "applied" as const,
        revision: 8,
        project: dto(staleMutationProject, 8, true)
      });
      await pendingMutation.promise;
    });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(1));

    fireEvent.change(sourceInput, { target: { value: "Post-reconcile edit" } });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(2));
    expect(applyProjectMutation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      projectSessionId: "opened-session",
      baseRevision: 9,
      mutation: {
        type: "update_dialogue_line",
        lineId: "session-line",
        patch: { sourceText: "Post-reconcile edit" }
      }
    }));

    await act(async () => {
      pendingReconciliationMutation.resolve({
        status: "applied" as const,
        revision: 10,
        project: dto(reconciledProject, 10, true)
      });
      await pendingReconciliationMutation.promise;
    });
    await waitFor(() => expect(screen.getByLabelText("원문 1")).toHaveValue("Post-reconcile edit"));
    expect(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", latePath);
    expect(screen.getByText("변경 있음")).toBeInTheDocument();
  });

  it("keeps the latest session state when a lower-revision inpainting result arrives late", async () => {
    mockCanvasForInpainting();
    const sourcePage = pageImage();
    const secondPage = pageImage({
      id: "page-image-2",
      pageNumber: 2,
      storedRelativePath: "Book-assets/images/page-002.jpg"
    });
    const latestLines = [
      rendererLine("latest-page-one-line", 1, "latest page one text", 1),
      rendererLine("latest-page-two-line", 1, "latest page two text", 2)
    ];
    const staleLines = [
      rendererLine("stale-page-one-line", 1, "stale page one text", 1),
      rendererLine("stale-page-two-line", 1, "stale page two text", 2)
    ];
    const latestProject = normalizeProject(openedProjectWithImages([
      sourcePage,
      secondPage
    ], latestLines).project);
    const staleProject = normalizeProject(openedProjectWithImages([
      sourcePage,
      secondPage
    ], staleLines).project);
    const committedProject = normalizeProject(openedProjectWithInpaintedResult([
      sourcePage,
      secondPage
    ], latestLines).project);
    const committedAsset = committedProject.processing.assets[0];
    if (!committedAsset) throw new Error("expected a committed inpainting asset");
    const committedRun = committedProject.processing.runs[0];
    if (!committedRun) throw new Error("expected a committed inpainting run");
    const latePath = "Book-assets/images/page-001-stale-inpainted.png";
    committedAsset.storedRelativePath = latePath;
    const lateImage = pageImage({
      id: "page-image-1-stale-inpainted",
      storedRelativePath: latePath,
      originalFileName: "scan_001_stale_inpainted.png",
      sha256: "d".repeat(64),
      mimeType: "image/png"
    });
    const pending = deferred<unknown>();
    const pendingPageImages = [{ pageNumber: 2, pageImageId: secondPage.id }];
    const dto = (project: typeof latestProject, revision: number, dirty: boolean, pendingImages = pendingPageImages) => ({
      revision,
      project,
      pendingPageImages: pendingImages,
      dirty,
      status: "active" as const
    });
    const inpaintPageImage = vi.fn().mockReturnValue(pending.promise);
    const applyProjectMutation = vi.fn().mockResolvedValue({
      status: "applied" as const,
      revision: 11,
      project: dto(latestProject, 11, true)
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(normalizeProject(createEmptyProject("Initial", false)), 0, false, []),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(latestProject, 10, true),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      resolvePageImageSrc: vi.fn().mockImplementation(async ({ storedRelativePath }) => storedRelativePath),
      inpaintPageImage
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("진행");
    expect(screen.getAllByText("latest page one text").length).toBeGreaterThan(0);

    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
    await waitFor(() => expect(inpaintPageImage).toHaveBeenCalledOnce());

    await act(async () => {
      pending.resolve({
        pageImage: lateImage,
        run: committedRun,
        asset: committedAsset,
        sessionResult: {
          projectSessionId: "opened-session",
          project: dto(staleProject, 9, false, [])
        }
      });
    });

    await waitFor(() => expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", sourcePage.storedRelativePath));
    expect(screen.getByRole("button", { name: /원본 결과|Original result/i })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i }));
    await waitFor(() => expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", latePath));
    expect(screen.getAllByText("latest page one text").length).toBeGreaterThan(0);
    expect(screen.queryByText("stale page one text")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByAltText("2페이지 이미지");
    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(within(inspector).getByRole("button", { name: "말풍선 OCR" })).toBeDisabled();
    expect(screen.getAllByText(/새로 연결한 이미지를 먼저 저장해야 OCR\/인페인팅할 수 있습니다\./).length).toBeGreaterThan(0);
    expect(screen.getAllByText("latest page two text").length).toBeGreaterThan(0);
    expect(screen.queryByText("stale page two text")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    await screen.findByAltText("1페이지 이미지");
    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), {
      target: { value: "edit after stale result" }
    });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledWith(
      expect.objectContaining({ projectSessionId: "opened-session", baseRevision: 10 })
    ));
  });

  it("keeps a direct pending page gated when a dialogue mutation response omits pending pages", async () => {
    const sourcePage = pageImage();
    const secondPage = pageImage({
      id: "page-image-2",
      pageNumber: 2,
      storedRelativePath: "Book-assets/images/page-002.jpg"
    });
    const replacementPage = pageImage({
      id: "page-image-1-replacement",
      storedRelativePath: "Book-assets/images/page-001-replacement.jpg",
      originalFileName: "scan_001_replacement.jpg",
      sha256: "f".repeat(64)
    });
    const lines = [
      rendererLine("page-one-line", 1, "page-one-text", 1),
      rendererLine("page-two-line", 1, "page-two-text", 2)
    ];
    const initialProject = normalizeProject(openedProjectWithImages([
      sourcePage,
      secondPage
    ], lines).project);
    const pendingProject = normalizeProject(openedProjectWithImages([
      replacementPage,
      secondPage
    ], lines).project);
    const dto = (project: typeof initialProject, revision: number, dirty: boolean, pendingPageImages: unknown[] = []) => ({
      revision,
      project,
      pendingPageImages,
      dirty,
      status: "active" as const
    });
    const choosePageImageFiles = vi.fn().mockResolvedValue([
      "C:\\images\\page-001-replacement.jpg"
    ]);
    const importPageImages = vi.fn().mockResolvedValue([{
      ok: true,
      pageImage: replacementPage
    }]);
    const applyProjectMutation = vi.fn().mockResolvedValue({
      status: "applied" as const,
      revision: 2,
      project: dto(pendingProject, 2, true)
    });
    const saveProject = vi.fn().mockResolvedValue({
      projectSessionId: "opened-session",
      project: dto(pendingProject, 3, false)
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(normalizeProject(createEmptyProject("Initial", false)), 0, false),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(initialProject, 1, false)
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject,
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      choosePageImageFiles,
      importPageImages,
      resolvePageImageSrc: vi.fn().mockImplementation(async ({ storedRelativePath }) => storedRelativePath)
    };

    renderApp();
    await waitFor(() => expect(window.projectApi.createProjectSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    openPagesPanel();
    fireEvent.click(screen.getByRole("button", { name: "이미지 업로드" }));
    await waitFor(() => expect(choosePageImageFiles).toHaveBeenCalledOnce());
    await waitFor(() => expect(importPageImages).toHaveBeenCalledWith({
      projectSessionId: "opened-session",
      files: [{ sourcePath: "C:\\images\\page-001-replacement.jpg", pageNumber: 1 }]
    }));
    await openWorkspacePanel("수정");
    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    expect(within(inspector).getByRole("button", { name: "말풍선 OCR" })).toBeDisabled();
    expect(within(inspector).getByRole("button", { name: "인페인팅" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByAltText("2페이지 이미지");
    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), {
      target: { value: "edited on another page" }
    });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledWith(
      expect.objectContaining({ projectSessionId: "opened-session", baseRevision: 1 })
    ));

    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    await screen.findByAltText("1페이지 이미지");
    expect(within(inspector).getByRole("button", { name: "말풍선 OCR" })).toBeDisabled();
    expect(within(inspector).getByRole("button", { name: "인페인팅" })).toBeDisabled();
    expect(screen.getAllByText(/새로 연결한 이미지를 먼저 저장해야 OCR\/인페인팅할 수 있습니다\./).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(saveProject).toHaveBeenCalledWith({
      projectSessionId: "opened-session"
    }));
    await waitFor(() => {
      expect(within(inspector).getByRole("button", { name: "말풍선 OCR" })).toBeEnabled();
      expect(within(inspector).getByRole("button", { name: "인페인팅" })).toBeEnabled();
    });
  });

  it("keeps a user-selected original layer when a deferred inpainting result completes", async () => {
    mockCanvasForInpainting();
    const inpainting = deferred<PageImage>();
    const inpaintPageImage = vi.fn().mockReturnValue(inpainting.promise);
    const sourceImage = pageImage();
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([sourceImage])),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      inpaintPageImage
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
    await waitFor(() => expect(inpaintPageImage).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: /원본 결과|Original result/i }));
    expect(screen.getByRole("button", { name: /원본 결과|Original result/i })).toHaveAttribute("aria-pressed", "true");

    await act(async () => {
      inpainting.resolve(pageImage({
        id: "page-image-1-inpainted-deferred",
        storedRelativePath: "Book-assets/images/page-001-inpainted-deferred.png",
        originalFileName: "scan_001_inpainted_deferred.png",
        sha256: "c".repeat(64),
        mimeType: "image/png"
      }));
      await inpainting.promise;
    });

    await waitFor(() => expect(screen.getByRole("button", { name: /원본 결과|Original result/i })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("OpenAI 인페인팅 결과가 준비되었습니다. 현재 결과 레이어를 유지합니다.");
  });

  it("preserves a translated selection, viewport context, and dialogue context during inpainting", async () => {
    mockCanvasForInpainting();
    const inpainting = deferred<PageImage>();
    const inpaintPageImage = vi.fn().mockReturnValue(inpainting.promise);
    const sourceImage = pageImage();
    const dialogueLines = [rendererLine("layer-intent-line", 1, "Layer intent text")];
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(openedProjectWithImages([sourceImage], dialogueLines)),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      inpaintPageImage
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "edited while processing" } });

    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    fireEvent.click(screen.getByRole("button", { name: /확대|Zoom in/i }));
    const viewport = screen.getByTestId("page-image-viewport");
    viewport.scrollLeft = 27;
    viewport.scrollTop = 19;
    fireEvent.scroll(viewport);
    fireEvent.click(screen.getByRole("button", { name: /OCR 레이어|OCR layer/i }));

    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
    await waitFor(() => expect(inpaintPageImage).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: /식자\/번역 결과|Translated result/i }));
    fireEvent.click(screen.getByRole("button", { name: /원본 결과|Original result/i }));
    fireEvent.click(screen.getByRole("button", { name: /식자\/번역 결과|Translated result/i }));

    await act(async () => {
      inpainting.resolve(pageImage({
        id: "page-image-1-inpainted-translated-selection",
        storedRelativePath: "Book-assets/images/page-001-inpainted-translated-selection.png",
        originalFileName: "scan_001_inpainted_translated_selection.png",
        sha256: "c".repeat(64),
        mimeType: "image/png"
      }));
      await inpainting.promise;
    });

    await waitFor(() => expect(screen.getByRole("button", { name: /식자\/번역 결과|Translated result/i })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: /원본 결과|Original result/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("OpenAI 인페인팅 결과가 준비되었습니다. 현재 결과 레이어를 유지합니다.");
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("edited while processing");
    expect(screen.getByTestId("page-image-viewport")).toHaveAttribute("data-view-mode", "actual");
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollLeft", 27);
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollTop", 19);
    expect(screen.getByRole("button", { name: /OCR 레이어|OCR layer/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the active layer unchanged for a stale inpainting session result while retaining the result graph", async () => {
    mockCanvasForInpainting();
    const inpainting = deferred<unknown>();
    const inpaintPageImage = vi.fn().mockReturnValue(inpainting.promise);
    const sourceImage = pageImage();
    const openedProject = normalizeProject(openedProjectWithImages([sourceImage]).project);
    const committedProject = normalizeProject(openedProjectWithInpaintedResult([sourceImage]).project);
    const committedRun = committedProject.processing?.runs[0];
    const committedAsset = committedProject.processing?.assets[0];
    if (!committedRun || !committedAsset) throw new Error("expected committed processing fixture");
    const staleImage = pageImage({
      id: "page-image-1-stale-layer-intent",
      storedRelativePath: "Book-assets/images/page-001-stale-layer-intent.png",
      originalFileName: "scan_001_stale_layer_intent.png",
      sha256: "d".repeat(64),
      mimeType: "image/png"
    });
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue({
        ...openedProjectWithImages([sourceImage]),
        project: openedProject
      }),
      saveProject: vi.fn(),
      importPageImages: vi.fn(),
      inpaintPageImage
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "인페인팅" }));
    const targetImage = await screen.findByAltText("1페이지 인페인팅 대상");
    fireEvent.load(targetImage);
    const maskCanvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(maskCanvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
    await waitFor(() => expect(inpaintPageImage).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: /원본 결과|Original result/i }));

    await act(async () => {
      inpainting.resolve({
        pageImage: staleImage,
        run: committedRun,
        asset: committedAsset,
        sessionResult: {
          projectSessionId: "unexpected-session",
          project: {
            revision: 2,
            project: committedProject,
            pendingPageImages: [],
            dirty: false,
            status: "active"
          }
        }
      });
      await inpainting.promise;
    });

    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("인페인팅 결과가 오래되어 최신 작업대 상태를 유지했습니다."));
    expect(screen.getByRole("button", { name: /원본 결과|Original result/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i }));
    await waitFor(() => expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", staleImage.storedRelativePath));
    expect(screen.getByRole("button", { name: /원본 결과|Original result/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps AI proposals read-only and persists user edits as a renderer draft", async () => {
    const line = { ...rendererLine("draft-line", 1, "原文"), speaker: "A", aiTranslation: "AI 제안" };
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "draft.txt", lines: [line] }),
      chooseSaveFile: vi.fn(), exportTranslations: vi.fn(), openProject: vi.fn(), saveProject: vi.fn()
    };
    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    const ai = await screen.findByLabelText("AI 번역 1");
    expect(ai).toHaveAttribute("readonly");
    expect(screen.getByText("AI 제안", { selector: ".translation-ownership-badge" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "사용자 초안" } });
    expect(screen.getByText("사용자 수정", { selector: ".translation-ownership-badge" })).toBeInTheDocument();
    const serialized = window.localStorage.getItem("trio.translation-drafts.v1");
    expect(serialized).toContain("사용자 초안");
  });

  it("renders a valid stored draft without mutating project content or dirty state", async () => {
    const line = { ...rendererLine("restore-line", 1, "복원 원문"), speaker: "A" };
    const opened = openedProjectWithImages([], [line]);
    const saveProject = vi.fn();
    saveTranslationDraft(window.localStorage, {
      projectId: opened.project.metadata.id,
      projectRevision: 0,
      lineId: line.id,
      sourceIdentity: createTranslationSourceIdentity(line.sourceText),
      lineStatus: "untranslated"
    }, "복원 초안");
    window.projectApi = {
      importTxtFile: vi.fn(), chooseSaveFile: vi.fn(), exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(opened), saveProject
    };
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("사용자 수정문 1")).toHaveValue("복원 초안");
    expect(screen.getByText("사용자 수정", { selector: ".translation-ownership-badge" })).toBeInTheDocument();
    expect(screen.getByText("저장됨", { selector: ".top-save-state" })).toBeInTheDocument();
    expect(saveProject).not.toHaveBeenCalled();
  });

  it("keeps a single AI result pipeline-owned and applies only the Main proposal DTO", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("AI proposal", false));
    openedProject.dialogueLines = [{
      ...rendererLine("ai-proposal-line", 1, "原文"),
      origin: { kind: "manual" }
    }];
    const payload = buildTranslationContextPayload({
      dialogueLines: openedProject.dialogueLines,
      targetLineId: "ai-proposal-line",
      characters: openedProject.characters,
      dictionaryTerms: openedProject.dictionaryTerms,
      stylePreset: DEFAULT_PROVIDER_SETTINGS.translationStyle
    });
    const fingerprint = computeTranslationPayloadFingerprint(payload);
    const proposedProject = structuredClone(openedProject);
    proposedProject.dialogueLines[0] = { ...proposedProject.dialogueLines[0]!, aiTranslation: "AI 제안" };
    const dto = (project: TranslationProjectV2, revision: number, dirty: boolean) => ({
      revision, project, pendingPageImages: [] as [], dirty, status: "active" as const
    });
    const commitTranslationProposal = vi.fn().mockResolvedValue({
      projectSessionId: "opened-session",
      project: dto(proposedProject, 2, true),
      appliedDialogueUpdates: [{ id: "ai-proposal-line", appliedTranslation: true, appliedTypesetting: false }]
    });
    const applyProjectMutation = vi.fn();
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(initialProject, 0, false), encrypted: false }),
      openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "opened-session", project: dto(openedProject, 1, false), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation,
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
      executeTranslation: vi.fn().mockResolvedValue({ translatedText: "AI 제안", engine: "test", contextFingerprint: fingerprint }),
      commitTranslationProposal,
      cancelTranslation: vi.fn().mockResolvedValue({ canceled: false })
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    fireEvent.click(await screen.findByRole("button", { name: /AI 문맥 번역 실행/ }));

    expect(await screen.findByLabelText("AI 번역 1", {}, { timeout: 3_000 })).toHaveValue("AI 제안");
    expect(screen.getByText("AI 제안", { selector: ".translation-ownership-badge" })).toBeInTheDocument();
    expect(commitTranslationProposal).toHaveBeenCalledWith(expect.objectContaining({
      projectSessionId: "opened-session",
      targetLineId: "ai-proposal-line",
      proposal: "AI 제안",
      expectedTranslationFingerprint: fingerprint
    }));
    expect(window.projectApi.executeTranslation).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ engineType: "gemini" })
    }));
    expect(applyProjectMutation).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("trio.translation-drafts.v1") ?? "").not.toContain("AI 제안");
  });

  it("does not start a single translation when Provider settings cannot be loaded", async () => {
    const project = openedProjectWithImages([], [rendererLine("provider-settings-line", 1, "原文")]);
    const executeTranslation = vi.fn();
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(project),
      saveProject: vi.fn(),
      getProviderSettings: vi.fn().mockRejectedValue(new Error("settings IPC failed")),
      executeTranslation
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    fireEvent.click(await screen.findByRole("button", { name: /AI 문맥 번역 실행/ }));

    expect(await findWorkStatus(/Provider 설정을 불러오지 못해 작업을 시작하지 않았습니다/)).toBeInTheDocument();
    expect(executeTranslation).not.toHaveBeenCalled();
  });

  it("passes the explicitly selected local translation Provider unchanged", async () => {
    const opened = openedProjectWithImages([], [rendererLine("local-provider-line", 1, "原文")]);
    const payload = buildTranslationContextPayload({
      dialogueLines: opened.project.dialogueLines,
      targetLineId: "local-provider-line",
      characters: opened.project.characters,
      dictionaryTerms: opened.project.dictionaryTerms,
      stylePreset: "literal"
    });
    const executeTranslation = vi.fn().mockResolvedValue({
      translatedText: "로컬 결과",
      engine: "local_ai",
      contextFingerprint: computeTranslationPayloadFingerprint(payload)
    });
    window.projectApi = {
      importTxtFile: vi.fn(), chooseSaveFile: vi.fn(), exportTranslations: vi.fn(), saveProject: vi.fn(),
      openProject: vi.fn().mockResolvedValue(opened),
      getProviderSettings: vi.fn().mockResolvedValue({
        ...DEFAULT_PROVIDER_SETTINGS,
        translationEngine: "local_ai",
        translationStyle: "literal",
        localAiRuntime: "lmstudio",
        localAiEndpoint: "http://127.0.0.1:1234",
        localAiModel: "local-model"
      }),
      executeTranslation
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    fireEvent.click(await screen.findByRole("button", { name: /AI 문맥 번역 실행/ }));

    await waitFor(() => expect(executeTranslation).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        engineType: "local_ai",
        localAiRuntime: "lmstudio",
        localAiEndpoint: "http://127.0.0.1:1234",
        localAiModel: "local-model"
      })
    })));
  });

  it("cancels a pending single translation when the user edits and ignores its late result", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Late proposal", false));
    openedProject.dialogueLines = [{ ...rendererLine("late-ai-line", 1, "原文"), origin: { kind: "manual" } }];
    const dto = (project: TranslationProjectV2, revision: number, dirty: boolean) => ({
      revision, project, pendingPageImages: [] as [], dirty, status: "active" as const
    });
    const pending = deferred<{ translatedText: string; engine: string; contextFingerprint: string }>();
    const cancelTranslation = vi.fn().mockResolvedValue({ canceled: true });
    const commitTranslationProposal = vi.fn();
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(initialProject, 0, false), encrypted: false }),
      openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "opened-session", project: dto(openedProject, 1, false), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation: vi.fn(),
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
      executeTranslation: vi.fn().mockReturnValue(pending.promise), commitTranslationProposal, cancelTranslation
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    fireEvent.click(await screen.findByRole("button", { name: /AI 문맥 번역 실행/ }));
    await waitFor(() => expect(window.projectApi.executeTranslation).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "사용자 최신 번역" } });
    await waitFor(() => expect(cancelTranslation).toHaveBeenCalledWith({
      requestId: expect.any(String)
    }));

    await act(async () => {
      pending.resolve({ translatedText: "늦은 AI 결과", engine: "test", contextFingerprint: "stale" });
      await pending.promise;
    });
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("사용자 최신 번역");
    expect(commitTranslationProposal).not.toHaveBeenCalled();
    expect(screen.queryByText(/AI 번역 실패/)).not.toBeInTheDocument();
  });

  it("does not apply a pending single translation after the project session changes", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const projectA = normalizeProject(createEmptyProject("Project A", false));
    projectA.dialogueLines = [{ ...rendererLine("project-a-line", 1, "A 원문"), origin: { kind: "manual" } }];
    const projectB = normalizeProject(createEmptyProject("Project B", false));
    projectB.dialogueLines = [{ ...rendererLine("project-b-line", 1, "B 원문"), origin: { kind: "manual" } }];
    const dto = (project: TranslationProjectV2, revision: number) => ({
      revision, project, pendingPageImages: [] as [], dirty: false, status: "active" as const
    });
    const pending = deferred<{ translatedText: string; engine: string; contextFingerprint: string }>();
    const commitTranslationProposal = vi.fn();
    const cancelTranslation = vi.fn().mockResolvedValue({ canceled: true });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(initialProject, 0), encrypted: false }),
      openProjectFromDialog: vi.fn()
        .mockResolvedValueOnce({ projectSessionId: "session-a", project: dto(projectA, 1), encrypted: false })
        .mockResolvedValueOnce({ projectSessionId: "session-b", project: dto(projectB, 4), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation: vi.fn(),
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
      executeTranslation: vi.fn().mockReturnValue(pending.promise), commitTranslationProposal, cancelTranslation
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    fireEvent.click(await screen.findByRole("button", { name: /AI 문맥 번역 실행/ }));
    await waitFor(() => expect(window.projectApi.executeTranslation).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("B 원문");
    await waitFor(() => expect(cancelTranslation).toHaveBeenCalledWith({ requestId: expect.any(String) }));

    await act(async () => {
      pending.resolve({ translatedText: "A의 늦은 결과", engine: "test", contextFingerprint: "stale" });
      await pending.promise;
    });
    expect(screen.getByLabelText("원문 1")).toHaveValue("B 원문");
    expect(commitTranslationProposal).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("A의 늦은 결과")).not.toBeInTheDocument();
  });

  it("does not apply a previous project batch result after the session switches", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const projectA = normalizeProject(createEmptyProject("Project A", false));
    projectA.dialogueLines = [{ ...rendererLine("project-a-line", 1, "A 원문"), origin: { kind: "manual" } }];
    const projectB = normalizeProject(createEmptyProject("Project B", false));
    projectB.dialogueLines = [{ ...rendererLine("project-b-line", 1, "B 원문"), origin: { kind: "manual" } }];
    const staleProject = structuredClone(projectA);
    staleProject.dialogueLines[0]!.aiTranslation = "A의 늦은 Batch 결과";
    const dto = (project: TranslationProjectV2, revision: number) => ({
      revision, project, pendingPageImages: [] as [], dirty: false, status: "active" as const
    });
    const pending = deferred<{
      progress: {
        stage: string;
        currentPageIndex: number;
        totalPages: number;
        percent: number;
        currentMessage: string;
        pageStatuses: Record<string, never>;
        errors: unknown[];
        isCanceled: boolean;
      };
      updatedProject: TranslationProjectV2;
      sessionChange: {
        status: "applied";
        revision: number;
        project: ReturnType<typeof dto>;
      };
    }>();
    const cancelBatchJob = vi.fn().mockResolvedValue({ canceled: true });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(initialProject, 0), encrypted: false }),
      openProjectFromDialog: vi.fn()
        .mockResolvedValueOnce({ projectSessionId: "session-a", project: dto(projectA, 1), encrypted: false })
        .mockResolvedValueOnce({ projectSessionId: "session-b", project: dto(projectB, 4), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation: vi.fn(),
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
      runBatchJob: vi.fn().mockReturnValue(pending.promise),
      cancelBatchJob
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    fireEvent.click(await screen.findByRole("button", { name: "일괄 자동화" }));
    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    await waitFor(() => expect(window.projectApi.runBatchJob).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("B 원문");
    await waitFor(() => expect(cancelBatchJob).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^batch-job-/)
    }));

    await act(async () => {
      pending.resolve({
        progress: {
          stage: "completed",
          currentPageIndex: 1,
          totalPages: 1,
          percent: 100,
          currentMessage: "일괄 자동화 완료: 늦은 A 결과",
          pageStatuses: {},
          errors: [],
          isCanceled: false
        },
        updatedProject: staleProject,
        sessionChange: {
          status: "applied",
          revision: 99,
          project: dto(staleProject, 99)
        }
      });
      await pending.promise;
    });

    expect(screen.getByLabelText("원문 1")).toHaveValue("B 원문");
    expect(screen.queryByDisplayValue("A의 늦은 Batch 결과")).not.toBeInTheDocument();
    expect(screen.queryByText("일괄 자동화 결과와 작업 큐 상태를 프로젝트에 반영했습니다.")).not.toBeInTheDocument();
    expect(screen.getByText("session:session-b")).toBeInTheDocument();
  });

  it("does not apply a previous project batch result when cancel IPC fails during the session switch", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const projectA = normalizeProject(createEmptyProject("Project A", false));
    projectA.dialogueLines = [{ ...rendererLine("project-a-line", 1, "A 원문"), origin: { kind: "manual" } }];
    const projectB = normalizeProject(createEmptyProject("Project B", false));
    projectB.dialogueLines = [{ ...rendererLine("project-b-line", 1, "B 원문"), origin: { kind: "manual" } }];
    const staleProject = structuredClone(projectA);
    staleProject.dialogueLines[0]!.aiTranslation = "취소 실패 후 늦은 Batch";
    const dto = (project: TranslationProjectV2, revision: number) => ({
      revision, project, pendingPageImages: [] as [], dirty: false, status: "active" as const
    });
    const pending = deferred<{
      progress: {
        stage: string;
        percent: number;
        currentMessage: string;
        pageStatuses: Record<string, never>;
        errors: unknown[];
        isCanceled: boolean;
      };
      updatedProject: TranslationProjectV2;
    }>();
    const cancelBatchJob = vi.fn().mockRejectedValue(new Error("batch cancel IPC failed"));
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(initialProject, 0), encrypted: false }),
      openProjectFromDialog: vi.fn()
        .mockResolvedValueOnce({ projectSessionId: "session-a", project: dto(projectA, 1), encrypted: false })
        .mockResolvedValueOnce({ projectSessionId: "session-b", project: dto(projectB, 4), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation: vi.fn(),
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
      runBatchJob: vi.fn().mockReturnValue(pending.promise),
      cancelBatchJob
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    fireEvent.click(await screen.findByRole("button", { name: "일괄 자동화" }));
    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    await waitFor(() => expect(window.projectApi.runBatchJob).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("B 원문");
    await waitFor(() => expect(cancelBatchJob).toHaveBeenCalledOnce());

    await act(async () => {
      pending.resolve({
        progress: {
          stage: "completed",
          percent: 100,
          currentMessage: "일괄 자동화 완료",
          pageStatuses: {},
          errors: [],
          isCanceled: false
        },
        updatedProject: staleProject
      });
      await pending.promise;
    });

    expect(screen.getByLabelText("원문 1")).toHaveValue("B 원문");
    expect(screen.queryByDisplayValue("취소 실패 후 늦은 Batch")).not.toBeInTheDocument();
    expect(screen.getByText("session:session-b")).toBeInTheDocument();
  });

  it("reports a confirmed translation cancel only after Main returns canceled: true", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Cancel ack", false));
    openedProject.dialogueLines = [{ ...rendererLine("cancel-ack-line", 1, "原文"), origin: { kind: "manual" } }];
    const dto = (project: TranslationProjectV2, revision: number, dirty: boolean) => ({
      revision, project, pendingPageImages: [] as [], dirty, status: "active" as const
    });
    const pending = deferred<{ translatedText: string; engine: string; contextFingerprint: string }>();
    const cancelPending = deferred<{ canceled: boolean }>();
    const cancelTranslation = vi.fn().mockReturnValue(cancelPending.promise);
    const commitTranslationProposal = vi.fn();
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(initialProject, 0, false), encrypted: false }),
      openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "opened-session", project: dto(openedProject, 1, false), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation: vi.fn(),
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
      executeTranslation: vi.fn().mockReturnValue(pending.promise), commitTranslationProposal, cancelTranslation
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    fireEvent.click(await screen.findByRole("button", { name: /AI 문맥 번역 실행/ }));
    await waitFor(() => expect(window.projectApi.executeTranslation).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "AI 번역 취소" }));
    await waitFor(() => expect(cancelTranslation).toHaveBeenCalledWith({ requestId: expect.any(String) }));
    expect(screen.queryByText("AI 번역 요청을 취소했습니다.")).not.toBeInTheDocument();

    await act(async () => {
      cancelPending.resolve({ canceled: true });
      await cancelPending.promise;
    });
    expect(await findWorkStatus("AI 번역 요청을 취소했습니다.")).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ translatedText: "취소 후 늦은 결과", engine: "test", contextFingerprint: "stale" });
      await pending.promise;
    });
    expect(commitTranslationProposal).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("취소 후 늦은 결과")).not.toBeInTheDocument();
  });

  it("keeps a late translation result unapplied when cancel IPC rejects", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Cancel reject", false));
    openedProject.dialogueLines = [{ ...rendererLine("cancel-reject-line", 1, "原文"), origin: { kind: "manual" } }];
    const dto = (project: TranslationProjectV2, revision: number, dirty: boolean) => ({
      revision, project, pendingPageImages: [] as [], dirty, status: "active" as const
    });
    const pending = deferred<{ translatedText: string; engine: string; contextFingerprint: string }>();
    const cancelTranslation = vi.fn().mockRejectedValue(new Error("translation cancel IPC failed"));
    const commitTranslationProposal = vi.fn();
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(initialProject, 0, false), encrypted: false }),
      openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "opened-session", project: dto(openedProject, 1, false), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation: vi.fn(),
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
      executeTranslation: vi.fn().mockReturnValue(pending.promise), commitTranslationProposal, cancelTranslation
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    fireEvent.click(await screen.findByRole("button", { name: /AI 문맥 번역 실행/ }));
    await waitFor(() => expect(window.projectApi.executeTranslation).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "AI 번역 취소" }));

    expect(await findWorkStatus("결과 적용은 중단했지만 backend 취소를 확인하지 못했습니다.")).toBeInTheDocument();
    expect(cancelTranslation).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ translatedText: "IPC 실패 후 늦은 결과", engine: "test", contextFingerprint: "stale" });
      await pending.promise;
    });
    expect(commitTranslationProposal).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("IPC 실패 후 늦은 결과")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 번역 요청을 취소했습니다.")).not.toBeInTheDocument();
  });

  it("keeps the new project scope when old Processing Queue requests resolve or reject", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const makeProject = (name: string, sourceText: string, pageId: string) => {
      const value = normalizeProject(createEmptyProject(name, false));
      value.dialogueLines = [{ ...rendererLine(`${pageId}-line`, 1, sourceText), origin: { kind: "manual" } }];
      value.pageImages = [pageImage({ id: pageId })];
      return value;
    };
    const withRunningQueue = (project: TranslationProjectV2) => {
      const next = structuredClone(project);
      next.processing.queue = {
        schemaVersion: 1,
        queueId: `queue-${project.metadata.id}`,
        projectSessionId: "session",
        status: "running",
        pageImageIds: next.pageImages.map((image) => image.id),
        pages: next.pageImages.map((image) => ({
          pageImageId: image.id,
          status: "running" as const,
          stage: "translation" as const,
          revision: 1,
          updatedAt: "2026-08-22T00:00:00.000Z"
        })),
        currentPageIndex: 0,
        lastUpdatedAt: "2026-08-22T00:00:00.000Z"
      };
      return next;
    };
    const projectA = withRunningQueue(makeProject("Project A", "A queue source", "queue-page-a"));
    const projectB = withRunningQueue(makeProject("Project B", "B queue source", "queue-page-b"));
    const projectC = withRunningQueue(makeProject("Project C", "C queue source", "queue-page-c"));
    const dto = (project: TranslationProjectV2, revision: number) => ({
      revision, project, pendingPageImages: [] as [], dirty: false, status: "active" as const
    });
    const firstPending = deferred<{ project: ReturnType<typeof dto> }>();
    const secondPending = deferred<{ project: ReturnType<typeof dto> }>();
    const updateProcessingQueue = vi.fn()
      .mockReturnValueOnce(firstPending.promise)
      .mockReturnValueOnce(secondPending.promise);
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(initialProject, 0), encrypted: false }),
      openProjectFromDialog: vi.fn()
        .mockResolvedValueOnce({ projectSessionId: "queue-session-a", project: dto(projectA, 1), encrypted: false })
        .mockResolvedValueOnce({ projectSessionId: "queue-session-b", project: dto(projectB, 5), encrypted: false })
        .mockResolvedValueOnce({ projectSessionId: "queue-session-c", project: dto(projectC, 9), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation: vi.fn(), updateProcessingQueue,
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://asset/page")
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    fireEvent.click(await screen.findByRole("button", { name: "결과 및 진행 열기" }));
    fireEvent.click(await screen.findByRole("button", { name: "일시정지" }));
    await waitFor(() => expect(updateProcessingQueue).toHaveBeenNthCalledWith(1, expect.objectContaining({
      projectSessionId: "queue-session-a",
      action: "pause"
    })));
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("B queue source");

    await act(async () => {
      firstPending.resolve({ project: dto(projectA, 2) });
      await firstPending.promise;
    });
    expect(screen.getByLabelText("원문 1")).toHaveValue("B queue source");
    expect(screen.getByText("session:queue-session-b")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
    await waitFor(() => expect(updateProcessingQueue).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("C queue source");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    await act(async () => {
      secondPending.reject(new Error("오래된 A/B 큐 오류"));
      try {
        await secondPending.promise;
      } catch {
        // The panel consumes this stale rejection without surfacing it.
      }
    });
    expect(screen.getByLabelText("원문 1")).toHaveValue("C queue source");
    expect(screen.getByText("session:queue-session-c")).toBeInTheDocument();
    expect(screen.queryByText("오래된 A/B 큐 오류")).not.toBeInTheDocument();
  });

  it("treats a needs_recovery session as a blocked recovery state instead of a normal editor", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const recovering = normalizeProject(createEmptyProject("Recovering", false));
    recovering.dialogueLines = [{ ...rendererLine("safe-line", 1, "안전 스냅샷"), origin: { kind: "manual" } }];
    const healthy = normalizeProject(createEmptyProject("Healthy", false));
    healthy.dialogueLines = [{ ...rendererLine("healthy-line", 1, "정상 프로젝트"), origin: { kind: "manual" } }];
    const dto = (
      project: TranslationProjectV2,
      revision: number,
      status: "active" | "needs_recovery" = "active"
    ) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty: status === "needs_recovery",
      status
    });
    const applyProjectMutation = vi.fn();
    const extractSpeechBubbles = vi.fn();
    const runBatchJob = vi.fn();
    const importTxtFile = vi.fn();
    const openRecentProject = vi.fn().mockResolvedValue({
      openFailed: true,
      code: "OPEN_FAILED",
      retryable: true,
      message: "다시 열기 실패"
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(initialProject, 0),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn()
        .mockResolvedValueOnce({
          projectSessionId: "recovery-session",
          project: dto(recovering, 4, "needs_recovery"),
          encrypted: false,
          recentProject: {
            recentProjectId: "recent-recovery",
            title: "Recovering",
            openedAt: "2026-09-03T00:00:00.000Z"
          }
        })
        .mockResolvedValueOnce({
          projectSessionId: "healthy-session",
          project: dto(healthy, 1),
          encrypted: false
        }),
      openRecentProject,
      unlockProject: vi.fn(),
      applyProjectMutation,
      extractSpeechBubbles,
      runBatchJob,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile,
      exportTranslations: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("translation-image://asset/page")
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("세션 복구가 필요합니다");
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("안전 스냅샷");
    expect(screen.getByLabelText("원문 1")).toHaveAttribute("readOnly");
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "일괄 자동화" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "전체 프로젝트 이미지 내보내기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "말풍선 OCR" })).toBeDisabled();
    await openWorkspacePanel("페이지");
    expect(screen.getByRole("button", { name: "TXT 불러오기" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /^설정$/ }));
    expect(screen.getByLabelText("프로젝트 제목")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "탐색: 문맥" }));
    const addCharacterButtons = screen.getAllByRole("button", { name: "캐릭터 추가" });
    expect(addCharacterButtons.length).toBeGreaterThan(0);
    expect(addCharacterButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByRole("button", { name: "세션 복구하기" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "복구 중 편집" } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(applyProjectMutation).not.toHaveBeenCalled();
    expect(runBatchJob).not.toHaveBeenCalled();
    expect(extractSpeechBubbles).not.toHaveBeenCalled();
    expect(importTxtFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "세션 복구하기" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("저장하지 않은 프로젝트 변경사항");
    await answerAppConfirmation("버리고 이동");
    await waitFor(() => expect(openRecentProject).toHaveBeenCalledWith({ recentProjectId: "recent-recovery" }));
    expect(screen.getByRole("alert")).toHaveTextContent("세션 복구가 필요합니다");
    expect(screen.getByLabelText("원문 1")).toHaveValue("안전 스냅샷");

    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await answerAppConfirmation("버리고 이동");
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("정상 프로젝트");
    expect(screen.getByLabelText("원문 1")).not.toHaveAttribute("readOnly");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "전체 프로젝트 이미지 내보내기" })).not.toBeDisabled();
    expect(screen.getAllByRole("button", { name: "캐릭터 추가" }).every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("keeps an accepted draft after Main revision increases and a page round trip", async () => {
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const openedProject = normalizeProject(createEmptyProject("Opened", false));
    openedProject.dialogueLines = [
      { ...rendererLine("revision-line-1", 1, "첫 페이지", 1), speaker: "A", origin: { kind: "manual" } },
      { ...rendererLine("revision-line-2", 2, "둘째 페이지", 2), speaker: "B", origin: { kind: "manual" } }
    ];
    const acceptedProject = structuredClone(openedProject);
    acceptedProject.dialogueLines[0] = { ...acceptedProject.dialogueLines[0]!, userTranslation: "승인된 초안", lineStatus: "draft" };
    const dto = (project: typeof openedProject, revision: number, dirty: boolean) => ({ revision, project, pendingPageImages: [] as [], dirty, status: "active" as const });
    const applyProjectMutation = vi.fn().mockResolvedValue({ status: "applied", revision: 2, project: dto(acceptedProject, 2, true) });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(initialProject, 0, false), encrypted: false }),
      openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "opened-session", project: dto(openedProject, 1, false), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation,
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    const translation = await screen.findByLabelText("사용자 수정문 1");
    fireEvent.change(translation, { target: { value: "승인된 초안" } });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2"));
    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    await waitFor(() => {
      expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
      expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("승인된 초안");
    });
  });

  it("keeps the current draft when an applied confirmation has a lower revision", async () => {
    const line1 = { ...rendererLine("lower-revision-line-1", 1, "최신 원문", 1), speaker: "A" };
    const line2 = { ...rendererLine("lower-revision-line-2", 2, "다음 원문", 2), speaker: "B" };
    const opened = openedProjectWithImages([], [line1, line2]);
    const openedProject = normalizeProject(opened.project);
    const dto = (project: TranslationProjectV2, revision: number, dirty: boolean) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const applyProjectMutation = vi.fn().mockImplementation(async () => {
      if (applyProjectMutation.mock.calls.length === 1) {
        const latest = structuredClone(openedProject);
        latest.dialogueLines[0] = { ...latest.dialogueLines[0]!, userTranslation: "낮은 revision 초안", lineStatus: "draft" };
        return { status: "applied" as const, revision: 2, project: dto(latest, 2, true) };
      }
      const stale = structuredClone(openedProject);
      stale.dialogueLines[0] = { ...stale.dialogueLines[0]!, userTranslation: "오래된 확정", lineStatus: "complete" };
      return { status: "applied" as const, revision: 1, project: dto(stale, 1, true) };
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(normalizeProject(createEmptyProject("Initial", false)), 0, false),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, 1, false),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    await screen.findByLabelText("사용자 수정문 1");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    fireEvent.click(within(screen.getByRole("region", { name: "하단 대사 패널" })).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(screen.getByRole("button", { name: "문제 라인 1 선택" }));
    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "낮은 revision 초안" } });
    fireEvent.click(screen.getByRole("button", { name: "검수 확정" }));

    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("current-issue")).toHaveAttribute("data-issue-id", "lower-revision-line-1");
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("낮은 revision 초안");
    expect(window.localStorage.getItem("trio.translation-drafts.v1")).toContain("낮은 revision 초안");
  });

  it("confirms the identity-validated renderer draft even before the user types again", async () => {
    const line1 = { ...rendererLine("restored-confirm-line", 1, "복원할 원문"), speaker: "A" };
    const line2 = { ...rendererLine("restored-next-line", 2, "다음 원문"), speaker: "B" };
    const opened = openedProjectWithImages([], [line1, line2]);
    const openedProject = normalizeProject(opened.project);
    const accepted = structuredClone(openedProject);
    accepted.dialogueLines[0] = { ...accepted.dialogueLines[0]!, userTranslation: "복원 초안", lineStatus: "complete" };
    const dto = (project: TranslationProjectV2, revision: number, dirty: boolean) => ({ revision, project, pendingPageImages: [] as [], dirty, status: "active" as const });
    const applyProjectMutation = vi.fn().mockResolvedValue({ status: "applied", revision: 2, project: dto(accepted, 2, true) });
    saveTranslationDraft(window.localStorage, {
      projectId: openedProject.metadata.id, projectRevision: 1, lineId: line1.id,
      sourceIdentity: createTranslationSourceIdentity(line1.sourceText), lineStatus: "untranslated"
    }, "복원 초안");
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(normalizeProject(createEmptyProject("Initial", false)), 0, false), encrypted: false }),
      openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "opened-session", project: dto(openedProject, 1, false), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation,
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("사용자 수정문 1")).toHaveValue("복원 초안");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    fireEvent.click(within(screen.getByRole("region", { name: "하단 대사 패널" })).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(screen.getByRole("button", { name: "문제 라인 1 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "검수 확정" }));
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledOnce());
    expect(applyProjectMutation.mock.calls[0]?.[0].mutation.patch).toMatchObject({ userTranslation: "복원 초안", lineStatus: "complete" });
  });

  it("confirms an issue translation in place and moves only on explicit navigation", async () => {
    const lines = [
      { ...rendererLine("issue-line-1", 1, "첫 대사"), speaker: "A" },
      { ...rendererLine("issue-line-2", 2, "둘째 대사"), speaker: "B" }
    ];
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "issues.txt", lines }),
      chooseSaveFile: vi.fn(), exportTranslations: vi.fn(), openProject: vi.fn(), saveProject: vi.fn()
    };
    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
    fireEvent.click(screen.getByRole("button", { name: "확인 필요 대사 목록 열기" }));
    fireEvent.click(screen.getByRole("button", { name: "문제 라인 1 선택" }));
    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "첫 확정" } });
    expect(screen.getByText("사용자 수정", { selector: ".translation-ownership-badge" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업대 현황" })).toHaveTextContent("프로젝트 확인 필요 2개");
    fireEvent.click(screen.getByRole("button", { name: "검수 확정" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "완료 표시" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("status", { name: "작업대 현황" })).toHaveTextContent("프로젝트 확인 필요 1개");
    expect(screen.getByLabelText("원문 1")).toHaveValue("첫 대사");
    fireEvent.click(screen.getByRole("button", { name: "다음 라인" }));
    await waitFor(() => expect(screen.getByLabelText("원문 2")).toHaveValue("둘째 대사"));
    const draft = window.localStorage.getItem("trio.translation-drafts.v1");
    expect(draft ?? "").not.toContain("첫 확정");
  });

  it("retains an editable renderer draft when confirmation mutation is rejected", async () => {
    const line1 = { ...rendererLine("reject-line-1", 1, "거절 원문", 1), speaker: "A" };
    const line2 = { ...rendererLine("reject-line-2", 2, "다음 원문", 2), speaker: "B" };
    const opened = openedProjectWithImages([], [line1, line2]);
    const openedProject = normalizeProject(opened.project);
    const dto = (project: TranslationProjectV2, revision: number, dirty: boolean) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const applyProjectMutation = vi.fn().mockRejectedValue(new Error("mutation rejected"));
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(normalizeProject(createEmptyProject("Initial", false)), 0, false),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, 1, false),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    await screen.findByLabelText("사용자 수정문 1");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    fireEvent.click(within(screen.getByRole("region", { name: "하단 대사 패널" })).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(screen.getByRole("button", { name: "문제 라인 1 선택" }));
    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "거절 초안" } });
    fireEvent.click(screen.getByRole("button", { name: "검수 확정" }));

    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("거절 초안");
    expect(window.localStorage.getItem("trio.translation-drafts.v1")).toContain("거절 초안");

    cleanup();
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("사용자 수정문 1")).toHaveValue("거절 초안");
  });

  it("re-scopes a renderer draft to the accepted revision after a confirmation conflict", async () => {
    const line1 = { ...rendererLine("conflict-line-1", 1, "충돌 원문", 1), speaker: "A" };
    const line2 = { ...rendererLine("conflict-line-2", 2, "다음 원문", 2), speaker: "B" };
    const opened = openedProjectWithImages([], [line1, line2]);
    const openedProject = normalizeProject(opened.project);
    const conflictProject = structuredClone(openedProject);
    const dto = (project: TranslationProjectV2, revision: number, dirty: boolean) => ({
      revision,
      project,
      pendingPageImages: [] as [],
      dirty,
      status: "active" as const
    });
    const applyProjectMutation = vi.fn().mockImplementation(async () => {
      if (applyProjectMutation.mock.calls.length === 1) {
        const acceptedDraft = structuredClone(openedProject);
        acceptedDraft.dialogueLines[0] = { ...acceptedDraft.dialogueLines[0]!, userTranslation: "충돌 초안", lineStatus: "draft" };
        return { status: "applied" as const, revision: 2, project: dto(acceptedDraft, 2, true) };
      }
      return {
        status: "revision_conflict" as const,
        code: "REVISION_CONFLICT" as const,
        revision: 3,
        project: dto(conflictProject, 3, true),
        conflictingPaths: ["dialogueLines[0].userTranslation"]
      };
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({
        projectSessionId: "initial-session",
        project: dto(normalizeProject(createEmptyProject("Initial", false)), 0, false),
        encrypted: false
      }),
      openProjectFromDialog: vi.fn().mockResolvedValue({
        projectSessionId: "opened-session",
        project: dto(openedProject, 1, false),
        encrypted: false
      }),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      applyProjectMutation,
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    await screen.findByLabelText("사용자 수정문 1");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    fireEvent.click(within(screen.getByRole("region", { name: "하단 대사 패널" })).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(screen.getByRole("button", { name: "문제 라인 1 선택" }));
    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "충돌 초안" } });
    fireEvent.click(screen.getByRole("button", { name: "검수 확정" }));

    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(2));
    const serialized = window.localStorage.getItem("trio.translation-drafts.v1");
    expect(serialized).toContain("충돌 초안");
    const envelope = JSON.parse(serialized ?? "{}");
    const entries = Object.values(envelope.entries ?? {}) as Array<{ projectRevision?: number }>;
    expect(entries[0]?.projectRevision).toBe(3);
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("충돌 초안");
  });

  it("keeps a draft when postponing an issue and retains it after the page changes", async () => {
    const lines = [
      { ...rendererLine("postpone-line-1", 1, "첫 대사"), speaker: "A" },
      { ...rendererLine("postpone-line-2", 2, "둘째 대사", 2), speaker: "B" }
    ];
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "postpone.txt", lines }),
      chooseSaveFile: vi.fn(), exportTranslations: vi.fn(), openProject: vi.fn(), saveProject: vi.fn()
    };
    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");
    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    fireEvent.click(within(screen.getByRole("region", { name: "하단 대사 패널" })).getByRole("tab", { name: "문제 라인" }));
    fireEvent.click(screen.getByRole("button", { name: "문제 라인 1 선택" }));
    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "보류 초안" } });
    fireEvent.click(screen.getByRole("button", { name: "보류" }));
    await waitFor(() => {
      expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
      expect(screen.getByLabelText("원문 2")).toHaveValue("둘째 대사");
    });
    expect(window.localStorage.getItem("trio.translation-drafts.v1")).toContain("보류 초안");
    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    await waitFor(() => {
      expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("1 / 2");
      expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("보류 초안");
    });
  });

  it("auto-opens the opaque recent project and restores the full renderer context once", async () => {
    const restoredProject = normalizeProject(createEmptyProject("복원 프로젝트", false));
    restoredProject.metadata.id = "restored-project";
    restoredProject.pageImages = [pageImage({ id: "restored-image", pageNumber: 1 })];
    // @ts-expect-error renderer fixture intentionally uses the legacy line shape.
    restoredProject.dialogueLines = [rendererLine("restore-line", 1, "복원 원문")];
    const snapshot = createWorkspaceSessionSnapshot({
      identity: {
        projectId: "restored-project",
        projectKey: "recent-restore",
        recentProjectId: "recent-restore",
        revision: 2
      },
      currentPage: 1,
      pageCount: 1,
      viewport: {
        ...createImageViewportState(),
        viewMode: "actual",
        zoom: 1.75,
        pan: { x: 24, y: 18 }
      },
      comparison: { mode: "opacity", revealPosition: 62, opacity: 0.35 },
      resultLayer: "inpainted",
      visibleOverlays: ["ocr", "issue"],
      workspacePanels: {
        pagesOpen: false,
        inspectorOpen: true,
        resultsOpen: false,
        focusMode: true,
        inspectorWidth: 448
      },
      bottomPanel: "issues",
      dialogueView: "full",
      selectedLineId: "restore-line",
      issueEditor: { activeEditor: "translation", pinned: true }
    });
    window.localStorage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(snapshot));

    const openRecentProject = vi.fn().mockResolvedValue({
      projectSessionId: "new-session-id",
      project: {
        revision: 2,
        project: restoredProject,
        pendingPageImages: [] as [],
        dirty: false,
        status: "active" as const
      },
      encrypted: false
    });
    const createProjectSession = vi.fn();
    window.projectApi = {
      createProjectSession,
      openRecentProject,
      openProjectFromDialog: vi.fn(),
      unlockProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      applyProjectMutation: vi.fn(),
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();
    expect(await screen.findByRole("img", { name: "1페이지 이미지" })).toBeVisible();
    await waitFor(() => expect(openRecentProject).toHaveBeenCalledWith({ recentProjectId: "recent-restore" }));
    expect(createProjectSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("focus-deck-shell")).toHaveClass("pages-collapsed", "inspector-collapsed", "results-collapsed");
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("1 / 1");
    expect(screen.getByRole("button", { name: /투명도 비교|Opacity comparison/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("focus-deck-shell")).not.toHaveClass("focus-mode");
    expect(await screen.findByRole("status", { name: "작업 상태" })).toHaveTextContent("이전 작업 문맥을 복원했습니다.");
    expect(screen.getAllByRole("status", { name: "작업 상태" })).toHaveLength(1);

    const activeSnapshot = JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_STORAGE_KEY) ?? "null");
    expect(activeSnapshot.lifecycle).toBe("active");
    window.dispatchEvent(new Event("pagehide"));
    const closedSnapshot = JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_STORAGE_KEY) ?? "null");
    expect(closedSnapshot.lifecycle).toBe("closed");
  });

  it("opens the configured projects start screen before automatic recent-project restoration", async () => {
    const snapshot = createWorkspaceSessionSnapshot({
      identity: { projectId: "recent-project", projectKey: "recent-1", recentProjectId: "recent-1", revision: 1 },
      currentPage: 1,
      pageCount: 1,
      viewport: createImageViewportState(),
      comparison: { mode: "single", revealPosition: 50, opacity: 0.5 },
      resultLayer: "original",
      visibleOverlays: [],
      workspacePanels: DEFAULT_WORKSPACE_PANELS,
      bottomPanel: "dialogue",
      dialogueView: "queue",
      selectedLineId: null,
      issueEditor: { activeEditor: null, pinned: false }
    });
    window.localStorage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    const initialProject = normalizeProject(createEmptyProject("Initial", false));
    const createProjectSession = vi.fn().mockResolvedValue({
      projectSessionId: "initial-session",
      project: { revision: 0, project: initialProject, pendingPageImages: [], dirty: false, status: "active" },
      encrypted: false
    });
    const openRecentProject = vi.fn();
    window.projectApi = {
      createProjectSession,
      openRecentProject,
      closeProject: vi.fn(),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      getProviderSettings: vi.fn().mockResolvedValue({ ...DEFAULT_PROVIDER_SETTINGS, startScreen: "projects" }),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();

    expect(await screen.findByRole("heading", { name: "프로젝트 관리" })).toBeInTheDocument();
    expect(openRecentProject).not.toHaveBeenCalled();
    expect(createProjectSession).toHaveBeenCalledOnce();
  });

  it("restores a normally closed workspace snapshot after a clean shutdown", async () => {
    const restoredProject = normalizeProject(createEmptyProject("정상 종료 프로젝트", false));
    restoredProject.metadata.id = "closed-project";
    restoredProject.pageImages = [pageImage({ id: "closed-image", pageNumber: 1 })];
    // @ts-expect-error renderer fixture intentionally uses the legacy line shape.
    restoredProject.dialogueLines = [{ ...rendererLine("closed-line", 1, "정상 종료 원문"), speaker: "A" }];
    const snapshot = createWorkspaceSessionSnapshot({
      identity: {
        projectId: "closed-project",
        projectKey: "closed-recent",
        recentProjectId: "closed-recent",
        revision: 7
      },
      currentPage: 1,
      pageCount: 1,
      viewport: {
        ...createImageViewportState(),
        viewMode: "actual",
        zoom: 1.5,
        pan: { x: 11, y: 9 }
      },
      resultLayer: "translated",
      bottomPanel: "dialogue",
      dialogueView: "full",
      selectedLineId: "closed-line",
      lifecycle: "closed"
    });
    window.localStorage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    const openRecentProject = vi.fn().mockResolvedValue({
      projectSessionId: "closed-session",
      project: { revision: 7, project: restoredProject, pendingPageImages: [] as [], dirty: false, status: "active" as const },
      encrypted: false,
      recentProject: { recentProjectId: "closed-recent", title: "정상 종료 프로젝트", openedAt: new Date().toISOString() }
    });
    window.projectApi = {
      createProjectSession: vi.fn(), openRecentProject, openProjectFromDialog: vi.fn(), unlockProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined), listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(),
      applyProjectMutation: vi.fn(), saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };

    renderApp();
    await screen.findByRole("img", { name: "1페이지 이미지" });
    await waitFor(() => expect(openRecentProject).toHaveBeenCalledWith({ recentProjectId: "closed-recent" }));
    expect(screen.getByTestId("page-image-viewport")).toHaveAttribute("data-view-mode", "actual");
    expect(screen.getByRole("button", { name: /식자\/번역 결과|Translated result/i })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("status", { name: "작업 상태" })).toHaveTextContent("이전 작업 문맥을 복원했습니다.");
    expect(screen.getAllByRole("status", { name: "작업 상태" })).toHaveLength(1);
    expect(screen.getByTestId("focus-deck-shell")).toHaveClass("pages-collapsed", "inspector-collapsed", "results-collapsed");
    await openWorkspacePanel("진행");
    expect(screen.getByRole("tab", { name: "대사" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "작업 큐 보기" })).toBeInTheDocument();
  });

  it("does not overwrite a persisted snapshot while a successful recent open is still pending", async () => {
    const before = createWorkspaceSessionSnapshot({
      identity: { projectId: "pending-project", projectKey: "pending-recent", recentProjectId: "pending-recent", revision: 2 },
      currentPage: 1,
      pageCount: 1,
      lifecycle: "closed"
    });
    const serializedBefore = JSON.stringify(before);
    window.localStorage.setItem(WORKSPACE_SESSION_STORAGE_KEY, serializedBefore);
    let resolveOpen: ((result: unknown) => void) | undefined;
    const openRecentProject = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveOpen = resolve; }));
    window.projectApi = {
      createProjectSession: vi.fn(), openRecentProject, openProjectFromDialog: vi.fn(), unlockProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined), listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(),
      applyProjectMutation: vi.fn(), saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(openRecentProject).toHaveBeenCalledWith({ recentProjectId: "pending-recent" }));
    expect(window.localStorage.getItem(WORKSPACE_SESSION_STORAGE_KEY)).toBe(serializedBefore);
    resolveOpen?.(null);
  });

  it("uses safe defaults when a successfully opened recent project has a newer revision", async () => {
    const before = createWorkspaceSessionSnapshot({
      identity: { projectId: "mismatch-project", projectKey: "mismatch-recent", recentProjectId: "mismatch-recent", revision: 2 },
      currentPage: 1,
      pageCount: 1,
      viewport: { ...createImageViewportState(), viewMode: "actual", zoom: 2 },
      lifecycle: "closed"
    });
    window.localStorage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(before));
    const restoredProject = normalizeProject(createEmptyProject("Revision 프로젝트", false));
    restoredProject.metadata.id = "mismatch-project";
    restoredProject.pageImages = [pageImage({ id: "mismatch-image", pageNumber: 1 })];
    // @ts-expect-error renderer fixture intentionally uses the legacy line shape.
    restoredProject.dialogueLines = [{ ...rendererLine("mismatch-line", 1, "Revision 원문"), speaker: "A" }];
    const openRecentProject = vi.fn().mockResolvedValue({
      projectSessionId: "mismatch-session",
      project: { revision: 3, project: restoredProject, pendingPageImages: [] as [], dirty: false, status: "active" as const },
      encrypted: false,
      recentProject: { recentProjectId: "mismatch-recent", title: "Revision 프로젝트", openedAt: new Date().toISOString() }
    });
    const createProjectSession = vi.fn();
    window.projectApi = {
      createProjectSession, openRecentProject, openProjectFromDialog: vi.fn(), unlockProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined), listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(),
      applyProjectMutation: vi.fn(), saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };

    renderApp();
    await screen.findByRole("img", { name: "1페이지 이미지" });
    await waitFor(() => expect(openRecentProject).toHaveBeenCalledWith({ recentProjectId: "mismatch-recent" }));
    expect(createProjectSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("page-image-viewport")).toHaveAttribute("data-view-mode", "fit");
    expect(screen.queryByText("이전 작업 문맥을 복원했습니다.")).not.toBeInTheDocument();
    const saved = JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_STORAGE_KEY) ?? "null");
    expect(saved.project.revision).toBe(3);
  });

  it("keeps the encrypted recent project on the safe home path without overwriting its snapshot", async () => {
    const before = createWorkspaceSessionSnapshot({
      identity: { projectId: "secret-project", projectKey: "secret-recent", recentProjectId: "secret-recent", revision: 1 },
      currentPage: 1,
      pageCount: 1,
      lifecycle: "closed"
    });
    const serializedBefore = JSON.stringify(before);
    window.localStorage.setItem(WORKSPACE_SESSION_STORAGE_KEY, serializedBefore);
    const openRecentProject = vi.fn().mockResolvedValue({ passwordRequired: true });
    const createProjectSession = vi.fn();
    window.projectApi = {
      createProjectSession, openRecentProject, openProjectFromDialog: vi.fn(), unlockProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined), listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(),
      applyProjectMutation: vi.fn(), saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };

    renderApp();
    await waitFor(() => expect(openRecentProject).toHaveBeenCalledWith({ recentProjectId: "secret-recent" }));
    expect(createProjectSession).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(WORKSPACE_SESSION_STORAGE_KEY)).toBe(serializedBefore);
    expect(screen.queryByRole("img", { name: "1페이지 이미지" })).not.toBeInTheDocument();
  });

  it("restores a typesetting draft with immutable OCR geometry and a separate mutable box", async () => {
    const restoredProject = normalizeProject(createEmptyProject("식자 복원 프로젝트", false));
    restoredProject.metadata.id = "typeset-restore-project";
    restoredProject.pageImages = [pageImage({ id: "typeset-restore-image", pageNumber: 1 })];
    // @ts-expect-error renderer fixture intentionally uses the legacy line shape.
    restoredProject.dialogueLines = [{ ...rendererLine("typeset-restore-line", 1, "식자 원문"), speaker: "A" }];
    const sourceOcrBbox = { x: 0.2, y: 0.3, width: 0.4, height: 0.2 };
    saveTypesettingDraft(window.localStorage, {
      projectId: "typeset-restore-project",
      pageImageId: "typeset-restore-image",
      sourceOcrId: "ocr-restore-1"
    }, {
      id: "typeset-restore-draft",
      sourceOcrId: "ocr-restore-1",
      bbox: { x: 0.25, y: 0.34, width: 0.1, height: 0.05 },
      rotationDegrees: 15,
      writingMode: "horizontal-tb"
    });
    const snapshot = createWorkspaceSessionSnapshot({
      identity: { projectId: "typeset-restore-project", projectKey: "typeset-restore-recent", recentProjectId: "typeset-restore-recent", revision: 3 },
      currentPage: 1,
      pageCount: 1,
      visibleOverlays: ["ocr", "safe-area", "typeset", "issue"],
      selectedLineId: "typeset-restore-line",
      currentIssue: { lineId: "typeset-restore-line", kind: "translation", editor: "translation" },
      issueEditor: { activeEditor: "translation", pinned: true },
      drafts: {
        translationLineId: null,
        translationSourceIdentity: null,
        typesettingPageImageId: "typeset-restore-image",
        typesettingSourceOcrId: "ocr-restore-1",
        typesettingSourceOcrBbox: sourceOcrBbox
      }
    });
    window.localStorage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    const openRecentProject = vi.fn().mockResolvedValue({
      projectSessionId: "typeset-restore-session",
      project: { revision: 3, project: restoredProject, pendingPageImages: [] as [], dirty: false, status: "active" as const },
      encrypted: false,
      recentProject: { recentProjectId: "typeset-restore-recent", title: "식자 복원 프로젝트", openedAt: new Date().toISOString() }
    });
    window.projectApi = {
      createProjectSession: vi.fn(), openRecentProject, openProjectFromDialog: vi.fn(), unlockProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined), listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(),
      applyProjectMutation: vi.fn(), saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };

    renderApp();
    await screen.findByRole("img", { name: "1페이지 이미지" });
    await selectWorkspaceEditingTool("글자 배치");
    const typesettingEditor = await screen.findByTestId("typesetting-box-editor");
    expect(typesettingEditor).toHaveStyle({ left: "25%", top: "34%", width: "10%", height: "5%" });
    expect(screen.getByTestId("semantic-overlay-active-ocr")).toHaveStyle({ left: "20%", top: "30%", width: "40%", height: "20%" });
  });

  it("restores draft, issue pin, viewport layers, result, overlays and panel width without dirtying the project", async () => {
    const restoredProject = normalizeProject(createEmptyProject("문맥 프로젝트", false));
    restoredProject.metadata.id = "context-project";
    restoredProject.pageImages = [pageImage({ id: "context-image", pageNumber: 1 })];
    restoredProject.dialogueLines = restoredProject.dialogueLines.map((line) => ({ ...line, speaker: "A" }));
    // @ts-expect-error renderer fixture intentionally uses the legacy line shape.
    restoredProject.dialogueLines = [{ ...rendererLine("context-line", 1, "문맥 원문"), speaker: "A", lineStatus: "untranslated" }];
    const sourceIdentity = createTranslationSourceIdentity("문맥 원문");
    saveTranslationDraft(window.localStorage, {
      projectId: "context-project",
      projectRevision: 4,
      lineId: "context-line",
      sourceIdentity,
      lineStatus: "untranslated"
    }, "복원 초안");
    const snapshot = createWorkspaceSessionSnapshot({
      identity: { projectId: "context-project", projectKey: "context-recent", recentProjectId: "context-recent", revision: 4 },
      currentPage: 1,
      pageCount: 1,
      viewport: {
        ...createImageViewportState(),
        viewMode: "actual",
        zoom: 2,
        pan: { x: 32, y: 21 },
        layers: { ...createImageViewportState().layers, ocr: false }
      },
      comparison: { mode: "opacity", revealPosition: 61, opacity: 0.35 },
      resultLayer: "inpainted",
      visibleOverlays: ["ocr", "issue"],
      workspacePanels: { pagesOpen: false, inspectorOpen: true, resultsOpen: true, focusMode: false, inspectorWidth: 448 },
      bottomPanel: "issues",
      dialogueView: "full",
      selectedLineId: "context-line",
      currentIssue: { lineId: "context-line", kind: "translation", editor: "translation" },
      issueEditor: { activeEditor: "translation", pinned: true },
      drafts: {
        translationLineId: "context-line",
        translationSourceIdentity: sourceIdentity,
        typesettingPageImageId: null,
        typesettingSourceOcrId: null
      }
    });
    window.localStorage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    const openRecentProject = vi.fn().mockResolvedValue({
      projectSessionId: "context-session",
      project: { revision: 4, project: restoredProject, pendingPageImages: [] as [], dirty: false, status: "active" as const },
      encrypted: false,
      recentProject: { recentProjectId: "context-recent", title: "문맥 프로젝트", openedAt: new Date().toISOString() }
    });
    window.projectApi = {
      createProjectSession: vi.fn(), openRecentProject, openProjectFromDialog: vi.fn(), unlockProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined), listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(),
      applyProjectMutation: vi.fn(), saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };

    renderApp();
    await screen.findByRole("img", { name: "1페이지 이미지" });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("이전 작업 문맥을 복원했습니다."));
    expect(screen.getByTestId("page-image-viewport")).toHaveAttribute("data-view-mode", "actual");
    expect(screen.getByText("200%", { selector: ".page-image-zoom" })).toBeInTheDocument();
    const restoredViewport = screen.getByTestId("page-image-viewport") as HTMLElement;
    expect(restoredViewport.scrollLeft).toBe(32);
    expect(restoredViewport.scrollTop).toBe(21);
    expect(screen.getByRole("button", { name: /인페인팅 결과|Inpainted result/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /OCR 레이어|OCR layer/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("focus-deck-shell")).toHaveClass("pages-collapsed", "inspector-collapsed", "results-collapsed");
    await openWorkspacePanel("진행");
    await openWorkspacePanel("수정");
    expect(screen.getByRole("tab", { name: "문제 라인" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: /투명도 비교|Opacity comparison/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "inpainting-mask overlay" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "ocr 오버레이 OCR 영역" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "issue 오버레이 문제 오버레이" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("focus-deck-shell")).toHaveClass("pages-collapsed");
    expect(screen.getByTestId("focus-deck-shell")).not.toHaveClass("results-collapsed");
    expect(screen.getByRole("contentinfo", { name: "결과 및 진행" })).toBeInTheDocument();
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "448");
    expect(screen.getByRole("button", { name: "문제 라인 1 선택" })).toHaveAttribute("aria-current", "true");
    const ocrOverlayButton = screen.getAllByRole("button").find((button) => button.getAttribute("aria-label")?.startsWith("ocr "));
    expect(ocrOverlayButton).toHaveAttribute("aria-pressed", "false");
    const issueOverlayButton = screen.getAllByRole("button").find((button) => button.getAttribute("aria-label")?.startsWith("issue "));
    expect(issueOverlayButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("focus-deck-shell")).toHaveClass("pages-collapsed");
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "448");
    expect(screen.getByTestId("current-issue")).toHaveAttribute("data-issue-kind", "translation");
    expect(screen.getByRole("button", { name: "편집기 pin 해제" })).toBeInTheDocument();
    await openWorkspacePanel("수정");
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("복원 초안");
    expect(screen.getByText("저장됨")).toBeInTheDocument();
    const storedAfterRestore = JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_STORAGE_KEY) ?? "null");
    expect(storedAfterRestore.project.projectId).toBe("context-project");
    expect(storedAfterRestore.lifecycle).toBe("active");
  });

  it("uses safe defaults and preserves the old snapshot when a recent project is unavailable or outdated", async () => {
    const before = createWorkspaceSessionSnapshot({
      identity: { projectId: "missing-project", projectKey: "missing-recent", recentProjectId: "missing-recent", revision: 1 },
      currentPage: 1,
      pageCount: 1
    });
    window.localStorage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify({ ...before, project: { ...before.project, revision: 0 } }));
    const openRecentProject = vi.fn().mockResolvedValue(null);
    const createProjectSession = vi.fn();
    window.projectApi = {
      createProjectSession, openRecentProject, openProjectFromDialog: vi.fn(), unlockProject: vi.fn(),
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      applyProjectMutation: vi.fn(), saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };
    renderApp();
    await waitFor(() => expect(openRecentProject).toHaveBeenCalledWith({ recentProjectId: "missing-recent" }));
    expect(createProjectSession).toHaveBeenCalledOnce();
    expect(JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_STORAGE_KEY) ?? "null")).toEqual(expect.objectContaining({ project: expect.objectContaining({ revision: 0 }) }));
    expect(screen.queryByText("이전 작업 문맥을 복원했습니다.")).not.toBeInTheDocument();
  });

  it("recovers from a rejected recent restore by creating one safe initial session", async () => {
    const before = createWorkspaceSessionSnapshot({
      identity: {
        projectId: "failed-recent-project",
        projectKey: "failed-recent",
        recentProjectId: "failed-recent",
        revision: 1
      },
      currentPage: 1,
      pageCount: 1
    });
    window.localStorage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(before));
    const initialProject = normalizeProject(createEmptyProject("안전한 새 프로젝트", false));
    const createProjectSession = vi.fn().mockResolvedValue({
      projectSessionId: "safe-initial-session",
      project: {
        revision: 0,
        project: initialProject,
        pendingPageImages: [] as [],
        dirty: false,
        status: "active" as const
      },
      encrypted: false
    });
    const openRecentProject = vi.fn().mockRejectedValue(new Error("recent unavailable"));
    window.projectApi = {
      createProjectSession,
      openRecentProject,
      openProjectFromDialog: vi.fn(),
      unlockProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      applyProjectMutation: vi.fn(),
      saveProject: vi.fn(),
      saveProjectAs: vi.fn(),
      rekeyProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();

    await waitFor(() => expect(openRecentProject).toHaveBeenCalledOnce());
    await waitFor(() => expect(createProjectSession).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "새 번역 프로젝트" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    expect(await screen.findByRole("heading", { name: "새 번역 프로젝트" })).toBeVisible();
  });

  it("blocks session-backed project actions after initial session failure and retries without legacy saving", async () => {
    const initialProject = normalizeProject(createEmptyProject("재시도 프로젝트", false));
    const createProjectSession = vi.fn()
      .mockRejectedValueOnce(new Error("session unavailable"))
      .mockResolvedValueOnce({
        projectSessionId: "retried-session",
        project: {
          revision: 0,
          project: initialProject,
          pendingPageImages: [] as [],
          dirty: false,
          status: "active" as const
        },
        encrypted: false
      });
    const saveProject = vi.fn();
    const saveProjectAs = vi.fn();
    window.projectApi = {
      createProjectSession,
      openProjectFromDialog: vi.fn(),
      openRecentProject: vi.fn(),
      unlockProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      removeRecentProject: vi.fn(),
      applyProjectMutation: vi.fn(),
      saveProject,
      saveProjectAs,
      rekeyProject: vi.fn(),
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn()
    };

    renderApp();

    expect(await screen.findByText(/프로젝트 세션을 준비하지 못했습니다/)).toBeVisible();
    expect(screen.getByRole("button", { name: "새 번역 프로젝트" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "TXT로 시작", hidden: true })).toBeDisabled();
    expect(saveProject).not.toHaveBeenCalled();
    expect(saveProjectAs).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 세션 다시 시도" }));

    await waitFor(() => expect(createProjectSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "새 번역 프로젝트" })).toBeEnabled());
    expect(window.projectApi.openRecentProject).not.toHaveBeenCalled();
    expect(saveProject).not.toHaveBeenCalled();
    expect(saveProjectAs).not.toHaveBeenCalled();
  });

  it("handles Ctrl+S keyboard shortcut to save project", async () => {
    const saveProjectMock = vi.fn().mockResolvedValue({
      project: {
        schemaVersion: 2,
        metadata: { id: "p1", title: "Saved", secret: false, createdAt: "", updatedAt: "" },
        settings: { defaultSourceLanguage: "ja" },
        pageImages: [],
        dialogueLines: [],
        characters: [],
        dictionaryTerms: []
      },
      savedAt: new Date().toISOString()
    });

    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "workspace.txt",
        lines: [rendererLine("workspace-line", 1, "Workspace line")]
      }),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\saved.ctp"),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: saveProjectMock
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(saveProjectMock).toHaveBeenCalled());
  });

  it("Stitch Q8: preserves a draft and review count across save and navigation without confirming it", async () => {
    const saveProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "review.txt", lines: [
        { ...rendererLine("stitch-one", 1, "첫 원문"), speaker: "A" },
        { ...rendererLine("stitch-two", 2, "다음 원문"), speaker: "B" }
      ] }),
      chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Review.ctp"), exportTranslations: vi.fn(), openProject: vi.fn(), saveProject
    };
    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    const draft = await screen.findByLabelText("사용자 수정문 1");
    // Approved Stitch spec Q8: editing, saving and navigation do not confirm review.
    expect(screen.getByRole("status", { name: "작업대 현황" })).toHaveTextContent("프로젝트 확인 필요 2개");
    fireEvent.change(draft, { target: { value: "내가 고친 첫 번역" } });
    expect(screen.getByRole("status", { name: "작업대 현황" })).toHaveTextContent("프로젝트 확인 필요 2개");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(saveProject).toHaveBeenCalledOnce());
    expect(screen.getByRole("status", { name: "작업대 현황" })).toHaveTextContent("프로젝트 확인 필요 2개");
    fireEvent.click(screen.getByRole("button", { name: "다음 라인" }));
    await screen.findByLabelText("사용자 수정문 2");
    expect(screen.getByRole("status", { name: "작업대 현황" })).toHaveTextContent("프로젝트 확인 필요 2개");
    fireEvent.click(screen.getByRole("button", { name: "이전 라인" }));
    expect(await screen.findByLabelText("사용자 수정문 1")).toHaveValue("내가 고친 첫 번역");
    expect(screen.getByRole("button", { name: "완료 표시" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status", { name: "작업대 현황" })).toHaveTextContent("프로젝트 확인 필요 2개");
  });

  it("Stitch: a delayed confirmation preserves the next selection and its draft", async () => {
    const opened = normalizeProject(openedProjectWithImages([], [
      { ...rendererLine("delayed-one", 1, "첫 원문"), speaker: "A", aiTranslation: "첫 제안" },
      { ...rendererLine("delayed-two", 2, "다음 원문"), speaker: "B", aiTranslation: "다음 제안" }
    ]).project);
    let sessionProject = structuredClone(opened);
    let revision = 1;
    let releaseConfirmation: (() => void) | undefined;
    const confirmationGate = new Promise<void>((resolve) => { releaseConfirmation = resolve; });
    const dto = (project: TranslationProjectV2, currentRevision: number, dirty: boolean) => ({
      project: structuredClone(project), revision: currentRevision, dirty, status: "active" as const, pendingPageImages: [] as []
    });
    const applyProjectMutation = vi.fn(async (args: ApplyProjectMutationArgs) => {
      if (args.mutation.type === "update_dialogue_line" && args.mutation.patch.lineStatus === "complete") await confirmationGate;
      const normalized = validateAndNormalizeProjectMutation(sessionProject, args.mutation);
      sessionProject = applyNormalizedProjectMutation(sessionProject, normalized.mutation);
      revision += 1;
      return { status: "applied" as const, revision, project: dto(sessionProject, revision, true) };
    });
    window.projectApi = {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(normalizeProject(createEmptyProject("Initial", false)), 0, false), encrypted: false }),
      openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "opened-session", project: dto(opened, 1, false), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), applyProjectMutation,
      saveProject: vi.fn(), saveProjectAs: vi.fn(), rekeyProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), removeRecentProject: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn()
    };
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "기존 프로젝트 열기" }));
    await openWorkspacePanel("수정");
    await screen.findByLabelText("사용자 수정문 1");
    fireEvent.click(screen.getByRole("button", { name: "확인 필요 대사 목록 열기" }));
    fireEvent.click(screen.getByRole("button", { name: "문제 라인 1 선택" }));
    await screen.findByRole("button", { name: /^(제안 채택 및 )?검수 확정$/ });
    fireEvent.click(screen.getByRole("button", { name: /^(제안 채택 및 )?검수 확정$/ }));
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "다음 라인" }));
    fireEvent.change(await screen.findByLabelText("사용자 수정문 2"), { target: { value: "다음 대사의 새 초안" } });
    await act(async () => { releaseConfirmation?.(); await confirmationGate; });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("사용자 수정문 2")).toHaveValue("다음 대사의 새 초안");
    expect(screen.getByRole("button", { name: "완료 표시" })).toHaveAttribute("aria-pressed", "false");
    expect(window.localStorage.getItem("trio.translation-drafts.v1")).toContain("다음 대사의 새 초안");
  });

  it("Stitch: reading keeps the editor mounted and blocks hidden confirmation shortcuts", async () => {
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({ filePath: "reading.txt", lines: [
        { ...rendererLine("reading-one", 1, "첫 페이지", 1), speaker: "A" },
        { ...rendererLine("reading-two", 2, "둘째 페이지", 2), speaker: "B" }
      ] }),
      chooseSaveFile: vi.fn(), exportTranslations: vi.fn(), openProject: vi.fn(), saveProject: vi.fn()
    };
    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    const draft = await screen.findByLabelText("사용자 수정문 1");
    fireEvent.change(draft, { target: { value: "읽기 전에 고친 번역" } });
    await openWorkspacePanel("페이지");
    const savedPanelPreferences = () => Object.fromEntries(Object.keys(window.localStorage)
      .filter((key) => key.startsWith("focus-deck:"))
      .map((key) => [key, window.localStorage.getItem(key)]));
    const panelPreferencesBeforeReading = savedPanelPreferences();
    fireEvent.click(screen.getByRole("button", { name: "전체 페이지 최종 읽기" }));
    expect(screen.getByTestId("focus-deck-shell")).toHaveClass("reading-mode");
    expect(draft).toBeInTheDocument();
    expect(draft).not.toBeVisible();
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(window, { key: "2", altKey: true });
    expect(screen.getByRole("button", { name: "페이지 목록 접기" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(screen.getByRole("button", { name: "페이지 목록 열기" })).toHaveAttribute("aria-expanded", "false");
    expect(savedPanelPreferences()).toEqual(panelPreferencesBeforeReading);
    fireEvent.click(screen.getByRole("button", { name: "대사 편집으로 돌아가기" }));
    expect(screen.getByRole("complementary", { name: "페이지 목록" })).toBeVisible();
    expect(savedPanelPreferences()).toEqual(panelPreferencesBeforeReading);
    expect(screen.getByLabelText("사용자 수정문 1")).toBe(draft);
    expect(draft).toHaveValue("읽기 전에 고친 번역");
    expect(screen.getByRole("button", { name: "완료 표시" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "전체 페이지 최종 읽기" }));
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(screen.getByTestId("focus-deck-shell")).toHaveClass("reading-mode");
    expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2");
    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    fireEvent.click(screen.getByRole("button", { name: "대사 편집으로 돌아가기" }));
    expect(await screen.findByLabelText("사용자 수정문 1")).toHaveValue("읽기 전에 고친 번역");
  });

  it("handles Alt+1/2/3 keyboard shortcuts to update line status", async () => {
    window.projectApi = {
      importTxtFile: vi.fn().mockResolvedValue({
        filePath: "workspace.txt",
        lines: [rendererLine("workspace-line", 1, "Workspace line")]
      }),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();
    await clickTxtStart();
    await openWorkspacePanel("수정");
    await screen.findByLabelText("원문 1");

    fireEvent.change(screen.getByLabelText("사용자 수정문 1"), { target: { value: "단축키로 확정할 번역" } });

    // Press Alt+2 for complete
    fireEvent.keyDown(window, { key: "2", altKey: true });
    const completeBtn = screen.getByRole("button", { name: "완료 표시" });
    expect(completeBtn).toHaveAttribute("aria-pressed", "true");

    // Press Alt+3 for review
    fireEvent.keyDown(window, { key: "3", altKey: true });
    const reviewBtn = screen.getByRole("button", { name: "검토필요 표시" });
    expect(reviewBtn).toHaveAttribute("aria-pressed", "true");
  });
});
