import type { DictionaryTerm } from "../../../shared/projectTypes.js";
import {
  formatMangaTranslationSystemPrompt,
  formatMangaTranslationUserPrompt,
  type TranslationContextPayload
} from "../../../shared/translationContext.js";
import { generateLocalAiTranslation } from "../../localAiClient.js";
import type {
  TranslateExecutionOptions,
  TranslationEngineAdapter,
  TranslationEngineResult
} from "../translationEngineRegistry.js";

export function createLocalAiTranslationAdapter(): TranslationEngineAdapter {
  return {
    type: "local_ai",
    displayName: "로컬 AI (Ollama / LM Studio / vLLM)",

    async isAvailable(): Promise<boolean> {
      return true;
    },

    async translate(
      payload: TranslationContextPayload,
      options: TranslateExecutionOptions = {}
    ): Promise<TranslationEngineResult> {
      const endpoint = options.localAiEndpoint || "http://localhost:11434";
      const model = options.localAiModel || "qwen2.5:7b-instruct";
      const runtime = options.localAiRuntime || "ollama";

      // 1. Build prompt from structured payload
      const systemPrompt = formatMangaTranslationSystemPrompt(
        payload.entities.speakerProfile,
        payload.source.dialogueType,
        payload.constraints.stylePreset
      );

      // Convert fuzzy matches to format expected by user prompt
      const fuzzyTmCandidates = payload.entities.fuzzyTmMatches.map((m) => ({
        entry: {
          id: "tm",
          sourceText: m.sourceText,
          targetTranslation: m.targetTranslation,
          speaker: m.speaker
        },
        similarity: m.similarity,
        isExactMatch: m.similarity >= 0.999
      }));

      const matchedDictionaryTerms: DictionaryTerm[] = payload.entities.matchedGlossary.map(
        (g, idx) => ({
          id: `glossary-${idx}`,
          source: g.source,
          target: g.target,
          note: g.note
        })
      );

      const userPrompt = formatMangaTranslationUserPrompt({
        sourceText: payload.source.sourceText,
        previousTurns: payload.contextWindow.previousTurns,
        nextTurns: payload.contextWindow.nextTurns,
        matchedTerms: matchedDictionaryTerms,
        fuzzyTmMatches: fuzzyTmCandidates,
        speakerProfile: payload.entities.speakerProfile,
        dialogueType: payload.source.dialogueType
      });

      const translatedText = await generateLocalAiTranslation({
        runtime,
        endpoint,
        model,
        sourceText: userPrompt,
        sourceLanguage: payload.source.sourceLanguage === "ja" || payload.source.sourceLanguage === "en"
          ? payload.source.sourceLanguage
          : "auto",
        systemPrompt,
        temperature: options.temperature ?? 0.3,
        signal: options.signal
      });

      return {
        translatedText,
        engine: "local_ai"
      };
    }
  };
}
