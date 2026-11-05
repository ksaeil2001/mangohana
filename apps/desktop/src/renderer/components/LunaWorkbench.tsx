import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DialogueLine, PageImage } from "../../shared/projectTypes";
import type { NormalizedBbox } from "../../shared/speechBubbleExtraction";
import type { PageStripItem } from "./PageStrip";

export interface LunaWorkbenchProps {
  projectId?: string;
  projectTitle: string;
  createdAt: string;
  currentPage: number;
  pageCount: number;
  pageImages: PageImage[];
  pageStripItems: PageStripItem[];
  currentPageLines: DialogueLine[];
  allLines: DialogueLine[];
  selectedLineId: string | null;
  issueCount: number;
  currentFilePath: string | null;
  projectSessionId: string | null;
  isTranslating: boolean;
  isInpainting: boolean;
  isExtractingOcr: boolean;
  workspaceZoom: number;
  showingOriginal: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onGoHome: () => void;
  onSelectPage: (pageNumber: number) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onSelectLine: (lineId: string) => void;
  onUpdateLine: (lineId: string, field: keyof DialogueLine, value: string | number | string[] | undefined) => void;
  onUpdateLineBbox: (lineId: string, bbox: NormalizedBbox) => void;
  onDeleteLine: () => void;
  onCreateManualLine: () => void;
  onRequestAiTranslation: () => void;
  onRunOcr: () => void;
  onOpenInpainting: () => void;
  onOpenBatchModal: (targetPages: number[] | "all") => void;
  onExportImages: () => void;
  onExportTxt: () => void;
  onImportImages: () => void;
  onCancelActiveTasks: () => void;
  onOpenEnvironmentPreparation: () => void;
  onOpenTranslationSettings?: () => void;
  onSaveProject: () => void;
  onToggleShowOriginal: (show: boolean) => void;
  onZoomChange: (zoom: number) => void;
  editingOverlayEnabled?: boolean;
  getLineImageBounds?: (line: DialogueLine) => NormalizedBbox | undefined;
  children: ReactNode | ((imageEditorOverlay: ReactNode) => ReactNode);
}

type BubbleTypographyStyle = {
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
  letterSpacing: number;
  align: "left" | "center" | "right";
  layout: "horizontal" | "vertical";
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  lowercase: boolean;
  fillBox: boolean;
  borderBox: boolean;
  textColor: "black" | "white";
};

const DEFAULT_TYPOGRAPHY: BubbleTypographyStyle = {
  fontFamily: "RIDIBatang",
  fontSize: 36,
  lineSpacing: 0,
  letterSpacing: 0,
  align: "center",
  layout: "horizontal",
  bold: false,
  italic: false,
  uppercase: false,
  lowercase: false,
  fillBox: false,
  borderBox: false,
  textColor: "black"
};

type LunaIconName =
  | "settings"
  | "edit"
  | "tools"
  | "keyboard"
  | "sun"
  | "moon"
  | "sparkle"
  | "brain"
  | "globe"
  | "link"
  | "bubble"
  | "image"
  | "chevron-down"
  | "chevron-right"
  | "chevron-left"
  | "check"
  | "eraser"
  | "brush"
  | "wand"
  | "select"
  | "box"
  | "align-left"
  | "align-center"
  | "align-right"
  | "layout-horizontal"
  | "layout-vertical"
  | "folder"
  | "grid"
  | "sort"
  | "search"
  | "download"
  | "cancel"
  | "retry"
  | "user"
  | "close"
  | "copy"
  | "duplicate"
  | "pen"
  | "droplet"
  | "trash"
  | "undo"
  | "redo"
  | "swap"
  | "eye"
  | "plus"
  | "info";

function LunaIcon({
  name,
  size = 14,
  className
}: {
  name: LunaIconName;
  size?: number;
  className?: string;
}) {
  const cn = className ? `luna-icon ${className}` : "luna-icon";
  switch (name) {
    case "settings":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "edit":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      );
    case "tools":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case "keyboard":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
        </svg>
      );
    case "sun":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      );
    case "moon":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      );
    case "sparkle":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
        </svg>
      );
    case "brain":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9.5 3a4 4 0 0 0-4 4c0 .7.2 1.4.5 2A4 4 0 0 0 4 13a4 4 0 0 0 2.5 3.7 4 4 0 0 0 5.5 3.3V4A4 4 0 0 0 9.5 3z" />
          <path d="M14.5 3a4 4 0 0 1 4 4c0 .7-.2 1.4-.5 2A4 4 0 0 1 20 13a4 4 0 0 1-2.5 3.7 4 4 0 0 1-5.5 3.3V4a4 4 0 0 1 2.5-1z" />
        </svg>
      );
    case "globe":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    case "link":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      );
    case "bubble":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "image":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      );
    case "chevron-right":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      );
    case "chevron-left":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      );
    case "check":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      );
    case "eraser":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 20H7L3 16a2 2 0 0 1 0-2.83l10-10a2 2 0 0 1 2.83 0l6 6a2 2 0 0 1 0 2.83L14 20" />
          <line x1="18" y1="12" x2="11" y2="19" />
        </svg>
      );
    case "brush":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
          <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 1.02 3.93.02 1.66-1.16 2.07-2.06 2.07-3.06 0-.55-.45-1-1-1z" />
        </svg>
      );
    case "wand":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14.5 4.5l5 5M3 21l10-10M9 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 13l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
        </svg>
      );
    case "select":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 3" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
        </svg>
      );
    case "box":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="21" x2="9" y2="9" />
        </svg>
      );
    case "align-left":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="21" y1="6" x2="3" y2="6" /><line x1="15" y1="12" x2="3" y2="12" /><line x1="18" y1="18" x2="3" y2="18" />
        </svg>
      );
    case "align-center":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="21" y1="6" x2="3" y2="6" /><line x1="17" y1="12" x2="7" y2="12" /><line x1="19" y1="18" x2="5" y2="18" />
        </svg>
      );
    case "align-right":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="21" y1="6" x2="3" y2="6" /><line x1="21" y1="12" x2="9" y2="12" /><line x1="21" y1="18" x2="6" y2="18" />
        </svg>
      );
    case "layout-horizontal":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="3" y1="7" x2="21" y2="7" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="17" x2="21" y2="17" />
        </svg>
      );
    case "layout-vertical":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="7" y1="3" x2="7" y2="21" /><line x1="12" y1="3" x2="12" y2="21" /><line x1="17" y1="3" x2="17" y2="21" />
        </svg>
      );
    case "folder":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "grid":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
        </svg>
      );
    case "sort":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4" />
        </svg>
      );
    case "search":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      );
    case "download":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      );
    case "cancel":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      );
    case "retry":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      );
    case "user":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      );
    case "close":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      );
    case "copy":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case "duplicate":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="18" x2="12" y2="12" />
          <line x1="9" y1="15" x2="15" y2="15" />
        </svg>
      );
    case "pen":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
      );
    case "droplet":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
        </svg>
      );
    case "trash":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      );
    case "undo":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7v6h6" />
          <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
        </svg>
      );
    case "redo":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 7v6h-6" />
          <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />
        </svg>
      );
    case "swap":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
        </svg>
      );
    case "eye":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "plus":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      );
    case "info":
      return (
        <svg className={cn} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      );
  }
}

