import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/renderer/App.js";
import type { ApplyProjectMutationArgs, ProjectChangeResult, ProjectSaveResult, ProjectSessionResult } from "../../src/shared/projectSessionTypes.js";
import type { InpaintPageImageResult } from "../../src/shared/inpainting.js";
import type { TranslationProjectV2 } from "../../src/shared/projectTypes.js";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation.js";
import { PRODUCTION_OCR_CONTRACT } from "../../src/shared/productionOcr.js";
import { DEFAULT_PROVIDER_SETTINGS } from "../../src/shared/providerSettings.js";
import { loadTypesettingDraft, saveTypesettingDraft } from "../../src/renderer/typesettingDrafts.js";
import { openTxtStartActions, openWorkspacePanel } from "./workspaceTestActions.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function dto(project: TranslationProjectV2, revision: number, dirty = false) {
  return { project, revision, dirty, pendingPageImages: [], status: "active" as const };
}

function makeProject(title = "A") {
  const project = normalizeProject(createEmptyProject(title, false));
  project.pageImages = [{
    id: "page-1", pageNumber: 1, storedRelativePath: "pages/p1.png", originalFileName: "p1.png",
    sha256: "a".repeat(64), byteSize: 10, mimeType: "image/png", copiedAt: "2026-10-29T00:00:00Z"
  }];
  project.dialogueLines = [{
    id: "line-1", order: 1, pageNumber: 1, sourceLanguage: "ja", sourceText: "원문",
    dialogueType: "speech", origin: { kind: "manual" }, parseConfidence: 1, parseWarnings: []
  }];
  return project;
}

function resultFor(project: TranslationProjectV2, sessionId = "opened", revision = 3) {
  const source = project.pageImages[0]!;
  const pageImage = { ...source, id: "cleaned-1", storedRelativePath: "pages/cleaned.png", originalFileName: "cleaned.png", sha256: "b".repeat(64) };
  const run = { runId: "run-1", pageImageId: source.id, source: "manual_openai" as const,
    status: "completed" as const, sourceSha256: source.sha256, appVersion: "0.1.0",
    queuedAt: "2026-10-29T00:00:00Z", completedAt: "2026-10-29T00:00:01Z" };
  const asset = { assetId: pageImage.id, source: "manual_openai" as const, sourcePageImageId: source.id,
    runId: run.runId, role: "cleaned" as const, storedRelativePath: pageImage.storedRelativePath,
    sha256: pageImage.sha256, byteSize: pageImage.byteSize, mimeType: "image/png" as const,
    createdAt: "2026-10-29T00:00:01Z" };
  return { pageImage, run, asset, sessionResult: { projectSessionId: sessionId, project: dto(project, revision) } };
}

let restoreCanvas = () => {};
function mockCanvas() {
  const keys: Array<[object, string]> = [
    [HTMLImageElement.prototype, "naturalWidth"], [HTMLImageElement.prototype, "naturalHeight"],
    [HTMLCanvasElement.prototype, "getBoundingClientRect"], [HTMLCanvasElement.prototype, "setPointerCapture"],
    [HTMLCanvasElement.prototype, "hasPointerCapture"], [HTMLCanvasElement.prototype, "releasePointerCapture"],
    [HTMLCanvasElement.prototype, "toDataURL"], [HTMLCanvasElement.prototype, "getContext"]
  ];
  const saved = keys.map(([target, key]) => [target, key, Object.getOwnPropertyDescriptor(target, key)] as const);
  restoreCanvas = () => {
    for (const [target, key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  };
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 100 });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 80 });
  Object.defineProperty(HTMLCanvasElement.prototype, "getBoundingClientRect", { configurable: true, value: () =>
    ({ x: 0, y: 0, width: 100, height: 80, top: 0, right: 100, bottom: 80, left: 0, toJSON: () => ({}) }) });
  Object.defineProperty(HTMLCanvasElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLCanvasElement.prototype, "hasPointerCapture", { configurable: true, value: () => true });
  Object.defineProperty(HTMLCanvasElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", { configurable: true, value: () => "data:image/png;base64,mask-png" });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => ({
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), stroke: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), putImageData: vi.fn(),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) })
  }) });
}

afterEach(() => { cleanup(); restoreCanvas(); restoreCanvas = () => {}; vi.unstubAllGlobals(); window.localStorage.clear(); });

async function openSavedProject(apiOverrides: Record<string, unknown> = {}, opened = makeProject()) {
  mockCanvas();
  const initial = normalizeProject(createEmptyProject("초기", false));
  const pending = deferred<InpaintPageImageResult>();
  const inpaintPageImage = vi.fn().mockReturnValue(pending.promise);
  const applyProjectMutation = vi.fn();
  const saveProject = vi.fn();
  const cancelInpainting = vi.fn().mockResolvedValue({ canceled: true });
  const openProjectFromDialog = vi.fn().mockResolvedValue({ projectSessionId: "opened", project: dto(opened, 1), encrypted: false });
  vi.stubGlobal("projectApi", {
    createProjectSession: vi.fn().mockResolvedValue({ projectSessionId: "initial", project: dto(initial, 0), encrypted: false }),
    openProjectFromDialog,
    openRecentProject: vi.fn(), unlockProject: vi.fn(), closeProject: vi.fn().mockResolvedValue(undefined),
    listRecentProjects: vi.fn().mockResolvedValue([]), importTxtFile: vi.fn(), exportTranslations: vi.fn(),
    saveProject, saveProjectAs: vi.fn(), applyProjectMutation, inpaintPageImage, cancelInpainting,
    resolvePageImageSrc: vi.fn().mockResolvedValue("app:///pages/p1.png"), ...apiOverrides
  });
  render(<App />);
  const open = await screen.findByRole("button", { name: "기존 프로젝트 열기" });
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  await openWorkspacePanel("수정");
  const settings = within(screen.getByRole("navigation", { name: "작업 영역" })).getByRole("button", { name: "설정" });
  if (settings.getAttribute("aria-expanded") !== "true") fireEvent.click(settings);
  await screen.findByLabelText("프로젝트 제목");
  await screen.findByAltText("1페이지 이미지");
  return { opened, pending, inpaintPageImage, applyProjectMutation, saveProject, cancelInpainting, openProjectFromDialog };
}

