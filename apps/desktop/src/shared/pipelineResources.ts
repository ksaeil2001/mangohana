export type PipelineResourceRole =
  | "font_ko_fallback"
  | "ocr_production"
  | "ocr_ja"
  | "ocr_en"
  | "inpaint_precise";

export type PipelineResourceRequirement = "ocr" | "precise_inpaint" | "typeset";
export type PipelineResourceDistribution = "bundled" | "download";

export type ManifestFileEntryV1 = {
  relativePath: string;
  byteSize: number;
  sha256: string;
};

export type SidecarIntegrityManifestV1 = {
  schemaVersion: 1;
  pipelineVersion: string;
  buildPlatform: "win32-x64";
  files: ManifestFileEntryV1[];
};

export type ResourcePackManifestV1 = {
  schemaVersion: 1;
  resourceId: string;
  role: PipelineResourceRole;
  version: string;
  compatiblePipelineVersions: string[];
  files: ManifestFileEntryV1[];
  licenseFiles: string[];
};

export type PipelineResourceDownloadV1 = {
  archiveUrl: string;
  manifestUrl: string;
  signatureUrl: string;
};

export type PipelineResourceLockEntryV1 = {
  role: PipelineResourceRole;
  resourceId: string;
  version: string;
  manifestSha256: string;
  distribution: PipelineResourceDistribution;
  download?: PipelineResourceDownloadV1;
  requiredFor: PipelineResourceRequirement[];
};

export type PipelineResourceLockV1 = {
  schemaVersion: 1;
  appVersion: string;
  pipelineVersion: string;
  resources: PipelineResourceLockEntryV1[];
};

export type PipelineResourceErrorCode =
  | "PIPELINE_RESOURCE_INVALID_SCHEMA_VERSION"
  | "PIPELINE_RESOURCE_INVALID_ROLE"
  | "PIPELINE_RESOURCE_INVALID_DISTRIBUTION"
  | "PIPELINE_RESOURCE_INVALID_DOWNLOAD_URLS"
  | "PIPELINE_RESOURCE_INVALID_FILE_ENTRY"
  | "PIPELINE_RESOURCE_INVALID_MANIFEST"
  | "PIPELINE_RESOURCE_INVALID_LOCK"
  | "RESOURCE_MISSING"
  | "RESOURCE_CORRUPT"
  | "RESOURCE_INCOMPATIBLE";

export type PipelineResourceValidationCode = Exclude<
  PipelineResourceErrorCode,
  "RESOURCE_MISSING" | "RESOURCE_CORRUPT" | "RESOURCE_INCOMPATIBLE"
>;

export type PipelineResourceErrorV1 = {
  code: PipelineResourceErrorCode;
  message: string;
};

export class PipelineResourceValidationError extends Error {
  readonly code: PipelineResourceValidationCode;

  constructor(code: PipelineResourceValidationCode, message: string) {
    super(message);
    this.name = "PipelineResourceValidationError";
    this.code = code;
  }
}

export function parseSidecarIntegrityManifestV1(input: unknown): SidecarIntegrityManifestV1 {
  const value = expectExactRecord(
    input,
    ["schemaVersion", "pipelineVersion", "buildPlatform", "files"],
    "PIPELINE_RESOURCE_INVALID_MANIFEST",
    "Invalid sidecar integrity manifest"
  );
  expectSchemaVersion(value.schemaVersion);

  if (value.buildPlatform !== "win32-x64" || !isNonEmptyString(value.pipelineVersion) || !Array.isArray(value.files)) {
    throwValidation("PIPELINE_RESOURCE_INVALID_MANIFEST", "Invalid sidecar integrity manifest");
  }

  return {
    schemaVersion: 1,
    pipelineVersion: value.pipelineVersion,
    buildPlatform: "win32-x64",
    files: value.files.map(parseManifestFileEntryV1)
  };
}

export function parseResourcePackManifestV1(input: unknown): ResourcePackManifestV1 {
  const value = expectExactRecord(
    input,
    ["schemaVersion", "resourceId", "role", "version", "compatiblePipelineVersions", "files", "licenseFiles"],
    "PIPELINE_RESOURCE_INVALID_MANIFEST",
    "Invalid resource pack manifest"
  );
  expectSchemaVersion(value.schemaVersion);
  const role = parseRole(value.role);

  if (
    !isNonEmptyString(value.resourceId) ||
    !isNonEmptyString(value.version) ||
    !isNonEmptyStringArray(value.compatiblePipelineVersions) ||
    !Array.isArray(value.files) ||
    !isNonEmptyStringArray(value.licenseFiles)
  ) {
    throwValidation("PIPELINE_RESOURCE_INVALID_MANIFEST", "Invalid resource pack manifest");
  }

  return {
    schemaVersion: 1,
    resourceId: value.resourceId,
    role,
    version: value.version,
    compatiblePipelineVersions: [...value.compatiblePipelineVersions],
    files: value.files.map(parseManifestFileEntryV1),
    licenseFiles: [...value.licenseFiles]
  };
}

