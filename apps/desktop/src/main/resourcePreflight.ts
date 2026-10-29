import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  PipelineResourceDistribution,
  PipelineResourceErrorCode,
  PipelineResourceLockEntryV1,
  PipelineResourceLockV1,
  PipelineResourceRole
} from "../shared/pipelineResources.js";
import { parsePipelineResourceLockV1 } from "../shared/pipelineResources.js";
import type { CmsPublisherAllowlist } from "./cmsSignatureVerifier.js";
import { normalizeCmsPublisherAllowlist } from "./cmsSignatureVerifier.js";
import { validatePipelineRelativePath } from "./pipelinePathSecurity.js";
import {
  ResourcePackVerificationError,
  verifyInstalledResourcePack
} from "./resourcePackInstaller.js";

export type ResourceBindingV1 = Readonly<{
  role: PipelineResourceRole;
  resourceId: string;
  version: string;
  distribution: PipelineResourceDistribution;
  absolutePath: string;
}>;

export type ResourcePlatformProbe = (
  binding: ResourceBindingV1
) => Promise<void>;

export type ResourcePreflightTrustedRoots = Readonly<{
  userDataRoot: string;
  bundledResourceRoot: string;
  bundledLocations: Readonly<
    Partial<Record<PipelineResourceRole, string>>
  >;
}>;

export type ResourcePreflightOptions = Readonly<{
  lock: Readonly<PipelineResourceLockV1>;
  requiredRoles: readonly PipelineResourceRole[];
  trustedRoots: ResourcePreflightTrustedRoots;
  publisherAllowlist: CmsPublisherAllowlist;
  probes: Readonly<Partial<Record<PipelineResourceRole, ResourcePlatformProbe>>>;
}>;

export class ResourcePreflightError extends Error {
  readonly code: Extract<
    PipelineResourceErrorCode,
    "RESOURCE_MISSING" | "RESOURCE_CORRUPT" | "RESOURCE_INCOMPATIBLE"
  >;

  constructor(code: ResourcePreflightError["code"]) {
    super("Pipeline resource preflight failed");
    this.name = "ResourcePreflightError";
    this.code = code;
  }
}

export async function preflightPipelineResources(
  options: ResourcePreflightOptions
): Promise<readonly ResourceBindingV1[]> {
  const lock = copyAndFreezeLock(options.lock);
  const requiredRoles = copyRequiredRoles(options.requiredRoles);
  const roots = copyTrustedRoots(options.trustedRoots);
  const publisherAllowlist = copyPublisherAllowlist(
    options.publisherAllowlist
  );
  const candidates: Array<{
    binding: ResourceBindingV1;
    entry: Readonly<PipelineResourceLockEntryV1>;
    probe: ResourcePlatformProbe;
  }> = [];

  for (const role of requiredRoles) {
    const entry = lock.resources.find((resource) => resource.role === role);
    if (entry === undefined) {
      throw new ResourcePreflightError("RESOURCE_MISSING");
    }
    const probe = options.probes[role];
    if (typeof probe !== "function") {
      throw new ResourcePreflightError("RESOURCE_INCOMPATIBLE");
    }
    const absolutePath = resolvePackRoot(entry, roots);
    const binding = Object.freeze({
      role: entry.role,
      resourceId: entry.resourceId,
      version: entry.version,
      distribution: entry.distribution,
      absolutePath
    });
    candidates.push({ binding, entry, probe });
  }

  for (const candidate of candidates) {
    try {
      const verification = await verifyInstalledResourcePack({
        packRoot: candidate.binding.absolutePath,
        entry: candidate.entry,
        pipelineVersion: lock.pipelineVersion,
        publisherAllowlist
      });
      if (!pathsAreEqual(
        verification.absolutePath,
        candidate.binding.absolutePath
      )) {
        throw new ResourcePreflightError("RESOURCE_CORRUPT");
      }
    } catch (error) {
      if (error instanceof ResourcePreflightError) throw error;
      if (error instanceof ResourcePackVerificationError) {
        throw new ResourcePreflightError(error.code);
      }
      throw new ResourcePreflightError("RESOURCE_CORRUPT");
    }
  }

  for (const candidate of candidates) {
    try {
      await candidate.probe(candidate.binding);
    } catch {
      throw new ResourcePreflightError("RESOURCE_CORRUPT");
    }
  }

  return Object.freeze(candidates.map((candidate) => candidate.binding));
}

