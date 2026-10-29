import { useRef } from "react";
import type { EditableTranslationProject, TranslationProjectV2 } from "../shared/projectTypes.js";
import type { ProjectSessionResult, TranslationProjectDto } from "../shared/projectSessionTypes.js";
import type { RecentProject } from "./recentProjects.js";

export type UseProjectSaveWorkflowOptions = {
  project: EditableTranslationProject;
  setProject: (project: EditableTranslationProject) => void;
  projectRef: React.MutableRefObject<EditableTranslationProject>;
  currentFilePath: string | null;
  setCurrentFilePath: (path: string | null) => void;
  projectSessionIdRef: React.MutableRefObject<string | null>;
  sessionGenerationRef: React.MutableRefObject<number>;
  projectRevisionRef: React.MutableRefObject<number>;
  setProjectRevision: (revision: number) => void;
  setPendingPageNumbers: (pages: number[]) => void;
  sessionProjectRef: React.MutableRefObject<TranslationProjectV2 | null>;
  sessionConflictRef: React.MutableRefObject<boolean>;
  initialSessionPromiseRef: React.MutableRefObject<Promise<ProjectSessionResult> | null>;
  sessionPersistenceRequired: boolean;
  drainSessionMutationQueue: () => Promise<void>;
  syncProjectToSession: () => Promise<boolean>;
  setIsDirty: (dirty: boolean) => void;
  setStatusMessage: (message: string) => void;
  setRecentProjects: React.Dispatch<React.SetStateAction<RecentProject[]>>;
  requestPassword: (message: string) => Promise<string | null>;
  sessionStatusRef?: React.MutableRefObject<TranslationProjectDto["status"]>;
  onProjectDto?: (dto: TranslationProjectDto) => void;
};

