import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvironmentPreparationService } from "../../src/main/environmentPreparation";

describe("environment preparation service", () => {
  it("owns the resource root outside the project storage schema", async () => {
    const initialResourceRoot = join(tmpdir(), "trio-test", "resources");
    const movedResourceRoot = join(tmpdir(), "trio-test-moved", "resources");
    const service = createEnvironmentPreparationService({
      resourceRoot: initialResourceRoot,
      appVersion: "0.1.0"
    });

    const initialSnapshot = await service.getSnapshot();
    expect(initialSnapshot.resourceRoot).toBe(initialResourceRoot);

    const moved = await service.setResourceRoot(movedResourceRoot);

    expect(moved.resourceRoot).toBe(movedResourceRoot);
    expect(moved.components).toEqual((await service.getSnapshot()).components);
  });

  it("delegates to getProviderStatus to produce distinct provider readiness", async () => {
    let mockGeminiKey = false;
    let mockOpenAiKey = true;

    const service = createEnvironmentPreparationService({
      resourceRoot: join(tmpdir(), "trio-test", "resources"),
      appVersion: "0.1.0",
      getProviderStatus: async () => ({
        ocrReady: mockGeminiKey,
        translationReady: mockGeminiKey,
        inpaintingReady: mockGeminiKey || mockOpenAiKey,
        inpaintingMessage: "OpenAI 인페인팅 엔진이 준비되었습니다."
      })
    });

    let snapshot = await service.getSnapshot();
    const inpaintingComp = snapshot.components.find((c) => c.id === "inpainting");
    const ocrComp = snapshot.components.find((c) => c.id === "ocr");

    expect(inpaintingComp?.status).toBe("ready");
    expect(inpaintingComp?.message).toBe("OpenAI 인페인팅 엔진이 준비되었습니다.");
    expect(ocrComp?.status).toBe("blocked");

    mockGeminiKey = true;
    snapshot = await service.getSnapshot();
    expect(snapshot.components.find((c) => c.id === "ocr")?.status).toBe("ready");
  });
});
