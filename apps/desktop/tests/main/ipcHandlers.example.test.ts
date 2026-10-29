// @vitest-environment node
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIpcHandlers } from "../../src/main/ipcHandlers";
import { createProjectSessionManager } from "../../src/main/projectSessions";
import { createRecentProjectRegistry } from "../../src/main/recentProjects";
import { loadProjectFile, saveProjectFile } from "../../src/main/projectStorage";
import * as projectStorage from "../../src/main/projectStorage";
import type { GeminiApiKeyStore } from "../../src/main/geminiApiKeyStore";
import type { ProjectImageExportResult } from "../../src/main/projectImageExport";
import type { ProjectSessionResult } from "../../src/shared/projectSessionTypes";
import { buildRenderReadinessReport } from "../../src/shared/renderReadiness";
import { createEmptyProject } from "../../src/shared/projectValidation";
import { createTranslationSourceIdentity, loadTranslationDraft, saveTranslationDraft } from "../../src/renderer/translationDrafts";
import { loadTypesettingDraft, saveTypesettingDraft } from "../../src/renderer/typesettingDrafts";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  netFetch: vi.fn(() => { throw new Error("외부 요청 금지"); })
}));

vi.mock("electron", () => ({
  dialog: { showOpenDialog: electronMocks.showOpenDialog, showSaveDialog: electronMocks.showSaveDialog },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => electronMocks.handlers.set(channel, handler) },
  protocol: { handle: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
  net: { fetch: electronMocks.netFetch }
}));

let fixtureRoot: string;
let bundleRoot: string;
let examplesRoot: string;
let manager: ReturnType<typeof createProjectSessionManager>;
const sourceRoot = resolve("public/mangohana-example");

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "mangohana-example-ipc-"));
  bundleRoot = join(fixtureRoot, "bundle");
  examplesRoot = join(fixtureRoot, "temp");
  await cp(sourceRoot, bundleRoot, { recursive: true, errorOnExist: true, force: false });
  await mkdir(join(examplesRoot, "existing-user-folder"), { recursive: true });
  await writeFile(join(examplesRoot, "existing-user-folder", "keep.txt"), "사용자 임시 파일");
  await writeFile(join(bundleRoot, "unrelated-profile.txt"), "복사하면 안 되는 파일");
  manager = createProjectSessionManager();
  electronMocks.handlers.clear();
  electronMocks.showOpenDialog.mockReset();
  electronMocks.showSaveDialog.mockReset();
  electronMocks.netFetch.mockClear();
});

