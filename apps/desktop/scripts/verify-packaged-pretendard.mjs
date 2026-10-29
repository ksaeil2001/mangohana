import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const EXPECTED_IDENTITY = "Pretendard Std Variable@1.3.9";
export const EXPECTED_FONT_SHA256 =
  "3090ccde0442bb347aa7685d9ba8b17436a60682df6e8f92a9a670de14056e22";

// Representative coverage is a package-level smoke check, not a substitute
// for page-specific runtime readiness. The renderer must still fail closed if
// a real page requests a codepoint/metric that is unavailable at runtime.
const REQUIRED_GLYPH_CODEPOINTS = Object.freeze([
  0x0041, // Latin capital A
  0x0061, // Latin small a
  0x0030, // digit zero
  0x0039, // digit nine
  0x002e, // ASCII period
  0x002c, // ASCII comma
  0x3002, // ideographic full stop
  0xff0c, // fullwidth comma
  0x3131, // Hangul compatibility jamo gieug
  0x314f, // Hangul compatibility jamo a
  0x3163, // Hangul compatibility jamo i
  0xac00, // Hangul syllable ga
  0xd55c, // Hangul syllable han
  0xae00 // Hangul syllable geul
]);

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const FONT_RELATIVE_PATH =
  "pipeline-resources/pretendard-ko-fallback/1.3.9/PretendardVariable.ttf";
const REQUIRED_RESOURCE_FILES = [
  "pipeline-resources/pipeline-resource-lock.json",
  "pipeline-resources/font-publisher-allowlist.json",
  "pipeline-resources/pretendard-ko-fallback/1.3.9/resource-manifest.json",
  "pipeline-resources/pretendard-ko-fallback/1.3.9/resource-manifest.p7s",
  FONT_RELATIVE_PATH
];
const GLYPH_REGRESSION_ARGS = Object.freeze([
  join("node_modules", "vitest", "vitest.mjs"),
  "run",
  "tests/renderer/productionTypesetFont.test.ts",
  "tests/renderer/typesettingReadiness.test.ts",
  "--reporter=dot"
]);

function fail(message) {
  throw new Error(message);
}

/**
 * Check representative codepoints against the exact packaged SFNT bytes.
 * Only cmap formats 4 and 12 are accepted; malformed tables or missing
 * non-zero glyph IDs fail closed. This parser intentionally uses only Node
 * built-ins so the evidence does not depend on a host font or native package.
 */
export function hasRequiredGlyphCoverage(fontBytes) {
  try {
    if (!ArrayBuffer.isView(fontBytes) || fontBytes.BYTES_PER_ELEMENT !== 1 || fontBytes.byteLength < 12) {
      return false;
    }
    const view = new DataView(
      fontBytes.buffer,
      fontBytes.byteOffset,
      fontBytes.byteLength
    );
    const cmapTable = findCmapTable(view);
    if (!cmapTable) {
      return false;
    }
    const lookups = parseCmapTable(view, cmapTable);
    if (lookups.length === 0) {
      return false;
    }
    return REQUIRED_GLYPH_CODEPOINTS.every((codePoint) =>
      lookups.some((lookup) => lookup(codePoint) > 0)
    );
  } catch {
    return false;
  }
}

function findCmapTable(view) {
  if (view.byteLength < 12) {
    return null;
  }
  const tableCount = readUint16(view, 4);
  const directoryEnd = 12 + tableCount * 16;
  if (directoryEnd > view.byteLength) {
    return null;
  }
  let cmapTable = null;
  for (let index = 0; index < tableCount; index += 1) {
    const entry = 12 + index * 16;
    const tag = String.fromCharCode(
      view.getUint8(entry),
      view.getUint8(entry + 1),
      view.getUint8(entry + 2),
      view.getUint8(entry + 3)
    );
    if (tag !== "cmap") {
      continue;
    }
    if (cmapTable) {
      return null;
    }
    const offset = readUint32(view, entry + 8);
    const length = readUint32(view, entry + 12);
    if (offset > view.byteLength || length > view.byteLength - offset) {
      return null;
    }
    cmapTable = { offset, length };
  }
  return cmapTable;
}

