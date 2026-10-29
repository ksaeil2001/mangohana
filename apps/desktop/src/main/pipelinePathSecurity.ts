export type PipelinePathValidationCode =
  | "PIPELINE_PATH_INVALID"
  | "PIPELINE_PATH_DUPLICATE"
  | "PIPELINE_PATH_CASE_COLLISION"
  | "PIPELINE_PATH_SELF_EXCLUSION_ALIAS";

export class PipelinePathValidationError extends Error {
  readonly code: PipelinePathValidationCode;

  constructor(code: PipelinePathValidationCode) {
    super("Invalid pipeline relative path");
    this.name = "PipelinePathValidationError";
    this.code = code;
  }
}

const manifestSelfExclusionPaths = new Set([
  "sidecar-integrity-manifest.json",
  "sidecar-integrity-manifest.p7s",
  "resource-manifest.json",
  "resource-manifest.p7s"
]);

const reservedDeviceNames = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_value, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_value, index) => `LPT${index + 1}`),
  "COM¹", "COM²", "COM³",
  "LPT¹", "LPT²", "LPT³"
]);

export function validatePipelineRelativePath(path: string): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\p{Cc}<>:"|?*]/u.test(path)
  ) {
    throwInvalidPath();
  }

  const segments = path.split("/");
  if (segments.some(isUnsafeSegment)) throwInvalidPath();

  const foldedPath = foldWindowsPath(path);
  if (manifestSelfExclusionPaths.has(foldedPath) && path !== foldedPath) {
    throw new PipelinePathValidationError("PIPELINE_PATH_SELF_EXCLUSION_ALIAS");
  }

  return path;
}

export function validatePipelineRelativePathList(paths: readonly string[]): string[] {
  const exactPaths = new Set<string>();
  const foldedPaths = new Set<string>();

  for (const path of paths) {
    validatePipelineRelativePath(path);

    if (exactPaths.has(path)) {
      throw new PipelinePathValidationError("PIPELINE_PATH_DUPLICATE");
    }

    const foldedPath = foldWindowsPath(path);
    if (foldedPaths.has(foldedPath)) {
      throw new PipelinePathValidationError("PIPELINE_PATH_CASE_COLLISION");
    }

    exactPaths.add(path);
    foldedPaths.add(foldedPath);
  }

  return [...paths];
}

function isUnsafeSegment(segment: string): boolean {
  if (segment.length === 0 || segment === "." || segment === "..") return true;
  if (segment.endsWith(".") || segment.endsWith(" ")) return true;

  return reservedDeviceNames.has(segment.split(".", 1)[0]!.toUpperCase());
}

function foldWindowsPath(path: string): string {
  return path.toLocaleLowerCase("en-US");
}

function throwInvalidPath(): never {
  throw new PipelinePathValidationError("PIPELINE_PATH_INVALID");
}
