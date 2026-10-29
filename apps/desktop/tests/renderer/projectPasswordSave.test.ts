import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../../src/shared/projectValidation";
import { useProjectSaveWorkflow } from "../../src/renderer/useProjectSaveWorkflow";

afterEach(() => { Reflect.deleteProperty(window, "projectApi"); });

describe("legacy password save", () => {
  it.each(["project switch", "edit in the same session"])('preserves current data after a %s while awaiting the password', async (change) => {
    const project = createEmptyProject("암호 저장 검증", true);
    const projectRef = { current: project };
    const sessionGenerationRef = { current: 1 };
    let answer!: (value: string) => void;
    const requestPassword = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
    const saveProject = vi.fn();
    const setProject = vi.fn();
    const setIsDirty = vi.fn();
    const setStatusMessage = vi.fn();
    window.projectApi = { chooseSaveFile: vi.fn().mockResolvedValue("fixture.ctp"), saveProject } as never;
    const { result } = renderHook(() => useProjectSaveWorkflow({
      project, projectRef, setProject, currentFilePath: null, setCurrentFilePath: vi.fn(),
      projectSessionIdRef: { current: null }, sessionGenerationRef, projectRevisionRef: { current: 0 },
      setProjectRevision: vi.fn(), setPendingPageNumbers: vi.fn(), sessionProjectRef: { current: null },
      sessionConflictRef: { current: false }, initialSessionPromiseRef: { current: null },
      sessionPersistenceRequired: false, drainSessionMutationQueue: async () => {}, syncProjectToSession: async () => true,
      setIsDirty, setStatusMessage, setRecentProjects: vi.fn(), requestPassword
    }));
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveProject(); });
    await waitFor(() => expect(requestPassword).toHaveBeenCalledOnce());
    projectRef.current = { ...project, metadata: { ...project.metadata, title: "대기 중 새 변경" } };
    if (change === "project switch") sessionGenerationRef.current += 1;
    await act(async () => { answer("fixture-only"); await saving; });
    expect(saveProject).not.toHaveBeenCalled();
    expect(setProject).not.toHaveBeenCalled();
    expect(setIsDirty).not.toHaveBeenCalled();
    expect(setStatusMessage).not.toHaveBeenCalled();
    expect(result.current.saveInFlightRef.current).toBe(false);
  });
});
