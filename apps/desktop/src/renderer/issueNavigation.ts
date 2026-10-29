import type { DialogueLine } from "../shared/projectTypes";
import type { NormalizedBbox } from "../shared/speechBubbleExtraction";
import type { OverlayKind } from "./trioState";
import type { ImageViewportState } from "./imageViewport";

export type IssueKind = "ocr" | "speaker" | "translation" | "review";
export type IssueEditor = "ocr" | "speaker" | "translation";

export type IssueLineItem = {
  line: DialogueLine;
  reasons: string[];
};

export type IssueNavigationTarget = {
  line: DialogueLine;
  lineId: string;
  pageNumber: number;
  kind: IssueKind;
  editor: IssueEditor;
  reasons: string[];
  requiredOverlays: readonly OverlayKind[];
  focusBbox?: NormalizedBbox;
};

export type IssueNavigationRule = {
  kind: IssueKind;
  editor: IssueEditor;
  requiredOverlays: readonly OverlayKind[];
  matches: (line: DialogueLine) => boolean;
};

export type IssueNavigationState = {
  currentIssueId: string | null;
  currentPage: number;
  selectedLineId: string | null;
  editor: IssueEditor | null;
  visibleOverlayKinds: readonly OverlayKind[];
  viewport: ImageViewportState | null;
};

export type IssueNavigationCommitResult = {
  ok: boolean;
  transactionId?: string;
  expectedTransactionId?: string;
};

export const ISSUE_NAVIGATION_RULES: readonly IssueNavigationRule[] = [
  {
    kind: "ocr",
    editor: "ocr",
    requiredOverlays: ["ocr", "balloon", "issue"],
    matches: (line) => (line.parseConfidence ?? 1) < 0.75 || (line.parseWarnings ?? []).some((warning) => warning.trim().length > 0)
  },
  {
    kind: "speaker",
    editor: "speaker",
    requiredOverlays: ["balloon", "issue"],
    matches: (line) => {
      const speaker = line.speaker?.trim().toLowerCase();
      return !speaker || speaker === "unknown";
    }
  },
  {
    kind: "translation",
    editor: "translation",
    requiredOverlays: ["safe-area", "typeset", "issue"],
    matches: (line) => Boolean(
      (line.sourceText || line.aiTranslation) &&
      (line.lineStatus ?? "untranslated") !== "complete" &&
      (!line.userTranslation?.trim() || (line.lineStatus ?? "untranslated") !== "review")
    )
  },
  {
    kind: "review",
    editor: "translation",
    requiredOverlays: ["issue"],
    matches: (line) => (line.lineStatus ?? "untranslated") === "review"
  }
];

export function getIssueReasons(line: DialogueLine): string[] {
  const reasons = new Set<string>();
  const speaker = line.speaker?.trim();
  const normalizedSpeaker = speaker?.toLowerCase();
  const status = line.lineStatus ?? "untranslated";

  if (status === "review") reasons.add("검토필요");
  for (const warning of line.parseWarnings ?? []) {
    if (warning.trim()) reasons.add(warning.trim());
  }
  if ((line.parseConfidence ?? 1) < 0.75) reasons.add("OCR confidence is low");
  if (!speaker) reasons.add("화자 없음");
  if (normalizedSpeaker === "unknown") reasons.add(`화자 ${speaker}`);
  if ((line.sourceText || line.aiTranslation) && !line.userTranslation?.trim() && status !== "complete") {
    reasons.add("사용자 수정문 없음");
  }
  if ((line.sourceText || line.aiTranslation) && line.userTranslation?.trim() && status !== "complete" && status !== "review") {
    reasons.add("번역 검수 미확정");
  }

  return [...reasons];
}

export function getIssueLineItems(lines: readonly DialogueLine[]): IssueLineItem[] {
  return lines.flatMap((line) => {
    const reasons = getIssueReasons(line);
    return reasons.length > 0 ? [{ line, reasons }] : [];
  });
}

export function classifyIssueKind(line: DialogueLine): IssueKind | null {
  return ISSUE_NAVIGATION_RULES.find((rule) => rule.matches(line))?.kind ?? null;
}

export function prepareIssueNavigation(
  line: DialogueLine | null | undefined,
  options: { focusBbox?: NormalizedBbox } = {}
): IssueNavigationTarget | null {
  if (!line || !line.id.trim() || !Number.isInteger(line.pageNumber) || line.pageNumber < 1) return null;
  const kind = classifyIssueKind(line);
  if (!kind) return null;
  const rule = ISSUE_NAVIGATION_RULES.find((candidate) => candidate.kind === kind);
  if (!rule) return null;
  return {
    line,
    lineId: line.id,
    pageNumber: line.pageNumber,
    kind,
    editor: rule.editor,
    reasons: getIssueReasons(line),
    requiredOverlays: [...rule.requiredOverlays],
    focusBbox: options.focusBbox
  };
}

export function commitOrRollbackIssueNavigation(
  snapshot: IssueNavigationState,
  target: IssueNavigationTarget,
  result: IssueNavigationCommitResult
): IssueNavigationState {
  if (!result.ok) return cloneNavigationState(snapshot);
  if (
    result.transactionId !== undefined &&
    result.expectedTransactionId !== undefined &&
    result.transactionId !== result.expectedTransactionId
  ) {
    return cloneNavigationState(snapshot);
  }

  const visibleOverlayKinds = [...snapshot.visibleOverlayKinds];
  for (const kind of target.requiredOverlays) {
    if (!visibleOverlayKinds.includes(kind)) visibleOverlayKinds.push(kind);
  }

  return {
    ...snapshot,
    currentIssueId: target.lineId,
    currentPage: target.pageNumber,
    selectedLineId: target.lineId,
    editor: target.editor,
    visibleOverlayKinds
  };
}

export function rollbackIssueNavigation(snapshot: IssueNavigationState): IssueNavigationState {
  return cloneNavigationState(snapshot);
}

function cloneNavigationState(state: IssueNavigationState): IssueNavigationState {
  return {
    ...state,
    visibleOverlayKinds: [...state.visibleOverlayKinds],
    viewport: state.viewport
      ? {
          ...state.viewport,
          pan: { ...state.viewport.pan },
          layers: { ...state.viewport.layers }
        }
      : null
  };
}
