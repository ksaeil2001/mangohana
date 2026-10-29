import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/renderer/App";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";
import { evaluateInpaintingQuality } from "../../src/shared/inpaintingQa";

afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("배경 정리 사용자 확인", () => {
  it("passes the viewed result and displayed session revision to Main and shows its saved confirmation", async () => {
    const initial = normalizeProject(createEmptyProject("초기", false));
    const opened = normalizeProject(createEmptyProject("검증 예시", false));
    const page = { id: "page-1", pageNumber: 1, storedRelativePath: "pages/p1.png", originalFileName: "p1.png", sha256: "a".repeat(64), byteSize: 10, mimeType: "image/png", copiedAt: "2026-10-29T00:00:00Z" };
    const qa = evaluateInpaintingQuality({ residualRegions: [] });
    opened.pageImages = [page, { ...page, id: "page-2", pageNumber: 2, storedRelativePath: "pages/p2.png", originalFileName: "p2.png", sha256: "c".repeat(64) }];
    opened.dialogueLines = [{ id: "line-1", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "ja", sourceText: "원문", userTranslation: "사용자 번역", lineStatus: "draft", parseConfidence: 1, parseWarnings: [], origin: { kind: "manual" } }];
    opened.processing = {
      pages: [{ pageImageId: page.id, latestCompletedRunId: "run-1", approvedCleanedAssetId: "clean-1", finalStatus: "auto_approved", updatedAt: "2026-10-29T00:00:00Z", inpaintingQa: qa }],
      runs: [{ runId: "run-1", pageImageId: page.id, source: "manual_local_edit", status: "completed", sourceSha256: page.sha256, appVersion: "test", queuedAt: "2026-10-29T00:00:00Z" }],
      assets: [{ assetId: "clean-1", source: "manual_local_edit", sourcePageImageId: page.id, runId: "run-1", role: "cleaned", storedRelativePath: "assets/clean.png", sha256: "b".repeat(64), byteSize: 10, mimeType: "image/png", createdAt: "2026-10-29T00:00:00Z", inpaintingQa: qa }]
    };
    const reviewed = structuredClone(opened);
    reviewed.processing.pages[0]!.userReviewedCleanedAssetId = "clean-1";
    const dto = (project: typeof opened, revision: number) => ({ project, revision, pendingPageImages: [], dirty: false, status: "active" as const });
    const reviewCleanedAsset = vi.fn().mockResolvedValue({ projectSessionId: "opened-session", project: dto(reviewed, 2) });
    const withBox = structuredClone(reviewed);
    withBox.dialogueLines[0]!.typesetting = { bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, writingMode: "horizontal-tb" };
    const applyProjectMutation = vi.fn().mockResolvedValue({ status: "applied", revision: 3, project: { ...dto(withBox, 3), dirty: true } });
    vi.stubGlobal("projectApi", {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial-session", project: dto(initial, 0), encrypted: false }),
      openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "opened-session", project: dto(opened, 1), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]),
      importTxtFile: vi.fn(), exportTranslations: vi.fn(), saveProject: vi.fn(),
      resolvePageImageSrc: vi.fn(async ({ storedRelativePath }: { storedRelativePath: string }) => `app:///${storedRelativePath}`),
      reviewCleanedAsset, applyProjectMutation
    });
    render(<App />);
    const open = await screen.findByRole("button", { name: "기존 프로젝트 열기" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    await screen.findByRole("region", { name: "페이지 이미지" });
    fireEvent.click(screen.getByText("보기·비교"));
    fireEvent.click(screen.getByRole("button", { name: "인페인팅 결과" }));
    const confirm = await screen.findByRole("button", { name: "배경 정리 확인" });
    expect(confirm).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("comparison-surface-original")).toHaveAttribute("src", "app:///assets/clean.png"));
    const image = screen.getByTestId("comparison-surface-original");
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 100 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 100 });
    fireEvent.load(image);
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(reviewCleanedAsset).toHaveBeenCalledExactlyOnceWith({ projectSessionId: "opened-session", pageImageId: "page-1", cleanedAssetId: "clean-1", expectedRevision: 1 }));
    expect(await screen.findByRole("button", { name: "배경 정리 확인됨" })).toBeDisabled();
    expect(screen.queryByRole("complementary", { name: "오른쪽 작업 패널" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "대사 수정" }));
    expect(await screen.findByRole("group", { name: "수정 도구" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "원문" }));
    expect(await screen.findByRole("textbox", { name: "원문 1" })).toHaveValue("원문");
    expect(screen.getByRole("button", { name: "원문" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "번역" }));
    expect(screen.getByRole("textbox", { name: "사용자 수정문 1" })).toHaveValue("사용자 번역");
    fireEvent.click(screen.getByRole("button", { name: "글자 배치" }));
    fireEvent.click(screen.getByRole("button", { name: "원본에서 영역 지정" }));
    fireEvent.click(await screen.findByText("숫자로 정밀 조정"));
    fireEvent.change(screen.getByRole("spinbutton", { name: "X (%)" }), { target: { value: "10" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Y (%)" }), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(screen.getByLabelText("현재 페이지")).toHaveTextContent("2 / 2"));
    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    const precision = await screen.findByText("숫자로 정밀 조정");
    if (!precision.closest("details")?.open) fireEvent.click(precision);
    expect(await screen.findByRole("spinbutton", { name: "X (%)" })).toHaveValue(10);
    expect(screen.getByRole("spinbutton", { name: "Y (%)" })).toHaveValue(20);
    fireEvent.change(screen.getByRole("spinbutton", { name: "너비 (%)" }), { target: { value: "30" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "높이 (%)" }), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "영역 적용" }));
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledWith(expect.objectContaining({
      projectSessionId: "opened-session", baseRevision: 2,
      mutation: { type: "update_dialogue_typesetting", lineId: "line-1", typesetting: withBox.dialogueLines[0]!.typesetting }
    })));
  });
});
