import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/renderer/App";
import type { ProjectChangeResult, ProjectSessionResult } from "../../src/shared/projectSessionTypes";
import type { ExtractSpeechBubblesRequest, SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";
import { openWorkspacePanel } from "./workspaceTestActions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function session(id: string, title: string): ProjectSessionResult {
  return {
    projectSessionId: id,
    encrypted: false,
    project: { project: normalizeProject(createEmptyProject(title, false)), revision: 0, pendingPageImages: [], dirty: false, status: "active" }
  };
}

function fixture() {
  const startup = session("startup", "초기 프로젝트");
  const saved = session("saved", "저장된 프로젝트");
  saved.project.project.pageImages = [{ id: "page-1", pageNumber: 1, storedRelativePath: "pages/1.png", originalFileName: "1.png", sha256: "a".repeat(64), byteSize: 10, mimeType: "image/png", copiedAt: "2026-10-29T00:00:00Z" }];
  saved.project.project.dialogueLines = [{ id: "line-1", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "ja", sourceText: "저장된 원문", userTranslation: "저장된 번역", lineStatus: "draft", parseConfidence: 1, parseWarnings: [], origin: { kind: "manual" } }];
  saved.recentProject = { recentProjectId: "recent-saved", title: "저장된 프로젝트", openedAt: "2026-10-29T00:00:00Z" };
  const restored = session("restored", "복구된 프로젝트");
  restored.project.project.dialogueLines = [{ ...saved.project.project.dialogueLines[0]!, sourceText: "복구된 원문" }];
  const other = session("other", "다른 프로젝트");
  const setup = session("setup", "새 프로젝트");
  const extractSpeechBubbles = vi.fn(async (request: ExtractSpeechBubblesRequest): Promise<SpeechBubbleExtractionResult> => ({
    pageNumber: 1,
    speechBubbles: [{ id: "ocr-1", type: "speech_bubble", text: "합성 OCR 원문", language: "ja", bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, readingOrder: 1, confidence: 0.9, notes: "", speakerCandidates: [] }],
    nonSpeechText: [], warnings: [],
    productionOcrContext: { runId: request.requestId, pageImageId: request.pageImageId, sourceSha256: request.sourceSha256 }
  }));
  const api = {
    createProjectSession: vi.fn().mockResolvedValueOnce(startup).mockResolvedValue(setup),
    openProjectFromDialog: vi.fn().mockResolvedValueOnce(saved).mockResolvedValue(other),
    openRecentProject: vi.fn().mockResolvedValue(restored), unlockProject: vi.fn(),
    closeProject: vi.fn().mockResolvedValue(undefined), listRecentProjects: vi.fn().mockResolvedValue([]),
    applyProjectMutation: vi.fn(), extractSpeechBubbles,
    importPageImages: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
    saveProject: vi.fn(), saveProjectAs: vi.fn(),
    resolvePageImageSrc: vi.fn().mockResolvedValue("app://synthetic/1.png")
  };
  return { saved, restored, other, setup, api };
}

async function openSaved(data: ReturnType<typeof fixture>) {
  vi.stubGlobal("projectApi", data.api);
  render(<App />);
  const open = screen.getByRole("button", { name: "기존 프로젝트 열기" });
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  await openWorkspacePanel("수정");
  await screen.findByLabelText("원문 1");
  await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "startup" }));
  data.api.closeProject.mockClear();
}

async function approveDiscard() {
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "버리고 이동" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
}

