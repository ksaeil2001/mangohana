import { fetchWithGeminiRetry } from "./geminiTransientRetry.js";
import {
  evaluateInpaintingQuality,
  type InpaintingQaResult,
  type ResidualTextRegion
} from "../shared/inpaintingQa.js";

export type InspectInpaintingQaArgs = {
  inpaintedImageBytes: Buffer;
  maskBytes?: Buffer;
  sourceMimeType?: string;
  attemptCount?: number;
  maxRetryAttempts?: number;
  apiKey?: string;
};

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/**
 * 인페인팅 처리된 결과 이미지를 분석하여 잔여 텍스트 유무를 재검출하고 품질 상태(PASS / RETRY / MANUAL_REVIEW)를 판정합니다.
 */
export async function inspectInpaintingQa(
  args: InspectInpaintingQaArgs
): Promise<InpaintingQaResult> {
  const { inpaintedImageBytes, maskBytes, attemptCount = 1, maxRetryAttempts = 2, apiKey } = args;

  const effectiveApiKey = apiKey || process.env.GEMINI_API_KEY;

  if (effectiveApiKey) {
    try {
      return await inspectInpaintingQaWithGemini({
        inpaintedImageBytes,
        maskBytes,
        sourceMimeType: args.sourceMimeType || "image/png",
        attemptCount,
        maxRetryAttempts,
        apiKey: effectiveApiKey
      });
    } catch {
      console.warn("Gemini 인페인팅 QA 검수에 실패하여 수동 검토가 필요합니다.");
    }
  }

  return createUnmeasuredQaResult({
    inpaintedImageBytes,
    attemptCount,
    maxRetryAttempts
  });
}

/**
 * Gemini Vision API를 이용한 잔여 텍스트 정밀 2차 재검출
 */
async function inspectInpaintingQaWithGemini(args: {
  inpaintedImageBytes: Buffer;
  maskBytes?: Buffer;
  sourceMimeType: string;
  attemptCount: number;
  maxRetryAttempts: number;
  apiKey: string;
}): Promise<InpaintingQaResult> {
  const prompt = [
    "You are a Quality Assurance inspector for manga/comic inpainting (text removal).",
    "Task:",
    "Inspect the provided inpainted image to detect if any residual text, leftover characters, smudged letters, or stroke fragments remain in the cleaned areas.",
    "",
    "Rules:",
    "- If all text has been cleanly removed and the background/screentone/artwork is restored, return an empty residualRegions list.",
    "- If any visible Japanese/English characters, punctuation marks, or leftover letter strokes are still visible, report each region with normalized bbox (0.0 to 1.0), detected text (or snippet), confidence (0.0 to 1.0), and severity ('minor' for faint residue, 'severe' for clearly unremoved characters).",
    "- Output strict JSON format only without markdown formatting.",
    "",
    "Expected JSON schema:",
    JSON.stringify(
      {
        residualRegions: [
          {
            bbox: { x: 0.0, y: 0.0, width: 0.0, height: 0.0 },
            detectedText: "leftover text snippet",
            residualConfidence: 0.8,
            severity: "minor | severe",
            notes: "description of residue"
          }
        ]
      },
      null,
      2
    )
  ].join("\n");

  const imageParts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [
    { text: prompt },
    {
      inlineData: {
        mimeType: args.sourceMimeType,
        data: args.inpaintedImageBytes.toString("base64")
      }
    }
  ];

  if (args.maskBytes) {
    imageParts.push({
      inlineData: {
        mimeType: "image/png",
        data: args.maskBytes.toString("base64")
      }
    });
  }

  const url = `${GEMINI_API_URL}/${DEFAULT_GEMINI_MODEL}:generateContent?key=${args.apiKey}`;
  const response = await fetchWithGeminiRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: imageParts }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      })
    },
    { maxAttempts: 3 }
  );

  if (!response.ok) {
    throw new Error(`Gemini QA 요청 실패 (HTTP ${response.status})`);
  }

  const payload: unknown = await response.json();
  const candidate = isRecord(payload) && Array.isArray(payload.candidates) ? payload.candidates[0] : undefined;
  const content = isRecord(candidate) ? candidate.content : undefined;
  const part = isRecord(content) && Array.isArray(content.parts) ? content.parts[0] : undefined;
  const rawJson = isRecord(part) ? part.text : undefined;
  if (typeof rawJson !== "string" || !rawJson.trim()) {
    throw new Error("Gemini QA 응답에 검사 결과가 없습니다.");
  }

  const parsed = safeParseJsonObject(rawJson);
  if (!isRecord(parsed) || !Array.isArray(parsed.residualRegions)) {
    throw new Error("Gemini QA 응답의 잔여 텍스트 영역 목록이 올바르지 않습니다.");
  }

  const regions: ResidualTextRegion[] = parsed.residualRegions.map((region: unknown) => {
    if (!isRecord(region) || !isRecord(region.bbox)) {
      throw new Error("Gemini QA 응답의 잔여 텍스트 영역이 올바르지 않습니다.");
    }
    const { bbox, residualConfidence, severity, detectedText, notes } = region;
    if (
      !isNormalizedNumber(bbox.x) ||
      !isNormalizedNumber(bbox.y) ||
      !isNormalizedNumber(bbox.width) || bbox.width === 0 ||
      !isNormalizedNumber(bbox.height) || bbox.height === 0 ||
      bbox.x + bbox.width > 1 ||
      bbox.y + bbox.height > 1 ||
      !isNormalizedNumber(residualConfidence) ||
      (severity !== "minor" && severity !== "severe") ||
      (detectedText !== undefined && typeof detectedText !== "string") ||
      (notes !== undefined && typeof notes !== "string")
    ) {
      throw new Error("Gemini QA 응답의 잔여 텍스트 영역 필드가 올바르지 않습니다.");
    }
    return {
      bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
      detectedText: detectedText?.trim(),
      residualConfidence,
      severity,
      notes: notes?.trim()
    };
  });

  const result = evaluateInpaintingQuality({
    residualRegions: regions,
    attemptCount: args.attemptCount,
    maxRetryAttempts: args.maxRetryAttempts
  });
  if (regions.length > 0 && result.qaStatus === "pass") {
    return {
      ...result,
      qaStatus: "manual_review",
      cleanlinessScore: 0,
      residualRegions: regions,
      reason: "낮은 신뢰도 후보로 잔여 여부를 확정하지 못함, 청결도 미측정",
      recommendedAction: "none",
      recommendedDilation: 0
    };
  }
  return result;
}

function createUnmeasuredQaResult(args: {
  inpaintedImageBytes: Buffer;
  attemptCount: number;
  maxRetryAttempts: number;
}): InpaintingQaResult {
  return {
    qaStatus: "manual_review",
    // 검수 미완료 시 0은 기존 숫자 타입을 유지하는 보수적 표시값입니다.
    cleanlinessScore: 0,
    residualRegions: [],
    attemptCount: args.attemptCount,
    maxRetryAttempts: args.maxRetryAttempts,
    reason: !args.inpaintedImageBytes || args.inpaintedImageBytes.length < 64
      ? "결과 이미지 데이터가 올바르지 않습니다. 청결도는 미측정입니다."
      : "잔여 텍스트 검수를 완료하지 못해 청결도는 미측정입니다. 수동 검토가 필요합니다.",
    evaluatedAt: new Date().toISOString(),
    recommendedAction: "none"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function safeParseJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Attempt to locate outermost { and }
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("Gemini QA 응답의 JSON이 올바르지 않습니다.");
  }
}
