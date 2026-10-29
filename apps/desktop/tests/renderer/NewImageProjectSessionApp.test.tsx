import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/renderer/App";
import type { PreparedPageImageBatchDto, ProjectSessionResult } from "../../src/shared/projectSessionTypes";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function session(projectSessionId: string, title = "새 프로젝트"): ProjectSessionResult {
  return {
    projectSessionId,
    project: { project: normalizeProject(createEmptyProject(title, false)), revision: 0, pendingPageImages: [], dirty: false, status: "active" },
    encrypted: false
  };
}

function fixture() {
  const initial = session("startup");
  const saved = session("saved", "저장된 합성 프로젝트");
  saved.project.project.pageImages = [{ id: "page-1", pageNumber: 1, storedRelativePath: "pages/1.png", originalFileName: "1.png", sha256: "a".repeat(64), byteSize: 10, mimeType: "image/png", copiedAt: "2026-10-29T00:00:00Z" }];
  saved.project.project.dialogueLines = [{ id: "line-1", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "ja", sourceText: "합성 원문", userTranslation: "사용자 번역", lineStatus: "draft", parseConfidence: 1, parseWarnings: [], origin: { kind: "manual" } }];
  const setup = session("setup");
  const batch = {
    importBatchId: "setup-batch",
    images: [{ preparedImageId: "prepared-1", importBatchId: "setup-batch", originalFileName: "new.png", byteSize: 10, mimeType: "image/png" as const, previewToken: "setup-preview" }]
  };
  const api = {
    createProjectSession: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(setup),
    openProjectFromDialog: vi.fn().mockResolvedValue(saved), openRecentProject: vi.fn(), unlockProject: vi.fn(),
    closeProject: vi.fn().mockResolvedValue(undefined), listRecentProjects: vi.fn().mockResolvedValue([]),
    choosePageImages: vi.fn().mockResolvedValue(batch), preparePageImages: vi.fn().mockResolvedValue(batch),
    releasePageImageImportBatch: vi.fn().mockResolvedValue(undefined),
    applyProjectMutation: vi.fn(), importPageImages: vi.fn(), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
    saveProjectAs: vi.fn(),
    saveProject: vi.fn().mockResolvedValue({ projectSessionId: "saved", project: saved.project }),
    resolvePageImageSrc: vi.fn(async () => "app://synthetic/1.png")
  };
  return { initial, saved, setup, batch, api };
}

async function openSavedProject(data: ReturnType<typeof fixture>) {
  vi.stubGlobal("projectApi", data.api);
  const view = render(<App />);
  const open = screen.getByRole("button", { name: "기존 프로젝트 열기" });
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  await screen.findByRole("navigation", { name: "작업 영역" });
  await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "startup" }));
  data.api.closeProject.mockClear();
  return view;
}

async function visitHome() {
  fireEvent.click(screen.getByText("도구"));
  fireEvent.click(await screen.findByRole("button", { name: "작업실 홈" }));
  await screen.findByRole("button", { name: "새 번역 프로젝트" });
}

