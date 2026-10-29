import type { DictionaryTerm } from "../../shared/projectTypes.js";
import type {
  InspectTranslationQaArgs,
  TranslationContextPayload,
  TranslationQaReport
} from "../../shared/translationContext.js";
import { inspectTranslationQuality } from "../../shared/translationContext.js";

export type TranslationEngineType = "local_ai" | "gemini" | "tm_direct";

export type TranslationEngineResult = {
  translatedText: string;
  engine: TranslationEngineType;
  usedExactTm?: boolean;
  qaReport?: TranslationQaReport;
};

export type TranslateExecutionOptions = {
  engineType?: TranslationEngineType;
  geminiModel?: string;
  localAiEndpoint?: string;
  localAiModel?: string;
  localAiRuntime?: "ollama" | "lmstudio" | "vllm" | "custom";
  temperature?: number;
  skipQaInspection?: boolean;
  signal?: AbortSignal;
};

export interface TranslationEngineAdapter {
  readonly type: TranslationEngineType;
  readonly displayName: string;
  isAvailable: () => Promise<boolean>;
  translate: (
    payload: TranslationContextPayload,
    options?: TranslateExecutionOptions
  ) => Promise<TranslationEngineResult>;
}

export type TranslationEngineRegistry = {
  registerAdapter: (adapter: TranslationEngineAdapter) => void;
  getAdapter: (type: TranslationEngineType) => TranslationEngineAdapter | undefined;
  listAdapters: () => TranslationEngineAdapter[];
  executeTranslation: (
    payload: TranslationContextPayload,
    options?: TranslateExecutionOptions
  ) => Promise<TranslationEngineResult>;
};

export function createTranslationEngineRegistry(
  initialAdapters: TranslationEngineAdapter[] = []
): TranslationEngineRegistry {
  const adapters = new Map<TranslationEngineType, TranslationEngineAdapter>();

  for (const adapter of initialAdapters) {
    adapters.set(adapter.type, adapter);
  }

  function registerAdapter(adapter: TranslationEngineAdapter): void {
    adapters.set(adapter.type, adapter);
  }

  function getAdapter(type: TranslationEngineType): TranslationEngineAdapter | undefined {
    return adapters.get(type);
  }

  function listAdapters(): TranslationEngineAdapter[] {
    return Array.from(adapters.values());
  }

  async function executeTranslation(
    payload: TranslationContextPayload,
    options: TranslateExecutionOptions = {}
  ): Promise<TranslationEngineResult> {
    const glossaryTerms: DictionaryTerm[] = payload.entities.matchedGlossary.map((g, idx) => ({
      id: `glossary-${idx}`,
      source: g.source,
      target: g.target,
      note: g.note
    }));

    // 1. Exact TM check (if available in fuzzyTmMatches with 100% similarity)
    const exactTmMatch = payload.entities.fuzzyTmMatches.find((m) => m.similarity >= 0.999);
    if (exactTmMatch && exactTmMatch.targetTranslation.trim()) {
      const qaArgs: InspectTranslationQaArgs = {
        sourceText: payload.source.sourceText,
        translatedText: exactTmMatch.targetTranslation,
        matchedTerms: glossaryTerms,
        speakerProfile: payload.entities.speakerProfile,
        dialogueType: payload.source.dialogueType
      };
      const qaReport = options.skipQaInspection ? undefined : inspectTranslationQuality(qaArgs);

      return {
        translatedText: exactTmMatch.targetTranslation,
        engine: "tm_direct",
        usedExactTm: true,
        qaReport
      };
    }

    // 2. Select appropriate engine adapter
    const requestedEngine = options.engineType ?? "local_ai";
    const adapter = adapters.get(requestedEngine) ?? adapters.get("local_ai");

    if (!adapter) {
      throw new Error(`번역 엔진 '${requestedEngine}'을(를) 사용할 수 없습니다.`);
    }

    const result = await adapter.translate(payload, options);

    // 3. Glossarion QA Quality inspection
    if (!options.skipQaInspection && !result.qaReport) {
      const qaReport = inspectTranslationQuality({
        sourceText: payload.source.sourceText,
        translatedText: result.translatedText,
        matchedTerms: glossaryTerms,
        speakerProfile: payload.entities.speakerProfile,
        dialogueType: payload.source.dialogueType
      });
      result.qaReport = qaReport;
    }

    return result;
  }

  return {
    registerAdapter,
    getAdapter,
    listAdapters,
    executeTranslation
  };
}