async function prepareOcrDraft() {
  fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
  const field = await screen.findByLabelText("speech_bubble 1 원문");
  fireEvent.change(field, { target: { value: "승인 전 OCR 초안" } });
  expect(field).toHaveValue("승인 전 OCR 초안");
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("프로젝트 전환 중 사용자 편집과 OCR 초안 보호", () => {
  it("닫기 대기 중 수정한 대사는 복구 재열기에서 폐기를 확인하기 전까지 보존한다", async () => {
    const data = fixture();
    const closing = deferred<void>();
    const mutation = deferred<ProjectChangeResult>();
    await openSaved(data);
    data.api.closeProject.mockReturnValueOnce(closing.promise);
    data.api.applyProjectMutation.mockReturnValue(mutation.promise);
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "saved" }));
    fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "닫는 동안 수정한 원문" } });
    await waitFor(() => expect(screen.getByLabelText("원문 1")).toHaveValue("닫는 동안 수정한 원문"));
    await act(async () => { closing.resolve(); await closing.promise; });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("세션 복구가 필요합니다"));
    expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "setup" });

    fireEvent.click(screen.getByRole("button", { name: "세션 복구하기" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("저장하지 않은 프로젝트 변경사항");
    expect(data.api.openRecentProject).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "계속 편집" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(screen.getByLabelText("원문 1")).toHaveValue("닫는 동안 수정한 원문");
    expect(data.api.openRecentProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "세션 복구하기" }));
    await approveDiscard();
    await waitFor(() => expect(data.api.openRecentProject).toHaveBeenCalledExactlyOnceWith({ recentProjectId: "recent-saved" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("원문 1")).toHaveValue("복구된 원문");
  });

  it("OCR 초안 폐기 승인 뒤 다른 프로젝트가 열리는 동안 수정한 내용은 보존한다", async () => {
    const data = fixture();
    const opening = deferred<ProjectSessionResult>();
    await openSaved(data);
    await prepareOcrDraft();
    data.api.openProjectFromDialog.mockReturnValueOnce(opening.promise);
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await approveDiscard();
    await waitFor(() => expect(data.api.openProjectFromDialog).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText("speech_bubble 1 원문"), { target: { value: "열기 대기 중 수정한 OCR" } });
    await act(async () => { opening.resolve(data.other); await opening.promise; });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "other" }));
    expect(data.api.closeProject).not.toHaveBeenCalledWith({ projectSessionId: "saved" });
    expect(screen.getByLabelText("speech_bubble 1 원문")).toHaveValue("열기 대기 중 수정한 OCR");
    expect(screen.queryByText("다른 프로젝트")).not.toBeInTheDocument();
  });

  it("열기 대기 중 OCR 검토 단계가 바뀌면 승인 이후의 작업을 보존한다", async () => {
    const data = fixture();
    const opening = deferred<ProjectSessionResult>();
    await openSaved(data);
    await prepareOcrDraft();
    data.api.openProjectFromDialog.mockReturnValueOnce(opening.promise);
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await approveDiscard();
    await waitFor(() => expect(data.api.openProjectFromDialog).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));
    expect(await screen.findByRole("heading", { name: "화자 검토" })).toBeVisible();
    await act(async () => { opening.resolve(data.other); await opening.promise; });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "other" }));
    expect(data.api.closeProject).not.toHaveBeenCalledWith({ projectSessionId: "saved" });
    expect(screen.getByRole("heading", { name: "화자 검토" })).toBeVisible();
  });

  it("열기 대기 중 변경 없이 OCR 검토를 다시 열면 승인된 전환을 계속한다", async () => {
    const data = fixture();
    const opening = deferred<ProjectSessionResult>();
    await openSaved(data);
    await prepareOcrDraft();
    data.api.openProjectFromDialog.mockReturnValueOnce(opening.promise);
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await approveDiscard();
    await waitFor(() => expect(data.api.openProjectFromDialog).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR 검토 닫기" }));
    await openWorkspacePanel("수정");
    expect(await screen.findByLabelText("speech_bubble 1 원문")).toHaveValue("승인 전 OCR 초안");
    await act(async () => { opening.resolve(data.other); await opening.promise; });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "saved" }));
    expect(data.api.closeProject).not.toHaveBeenCalledWith({ projectSessionId: "other" });
    expect((await screen.findAllByText("다른 프로젝트")).length).toBeGreaterThan(0);
  });

  it("OCR 초안 폐기 승인 뒤 기존 세션이 닫히는 동안 수정한 내용은 복구 상태로 보존한다", async () => {
    const data = fixture();
    const closing = deferred<void>();
    await openSaved(data);
    await prepareOcrDraft();
    data.api.closeProject.mockReturnValueOnce(closing.promise);
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await approveDiscard();
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "saved" }));
    fireEvent.change(screen.getByLabelText("speech_bubble 1 원문"), { target: { value: "닫기 대기 중 수정한 OCR" } });
    await act(async () => { closing.resolve(); await closing.promise; });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "other" }));
    expect(screen.getByLabelText("speech_bubble 1 원문")).toHaveValue("닫기 대기 중 수정한 OCR");
    expect(screen.getByRole("alert")).toHaveTextContent("세션 복구가 필요합니다");
    fireEvent.click(screen.getByRole("button", { name: "세션 복구하기" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("미적용 OCR 검토 초안");
    fireEvent.click(within(dialog).getByRole("button", { name: "계속 편집" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(screen.getByLabelText("speech_bubble 1 원문")).toHaveValue("닫기 대기 중 수정한 OCR");
    expect(data.api.openRecentProject).not.toHaveBeenCalled();
  });
});
