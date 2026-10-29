import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useInpaintingWorkflow } from "../../src/renderer/useInpaintingWorkflow.js";
import { useOcrWorkflow } from "../../src/renderer/useOcrWorkflow.js";
import { useProjectSession } from "../../src/renderer/useProjectSession.js";
import { useProjectSetup } from "../../src/renderer/useProjectSetup.js";
import { useTranslationWorkflow } from "../../src/renderer/useTranslationWorkflow.js";
import { useWorkspaceState } from "../../src/renderer/useWorkspaceState.js";
import {
  useSessionMutationQueue,
  remapLocalDialogueIds,
  mergePendingPageNumbers
} from "../../src/renderer/useSessionMutationQueue.js";
import { useProjectSaveWorkflow } from "../../src/renderer/useProjectSaveWorkflow.js";
import { createEmptyProject } from "../../src/shared/projectValidation.js";
import type { EditableTranslationProject, TranslationProjectV2 } from "../../src/shared/projectTypes.js";

describe("Modular App Workflow Hooks", () => {
  describe("useProjectSetup", () => {
    it("initializes and handles preparation and reset", () => {
      const { result } = renderHook(() => useProjectSetup());

      expect(result.current.projectSetup.isPreparing).toBe(false);
      expect(result.current.projectSetup.files).toEqual([]);

      let token = 0;
      act(() => {
        token = result.current.startPreparingProjectSetup();
      });
      expect(result.current.projectSetup.isPreparing).toBe(true);

      act(() => {
        result.current.finishPreparingProjectSetup(token);
      });
      expect(result.current.projectSetup.isPreparing).toBe(false);

      act(() => {
        result.current.setProjectSetupStoragePath("/test/path");
        result.current.setProjectSetupMode("fast");
      });
      expect(result.current.projectSetupStoragePath).toBe("/test/path");
      expect(result.current.projectSetup.mode).toBe("fast");

      act(() => {
        result.current.resetProjectSetup();
      });
      expect(result.current.projectSetupStoragePath).toBeNull();
      expect(result.current.projectSetup.files).toEqual([]);
    });
  });

  describe("useOcrWorkflow", () => {
    it("opens and manages OCR review modal items", () => {
      const { result } = renderHook(() => useOcrWorkflow());

      expect(result.current.isOcrReviewOpen).toBe(false);

      const mockItems = [
        {
          id: "b1",
          text: "こんにちは",
          readingOrder: 1,
          confidence: 0.95,
          notes: "",
          bbox: { x: 10, y: 10, width: 50, height: 50 },
          language: "ja" as const,
          textType: "speech_bubble" as const,
          speakerCandidates: [],
          selectedSpeaker: ""
        }
      ];

      act(() => {
        result.current.openOcrReview(mockItems, 1, "b1");
      });

      expect(result.current.isOcrReviewOpen).toBe(true);
      expect(result.current.ocrReviewPageNumber).toBe(1);
      expect(result.current.ocrSelectedBubbleId).toBe("b1");
      expect(result.current.ocrReviewItems).toHaveLength(1);

      act(() => {
        result.current.updateOcrReviewItem("b1", { text: "おはよう" });
      });
      expect(result.current.ocrReviewItems[0]?.text).toBe("おはよう");

      act(() => {
        result.current.closeOcrReview();
      });
      expect(result.current.isOcrReviewOpen).toBe(false);
      expect(result.current.ocrReviewItems).toHaveLength(0);
    });
  });

  describe("useTranslationWorkflow", () => {
    it("tracks in-flight translation and errors", () => {
      const { result } = renderHook(() => useTranslationWorkflow());

      expect(result.current.isTranslating).toBe(false);

      act(() => {
        result.current.startTranslation("line-42");
      });
      expect(result.current.isTranslating).toBe(true);
      expect(result.current.translatingLineId).toBe("line-42");

      act(() => {
        result.current.failTranslation("Rate limit exceeded");
      });
      expect(result.current.isTranslating).toBe(false);
      expect(result.current.translatingLineId).toBeNull();
      expect(result.current.translationError).toBe("Rate limit exceeded");

      act(() => {
        result.current.resetTranslationState();
      });
      expect(result.current.translationError).toBeNull();
    });
  });

  describe("useInpaintingWorkflow", () => {
    it("manages inpainting draft context and per-page result map", () => {
      const { result } = renderHook(() => useInpaintingWorkflow());

      expect(result.current.selectedInpaintingProvider).toBe("gemini");

      act(() => {
        result.current.setSelectedInpaintingProvider("local-lama");
        result.current.setPageResultContext("page-img-1", {
          original: {
            id: "page-img-1",
            pageNumber: 1,
            storedRelativePath: "pages/1.png",
            originalFileName: "1.png",
            sha256: "abc",
            byteSize: 100,
            mimeType: "image/png",
            copiedAt: "2026-08-27T00:00:00.000Z"
          }
        });
      });

      expect(result.current.selectedInpaintingProvider).toBe("local-lama");
      expect(result.current.pageResultContexts["page-img-1"]?.original?.storedRelativePath).toBe("pages/1.png");

      act(() => {
        result.current.clearInpaintingWorkflow();
      });
      expect(result.current.isInpaintingRunning).toBe(false);
    });
  });

  describe("useWorkspaceState", () => {
    it("switches panels, pages, selection, and resets cleanly", () => {
      const { result } = renderHook(() => useWorkspaceState());

      expect(result.current.bottomPanel).toBe("dialogue");
      expect(result.current.selectedPageNumber).toBe(1);
      expect(result.current.selectedLineId).toBeNull();

      act(() => {
        result.current.setBottomPanel("issues");
        result.current.setSelectedPageNumber(3);
        result.current.setSelectedLineId("line-9");
        result.current.setGuidanceDensity("compact");
      });

      expect(result.current.bottomPanel).toBe("issues");
      expect(result.current.selectedPageNumber).toBe(3);
      expect(result.current.selectedLineId).toBe("line-9");
      expect(result.current.guidanceDensity).toBe("compact");

      act(() => {
        result.current.resetWorkspaceState();
      });

      expect(result.current.bottomPanel).toBe("dialogue");
      expect(result.current.selectedPageNumber).toBe(1);
      expect(result.current.selectedLineId).toBeNull();
      expect(result.current.guidanceDensity).toBe("guided");
    });
  });

  describe("useProjectSession", () => {
    it("tracks project session IDs, file path, revisions, and clearing", () => {
      const { result } = renderHook(() => useProjectSession());

      expect(result.current.projectSessionId).toBeNull();
      expect(result.current.sessionRevision).toBe(1);

      act(() => {
        result.current.setProjectSessionId("session-123");
        result.current.setActiveProjectFilePath("/path/to/project.ctp");
        result.current.setRecentProjectId("recent-456");
        result.current.incrementRevision();
      });

      expect(result.current.projectSessionId).toBe("session-123");
      expect(result.current.activeProjectFilePath).toBe("/path/to/project.ctp");
      expect(result.current.recentProjectId).toBe("recent-456");
      expect(result.current.sessionRevision).toBe(2);

      act(() => {
        result.current.clearProjectSession();
      });
      expect(result.current.projectSessionId).toBeNull();
      expect(result.current.activeProjectFilePath).toBeNull();
      expect(result.current.recentProjectId).toBeNull();
      expect(result.current.sessionRevision).toBe(1);
    });
  });

  describe("useSessionMutationQueue", () => {
    it("remaps local dialogue IDs correctly", () => {
      const localMap = new Map([["local-1", "server-1"], ["local-2", "server-2"]]);
      expect(remapLocalDialogueIds({ type: "remove_dialogue_line", lineId: "local-1" }, localMap)).toEqual({
        type: "remove_dialogue_line",
        lineId: "server-1"
      });
      expect(remapLocalDialogueIds({ type: "reorder_dialogue_lines", orderedLineIds: ["local-1", "other", "local-2"] }, localMap)).toEqual({
        type: "reorder_dialogue_lines",
        orderedLineIds: ["server-1", "other", "server-2"]
      });
      expect(remapLocalDialogueIds({
        type: "update_dialogue_typesetting",
        lineId: "local-1",
        typesetting: { bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, writingMode: "horizontal-tb" }
      }, localMap)).toEqual({
        type: "update_dialogue_typesetting",
        lineId: "server-1",
        typesetting: { bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, writingMode: "horizontal-tb" }
      });
    });

    it("merges pending page numbers with deduplication", () => {
      expect(mergePendingPageNumbers([1, 2], [{ pageNumber: 2 }, { pageNumber: 3 }])).toEqual([1, 2, 3]);
    });

    it("queues and drains mutations through applyProjectMutation", async () => {
      const initialProject = createEmptyProject("Test Project", false);
      const projectRef = { current: initialProject };
      const selectedLineIdRef = { current: null };
      const projectSessionIdRef = { current: "session-abc" };
      const projectRevisionRef = { current: 1 };
      const setProjectRevision = vi.fn();
      const setProject = vi.fn();
      const setSelectedLineId = vi.fn();
      const setPendingPageNumbers = vi.fn();
      const setIsDirty = vi.fn();
      const setStatusMessage = vi.fn();

      const mockApply = vi.fn().mockResolvedValue({
        status: "applied",
        revision: 2,
        project: {
          project: { ...initialProject, metadata: { ...initialProject.metadata, title: "Updated" } },
          revision: 2,
          dirty: true,
          pendingPageImages: []
        }
      });
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      const { result } = renderHook(() =>
        useSessionMutationQueue({
          projectSessionIdRef,
          projectRevisionRef,
          setProjectRevision,
          projectRef,
          setProject,
          selectedLineIdRef,
          setSelectedLineId,
          setPendingPageNumbers,
          setIsDirty,
          setStatusMessage
        })
      );

      act(() => {
        result.current.queueSessionMutation({ type: "set_project_title", title: "Updated" });
      });

      await act(async () => {
        await result.current.drainSessionMutationQueue();
      });

      expect(mockApply).toHaveBeenCalledWith({
        projectSessionId: "session-abc",
        baseRevision: 1,
        mutation: { type: "set_project_title", title: "Updated" }
      });
      expect(setProjectRevision).toHaveBeenCalledWith(2);
      expect(setIsDirty).toHaveBeenCalledWith(true);
    });

    it("handles revision conflicts by resetting generation and notifying status", async () => {
      const initialProject = createEmptyProject("Test Project", false);
      const projectRef = { current: initialProject };
      const selectedLineIdRef = { current: null };
      const projectSessionIdRef = { current: "session-abc" };
      const projectRevisionRef = { current: 1 };
      const setProjectRevision = vi.fn();
      const setProject = vi.fn();
      const setSelectedLineId = vi.fn();
      const setPendingPageNumbers = vi.fn();
      const setIsDirty = vi.fn();
      const setStatusMessage = vi.fn();

      const mockApply = vi.fn().mockResolvedValue({
        status: "revision_conflict",
        revision: 3,
        conflictingPaths: ["dialogueLines"],
        project: {
          project: initialProject,
          revision: 3,
          dirty: false,
          pendingPageImages: []
        }
      });
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      const { result } = renderHook(() =>
        useSessionMutationQueue({
          projectSessionIdRef,
          projectRevisionRef,
          setProjectRevision,
          projectRef,
          setProject,
          selectedLineIdRef,
          setSelectedLineId,
          setPendingPageNumbers,
          setIsDirty,
          setStatusMessage
        })
      );

      const observer = vi.fn();
      act(() => {
        result.current.queueSessionMutation({ type: "set_project_title", title: "Conflict" }, undefined, observer);
      });

      await act(async () => {
        await result.current.drainSessionMutationQueue();
      });

      expect(result.current.sessionConflictRef.current).toBe(true);
      expect(setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("다른 변경과 충돌했습니다"));
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ status: "revision_conflict" }), true);
    });

    function asSessionProject(project: EditableTranslationProject): TranslationProjectV2 {
      return project as unknown as TranslationProjectV2;
    }

    function createAppliedMutationResult(
      project: EditableTranslationProject,
      revision: number,
      pendingPageImages: Array<{ pageNumber: number }> = []
    ) {
      return {
        status: "applied" as const,
        revision,
        project: {
          project: asSessionProject(project),
          revision,
          dirty: true,
          pendingPageImages,
          status: "active" as const
        }
      };
    }

    function createSessionMutationHarness(desiredProject: EditableTranslationProject) {
      const projectRef = { current: desiredProject };
      const selectedLineIdRef = { current: null as string | null };
      const projectSessionIdRef = { current: "session-a" as string | null };
      const projectRevisionRef = { current: 1 };
      const setProjectRevision = vi.fn((revision: number) => {
        projectRevisionRef.current = revision;
      });
      const setProject = vi.fn((next: EditableTranslationProject) => {
        projectRef.current = next;
      });
      const setSelectedLineId = vi.fn();
      const setPendingPageNumbers = vi.fn();
      const setIsDirty = vi.fn();
      const setStatusMessage = vi.fn();
      const { result } = renderHook(() =>
        useSessionMutationQueue({
          projectSessionIdRef,
          projectRevisionRef,
          setProjectRevision,
          projectRef,
          setProject,
          selectedLineIdRef,
          setSelectedLineId,
          setPendingPageNumbers,
          setIsDirty,
          setStatusMessage
        })
      );
      return {
        result,
        projectRef,
        projectSessionIdRef,
        projectRevisionRef,
        setProjectRevision,
        setProject,
        setPendingPageNumbers,
        setIsDirty,
        setStatusMessage
      };
    }

    it("does not apply a late syncProjectToSession mutation after the project session switches", async () => {
      const sessionABaseline = createEmptyProject("Project A", false);
      const desiredProjectA = {
        ...sessionABaseline,
        metadata: { ...sessionABaseline.metadata, title: "Project A Synced" }
      };
      const projectB = createEmptyProject("Project B", false);
      const harness = createSessionMutationHarness(desiredProjectA);
      const stalePendingPage = { pageNumber: 7 };
      const staleProject = {
        ...desiredProjectA,
        metadata: { ...desiredProjectA.metadata, title: "Project A From Main" }
      };
      let resolveMutation: ((value: unknown) => void) | undefined;
      const deferredMutation = new Promise((resolve) => {
        resolveMutation = resolve;
      });
      const mockApply = vi.fn().mockImplementation(() => deferredMutation);
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      act(() => {
        harness.result.current.sessionProjectRef.current = asSessionProject(sessionABaseline);
      });

      let syncPromise: Promise<boolean> = Promise.resolve(false);
      await act(async () => {
        syncPromise = harness.result.current.syncProjectToSession();
        await Promise.resolve();
      });

      expect(mockApply).toHaveBeenCalledTimes(1);
      expect(mockApply).toHaveBeenCalledWith({
        projectSessionId: "session-a",
        baseRevision: 1,
        mutation: { type: "set_project_title", title: "Project A Synced" }
      });

      harness.projectSessionIdRef.current = "session-b";
      harness.result.current.sessionGenerationRef.current += 1;
      harness.projectRevisionRef.current = 10;
      harness.projectRef.current = projectB;
      harness.result.current.sessionProjectRef.current = asSessionProject(projectB);
      harness.setProject.mockClear();
      harness.setProjectRevision.mockClear();
      harness.setPendingPageNumbers.mockClear();
      harness.setIsDirty.mockClear();

      let synced = true;
      await act(async () => {
        resolveMutation!(createAppliedMutationResult(staleProject, 2, [stalePendingPage]));
        synced = await syncPromise;
      });

      expect(synced).toBe(false);
      expect(harness.setProject).not.toHaveBeenCalled();
      expect(harness.setProjectRevision).not.toHaveBeenCalled();
      expect(harness.setPendingPageNumbers).not.toHaveBeenCalled();
      expect(harness.setIsDirty).not.toHaveBeenCalled();
      expect(harness.projectRevisionRef.current).toBe(10);
      expect(harness.projectRef.current).toBe(projectB);
      expect(harness.result.current.sessionProjectRef.current).toBe(projectB);
    });

    it("does not apply a late sync mutation after sessionGeneration changes with the same session id", async () => {
      const sessionABaseline = createEmptyProject("Project A", false);
      const desiredProjectA = {
        ...sessionABaseline,
        metadata: { ...sessionABaseline.metadata, title: "Project A Synced" }
      };
      const resetSnapshot = createEmptyProject("Reset Snapshot", false);
      const harness = createSessionMutationHarness(desiredProjectA);
      let resolveMutation: ((value: unknown) => void) | undefined;
      const deferredMutation = new Promise((resolve) => {
        resolveMutation = resolve;
      });
      const mockApply = vi.fn().mockImplementation(() => deferredMutation);
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      act(() => {
        harness.result.current.sessionProjectRef.current = asSessionProject(sessionABaseline);
      });

      let syncPromise: Promise<boolean> = Promise.resolve(false);
      await act(async () => {
        syncPromise = harness.result.current.syncProjectToSession();
        await Promise.resolve();
      });

      expect(mockApply).toHaveBeenCalledTimes(1);
      harness.result.current.sessionGenerationRef.current += 1;
      harness.projectRevisionRef.current = 10;
      harness.projectRef.current = resetSnapshot;
      harness.result.current.sessionProjectRef.current = asSessionProject(resetSnapshot);
      harness.setProject.mockClear();
      harness.setProjectRevision.mockClear();
      harness.setPendingPageNumbers.mockClear();

      let synced = true;
      await act(async () => {
        resolveMutation!(createAppliedMutationResult(desiredProjectA, 2, [{ pageNumber: 3 }]));
        synced = await syncPromise;
      });

      expect(synced).toBe(false);
      expect(harness.setProject).not.toHaveBeenCalled();
      expect(harness.setProjectRevision).not.toHaveBeenCalled();
      expect(harness.setPendingPageNumbers).not.toHaveBeenCalled();
      expect(harness.projectSessionIdRef.current).toBe("session-a");
      expect(harness.projectRevisionRef.current).toBe(10);
      expect(harness.projectRef.current).toBe(resetSnapshot);
      expect(harness.result.current.sessionProjectRef.current).toBe(resetSnapshot);
    });

    it("includes typesetting when queueProjectDiff adds a new OCR dialogue line", async () => {
      const baseline = createEmptyProject("Typeset add", false);
      const typesetting = {
        bbox: { x: 0.22, y: 0.31, width: 0.18, height: 0.09 },
        writingMode: "vertical-rl" as const,
        rotationDegrees: 12,
        shape: "cloud" as const
      };
      const desired = {
        ...baseline,
        dialogueLines: [{
          id: "ocr-line-1",
          order: 1,
          pageNumber: 1,
          dialogueType: "speech" as const,
          lineStatus: "untranslated" as const,
          sourceLanguage: "ja" as const,
          sourceText: "こんにちは",
          parseConfidence: 1,
          parseWarnings: [],
          origin: { kind: "manual" as const },
          typesetting
        }]
      };
      const harness = createSessionMutationHarness(desired);
      const mockApply = vi.fn().mockResolvedValue(createAppliedMutationResult(desired, 2));
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      act(() => {
        harness.result.current.sessionProjectRef.current = asSessionProject(baseline);
      });
      act(() => {
        harness.result.current.queueProjectDiff(baseline, desired);
      });
      await act(async () => {
        await harness.result.current.drainSessionMutationQueue();
      });

      expect(mockApply).toHaveBeenCalledWith({
        projectSessionId: "session-a",
        baseRevision: 1,
        mutation: {
          type: "add_dialogue_line",
          input: expect.objectContaining({
            sourceText: "こんにちは",
            typesetting
          })
        }
      });
    });

    it("syncs an existing line typesetting change through update_dialogue_typesetting", async () => {
      const baseline = createEmptyProject("Typeset sync", false);
      baseline.dialogueLines = [{
        id: "line-typeset",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        lineStatus: "untranslated",
        sourceLanguage: "ja",
        sourceText: "原文",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" },
        typesetting: {
          bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
          writingMode: "horizontal-tb"
        }
      }];
      const desired = {
        ...baseline,
        dialogueLines: [{
          ...baseline.dialogueLines[0]!,
          typesetting: {
            bbox: { x: 0.16, y: 0.12, width: 0.18, height: 0.11 },
            writingMode: "vertical-rl" as const,
            rotationDegrees: 8,
            shape: "rectangle" as const
          }
        }]
      };
      const harness = createSessionMutationHarness(desired);
      const mockApply = vi.fn().mockResolvedValue(createAppliedMutationResult(desired, 2));
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      act(() => {
        harness.result.current.sessionProjectRef.current = asSessionProject(baseline);
      });

      let synced = false;
      await act(async () => {
        synced = await harness.result.current.syncProjectToSession();
      });

      expect(synced).toBe(true);
      expect(mockApply).toHaveBeenCalledWith({
        projectSessionId: "session-a",
        baseRevision: 1,
        mutation: {
          type: "update_dialogue_typesetting",
          lineId: "line-typeset",
          typesetting: desired.dialogueLines[0]!.typesetting
        }
      });
    });

    it("queues a pageNumber update when queueProjectDiff sees a moved dialogue line", async () => {
      const baseline = createEmptyProject("Page diff", false);
      baseline.dialogueLines = [{
        id: "line-page-edit",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        lineStatus: "untranslated",
        sourceLanguage: "en",
        sourceText: "Move me",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      }];
      const desired = {
        ...baseline,
        dialogueLines: [{ ...baseline.dialogueLines[0]!, pageNumber: 2 }]
      };
      const harness = createSessionMutationHarness(desired);
      const mockApply = vi.fn().mockResolvedValue(createAppliedMutationResult(desired, 2));
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      act(() => {
        harness.result.current.sessionProjectRef.current = asSessionProject(baseline);
      });
      act(() => {
        harness.result.current.queueProjectDiff(baseline, desired);
      });
      await act(async () => {
        await harness.result.current.drainSessionMutationQueue();
      });

      expect(mockApply).toHaveBeenCalledWith({
        projectSessionId: "session-a",
        baseRevision: 1,
        mutation: {
          type: "update_dialogue_line",
          lineId: "line-page-edit",
          patch: { pageNumber: 2 }
        }
      });
    });

    it("syncs a renderer pageNumber change through syncProjectToSession", async () => {
      const baseline = createEmptyProject("Page sync", false);
      baseline.dialogueLines = [{
        id: "line-page-edit",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        lineStatus: "untranslated",
        sourceLanguage: "en",
        sourceText: "Move me",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      }];
      const desired = {
        ...baseline,
        dialogueLines: [{ ...baseline.dialogueLines[0]!, pageNumber: 2 }]
      };
      const harness = createSessionMutationHarness(desired);
      const mockApply = vi.fn().mockResolvedValue(createAppliedMutationResult(desired, 2));
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      act(() => {
        harness.result.current.sessionProjectRef.current = asSessionProject(baseline);
      });

      let synced = false;
      await act(async () => {
        synced = await harness.result.current.syncProjectToSession();
      });

      expect(synced).toBe(true);
      expect(mockApply).toHaveBeenCalledWith({
        projectSessionId: "session-a",
        baseRevision: 1,
        mutation: {
          type: "update_dialogue_line",
          lineId: "line-page-edit",
          patch: { pageNumber: 2 }
        }
      });
    });

    it("applies syncProjectToSession mutations when the session stays current", async () => {
      const sessionABaseline = createEmptyProject("Project A", false);
      const desiredProjectA = {
        ...sessionABaseline,
        metadata: { ...sessionABaseline.metadata, title: "Project A Synced" }
      };
      const harness = createSessionMutationHarness(desiredProjectA);
      const appliedProject = {
        ...desiredProjectA,
        metadata: { ...desiredProjectA.metadata, title: "Project A Synced" }
      };
      const mockApply = vi.fn().mockResolvedValue(createAppliedMutationResult(appliedProject, 2, [{ pageNumber: 2 }]));
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      act(() => {
        harness.result.current.sessionProjectRef.current = asSessionProject(sessionABaseline);
      });

      let synced = false;
      await act(async () => {
        synced = await harness.result.current.syncProjectToSession();
      });

      expect(synced).toBe(true);
      expect(mockApply).toHaveBeenCalledTimes(1);
      expect(harness.setProject).toHaveBeenCalledWith(appliedProject);
      expect(harness.setProjectRevision).toHaveBeenCalledWith(2);
      expect(harness.setPendingPageNumbers).toHaveBeenCalled();
      expect(harness.projectRevisionRef.current).toBe(2);
      expect(harness.projectRef.current).toBe(appliedProject);
      expect(harness.result.current.sessionProjectRef.current).toBe(appliedProject);
    });

    it("does not send remaining sync mutations after the session switches following the first response", async () => {
      const sessionABaseline = createEmptyProject("Project A", false);
      const desiredProjectA = {
        ...sessionABaseline,
        metadata: { ...sessionABaseline.metadata, title: "Project A Synced" },
        settings: { ...sessionABaseline.settings, defaultSourceLanguage: "ja" as const },
        characters: [{ id: "char-1", name: "Hero", aliases: [] }]
      };
      const projectB = createEmptyProject("Project B", false);
      const harness = createSessionMutationHarness(desiredProjectA);
      const deferredResolvers: Array<(value: unknown) => void> = [];
      const mockApply = vi.fn().mockImplementation(() =>
        new Promise((resolve) => {
          deferredResolvers.push(resolve);
        })
      );
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      act(() => {
        harness.result.current.sessionProjectRef.current = asSessionProject(sessionABaseline);
      });

      let syncPromise: Promise<boolean> = Promise.resolve(false);
      await act(async () => {
        syncPromise = harness.result.current.syncProjectToSession();
        await Promise.resolve();
      });

      expect(mockApply).toHaveBeenCalledTimes(1);
      expect(mockApply.mock.calls[0]?.[0]).toEqual({
        projectSessionId: "session-a",
        baseRevision: 1,
        mutation: { type: "set_project_title", title: "Project A Synced" }
      });

      const titleSyncedProject = {
        ...sessionABaseline,
        metadata: { ...sessionABaseline.metadata, title: "Project A Synced" }
      };
      await act(async () => {
        deferredResolvers[0]!(createAppliedMutationResult(titleSyncedProject, 2));
        await Promise.resolve();
      });

      // A partial sync must not replace the still-unsynchronized local settings
      // and character edits, even though Main has advanced to the new revision.
      expect(harness.setProject).not.toHaveBeenCalled();
      expect(harness.projectRef.current).toBe(desiredProjectA);
      expect(harness.result.current.sessionProjectRef.current).toEqual(titleSyncedProject);
      expect(harness.projectRevisionRef.current).toBe(2);
      expect(mockApply).toHaveBeenCalledTimes(2);
      expect(mockApply.mock.calls[1]?.[0]).toEqual({
        projectSessionId: "session-a",
        baseRevision: 2,
        mutation: {
          type: "update_project_settings",
          patch: { defaultSourceLanguage: "ja" }
        }
      });

      harness.projectSessionIdRef.current = "session-b";
      harness.result.current.sessionGenerationRef.current += 1;
      harness.projectRevisionRef.current = 10;
      harness.projectRef.current = projectB;
      harness.result.current.sessionProjectRef.current = asSessionProject(projectB);
      harness.setProject.mockClear();
      harness.setProjectRevision.mockClear();
      harness.setPendingPageNumbers.mockClear();
      harness.setIsDirty.mockClear();

      const staleSettingsProject = {
        ...titleSyncedProject,
        settings: { ...titleSyncedProject.settings, defaultSourceLanguage: "ja" as const }
      };
      let synced = true;
      await act(async () => {
        deferredResolvers[1]!(createAppliedMutationResult(staleSettingsProject, 3, [{ pageNumber: 4 }]));
        await Promise.resolve();
        await Promise.resolve();
        for (let index = 2; index < deferredResolvers.length; index += 1) {
          deferredResolvers[index]!(createAppliedMutationResult(staleSettingsProject, 4 + index));
        }
        synced = await syncPromise;
      });

      expect(synced).toBe(false);
      expect(mockApply).toHaveBeenCalledTimes(2);
      expect(harness.setProject).not.toHaveBeenCalled();
      expect(harness.setProjectRevision).not.toHaveBeenCalled();
      expect(harness.setPendingPageNumbers).not.toHaveBeenCalled();
      expect(harness.setIsDirty).not.toHaveBeenCalled();
      expect(harness.projectRevisionRef.current).toBe(10);
      expect(harness.projectRef.current).toBe(projectB);
      expect(harness.result.current.sessionProjectRef.current).toBe(projectB);
    });

    it("does not let a previous generation finally change the next session pending count or reconciliation", async () => {
      const projectA = createEmptyProject("Project A", false);
      const projectB = createEmptyProject("Project B", false);
      const projectBUpdated = {
        ...projectB,
        metadata: { ...projectB.metadata, title: "Project B Updated" }
      };
      const harness = createSessionMutationHarness(projectA);
      let resolveA: ((value: unknown) => void) | undefined;
      let resolveB: ((value: unknown) => void) | undefined;
      const deferredA = new Promise((resolve) => {
        resolveA = resolve;
      });
      const deferredB = new Promise((resolve) => {
        resolveB = resolve;
      });
      const mockApply = vi.fn()
        .mockImplementationOnce(() => deferredA)
        .mockImplementationOnce(() => deferredB);
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      act(() => {
        harness.result.current.sessionProjectRef.current = asSessionProject(projectA);
      });
      act(() => {
        harness.result.current.queueSessionMutation({
          type: "set_project_title",
          title: "Project A Updated"
        });
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockApply).toHaveBeenCalledTimes(1);
      expect(harness.result.current.queuedSessionMutationCountRef.current).toBe(1);

      act(() => {
        harness.projectSessionIdRef.current = "session-b";
        harness.projectRevisionRef.current = 10;
        harness.projectRef.current = projectB;
        harness.result.current.resetSessionMutationState(asSessionProject(projectB));
      });
      expect(harness.result.current.queuedSessionMutationCountRef.current).toBe(0);

      act(() => {
        harness.result.current.queueSessionMutation({
          type: "set_project_title",
          title: "Project B Updated"
        });
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockApply).toHaveBeenCalledTimes(2);
      expect(harness.result.current.queuedSessionMutationCountRef.current).toBe(1);
      harness.setProject.mockClear();
      harness.setProjectRevision.mockClear();

      await act(async () => {
        resolveA!(createAppliedMutationResult({
          ...projectA,
          metadata: { ...projectA.metadata, title: "Project A From Main" }
        }, 2));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(harness.result.current.queuedSessionMutationCountRef.current).toBe(1);
      expect(harness.setProject).not.toHaveBeenCalled();
      expect(harness.projectRef.current).toBe(projectB);
      expect(harness.result.current.sessionProjectRef.current).toBe(projectB);

      await act(async () => {
        resolveB!(createAppliedMutationResult(projectBUpdated, 20));
        await harness.result.current.drainSessionMutationQueue();
      });

      expect(harness.result.current.queuedSessionMutationCountRef.current).toBe(0);
      expect(harness.setProject).toHaveBeenCalledWith(projectBUpdated);
      expect(harness.projectRef.current).toBe(projectBUpdated);
    });

    it("does not let a previous generation finally drive the next session pending count negative", async () => {
      const projectA = createEmptyProject("Project A", false);
      const projectB = createEmptyProject("Project B", false);
      const projectBUpdated = {
        ...projectB,
        metadata: { ...projectB.metadata, title: "Project B Updated" }
      };
      const harness = createSessionMutationHarness(projectA);
      let resolveA: ((value: unknown) => void) | undefined;
      let resolveB: ((value: unknown) => void) | undefined;
      const deferredA = new Promise((resolve) => {
        resolveA = resolve;
      });
      const deferredB = new Promise((resolve) => {
        resolveB = resolve;
      });
      const mockApply = vi.fn()
        .mockImplementationOnce(() => deferredA)
        .mockImplementationOnce(() => deferredB);
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      act(() => {
        harness.result.current.sessionProjectRef.current = asSessionProject(projectA);
      });
      act(() => {
        harness.result.current.queueSessionMutation({
          type: "set_project_title",
          title: "Project A Updated"
        });
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockApply).toHaveBeenCalledTimes(1);
      act(() => {
        harness.projectSessionIdRef.current = "session-b";
        harness.projectRevisionRef.current = 10;
        harness.projectRef.current = projectB;
        harness.result.current.resetSessionMutationState(asSessionProject(projectB));
      });
      act(() => {
        harness.result.current.queueSessionMutation({
          type: "set_project_title",
          title: "Project B Updated"
        });
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockApply).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveB!(createAppliedMutationResult(projectBUpdated, 20));
        await harness.result.current.drainSessionMutationQueue();
      });
      expect(harness.result.current.queuedSessionMutationCountRef.current).toBe(0);

      await act(async () => {
        resolveA!(createAppliedMutationResult(projectA, 2));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(harness.result.current.queuedSessionMutationCountRef.current).toBe(0);
    });

    it("does not apply a previous generation success, failure, or finally to the next session", async () => {
      const projectA = createEmptyProject("Project A", false);
      const projectB = createEmptyProject("Project B", false);
      const harness = createSessionMutationHarness(projectA);
      let rejectA: ((reason: unknown) => void) | undefined;
      const deferredA = new Promise((_resolve, reject) => {
        rejectA = reject;
      });
      const mockApply = vi.fn().mockImplementation(() => deferredA);
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      act(() => {
        harness.result.current.sessionProjectRef.current = asSessionProject(projectA);
      });
      act(() => {
        harness.result.current.queueSessionMutation({
          type: "set_project_title",
          title: "Project A Updated"
        });
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockApply).toHaveBeenCalledTimes(1);
      act(() => {
        harness.projectSessionIdRef.current = "session-b";
        harness.projectRevisionRef.current = 10;
        harness.projectRef.current = projectB;
        harness.result.current.resetSessionMutationState(asSessionProject(projectB));
      });
      harness.setProject.mockClear();
      harness.setStatusMessage.mockClear();

      await act(async () => {
        rejectA!(new Error("session A mutation failed"));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(harness.result.current.sessionMutationFailedRef.current).toBe(false);
      expect(harness.result.current.queuedSessionMutationCountRef.current).toBe(0);
      expect(harness.setProject).not.toHaveBeenCalled();
      expect(harness.setStatusMessage).not.toHaveBeenCalled();
      expect(harness.result.current.sessionProjectRef.current).toBe(projectB);
    });

    it("recovers renderer reconciliation after a later mutation succeeds in the same session", async () => {
      const baseline = createEmptyProject("Recoverable", false);
      const failedTitle = {
        ...baseline,
        metadata: { ...baseline.metadata, title: "Invalid" }
      };
      const recovered = {
        ...baseline,
        metadata: { ...baseline.metadata, title: "Recovered" }
      };
      const harness = createSessionMutationHarness(baseline);
      const mockApply = vi.fn()
        .mockRejectedValueOnce(new Error("transient mutation failure"))
        .mockResolvedValueOnce(createAppliedMutationResult(recovered, 3));
      window.projectApi = {
        ...window.projectApi,
        applyProjectMutation: mockApply
      } as any;

      act(() => {
        harness.result.current.sessionProjectRef.current = asSessionProject(baseline);
        harness.projectRef.current = failedTitle;
      });
      act(() => {
        harness.result.current.queueSessionMutation({
          type: "set_project_title",
          title: "Invalid"
        });
      });
      await act(async () => {
        await harness.result.current.drainSessionMutationQueue();
      });

      expect(harness.result.current.sessionMutationFailedRef.current).toBe(true);
      expect(harness.setStatusMessage).toHaveBeenCalledWith("transient mutation failure");
      expect(harness.projectRef.current).toBe(failedTitle);

      harness.setProject.mockClear();
      act(() => {
        harness.projectRef.current = recovered;
        harness.result.current.queueSessionMutation({
          type: "set_project_title",
          title: "Recovered"
        });
      });
      await act(async () => {
        await harness.result.current.drainSessionMutationQueue();
      });

      expect(harness.result.current.sessionMutationFailedRef.current).toBe(false);
      expect(harness.setProject).toHaveBeenCalledWith(recovered);
      expect(harness.projectRef.current).toBe(recovered);
      expect(harness.result.current.sessionProjectRef.current).toBe(recovered);
    });
  });

  describe("useProjectSaveWorkflow", () => {
    it("guards against in-flight concurrent saves", async () => {
      const initialProject = createEmptyProject("Save Test", false);
      const projectRef = { current: initialProject };
      const projectSessionIdRef = { current: "session-save" };
      const sessionGenerationRef = { current: 1 };
      const projectRevisionRef = { current: 1 };
      const sessionProjectRef = { current: initialProject as unknown as TranslationProjectV2 };
      const sessionConflictRef = { current: false };
      const initialSessionPromiseRef = { current: null };
      const drainSessionMutationQueue = vi.fn().mockResolvedValue(undefined);
      const syncProjectToSession = vi.fn().mockResolvedValue(true);
      const setProject = vi.fn();
      const setCurrentFilePath = vi.fn();
      const setProjectRevision = vi.fn();
      const setPendingPageNumbers = vi.fn();
      const setIsDirty = vi.fn();
      const setStatusMessage = vi.fn();
      const setRecentProjects = vi.fn();

      let resolveSave: (value: any) => void;
      const savePromise = new Promise((resolve) => {
        resolveSave = resolve;
      });
      const mockSave = vi.fn().mockImplementation(() => savePromise);

      window.projectApi = {
        ...window.projectApi,
        saveProject: mockSave,
        saveProjectAs: vi.fn(),
        applyProjectMutation: vi.fn()
      } as any;

      const { result } = renderHook(() =>
        useProjectSaveWorkflow({ requestPassword: vi.fn().mockResolvedValue(null),
          sessionPersistenceRequired: true,
          project: initialProject,
          setProject,
          projectRef,
          currentFilePath: "session:session-save",
          setCurrentFilePath,
          projectSessionIdRef,
          sessionGenerationRef,
          projectRevisionRef,
          setProjectRevision,
          setPendingPageNumbers,
          sessionProjectRef,
          sessionConflictRef,
          initialSessionPromiseRef,
          drainSessionMutationQueue,
          syncProjectToSession,
          setIsDirty,
          setStatusMessage,
          setRecentProjects
        })
      );

      // Trigger first save
      const p1 = result.current.saveProject();
      expect(result.current.saveInFlightRef.current).toBe(true);

      // Trigger second save while first is in flight
      const p2 = result.current.saveProject();

      // Let save proceed
      resolveSave!({
        project: {
          project: initialProject,
          revision: 2,
          dirty: false,
          pendingPageImages: []
        }
      });
      await act(async () => {
        await Promise.all([p1, p2]);
      });

      expect(result.current.saveInFlightRef.current).toBe(false);
      expect(mockSave).toHaveBeenCalledTimes(1);
    });

    function createPersistentSaveHarness(options?: {
      drainSessionMutationQueue?: () => Promise<void>;
      initialSessionPromise?: Promise<unknown> | null;
    }) {
      const projectA = createEmptyProject("Project A", false);
      const projectRef = { current: projectA };
      const projectSessionIdRef = { current: "session-a" as string | null };
      const sessionGenerationRef = { current: 1 };
      const projectRevisionRef = { current: 1 };
      const sessionProjectRef = { current: projectA as unknown as TranslationProjectV2 };
      const sessionConflictRef = { current: false };
      const initialSessionPromiseRef = {
        current: (options?.initialSessionPromise ?? null) as Promise<any> | null
      };
      const drainSessionMutationQueue = vi.fn().mockImplementation(
        options?.drainSessionMutationQueue ?? (async () => undefined)
      );
      const syncProjectToSession = vi.fn().mockResolvedValue(true);
      const setProject = vi.fn((next: EditableTranslationProject) => {
        projectRef.current = next;
      });
      const setCurrentFilePath = vi.fn();
      const setProjectRevision = vi.fn((revision: number) => {
        projectRevisionRef.current = revision;
      });
      const setPendingPageNumbers = vi.fn();
      const setIsDirty = vi.fn();
      const setStatusMessage = vi.fn();
      const setRecentProjects = vi.fn();
      const mockSave = vi.fn();
      const mockSaveAs = vi.fn();

      window.projectApi = {
        ...window.projectApi,
        saveProject: mockSave,
        saveProjectAs: mockSaveAs,
        applyProjectMutation: vi.fn()
      } as any;

      const { result } = renderHook(() =>
        useProjectSaveWorkflow({ requestPassword: vi.fn().mockResolvedValue(null),
          sessionPersistenceRequired: true,
          project: projectA,
          setProject,
          projectRef,
          currentFilePath: "session:session-a",
          setCurrentFilePath,
          projectSessionIdRef,
          sessionGenerationRef,
          projectRevisionRef,
          setProjectRevision,
          setPendingPageNumbers,
          sessionProjectRef,
          sessionConflictRef,
          initialSessionPromiseRef,
          drainSessionMutationQueue,
          syncProjectToSession,
          setIsDirty,
          setStatusMessage,
          setRecentProjects
        })
      );

      return {
        result,
        projectA,
        projectRef,
        projectSessionIdRef,
        sessionGenerationRef,
        projectRevisionRef,
        sessionProjectRef,
        drainSessionMutationQueue,
        syncProjectToSession,
        setProject,
        setCurrentFilePath,
        setProjectRevision,
        setPendingPageNumbers,
        setIsDirty,
        setStatusMessage,
        setRecentProjects,
        mockSave,
        mockSaveAs
      };
    }

    function switchSaveHarnessToProjectB(harness: ReturnType<typeof createPersistentSaveHarness>) {
      const projectB = createEmptyProject("Project B", false);
      harness.projectSessionIdRef.current = "session-b";
      harness.sessionGenerationRef.current += 1;
      harness.projectRevisionRef.current = 10;
      harness.projectRef.current = projectB;
      harness.sessionProjectRef.current = projectB as unknown as TranslationProjectV2;
      harness.setProject.mockClear();
      harness.setCurrentFilePath.mockClear();
      harness.setProjectRevision.mockClear();
      harness.setPendingPageNumbers.mockClear();
      harness.setIsDirty.mockClear();
      harness.setStatusMessage.mockClear();
      harness.setRecentProjects.mockClear();
      return projectB;
    }

    it("does not save the new project when the session switches during mutation drain", async () => {
      let releaseDrain: () => void = () => undefined;
      const drainGate = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      const harness = createPersistentSaveHarness({
        drainSessionMutationQueue: () => drainGate
      });

      let savePromise: Promise<void> = Promise.resolve();
      await act(async () => {
        savePromise = harness.result.current.saveProject();
        await Promise.resolve();
      });

      expect(harness.drainSessionMutationQueue).toHaveBeenCalledOnce();
      expect(harness.syncProjectToSession).not.toHaveBeenCalled();
      expect(harness.mockSave).not.toHaveBeenCalled();

      const projectB = switchSaveHarnessToProjectB(harness);

      await act(async () => {
        releaseDrain();
        await savePromise;
      });

      expect(harness.syncProjectToSession).not.toHaveBeenCalled();
      expect(harness.mockSave).not.toHaveBeenCalled();
      expect(harness.mockSaveAs).not.toHaveBeenCalled();
      expect(harness.setProject).not.toHaveBeenCalled();
      expect(harness.setProjectRevision).not.toHaveBeenCalled();
      expect(harness.setCurrentFilePath).not.toHaveBeenCalled();
      expect(harness.setStatusMessage).not.toHaveBeenCalled();
      expect(harness.setIsDirty).not.toHaveBeenCalled();
      expect(harness.setRecentProjects).not.toHaveBeenCalled();
      expect(harness.setPendingPageNumbers).not.toHaveBeenCalled();
      expect(harness.projectRevisionRef.current).toBe(10);
      expect(harness.projectRef.current).toBe(projectB);
      expect(harness.sessionProjectRef.current).toBe(projectB);
      expect(harness.result.current.saveInFlightRef.current).toBe(false);
    });

    it("does not save the new project when the session switches during initial session wait", async () => {
      let releaseInitial: (value?: unknown) => void = () => undefined;
      const initialSessionPromise = new Promise((resolve) => {
        releaseInitial = resolve;
      });
      const harness = createPersistentSaveHarness({
        initialSessionPromise
      });

      let savePromise: Promise<void> = Promise.resolve();
      await act(async () => {
        savePromise = harness.result.current.saveProjectAs();
        await Promise.resolve();
      });

      expect(harness.drainSessionMutationQueue).not.toHaveBeenCalled();
      expect(harness.syncProjectToSession).not.toHaveBeenCalled();
      expect(harness.mockSaveAs).not.toHaveBeenCalled();

      const projectB = switchSaveHarnessToProjectB(harness);

      await act(async () => {
        releaseInitial();
        await savePromise;
      });

      expect(harness.drainSessionMutationQueue).not.toHaveBeenCalled();
      expect(harness.syncProjectToSession).not.toHaveBeenCalled();
      expect(harness.mockSave).not.toHaveBeenCalled();
      expect(harness.mockSaveAs).not.toHaveBeenCalled();
      expect(harness.setProject).not.toHaveBeenCalled();
      expect(harness.setProjectRevision).not.toHaveBeenCalled();
      expect(harness.setCurrentFilePath).not.toHaveBeenCalled();
      expect(harness.setStatusMessage).not.toHaveBeenCalled();
      expect(harness.setIsDirty).not.toHaveBeenCalled();
      expect(harness.setRecentProjects).not.toHaveBeenCalled();
      expect(harness.projectRevisionRef.current).toBe(10);
      expect(harness.projectRef.current).toBe(projectB);
      expect(harness.sessionProjectRef.current).toBe(projectB);
    });

    it("does not apply a late save IPC result after the project session switches", async () => {
      const harness = createPersistentSaveHarness();
      let resolveSave: ((value: unknown) => void) | undefined;
      harness.mockSave.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSave = resolve;
          })
      );

      let savePromise: Promise<void> = Promise.resolve();
      await act(async () => {
        savePromise = harness.result.current.saveProject();
        await Promise.resolve();
      });

      expect(harness.syncProjectToSession).toHaveBeenCalledOnce();
      expect(harness.mockSave).toHaveBeenCalledWith({ projectSessionId: "session-a" });
      expect(harness.mockSaveAs).not.toHaveBeenCalled();

      const projectB = switchSaveHarnessToProjectB(harness);
      const staleSavedProject = {
        ...harness.projectA,
        metadata: { ...harness.projectA.metadata, title: "Stale Saved A" }
      };

      await act(async () => {
        resolveSave!({
          projectSessionId: "session-a",
          project: {
            project: staleSavedProject,
            revision: 99,
            dirty: false,
            pendingPageImages: [{ pageNumber: 8 }]
          },
          recentProject: {
            recentProjectId: "recent-a",
            title: "Stale Saved A",
            openedAt: "2026-09-02T00:00:00.000Z"
          }
        });
        await savePromise;
      });

      expect(harness.mockSave).toHaveBeenCalledTimes(1);
      expect(harness.mockSave).toHaveBeenCalledWith({ projectSessionId: "session-a" });
      expect(harness.setProject).not.toHaveBeenCalled();
      expect(harness.setProjectRevision).not.toHaveBeenCalled();
      expect(harness.setCurrentFilePath).not.toHaveBeenCalled();
      expect(harness.setStatusMessage).not.toHaveBeenCalled();
      expect(harness.setIsDirty).not.toHaveBeenCalled();
      expect(harness.setRecentProjects).not.toHaveBeenCalled();
      expect(harness.setPendingPageNumbers).not.toHaveBeenCalled();
      expect(harness.projectRevisionRef.current).toBe(10);
      expect(harness.projectRef.current).toBe(projectB);
      expect(harness.sessionProjectRef.current).toBe(projectB);
    });

    it("does not show a previous save error on the new project after a session switch", async () => {
      const harness = createPersistentSaveHarness();
      let rejectSave: ((reason?: unknown) => void) | undefined;
      harness.mockSave.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectSave = reject;
          })
      );

      let savePromise: Promise<void> = Promise.resolve();
      await act(async () => {
        savePromise = harness.result.current.saveProject();
        await Promise.resolve();
      });

      expect(harness.mockSave).toHaveBeenCalledWith({ projectSessionId: "session-a" });
      switchSaveHarnessToProjectB(harness);

      await act(async () => {
        rejectSave!(new Error("disk full"));
        await savePromise;
      });

      expect(harness.setStatusMessage).not.toHaveBeenCalled();
    });

    function createSaveWorkflowHarness(options?: {
      projectSessionId?: string | null;
      sessionGeneration?: number;
      sessionConflict?: boolean;
      drainSessionMutationQueue?: () => Promise<void>;
      syncProjectToSession?: () => Promise<boolean>;
    }) {
      const initialProject = createEmptyProject("Export Test", false);
      const projectRef = { current: initialProject };
      const projectSessionIdRef = { current: options?.projectSessionId === undefined ? "session-export" : options.projectSessionId };
      const sessionGenerationRef = { current: options?.sessionGeneration ?? 1 };
      const projectRevisionRef = { current: 1 };
      const sessionProjectRef = { current: initialProject as unknown as TranslationProjectV2 };
      const sessionConflictRef = { current: options?.sessionConflict ?? false };
      const initialSessionPromiseRef = { current: null };
      const drainSessionMutationQueue = vi.fn().mockImplementation(
        options?.drainSessionMutationQueue ?? (async () => undefined)
      );
      const syncProjectToSession = vi.fn().mockImplementation(
        options?.syncProjectToSession ?? (async () => true)
      );
      const setStatusMessage = vi.fn();
      const mockExport = vi.fn().mockResolvedValue("C:/projects/export.txt");
      window.projectApi = {
        ...window.projectApi,
        exportTranslations: mockExport,
        applyProjectMutation: vi.fn()
      } as any;

      const { result } = renderHook(() =>
        useProjectSaveWorkflow({ requestPassword: vi.fn().mockResolvedValue(null),
          sessionPersistenceRequired: true,
          project: initialProject,
          setProject: vi.fn(),
          projectRef,
          currentFilePath: null,
          setCurrentFilePath: vi.fn(),
          projectSessionIdRef,
          sessionGenerationRef,
          projectRevisionRef,
          setProjectRevision: vi.fn(),
          setPendingPageNumbers: vi.fn(),
          sessionProjectRef,
          sessionConflictRef,
          initialSessionPromiseRef,
          drainSessionMutationQueue,
          syncProjectToSession,
          setIsDirty: vi.fn(),
          setStatusMessage,
          setRecentProjects: vi.fn()
        })
      );

      return {
        result,
        projectSessionIdRef,
        sessionGenerationRef,
        sessionConflictRef,
        drainSessionMutationQueue,
        syncProjectToSession,
        mockExport,
        setStatusMessage
      };
    }

    it("exports translations and sets appropriate feedback message", async () => {
      const harness = createSaveWorkflowHarness();

      await act(async () => {
        await harness.result.current.exportTranslations();
      });

      expect(harness.drainSessionMutationQueue).toHaveBeenCalledOnce();
      expect(harness.syncProjectToSession).toHaveBeenCalledOnce();
      expect(harness.mockExport).toHaveBeenCalledWith(
        expect.objectContaining({
          projectSessionId: "session-export",
          defaultPath: "Export Test.txt"
        })
      );
      expect(harness.setStatusMessage).toHaveBeenCalledWith("번역문을 내보냈습니다.");
    });

    it("does not call export IPC until pending session mutations drain and sync", async () => {
      let releaseDrain: () => void = () => undefined;
      const drainGate = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      const harness = createSaveWorkflowHarness({
        drainSessionMutationQueue: () => drainGate
      });
      const callOrder: string[] = [];
      harness.drainSessionMutationQueue.mockImplementation(async () => {
        callOrder.push("drain-start");
        await drainGate;
        callOrder.push("drain-done");
      });
      harness.syncProjectToSession.mockImplementation(async () => {
        callOrder.push("sync");
        return true;
      });
      harness.mockExport.mockImplementation(async () => {
        callOrder.push("export");
        return "C:/projects/export.txt";
      });

      let exportPromise: Promise<void> = Promise.resolve();
      act(() => {
        exportPromise = harness.result.current.exportTranslations();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(harness.mockExport).not.toHaveBeenCalled();
      expect(harness.syncProjectToSession).not.toHaveBeenCalled();
      expect(callOrder).toEqual(["drain-start"]);

      await act(async () => {
        releaseDrain();
        await exportPromise;
      });

      expect(callOrder).toEqual(["drain-start", "drain-done", "sync", "export"]);
      expect(harness.mockExport).toHaveBeenCalledOnce();
    });

    it("does not export stale TXT after a revision conflict", async () => {
      const harness = createSaveWorkflowHarness();
      harness.drainSessionMutationQueue.mockImplementation(async () => {
        harness.sessionConflictRef.current = true;
      });

      await act(async () => {
        await harness.result.current.exportTranslations();
      });

      expect(harness.mockExport).not.toHaveBeenCalled();
      expect(harness.syncProjectToSession).not.toHaveBeenCalled();
      expect(harness.setStatusMessage).not.toHaveBeenCalledWith("번역문을 내보냈습니다.");
    });

    it("does not export stale TXT when session sync fails", async () => {
      const harness = createSaveWorkflowHarness({
        syncProjectToSession: async () => false
      });

      await act(async () => {
        await harness.result.current.exportTranslations();
      });

      expect(harness.drainSessionMutationQueue).toHaveBeenCalledOnce();
      expect(harness.syncProjectToSession).toHaveBeenCalledOnce();
      expect(harness.mockExport).not.toHaveBeenCalled();
      expect(harness.setStatusMessage).toHaveBeenCalledWith(
        "프로젝트 변경을 최신 상태로 맞추지 못해 내보내기를 중단했습니다. 최신 상태를 확인한 뒤 다시 시도하세요."
      );
    });

    it("does not apply a previous session export after the project switches during drain", async () => {
      const harness = createSaveWorkflowHarness();
      harness.drainSessionMutationQueue.mockImplementation(async () => {
        harness.projectSessionIdRef.current = "session-other";
        harness.sessionGenerationRef.current += 1;
      });

      await act(async () => {
        await harness.result.current.exportTranslations();
      });

      expect(harness.mockExport).not.toHaveBeenCalled();
      expect(harness.syncProjectToSession).not.toHaveBeenCalled();
      expect(harness.setStatusMessage).not.toHaveBeenCalled();
    });

    it("keeps standalone TXT export without draining a project session", async () => {
      const harness = createSaveWorkflowHarness({
        projectSessionId: null
      });

      await act(async () => {
        await harness.result.current.exportTranslations();
      });

      expect(harness.drainSessionMutationQueue).not.toHaveBeenCalled();
      expect(harness.syncProjectToSession).not.toHaveBeenCalled();
      expect(harness.mockExport).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: "Export Test.txt",
          project: expect.objectContaining({
            metadata: expect.objectContaining({ title: "Export Test" })
          })
        })
      );
      expect(harness.mockExport.mock.calls[0]?.[0]).not.toHaveProperty("projectSessionId");
      expect(harness.setStatusMessage).toHaveBeenCalledWith("번역문을 내보냈습니다.");
    });
  });
});
