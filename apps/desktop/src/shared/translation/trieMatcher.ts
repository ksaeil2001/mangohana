import type { DialogueType, DictionaryTerm } from "../projectTypes.js";

export type TermCondition = {
  speaker?: string;
  dialogueType?: DialogueType;
  targetContext?: string;
};

export type ConditionalDictionaryTerm = DictionaryTerm & {
  condition?: TermCondition;
  priority?: number;
};

type TrieNode = {
  children: Map<string, TrieNode>;
  terms: ConditionalDictionaryTerm[];
};

export type TrieMatcher = {
  root: TrieNode;
  insert: (term: ConditionalDictionaryTerm) => void;
  findMatches: (
    text: string,
    context?: { speaker?: string; dialogueType?: DialogueType }
  ) => ConditionalDictionaryTerm[];
};

function normalizeForTrie(raw: string): string {
  if (!raw) return "";
  return raw.trim().normalize("NFKC").toLowerCase();
}

export function createTrieMatcher(terms?: readonly ConditionalDictionaryTerm[]): TrieMatcher {
  const root: TrieNode = {
    children: new Map(),
    terms: []
  };

  function insert(term: ConditionalDictionaryTerm): void {
    const normalizedSource = normalizeForTrie(term.source);
    if (!normalizedSource) return;

    let currentNode = root;
    for (const char of normalizedSource) {
      let nextNode = currentNode.children.get(char);
      if (!nextNode) {
        nextNode = { children: new Map(), terms: [] };
        currentNode.children.set(char, nextNode);
      }
      currentNode = nextNode;
    }
    currentNode.terms.push(term);
  }

  if (terms && terms.length > 0) {
    for (const term of terms) {
      insert(term);
    }
  }

  function matchesCondition(
    term: ConditionalDictionaryTerm,
    context?: { speaker?: string; dialogueType?: DialogueType; text?: string }
  ): boolean {
    if (!term.condition) return true;

    if (term.condition.speaker && context?.speaker) {
      const condSpeaker = normalizeForTrie(term.condition.speaker);
      const curSpeaker = normalizeForTrie(context.speaker);
      if (condSpeaker !== curSpeaker && !curSpeaker.includes(condSpeaker)) {
        return false;
      }
    } else if (term.condition.speaker && !context?.speaker) {
      return false;
    }

    if (term.condition.dialogueType && context?.dialogueType) {
      if (term.condition.dialogueType !== context.dialogueType) {
        return false;
      }
    }

    if (term.condition.targetContext && context?.text) {
      const condContext = normalizeForTrie(term.condition.targetContext);
      const curText = normalizeForTrie(context.text);
      if (!curText.includes(condContext)) {
        return false;
      }
    }

    return true;
  }

  function findMatches(
    text: string,
    context?: { speaker?: string; dialogueType?: DialogueType }
  ): ConditionalDictionaryTerm[] {
    if (!text || !text.trim()) return [];
    const normalizedText = normalizeForTrie(text);
    const matchedTermMap = new Map<string, ConditionalDictionaryTerm>();

    for (let i = 0; i < normalizedText.length; i += 1) {
      let currentNode: TrieNode | undefined = root;
      for (let j = i; j < normalizedText.length; j += 1) {
        const char = normalizedText[j]!;
        currentNode = currentNode.children.get(char);
        if (!currentNode) break;

        if (currentNode.terms.length > 0) {
          const eligibleTerms = currentNode.terms.filter((t) =>
            matchesCondition(t, { ...context, text: normalizedText })
          );

          if (eligibleTerms.length > 0) {
            // Sort by priority descending, then specific conditions first
            eligibleTerms.sort((a, b) => {
              const priorityA = a.priority ?? (a.condition?.speaker ? 10 : 0);
              const priorityB = b.priority ?? (b.condition?.speaker ? 10 : 0);
              return priorityB - priorityA;
            });

            const bestTerm = eligibleTerms[0]!;
            const existing = matchedTermMap.get(normalizeForTrie(bestTerm.source));
            if (!existing) {
              matchedTermMap.set(normalizeForTrie(bestTerm.source), bestTerm);
            } else {
              const exPriority = existing.priority ?? (existing.condition?.speaker ? 10 : 0);
              const curPriority = bestTerm.priority ?? (bestTerm.condition?.speaker ? 10 : 0);
              if (curPriority > exPriority) {
                matchedTermMap.set(normalizeForTrie(bestTerm.source), bestTerm);
              }
            }
          }
        }
      }
    }

    return Array.from(matchedTermMap.values());
  }

  return {
    root,
    insert,
    findMatches
  };
}
