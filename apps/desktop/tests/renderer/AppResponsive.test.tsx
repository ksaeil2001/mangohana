import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DialogueLine, PageImage } from "../../src/shared/projectTypes";
import { PRODUCTION_OCR_CONTRACT } from "../../src/shared/productionOcr";
import type { SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction";
import { DEFAULT_PROVIDER_SETTINGS } from "../../src/shared/providerSettings";
import { createEmptyProject } from "../../src/shared/projectValidation";
import App from "../../src/renderer/App";
import { openWorkspacePanel, selectWorkspaceEditingTool } from "./workspaceTestActions";

function renderApp() {
  if (window.projectApi && !window.projectApi.getProviderSettings) {
    window.projectApi.getProviderSettings = vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS);
  }
  return render(<App />);
}

function makePageImage(id: string, pageNumber: number): PageImage {
  return {
    id,
    pageNumber,
    storedRelativePath: `Book-assets/images/page-${pageNumber}.png`,
    originalFileName: `page-${pageNumber}.png`,
    sha256: "a".repeat(64),
    byteSize: 4,
    mimeType: "image/png",
    copiedAt: "2026-08-09T00:00:00.000Z"
  };
}

function makeResponsiveProject() {
  const project = createEmptyProject("Responsive project", false);
  // Exercise the legacy project path while keeping the production fixture type.
  (project as unknown as { schemaVersion: 1 }).schemaVersion = 1;
  project.metadata.id = "responsive-project";
  const line: DialogueLine = {
    id: "responsive-line",
    order: 1,
    pageNumber: 1,
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "Responsive source",
    lineStatus: "untranslated",
    parseConfidence: 0.9,
    parseWarnings: []
  };
  project.dialogueLines = [line];
  project.pageImages = [makePageImage("responsive-page-1", 1), makePageImage("responsive-page-2", 2)];
  return { filePath: "C:\\projects\\responsive.ctp", encrypted: false, project };
}

function makeResponsiveReview(): SpeechBubbleExtractionResult {
  return {
    pageNumber: 1,
    speechBubbles: [{
      id: "responsive-review-bubble",
      type: "speech_bubble" as const,
      text: "Responsive OCR",
      language: "ja" as const,
      bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.15 },
      readingOrder: 1,
      confidence: 0.95,
      notes: "",
      speakerCandidates: [],
      orientation: "horizontal" as const,
      polygon: [
        { x: 0.2, y: 0.2 },
        { x: 0.5, y: 0.2 },
        { x: 0.5, y: 0.35 },
        { x: 0.2, y: 0.35 }
      ],
      productionOcrProvenance: {
        contractVersion: 1 as const,
        detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId,
        detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision,
        recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId,
        recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision,
        groupId: "group-responsive",
        sourceDetectionIds: ["detection-responsive"],
        sourceDetectionScores: [0.9],
        sourceQuadsPx: [[
          { x: 20, y: 20 },
          { x: 50, y: 20 },
          { x: 50, y: 35 },
          { x: 20, y: 35 }
        ]],
        orientation: "horizontal" as const,
        cropTransform: {
          sourceBboxPx: { x: 20, y: 20, width: 30, height: 15 },
          cropBboxPx: { x: 18, y: 19, width: 34, height: 17 },
          paddingRatio: 0.08 as const,
          rotationDegrees: 0 as const,
          imageWidth: 100,
          imageHeight: 100
        },
        confidenceSource: "detector_min" as const
      }
    }],
    nonSpeechText: [],
    warnings: []
  };
}

function makeProductionExtraction(result: SpeechBubbleExtractionResult = {
  pageNumber: 1,
  speechBubbles: [],
  nonSpeechText: [],
  warnings: []
}) {
  return {
    ...result,
    productionOcrContext: {
      runId: "ocr-responsive",
      pageImageId: "responsive-page-1",
      sourceSha256: "a".repeat(64)
    }
  };
}

function installResponsiveSessionApi(overrides: Record<string, unknown> = {}) {
  const opened = makeResponsiveProject();
  const sessionResult = {
    projectSessionId: "responsive-session",
    encrypted: false,
    project: {
      revision: 0,
      project: opened.project,
      pendingPageImages: [],
      dirty: false,
      status: "active" as const
    }
  };
  window.projectApi = {
    importTxtFile: vi.fn(),
    chooseSaveFile: vi.fn(),
    exportTranslations: vi.fn(),
    openProjectFromDialog: vi.fn().mockResolvedValue(sessionResult),
    openRecentProject: vi.fn().mockResolvedValue(sessionResult),
    unlockProject: vi.fn().mockResolvedValue(sessionResult),
    closeProject: vi.fn().mockResolvedValue(undefined),
    saveProject: vi.fn(),
    resolvePageImageSrc: vi.fn().mockResolvedValue("responsive://page"),
    ...overrides
  } as typeof window.projectApi;
}