function ocrExtraction() {
  const sourceBboxPx = { x: 100, y: 100, width: 200, height: 100 };
  const sourceQuadPx = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 200 }, { x: 100, y: 200 }];
  return { pageNumber: 1, nonSpeechText: [], warnings: [],
    productionOcrContext: { runId: "ocr-run", pageImageId: "page-1", sourceSha256: "a".repeat(64) },
    speechBubbles: [{ id: "ocr-1", type: "speech_bubble", text: "합성 OCR", language: "ja",
      bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, readingOrder: 1, confidence: 0.9,
      notes: "", speakerCandidates: [], orientation: "horizontal",
      productionOcrProvenance: { contractVersion: 1,
        detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId, detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision,
        recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId, recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision,
        groupId: "ocr-1", sourceDetectionIds: ["detection-1"], sourceDetectionScores: [0.93], sourceQuadsPx: [sourceQuadPx],
        orientation: "horizontal", confidenceSource: "detector_min", cropTransform: { sourceBboxPx, cropBboxPx: sourceBboxPx,
          paddingRatio: 0.08, rotationDegrees: 0, imageWidth: 1000, imageHeight: 1000 } }
    }] };
}

async function prepareOcrReview() {
  fireEvent.click(screen.getByRole("button", { name: "말풍선 OCR" }));
  const draft = await screen.findByLabelText("speech_bubble 1 원문");
  fireEvent.change(draft, { target: { value: "보존할 OCR 초안" } });
  fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));
}

async function expectOcrDraft() {
  expect(screen.getByRole("region", { name: "1페이지 말풍선 OCR 검토" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "이전 단계" }));
  expect(await screen.findByLabelText("speech_bubble 1 원문")).toHaveValue("보존할 OCR 초안");
}

async function startInpainting() {
  const open = screen.getByRole("button", { name: "인페인팅" });
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  fireEvent.load(await screen.findByAltText("1페이지 인페인팅 대상"));
  const canvas = screen.getByLabelText("인페인팅 마스크");
  fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
}

async function makeTitleConflict(harness: Awaited<ReturnType<typeof openSavedProject>>) {
  const server = { ...harness.opened, metadata: { ...harness.opened.metadata, title: "서버 제목" } };
  harness.applyProjectMutation.mockResolvedValueOnce({ status: "revision_conflict", code: "REVISION_CONFLICT",
    revision: 2, project: dto(server, 2), conflictingPaths: ["metadata/title"] } satisfies ProjectChangeResult);
  fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
  await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("충돌"));
  return server;
}

describe("conflict protection in App operations", () => {
  it("keeps the conflicted title and dirty state when a pending inpainting DTO returns", async () => {
    const harness = await openSavedProject();
    await startInpainting();
    await waitFor(() => expect(harness.inpaintPageImage).toHaveBeenCalledOnce());
    const server = await makeTitleConflict(harness);
    await act(async () => { harness.pending.resolve(resultFor(server)); await harness.pending.promise; });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("충돌");
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await act(async () => { await Promise.resolve(); });
    expect(harness.saveProject).not.toHaveBeenCalled();
  });

  it("keeps a failed local title when a later inpainting DTO has no queued mutation", async () => {
    const harness = await openSavedProject();
    await startInpainting();
    await waitFor(() => expect(harness.inpaintPageImage).toHaveBeenCalledOnce());
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("합성 제목 변경 실패"));
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("합성 제목 변경 실패"));
    await act(async () => { harness.pending.resolve(resultFor(harness.opened, "opened", 2)); await harness.pending.promise; });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
  });

  it("does not start inpainting while a conflict is unresolved", async () => {
    const harness = await openSavedProject();
    await makeTitleConflict(harness);
    await startInpainting();
    await act(async () => { await Promise.resolve(); });
    expect(harness.inpaintPageImage).not.toHaveBeenCalled();
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("충돌");
  });

  it("ignores a late inpainting response after the same session enters recovery", async () => {
    const harness = await openSavedProject();
    await startInpainting();
    await waitFor(() => expect(harness.inpaintPageImage).toHaveBeenCalledOnce());
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2,
      project: { ...dto(harness.opened, 2), status: "needs_recovery" } });
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("복구"));
    await act(async () => { harness.pending.resolve(resultFor(harness.opened)); await harness.pending.promise; });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("복구");
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("복구");
  });

  it("retains local input when the inpainting DTO itself requires recovery", async () => {
    const harness = await openSavedProject();
    await startInpainting();
    await waitFor(() => expect(harness.inpaintPageImage).toHaveBeenCalledOnce());
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("합성 제목 변경 실패"));
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("합성 제목 변경 실패"));
    const response = resultFor(harness.opened);
    await act(async () => {
      harness.pending.resolve({ ...response, sessionResult: { ...response.sessionResult,
        project: { ...response.sessionResult.project, status: "needs_recovery" } } });
      await harness.pending.promise;
    });
    expect(screen.getByRole("alert")).toHaveTextContent("복구");
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
  });

  it("keeps conflict feedback when the pending inpainting fails", async () => {
    const harness = await openSavedProject();
    await startInpainting();
    await waitFor(() => expect(harness.inpaintPageImage).toHaveBeenCalledOnce());
    await makeTitleConflict(harness);
    await act(async () => { harness.pending.reject(new Error("늦은 인페인팅 실패")); await harness.pending.promise.catch(() => undefined); });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("충돌");
  });

  it("does not adopt a canceled inpainting DTO after a later conflict", async () => {
    const harness = await openSavedProject();
    await startInpainting();
    await waitFor(() => expect(harness.inpaintPageImage).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "인페인팅 실행 취소" }));
    await waitFor(() => expect(harness.cancelInpainting).toHaveBeenCalledOnce());
    const server = await makeTitleConflict(harness);
    await act(async () => { harness.pending.resolve(resultFor(server)); await harness.pending.promise; });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("충돌");
  });

  it("does not apply a late DTO after an explicit inpainting cancel", async () => {
    const harness = await openSavedProject();
    await startInpainting();
    await waitFor(() => expect(harness.inpaintPageImage).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "인페인팅 실행 취소" }));
    await waitFor(() => expect(harness.cancelInpainting).toHaveBeenCalledOnce());
    const late = { ...harness.opened, metadata: { ...harness.opened.metadata, title: "취소된 응답" } };
    await act(async () => { harness.pending.resolve(resultFor(late)); await harness.pending.promise; });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("A");
    expect(screen.getByText("저장하지 않은 변경사항이 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("취소");
  });

  it.each([true, false])("keeps conflict notice when a late cancel acknowledgment is %s", async (canceled) => {
    const pendingCancel = deferred<{ canceled: boolean }>();
    const cancelInpainting = vi.fn().mockReturnValue(pendingCancel.promise);
    const harness = await openSavedProject({ cancelInpainting });
    await startInpainting();
    await waitFor(() => expect(harness.inpaintPageImage).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "인페인팅 실행 취소" }));
    await waitFor(() => expect(cancelInpainting).toHaveBeenCalledOnce());
    await makeTitleConflict(harness);
    const conflictNotice = screen.getByRole("status", { name: "작업 상태" }).textContent;
    await act(async () => { pendingCancel.resolve({ canceled }); await pendingCancel.promise; });
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(conflictNotice!);
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
  });

  it("ignores an old inpainting response when a new session reuses the same session id", async () => {
    const harness = await openSavedProject();
    await startInpainting();
    await waitFor(() => expect(harness.inpaintPageImage).toHaveBeenCalledOnce());
    const reopened = { ...harness.opened, metadata: { ...harness.opened.metadata, title: "다시 연 제목" } };
    harness.openProjectFromDialog.mockResolvedValueOnce({ projectSessionId: "opened", project: dto(reopened, 2), encrypted: false });
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    await waitFor(() => expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("다시 연 제목"));
    const old = { ...harness.opened, metadata: { ...harness.opened.metadata, title: "이전 세션" } };
    await act(async () => { harness.pending.resolve(resultFor(old, "opened", 3)); await harness.pending.promise; });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("다시 연 제목");
    expect(screen.getByText("저장하지 않은 변경사항이 없습니다.")).toBeInTheDocument();
  });
});

