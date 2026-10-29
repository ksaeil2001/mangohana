import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/renderer/App";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";
import type { TranslationProjectV2 } from "../../src/shared/projectTypes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function fixture(withLine: boolean) {
  const initial = normalizeProject(createEmptyProject("초기", false));
  const opened = normalizeProject(createEmptyProject("예시", false));
  opened.pageImages = [{ id: "page-1", pageNumber: 1, storedRelativePath: "pages/p1.png", originalFileName: "p1.png", sha256: "a".repeat(64), byteSize: 10, mimeType: "image/png", copiedAt: "2026-10-29T00:00:00Z" }];
  if (withLine) opened.dialogueLines = [{ id: "line-1", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "ja", sourceText: "원문", userTranslation: "번역", lineStatus: "draft", parseConfidence: 1, parseWarnings: [], origin: { kind: "manual" } }];
  const dto = (project: TranslationProjectV2, revision: number, dirty = false) => ({ project, revision, pendingPageImages: [], dirty, status: "active" as const });
  return { initial, opened, dto };
}

async function openWorkspace(api: Record<string, unknown>) {
  vi.stubGlobal("projectApi", api);
  render(<App />);
  const open = await screen.findByRole("button", { name: "기존 프로젝트 열기" });
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  const navigation = await screen.findByRole("navigation", { name: "작업 영역" });
  fireEvent.click(within(navigation).getByRole("button", { name: "수정" }));
  await screen.findByRole("group", { name: "수정 도구" });
}

function apiBase(data: ReturnType<typeof fixture>) {
  return {
    createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial", project: data.dto(data.initial, 0), encrypted: false }),
    openProjectFromDialog: vi.fn().mockResolvedValue({ projectSessionId: "opened", project: data.dto(data.opened, 1), encrypted: false }),
    openRecentProject: vi.fn(), unlockProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
    listRecentProjects: vi.fn().mockResolvedValue([]), importTxtFile: vi.fn(), exportTranslations: vi.fn(), saveProject: vi.fn(),
    resolvePageImageSrc: vi.fn(async ({ storedRelativePath }: { storedRelativePath: string }) => `app:///${storedRelativePath}`)
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("수동 식자 초안 보호", () => {
  it("preserves incomplete coordinates when Main replaces a newly created line's temporary ID", async () => {
    const data = fixture(false);
    const created = deferred<{ status: "applied"; revision: number; project: ReturnType<typeof data.dto> }>();
    const applyProjectMutation = vi.fn().mockReturnValue(created.promise);
    await openWorkspace({ ...apiBase(data), applyProjectMutation });
    fireEvent.click(await screen.findByRole("button", { name: "수동 대사 추가" }));
    fireEvent.change(screen.getByLabelText("수동 대사 원문"), { target: { value: "수동 원문" } });
    fireEvent.click(screen.getByRole("button", { name: "대사 만들기" }));
    await waitFor(() => expect(applyProjectMutation).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "글자 배치" }));
    fireEvent.click(await screen.findByText("숫자로 정밀 조정"));
    fireEvent.change(await screen.findByRole("spinbutton", { name: "X (%)" }), { target: { value: "12" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Y (%)" }), { target: { value: "23" } });

    const persisted = structuredClone(data.opened);
    persisted.dialogueLines = [{ id: "main-line-1", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "unknown", sourceText: "수동 원문", lineStatus: "untranslated", parseConfidence: 1, parseWarnings: [], origin: { kind: "manual" } }];
    await act(async () => { created.resolve({ status: "applied", revision: 2, project: data.dto(persisted, 2, true) }); await created.promise; });
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "X (%)" })).toHaveValue(12));
    expect(screen.getByRole("spinbutton", { name: "Y (%)" })).toHaveValue(23);
    expect(screen.getByRole("button", { name: "영역 적용" })).toBeDisabled();
  });

  it("locks draft editing while the selected page is being reconnected", async () => {
    const data = fixture(true);
    const importing = deferred<Array<{ ok: true; pendingPageImage: { pageNumber: number } }>>();
    const choosePageImages = vi.fn().mockResolvedValue({ importBatchId: "batch", images: [{ preparedImageId: "prepared", importBatchId: "batch", originalFileName: "new.png", byteSize: 10, mimeType: "image/png", previewToken: "preview" }] });
    const importPageImages = vi.fn().mockReturnValue(importing.promise);
    await openWorkspace({ ...apiBase(data), choosePageImages, importPageImages, releasePageImageImportBatch: vi.fn(), applyProjectMutation: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "글자 배치" }));
    fireEvent.click(await screen.findByText("숫자로 정밀 조정"));
    const x = await screen.findByRole("spinbutton", { name: "X (%)" });
    fireEvent.click(screen.getByRole("button", { name: "다시 연결" }));
    await waitFor(() => expect(importPageImages).toHaveBeenCalledOnce());
    expect(x).toBeDisabled();
    fireEvent.change(x, { target: { value: "25" } });
    expect(x).toHaveValue(null);
    await act(async () => { importing.resolve([{ ok: true, pendingPageImage: { pageNumber: 1 } }]); await importing.promise; });
    expect(screen.queryByText(/미적용 초안 1개/)).not.toBeInTheDocument();
  });
});

