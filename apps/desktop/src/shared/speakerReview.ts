import type { CharacterProfile } from "./projectTypes.js";
import {
  normalizeSpeakerCandidates,
  type ExtractedSpeechBubble,
  type SpeakerCandidate
} from "./speechBubbleExtraction.js";
import {
  matchCharacterFromBank,
  type CharacterMatchResult
} from "./characterBank/characterAssociation.js";
import {
  sortMangaReadingOrder,
  type PanelRegion
} from "./geometry/panelAndBubbleLayout.js";

export type SpeakerAssociationRelation =
  | "one_to_one"
  | "one_to_many"
  | "many_to_one"
  | "split"
  | "merge"
  | "collision";

export type SpeakerReviewProposal = {
  bubbleId: string;
  panelIndex?: number;
  readingOrder: number;
  candidates: SpeakerCandidate[];
  characterMatches: Array<{
    candidate: SpeakerCandidate;
    match: CharacterMatchResult;
  }>;
  associationStatus: "needs_review" | "ready_for_user_selection";
  relation: SpeakerAssociationRelation;
};

export function buildSpeakerReviewProposals(args: {
  bubbles: readonly ExtractedSpeechBubble[];
  panels?: readonly PanelRegion[];
  characters?: readonly CharacterProfile[];
  relations?: Readonly<Record<string, SpeakerAssociationRelation>>;
  direction?: "rtl" | "ltr";
}): SpeakerReviewProposal[] {
  const ordered = sortMangaReadingOrder(
    [...(args.panels ?? [])],
    args.bubbles.map((bubble) => ({
      id: bubble.id,
      bbox: bubble.bbox,
      polygon: bubble.polygon,
      readingOrder: bubble.readingOrder
    })),
    args.direction ?? "rtl"
  );
  const byId = new Map(args.bubbles.map((bubble) => [bubble.id, bubble]));
  const characters = [...(args.characters ?? [])];

  return ordered.map((bubble) => {
    const source = byId.get(bubble.id);
    const candidates = normalizeSpeakerCandidates(source?.speakerCandidates ?? []).slice(0, 3);
    const characterMatches = candidates.map((candidate) => ({
      candidate,
      match: matchCharacterFromBank(candidate.speaker, characters)
    }));
    const relation = args.relations?.[bubble.id] ?? "one_to_one";
    const topCandidate = candidates[0];
    const associationStatus =
      relation !== "one_to_one" ||
      !topCandidate ||
      topCandidate.speaker.trim().toLowerCase() === "unknown" ||
      topCandidate.confidence < 0.75
        ? "needs_review"
        : "ready_for_user_selection";

    return {
      bubbleId: bubble.id,
      ...(bubble.panelIndex === undefined ? {} : { panelIndex: bubble.panelIndex }),
      readingOrder: bubble.readingOrder,
      candidates,
      characterMatches,
      associationStatus,
      relation
    };
  });
}
