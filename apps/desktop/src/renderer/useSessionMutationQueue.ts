import { useRef } from "react";
import type { DialogueUserPatch, NewDialogueLineInput, ProjectMutation } from "../shared/projectChanges.js";
import type { EditableTranslationProject, TranslationProjectV2 } from "../shared/projectTypes.js";
import type { ProjectChangeResult, TranslationProjectDto } from "../shared/projectSessionTypes.js";
import { inspectApprovedCleanedAsset } from "../shared/approvedCleanedAsset.js";

export type SessionMutationObserver = (result: ProjectChangeResult | null, adopted: boolean) => void;

type FailedSessionMutation = { mutation: ProjectMutation; clientLineId?: string };

export function mergePendingPageNumbers(
  current: number[],
  pendingPageImages: Array<{ pageNumber: number }>
): number[] {
  return [...new Set([
    ...current,
    ...pendingPageImages.map((page) => page.pageNumber)
  ])];
}

const dialogueUserPatchFields = [
  "speaker",
  "position",
  "dialogueType",
  "lineStatus",
  "sourceLanguage",
  "sourceText",
  "referenceTranslation",
  "userTranslation",
  "notes",
  "pageNumber"
] as const;

const optionalDialogueTextFields = new Set(["speaker", "position", "referenceTranslation", "userTranslation", "notes"]);

