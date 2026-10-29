import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import type { WorkspacePanelState } from "../focusDeck";
import type { GuidedStage } from "../guidedWorkflow";
import {
  deriveVisibleWorkspacePanels,
  useWorkspaceAdaptation,
  type WorkspaceAuxiliaryPanel
} from "../workspaceAdaptation";
import { ResizableWorkspace } from "./ResizableWorkspace";

export type WorkspacePanelActions = { togglePages: () => void; openResults: () => void; openInspector: () => void };
export type WorkspaceNavigationControls = {
  pagesVisible: boolean;
  inspectorVisible: boolean;
  resultsVisible: boolean;
  openPages: () => void;
  togglePages: () => void;
  toggleInspector: () => void;
  toggleResults: () => void;
};

// Inkline Production Bench: current page context drives the workbench, with progress that distinguishes done, current, and next.
interface FocusDeckShellProps {
  topBar: ReactNode | ((controls: { resultsVisible: boolean; toggleResults: () => void }) => ReactNode);
  navigation?: (controls: WorkspaceNavigationControls) => ReactNode;
  pages: ReactNode;
  canvas: ReactNode;
  editor: ReactNode;
  filmstrip: ReactNode;
  statusBar?: ReactNode;
  panelActionsRef?: Ref<WorkspacePanelActions>;
  panelState: WorkspacePanelState;
  onPanelStateChange(state: WorkspacePanelState): void;
  pagesBadge?: ReactNode;
  inspectorBadge?: ReactNode;
  resultsBadge?: ReactNode;
  currentStage: GuidedStage;
  /** True while the user is viewing a page rather than editing a selected bubble. */
  canvasPriority?: boolean;
  readingMode?: boolean;
  showWorkflow?: boolean;
  showWorkspaceChrome?: boolean;
}

