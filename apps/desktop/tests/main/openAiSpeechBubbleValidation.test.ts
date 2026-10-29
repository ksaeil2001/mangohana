import { afterEach, describe, expect, it, vi } from "vitest";
import { validateSpeechBubblesWithOpenAI } from "../../src/main/openAiSpeechBubbleValidation";
import type { SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction";

describe("openAiSpeechBubbleValidation", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_VALIDATION_MODEL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.OPENAI_VALIDATION_MODEL;
    else process.env.OPENAI_VALIDATION_MODEL = originalModel;
    vi.restoreAllMocks();
  });

  it("rejects missing OPENAI_API_KEY before making a request", async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      validateSpeechBubblesWithOpenAI({
        imageBytes: Buffer.from([1]),
        sourceMimeType: "image/png",
        geminiExtraction: emptyExtraction()
      })
    ).rejects.toThrow(/OPENAI_API_KEY/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts image and Gemini JSON to the Responses API and normalizes corrected JSON", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_VALIDATION_MODEL = "gpt-test-validation";
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
          speechBubbles: [
            {
              id: "bubble-001",
              text: "Hello",
              language: "en",
              bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
              readingOrder: 1,
              confidence: 0.88,
              notes: ""
            }
          ],
          nonSpeechText: [
            {
              type: "sound_effect",
              text: "ドン",
              bbox: { x: 0.8, y: 0.1, width: 0.1, height: 0.1 },
              confidence: 0.9
            }
          ],
          warnings: ["Possible missing bubble near x=0.4,y=0.5"]
        })
      })
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await validateSpeechBubblesWithOpenAI({
      imageBytes: Buffer.from([1, 2, 3]),
      sourceMimeType: "image/jpeg",
      geminiExtraction
    });

    expect(result.nonSpeechText[0]?.type).toBe("sound_effect");
    expect(result.warnings).toEqual(["Possible missing bubble near x=0.4,y=0.5"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-openai-key"
        },
        body: expect.any(String)
      })
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      input: Array<{ content: Array<{ type: string; text?: string; image_url?: string }> }>;
      text: { format: { type: string } };
    };
    expect(requestBody.model).toBe("gpt-test-validation");
    expect(requestBody.text.format.type).toBe("json_object");
    expect(requestBody.input[0]?.content[0]?.text).toContain("Gemini JSON extraction");
    expect(requestBody.input[0]?.content[0]?.text).toContain('"Hello"');
    expect(requestBody.input[0]?.content[0]?.text).toContain("Move narration_box and caption_time_place to nonSpeechText");
    expect(requestBody.input[0]?.content[0]?.text).toContain("sound_effect");
    expect(requestBody.input[0]?.content[0]?.text).toContain("[?]");
    expect(requestBody.input[0]?.content[0]?.text).toContain("speakerCandidates");
    expect(requestBody.input[0]?.content[0]?.text).toContain("Do not decide or finalize the speaker");
    expect(requestBody.input[0]?.content[0]?.text).toContain("tail direction");
    expect(requestBody.input[0]?.content[1]).toEqual({
      type: "input_image",
      image_url: `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString("base64")}`
    });
  });

  it("can read text from Responses output message content", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: '{"pageNumber":1,"speechBubbles":[],"nonSpeechText":[],"warnings":[]}'
              }
            ]
          }
        ]
      })
    }) as unknown as typeof fetch;

    await expect(
      validateSpeechBubblesWithOpenAI({
        imageBytes: Buffer.from([1]),
        sourceMimeType: "image/webp",
        geminiExtraction: emptyExtraction()
      })
    ).resolves.toEqual({ pageNumber: 1, speechBubbles: [], nonSpeechText: [], warnings: [] });
  });
});

function emptyExtraction(): SpeechBubbleExtractionResult {
  return {
    pageNumber: 1,
    speechBubbles: [],
    nonSpeechText: [],
    warnings: []
  };
}