describe("OCR review while session state changes", () => {
  it("keeps the draft and conflict notice without sending review when the queue conflicts during drain", async () => {
    const applyReview = vi.fn();
    const harness = await openSavedProject({ extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()), applyProductionOcrReview: applyReview });
    await prepareOcrReview();
    const pendingMutation = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(pendingMutation.promise);
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "C" } });
    expect(harness.applyProjectMutation).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await act(async () => { await Promise.resolve(); });
    expect(applyReview).not.toHaveBeenCalled();
    const server = { ...harness.opened, metadata: { ...harness.opened.metadata, title: "서버 제목" } };
    await act(async () => {
      pendingMutation.resolve({ status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2,
        project: dto(server, 2), conflictingPaths: ["metadata/title"] });
      await pendingMutation.promise;
    });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("metadata/title"));
    expect(applyReview).not.toHaveBeenCalled();
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("C");
    await expectOcrDraft();
  });

  it("does not send review when the session enters recovery while the queue drains", async () => {
    const applyReview = vi.fn().mockResolvedValue({ projectSessionId: "opened", project: dto(makeProject(), 3, true) });
    const harness = await openSavedProject({ extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()), applyProductionOcrReview: applyReview });
    await prepareOcrReview();
    const pendingMutation = deferred<ProjectChangeResult>();
    harness.applyProjectMutation.mockReturnValueOnce(pendingMutation.promise);
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await act(async () => {
      pendingMutation.resolve({ status: "applied", revision: 2,
        project: { ...dto(harness.opened, 2), status: "needs_recovery" } });
      await pendingMutation.promise;
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("복구"));
    expect(applyReview).not.toHaveBeenCalled();
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    await expectOcrDraft();
  });

  it("keeps the draft when an OCR response arrives after a new conflict", async () => {
    const pendingReview = deferred<ProjectSaveResult>();
    const applyReview = vi.fn().mockReturnValue(pendingReview.promise);
    const harness = await openSavedProject({ extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()), applyProductionOcrReview: applyReview });
    await prepareOcrReview();
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await waitFor(() => expect(applyReview).toHaveBeenCalledOnce());
    await makeTitleConflict(harness);
    const conflictNotice = screen.getByRole("status", { name: "작업 상태" }).textContent;
    await act(async () => { pendingReview.resolve({ projectSessionId: "opened", project: dto(harness.opened, 3, true) }); await pendingReview.promise; });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(conflictNotice!);
    await expectOcrDraft();
  });

  it("keeps the draft when an OCR response arrives after the session enters recovery", async () => {
    const pendingReview = deferred<ProjectSaveResult>();
    const applyReview = vi.fn().mockReturnValue(pendingReview.promise);
    const harness = await openSavedProject({ extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()), applyProductionOcrReview: applyReview });
    await prepareOcrReview();
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await waitFor(() => expect(applyReview).toHaveBeenCalledOnce());
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2,
      project: { ...dto(harness.opened, 2), status: "needs_recovery" } });
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("복구"));
    await act(async () => { pendingReview.resolve({ projectSessionId: "opened", project: dto(harness.opened, 3, true) }); await pendingReview.promise; });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByRole("alert")).toHaveTextContent("복구");
    await expectOcrDraft();
  });

  it("keeps the conflict notice and draft when a pending OCR review fails", async () => {
    const pendingReview = deferred<ProjectSaveResult>();
    const applyReview = vi.fn().mockReturnValue(pendingReview.promise);
    const harness = await openSavedProject({ extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()), applyProductionOcrReview: applyReview });
    await prepareOcrReview();
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await waitFor(() => expect(applyReview).toHaveBeenCalledOnce());
    await makeTitleConflict(harness);
    const conflictNotice = screen.getByRole("status", { name: "작업 상태" }).textContent;
    await act(async () => { pendingReview.reject(new Error("늦은 OCR 적용 실패")); await pendingReview.promise.catch(() => undefined); });
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(conflictNotice!);
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    await expectOcrDraft();
  });

  it("keeps the draft when an OCR response itself requires session recovery", async () => {
    const pendingReview = deferred<ProjectSaveResult>();
    const applyReview = vi.fn().mockReturnValue(pendingReview.promise);
    const harness = await openSavedProject({ extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()), applyProductionOcrReview: applyReview });
    await prepareOcrReview();
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await waitFor(() => expect(applyReview).toHaveBeenCalledOnce());
    await act(async () => { pendingReview.resolve({ projectSessionId: "opened", project: { ...dto(harness.opened, 2), status: "needs_recovery" } }); await pendingReview.promise; });
    expect(screen.getByRole("alert")).toHaveTextContent("복구");
    await expectOcrDraft();
  });

  it("does not adopt an OCR result belonging to another session", async () => {
    const pendingReview = deferred<ProjectSaveResult>();
    const applyReview = vi.fn().mockReturnValue(pendingReview.promise);
    const harness = await openSavedProject({ extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()), applyProductionOcrReview: applyReview });
    await prepareOcrReview();
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await waitFor(() => expect(applyReview).toHaveBeenCalledOnce());
    const other = { ...harness.opened, metadata: { ...harness.opened.metadata, title: "다른 세션 결과" } };
    await act(async () => { pendingReview.resolve({ projectSessionId: "other", project: dto(other, 2, false) }); await pendingReview.promise; });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("A");
    await expectOcrDraft();
  });

  it("keeps a failed local title and the OCR draft without sending review", async () => {
    const applyReview = vi.fn().mockResolvedValue({ projectSessionId: "opened", project: dto(makeProject(), 2) });
    const harness = await openSavedProject({ extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()), applyProductionOcrReview: applyReview });
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("합성 제목 변경 실패"));
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("합성 제목 변경 실패"));
    await prepareOcrReview();
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(applyReview).not.toHaveBeenCalled();
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    await expectOcrDraft();
  });

  it("keeps an OCR draft edited after its earlier version was sent", async () => {
    const pendingReview = deferred<ProjectSaveResult>();
    const applyReview = vi.fn().mockReturnValue(pendingReview.promise);
    const harness = await openSavedProject({ extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()), applyProductionOcrReview: applyReview });
    await prepareOcrReview();
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await waitFor(() => expect(applyReview).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "이전 단계" }));
    fireEvent.change(screen.getByLabelText("speech_bubble 1 원문"), { target: { value: "응답 대기 중 새 OCR 초안" } });
    await act(async () => { pendingReview.resolve({ projectSessionId: "opened", project: dto(harness.opened, 2, true) }); await pendingReview.promise; });
    expect(screen.getByLabelText("speech_bubble 1 원문")).toHaveValue("응답 대기 중 새 OCR 초안");
    expect(screen.getByRole("region", { name: "1페이지 말풍선 OCR 검토" })).toBeInTheDocument();
  });

  it("keeps a newer typesetting draft created while OCR review is pending", async () => {
    const pendingReview = deferred<ProjectSaveResult>();
    const applyReview = vi.fn().mockReturnValue(pendingReview.promise);
    const harness = await openSavedProject({ extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()), applyProductionOcrReview: applyReview });
    await prepareOcrReview();
    const scope = { projectId: harness.opened.metadata.id, pageImageId: "page-1", sourceOcrId: "ocr-1" };
    const draft = { id: "draft-1", sourceOcrId: "ocr-1", bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
      rotationDegrees: 0, writingMode: "horizontal-tb" as const };
    saveTypesettingDraft(window.localStorage, scope, draft);
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await waitFor(() => expect(applyReview).toHaveBeenCalledOnce());
    const latest = { ...draft, rotationDegrees: 10 };
    saveTypesettingDraft(window.localStorage, scope, latest);
    await act(async () => { pendingReview.resolve({ projectSessionId: "opened", project: dto(harness.opened, 2, true) }); await pendingReview.promise; });
    expect(loadTypesettingDraft(window.localStorage, scope)).toEqual(latest);
  });

  it("keeps a failed local edit and the OCR draft when an earlier review response arrives", async () => {
    const pendingReview = deferred<ProjectSaveResult>();
    const applyReview = vi.fn().mockReturnValue(pendingReview.promise);
    const harness = await openSavedProject({ extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()), applyProductionOcrReview: applyReview });
    await prepareOcrReview();
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await waitFor(() => expect(applyReview).toHaveBeenCalledOnce());
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("합성 제목 변경 실패"));
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("합성 제목 변경 실패"));
    await act(async () => { pendingReview.resolve({ projectSessionId: "opened", project: dto(harness.opened, 2) }); await pendingReview.promise; });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    await expectOcrDraft();
  });

  it("does not delete new OCR lines by saving over an overlapping failed local edit", async () => {
    const pendingReview = deferred<ProjectSaveResult>();
    const exportTranslations = vi.fn();
    const exportProjectImages = vi.fn();
    const harness = await openSavedProject({
      extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()),
      applyProductionOcrReview: vi.fn().mockReturnValue(pendingReview.promise),
      exportTranslations, exportProjectImages
    });
    await prepareOcrReview();
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await waitFor(() => expect(window.projectApi!.applyProductionOcrReview).toHaveBeenCalledOnce());
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("합성 제목 변경 실패"));
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("합성 제목 변경 실패"));

    let server = structuredClone(harness.opened);
    server.dialogueLines.push({
      ...server.dialogueLines[0]!, id: "ocr-main", order: 2, sourceText: "새 OCR 대사",
      origin: { kind: "pipeline", pageImageId: "page-1", persistentRegionId: "region-1", latestRunId: "ocr-run", latestRegionId: "ocr-1", candidateIds: ["ocr-1"], readingIndex: 1, sourceFingerprint: "c".repeat(64) }
    });
    let revision = 2;
    harness.applyProjectMutation.mockImplementation(async ({ mutation }: ApplyProjectMutationArgs) => {
      if (mutation.type === "set_project_title") server = { ...server, metadata: { ...server.metadata, title: mutation.title } };
      if (mutation.type === "remove_dialogue_line") server = { ...server, dialogueLines: server.dialogueLines.filter((line) => line.id !== mutation.lineId) };
      revision += 1;
      return { status: "applied", revision, project: dto(structuredClone(server), revision, true) };
    });
    harness.saveProject.mockImplementation(async () => ({ projectSessionId: "opened", project: dto(structuredClone(server), revision) }));
    await act(async () => { pendingReview.resolve({ projectSessionId: "opened", project: dto(structuredClone(server), revision, true) }); await pendingReview.promise; });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(harness.saveProject.mock.calls.length > 0 ||
      screen.getByRole("status", { name: "작업 상태" }).textContent?.includes("충돌")).toBeTruthy());
    expect(server.dialogueLines.some((line) => line.id === "ocr-main")).toBe(true);
    expect(harness.saveProject).not.toHaveBeenCalled();
    expect(harness.applyProjectMutation).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "충돌 후 로컬 편집" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    fireEvent.click(screen.getByRole("button", { name: "TXT 내보내기" }));
    fireEvent.click(screen.getByRole("button", { name: "전체 프로젝트 이미지 내보내기" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(harness.applyProjectMutation).toHaveBeenCalledTimes(1);
    expect(exportTranslations).not.toHaveBeenCalled();
    expect(exportProjectImages).not.toHaveBeenCalled();
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("충돌 후 로컬 편집");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("OCR 초안");
    await expectOcrDraft();
  });

  it("keeps a pending local mutation and OCR draft locked when its response arrives later", async () => {
    const pendingReview = deferred<ProjectSaveResult>();
    const pendingMutation = deferred<ProjectChangeResult>();
    const exportTranslations = vi.fn();
    const applyReview = vi.fn().mockReturnValue(pendingReview.promise);
    const harness = await openSavedProject({
      extractSpeechBubbles: vi.fn().mockResolvedValue(ocrExtraction()),
      applyProductionOcrReview: applyReview, exportTranslations
    });
    await prepareOcrReview();
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    await waitFor(() => expect(applyReview).toHaveBeenCalledOnce());
    harness.applyProjectMutation.mockReturnValueOnce(pendingMutation.promise);
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    const mainB = { ...harness.opened, metadata: { ...harness.opened.metadata, title: "B" } };
    const ocrResult = structuredClone(mainB);
    ocrResult.dialogueLines.push({
      ...ocrResult.dialogueLines[0]!, id: "ocr-main", order: 2, sourceText: "새 OCR 대사",
      origin: { kind: "pipeline", pageImageId: "page-1", persistentRegionId: "region-1", latestRunId: "ocr-run", latestRegionId: "ocr-1", candidateIds: ["ocr-1"], readingIndex: 1, sourceFingerprint: "c".repeat(64) }
    });
    await act(async () => { pendingReview.resolve({ projectSessionId: "opened", project: dto(ocrResult, 3, true) }); await pendingReview.promise; });
    const notice = screen.getByRole("status", { name: "작업 상태" }).textContent;
    expect(notice).toContain("충돌");
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    fireEvent.click(screen.getByRole("button", { name: "TXT 내보내기" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(harness.saveProject).not.toHaveBeenCalled();
    expect(exportTranslations).not.toHaveBeenCalled();
    await act(async () => { pendingMutation.resolve({ status: "applied", revision: 2, project: dto(mainB, 2, true) }); await pendingMutation.promise; });
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(notice!);
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "D" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    fireEvent.click(screen.getByRole("button", { name: "TXT 내보내기" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(harness.applyProjectMutation).toHaveBeenCalledOnce();
    expect(harness.saveProject).not.toHaveBeenCalled();
    expect(exportTranslations).not.toHaveBeenCalled();
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("D");
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("OCR 초안");
    await expectOcrDraft();

    const reopened = makeProject("다시 연 프로젝트");
    harness.openProjectFromDialog.mockResolvedValueOnce({ projectSessionId: "reopened", project: dto(reopened, 4), encrypted: false });
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    const cancelDialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(cancelDialog).getByRole("button", { name: "계속 편집" }));
    await waitFor(() => expect(cancelDialog).not.toBeInTheDocument());
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("D");
    expect(screen.getByLabelText("speech_bubble 1 원문")).toHaveValue("보존할 OCR 초안");

    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    const discardDialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(discardDialog).getByRole("button", { name: "버리고 이동" }));
    await waitFor(() => expect(harness.openProjectFromDialog).toHaveBeenCalledTimes(2));
    await openWorkspacePanel("수정");
    const settings = within(screen.getByRole("navigation", { name: "작업 영역" })).getByRole("button", { name: "설정" });
    if (settings.getAttribute("aria-expanded") !== "true") fireEvent.click(settings);
    await waitFor(() => expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("다시 연 프로젝트"));
    const nextProject = { ...reopened, metadata: { ...reopened.metadata, title: "새 세션 편집" } };
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 5, project: dto(nextProject, 5, true) });
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "새 세션 편집" } });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    expect(harness.applyProjectMutation).toHaveBeenLastCalledWith({
      projectSessionId: "reopened", baseRevision: 4, mutation: { type: "set_project_title", title: "새 세션 편집" }
    });
  });
});

