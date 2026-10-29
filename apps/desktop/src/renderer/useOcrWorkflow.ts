import { useState } from "react";
import type { SpeechBubbleReviewItem } from "./components/SpeechBubbleReviewDialog.js";

export type OcrWorkflowState = {
  isOcrRunning: boolean;
  ocrProgress: { current: number; total: number; message?: string } | null;
  ocrError: string | null;
  ocrReviewItems: SpeechBubbleReviewItem[];
  isOcrReviewOpen: boolean;
  ocrReviewPageNumber: number | null;
  ocrSelectedBubbleId: string | null;
};

export function useOcrWorkflow() {
  const [isOcrRunning, setIsOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<{ current: number; total: number; message?: string } | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrReviewItems, setOcrReviewItems] = useState<SpeechBubbleReviewItem[]>([]);
  const [isOcrReviewOpen, setIsOcrReviewOpen] = useState(false);
  const [ocrReviewPageNumber, setOcrReviewPageNumber] = useState<number | null>(null);
  const [ocrSelectedBubbleId, setOcrSelectedBubbleId] = useState<string | null>(null);

  function openOcrReview(items: SpeechBubbleReviewItem[], pageNumber: number, selectedId?: string) {
    setOcrReviewItems(items);
    setOcrReviewPageNumber(pageNumber);
    setOcrSelectedBubbleId(selectedId || (items[0]?.id ?? null));
    setIsOcrReviewOpen(true);
  }

  function closeOcrReview() {
    setIsOcrReviewOpen(false);
    setOcrReviewItems([]);
    setOcrReviewPageNumber(null);
    setOcrSelectedBubbleId(null);
  }

  function updateOcrReviewItem(id: string, updates: Partial<SpeechBubbleReviewItem>) {
    setOcrReviewItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...updates } : item))
    );
  }

  function clearOcrState() {
    setIsOcrRunning(false);
    setOcrProgress(null);
    setOcrError(null);
    setIsOcrReviewOpen(false);
    setOcrReviewItems([]);
    setOcrReviewPageNumber(null);
    setOcrSelectedBubbleId(null);
  }

  return {
    isOcrRunning,
    setIsOcrRunning,
    ocrProgress,
    setOcrProgress,
    ocrError,
    setOcrError,
    ocrReviewItems,
    setOcrReviewItems,
    isOcrReviewOpen,
    setIsOcrReviewOpen,
    ocrReviewPageNumber,
    setOcrReviewPageNumber,
    ocrSelectedBubbleId,
    setOcrSelectedBubbleId,
    openOcrReview,
    closeOcrReview,
    updateOcrReviewItem,
    clearOcrState
  };
}