async function editBox(x: string) {
  if (screen.queryByRole("button", { name: "작업대로 돌아가기" })) {
    fireEvent.click(screen.getByRole("button", { name: "작업대로 돌아가기" }));
  }
  const navigation = await screen.findByRole("navigation", { name: "작업 영역" });
  if (!screen.queryByRole("group", { name: "수정 도구" })) {
    fireEvent.click(within(navigation).getByRole("button", { name: "수정" }));
  }
  fireEvent.click(await screen.findByRole("button", { name: "글자 배치" }));
  fireEvent.click(await screen.findByText("숫자로 정밀 조정"));
  fireEvent.change(await screen.findByRole("spinbutton", { name: "X (%)" }), { target: { value: x } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("저장된 프로젝트에서 새 이미지 프로젝트로 전환", () => {
  it("새 임시 세션을 준비하고 기존 세션을 닫은 뒤 그 소유권으로 이미지를 선택한다", async () => {
    const data = fixture();
    await openSavedProject(data);
    await visitHome();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    await screen.findByRole("heading", { name: "새 번역 프로젝트" });
    expect(data.api.choosePageImages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "이미지 선택" }));
    expect(await screen.findByRole("img", { name: "new.png" })).toBeVisible();
    expect(data.api.createProjectSession).toHaveBeenCalledTimes(2);
    expect(data.api.createProjectSession).toHaveBeenLastCalledWith({ title: "새 프로젝트", secret: false });
    expect(data.api.closeProject).toHaveBeenCalledExactlyOnceWith({ projectSessionId: "saved" });
    expect(data.api.createProjectSession.mock.invocationCallOrder[1]).toBeLessThan(data.api.closeProject.mock.invocationCallOrder[0]!);
    expect(data.api.choosePageImages).toHaveBeenCalledExactlyOnceWith({ projectSessionId: "setup" });
    expect(screen.queryByText("프로젝트 세션이 준비되지 않아 이미지를 선택할 수 없습니다.")).not.toBeInTheDocument();
  });

  it("처음 홈에서 시작할 때는 준비된 startup 세션을 그대로 사용한다", async () => {
    const data = fixture();
    vi.stubGlobal("projectApi", data.api);
    render(<App />);
    const start = screen.getByRole("button", { name: "새 번역 프로젝트" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    fireEvent.click(await screen.findByRole("button", { name: "이미지 선택" }));
    await screen.findByRole("img", { name: "new.png" });
    expect(data.api.createProjectSession).toHaveBeenCalledOnce();
    expect(data.api.closeProject).not.toHaveBeenCalled();
    expect(data.api.choosePageImages).toHaveBeenCalledWith({ projectSessionId: "startup" });
  });

  it("임시 세션 생성 실패 시 기존 프로젝트를 유지하고 다시 시도할 수 있다", async () => {
    const data = fixture();
    await openSavedProject(data);
    data.api.createProjectSession.mockRejectedValueOnce(new Error("synthetic create failure"));
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("새 프로젝트 세션을 준비하지 못했습니다"));
    expect(data.api.closeProject).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "새 번역 프로젝트" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(data.api.saveProject).toHaveBeenCalledWith({ projectSessionId: "saved" }));
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    await screen.findByRole("heading", { name: "새 번역 프로젝트" });
  });

  it("기존 세션 닫기 실패 시 새 임시 세션만 정리하고 기존 프로젝트를 유지한다", async () => {
    const data = fixture();
    await openSavedProject(data);
    data.api.closeProject.mockRejectedValueOnce(new Error("synthetic close failure"));
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("이전 프로젝트를 닫지 못해 새 프로젝트로 전환하지 못했습니다"));
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "setup" }));
    expect(screen.queryByRole("heading", { name: "새 번역 프로젝트" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(data.api.saveProject).toHaveBeenCalledWith({ projectSessionId: "saved" }));
  });

  it("임시 세션 rollback도 실패하면 다음 전환에서 누락 없이 정리를 재시도한다", async () => {
    const data = fixture();
    await openSavedProject(data);
    data.api.closeProject.mockRejectedValueOnce(new Error("synthetic saved close failure"))
      .mockRejectedValueOnce(new Error("synthetic rollback failure"));
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("새 프로젝트 세션을 정리하지 못했습니다"));
    expect(screen.queryByRole("heading", { name: "새 번역 프로젝트" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    await screen.findByRole("heading", { name: "새 번역 프로젝트" });
    expect(data.api.closeProject.mock.calls.map(([args]) => args.projectSessionId)).toEqual(["saved", "setup", "setup", "saved"]);
    expect(data.api.closeProject.mock.invocationCallOrder[2]).toBeLessThan(data.api.createProjectSession.mock.invocationCallOrder[2]!);
  });

  it("임시 세션을 기다리는 동안 중복 요청을 합치고 새로 쓴 글자 배치 초안을 보호한다", async () => {
    const data = fixture();
    const creating = deferred<ProjectSessionResult>();
    await openSavedProject(data);
    await visitHome();
    data.api.createProjectSession.mockReturnValueOnce(creating.promise);
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    await waitFor(() => expect(data.api.createProjectSession).toHaveBeenCalledTimes(2));
    expect(data.api.closeProject).not.toHaveBeenCalled();
    await editBox("12");
    await act(async () => { creating.resolve(data.setup); await creating.promise; });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledExactlyOnceWith({ projectSessionId: "setup" }));
    expect(screen.getByRole("spinbutton", { name: "X (%)" })).toHaveValue(12);
    expect(screen.queryByRole("heading", { name: "새 번역 프로젝트" })).not.toBeInTheDocument();
  });

  it("기존 초안 폐기를 거절하면 세션을 생성하거나 닫지 않는다", async () => {
    const data = fixture();
    await openSavedProject(data);
    await editBox("12");
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "계속 편집" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(data.api.createProjectSession).toHaveBeenCalledOnce();
    expect(data.api.closeProject).not.toHaveBeenCalled();
    expect(screen.getByRole("spinbutton", { name: "X (%)" })).toHaveValue(12);
  });

  it("폐기 승인 뒤 생성 대기 중 같은 초안이 수정되어도 그 새 내용은 버리지 않는다", async () => {
    const data = fixture();
    const creating = deferred<ProjectSessionResult>();
    await openSavedProject(data);
    await editBox("12");
    data.api.createProjectSession.mockReturnValueOnce(creating.promise);
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "버리고 이동" }));
    await waitFor(() => expect(data.api.createProjectSession).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole("spinbutton", { name: "X (%)" }), { target: { value: "23" } });
    await act(async () => { creating.resolve(data.setup); await creating.promise; });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledExactlyOnceWith({ projectSessionId: "setup" }));
    expect(screen.getByRole("spinbutton", { name: "X (%)" })).toHaveValue(23);
  });

  it("이미 닫는 중 새 초안이 생기면 화면에 보존하고 복구가 필요한 상태로 남긴다", async () => {
    const data = fixture();
    const closing = deferred<void>();
    await openSavedProject(data);
    await editBox("12");
    data.api.closeProject.mockReturnValueOnce(closing.promise);
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "버리고 이동" }));
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "saved" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "X (%)" }), { target: { value: "23" } });
    await act(async () => { closing.resolve(); await closing.promise; });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "setup" }));
    expect(screen.getByRole("spinbutton", { name: "X (%)" })).toHaveValue(23);
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("세션 복구가 필요합니다");
    expect(screen.queryByRole("heading", { name: "새 번역 프로젝트" })).not.toBeInTheDocument();
  });

  it("다른 프로젝트를 연 뒤 도착한 임시 세션은 현재 화면을 덮지 않고 닫는다", async () => {
    const data = fixture();
    const creating = deferred<ProjectSessionResult>();
    await openSavedProject(data);
    await visitHome();
    data.api.createProjectSession.mockReturnValueOnce(creating.promise);
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    await waitFor(() => expect(data.api.createProjectSession).toHaveBeenCalledTimes(2));
    data.api.openProjectFromDialog.mockResolvedValueOnce(session("other", "다른 프로젝트"));
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByRole("navigation", { name: "작업 영역" });
    await act(async () => { creating.resolve(data.setup); await creating.promise; });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "setup" }));
    expect(data.api.closeProject).not.toHaveBeenCalledWith({ projectSessionId: "other" });
    expect(screen.queryByRole("heading", { name: "새 번역 프로젝트" })).not.toBeInTheDocument();
    expect(screen.getAllByText("다른 프로젝트").length).toBeGreaterThan(0);
  });

  it("컴포넌트가 사라진 뒤 도착한 임시 세션도 닫는다", async () => {
    const data = fixture();
    const creating = deferred<ProjectSessionResult>();
    const view = await openSavedProject(data);
    data.api.createProjectSession.mockReturnValueOnce(creating.promise);
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    await waitFor(() => expect(data.api.createProjectSession).toHaveBeenCalledTimes(2));
    view.unmount();
    await act(async () => { creating.resolve(data.setup); await creating.promise; });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledExactlyOnceWith({ projectSessionId: "setup" }));
  });

  it("다른 프로젝트를 연 뒤 늦게 실패한 생성 요청은 현재 상태를 덮지 않는다", async () => {
    const data = fixture();
    const creating = deferred<ProjectSessionResult>();
    await openSavedProject(data);
    await visitHome();
    data.api.createProjectSession.mockReturnValueOnce(creating.promise);
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    await waitFor(() => expect(data.api.createProjectSession).toHaveBeenCalledTimes(2));
    data.api.openProjectFromDialog.mockResolvedValueOnce({ ...data.saved, projectSessionId: "other" });
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    await screen.findByRole("navigation", { name: "작업 영역" });
    const status = screen.getByRole("status", { name: "작업 상태" }).textContent;
    await act(async () => { creating.reject(new Error("synthetic late failure")); await creating.promise.catch(() => undefined); });
    expect(screen.getByRole("status", { name: "작업 상태" }).textContent).toBe(status);
    expect(data.api.closeProject).not.toHaveBeenCalledWith({ projectSessionId: "other" });
  });

  it.each(["picker", "drop"] as const)("setup 취소 후 늦은 %s 결과는 원래 임시 세션 소유권으로 해제한다", async (source) => {
    const data = fixture();
    const choosing = deferred<PreparedPageImageBatchDto | null>();
    await openSavedProject(data);
    await visitHome();
    fireEvent.click(screen.getByRole("button", { name: "새 번역 프로젝트" }));
    await screen.findByRole("heading", { name: "새 번역 프로젝트" });
    if (source === "picker") {
      data.api.choosePageImages.mockReturnValueOnce(choosing.promise);
      fireEvent.click(screen.getByRole("button", { name: "이미지 선택" }));
      await waitFor(() => expect(data.api.choosePageImages).toHaveBeenCalledWith({ projectSessionId: "setup" }));
    } else {
      data.api.preparePageImages.mockReturnValueOnce(choosing.promise);
      const files = [new File(["synthetic"], "new.png", { type: "image/png" })];
      fireEvent.drop(screen.getByTestId("project-image-drop-zone"), { dataTransfer: { files } });
      await waitFor(() => expect(data.api.preparePageImages).toHaveBeenCalledWith({ projectSessionId: "setup", files }));
    }
    data.api.createProjectSession.mockResolvedValueOnce(session("replacement"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(data.api.createProjectSession).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole("button", { name: "새 번역 프로젝트" })).toBeEnabled());
    await act(async () => { choosing.resolve(data.batch); await choosing.promise; });
    await waitFor(() => expect(data.api.releasePageImageImportBatch).toHaveBeenCalledExactlyOnceWith({ projectSessionId: "setup", importBatchId: "setup-batch" }));
    expect(screen.queryByRole("img", { name: "new.png" })).not.toBeInTheDocument();
  });
});
