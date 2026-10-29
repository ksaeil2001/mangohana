import { posix, win32 } from "node:path";

export type PathSemantics = "win32" | "posix";

export function pathSemanticsForPlatform(
  platform: NodeJS.Platform = process.platform
): PathSemantics {
  return platform === "win32" ? "win32" : "posix";
}

export function filesystemPathIdentity(
  filePath: string,
  semantics: PathSemantics = pathSemanticsForPlatform()
): string {
  const resolved = pathApi(semantics).resolve(filePath);
  return semantics === "win32"
    ? resolved.toLocaleLowerCase("en-US")
    : resolved;
}

export function sameFilesystemPath(
  left: string,
  right: string,
  semantics: PathSemantics = pathSemanticsForPlatform()
): boolean {
  return (
    filesystemPathIdentity(left, semantics) ===
    filesystemPathIdentity(right, semantics)
  );
}

export function projectRelativePathIdentity(
  storedRelativePath: string,
  semantics: PathSemantics = pathSemanticsForPlatform()
): string {
  const normalized = storedRelativePath.replaceAll("\\", "/");
  return semantics === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

export function absoluteParentDirectory(
  filePath: string,
  semantics: PathSemantics = pathSemanticsForPlatform()
): string | null {
  const implementation = pathApi(semantics);
  return implementation.isAbsolute(filePath)
    ? implementation.dirname(filePath)
    : null;
}

export function parentDirectory(
  filePath: string,
  semantics: PathSemantics = pathSemanticsForPlatform()
): string {
  return pathApi(semantics).dirname(filePath);
}

function pathApi(semantics: PathSemantics): typeof win32 | typeof posix {
  return semantics === "win32" ? win32 : posix;
}