describe("AI translation while session state changes", () => {
  function projectWithExistingText() {
    const project = makeProject();
    project.dialogueLines[0] = { ...project.dialogueLines[0]!, aiTranslation: "기존 AI 제안", userTranslation: "사용자 번역" };
    return project;
  }

  it("does not request or commit an AI proposal while a conflict already exists", async () => {
    const executeTranslation = vi.fn().mockResolvedValue({ translatedText: "새 제안", engine: "fixture", contextFingerprint: "" });
    const commitTranslationProposal = vi.fn().mockResolvedValue({ projectSessionId: "opened", project: dto(projectWithExistingText(), 3, true) });
    const harness = await openSavedProject({ getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS),
      executeTranslation, commitTranslationProposal }, projectWithExistingText());
    await makeTitleConflict(harness);
    const conflictNotice = screen.getByRole("status", { name: "작업 상태" }).textContent;
    fireEvent.click(screen.getByRole("button", { name: /AI 문맥 번역 실행/ }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(executeTranslation).not.toHaveBeenCalled();
    expect(commitTranslationProposal).not.toHaveBeenCalled();
    expect(screen.getByLabelText("AI 번역 1")).toHaveValue("기존 AI 제안");
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("사용자 번역");
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(conflictNotice!);
  });

  it("does not commit a pending AI response after the session enters recovery", async () => {
    const pending = deferred<{ translatedText: string; engine: string; contextFingerprint: string }>();
    const executeTranslation = vi.fn().mockReturnValue(pending.promise);
    const commitTranslationProposal = vi.fn().mockResolvedValue({ projectSessionId: "opened", project: dto(projectWithExistingText(), 3, true) });
    const harness = await openSavedProject({ getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS),
      executeTranslation, commitTranslationProposal }, projectWithExistingText());
    fireEvent.click(screen.getByRole("button", { name: /AI 문맥 번역 실행/ }));
    await waitFor(() => expect(executeTranslation).toHaveBeenCalledOnce());
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2,
      project: { ...dto(harness.opened, 2), status: "needs_recovery" } });
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("복구"));
    await act(async () => { pending.resolve({ translatedText: "늦은 제안", engine: "fixture", contextFingerprint: "" }); await pending.promise; });
    expect(commitTranslationProposal).not.toHaveBeenCalled();
    expect(screen.getByLabelText("AI 번역 1")).toHaveValue("기존 AI 제안");
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("사용자 번역");
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByRole("alert")).toHaveTextContent("복구");
  });

  it("does not commit a pending AI response after a title conflict", async () => {
    const pending = deferred<{ translatedText: string; engine: string; contextFingerprint: string }>();
    const executeTranslation = vi.fn().mockReturnValue(pending.promise);
    const commitTranslationProposal = vi.fn();
    const harness = await openSavedProject({ getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS),
      executeTranslation, commitTranslationProposal, cancelTranslation: vi.fn().mockResolvedValue({ canceled: true }) }, projectWithExistingText());
    fireEvent.click(screen.getByRole("button", { name: /AI 문맥 번역 실행/ }));
    await waitFor(() => expect(executeTranslation).toHaveBeenCalledOnce());
    await makeTitleConflict(harness);
    await act(async () => { pending.resolve({ translatedText: "늦은 제안", engine: "fixture", contextFingerprint: "" }); await pending.promise; });
    expect(commitTranslationProposal).not.toHaveBeenCalled();
    expect(screen.getByLabelText("AI 번역 1")).toHaveValue("기존 AI 제안");
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("사용자 번역");
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
  });

  it.each(["conflict", "recovery"] as const)("does not commit an AI response while the queue enters %s", async (nextStatus) => {
    const pendingTranslation = deferred<{ translatedText: string; engine: string; contextFingerprint: string }>();
    const pendingMutation = deferred<ProjectChangeResult>();
    const executeTranslation = vi.fn().mockReturnValue(pendingTranslation.promise);
    const commitTranslationProposal = vi.fn();
    const harness = await openSavedProject({ getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS),
      executeTranslation, commitTranslationProposal }, projectWithExistingText());
    fireEvent.click(screen.getByRole("button", { name: /AI 문맥 번역 실행/ }));
    await waitFor(() => expect(executeTranslation).toHaveBeenCalledOnce());
    harness.applyProjectMutation.mockReturnValueOnce(pendingMutation.promise);
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    await act(async () => {
      pendingTranslation.resolve({ translatedText: "대기한 제안", engine: "fixture", contextFingerprint: "" });
      await pendingTranslation.promise;
    });
    expect(commitTranslationProposal).not.toHaveBeenCalled();
    const server = { ...harness.opened, metadata: { ...harness.opened.metadata, title: "서버 제목" } };
    const response: ProjectChangeResult = nextStatus === "conflict"
      ? { status: "revision_conflict", code: "REVISION_CONFLICT", revision: 2, project: dto(server, 2), conflictingPaths: ["metadata/title"] }
      : { status: "applied", revision: 2, project: { ...dto(server, 2), status: "needs_recovery" } };
    await act(async () => { pendingMutation.resolve(response); await pendingMutation.promise; });
    expect(commitTranslationProposal).not.toHaveBeenCalled();
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByLabelText("AI 번역 1")).toHaveValue("기존 AI 제안");
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("사용자 번역");
    if (nextStatus === "conflict") expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("충돌");
    else expect(screen.getByRole("alert")).toHaveTextContent("복구");
  });

  it("does not start AI translation when the session already needs recovery", async () => {
    const executeTranslation = vi.fn();
    const commitTranslationProposal = vi.fn();
    const harness = await openSavedProject({ getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS),
      executeTranslation, commitTranslationProposal }, projectWithExistingText());
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 2,
      project: { ...dto(harness.opened, 2), status: "needs_recovery" } });
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("복구"));
    fireEvent.click(screen.getByRole("button", { name: /AI 문맥 번역 실행/ }));
    await act(async () => { await Promise.resolve(); });
    expect(executeTranslation).not.toHaveBeenCalled();
    expect(commitTranslationProposal).not.toHaveBeenCalled();
    expect(screen.getByLabelText("AI 번역 1")).toHaveValue("기존 AI 제안");
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("사용자 번역");
  });

  it("does not start AI translation with a failed unsynced title", async () => {
    const executeTranslation = vi.fn().mockResolvedValue({ translatedText: "새 제안", engine: "fixture", contextFingerprint: "" });
    const commitTranslationProposal = vi.fn().mockResolvedValue({ projectSessionId: "opened", project: dto(projectWithExistingText(), 3) });
    const harness = await openSavedProject({ getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS),
      executeTranslation, commitTranslationProposal }, projectWithExistingText());
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("합성 제목 변경 실패"));
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("합성 제목 변경 실패"));
    fireEvent.click(screen.getByRole("button", { name: /AI 문맥 번역 실행/ }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(executeTranslation).not.toHaveBeenCalled();
    expect(commitTranslationProposal).not.toHaveBeenCalled();
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByLabelText("AI 번역 1")).toHaveValue("기존 AI 제안");
    expect(screen.getByLabelText("사용자 수정문 1")).toHaveValue("사용자 번역");
  });

  it("preserves local input and the existing AI proposal when the commit DTO needs recovery", async () => {
    const pendingCommit = deferred<ProjectSaveResult>();
    const commitTranslationProposal = vi.fn().mockReturnValue(pendingCommit.promise);
    const harness = await openSavedProject({ getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS),
      executeTranslation: vi.fn().mockResolvedValue({ translatedText: "새 제안", engine: "fixture", contextFingerprint: "" }),
      commitTranslationProposal }, projectWithExistingText());
    fireEvent.click(screen.getByRole("button", { name: /AI 문맥 번역 실행/ }));
    await waitFor(() => expect(commitTranslationProposal).toHaveBeenCalledOnce());
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("합성 제목 변경 실패"));
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("합성 제목 변경 실패"));
    await act(async () => { pendingCommit.resolve({ projectSessionId: "opened", project: { ...dto(harness.opened, 2), status: "needs_recovery" } }); await pendingCommit.promise; });
    expect(screen.getByRole("alert")).toHaveTextContent("복구");
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    expect(screen.getByLabelText("AI 번역 1")).toHaveValue("기존 AI 제안");
  });

  it("does not regress a newer revision when a late AI commit response arrives", async () => {
    const pendingCommit = deferred<ProjectSaveResult>();
    const commitTranslationProposal = vi.fn().mockReturnValue(pendingCommit.promise);
    const harness = await openSavedProject({ getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS),
      executeTranslation: vi.fn().mockResolvedValue({ translatedText: "새 제안", engine: "fixture", contextFingerprint: "" }),
      commitTranslationProposal }, projectWithExistingText());
    fireEvent.click(screen.getByRole("button", { name: /AI 문맥 번역 실행/ }));
    await waitFor(() => expect(commitTranslationProposal).toHaveBeenCalledOnce());
    const mainB = { ...harness.opened, metadata: { ...harness.opened.metadata, title: "B" } };
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 3, project: dto(mainB, 3, true) });
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { pendingCommit.resolve({ projectSessionId: "opened", project: dto(harness.opened, 2) }); await pendingCommit.promise; });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    const mainC = { ...mainB, metadata: { ...mainB.metadata, title: "C" } };
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 4, project: dto(mainC, 4, true) });
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "C" } });
    await waitFor(() => expect(harness.applyProjectMutation).toHaveBeenCalledTimes(2));
    expect(harness.applyProjectMutation).toHaveBeenLastCalledWith(expect.objectContaining({ projectSessionId: "opened", baseRevision: 3 }));
  });

  it("keeps a failed local edit and its AI proposal when an earlier commit response arrives", async () => {
    const pendingCommit = deferred<ProjectSaveResult>();
    const commitTranslationProposal = vi.fn().mockReturnValue(pendingCommit.promise);
    const harness = await openSavedProject({ getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS),
      executeTranslation: vi.fn().mockResolvedValue({ translatedText: "새 제안", engine: "fixture", contextFingerprint: "" }),
      commitTranslationProposal }, projectWithExistingText());
    fireEvent.click(screen.getByRole("button", { name: /AI 문맥 번역 실행/ }));
    await waitFor(() => expect(commitTranslationProposal).toHaveBeenCalledOnce());
    harness.applyProjectMutation.mockRejectedValueOnce(new Error("합성 제목 변경 실패"));
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("합성 제목 변경 실패"));
    await act(async () => { pendingCommit.resolve({ projectSessionId: "opened", project: dto(harness.opened, 2) }); await pendingCommit.promise; });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    expect(screen.getByLabelText("AI 번역 1")).toHaveValue("기존 AI 제안");
  });
});

