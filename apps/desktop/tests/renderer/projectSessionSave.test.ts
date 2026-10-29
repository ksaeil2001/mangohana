import { useRef, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditableTranslationProject, TranslationProjectV2 } from "../../src/shared/projectTypes.js";
import type { ProjectChangeResult, ProjectSaveResult, TranslationProjectDto } from "../../src/shared/projectSessionTypes.js";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation.js";
import type { RecentProject } from "../../src/renderer/recentProjects.js";
import { useProjectSaveWorkflow } from "../../src/renderer/useProjectSaveWorkflow.js";
import { useSessionMutationQueue } from "../../src/renderer/useSessionMutationQueue.js";

afterEach(() => { Reflect.deleteProperty(window, "projectApi"); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function dto(project: TranslationProjectV2, revision: number, dirty: boolean): TranslationProjectDto {
  return { project, revision, dirty, pendingPageImages: [], status: "active" };
}

function createHarness(secret = false) {
  const initialProject = normalizeProject(createEmptyProject("저장 경합 검증", secret));
  initialProject.dialogueLines = [{
    id: "line-1", order: 1, pageNumber: 1, sourceLanguage: "ja", sourceText: "原文",
    userTranslation: "저장 요청 시점 번역", dialogueType: "speech", origin: { kind: "manual" },
    parseConfidence: 1, parseWarnings: []
  }];
  const save = deferred<ProjectSaveResult | null>();
  const saveProject = vi.fn().mockReturnValue(save.promise);
  const saveProjectAs = vi.fn().mockReturnValue(save.promise);
  const applyProjectMutation = vi.fn();
  const observedDtos = vi.fn();
  window.projectApi = { saveProject, saveProjectAs, applyProjectMutation } as never;

  const hook = renderHook(() => {
    const [project, updateProject] = useState<EditableTranslationProject>(initialProject);
    const projectRef = useRef(project);
    const [revision, setProjectRevision] = useState(1);
    const projectRevisionRef = useRef(1);
    const projectSessionIdRef = useRef<string | null>("session-save");
    const [pendingPageNumbers, setPendingPageNumbers] = useState<number[]>([]);
    const [dirty, setIsDirty] = useState(true);
    const [statusMessage, setStatusMessage] = useState("");
    const [sessionStatus, setSessionStatus] = useState<TranslationProjectDto["status"]>("active");
    const sessionStatusRef = useRef(sessionStatus);
    const [currentFilePath, setCurrentFilePath] = useState<string | null>("session:session-save");
    const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
    const selectedLineIdRef = useRef<string | null>("line-1");
    const initialSessionPromiseRef = useRef(null);
    function setProject(next: EditableTranslationProject) {
      projectRef.current = next;
      updateProject(next);
    }
    function onProjectDto(next: TranslationProjectDto) {
      observedDtos(next);
      sessionStatusRef.current = next.status;
      setSessionStatus(next.status);
      if (next.status === "needs_recovery") setStatusMessage("세션 복구가 필요합니다.");
    }
    const queue = useSessionMutationQueue({
      projectSessionIdRef, projectRevisionRef, setProjectRevision, projectRef, setProject,
      selectedLineIdRef, setSelectedLineId: vi.fn(), setPendingPageNumbers, setIsDirty,
      setStatusMessage, sessionStatusRef, onProjectDto
    });
    if (!queue.sessionProjectRef.current) queue.sessionProjectRef.current = initialProject;
    const workflow = useProjectSaveWorkflow({
      project, setProject, projectRef, currentFilePath, setCurrentFilePath, projectSessionIdRef,
      projectRevisionRef, setProjectRevision, setPendingPageNumbers, initialSessionPromiseRef,
      sessionPersistenceRequired: true, setIsDirty, setStatusMessage, setRecentProjects,
      requestPassword: vi.fn().mockResolvedValue(null), sessionStatusRef, onProjectDto,
      sessionGenerationRef: queue.sessionGenerationRef, sessionProjectRef: queue.sessionProjectRef,
      sessionConflictRef: queue.sessionConflictRef, drainSessionMutationQueue: queue.drainSessionMutationQueue,
      syncProjectToSession: queue.syncProjectToSession
    });
    function editTranslation(value: string, queued = true) {
      setProject({
        ...projectRef.current,
        dialogueLines: projectRef.current.dialogueLines.map((line) => ({ ...line, userTranslation: value }))
      });
      setIsDirty(true);
      if (queued) queue.queueSessionMutation({
        type: "update_dialogue_line", lineId: "line-1", patch: { userTranslation: value }
      });
    }
    return {
      project, projectRef, revision, projectRevisionRef, dirty, pendingPageNumbers,
      statusMessage, sessionStatus, sessionStatusRef, currentFilePath, recentProjects,
      workflow, queue, editTranslation
    };
  });
  return { ...hook, initialProject, save, saveProject, saveProjectAs, applyProjectMutation, observedDtos };
}

async function startSave(harness: ReturnType<typeof createHarness>, method: "saveProject" | "saveProjectAs" = "saveProject") {
  let saving!: Promise<void>;
  act(() => { saving = harness.result.current.workflow[method](); });
  await waitFor(() => expect(harness[method]).toHaveBeenCalledOnce());
  return { saving };
}

describe("session save response ordering", () => {
  it.each(["saveProject", "saveProjectAs"] as const)("preserves a newer mutation revision after a late %s response", async (method) => {
    const harness = createHarness();
    const { saving } = await startSave(harness, method);
    const mutation = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(mutation.promise);
    act(() => { harness.result.current.editTranslation("저장 요청 이후 사용자 번역"); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    const latestProject = harness.result.current.project as TranslationProjectV2;
    const latestDto = dto(latestProject, 2, true);
    latestDto.pendingPageImages = [{
      importBatchId: "import-2", preparedImageId: "prepared-2", pageImageId: "page-2", pageNumber: 2,
      originalFileName: "fixture.png", byteSize: 1, mimeType: "image/png", previewToken: "fixture-preview"
    }];
    await act(async () => {
      mutation.resolve({ status: "applied", revision: 2, project: latestDto });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.revision).toBe(2);
    const recentProject = { recentProjectId: "recent-save", title: "저장 경합 검증", openedAt: "2026-10-29T00:00:00.000Z" };
    await act(async () => {
      harness.save.resolve({ projectSessionId: "session-save", project: dto(harness.initialProject, 1, false), recentProject });
      await saving;
    });

    expect(harness.result.current.project.dialogueLines[0]!.userTranslation).toBe("저장 요청 이후 사용자 번역");
    expect(harness.result.current.projectRef.current).toBe(latestProject);
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(latestProject);
    expect(harness.result.current.revision).toBe(2);
    expect(harness.result.current.projectRevisionRef.current).toBe(2);
    expect(harness.result.current.pendingPageNumbers).toEqual([2]);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.statusMessage).toMatch(/저장.*다시 저장/);
    expect(harness.result.current.recentProjects).toEqual([recentProject]);
    expect(harness.observedDtos).toHaveBeenCalledTimes(1);
    expect(harness.result.current.workflow.saveInFlightRef.current).toBe(false);

    // A later edit must use revision 2, not the revision of the old save response.
    harness.applyProjectMutation.mockImplementationOnce((args) => ({
      status: "applied", revision: 3, project: dto({
        ...latestProject, dialogueLines: latestProject.dialogueLines.map((line) => ({ ...line, ...args.mutation.patch }))
      }, 3, true)
    }));
    act(() => { harness.result.current.editTranslation("계속 편집한 번역"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.applyProjectMutation).toHaveBeenLastCalledWith({
      projectSessionId: "session-save", baseRevision: 2,
      mutation: { type: "update_dialogue_line", lineId: "line-1", patch: { userTranslation: "계속 편집한 번역" } }
    });
    const finalProject = harness.result.current.project as TranslationProjectV2;
    harness.saveProject.mockResolvedValueOnce({ projectSessionId: "session-save", project: dto(finalProject, 3, false) });
    await act(async () => { await harness.result.current.workflow.saveProject(); });
    expect(harness.result.current.project.dialogueLines[0]!.userTranslation).toBe("계속 편집한 번역");
    expect(harness.result.current.dirty).toBe(false);
    expect(harness.result.current.statusMessage).toBe("프로젝트를 저장했습니다.");
  });

  it.each([true, false])("preserves local edits at the same revision while a mutation is queued: %s", async (queued) => {
    const harness = createHarness();
    const { saving } = await startSave(harness);
    const mutation = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(mutation.promise);
    act(() => { harness.result.current.editTranslation("아직 반영 대기 중인 사용자 번역", queued); });
    if (queued) await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    const editedProject = harness.result.current.project as TranslationProjectV2;
    const savedProject = { ...harness.initialProject, metadata: { ...harness.initialProject.metadata, updatedAt: "2026-10-29T00:00:00.000Z" } };
    await act(async () => {
      harness.save.resolve({ projectSessionId: "session-save", project: dto(savedProject, 1, false) });
      await saving;
    });
    expect(harness.result.current.project.dialogueLines[0]!.userTranslation).toBe("아직 반영 대기 중인 사용자 번역");
    expect(harness.result.current.projectRef.current).toBe(editedProject);
    expect(harness.result.current.revision).toBe(1);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.statusMessage).toMatch(/저장.*다시 저장/);
    expect(harness.result.current.queue.queuedSessionMutationCountRef.current).toBe(queued ? 1 : 0);
    if (queued) {
      await act(async () => {
        mutation.resolve({ status: "applied", revision: 2, project: dto(editedProject, 2, true) });
        await harness.result.current.queue.drainSessionMutationQueue();
      });
      expect(harness.result.current.project.dialogueLines[0]!.userTranslation).toBe("아직 반영 대기 중인 사용자 번역");
      expect(harness.result.current.revision).toBe(2);
      expect(harness.result.current.dirty).toBe(true);
      expect(harness.result.current.queue.queuedSessionMutationCountRef.current).toBe(0);
    }
  });

  it.each([false, true])("reports remaining unsaved changes returned by Main for a secret project: %s", async (secret) => {
    const harness = createHarness(secret);
    const { saving } = await startSave(harness);
    await act(async () => {
      harness.save.resolve({ projectSessionId: "session-save", project: dto(harness.initialProject, 1, true) });
      await saving;
    });
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.statusMessage).toMatch(/저장.*다시 저장/);
    if (secret) expect(harness.result.current.statusMessage).toContain("암호화");
  });

  it("keeps a newly blocked recovery status when an earlier active save response arrives", async () => {
    const harness = createHarness();
    const { saving } = await startSave(harness);
    act(() => { harness.result.current.sessionStatusRef.current = "needs_recovery"; });
    await act(async () => {
      harness.save.resolve({ projectSessionId: "session-save", project: dto(harness.initialProject, 1, false) });
      await saving;
    });
    expect(harness.result.current.sessionStatusRef.current).toBe("needs_recovery");
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.statusMessage).toContain("복구");
    expect(harness.observedDtos).not.toHaveBeenCalled();
  });

  it.each([false, true])("adopts an unchanged successful save and clears dirty for a secret project: %s", async (secret) => {
    const harness = createHarness(secret);
    const { saving } = await startSave(harness);
    const savedProject = structuredClone(harness.initialProject);
    savedProject.metadata.updatedAt = "2026-10-29T00:00:00.000Z";
    const savedDto = dto(savedProject, 1, false);
    await act(async () => {
      harness.save.resolve({ projectSessionId: "session-save", project: savedDto });
      await saving;
    });
    expect(harness.result.current.project).toBe(savedProject);
    expect(harness.result.current.projectRef.current).toBe(savedProject);
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(savedProject);
    expect(harness.result.current.currentFilePath).toBe("session:session-save");
    expect(harness.result.current.dirty).toBe(false);
    expect(harness.result.current.statusMessage).toBe(secret ? "암호화해서 저장했습니다." : "프로젝트를 저장했습니다.");
    expect(harness.observedDtos).toHaveBeenLastCalledWith(savedDto);
  });

  it("clears dirty when the save response includes a mutation already adopted while waiting", async () => {
    const harness = createHarness();
    const { saving } = await startSave(harness);
    const mutation = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(mutation.promise);
    act(() => { harness.result.current.editTranslation("이번 저장에 포함된 번역"); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    const editedProject = harness.result.current.project as TranslationProjectV2;
    await act(async () => {
      mutation.resolve({ status: "applied", revision: 2, project: dto(editedProject, 2, true) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    const savedProject = structuredClone(editedProject);
    await act(async () => {
      harness.save.resolve({ projectSessionId: "session-save", project: dto(savedProject, 2, false) });
      await saving;
    });
    expect(harness.result.current.project).toBe(savedProject);
    expect(harness.result.current.project.dialogueLines[0]!.userTranslation).toBe("이번 저장에 포함된 번역");
    expect(harness.result.current.revision).toBe(2);
    expect(harness.result.current.dirty).toBe(false);
    expect(harness.result.current.statusMessage).toBe("프로젝트를 저장했습니다.");
  });

  it("preserves local edits after save failure and allows a later save retry", async () => {
    const harness = createHarness();
    const { saving } = await startSave(harness);
    act(() => { harness.result.current.editTranslation("실패해도 보존할 사용자 번역", false); });
    await act(async () => {
      harness.save.reject(new Error("fixture disk full"));
      await saving;
    });
    expect(harness.result.current.project.dialogueLines[0]!.userTranslation).toBe("실패해도 보존할 사용자 번역");
    expect(harness.result.current.revision).toBe(1);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.statusMessage).toBe("fixture disk full");
    expect(harness.result.current.workflow.saveInFlightRef.current).toBe(false);
    const editedProject = harness.result.current.project as TranslationProjectV2;
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2, project: dto(editedProject, 2, true) });
    harness.saveProject.mockResolvedValueOnce({ projectSessionId: "session-save", project: dto(editedProject, 2, false) });
    await act(async () => { await harness.result.current.workflow.saveProject(); });
    expect(harness.result.current.project.dialogueLines[0]!.userTranslation).toBe("실패해도 보존할 사용자 번역");
    expect(harness.result.current.revision).toBe(2);
    expect(harness.result.current.dirty).toBe(false);
  });

  it("adopts a needs_recovery save response without reporting ordinary success", async () => {
    const harness = createHarness();
    const { saving } = await startSave(harness);
    const recoveryDto = { ...dto(harness.initialProject, 1, true), status: "needs_recovery" as const };
    await act(async () => {
      harness.save.resolve({ projectSessionId: "session-save", project: recoveryDto });
      await saving;
    });
    expect(harness.result.current.sessionStatus).toBe("needs_recovery");
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.statusMessage).toContain("복구");
    expect(harness.result.current.statusMessage).not.toContain("저장했습니다");
  });

  it("preserves the clean state of a newer persisted revision after an older save response", async () => {
    const harness = createHarness();
    const { saving } = await startSave(harness);
    const latestProject = { ...harness.initialProject, metadata: { ...harness.initialProject.metadata, title: "이미 저장된 최신 상태" } };
    act(() => {
      harness.result.current.queue.applySessionChange({ status: "applied", revision: 2, project: dto(latestProject, 2, false) });
    });
    await act(async () => {
      harness.save.resolve({ projectSessionId: "session-save", project: dto(harness.initialProject, 1, false) });
      await saving;
    });
    expect(harness.result.current.project.metadata.title).toBe("이미 저장된 최신 상태");
    expect(harness.result.current.revision).toBe(2);
    expect(harness.result.current.dirty).toBe(false);
    expect(harness.result.current.statusMessage).not.toContain("아직 저장하지 않은 변경사항이 있습니다");
  });
});