export function useProjectSaveWorkflow(options: UseProjectSaveWorkflowOptions) {
  const {
    project,
    setProject,
    projectRef,
    currentFilePath,
    setCurrentFilePath,
    projectSessionIdRef,
    sessionGenerationRef,
    projectRevisionRef,
    setProjectRevision,
    setPendingPageNumbers,
    sessionProjectRef,
    sessionConflictRef,
    initialSessionPromiseRef,
    sessionPersistenceRequired,
    drainSessionMutationQueue,
    syncProjectToSession,
    setIsDirty,
    setStatusMessage,
    setRecentProjects,
    sessionStatusRef,
    onProjectDto,
    requestPassword
  } = options;

  const saveInFlightRef = useRef(false);

  function isSameSession(sessionId: string | null, generation: number): boolean {
    return projectSessionIdRef.current === sessionId && sessionGenerationRef.current === generation;
  }

  function blockProjectSessionRecovery(): boolean {
    if (sessionStatusRef?.current !== "needs_recovery") return false;
    setStatusMessage("세션 복구가 필요하여 저장 또는 내보내기를 중단했습니다. 프로젝트를 다시 열어 복구하세요.");
    return true;
  }

  async function prepareSyncedSessionForExport(): Promise<boolean> {
    if (blockProjectSessionRecovery()) return false;
    const startedSessionId = projectSessionIdRef.current;
    const startedGeneration = sessionGenerationRef.current;
    if (!startedSessionId) return true;

    await initialSessionPromiseRef.current;
    if (!isSameSession(startedSessionId, startedGeneration)) return false;

    await drainSessionMutationQueue();
    if (!isSameSession(startedSessionId, startedGeneration)) return false;
    if (sessionConflictRef.current) return false;

    if (!window.projectApi?.applyProjectMutation) return true;

    try {
      const synced = await syncProjectToSession();
      if (!isSameSession(startedSessionId, startedGeneration)) return false;
      if (sessionConflictRef.current) return false;
      if (!synced) {
        setStatusMessage("프로젝트 변경을 최신 상태로 맞추지 못해 내보내기를 중단했습니다. 최신 상태를 확인한 뒤 다시 시도하세요.");
        return false;
      }
    } catch (error) {
      if (isSameSession(startedSessionId, startedGeneration)) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : "프로젝트 변경을 최신 상태로 맞추지 못해 내보내기를 중단했습니다. 최신 상태를 확인한 뒤 다시 시도하세요."
        );
      }
      return false;
    }

    return isSameSession(startedSessionId, startedGeneration);
  }

  async function saveProject() {
    await saveProjectTo(currentFilePath);
  }

  async function saveProjectAs() {
    await saveProjectTo(null);
  }

  async function saveProjectTo(targetPath: string | null) {
    if (!window.projectApi || saveInFlightRef.current) return;
    if (blockProjectSessionRecovery()) return;
    saveInFlightRef.current = true;
    const startedSessionId = projectSessionIdRef.current;
    const startedGeneration = sessionGenerationRef.current;

    try {
      await initialSessionPromiseRef.current;
      if (!isSameSession(startedSessionId, startedGeneration)) return;

      await drainSessionMutationQueue();
      if (!isSameSession(startedSessionId, startedGeneration)) return;
      if (sessionConflictRef.current) return;

      if (startedSessionId && window.projectApi.saveProjectAs && window.projectApi.applyProjectMutation) {
        if (!(await syncProjectToSession()) || !isSameSession(startedSessionId, startedGeneration)) return;
        const result = targetPath
          ? await window.projectApi.saveProject({ projectSessionId: startedSessionId })
          : await window.projectApi.saveProjectAs({ projectSessionId: startedSessionId });
        if (!isSameSession(startedSessionId, startedGeneration)) return;
        if (blockProjectSessionRecovery()) return;
        if (!result || !("project" in result)) {
          setStatusMessage("저장을 취소했습니다.");
          return;
        }
        const hasNewerRevision = projectRevisionRef.current > result.project.revision;
        // Optimistic edits can still be waiting for Main without a new revision yet.
        const hasLocalEdits = projectRef.current !== sessionProjectRef.current;
        const hasUnsavedChanges = hasLocalEdits || result.project.dirty;
        if (!hasNewerRevision) {
          setProjectRevision(result.project.revision);
          projectRevisionRef.current = result.project.revision;
          setPendingPageNumbers(result.project.pendingPageImages.map((page) => page.pageNumber));
          sessionProjectRef.current = result.project.project;
          if (!hasLocalEdits) {
            projectRef.current = result.project.project;
            setProject(result.project.project);
          }
          setIsDirty(hasUnsavedChanges);
          onProjectDto?.(result.project);
        }
        setCurrentFilePath(`session:${startedSessionId}`);
        if (!hasNewerRevision && result.project.status === "needs_recovery") return;
        if (result.recentProject) {
          setRecentProjects((current) => [
            result.recentProject!,
            ...current.filter(
              (item) => item.recentProjectId !== result.recentProject!.recentProjectId
            )
          ].slice(0, 8));
        }
        const savedMessage = result.project.project.metadata.secret ? "암호화해서 저장했습니다." : "프로젝트를 저장했습니다.";
        setStatusMessage(hasNewerRevision
          ? `${savedMessage} 더 최신 변경사항의 저장 상태를 확인하고 필요하면 다시 저장하세요.`
          : hasUnsavedChanges
            ? `${savedMessage} 아직 저장하지 않은 변경사항이 있습니다. 다시 저장하세요.`
            : savedMessage);
        return;
      }
      if (sessionPersistenceRequired) {
        setStatusMessage("프로젝트 세션이 준비되지 않아 저장할 수 없습니다. 세션을 다시 시도하세요.");
        return;
      }
      const filePath =
        targetPath ??
        (await window.projectApi.chooseSaveFile?.({
          defaultPath: `${project.metadata.title || "새 프로젝트"}.ctp`
        }));

      if (!isSameSession(startedSessionId, startedGeneration)) return;

      if (!filePath) {
        setStatusMessage("저장을 취소했습니다.");
        return;
      }

      const snapshot = projectRef.current;
      const password = snapshot.metadata.secret ? (await requestPassword("이 시크릿 프로젝트의 암호"))?.trim() : undefined;
      if (!isSameSession(startedSessionId, startedGeneration) || projectRef.current !== snapshot) return;
      if (snapshot.metadata.secret && !password) {
        setStatusMessage("시크릿 프로젝트 암호가 필요합니다.");
        return;
      }

      const projectToSave = {
        ...snapshot,
        metadata: {
          ...snapshot.metadata,
          updatedAt: new Date().toISOString()
        }
      };

      await window.projectApi.saveProject({ filePath, project: projectToSave, password });
      if (!isSameSession(startedSessionId, startedGeneration) || projectRef.current !== snapshot) return;
      setProject(projectToSave);
      setCurrentFilePath(filePath);
      setIsDirty(false);
      setStatusMessage(project.metadata.secret ? "암호화해서 저장했습니다." : "프로젝트를 저장했습니다.");
    } catch (error) {
      if (!isSameSession(startedSessionId, startedGeneration)) return;
      setStatusMessage(error instanceof Error ? error.message : "프로젝트를 저장하지 못했습니다.");
    } finally {
      saveInFlightRef.current = false;
    }
  }

  async function exportTranslations() {
    if (!window.projectApi) return;
    if (blockProjectSessionRecovery()) return;
    const startedSessionId = projectSessionIdRef.current;
    const startedGeneration = sessionGenerationRef.current;

    try {
      if (startedSessionId) {
        if (!(await prepareSyncedSessionForExport()) || !isSameSession(startedSessionId, startedGeneration)) {
          return;
        }
      }

      const currentProject = projectRef.current;
      const filePath = await window.projectApi.exportTranslations({
        defaultPath: `${currentProject.metadata.title || "새 프로젝트"}.txt`,
        ...(startedSessionId ? { projectSessionId: startedSessionId } : {}),
        project: {
          ...currentProject,
          metadata: {
            ...currentProject.metadata,
            updatedAt: new Date().toISOString()
          }
        }
      });

      if (startedSessionId && !isSameSession(startedSessionId, startedGeneration)) return;
      setStatusMessage(filePath ? "번역문을 내보냈습니다." : "내보내기를 취소했습니다.");
    } catch (error) {
      if (startedSessionId && !isSameSession(startedSessionId, startedGeneration)) return;
      setStatusMessage(error instanceof Error ? error.message : "번역문을 내보내지 못했습니다.");
    }
  }

  return {
    saveInFlightRef,
    saveProject,
    saveProjectAs,
    saveProjectTo,
    exportTranslations,
    prepareSyncedSessionForExport
  };
}
