import { describe, it, expect, vi } from "vitest";
import { createBatchExecutionCoordinator } from "../../src/main/batch/batchExecutionCoordinator.js";
import { createProviderSettingsStore } from "../../src/main/providerSettingsStore.js";
import { createProjectSessionManager } from "../../src/main/projectSessions.js";
import type { TranslationEngineRegistry } from "../../src/main/translation/translationEngineRegistry.js";
import type { TranslationProject, TranslationProjectV2 } from "../../src/shared/projectTypes.js";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation.js";
import {
  createProcessingQueue,
  failProcessingQueuePage,
  pauseProcessingQueue,
  startProcessingQueue
} from "../../src/shared/processingQueue.js";

describe("batchExecutionCoordinator", () => {
  const dummyProject: TranslationProjectV2 = {
    ...createEmptyProject("Test Project", false),
    dialogueLines: [
      {
        id: "line-1",
        order: 1,
        pageNumber: 1,
        sourceLanguage: "ja",
        sourceText: "こんにちは",
        dialogueType: "speech",
        lineStatus: "draft",
        parseConfidence: 1,
        parseWarnings: [],
        typesetting: {
          bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
          writingMode: "horizontal-tb"
        },
        origin: { kind: "manual" as const }
      },
      {
        id: "line-2",
        order: 2,
        pageNumber: 1,
        sourceLanguage: "ja",
        sourceText: "ありがとう",
        dialogueType: "speech",
        lineStatus: "draft",
        parseConfidence: 1,
        parseWarnings: [],
        typesetting: {
          bbox: { x: 0.5, y: 0.5, width: 0.4, height: 0.2 },
          writingMode: "horizontal-tb"
        },
        origin: { kind: "manual" as const }
      }
    ],
    characters: [],
    dictionaryTerms: [],
    pageImages: []
  };

  it("successfully executes batch translation and typesetting", async () => {
    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async (payload) => {
        const text = payload.source.sourceText === "こんにちは" ? "안녕하세요" : "고마워요";
        return { translatedText: text, engine: "test-engine" };
      })
    };

    const providerSettingsStore = createProviderSettingsStore();
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore
    });

    const progressUpdates: any[] = [];
    const result = await coordinator.runBatchJob({
      project: dummyProject,
      requestId: "req-1",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: true,
        overwriteExisting: false
      },
      onProgress: (p) => progressUpdates.push(p)
    });

    expect(result.progress.stage).toBe("completed");
    expect(result.updatedProject.dialogueLines[0].aiTranslation).toBe("안녕하세요");
    expect(result.updatedProject.dialogueLines[1].aiTranslation).toBe("고마워요");
    expect(result.updatedProject.dialogueLines[0].typesetting).toBeDefined();
    expect(progressUpdates.length).toBeGreaterThan(0);
  });

  it("keeps an AI-only session batch result as a proposal without user-approved typesetting", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...createEmptyProject("AI proposal boundary", false),
      dialogueLines: [{
        id: "ai-only-session-line",
        order: 1,
        pageNumber: 1,
        sourceLanguage: "ja",
        sourceText: "こんにちは",
        dialogueType: "speech",
        lineStatus: "untranslated",
        parseConfidence: 1,
        parseWarnings: [],
        polygon: [
          { x: 0.1, y: 0.1 },
          { x: 0.5, y: 0.1 },
          { x: 0.5, y: 0.3 },
          { x: 0.1, y: 0.3 }
        ],
        origin: { kind: "manual" }
      }]
    };
    const session = projectSessionManager.createProjectSession({ project: sessionProject });
    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockResolvedValue({ translatedText: "안녕하세요", engine: "test-engine" })
    };
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: session.projectSessionId,
      requestId: "req-ai-only-session",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: true,
        overwriteExisting: false
      }
    });

    const updatedLine = result.updatedProject.dialogueLines[0];
    const liveLine = projectSessionManager.getProject(session.projectSessionId).project.dialogueLines[0];
    expect(updatedLine).toMatchObject({
      aiTranslation: "안녕하세요",
      lineStatus: "untranslated"
    });
    expect(updatedLine?.userTranslation).toBeUndefined();
    expect(updatedLine?.typesetting).toBeUndefined();
    expect(liveLine).toEqual(updatedLine);
  });

  it("handles cancellation gracefully during batch execution", async () => {
    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async (_payload, options) => {
        if (options?.signal?.aborted) {
          throw new Error("Aborted");
        }
        return { translatedText: "번역됨", engine: "test" };
      })
    };

    const providerSettingsStore = createProviderSettingsStore();
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore
    });

    // Cancel before or during execution
    const promise = coordinator.runBatchJob({
      project: dummyProject,
      requestId: "req-cancel",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: false
      }
    });

    coordinator.cancelBatchJob("req-cancel");
    const result = await promise;

    expect(result.progress.stage).toBe("canceled");
    expect(result.progress.isCanceled).toBe(true);
  });

  it("reports partial success if some lines fail to translate", async () => {
    let callCount = 0;
    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { translatedText: "성공", engine: "test" };
        }
        throw new Error("API rate limit");
      })
    };

    const providerSettingsStore = createProviderSettingsStore();
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore
    });

    const result = await coordinator.runBatchJob({
      project: dummyProject,
      requestId: "req-partial",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: false
      }
    });

    expect(result.progress.stage).toBe("partial");
    expect(result.updatedProject.dialogueLines[0].aiTranslation).toBe("성공");
    expect(result.updatedProject.dialogueLines[1].aiTranslation).toBeUndefined();
  });

  it("filters by targetPages and only translates and typesets dialogue on selected pages", async () => {
    const multiPageProject: TranslationProject = {
      ...dummyProject,
      dialogueLines: [
        {
          id: "line-p1",
          order: 1,
          pageNumber: 1,
          sourceLanguage: "ja",
          sourceText: "1페이지 대사",
          dialogueType: "speech",
          lineStatus: "draft",
          parseConfidence: 1,
          parseWarnings: []
        },
        {
          id: "line-p2",
          order: 2,
          pageNumber: 2,
          sourceLanguage: "ja",
          sourceText: "2페이지 대사",
          dialogueType: "speech",
          lineStatus: "draft",
          parseConfidence: 1,
          parseWarnings: [],
          typesetting: {
            bbox: { x: 0.2, y: 0.2, width: 0.5, height: 0.2 },
            writingMode: "horizontal-tb"
          }
        },
        {
          id: "line-p3",
          order: 3,
          pageNumber: 3,
          sourceLanguage: "ja",
          sourceText: "3페이지 대사",
          dialogueType: "speech",
          lineStatus: "draft",
          parseConfidence: 1,
          parseWarnings: []
        }
      ]
    };

    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async (payload) => {
        return { translatedText: `번역_${payload.source.sourceText}`, engine: "test" };
      })
    };

    const providerSettingsStore = createProviderSettingsStore();
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore
    });

    const result = await coordinator.runBatchJob({
      project: multiPageProject,
      requestId: "req-target-pages",
      config: {
        targetPages: [2],
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: true,
        overwriteExisting: false
      }
    });

    expect(result.progress.stage).toBe("completed");

    // Page 1 and 3 should be untouched
    expect(result.updatedProject.dialogueLines[0].aiTranslation).toBeUndefined();
    expect(result.updatedProject.dialogueLines[0].typesetting).toBeUndefined();

    // Page 2 should be translated and typeset
    expect(result.updatedProject.dialogueLines[1].aiTranslation).toBe("번역_2페이지 대사");
    expect(result.updatedProject.dialogueLines[1].typesetting).toBeDefined();

    // Page 3 untouched
    expect(result.updatedProject.dialogueLines[2].aiTranslation).toBeUndefined();
    expect(result.updatedProject.dialogueLines[2].typesetting).toBeUndefined();

    // Translation adapter should have been called only once for page 2
    expect(mockRegistry.executeTranslation).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported pipeline stages explicitly", async () => {
    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn()
    };

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore()
    });

    await expect(
      coordinator.runBatchJob({
        project: dummyProject,
        requestId: "req-unsupported-ocr",
        config: {
          targetPages: "all",
          speechStylePreset: "informal",
          runOcr: true, // unsupported
          runGlossary: false,
          runTranslate: true,
          runInpaint: false,
          runTypeset: false,
          overwriteExisting: false
        }
      })
    ).rejects.toThrow("지원하지 않는 일괄 처리 단계입니다: 말풍선 OCR");

    await expect(
      coordinator.runBatchJob({
        project: dummyProject,
        requestId: "req-unsupported-inpaint",
        config: {
          targetPages: "all",
          speechStylePreset: "informal",
          runOcr: false,
          runGlossary: false,
          runTranslate: true,
          runInpaint: true, // unsupported
          runTypeset: false,
          overwriteExisting: false
        }
      })
    ).rejects.toThrow("지원하지 않는 일괄 처리 단계입니다: 배경 인페인팅");
  });

  it("skips typesetting and reports partial progress when dialogue lines lack geometry", async () => {
    const noGeoProject: TranslationProject = {
      ...createEmptyProject("No Geo Project", false),
      dialogueLines: [
        {
          id: "no-geo-1",
          order: 1,
          pageNumber: 1,
          sourceLanguage: "ja",
          sourceText: "대사 1",
          userTranslation: "번역 1",
          dialogueType: "speech",
          lineStatus: "draft",
          parseConfidence: 1,
          parseWarnings: []
          // No typesetting bbox or polygon
        }
      ],
      characters: [],
      dictionaryTerms: [],
      pageImages: []
    };

    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn()
    };

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore()
    });

    const result = await coordinator.runBatchJob({
      project: noGeoProject,
      requestId: "req-no-geo",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: false,
        runInpaint: false,
        runTypeset: true,
        overwriteExisting: false
      }
    });

    expect(result.progress.stage).toBe("partial");
    expect(result.progress.errors).toHaveLength(1);
    expect(result.progress.errors[0]?.message).toContain("말풍선 위치 정보 없음 (식자 건너뜀)");
    expect(result.updatedProject.dialogueLines[0]?.typesetting).toBeUndefined();
  });

  it("directly commits batch results to Main ProjectSessionManager and updates session liveProject and ProcessingQueue", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject = {
      ...dummyProject,
      dialogueLines: dummyProject.dialogueLines.map((line, index) => ({
        ...line,
        userTranslation: index === 0 ? "사용자 번역 1" : "사용자 번역 2"
      })),
      pageImages: [
        {
          id: "page-img-1",
          pageNumber: 1,
          storedRelativePath: "pages/1.png",
          originalFileName: "1.png",
          sha256: "a".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: new Date().toISOString()
        }
      ]
    };

    const sessionResult = projectSessionManager.createProjectSession({
      project: sessionProject
    });
    const sessionId = sessionResult.projectSessionId;

    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async (payload) => ({
        translatedText: `세션번역_${payload.source.sourceText}`,
        engine: "test"
      }))
    };

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const batchResult = await coordinator.runBatchJob({
      projectSessionId: sessionId,
      requestId: "req-session-commit",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: true,
        overwriteExisting: true
      }
    });

    expect(batchResult.sessionChange).toBeDefined();
    expect(batchResult.sessionChange?.status).toBe("applied");
    expect(batchResult.sessionChange?.revision).toBeGreaterThan(0);

    // Verify Main session manager holds authoritative updated values
    const updatedSession = projectSessionManager.getProject(sessionId);
    expect(updatedSession.project.dialogueLines[0]?.aiTranslation).toBe("세션번역_こんにちは");
    expect(updatedSession.project.dialogueLines[1]?.aiTranslation).toBe("세션번역_ありがとう");
    expect(updatedSession.project.dialogueLines[0]?.typesetting).toBeDefined();
    expect(updatedSession.project.dialogueLines[0]?.typesetting?.fontSizeRatio).toBeGreaterThan(0);

    // Verify ProcessingQueue was committed into processing.queue
    expect(updatedSession.project.processing.queue).toBeDefined();
    expect(updatedSession.project.processing.queue?.status).toBe("completed");
    expect(updatedSession.project.processing.queue?.pages[0]?.stage).toBe("completed");
  });

  it("updates BatchProgressState pageStatuses translatedCount, typesettingDone and currentPageIndex", async () => {
    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async () => ({
        translatedText: "번역완료",
        engine: "test"
      }))
    };

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore()
    });

    const progressUpdates: any[] = [];
    const result = await coordinator.runBatchJob({
      project: dummyProject,
      requestId: "req-progress-detail",
      config: {
        targetPages: [1],
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: true,
        overwriteExisting: false
      },
      onProgress: (p) => progressUpdates.push(structuredClone(p))
    });

    expect(result.progress.pageStatuses[1]?.translatedCount).toBe(2);
    expect(result.progress.pageStatuses[1]?.typesettingDone).toBe(true);
    expect(result.progress.currentPageIndex).toBe(0);
  });
  it("discards stale batch results when sourceText was modified during batch execution", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...dummyProject,
      pageImages: [
        {
          id: "page-img-1",
          pageNumber: 1,
          storedRelativePath: "pages/1.png",
          originalFileName: "1.png",
          sha256: "a".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: new Date().toISOString()
        }
      ]
    };

    const sessionResult = projectSessionManager.createProjectSession({
      project: sessionProject
    });
    const sessionId = sessionResult.projectSessionId;

    let callCount = 0;
    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async (payload) => {
        callCount++;
        if (callCount === 1) {
          const currentRev = projectSessionManager.getProject(sessionId).revision;
          const mutResult = await projectSessionManager.applyProjectMutation({
            projectSessionId: sessionId,
            baseRevision: currentRev,
            mutation: {
              type: "update_dialogue_line",
              lineId: "line-1",
              patch: { sourceText: "Modified source text" }
            }
          });
          expect(mutResult.status).toBe("applied");
        }
        return { translatedText: `Translated_${payload.source.sourceText}`, engine: "test" };
      })
    };

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: sessionId,
      requestId: "req-stale-discard",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: false
      }
    });

    const updatedSession = projectSessionManager.getProject(sessionId);
    expect(updatedSession.project.dialogueLines[0]?.aiTranslation).toBeUndefined();
    // line-2 used line-1 as provider context, so it is also stale.
    expect(updatedSession.project.dialogueLines[1]?.aiTranslation).toBeUndefined();

    expect(result.progress.stage).toBe("failed");
    expect(result.progress.errors.length).toBeGreaterThan(0);
  });

  it("preserves batch results for unsaved new dialogue lines added via user mutation", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject = {
      ...createEmptyProject("No lines", false),
      pageImages: [
        {
          id: "page-img-1",
          pageNumber: 1,
          storedRelativePath: "pages/1.png",
          originalFileName: "1.png",
          sha256: "a".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: new Date().toISOString()
        }
      ]
    };

    const sessionResult = projectSessionManager.createProjectSession({
      project: sessionProject
    });
    const sessionId = sessionResult.projectSessionId;

    const addResult = await projectSessionManager.applyProjectMutation({
      projectSessionId: sessionId,
      baseRevision: sessionResult.project.revision,
      mutation: {
        type: "add_dialogue_line",
        input: {
          pageNumber: 1,
          sourceLanguage: "ja",
          sourceText: "新しいセリフ",
          dialogueType: "speech"
        }
      }
    });
    expect(addResult.status).toBe("applied");

    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async () => {
        return { translatedText: "새로운 대사 번역", engine: "test" };
      })
    };

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: sessionId,
      requestId: "req-unsaved-new-line",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: false
      }
    });

    expect(result.sessionChange).toBeDefined();
    const line = result.sessionChange?.project.project.dialogueLines.find((l: any) => l.sourceText === "新しいセリフ");
    expect(line).toBeDefined();
    expect(line?.aiTranslation).toBe("새로운 대사 번역");
  });

  it("commits cancelled ProcessingQueue to Main session", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject = {
      ...dummyProject,
      pageImages: [
        {
          id: "page-img-1",
          pageNumber: 1,
          storedRelativePath: "pages/1.png",
          originalFileName: "1.png",
          sha256: "a".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: new Date().toISOString()
        }
      ]
    };

    const sessionResult = projectSessionManager.createProjectSession({
      project: sessionProject
    });
    const sessionId = sessionResult.projectSessionId;

    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async (_payload, options) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve({ translatedText: "done", engine: "test" }), 50);
          if (options?.signal) {
            options.signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(new Error("Aborted"));
            });
          }
        });
      })
    };

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const promise = coordinator.runBatchJob({
      projectSessionId: sessionId,
      requestId: "req-cancel-queue",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: false
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    coordinator.cancelBatchJob("req-cancel-queue");
    await promise;

    const session = projectSessionManager.getProject(sessionId);
    expect(session.project.processing.queue).toBeDefined();
    expect(session.project.processing.queue?.status).toBe("cancelled");
  });

  it("sets ProcessingQueue page status to failed when translation fails", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject = {
      ...dummyProject,
      pageImages: [
        {
          id: "page-img-1",
          pageNumber: 1,
          storedRelativePath: "pages/1.png",
          originalFileName: "1.png",
          sha256: "a".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: new Date().toISOString()
        }
      ]
    };

    const sessionResult = projectSessionManager.createProjectSession({
      project: sessionProject
    });
    const sessionId = sessionResult.projectSessionId;

    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async () => {
        throw new Error("Translation API Error");
      })
    };

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    await coordinator.runBatchJob({
      projectSessionId: sessionId,
      requestId: "req-fail-queue",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: false
      }
    });

    const session = projectSessionManager.getProject(sessionId);
    expect(session.project.processing.queue).toBeDefined();
    expect(session.project.processing.queue?.status).toBe("failed");
    expect(session.project.processing.queue?.pages[0]?.status).toBe("failed");
  });

  it("sets typesettingDone to false when all lines on a page lack geometry", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...createEmptyProject("No Geo", false),
      pageImages: [
        {
          id: "page-img-1",
          pageNumber: 1,
          storedRelativePath: "pages/1.png",
          originalFileName: "1.png",
          sha256: "a".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: new Date().toISOString()
        }
      ],
      dialogueLines: [
        {
          id: "no-geo-line",
          order: 1,
          pageNumber: 1,
          sourceLanguage: "ja",
          sourceText: "테스트",
          userTranslation: "번역 1",
          dialogueType: "speech",
          lineStatus: "draft",
          parseConfidence: 1,
          parseWarnings: [],
          origin: { kind: "manual" as const }
        }
      ]
    };

    const sessionResult = projectSessionManager.createProjectSession({
      project: sessionProject
    });
    const sessionId = sessionResult.projectSessionId;

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: {
        registerAdapter: vi.fn(),
        getAdapter: vi.fn(),
        listAdapters: vi.fn(),
        executeTranslation: vi.fn()
      },
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: sessionId,
      requestId: "req-typesetting-done-false",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: false,
        runInpaint: false,
        runTypeset: true,
        overwriteExisting: false
      }
    });

    expect(result.progress.pageStatuses[1]?.typesettingDone).toBe(false);
    expect(projectSessionManager.getProject(sessionId).project.processing.queue?.pages[0])
      .toMatchObject({ status: "failed", stage: "typesetting" });
  });

  it("only includes actually changed lines in commit_batch_result dialogueUpdates", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...dummyProject,
      pageImages: [
        {
          id: "page-img-1",
          pageNumber: 1,
          storedRelativePath: "pages/1.png",
          originalFileName: "1.png",
          sha256: "a".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: new Date().toISOString()
        }
      ],
      dialogueLines: [
        ...dummyProject.dialogueLines,
        {
          id: "line-3",
          order: 3,
          pageNumber: 1,
          sourceLanguage: "ja",
          sourceText: "안녕",
          userTranslation: "이미 번역됨",
          dialogueType: "speech",
          lineStatus: "draft",
          parseConfidence: 1,
          parseWarnings: [],
          typesetting: {
            bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
            writingMode: "horizontal-tb"
          },
          origin: { kind: "manual" as const }
        }
      ]
    };

    const sessionResult = projectSessionManager.createProjectSession({
      project: sessionProject
    });
    const sessionId = sessionResult.projectSessionId;

    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async () => {
        return { translatedText: "새 번역", engine: "test" };
      })
    };

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: sessionId,
      requestId: "req-changed-lines-only",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: false
      }
    });

    expect(result.sessionChange).toBeDefined();
    const session = projectSessionManager.getProject(sessionId);

    expect(session.project.dialogueLines.find(l => l.id === "line-1")?.aiTranslation).toBe("새 번역");
    expect(session.project.dialogueLines.find(l => l.id === "line-2")?.aiTranslation).toBe("새 번역");

    const line3 = session.project.dialogueLines.find(l => l.id === "line-3");
    expect(line3?.aiTranslation).toBeUndefined();
    expect(line3?.userTranslation).toBe("이미 번역됨");
  });

  it("discards stale batch results when dictionary term is modified during batch execution", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...dummyProject,
      dictionaryTerms: [
        {
          id: "term-1",
          source: "こんにちは",
          target: "안녕"
        }
      ],
      pageImages: [
        {
          id: "page-img-1",
          pageNumber: 1,
          storedRelativePath: "pages/1.png",
          originalFileName: "1.png",
          sha256: "a".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: new Date().toISOString()
        }
      ]
    };

    const sessionResult = projectSessionManager.createProjectSession({
      project: sessionProject
    });
    const sessionId = sessionResult.projectSessionId;

    let callCount = 0;
    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async (payload) => {
        callCount++;
        if (callCount === 1) {
          // Mutate glossary during execution
          const currentRev = projectSessionManager.getProject(sessionId).revision;
          const mutResult = await projectSessionManager.applyProjectMutation({
            projectSessionId: sessionId,
            baseRevision: currentRev,
            mutation: {
              type: "upsert_dictionary_term",
              term: {
                id: "term-1",
                source: "こんにちは",
                target: "안녕하세요 (공손하게)"
              }
            }
          });
          expect(mutResult.status).toBe("applied");
        }
        return { translatedText: `Translated_${payload.source.sourceText}`, engine: "test" };
      })
    };

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: sessionId,
      requestId: "req-stale-glossary",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: false
      }
    });

    const updatedSession = projectSessionManager.getProject(sessionId);
    // line-1 had glossary matched to こんにちは, which changed during execution -> discarded
    expect(updatedSession.project.dialogueLines[0]?.aiTranslation).toBeUndefined();
    // line-2 used line-1 and its matched glossary as provider context -> discarded
    expect(updatedSession.project.dialogueLines[1]?.aiTranslation).toBeUndefined();

    expect(result.progress.stage).toBe("failed");
    expect(result.progress.errors.length).toBeGreaterThan(0);
    expect(result.progress.currentMessage).toContain("2개 번역 실행 중 변경으로 폐기");
  });

  it("discards stale batch results when character profile is modified during batch execution", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...dummyProject,
      characters: [
        {
          id: "char-1",
          name: "Hero",
          aliases: [],
          speechStyle: "정중하고 공손한 경어체"
        }
      ],
      dialogueLines: [
        {
          ...dummyProject.dialogueLines[0]!,
          speaker: "Hero"
        },
        {
          ...dummyProject.dialogueLines[1]!,
          speaker: "Other"
        }
      ],
      pageImages: [
        {
          id: "page-img-1",
          pageNumber: 1,
          storedRelativePath: "pages/1.png",
          originalFileName: "1.png",
          sha256: "a".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: new Date().toISOString()
        }
      ]
    };

    const sessionResult = projectSessionManager.createProjectSession({
      project: sessionProject
    });
    const sessionId = sessionResult.projectSessionId;

    let callCount = 0;
    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async (payload) => {
        callCount++;
        if (callCount === 1) {
          // Mutate character profile speech style during execution
          const currentRev = projectSessionManager.getProject(sessionId).revision;
          const mutResult = await projectSessionManager.applyProjectMutation({
            projectSessionId: sessionId,
            baseRevision: currentRev,
            mutation: {
              type: "upsert_character",
              character: {
                id: "char-1",
                name: "Hero",
                aliases: [],
                speechStyle: "거칠고 반항적인 반말투"
              }
            }
          });
          expect(mutResult.status).toBe("applied");
        }
        return { translatedText: `Translated_${payload.source.sourceText}`, engine: "test" };
      })
    };

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: sessionId,
      requestId: "req-stale-character",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: false
      }
    });

    const updatedSession = projectSessionManager.getProject(sessionId);
    // line-1 had speaker Hero whose profile changed -> discarded
    expect(updatedSession.project.dialogueLines[0]?.aiTranslation).toBeUndefined();
    // line-2 used line-1's rejected proposal as provider context -> discarded
    expect(updatedSession.project.dialogueLines[1]?.aiTranslation).toBeUndefined();

    expect(result.progress.stage).toBe("failed");
  });

  it("discards a translation when its previous-turn payload changes during execution", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...createEmptyProject("Previous turn stale", false),
      pageImages: [{
        id: "page-img-1",
        pageNumber: 1,
        storedRelativePath: "pages/1.png",
        originalFileName: "1.png",
        sha256: "a".repeat(64),
        byteSize: 100,
        mimeType: "image/png",
        copiedAt: "2026-08-28T09:00:00.000Z"
      }],
      dialogueLines: [
        {
          ...dummyProject.dialogueLines[0]!,
          id: "context-line",
          order: 1,
          aiTranslation: undefined
        },
        {
          ...dummyProject.dialogueLines[1]!,
          id: "target-line",
          order: 2,
          aiTranslation: undefined
        }
      ]
    };
    const created = projectSessionManager.createProjectSession({ project: sessionProject });
    let callCount = 0;
    const registry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async (payload) => {
        callCount++;
        if (callCount === 2) {
          const current = projectSessionManager.getProject(created.projectSessionId);
          const mutation = await projectSessionManager.applyProjectMutation({
            projectSessionId: created.projectSessionId,
            baseRevision: current.revision,
            mutation: {
              type: "update_dialogue_line",
              lineId: "context-line",
              patch: { userTranslation: "사용자가 확정한 새 문맥" }
            }
          });
          expect(mutation.status).toBe("applied");
        }
        return {
          translatedText: `Translated_${payload.source.sourceText}`,
          engine: "test"
        };
      })
    };
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: registry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-previous-turn-stale",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: true
      }
    });

    const lines = projectSessionManager.getProject(created.projectSessionId).project.dialogueLines;
    expect(lines.find((line) => line.id === "context-line")).toMatchObject({
      aiTranslation: "Translated_こんにちは",
      userTranslation: "사용자가 확정한 새 문맥"
    });
    expect(lines.find((line) => line.id === "target-line")?.aiTranslation).toBeUndefined();
    expect(result.progress.pageStatuses[1]?.translatedCount).toBe(1);
    expect(result.progress.stage).toBe("partial");
    expect(result.progress.currentMessage).toContain("1개 번역 적용");
    expect(result.progress.currentMessage).toContain("1개 번역 실행 중 변경으로 폐기");
  });

  it("reports a valid translation and stale typesetting as separate field results", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...createEmptyProject("Partial field stale", false),
      pageImages: [{
        id: "page-img-1",
        pageNumber: 1,
        storedRelativePath: "pages/1.png",
        originalFileName: "1.png",
        sha256: "a".repeat(64),
        byteSize: 100,
        mimeType: "image/png",
        copiedAt: "2026-08-28T09:00:00.000Z"
      }],
      dialogueLines: [{
        ...dummyProject.dialogueLines[0]!,
        id: "partial-line",
        userTranslation: "사용자 확정 번역",
        aiTranslation: undefined
      }]
    };
    const created = projectSessionManager.createProjectSession({ project: sessionProject });
    const registry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async () => {
        const current = projectSessionManager.getProject(created.projectSessionId);
        const mutation = await projectSessionManager.applyProjectMutation({
          projectSessionId: created.projectSessionId,
          baseRevision: current.revision,
          mutation: {
            type: "update_dialogue_typesetting",
            lineId: "partial-line",
            typesetting: {
              bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.15 },
              writingMode: "horizontal-tb"
            }
          }
        });
        expect(mutation.status).toBe("applied");
        return { translatedText: "AI 번역 제안", engine: "test" };
      })
    };
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: registry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-partial-field-stale",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: true,
        overwriteExisting: true
      }
    });

    const session = projectSessionManager.getProject(created.projectSessionId);
    const line = session.project.dialogueLines[0];
    expect(line?.aiTranslation).toBe("AI 번역 제안");
    expect(line?.typesetting?.bbox).toEqual({
      x: 0.2,
      y: 0.2,
      width: 0.3,
      height: 0.15
    });
    expect(result.progress.pageStatuses[1]).toMatchObject({
      translatedCount: 1,
      typesettingDone: false
    });
    expect(result.progress.stage).toBe("partial");
    expect(result.progress.currentMessage).toContain("1개 번역 적용");
    expect(result.progress.currentMessage).toContain("1개 식자 실행 중 변경으로 폐기");
    expect(session.project.processing.queue?.pages[0]).toMatchObject({
      status: "failed",
      stage: "typesetting",
      error: { stage: "typesetting" }
    });
  });

  it("preserves failed stage as translation and points currentPageIndex to first failed page", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...dummyProject,
      pageImages: [
        {
          id: "page-img-1",
          pageNumber: 1,
          storedRelativePath: "pages/1.png",
          originalFileName: "1.png",
          sha256: "a".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: new Date().toISOString()
        },
        {
          id: "page-img-2",
          pageNumber: 2,
          storedRelativePath: "pages/2.png",
          originalFileName: "2.png",
          sha256: "b".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: new Date().toISOString()
        }
      ],
      dialogueLines: [
        {
          id: "line-p1",
          order: 1,
          pageNumber: 1,
          sourceLanguage: "ja",
          sourceText: "1페이지 정상 대사",
          dialogueType: "speech",
          lineStatus: "draft",
          parseConfidence: 1,
          parseWarnings: [],
          origin: { kind: "manual" as const }
        },
        {
          id: "line-p2",
          order: 2,
          pageNumber: 2,
          sourceLanguage: "ja",
          sourceText: "2페이지 실패 대사",
          dialogueType: "speech",
          lineStatus: "draft",
          parseConfidence: 1,
          parseWarnings: [],
          origin: { kind: "manual" as const }
        }
      ]
    };

    const sessionResult = projectSessionManager.createProjectSession({
      project: sessionProject
    });
    const sessionId = sessionResult.projectSessionId;

    const mockRegistry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async (payload) => {
        if (payload.source.pageNumber === 2) {
          throw new Error("Page 2 API Failure");
        }
        return { translatedText: "1페이지 번역 완료", engine: "test" };
      })
    };

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: mockRegistry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: sessionId,
      requestId: "req-failed-stage-index",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: false
      }
    });

    expect(result.progress.stage).toBe("partial");
    const session = projectSessionManager.getProject(sessionId);
    const queue = session.project.processing.queue;
    expect(queue).toBeDefined();
    expect(queue?.status).toBe("failed");
    // page 1 is completed
    expect(queue?.pages[0]?.status).toBe("completed");
    expect(queue?.pages[0]?.stage).toBe("completed");
    // page 2 is failed, stage must be "translation" (NOT "completed")
    expect(queue?.pages[1]?.status).toBe("failed");
    expect(queue?.pages[1]?.stage).toBe("translation");
    expect(queue?.pages[1]?.error?.stage).toBe("translation");
    // currentPageIndex points to page 2 (index 1)
    expect(queue?.currentPageIndex).toBe(1);
  });

  it("sets typesettingDone to false when only 1 of 2 lines on a page has geometry", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...createEmptyProject("Partial Geo", false),
      pageImages: [
        {
          id: "page-img-1",
          pageNumber: 1,
          storedRelativePath: "pages/1.png",
          originalFileName: "1.png",
          sha256: "a".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: new Date().toISOString()
        }
      ],
      dialogueLines: [
        {
          id: "line-geo",
          order: 1,
          pageNumber: 1,
          sourceLanguage: "ja",
          sourceText: "식자 가능",
          userTranslation: "번역 1",
          dialogueType: "speech",
          lineStatus: "draft",
          parseConfidence: 1,
          parseWarnings: [],
          typesetting: {
            bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
            writingMode: "horizontal-tb"
          },
          origin: { kind: "manual" as const }
        },
        {
          id: "line-no-geo",
          order: 2,
          pageNumber: 1,
          sourceLanguage: "ja",
          sourceText: "위치 없음",
          userTranslation: "번역 2",
          dialogueType: "speech",
          lineStatus: "draft",
          parseConfidence: 1,
          parseWarnings: [],
          origin: { kind: "manual" as const }
        }
      ]
    };

    const sessionResult = projectSessionManager.createProjectSession({
      project: sessionProject
    });
    const sessionId = sessionResult.projectSessionId;

    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: {
        registerAdapter: vi.fn(),
        getAdapter: vi.fn(),
        listAdapters: vi.fn(),
        executeTranslation: vi.fn()
      },
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: sessionId,
      requestId: "req-partial-geo-typesetting-done",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: false,
        runInpaint: false,
        runTypeset: true,
        overwriteExisting: false
      }
    });

    // Since 1 of 2 lines lacked geometry, typesetting is not completely done for page 1
    expect(result.progress.pageStatuses[1]?.typesettingDone).toBe(false);
    expect(result.progress.stage).toBe("partial");
    expect(result.progress.errors.some(e => e.message.includes("말풍선 위치 정보 없음"))).toBe(true);
  });

  it("preserves a provider translation failure when a later typesetting result is stale on the same page", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...createEmptyProject("Mixed page failures", false),
      pageImages: [{
        id: "mixed-page-image",
        pageNumber: 1,
        storedRelativePath: "pages/mixed.png",
        originalFileName: "mixed.png",
        sha256: "c".repeat(64),
        byteSize: 100,
        mimeType: "image/png",
        copiedAt: "2026-08-28T09:00:00.000Z"
      }],
      dialogueLines: [
        {
          ...dummyProject.dialogueLines[0]!,
          id: "provider-failure-line",
          userTranslation: "사용자 확정 번역 1"
        },
        {
          ...dummyProject.dialogueLines[1]!,
          id: "stale-typesetting-line",
          userTranslation: "사용자 확정 번역 2"
        }
      ]
    };
    const created = projectSessionManager.createProjectSession({ project: sessionProject });
    let callCount = 0;
    const registry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) throw new Error("Provider quota exceeded");
        const current = projectSessionManager.getProject(created.projectSessionId);
        await projectSessionManager.applyProjectMutation({
          projectSessionId: created.projectSessionId,
          baseRevision: current.revision,
          mutation: {
            type: "update_dialogue_typesetting",
            lineId: "stale-typesetting-line",
            typesetting: {
              bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.15 },
              writingMode: "horizontal-tb"
            }
          }
        });
        return { translatedText: "AI 번역 제안", engine: "test" };
      })
    };
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: registry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    await coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-mixed-page-failures",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: true,
        overwriteExisting: true
      }
    });

    const page = projectSessionManager.getProject(created.projectSessionId)
      .project.processing.queue?.pages[0];
    expect(page).toMatchObject({
      status: "failed",
      stage: "translation",
      error: {
        code: "BATCH_TRANSLATION_FAILED",
        message: expect.stringContaining("Provider quota exceeded"),
        stage: "translation"
      }
    });
    expect(page?.error?.details).toMatchObject({
      additionalFailure1Code: "BATCH_STALE_CONTEXT_DISCARDED",
      additionalFailure1Stage: "typesetting"
    });
  });

  it("runs multi-page typesetting in page order and never marks the next page completed before it runs", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...createEmptyProject("Ordered page typesetting", false),
      pageImages: [
        {
          id: "typeset-page-1",
          pageNumber: 1,
          storedRelativePath: "pages/1.png",
          originalFileName: "1.png",
          sha256: "d".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: "2026-08-28T11:00:00.000Z"
        },
        {
          id: "typeset-page-2",
          pageNumber: 2,
          storedRelativePath: "pages/2.png",
          originalFileName: "2.png",
          sha256: "e".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
          copiedAt: "2026-08-28T11:00:00.000Z"
        }
      ],
      dialogueLines: [
        {
          ...dummyProject.dialogueLines[0]!,
          id: "typeset-line-1",
          pageNumber: 1,
          userTranslation: "첫 페이지 확정 번역"
        },
        {
          ...dummyProject.dialogueLines[1]!,
          id: "typeset-line-2",
          pageNumber: 2,
          userTranslation: "둘째 페이지 확정 번역"
        }
      ]
    };
    const created = projectSessionManager.createProjectSession({ project: sessionProject });
    const queueSnapshots: Array<{ message: string; statuses: string[]; stages: string[] }> = [];
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: {
        registerAdapter: vi.fn(),
        getAdapter: vi.fn(),
        listAdapters: vi.fn(),
        executeTranslation: vi.fn()
      },
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-ordered-typesetting",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: false,
        runInpaint: false,
        runTypeset: true,
        overwriteExisting: false
      },
      onProgress: (progress) => {
        if (progress.stage !== "typeset" || !progress.currentMessage.includes("페이지")) return;
        const queue = projectSessionManager.getProject(created.projectSessionId).project.processing.queue;
        queueSnapshots.push({
          message: progress.currentMessage,
          statuses: queue?.pages.map((page) => page.status) ?? [],
          stages: queue?.pages.map((page) => page.stage) ?? []
        });
      }
    });

    expect(queueSnapshots.map((snapshot) => snapshot.message)).toEqual([
      expect.stringContaining("1페이지"),
      expect.stringContaining("2페이지")
    ]);
    expect(queueSnapshots[0]).toMatchObject({
      statuses: ["running", "pending"],
      stages: ["typesetting", "typesetting"]
    });
    expect(queueSnapshots[1]).toMatchObject({
      statuses: ["completed", "running"],
      stages: ["completed", "typesetting"]
    });
    expect(result.updatedProject.dialogueLines.map((line) => line.typesetting?.fontSizeRatio))
      .toEqual([expect.any(Number), expect.any(Number)]);
  });

  it("allows only one of two nearly simultaneous Batch runs to acquire the session queue", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...createEmptyProject("Concurrent Batch runs", false),
      pageImages: [{
        id: "concurrent-batch-page",
        pageNumber: 1,
        storedRelativePath: "pages/concurrent.png",
        originalFileName: "concurrent.png",
        sha256: "1".repeat(64),
        byteSize: 100,
        mimeType: "image/png",
        copiedAt: "2026-08-28T11:15:00.000Z"
      }],
      dialogueLines: [{
        ...dummyProject.dialogueLines[0]!,
        id: "concurrent-batch-line"
      }]
    };
    const created = projectSessionManager.createProjectSession({ project: sessionProject });
    let markProviderStarted!: () => void;
    let finishProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const providerFinished = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    const registry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async () => {
        markProviderStarted();
        await providerFinished;
        return { translatedText: "첫 Batch 결과", engine: "test" };
      })
    };
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: registry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });
    const config = {
      targetPages: "all" as const,
      speechStylePreset: "informal" as const,
      runOcr: false,
      runGlossary: false,
      runTranslate: true,
      runInpaint: false,
      runTypeset: false,
      overwriteExisting: false
    };

    const first = coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-concurrent-first",
      config
    });
    await providerStarted;
    await expect(coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-concurrent-second",
      config
    })).rejects.toThrow(/실행 중이거나 일시정지된 처리 큐/);
    expect(projectSessionManager.getProject(created.projectSessionId).project.processing.queue?.queueId)
      .toBe("batch-queue-req-concurrent-first");

    finishProvider();
    await expect(first).resolves.toMatchObject({ progress: { stage: "completed" } });
    expect(registry.executeTranslation).toHaveBeenCalledOnce();
  });

  it("waits for cancellation persistence before releasing the lease or draining the session", async () => {
    const manager = createProjectSessionManager();
    const { projectSessionId } = manager.createProjectSession({
      project: batchRetryProject("Cancel persistence lifetime", undefined)
    });
    const providerStarted = batchGate();
    const cancelSaveStarted = batchGate();
    const finishCancelSave = batchGate();
    const events: string[] = [];
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>(async (_payload, options) => {
      providerStarted.resolve();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      });
    });
    const commit = manager.commitMainProjectPatch;
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation(async (args) => {
      if (args.patch.type === "update_processing_queue" && args.patch.queue.status === "cancelled") {
        events.push("cancel-save-started");
        cancelSaveStarted.resolve();
        await finishCancelSave.promise;
        const result = await commit(args);
        events.push("cancel-save-finished");
        return result;
      }
      return commit(args);
    });
    const release = manager.releaseBatchProcessingLease;
    vi.spyOn(manager, "releaseBatchProcessingLease").mockImplementation((...args) => {
      events.push("lease-released");
      return release(...args);
    });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager: manager
    });
    const running = coordinator.runBatchJob({
      projectSessionId, requestId: "cancel-save-lifetime",
      config: createTestBatchConfig({ runTranslate: true, runTypeset: false })
    });
    let draining: Promise<boolean> | undefined;
    try {
      await providerStarted.promise;
      draining = coordinator.cancelSessionExecutions(projectSessionId).then((canceled) => {
        events.push("session-drained");
        return canceled;
      });
      await cancelSaveStarted.promise;
    } finally {
      finishCancelSave.resolve();
      await Promise.allSettled([running, ...(draining ? [draining] : [])]);
    }
    expect(await draining).toBe(true);
    expect(await running).toMatchObject({ progress: { stage: "canceled" } });
    expect(events.indexOf("lease-released")).toBeGreaterThan(events.indexOf("cancel-save-finished"));
    expect(events.indexOf("session-drained")).toBeGreaterThan(events.indexOf("lease-released"));
    expect(manager.getProject(projectSessionId).project.processing.queue?.status).toBe("cancelled");
  });

  it.each(["run", "retry", "resume"] as const)(
    "drains a %s waiting behind an existing session write before queue acquisition",
    async (entry) => {
      const writeStarted = batchGate();
      const finishWrite = batchGate();
      let blockWrite = false;
      const manager = createProjectSessionManager({ saveProjectFile: async () => {
        if (blockWrite) {
          blockWrite = false;
          writeStarted.resolve();
          await finishWrite.promise;
        }
      } });
      const project = batchRetryProject(`queued ${entry}`, undefined);
      if (entry === "resume") {
        let queue = createProcessingQueue({
          queueId: "queued-resume", projectSessionId: "previous-process",
          pageImageIds: ["retry-page"], revision: 0, now: "2026-10-18T00:00:00.000Z"
        });
        queue = startProcessingQueue(queue, { now: "2026-10-18T00:00:01.000Z" });
        queue.pages[0]!.stage = "translation";
        project.processing.queue = queue;
      }
      const { projectSessionId } = manager.createProjectSession({
        project, filePath: `${process.env.TEMP}/queued-${entry}.ctp`
      });
      if (entry === "retry") await installFailedBatchQueue(manager, projectSessionId, {
        queueId: "queued-retry", stage: "translation", code: "BATCH_TRANSLATION_FAILED"
      });
      const executeTranslation = vi.fn().mockResolvedValue({ translatedText: "unexpected", engine: "gemini" });
      const release = vi.spyOn(manager, "releaseBatchProcessingLease");
      const coordinator = createBatchExecutionCoordinator({
        translationEngineRegistry: translationRegistry(executeTranslation),
        providerSettingsStore: createProviderSettingsStore(), projectSessionManager: manager
      });
      blockWrite = true;
      const saving = manager.saveProject({ projectSessionId });
      await writeStarted.promise;
      const queue = manager.getProject(projectSessionId).project.processing.queue;
      const running = entry === "run"
        ? coordinator.runBatchJob({ projectSessionId, requestId: "queued-run", config: createTestBatchConfig({ runTranslate: true, runTypeset: false }) })
        : entry === "retry"
          ? coordinator.retryProcessingQueuePage({ projectSessionId, queueId: queue!.queueId, pageImageId: "retry-page", revision: queue!.pages[0]!.revision })
          : coordinator.resumeProcessingQueue({ projectSessionId, queueId: queue!.queueId });
      const draining = coordinator.cancelSessionExecutions(projectSessionId);
      const competing = coordinator.runBatchJob({
        projectSessionId, requestId: "queued-competitor",
        config: createTestBatchConfig({ runTranslate: true, runTypeset: false })
      });
      try {
        expect(release).not.toHaveBeenCalled();
      } finally {
        finishWrite.resolve();
        await Promise.allSettled([saving, running, draining, competing]);
      }
      await expect(competing).rejects.toThrow(/실행 중이거나 일시정지된 처리 큐/);
      expect(await draining).toBe(true);
      expect(await running).toMatchObject({ progress: { stage: "canceled" } });
      expect(executeTranslation).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(manager.getProject(projectSessionId).project.processing.queue?.status).toBe("cancelled");
    }
  );

  it.each(["run", "retry", "resume"] as const)(
    "keeps cancellation while a %s acquisition holds an obtained lease before returning",
    async (entry) => {
      const manager = createProjectSessionManager();
      const project = batchRetryProject(`acquired ${entry}`, undefined);
      if (entry === "resume") {
        let queue = createProcessingQueue({
          queueId: "acquired-resume", projectSessionId: "previous-process",
          pageImageIds: ["retry-page"], revision: 0, now: "2026-10-18T00:00:00.000Z"
        });
        queue = startProcessingQueue(queue, { now: "2026-10-18T00:00:01.000Z" });
        queue.pages[0]!.stage = "translation";
        project.processing.queue = queue;
      }
      const { projectSessionId } = manager.createProjectSession({ project });
      if (entry === "retry") await installFailedBatchQueue(manager, projectSessionId, {
        queueId: "acquired-retry", stage: "translation", code: "BATCH_TRANSLATION_FAILED"
      });
      const acquired = batchGate();
      const finishAcquire = batchGate();
      const events: string[] = [];
      const acquire = manager.acquireBatchProcessingQueue;
      const acquireResume = manager.acquireBatchProcessingQueueResume;
      vi.spyOn(manager, "acquireBatchProcessingQueue").mockImplementation(async (args) => {
        const result = await acquire(args);
        acquired.resolve();
        await finishAcquire.promise;
        events.push("acquisition-returned");
        return result;
      });
      vi.spyOn(manager, "acquireBatchProcessingQueueResume").mockImplementation(async (args) => {
        const result = await acquireResume(args);
        acquired.resolve();
        await finishAcquire.promise;
        events.push("acquisition-returned");
        return result;
      });
      const release = vi.spyOn(manager, "releaseBatchProcessingLease");
      const executeTranslation = vi.fn().mockResolvedValue({ translatedText: "unexpected", engine: "gemini" });
      const coordinator = createBatchExecutionCoordinator({
        translationEngineRegistry: translationRegistry(executeTranslation),
        providerSettingsStore: createProviderSettingsStore(), projectSessionManager: manager
      });
      const queue = manager.getProject(projectSessionId).project.processing.queue;
      const running = entry === "run"
        ? coordinator.runBatchJob({ projectSessionId, requestId: "acquired-run", config: createTestBatchConfig({ runTranslate: true, runTypeset: false }) })
        : entry === "retry"
          ? coordinator.retryProcessingQueuePage({ projectSessionId, queueId: queue!.queueId, pageImageId: "retry-page", revision: queue!.pages[0]!.revision })
          : coordinator.resumeProcessingQueue({ projectSessionId, queueId: queue!.queueId });
      let draining: Promise<boolean> | undefined;
      try {
        await acquired.promise;
        draining = coordinator.cancelSessionExecutions(projectSessionId).then((value) => {
          events.push("drained");
          return value;
        });
        expect(release).not.toHaveBeenCalled();
      } finally {
        finishAcquire.resolve();
        await Promise.allSettled([running, ...(draining ? [draining] : [])]);
      }
      expect(await draining).toBe(true);
      expect(await running).toMatchObject({ progress: { stage: "canceled" } });
      expect(events).toEqual(["acquisition-returned", "drained"]);
      expect(release).toHaveBeenCalledOnce();
      expect(executeTranslation).not.toHaveBeenCalled();
    }
  );

  it("rejects duplicate standalone request IDs without replacing the first cancellation target", async () => {
    const started = batchGate();
    const finish = batchGate();
    let signal: AbortSignal | undefined;
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>(async (_payload, options) => {
      signal = options?.signal;
      started.resolve();
      await finish.promise; // This fake deliberately ignores abort until it returns.
      return { translatedText: "late result", engine: "gemini" };
    });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation), providerSettingsStore: createProviderSettingsStore()
    });
    const options = {
      project: batchRetryProject("standalone lifetime", undefined), requestId: "standalone-lifetime",
      config: createTestBatchConfig({ runTranslate: true, runTypeset: false })
    };
    const running = coordinator.runBatchJob(options);
    let draining: Promise<boolean> | undefined;
    let duplicate: ReturnType<typeof coordinator.runBatchJob> | undefined;
    try {
      await started.promise;
      duplicate = coordinator.runBatchJob(options);
      draining = coordinator.cancelBatchJobAndWait(options.requestId);
      expect(signal?.aborted).toBe(true);
      expect(coordinator.cancelBatchJob(options.requestId)).toBe(true);
    } finally {
      finish.resolve();
      await Promise.allSettled([running, ...(draining ? [draining] : []), ...(duplicate ? [duplicate] : [])]);
    }
    await expect(duplicate).rejects.toThrow(/requestId/);
    expect(await draining).toBe(true);
    const result = await running;
    expect(result.progress.stage).toBe("canceled");
    expect(result.updatedProject.dialogueLines[0]?.aiTranslation).toBeUndefined();
    expect(executeTranslation).toHaveBeenCalledOnce();
    expect(coordinator.cancelBatchJob(options.requestId)).toBe(false);
    await expect(coordinator.cancelBatchJobAndWait(options.requestId)).resolves.toBe(false);
  });

  it.each(["acquire", "initialize", "checkpoint", "final"] as const)(
    "cleans up a failed %s without retaining a request registration",
    async (failure) => {
      const manager = createProjectSessionManager();
      const { projectSessionId } = manager.createProjectSession({ project: batchRetryProject(`failed ${failure}`, undefined) });
      const fault = new Error(`injected ${failure} failure`);
      const acquire = manager.acquireBatchProcessingQueue;
      if (failure === "acquire") vi.spyOn(manager, "acquireBatchProcessingQueue").mockRejectedValueOnce(fault);
      if (failure === "initialize") vi.spyOn(manager, "acquireBatchProcessingQueue").mockImplementationOnce(async (args) => {
        const result = await acquire(args);
        // Fault injection after a real lease was acquired, before processing begins.
        Object.defineProperty(result.project, "dialogueLines", { get: () => { throw fault; } });
        return result;
      });
      const commit = manager.commitMainProjectPatch;
      vi.spyOn(manager, "commitMainProjectPatch").mockImplementation(async (args) => {
        if (args.patch.type === "commit_batch_result" &&
          ((failure === "checkpoint" && !args.patch.queue) || (failure === "final" && args.patch.queue))) throw fault;
        return commit(args);
      });
      const release = vi.spyOn(manager, "releaseBatchProcessingLease");
      const coordinator = createBatchExecutionCoordinator({
        translationEngineRegistry: translationRegistry(vi.fn().mockResolvedValue({ translatedText: "fake translation", engine: "gemini" })),
        providerSettingsStore: createProviderSettingsStore(), projectSessionManager: manager
      });
      await expect(coordinator.runBatchJob({
        projectSessionId, requestId: "reusable-failed-id",
        config: createTestBatchConfig({ runTranslate: true, runTypeset: false })
      })).rejects.toThrow(fault.message);
      expect(release).toHaveBeenCalledTimes(failure === "acquire" ? 0 : 1);
      expect(coordinator.cancelBatchJob("reusable-failed-id")).toBe(false);
      await expect(coordinator.cancelBatchJobAndWait("reusable-failed-id")).resolves.toBe(false);
      await expect(coordinator.runBatchJob({
        project: createEmptyProject("reuse after failure", false), requestId: "reusable-failed-id",
        config: createTestBatchConfig({ runTranslate: false, runTypeset: true })
      })).resolves.toMatchObject({ progress: { stage: "completed" } });
    }
  );

  it.each(["false", "throw"] as const)(
    "settles request and session waiters when lease release returns %s",
    async (failure) => {
      const manager = createProjectSessionManager();
      const { projectSessionId } = manager.createProjectSession({ project: createEmptyProject("empty session lease", false) });
      const acquired = batchGate();
      const finish = batchGate();
      const acquire = manager.acquireBatchProcessingQueue;
      let leaseId: string | undefined;
      vi.spyOn(manager, "acquireBatchProcessingQueue").mockImplementationOnce(async (args) => {
        const result = await acquire(args);
        leaseId = result.leaseId;
        acquired.resolve();
        await finish.promise;
        return result;
      });
      const release = manager.releaseBatchProcessingLease;
      const fault = new Error("injected lease release failure");
      vi.spyOn(manager, "releaseBatchProcessingLease").mockImplementation(() => {
        if (failure === "throw") throw fault;
        return false;
      });
      const executeTranslation = vi.fn();
      const coordinator = createBatchExecutionCoordinator({
        translationEngineRegistry: translationRegistry(executeTranslation),
        providerSettingsStore: createProviderSettingsStore(), projectSessionManager: manager
      });
      const running = coordinator.runBatchJob({ projectSessionId, requestId: "release-failure", config: createTestBatchConfig({ runTranslate: true, runTypeset: false }) });
      let requestDrain: Promise<boolean> | undefined;
      let sessionDrain: Promise<boolean> | undefined;
      let results: PromiseSettledResult<unknown>[] = [];
      try {
        await acquired.promise;
        requestDrain = coordinator.cancelBatchJobAndWait("release-failure");
        sessionDrain = coordinator.cancelSessionExecutions(projectSessionId);
      } finally {
        finish.resolve();
        results = await Promise.allSettled([running, ...(requestDrain ? [requestDrain] : []), ...(sessionDrain ? [sessionDrain] : [])]);
        if (leaseId) release(projectSessionId, leaseId);
      }
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
      const reasons = results.map((result) => (result as PromiseRejectedResult).reason);
      expect(reasons[0]).toBe(reasons[1]);
      expect(reasons[1]).toBe(reasons[2]);
      expect(String(reasons[0])).toContain(failure === "throw" ? fault.message : "lease");
      expect(executeTranslation).not.toHaveBeenCalled();
      expect(coordinator.cancelBatchJob("release-failure")).toBe(false);
      await expect(coordinator.cancelBatchJobAndWait("release-failure")).resolves.toBe(false);
    }
  );

  it("preserves both execution and cleanup failures and still releases drain waiters", async () => {
    const manager = createProjectSessionManager();
    const { projectSessionId } = manager.createProjectSession({ project: batchRetryProject("combined failure", undefined) });
    const acquired = batchGate();
    const finish = batchGate();
    const executionFault = new Error("injected initialization failure");
    const cleanupFault = new Error("injected release failure");
    const acquire = manager.acquireBatchProcessingQueue;
    let leaseId: string | undefined;
    vi.spyOn(manager, "acquireBatchProcessingQueue").mockImplementationOnce(async (args) => {
      const result = await acquire(args);
      leaseId = result.leaseId;
      acquired.resolve();
      await finish.promise;
      Object.defineProperty(result.project, "dialogueLines", { get: () => { throw executionFault; } });
      return result;
    });
    const release = manager.releaseBatchProcessingLease;
    vi.spyOn(manager, "releaseBatchProcessingLease").mockImplementation(() => { throw cleanupFault; });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(vi.fn()),
      providerSettingsStore: createProviderSettingsStore(), projectSessionManager: manager
    });
    const running = coordinator.runBatchJob({ projectSessionId, requestId: "combined-failure", config: createTestBatchConfig({ runTranslate: true, runTypeset: false }) });
    let draining: Promise<boolean> | undefined;
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      await acquired.promise;
      draining = coordinator.cancelSessionExecutions(projectSessionId);
    } finally {
      finish.resolve();
      results = await Promise.allSettled([running, ...(draining ? [draining] : [])]);
      if (leaseId) release(projectSessionId, leaseId);
    }
    expect(results[0]).toMatchObject({ status: "rejected", reason: { errors: [executionFault, cleanupFault] } });
    expect(results[1]).toEqual({ status: "rejected", reason: cleanupFault });
    expect(coordinator.cancelBatchJob("combined-failure")).toBe(false);
  });

  it("warns when cancellation succeeds but the cancelled queue cannot be persisted", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...createEmptyProject("Cancel persistence warning", false),
      pageImages: [{
        id: "cancel-warning-page",
        pageNumber: 1,
        storedRelativePath: "pages/cancel.png",
        originalFileName: "cancel.png",
        sha256: "f".repeat(64),
        byteSize: 100,
        mimeType: "image/png",
        copiedAt: "2026-08-28T11:30:00.000Z"
      }],
      dialogueLines: [{
        ...dummyProject.dialogueLines[0]!,
        id: "cancel-warning-line"
      }]
    };
    const created = projectSessionManager.createProjectSession({ project: sessionProject });
    let providerStarted!: () => void;
    const providerStart = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const registry: TranslationEngineRegistry = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listAdapters: vi.fn(),
      executeTranslation: vi.fn().mockImplementation(async (_payload, options) => {
        providerStarted();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
        });
      })
    };
    const originalCommit = projectSessionManager.commitMainProjectPatch;
    vi.spyOn(projectSessionManager, "commitMainProjectPatch").mockImplementation(async (args) => {
      if (args.patch.type === "update_processing_queue" && args.patch.queue.status === "cancelled") {
        throw new Error("disk unavailable");
      }
      return originalCommit(args);
    });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: registry,
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const running = coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-cancel-persistence-warning",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: false
      }
    });
    await providerStart;
    expect(coordinator.cancelBatchJob("req-cancel-persistence-warning")).toBe(true);

    const result = await running;
    expect(result.progress).toMatchObject({
      stage: "canceled",
      isCanceled: true,
      currentMessage: expect.stringContaining("취소 상태를 프로젝트에 저장하지 못했습니다")
    });
    expect(result.progress.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("disk unavailable") })
    ]));
    expect(result.sessionChange).toBeUndefined();
    expect(projectSessionManager.getProject(created.projectSessionId).project.processing.queue?.status)
      .toBe("running");
  });

  it("surfaces a live queue sync failure without rerunning a successful Provider request", async () => {
    const projectSessionManager = createProjectSessionManager();
    const sessionProject: TranslationProjectV2 = {
      ...createEmptyProject("Live sync warning", false),
      pageImages: [{
        id: "live-sync-page",
        pageNumber: 1,
        storedRelativePath: "pages/live-sync.png",
        originalFileName: "live-sync.png",
        sha256: "2".repeat(64),
        byteSize: 100,
        mimeType: "image/png",
        copiedAt: "2026-08-28T11:45:00.000Z"
      }],
      dialogueLines: [{
        ...dummyProject.dialogueLines[0]!,
        id: "live-sync-line"
      }]
    };
    const created = projectSessionManager.createProjectSession({ project: sessionProject });
    const executeTranslation = vi.fn().mockResolvedValue({
      translatedText: "Provider 성공 결과",
      engine: "test"
    });
    const originalCommit = projectSessionManager.commitMainProjectPatch;
    let failedLiveSync = false;
    vi.spyOn(projectSessionManager, "commitMainProjectPatch").mockImplementation(async (args) => {
      if (!failedLiveSync && args.patch.type === "update_processing_queue") {
        failedLiveSync = true;
        throw new Error("temporary queue write failure");
      }
      return originalCommit(args);
    });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: {
        registerAdapter: vi.fn(),
        getAdapter: vi.fn(),
        listAdapters: vi.fn(),
        executeTranslation
      },
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-live-sync-warning",
      config: {
        targetPages: "all",
        speechStylePreset: "informal",
        runOcr: false,
        runGlossary: false,
        runTranslate: true,
        runInpaint: false,
        runTypeset: false,
        overwriteExisting: false
      }
    });

    expect(executeTranslation).toHaveBeenCalledOnce();
    expect(result.progress.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("완료된 Provider 작업은 다시 실행하지 않습니다")
      })
    ]));
    expect(projectSessionManager.getProject(created.projectSessionId)
      .project.dialogueLines[0]?.aiTranslation).toBe("Provider 성공 결과");
    expect(projectSessionManager.getProject(created.projectSessionId)
      .project.processing.queue?.status).toBe("completed");
  });

  it("durably commits a Provider result before persisting the page as completed", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = batchRetryProject("durable provider order", undefined);
    const created = projectSessionManager.createProjectSession({ project });
    const commitOrder: string[] = [];
    const originalCommit = projectSessionManager.commitMainProjectPatch;
    vi.spyOn(projectSessionManager, "commitMainProjectPatch").mockImplementation(async (args) => {
      if (args.patch.type === "commit_batch_result" && args.patch.dialogueUpdates.length > 0) {
        commitOrder.push("result");
      }
      if (args.patch.type === "update_processing_queue" && args.patch.queue.pages[0]?.status === "completed") {
        commitOrder.push("completed");
      }
      return originalCommit(args);
    });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(vi.fn().mockResolvedValue({
        translatedText: "지불 완료된 번역",
        engine: "test"
      })),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    await coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-durable-provider-order",
      config: createTestBatchConfig({ runTranslate: true, runTypeset: false })
    });

    expect(commitOrder).toEqual(["result", "completed"]);
    expect(projectSessionManager.getProject(created.projectSessionId).project.dialogueLines[0]?.aiTranslation)
      .toBe("지불 완료된 번역");
  });

  it("reopens after the first line checkpoint without calling the Provider for that line again", async () => {
    const firstManager = createProjectSessionManager();
    const project = batchRetryProject("line checkpoint crash", undefined);
    project.dialogueLines.push({
      ...project.dialogueLines[0]!,
      id: "retry-line-2",
      order: 2,
      sourceText: "둘째 원문"
    });
    const created = firstManager.createProjectSession({ project });
    const firstProvider = vi.fn().mockResolvedValue({ translatedText: "첫 대사 결과", engine: "test" });
    const firstCoordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(firstProvider),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager: firstManager
    });

    await expect(firstCoordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-line-checkpoint-crash",
      config: createTestBatchConfig({ runTranslate: true, runTypeset: false }),
      onProgress: (progress) => {
        if (progress.stage === "translate" && progress.currentMessage.includes("대사 2/2")) {
          throw new Error("SIMULATED_PROCESS_CRASH");
        }
      }
    })).rejects.toThrow("SIMULATED_PROCESS_CRASH");

    const diskSnapshot = firstManager.getProject(created.projectSessionId).project;
    expect(diskSnapshot.dialogueLines[0]?.aiTranslation).toBe("첫 대사 결과");
    const restartedManager = createProjectSessionManager({ createId: () => "restarted-line-session" });
    const restarted = restartedManager.createProjectSession({ project: diskSnapshot });
    const resumedProvider = vi.fn().mockResolvedValue({ translatedText: "둘째 대사 결과", engine: "test" });
    const restartedCoordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(resumedProvider),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager: restartedManager
    });

    await restartedCoordinator.resumeProcessingQueue({
      projectSessionId: restarted.projectSessionId,
      queueId: "batch-queue-req-line-checkpoint-crash"
    });

    expect(resumedProvider).toHaveBeenCalledOnce();
    expect(restartedManager.getProject(restarted.projectSessionId).project.dialogueLines)
      .toMatchObject([
        { aiTranslation: "첫 대사 결과" },
        { aiTranslation: "둘째 대사 결과" }
      ]);
  });

  it("keeps page 1 result and completed outcome consistent when execution stops before page 2", async () => {
    const manager = createProjectSessionManager();
    const project = batchRetryProject("page checkpoint crash", undefined);
    project.pageImages.push({
      ...project.pageImages[0]!,
      id: "retry-page-2",
      pageNumber: 2,
      storedRelativePath: "pages/retry-2.png",
      originalFileName: "retry-2.png"
    });
    project.dialogueLines.push({
      ...project.dialogueLines[0]!,
      id: "retry-line-2",
      order: 2,
      pageNumber: 2,
      sourceText: "둘째 페이지 원문"
    });
    const created = manager.createProjectSession({ project });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(vi.fn().mockResolvedValue({
        translatedText: "첫 페이지 durable 결과",
        engine: "test"
      })),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager: manager
    });

    await expect(coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-page-checkpoint-crash",
      config: createTestBatchConfig({ runTranslate: true, runTypeset: false }),
      onProgress: (progress) => {
        if (progress.stage === "translate" && progress.currentMessage.includes("2페이지")) {
          throw new Error("SIMULATED_PAGE_2_CRASH");
        }
      }
    })).rejects.toThrow("SIMULATED_PAGE_2_CRASH");

    const diskSnapshot = manager.getProject(created.projectSessionId).project;
    expect(diskSnapshot.dialogueLines[0]?.aiTranslation).toBe("첫 페이지 durable 결과");
    expect(diskSnapshot.processing.queue?.pages[0]).toMatchObject({
      status: "completed",
      stage: "completed"
    });
    const restartedManager = createProjectSessionManager({ createId: () => "restarted-page-session" });
    const restarted = restartedManager.createProjectSession({ project: diskSnapshot });
    expect(restartedManager.getProject(restarted.projectSessionId).project).toMatchObject({
      dialogueLines: [{ aiTranslation: "첫 페이지 durable 결과" }, expect.any(Object)],
      processing: { queue: { pages: [{ status: "completed" }, { status: "paused" }] } }
    });
  });

  it("durably commits each typesetting page before persisting its completed outcome", async () => {
    const manager = createProjectSessionManager();
    const project = batchRetryProject("typesetting checkpoint crash", "첫 사용자 번역");
    project.pageImages.push({
      ...project.pageImages[0]!,
      id: "retry-page-2",
      pageNumber: 2,
      storedRelativePath: "pages/retry-2.png",
      originalFileName: "retry-2.png"
    });
    project.dialogueLines.push({
      ...project.dialogueLines[0]!,
      id: "retry-line-2",
      order: 2,
      pageNumber: 2,
      userTranslation: "둘째 사용자 번역",
      typesetting: undefined
    });
    const created = manager.createProjectSession({ project });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(vi.fn()),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager: manager
    });

    await expect(coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-typesetting-checkpoint-crash",
      config: createTestBatchConfig({ runTranslate: false, runTypeset: true }),
      onProgress: (progress) => {
        if (progress.stage === "typeset" && progress.currentMessage.includes("2페이지")) {
          throw new Error("SIMULATED_TYPESETTING_PAGE_2_CRASH");
        }
      }
    })).rejects.toThrow("SIMULATED_TYPESETTING_PAGE_2_CRASH");

    const diskSnapshot = manager.getProject(created.projectSessionId).project;
    expect(diskSnapshot.dialogueLines[0]?.typesetting?.fontSizeRatio).toEqual(expect.any(Number));
    expect(diskSnapshot.processing.queue?.pages[0]).toMatchObject({ status: "completed", stage: "completed" });
    const restartedManager = createProjectSessionManager({ createId: () => "restarted-typesetting-session" });
    const restarted = restartedManager.createProjectSession({ project: diskSnapshot });
    expect(restartedManager.getProject(restarted.projectSessionId).project.dialogueLines[0]?.typesetting?.fontSizeRatio)
      .toEqual(expect.any(Number));
  });

  it("does not move the queue page to completed when the durable result commit fails", async () => {
    const manager = createProjectSessionManager();
    const project = batchRetryProject("checkpoint failure", undefined);
    const created = manager.createProjectSession({ project });
    const originalCommit = manager.commitMainProjectPatch;
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation(async (args) => {
      if (args.patch.type === "commit_batch_result" && args.patch.dialogueUpdates.length > 0) {
        throw new Error("checkpoint disk failure");
      }
      return originalCommit(args);
    });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(vi.fn().mockResolvedValue({
        translatedText: "저장되지 않은 결과",
        engine: "test"
      })),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager: manager
    });

    await expect(coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-checkpoint-failure",
      config: createTestBatchConfig({ runTranslate: true, runTypeset: false })
    })).rejects.toThrow("checkpoint disk failure");

    const current = manager.getProject(created.projectSessionId).project;
    expect(current.dialogueLines[0]?.aiTranslation).toBeUndefined();
    expect(current.processing.queue).toMatchObject({
      pages: [{ status: "running", stage: "translation" }]
    });
  });

  it("does not re-call the Provider after queue persistence fails behind a durable line checkpoint", async () => {
    const manager = createProjectSessionManager();
    const project = batchRetryProject("queue persistence failure", undefined);
    const created = manager.createProjectSession({ project });
    const originalCommit = manager.commitMainProjectPatch;
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation(async (args) => {
      if (
        (args.patch.type === "update_processing_queue" && args.patch.queue.pages[0]?.status === "completed") ||
        (args.patch.type === "commit_batch_result" && args.patch.queue?.pages[0]?.status === "completed")
      ) {
        throw new Error("queue disk failure");
      }
      return originalCommit(args);
    });
    const firstProvider = vi.fn().mockResolvedValue({ translatedText: "durable before queue failure", engine: "test" });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(firstProvider),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager: manager
    });

    await expect(coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-queue-persistence-failure",
      config: createTestBatchConfig({ runTranslate: true, runTypeset: false })
    })).rejects.toThrow("queue disk failure");
    const diskSnapshot = manager.getProject(created.projectSessionId).project;
    expect(diskSnapshot.dialogueLines[0]?.aiTranslation).toBe("durable before queue failure");
    expect(diskSnapshot.processing.queue?.status).toBe("running");

    const restartedManager = createProjectSessionManager({ createId: () => "queue-failure-restart" });
    const restarted = restartedManager.createProjectSession({ project: diskSnapshot });
    const resumedProvider = vi.fn();
    const restartedCoordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(resumedProvider),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager: restartedManager
    });
    await restartedCoordinator.resumeProcessingQueue({
      projectSessionId: restarted.projectSessionId,
      queueId: "batch-queue-req-queue-persistence-failure"
    });

    expect(resumedProvider).not.toHaveBeenCalled();
    expect(restartedManager.getProject(restarted.projectSessionId).project.processing.queue?.status).toBe("completed");
  });

  it("retries a failed translation page through the Provider exactly once and commits the fresh result", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = batchRetryProject("retry-translation", undefined);
    const created = projectSessionManager.createProjectSession({ project });
    await installFailedBatchQueue(projectSessionManager, created.projectSessionId, {
      queueId: "queue-retry-translation",
      stage: "translation",
      code: "BATCH_TRANSLATION_FAILED"
    });
    const executeTranslation = vi.fn().mockResolvedValue({ translatedText: "새 번역", engine: "test" });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    await coordinator.retryProcessingQueuePage({
      projectSessionId: created.projectSessionId,
      queueId: "queue-retry-translation",
      pageImageId: "retry-page",
      revision: 0
    });

    const current = projectSessionManager.getProject(created.projectSessionId).project;
    expect(executeTranslation).toHaveBeenCalledOnce();
    expect(current.dialogueLines[0]?.aiTranslation).toBe("새 번역");
    expect(current.processing.queue).toMatchObject({
      queueId: "queue-retry-translation",
      status: "completed",
      pages: [{ status: "completed", stage: "completed" }]
    });
  });

  it("retries a failed typesetting page locally without calling the translation Provider", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = batchRetryProject("retry-typesetting", "사용자 확정 번역");
    const created = projectSessionManager.createProjectSession({ project });
    await installFailedBatchQueue(projectSessionManager, created.projectSessionId, {
      queueId: "queue-retry-typesetting",
      stage: "typesetting",
      code: "BATCH_TYPESETTING_SKIPPED_NO_GEOMETRY"
    });
    const executeTranslation = vi.fn();
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    await coordinator.retryProcessingQueuePage({
      projectSessionId: created.projectSessionId,
      queueId: "queue-retry-typesetting",
      pageImageId: "retry-page",
      revision: 0
    });

    const current = projectSessionManager.getProject(created.projectSessionId).project;
    expect(executeTranslation).not.toHaveBeenCalled();
    expect(current.dialogueLines[0]?.typesetting?.fontSizeRatio).toEqual(expect.any(Number));
    expect(current.processing.queue?.status).toBe("completed");
  });

  it("retries only the selected failed page and preserves other page failures", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = batchRetryProject("page-specific retry", undefined);
    project.pageImages.push({
      ...project.pageImages[0]!,
      id: "retry-page-2",
      pageNumber: 2,
      storedRelativePath: "pages/retry-2.png",
      originalFileName: "retry-2.png"
    });
    project.dialogueLines.push({
      ...project.dialogueLines[0]!,
      id: "retry-line-2",
      order: 2,
      pageNumber: 2,
      sourceText: "둘째 원문"
    });
    const created = projectSessionManager.createProjectSession({ project });
    let queue = createProcessingQueue({
      queueId: "queue-page-specific",
      projectSessionId: created.projectSessionId,
      pageImageIds: ["retry-page", "retry-page-2"],
      revision: 0,
      now: "2026-08-29T00:00:00.000Z"
    });
    queue.status = "failed";
    queue.pages.forEach((page, index) => {
      page.status = "failed";
      page.stage = "translation";
      page.error = {
        code: "BATCH_TRANSLATION_FAILED",
        message: `page ${index + 1} failed`,
        retryable: true,
        stage: "translation"
      };
    });
    await projectSessionManager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: { type: "update_processing_queue", queue }
    });
    const executeTranslation = vi.fn().mockResolvedValue({ translatedText: "둘째 재시도 결과", engine: "test" });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    await coordinator.retryProcessingQueuePage({
      projectSessionId: created.projectSessionId,
      queueId: "queue-page-specific",
      pageImageId: "retry-page-2",
      revision: 0
    });

    const current = projectSessionManager.getProject(created.projectSessionId).project;
    expect(executeTranslation).toHaveBeenCalledOnce();
    expect(current.dialogueLines[0]?.aiTranslation).toBeUndefined();
    expect(current.dialogueLines[1]?.aiTranslation).toBe("둘째 재시도 결과");
    expect(current.processing.queue).toMatchObject({
      status: "failed",
      currentPageIndex: 0,
      pages: [
        { status: "failed", error: { message: "page 1 failed" } },
        { status: "completed", stage: "completed", error: undefined }
      ]
    });
  });

  it("preserves the prior primary and additional failures when a retry fails again", async () => {
    const projectSessionManager = createProjectSessionManager();
    const created = projectSessionManager.createProjectSession({
      project: batchRetryProject("retry failure history", undefined)
    });
    await installFailedBatchQueue(projectSessionManager, created.projectSessionId, {
      queueId: "queue-retry-history",
      stage: "translation",
      code: "BATCH_TRANSLATION_FAILED"
    });
    const savedQueue = structuredClone(
      projectSessionManager.getProject(created.projectSessionId).project.processing.queue!
    );
    savedQueue.pages[0]!.error = {
      code: "BATCH_TRANSLATION_FAILED",
      message: "original provider failure",
      retryable: true,
      stage: "translation",
      details: {
        additionalFailureCount: 1,
        additionalFailure1Code: "BATCH_STALE_CONTEXT_DISCARDED",
        additionalFailure1Message: "original stale detail",
        additionalFailure1Stage: "translation"
      }
    };
    await projectSessionManager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: { type: "update_processing_queue", queue: savedQueue }
    });
    const executeTranslation = vi.fn().mockRejectedValue(new Error("retry provider failure"));
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    await coordinator.retryProcessingQueuePage({
      projectSessionId: created.projectSessionId,
      queueId: "queue-retry-history",
      pageImageId: "retry-page",
      revision: 0
    });

    const error = projectSessionManager.getProject(created.projectSessionId)
      .project.processing.queue?.pages[0]?.error;
    expect(error?.message).toContain("retry provider failure");
    expect(Object.values(error?.details ?? {})).toEqual(expect.arrayContaining([
      "original provider failure",
      "original stale detail"
    ]));
  });

  it("keeps unresolved typesetting work after translation retry and completes only after typesetting retry", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = batchRetryProject("retry unresolved secondary", "사용자 확정 번역");
    const created = projectSessionManager.createProjectSession({ project });
    await installFailedBatchQueue(projectSessionManager, created.projectSessionId, {
      queueId: "queue-retry-unresolved-secondary",
      stage: "translation",
      code: "BATCH_TRANSLATION_FAILED"
    });
    const queue = structuredClone(
      projectSessionManager.getProject(created.projectSessionId).project.processing.queue!
    );
    queue.pages[0]!.error = {
      code: "BATCH_TRANSLATION_FAILED",
      message: "provider failed",
      retryable: true,
      stage: "translation",
      details: {
        additionalFailureCount: 1,
        additionalFailure1Code: "BATCH_TYPESETTING_SKIPPED_NO_GEOMETRY",
        additionalFailure1Message: "typesetting still unresolved",
        additionalFailure1Stage: "typesetting"
      }
    };
    await projectSessionManager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: { type: "update_processing_queue", queue }
    });
    const executeTranslation = vi.fn().mockResolvedValue({ translatedText: "번역 재시도 성공", engine: "test" });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    await coordinator.retryProcessingQueuePage({
      projectSessionId: created.projectSessionId,
      queueId: "queue-retry-unresolved-secondary",
      pageImageId: "retry-page",
      revision: 0
    });

    const afterTranslation = projectSessionManager.getProject(created.projectSessionId).project;
    expect(afterTranslation.dialogueLines[0]?.aiTranslation).toBe("번역 재시도 성공");
    expect(afterTranslation.processing.queue?.pages[0]).toMatchObject({
      status: "failed",
      stage: "typesetting",
      error: {
        code: "BATCH_TYPESETTING_SKIPPED_NO_GEOMETRY",
        message: "typesetting still unresolved",
        stage: "typesetting"
      }
    });
    expect(afterTranslation.processing.queue?.status).toBe("failed");

    const typesettingRevision = afterTranslation.processing.queue!.pages[0]!.revision;
    await coordinator.retryProcessingQueuePage({
      projectSessionId: created.projectSessionId,
      queueId: "queue-retry-unresolved-secondary",
      pageImageId: "retry-page",
      revision: typesettingRevision
    });

    const completed = projectSessionManager.getProject(created.projectSessionId).project;
    expect(executeTranslation).toHaveBeenCalledOnce();
    expect(completed.dialogueLines[0]?.typesetting?.fontSizeRatio).toEqual(expect.any(Number));
    expect(completed.processing.queue).toMatchObject({
      status: "completed",
      pages: [{ status: "completed", stage: "completed", error: undefined }]
    });
  });

  it("regenerates a stale translation retry from the latest live source context", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = batchRetryProject("retry-stale", undefined);
    project.dialogueLines[0]!.aiTranslation = "이전 제안";
    const created = projectSessionManager.createProjectSession({ project });
    await installFailedBatchQueue(projectSessionManager, created.projectSessionId, {
      queueId: "queue-retry-stale",
      stage: "translation",
      code: "BATCH_STALE_CONTEXT_DISCARDED"
    });
    const mutation = await projectSessionManager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: projectSessionManager.getProject(created.projectSessionId).revision,
      mutation: {
        type: "update_dialogue_line",
        lineId: "retry-line",
        patch: { sourceText: "최신 원문" }
      }
    });
    expect(mutation.status).toBe("applied");
    const executeTranslation = vi.fn().mockImplementation(async (payload) => ({
      translatedText: `새 결과:${payload.source.sourceText}`,
      engine: "test"
    }));
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    await coordinator.retryProcessingQueuePage({
      projectSessionId: created.projectSessionId,
      queueId: "queue-retry-stale",
      pageImageId: "retry-page",
      revision: 0
    });

    expect(executeTranslation).toHaveBeenCalledOnce();
    expect(projectSessionManager.getProject(created.projectSessionId).project.dialogueLines[0])
      .toMatchObject({ sourceText: "최신 원문", aiTranslation: "새 결과:최신 원문" });
  });

  it("does not auto-call a Provider for a recovered queue and calls it only after explicit resume", async () => {
    const project = batchRetryProject("restart-resume", undefined);
    let persistedQueue = createProcessingQueue({
      queueId: "queue-restart-resume",
      projectSessionId: "old-process",
      pageImageIds: ["retry-page"],
      revision: 0,
      now: "2026-08-29T00:00:00.000Z"
    });
    persistedQueue = startProcessingQueue(persistedQueue, { now: "2026-08-29T00:00:01.000Z" });
    persistedQueue.pages[0]!.stage = "translation";
    project.processing.queue = persistedQueue;
    const projectSessionManager = createProjectSessionManager({ createId: () => "new-process" });
    const created = projectSessionManager.createProjectSession({ project });
    const executeTranslation = vi.fn().mockResolvedValue({ translatedText: "명시적 재개 결과", engine: "test" });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    expect(projectSessionManager.getProject(created.projectSessionId).project.processing.queue)
      .toMatchObject({ status: "paused", pages: [{ stage: "translation", requiresExternalResume: true }] });
    expect(executeTranslation).not.toHaveBeenCalled();

    await coordinator.resumeProcessingQueue({
      projectSessionId: created.projectSessionId,
      queueId: "queue-restart-resume"
    });

    expect(executeTranslation).toHaveBeenCalledOnce();
    expect(projectSessionManager.getProject(created.projectSessionId).project.dialogueLines[0]?.aiTranslation)
      .toBe("명시적 재개 결과");
  });

  it("stops before the next Provider call when an active Batch is paused", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = batchRetryProject("pause-active", undefined);
    project.dialogueLines.push({
      ...project.dialogueLines[0]!,
      id: "retry-line-2",
      order: 2,
      sourceText: "둘째 원문"
    });
    const created = projectSessionManager.createProjectSession({ project });
    let finishFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstFinished = new Promise<void>((resolve) => { finishFirst = resolve; });
    const executeTranslation = vi.fn().mockImplementation(async () => {
      markFirstStarted();
      await firstFinished;
      return { translatedText: "첫 결과", engine: "test" };
    });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });
    const running = coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-pause-control-plane",
      config: createTestBatchConfig({ runTranslate: true, runTypeset: false })
    });
    await firstStarted;

    let pauseSettled = false;
    const pauseRequest = coordinator.controlProcessingQueue({
      projectSessionId: created.projectSessionId,
      queueId: "batch-queue-req-pause-control-plane",
      action: "pause"
    }).then((result) => {
      pauseSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(pauseSettled).toBe(false);
    expect(projectSessionManager.getProject(created.projectSessionId).project.processing.queue?.status)
      .toBe("running");
    await expect(coordinator.resumeProcessingQueue({
      projectSessionId: created.projectSessionId,
      queueId: "batch-queue-req-pause-control-plane"
    })).rejects.toThrow();
    finishFirst();
    await expect(pauseRequest).resolves.toMatchObject({ control: { status: "settled" }, queue: { status: "paused" } });
    await running;

    const current = projectSessionManager.getProject(created.projectSessionId).project;
    expect(executeTranslation).toHaveBeenCalledOnce();
    expect(current.dialogueLines[0]?.aiTranslation).toBe("첫 결과");
    expect(current.dialogueLines[1]?.aiTranslation).toBeUndefined();
    expect(current.processing.queue?.status).toBe("paused");
  });

  it("does not calculate remaining typesetting pages after cancellation or revive the queue", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = batchRetryProject("cancel-typesetting", "첫 번역");
    project.pageImages.push({
      ...project.pageImages[0]!,
      id: "retry-page-2",
      pageNumber: 2,
      storedRelativePath: "pages/retry-2.png",
      originalFileName: "retry-2.png"
    });
    project.dialogueLines.push({
      ...project.dialogueLines[0]!,
      id: "retry-line-2",
      order: 2,
      pageNumber: 2,
      userTranslation: "둘째 번역",
      typesetting: undefined
    });
    const created = projectSessionManager.createProjectSession({ project });
    const executeTranslation = vi.fn();
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    const result = await coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "req-cancel-typesetting-pages",
      config: createTestBatchConfig({ runTranslate: false, runTypeset: true }),
      onProgress: (progress) => {
        if (progress.stage === "typeset" && progress.currentMessage.includes("2페이지")) {
          coordinator.cancelBatchJob("req-cancel-typesetting-pages");
        }
      }
    });

    expect(executeTranslation).not.toHaveBeenCalled();
    expect(result.progress).toMatchObject({ stage: "canceled", isCanceled: true });
    expect(result.progress.pageStatuses[1]?.typesettingDone).toBe(true);
    expect(result.progress.pageStatuses[2]?.typesettingDone).toBe(false);
    expect(projectSessionManager.getProject(created.projectSessionId).project.processing.queue?.status)
      .toBe("cancelled");
  });

  it("does not start a second Batch in a dialogue-only project without page images", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = batchRetryProject("dialogue-only lease", undefined);
    project.pageImages = [];
    const created = projectSessionManager.createProjectSession({ project });
    let providerStarted!: () => void;
    let finishProvider!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const finished = new Promise<void>((resolve) => { finishProvider = resolve; });
    const executeTranslation = vi.fn().mockImplementation(async () => {
      providerStarted();
      await finished;
      return { translatedText: "첫 Batch", engine: "test" };
    });
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });
    const config = createTestBatchConfig({ runTranslate: true, runTypeset: false });

    const first = coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "dialogue-only-first",
      config
    });
    await started;
    await expect(coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "dialogue-only-second",
      config
    })).rejects.toThrow(/Batch/);
    finishProvider();
    await first;

    expect(executeTranslation).toHaveBeenCalledOnce();
  });

  it("preserves the last typesetting checkpoint and cancels before the final commit", async () => {
    const manager = createProjectSessionManager();
    const created = manager.createProjectSession({ project: batchRetryProject("last checkpoint cancel", "확정 번역") });
    const entered = batchGate();
    const release = batchGate();
    const commit = manager.commitMainProjectPatch.bind(manager);
    const finalCommits: string[] = [];
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation(async (args) => {
      if (args.patch.type === "commit_batch_result" && !args.patch.queue) {
        const result = await commit(args);
        entered.resolve();
        await release.promise;
        return result;
      }
      if (args.patch.type === "commit_batch_result" && args.patch.queue) finalCommits.push(args.patch.queue.status);
      return commit(args);
    });
    const coordinator = createBatchExecutionCoordinator({
      projectSessionManager: manager,
      providerSettingsStore: createProviderSettingsStore(),
      translationEngineRegistry: translationRegistry(vi.fn())
    });
    const running = coordinator.runBatchJob({
      projectSessionId: created.projectSessionId,
      requestId: "last-checkpoint-cancel",
      config: createTestBatchConfig({ runTranslate: false, runTypeset: true })
    });
    try {
      await entered.promise;
      expect(coordinator.cancelBatchJob("last-checkpoint-cancel")).toBe(true);
    } finally {
      release.resolve();
    }
    const result = await running;
    expect(result.progress).toMatchObject({ stage: "canceled", isCanceled: true });
    expect(result.sessionChange?.project.project.processing.queue?.status).toBe("cancelled");
    expect(manager.getProject(created.projectSessionId).project.dialogueLines[0]?.typesetting).toBeDefined();
    expect(finalCommits).toEqual([]);
  });

  it("does not turn a paused queue running when its stage has no Batch executor", async () => {
    const project = batchRetryProject("no executor resume", undefined);
    let queue = createProcessingQueue({
      queueId: "queue-no-executor",
      projectSessionId: "old-session",
      pageImageIds: ["retry-page"],
      revision: 0,
      now: "2026-08-29T00:00:00.000Z"
    });
    queue = startProcessingQueue(queue, { now: "2026-08-29T00:00:01.000Z" });
    queue = pauseProcessingQueue(queue, { now: "2026-08-29T00:00:02.000Z" });
    project.processing.queue = queue;
    const projectSessionManager = createProjectSessionManager();
    const created = projectSessionManager.createProjectSession({ project });
    const executeTranslation = vi.fn();
    const coordinator = createBatchExecutionCoordinator({
      translationEngineRegistry: translationRegistry(executeTranslation),
      providerSettingsStore: createProviderSettingsStore(),
      projectSessionManager
    });

    await expect(coordinator.resumeProcessingQueue({
      projectSessionId: created.projectSessionId,
      queueId: "queue-no-executor"
    })).rejects.toThrow(/executor/);

    expect(executeTranslation).not.toHaveBeenCalled();
    expect(projectSessionManager.getProject(created.projectSessionId).project.processing.queue?.status)
      .toBe("paused");
  });
});