export function parsePipelineResourceLockV1(input: unknown): PipelineResourceLockV1 {
  const value = expectExactRecord(
    input,
    ["schemaVersion", "appVersion", "pipelineVersion", "resources"],
    "PIPELINE_RESOURCE_INVALID_LOCK",
    "Invalid pipeline resource lock"
  );
  expectSchemaVersion(value.schemaVersion);

  if (!isNonEmptyString(value.appVersion) || !isNonEmptyString(value.pipelineVersion) || !Array.isArray(value.resources)) {
    throwValidation("PIPELINE_RESOURCE_INVALID_LOCK", "Invalid pipeline resource lock");
  }

  const resources = value.resources.map(parsePipelineResourceLockEntryV1);
  const roles = new Set<PipelineResourceRole>();
  const resourceIds = new Set<string>();
  for (const resource of resources) {
    const foldedResourceId = resource.resourceId.toLocaleLowerCase("en-US");
    if (roles.has(resource.role) || resourceIds.has(foldedResourceId)) {
      throwValidation(
        "PIPELINE_RESOURCE_INVALID_LOCK",
        "Pipeline resource lock contains duplicate bindings"
      );
    }
    roles.add(resource.role);
    resourceIds.add(foldedResourceId);
  }

  return {
    schemaVersion: 1,
    appVersion: value.appVersion,
    pipelineVersion: value.pipelineVersion,
    resources
  };
}

function parsePipelineResourceLockEntryV1(input: unknown): PipelineResourceLockEntryV1 {
  const value = expectRecord(input, "PIPELINE_RESOURCE_INVALID_LOCK", "Invalid pipeline resource lock entry");
  const distribution = parseDistribution(value.distribution);
  const expectedKeys = distribution === "download"
    ? ["role", "resourceId", "version", "manifestSha256", "distribution", "download", "requiredFor"]
    : ["role", "resourceId", "version", "manifestSha256", "distribution", "requiredFor"];

  if (!hasExactKeys(value, expectedKeys)) {
    throwValidation("PIPELINE_RESOURCE_INVALID_LOCK", "Invalid pipeline resource lock entry");
  }

  const role = parseRole(value.role);
  if (
    !isNonEmptyString(value.resourceId) ||
    !isNonEmptyString(value.version) ||
    !isSha256(value.manifestSha256) ||
    !isRequirementArray(value.requiredFor)
  ) {
    throwValidation("PIPELINE_RESOURCE_INVALID_LOCK", "Invalid pipeline resource lock entry");
  }

  if (distribution === "bundled") {
    return {
      role,
      resourceId: value.resourceId,
      version: value.version,
      manifestSha256: value.manifestSha256,
      distribution,
      requiredFor: [...value.requiredFor]
    };
  }

  return {
    role,
    resourceId: value.resourceId,
    version: value.version,
    manifestSha256: value.manifestSha256,
    distribution,
    download: parseDownloadUrls(value.download),
    requiredFor: [...value.requiredFor]
  };
}

function parseManifestFileEntryV1(input: unknown): ManifestFileEntryV1 {
  const value = expectExactRecord(
    input,
    ["relativePath", "byteSize", "sha256"],
    "PIPELINE_RESOURCE_INVALID_FILE_ENTRY",
    "Invalid manifest file entry"
  );

  if (!isNonEmptyString(value.relativePath) || !isByteSize(value.byteSize) || !isSha256(value.sha256)) {
    throwValidation("PIPELINE_RESOURCE_INVALID_FILE_ENTRY", "Invalid manifest file entry");
  }

  return {
    relativePath: value.relativePath,
    byteSize: value.byteSize,
    sha256: value.sha256
  };
}

function parseDownloadUrls(input: unknown): PipelineResourceDownloadV1 {
  const value = expectExactRecord(
    input,
    ["archiveUrl", "manifestUrl", "signatureUrl"],
    "PIPELINE_RESOURCE_INVALID_DOWNLOAD_URLS",
    "Download resources require exactly three HTTPS URLs"
  );

  if (!isHttpsUrl(value.archiveUrl) || !isHttpsUrl(value.manifestUrl) || !isHttpsUrl(value.signatureUrl)) {
    throwValidation("PIPELINE_RESOURCE_INVALID_DOWNLOAD_URLS", "Download resources require exactly three HTTPS URLs");
  }

  return {
    archiveUrl: value.archiveUrl,
    manifestUrl: value.manifestUrl,
    signatureUrl: value.signatureUrl
  };
}

function expectSchemaVersion(value: unknown): void {
  if (value !== 1) {
    throwValidation("PIPELINE_RESOURCE_INVALID_SCHEMA_VERSION", "Unsupported pipeline resource schema version");
  }
}

function parseRole(value: unknown): PipelineResourceRole {
  if (
    value === "font_ko_fallback"
    || value === "ocr_production"
    || value === "ocr_ja"
    || value === "ocr_en"
    || value === "inpaint_precise"
  ) {
    return value;
  }
  throwValidation("PIPELINE_RESOURCE_INVALID_ROLE", "Invalid pipeline resource role");
}

function parseDistribution(value: unknown): PipelineResourceDistribution {
  if (value === "bundled" || value === "download") return value;
  throwValidation("PIPELINE_RESOURCE_INVALID_DISTRIBUTION", "Invalid pipeline resource distribution");
}

function expectExactRecord(
  value: unknown,
  expectedKeys: string[],
  code: PipelineResourceValidationCode,
  message: string
): Record<string, unknown> {
  const record = expectRecord(value, code, message);
  if (!hasExactKeys(record, expectedKeys)) throwValidation(code, message);
  return record;
}

function expectRecord(
  value: unknown,
  code: PipelineResourceValidationCode,
  message: string
): Record<string, unknown> {
  if (!isRecord(value)) throwValidation(code, message);
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isRequirementArray(value: unknown): value is PipelineResourceRequirement[] {
  return Array.isArray(value) && value.every(
    (requirement) => requirement === "ocr" || requirement === "precise_inpaint" || requirement === "typeset"
  );
}

function isByteSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function throwValidation(code: PipelineResourceValidationCode, message: string): never {
  throw new PipelineResourceValidationError(code, message);
}
