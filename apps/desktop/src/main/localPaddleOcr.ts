import type { SpeechBubbleExtractionResult } from "../shared/speechBubbleExtraction.js";
import { createLinkedAbortController, isAbortError } from "./abortSignals.js";

export type LocalPaddleOcrArgs = {
  imageBytes: Buffer;
  pageNumber: number;
  endpoint?: string;
  signal?: AbortSignal;
};

export const DEFAULT_PADDLE_OCR_ENDPOINT = "http://localhost:5001/ocr";

export function normalizePaddleOcrEndpoint(endpoint?: string): string {
  const trimmed = endpoint?.trim();
  if (!trimmed) return DEFAULT_PADDLE_OCR_ENDPOINT;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const noTrailing = withProtocol.replace(/\/+$/, "");
  return noTrailing.endsWith("/ocr") ? noTrailing : `${noTrailing}/ocr`;
}

export async function extractSpeechBubblesWithLocalPaddleOcr(
  args: LocalPaddleOcrArgs
): Promise<SpeechBubbleExtractionResult> {
  const url = normalizePaddleOcrEndpoint(args.endpoint);
  const linked = createLinkedAbortController(args.signal, 20000);

  const imageBase64 = args.imageBytes.toString("base64");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: linked.signal,
      body: JSON.stringify({
        image: imageBase64,
        pageNumber: args.pageNumber
      })
    });

    if (!response.ok) {
      const err = typeof response.text === "function" ? await response.text().catch(() => "") : "";
      throw new Error(`PaddleOCR 로컬 서버 응답 실패 (HTTP ${response.status}): ${err || response.statusText}`);
    }

    const data = (await response.json()) as Partial<SpeechBubbleExtractionResult>;

    return {
      pageNumber: args.pageNumber,
      speechBubbles: Array.isArray(data.speechBubbles) ? data.speechBubbles : [],
      nonSpeechText: Array.isArray(data.nonSpeechText) ? data.nonSpeechText : [],
      warnings: Array.isArray(data.warnings) ? data.warnings : []
    };
  } catch (error) {
    if (isAbortError(error) && args.signal?.aborted) throw args.signal.reason ?? error;
    if (isAbortError(error) && linked.didTimeOut()) {
      throw new Error("PaddleOCR 요청 시간이 초과되었습니다 (20초).");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PaddleOCR 텍스트 인식 실패: ${message}`);
  } finally {
    linked.dispose();
  }
}