describe("Batch queue control settlement", () => {
  it.each([false, true])("preserves unresolved retry history when paused mid-page (provider failure=%s)", async (providerFails) => {
    const manager = createProjectSessionManager();
    const project = batchRetryProject("paused retry history", undefined);
    project.dialogueLines.push({ ...project.dialogueLines[0]!, id: "unstarted-line", order: 2 });
    const created = manager.createProjectSession({ project });
    await installFailedBatchQueue(manager, created.projectSessionId, {
      queueId: "paused-retry-history", stage: "translation", code: "BATCH_STALE_CONTEXT_DISCARDED"
    });
    const queue = structuredClone(manager.getProject(created.projectSessionId).project.processing.queue!);
    queue.pages[0]!.error = {
      code: "BATCH_STALE_CONTEXT_DISCARDED", message: "prior-context-failure", retryable: true, stage: "translation",
      details: { speechStylePreset: "honorific", overwriteExisting: true,
        additionalFailure1Code: "BATCH_TYPESETTING_SKIPPED_NO_GEOMETRY", additionalFailure1Message: "prior-typesetting-failure", additionalFailure1Stage: "typesetting", additionalFailureCount: 1 }
    };
    await manager.commitMainProjectPatch({ projectSessionId: created.projectSessionId, patch: { type: "update_processing_queue", queue } });
    const entered = batchGate(); const release = batchGate();
    const translate = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockImplementation(async () => {
      entered.resolve(); await release.promise;
      if (providerFails) throw new Error("current-provider-failure");
      return { translatedText: "첫 재시도 checkpoint", engine: "local_ai" };
    });
    const coordinator = createBatchExecutionCoordinator({ projectSessionManager: manager, providerSettingsStore: createProviderSettingsStore(), translationEngineRegistry: translationRegistry(translate) });
    const running = coordinator.retryProcessingQueuePage({ projectSessionId: created.projectSessionId, queueId: queue.queueId, pageImageId: "retry-page", revision: 0 });
    let pause!: ReturnType<typeof coordinator.controlProcessingQueue>;
    try {
      await entered.promise;
      pause = coordinator.controlProcessingQueue({ projectSessionId: created.projectSessionId, queueId: queue.queueId, action: "pause" });
    } finally { release.resolve(); }
    const [result, controlled] = await Promise.all([running, pause]);
    expect(result.progress.stage).toBe(providerFails ? "failed" : "partial");
    expect(controlled.queue).toMatchObject({ status: "failed", currentPageIndex: 0 });
    const error = controlled.queue.pages[0]?.error;
    expect(error).toMatchObject({ code: providerFails ? "BATCH_TRANSLATION_FAILED" : "BATCH_STALE_CONTEXT_DISCARDED",
      details: { speechStylePreset: "honorific", overwriteExisting: true } });
    expect([error?.message, ...Object.values(error?.details ?? {})]).toEqual(expect.arrayContaining([
      "prior-context-failure", "prior-typesetting-failure", "BATCH_TYPESETTING_SKIPPED_NO_GEOMETRY"
    ]));
    if (providerFails) expect(JSON.stringify(controlled.queue.pages[0]?.error)).toContain("current-provider-failure");
    expect(manager.getProject(created.projectSessionId).project.dialogueLines[1]?.aiTranslation).toBeUndefined();
    expect(translate).toHaveBeenCalledOnce();
  });

  it.each(["translation", "typesetting"] as const)("cancels after the last %s outcome before final save", async (stage) => {
    const manager = createProjectSessionManager();
    const created = manager.createProjectSession({ project: batchRetryProject("last outcome cancel", stage === "typesetting" ? "확정 번역" : undefined) });
    const entered = batchGate(); const release = batchGate();
    const commit = manager.commitMainProjectPatch.bind(manager);
    let finalCommits = 0;
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation(async (args) => {
      if (args.patch.type === "update_processing_queue" && args.patch.queue.status === "running" && args.patch.queue.pages[0]?.stage === "completed") {
        const result = await commit(args); entered.resolve(); await release.promise; return result;
      }
      if (args.patch.type === "commit_batch_result" && args.patch.queue) finalCommits++;
      return commit(args);
    });
    const translate = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockResolvedValue({ translatedText: "checkpoint 번역", engine: "local_ai" });
    const coordinator = createBatchExecutionCoordinator({ projectSessionManager: manager, providerSettingsStore: createProviderSettingsStore(), translationEngineRegistry: translationRegistry(translate) });
    const running = coordinator.runBatchJob({ projectSessionId: created.projectSessionId, requestId: "last-outcome", config: createTestBatchConfig({ runTranslate: stage === "translation", runTypeset: stage === "typesetting" }) });
    let cancel!: ReturnType<typeof coordinator.controlProcessingQueue>;
    try {
      await entered.promise;
      cancel = coordinator.controlProcessingQueue({ projectSessionId: created.projectSessionId, queueId: "batch-queue-last-outcome", action: "cancel" });
    } finally { release.resolve(); }
    expect((await running).progress.stage).toBe("canceled");
    expect(await cancel).toMatchObject({ queue: { status: "cancelled" }, control: { status: "settled" } });
    const line = manager.getProject(created.projectSessionId).project.dialogueLines[0];
    if (stage === "translation") expect(line?.aiTranslation).toBe("checkpoint 번역");
    else expect(line?.typesetting).toBeDefined();
    expect(finalCommits).toBe(0);
  });

  it("returns completion when pause arrives during the only remaining checkpoint", async () => {
    const entered = batchGate(); const release = batchGate();
    const translate = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockResolvedValue({ translatedText: "완료 번역", engine: "local_ai" });
    const { manager, coordinator, projectSessionId, queueId, running } = startControlledBatch(translate, "no-remaining");
    const commit = manager.commitMainProjectPatch.bind(manager);
    let pausedWrites = 0;
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation(async (args) => {
      if (args.patch.type === "commit_batch_result" && !args.patch.queue) {
        entered.resolve(); await release.promise;
      }
      if (args.patch.type === "update_processing_queue" && args.patch.queue.status === "paused") pausedWrites++;
      return commit(args);
    });
    let pause!: ReturnType<typeof coordinator.controlProcessingQueue>;
    try {
      await entered.promise;
      pause = coordinator.controlProcessingQueue({ projectSessionId, queueId, action: "pause" });
    } finally { release.resolve(); }
    expect((await running).progress.stage).toBe("completed");
    expect(await pause).toMatchObject({ queue: { status: "completed" }, control: { status: "settled" } });
    expect(pausedWrites).toBe(0);
  });

  it("preserves failed typesetting and unstarted pages when paused after its outcome", async () => {
    const manager = createProjectSessionManager();
    const project = batchRetryProject("typeset failure pause", "확정 번역");
    project.dialogueLines[0]!.polygon = undefined;
    project.pageImages.push({ ...project.pageImages[0]!, id: "next-page", pageNumber: 2 });
    project.dialogueLines.push({ ...project.dialogueLines[0]!, id: "next-line", order: 2, pageNumber: 2 });
    const created = manager.createProjectSession({ project });
    const entered = batchGate(); const release = batchGate();
    const commit = manager.commitMainProjectPatch.bind(manager);
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation(async (args) => {
      const result = await commit(args);
      if (args.patch.type === "update_processing_queue" && args.patch.queue.status === "running" && args.patch.queue.pages[0]?.status === "failed") {
        entered.resolve(); await release.promise;
      }
      return result;
    });
    const coordinator = createBatchExecutionCoordinator({ projectSessionManager: manager, providerSettingsStore: createProviderSettingsStore(), translationEngineRegistry: translationRegistry(vi.fn()) });
    const running = coordinator.runBatchJob({ projectSessionId: created.projectSessionId, requestId: "typeset-pause-failed", config: createTestBatchConfig({ runTranslate: false, runTypeset: true }) });
    let pause!: ReturnType<typeof coordinator.controlProcessingQueue>;
    try {
      await entered.promise;
      pause = coordinator.controlProcessingQueue({ projectSessionId: created.projectSessionId, queueId: "batch-queue-typeset-pause-failed", action: "pause" });
    } finally { release.resolve(); }
    expect((await running).progress.stage).toBe("failed");
    expect((await pause).queue).toMatchObject({ status: "failed", currentPageIndex: 0,
      pages: [{ status: "failed", stage: "typesetting", error: { code: "BATCH_TYPESETTING_SKIPPED_NO_GEOMETRY" } }, { status: "pending", stage: "typesetting" }] });
  });

  it("publishes acquired identity before the first provider and never commits again after pause", async () => {
    const manager = createProjectSessionManager();
    const project = batchRetryProject("pause early return", undefined);
    project.dialogueLines.push({ ...project.dialogueLines[0]!, id: "second-line", order: 2 });
    const created = manager.createProjectSession({ project });
    const providerEntered = batchGate(); const releaseProvider = batchGate();
    const events: string[] = [];
    const translate = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockImplementation(async () => {
      events.push("provider"); providerEntered.resolve(); await releaseProvider.promise;
      return { translatedText: "첫 checkpoint", engine: "local_ai" };
    });
    const coordinator = createBatchExecutionCoordinator({ projectSessionManager: manager,
      translationEngineRegistry: translationRegistry(translate), providerSettingsStore: createProviderSettingsStore() });
    const commit = manager.commitMainProjectPatch.bind(manager);
    const writes: string[] = [];
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation((args) => {
      if (args.patch.type === "commit_batch_result") writes.push(args.patch.queue ? "final" : "checkpoint");
      return commit(args);
    });
    let cancel!: ReturnType<typeof coordinator.controlProcessingQueue>;
    let close!: Promise<void>;
    const running = coordinator.runBatchJob({ projectSessionId: created.projectSessionId, requestId: "pause-no-final",
      config: createTestBatchConfig({ runTranslate: true, runTypeset: false }),
      onProgress: (progress, identity) => {
        if (!events.length && identity) events.push(`identity:${identity.projectSessionId}:${identity.queueId}`);
        if (progress.stage === "partial") {
          cancel = coordinator.controlProcessingQueue({ projectSessionId: created.projectSessionId, queueId: "batch-queue-pause-no-final", action: "cancel" });
          close = coordinator.cancelSessionExecutions(created.projectSessionId).then(() => manager.closeProject({ projectSessionId: created.projectSessionId }));
        }
      }
    });
    let pause!: ReturnType<typeof coordinator.controlProcessingQueue>;
    try {
      await providerEntered.promise;
      pause = coordinator.controlProcessingQueue({ projectSessionId: created.projectSessionId, queueId: "batch-queue-pause-no-final", action: "pause" });
    } finally { releaseProvider.resolve(); }
    await Promise.all([running, pause]);
    expect(await cancel).toMatchObject({ queue: { status: "cancelled" }, control: { status: "settled" } });
    await close;
    expect(writes).toEqual(["checkpoint"]);
    expect(events).toEqual([`identity:${created.projectSessionId}:batch-queue-pause-no-final`, "provider"]);
    expect(translate).toHaveBeenCalledOnce();
    expect(() => manager.getProject(created.projectSessionId)).toThrow();
  });

  it("keeps checkpoint failure fatal when cancel is already accepted", async () => {
    const checkpointEntered = batchGate(); const releaseCheckpoint = batchGate();
    const translate = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockResolvedValue({ translatedText: "아직 저장 안 됨", engine: "local_ai" });
    const { manager, coordinator, projectSessionId, queueId, running } = startControlledBatch(translate);
    const observedRun = running.catch((error: unknown) => error);
    const commit = manager.commitMainProjectPatch.bind(manager);
    let cancelWrites = 0;
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation(async (args) => {
      if (args.patch.type === "commit_batch_result" && !args.patch.queue) {
        checkpointEntered.resolve(); await releaseCheckpoint.promise; throw new Error("fatal-checkpoint-save");
      }
      if (args.patch.type === "update_processing_queue" && args.patch.queue.status === "cancelled") cancelWrites++;
      return commit(args);
    });
    let cancel!: ReturnType<typeof coordinator.controlProcessingQueue>;
    try {
      await checkpointEntered.promise;
      cancel = coordinator.controlProcessingQueue({ projectSessionId, queueId, action: "cancel" });
    } finally { releaseCheckpoint.resolve(); }
    expect(await observedRun).toMatchObject({ message: "fatal-checkpoint-save" });
    expect(await cancel).toMatchObject({ queue: { status: "running" }, control: { status: "failed", message: "fatal-checkpoint-save" } });
    expect(cancelWrites).toBe(0);
    expect(translate).toHaveBeenCalledOnce();
  });

  it.each([false, true])("reports lease cleanup failure through queue control (throws=%s)", async (throws) => {
    const entered = batchGate(); const release = batchGate();
    const translate = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockImplementation(async () => {
      entered.resolve(); await release.promise;
      return { translatedText: "late", engine: "local_ai" };
    });
    const { manager, coordinator, projectSessionId, queueId, running } = startControlledBatch(translate);
    const observedRun = running.catch((error: unknown) => error);
    vi.spyOn(manager, "releaseBatchProcessingLease").mockImplementation(() => {
      if (throws) throw new Error("cleanup-refused");
      return false;
    });
    let cancel!: ReturnType<typeof coordinator.controlProcessingQueue>;
    try {
      await entered.promise;
      cancel = coordinator.controlProcessingQueue({ projectSessionId, queueId, action: "cancel" });
    } finally { release.resolve(); }
    expect(await observedRun).toBeInstanceOf(Error);
    const controlled = await cancel;
    expect(controlled).toMatchObject({ queue: { status: "cancelled" }, control: { status: "failed" } });
    if (controlled.control.status === "failed") expect(controlled.control.message).toContain(throws ? "cleanup-refused" : "lease");
  });

  it.each(["pause-first", "cancel-first"] as const)("keeps cancel sticky with duplicate controls (%s)", async (order) => {
    const entered = batchGate();
    const release = batchGate();
    const translate = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { translatedText: "늦게 도착한 결과", engine: "local_ai" };
    });
    const { manager, coordinator, projectSessionId, queueId, running } = startControlledBatch(translate);
    const controls: Array<ReturnType<typeof coordinator.controlProcessingQueue>> = [];
    let cancelWrites = 0;
    const commit = manager.commitMainProjectPatch.bind(manager);
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation((args) => {
      if (args.patch.type === "update_processing_queue" && args.patch.queue.status === "cancelled") cancelWrites++;
      return commit(args);
    });
    try {
      await entered.promise;
      const actions = order === "pause-first" ? ["pause", "cancel", "pause", "cancel"] as const : ["cancel", "pause", "cancel", "pause"] as const;
      for (const action of actions) controls.push(coordinator.controlProcessingQueue({ projectSessionId, queueId, action }));
    } finally {
      release.resolve();
    }
    const result = await running;
    for (const control of await Promise.all(controls)) {
      expect(control).toMatchObject({ control: { status: "settled" }, queue: { status: "cancelled" } });
    }
    expect(result.progress.stage).toBe("canceled");
    expect(translate).toHaveBeenCalledOnce();
    expect(manager.getProject(projectSessionId).project.dialogueLines[0]?.aiTranslation).toBeUndefined();
    expect(cancelWrites).toBe(1);
  });

  it.each([
    { pauseFails: false, cancelFails: false },
    { pauseFails: true, cancelFails: false },
    { pauseFails: false, cancelFails: true },
    { pauseFails: true, cancelFails: true }
  ])("settles pause-save/cancel overlap with actual state: %j", async ({ pauseFails, cancelFails }) => {
    const providerEntered = batchGate();
    const releaseProvider = batchGate();
    const pauseEntered = batchGate();
    const releasePause = batchGate();
    const translate = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockImplementation(async () => {
      providerEntered.resolve();
      await releaseProvider.promise;
      return { translatedText: "저장된 첫 결과", engine: "local_ai" };
    });
    const { manager, coordinator, projectSessionId, queueId, running } = startControlledBatch(translate);
    const commit = manager.commitMainProjectPatch.bind(manager);
    const writes: string[] = [];
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation(async (args) => {
      if (args.patch.type === "update_processing_queue" && args.patch.queue.status === "paused") {
        writes.push("pause");
        pauseEntered.resolve();
        await releasePause.promise;
        if (pauseFails) throw new Error("pause-save-failed");
      }
      if (args.patch.type === "update_processing_queue" && args.patch.queue.status === "cancelled") {
        writes.push("cancel");
        if (cancelFails) throw new Error("cancel-save-failed");
      }
      if (args.patch.type === "commit_batch_result" && args.patch.queue) writes.push("final");
      return commit(args);
    });
    let pause!: ReturnType<typeof coordinator.controlProcessingQueue>;
    let cancel!: ReturnType<typeof coordinator.controlProcessingQueue>;
    try {
      await providerEntered.promise;
      pause = coordinator.controlProcessingQueue({ projectSessionId, queueId, action: "pause" });
      releaseProvider.resolve();
      await pauseEntered.promise;
      cancel = coordinator.controlProcessingQueue({ projectSessionId, queueId, action: "cancel" });
    } finally {
      releaseProvider.resolve();
      releasePause.resolve();
    }
    const [result, pauseResult, cancelResult] = await Promise.all([running, pause, cancel]);
    const expectedState = cancelFails ? (pauseFails ? "running" : "paused") : "cancelled";
    expect(result.progress.stage).toBe("canceled");
    expect(pauseResult.queue.status).toBe(expectedState);
    expect(cancelResult.queue.status).toBe(expectedState);
    expect(pauseResult.control.status).toBe(pauseFails || cancelFails ? "failed" : "settled");
    expect(cancelResult.control.status).toBe(cancelFails ? "failed" : "settled");
    expect(Boolean(result.sessionChange)).toBe(!cancelFails);
    if (pauseFails) expect(result.progress.errors.some((error) => error.message.includes("pause-save-failed"))).toBe(true);
    if (cancelFails) expect(result.progress.errors.some((error) => error.message.includes("cancel-save-failed"))).toBe(true);
    expect(manager.getProject(projectSessionId).project.dialogueLines[0]?.aiTranslation).toBe("저장된 첫 결과");
    expect(writes).toEqual(["pause", "cancel"]);
    expect(translate).toHaveBeenCalledOnce();
  });

  it("reports a pause-save failure without retrying it or committing a final result", async () => {
    const entered = batchGate();
    const release = batchGate();
    const translate = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockImplementation(async () => {
      entered.resolve(); await release.promise;
      return { translatedText: "checkpoint", engine: "local_ai" };
    });
    const { manager, coordinator, projectSessionId, queueId, running } = startControlledBatch(translate);
    const observedRun = running.catch((error: unknown) => error);
    const commit = manager.commitMainProjectPatch.bind(manager);
    const writes: string[] = [];
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation((args) => {
      if (args.patch.type === "update_processing_queue" && args.patch.queue.status === "paused") {
        writes.push("pause"); return Promise.reject(new Error("pause-alone-failed"));
      }
      if (args.patch.type === "commit_batch_result" && args.patch.queue) writes.push("final");
      return commit(args);
    });
    let pause!: ReturnType<typeof coordinator.controlProcessingQueue>;
    try {
      await entered.promise;
      pause = coordinator.controlProcessingQueue({ projectSessionId, queueId, action: "pause" });
    } finally { release.resolve(); }
    expect(await observedRun).toMatchObject({ message: "pause-alone-failed" });
    expect(await pause).toMatchObject({ control: { status: "failed", message: "pause-alone-failed" }, queue: { status: "running" } });
    expect(writes).toEqual(["pause"]);
  });

  it.each([
    { failFinal: false, failWork: false }, { failFinal: true, failWork: false }, { failFinal: false, failWork: true }
  ])("rejects cancel after final manager invocation and drains %j", async ({ failFinal, failWork }) => {
    const manager = createProjectSessionManager();
    const project = batchRetryProject("final fence", "확정 번역");
    if (failWork) project.dialogueLines[0]!.polygon = undefined;
    const created = manager.createProjectSession({ project });
    const entered = batchGate();
    const release = batchGate();
    const commit = manager.commitMainProjectPatch.bind(manager);
    let cancelWrites = 0;
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation(async (args) => {
      if (args.patch.type === "commit_batch_result" && args.patch.queue) {
        entered.resolve(); await release.promise;
        if (failFinal) throw new Error("final-save-failed");
      }
      if (args.patch.type === "update_processing_queue" && args.patch.queue.status === "cancelled") cancelWrites++;
      return commit(args);
    });
    const coordinator = createBatchExecutionCoordinator({ projectSessionManager: manager,
      providerSettingsStore: createProviderSettingsStore(), translationEngineRegistry: translationRegistry(vi.fn()) });
    const running = coordinator.runBatchJob({ projectSessionId: created.projectSessionId,
      requestId: "final-fence", config: createTestBatchConfig({ runTranslate: false, runTypeset: true }) });
    const observedRun = running.catch((error: unknown) => error);
    let drainSettled = false;
    let drain!: Promise<boolean>;
    let control!: ReturnType<typeof coordinator.controlProcessingQueue>;
    try {
      await entered.promise;
      expect(coordinator.cancelBatchJob("final-fence")).toBe(false);
      drain = coordinator.cancelBatchJobAndWait("final-fence").then((found) => { drainSettled = true; return found; });
      control = coordinator.controlProcessingQueue({ projectSessionId: created.projectSessionId, queueId: "batch-queue-final-fence", action: "cancel" });
      expect(drainSettled).toBe(false);
    } finally { release.resolve(); }
    const result = await observedRun;
    const controlled = await control;
    expect(await drain).toBe(true);
    expect(controlled.control.status).toBe(failFinal ? "failed" : "settled");
    expect(controlled.queue.status).toBe(failFinal ? "running" : failWork ? "failed" : "completed");
    if (failFinal) expect(result).toMatchObject({ message: "final-save-failed" });
    else expect(result).toMatchObject({ progress: { stage: failWork ? "partial" : "completed" } });
    expect(cancelWrites).toBe(0);
  });

  it.each(["same-page", "next-page", "no-remaining"] as const)("preserves provider failure when pause arrives with %s work", async (remaining) => {
    const entered = batchGate(); const release = batchGate();
    const translate = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockImplementation(async () => {
      entered.resolve(); await release.promise; throw new Error("provider-rejected");
    });
    const { manager, coordinator, projectSessionId, queueId, running } = startControlledBatch(translate, remaining);
    let pause!: ReturnType<typeof coordinator.controlProcessingQueue>;
    try {
      await entered.promise;
      pause = coordinator.controlProcessingQueue({ projectSessionId, queueId, action: "pause" });
    } finally { release.resolve(); }
    const [result, control] = await Promise.all([running, pause]);
    expect(result.progress.stage).toBe("failed");
    expect(result.progress.currentMessage).not.toContain("일시정지되었습니다");
    expect(control.queue).toMatchObject({ status: "failed", currentPageIndex: 0 });
    expect(control.queue.pages[0]).toMatchObject({ status: "failed", stage: "translation", error: { retryable: true } });
    if (remaining === "next-page") expect(control.queue.pages[1]).toMatchObject({ status: "pending", stage: "translation" });
    expect(translate).toHaveBeenCalledOnce();
    await expect(coordinator.resumeProcessingQueue({ projectSessionId, queueId })).rejects.toThrow();
    expect(manager.getProject(projectSessionId).project.dialogueLines[0]?.aiTranslation).toBeUndefined();
  });
});

