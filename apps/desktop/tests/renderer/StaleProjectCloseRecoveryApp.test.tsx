import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/renderer/App";
import type { ProjectChangeResult, ProjectSessionResult } from "../../src/shared/projectSessionTypes";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";
import { openWorkspacePanel } from "./workspaceTestActions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function session(projectSessionId: string, title: string, sourceText?: string): ProjectSessionResult {
  const project = normalizeProject(createEmptyProject(title, false));
  if (sourceText) {
    project.dialogueLines = [{ id: "line-1", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "ja", sourceText, userTranslation: "합성 번역", lineStatus: "draft", parseConfidence: 1, parseWarnings: [], origin: { kind: "manual" } }];
  }
  return { projectSessionId, encrypted: false, project: { project, revision: 0, pendingPageImages: [], dirty: false, status: "active" } };
}

function fixture() {
  const startup = session("startup", "초기 세션");
  const saved = session("saved", "기존 프로젝트", "기존 원문");
  const setup = session("setup", "새 프로젝트");
  const closing = deferred<void>();
  const live = new Map<string, ProjectSessionResult>();
  const install = (result: ProjectSessionResult) => { live.set(result.projectSessionId, result); return result; };
  let savedClosePending = true;
  const closeProject = vi.fn(async ({ projectSessionId }: { projectSessionId: string }) => {
    const owner = live.get(projectSessionId);
    if (projectSessionId === "saved" && savedClosePending) {
      savedClosePending = false;
      await closing.promise;
    }
    if (live.get(projectSessionId) === owner) live.delete(projectSessionId);
  });
  const api = {
    createProjectSession: vi.fn().mockImplementationOnce(async () => install(startup)).mockImplementation(async () => install(setup)),
    openProjectFromDialog: vi.fn<() => Promise<ProjectSessionResult | null>>()
      .mockImplementationOnce(async () => install(saved)).mockResolvedValue(null),
    openRecentProject: vi.fn(), unlockProject: vi.fn(), closeProject,
    listRecentProjects: vi.fn().mockResolvedValue([]), applyProjectMutation: vi.fn(),
    importTxtFile: vi.fn(), exportTranslations: vi.fn(), saveProjectAs: vi.fn(),
    saveProject: vi.fn(async ({ projectSessionId }: { projectSessionId: string }) => {
      const current = live.get(projectSessionId);
      if (!current) throw new Error("synthetic session is closed");
      return { projectSessionId, project: current.project };
    })
  };
  return { api, live, closing, install };
}

async function openSaved(data: ReturnType<typeof fixture>) {
  vi.stubGlobal("projectApi", data.api);
  const view = render(<App />);
  const open = screen.getByRole("button", { name: "기존 프로젝트 열기" });
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  await openWorkspacePanel("수정");
  expect(await screen.findByLabelText("원문 1")).toHaveValue("기존 원문");
  await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "startup" }));
  data.api.closeProject.mockClear();
  return view;
}

async function startClosing(data: ReturnType<typeof fixture>) {
  fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
  await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "saved" }));
  expect(data.live.has("saved")).toBe(true);
}