export function FocusDeckShell({
  topBar,
  navigation,
  pages,
  canvas,
  editor,
  filmstrip,
  statusBar,
  panelActionsRef,
  panelState,
  onPanelStateChange,
  pagesBadge,
  inspectorBadge,
  resultsBadge,
  currentStage,
  canvasPriority = false,
  readingMode = false,
  showWorkflow = true,
  showWorkspaceChrome = true
}: FocusDeckShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const adaptation = useWorkspaceAdaptation();
  const [documentFullscreen, setDocumentFullscreen] = useState(() => Boolean(document.fullscreenElement));
  const [activeAuxiliaryPanel, setActiveAuxiliaryPanel] = useState<WorkspaceAuxiliaryPanel | null>(null);
  const [readingPagesOpen, setReadingPagesOpen] = useState(panelState.pagesOpen);
  const hideSupportingPanels = panelState.focusMode || documentFullscreen;
  const translationWorkspace = currentStage === "translation" && !canvasPriority;
  const derivedPanels = deriveVisibleWorkspacePanels(panelState, adaptation, {
    // The A rail fits beside the canvas at compact widths as well as wide.
    pagesExpanded: true,
    activePanel: activeAuxiliaryPanel
  });
  const pagesOpen = (readingMode ? readingPagesOpen : derivedPanels.pagesOpen) && !hideSupportingPanels;
  const inspectorOpen = translationWorkspace && hideSupportingPanels
    ? panelState.inspectorOpen
    : derivedPanels.inspectorOpen && !hideSupportingPanels;
  const resultsOpen = derivedPanels.resultsOpen && !hideSupportingPanels;
  const inspectorVisible = inspectorOpen && !readingMode;
  const resultsVisible = resultsOpen && !readingMode;
  const effectiveCanvasPriority = canvasPriority && !inspectorVisible;

  useEffect(() => {
    if (!readingMode) setReadingPagesOpen(derivedPanels.pagesOpen);
  }, [readingMode, derivedPanels.pagesOpen]);

  useEffect(() => {
    const updateFullscreen = () => setDocumentFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    if (adaptation.tier !== "narrow" && adaptation.tier !== "precision-limited") setActiveAuxiliaryPanel(null);
  }, [adaptation.tier]);

  useEffect(() => {
    if (!readingMode) return;
    const activeElement = document.activeElement;
    const hiddenControls = shellRef.current?.querySelectorAll(".focus-deck-inspector-edge, .focus-deck-filmstrip");
    if (activeElement && Array.from(hiddenControls ?? []).some((region) => region.contains(activeElement))) {
      shellRef.current?.querySelector<HTMLElement>(".focus-deck-canvas")?.focus({ preventScroll: true });
    }
  }, [readingMode]);

  useEffect(() => {
    if (!showWorkspaceChrome || !panelState.focusMode) return;
    const exitFocusMode = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onPanelStateChange({ ...panelState, focusMode: false });
    };
    document.addEventListener("keydown", exitFocusMode);
    return () => document.removeEventListener("keydown", exitFocusMode);
  }, [onPanelStateChange, panelState, showWorkspaceChrome]);

  const stages: Array<[GuidedStage, string]> = [
    ["ocr", "OCR"],
    ["speaker", "화자"],
    ["translation", "번역"],
    ["complete", "완료"]
  ];
  const currentStageIndex = stages.findIndex(([stage]) => stage === currentStage);

  const changePanel = (change: Partial<WorkspacePanelState>) => {
    onPanelStateChange({ ...panelState, ...change });
  };

  const toggleAuxiliaryPanel = (panel: WorkspaceAuxiliaryPanel) => {
    if (readingMode) {
      if (panel === "pages") setReadingPagesOpen((current) => !current);
      return;
    }
    if (adaptation.tier === "narrow" || adaptation.tier === "precision-limited") {
      const isOpen = (panel === "pages" && pagesOpen) ||
        (panel === "inspector" && inspectorOpen) ||
        (panel === "results" && resultsOpen);
      if (isOpen) {
        setActiveAuxiliaryPanel(null);
        changePanel({ pagesOpen: false, inspectorOpen: false, resultsOpen: false });
      } else {
        setActiveAuxiliaryPanel(panel);
        changePanel({
          pagesOpen: panel === "pages",
          inspectorOpen: panel === "inspector",
          resultsOpen: panel === "results",
          focusMode: false
        });
      }
      return;
    }
    const stateKey = `${panel}Open` as keyof Pick<WorkspacePanelState, "pagesOpen" | "inspectorOpen" | "resultsOpen">;
    changePanel({ [stateKey]: !panelState[stateKey], focusMode: false });
  };

  const openAuxiliaryPanel = (panel: WorkspaceAuxiliaryPanel) => {
    if (readingMode) {
      if (panel === "pages") setReadingPagesOpen(true);
      return;
    }
    if (adaptation.tier === "narrow" || adaptation.tier === "precision-limited") {
      setActiveAuxiliaryPanel(panel);
      changePanel({ pagesOpen: panel === "pages", inspectorOpen: panel === "inspector", resultsOpen: panel === "results", focusMode: false });
      return;
    }
    changePanel({ [`${panel}Open`]: true, focusMode: false } as Partial<WorkspacePanelState>);
  };

  useImperativeHandle(panelActionsRef, () => ({
    togglePages: () => toggleAuxiliaryPanel("pages"),
    openResults: () => openAuxiliaryPanel("results"),
    openInspector: () => openAuxiliaryPanel("inspector")
  }));

  return (
    <div
      ref={shellRef}
      className={[
        "focus-deck-shell",
        "stitch-workbench",
        navigation && showWorkspaceChrome ? "has-workspace-navigation" : "",
        showWorkspaceChrome ? "" : "empty-workspace",
        panelState.focusMode ? "focus-mode" : "",
        documentFullscreen ? "document-fullscreen" : "",
        readingMode ? "reading-mode" : "",
        pagesOpen ? "" : "pages-collapsed",
        inspectorVisible ? "" : "inspector-collapsed",
        resultsVisible ? "" : "results-collapsed",
        effectiveCanvasPriority ? "canvas-priority" : ""
      ].filter(Boolean).join(" ")}
      data-layout-tier={adaptation.tier}
      data-workspace-stage={canvasPriority ? "image" : currentStage}
      data-precision-limited={adaptation.precisionEditingDisabled ? "true" : "false"}
      data-testid="focus-deck-shell"
    >
      <header className="focus-deck-top-bar">
        {typeof topBar === "function" ? topBar({ resultsVisible, toggleResults: () => toggleAuxiliaryPanel("results") }) : topBar}
        {showWorkflow ? (
          <ol className="focus-deck-workflow-label" aria-label="작업 진행 단계">
            {stages.map(([stage, label], index) => {
              const state = index < currentStageIndex ? "complete" : stage === currentStage ? "current" : "upcoming";
              const stateLabel = state === "complete" ? "완료" : state === "current" ? "현재 단계" : "다음 단계";
              return (
                <li
                  key={stage}
                  data-state={state}
                  aria-current={stage === currentStage ? "step" : undefined}
                >
                  <span>{index + 1}</span><span>{label}</span>
                  <span className="sr-only">, {stateLabel}</span>
                </li>
              );
            })}
          </ol>
        ) : null}
        {showWorkspaceChrome ? (
          <button
            type="button"
            className="focus-deck-focus-toggle"
            aria-pressed={panelState.focusMode}
            aria-expanded={!panelState.focusMode}
            aria-controls="focus-deck-workspace-regions"
            aria-label={panelState.focusMode ? "집중 모드 끄기" : "집중 모드 켜기"}
            title={panelState.focusMode ? "집중 모드 끄기" : "집중 모드 켜기"}
            onClick={() => changePanel({ focusMode: !panelState.focusMode })}
          >
            {panelState.focusMode ? "집중 해제" : "집중 모드"}
          </button>
        ) : null}
        {showWorkspaceChrome && adaptation.showPrecisionNotice ? (
          <p className="workspace-precision-notice" role="status" aria-label="정밀 편집 안내" data-testid="workspace-precision-notice">
            창이 작아 정밀 편집을 잠시 비활성화했습니다. 이미지 열람, 페이지 이동, OCR, 수동 번역, 저장은 계속 사용할 수 있습니다.
          </p>
        ) : null}
      </header>
      {showWorkspaceChrome && navigation ? (
        <div className="focus-deck-navigation">
          {navigation({
            pagesVisible: pagesOpen,
            inspectorVisible,
            resultsVisible,
            openPages: () => openAuxiliaryPanel("pages"),
            togglePages: () => toggleAuxiliaryPanel("pages"),
            toggleInspector: () => toggleAuxiliaryPanel("inspector"),
            toggleResults: () => toggleAuxiliaryPanel("results")
          })}
        </div>
      ) : null}
      <div id="focus-deck-workspace-regions" className="focus-deck-workspace">
        {showWorkspaceChrome ? (
          <div className="focus-deck-pages-edge">
            <PanelToggle
              controls="focus-deck-pages"
              open={pagesOpen}
              openLabel="페이지 목록 열기"
              closeLabel="페이지 목록 접기"
              badge={pagesBadge}
              onClick={() => toggleAuxiliaryPanel("pages")}
            />
          </div>
        ) : null}
        {showWorkspaceChrome && pagesOpen ? (
          <aside id="focus-deck-pages" className="focus-deck-pages" aria-label="페이지 목록">
            {pages}
          </aside>
        ) : null}
        {showWorkspaceChrome ? (
          <ResizableWorkspace
            editorWidth={panelState.inspectorWidth}
            onEditorWidthChange={(inspectorWidth) => changePanel({ inspectorWidth })}
            canvas={canvas}
            editor={editor}
            editorOpen={inspectorOpen}
            editorHidden={readingMode}
          />
        ) : canvas}
        {showWorkspaceChrome ? (
          <div className="focus-deck-inspector-edge" hidden={readingMode} inert={readingMode}>
            <PanelToggle
              controls="focus-deck-inspector"
              open={inspectorOpen}
              openLabel={translationWorkspace ? "번역 편집기 열기" : "작업 인스펙터 열기"}
              closeLabel={translationWorkspace ? "번역 편집기 접기" : "작업 인스펙터 접기"}
              badge={inspectorBadge}
              onClick={() => toggleAuxiliaryPanel("inspector")}
            />
          </div>
        ) : null}
      </div>
      {showWorkspaceChrome ? (
        <footer className="focus-deck-filmstrip" aria-label="결과 및 진행" hidden={readingMode} inert={readingMode}>
          <div className="focus-deck-results-control">
            <PanelToggle
              controls="focus-deck-results"
              open={resultsOpen}
              openLabel="결과 및 진행 열기"
              closeLabel="결과 및 진행 접기"
              badge={resultsBadge}
              onClick={() => toggleAuxiliaryPanel("results")}
            />
          </div>
          {resultsOpen ? <div id="focus-deck-results" className="focus-deck-results-content">{filmstrip}</div> : null}
        </footer>
      ) : null}
      {showWorkspaceChrome && statusBar !== undefined && statusBar !== null ? (
        <div className="focus-deck-status-bar">{statusBar}</div>
      ) : null}
    </div>
  );
}

function PanelToggle({
  controls,
  open,
  openLabel,
  closeLabel,
  badge,
  onClick
}: {
  controls: string;
  open: boolean;
  openLabel: string;
  closeLabel: string;
  badge?: ReactNode;
  onClick(): void;
}) {
  const label = open ? closeLabel : openLabel;
  const isPagesEdge = controls === "focus-deck-pages";
  const isInspectorEdge = controls === "focus-deck-inspector";
  const icon = isPagesEdge
    ? (open ? "◀" : "▶")
    : isInspectorEdge
      ? (open ? "▶" : "◀")
      : (open ? "▼" : "▲");

  return (
    <button
      type="button"
      className="focus-deck-panel-toggle"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <span className="focus-deck-toggle-icon" aria-hidden="true">{icon}</span>
      <span className="focus-deck-toggle-text" aria-hidden="true">{open ? "접기" : "열기"}</span>
      {badge !== undefined && badge !== null ? <span className="focus-deck-panel-badge">{badge}</span> : null}
    </button>
  );
}