function copyPublisherAllowlist(
  input: CmsPublisherAllowlist
): Readonly<CmsPublisherAllowlist> {
  try {
    return normalizeCmsPublisherAllowlist(input);
  } catch {
    throw new ResourcePreflightError("RESOURCE_CORRUPT");
  }
}

type CopiedTrustedRoots = Readonly<{
  userDataRoot: string;
  bundledResourceRoot: string;
  bundledLocations: Readonly<
    Partial<Record<PipelineResourceRole, string>>
  >;
}>;

const resourceRoles = new Set<PipelineResourceRole>([
  "font_ko_fallback",
  "ocr_production",
  "ocr_ja",
  "ocr_en",
  "inpaint_precise"
]);

function copyAndFreezeLock(
  input: Readonly<PipelineResourceLockV1>
): Readonly<PipelineResourceLockV1> {
  let lock: PipelineResourceLockV1;
  try {
    lock = parsePipelineResourceLockV1(input);
  } catch {
    throw new ResourcePreflightError("RESOURCE_CORRUPT");
  }

  for (const entry of lock.resources) {
    if (entry.download !== undefined) Object.freeze(entry.download);
    Object.freeze(entry.requiredFor);
    Object.freeze(entry);
  }
  Object.freeze(lock.resources);
  return Object.freeze(lock);
}

function copyRequiredRoles(
  input: readonly PipelineResourceRole[]
): readonly PipelineResourceRole[] {
  if (!Array.isArray(input)) {
    throw new ResourcePreflightError("RESOURCE_INCOMPATIBLE");
  }
  const roles = [...input];
  const seen = new Set<PipelineResourceRole>();
  for (const role of roles) {
    if (!resourceRoles.has(role) || seen.has(role)) {
      throw new ResourcePreflightError("RESOURCE_INCOMPATIBLE");
    }
    seen.add(role);
  }
  return Object.freeze(roles);
}

function copyTrustedRoots(
  input: ResourcePreflightTrustedRoots
): CopiedTrustedRoots {
  if (typeof input !== "object" || input === null) {
    throw new ResourcePreflightError("RESOURCE_CORRUPT");
  }
  const userDataRoot = validateTrustedAbsoluteRoot(input.userDataRoot);
  const bundledResourceRoot = validateTrustedAbsoluteRoot(
    input.bundledResourceRoot
  );
  const bundledLocations = Object.freeze({ ...input.bundledLocations });
  return Object.freeze({
    userDataRoot,
    bundledResourceRoot,
    bundledLocations
  });
}

function resolvePackRoot(
  entry: Readonly<PipelineResourceLockEntryV1>,
  roots: CopiedTrustedRoots
): string {
  if (entry.distribution === "download") {
    const resourceId = validateLocationSegment(entry.resourceId);
    const version = validateLocationSegment(entry.version);
    return resolveExactDescendant(
      roots.userDataRoot,
      `pipeline-resources/${resourceId}/${version}`
    );
  }
  if (entry.distribution === "bundled") {
    const location = roots.bundledLocations[entry.role];
    if (location === undefined) {
      throw new ResourcePreflightError("RESOURCE_INCOMPATIBLE");
    }
    return resolveExactDescendant(roots.bundledResourceRoot, location);
  }
  throw new ResourcePreflightError("RESOURCE_INCOMPATIBLE");
}

function validateTrustedAbsoluteRoot(root: string): string {
  if (
    typeof root !== "string"
    || root.length === 0
    || !isAbsolute(root)
    || !pathsAreEqual(root, resolve(root))
  ) {
    throw new ResourcePreflightError("RESOURCE_CORRUPT");
  }
  return root;
}

function validateLocationSegment(value: string): string {
  if (value.includes("/") || value.includes("\\")) {
    throw new ResourcePreflightError("RESOURCE_CORRUPT");
  }
  try {
    return validatePipelineRelativePath(value);
  } catch {
    throw new ResourcePreflightError("RESOURCE_CORRUPT");
  }
}

function resolveExactDescendant(root: string, location: string): string {
  let validatedLocation: string;
  try {
    validatedLocation = validatePipelineRelativePath(location);
  } catch {
    throw new ResourcePreflightError("RESOURCE_CORRUPT");
  }
  const candidate = resolve(root, ...validatedLocation.split("/"));
  const derivedLocation = relative(root, candidate).split(sep).join("/");
  if (
    derivedLocation !== validatedLocation
    || pathsAreEqual(candidate, root)
  ) {
    throw new ResourcePreflightError("RESOURCE_CORRUPT");
  }
  return candidate;
}

function pathsAreEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}