afterEach(async () => {
  await manager.disposeAll();
  const inside = relative(resolve(tmpdir()), fixtureRoot);
  if (!inside || inside.startsWith(`..${sep}`) || inside === "..") throw new Error("Unsafe fixture cleanup");
  await rm(fixtureRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function registerExample(overrides: Partial<Parameters<typeof registerIpcHandlers>[0]> = {}) {
  const geminiApiKeyStore = {
    initialize: vi.fn(),
    getStatus: vi.fn(() => ({ configured: false, source: "none", persistence: "encrypted", requiresReentry: false })),
    set: vi.fn(), clear: vi.fn()
  } as unknown as GeminiApiKeyStore;
  return registerIpcHandlers({
    geminiApiKeyStore,
    projectSessionManager: manager,
    recentProjectRegistry: createRecentProjectRegistry(),
    exampleProjectDirectory: bundleRoot,
    exampleTemporaryDirectory: examplesRoot,
    ...overrides
  });
}

async function invoke(channel: string, ownerId = 41, ...args: unknown[]) {
  const handler = electronMocks.handlers.get(channel);
  expect(handler, `${channel} 등록`).toBeTypeOf("function");
  return await handler!({ sender: { id: ownerId, isDestroyed: () => false } }, ...args);
}

async function openExample(ownerId = 41) {
  return await invoke("project:openExample", ownerId) as ProjectSessionResult;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [name, hash] of Object.entries(await snapshot(path))) result[`${entry.name}/${name}`] = hash;
    } else {
      result[entry.name] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  return result;
}

describe("자체 예시 프로젝트 Main IPC", () => {
  it("번들과 기존 프로젝트를 보존하며 제공자 없이 정식 세션으로 필요한 세 파일만 연다", async () => {
    const beforeBundle = await snapshot(bundleRoot);
    const userPath = join(fixtureRoot, "user.ctp");
    await saveProjectFile({ filePath: userPath, project: createEmptyProject("기존 사용자 프로젝트", false) });
    const beforeUser = await readFile(userPath);
    registerExample();
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [userPath] });
    const existing = await invoke("project:openFromDialog") as ProjectSessionResult;
    const result = await openExample();
    const copiedPath = manager.getFilePath(result.projectSessionId)!;
    expect(dirname(dirname(copiedPath))).toBe(examplesRoot);
    expect(result.encrypted).toBe(false);
    expect(result.project.status).toBe("active");
    expect(result.project.project.metadata.title).toMatch(/예시.*제공자 처리 없음/);
    expect(result.project.project.pageImages).toHaveLength(2);
    expect(result.project.project.processing).toMatchObject({ runs: [], assets: [], pages: [] });
    expect(Object.keys(await snapshot(dirname(copiedPath))).sort()).toEqual(
      Object.keys(beforeBundle).filter((name) => name !== "unrelated-profile.txt").sort()
    );
    expect(await snapshot(bundleRoot)).toEqual(beforeBundle);
    expect(await readFile(userPath)).toEqual(beforeUser);
    expect(manager.getProject(existing.projectSessionId).project.metadata.title).toBe("기존 사용자 프로젝트");
    expect(electronMocks.netFetch).not.toHaveBeenCalled();
  });

  it("실행마다 별도 경로·세션·프로젝트 ID를 저장하고 다른 복사본과 번들 ID를 보존한다", async () => {
    const bundled = await loadProjectFile({ filePath: join(bundleRoot, "ui-sample.ctp") });
    registerExample();
    const [first, second] = await Promise.all([openExample(), openExample()]);
    const firstPath = manager.getFilePath(first.projectSessionId)!;
    const secondPath = manager.getFilePath(second.projectSessionId)!;
    expect(first.projectSessionId).not.toBe(second.projectSessionId);
    expect(dirname(firstPath)).not.toBe(dirname(secondPath));
    expect(first.project.project.metadata.id).not.toBe(second.project.project.metadata.id);
    for (const opened of [first, second]) {
      expect(opened.project.project.metadata.id).not.toBe(bundled.project.metadata.id);
      const persisted = await loadProjectFile({ filePath: manager.getFilePath(opened.projectSessionId)! });
      expect(persisted.project.metadata.id).toBe(opened.project.project.metadata.id);
    }
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); }
    };
    const line = first.project.project.dialogueLines[0]!;
    const translationScope = { projectId: first.project.project.metadata.id, projectRevision: first.project.revision,
      lineId: line.id, sourceIdentity: createTranslationSourceIdentity(line.sourceText), lineStatus: line.lineStatus };
    saveTranslationDraft(storage, translationScope, "첫 예시에만 남긴 번역 초안");
    expect(loadTranslationDraft(storage, translationScope)).toBe("첫 예시에만 남긴 번역 초안");
    expect(loadTranslationDraft(storage, { ...translationScope, projectId: second.project.project.metadata.id })).toBeNull();
    const typesettingScope = { projectId: first.project.project.metadata.id,
      pageImageId: first.project.project.pageImages[0]!.id, sourceOcrId: line.id };
    const draft = { id: "example-draft", sourceOcrId: line.id, bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
      rotationDegrees: 0, writingMode: "horizontal-tb" as const };
    saveTypesettingDraft(storage, typesettingScope, draft);
    expect(loadTypesettingDraft(storage, typesettingScope)).toEqual(draft);
    expect(loadTypesettingDraft(storage, { ...typesettingScope, projectId: second.project.project.metadata.id })).toBeNull();
    const untouched = await snapshot(dirname(secondPath));
    await invoke("project:applyMutation", 41, { projectSessionId: first.projectSessionId, baseRevision: first.project.revision,
      mutation: { type: "set_project_title", title: "수정한 예시" } });
    await invoke("project:save", 41, { projectSessionId: first.projectSessionId });
    expect((await loadProjectFile({ filePath: firstPath })).project.metadata.title).toBe("수정한 예시");
    expect(await snapshot(dirname(secondPath))).toEqual(untouched);
    expect((await loadProjectFile({ filePath: join(bundleRoot, "ui-sample.ctp") })).project.metadata.id)
      .toBe(bundled.project.metadata.id);
  });

  it("다른 Renderer의 읽기·수정·저장·출력·닫기를 거부하고 소유자의 정상 close를 유지한다", async () => {
    registerExample();
    const result = await openExample();
    const args = { projectSessionId: result.projectSessionId };
    for (const channel of ["project:hydratePage", "project:applyMutation", "project:saveAs", "project:exportImages", "project:close"]) {
      await expect(invoke(channel, 99, { ...args, pageNumber: 1, baseRevision: result.project.revision,
        mutation: { type: "set_project_title", title: "가로챔" } })).rejects.toThrow(/another renderer/);
    }
    await invoke("project:hydratePage", 41, { ...args, pageNumber: 1 });
    await invoke("project:close", 41, args);
    expect(() => manager.getProject(result.projectSessionId)).toThrow();
    expect(electronMocks.showSaveDialog).not.toHaveBeenCalled();
    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled();
  });

  it("다른 이름 저장 후에도 sidecar와 원본 출력 경로를 사용할 수 있다", async () => {
    const beforeBundle = await snapshot(bundleRoot);
    registerExample();
    const result = await openExample();
    const copiedPath = manager.getFilePath(result.projectSessionId)!;
    const beforeCopy = await snapshot(dirname(copiedPath));
    const savedPath = join(fixtureRoot, "saved", "내 예시.ctp");
    electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: savedPath });
    await invoke("project:saveAs", 41, { projectSessionId: result.projectSessionId });
    expect(manager.getFilePath(result.projectSessionId)).toBe(savedPath);
    const loaded = await loadProjectFile({ filePath: savedPath });
    expect(loaded.project.metadata.id).toBe(result.project.project.metadata.id);
    electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(fixtureRoot, "export") });
    const exported = await invoke("project:exportImages", 41, { projectSessionId: result.projectSessionId }) as ProjectImageExportResult;
    const originals = exported.report.files.filter((file) => file.kind === "original");
    expect(originals).toHaveLength(2);
    for (const file of originals) {
      const page = loaded.project.pageImages.find((image) => image.id === file.pageImageId)!;
      const expected = await readFile(join(bundleRoot, page.storedRelativePath));
      expect(await readFile(join(exported.exportRoot, file.outputPath))).toEqual(expected);
      expect(await readFile(join(dirname(savedPath), page.storedRelativePath))).toEqual(expected);
    }
    expect(await snapshot(dirname(copiedPath))).toEqual(beforeCopy);
    expect(await snapshot(bundleRoot)).toEqual(beforeBundle);
  });

  it("식자 안전 영역을 지정한 뒤 기존 준비 검사와 글꼴 확인을 거쳐 식자 PNG를 출력한다", async () => {
    registerExample({ verifyInstalledTypesetFontResource: async () => true });
    const opened = await openExample();
    const line = opened.project.project.dialogueLines[0]!;
    await invoke("project:applyMutation", 41, { projectSessionId: opened.projectSessionId, baseRevision: opened.project.revision,
      mutation: { type: "update_dialogue_typesetting", lineId: line.id,
        typesetting: { bbox: { x: 0.45, y: 0.08, width: 0.4, height: 0.06 }, writingMode: "horizontal-tb" } } });
    const current = manager.getProject(opened.projectSessionId);
    const font = { identity: "isolated-test-font", resourceAvailable: true, metricsCalculated: true, glyphCoverageVerified: true };
    const typesetPages = await Promise.all(current.project.pageImages.map(async (page) => ({
      pageImageId: page.id,
      // Canvas 합성은 이 Main 테스트 밖이다. 유효한 합성 PNG로 전달 계약을 검사한다.
      pngBase64: (await readFile(join(bundleRoot, page.storedRelativePath))).toString("base64"),
      readiness: buildRenderReadinessReport({ pageImageId: page.id, revision: current.revision,
        resultRevision: current.revision, lines: current.project.dialogueLines.filter((entry) => entry.pageNumber === page.pageNumber), font })
    })));
    electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(fixtureRoot, "typeset-export") });
    const exported = await invoke("project:exportImages", 41, { projectSessionId: opened.projectSessionId, typesetPages }) as ProjectImageExportResult;
    expect(exported.report.files.filter((file) => file.kind === "typeset")).toHaveLength(2);
    expect(exported.report.failures.filter((failure) => failure.kind === "typeset")).toEqual([]);
  });

  it.each(["missing-image", "corrupt-image", "invalid-project", "encrypted-project"])(
    "%s 실패 시 이번 임시 복사본만 정리하고 기존 사용자 임시 폴더는 보존한다", async (failure) => {
      const sample = JSON.parse(await readFile(join(bundleRoot, "ui-sample.ctp"), "utf8"));
      const assetPath = join(bundleRoot, sample.payload.pageImages[0].storedRelativePath);
      if (failure === "missing-image") await rm(assetPath);
      if (failure === "corrupt-image") await writeFile(assetPath, "broken");
      if (failure === "invalid-project") await writeFile(join(bundleRoot, "ui-sample.ctp"), "{}");
      if (failure === "encrypted-project") {
        await saveProjectFile({ filePath: join(bundleRoot, "ui-sample.ctp"), project: createEmptyProject("가짜 암호화 fixture", true), password: "fixture-only-password" });
      }
      const before = await snapshot(examplesRoot);
      registerExample();
      await expect(openExample()).rejects.toThrow();
      expect(await snapshot(examplesRoot)).toEqual(before);
      expect(await readdir(examplesRoot)).toEqual(["existing-user-folder"]);
    }
  );

  it("정식 open 후처리가 실패하면 세션을 닫고 자체 복사본만 정리한다", async () => {
    const createdIds: string[] = [];
    const create = manager.createProjectSession.bind(manager);
    vi.spyOn(manager, "createProjectSession").mockImplementation((args) => {
      const result = create(args); createdIds.push(result.projectSessionId); return result;
    });
    vi.spyOn(manager, "resumePageImageImports").mockRejectedValueOnce(new Error("fixture resume failure"));
    registerExample();
    await expect(openExample()).rejects.toThrow("fixture resume failure");
    expect(createdIds).toHaveLength(1);
    expect(() => manager.getProject(createdIds[0]!)).toThrow();
    expect(await readdir(examplesRoot)).toEqual(["existing-user-folder"]);
  });

  it("새 ID의 정식 저장이 실패하면 세션을 열지 않고 이번 임시 폴더만 정리한다", async () => {
    vi.spyOn(projectStorage, "saveProjectFile").mockRejectedValueOnce(new Error("fixture identity save failure"));
    const beforeBundle = await snapshot(bundleRoot);
    const create = vi.spyOn(manager, "createProjectSession");
    registerExample();
    await expect(openExample()).rejects.toThrow("fixture identity save failure");
    expect(create).not.toHaveBeenCalled();
    expect(await snapshot(bundleRoot)).toEqual(beforeBundle);
    expect(await readdir(examplesRoot)).toEqual(["existing-user-folder"]);
  });

  it("세션 close도 실패하면 복사본을 보존하고 기존 Main 재정리 경로에 남긴다", async () => {
    vi.spyOn(manager, "resumePageImageImports").mockRejectedValueOnce(new Error("fixture resume failure"));
    vi.spyOn(manager, "closeProject").mockRejectedValueOnce(new Error("fixture close failure"));
    const lifecycle = registerExample();
    await expect(openExample()).rejects.toThrow(/cleanup failed/);
    const created = (await readdir(examplesRoot)).filter((name) => name !== "existing-user-folder");
    expect(created).toHaveLength(1);
    expect(await readFile(join(examplesRoot, created[0]!, "ui-sample.ctp"), "utf8")).toContain("예시");
    await lifecycle.retryPendingSessionCleanups();
    expect(await readFile(join(examplesRoot, "existing-user-folder", "keep.txt"), "utf8")).toBe("사용자 임시 파일");
  });

  it("Renderer가 열기 도중 종료되면 결과를 돌려주지 않고 세션과 자체 복사본을 정리한다", async () => {
    const resume = manager.resumePageImageImports.bind(manager);
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(manager, "resumePageImageImports").mockImplementationOnce(async (sessionId) => {
      entered(); await gate; return resume(sessionId);
    });
    const lifecycle = registerExample();
    const opening = openExample();
    const failed = expect(opening).rejects.toThrow();
    await ready;
    await lifecycle.cleanupRenderer(41);
    release();
    await failed;
    expect(await readdir(examplesRoot)).toEqual(["existing-user-folder"]);
    await expect(openExample()).rejects.toThrow(/no longer active/);
  });

  it("Renderer의 경로나 명령 입력을 받지 않고 리소스 누락도 기존 파일 변경 없이 실패한다", async () => {
    registerExample();
    for (const args of [{ filePath: join(fixtureRoot, "user.ctp") }, "command", null]) {
      await expect(invoke("project:openExample", 41, args)).rejects.toThrow();
    }
    expect(await readdir(examplesRoot)).toEqual(["existing-user-folder"]);
    registerExample({ exampleProjectDirectory: undefined });
    await expect(openExample()).rejects.toThrow(/예시/);
    expect(await readdir(examplesRoot)).toEqual(["existing-user-folder"]);
  });
});
