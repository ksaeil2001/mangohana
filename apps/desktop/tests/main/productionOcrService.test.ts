import { describe, expect, it, vi } from "vitest";
import {
  createProductionOcrService,
  ProductionOcrUnavailableError
} from "../../src/main/productionOcrService.js";
import { PRODUCTION_OCR_CONTRACT } from "../../src/shared/productionOcr.js";
import type { PipelineResourceLockV1 } from "../../src/shared/pipelineResources.js";

const lock: PipelineResourceLockV1 = {
  schemaVersion: 1,
  appVersion: "0.1.4",
  pipelineVersion: "1.0.0",
  resources: [{
    role: "ocr_production",
    resourceId: "trio-production-ocr-win32-x64",
    version: "1.0.0",
    manifestSha256: "a".repeat(64),
    distribution: "download",
    download: {
      archiveUrl: "https://example.com/ocr.zip",
      manifestUrl: "https://example.com/manifest.json",
      signatureUrl: "https://example.com/manifest.p7s"
    },
    requiredFor: ["ocr"]
  }]
};

describe("Production OCR service", () => {
  it("fails closed on unsupported platforms without constructing a runtime", async () => {
    const createRuntime = vi.fn();
    const service = createProductionOcrService({
      resourcesPath: "C:\\Program Files\\Trio\\resources",
      initialResourceRoot: "C:\\TrioData\\resources",
      platform: "linux",
      arch: "x64",
      createRuntime
    });

    await expect(service.execute({
      imageBytes: Buffer.from("image"),
      pageNumber: 1
    })).rejects.toBeInstanceOf(ProductionOcrUnavailableError);
    expect((await service.getStatus()).disabledReason).toContain("Windows x64");
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("uses only the fixed signed resource binding and one Production runtime", async () => {
    const execute = vi.fn().mockResolvedValue({
      pageNumber: 1,
      speechBubbles: [],
      nonSpeechText: [],
      warnings: []
    });
    const probe = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const preflight = vi.fn(async (options) => {
      expect(options.requiredRoles).toEqual(["ocr_production"]);
      const binding = {
        role: "ocr_production" as const,
        resourceId: "trio-production-ocr-win32-x64",
        version: "1.0.0",
        distribution: "download" as const,
        absolutePath: "C:\\TrioData\\resources\\pipeline-resources\\trio-production-ocr-win32-x64\\1.0.0"
      };
      await options.probes.ocr_production?.(binding);
      return [binding];
    });
    const service = createProductionOcrService({
      resourcesPath: "C:\\Program Files\\Trio\\resources",
      initialResourceRoot: "C:\\TrioData\\resources",
      platform: "win32",
      arch: "x64",
      loadConfiguration: async () => ({
        lock,
        publisherAllowlist: { current: "b".repeat(64) }
      }),
      preflight,
      probeResource: async (binding) => ({
        packRoot: binding.absolutePath,
        pythonExecutable: `${binding.absolutePath}\\runtime\\python.exe`,
        sidecarEntrypoint: `${binding.absolutePath}\\sidecar\\trio_ocr_sidecar.py`
      }),
      createRuntime: () => ({ execute, probe, close })
    });

    const result = await service.execute({ imageBytes: Buffer.from("image"), pageNumber: 1 });

    expect(result.pageNumber).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect((await service.getStatus()).ready).toBe(true);
    expect(PRODUCTION_OCR_CONTRACT.resourceRole).toBe("ocr_production");
  });

  it("installs only the lock-owned Production OCR pack and never accepts a renderer URL", async () => {
    const install = vi.fn().mockResolvedValue({ installed: true });
    const service = createProductionOcrService({
      resourcesPath: "C:\\Program Files\\Trio\\resources",
      initialResourceRoot: "C:\\TrioData\\resources",
      platform: "win32",
      arch: "x64",
      loadConfiguration: async () => ({
        lock,
        publisherAllowlist: { current: "b".repeat(64) }
      }),
      install,
      preflight: vi.fn().mockRejectedValue(new Error("pack remains unavailable"))
    });

    await expect(service.installOrRepair()).rejects.toBeInstanceOf(ProductionOcrUnavailableError);
    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: "trio-production-ocr-win32-x64",
      resourceStoreRoot: "C:\\TrioData\\resources\\pipeline-resources",
      lock,
      publisherAllowlist: { current: "B".repeat(64) }
    }));
    expect(Object.keys(install.mock.calls[0]![0])).not.toContain("archiveUrl");
  });

  it("reports missing Production deployment metadata as BLOCKED instead of falling back", async () => {
    const service = createProductionOcrService({
      resourcesPath: "C:\\missing",
      initialResourceRoot: "C:\\TrioData\\resources",
      platform: "win32",
      arch: "x64"
    });

    const status = await service.getStatus();
    expect(status.ready).toBe(false);
    expect(status.state).toBe("blocked");
    expect(status.disabledReason).toContain("Production OCR 배포 메타데이터");
  });
});
