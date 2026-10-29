import type { CharacterProfile } from "../projectTypes.js";
import type { SpeakerCandidate } from "../speechBubbleExtraction.js";

export type CharacterMatchResult = {
  matchedProfile?: CharacterProfile;
  matchType: "exact_name" | "exact_alias" | "fuzzy_name" | "none";
  confidenceBoost: number;
};

export type SpeakerAssociationBenchmarkItem = {
  lineId: string;
  groundTruthSpeaker: string;
  predictedCandidates: SpeakerCandidate[];
  isSpeech: boolean;
  panelIndex?: number;
};

export type SpeakerAssociationMetrics = {
  totalLines: number;
  speechLinesCount: number;
  top1Accuracy: number; // Top-1 후보가 Ground Truth와 일치하는 비율
  top3Recall: number; // Top-3 후보 내에 Ground Truth가 포함된 비율
  unknownRate: number; // unknown으로 예측된 비율
  intraPanelAssociationCount: number;
};

/**
 * Magi 원칙 기반 Chapter-wide Character Bank 매칭:
 * 모델이 추론한 화자명 또는 사용자가 입력한 화자 텍스트를 Character Bank 내 등록된 인물과 일치시킵니다.
 */
export function matchCharacterFromBank(
  query: string,
  characterBank: CharacterProfile[]
): CharacterMatchResult {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery || !characterBank.length) {
    return { matchType: "none", confidenceBoost: 0 };
  }

  // 1. 이름 완전 일치
  const exactNameMatch = characterBank.find(
    (c) => c.name.trim().toLowerCase() === normalizedQuery
  );
  if (exactNameMatch) {
    return {
      matchedProfile: exactNameMatch,
      matchType: "exact_name",
      confidenceBoost: 0.2
    };
  }

  // 2. 별칭(Alias) 완전 일치
  for (const profile of characterBank) {
    const aliasMatch = profile.aliases?.some(
      (alias) => alias.trim().toLowerCase() === normalizedQuery
    );
    if (aliasMatch) {
      return {
        matchedProfile: profile,
        matchType: "exact_alias",
        confidenceBoost: 0.15
      };
    }
  }

  // 3. 부분 일치 (Fuzzy match)
  for (const profile of characterBank) {
    const profileName = profile.name.trim().toLowerCase();
    if (
      (profileName.length >= 2 && normalizedQuery.includes(profileName)) ||
      (normalizedQuery.length >= 2 && profileName.includes(normalizedQuery))
    ) {
      return {
        matchedProfile: profile,
        matchType: "fuzzy_name",
        confidenceBoost: 0.1
      };
    }
  }

  return { matchType: "none", confidenceBoost: 0 };
}

/**
 * Magi 원칙 기반 화자 프로필 컨텍스트를 프롬프트 및 번역 어투에 주입하기 위해 정규화합니다.
 */
export function formatCharacterBankContext(characterBank: CharacterProfile[]): string {
  if (!characterBank.length) return "등록된 캐릭터 프로필 없음.";

  return characterBank
    .map((c, idx) => {
      const aliasStr = c.aliases && c.aliases.length > 0 ? ` (별칭: ${c.aliases.join(", ")})` : "";
      const styleStr = c.speechStyle ? ` [말투/어조: ${c.speechStyle}]` : "";
      const descStr = c.description ? ` - ${c.description}` : "";
      const relStr = c.relationshipNotes ? ` (관계: ${c.relationshipNotes})` : "";
      return `${idx + 1}. ${c.name}${aliasStr}${styleStr}${descStr}${relStr}`;
    })
    .join("\n");
}

/**
 * Manga109Dialog 벤치마크 평가 기준 기반:
 * 화자-대사 연결(Speaker-to-Text Association) 정확도 지표를 계산합니다.
 */
export function calculateSpeakerAssociationMetrics(
  items: SpeakerAssociationBenchmarkItem[]
): SpeakerAssociationMetrics {
  if (!items.length) {
    return {
      totalLines: 0,
      speechLinesCount: 0,
      top1Accuracy: 0,
      top3Recall: 0,
      unknownRate: 0,
      intraPanelAssociationCount: 0
    };
  }

  let correctTop1 = 0;
  let correctTop3 = 0;
  let unknownCount = 0;
  let speechCount = 0;
  let intraPanelCount = 0;

  for (const item of items) {
    if (item.isSpeech) speechCount++;
    if (typeof item.panelIndex === "number") intraPanelCount++;

    const gt = item.groundTruthSpeaker.trim().toLowerCase();
    const top1 = item.predictedCandidates[0]?.speaker.trim().toLowerCase();

    if (!top1 || top1 === "unknown") {
      unknownCount++;
    }

    if (top1 && top1 === gt) {
      correctTop1++;
    }

    const inTop3 = item.predictedCandidates
      .slice(0, 3)
      .some((cand) => cand.speaker.trim().toLowerCase() === gt);

    if (inTop3) {
      correctTop3++;
    }
  }

  return {
    totalLines: items.length,
    speechLinesCount: speechCount,
    top1Accuracy: items.length > 0 ? Number((correctTop1 / items.length).toFixed(4)) : 0,
    top3Recall: items.length > 0 ? Number((correctTop3 / items.length).toFixed(4)) : 0,
    unknownRate: items.length > 0 ? Number((unknownCount / items.length).toFixed(4)) : 0,
    intraPanelAssociationCount: intraPanelCount
  };
}