export function LunaWorkbench({
  projectId,
  projectTitle,
  createdAt,
  currentPage,
  pageCount,
  pageImages,
  pageStripItems,
  currentPageLines,
  allLines,
  selectedLineId,
  issueCount,
  currentFilePath,
  projectSessionId,
  isTranslating,
  isInpainting,
  isExtractingOcr,
  workspaceZoom,
  showingOriginal,
  theme,
  onToggleTheme,
  onGoHome,
  onSelectPage,
  onPreviousPage,
  onNextPage,
  onSelectLine,
  onUpdateLine,
  onUpdateLineBbox,
  onDeleteLine,
  onCreateManualLine,
  onRequestAiTranslation,
  onRunOcr,
  onOpenInpainting,
  onOpenBatchModal,
  onExportImages,
  onExportTxt,
  onImportImages,
  onCancelActiveTasks,
  onOpenEnvironmentPreparation,
  onOpenTranslationSettings,
  onSaveProject,
  onToggleShowOriginal,
  onZoomChange,
  editingOverlayEnabled = true,
  getLineImageBounds,
  children
}: LunaWorkbenchProps) {
  const [viewMode, setViewMode] = useState<"grid" | "single">("single");
  const [leftMode, setLeftMode] = useState<"settings" | "edit">("settings");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const [translationModel, setTranslationModel] = useState<string | null>(null);
  const [selectedFont, setSelectedFont] = useState("RIDIBatang");

  useEffect(() => {
    if (viewMode !== "grid") return;
    let active = true;
    const request = window.projectApi?.getProviderSettings?.();
    void request?.then((settings) => {
      if (!active) return;
      const configuredModel = settings.translationEngine === "local_ai" ? settings.localAiModel : settings.geminiModel;
      setTranslationModel(configuredModel.trim() || null);
    }).catch(() => {
      if (active) setTranslationModel(null);
    });
    return () => { active = false; };
  }, [viewMode]);

  const [targetScope, setTargetScope] = useState<"image" | "folder">("image");
  const [globalEditingScope, setGlobalEditingScope] = useState<"image" | "folder">("image");

  // Grid selection & zoom state
  const [selectedGridPages, setSelectedGridPages] = useState<Set<number>>(() => new Set());
  useEffect(() => setSelectedGridPages(new Set()), [projectId, projectSessionId]);
  const [gridThumbScale, setGridThumbScale] = useState(40);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Edit tools & typography state
  const [typographyByLine, setTypographyByLine] = useState<Record<string, BubbleTypographyStyle>>({});
  const [globalTypography, setGlobalTypography] = useState<BubbleTypographyStyle>(DEFAULT_TYPOGRAPHY);
  const [hideBoxes, setHideBoxes] = useState(false);
  const [editingBubbleLineId, setEditingBubbleLineId] = useState<string | null>(null);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [dragPreview, setDragPreview] = useState<{ lineId: string; bbox: NormalizedBbox } | null>(null);

  // Undo/Redo history stack for line translation edits
  const undoStackRef = useRef<Array<{ lineId: string; prevText: string; nextText: string }>>([]);
  const redoStackRef = useRef<Array<{ lineId: string; prevText: string; nextText: string }>>([]);

  const activeTypography = useMemo(() => {
    if (selectedLineId && typographyByLine[selectedLineId]) {
      return typographyByLine[selectedLineId]!;
    }
    return { ...globalTypography, fontFamily: selectedFont };
  }, [globalTypography, selectedFont, selectedLineId, typographyByLine]);

  const updateActiveTypography = (patch: Partial<BubbleTypographyStyle>) => {
    if (patch.fontFamily) setSelectedFont(patch.fontFamily);
    setGlobalTypography((prev) => ({ ...prev, ...patch }));
    if (selectedLineId) {
      setTypographyByLine((prev) => ({
        ...prev,
        [selectedLineId]: { ...(prev[selectedLineId] ?? activeTypography), ...patch }
      }));
    }
  };

  const selectedLine = useMemo(
    () => currentPageLines.find((line) => line.id === selectedLineId) ?? currentPageLines[0] ?? null,
    [currentPageLines, selectedLineId]
  );

  const imageScope = projectSessionId ? `session:${projectSessionId}` : currentFilePath;

  const totalImagesCount = Math.max(pageCount, pageImages.length, pageStripItems.length);
  const totalByteSize = useMemo(
    () => pageImages.reduce((sum, img) => sum + (img.byteSize || 0), 0),
    [pageImages]
  );
  const totalSizeLabel = totalByteSize >= 1024 * 1024
    ? `${(totalByteSize / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(totalByteSize / 1024)} KB`;

  const imagePages = new Set(pageImages.map((image) => image.pageNumber));
  const selectedImagePages = [...selectedGridPages].filter((page) => imagePages.has(page)).sort((a, b) => a - b);
  const pagesWithDialogue = new Set(allLines.filter((line) => imagePages.has(line.pageNumber)).map((line) => line.pageNumber));
  const dialogueCoverage = imagePages.size > 0
    ? Math.round((pagesWithDialogue.size / imagePages.size) * 100)
    : 0;

  const visibleGridPages = useMemo(() => {
    const base = [...pageStripItems];
    if (sortOrder === "desc") base.reverse();
    if (!searchQuery.trim()) return base;
    const q = searchQuery.trim().toLowerCase();
    return base.filter((p) => String(p.pageNumber).padStart(3, "0").includes(q));
  }, [pageStripItems, searchQuery, sortOrder]);

  const zoomPercent = Math.round((workspaceZoom || 0.45) * 100);

  // Dragging / Resizing speech bubble boxes on the canvas
  const overlayLayerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    lineId: string;
    pointerId: number;
    mode: "move" | "resize-br" | "resize-tr";
    startX: number;
    startY: number;
    initialBbox: NormalizedBbox;
    latest?: NormalizedBbox;
  } | null>(null);

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const drag = dragStateRef.current;
      const container = overlayLayerRef.current;
      if (!drag || drag.pointerId !== e.pointerId || !container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dx = (e.clientX - drag.startX) / rect.width;
      const dy = (e.clientY - drag.startY) / rect.height;
      let next: NormalizedBbox = { ...drag.initialBbox };
      if (drag.mode === "move") {
        next.x = Math.max(0, Math.min(1 - next.width, drag.initialBbox.x + dx));
        next.y = Math.max(0, Math.min(1 - next.height, drag.initialBbox.y + dy));
      } else if (drag.mode === "resize-br") {
        next.width = Math.max(Math.min(0.06, next.width), Math.min(1 - next.x, next.width + dx));
        next.height = Math.max(Math.min(0.06, next.height), Math.min(1 - next.y, next.height + dy));
      } else if (drag.mode === "resize-tr") {
        const newY = Math.max(0, Math.min(next.y + next.height - Math.min(0.06, next.height), next.y + dy));
        next.width = Math.max(Math.min(0.06, next.width), Math.min(1 - next.x, next.width + dx));
        next.height = drag.initialBbox.height + (drag.initialBbox.y - newY);
        next.y = newY;
      }
      drag.latest = next;
      setDragPreview({ lineId: drag.lineId, bbox: next });
    };

    const cancelDrag = () => {
      dragStateRef.current = null;
      setDragPreview(null);
    };
    const handlePointerUp = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.latest && overlayLayerRef.current) onUpdateLineBbox(drag.lineId, drag.latest);
      cancelDrag();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", cancelDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", cancelDrag);
    };
  }, [onUpdateLineBbox]);

  useEffect(() => {
    dragStateRef.current = null;
    setDragPreview(null);
    setEditingBubbleLineId(null);
  }, [currentPage, projectSessionId, viewMode, showingOriginal, editingOverlayEnabled]);

  const handleChangeBubbleText = (line: DialogueLine, nextValue: string) => {
    const prevValue = line.userTranslation || line.aiTranslation || line.sourceText || "";
    undoStackRef.current.push({ lineId: line.id, prevText: prevValue, nextText: nextValue });
    redoStackRef.current = [];
    onUpdateLine(line.id, "userTranslation", nextValue);
  };

  const handleUndo = () => {
    const last = undoStackRef.current.pop();
    if (!last) return;
    redoStackRef.current.push(last);
    onUpdateLine(last.lineId, "userTranslation", last.prevText);
  };

  const handleRedo = () => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(next);
    onUpdateLine(next.lineId, "userTranslation", next.nextText);
  };

  const handleFindReplaceAll = () => {
    if (!findText.trim()) return;
    const scopeLines = globalEditingScope === "folder" ? allLines : currentPageLines;
    for (const line of scopeLines) {
      const current = line.userTranslation || line.aiTranslation || line.sourceText || "";
      if (current.includes(findText)) {
        const replaced = current.split(findText).join(replaceText);
        handleChangeBubbleText(line, replaced);
      }
    }
    setFindReplaceOpen(false);
  };

  const handleTranslateAction = () => {
    if (viewMode === "grid") {
      if (selectedImagePages.length > 0) onOpenBatchModal(selectedImagePages);
      return;
    }
    if (targetScope === "folder") {
      onOpenBatchModal("all");
      return;
    }
    if (currentPageLines.length === 0) {
      onRunOcr();
    } else {
      onRequestAiTranslation();
    }
  };

  const isBusy = isTranslating || isInpainting || isExtractingOcr;

  const imageEditorOverlay = editingOverlayEnabled && viewMode === "single" && !hideBoxes && !showingOriginal && currentPageLines.length > 0 && (
    <div ref={overlayLayerRef} className="luna-bubble-overlay-layer">
      {currentPageLines.map((line) => {
        const bbox = (dragPreview?.lineId === line.id ? dragPreview.bbox : undefined) ??
          line.typesetting?.bbox ?? getLineImageBounds?.(line);
        if (!bbox) return null;
        const isSelected = line.id === (selectedLine?.id ?? selectedLineId);
        const typo = typographyByLine[line.id] ?? { ...globalTypography, fontFamily: selectedFont };
        const rawText = line.userTranslation || line.aiTranslation || line.sourceText || "";
        const displayText = typo.uppercase
          ? rawText.toUpperCase()
          : typo.lowercase
            ? rawText.toLowerCase()
            : rawText;
        const isEditingThis = editingBubbleLineId === line.id;

        return (
          <div
            key={line.id}
            className={[
              "luna-bubble-box",
              leftMode === "edit" ? "edit-mode" : "preview-mode",
              isSelected ? "selected" : "unselected",
              typo.fillBox ? "has-fill" : "",
              typo.borderBox ? "has-solid-border" : ""
            ].filter(Boolean).join(" ")}
            style={{
              left: `${bbox.x * 100}%`,
              top: `${bbox.y * 100}%`,
              width: `${bbox.width * 100}%`,
              height: `${bbox.height * 100}%`
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSelectLine(line.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onSelectLine(line.id);
              setLeftMode("edit");
              setEditingBubbleLineId(line.id);
            }}
          >
            {/* Floating Dark Action Toolbar above selected bubble in EDIT mode */}
            {leftMode === "edit" && isSelected && (
              <div
                className="luna-floating-bubble-toolbar"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="luna-float-tool-btn"
                  title="Copy Text"
                  onClick={() => void navigator.clipboard?.writeText(rawText)}
                >
                  <LunaIcon name="copy" size={13} />
                </button>
                <button
                  type="button"
                  className="luna-float-tool-btn"
                  title="Add / Duplicate Bubble"
                  onClick={onCreateManualLine}
                >
                  <LunaIcon name="duplicate" size={13} />
                </button>
                <span className="luna-float-sep" aria-hidden="true" />
                <button
                  type="button"
                  className={isEditingThis ? "luna-float-tool-btn active" : "luna-float-tool-btn"}
                  title="Edit Bubble Text"
                  onClick={() =>
                    setEditingBubbleLineId((cur) => (cur === line.id ? null : line.id))
                  }
                >
                  <LunaIcon name="pen" size={13} />
                </button>
                <button
                  type="button"
                  className="luna-float-tool-btn"
                  title="Toggle Fill Background"
                  onClick={() => updateActiveTypography({ fillBox: !typo.fillBox })}
                >
                  <LunaIcon name="droplet" size={13} />
                </button>
                <span className="luna-float-sep" aria-hidden="true" />
                <button
                  type="button"
                  className="luna-float-tool-btn"
                  title="Re-run OCR"
                  onClick={onRunOcr}
                >
                  <LunaIcon name="box" size={13} />
                </button>
                <button
                  type="button"
                  className="luna-float-tool-btn"
                  title="Regenerate AI Translation"
                  onClick={onRequestAiTranslation}
                >
                  <LunaIcon name="sparkle" size={13} />
                </button>
                <button
                  type="button"
                  className="luna-float-tool-btn danger"
                  title="Delete Bubble"
                  onClick={onDeleteLine}
                >
                  <LunaIcon name="trash" size={13} />
                </button>
              </div>
            )}

            {/* Bubble Text or Inline Editor */}
            {isEditingThis ? (
              <textarea
                className="luna-bubble-inline-Input"
                autoFocus
                value={rawText}
                onChange={(e) => handleChangeBubbleText(line, e.target.value)}
                onBlur={() => setEditingBubbleLineId(null)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div
                className={[
                  "luna-bubble-text-render",
                  typo.fontFamily === "RIDIBatang" ? "font-serif" : "font-sans",
                  typo.bold ? "is-bold" : "",
                  typo.italic ? "is-italic" : "",
                  typo.layout === "vertical" ? "is-vertical" : "",
                  `align-${typo.align}`,
                  typo.textColor === "white" ? "text-white" : "text-black"
                ].filter(Boolean).join(" ")}
                style={{
                  fontSize: `${Math.max(11, Math.round(typo.fontSize * 0.42))}px`,
                  lineHeight: `${1.35 + typo.lineSpacing / 100}`,
                  letterSpacing: `${typo.letterSpacing / 100}em`
                }}
                aria-hidden="true"
              >
                {displayText}
              </div>
            )}

            {/* Corner Handles in EDIT mode (Matches Image 3) */}
            {leftMode === "edit" && (
              <>
                {isSelected && (
                  <>
                    <span className="luna-corner-handle tl" aria-hidden="true" />
                    <span
                      className="luna-corner-handle tr"
                      aria-hidden="true"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        dragStateRef.current = {
                          lineId: line.id,
                    pointerId: e.pointerId,
                          mode: "resize-tr",
                          startX: e.clientX,
                          startY: e.clientY,
                          initialBbox: bbox
                        };
                      }}
                    />
                    <span
                      className="luna-corner-handle br"
                      aria-hidden="true"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        dragStateRef.current = {
                          lineId: line.id,
                    pointerId: e.pointerId,
                          mode: "resize-br",
                          startX: e.clientX,
                          startY: e.clientY,
                          initialBbox: bbox
                        };
                      }}
                    />
                  </>
                )}
                <span
                  className={isSelected ? "luna-corner-handle bl selected" : "luna-corner-handle bl unselected"}
                  aria-hidden="true"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onSelectLine(line.id);
                    dragStateRef.current = {
                      lineId: line.id,
                  pointerId: e.pointerId,
                      mode: "move",
                      startX: e.clientX,
                      startY: e.clientY,
                      initialBbox: bbox
                    };
                  }}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div
      className={[
        "luna-workbench",
        leftCollapsed ? "left-collapsed" : "",
        rightCollapsed ? "right-collapsed" : "",
        `view-${viewMode}`,
        `mode-${leftMode}`
      ].filter(Boolean).join(" ")}
      data-testid="luna-workbench"
    >
      {/* ==================================================================
          1. LEFT COLUMN: MODE CARD (SETTINGS / EDIT) + ACTIONS CARD
          ================================================================== */}
      {!leftCollapsed && (
        <div className="luna-left-col">
          {/* Top Card: MODE (SETTINGS | EDIT) */}
          <div className="luna-card luna-mode-card">
            <div className="luna-card-header">
              <span className="luna-section-title">작업 도구</span>
              <div className="luna-header-icons">
                {leftMode === "edit" && (
                  <button
                    type="button"
                    className="luna-icon-btn"
                    title="Environment & Tools"
                    onClick={onOpenEnvironmentPreparation}
                  >
                    <LunaIcon name="tools" size={13} />
                  </button>
                )}
                <button
                  type="button"
                  className="luna-icon-btn"
                  title="Save Project (Ctrl+S)"
                  onClick={onSaveProject}
                >
                  <LunaIcon name="keyboard" size={13} />
                </button>
                <button
                  type="button"
                  className="luna-icon-btn"
                  title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
                  onClick={onToggleTheme}
                >
                  <LunaIcon name={theme === "dark" ? "sun" : "moon"} size={13} />
                </button>
              </div>
            </div>

            {/* Segmented Mode Switch */}
            <div className="luna-segmented-switch">
              <button
                type="button"
                className={leftMode === "settings" ? "luna-seg-btn active" : "luna-seg-btn"}
                onClick={() => setLeftMode("settings")}
              >
                <LunaIcon name="settings" size={12} />
                <span>실행 설정</span>
              </button>
              <button
                type="button"
                className={leftMode === "edit" ? "luna-seg-btn active" : "luna-seg-btn"}
                onClick={() => {
                  setLeftMode("edit");
                  setViewMode("single");
                }}
              >
                <LunaIcon name="edit" size={12} />
                <span>편집</span>
              </button>
            </div>

            {leftMode === "settings" ? (
              <div className="luna-mode-body">
                <div className="luna-group-block">
                  <div className="luna-subsection-label" aria-hidden="true">TRANSLATION SETTINGS</div>

                  <div className="luna-form-grid-2">
                    <div className="luna-field">
                      <span className="luna-field-label">저장된 번역 모델</span>
                      <strong className="luna-detail-val">{translationModel || "설정에서 확인"}</strong>
                    </div>
                    <div className="luna-field">
                      <span className="luna-field-label">대상 언어</span>
                      <strong className="luna-detail-val">한국어</strong>
                    </div>
                  </div>
                  <p className="luna-helper-note">번역은 앱에 저장된 모델 설정을 사용합니다. 이 화면에서 이미지 문맥을 변경할 수 없습니다.</p>
                  <button type="button" className="luna-accordion-row" onClick={onOpenTranslationSettings ?? onOpenEnvironmentPreparation}>
                    <span className="luna-accordion-label">번역 설정 열기</span>
                    <LunaIcon name="chevron-right" size={11} />
                  </button>
                </div>
              </div>
            ) : (
              /* EDIT MODE BODY (Matches Image 3) */
              <div className="luna-mode-body">
                <div className="luna-group-block">
                  <div className="luna-subsection-label" aria-hidden="true">TOOLS</div>
                  <div className="luna-tools-bar">
                    <button type="button" className="luna-action-btn" onClick={onCreateManualLine}>대사 추가</button>
                    <button type="button" className="luna-action-btn" onClick={onOpenInpainting}>배경 정리</button>
                  </div>
                </div>

                <div className="luna-divider" />

                <div className="luna-group-block">
                  <div className="luna-subsection-label">글자 미리보기</div>

                  <div className="luna-form-grid-2">
                    <div className="luna-field">
                      <span className="luna-field-label" aria-hidden="true">Font</span>
                      <div className="luna-select-wrap">
                        <span className="luna-select-prefix luna-serif-f" aria-hidden="true">F</span>
                        <select
                          className="luna-select"
                          value={activeTypography.fontFamily}
                          onChange={(e) => updateActiveTypography({ fontFamily: e.target.value })}
                          aria-label="Edit Font"
                        >
                          <option value="RIDIBatang">RIDIBatang</option>
                          <option value="Pretendard">Pretendard</option>
                          <option value="NanumGothic">NanumGothic</option>
                          <option value="NotoSansKR">NotoSansKR</option>
                        </select>
                      </div>
                    </div>

                    <div className="luna-field">
                      <span className="luna-field-label" aria-hidden="true">Formatting</span>
                      <div className="luna-btn-group">
                        <button
                          type="button"
                          className={activeTypography.bold ? "luna-fmt-btn active" : "luna-fmt-btn"}
                          onClick={() => updateActiveTypography({ bold: !activeTypography.bold })}
                        >
                          <strong aria-hidden="true">B</strong>
                        </button>
                        <button
                          type="button"
                          className={activeTypography.italic ? "luna-fmt-btn active" : "luna-fmt-btn"}
                          onClick={() => updateActiveTypography({ italic: !activeTypography.italic })}
                        >
                          <em aria-hidden="true">I</em>
                        </button>
                        <button
                          type="button"
                          className={activeTypography.uppercase ? "luna-fmt-btn active" : "luna-fmt-btn"}
                          onClick={() => updateActiveTypography({ uppercase: !activeTypography.uppercase })}
                        >
                          <span aria-hidden="true">AG</span>
                        </button>
                        <button
                          type="button"
                          className={activeTypography.lowercase ? "luna-fmt-btn active" : "luna-fmt-btn"}
                          onClick={() => updateActiveTypography({ lowercase: !activeTypography.lowercase })}
                        >
                          <span aria-hidden="true">ag</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="luna-form-grid-2">
                    <div className="luna-field">
                      <span className="luna-field-label" aria-hidden="true">Text Alignment</span>
                      <div className="luna-btn-group">
                        {(["left", "center", "right"] as const).map((align) => (
                          <button
                            key={align}
                            type="button"
                            className={activeTypography.align === align ? "luna-fmt-btn active" : "luna-fmt-btn"}
                            onClick={() => updateActiveTypography({ align })}
                          >
                            <LunaIcon
                              name={align === "left" ? "align-left" : align === "center" ? "align-center" : "align-right"}
                              size={12}
                            />
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="luna-field">
                      <span className="luna-field-label" aria-hidden="true">
                        Text Layout <span className="luna-help-dot">?</span>
                      </span>
                      <div className="luna-btn-group">
                        <button
                          type="button"
                          className={activeTypography.layout === "horizontal" ? "luna-fmt-btn active" : "luna-fmt-btn"}
                          onClick={() => updateActiveTypography({ layout: "horizontal" })}
                        >
                          <LunaIcon name="layout-horizontal" size={12} />
                        </button>
                        <button
                          type="button"
                          className={activeTypography.layout === "vertical" ? "luna-fmt-btn active" : "luna-fmt-btn"}
                          onClick={() => updateActiveTypography({ layout: "vertical" })}
                        >
                          <LunaIcon name="layout-vertical" size={12} />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="luna-field">
                    <span className="luna-field-label" aria-hidden="true">
                      Font Size <span className="luna-dim-inline">(Alt+Wheel)</span>
                    </span>
                    <div className="luna-slider-row">
                      <span className="luna-slider-icon" aria-hidden="true">Aa</span>
                      <input
                        type="range"
                        className="luna-range"
                        min={12}
                        max={72}
                        value={activeTypography.fontSize}
                        onChange={(e) => updateActiveTypography({ fontSize: Number(e.target.value) })}
                        aria-label="Font Size"
                      />
                      <span className="luna-value-box" aria-hidden="true">{activeTypography.fontSize}px</span>
                    </div>
                  </div>

                  <div className="luna-form-grid-2">
                    <div className="luna-field">
                      <span className="luna-field-label" aria-hidden="true">
                        Line Spacing <span className="luna-help-dot">?</span>
                      </span>
                      <div className="luna-slider-row">
                        <span className="luna-slider-icon" aria-hidden="true">↕A</span>
                        <input
                          type="range"
                          className="luna-range"
                          min={-20}
                          max={100}
                          value={activeTypography.lineSpacing}
                          onChange={(e) => updateActiveTypography({ lineSpacing: Number(e.target.value) })}
                          aria-label="Line Spacing"
                        />
                        <span className="luna-value-box" aria-hidden="true">{activeTypography.lineSpacing}%</span>
                      </div>
                    </div>

                    <div className="luna-field">
                      <span className="luna-field-label" aria-hidden="true">Letter Spacing</span>
                      <div className="luna-slider-row">
                        <span className="luna-slider-icon" aria-hidden="true">A↔</span>
                        <input
                          type="range"
                          className="luna-range"
                          min={-10}
                          max={50}
                          value={activeTypography.letterSpacing}
                          onChange={(e) => updateActiveTypography({ letterSpacing: Number(e.target.value) })}
                          aria-label="Letter Spacing"
                        />
                        <span className="luna-value-box" aria-hidden="true">{activeTypography.letterSpacing}%</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="luna-divider" />

                <div className="luna-group-block">
                  <div className="luna-subsection-label" aria-hidden="true">APPEARANCE</div>
                  <div className="luna-form-grid-2">
                    <div className="luna-field">
                      <span className="luna-field-label" aria-hidden="true">Colors</span>
                      <div className="luna-swatches-row">
                        <button
                          type="button"
                          className="luna-swatch-item"
                          onClick={() =>
                            updateActiveTypography({
                              textColor: activeTypography.textColor === "black" ? "white" : "black"
                            })
                          }
                        >
                          <span className="luna-swatch-label" aria-hidden="true">Text</span>
                          <span
                            className={
                              activeTypography.textColor === "black"
                                ? "luna-color-chip swatch-black"
                                : "luna-color-chip swatch-white"
                            }
                          />
                        </button>
                        <div className="luna-swatch-item">
                          <span className="luna-swatch-label" aria-hidden="true">Stroke</span>
                          <span className="luna-color-chip swatch-white" />
                        </div>
                        <div className="luna-swatch-item">
                          <span className="luna-swatch-label" aria-hidden="true">Box</span>
                          <span className="luna-color-chip swatch-white" />
                        </div>
                      </div>
                    </div>

                    <div className="luna-field">
                      <span className="luna-field-label" aria-hidden="true">
                        Box <span className="luna-help-dot">?</span>
                      </span>
                      <div className="luna-checkbox-row">
                        <label className="luna-check-label">
                          <input
                            type="checkbox"
                            checked={activeTypography.fillBox}
                            onChange={(e) => updateActiveTypography({ fillBox: e.target.checked })}
                          />
                          <span aria-hidden="true">Fill</span>
                        </label>
                        <label className="luna-check-label">
                          <input
                            type="checkbox"
                            checked={activeTypography.borderBox}
                            onChange={(e) => updateActiveTypography({ borderBox: e.target.checked })}
                          />
                          <span aria-hidden="true">Border</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="luna-divider" />

                <div className="luna-group-block">
                  <div className="luna-subsection-label" aria-hidden="true">GLOBAL EDITING</div>
                  <div className="luna-segmented-switch compact">
                    <button
                      type="button"
                      className={globalEditingScope === "image" ? "luna-seg-btn active" : "luna-seg-btn"}
                      onClick={() => setGlobalEditingScope("image")}
                    >
                      <LunaIcon name="image" size={12} />
                      <span aria-hidden="true">THIS IMAGE</span>
                    </button>
                    <button
                      type="button"
                      className={globalEditingScope === "folder" ? "luna-seg-btn active" : "luna-seg-btn"}
                      onClick={() => setGlobalEditingScope("folder")}
                    >
                      <LunaIcon name="folder" size={12} />
                      <span aria-hidden="true">THIS FOLDER</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Bottom Left Card: SELECTION / TARGET + ACTIONS */}
          <div className="luna-card luna-actions-card">
            {leftMode === "settings" ? (
              <>
                {viewMode === "grid" ? (
                  <div className="luna-group-block">
                    <div className="luna-subsection-label" aria-hidden="true">SELECTION</div>
                    <div className="luna-selection-bar">
                      <span className="luna-selection-count" aria-hidden="true">
                        이미지 {imagePages.size}장 중 {selectedImagePages.length}장 선택
                      </span>
                      <button
                        type="button"
                        className="luna-selection-link"
                        onClick={() =>
                          setSelectedGridPages(new Set(imagePages))
                        }
                      >
                        <LunaIcon name="check" size={10} />
                        <span>전체 선택</span>
                      </button>
                      <button
                        type="button"
                        className="luna-selection-link"
                        onClick={() => setSelectedGridPages(new Set())}
                      >
                        <LunaIcon name="close" size={10} />
                        <span>선택 해제</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="luna-group-block">
                    <div className="luna-subsection-label" aria-hidden="true">TARGET</div>
                    <div className="luna-segmented-switch compact">
                      <button
                        type="button"
                        className={targetScope === "image" ? "luna-seg-btn active" : "luna-seg-btn"}
                        onClick={() => setTargetScope("image")}
                      >
                        <LunaIcon name="image" size={12} />
                        <span aria-hidden="true">THIS IMAGE</span>
                      </button>
                      <button
                        type="button"
                        className={targetScope === "folder" ? "luna-seg-btn active" : "luna-seg-btn"}
                        onClick={() => setTargetScope("folder")}
                      >
                        <LunaIcon name="folder" size={12} />
                        <span aria-hidden="true">THIS FOLDER</span>
                      </button>
                    </div>
                  </div>
                )}

                <div className="luna-group-block">
                  <div className="luna-subsection-header">
                    <span className="luna-subsection-label" aria-hidden="true">ACTIONS</span>
                    {viewMode === "single" && (
                      <span className="luna-actions-badge" aria-hidden="true">
                        {targetScope === "folder" ? totalImagesCount : 1}
                      </span>
                    )}
                  </div>
                  <div className="luna-actions-grid">
                    <button
                      type="button"
                      className="luna-action-btn primary-translate"
                      disabled={viewMode === "grid" && selectedImagePages.length === 0}
                      onClick={handleTranslateAction}
                    >
                      <LunaIcon name="sparkle" size={13} />
                      <span>{viewMode === "grid" || targetScope === "folder" ? "일괄 작업" : currentPageLines.length ? "현재 대사 번역" : "현재 페이지 OCR"}</span>
                    </button>
                    <button
                      type="button"
                      className="luna-action-btn"
                      onClick={onOpenInpainting}
                    >
                      <LunaIcon name="wand" size={13} className="luna-icon-green" />
                      <span>현재 페이지 인페인팅</span>
                    </button>
                    <button
                      type="button"
                      className="luna-action-btn"
                      onClick={onExportImages}
                    >
                      <LunaIcon name="download" size={13} />
                      <span>프로젝트 이미지 내보내기</span>
                    </button>
                    <button
                      type="button"
                      className="luna-action-btn"
                      disabled={!isBusy}
                      onClick={onCancelActiveTasks}
                    >
                      <LunaIcon name="cancel" size={13} className="luna-icon-red" />
                      <span aria-hidden="true">Cancel</span>
                    </button>
                    <button
                      type="button"
                      className="luna-action-btn"
                      onClick={onRunOcr}
                    >
                      <LunaIcon name="retry" size={13} className="luna-icon-orange" />
                      <span>현재 페이지 OCR</span>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              /* EDIT MODE BOTTOM CARD (Undo, Redo, Export & Import, Find & Replace) */
              <div className="luna-group-block">
                <div className="luna-subsection-label" aria-hidden="true">ACTIONS</div>
                {findReplaceOpen && (
                  <div className="luna-find-replace-box">
                    <input
                      type="text"
                      className="luna-input"
                      placeholder="Find text..."
                      value={findText}
                      onChange={(e) => setFindText(e.target.value)}
                    />
                    <input
                      type="text"
                      className="luna-input"
                      placeholder="Replace with..."
                      value={replaceText}
                      onChange={(e) => setReplaceText(e.target.value)}
                    />
                    <button type="button" className="luna-action-btn primary-translate" onClick={handleFindReplaceAll}>
                      <span aria-hidden="true">Replace All</span>
                    </button>
                  </div>
                )}
                <div className="luna-actions-grid">
                  <button type="button" className="luna-action-btn" onClick={handleUndo}>
                    <LunaIcon name="undo" size={12} />
                    <span aria-hidden="true">Undo</span>
                    <span className="luna-shortcut-hint" aria-hidden="true">(Ctrl+Z)</span>
                  </button>
                  <button type="button" className="luna-action-btn" onClick={handleRedo}>
                    <LunaIcon name="redo" size={12} />
                    <span aria-hidden="true">Redo</span>
                    <span className="luna-shortcut-hint" aria-hidden="true">(Ctrl+Shift+Z)</span>
                  </button>
                  <button type="button" className="luna-action-btn" onClick={onExportTxt}>
                    <LunaIcon name="swap" size={12} />
                    <span>대사 TXT 내보내기</span>
                  </button>
                  <button
                    type="button"
                    className="luna-action-btn"
                    onClick={() => setFindReplaceOpen((v) => !v)}
                  >
                    <LunaIcon name="search" size={12} />
                    <span aria-hidden="true">Find &amp; Replace</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================================================================
          2. CENTER COLUMN: BREADCRUMB + GRID/SINGLE CANVAS + BOTTOM BAR
          ================================================================== */}
      <div className="luna-center-col">
        {/* Top Bar */}
        <div className="luna-center-topbar">
          <div className="luna-breadcrumbs">
            <button type="button" className="luna-crumb-btn" onClick={onGoHome}>
              <LunaIcon name="folder" size={13} className="luna-crumb-icon" />
              <span aria-hidden="true">Projects</span>
            </button>
            <span className="luna-crumb-sep" aria-hidden="true">›</span>
            <button
              type="button"
              className={viewMode === "grid" ? "luna-crumb-btn active" : "luna-crumb-btn"}
              onClick={() => setViewMode("grid")}
            >
              <span
                className={viewMode === "grid" ? "luna-crumb-badge active" : "luna-crumb-badge"}
                aria-hidden="true"
              >
                <LunaIcon name="grid" size={10} />
              </span>
              <span className="luna-crumb-title" aria-hidden="true">{projectTitle}</span>
            </button>
            <span className="luna-crumb-sep" aria-hidden="true">›</span>
            <button
              type="button"
              className={viewMode === "single" ? "luna-crumb-btn active" : "luna-crumb-btn"}
              onClick={() => setViewMode("single")}
            >
              <span
                className={viewMode === "single" ? "luna-crumb-badge active" : "luna-crumb-badge"}
                aria-hidden="true"
              >
                <LunaIcon name="image" size={10} />
              </span>
              <span aria-hidden="true">{String(currentPage).padStart(3, "0")}</span>
            </button>
          </div>

          <div className="luna-topbar-right">
            {viewMode === "grid" ? (
              <>
                {searchOpen && (
                  <input
                    type="text"
                    className="luna-top-search"
                    placeholder="Page #..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                )}
                <button
                  type="button"
                  className="luna-top-pill-btn"
                  onClick={() => setSortOrder((s) => (s === "asc" ? "desc" : "asc"))}
                >
                  <LunaIcon name="sort" size={12} />
                  <span>{sortOrder === "asc" ? "페이지 오름차순" : "페이지 내림차순"}</span>
                  <LunaIcon name="chevron-down" size={9} />
                </button>
                <button
                  type="button"
                  className="luna-top-pill-btn icon-only"
                  aria-label="페이지 검색"
                  aria-expanded={searchOpen}
                  onClick={() => setSearchOpen((v) => !v)}
                >
                  <LunaIcon name="search" size={13} />
                </button>
              </>
            ) : (
              <>
                {leftMode === "edit" && (
                  <button
                    type="button"
                    className={hideBoxes ? "luna-top-pill-btn active" : "luna-top-pill-btn"}
                    onClick={() => setHideBoxes((v) => !v)}
                  >
                    <LunaIcon name="box" size={12} />
                    <span aria-hidden="true">{hideBoxes ? "Show Boxes" : "Hide Boxes"}</span>
                  </button>
                )}
                <button
                  type="button"
                  className={showingOriginal ? "luna-top-pill-btn active" : "luna-top-pill-btn"}
                  aria-pressed={showingOriginal}
                  onClick={() => onToggleShowOriginal(!showingOriginal)}
                >
                  <LunaIcon name="eye" size={12} />
                  <span>원본 보기</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Side Collapse Handles (< and >) */}
        <button
          type="button"
          className="luna-edge-collapse left"
          onClick={() => setLeftCollapsed((v) => !v)}
          title={leftCollapsed ? "Expand Left Panel" : "Collapse Left Panel"}
        >
          <span aria-hidden="true">{leftCollapsed ? "›" : "‹"}</span>
        </button>
        <button
          type="button"
          className="luna-edge-collapse right"
          onClick={() => setRightCollapsed((v) => !v)}
          title={rightCollapsed ? "Expand Right Panel" : "Collapse Right Panel"}
        >
          <span aria-hidden="true">{rightCollapsed ? "‹" : "›"}</span>
        </button>

        {/* Center Body */}
        <div className="luna-center-body">
          {/* Folder Grid View (Image 1) */}
          {viewMode === "grid" && (
            <div
              className="luna-folder-grid-scroll"
              style={{ "--luna-grid-min": `${105 + gridThumbScale}px` } as React.CSSProperties}
            >
              <div className="luna-folder-grid">
                {visibleGridPages.map((item) => {
                  const isCurrent = item.pageNumber === currentPage;
                  const isSelected = selectedGridPages.has(item.pageNumber);
                  const borderStatus = isCurrent ? "status-blue" : item.issueCount > 0 ? "status-orange" : "";
                  return (
                    <div key={item.pageNumber} className="luna-grid-cell">
                      {item.hasImage && (
                        <input type="checkbox" className="luna-grid-page-select" aria-label={`${item.pageNumber}페이지 일괄 작업 선택`}
                          checked={isSelected} onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setSelectedGridPages((previous) => {
                              const next = new Set(previous);
                              if (checked) next.add(item.pageNumber);
                              else next.delete(item.pageNumber);
                              return next;
                            });
                          }} />
                      )}
                      <button
                        type="button"
                        className={`luna-grid-card ${borderStatus}${isSelected ? " selected" : ""}`}
                        aria-label={`${item.pageNumber}페이지 열기`}
                        aria-current={isCurrent ? "page" : undefined}
                        onClick={() => {
                          onSelectPage(item.pageNumber);
                          if (isCurrent) setViewMode("single");
                        }}
                        onDoubleClick={() => {
                          onSelectPage(item.pageNumber);
                          setViewMode("single");
                        }}
                      >
                        <div className="luna-grid-thumb-box">
                          <LunaResolvedThumb
                            path={item.storedRelativePath}
                            revision={item.imageRevision}
                            scope={imageScope}
                            pageNumber={item.pageNumber}
                          />
                        </div>
                      </button>
                      <span className="luna-grid-page-code" aria-hidden="true">
                        {String(item.pageNumber).padStart(3, "0")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Single Image Canvas (Images 2 & 3) - stays mounted at all times */}
          <div className={viewMode === "grid" ? "luna-single-stage-wrap grid-hidden" : "luna-single-stage-wrap"}>
            {typeof children === "function" ? children(imageEditorOverlay) : children}


          </div>
        </div>

        {/* Center Bottom Bar */}
        <div className="luna-center-bottombar">
          {viewMode === "grid" ? (
            <>
              <div className="luna-bottom-left">
                <span className="luna-bottom-icon" aria-hidden="true">
                  <LunaIcon name="grid" size={13} />
                </span>
                <input
                  type="range"
                  className="luna-range zoom-range"
                  min={0}
                  max={100}
                  value={gridThumbScale}
                  onChange={(e) => setGridThumbScale(Number(e.target.value))}
                  aria-label="Grid Thumbnail Scale"
                />
                <span className="luna-bottom-icon" aria-hidden="true">
                  <LunaIcon name="search" size={13} />
                </span>
              </div>
              <div className="luna-bottom-right">
                <button type="button" className="luna-bottom-btn" onClick={onImportImages}>
                  <LunaIcon name="plus" size={11} />
                  <span>이미지 추가</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="luna-bottom-left">
                <span className="luna-bottom-icon" aria-hidden="true">
                  <LunaIcon name="search" size={13} />
                </span>
                <input
                  type="range"
                  className="luna-range zoom-range"
                  min={25}
                  max={200}
                  value={zoomPercent}
                  onChange={(e) => onZoomChange(Number(e.target.value) / 100)}
                  aria-label="Canvas Zoom Slider"
                />
                <span className="luna-zoom-readout" aria-hidden="true">배율 {zoomPercent}%</span>
                <button
                  type="button"
                  className="luna-bottom-icon-btn"
                  title="Actual Size (1:1)"
                  onClick={() => onZoomChange(1)}
                >
                  <span aria-hidden="true">1:1</span>
                </button>

              </div>
              <div className="luna-bottom-right">
                <button
                  type="button"
                  className="luna-bottom-btn"
                  disabled={currentPage <= 1}
                  onClick={onPreviousPage}
                >
                  <LunaIcon name="chevron-left" size={11} />
                  <span aria-hidden="true">Prev</span>
                </button>
                <button
                  type="button"
                  className="luna-bottom-btn"
                  disabled={currentPage >= pageCount}
                  onClick={onNextPage}
                >
                  <span aria-hidden="true">Next</span>
                  <LunaIcon name="chevron-right" size={11} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ==================================================================
          3. RIGHT COLUMN: CREDITS + DETAILS / PROJECT IMAGES + ADD IMAGES
          ================================================================== */}
      {!rightCollapsed && (
        <div className="luna-right-col">
          {/* Project summary */}
          <div className="luna-card luna-credits-card">
            <div className="luna-credits-left">
              <div className="luna-credits-meta">
                <span className="luna-credits-kicker">프로젝트</span>
                <strong className="luna-credits-value">{imagePages.size}장</strong>
              </div>
            </div>
            <button
              type="button"
              className="luna-close-project-btn"
              title="Close Project"
              onClick={onGoHome}
            >
              <LunaIcon name="close" size={12} />
            </button>
          </div>

          {/* Middle Card: DETAILS (Grid View) OR PROJECT IMAGES (Single Image View) */}
          {viewMode === "grid" ? (
            <div className="luna-card luna-details-card">
              <div className="luna-card-header">
                <span className="luna-section-title" aria-hidden="true">DETAILS</span>
              </div>

              <div className="luna-details-cover">
                <LunaResolvedThumb
                  path={pageStripItems[0]?.storedRelativePath}
                  revision={pageStripItems[0]?.imageRevision}
                  scope={imageScope}
                  pageNumber={1}
                />
              </div>

              <div className="luna-details-title-block" aria-hidden="true">
                <strong>{projectTitle}</strong>
                <span>이미지 {imagePages.size}장 · {totalSizeLabel}</span>
              </div>

              <div className="luna-divider" />

              <div className="luna-group-block">
                <div className="luna-subsection-header">
                  <span className="luna-subsection-label">대사가 있는 페이지</span>
                  <strong className="luna-progress-pct">{dialogueCoverage}%</strong>
                </div>
                <div className="luna-progress-track">
                  <div className="luna-progress-fill" style={{ width: `${dialogueCoverage}%` }} />
                </div>

                <div className="luna-stats-2x2">
                  <div className="luna-stat-cell">
                    <strong>{pagesWithDialogue.size}</strong>
                    <span className="luna-stat-label"><i className="luna-dot green" /> 대사 있음</span>
                  </div>
                  <div className="luna-stat-cell">
                    <strong>{imagePages.size - pagesWithDialogue.size}</strong>
                    <span className="luna-stat-label"><i className="luna-dot gray" /> 대사 없음</span>
                  </div>
                  <div className="luna-stat-cell">
                    <strong>{allLines.length}</strong>
                    <span className="luna-stat-label">전체 대사</span>
                  </div>
                  <div className="luna-stat-cell">
                    <strong>{issueCount}</strong>
                    <span className="luna-stat-label">검토할 대사</span>
                  </div>
                </div>
              </div>

              <div className="luna-divider" />

              <div className="luna-group-block" aria-hidden="true">
                <div className="luna-subsection-label">HISTORY</div>
                <span className="luna-detail-kicker">Created</span>
                <strong className="luna-detail-val">{createdAt.slice(0, 10)}</strong>
              </div>
            </div>
          ) : (
            /* Single Image View: PROJECT IMAGES vertical linked strip (Images 2 & 3) */
            <div className="luna-card luna-project-images-card">
              <div className="luna-card-header">
                <span className="luna-section-title" aria-hidden="true">PROJECT IMAGES</span>
                <button
                  type="button"
                  className="luna-icon-btn"
                  title="Switch to Folder Grid View"
                  onClick={() => setViewMode("grid")}
                >
                  <LunaIcon name="grid" size={12} />
                </button>
              </div>

              <div className="luna-vertical-strip-scroll">
                {pageStripItems.map((item) => {
                  const isCurrent = item.pageNumber === currentPage;
                  const borderClass = isCurrent
                    ? "status-blue"
                    : item.issueCount > 0 ? "status-orange" : "";
                  return (
                    <div key={item.pageNumber} className="luna-vstrip-item">
                      <button
                        type="button"
                        className={`luna-vstrip-thumb-btn ${borderClass}`}
                        aria-label={`${item.pageNumber}페이지 열기`}
                        aria-current={isCurrent ? "page" : undefined}
                        onClick={() => onSelectPage(item.pageNumber)}
                      >
                        <LunaResolvedThumb
                          path={item.storedRelativePath}
                          revision={item.imageRevision}
                          scope={imageScope}
                          pageNumber={item.pageNumber}
                        />
                        <span className="luna-thumb-number-badge" aria-hidden="true">
                          {item.pageNumber}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Bottom Add Images Dropzone Card */}
          <div className="luna-card luna-add-images-card">
            <button
              type="button"
              className="luna-add-images-btn"
              onClick={onImportImages}
            >
              <span className="luna-add-images-icon" aria-hidden="true">
                <LunaIcon name="image" size={14} />
              </span>
              <span className="luna-add-images-text" aria-hidden="true">
                <strong>Add Images</strong>
                <span>into &ldquo;{projectTitle}&rdquo;</span>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function LunaResolvedThumb({
  path,
  revision,
  scope,
  pageNumber
}: {
  path?: string;
  revision?: string;
  scope?: string | null;
  pageNumber: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [resolvedState, setResolvedState] = useState<{ key: string; src: string } | null>(null);
  const key = `${scope ?? ""}\0${path ?? ""}\0${revision ?? ""}`;

  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { rootMargin: "80px" }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !path) return;
    const isTestEnv = typeof import.meta !== "undefined" && (import.meta as { env?: { MODE?: string } }).env?.MODE === "test";
    if (isTestEnv || !scope || !window.projectApi?.resolvePageImageSrc) {
      setResolvedState({ key, src: path });
      return;
    }
    let canceled = false;
    const resolve = window.projectApi.resolvePageImageSrc({
      ...(scope.startsWith("session:")
        ? { projectSessionId: scope.slice(8) }
        : { projectFilePath: scope }),
      storedRelativePath: path
    });
    void resolve
      .then((resolved) => {
        if (!canceled) setResolvedState({ key, src: resolved });
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [visible, key, path, scope]);

  const src = resolvedState?.key === key ? resolvedState.src : null;

  return (
    <div ref={ref} className="luna-thumb-media" aria-hidden="true">
      {src ? (
        <img src={src} alt="" loading="lazy" onError={() => setResolvedState(null)} />
      ) : (
        <span className="luna-thumb-placeholder">{String(pageNumber).padStart(3, "0")}</span>
      )}
    </div>
  );
}