function parseCmapTable(view, table) {
  const tableEnd = table.offset + table.length;
  if (table.length < 4) {
    return [];
  }
  const recordCount = readUint16(view, table.offset + 2);
  const recordsEnd = table.offset + 4 + recordCount * 8;
  if (recordsEnd > tableEnd) {
    return [];
  }
  const lookups = [];
  for (let index = 0; index < recordCount; index += 1) {
    const record = table.offset + 4 + index * 8;
    const subtableOffset = readUint32(view, record + 4);
    if (subtableOffset > table.length - 2) {
      return [];
    }
    const subtable = table.offset + subtableOffset;
    const format = readUint16(view, subtable);
    if (format === 4) {
      const lookup = parseCmapFormat4(view, subtable, tableEnd);
      if (!lookup) {
        return [];
      }
      lookups.push(lookup);
    } else if (format === 12) {
      const lookup = parseCmapFormat12(view, subtable, tableEnd);
      if (!lookup) {
        return [];
      }
      lookups.push(lookup);
    }
  }
  return lookups;
}

function parseCmapFormat4(view, start, tableEnd) {
  const length = readUint16(view, start + 2);
  if (length < 32 || start > tableEnd - length) {
    return null;
  }
  const end = start + length;
  const segmentCountX2 = readUint16(view, start + 6);
  if (segmentCountX2 === 0 || segmentCountX2 % 2 !== 0) {
    return null;
  }
  const segmentCount = segmentCountX2 / 2;
  const arraysEnd = start + 16 + segmentCount * 8;
  if (arraysEnd > end) {
    return null;
  }
  const segments = [];
  let previousEnd = -1;
  for (let index = 0; index < segmentCount; index += 1) {
    const endCode = readUint16(view, start + 14 + index * 2);
    const startCode = readUint16(
      view,
      start + 16 + segmentCount * 2 + index * 2
    );
    const idDelta = view.getInt16(
      start + 16 + segmentCount * 4 + index * 2
    );
    const idRangeOffsetAddress =
      start + 16 + segmentCount * 6 + index * 2;
    const idRangeOffset = readUint16(view, idRangeOffsetAddress);
    if (startCode > endCode || startCode <= previousEnd) {
      return null;
    }
    if (idRangeOffset > 0) {
      const lastGlyphAddress =
        idRangeOffsetAddress + idRangeOffset +
        (endCode - startCode) * 2 + 2;
      if (lastGlyphAddress > end) {
        return null;
      }
    }
    segments.push({
      endCode,
      idDelta,
      idRangeOffset,
      idRangeOffsetAddress,
      startCode
    });
    previousEnd = endCode;
  }
  if (segments[segments.length - 1]?.endCode !== 0xffff) {
    return null;
  }
  return (codePoint) => {
    if (codePoint > 0xffff) {
      return 0;
    }
    for (const segment of segments) {
      if (codePoint < segment.startCode) {
        return 0;
      }
      if (codePoint > segment.endCode) {
        continue;
      }
      if (segment.idRangeOffset === 0) {
        return (codePoint + segment.idDelta) & 0xffff;
      }
      const glyphAddress = segment.idRangeOffsetAddress +
        segment.idRangeOffset +
        (codePoint - segment.startCode) * 2;
      const glyphId = readUint16(view, glyphAddress);
      return glyphId === 0 ? 0 : (glyphId + segment.idDelta) & 0xffff;
    }
    return 0;
  };
}

function parseCmapFormat12(view, start, tableEnd) {
  const length = readUint32(view, start + 4);
  if (length < 16 || start > tableEnd - length) {
    return null;
  }
  const end = start + length;
  const groupCount = readUint32(view, start + 12);
  if (groupCount > Math.floor((length - 16) / 12)) {
    return null;
  }
  const groups = [];
  let previousEnd = -1;
  for (let index = 0; index < groupCount; index += 1) {
    const group = start + 16 + index * 12;
    const startCode = readUint32(view, group);
    const endCode = readUint32(view, group + 4);
    const startGlyph = readUint32(view, group + 8);
    if (
      startCode > endCode ||
      endCode > 0x10ffff ||
      startCode <= previousEnd ||
      startGlyph > 0xffff ||
      endCode - startCode > 0xffff - startGlyph
    ) {
      return null;
    }
    groups.push({ endCode, startCode, startGlyph });
    previousEnd = endCode;
  }
  if (start + 16 + groupCount * 12 > end) {
    return null;
  }
  return (codePoint) => {
    for (const group of groups) {
      if (codePoint < group.startCode) {
        return 0;
      }
      if (codePoint <= group.endCode) {
        return group.startGlyph + codePoint - group.startCode;
      }
    }
    return 0;
  };
}

function readUint16(view, offset) {
  if (offset < 0 || offset + 2 > view.byteLength) {
    throw new Error("cmap read out of bounds");
  }
  return view.getUint16(offset);
}

function readUint32(view, offset) {
  if (offset < 0 || offset + 4 > view.byteLength) {
    throw new Error("cmap read out of bounds");
  }
  return view.getUint32(offset);
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--") || index + 1 >= argv.length) {
      fail("Expected --resources-dir and --output arguments.");
    }
    result[value.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function assertRegularFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("A production Pretendard resource file is not a regular file.");
  }
}

