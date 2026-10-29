import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { resolveStoredPageImagePath } from "./inpaintingAssets.js";

/**
 * Checks canonical containment and returns the same bytes whose size/hash were checked.
 * This is NOT a race-safe filesystem boundary against hostile parent replacement:
 * Node on Windows exposes neither a final-path-from-handle API nor directory-relative
 * no-reparse opens. A junction can change between realpath and open. Repeating path
 * checks cannot close that window (or an ABA swap); a native handle boundary is needed.
 */
export async function readVerifiedProjectAsset(args: {
  projectFilePath: string;
  image: { storedRelativePath: string; sha256: string; byteSize: number };
  errorPrefix: "ORIGINAL_IMAGE" | "CLEANED_ASSET";
}): Promise<Buffer> {
  const storedPath = resolveStoredPageImagePath({
    projectFilePath: args.projectFilePath,
    storedRelativePath: args.image.storedRelativePath
  });
  const projectRoot = await realpath(dirname(args.projectFilePath));
  const actualPath = await realpath(storedPath);
  const inside = relative(projectRoot, actualPath);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`${args.errorPrefix}_UNSAFE_PATH`);
  }
  const handle = await open(actualPath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== args.image.byteSize) {
      throw new Error(`${args.errorPrefix}_INTEGRITY_MISMATCH: SHA-256/byteSize`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== args.image.byteSize || createHash("sha256").update(bytes).digest("hex") !== args.image.sha256) {
      throw new Error(`${args.errorPrefix}_INTEGRITY_MISMATCH: SHA-256/byteSize`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}
