import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/renderer/App.js";
import type { ProjectChangeResult, ProjectSaveResult } from "../../src/shared/projectSessionTypes.js";
import type { TranslationProjectV2 } from "../../src/shared/projectTypes.js";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation.js";
import { PRODUCTION_OCR_CONTRACT } from "../../src/shared/productionOcr.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function dto(project: TranslationProjectV2, revision: number, dirty = false) {
  return { project, revision, dirty, pendingPageImages: [], status: "active" as const };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("App session mutation and save ordering", () => {
  it("blocks OCR review before Main when a conflict already exists and preserves its draft", async () => {
    const initial = normalizeProject(createEmptyProject("초기", false));
    const opened = normalizeProject(createEmptyProject("A", false));
    opened.pageImages = [{
      id: "page-1", pageNumber: 1, storedRelativePath: "pages/p1.png", originalFileName: "p1.png",
      sha256: "a".repeat(64), byteSize: 10, mimeType: "image/png", copiedAt: "2026-10-29T00:00:00Z"
    }];
    opened.dialogueLines = [{
      id: "line-1", order: 1, pageNumber: 1, sourceLanguage: "ja", sourceText: "원문",
      dialogueType: "speech", origin: { kind: "manual" }, parseConfidence: 1, parseWarnings: []
    }];
    const mainConflict = { ...opened, metadata: { ...opened.metadata, title: "서버 제목" } };
    const applyProjectMutation = vi.fn().mockResolvedValue({
      status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
      project: dto(mainConflict, 2), conflictingPaths: ["metadata/title"]
    });
    const sourceBboxPx = { x: 100, y: 100, width: 200, height: 100 };
    const sourceQuadPx = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 200 }, { x: 100, y: 200 }];
    const extractSpeechBubbles = vi.fn().mockResolvedValue({
      pageNumber: 1, nonSpeechText: [], warnings: [],
      productionOcrContext: { runId: "ocr-run", pageImageId: "page-1", sourceSha256: "a".repeat(64) },
      speechBubbles: [{
        id: "ocr-1", type: "speech_bubble", text: "합성 OCR", language: "ja",
        bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, readingOrder: 1,
        confidence: 0.9, notes: "", speakerCandidates: [], orientation: "horizontal",
        productionOcrProvenance: {
          contractVersion: 1, detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId,
          detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision,
          recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId,
          recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision,
          groupId: "ocr-1", sourceDetectionIds: ["detection-1"], sourceDetectionScores: [0.93],
          sourceQuadsPx: [sourceQuadPx], orientation: "horizontal", confidenceSource: "detector_min",
          cropTransform: { sourceBboxPx, cropBboxPx: sourceBboxPx, paddingRatio: 0.08,
            rotationDegrees: 0, imageWidth: 1000, imageHeight: 1000 }
        }
      }]
    });
    const applyProductionOcrReview = vi.fn().mockResolvedValue({ projectSessionId: "opened", project: dto(mainConflict, 3, true) });
    vi.stubGlobal("projectApi", {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial", project: dto(initial, 0), encrypted: false }),
      openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "opened", project: dto(opened, 1), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
      saveProject: vi.fn(), saveProjectAs: vi.fn(), applyProjectMutation, extractSpeechBubbles, applyProductionOcrReview,
      resolvePageImageSrc: vi.fn().mockResolvedValue("app:///pages/p1.png")
    });
    render(<App />);
    const open = await screen.findByRole("button", { name: "기존 프로젝트 열기" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    const navigation = await screen.findByRole("navigation", { name: "작업 영역" });
    fireEvent.click(within(navigation).getByRole("button", { name: "설정" }));
    fireEvent.click(within(navigation).getByRole("button", { name: "수정" }));
    fireEvent.change(await screen.findByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("충돌"));
    const conflictNotice = screen.getByRole("status", { name: "작업 상태" }).textContent;
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
    const draft = await screen.findByLabelText("speech_bubble 1 원문");
    fireEvent.change(draft, { target: { value: "사용자 검토 초안" } });
    fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(applyProductionOcrReview).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(conflictNotice!);
    expect(screen.getByRole("region", { name: "1페이지 말풍선 OCR 검토" })).toBeInTheDocument();
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR 검토 닫기" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "작업 영역" })).getByRole("button", { name: "수정" }));
    fireEvent.click(await screen.findByRole("button", { name: "이전 단계" }));
    expect(await screen.findByLabelText("speech_bubble 1 원문")).toHaveValue("사용자 검토 초안");
  });

  it("keeps a title conflict locked through local edits until an approved new session opens", async () => {
    const initial = normalizeProject(createEmptyProject("초기", false));
    const opened = normalizeProject(createEmptyProject("A", false));
    opened.pageImages = [{
      id: "page-1", pageNumber: 1, storedRelativePath: "pages/p1.png", originalFileName: "p1.png",
      sha256: "a".repeat(64), byteSize: 10, mimeType: "image/png", copiedAt: "2026-10-29T00:00:00Z"
    }];
    opened.dialogueLines = [{
      id: "line-1", order: 1, pageNumber: 1, sourceLanguage: "ja", sourceText: "원문",
      dialogueType: "speech", origin: { kind: "manual" }, parseConfidence: 1, parseWarnings: []
    }];
    const mainConflict = { ...opened, metadata: { ...opened.metadata, title: "서버 제목" } };
    const reopened = { ...mainConflict, metadata: { ...mainConflict.metadata, title: "다시 연 프로젝트" } };
    const newEdit = { ...reopened, metadata: { ...reopened.metadata, title: "새 세션 편집" } };
    const applyProjectMutation = vi.fn()
      .mockResolvedValueOnce({ status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
        project: dto(mainConflict, 2), conflictingPaths: ["metadata/title"] })
      .mockResolvedValue({ status: "applied", revision: 4, project: dto(newEdit, 4, true) });
    const saveProject = vi.fn().mockResolvedValue({ projectSessionId: "reopened", project: dto(newEdit, 4) });
    const exportTranslations = vi.fn();
    const exportProjectImages = vi.fn();
    const openProjectFromDialog = vi.fn()
      .mockResolvedValueOnce({ projectSessionId: "opened", project: dto(opened, 1), encrypted: false })
      .mockResolvedValueOnce({ projectSessionId: "reopened", project: dto(reopened, 3), encrypted: false });
    vi.stubGlobal("projectApi", {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial", project: dto(initial, 0), encrypted: false }),
      openProjectFromDialog, openRecentProject: vi.fn(), unlockProject: vi.fn(),
      closeProject: vi.fn().mockResolvedValue(undefined), listRecentProjects: vi.fn().mockResolvedValue([]),
      importTxtFile: vi.fn(), exportTranslations, exportProjectImages, saveProject, saveProjectAs: vi.fn(), applyProjectMutation,
      resolvePageImageSrc: vi.fn().mockResolvedValue("app:///pages/p1.png")
    });
    render(<App />);
    const open = await screen.findByRole("button", { name: "기존 프로젝트 열기" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    const navigation = await screen.findByRole("navigation", { name: "작업 영역" });
    fireEvent.click(within(navigation).getByRole("button", { name: "설정" }));
    fireEvent.click(within(navigation).getByRole("button", { name: "수정" }));
    const title = await screen.findByLabelText("프로젝트 제목");
    const source = await screen.findByLabelText("원문 1");
    fireEvent.change(title, { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("충돌"));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    fireEvent.change(source, { target: { value: "C" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("충돌"));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    fireEvent.click(screen.getByRole("button", { name: "TXT 내보내기" }));
    fireEvent.click(screen.getByRole("button", { name: "전체 프로젝트 이미지 내보내기" }));
    await act(async () => { await Promise.resolve(); });
    expect(applyProjectMutation).toHaveBeenCalledOnce();
    expect(saveProject).not.toHaveBeenCalled();
    expect(exportTranslations).not.toHaveBeenCalled();
    expect(exportProjectImages).not.toHaveBeenCalled();
    expect(title).toHaveValue("B");
    expect(source).toHaveValue("C");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("미저장");

    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    const cancelDialog = await screen.findByRole("alertdialog");
    expect(cancelDialog).toHaveTextContent("저장하지 않은 프로젝트 변경사항");
    fireEvent.click(within(cancelDialog).getByRole("button", { name: "계속 편집" }));
    await waitFor(() => expect(cancelDialog).not.toBeInTheDocument());
    expect(title).toHaveValue("B");
    expect(source).toHaveValue("C");
    expect(openProjectFromDialog).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    const discardDialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(discardDialog).getByRole("button", { name: "버리고 이동" }));
    await waitFor(() => expect(openProjectFromDialog).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("다시 연 프로젝트"));
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "새 세션 편집" } });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(2));
    expect(applyProjectMutation).toHaveBeenLastCalledWith({
      projectSessionId: "reopened", baseRevision: 3, mutation: { type: "set_project_title", title: "새 세션 편집" }
    });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(saveProject).toHaveBeenCalledOnce());
  });

  it("keeps a failed title when a different line edit succeeds and then saves both", async () => {
    const initial = normalizeProject(createEmptyProject("초기", false));
    const opened = normalizeProject(createEmptyProject("A", false));
    opened.pageImages = [{
      id: "page-1", pageNumber: 1, storedRelativePath: "pages/p1.png", originalFileName: "p1.png",
      sha256: "a".repeat(64), byteSize: 10, mimeType: "image/png", copiedAt: "2026-10-29T00:00:00Z"
    }];
    opened.dialogueLines = [{
      id: "line-1", order: 1, pageNumber: 1, sourceLanguage: "ja", sourceText: "원문",
      dialogueType: "speech", origin: { kind: "manual" }, parseConfidence: 1, parseWarnings: []
    }];
    const mainC = { ...opened, dialogueLines: [{ ...opened.dialogueLines[0]!, sourceText: "C" }] };
    const bothEdits = { ...mainC, metadata: { ...mainC.metadata, title: "B" } };
    const applyProjectMutation = vi.fn()
      .mockRejectedValueOnce(new Error("fixture title failure"))
      .mockResolvedValueOnce({ status: "applied", revision: 2, project: dto(mainC, 2, true) })
      .mockResolvedValueOnce({ status: "applied", revision: 3, project: dto(bothEdits, 3, true) });
    const saveProject = vi.fn().mockResolvedValue({ projectSessionId: "opened", project: dto(bothEdits, 3) });
    vi.stubGlobal("projectApi", {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial", project: dto(initial, 0), encrypted: false }),
      openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "opened", project: dto(opened, 1), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
      saveProject, saveProjectAs: vi.fn(), applyProjectMutation,
      resolvePageImageSrc: vi.fn().mockResolvedValue("app:///pages/p1.png")
    });
    render(<App />);
    const open = await screen.findByRole("button", { name: "기존 프로젝트 열기" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    const navigation = await screen.findByRole("navigation", { name: "작업 영역" });
    fireEvent.click(within(navigation).getByRole("button", { name: "설정" }));
    fireEvent.click(within(navigation).getByRole("button", { name: "수정" }));
    const title = await screen.findByLabelText("프로젝트 제목");
    const source = await screen.findByLabelText("원문 1");
    fireEvent.change(title, { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("fixture title failure"));
    fireEvent.change(source, { target: { value: "C" } });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(source).toHaveValue("C"));
    expect(title).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(saveProject).toHaveBeenCalledOnce());
    expect(applyProjectMutation).toHaveBeenLastCalledWith({
      projectSessionId: "opened", baseRevision: 2, mutation: { type: "set_project_title", title: "B" }
    });
    expect(title).toHaveValue("B");
    expect(source).toHaveValue("C");
    await waitFor(() => expect(screen.getByText("저장하지 않은 변경사항이 없습니다.")).toBeInTheDocument());
  });

  it("keeps a later title edit while the failed edit is synced and saved", async () => {
    const initial = normalizeProject(createEmptyProject("초기", false));
    const opened = normalizeProject(createEmptyProject("A", false));
    opened.pageImages = [{
      id: "page-1", pageNumber: 1, storedRelativePath: "pages/p1.png", originalFileName: "p1.png",
      sha256: "a".repeat(64), byteSize: 10, mimeType: "image/png", copiedAt: "2026-10-29T00:00:00Z"
    }];
    const projectB = { ...opened, metadata: { ...opened.metadata, title: "B" } };
    const projectC = { ...opened, metadata: { ...opened.metadata, title: "C" } };
    const syncB = deferred<ProjectChangeResult>();
    const editC = deferred<ProjectChangeResult>();
    const saveB = deferred<ProjectSaveResult>();
    const applyProjectMutation = vi.fn().mockRejectedValueOnce(new Error("fixture mutation failure"))
      .mockReturnValueOnce(syncB.promise).mockReturnValueOnce(editC.promise);
    const saveProject = vi.fn().mockReturnValueOnce(saveB.promise)
      .mockResolvedValueOnce({ projectSessionId: "opened", project: dto(projectC, 3) });
    vi.stubGlobal("projectApi", {
      createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial", project: dto(initial, 0), encrypted: false }),
      openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "opened", project: dto(opened, 1), encrypted: false }),
      openRecentProject: vi.fn(), unlockProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
      listRecentProjects: vi.fn().mockResolvedValue([]), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
      saveProject, saveProjectAs: vi.fn(), applyProjectMutation,
      resolvePageImageSrc: vi.fn().mockResolvedValue("app:///pages/p1.png")
    });
    render(<App />);
    const open = await screen.findByRole("button", { name: "기존 프로젝트 열기" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    const navigation = await screen.findByRole("navigation", { name: "작업 영역" });
    fireEvent.click(within(navigation).getByRole("button", { name: "설정" }));
    const title = await screen.findByLabelText("프로젝트 제목");
    fireEvent.change(title, { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("fixture mutation failure"));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(2));
    fireEvent.change(title, { target: { value: "C" } });
    expect(title).toHaveValue("C");
    expect(applyProjectMutation).toHaveBeenCalledTimes(2);
    await act(async () => {
      syncB.resolve({ status: "applied", revision: 2, project: dto(projectB, 2, true) });
      await syncB.promise;
    });
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledTimes(3));
    expect(applyProjectMutation).toHaveBeenNthCalledWith(3, {
      projectSessionId: "opened", baseRevision: 2, mutation: { type: "set_project_title", title: "C" }
    });
    await waitFor(() => expect(saveProject).toHaveBeenCalledOnce());
    await act(async () => {
      saveB.resolve({ projectSessionId: "opened", project: dto(projectB, 2) });
      await saveB.promise;
    });
    expect(title).toHaveValue("C");
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("다시 저장");
    await act(async () => {
      editC.resolve({ status: "applied", revision: 3, project: dto(projectC, 3, true) });
      await editC.promise;
    });
    await waitFor(() => expect(title).toHaveValue("C"));
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("저장하지 않은 변경사항이 없습니다.")).toBeInTheDocument());
    expect(title).toHaveValue("C");
  });
});