function startControlledBatch(
  executeTranslation: TranslationEngineRegistry["executeTranslation"],
  remaining: "same-page" | "next-page" | "no-remaining" = "same-page"
) {
  const project = batchRetryProject("controlled batch", undefined);
  if (remaining !== "no-remaining") project.dialogueLines.push({ ...project.dialogueLines[0]!, id: "second-line", order: 2, pageNumber: remaining === "next-page" ? 2 : 1 });
  if (remaining === "next-page") project.pageImages.push({ ...project.pageImages[0]!, id: "second-page", pageNumber: 2 });
  const manager = createProjectSessionManager();
  const created = manager.createProjectSession({ project });
  const coordinator = createBatchExecutionCoordinator({ projectSessionManager: manager,
    providerSettingsStore: createProviderSettingsStore(), translationEngineRegistry: translationRegistry(executeTranslation) });
  const requestId = "controlled-batch";
  const running = coordinator.runBatchJob({ projectSessionId: created.projectSessionId, requestId,
    config: createTestBatchConfig({ runTranslate: true, runTypeset: false }) });
  return { manager, coordinator, projectSessionId: created.projectSessionId, queueId: `batch-queue-${requestId}`, running };
}

function batchGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function batchRetryProject(title: string, userTranslation: string | undefined): TranslationProjectV2 {
  const project = createEmptyProject(title, false);
  project.pageImages = [{
    id: "retry-page",
    pageNumber: 1,
    storedRelativePath: "pages/retry.png",
    originalFileName: "retry.png",
    sha256: "9".repeat(64),
    byteSize: 100,
    mimeType: "image/png",
    copiedAt: "2026-08-29T00:00:00.000Z"
  }];
  project.dialogueLines = [{
    id: "retry-line",
    order: 1,
    pageNumber: 1,
    sourceLanguage: "ja",
    sourceText: "원문",
    userTranslation,
    dialogueType: "speech",
    lineStatus: userTranslation ? "draft" : "untranslated",
    parseConfidence: 1,
    parseWarnings: [],
    polygon: [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.3 },
      { x: 0.1, y: 0.3 }
    ],
    origin: { kind: "manual" }
  }];
  return normalizeProject(project);
}