describe("App responsive precision policy", () => {
  const previousWidth = window.innerWidth;

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    Reflect.deleteProperty(window, "projectApi");
  });

  it("keeps welcome header actions plus primary and secondary start actions in the DOM at 1024px", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn()
    };

    renderApp();

    const header = document.querySelector(".project-home-header");
    expect(header).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "최근 프로젝트 전환" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "프로젝트 목록으로 이동" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 번역 프로젝트" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "기존 프로젝트 열기" })).toBeInTheDocument();
  });

  it("keeps image/page/OCR/save work available below 1024px and disables only inpainting entry", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    const opened = makeResponsiveProject();
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(opened),
      saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn().mockResolvedValue("responsive://page"),
      extractSpeechBubbles: vi.fn().mockResolvedValue({ pageNumber: 1, speechBubbles: [], nonSpeechText: [], warnings: [] }),
      validateSpeechBubbles: vi.fn()
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    expect(await screen.findByAltText("1페이지 이미지")).toBeInTheDocument();

    const shell = screen.getByTestId("focus-deck-shell");
    expect(shell).toHaveAttribute("data-layout-tier", "precision-limited");
    expect(screen.getByRole("status", { name: "정밀 편집 안내" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다음 페이지" })).not.toBeDisabled();

    await openWorkspacePanel("수정");

    const ocrButton = screen.getAllByRole("button").find((button) => /OCR/.test(button.textContent ?? ""));
    expect(ocrButton).toBeDefined();
    expect(ocrButton).not.toBeDisabled();
    const saveButton = screen.getAllByRole("button").find((button) => button.textContent?.trim() === "저장");
    expect(saveButton).toBeDefined();
    expect(saveButton).not.toBeDisabled();

    const inpaintingButton = screen
      .getAllByRole("button")
      .find((button) => button.closest(".inspector-image-action-buttons") && /인페인팅/.test(button.textContent ?? ""));
    expect(inpaintingButton).toBeDefined();
    expect(inpaintingButton).toBeDisabled();
    expect(inpaintingButton).toHaveAttribute("aria-describedby", "inspector-precision-disabled-reason");
    expect(screen.getByText(
      "창이 작아 인페인팅과 식자 상자 직접 조작을 잠시 비활성화했습니다. 이미지 열람, OCR, 수동 번역, 저장은 계속 사용할 수 있습니다."
    )).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(screen.getByAltText("2페이지 이미지")).toBeInTheDocument());
  });

  it("keeps the Space OCR shortcut available below 1024px", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    const extractSpeechBubbles = vi.fn().mockResolvedValue({
      pageNumber: 1,
      speechBubbles: [],
      nonSpeechText: [],
      warnings: []
    });
    installResponsiveSessionApi({ extractSpeechBubbles });

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    fireEvent.keyDown(window, { key: " " });

    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledTimes(1));
  });

  it("keeps the narrow inspector OCR action in the reachable second workspace track", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    const extractSpeechBubbles = vi.fn().mockResolvedValue(makeProductionExtraction());
    installResponsiveSessionApi({ extractSpeechBubbles });

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    expect(screen.getByTestId("focus-deck-shell")).toHaveAttribute("data-layout-tier", "narrow");
    await openWorkspacePanel("수정");
    const inspector = screen.getByRole("complementary", { name: "오른쪽 작업 패널" });
    const ocrButton = within(inspector).getByRole("button", { name: "말풍선 OCR" });
    expect(ocrButton).toBeEnabled();
    expect(screen.getByTestId("resizable-workspace")).not.toHaveClass("inspector-collapsed");

    fireEvent.click(ocrButton);
    await waitFor(() => expect(extractSpeechBubbles).toHaveBeenCalledTimes(1));
  });

  it("keeps manual translation editing and saving enabled below 1024px", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    const saveProject = vi.fn().mockResolvedValue(undefined);
    window.projectApi = {
      importTxtFile: vi.fn(),
      chooseSaveFile: vi.fn(),
      exportTranslations: vi.fn(),
      openProject: vi.fn().mockResolvedValue(makeResponsiveProject()),
      saveProject,
      resolvePageImageSrc: vi.fn().mockResolvedValue("responsive://page")
    };

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");

    await openWorkspacePanel("수정");
    const translation = await screen.findByLabelText("사용자 수정문 1");
    expect(translation).toBeEnabled();
    fireEvent.change(translation, { target: { value: "Responsive manual translation" } });
    expect(translation).toHaveValue("Responsive manual translation");

    const saveButton = screen.getByRole("button", { name: "저장" });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);
    await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1));
    expect(saveProject).toHaveBeenCalledWith(expect.objectContaining({
      project: expect.objectContaining({
        dialogueLines: expect.arrayContaining([
          expect.objectContaining({ userTranslation: "Responsive manual translation" })
        ])
      })
    }));
  });

  it("keeps the OCR overlay visible but disables typesetting handles below 1024px", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    const review = makeResponsiveReview();
    installResponsiveSessionApi({
      extractSpeechBubbles: vi.fn().mockResolvedValue(makeProductionExtraction(review))
    });

    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByAltText("1페이지 이미지");
    await openWorkspacePanel("수정");
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));

    await screen.findByRole("region", { name: "1페이지 말풍선 OCR 검토" });
    await selectWorkspaceEditingTool("글자 배치");
    const editor = await screen.findByTestId("typesetting-box-editor");
    expect(editor).toHaveClass("is-disabled");
    expect(screen.getByRole("button", { name: "식자 상자 이동" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "식자 상자 남동쪽 크기 조절" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "식자 상자 회전" })).toBeDisabled();
    expect(screen.getByRole("img", { name: "선택된 OCR 영역" })).toBeInTheDocument();
  });
});