async function cancelOpen(data: ReturnType<typeof fixture>) {
  fireEvent.click(screen.getByRole("button", { name: "열기" }));
  await waitFor(() => expect(data.api.openProjectFromDialog).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("열기를 취소했습니다"));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("오래된 프로젝트 세션 닫기 완료", () => {
  it.each([false, true])("파일 선택을 취소하면 닫힌 기존 세션을 복구 상태로 유지한다 (새 편집: %s)", async (edit) => {
    const data = fixture();
    await openSaved(data);
    await startClosing(data);
    await cancelOpen(data);
    const mutation = edit ? deferred<ProjectChangeResult>() : null;
    const staleProject = structuredClone(data.live.get("saved")!.project);
    if (edit) {
      data.api.applyProjectMutation.mockReturnValue(mutation!.promise);
      fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "닫기 중 사용자 편집" } });
      expect(screen.getByLabelText("원문 1")).toHaveValue("닫기 중 사용자 편집");
      await waitFor(() => expect(data.api.applyProjectMutation).toHaveBeenCalledOnce());
    }
    await act(async () => { data.closing.resolve(); await data.closing.promise; });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "setup" }));
    expect(data.live.has("saved")).toBe(false);
    expect(data.live.has("setup")).toBe(false);
    expect(await screen.findByRole("alert")).toHaveTextContent("세션 복구가 필요합니다");
    expect(screen.getByLabelText("원문 1")).toHaveValue(edit ? "닫기 중 사용자 편집" : "기존 원문");
    expect(screen.getByLabelText("원문 1")).toHaveAttribute("readOnly");
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    if (mutation) {
      staleProject.project.dialogueLines[0]!.sourceText = "늦은 결과의 원문";
      await act(async () => {
        mutation.resolve({ status: "applied", revision: 1, project: { ...staleProject, revision: 1 } });
        await mutation.promise;
      });
      expect(screen.getByLabelText("원문 1")).toHaveValue("닫기 중 사용자 편집");
      expect(screen.getByRole("alert")).toHaveTextContent("세션 복구가 필요합니다");
      expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    }
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(data.api.saveProject).not.toHaveBeenCalled();
  });

  it.each(["replacement", "saved"])("%s ID의 새 세션으로 이미 교체됐다면 복구 상태로 잘못 바꾸지 않는다", async (sessionId) => {
    const data = fixture();
    await openSaved(data);
    await startClosing(data);
    const replacement = session(sessionId, "교체된 프로젝트", "교체된 원문");
    data.api.openProjectFromDialog.mockImplementationOnce(async () => data.install(replacement));
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await openWorkspacePanel("수정");
    await waitFor(() => expect(screen.getByLabelText("원문 1")).toHaveValue("교체된 원문"));
    await act(async () => { data.closing.resolve(); await data.closing.promise; });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "setup" }));
    expect(data.live.get(sessionId)).toBe(replacement);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(data.api.saveProject).toHaveBeenCalledWith({ projectSessionId: sessionId }));
  });

  it("같은 기존 세션에서 수정 충돌로 큐 세대가 바뀌어도 닫힌 세션을 복구 상태로 전환한다", async () => {
    const data = fixture();
    await openSaved(data);
    await startClosing(data);
    await cancelOpen(data);
    const current = structuredClone(data.live.get("saved")!.project);
    current.project.dialogueLines[0]!.sourceText = "충돌 후 보존된 원문";
    data.api.applyProjectMutation.mockResolvedValueOnce({
      status: "revision_conflict", code: "REVISION_CONFLICT", revision: 1,
      project: { ...current, revision: 1, dirty: true }, conflictingPaths: ["dialogueLines"]
    });
    fireEvent.change(screen.getByLabelText("원문 1"), { target: { value: "충돌 후 보존된 원문" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("다른 변경과 충돌했습니다"));
    await act(async () => { data.closing.resolve(); await data.closing.promise; });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "setup" }));
    expect(data.live.has("saved")).toBe(false);
    expect(await screen.findByRole("alert")).toHaveTextContent("세션 복구가 필요합니다");
    expect(screen.getByLabelText("원문 1")).toHaveValue("충돌 후 보존된 원문");
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  });

  it("취소 후 기존 세션 닫기가 실패하면 살아 있는 세션에 복구 상태를 적용하지 않는다", async () => {
    const data = fixture();
    await openSaved(data);
    await startClosing(data);
    await cancelOpen(data);
    await act(async () => { data.closing.reject(new Error("synthetic close failure")); await data.closing.promise.catch(() => undefined); });
    await waitFor(() => expect(data.api.closeProject).toHaveBeenCalledWith({ projectSessionId: "setup" }));
    expect(data.live.has("saved")).toBe(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(data.api.saveProject).toHaveBeenCalledWith({ projectSessionId: "saved" }));
  });
});