async function installFailedBatchQueue(
  manager: ReturnType<typeof createProjectSessionManager>,
  projectSessionId: string,
  args: { queueId: string; stage: "translation" | "typesetting"; code: string }
): Promise<void> {
  let queue = createProcessingQueue({
    queueId: args.queueId,
    projectSessionId,
    pageImageIds: ["retry-page"],
    revision: 0,
    now: "2026-08-29T00:00:00.000Z"
  });
  queue = startProcessingQueue(queue, { now: "2026-08-29T00:00:01.000Z" });
  queue.pages[0]!.stage = args.stage;
  queue = failProcessingQueuePage(queue, {
    pageImageId: "retry-page",
    revision: 0,
    now: "2026-08-29T00:00:02.000Z",
    error: {
      code: args.code,
      message: "retry me",
      retryable: true,
      stage: args.stage
    }
  });
  await manager.commitMainProjectPatch({
    projectSessionId,
    patch: { type: "update_processing_queue", queue }
  });
}

function translationRegistry(
  executeTranslation: TranslationEngineRegistry["executeTranslation"]
): TranslationEngineRegistry {
  return {
    registerAdapter: vi.fn(),
    getAdapter: vi.fn(),
    listAdapters: vi.fn(),
    executeTranslation
  };
}

function createTestBatchConfig(overrides: { runTranslate: boolean; runTypeset: boolean }) {
  return {
    targetPages: "all" as const,
    speechStylePreset: "informal" as const,
    runOcr: false,
    runGlossary: false,
    runTranslate: overrides.runTranslate,
    runInpaint: false,
    runTypeset: overrides.runTypeset,
    overwriteExisting: false
  };
}
