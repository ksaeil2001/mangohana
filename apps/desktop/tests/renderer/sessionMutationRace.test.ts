import { useRef, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditableTranslationProject, TranslationProjectV2 } from "../../src/shared/projectTypes.js";
import type { ProjectChangeResult, ProjectSaveResult, ProjectSessionResult, TranslationProjectDto } from "../../src/shared/projectSessionTypes.js";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation.js";
import type { RecentProject } from "../../src/renderer/recentProjects.js";
import { useProjectSaveWorkflow } from "../../src/renderer/useProjectSaveWorkflow.js";
import { useSessionMutationQueue } from "../../src/renderer/useSessionMutationQueue.js";

afterEach(() => { Reflect.deleteProperty(window, "projectApi"); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function dto(project: TranslationProjectV2, revision: number, dirty = true): TranslationProjectDto {
  return { project, revision, dirty, pendingPageImages: [], status: "active" };
}

function titled(project: TranslationProjectV2, title: string): TranslationProjectV2 {
  return { ...project, metadata: { ...project.metadata, title } };
}

function createHarness(withLine = false) {
  const initial = normalizeProject(createEmptyProject("A", false));
  if (withLine) initial.dialogueLines = [{
    id: "line-1", order: 1, pageNumber: 1, sourceLanguage: "ja", sourceText: "원문",
    dialogueType: "speech", origin: { kind: "manual" }, parseConfidence: 1, parseWarnings: []
  }];
  const applyProjectMutation = vi.fn();
  const reviewCleanedAsset = vi.fn();
  const saveProject = vi.fn();
  const saveProjectAs = vi.fn();
  const exportTranslations = vi.fn();
  const onProjectDto = vi.fn();
  const onLineIdRemapped = vi.fn();
  window.projectApi = { applyProjectMutation, reviewCleanedAsset, saveProject, saveProjectAs, exportTranslations } as never;
  const hook = renderHook(() => {
    const [project, setProjectState] = useState<EditableTranslationProject>(initial);
    const projectRef = useRef<EditableTranslationProject>(initial);
    const projectSessionIdRef = useRef<string | null>("session-a");
    const projectRevisionRef = useRef(1);
    const [revision, setProjectRevision] = useState(1);
    const [dirty, setIsDirty] = useState(false);
    const [pendingPages, setPendingPageNumbers] = useState<number[]>([]);
    const [message, setStatusMessage] = useState("");
    const [status, setStatus] = useState<TranslationProjectDto["status"]>("active");
    const sessionStatusRef = useRef<TranslationProjectDto["status"]>("active");
    const [currentFilePath, setCurrentFilePath] = useState<string | null>("session:session-a");
    const [, setRecentProjects] = useState<RecentProject[]>([]);
    const initialSessionPromiseRef = useRef<Promise<ProjectSessionResult> | null>(null);
    const selectedLineIdRef = useRef<string | null>("local-line");
    const [selectedLineId, setSelectedLineId] = useState<string | null>("local-line");
    const draftRef = useRef<string | null>("사용자 초안");
    function setProject(next: EditableTranslationProject) {
      projectRef.current = next;
      setProjectState(next);
    }
    function adoptProjectDto(next: TranslationProjectDto) {
      onProjectDto(next);
      sessionStatusRef.current = next.status;
      setStatus(next.status);
    }
    const queue = useSessionMutationQueue({
      projectSessionIdRef, projectRevisionRef, setProjectRevision, projectRef, setProject,
      selectedLineIdRef, setSelectedLineId, setPendingPageNumbers, setIsDirty, setStatusMessage,
      sessionStatusRef,
      onProjectDto: adoptProjectDto,
      onLineIdRemapped
    });
    if (!queue.sessionProjectRef.current) queue.sessionProjectRef.current = initial;
    const saveWorkflow = useProjectSaveWorkflow({
      project, setProject, projectRef, currentFilePath, setCurrentFilePath, projectSessionIdRef,
      projectRevisionRef, setProjectRevision, setPendingPageNumbers, initialSessionPromiseRef,
      sessionPersistenceRequired: true, setIsDirty, setStatusMessage, setRecentProjects,
      requestPassword: vi.fn().mockResolvedValue(null), sessionStatusRef, onProjectDto: adoptProjectDto,
      sessionGenerationRef: queue.sessionGenerationRef, sessionProjectRef: queue.sessionProjectRef,
      sessionConflictRef: queue.sessionConflictRef, drainSessionMutationQueue: queue.drainSessionMutationQueue,
      syncProjectToSession: queue.syncProjectToSession
    });
    function editTitle(title: string, queueMutation = true) {
      if (queueMutation) queue.queueSessionMutation({ type: "set_project_title", title });
      setProject(titled(projectRef.current as TranslationProjectV2, title));
      setIsDirty(true);
    }
    function editSourceLanguage() {
      const current = projectRef.current;
      setProject({ ...current, settings: { ...current.settings, defaultSourceLanguage: "ja" } });
      setIsDirty(true);
    }
    function addLocalLine(includeClientId = true) {
      const input = { pageNumber: 1, sourceLanguage: "ja" as const, sourceText: "原文", dialogueType: "speech" as const };
      queue.queueSessionMutation({ type: "add_dialogue_line", input }, includeClientId ? "local-line" : undefined);
      setProject({
        ...projectRef.current,
        dialogueLines: [{
          id: "local-line", order: 1, ...input,
          origin: { kind: "manual" }, parseConfidence: 1, parseWarnings: []
        }]
      });
      setIsDirty(true);
    }
    function editLocalLineText(sourceText: string) {
      queue.queueSessionMutation({ type: "update_dialogue_line", lineId: "local-line", patch: { sourceText } });
      setProject({
        ...projectRef.current,
        dialogueLines: projectRef.current.dialogueLines.map((line) => line.id === "local-line" ? { ...line, sourceText } : line)
      });
      setIsDirty(true);
    }
    function removeLocalLine() {
      queue.queueSessionMutation({ type: "remove_dialogue_line", lineId: "local-line" });
      setProject({
        ...projectRef.current,
        dialogueLines: projectRef.current.dialogueLines.filter((line) => line.id !== "local-line")
      });
      setIsDirty(true);
    }
    function editExistingLineText(sourceText: string, queueMutation = true) {
      if (queueMutation) queue.queueSessionMutation({ type: "update_dialogue_line", lineId: "line-1", patch: { sourceText } });
      setProject({
        ...projectRef.current,
        dialogueLines: projectRef.current.dialogueLines.map((line) => line.id === "line-1" ? { ...line, sourceText } : line)
      });
      setIsDirty(true);
    }
    function clearExistingLineNotes() {
      queue.queueSessionMutation({ type: "update_dialogue_line", lineId: "line-1", patch: { notes: "" } });
      setProject({
        ...projectRef.current,
        dialogueLines: projectRef.current.dialogueLines.map((line) => line.id === "line-1" ? { ...line, notes: undefined } : line)
      });
      setIsDirty(true);
    }
    function removeLocalPage(pageImageId: string) {
      queue.queueSessionMutation({ type: "remove_page_image", pageImageId });
      setProject({
        ...projectRef.current,
        pageImages: projectRef.current.pageImages.filter((page) => page.id !== pageImageId)
      });
      setIsDirty(true);
    }
    function enterRecovery() {
      sessionStatusRef.current = "needs_recovery";
      setStatus("needs_recovery");
      setStatusMessage("복구가 필요합니다.");
    }
    function switchSession(next: TranslationProjectV2) {
      projectSessionIdRef.current = "session-b";
      queue.resetSessionMutationState(next);
      projectRevisionRef.current = 10;
      setProjectRevision(10);
      setProject(next);
      setIsDirty(false);
      setStatusMessage("");
    }
    return {
      project, projectRef, revision, projectRevisionRef, dirty, pendingPages, message, status,
      sessionStatusRef, selectedLineId, selectedLineIdRef, draftRef, queue, saveWorkflow,
      editTitle, editSourceLanguage, addLocalLine, editLocalLineText, removeLocalLine, editExistingLineText, clearExistingLineNotes, removeLocalPage,
      enterRecovery, switchSession
    };
  });
  return { ...hook, initial, applyProjectMutation, reviewCleanedAsset, saveProject, saveProjectAs, exportTranslations, onProjectDto, onLineIdRemapped };
}

async function failLocalTitleB(harness: ReturnType<typeof createHarness>) {
  harness.applyProjectMutation.mockRejectedValueOnce(new Error("fixture mutation failure"));
  act(() => { harness.result.current.editTitle("B"); });
  await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
  expect(harness.result.current.project.metadata.title).toBe("B");
  expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
}

describe("session mutation ordering and recovery", () => {
  it("blocks immediate save, export and direct sync after a title conflict", async () => {
    const harness = createHarness(true);
    const mainConflict = titled(harness.initial, "서버 제목");
    harness.applyProjectMutation.mockResolvedValueOnce({
      status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
      project: dto(mainConflict, 2, false), conflictingPaths: ["metadata/title"]
    } satisfies ProjectChangeResult);
    act(() => { harness.result.current.editTitle("B"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });

    // Old code would silently retry B on Main's newer revision when sync is called directly.
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 3, project: dto(titled(mainConflict, "B"), 3) });
    await act(async () => {
      await harness.result.current.saveWorkflow.saveProject();
      await harness.result.current.saveWorkflow.saveProjectAs();
      await harness.result.current.saveWorkflow.exportTranslations();
      expect(await harness.result.current.saveWorkflow.prepareSyncedSessionForExport()).toBe(false);
      expect(await harness.result.current.queue.syncProjectToSession()).toBe(false);
    });
    expect(harness.applyProjectMutation).toHaveBeenCalledOnce();
    expect(harness.saveProject).not.toHaveBeenCalled();
    expect(harness.saveProjectAs).not.toHaveBeenCalled();
    expect(harness.exportTranslations).not.toHaveBeenCalled();
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(mainConflict);
    expect(harness.result.current.projectRevisionRef.current).toBe(2);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(true);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.message).toContain("저장");
    expect(harness.result.current.message).toContain("내보내기");
    expect(harness.result.current.message).toContain("미저장");
    expect(harness.result.current.message).toContain("다시 열");
  });

  it("retains later local edits without sending any mutation while a conflict is unresolved", async () => {
    const harness = createHarness(true);
    const mainConflict = titled(harness.initial, "서버 제목");
    harness.applyProjectMutation.mockResolvedValueOnce({
      status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
      project: dto(mainConflict, 2, false), conflictingPaths: ["metadata/title"]
    } satisfies ProjectChangeResult);
    act(() => { harness.result.current.editTitle("B"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    const callback = vi.fn();
    const mainC = { ...mainConflict, dialogueLines: [{ ...mainConflict.dialogueLines[0]!, sourceText: "C" }] };
    harness.applyProjectMutation.mockResolvedValue({ status: "applied", revision: 3, project: dto(mainC, 3) });
    act(() => {
      harness.result.current.editExistingLineText("C");
      harness.result.current.queue.queueSessionMutation({ type: "set_project_title", title: "B2" }, undefined, callback);
      harness.result.current.editTitle("B2", false);
    });
    await act(async () => {
      await harness.result.current.queue.drainSessionMutationQueue();
      await harness.result.current.saveWorkflow.saveProject();
      await harness.result.current.saveWorkflow.exportTranslations();
      expect(await harness.result.current.queue.syncProjectToSession()).toBe(false);
    });
    expect(harness.applyProjectMutation).toHaveBeenCalledOnce();
    expect(harness.saveProject).not.toHaveBeenCalled();
    expect(harness.exportTranslations).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(null, false);
    expect(harness.result.current.project.metadata.title).toBe("B2");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(mainConflict);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(true);
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    expect(harness.result.current.dirty).toBe(true);
  });

  it("keeps a conflict locked after an earlier unrelated success and preserves a later queued edit", async () => {
    const harness = createHarness(true);
    const lineSuccess = deferred<ProjectChangeResult>();
    const titleConflict = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(lineSuccess.promise).mockReturnValueOnce(titleConflict.promise);
    act(() => {
      harness.result.current.editExistingLineText("C");
      harness.result.current.editTitle("B");
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    const mainC = { ...harness.initial, dialogueLines: [{ ...harness.initial.dialogueLines[0]!, sourceText: "C" }] };
    await act(async () => { lineSuccess.resolve({ status: "applied", revision: 2, project: dto(mainC, 2) }); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    act(() => { harness.result.current.editExistingLineText("D"); });
    const mainConflict = titled(mainC, "서버 제목");
    await act(async () => {
      titleConflict.resolve({ status: "revision_conflict", code: "REVISION_CONFLICT", revision: 3,
        project: dto(mainConflict, 3), conflictingPaths: ["metadata/title"] });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    act(() => { harness.result.current.editExistingLineText("E"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2);
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(mainConflict);
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("E");
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(true);
    expect(harness.result.current.dirty).toBe(true);
  });

  it("preserves local input and the conflict when another applied session result arrives", async () => {
    const harness = createHarness(true);
    const mainConflict = titled(harness.initial, "서버 제목");
    harness.applyProjectMutation.mockResolvedValueOnce({
      status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
      project: dto(mainConflict, 2, false), conflictingPaths: ["metadata/title"]
    } satisfies ProjectChangeResult);
    act(() => { harness.result.current.editTitle("B"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    act(() => { harness.result.current.editExistingLineText("C", false); });
    const laterMain = { ...mainConflict, dialogueLines: [{ ...mainConflict.dialogueLines[0]!, sourceText: "서버 원문" }] };
    act(() => {
      expect(() => harness.result.current.queue.applySessionChange({
        status: "applied", revision: 3, project: dto(laterMain, 3, false)
      })).toThrow(/충돌/);
    });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(laterMain);
    expect(harness.result.current.revision).toBe(3);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(true);
    expect(harness.result.current.dirty).toBe(true);
  });

  it("does not replace a recovery state with a late active result while conflicted", async () => {
    const harness = createHarness(true);
    const mainConflict = titled(harness.initial, "서버 제목");
    harness.applyProjectMutation.mockResolvedValueOnce({
      status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
      project: dto(mainConflict, 2, false), conflictingPaths: ["metadata/title"]
    } satisfies ProjectChangeResult);
    act(() => { harness.result.current.editTitle("B"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    act(() => { harness.result.current.enterRecovery(); });
    harness.onProjectDto.mockClear();

    act(() => {
      expect(() => harness.result.current.queue.applySessionChange({
        status: "applied", revision: 3, project: dto(titled(mainConflict, "늦은 결과"), 3, false)
      })).toThrow(/복구/);
    });

    expect(harness.result.current.status).toBe("needs_recovery");
    expect(harness.result.current.sessionStatusRef.current).toBe("needs_recovery");
    expect(harness.onProjectDto).not.toHaveBeenCalled();
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(mainConflict);
    expect(harness.result.current.revision).toBe(2);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.message).toContain("복구");
  });

  it("warns that an export already in progress may finish after a conflict", async () => {
    const harness = createHarness(true);
    const pendingExport = deferred<string | null>();
    harness.exportTranslations.mockReturnValueOnce(pendingExport.promise);
    let exporting!: Promise<void>;
    act(() => { exporting = harness.result.current.saveWorkflow.exportTranslations(); });
    await waitFor(() => expect(harness.exportTranslations).toHaveBeenCalledOnce());

    const mainConflict = titled(harness.initial, "서버 제목");
    harness.applyProjectMutation.mockResolvedValueOnce({
      status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
      project: dto(mainConflict, 2, false), conflictingPaths: ["metadata/title"]
    } satisfies ProjectChangeResult);
    act(() => { harness.result.current.editTitle("B"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.message).toContain("진행 중인 저장·내보내기");
    expect(harness.result.current.message).toContain("완료될 수");

    await act(async () => { pendingExport.resolve("fixture.txt"); await exporting; });
    expect(harness.result.current.message).toContain("진행 중인 저장·내보내기");
    expect(harness.result.current.message).not.toContain("번역문을 내보냈습니다");
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.dirty).toBe(true);
  });

  it("retains a failed title through an unrelated successful line edit and saves both", async () => {
    const harness = createHarness(true);
    await failLocalTitleB(harness);
    const mainC = {
      ...harness.initial,
      dialogueLines: [{ ...harness.initial.dialogueLines[0]!, sourceText: "C" }]
    };
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2, project: dto(mainC, 2) });
    act(() => { harness.result.current.editExistingLineText("C"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.queue.sessionProjectRef.current?.metadata.title).toBe("A");
    expect(harness.result.current.revision).toBe(2);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);

    const bothEdits = titled(mainC, "B");
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 3, project: dto(bothEdits, 3) });
    harness.saveProject.mockResolvedValueOnce({ projectSessionId: "session-a", project: dto(bothEdits, 3, false) });
    await act(async () => { await harness.result.current.saveWorkflow.saveProject(); });
    expect(harness.applyProjectMutation).toHaveBeenLastCalledWith({
      projectSessionId: "session-a", baseRevision: 2, mutation: { type: "set_project_title", title: "B" }
    });
    expect(harness.saveProject).toHaveBeenCalledOnce();
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(false);
    expect(harness.result.current.dirty).toBe(false);
  });

  it("clears an earlier failed field when a later successful DTO includes the local value", async () => {
    const harness = createHarness(true);
    await failLocalTitleB(harness);
    const bothEdits = {
      ...titled(harness.initial, "B"),
      dialogueLines: [{ ...harness.initial.dialogueLines[0]!, sourceText: "C" }]
    };
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2, project: dto(bothEdits, 2) });
    act(() => { harness.result.current.editExistingLineText("C"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(bothEdits);
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(false);
    expect(harness.result.current.dirty).toBe(true);
  });

  it("keeps other local fields when a later response includes only the earlier failed field", async () => {
    const harness = createHarness(true);
    await failLocalTitleB(harness);
    act(() => { harness.result.current.editSourceLanguage(); });
    const mainBoth = {
      ...titled(harness.initial, "B"),
      dialogueLines: [{ ...harness.initial.dialogueLines[0]!, sourceText: "C" }]
    };
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2, project: dto(mainBoth, 2) });
    act(() => { harness.result.current.editExistingLineText("C"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    expect(harness.result.current.dirty).toBe(true);
    const mainAll = { ...mainBoth, settings: { ...mainBoth.settings, defaultSourceLanguage: "ja" as const } };
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 3, project: dto(mainAll, 3) });
    harness.saveProject.mockResolvedValueOnce({ projectSessionId: "session-a", project: dto(mainAll, 3, false) });
    await act(async () => { await harness.result.current.saveWorkflow.saveProject(); });
    expect(harness.applyProjectMutation).toHaveBeenLastCalledWith({
      projectSessionId: "session-a", baseRevision: 2,
      mutation: { type: "update_project_settings", patch: { defaultSourceLanguage: "ja" } }
    });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    expect(harness.result.current.dirty).toBe(false);
  });

  it("keeps other failed fields until each is reflected in a successful response", async () => {
    const harness = createHarness(true);
    await failLocalTitleB(harness);
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("fixture line failure"));
    act(() => { harness.result.current.editExistingLineText("C"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    const mainB = titled(harness.initial, "B");
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2, project: dto(mainB, 2) });
    act(() => { harness.result.current.editTitle("B"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    const mainBoth = { ...mainB, dialogueLines: [{ ...mainB.dialogueLines[0]!, sourceText: "C" }] };
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 3, project: dto(mainBoth, 3) });
    act(() => { harness.result.current.editExistingLineText("C"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(false);
  });

  it("recognizes a cleared optional text field normalized to an empty string by Main", async () => {
    const harness = createHarness(true);
    harness.initial.dialogueLines[0]!.notes = "이전 메모";
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("fixture notes failure"));
    act(() => { harness.result.current.clearExistingLineNotes(); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    const mainB = {
      ...titled(harness.initial, "B"),
      dialogueLines: [{ ...harness.initial.dialogueLines[0]!, notes: "" }]
    };
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2, project: dto(mainB, 2) });
    act(() => { harness.result.current.editTitle("B"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.notes).toBe("");
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(false);
    expect(harness.result.current.dirty).toBe(true);
  });

  it("allows save when the user removes a failed local addition and both sides agree", async () => {
    const harness = createHarness();
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("fixture add failure"))
      .mockRejectedValueOnce(new Error("fixture remove failure"));
    act(() => { harness.result.current.addLocalLine(); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    act(() => { harness.result.current.removeLocalLine(); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.dialogueLines).toEqual([]);
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    harness.saveProject.mockResolvedValueOnce({ projectSessionId: "session-a", project: dto(harness.initial, 1, false) });
    await act(async () => { await harness.result.current.saveWorkflow.saveProject(); });
    expect(harness.saveProject).toHaveBeenCalledOnce();
    expect(harness.result.current.project.dialogueLines).toEqual([]);
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(false);
    expect(harness.result.current.dirty).toBe(false);
  });

  it("keeps other local edits after a failed addition is removed", async () => {
    const harness = createHarness();
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("fixture add failure"))
      .mockRejectedValueOnce(new Error("fixture remove failure"));
    act(() => { harness.result.current.addLocalLine(); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    act(() => { harness.result.current.removeLocalLine(); harness.result.current.editSourceLanguage(); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    const mainB = titled(harness.initial, "B");
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2, project: dto(mainB, 2) });
    act(() => { harness.result.current.editTitle("B"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.dialogueLines).toEqual([]);
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    const mainAll = { ...mainB, settings: { ...mainB.settings, defaultSourceLanguage: "ja" as const } };
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 3, project: dto(mainAll, 3) });
    harness.saveProject.mockResolvedValueOnce({ projectSessionId: "session-a", project: dto(mainAll, 3, false) });
    await act(async () => { await harness.result.current.saveWorkflow.saveProject(); });
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    expect(harness.result.current.project.dialogueLines).toEqual([]);
    expect(harness.result.current.dirty).toBe(false);
  });

  it("recovers a failed local addition without a supplied client ID through explicit sync", async () => {
    const harness = createHarness();
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("fixture add failure"));
    act(() => { harness.result.current.addLocalLine(false); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    const mainAdded = { ...harness.initial, dialogueLines: [{
      id: "main-line", order: 1, pageNumber: 1, sourceLanguage: "ja" as const, sourceText: "原文",
      dialogueType: "speech" as const, origin: { kind: "manual" as const }, parseConfidence: 1, parseWarnings: []
    }] };
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2, project: dto(mainAdded, 2) });
    harness.saveProject.mockResolvedValueOnce({ projectSessionId: "session-a", project: dto(mainAdded, 2, false) });
    await act(async () => { await harness.result.current.saveWorkflow.saveProject(); });
    expect(harness.saveProject).toHaveBeenCalledOnce();
    expect(harness.result.current.project.dialogueLines[0]?.id).toBe("main-line");
    expect(harness.result.current.selectedLineId).toBe("main-line");
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(false);
    expect(harness.result.current.dirty).toBe(false);
  });

  it("blocks save if a failed page mutation cannot be recovered by project sync", async () => {
    const harness = createHarness();
    harness.initial.pageImages = [{
      id: "page-1", pageNumber: 1, storedRelativePath: "pages/p1.png", originalFileName: "p1.png",
      sha256: "a".repeat(64), byteSize: 10, mimeType: "image/png", copiedAt: "2026-10-29T00:00:00Z"
    }];
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("fixture page failure"));
    act(() => { harness.result.current.removeLocalPage("page-1"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    const mainB = titled(harness.initial, "B");
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2, project: dto(mainB, 2) });
    act(() => { harness.result.current.editTitle("B"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.pageImages).toEqual([]);
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    await act(async () => { await harness.result.current.saveWorkflow.saveProject(); });
    expect(harness.saveProject).not.toHaveBeenCalled();
    expect(harness.result.current.project.pageImages).toEqual([]);
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.message).toContain("동기화하지 못해 저장을 중단");
  });

  it("keeps a local edit and session ownership after an ordinary mutation conflict", async () => {
    const harness = createHarness(true);
    const mainConflict = titled(harness.initial, "서버 제목");
    const conflict: ProjectChangeResult = {
      status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
      project: dto(mainConflict, 2, false), conflictingPaths: ["metadata.title"]
    };
    const observer = vi.fn();
    harness.applyProjectMutation.mockResolvedValueOnce(conflict);
    const generation = harness.result.current.queue.sessionGenerationRef.current;
    act(() => {
      harness.result.current.queue.queueSessionMutation({ type: "set_project_title", title: "B" }, undefined, observer);
      harness.result.current.editTitle("B", false);
    });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(mainConflict);
    expect(harness.result.current.revision).toBe(2);
    expect(harness.result.current.projectRevisionRef.current).toBe(2);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(true);
    expect(harness.result.current.queue.sessionGenerationRef.current).toBe(generation + 1);
    expect(harness.result.current.message).toContain("충돌");
    expect(observer).toHaveBeenCalledWith(conflict, true);

    act(() => { harness.result.current.editExistingLineText("C"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    expect(harness.result.current.dirty).toBe(true);

    await act(async () => { await harness.result.current.saveWorkflow.saveProject(); });
    expect(harness.applyProjectMutation).toHaveBeenCalledOnce();
    expect(harness.saveProject).not.toHaveBeenCalled();
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(mainConflict);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(true);
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.dirty).toBe(true);
  });

  it("keeps later queued edits when an earlier ordinary mutation conflicts", async () => {
    const harness = createHarness(true);
    const conflictResult = deferred<ProjectChangeResult>();
    const pendingObserver = vi.fn();
    harness.applyProjectMutation.mockReturnValueOnce(conflictResult.promise);
    act(() => { harness.result.current.editTitle("B"); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    act(() => {
      harness.result.current.queue.queueSessionMutation({
        type: "update_dialogue_line", lineId: "line-1", patch: { sourceText: "C" }
      }, undefined, pendingObserver);
      harness.result.current.editExistingLineText("C", false);
    });
    const mainConflict = titled(harness.initial, "서버 제목");
    await act(async () => {
      conflictResult.resolve({
        status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
        project: dto(mainConflict, 2, false), conflictingPaths: ["metadata.title"]
      });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.applyProjectMutation).toHaveBeenCalledOnce();
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(mainConflict);
    expect(harness.result.current.revision).toBe(2);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(true);
    expect(harness.result.current.queue.queuedSessionMutationCountRef.current).toBe(0);
    expect(harness.result.current.dirty).toBe(true);
    expect(pendingObserver).toHaveBeenCalledWith(null, false);
  });

  it("does not roll back a newer session revision when an old conflict arrives", async () => {
    const harness = createHarness();
    const conflictResult = deferred<ProjectChangeResult>();
    const observer = vi.fn();
    harness.applyProjectMutation.mockReturnValueOnce(conflictResult.promise);
    act(() => {
      harness.result.current.queue.queueSessionMutation({ type: "set_project_title", title: "B" }, undefined, observer);
      harness.result.current.editTitle("B", false);
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    const latestMain = titled(harness.initial, "최신 서버 상태");
    const generation = harness.result.current.queue.sessionGenerationRef.current;
    act(() => {
      harness.result.current.queue.applySessionChange({ status: "applied", revision: 5, project: dto(latestMain, 5) });
      harness.result.current.editTitle("B", false);
    });
    await act(async () => {
      conflictResult.resolve({
        status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
        project: dto(titled(harness.initial, "오래된 서버 상태"), 2, false), conflictingPaths: ["metadata.title"]
      });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(latestMain);
    expect(harness.result.current.revision).toBe(5);
    expect(harness.result.current.projectRevisionRef.current).toBe(5);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(false);
    expect(harness.result.current.queue.sessionGenerationRef.current).toBe(generation);
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    expect(harness.result.current.dirty).toBe(true);
    expect(observer).toHaveBeenCalledWith(null, false);
  });

  it("does not lose a page removal canceled by a conflicting earlier mutation", async () => {
    const harness = createHarness();
    harness.initial.pageImages = [{
      id: "page-1", pageNumber: 1, storedRelativePath: "pages/p1.png", originalFileName: "p1.png",
      sha256: "a".repeat(64), byteSize: 10, mimeType: "image/png", copiedAt: "2026-10-29T00:00:00Z"
    }];
    const conflictResult = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(conflictResult.promise);
    act(() => { harness.result.current.editTitle("B"); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    act(() => { harness.result.current.removeLocalPage("page-1"); });
    const mainConflict = titled(harness.initial, "서버 제목");
    await act(async () => {
      conflictResult.resolve({
        status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
        project: dto(mainConflict, 2, false), conflictingPaths: ["metadata.title"]
      });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.applyProjectMutation).toHaveBeenCalledOnce();
    expect(harness.result.current.project.pageImages).toEqual([]);
    act(() => { harness.result.current.editTitle("B"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.pageImages).toEqual([]);
    await act(async () => { await harness.result.current.saveWorkflow.saveProject(); });
    expect(harness.saveProject).not.toHaveBeenCalled();
    expect(harness.result.current.project.pageImages).toEqual([]);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.message).toContain("충돌");
    act(() => { harness.result.current.removeLocalPage("page-1"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    await act(async () => { await harness.result.current.saveWorkflow.saveProject(); });
    expect(harness.applyProjectMutation).toHaveBeenCalledOnce();
    expect(harness.saveProject).not.toHaveBeenCalled();
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(mainConflict);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(true);
    expect(harness.result.current.project.pageImages).toEqual([]);
    expect(harness.result.current.dirty).toBe(true);
  });

  it("keeps queued work and local edits after an older ordinary conflict", async () => {
    const harness = createHarness(true);
    const conflictResult = deferred<ProjectChangeResult>();
    const editC = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(conflictResult.promise).mockReturnValueOnce(editC.promise);
    act(() => { harness.result.current.editTitle("B"); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    const latestMain = titled(harness.initial, "최신 서버 상태");
    const generation = harness.result.current.queue.sessionGenerationRef.current;
    act(() => {
      harness.result.current.queue.applySessionChange({ status: "applied", revision: 5, project: dto(latestMain, 5) });
      harness.result.current.editTitle("B", false);
      harness.result.current.editExistingLineText("C");
    });
    await act(async () => {
      conflictResult.resolve({
        status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
        project: dto(titled(harness.initial, "오래된 서버 상태"), 2, false), conflictingPaths: ["metadata.title"]
      });
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    expect(harness.applyProjectMutation).toHaveBeenNthCalledWith(2, {
      projectSessionId: "session-a", baseRevision: 5,
      mutation: { type: "update_dialogue_line", lineId: "line-1", patch: { sourceText: "C" } }
    });
    const mainC = { ...latestMain, dialogueLines: [{ ...latestMain.dialogueLines[0]!, sourceText: "C" }] };
    await act(async () => {
      editC.resolve({ status: "applied", revision: 6, project: dto(mainC, 6) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.revision).toBe(6);
    expect(harness.result.current.queue.sessionGenerationRef.current).toBe(generation);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(false);
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    const bothEdits = titled(mainC, "B");
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 7, project: dto(bothEdits, 7) });
    harness.saveProject.mockResolvedValueOnce({ projectSessionId: "session-a", project: dto(bothEdits, 7, false) });
    await act(async () => { await harness.result.current.saveWorkflow.saveProject(); });
    expect(harness.applyProjectMutation).toHaveBeenLastCalledWith({
      projectSessionId: "session-a", baseRevision: 6, mutation: { type: "set_project_title", title: "B" }
    });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.dirty).toBe(false);
  });

  it("does not adopt an older sync conflict or cancel newer queued edits", async () => {
    const harness = createHarness(true);
    await failLocalTitleB(harness);
    const syncB = deferred<ProjectChangeResult>();
    const editC = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncB.promise).mockReturnValueOnce(editC.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    const latestMain = titled(harness.initial, "최신 서버 상태");
    const generation = harness.result.current.queue.sessionGenerationRef.current;
    act(() => {
      harness.result.current.queue.applySessionChange({ status: "applied", revision: 5, project: dto(latestMain, 5) });
      harness.result.current.editTitle("B", false);
      harness.result.current.editExistingLineText("C");
    });
    await act(async () => {
      syncB.resolve({
        status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
        project: dto(titled(harness.initial, "오래된 서버 상태"), 2, false), conflictingPaths: ["metadata.title"]
      });
      expect(await syncing).toBe(false);
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(3));
    expect(harness.applyProjectMutation).toHaveBeenNthCalledWith(3, {
      projectSessionId: "session-a", baseRevision: 5,
      mutation: { type: "update_dialogue_line", lineId: "line-1", patch: { sourceText: "C" } }
    });
    const mainC = { ...latestMain, dialogueLines: [{ ...latestMain.dialogueLines[0]!, sourceText: "C" }] };
    await act(async () => {
      editC.resolve({ status: "applied", revision: 6, project: dto(mainC, 6) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("C");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(mainC);
    expect(harness.result.current.revision).toBe(6);
    expect(harness.result.current.queue.sessionGenerationRef.current).toBe(generation);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(false);
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    expect(harness.result.current.dirty).toBe(true);
  });

  it.each(["ordinary", "sync"] as const)("does not adopt an older recovery DTO from %s work", async (mode) => {
    const harness = createHarness();
    const late = deferred<ProjectChangeResult>();
    let syncing: Promise<boolean> | undefined;
    if (mode === "sync") {
      await failLocalTitleB(harness);
      harness.applyProjectMutation.mockReturnValueOnce(late.promise);
      act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
      await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    } else {
      harness.applyProjectMutation.mockReturnValueOnce(late.promise);
      act(() => { harness.result.current.editTitle("B"); });
      await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    }
    const latestMain = titled(harness.initial, "최신 서버 상태");
    const generation = harness.result.current.queue.sessionGenerationRef.current;
    act(() => {
      harness.result.current.queue.applySessionChange({ status: "applied", revision: 5, project: dto(latestMain, 5) });
      harness.result.current.editTitle("B", false);
    });
    harness.onProjectDto.mockClear();
    const staleRecovery = { ...dto(titled(harness.initial, "오래된 상태"), 2), status: "needs_recovery" as const };
    await act(async () => {
      late.resolve({ status: "applied", revision: 2, project: staleRecovery });
      if (syncing) expect(await syncing).toBe(false);
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.status).toBe("active");
    expect(harness.result.current.sessionStatusRef.current).toBe("active");
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(latestMain);
    expect(harness.result.current.revision).toBe(5);
    expect(harness.result.current.queue.sessionGenerationRef.current).toBe(generation);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.onProjectDto).not.toHaveBeenCalled();
  });

  it("preserves and subsequently saves a later user edit through the real save workflow", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    const syncB = deferred<ProjectChangeResult>();
    const editC = deferred<ProjectChangeResult>();
    const saveB = deferred<ProjectSaveResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncB.promise).mockReturnValueOnce(editC.promise);
    harness.saveProject.mockReturnValueOnce(saveB.promise);
    let saving!: Promise<void>;
    act(() => { saving = harness.result.current.saveWorkflow.saveProject(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    act(() => { harness.result.current.editTitle("C"); });
    await act(async () => {
      syncB.resolve({ status: "applied", revision: 2, project: dto(titled(harness.initial, "B"), 2) });
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(harness.saveProject).toHaveBeenCalledOnce());
    expect(harness.applyProjectMutation).toHaveBeenNthCalledWith(3, {
      projectSessionId: "session-a", baseRevision: 2, mutation: { type: "set_project_title", title: "C" }
    });
    await act(async () => {
      saveB.resolve({ projectSessionId: "session-a", project: dto(titled(harness.initial, "B"), 2, false) });
      await saving;
    });
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.message).toContain("다시 저장");
    await act(async () => {
      editC.resolve({ status: "applied", revision: 3, project: dto(titled(harness.initial, "C"), 3) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.revision).toBe(3);
    expect(harness.result.current.dirty).toBe(true);
    harness.saveProject.mockResolvedValueOnce({ projectSessionId: "session-a", project: dto(titled(harness.initial, "C"), 3, false) });
    await act(async () => { await harness.result.current.saveWorkflow.saveProject(); });
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.dirty).toBe(false);
  });

  it("serializes a later queued edit after the save sync and uses its new revision", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    const syncB = deferred<ProjectChangeResult>();
    const editC = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncB.promise).mockReturnValueOnce(editC.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    expect(harness.applyProjectMutation).toHaveBeenNthCalledWith(2, {
      projectSessionId: "session-a", baseRevision: 1, mutation: { type: "set_project_title", title: "B" }
    });
    act(() => { harness.result.current.editTitle("C"); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2);
    expect(harness.result.current.project.metadata.title).toBe("C");
    await act(async () => {
      syncB.resolve({ status: "applied", revision: 2, project: dto(titled(harness.initial, "B"), 2) });
      expect(await syncing).toBe(true);
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(3));
    expect(harness.applyProjectMutation).toHaveBeenNthCalledWith(3, {
      projectSessionId: "session-a", baseRevision: 2, mutation: { type: "set_project_title", title: "C" }
    });
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.dirty).toBe(true);
    await act(async () => {
      editC.resolve({ status: "applied", revision: 3, project: dto(titled(harness.initial, "C"), 3) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.queue.sessionProjectRef.current?.metadata.title).toBe("C");
    expect(harness.result.current.revision).toBe(3);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(false);
    expect(harness.result.current.queue.queuedSessionMutationCountRef.current).toBe(0);
  });

  it("keeps a newer local edit that was not queued when the older sync response arrives", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    const syncB = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncB.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    act(() => { harness.result.current.editTitle("C", false); });
    await act(async () => {
      syncB.resolve({ status: "applied", revision: 2, project: dto(titled(harness.initial, "B"), 2) });
      expect(await syncing).toBe(true);
    });
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.projectRef.current.metadata.title).toBe("C");
    expect(harness.result.current.queue.sessionProjectRef.current?.metadata.title).toBe("B");
    expect(harness.result.current.revision).toBe(2);
    expect(harness.result.current.dirty).toBe(true);
  });

  it("keeps an even newer unqueued edit when the queued edit after sync finishes", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    const syncB = deferred<ProjectChangeResult>();
    const editC = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncB.promise).mockReturnValueOnce(editC.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    act(() => { harness.result.current.editTitle("C"); });
    await act(async () => {
      syncB.resolve({ status: "applied", revision: 2, project: dto(titled(harness.initial, "B"), 2) });
      expect(await syncing).toBe(true);
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(3));
    act(() => { harness.result.current.editTitle("D", false); });
    await act(async () => {
      editC.resolve({ status: "applied", revision: 3, project: dto(titled(harness.initial, "C"), 3) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.project.metadata.title).toBe("D");
    expect(harness.result.current.queue.sessionProjectRef.current?.metadata.title).toBe("C");
    expect(harness.result.current.revision).toBe(3);
    expect(harness.result.current.dirty).toBe(true);
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 4, project: dto(titled(harness.initial, "D"), 4) });
    await act(async () => { expect(await harness.result.current.queue.syncProjectToSession()).toBe(true); });
    expect(harness.applyProjectMutation).toHaveBeenLastCalledWith({
      projectSessionId: "session-a", baseRevision: 3, mutation: { type: "set_project_title", title: "D" }
    });
    expect(harness.result.current.project.metadata.title).toBe("D");
    expect(harness.result.current.queue.sessionProjectRef.current?.metadata.title).toBe("D");
    expect(harness.result.current.revision).toBe(4);
  });

  it("keeps an unqueued edit made before the queued edit can start", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    const syncB = deferred<ProjectChangeResult>();
    const editC = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncB.promise).mockReturnValueOnce(editC.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    act(() => { harness.result.current.editTitle("C"); });
    await act(async () => { await Promise.resolve(); });
    act(() => { harness.result.current.editTitle("D", false); });
    await act(async () => {
      syncB.resolve({ status: "applied", revision: 2, project: dto(titled(harness.initial, "B"), 2) });
      expect(await syncing).toBe(true);
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(3));
    await act(async () => {
      editC.resolve({ status: "applied", revision: 3, project: dto(titled(harness.initial, "C"), 3) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.project.metadata.title).toBe("D");
    expect(harness.result.current.queue.sessionProjectRef.current?.metadata.title).toBe("C");
    expect(harness.result.current.revision).toBe(3);
    expect(harness.result.current.dirty).toBe(true);
  });

  it("preserves an added line's identity when a later local edit delays reconciliation", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    const syncB = deferred<ProjectChangeResult>();
    const addLine = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncB.promise).mockReturnValueOnce(addLine.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    act(() => { harness.result.current.addLocalLine(); });
    await act(async () => {
      syncB.resolve({ status: "applied", revision: 2, project: dto(titled(harness.initial, "B"), 2) });
      expect(await syncing).toBe(true);
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(3));
    act(() => { harness.result.current.editTitle("D", false); });
    const mainProject = titled(harness.initial, "B");
    mainProject.dialogueLines = [{
      id: "main-line", order: 1, pageNumber: 1, sourceLanguage: "ja", sourceText: "原文",
      dialogueType: "speech", origin: { kind: "manual" }, parseConfidence: 1, parseWarnings: []
    }];
    await act(async () => {
      addLine.resolve({ status: "applied", revision: 3, project: dto(mainProject, 3) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.project.metadata.title).toBe("D");
    expect(harness.result.current.project.dialogueLines[0]?.id).toBe("local-line");
    expect(harness.result.current.draftRef.current).toBe("사용자 초안");
    harness.applyProjectMutation
      .mockResolvedValueOnce({ status: "applied", revision: 4, project: dto(titled(mainProject, "D"), 4) })
      .mockRejectedValue(new Error("기존 대사를 삭제하거나 다시 추가하면 안 됩니다."));
    await act(async () => { expect(await harness.result.current.queue.syncProjectToSession()).toBe(true); });
    expect(harness.applyProjectMutation).toHaveBeenCalledTimes(4);
    expect(harness.applyProjectMutation).toHaveBeenLastCalledWith({
      projectSessionId: "session-a", baseRevision: 3, mutation: { type: "set_project_title", title: "D" }
    });
    expect(harness.result.current.project.dialogueLines[0]?.id).toBe("main-line");
    expect(harness.result.current.selectedLineId).toBe("main-line");
    expect(harness.onLineIdRemapped).toHaveBeenCalledWith("local-line", "main-line");
    expect(harness.result.current.draftRef.current).toBe("사용자 초안");
  });

  it("remaps a follow-up edit queued while a failed local line is being synced", async () => {
    const harness = createHarness();
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("fixture mutation failure"));
    act(() => { harness.result.current.addLocalLine(); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    const addLine = deferred<ProjectChangeResult>();
    const editLine = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(addLine.promise).mockReturnValueOnce(editLine.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    act(() => { harness.result.current.editLocalLineText("수정한 원문"); });
    const mainProject = { ...harness.initial, dialogueLines: [{
      id: "main-line", order: 1, pageNumber: 1, sourceLanguage: "ja" as const, sourceText: "原文",
      dialogueType: "speech" as const, origin: { kind: "manual" as const }, parseConfidence: 1, parseWarnings: []
    }] };
    await act(async () => {
      addLine.resolve({ status: "applied", revision: 2, project: dto(mainProject, 2) });
      expect(await syncing).toBe(true);
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(3));
    expect(harness.applyProjectMutation).toHaveBeenNthCalledWith(3, {
      projectSessionId: "session-a", baseRevision: 2,
      mutation: { type: "update_dialogue_line", lineId: "main-line", patch: { sourceText: "수정한 원문" } }
    });
    const edited = { ...mainProject, dialogueLines: [{ ...mainProject.dialogueLines[0]!, sourceText: "수정한 원문" }] };
    await act(async () => {
      editLine.resolve({ status: "applied", revision: 3, project: dto(edited, 3) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.project.dialogueLines[0]?.id).toBe("main-line");
    expect(harness.result.current.project.dialogueLines[0]?.sourceText).toBe("수정한 원문");
    expect(harness.result.current.selectedLineId).toBe("main-line");
    expect(harness.onLineIdRemapped).toHaveBeenCalledWith("local-line", "main-line");
    expect(harness.result.current.draftRef.current).toBe("사용자 초안");
  });

  it.each(["failure", "recovery"] as const)("preserves all local fields if a later sync step ends in %s", async (outcome) => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    act(() => { harness.result.current.editSourceLanguage(); });
    const syncTitle = deferred<ProjectChangeResult>();
    const syncSettings = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncTitle.promise).mockReturnValueOnce(syncSettings.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    await act(async () => {
      syncTitle.resolve({ status: "applied", revision: 2, project: dto(titled(harness.initial, "B"), 2) });
      await Promise.resolve();
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(3));
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    if (outcome === "failure") {
      await act(async () => {
        syncSettings.reject(new Error("fixture settings failure"));
        await expect(syncing).rejects.toThrow("fixture settings failure");
      });
    } else {
      const recoveryDto = { ...dto(titled(harness.initial, "B"), 2, false), status: "needs_recovery" as const };
      await act(async () => {
        syncSettings.resolve({ status: "applied", revision: 2, project: recoveryDto });
        expect(await syncing).toBe(false);
      });
      expect(harness.result.current.status).toBe("needs_recovery");
    }
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    expect(harness.result.current.dirty).toBe(true);
  });

  it("preserves unsynced fields through a later queued success after partial sync failure", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    act(() => { harness.result.current.editSourceLanguage(); });
    const syncTitle = deferred<ProjectChangeResult>();
    const syncSettings = deferred<ProjectChangeResult>();
    const editC = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncTitle.promise).mockReturnValueOnce(syncSettings.promise).mockReturnValueOnce(editC.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    await act(async () => {
      syncTitle.resolve({ status: "applied", revision: 2, project: dto(titled(harness.initial, "B"), 2) });
      await Promise.resolve();
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(3));
    act(() => { harness.result.current.editTitle("C"); });
    await act(async () => {
      syncSettings.reject(new Error("fixture settings failure"));
      await expect(syncing).rejects.toThrow("fixture settings failure");
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(4));
    expect(harness.applyProjectMutation).toHaveBeenNthCalledWith(4, {
      projectSessionId: "session-a", baseRevision: 2, mutation: { type: "set_project_title", title: "C" }
    });
    const mainC = titled(harness.initial, "C");
    await act(async () => {
      editC.resolve({ status: "applied", revision: 3, project: dto(mainC, 3) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    const savedC = { ...mainC, settings: { ...mainC.settings, defaultSourceLanguage: "ja" as const } };
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 4, project: dto(savedC, 4) });
    await act(async () => { expect(await harness.result.current.queue.syncProjectToSession()).toBe(true); });
    expect(harness.applyProjectMutation).toHaveBeenLastCalledWith({
      projectSessionId: "session-a", baseRevision: 3,
      mutation: { type: "update_project_settings", patch: { defaultSourceLanguage: "ja" } }
    });
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(false);
  });

  it("preserves unsynced fields and blocks later mutations after a sync conflict", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    act(() => { harness.result.current.editSourceLanguage(); });
    const mainB = titled(harness.initial, "B");
    harness.applyProjectMutation
      .mockResolvedValueOnce({ status: "applied", revision: 2, project: dto(mainB, 2) })
      .mockResolvedValueOnce({
        status: "revision_conflict", code: "REVISION_CONFLICT", revision: 3,
        project: dto(mainB, 3), conflictingPaths: ["settings.defaultSourceLanguage"]
      } satisfies ProjectChangeResult);
    await act(async () => { expect(await harness.result.current.queue.syncProjectToSession()).toBe(false); });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(true);
    act(() => { harness.result.current.editTitle("C"); });
    await act(async () => { await harness.result.current.queue.drainSessionMutationQueue(); });
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    await act(async () => { expect(await harness.result.current.queue.syncProjectToSession()).toBe(false); });
    expect(harness.applyProjectMutation).toHaveBeenCalledTimes(3);
    expect(harness.applyProjectMutation).toHaveBeenLastCalledWith({
      projectSessionId: "session-a", baseRevision: 2,
      mutation: { type: "update_project_settings", patch: { defaultSourceLanguage: "ja" } }
    });
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(mainB);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(true);
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    expect(harness.result.current.queue.sessionMutationFailedRef.current).toBe(true);
    expect(harness.result.current.dirty).toBe(true);
  });

  it("keeps a later edit behind every step of a multi-mutation save sync", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    act(() => { harness.result.current.editSourceLanguage(); });
    const syncTitle = deferred<ProjectChangeResult>();
    const syncSettings = deferred<ProjectChangeResult>();
    const editC = deferred<ProjectChangeResult>();
    harness.applyProjectMutation
      .mockReturnValueOnce(syncTitle.promise)
      .mockReturnValueOnce(syncSettings.promise)
      .mockReturnValueOnce(editC.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    act(() => { harness.result.current.editTitle("C"); });
    await act(async () => {
      syncTitle.resolve({ status: "applied", revision: 2, project: dto(titled(harness.initial, "B"), 2) });
      await Promise.resolve();
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(3));
    expect(harness.applyProjectMutation).toHaveBeenNthCalledWith(3, {
      projectSessionId: "session-a", baseRevision: 2,
      mutation: { type: "update_project_settings", patch: { defaultSourceLanguage: "ja" } }
    });
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    const titleAndSettings = { ...titled(harness.initial, "B"), settings: { ...harness.initial.settings, defaultSourceLanguage: "ja" as const } };
    await act(async () => {
      syncSettings.resolve({ status: "applied", revision: 3, project: dto(titleAndSettings, 3) });
      expect(await syncing).toBe(true);
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(4));
    expect(harness.applyProjectMutation).toHaveBeenNthCalledWith(4, {
      projectSessionId: "session-a", baseRevision: 3, mutation: { type: "set_project_title", title: "C" }
    });
    await act(async () => {
      editC.resolve({ status: "applied", revision: 4, project: dto(titled(titleAndSettings, "C"), 4) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    expect(harness.result.current.revision).toBe(4);
    expect(harness.result.current.dirty).toBe(true);
  });

  it("ignores remaining sync responses after switching sessions mid-sync", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    act(() => { harness.result.current.editSourceLanguage(); });
    const syncTitle = deferred<ProjectChangeResult>();
    const syncSettings = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncTitle.promise).mockReturnValueOnce(syncSettings.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    await act(async () => {
      syncTitle.resolve({ status: "applied", revision: 2, project: dto(titled(harness.initial, "B"), 2) });
      await Promise.resolve();
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(3));
    expect(harness.result.current.project.settings.defaultSourceLanguage).toBe("ja");
    const nextProject = normalizeProject(createEmptyProject("다른 세션", false));
    act(() => { harness.result.current.switchSession(nextProject); });
    harness.onProjectDto.mockClear();
    await act(async () => {
      syncSettings.resolve({ status: "applied", revision: 3, project: dto(titled(harness.initial, "B"), 3) });
      expect(await syncing).toBe(false);
    });
    expect(harness.result.current.project).toBe(nextProject);
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(nextProject);
    expect(harness.result.current.revision).toBe(10);
    expect(harness.result.current.dirty).toBe(false);
    expect(harness.onProjectDto).not.toHaveBeenCalled();
  });

  it("preserves a later queued edit when the sync itself encounters an external revision conflict", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    const syncB = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncB.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    act(() => { harness.result.current.editTitle("C"); });
    await act(async () => {
      syncB.resolve({
        status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
        project: dto(titled(harness.initial, "외부 편집"), 2), conflictingPaths: ["metadata.title"]
      });
      expect(await syncing).toBe(false);
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2);
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.queue.sessionProjectRef.current?.metadata.title).toBe("외부 편집");
    expect(harness.result.current.revision).toBe(2);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(true);
    expect(harness.result.current.message).toContain("충돌");
  });

  it("preserves the unsynced local edit when a save sync encounters a revision conflict", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    harness.applyProjectMutation.mockResolvedValueOnce({
      status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
      project: dto(titled(harness.initial, "외부 편집"), 2), conflictingPaths: ["metadata.title"]
    } satisfies ProjectChangeResult);
    await act(async () => { expect(await harness.result.current.queue.syncProjectToSession()).toBe(false); });
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.queue.sessionProjectRef.current?.metadata.title).toBe("외부 편집");
    expect(harness.result.current.revision).toBe(2);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.queue.sessionConflictRef.current).toBe(true);
    expect(harness.result.current.message).toContain("충돌");
  });

  it("ignores an active mutation result after recovery starts and preserves its draft", async () => {
    const harness = createHarness();
    const mutation = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(mutation.promise);
    const observer = vi.fn((result: ProjectChangeResult | null, adopted: boolean) => {
      if (result?.status === "applied" && adopted) harness.result.current.draftRef.current = null;
    });
    act(() => {
      harness.result.current.queue.queueSessionMutation({
        type: "add_dialogue_line", input: { pageNumber: 1, sourceLanguage: "ja", sourceText: "原文", dialogueType: "speech" }
      }, "local-line", observer);
      harness.result.current.editTitle("사용자의 최신 화면", false);
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    act(() => { harness.result.current.enterRecovery(); });
    const activeProject = titled(harness.initial, "오래된 응답");
    activeProject.dialogueLines = [{
      id: "main-line", order: 1, pageNumber: 1, sourceLanguage: "ja", sourceText: "原文",
      dialogueType: "speech", origin: { kind: "manual" }, parseConfidence: 1, parseWarnings: []
    }];
    await act(async () => {
      mutation.resolve({ status: "applied", revision: 2, project: dto(activeProject, 2, false) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.status).toBe("needs_recovery");
    expect(harness.result.current.sessionStatusRef.current).toBe("needs_recovery");
    expect(harness.result.current.project.metadata.title).toBe("사용자의 최신 화면");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(harness.initial);
    expect(harness.result.current.revision).toBe(1);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.pendingPages).toEqual([]);
    expect(harness.result.current.message).toBe("복구가 필요합니다.");
    expect(harness.result.current.selectedLineId).toBe("local-line");
    expect(harness.result.current.draftRef.current).toBe("사용자 초안");
    expect(harness.onProjectDto).not.toHaveBeenCalled();
    expect(harness.onLineIdRemapped).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalledWith(expect.objectContaining({ status: "applied" }), true);
    expect(harness.result.current.queue.queuedSessionMutationCountRef.current).toBe(0);
  });

  it("does not send a second queued mutation after recovery starts", async () => {
    const harness = createHarness();
    const mutation = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(mutation.promise);
    act(() => {
      harness.result.current.editTitle("B");
      harness.result.current.editTitle("C");
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    act(() => { harness.result.current.enterRecovery(); });
    await act(async () => {
      mutation.resolve({ status: "applied", revision: 2, project: dto(titled(harness.initial, "B"), 2) });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.applyProjectMutation).toHaveBeenCalledOnce();
    expect(harness.result.current.project.metadata.title).toBe("C");
    expect(harness.result.current.status).toBe("needs_recovery");
    expect(harness.result.current.queue.queuedSessionMutationCountRef.current).toBe(0);
  });

  it("does not treat an applied response with needs_recovery as an adopted user edit", async () => {
    const harness = createHarness();
    const mutation = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(mutation.promise);
    const observer = vi.fn((result: ProjectChangeResult | null, adopted: boolean) => {
      if (result?.status === "applied" && adopted) harness.result.current.draftRef.current = null;
    });
    act(() => {
      harness.result.current.queue.queueSessionMutation({ type: "set_project_title", title: "B" }, undefined, observer);
      harness.result.current.editTitle("B", false);
    });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    const recoveryDto = { ...dto(titled(harness.initial, "복구 필요 결과"), 2, false), status: "needs_recovery" as const };
    await act(async () => {
      mutation.resolve({ status: "applied", revision: 2, project: recoveryDto });
      await harness.result.current.queue.drainSessionMutationQueue();
    });
    expect(harness.result.current.status).toBe("needs_recovery");
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(harness.initial);
    expect(harness.result.current.revision).toBe(1);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.result.current.draftRef.current).toBe("사용자 초안");
    expect(observer).not.toHaveBeenCalledWith(expect.objectContaining({ status: "applied" }), true);
  });

  it("ignores a late active save-sync response after recovery starts", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    const syncB = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncB.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    act(() => { harness.result.current.enterRecovery(); });
    await act(async () => {
      syncB.resolve({ status: "applied", revision: 2, project: dto(titled(harness.initial, "B"), 2, false) });
      expect(await syncing).toBe(false);
    });
    expect(harness.result.current.status).toBe("needs_recovery");
    expect(harness.result.current.message).toBe("복구가 필요합니다.");
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(harness.initial);
    expect(harness.result.current.revision).toBe(1);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.onProjectDto).not.toHaveBeenCalled();
  });

  it("keeps the user's local data when a save-sync response itself requires recovery", async () => {
    const harness = createHarness();
    await failLocalTitleB(harness);
    const syncB = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(syncB.promise);
    let syncing!: Promise<boolean>;
    act(() => { syncing = harness.result.current.queue.syncProjectToSession(); });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    const recoveryDto = { ...dto(titled(harness.initial, "복구 필요 결과"), 2, false), status: "needs_recovery" as const };
    await act(async () => {
      syncB.resolve({ status: "applied", revision: 2, project: recoveryDto });
      expect(await syncing).toBe(false);
    });
    expect(harness.result.current.status).toBe("needs_recovery");
    expect(harness.result.current.project.metadata.title).toBe("B");
    expect(harness.result.current.queue.sessionProjectRef.current).toBe(harness.initial);
    expect(harness.result.current.revision).toBe(1);
    expect(harness.result.current.dirty).toBe(true);
    expect(harness.onProjectDto).toHaveBeenCalledWith(recoveryDto);
  });

  it("ignores a late active cleaned-review response after recovery starts", async () => {
    const harness = createHarness();
    const review = deferred<ProjectSaveResult>();
    harness.reviewCleanedAsset.mockReturnValueOnce(review.promise);
    let reviewing!: Promise<boolean> | null;
    act(() => { reviewing = harness.result.current.queue.queueCleanedAssetReview({
      pageImageId: "page-1", cleanedAssetId: "clean-1", expectedRevision: 1
    }); });
    expect(reviewing).not.toBeNull();
    await waitFor(() => expect(harness.reviewCleanedAsset).toHaveBeenCalledOnce());
    act(() => { harness.result.current.enterRecovery(); });
    await act(async () => {
      review.resolve({ projectSessionId: "session-a", project: dto(titled(harness.initial, "오래된 확인"), 2, false) });
      expect(await reviewing).toBe(false);
    });
    expect(harness.result.current.status).toBe("needs_recovery");
    expect(harness.result.current.message).toBe("복구가 필요합니다.");
    expect(harness.result.current.project.metadata.title).toBe("A");
    expect(harness.result.current.revision).toBe(1);
    expect(harness.onProjectDto).not.toHaveBeenCalled();
  });

  it("does not report review success when its own response requires recovery", async () => {
    const harness = createHarness();
    const review = deferred<ProjectSaveResult>();
    harness.reviewCleanedAsset.mockReturnValueOnce(review.promise);
    let reviewing!: Promise<boolean> | null;
    act(() => { reviewing = harness.result.current.queue.queueCleanedAssetReview({
      pageImageId: "page-1", cleanedAssetId: "clean-1", expectedRevision: 1
    }); });
    await waitFor(() => expect(harness.reviewCleanedAsset).toHaveBeenCalledOnce());
    const recoveryDto = { ...dto(titled(harness.initial, "복구 필요 결과"), 2, false), status: "needs_recovery" as const };
    await act(async () => {
      review.resolve({ projectSessionId: "session-a", project: recoveryDto });
      expect(await reviewing).toBe(false);
    });
    expect(harness.result.current.status).toBe("needs_recovery");
    expect(harness.result.current.project.metadata.title).toBe("A");
    expect(harness.result.current.revision).toBe(1);
    expect(harness.result.current.message).not.toContain("저장했습니다");
  });
});
