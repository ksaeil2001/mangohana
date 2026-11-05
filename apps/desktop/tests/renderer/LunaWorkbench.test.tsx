import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LunaWorkbench } from "../../src/renderer/components/LunaWorkbench";
import type { DialogueLine, PageImage } from "../../src/shared/projectTypes";
import type { PageStripItem } from "../../src/renderer/components/PageStrip";
import { DEFAULT_PROVIDER_SETTINGS } from "../../src/shared/providerSettings";

function createTestProps() {
  const pageImages: PageImage[] = [
    {
      id: "img-1",
      pageNumber: 1,
      storedRelativePath: "assets/001.png",
      originalFileName: "001.png",
      sha256: "a".repeat(64),
      byteSize: 1024 * 1024 * 2,
      mimeType: "image/png",
      copiedAt: "2026-11-03T00:00:00.000Z"
    },
    {
      id: "img-2",
      pageNumber: 2,
      storedRelativePath: "assets/002.png",
      originalFileName: "002.png",
      sha256: "b".repeat(64),
      byteSize: 1024 * 1024 * 2,
      mimeType: "image/png",
      copiedAt: "2026-11-03T00:00:00.000Z"
    }
  ];

  const pageStripItems: PageStripItem[] = [
    { pageNumber: 1, hasImage: true, lineCount: 2, issueCount: 0, storedRelativePath: "assets/001.png" },
    { pageNumber: 2, hasImage: true, lineCount: 2, issueCount: 0, storedRelativePath: "assets/002.png" }
  ];

  const lines: DialogueLine[] = [
    {
      id: "line-1",
      order: 1,
      pageNumber: 2,
      speaker: "A",
      sourceText: "Hello",
      aiTranslation: "오늘.. 그 사람이 아침 조회 때 나한테 말을 걸었어.",
      userTranslation: "오늘.. 그 사람이 아침 조회 때 나한테 말을 걸었어.",
      dialogueType: "speech",
      sourceLanguage: "ja",
      parseConfidence: 0.95,
      parseWarnings: [],
      lineStatus: "draft",
      ocrEditStatus: "ai_proposed",
      typesetting: { bbox: { x: 0.2, y: 0.25, width: 0.3, height: 0.2 }, writingMode: "horizontal-tb" }
    }
  ];

  return {
    projectTitle: "[Mint No Chicchai Oana] NTR Jigo Houkoku 2 After",
    createdAt: "2026-11-03T00:00:00.000Z",
    currentPage: 2,
    pageCount: 2,
    pageImages,
    pageStripItems,
    currentPageLines: lines,
    allLines: lines,
    selectedLineId: "line-1",
    issueCount: 1,
    currentFilePath: "C:\\projects\\test.ctp",
    projectSessionId: "session-1",
    isTranslating: false,
    isInpainting: false,
    isExtractingOcr: false,
    workspaceZoom: 0.45,
    showingOriginal: false,
    theme: "dark" as const,
    onToggleTheme: vi.fn(),
    onGoHome: vi.fn(),
    onSelectPage: vi.fn(),
    onPreviousPage: vi.fn(),
    onNextPage: vi.fn(),
    onSelectLine: vi.fn(),
    onUpdateLine: vi.fn(),
    onUpdateLineBbox: vi.fn(),
    onDeleteLine: vi.fn(),
    onCreateManualLine: vi.fn(),
    onRequestAiTranslation: vi.fn(),
    onRunOcr: vi.fn(),
    onOpenInpainting: vi.fn(),
    onOpenBatchModal: vi.fn(),
    onExportImages: vi.fn(),
    onExportTxt: vi.fn(),
    onImportImages: vi.fn(),
    onCancelActiveTasks: vi.fn(),
    onOpenEnvironmentPreparation: vi.fn(),
    onSaveProject: vi.fn(),
    onToggleShowOriginal: vi.fn(),
    onZoomChange: vi.fn()
  };
}

describe("LunaWorkbench", () => {
  it("opens batch setup for the selected image pages only", () => {
    const props = createTestProps();
    render(<LunaWorkbench {...props}>{null}</LunaWorkbench>);
    fireEvent.click(screen.getByTitle("Switch to Folder Grid View"));

    const batch = screen.getByRole("button", { name: "일괄 작업" });
    expect(batch).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "2페이지 일괄 작업 선택" }));
    fireEvent.click(batch);
    expect(props.onOpenBatchModal).toHaveBeenCalledExactlyOnceWith([2]);
    expect(props.onSelectPage).not.toHaveBeenCalled();
  });

  it("shows the saved translation model and opens real settings", async () => {
    vi.stubGlobal("projectApi", {
      getProviderSettings: vi.fn().mockResolvedValue({
        ...DEFAULT_PROVIDER_SETTINGS,
        translationEngine: "local_ai",
        localAiModel: "fixture-local-model"
      })
    });
    try {
      const openSettings = vi.fn();
      render(<LunaWorkbench {...createTestProps()} onOpenTranslationSettings={openSettings}>{null}</LunaWorkbench>);
      fireEvent.click(screen.getByTitle("Switch to Folder Grid View"));

      expect(await screen.findByText("fixture-local-model")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "번역 설정 열기" }));
      expect(openSettings).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows image-only projects at zero dialogue coverage with no invented execution data", () => {
    const props = createTestProps();
    render(<LunaWorkbench {...props} allLines={[]} currentPageLines={[]} issueCount={0}>{null}</LunaWorkbench>);
    fireEvent.click(screen.getByTitle("Switch to Folder Grid View"));

    expect(screen.getByText("대사가 있는 페이지").parentElement).toHaveTextContent("0%");
    expect(screen.getByText("대사 없음").parentElement).toHaveTextContent("2");
    expect(screen.queryByText(/Sent with|Credits spent/)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Translation Model" })).not.toBeInTheDocument();
  });

  it("renders single image view with SETTINGS tab and switches to Folder Grid view and EDIT tab", () => {
    const props = createTestProps();
    render(
      <LunaWorkbench {...props}>
        {(overlay) => <div data-testid="child-canvas">{overlay}</div>}
      </LunaWorkbench>
    );

    const workbench = screen.getByTestId("luna-workbench");
    expect(workbench).toHaveClass("view-single", "mode-settings");
    expect(screen.getByTestId("child-canvas")).toBeInTheDocument();

    // Switch to Folder Grid View via PROJECT IMAGES header button
    fireEvent.click(screen.getByTitle("Switch to Folder Grid View"));
    expect(workbench).toHaveClass("view-grid", "mode-settings");

    // Switch to EDIT mode
    const editBtn = workbench.querySelectorAll(".luna-seg-btn")[1]!;
    fireEvent.click(editBtn);
    expect(workbench).toHaveClass("view-single", "mode-edit");

    // Verify floating toolbar and typography controls exist in EDIT mode
    expect(screen.getByLabelText("Font Size")).toHaveValue("36");
    expect(screen.getByTitle("Delete Bubble")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "대사 추가" }));
    expect(props.onCreateManualLine).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "배경 정리" }));
    expect(props.onOpenInpainting).toHaveBeenCalledOnce();
  });
});