async function assertRequiredFiles(resourcesPath) {
  for (const relativePath of REQUIRED_RESOURCE_FILES) {
    await assertRegularFile(join(resourcesPath, relativePath));
  }
}

async function loadAuthoritativeModule() {
  const modulePath = resolve(
    PROJECT_ROOT,
    "dist-electron/src/main/productionTypesetFontResource.js"
  );
  await assertRegularFile(modulePath);
  return import(pathToFileURL(modulePath).href);
}

async function initializeAuthoritativeResource(resourcesPath) {
  const authoritative = await loadAuthoritativeModule();
  if (authoritative.PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY !== EXPECTED_IDENTITY) {
    fail("The production Pretendard evidence identity changed.");
  }
  return authoritative.initializeProductionTypesetFontResource(
    resourcesPath,
    { warn: () => undefined }
  );
}

export async function readPackagedFontBytes(resourcesPath) {
  return readFile(join(resourcesPath, FONT_RELATIVE_PATH));
}

export async function readPackagedFontHash(resourcesPath) {
  const bytes = await readPackagedFontBytes(resourcesPath);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Run the fixed renderer/readiness regression command. The verifier never
 * accepts a command or an environment assertion from an operator. Tests use
 * the function-level seam on verifyPackagedPretendard instead.
 */
export async function runRendererGlyphRegression() {
  try {
    await execFile(process.execPath, [...GLYPH_REGRESSION_ARGS], {
      cwd: PROJECT_ROOT,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

function writeSanitizedSummary(outputPath, summary) {
  return writeFile(
    outputPath,
    `${JSON.stringify(summary)}\n`,
    { encoding: "utf8", flag: "wx" }
  );
}

const FALSE_SUMMARY = Object.freeze({
  cmsValid: false,
  hashValid: false,
  publisherAllowed: false,
  identityMatched: false,
  glyphCoverageValid: false
});

/**
 * Verify a packaged resource and write only the sanitized boolean evidence.
 * The optional functions are a narrow module-level test seam; the CLI always
 * uses the authoritative defaults above and supplies no operator-controlled
 * verifier or glyph command.
 */
export async function verifyPackagedPretendard({
  resourcesPath,
  outputPath,
  initializeResource = initializeAuthoritativeResource,
  readPackagedFontBytes: readFontBytes = readPackagedFontBytes,
  runGlyphRegression = runRendererGlyphRegression
}) {
  if (!isAbsolute(resourcesPath) || !isAbsolute(outputPath)) {
    fail("Packaged resource and output paths must be absolute.");
  }

  try {
    await assertRequiredFiles(resourcesPath);
    const resource = await initializeResource(resourcesPath);
    const resourceEnabled = resource.enabled === true;
    const identityMatched = resourceEnabled &&
      await resource.verifyInstalledTypesetFontResource(EXPECTED_IDENTITY);
    const packagedFontBytes = await readFontBytes(resourcesPath);
    const packagedFontHash = createHash("sha256")
      .update(packagedFontBytes)
      .digest("hex");
    const hashValid = packagedFontHash === EXPECTED_FONT_SHA256;
    const packagedGlyphCoverageValid = identityMatched && hashValid &&
      hasRequiredGlyphCoverage(packagedFontBytes);
    const glyphCoverageValid = packagedGlyphCoverageValid
      ? await runGlyphRegression()
      : false;
    const summary = {
      cmsValid: resourceEnabled,
      hashValid,
      publisherAllowed: resourceEnabled,
      identityMatched,
      glyphCoverageValid
    };
    await writeSanitizedSummary(outputPath, summary);
    if (!Object.values(summary).every((value) => value === true)) {
      fail("The packaged Pretendard resource did not pass the stable evidence gate.");
    }
    return { packagedFontHash, summary };
  } catch (error) {
    try {
      await writeSanitizedSummary(outputPath, FALSE_SUMMARY);
    } catch {
      // Preserve the original fail-closed result without exposing paths.
    }
    throw error;
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const resourcesPath = resolve(args["resources-dir"] ?? "");
  const outputPath = resolve(args.output ?? "");
  const result = await verifyPackagedPretendard({ resourcesPath, outputPath });
  // The exact packaged hash is bound to the successful gate and reported
  // separately from the sanitized artifact, which intentionally has no hash.
  console.log(JSON.stringify({
    pretendardVerified: true,
    resourceHash: result.packagedFontHash
  }));
}

const isCliInvocation = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCliInvocation) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Pretendard verification failed.");
    process.exitCode = 1;
  });
}
