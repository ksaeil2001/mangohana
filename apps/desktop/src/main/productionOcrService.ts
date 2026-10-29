import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { CmsPublisherAllowlist } from "./cmsSignatureVerifier.js";
import { normalizeCmsPublisherAllowlist } from "./cmsSignatureVerifier.js";
import { cropProductionOcrGroup } from "./imageCrop.js";
import { ProductionOcrPipeline } from "./ocr/pipeline/productionOcrPipeline.js";
import {
  probeProductionOcrResource,
  type ProductionOcrRuntimeBinding
} from "./ocr/runtime/productionOcrResource.js";
import { ProductionOcrSidecarClient } from "./ocr/runtime/productionOcrSidecarClient.js";
import { ProductionOcrSidecarTransport } from "./ocr/runtime/productionOcrSidecarTransport.js";
import {
  installResourcePack,
  type ResourcePackInstallOptions
} from "./resourcePackInstaller.js";
import {
  preflightPipelineResources,
  type ResourceBindingV1,
  type ResourcePreflightOptions
} from "./resourcePreflight.js";
import type { SpeechBubbleExtractionResult } from "../shared/speechBubbleExtraction.js";
import {
  parsePipelineResourceLockV1,
  type PipelineResourceLockV1
} from "../shared/pipelineResources.js";

const PRODUCTION_OCR_RESOURCE_ID = "trio-production-ocr-win32-x64";
const PRODUCTION_OCR_RESOURCE_VERSION = "1.0.0";
const PRODUCTION_OCR_ROLE = "ocr_production" as const;
const PIPELINE_RESOURCES_DIRECTORY = "pipeline-resources";
const LOCK_FILE_NAME = "pipeline-resource-lock.json";
const ALLOWLIST_FILE_NAME = "ocr-publisher-allowlist.json";

export type ProductionOcrStatus = Readonly<{
  state: "ready" | "blocked";
  ready: boolean;
  message: string;
  disabledReason?: string;
  resourceVersion?: string;
}>;

export type ProductionOcrExecuteArgs = Readonly<{
  imageBytes: Buffer;
  pageNumber: number | null;
  signal?: AbortSignal;
}>;

export type ProductionOcrService = Readonly<{
  getStatus: () => Promise<ProductionOcrStatus>;
  setResourceRoot: (resourceRoot: string) => Promise<ProductionOcrStatus>;
  installOrRepair: (signal?: AbortSignal) => Promise<ProductionOcrStatus>;
  execute: (args: ProductionOcrExecuteArgs) => Promise<SpeechBubbleExtractionResult>;
  close: () => void;
}>;

type ProductionOcrRuntime = Readonly<{
  probe: (signal?: AbortSignal) => Promise<void>;
  execute: (args: ProductionOcrExecuteArgs) => Promise<SpeechBubbleExtractionResult>;
  close: () => void;
}>;

type ProductionOcrConfiguration = Readonly<{
  lock: PipelineResourceLockV1;
  publisherAllowlist: CmsPublisherAllowlist;
}>;

type ProductionOcrServiceOptions = Readonly<{
  resourcesPath: string;
  initialResourceRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  loadConfiguration?: () => Promise<ProductionOcrConfiguration>;
  preflight?: (options: ResourcePreflightOptions) => Promise<readonly ResourceBindingV1[]>;
  install?: (options: ResourcePackInstallOptions) => Promise<unknown>;
  probeResource?: (binding: ResourceBindingV1) => Promise<ProductionOcrRuntimeBinding>;
  createRuntime?: (binding: ProductionOcrRuntimeBinding) => ProductionOcrRuntime;
}>;

export class ProductionOcrUnavailableError extends Error {
  readonly code:
    | "OCR_UNSUPPORTED_PLATFORM"
    | "OCR_DEPLOYMENT_METADATA_MISSING"
    | "OCR_RESOURCE_UNAVAILABLE"
    | "OCR_INSTALL_FAILED";

  constructor(code: ProductionOcrUnavailableError["code"], message: string) {
    super(message);
    this.name = "ProductionOcrUnavailableError";
    this.code = code;
  }
}

