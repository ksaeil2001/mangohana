import { describe, expect, it } from "vitest";
import { getWorkspacePresentation } from "../../src/renderer/workspacePresentation";

describe("getWorkspacePresentation", () => {
  it("shows the start panel for an empty unsaved project", () => {
    expect(
      getWorkspacePresentation({
        currentFilePath: null,
        lineCount: 0,
        imageCount: 0,
        isDirty: false,
        apiReady: true
      })
    ).toEqual({
      isEmptyWorkspace: true,
      showStartPanel: false,
      showWorkspaceChrome: true,
      showPageControls: true,
      showBottomPanel: false,
      showInspector: true,
      showSave: false,
      showSaveAs: true,
      showExport: false,
      saveLabel: "새 프로젝트"
    });
  });

  it("shows the workspace and file actions for an unsaved project with one line", () => {
    expect(
      getWorkspacePresentation({
        currentFilePath: null,
        lineCount: 1,
        imageCount: 0,
        isDirty: true,
        apiReady: true
      })
    ).toEqual({
      isEmptyWorkspace: false,
      showStartPanel: false,
      showWorkspaceChrome: true,
      showPageControls: true,
      showBottomPanel: true,
      showInspector: true,
      showSave: true,
      showSaveAs: true,
      showExport: true,
      saveLabel: "저장 필요"
    });
  });

  it("supports a saved project with zero dialogue lines", () => {
    expect(
      getWorkspacePresentation({
        currentFilePath: "C:\\work\\empty.ctp",
        lineCount: 0,
        imageCount: 0,
        isDirty: false,
        apiReady: true
      })
    ).toEqual({
      isEmptyWorkspace: true,
      showStartPanel: false,
      showWorkspaceChrome: true,
      showPageControls: true,
      showBottomPanel: false,
      showInspector: true,
      showSave: true,
      showSaveAs: true,
      showExport: false,
      saveLabel: "저장됨"
    });
  });

  it("hides Electron actions when the API is unavailable", () => {
    expect(
      getWorkspacePresentation({
        currentFilePath: null,
        lineCount: 2,
        imageCount: 0,
        isDirty: true,
        apiReady: false
      })
    ).toMatchObject({ showSave: false, showSaveAs: false, showExport: false });
  });

  it("shows the image workspace for a saved project with images but no dialogue", () => {
    expect(
      getWorkspacePresentation({
        currentFilePath: "C:\\work\\images.ctp",
        lineCount: 0,
        imageCount: 2,
        isDirty: false,
        apiReady: true
      })
    ).toMatchObject({
      isEmptyWorkspace: false,
      showStartPanel: false,
      showWorkspaceChrome: true,
      showPageControls: true,
      showBottomPanel: true,
      showInspector: true,
      showSave: true,
      showExport: false,
      saveLabel: "저장됨"
    });
  });

  it("keeps a saved project empty when it has neither lines nor images", () => {
    expect(
      getWorkspacePresentation({
        currentFilePath: "C:\\work\\empty.ctp",
        lineCount: 0,
        imageCount: 0,
        isDirty: false,
        apiReady: true
      })
    ).toMatchObject({ isEmptyWorkspace: true, showStartPanel: false, showWorkspaceChrome: true });
  });
});
