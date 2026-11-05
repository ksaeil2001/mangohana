import { describe, expect, it, vi } from "vitest";
import {
  createProductionOcrService,
  ProductionOcrUnavailableError
} from "../../src/main/productionOcrService.js";
import { PRODUCTION_OCR_CONTRACT } from "../../src/shared/productionOcr.js";
import type { PipelineResourceLockV1 } from "../../src/shared/pipelineResources.js";
import { parseProductionOcrDetections } from "../../src/main/ocr/detection/productionDetectorParser.js";
import { ProductionOcrSidecarClient } from "../../src/main/ocr/runtime/productionOcrSidecarClient.js";
import * as mangaRuntime from "../../src/main/ocr/runtime/mangaOcrRuntime.js";
import { MANGA_OCR_MODELS } from "../../src/shared/productionOcr.js";

const imageMocks = vi.hoisted(() => ({ decode: vi.fn() }));
vi.mock("electron", () => ({ nativeImage: { createFromBuffer: imageMocks.decode } }));

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
  function preparedOptions() {
    const binding = { role: "ocr_production" as const, resourceId: "trio-production-ocr-win32-x64", version: "1.0.0", distribution: "download" as const, absolutePath: "C:\\fake\\verified-pack" };
    return {
      resourcesPath: "C:\\fake\\app-resources", initialResourceRoot: "C:\\fake\\resources",
      platform: "win32" as const, arch: "x64",
      loadConfiguration: async () => ({ lock, publisherAllowlist: { current: "b".repeat(64) } }),
      preflight: async (options: Parameters<NonNullable<Parameters<typeof createProductionOcrService>[0]["preflight"]>>[0]) => {
        await options.probes.ocr_production?.(binding); return [binding];
      },
      probeResource: async () => ({ packRoot: binding.absolutePath, pythonExecutable: "C:\\fake\\python.exe", sidecarEntrypoint: "C:\\fake\\sidecar.py" })
    };
  }

  it("closes an instance whose probe failed and constructs a fresh instance on retry", async () => {
    const first = { probe: vi.fn().mockRejectedValue(new Error("initialization failed")), execute: vi.fn(), close: vi.fn() };
    const second = { probe: vi.fn().mockResolvedValue(undefined), execute: vi.fn(), close: vi.fn() };
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const service = createProductionOcrService({ ...preparedOptions(), createRuntime: factory });
    expect((await service.getStatus()).ready).toBe(false);
    expect(first.close).toHaveBeenCalledOnce();
    expect((await service.getStatus()).ready).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
    service.close();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("does not adopt a late probe result after closing its generation", async () => {
    let finish!: () => void;
    const probe = vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const runtime = { probe, execute:vi.fn(), close:vi.fn() };
    const service=createProductionOcrService({...preparedOptions(),createRuntime:()=>runtime});
    const preparing=service.getStatus();
    await vi.waitFor(()=>expect(probe).toHaveBeenCalledOnce());
    service.close(); finish();
    expect((await preparing).ready).toBe(false);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("immediately closes the old preparation and does not publish its failure over a new ready root", async () => {
    let finish!:()=>void;
    const first={probe:vi.fn((_signal?:AbortSignal)=>new Promise<void>(resolve=>{finish=resolve;})),execute:vi.fn(),close:vi.fn()};
    const second={probe:vi.fn().mockResolvedValue(undefined),execute:vi.fn().mockResolvedValue({pageNumber:1,speechBubbles:[],nonSpeechText:[],warnings:[]}),close:vi.fn()};
    const factory=vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const service=createProductionOcrService({...preparedOptions(),createRuntime:factory});
    const oldStatus=service.getStatus();
    await vi.waitFor(()=>expect(first.probe).toHaveBeenCalledOnce());
    expect((await service.setResourceRoot("C:\\fake\\other-root")).ready).toBe(true);
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.probe.mock.calls[0]?.[0]?.aborted).toBe(true);
    finish();
    expect((await oldStatus).ready).toBe(true);
    expect((await service.getStatus()).ready).toBe(true);
    await service.execute({imageBytes:Buffer.from("synthetic image"),pageNumber:1});
    expect(second.execute).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
    service.close();
  });

  it("selects the server-owned Manga/Hayai path and preserves the actual recognition identity", async () => {
    const source=Buffer.from("synthetic source page");
    imageMocks.decode.mockReturnValue({getSize:()=>({width:100,height:100}),crop:()=>({toPNG:()=>Buffer.from("synthetic OCR crop")})});
    const probe=vi.spyOn(ProductionOcrSidecarClient.prototype,"probe").mockResolvedValue(undefined);
    const detect=vi.spyOn(ProductionOcrSidecarClient.prototype,"detect").mockResolvedValue(parseProductionOcrDetections({detections:[{detectionId:"pp",quad:[[10,10],[30,10],[30,70],[10,70]],score:.9}]},100,100));
    const legacy=vi.spyOn(ProductionOcrSidecarClient.prototype,"recognizeGroup");
    const manga={probe:vi.fn().mockResolvedValue(undefined),detector:{detect:vi.fn().mockResolvedValue([])},textVerifier:{verify:vi.fn().mockResolvedValue({accepted:true})},recognizer:{recognizeGroup:vi.fn().mockResolvedValue({text:"合成テスト"})},close:vi.fn()};
    const factory=vi.spyOn(mangaRuntime,"createMangaOcrRuntime").mockReturnValue(manga);
    const service=createProductionOcrService({...preparedOptions(),mangaOcr:{assetsRoot:"C:\\fake\\assets",detectorModelPath:"C:\\fake\\detector.onnx"}});
    try {
      const result=await service.execute({imageBytes:source,pageNumber:1});
      expect(result.speechBubbles).toHaveLength(1);
      expect(result.speechBubbles[0]!.productionOcrProvenance).toMatchObject({recognizerModelId:MANGA_OCR_MODELS.recognizer.modelId,recognizerRevision:MANGA_OCR_MODELS.recognizer.revision});
      expect(manga.recognizer.recognizeGroup).toHaveBeenCalledOnce();
      expect(legacy).not.toHaveBeenCalled();
      expect(factory.mock.calls[0]![1].resourcesPath).toBe("C:\\fake\\app-resources");
    } finally { service.close(); factory.mockRestore();probe.mockRestore();detect.mockRestore();legacy.mockRestore(); }
    expect(manga.close).toHaveBeenCalledOnce();
  });
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

  it("uses detail detection in the default runtime while retaining the verified client for recognition", async () => {
    const source = Buffer.from("source-page");
    const sourceSnapshot = Buffer.from(source);
    imageMocks.decode.mockReturnValue({
      getSize: () => ({ width: 2598, height: 3626 }),
      crop: (rect: unknown) => ({ toPNG: () => Buffer.from(JSON.stringify(rect)) })
    });
    const probe = vi.spyOn(ProductionOcrSidecarClient.prototype, "probe").mockResolvedValue(undefined);
    const detect = vi.spyOn(ProductionOcrSidecarClient.prototype, "detect").mockImplementation(async ({ imageBytes }) => {
      if (imageBytes === source) return [];
      const rect = JSON.parse(imageBytes.toString());
      return parseProductionOcrDetections({ detections: rect.x === 1000 && rect.y === 1000 ? [{
        detectionId: "det-0001", quad: [[100, 100], [130, 100], [130, 220], [100, 220]], score: 0.8
      }] : [] }, rect.width, rect.height);
    });
    const recognize = vi.spyOn(ProductionOcrSidecarClient.prototype, "recognizeGroup").mockResolvedValue({ text: "は？" });
    const binding = {
      role: "ocr_production" as const,
      resourceId: "trio-production-ocr-win32-x64",
      version: "1.0.0",
      distribution: "download" as const,
      absolutePath: "C:\\TrioData\\resources\\pipeline-resources\\trio-production-ocr-win32-x64\\1.0.0"
    };
    const service = createProductionOcrService({
      resourcesPath: "C:\\Program Files\\Trio\\resources",
      initialResourceRoot: "C:\\TrioData\\resources",
      platform: "win32", arch: "x64",
      loadConfiguration: async () => ({ lock, publisherAllowlist: { current: "b".repeat(64) } }),
      preflight: async (options) => { await options.probes.ocr_production?.(binding); return [binding]; },
      probeResource: async () => ({ packRoot: binding.absolutePath, pythonExecutable: "C:\\fake\\python.exe", sidecarEntrypoint: "C:\\fake\\sidecar.py" })
    });
    try {
      const result = await service.execute({ imageBytes: source, pageNumber: 18 });
      expect(probe).toHaveBeenCalledOnce();
      expect(detect.mock.calls.length).toBeGreaterThan(1);
      expect(recognize).toHaveBeenCalledOnce();
      expect(result.speechBubbles).toHaveLength(1);
      expect(result.speechBubbles[0]).toMatchObject({
        text: "は?",
        productionOcrProvenance: {
          detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision,
          sourceQuadsPx: [[{ x: 1100, y: 1100 }, { x: 1130, y: 1100 }, { x: 1130, y: 1220 }, { x: 1100, y: 1220 }]],
          cropTransform: { imageWidth: 2598, imageHeight: 3626 }
        }
      });
      expect(result.warnings).toEqual([]);
      expect(source).toEqual(sourceSnapshot);
    } finally {
      service.close();
      probe.mockRestore(); detect.mockRestore(); recognize.mockRestore();
    }
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
