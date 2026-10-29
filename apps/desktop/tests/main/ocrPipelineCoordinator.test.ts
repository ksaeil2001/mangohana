import { describe, expect, it, vi } from "vitest";
import { OcrPipelineCoordinator } from "../../src/main/ocr/pipeline/ocrPipelineCoordinator.js";
import type { SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction.js";

describe("OcrPipelineCoordinator (JMTrans Decoupled Architecture)", () => {
  it("initializes without errors and creates runners", () => {
    const coordinator = new OcrPipelineCoordinator({
      mangaEndpoint: "http://localhost:5000/ocr",
      paddleEndpoint: "http://localhost:5001/ocr"
    });
    expect(coordinator).toBeDefined();
  });

  it("handles fallback to Gemini when requested", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    try {
      const coordinator = new OcrPipelineCoordinator();
      // In test environment without GEMINI_API_KEY, should fail soft or throw standard error
      await expect(
        coordinator.execute({
          imageBytes: Buffer.from("fake-png"),
          pageNumber: 1,
          engine: "gemini"
        })
      ).rejects.toThrow("GEMINI_API_KEY");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("executes paddle-ocr standalone route using paddleEndpoint", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: any) => {
      expect(url).toBe("http://localhost:5001/ocr");
      const body = JSON.parse(init.body);
      expect(body.pageNumber).toBe(1);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            pageNumber: 1,
            speechBubbles: [
              {
                id: "b1",
                text: "PaddleOCR 텍스트",
                bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
              }
            ],
            nonSpeechText: []
          }),
          { status: 200 }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const coordinator = new OcrPipelineCoordinator({
      paddleEndpoint: "http://localhost:5001/ocr"
    });

    const result = await coordinator.execute({
      imageBytes: Buffer.from("fake-image"),
      pageNumber: 1,
      engine: "paddle-ocr",
      paddleEndpoint: "http://localhost:5001/ocr"
    });

    expect(result.speechBubbles).toHaveLength(1);
    expect(result.speechBubbles[0].text).toBe("PaddleOCR 텍스트");
    vi.unstubAllGlobals();
  });

  it("fails clearly without falling back to Gemini when paddle-ocr server fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const coordinator = new OcrPipelineCoordinator();
    await expect(
      coordinator.execute({
        imageBytes: Buffer.from("fake-image"),
        pageNumber: 1,
        engine: "paddle-ocr"
      })
    ).rejects.toThrow("PaddleOCR 로컬 서버 응답 실패");
    vi.unstubAllGlobals();
  });

  it("hybrid mode crops bubble bbox to PNG and passes cropped bytes to PaddleOCR runner", async () => {
    const croppedBuffer = Buffer.from("cropped-sub-image");
    const cropImageMock = vi.fn().mockReturnValue(croppedBuffer);

    const fetchMock = vi.fn().mockImplementation((url: string, init?: any) => {
      // 1. Manga-OCR or Gemini base extraction call
      if (url === "http://localhost:5000/ocr") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              pageNumber: 1,
              speechBubbles: [
                {
                  id: "b1",
                  text: "こんにちは",
                  bbox: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
                  readingOrder: 1
                }
              ],
              nonSpeechText: []
            }),
            { status: 200 }
          )
        );
      }
      // 2. PaddleOCR crop recognition call
      if (url === "http://localhost:5001/ocr") {
        const body = JSON.parse(init.body);
        // Verify PaddleOCR received the cropped sub-image base64, not the full page image!
        expect(body.image).toBe(croppedBuffer.toString("base64"));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              text: "こんにちは!",
              confidence: 0.95
            }),
            { status: 200 }
          )
        );
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const coordinator = new OcrPipelineCoordinator({
      mangaEndpoint: "http://localhost:5000/ocr",
      paddleEndpoint: "http://localhost:5001/ocr",
      cropImage: cropImageMock
    });

    const result = await coordinator.execute({
      imageBytes: Buffer.from("full-page-image"),
      pageNumber: 1,
      engine: "hybrid",
      ocrEndpoint: "http://localhost:5000/ocr"
    });

    expect(cropImageMock).toHaveBeenCalledWith({
      imageBytes: Buffer.from("full-page-image"),
      bbox: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
      paddingRatio: 0.08
    });
    expect(result.speechBubbles).toHaveLength(1);
    expect(result.speechBubbles[0].isCrossValidated).toBe(true);

    vi.unstubAllGlobals();
  });

  it("skips cross-validation and does not fallback to full page image when cropImage throws", async () => {
    const cropImageMock = vi.fn().mockImplementation(() => {
      throw new Error("Crop geometry invalid");
    });

    const paddleFetchMock = vi.fn();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "http://localhost:5000/ocr") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              pageNumber: 1,
              speechBubbles: [
                {
                  id: "b_crop_fail",
                  text: "원래 텍스트",
                  bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
                  readingOrder: 1
                }
              ],
              nonSpeechText: []
            }),
            { status: 200 }
          )
        );
      }
      if (url === "http://localhost:5001/ocr") {
        paddleFetchMock();
        return Promise.resolve(
          new Response(JSON.stringify({ text: "wrong text", confidence: 0.99 }), { status: 200 })
        );
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const coordinator = new OcrPipelineCoordinator({
      mangaEndpoint: "http://localhost:5000/ocr",
      paddleEndpoint: "http://localhost:5001/ocr",
      cropImage: cropImageMock
    });

    const result = await coordinator.execute({
      imageBytes: Buffer.from("full-page-image"),
      pageNumber: 1,
      engine: "hybrid",
      ocrEndpoint: "http://localhost:5000/ocr"
    });

    expect(cropImageMock).toHaveBeenCalled();
    // PaddleOCR should NOT have been called because crop failed!
    expect(paddleFetchMock).not.toHaveBeenCalled();
    expect(result.speechBubbles).toHaveLength(1);
    expect(result.speechBubbles[0].isCrossValidated).toBe(false);
    expect(result.speechBubbles[0].text).toBe("원래 텍스트");
    expect(result.speechBubbles[0].notes).toContain("교차 검증 생략: 말풍선 영역(bbox) 크롭 실패");

    vi.unstubAllGlobals();
  });
});
