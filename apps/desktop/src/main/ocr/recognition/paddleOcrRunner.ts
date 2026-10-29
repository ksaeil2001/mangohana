import type { OcrCropRecognitionInput, OcrCropRecognitionOutput, OcrTextRecognizer } from "../types.js";
import { createLinkedAbortController, isAbortError } from "../../abortSignals.js";

const DEFAULT_PADDLE_OCR_ENDPOINT = "http://localhost:5001/ocr";

export function normalizePaddleOcrEndpoint(endpoint?: string): string {
  const trimmed = endpoint?.trim();
  if (!trimmed) return DEFAULT_PADDLE_OCR_ENDPOINT;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const noTrailing = withProtocol.replace(/\/+$/, "");
  return noTrailing.endsWith("/ocr") ? noTrailing : `${noTrailing}/ocr`;
}

export class PaddleOcrRunner implements OcrTextRecognizer {
  readonly name = "paddle-ocr";
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = normalizePaddleOcrEndpoint(endpoint);
  }

  async recognizeCrop(input: OcrCropRecognitionInput): Promise<OcrCropRecognitionOutput> {
    const linked = createLinkedAbortController(input.signal, 15000);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: linked.signal,
        body: JSON.stringify({
          image: input.cropBytes.toString("base64"),
          readingOrder: input.readingOrder,
          polygon: input.polygon
        })
      });

      if (!response.ok) {
        const err = await response.text().catch(() => "");
        throw new Error(`PaddleOCR 응답 실패 (HTTP ${response.status}): ${err || response.statusText}`);
      }

      const data = (await response.json()) as { text?: string; confidence?: number; language?: string; notes?: string };
      const text = typeof data.text === "string" ? data.text : "";
      const confidence = typeof data.confidence === "number" ? Math.min(1, Math.max(0, data.confidence)) : 0.8;

      return {
        text,
        confidence,
        language: data.language,
        rawPaddleOcrText: text,
        notes: data.notes
      };
    } catch (error) {
      if (isAbortError(error) && input.signal?.aborted) throw input.signal.reason ?? error;
      if (isAbortError(error) && linked.didTimeOut()) {
        throw new Error("PaddleOCR 요청 시간이 초과되었습니다 (15초).");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`PaddleOCR 인식 실패: ${message}`);
    } finally {
      linked.dispose();
    }
  }
}
