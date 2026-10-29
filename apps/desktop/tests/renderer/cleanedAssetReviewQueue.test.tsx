import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionMutationQueue } from "../../src/renderer/useSessionMutationQueue";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";
import type { ProjectSaveResult, TranslationProjectDto } from "../../src/shared/projectSessionTypes";
import type { EditableTranslationProject } from "../../src/shared/projectTypes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function setup() {
  const initial = normalizeProject(createEmptyProject("예시", false));
  const projectRef: { current: EditableTranslationProject } = { current: initial };
  const sessionId = { current: "session-1" as string | null };
  const revision = { current: 7 };
  const setProject = vi.fn((project: EditableTranslationProject) => { projectRef.current = project; });
  const setStatusMessage = vi.fn();
  const { result } = renderHook(() => useSessionMutationQueue({
    projectSessionIdRef: sessionId,
    projectRevisionRef: revision,
    setProjectRevision: vi.fn(),
    projectRef,
    setProject,
    selectedLineIdRef: { current: null },
    setSelectedLineId: vi.fn(),
    setPendingPageNumbers: vi.fn(),
    setIsDirty: vi.fn(),
    setStatusMessage,
    sessionStatusRef: { current: "active" }
  }));
  result.current.sessionProjectRef.current = initial;
  const dto = (project: typeof initial, nextRevision: number, dirty: boolean): TranslationProjectDto => ({
    revision: nextRevision, project, pendingPageImages: [], dirty, status: "active"
  });
  return { result, initial, projectRef, sessionId, revision, setProject, setStatusMessage, dto };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("cleaned asset review session queue", () => {
  it("sends the revision seen at click time and keeps later edits in order", async () => {
    const state = setup();
    const review = deferred<ProjectSaveResult>();
    const reviewed = { ...state.initial, metadata: { ...state.initial.metadata, title: "확인된 예시" } };
    const edited = { ...reviewed, metadata: { ...reviewed.metadata, title: "사용자 편집" } };
    const reviewCleanedAsset = vi.fn().mockReturnValue(review.promise);
    const applyProjectMutation = vi.fn().mockResolvedValue({ status: "applied", revision: 9, project: state.dto(edited, 9, true) });
    vi.stubGlobal("projectApi", { reviewCleanedAsset, applyProjectMutation });

    let operation: Promise<boolean> | null = null;
    act(() => {
      operation = state.result.current.queueCleanedAssetReview({ pageImageId: "page-1", cleanedAssetId: "clean-1", expectedRevision: 7 });
      state.projectRef.current = { ...state.initial, metadata: { ...state.initial.metadata, title: "사용자 편집" } };
      state.result.current.queueSessionMutation({ type: "set_project_title", title: "사용자 편집" });
    });
    await act(async () => { await Promise.resolve(); });
    expect(reviewCleanedAsset).toHaveBeenCalledExactlyOnceWith({ projectSessionId: "session-1", pageImageId: "page-1", cleanedAssetId: "clean-1", expectedRevision: 7 });
    expect(applyProjectMutation).not.toHaveBeenCalled();

    await act(async () => {
      review.resolve({ projectSessionId: "session-1", project: state.dto(reviewed, 8, false) });
      await operation;
      await state.result.current.drainSessionMutationQueue();
    });
    expect(applyProjectMutation).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: 8 }));
    expect(state.projectRef.current.metadata.title).toBe("사용자 편집");
    expect(state.revision.current).toBe(9);
  });

  it("rejects a busy queue and does not retry a revision conflict", async () => {
    const state = setup();
    const reviewCleanedAsset = vi.fn().mockRejectedValue(new Error("REVISION_CONFLICT"));
    vi.stubGlobal("projectApi", { reviewCleanedAsset });
    state.result.current.queuedSessionMutationCountRef.current = 1;
    expect(state.result.current.queueCleanedAssetReview({ pageImageId: "p", cleanedAssetId: "a", expectedRevision: 7 })).toBeNull();
    state.result.current.queuedSessionMutationCountRef.current = 0;
    await act(async () => {
      expect(await state.result.current.queueCleanedAssetReview({ pageImageId: "p", cleanedAssetId: "a", expectedRevision: 7 })).toBe(false);
    });
    expect(reviewCleanedAsset).toHaveBeenCalledTimes(1);
    expect(state.projectRef.current).toBe(state.initial);
    expect(state.setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("다시 확인"));
  });

  it("does not apply a late confirmation to another session", async () => {
    const state = setup();
    const review = deferred<ProjectSaveResult>();
    const reviewCleanedAsset = vi.fn().mockReturnValue(review.promise);
    vi.stubGlobal("projectApi", { reviewCleanedAsset });
    let operation: Promise<boolean> | null = null;
    act(() => { operation = state.result.current.queueCleanedAssetReview({ pageImageId: "p", cleanedAssetId: "a", expectedRevision: 7 }); });
    await act(async () => { await Promise.resolve(); });
    const other = normalizeProject(createEmptyProject("다른 프로젝트", false));
    act(() => {
      state.sessionId.current = "session-2";
      state.result.current.resetSessionMutationState(other);
      state.projectRef.current = other;
      state.revision.current = 1;
    });
    await act(async () => {
      review.resolve({ projectSessionId: "session-1", project: state.dto(state.initial, 8, false) });
      await operation;
    });
    expect(state.projectRef.current).toBe(other);
    expect(state.revision.current).toBe(1);
  });
});