describe("합성 예시 프로젝트 열기", () => {
  it("홈에서 예시를 열고 기존 시작 세션을 닫는다", async () => {
    const data = fixture(true);
    const base = apiBase(data);
    const openExampleProject = vi.fn().mockResolvedValue({
      projectSessionId: "example", project: data.dto(data.opened, 1), encrypted: false
    });
    vi.stubGlobal("projectApi", { ...base, openExampleProject });
    render(<App />);
    const button = await screen.findByRole("button", { name: "예시 프로젝트 열기" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByRole("navigation", { name: "작업 영역" });
    expect(openExampleProject).toHaveBeenCalledOnce();
    expect(base.closeProject).toHaveBeenCalledWith({ projectSessionId: "initial" });
  });

  it("예시를 여는 도중 새로 작성한 초안은 폐기하지 않고 전환을 취소한다", async () => {
    const data = fixture(true);
    const base = apiBase(data);
    const opening = deferred<{ projectSessionId: string; project: ReturnType<typeof data.dto>; encrypted: boolean }>();
    const openExampleProject = vi.fn().mockReturnValue(opening.promise);
    await openWorkspace({ ...base, openExampleProject, applyProjectMutation: vi.fn() });
    fireEvent.click(screen.getByText("도구"));
    fireEvent.click(screen.getByRole("button", { name: "작업실 홈" }));
    fireEvent.click(await screen.findByRole("button", { name: "예시 프로젝트 열기" }));
    await waitFor(() => expect(openExampleProject).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "작업대로 돌아가기" }));
    const navigation = await screen.findByRole("navigation", { name: "작업 영역" });
    if (!screen.queryByRole("group", { name: "수정 도구" })) {
      fireEvent.click(within(navigation).getByRole("button", { name: "수정" }));
    }
    fireEvent.click(await screen.findByRole("button", { name: "글자 배치" }));
    fireEvent.click(await screen.findByText("숫자로 정밀 조정"));
    fireEvent.change(await screen.findByRole("spinbutton", { name: "X (%)" }), { target: { value: "12" } });
    await act(async () => {
      opening.resolve({ projectSessionId: "example", project: data.dto(data.opened, 1), encrypted: false });
      await opening.promise;
    });
    await waitFor(() => expect(base.closeProject).toHaveBeenCalledWith({ projectSessionId: "example" }));
    expect(base.closeProject).not.toHaveBeenCalledWith({ projectSessionId: "opened" });
    expect(screen.getByRole("spinbutton", { name: "X (%)" })).toHaveValue(12);
    expect(screen.getAllByText(/미적용 초안/).length).toBeGreaterThan(0);
  });

  it.each(["example", "project"] as const)("%s 전환 중 이전 세션을 닫는 동안 생긴 초안을 보존한다", async (mode) => {
    const data = fixture(true);
    const base = apiBase(data);
    const closing = deferred<void>();
    base.closeProject.mockImplementation(({ projectSessionId }: { projectSessionId: string }) =>
      projectSessionId === "opened" ? closing.promise : Promise.resolve());
    const nextSession = { projectSessionId: "next", project: data.dto(data.opened, 1), encrypted: false };
    base.openProjectFromDialog.mockResolvedValueOnce({ projectSessionId: "opened", project: data.dto(data.opened, 1), encrypted: false })
      .mockResolvedValueOnce(nextSession);
    const openExampleProject = vi.fn().mockResolvedValue(nextSession);
    await openWorkspace({ ...base, openExampleProject, applyProjectMutation: vi.fn() });
    fireEvent.click(screen.getByText("도구"));
    fireEvent.click(screen.getByRole("button", { name: "작업실 홈" }));
    fireEvent.click(await screen.findByRole("button", {
      name: mode === "example" ? "예시 프로젝트 열기" : "기존 프로젝트 열기"
    }));
    await waitFor(() => expect(base.closeProject).toHaveBeenCalledWith({ projectSessionId: "opened" }));
    fireEvent.click(screen.getByRole("button", { name: "작업대로 돌아가기" }));
    const navigation = await screen.findByRole("navigation", { name: "작업 영역" });
    if (!screen.queryByRole("group", { name: "수정 도구" })) {
      fireEvent.click(within(navigation).getByRole("button", { name: "수정" }));
    }
    fireEvent.click(await screen.findByRole("button", { name: "글자 배치" }));
    fireEvent.click(await screen.findByText("숫자로 정밀 조정"));
    fireEvent.change(await screen.findByRole("spinbutton", { name: "X (%)" }), { target: { value: "24" } });
    await act(async () => { closing.resolve(); await closing.promise; });
    await waitFor(() => expect(base.closeProject).toHaveBeenCalledWith({ projectSessionId: "next" }));
    expect(screen.getByRole("spinbutton", { name: "X (%)" })).toHaveValue(24);
    expect(screen.getAllByText(/미적용 초안/).length).toBeGreaterThan(0);
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(/복구/);
  });
});