export function createProductionOcrService(
  options: ProductionOcrServiceOptions
): ProductionOcrService {
  const resourcesPath = normalizeAbsoluteRoot(options.resourcesPath, "resourcesPath");
  let resourceRoot = normalizeAbsoluteRoot(options.initialResourceRoot, "initialResourceRoot");
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const preflight = options.preflight ?? preflightPipelineResources;
  const install = options.install ?? installResourcePack;
  const probeResource = options.probeResource ?? probeProductionOcrResource;
  const createRuntime = options.createRuntime ?? createDefaultRuntime;
  const loadConfiguration = options.loadConfiguration ?? (() =>
    loadProductionOcrConfiguration(resolve(resourcesPath, PIPELINE_RESOURCES_DIRECTORY)));

  let runtime: ProductionOcrRuntime | undefined;
  let readinessPromise: Promise<ProductionOcrRuntime> | undefined;
  let lastStatus: ProductionOcrStatus | undefined;

  function unsupportedStatus(): ProductionOcrStatus {
    const disabledReason = "Production OCR은 MVP에서 Windows x64 CPU 환경만 지원합니다.";
    return Object.freeze({
      state: "blocked",
      ready: false,
      message: disabledReason,
      disabledReason
    });
  }

  function closeRuntime(): void {
    runtime?.close();
    runtime = undefined;
    readinessPromise = undefined;
  }

  async function prepareRuntime(): Promise<ProductionOcrRuntime> {
    if (platform !== "win32" || arch !== "x64") {
      throw new ProductionOcrUnavailableError(
        "OCR_UNSUPPORTED_PLATFORM",
        unsupportedStatus().disabledReason!
      );
    }
    let configuration: ProductionOcrConfiguration;
    try {
      configuration = await loadConfiguration();
      assertFixedProductionOcrEntry(configuration.lock);
    } catch {
      throw new ProductionOcrUnavailableError(
        "OCR_DEPLOYMENT_METADATA_MISSING",
        "Production OCR 배포 메타데이터 또는 publisher allowlist가 준비되지 않았습니다."
      );
    }

    let runtimeBinding: ProductionOcrRuntimeBinding | undefined;
    try {
      await preflight({
        lock: configuration.lock,
        requiredRoles: [PRODUCTION_OCR_ROLE],
        trustedRoots: {
          userDataRoot: resourceRoot,
          bundledResourceRoot: resolve(resourcesPath, PIPELINE_RESOURCES_DIRECTORY),
          bundledLocations: {}
        },
        publisherAllowlist: normalizeCmsPublisherAllowlist(configuration.publisherAllowlist),
        probes: {
          ocr_production: async (binding) => {
            runtimeBinding = await probeResource(binding);
          }
        }
      });
      if (!runtimeBinding) throw new Error("Production OCR runtime binding is missing");
      const nextRuntime = createRuntime(runtimeBinding);
      await nextRuntime.probe();
      runtime = nextRuntime;
      lastStatus = Object.freeze({
        state: "ready",
        ready: true,
        message: "PP-OCRv6_medium_det 및 Baberu OCR CPU 런타임이 준비되었습니다.",
        resourceVersion: PRODUCTION_OCR_RESOURCE_VERSION
      });
      return nextRuntime;
    } catch (error) {
      closeRuntime();
      if (error instanceof ProductionOcrUnavailableError) throw error;
      throw new ProductionOcrUnavailableError(
        "OCR_RESOURCE_UNAVAILABLE",
        "서명 및 checksum 검증을 통과한 Production OCR 리소스 팩이 필요합니다."
      );
    }
  }

  async function ensureRuntime(): Promise<ProductionOcrRuntime> {
    if (runtime) return runtime;
    readinessPromise ??= prepareRuntime();
    try {
      return await readinessPromise;
    } finally {
      if (!runtime) readinessPromise = undefined;
    }
  }

  async function getStatus(): Promise<ProductionOcrStatus> {
    if (platform !== "win32" || arch !== "x64") {
      lastStatus = unsupportedStatus();
      return lastStatus;
    }
    if (runtime && lastStatus) return lastStatus;
    try {
      await ensureRuntime();
      return lastStatus!;
    } catch (error) {
      const unavailable = toUnavailableError(error);
      lastStatus = Object.freeze({
        state: "blocked",
        ready: false,
        message: unavailable.message,
        disabledReason: unavailable.message
      });
      return lastStatus;
    }
  }

  return Object.freeze({
    getStatus,
    setResourceRoot: async (nextResourceRoot) => {
      closeRuntime();
      resourceRoot = normalizeAbsoluteRoot(nextResourceRoot, "resourceRoot");
      lastStatus = undefined;
      return await getStatus();
    },
    installOrRepair: async (signal) => {
      if (platform !== "win32" || arch !== "x64") {
        throw new ProductionOcrUnavailableError(
          "OCR_UNSUPPORTED_PLATFORM",
          unsupportedStatus().disabledReason!
        );
      }
      let configuration: ProductionOcrConfiguration;
      try {
        configuration = await loadConfiguration();
        assertFixedProductionOcrEntry(configuration.lock);
        configuration = {
          lock: configuration.lock,
          publisherAllowlist: normalizeCmsPublisherAllowlist(configuration.publisherAllowlist)
        };
      } catch {
        throw new ProductionOcrUnavailableError(
          "OCR_DEPLOYMENT_METADATA_MISSING",
          "Production OCR 배포 메타데이터 또는 publisher allowlist가 준비되지 않았습니다."
        );
      }
      closeRuntime();
      try {
        await install({
          resourceStoreRoot: resolve(resourceRoot, PIPELINE_RESOURCES_DIRECTORY),
          lock: configuration.lock,
          resourceId: PRODUCTION_OCR_RESOURCE_ID,
          transactionId: randomUUID(),
          publisherAllowlist: configuration.publisherAllowlist,
          signal
        });
        return await getStatusAfterInstall();
      } catch (error) {
        if (error instanceof ProductionOcrUnavailableError) throw error;
        throw new ProductionOcrUnavailableError(
          "OCR_INSTALL_FAILED",
          "Production OCR 리소스 팩 설치 또는 검증에 실패했습니다."
        );
      }
    },
    execute: async (args) => {
      const approvedRuntime = await ensureRuntime();
      return await approvedRuntime.execute(args);
    },
    close: closeRuntime
  });

  async function getStatusAfterInstall(): Promise<ProductionOcrStatus> {
    try {
      await ensureRuntime();
      return lastStatus!;
    } catch (error) {
      throw toUnavailableError(error);
    }
  }
}

