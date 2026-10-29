import type { DictionaryTerm } from "../../../shared/projectTypes.js";
import {
  formatMangaTranslationSystemPrompt,
  formatMangaTranslationUserPrompt,
  type TranslationContextPayload
} from "../../../shared/translationContext.js";
import type { GeminiApiKeyStore } from "../../geminiApiKeyStore.js";
import { fetchWithGeminiRetry } from "../../geminiTransientRetry.js";
import type {
  TranslateExecutionOptions,
  TranslationEngineAdapter,
  TranslationEngineResult
} from "../translationEngineRegistry.js";

const GEMINI_TEXT_MODEL = "gemini-2.5-flash";

export function createGeminiTranslationAdapter(
  geminiApiKeyStore: GeminiApiKeyStore
): TranslationEngineAdapter {
  return {
    type: "gemini",
    displayName: "Google Gemini (클라우드 AI)",

    async isAvailable(): Promise<boolean> {
      const status = geminiApiKeyStore.getStatus();
      return Boolean(status.configured || process.env.GEMINI_API_KEY);
    },

    async translate(
      payload: TranslationContextPayload,
      options: TranslateExecutionOptions = {}
    ): Promise<TranslationEngineResult> {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || !apiKey.trim()) {
        throw new Error("Gemini API 키가 설정되지 않았습니다. 설정 페이지에서 API 키를 등록하세요.");
      }

      const systemPrompt = formatMangaTranslationSystemPrompt(
        payload.entities.speakerProfile,
        payload.source.dialogueType,
        payload.constraints.stylePreset
      );

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

      if (options.signal?.aborted) {
        throw new Error("Gemini 번역 요청이 취소되었습니다.");
      }

      const selectedModel = options.geminiModel?.trim() || GEMINI_TEXT_MODEL;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

      const response = await fetchWithGeminiRetry(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: options.signal,
          body: JSON.stringify({
            system_instruction: {
              parts: [{ text: systemPrompt }]
            },
            contents: [
              {
                role: "user",
                parts: [{ text: userPrompt }]
              }
            ],
            generationConfig: {
              temperature: options.temperature ?? 0.3
            }
          })
        },
        { maxAttempts: 3 }
      );

      if (!response.ok) {
        const errJson = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(`Gemini 번역 API 요청 실패: ${errJson.error?.message || response.statusText}`);
      }

      const data = (await response.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const cleaned = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/^```[\w]*\n?/gi, "")
        .replace(/\n?```$/gi, "")
        .trim();

      const unquoted = cleaned.replace(/^["'「『]([\s\S]*)["'」』]$/, "$1").trim();

      return {
        translatedText: unquoted || cleaned,
        engine: "gemini"
      };
    }
  };
}