function buildDialogueUserPatch(
  previous: EditableTranslationProject["dialogueLines"][number],
  next: EditableTranslationProject["dialogueLines"][number]
): DialogueUserPatch | null {
  const patch: DialogueUserPatch = {};
  for (const field of dialogueUserPatchFields) {
    if (next[field] === previous[field]) continue;
    if (field === "pageNumber") {
      patch.pageNumber = next.pageNumber;
    } else {
      Object.assign(patch, { [field]: next[field] ?? "" });
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function buildAddDialogueLineInput(
  line: EditableTranslationProject["dialogueLines"][number]
): NewDialogueLineInput {
  return {
    pageNumber: line.pageNumber,
    sourceLanguage: line.sourceLanguage,
    sourceText: line.sourceText,
    dialogueType: line.dialogueType,
    ...(line.speaker === undefined ? {} : { speaker: line.speaker }),
    ...(line.position === undefined ? {} : { position: line.position }),
    ...(line.notes === undefined ? {} : { notes: line.notes }),
    ...(line.lineStatus === undefined ? {} : { lineStatus: line.lineStatus }),
    ...(line.referenceTranslation === undefined ? {} : { referenceTranslation: line.referenceTranslation }),
    ...(line.userTranslation === undefined ? {} : { userTranslation: line.userTranslation }),
    ...(line.typesetting === undefined ? {} : { typesetting: line.typesetting })
  };
}

function typesettingNeedsUpdate(
  previous: EditableTranslationProject["dialogueLines"][number],
  next: EditableTranslationProject["dialogueLines"][number]
): boolean {
  return Boolean(next.typesetting) && JSON.stringify(previous.typesetting ?? null) !== JSON.stringify(next.typesetting);
}

function sameProjectValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameProjectValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(rightRecord, key) && sameProjectValue(leftRecord[key], rightRecord[key]));
}

function sameDialogueField(field: string, left: unknown, right: unknown): boolean {
  if (optionalDialogueTextFields.has(field) &&
    (left === undefined || left === "") && (right === undefined || right === "")) return true;
  return sameProjectValue(left, right);
}

function areLocalEditsReflected(
  local: EditableTranslationProject,
  main: TranslationProjectV2,
  localLineIds: Map<string, string>
): boolean {
  if (local.metadata.id !== main.metadata.id || local.metadata.title !== main.metadata.title ||
    local.metadata.secret !== main.metadata.secret || !sameProjectValue(local.settings, main.settings) ||
    !sameProjectValue(local.characters, main.characters) || !sameProjectValue(local.dictionaryTerms, main.dictionaryTerms) ||
    local.pageImages.length !== main.pageImages.length || local.dialogueLines.length !== main.dialogueLines.length) return false;
  if (local.pageImages.some((page, index) => page.id !== main.pageImages[index]?.id ||
    page.pageNumber !== main.pageImages[index]?.pageNumber)) return false;
  if (local.dialogueLines.some((line, index) => {
    const mainLine = main.dialogueLines[index];
    return !mainLine || (localLineIds.get(line.id) ?? line.id) !== mainLine.id ||
      dialogueUserPatchFields.some((field) => !sameDialogueField(field, line[field], mainLine[field])) ||
      !sameProjectValue(line.typesetting, mainLine.typesetting);
  })) return false;
  const reviewedPages = new Map<string, string | undefined>();
  for (const page of main.processing.pages) reviewedPages.set(page.pageImageId, page.userReviewedCleanedAssetId);
  return local.processing.pages.every((page) => page.userReviewedCleanedAssetId === undefined ||
    page.userReviewedCleanedAssetId === reviewedPages.get(page.pageImageId));
}

function isFailedMutationReflected(
  failed: FailedSessionMutation,
  local: EditableTranslationProject,
  main: TranslationProjectV2,
  localLineIds: Map<string, string>
): boolean {
  const { mutation } = failed;
  const equal = sameProjectValue;
  const findLines = (lineId: string) => {
    const mainId = localLineIds.get(lineId) ?? lineId;
    return {
      localLine: local.dialogueLines.find((line) => line.id === lineId || line.id === mainId),
      mainLine: main.dialogueLines.find((line) => line.id === mainId)
    };
  };

  switch (mutation.type) {
    case "set_project_title":
      return local.metadata.title === main.metadata.title;
    case "update_project_settings":
      return Object.keys(mutation.patch).every((field) =>
        equal(local.settings[field as keyof typeof local.settings], main.settings[field as keyof typeof main.settings]));
    case "update_dialogue_line": {
      const { localLine, mainLine } = findLines(mutation.lineId);
      if (!localLine || !mainLine) return !localLine && !mainLine;
      return Object.keys(mutation.patch).every((field) =>
        sameDialogueField(field, localLine[field as keyof typeof localLine], mainLine[field as keyof typeof mainLine]));
    }
    case "update_dialogue_typesetting": {
      const { localLine, mainLine } = findLines(mutation.lineId);
      return localLine && mainLine ? equal(localLine.typesetting, mainLine.typesetting) : !localLine && !mainLine;
    }
    case "add_dialogue_line": {
      if (!failed.clientLineId) return areLocalEditsReflected(local, main, localLineIds);
      if (!localLineIds.has(failed.clientLineId)) {
        return !local.dialogueLines.some((line) => line.id === failed.clientLineId);
      }
      const { localLine, mainLine } = findLines(failed.clientLineId);
      if (!localLine || !mainLine) return !localLine && !mainLine;
      return dialogueUserPatchFields.every((field) => sameDialogueField(field, localLine[field], mainLine[field])) &&
        equal(localLine.typesetting, mainLine.typesetting);
    }
    case "remove_dialogue_line": {
      const { localLine, mainLine } = findLines(mutation.lineId);
      return Boolean(localLine) === Boolean(mainLine);
    }
    case "reorder_dialogue_lines":
      return local.dialogueLines.length === main.dialogueLines.length &&
        local.dialogueLines.every((line, index) => (localLineIds.get(line.id) ?? line.id) === main.dialogueLines[index]?.id);
    case "upsert_character":
    case "remove_character": {
      const id = mutation.type === "upsert_character" ? mutation.character.id : mutation.characterId;
      return equal(local.characters.find((item) => item.id === id), main.characters.find((item) => item.id === id));
    }
    case "upsert_dictionary_term":
    case "remove_dictionary_term": {
      const id = mutation.type === "upsert_dictionary_term" ? mutation.term.id : mutation.termId;
      return equal(local.dictionaryTerms.find((item) => item.id === id), main.dictionaryTerms.find((item) => item.id === id));
    }
    case "remove_page_image":
      return local.pageImages.some((page) => page.id === mutation.pageImageId) ===
        main.pageImages.some((page) => page.id === mutation.pageImageId);
  }
}

export function remapLocalDialogueIds(
  mutation: ProjectMutation,
  localLineIds: Map<string, string>
): ProjectMutation {
  if (
    mutation.type === "update_dialogue_line" ||
    mutation.type === "remove_dialogue_line" ||
    mutation.type === "update_dialogue_typesetting"
  ) {
    return {
      ...mutation,
      lineId: localLineIds.get(mutation.lineId) ?? mutation.lineId
    };
  }
  if (mutation.type === "reorder_dialogue_lines") {
    return {
      ...mutation,
      orderedLineIds: mutation.orderedLineIds.map((id) => localLineIds.get(id) ?? id)
    };
  }
  return mutation;
}

export type UseSessionMutationQueueOptions = {
  projectSessionIdRef: React.MutableRefObject<string | null>;
  projectRevisionRef: React.MutableRefObject<number>;
  setProjectRevision: (revision: number) => void;
  projectRef: React.MutableRefObject<EditableTranslationProject>;
  setProject: (project: EditableTranslationProject) => void;
  selectedLineIdRef: React.MutableRefObject<string | null>;
  setSelectedLineId: (lineId: string | null) => void;
  setPendingPageNumbers: React.Dispatch<React.SetStateAction<number[]>>;
  setIsDirty: (dirty: boolean) => void;
  setStatusMessage: (message: string) => void;
  sessionStatusRef?: React.MutableRefObject<TranslationProjectDto["status"]>;
  onProjectDto?: (dto: TranslationProjectDto) => void;
  onLineIdRemapped?: (clientLineId: string, mainLineId: string) => void;
};

export function useSessionMutationQueue(options: UseSessionMutationQueueOptions) {
  const {
    projectSessionIdRef,
    projectRevisionRef,
    setProjectRevision,
    projectRef,
    setProject,
    selectedLineIdRef,
    setSelectedLineId,
    setPendingPageNumbers,
    setIsDirty,
    setStatusMessage,
    sessionStatusRef,
    onProjectDto,
    onLineIdRemapped
  } = options;

  const sessionProjectRef = useRef<TranslationProjectV2 | null>(null);
  const sessionMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedSessionMutationCountRef = useRef(0);
  const pendingSessionMutationTokensRef = useRef(new Set<number>());
  const nextSessionMutationTokenRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const localLineIdMapRef = useRef(new Map<string, string>());
  const sessionConflictRef = useRef(false);
  const sessionConflictMessageRef = useRef("");
  const sessionMutationFailedRef = useRef(false);
  const sessionSyncFailedRef = useRef(false);
  const failedSessionMutationsRef = useRef<FailedSessionMutation[]>([]);

  function isCurrentSessionGeneration(generation: number, projectSessionId: string): boolean {
    return (
      generation === sessionGenerationRef.current &&
      projectSessionIdRef.current === projectSessionId
    );
  }

  function canApplySessionResult(generation: number, projectSessionId: string): boolean {
    return isCurrentSessionGeneration(generation, projectSessionId) &&
      sessionStatusRef?.current !== "needs_recovery";
  }

  function reportSessionConflict(paths: string[]): void {
    sessionConflictMessageRef.current = `다른 변경과 충돌했습니다: ${paths.join(", ") || "최신 상태 확인"}. 새 저장·내보내기를 중단했습니다. 진행 중인 저장·내보내기는 완료될 수 있습니다. 미저장 내용을 기록한 뒤 다시 여세요. 다시 열면 미저장 내용은 사라집니다.`;
    setStatusMessage(sessionConflictMessageRef.current);
  }

  function lockSessionConflict(message: string): void {
    if (sessionConflictRef.current || (sessionStatusRef && sessionStatusRef.current !== "active")) return;
    sessionConflictRef.current = true;
    sessionSyncFailedRef.current = true;
    sessionMutationFailedRef.current = true;
    sessionGenerationRef.current += 1;
    pendingSessionMutationTokensRef.current = new Set();
    queuedSessionMutationCountRef.current = 0;
    sessionMutationQueueRef.current = Promise.resolve();
    sessionConflictMessageRef.current = message;
    setIsDirty(true);
    setStatusMessage(message);
  }

  function adoptRecoveryStatus(dto: TranslationProjectDto): boolean {
    if (dto.status !== "needs_recovery") return false;
    if (sessionStatusRef) sessionStatusRef.current = "needs_recovery";
    onProjectDto?.(dto);
    return true;
  }

  function trackPendingSessionMutation(token: number): void {
    pendingSessionMutationTokensRef.current.add(token);
    queuedSessionMutationCountRef.current = pendingSessionMutationTokensRef.current.size;
  }

  function releasePendingSessionMutation(generation: number, token: number): void {
    if (generation !== sessionGenerationRef.current) return;
    pendingSessionMutationTokensRef.current.delete(token);
    queuedSessionMutationCountRef.current = pendingSessionMutationTokensRef.current.size;
  }

  function reconcileSessionProject(nextProject: TranslationProjectV2): void {
    const currentSelectedLineId = selectedLineIdRef.current;
    const selectedMainId = currentSelectedLineId
      ? localLineIdMapRef.current.get(currentSelectedLineId) ?? currentSelectedLineId
      : null;
    for (const [clientLineId, mainLineId] of localLineIdMapRef.current) {
      onLineIdRemapped?.(clientLineId, mainLineId);
    }
    localLineIdMapRef.current.clear();
    projectRef.current = nextProject;
    setProject(nextProject);
    selectedLineIdRef.current = selectedMainId;
    setSelectedLineId(selectedMainId);
  }

  function applySessionChange(result: ProjectChangeResult) {
    if (sessionStatusRef?.current === "needs_recovery") {
      const message = "세션 복구가 필요하여 결과를 화면에 반영하지 못했습니다.";
      setIsDirty(true);
      setStatusMessage(message);
      throw new Error(message);
    }
    if (sessionConflictRef.current) {
      if (result.revision >= projectRevisionRef.current) {
        setProjectRevision(result.revision);
        projectRevisionRef.current = result.revision;
        setPendingPageNumbers((current) => mergePendingPageNumbers(current, result.project.pendingPageImages));
        sessionProjectRef.current = result.project.project;
        onProjectDto?.(result.project);
      }
      setIsDirty(true);
      const message = result.project.status === "needs_recovery"
        ? "세션 복구가 필요하여 결과를 화면에 반영하지 못했습니다."
        : `충돌로 작업 결과를 화면에 반영하지 못했습니다. ${sessionConflictMessageRef.current}`;
      setStatusMessage(message);
      // Callers must not discard review drafts after a result was kept off screen.
      throw new Error(message);
    }
    setProjectRevision(result.revision);
    projectRevisionRef.current = result.revision;
    setPendingPageNumbers((current) => mergePendingPageNumbers(current, result.project.pendingPageImages));
    sessionProjectRef.current = result.project.project;
    projectRef.current = result.project.project;
    setProject(result.project.project);
    setIsDirty(result.project.dirty);
    onProjectDto?.(result.project);
    if (result.status === "revision_conflict") {
      setStatusMessage(`다른 변경과 충돌했습니다: ${result.conflictingPaths.join(", ") || "최신 상태를 확인하세요."}`);
    }
  }

  function queueSessionMutation(
    mutation: ProjectMutation,
    clientLineId?: string,
    observer?: SessionMutationObserver
  ): boolean {
    const api = window.projectApi;
    const projectSessionId = projectSessionIdRef.current;
    if (!api?.applyProjectMutation || !projectSessionId) return false;
    if (sessionStatusRef?.current === "needs_recovery") return false;
    const notify = (result: ProjectChangeResult | null, adopted = false) => {
      try {
        observer?.(result, adopted);
      } catch {
        // An optional UI observer must never break the mutation queue.
      }
    };
    const generation = sessionGenerationRef.current;
    const token = ++nextSessionMutationTokenRef.current;
    trackPendingSessionMutation(token);
    const projectBeforeQueue = projectRef.current;
    let projectAfterQueue = projectBeforeQueue;
    let projectAtDispatch: EditableTranslationProject | undefined;
    let responseIsStale = false;
    // The caller may update its optimistic project immediately after queuing.
    void Promise.resolve().then(() => {
      if (canApplySessionResult(generation, projectSessionId)) projectAfterQueue = projectRef.current;
    });

    function hasLaterLocalChanges(): boolean {
      return projectAtDispatch !== undefined && (
        projectRef.current !== projectAtDispatch ||
        (projectAfterQueue !== projectBeforeQueue && projectRef.current !== projectAfterQueue)
      );
    }

    sessionMutationQueueRef.current = sessionMutationQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!canApplySessionResult(generation, projectSessionId)) {
          notify(null);
          return;
        }
        if (sessionConflictRef.current) {
          // Keep optimistic input and drafts local until the conflict is explicitly resolved.
          setIsDirty(true);
          setStatusMessage(sessionConflictMessageRef.current);
          notify(null);
          return;
        }
        const mappedMutation = remapLocalDialogueIds(mutation, localLineIdMapRef.current);
        const previousProject = sessionProjectRef.current;
        projectAtDispatch = projectRef.current;
        const result = await api.applyProjectMutation!({
          projectSessionId,
          baseRevision: projectRevisionRef.current,
          mutation: mappedMutation
        });
        if (!canApplySessionResult(generation, projectSessionId)) {
          notify(null);
          return;
        }
        if (result.revision < projectRevisionRef.current) {
          responseIsStale = true;
          if (!sessionProjectRef.current || !areLocalEditsReflected(projectRef.current, sessionProjectRef.current, localLineIdMapRef.current)) {
            failedSessionMutationsRef.current.push({ mutation, clientLineId });
            sessionMutationFailedRef.current = true;
            setIsDirty(true);
          }
          notify(null);
          return;
        }
        if (adoptRecoveryStatus(result.project)) {
          notify(null);
          return;
        }
        if (result.status === "applied" &&
          clientLineId && previousProject && mappedMutation.type === "add_dialogue_line") {
          const previousIds = new Set(previousProject.dialogueLines.map((line) => line.id));
          const added = result.project.project.dialogueLines.find(
            (line) =>
              !previousIds.has(line.id) &&
              line.origin.kind === "manual" &&
              line.pageNumber === mappedMutation.input.pageNumber &&
              line.sourceLanguage === mappedMutation.input.sourceLanguage &&
              line.sourceText === mappedMutation.input.sourceText &&
              line.dialogueType === mappedMutation.input.dialogueType
          );
          if (added) localLineIdMapRef.current.set(clientLineId, added.id);
        }
        if (result.status === "applied") {
          const hadFailedMutations = failedSessionMutationsRef.current.length > 0;
          failedSessionMutationsRef.current = failedSessionMutationsRef.current.filter((failed) =>
            !isFailedMutationReflected(failed, projectRef.current, result.project.project, localLineIdMapRef.current));
          if (!sessionSyncFailedRef.current) {
            const hasOtherLocalEdits = hadFailedMutations && failedSessionMutationsRef.current.length === 0 &&
              !areLocalEditsReflected(projectRef.current, result.project.project, localLineIdMapRef.current);
            if (hasOtherLocalEdits) sessionSyncFailedRef.current = true;
            sessionMutationFailedRef.current = failedSessionMutationsRef.current.length > 0 || hasOtherLocalEdits;
          }
        }
        projectRevisionRef.current = result.revision;
        setProjectRevision(result.revision);
        setPendingPageNumbers((current) => mergePendingPageNumbers(current, result.project.pendingPageImages));
        sessionProjectRef.current = result.project.project;
        setIsDirty(result.project.dirty || result.status === "revision_conflict" || sessionMutationFailedRef.current ||
          hasLaterLocalChanges() || pendingSessionMutationTokensRef.current.size > 1);
        onProjectDto?.(result.project);
        if (!canApplySessionResult(generation, projectSessionId)) {
          notify(null);
          return;
        }

        if (result.status === "revision_conflict") {
          sessionConflictRef.current = true;
          sessionSyncFailedRef.current = true;
          sessionMutationFailedRef.current = true;
          failedSessionMutationsRef.current.push({ mutation, clientLineId });
          sessionGenerationRef.current += 1;
          pendingSessionMutationTokensRef.current = new Set();
          queuedSessionMutationCountRef.current = 0;
          setIsDirty(true);
          reportSessionConflict(result.conflictingPaths);
          notify(result, true);
          return;
        }
        notify(result, true);
      })
      .catch((error) => {
        if (canApplySessionResult(generation, projectSessionId)) {
          failedSessionMutationsRef.current.push({ mutation, clientLineId });
          sessionMutationFailedRef.current = true;
          setStatusMessage(error instanceof Error ? error.message : "프로젝트 변경을 적용하지 못했습니다.");
        }
        notify(null);
      })
      .finally(() => {
        releasePendingSessionMutation(generation, token);
        if (
          !canApplySessionResult(generation, projectSessionId) ||
          pendingSessionMutationTokensRef.current.size !== 0 ||
          !sessionProjectRef.current ||
          sessionMutationFailedRef.current ||
          responseIsStale ||
          hasLaterLocalChanges()
        ) {
          return;
        }
        reconcileSessionProject(sessionProjectRef.current);
      });
    return true;
  }

  /** Serialize the explicit review with user edits without changing the revision seen at the click. */
  function queueCleanedAssetReview(args: {
    pageImageId: string;
    cleanedAssetId: string;
    expectedRevision: number;
  }): Promise<boolean> | null {
    const projectSessionId = projectSessionIdRef.current;
    const review = window.projectApi?.reviewCleanedAsset;
    if (!projectSessionId || !review || queuedSessionMutationCountRef.current > 0 ||
      sessionConflictRef.current || sessionMutationFailedRef.current ||
      (sessionStatusRef && sessionStatusRef.current !== "active") ||
      projectRevisionRef.current !== args.expectedRevision) return null;

    const generation = sessionGenerationRef.current;
    const projectId = projectRef.current.metadata.id;
    const baseline = sessionProjectRef.current;
    const token = ++nextSessionMutationTokenRef.current;
    trackPendingSessionMutation(token);
    const operation = sessionMutationQueueRef.current.catch(() => undefined).then(async () => {
      if (!canApplySessionResult(generation, projectSessionId) || projectRef.current.metadata.id !== projectId) return false;
      try {
        const result = await review({ projectSessionId, ...args });
        if (!canApplySessionResult(generation, projectSessionId) || projectRef.current.metadata.id !== projectId ||
          result.projectSessionId !== projectSessionId || result.project.project.metadata.id !== projectId ||
          result.project.revision < projectRevisionRef.current) return false;
        if (adoptRecoveryStatus(result.project) || result.project.revision === projectRevisionRef.current) return false;

        const local = projectRef.current;
        const hasLaterEdits = queuedSessionMutationCountRef.current > 1;
        if (!hasLaterEdits && local === baseline) {
          applySessionChange({ status: "applied", revision: result.project.revision, project: result.project });
        } else {
          projectRevisionRef.current = result.project.revision;
          setProjectRevision(result.project.revision);
          setPendingPageNumbers((current) => mergePendingPageNumbers(current, result.project.pendingPageImages));
          sessionProjectRef.current = result.project.project;
          onProjectDto?.(result.project);
          if (!canApplySessionResult(generation, projectSessionId)) return false;
          // Later queued edits will adopt a newer Main DTO. If there are only
          // unqueued local edits, merge this one confirmed field without replacing them.
          if (!hasLaterEdits) {
            const page = local.pageImages.find((item) => item.id === args.pageImageId);
            const inspection = page && inspectApprovedCleanedAsset(local, page);
            const saved = result.project.project.processing.pages.find((item) => item.pageImageId === args.pageImageId);
            if (inspection && inspection.status === "valid" && inspection.asset?.assetId === args.cleanedAssetId &&
              saved?.userReviewedCleanedAssetId === args.cleanedAssetId) {
              const next = {
                ...local,
                processing: {
                  ...local.processing,
                  pages: local.processing.pages.map((item) => item.pageImageId === args.pageImageId
                    ? { ...item, userReviewedCleanedAssetId: args.cleanedAssetId }
                    : item)
                }
              };
              projectRef.current = next;
              setProject(next);
            }
            setIsDirty(true);
          }
        }
        setStatusMessage("배경 정리 확인을 저장했습니다. 다른 편집 내용은 별도로 저장하세요.");
        return true;
      } catch (error) {
        if (canApplySessionResult(generation, projectSessionId)) {
          const conflict = error instanceof Error && error.message.includes("REVISION_CONFLICT");
          setStatusMessage(conflict
            ? "프로젝트가 바뀌어 배경 확인을 저장하지 않았습니다. 현재 결과를 다시 확인하세요."
            : "배경 정리 확인을 저장하지 못했습니다. 현재 결과와 저장 상태를 다시 확인하세요.");
        }
        return false;
      }
    }).finally(() => releasePendingSessionMutation(generation, token));
    sessionMutationQueueRef.current = operation.then(() => undefined);
    return operation;
  }

  async function drainSessionMutationQueue(): Promise<void> {
    while (true) {
      const observed = sessionMutationQueueRef.current;
      await observed;
      if (observed === sessionMutationQueueRef.current) return;
    }
  }

  function queueProjectDiff(
    before: EditableTranslationProject,
    after: EditableTranslationProject
  ): void {
    if (before.metadata.title !== after.metadata.title) {
      queueSessionMutation({ type: "set_project_title", title: after.metadata.title });
    }
    const settingsPatch = Object.fromEntries(
      Object.entries(after.settings).filter(
        ([field, value]) => before.settings[field as keyof typeof before.settings] !== value
      )
    );
    if (Object.keys(settingsPatch).length > 0) {
      queueSessionMutation({ type: "update_project_settings", patch: settingsPatch });
    }

    const afterLineIds = new Set(after.dialogueLines.map((line) => line.id));
    for (const line of before.dialogueLines) {
      if (!afterLineIds.has(line.id)) {
        queueSessionMutation({ type: "remove_dialogue_line", lineId: line.id });
      }
    }
    for (const line of after.dialogueLines) {
      const previous = before.dialogueLines.find((candidate) => candidate.id === line.id);
      if (!previous) {
        queueSessionMutation({
          type: "add_dialogue_line",
          input: buildAddDialogueLineInput(line)
        }, line.id);
        continue;
      }
      const patch = buildDialogueUserPatch(previous, line);
      if (patch) {
        queueSessionMutation({ type: "update_dialogue_line", lineId: line.id, patch });
      }
      if (line.typesetting && typesettingNeedsUpdate(previous, line)) {
        queueSessionMutation({
          type: "update_dialogue_typesetting",
          lineId: line.id,
          typesetting: line.typesetting
        });
      }
    }
    if (
      after.dialogueLines.some((line, index) => before.dialogueLines[index]?.id !== line.id)
    ) {
      queueSessionMutation({
        type: "reorder_dialogue_lines",
        orderedLineIds: after.dialogueLines.map((line) => line.id)
      });
    }

    const afterCharacterIds = new Set(after.characters.map((character) => character.id));
    for (const character of before.characters) {
      if (!afterCharacterIds.has(character.id)) {
        queueSessionMutation({ type: "remove_character", characterId: character.id });
      }
    }
    for (const character of after.characters) {
      const previous = before.characters.find((candidate) => candidate.id === character.id);
      if (JSON.stringify(previous) !== JSON.stringify(character)) {
        queueSessionMutation({ type: "upsert_character", character });
      }
    }

    const afterTermIds = new Set(after.dictionaryTerms.map((term) => term.id));
    for (const term of before.dictionaryTerms) {
      if (!afterTermIds.has(term.id)) {
        queueSessionMutation({ type: "remove_dictionary_term", termId: term.id });
      }
    }
    for (const term of after.dictionaryTerms) {
      const previous = before.dictionaryTerms.find((candidate) => candidate.id === term.id);
      if (JSON.stringify(previous) !== JSON.stringify(term)) {
        queueSessionMutation({ type: "upsert_dictionary_term", term });
      }
    }
  }

  function syncProjectToSession(): Promise<boolean> {
    if (sessionConflictRef.current) {
      setStatusMessage(sessionConflictMessageRef.current);
      return Promise.resolve(false);
    }
    const sessionId = projectSessionIdRef.current;
    const generation = sessionGenerationRef.current;
    const desiredProject = projectRef.current;
    // Keep later user mutations behind every mutation in this sync.
    const operation = sessionMutationQueueRef.current.catch(() => undefined).then(() =>
      syncProjectToSessionInQueue(sessionId, generation, desiredProject)
    ).then((synced) => {
      if (!synced && sessionId && canApplySessionResult(generation, sessionId)) {
        sessionSyncFailedRef.current = true;
        sessionMutationFailedRef.current = true;
      }
      return synced;
    }, (error: unknown) => {
      if (sessionId && canApplySessionResult(generation, sessionId)) {
        sessionSyncFailedRef.current = true;
        sessionMutationFailedRef.current = true;
      }
      throw error;
    });
    sessionMutationQueueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function syncProjectToSessionInQueue(
    sessionId: string | null,
    sessionGeneration: number,
    localDesiredProject: EditableTranslationProject
  ): Promise<boolean> {
    const api = window.projectApi;
    const baseline = sessionProjectRef.current;
    const applyProjectMutation = api?.applyProjectMutation;
    if (!sessionId || !applyProjectMutation || !baseline || sessionConflictRef.current ||
      !canApplySessionResult(sessionGeneration, sessionId)) return false;
    const activeSessionId = sessionId;
    const invokeMutation = applyProjectMutation;
    const sessionLineIds = localLineIdMapRef.current.size === 0
      ? null
      : new Set(baseline.dialogueLines.map((line) => line.id));
    const desiredProject = localLineIdMapRef.current.size === 0 ? localDesiredProject : {
      ...localDesiredProject,
      dialogueLines: localDesiredProject.dialogueLines.map((line) => {
        const mainId = localLineIdMapRef.current.get(line.id);
        return mainId && sessionLineIds?.has(mainId) ? { ...line, id: mainId } : line;
      })
    };
    let revision = projectRevisionRef.current;
    let working = baseline;
    const addedLineIds = new Map<string, string>();

    function isCurrentSyncSession(): boolean {
      return !sessionConflictRef.current && canApplySessionResult(sessionGeneration, activeSessionId);
    }

    async function applyMutation(mutation: ProjectMutation): Promise<boolean> {
      if (!isCurrentSyncSession()) return false;
      const result = await invokeMutation({
        projectSessionId: activeSessionId,
        baseRevision: revision,
        mutation
      });
      if (!isCurrentSyncSession()) return false;
      if (result.revision < projectRevisionRef.current) return false;
      if (adoptRecoveryStatus(result.project)) return false;
      projectRevisionRef.current = result.revision;
      setProjectRevision(result.revision);
      setPendingPageNumbers((current) => mergePendingPageNumbers(current, result.project.pendingPageImages));
      sessionProjectRef.current = result.project.project;
      setIsDirty(true);
      onProjectDto?.(result.project);
      if (!isCurrentSyncSession()) return false;
      if (result.status === "revision_conflict") {
        sessionConflictRef.current = true;
        sessionSyncFailedRef.current = true;
        sessionMutationFailedRef.current = true;
        sessionGenerationRef.current += 1;
        pendingSessionMutationTokensRef.current = new Set();
        queuedSessionMutationCountRef.current = 0;
        reportSessionConflict(result.conflictingPaths);
        return false;
      }
      revision = result.revision;
      working = result.project.project;
      return true;
    }

    if (
      baseline.metadata.title !== desiredProject.metadata.title &&
      !(await applyMutation({ type: "set_project_title", title: desiredProject.metadata.title }))
    ) return false;

    const settingsPatch = Object.fromEntries(
      Object.entries(desiredProject.settings).filter(
        ([field, value]) => baseline.settings[field as keyof typeof baseline.settings] !== value
      )
    );
    if (
      Object.keys(settingsPatch).length > 0 &&
      !(await applyMutation({
        type: "update_project_settings",
        patch: settingsPatch
      }))
    ) return false;

    const desiredLineIds = new Set(desiredProject.dialogueLines.map((line) => line.id));
    for (const line of baseline.dialogueLines) {
      if (
        !desiredLineIds.has(line.id) &&
        !(await applyMutation({ type: "remove_dialogue_line", lineId: line.id }))
      ) return false;
    }

    for (const line of desiredProject.dialogueLines) {
      const previous = baseline.dialogueLines.find((candidate) => candidate.id === line.id);
      if (!previous) {
        const lineIdBeforeAdd = line.id;
        const previousIds = new Set(working.dialogueLines.map((entry) => entry.id));
        const ok = await applyMutation({
          type: "add_dialogue_line",
          input: buildAddDialogueLineInput(line)
        });
        if (!ok) return false;
        const added = working.dialogueLines.find(
          (candidate) =>
            !previousIds.has(candidate.id) &&
            candidate.origin.kind === "manual" &&
            candidate.pageNumber === line.pageNumber &&
            candidate.sourceLanguage === line.sourceLanguage &&
            candidate.sourceText === line.sourceText &&
            candidate.dialogueType === line.dialogueType
        );
        if (added) {
          addedLineIds.set(lineIdBeforeAdd, added.id);
          localLineIdMapRef.current.set(lineIdBeforeAdd, added.id);
        }
        continue;
      }
      const patch = buildDialogueUserPatch(previous, line);
      if (
        patch &&
        !(await applyMutation({ type: "update_dialogue_line", lineId: line.id, patch }))
      ) return false;
      if (
        line.typesetting &&
        typesettingNeedsUpdate(previous, line) &&
        !(await applyMutation({
          type: "update_dialogue_typesetting",
          lineId: line.id,
          typesetting: line.typesetting
        }))
      ) return false;
    }

    const desiredOrder = desiredProject.dialogueLines.map((line) => addedLineIds.get(line.id) ?? line.id);
    if (
      desiredOrder.some((lineId, index) => working.dialogueLines[index]?.id !== lineId) &&
      !(await applyMutation({ type: "reorder_dialogue_lines", orderedLineIds: desiredOrder }))
    ) return false;

    const desiredCharacterIds = new Set(desiredProject.characters.map((character) => character.id));
    for (const character of baseline.characters) {
      if (
        !desiredCharacterIds.has(character.id) &&
        !(await applyMutation({ type: "remove_character", characterId: character.id }))
      ) return false;
    }
    for (const character of desiredProject.characters) {
      const previous = baseline.characters.find((candidate) => candidate.id === character.id);
      if (
        JSON.stringify(previous) !== JSON.stringify(character) &&
        !(await applyMutation({ type: "upsert_character", character }))
      ) return false;
    }

    const desiredTermIds = new Set(desiredProject.dictionaryTerms.map((term) => term.id));
    for (const term of baseline.dictionaryTerms) {
      if (
        !desiredTermIds.has(term.id) &&
        !(await applyMutation({ type: "remove_dictionary_term", termId: term.id }))
      ) return false;
    }
    for (const term of desiredProject.dictionaryTerms) {
      const previous = baseline.dictionaryTerms.find((candidate) => candidate.id === term.id);
      if (
        JSON.stringify(previous) !== JSON.stringify(term) &&
        !(await applyMutation({ type: "upsert_dictionary_term", term }))
      ) return false;
    }

    if (!isCurrentSyncSession()) return false;
    const mustVerifyLocalEdits = sessionMutationFailedRef.current || sessionSyncFailedRef.current ||
      failedSessionMutationsRef.current.length > 0;
    failedSessionMutationsRef.current = failedSessionMutationsRef.current.filter((failed) =>
      !isFailedMutationReflected(failed, localDesiredProject, working, localLineIdMapRef.current));
    if (failedSessionMutationsRef.current.length > 0 ||
      (mustVerifyLocalEdits && !areLocalEditsReflected(localDesiredProject, working, localLineIdMapRef.current))) {
      setStatusMessage("일부 프로젝트 변경을 동기화하지 못해 저장을 중단했습니다. 변경 내용을 확인하세요.");
      return false;
    }
    sessionMutationFailedRef.current = false;
    sessionSyncFailedRef.current = false;
    if (isCurrentSyncSession() && projectRef.current === localDesiredProject && queuedSessionMutationCountRef.current === 0) {
      reconcileSessionProject(working);
    }
    return true;
  }

  function resetSessionMutationState(nextSnapshot: TranslationProjectV2 | null = null) {
    sessionProjectRef.current = nextSnapshot;
    sessionGenerationRef.current += 1;
    pendingSessionMutationTokensRef.current = new Set();
    queuedSessionMutationCountRef.current = 0;
    localLineIdMapRef.current.clear();
    sessionConflictRef.current = false;
    sessionConflictMessageRef.current = "";
    sessionMutationFailedRef.current = false;
    sessionSyncFailedRef.current = false;
    failedSessionMutationsRef.current = [];
    sessionMutationQueueRef.current = Promise.resolve();
  }

  return {
    sessionProjectRef,
    sessionMutationQueueRef,
    queuedSessionMutationCountRef,
    sessionGenerationRef,
    localLineIdMapRef,
    sessionConflictRef,
    sessionMutationFailedRef,
    lockSessionConflict,
    applySessionChange,
    queueSessionMutation,
    queueCleanedAssetReview,
    drainSessionMutationQueue,
    queueProjectDiff,
    syncProjectToSession,
    resetSessionMutationState
  };
}
