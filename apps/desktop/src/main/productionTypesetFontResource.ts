import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  InstalledTypesetFontResourceVerifier
} from "./projectImageExport.js";
import {
  preflightPipelineResources,
  type ResourcePlatformProbe,
  type ResourcePreflightOptions,
  type ResourceBindingV1
} from "./resourcePreflight.js";
import {
  normalizeCmsPublisherAllowlist,
  type CmsPublisherAllowlist
} from "./cmsSignatureVerifier.js";
import {
  parsePipelineResourceLockV1,
  parseResourcePackManifestV1,
  type PipelineResourceLockV1
} from "../shared/pipelineResources.js";
import {
  PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY,
  PRODUCTION_TYPESET_FONT_URL
} from "../shared/productionTypesetFontResource.js";

const productionTypesetFontResourceId = "pretendard-ko-fallback";
const productionTypesetFontRole = "font_ko_fallback" as const;
const productionTypesetFontVersion = "1.3.9";
const productionPipelineVersion = "1.0.0";
const productionPipelineResourcesDirectory = "pipeline-resources";
const productionResourcePackLocation =
  "pretendard-ko-fallback/1.3.9";
const productionLockFileName = "pipeline-resource-lock.json";
const productionAllowlistFileName = "font-publisher-allowlist.json";
const productionFontFileName = "PretendardVariable.ttf";

export type ProductionTypesetFontProtocolRequest = Readonly<{
  url: string;
}>;

export type ProductionTypesetFontProtocolHandler = (
  request: ProductionTypesetFontProtocolRequest
) => Promise<Response>;

export type ProductionTypesetFontResource = Readonly<{
  enabled: boolean;
  verifyInstalledTypesetFontResource: InstalledTypesetFontResourceVerifier;
  handleProtocolRequest: ProductionTypesetFontProtocolHandler;
}>;

export type ProductionTypesetFontResourceInitializationOptions = Readonly<{
  /** Test-only seam; production always uses the authoritative preflight. */
  preflight?: typeof preflightPipelineResources;
  /** Test-only seam for asserting generic policy warnings. */
  warn?: (message: string) => void;
}>;

/**
 * Load and verify the fixed bundled Pretendard resource from Main-owned
 * packaged resources. Any policy failure returns a disabled state so app
 * startup and non-typesetting exports remain available.
 */
export async function initializeProductionTypesetFontResource(
  resourcesPath: string,
  options: ProductionTypesetFontResourceInitializationOptions = {}
): Promise<ProductionTypesetFontResource> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let approvedFontBytes: Buffer | undefined;

  try {
    const packagedRoot = validateResourcesPath(resourcesPath);
    const pipelineRoot = resolve(packagedRoot, productionPipelineResourcesDirectory);
    const lock = await readPipelineLock(
      join(pipelineRoot, productionLockFileName)
    );
    const publisherAllowlist = await readPublisherAllowlist(
      join(pipelineRoot, productionAllowlistFileName)
    );
    const entry = getFixedFontLockEntry(lock);
    const expectedPackRoot = resolve(
      pipelineRoot,
      ...productionResourcePackLocation.split("/")
    );
    const probe: ResourcePlatformProbe = async (binding) => {
      assertFixedFontBinding(binding, expectedPackRoot);
      approvedFontBytes = await probeFontFile(binding.absolutePath, entry.manifestSha256);
    };
    const preflight = options.preflight ?? preflightPipelineResources;
    const preflightOptions: ResourcePreflightOptions = {
      lock,
      requiredRoles: [productionTypesetFontRole],
      trustedRoots: {
        // The required entry is bundled, so this root is never used to find a
        // pack. It remains fixed and Main-owned to satisfy the shared API.
        userDataRoot: packagedRoot,
        bundledResourceRoot: pipelineRoot,
        bundledLocations: {
          [productionTypesetFontRole]: productionResourcePackLocation
        }
      },
      publisherAllowlist,
      probes: { [productionTypesetFontRole]: probe }
    };
    const bindings = await preflight(preflightOptions);
    const binding = bindings.find(
      (candidate) => candidate.role === productionTypesetFontRole
    );
    if (!binding || !approvedFontBytes) {
      throw new Error("Production font preflight did not approve a font");
    }
    if (
      entry.resourceId !== productionTypesetFontResourceId
      || entry.version !== productionTypesetFontVersion
      || entry.distribution !== "bundled"
      || lock.pipelineVersion !== productionPipelineVersion
    ) {
      throw new Error("Production font lock coordinates are not fixed");
    }

    return createEnabledResource(Buffer.from(approvedFontBytes));
  } catch {
    warn(
      "Trio production typeset font resource is unavailable; typeset evidence is disabled."
    );
    return createDisabledResource();
  }
}

/** Alias kept for Main callers that prefer factory terminology. */
export const createProductionTypesetFontResource =
  initializeProductionTypesetFontResource;

function createEnabledResource(fontBytes: Buffer): ProductionTypesetFontResource {
  const immutableFontBytes = Uint8Array.from(fontBytes);
  return Object.freeze({
    enabled: true,
    verifyInstalledTypesetFontResource: async (identity: string) =>
      identity === PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY,
    handleProtocolRequest: createProtocolHandler(immutableFontBytes)
  });
}

