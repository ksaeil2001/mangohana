import type { DialogueLine } from "../shared/projectTypes";

export type TranslationOwnershipState =
  | "untranslated"
  | "ai-suggestion"
  | "user-edited"
  | "user-confirmed"
  | "review-required";

export type TranslationOwnership = {
  state: TranslationOwnershipState;
  label: string;
  description: string;
};

export function classifyTranslationOwnership(line: DialogueLine): TranslationOwnership {
  const status = line.lineStatus ?? "untranslated";
  if (status === "review") {
    return { state: "review-required", label: "재검토 필요", description: "사용자 확인이 다시 필요합니다." };
  }
  if (status === "complete") {
    return { state: "user-confirmed", label: "사용자 확정", description: "사용자가 이 번역을 확정했습니다." };
  }
  if (line.userTranslation !== undefined && line.userTranslation.length > 0) {
    return { state: "user-edited", label: "사용자 수정", description: "사용자가 수정한 초안입니다." };
  }
  if (line.aiTranslation !== undefined && line.aiTranslation.length > 0) {
    return { state: "ai-suggestion", label: "AI 제안", description: "AI가 제안한 번역이며 아직 사용자가 확정하지 않았습니다." };
  }
  return { state: "untranslated", label: "미번역", description: "아직 번역 초안이 없습니다." };
}

/** Replace only the pipeline-owned proposal. User text and status are never touched. */
export function mergeAiTranslationProposal(line: DialogueLine, proposal: string): DialogueLine {
  const normalized = proposal.trim();
  if (!normalized) {
    const next = { ...line };
    delete next.aiTranslation;
    return next;
  }
  return { ...line, aiTranslation: proposal };
}

export function markTranslationDraft(line: DialogueLine, userTranslation: string): DialogueLine {
  return { ...line, userTranslation, lineStatus: "draft" };
}

export function canConfirmTranslation(line: DialogueLine): boolean {
  return Boolean(line.userTranslation?.trim() || (!line.userTranslation && line.aiTranslation?.trim()));
}

export function confirmTranslation(line: DialogueLine): DialogueLine {
  const proposal = !line.userTranslation && line.aiTranslation?.trim() ? line.aiTranslation : undefined;
  return { ...line, ...(proposal === undefined ? {} : { userTranslation: proposal }), lineStatus: "complete" };
}

export function markTranslationReview(line: DialogueLine): DialogueLine {
  return { ...line, lineStatus: "review" };
}