function createDefaultRuntime(binding: ProductionOcrRuntimeBinding): ProductionOcrRuntime {
  const transport = new ProductionOcrSidecarTransport(binding);
  const client = new ProductionOcrSidecarClient((request, signal) =>
    transport.invoke(request, signal));
  const pipeline = new ProductionOcrPipeline({
    detector: client,
    recognizer: client,
    cropGroup: cropProductionOcrGroup
  });
  return {
    probe: (signal) => client.probe(signal),
    execute: (args) => pipeline.execute(args),
    close: () => transport.close()
  };
}

async function loadProductionOcrConfiguration(
  packagedPipelineRoot: string
): Promise<ProductionOcrConfiguration> {
  const [lockBytes, allowlistBytes] = await Promise.all([
    readFile(resolve(packagedPipelineRoot, LOCK_FILE_NAME)),
    readFile(resolve(packagedPipelineRoot, ALLOWLIST_FILE_NAME))
  ]);
  return {
    lock: parsePipelineResourceLockV1(JSON.parse(lockBytes.toString("utf8"))),
    publisherAllowlist: normalizeCmsPublisherAllowlist(
      JSON.parse(allowlistBytes.toString("utf8")) as CmsPublisherAllowlist
    )
  };
}

function assertFixedProductionOcrEntry(lock: PipelineResourceLockV1): void {
  const entry = lock.resources.find((candidate) => candidate.role === PRODUCTION_OCR_ROLE);
  if (
    !entry
    || entry.resourceId !== PRODUCTION_OCR_RESOURCE_ID
    || entry.version !== PRODUCTION_OCR_RESOURCE_VERSION
    || entry.distribution !== "download"
    || !entry.download
    || !entry.requiredFor.includes("ocr")
  ) {
    throw new Error("Production OCR lock entry does not match the frozen contract");
  }
}

function normalizeAbsoluteRoot(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function toUnavailableError(error: unknown): ProductionOcrUnavailableError {
  if (error instanceof ProductionOcrUnavailableError) return error;
  return new ProductionOcrUnavailableError(
    "OCR_RESOURCE_UNAVAILABLE",
    "Production OCR 런타임을 사용할 수 없습니다."
  );
}
