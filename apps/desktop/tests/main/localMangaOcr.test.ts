import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { extractSpeechBubblesWithLocalOcr } from "../../src/main/localMangaOcr.js";

describe("localMangaOcr", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends image to Manga-OCR server and formats extraction result", async () => {
    let requestBody: any;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          speechBubbles: [
            {
              id: "bubble-1",
              type: "speech_bubble",
              text: "お前を信じる！",
              language: "ja",
              bbox: { x: 10, y: 10, width: 80, height: 100 },
              readingOrder: 1,
              confidence: 0.95,
              notes: "",
              speakerCandidates: []
            }
          ],
          nonSpeechText: [],
          warnings: []
        })
      };
    });

    const imageBytes = Buffer.from("manga-page");
    const result = await extractSpeechBubblesWithLocalOcr({
      imageBytes,
      pageNumber: 1
    });

    expect(result.pageNumber).toBe(1);
    expect(result.speechBubbles).toHaveLength(1);
    expect(result.speechBubbles[0]?.text).toBe("お前を信じる！");
    expect(requestBody.pageNumber).toBe(1);
    expect(requestBody.image).toBe(imageBytes.toString("base64"));
  });

  it("handles OCR server error gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error"
    } as Response);

    await expect(
      extractSpeechBubblesWithLocalOcr({
        imageBytes: Buffer.from("image"),
        pageNumber: 1
      })
    ).rejects.toThrow(/Manga-OCR 로컬 서버 응답 실패/);
  });

  it("honors parent cancellation without converting it to a timeout", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("canceled", "AbortError")), { once: true });
    }));

    const pending = extractSpeechBubblesWithLocalOcr({
      imageBytes: Buffer.from("image"),
      pageNumber: 1,
      signal: controller.signal
    });
    controller.abort(new DOMException("manual cancel", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