async function openUnsavedProject() {
  const initial = normalizeProject(createEmptyProject("A", false));
  const working = structuredClone(initial);
  const createProjectSession = vi.fn().mockResolvedValueOnce({ projectSessionId: "plain", project: dto(initial, 0), encrypted: false });
  const applyProjectMutation = vi.fn(async (args: ApplyProjectMutationArgs): Promise<ProjectChangeResult> => {
    if (args.mutation.type === "set_project_title") {
      const server = { ...working, metadata: { ...working.metadata, title: "서버 제목" } };
      return { status: "revision_conflict" as const, code: "REVISION_CONFLICT" as const, revision: 3,
        project: dto(server, 3), conflictingPaths: ["metadata/title"] };
    }
    if (args.mutation.type === "add_dialogue_line") {
      working.dialogueLines = [{ ...args.mutation.input, id: "line-1", order: 1, origin: { kind: "manual" }, parseConfidence: 1, parseWarnings: [] }];
    }
    return { status: "applied" as const, revision: args.baseRevision + 1, project: dto(structuredClone(working), args.baseRevision + 1, true) };
  });
  const closeProject = vi.fn().mockResolvedValue(undefined);
  const saveProjectAs = vi.fn();
  vi.stubGlobal("projectApi", {
    createProjectSession, applyProjectMutation, closeProject, saveProject: vi.fn(), saveProjectAs,
    openProjectFromDialog: vi.fn(), openRecentProject: vi.fn(), unlockProject: vi.fn(),
    listRecentProjects: vi.fn().mockResolvedValue([]), exportTranslations: vi.fn(),
    importTxtFile: vi.fn().mockResolvedValue({ filePath: "fixture.txt", lines: [{
      id: "line-1", order: 1, pageNumber: 1, sourceLanguage: "ja", sourceText: "원문",
      dialogueType: "speech", parseConfidence: 1, parseWarnings: []
    }] })
  });
  render(<App />);
  await waitFor(() => expect(createProjectSession).toHaveBeenCalledOnce());
  openTxtStartActions();
  const start = screen.getByRole("button", { name: "TXT로 시작" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("대사 1개를 불러왔습니다."));
  await openWorkspacePanel("수정");
  await waitFor(() => expect(applyProjectMutation.mock.calls.length).toBeGreaterThanOrEqual(2));
  const settings = within(screen.getByRole("navigation", { name: "작업 영역" })).getByRole("button", { name: "설정" });
  if (settings.getAttribute("aria-expanded") !== "true") fireEvent.click(settings);
  return { createProjectSession, applyProjectMutation, closeProject, saveProjectAs };
}

describe("unsaved project protection mode", () => {
  it("does not replace a conflicted session when protection is toggled", async () => {
    const harness = await openUnsavedProject();
    harness.createProjectSession.mockResolvedValueOnce({ projectSessionId: "secret", project: dto(normalizeProject(createEmptyProject("B", true)), 0), encrypted: true });
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("충돌"));
    fireEvent.click(screen.getByLabelText("시크릿 프로젝트"));
    const dialog = screen.queryByRole("dialog");
    if (dialog) {
      fireEvent.change(within(dialog).getByLabelText("프로젝트 암호"), { target: { value: "fixture-password" } });
      fireEvent.submit(within(dialog).getByRole("button", { name: "보호 모드 적용" }).closest("form")!);
    }
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(harness.createProjectSession).toHaveBeenCalledOnce();
    expect(harness.closeProject).not.toHaveBeenCalledWith({ projectSessionId: "plain" });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByLabelText("시크릿 프로젝트")).not.toBeChecked();
    expect(screen.getByText("저장하지 않은 변경사항이 있습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다른 이름 저장" }));
    await act(async () => { await Promise.resolve(); });
    expect(harness.saveProjectAs).not.toHaveBeenCalled();
  });

  it("keeps a recovery session when a pending protection session arrives", async () => {
    const harness = await openUnsavedProject();
    const pending = deferred<ProjectSessionResult>();
    harness.createProjectSession.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByLabelText("시크릿 프로젝트"));
    const prompt = await screen.findByRole("dialog");
    fireEvent.change(within(prompt).getByLabelText("프로젝트 암호"), { target: { value: "fixture-password" } });
    fireEvent.submit(within(prompt).getByRole("button", { name: "보호 모드 적용" }).closest("form")!);
    await waitFor(() => expect(harness.createProjectSession).toHaveBeenCalledTimes(2));
    const recovery = makeProject();
    harness.applyProjectMutation.mockResolvedValueOnce({ status: "applied", revision: 3,
      project: { ...dto(recovery, 3), status: "needs_recovery" } });
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("복구"));
    const secret = normalizeProject(createEmptyProject("A", true));
    await act(async () => { pending.resolve({ projectSessionId: "secret", project: dto(secret, 0), encrypted: true }); await pending.promise; });
    await waitFor(() => expect(harness.closeProject).toHaveBeenCalledWith({ projectSessionId: "secret" }));
    expect(harness.closeProject).not.toHaveBeenCalledWith({ projectSessionId: "plain" });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByLabelText("시크릿 프로젝트")).not.toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("복구");
  });

  it("cleans up a newly created protection session if a conflict occurs before installation", async () => {
    const harness = await openUnsavedProject();
    const pending = deferred<ProjectSessionResult>();
    harness.createProjectSession.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByLabelText("시크릿 프로젝트"));
    const prompt = await screen.findByRole("dialog");
    fireEvent.change(within(prompt).getByLabelText("프로젝트 암호"), { target: { value: "fixture-password" } });
    fireEvent.submit(within(prompt).getByRole("button", { name: "보호 모드 적용" }).closest("form")!);
    await waitFor(() => expect(harness.createProjectSession).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText("프로젝트 제목"), { target: { value: "B" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent("충돌"));
    const conflictNotice = screen.getByRole("status", { name: "작업 상태" }).textContent;
    const secret = normalizeProject(createEmptyProject("A", true));
    await act(async () => { pending.resolve({ projectSessionId: "secret", project: dto(secret, 0), encrypted: true }); await pending.promise; });
    await waitFor(() => expect(harness.closeProject).toHaveBeenCalledWith({ projectSessionId: "secret" }));
    expect(harness.closeProject).not.toHaveBeenCalledWith({ projectSessionId: "plain" });
    expect(screen.getByLabelText("프로젝트 제목")).toHaveValue("B");
    expect(screen.getByLabelText("시크릿 프로젝트")).not.toBeChecked();
    expect(screen.getByRole("status", { name: "작업 상태" })).toHaveTextContent(conflictNotice!);
  });
});
