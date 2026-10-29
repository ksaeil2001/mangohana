import { useState } from "react";

export function useTranslationWorkflow() {
  const [isTranslating, setIsTranslating] = useState(false);
  const [translatingLineId, setTranslatingLineId] = useState<string | null>(null);
  const [translationError, setTranslationError] = useState<string | null>(null);

  function startTranslation(lineId?: string) {
    setIsTranslating(true);
    setTranslatingLineId(lineId ?? null);
    setTranslationError(null);
  }

  function finishTranslation() {
    setIsTranslating(false);
    setTranslatingLineId(null);
  }

  function failTranslation(error: string) {
    setIsTranslating(false);
    setTranslatingLineId(null);
    setTranslationError(error);
  }

  function resetTranslationState() {
    setIsTranslating(false);
    setTranslatingLineId(null);
    setTranslationError(null);
  }

  return {
    isTranslating,
    setIsTranslating,
    translatingLineId,
    setTranslatingLineId,
    translationError,
    setTranslationError,
    startTranslation,
    finishTranslation,
    failTranslation,
    resetTranslationState
  };
}
