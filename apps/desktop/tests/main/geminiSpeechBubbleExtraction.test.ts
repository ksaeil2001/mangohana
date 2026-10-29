import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractSpeechBubblesWithGemini,
  reocrSpeechBubbleCropWithGemini,
  validateSpeechBubblesWithGemini
} from "../../src/main/geminiSpeechBubbleExtraction";
import {
  buildSpeechBubbleCropReocrPrompt,
  buildSpeechBubbleValidationPrompt
} from "../../src/shared/speechBubbleExtraction";
import type { SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction";
import type { ReocrTarget } from "../../src/shared/speechBubbleReocr";

describe("geminiSpeechBubbleExtraction", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalModel = process.env.GEMINI_TEXT_MODEL;

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.GEMINI_TEXT_MODEL;
    else process.env.GEMINI_TEXT_MODEL = originalModel;
    vi.restoreAllMocks();
  });

  it("rejects missing GEMINI_API_KEY before making a request", async () => {
    delete process.env.GEMINI_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      extractSpeechBubblesWithGemini({
        imageBytes: Buffer.from([1]),
        sourceMimeType: "image/png",
        pageNumber: 1
      })
    ).rejects.toThrow(/GEMINI_API_KEY/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the current stable Gemini text model by default", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    delete process.env.GEMINI_TEXT_MODEL;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output_text: '{"pageNumber":1,"speechBubbles":[],"nonSpeechText":[],"warnings":[]}'
      })
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await extractSpeechBubblesWithGemini({
      imageBytes: Buffer.from([1]),
      sourceMimeType: "image/png",
      pageNumber: 1
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { model: string };
    expect(requestBody.model).toBe("gemini-3.5-flash");
  });

  it("propagates a parent abort without starting a retry", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const controller = new AbortController();
    const cancellation = new Error("OCR canceled");
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = extractSpeechBubblesWithGemini({
      imageBytes: Buffer.from([1]),
      sourceMimeType: "image/png",
      pageNumber: 1,
      signal: controller.signal
    });
    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses three total attempts for transient extraction failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiErrorResponse(503, "high demand"))
      .mockResolvedValueOnce(geminiErrorResponse(503, "high demand"))
      .mockResolvedValueOnce(geminiSuccessResponse(emptyExtraction(1)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = extractSpeechBubblesWithGemini({
      imageBytes: Buffer.from([1]),
      sourceMimeType: "image/png",
      pageNumber: 1
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual(emptyExtraction(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves the final Gemini extraction error after three failed attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiErrorResponse(503, "first overload"))
      .mockResolvedValueOnce(geminiErrorResponse(503, "second overload"))
      .mockResolvedValueOnce(geminiErrorResponse(503, "final overload"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = extractSpeechBubblesWithGemini({
      imageBytes: Buffer.from([1]),
      sourceMimeType: "image/png",
      pageNumber: 1
    }).then(
      () => new Error("Expected extraction to fail."),
      (error: unknown) => error
    );
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({
      message: "Gemini extraction request failed: final overload"
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("posts an extraction request and normalizes Gemini JSON", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_TEXT_MODEL = "gemini-test-text";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output_text: JSON.stringify({
          pageNumber: 3,
          speechBubbles: [
            {
              id: "bubble-010",
              type: "speech_bubble",
              text: "Hello\nthere",
              language: "en",
              bbox: { x: 0.9, y: -1, width: 0.5, height: 0.25 },
              readingOrder: 2,
              confidence: 1.5,
              notes: "clear"
            },
            {
              text: "あ[?]",
              type: "thought_bubble",
              language: "ja",
              bbox: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
              readingOrder: 1,
              confidence: 0.62
            }
          ],
          nonSpeechText: [
            {
              type: "caption",
              text: "ドン",
              bbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
              confidence: 0.8,
              notes: "old alias"
            },
            {
              type: "screen_text",
              text: "CALL",
              bbox: { x: 0.7, y: 0.4, width: 0.2, height: 0.2 },
              confidence: 0.6,
              notes: "phone UI",
              readingOrder: 5
            }
          ],
          warnings: ["reading order checked"]
        })
      })
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await extractSpeechBubblesWithGemini({
      imageBytes: Buffer.from([1]),
      sourceMimeType: "image/jpeg",
      pageNumber: 3,
      interestMaskBytes: Buffer.from([2])
    });

    expect(result.pageNumber).toBe(3);
    expect(result.speechBubbles.map((bubble) => bubble.text)).toEqual(["あ[?]", "Hello\nthere"]);
    expect(result.speechBubbles[0]?.type).toBe("thought_bubble");
    expect(result.speechBubbles[1]?.bbox).toEqual({ x: 0.9, y: 0, width: 0.09999999999999998, height: 0.25 });
    expect(result.speechBubbles[1]?.confidence).toBe(1);
    expect(result.nonSpeechText[0]?.type).toBe("caption_time_place");
    expect(result.nonSpeechText[0]?.notes).toBe("old alias");
    expect(result.nonSpeechText[1]?.type).toBe("screen_text");
    expect(result.nonSpeechText[1]?.readingOrder).toBe(5);
    expect(result.warnings).toEqual(["reading order checked"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": "test-gemini-key"
        },
        body: expect.any(String)
      })
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      input: Array<{ type: string; text?: string; mime_type?: string; data?: string }>;
    };
    expect(requestBody.model).toBe("gemini-test-text");
    expect(requestBody.input).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("speech_bubble")
      }),
      expect.objectContaining({ type: "image", mime_type: "image/jpeg", data: Buffer.from([1]).toString("base64") }),
      expect.objectContaining({ type: "image", mime_type: "image/png", data: Buffer.from([2]).toString("base64") })
    ]);
    expect(requestBody.input[0]?.text).toContain("thought_bubble");
    expect(requestBody.input[0]?.text).toContain("filtered_speech");
    expect(requestBody.input[0]?.text).toContain("caption_time_place");
    expect(requestBody.input[0]?.text).toContain("Do not translate");
    expect(requestBody.input[0]?.text).toContain("Treat the first provided image as the only OCR target image");
    expect(requestBody.input[0]?.text).toContain("Do not OCR the interest mask as a separate page or image");
    expect(requestBody.input[0]?.text).toContain("readingOrder starts at 1 within this single OCR target image");
  });

  it("can read text output from interaction steps", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        steps: [
          {
            content: [
              {
                type: "text",
                text: '{"pageNumber":1,"speechBubbles":[],"nonSpeechText":[],"warnings":[]}'
              }
            ]
          }
        ]
      })
    }) as unknown as typeof fetch;

    await expect(
      extractSpeechBubblesWithGemini({
        imageBytes: Buffer.from([1]),
        sourceMimeType: "image/webp",
        pageNumber: 1
      })
    ).resolves.toEqual({ pageNumber: 1, speechBubbles: [], nonSpeechText: [], warnings: [] });
  });

  it("normalizes speakerCandidates from OCR JSON", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output_text: JSON.stringify({
          pageNumber: 1,
          speechBubbles: [
            {
              id: "bubble-001",
              type: "speech_bubble",
              text: "Hello",
              language: "en",
              bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
              readingOrder: 1,
              confidence: 0.9,
              notes: "",
              speakerCandidates: [
                { speaker: "Mika", confidence: 1.2, reason: "tail points to Mika" },
                { speaker: "", confidence: 0.5, reason: "blank speaker should be ignored" },
                { speaker: "Ren", confidence: -1, reason: 123 },
                { speaker: "A", confidence: 0.2, reason: "extra" },
                { speaker: "B", confidence: 0.2, reason: "extra" }
              ]
            }
          ],
          nonSpeechText: [
            {
              type: "narration_box",
              text: "Later",
              bbox: { x: 0, y: 0, width: 0.2, height: 0.1 },
              readingOrder: 2,
              confidence: 0.8,
              notes: "",
              speakerCandidates: [{ speaker: "Narrator", confidence: 0.8, reason: "boxed narration" }]
            }
          ],
          warnings: []
        })
      })
    }) as unknown as typeof fetch;

    const result = await extractSpeechBubblesWithGemini({
      imageBytes: Buffer.from([1]),
      sourceMimeType: "image/png",
      pageNumber: 1
    });

    expect(result.speechBubbles[0]?.speakerCandidates).toEqual([
      { speaker: "Mika", confidence: 1, reason: "tail points to Mika" },
      { speaker: "Ren", confidence: 0, reason: "" },
      { speaker: "A", confidence: 0.2, reason: "extra" }
    ]);
    expect(result.nonSpeechText[0]?.speakerCandidates).toEqual([
      { speaker: "Narrator", confidence: 0.8, reason: "boxed narration" }
    ]);
  });

  it("posts a validation request through Gemini and normalizes corrected JSON", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_TEXT_MODEL = "gemini-test-text";
    const geminiExtraction: SpeechBubbleExtractionResult = {
      pageNumber: 2,
      speechBubbles: [
        {
          id: "bubble-001",
          type: "speech_bubble",
          text: "Hello",
          language: "en",
          bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
          readingOrder: 1,
          confidence: 0.88,
          notes: "",
          speakerCandidates: []
        }
      ],
      nonSpeechText: [],
      warnings: []
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output_text: JSON.stringify({
          pageNumber: 2,
          speechBubbles: [],
          nonSpeechText: [
            {
              type: "caption_time_place",
              text: "Later",
              bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
              confidence: 0.9,
              readingOrder: 1,
              notes: "scene caption"
            }
          ],
          warnings: ["Moved caption out of speech bubbles"]
        })
      })
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await validateSpeechBubblesWithGemini({
      imageBytes: Buffer.from([1, 2, 3]),
      sourceMimeType: "image/jpeg",
      geminiExtraction
    });

    expect(result.nonSpeechText[0]?.text).toBe("Later");
    expect(result.warnings).toEqual(["Moved caption out of speech bubbles"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": "test-gemini-key"
        },
        body: expect.any(String)
      })
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      input: Array<{ type: string; text?: string; mime_type?: string; data?: string }>;
    };
    expect(requestBody.model).toBe("gemini-test-text");
    expect(requestBody.input).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Gemini JSON extraction")
      }),
      expect.objectContaining({
        type: "image",
        mime_type: "image/jpeg",
        data: Buffer.from([1, 2, 3]).toString("base64")
      })
    ]);
    expect(requestBody.input[0]?.text).toContain("without translating");
    expect(requestBody.input[0]?.text).toContain('"Hello"');
    expect(requestBody.input[0]?.text).toContain("Validate against the single provided page image only");
    expect(requestBody.input[0]?.text).toContain("Keep bbox and readingOrder relative to that one image");
    expect(requestBody.input[0]?.text).toContain("speakerCandidates");
    expect(requestBody.input[0]?.text).toContain("Do not decide or finalize the speaker");
    expect(requestBody.input[0]?.text).toContain("tail direction");
    expect(requestBody.input[0]?.text).toContain("unknown");
  });

  it("uses three total attempts for transient validation failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiErrorResponse(503, "high demand"))
      .mockResolvedValueOnce(geminiErrorResponse(503, "high demand"))
      .mockResolvedValueOnce(geminiSuccessResponse(emptyExtraction(1)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = validateSpeechBubblesWithGemini({
      imageBytes: Buffer.from([1]),
      sourceMimeType: "image/png",
      geminiExtraction: emptyExtraction(1)
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual(emptyExtraction(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("includes character context when building validation prompt", () => {
    const prompt = buildSpeechBubbleValidationPrompt(emptyExtraction(1), [
      { name: "Mika", aliases: ["M"], description: "short hair", speechStyle: "casual" }
    ]);

    expect(prompt).toContain("Project character context");
    expect(prompt).toContain("Mika");
    expect(prompt).toContain("short hair");
    expect(prompt).toContain("casual");
  });

  it("builds a crop reOCR prompt scoped to one crop image", () => {
    const target = cropTarget();

    const prompt = buildSpeechBubbleCropReocrPrompt(target);

    expect(prompt).toContain("OCR only this single crop image");
    expect(prompt).toContain("Do not translate");
    expect(prompt).toContain("[?]");
    expect(prompt).toContain("speech_bubble");
    expect(prompt).toContain("Do not infer text from the full page");
  });

  it("posts one crop image to Gemini and normalizes crop reOCR JSON", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_TEXT_MODEL = "gemini-test-text";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output_text: JSON.stringify({
          text: "Hello",
          confidence: 0.84,
          notes: "clear crop"
        })
      })
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await reocrSpeechBubbleCropWithGemini({
      cropImageBytes: Buffer.from([9, 8, 7]),
      sourceMimeType: "image/png",
      target: cropTarget()
    });

    expect(result).toEqual({ text: "Hello", confidence: 0.84, notes: "clear crop" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": "test-gemini-key"
        },
        body: expect.any(String)
      })
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      input: Array<{ type: string; text?: string; mime_type?: string; data?: string }>;
    };
    expect(requestBody.model).toBe("gemini-test-text");
    expect(requestBody.input).toHaveLength(2);
    expect(requestBody.input[0]?.text).toContain("OCR only this single crop image");
    expect(requestBody.input[0]?.text).toContain("speech_bubble");
    expect(requestBody.input[1]).toEqual({
      type: "image",
      mime_type: "image/png",
      data: Buffer.from([9, 8, 7]).toString("base64")
    });
  });

  it("uses two total attempts for transient Crop ReOCR failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiErrorResponse(503, "high demand"))
      .mockResolvedValueOnce(geminiSuccessResponse({
        text: "Hello",
        confidence: 0.84,
        notes: "clear after retry"
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = reocrSpeechBubbleCropWithGemini({
      cropImageBytes: Buffer.from([9, 8, 7]),
      sourceMimeType: "image/png",
      target: cropTarget()
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({
      text: "Hello",
      confidence: 0.84,
      notes: "clear after retry"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function cropTarget(): ReocrTarget {
  return {
    kind: "speechBubbles",
    index: 0,
    type: "speech_bubble",
    text: "Hel[?]o",
    bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
    readingOrder: 1,
    confidence: 0.62,
    notes: "uncertain whole image"
  };
}

function emptyExtraction(pageNumber: number): SpeechBubbleExtractionResult {
  return {
    pageNumber,
    speechBubbles: [],
    nonSpeechText: [],
    warnings: []
  };
}

function geminiErrorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(JSON.stringify({ error: { message } }))
  } as unknown as Response;
}

function geminiSuccessResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({ output_text: JSON.stringify(payload) })
  } as unknown as Response;
}