function createDisabledResource(): ProductionTypesetFontResource {
  return Object.freeze({
    enabled: false,
    verifyInstalledTypesetFontResource: async () => false,
    handleProtocolRequest: async () => notFoundResponse()
  });
}

function createProtocolHandler(
  fontBytes: Uint8Array
): ProductionTypesetFontProtocolHandler {
  return async (request) => {
    if (request.url !== PRODUCTION_TYPESET_FONT_URL) {
      return notFoundResponse();
    }
    return new Response(Uint8Array.from(fontBytes), {
      headers: {
        "cache-control": "no-store",
        "content-type": "font/ttf"
      }
    });
  };
}

function notFoundResponse(): Response {
  return new Response(null, { status: 404 });
}

async function readPipelineLock(filePath: string): Promise<PipelineResourceLockV1> {
  const value = await readJson(filePath);
  return parsePipelineResourceLockV1(value);
}

async function readPublisherAllowlist(
  filePath: string
): Promise<Readonly<CmsPublisherAllowlist>> {
  const value = await readJson(filePath);
  return normalizeCmsPublisherAllowlist(value as CmsPublisherAllowlist);
}

async function readJson(filePath: string): Promise<unknown> {
  const bytes = await readFile(filePath);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function getFixedFontLockEntry(
  lock: PipelineResourceLockV1
): PipelineResourceLockV1["resources"][number] {
  const entry = lock.resources.find(
    (candidate) => candidate.role === productionTypesetFontRole
  );
  if (
    !entry
    || entry.resourceId !== productionTypesetFontResourceId
    || entry.version !== productionTypesetFontVersion
    || entry.distribution !== "bundled"
    || !entry.requiredFor.includes("typeset")
    || lock.pipelineVersion !== productionPipelineVersion
  ) {
    throw new Error("Production font lock does not match the fixed contract");
  }
  return entry;
}

function assertFixedFontBinding(
  binding: ResourceBindingV1,
  expectedPackRoot: string
): void {
  if (
    binding.role !== productionTypesetFontRole
    || binding.resourceId !== productionTypesetFontResourceId
    || binding.version !== productionTypesetFontVersion
    || binding.distribution !== "bundled"
    || !pathsAreEqual(binding.absolutePath, expectedPackRoot)
  ) {
    throw new Error("Production font binding does not match the fixed contract");
  }
}

async function probeFontFile(packRoot: string, manifestSha256: string): Promise<Buffer> {
  // Bind the exact bytes we will serve to the manifest approved by preflight.
  // The file can change after preflight's streaming hash and before this read.
  const manifestBytes = await readFile(join(packRoot, "resource-manifest.json"));
  if (createHash("sha256").update(manifestBytes).digest("hex") !== manifestSha256) {
    throw new Error("Production font manifest changed after verification");
  }
  const manifest = parseResourcePackManifestV1(JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)
  ));
  const fontEntry = manifest.files.find((file) => file.relativePath === productionFontFileName);
  if (!fontEntry) throw new Error("Production font is absent from the approved manifest");
  const fontPath = resolve(packRoot, productionFontFileName);
  const pathFromPack = relative(packRoot, fontPath);
  if (
    pathFromPack !== productionFontFileName
    || isAbsolute(pathFromPack)
    || pathFromPack.startsWith(`..${sep}`)
  ) {
    throw new Error("Production font path is outside the approved pack");
  }

  const metadata = await lstat(fontPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Production font file is not regular");
  }
  const canonicalPath = await realpath(fontPath);
  if (!pathsAreEqual(canonicalPath, fontPath)) {
    throw new Error("Production font file is not canonical");
  }
  const bytes = await readFile(fontPath);
  if (
    bytes.byteLength !== fontEntry.byteSize
    || createHash("sha256").update(bytes).digest("hex") !== fontEntry.sha256
  ) {
    throw new Error("Production font bytes changed after verification");
  }
  if (bytes.length < 4 || !hasSupportedFontSignature(bytes)) {
    throw new Error("Production font signature is unsupported");
  }
  return bytes;
}

function hasSupportedFontSignature(bytes: Uint8Array): boolean {
  if (
    bytes[0] === 0x00
    && bytes[1] === 0x01
    && bytes[2] === 0x00
    && bytes[3] === 0x00
  ) {
    return true;
  }
  const signature = String.fromCharCode(
    bytes[0]!,
    bytes[1]!,
    bytes[2]!,
    bytes[3]!
  );
  return signature === "OTTO" || signature === "true" || signature === "typ1";
}

function validateResourcesPath(resourcesPath: string): string {
  if (
    typeof resourcesPath !== "string"
    || resourcesPath.length === 0
    || !isAbsolute(resourcesPath)
    || !pathsAreEqual(resolve(resourcesPath), resourcesPath)
  ) {
    throw new Error("Invalid packaged resources path");
  }
  return resourcesPath;
}

function pathsAreEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}
