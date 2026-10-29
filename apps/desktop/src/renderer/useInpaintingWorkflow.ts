import { useState } from "react";
import type { InpaintingProvider } from "../shared/inpainting.js";
import type { InpaintingMaskDraft } from "./inpaintingMaskDraft.js";
import type { PageImage } from "../shared/projectTypes.js";

export type InpaintingMaskDraftContext = {
  projectId: string;
  pageNumber: number;
  pageImageId: string;
  draft: InpaintingMaskDraft;
};

export type PageResultContext = {
  original: PageImage | null;
  inpainted: PageImage | null;
  translated: PageImage | null;
};

export type PageResultContextMap = Record<string, PageResultContext>;

export type PendingInpaintingContext = {
  projectId: string;
  pageNumber: number;
  pageImageId: string;
};

export function useInpaintingWorkflow() {
  const [isInpaintingRunning, setIsInpaintingRunning] = useState(false);
  const [inpaintingError, setInpaintingError] = useState<string | null>(null);
  const [selectedInpaintingProvider, setSelectedInpaintingProvider] = useState<InpaintingProvider>("gemini");
  const [inpaintingMaskDraftContext, setInpaintingMaskDraftContext] = useState<InpaintingMaskDraftContext | null>(null);
  const [pendingInpaintingContext, setPendingInpaintingContext] = useState<PendingInpaintingContext | null>(null);
  const [pageResultContexts, setPageResultContexts] = useState<PageResultContextMap>({});

  function setPageResultContext(pageImageId: string, resultContext: Partial<PageResultContext>) {
    setPageResultContexts((prev) => {
      const existing = prev[pageImageId] || { original: null, inpainted: null, translated: null };
      return {
        ...prev,
        [pageImageId]: { ...existing, ...resultContext }
      };
    });
  }

  function clearInpaintingWorkflow() {
    setIsInpaintingRunning(false);
    setInpaintingError(null);
    setInpaintingMaskDraftContext(null);
    setPendingInpaintingContext(null);
  }

  return {
    isInpaintingRunning,
    setIsInpaintingRunning,
    inpaintingError,
    setInpaintingError,
    selectedInpaintingProvider,
    setSelectedInpaintingProvider,
    inpaintingMaskDraftContext,
    setInpaintingMaskDraftContext,
    pendingInpaintingContext,
    setPendingInpaintingContext,
    pageResultContexts,
    setPageResultContexts,
    setPageResultContext,
    clearInpaintingWorkflow
  };
}
