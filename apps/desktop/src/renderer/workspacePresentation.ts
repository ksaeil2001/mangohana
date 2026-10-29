export type WorkspacePresentation = {
  isEmptyWorkspace: boolean;
  showStartPanel: boolean;
  showWorkspaceChrome: boolean;
  showPageControls: boolean;
  showBottomPanel: boolean;
  showInspector: boolean;
  showSave: boolean;
  showSaveAs: boolean;
  showExport: boolean;
  saveLabel: "새 프로젝트" | "저장 필요" | "변경 있음" | "저장됨";
};

export function getWorkspacePresentation(args: {
  currentFilePath: string | null;
  lineCount: number;
  imageCount: number;
  isDirty: boolean;
  apiReady: boolean;
}): WorkspacePresentation {
  const hasSavedFile = Boolean(args.currentFilePath);
  const hasLines = args.lineCount > 0;
  const hasImages = args.imageCount > 0;
  const hasContent = hasLines || hasImages;
  const isEmptyWorkspace = !hasContent;

  return {
    isEmptyWorkspace,
    // Empty projects share the same Workspace shell. The canvas itself
    // becomes the import affordance instead of sending users to a separate screen.
    showStartPanel: false,
    showWorkspaceChrome: true,
    showPageControls: true,
    showBottomPanel: !isEmptyWorkspace,
    showInspector: true,
    showSave: args.apiReady && (hasSavedFile || hasContent),
    showSaveAs: args.apiReady,
    showExport: args.apiReady && hasLines,
    saveLabel: !hasSavedFile
      ? isEmptyWorkspace
        ? "새 프로젝트"
        : "저장 필요"
      : args.isDirty
        ? "변경 있음"
        : "저장됨"
  };
}
