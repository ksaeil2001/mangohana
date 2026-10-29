import type { OcrCropRecognitionInput, OcrCropRecognitionOutput, OcrTextRecognizer } from "../types.js";
import { createLinkedAbortController, isAbortError } from "../../abortSignals.js";

const DEFAULT_MANGA_OCR_ENDPOINT = "http://localhost:5000/ocr";

export function normalizeMangaOcrEndpoint(endpoint?: string): string {
  const trimmed = endpoint?.trim();
  if (!trimmed) return DEFAULT_MANGA_OCR_ENDPOINT;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const noTrailing = withProtocol.replace(/\/+$/, "");
  return noTrailing.endsWith("/ocr") ? noTrailing : `${noTrailing}/ocr`;
}

export class MangaOcrRunner implements OcrTextRecognizer {
  readonly name = "manga-ocr";
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = normalizeMangaOcrEndpoint(endpoint);
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
          orientation: input.orientation ?? "vertical"
        })
      });

      if (!response.ok) {
        const err = await response.text().catch(() => "");
        throw new Error(`MangaOCR 응답 실패 (HTTP ${response.status}): ${err || response.statusText}`);
      }

      const data = (await response.json()) as { text?: string; confidence?: number; notes?: string };
      const text = typeof data.text === "string" ? data.text : "";
      const confidence = typeof data.confidence === "number" ? data.confidence : 0.85;

      return {
        text,
        confidence,
        rawMangaOcrText: text,
        notes: data.notes
      };
    } catch (error) {
      if (isAbortError(error) && input.signal?.aborted) throw input.signal.reason ?? error;
      if (isAbortError(error) && linked.didTimeOut()) {
        throw new Error("MangaOCR 요청 시간이 초과되었습니다 (15초).");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`MangaOCR 인식 실패: ${message}`);
    } finally {
      linked.dispose();
    }
  }
}
