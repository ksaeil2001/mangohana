import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";

const EXPECTED_SOURCE_SHA256 = "08276cdab69d6d2da74d3b46134af812b4b1f130b8ac9eee2316c8c154473a08";
const EXPECTED_SOURCE = { width: 1254, height: 1254 };
const EXPECTED_MASTER = { width: 1024, height: 1024 };
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_REPRESENTATIONS = [
  { type: "ic11", width: 32, height: 32, effective: "16@2x" },
  { type: "ic12", width: 64, height: 64, effective: "32@2x" },
  { type: "ic07", width: 128, height: 128, effective: "128@1x" },
  { type: "ic13", width: 256, height: 256, effective: "128@2x" },
  { type: "ic08", width: 256, height: 256, effective: "256@1x" },
  { type: "ic14", width: 512, height: 512, effective: "256@2x" },
  { type: "ic09", width: 512, height: 512, effective: "512@1x" },
  { type: "ic10", width: 1024, height: 1024, effective: "512@2x" },
];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_DECODED_PNG_BYTES = 256 * 1024 * 1024;

function supportsBoundedInflate() {
  try {
    const output = inflateSync(Buffer.from("789c6360000000020001", "hex"), { maxOutputLength: 1 });
    return output.length <= 1;
  } catch (error) {
    return error?.code === "ERR_BUFFER_TOO_LARGE";
  }
}

const BOUNDED_INFLATE_SUPPORTED = supportsBoundedInflate();

class VerificationError extends Error {}

function parseArgs() {
  const args = process.argv.slice(2);
  let outputRoot = resolve(process.cwd(), "build");
  let packageFile = resolve(process.cwd(), "package.json");
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output-root" || argument === "--root") {
      const value = args[index + 1];
      if (!value) throw new VerificationError(`${argument} requires a path`);
      outputRoot = resolve(process.cwd(), value);
      index += 1;
    } else if (argument === "--package") {
      const value = args[index + 1];
      if (!value) throw new VerificationError("--package requires a path");
      packageFile = resolve(process.cwd(), value);
      index += 1;
    } else {
      throw new VerificationError(`unknown argument ${argument}`);
    }
  }
  return { outputRoot, packageFile };
}

function regularFile(filePath, label) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new VerificationError(`${label} is missing`);
  }
  if (stat.isSymbolicLink()) throw new VerificationError(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new VerificationError(`${label} must be a regular file`);
  return filePath;
}

function regularDirectory(directoryPath, label) {
  let stat;
  try {
    stat = lstatSync(directoryPath);
  } catch {
    throw new VerificationError(`${label} is missing`);
  }
  if (stat.isSymbolicLink()) throw new VerificationError(`${label} must not be a symlink`);
  if (!stat.isDirectory()) throw new VerificationError(`${label} must be a directory`);
  return directoryPath;
}

function readRegularFile(filePath, label) {
  regularFile(filePath, label);
  try {
    return readFileSync(filePath);
  } catch {
    throw new VerificationError(`${label} could not be read`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePng(bytes, label) {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new VerificationError(`${label} has an invalid PNG signature`);
  }

  let offset = 8;
  let header;
  let hasIdat = false;
  let idatClosed = false;
  const idatData = [];
  let hasEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new VerificationError(`${label} has a truncated PNG chunk`);
    const chunkLength = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString("ascii", offset + 4, offset + 8);
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkLength;
    const chunkEnd = chunkDataEnd + 4;
    if (chunkEnd > bytes.length) throw new VerificationError(`${label} has a truncated PNG chunk`);
    const chunkTypeBytes = bytes.subarray(offset + 4, offset + 8);
    const chunkData = bytes.subarray(chunkDataStart, chunkDataEnd);
    const storedCrc = bytes.readUInt32BE(chunkDataEnd);
    const calculatedCrc = crc32(Buffer.concat([chunkTypeBytes, chunkData]));
    if (storedCrc !== calculatedCrc) throw new VerificationError(`${label} has a PNG CRC mismatch`);
    if (chunkType === "IHDR") {
      if (header || chunkLength !== 13 || offset !== 8) {
        throw new VerificationError(`${label} has an invalid PNG IHDR`);
      }
      header = {
        width: chunkData.readUInt32BE(0),
        height: chunkData.readUInt32BE(4),
        bitDepth: chunkData[8],
        colorType: chunkData[9],
        compression: chunkData[10],
        filter: chunkData[11],
        interlace: chunkData[12],
      };
      if (header.width === 0 || header.height === 0) {
        throw new VerificationError(`${label} has invalid PNG dimensions`);
      }
    } else if (chunkType === "IDAT") {
      if (!header || idatClosed) throw new VerificationError(`${label} has an invalid IDAT sequence`);
      hasIdat = true;
      idatData.push(Buffer.from(chunkData));
    } else if (chunkType === "IEND") {
      if (chunkLength !== 0 || hasEnd || chunkEnd !== bytes.length) {
        throw new VerificationError(`${label} has an invalid PNG IEND`);
      }
      hasEnd = true;
    } else if (hasIdat) {
      idatClosed = true;
    }
    offset = chunkEnd;
  }
  if (!header || !hasEnd || !hasIdat) {
    throw new VerificationError(`${label} is missing PNG IHDR, IDAT, or IEND`);
  }
  if (
    header.bitDepth !== 8 ||
    header.colorType !== 6 ||
    header.compression !== 0 ||
    header.filter !== 0 ||
    header.interlace !== 0
  ) {
    throw new VerificationError(`${label} must be an 8-bit non-interlaced RGBA PNG`);
  }

  const scanlineLength = 1 + header.width * 4;
  const expectedDecodedLength = header.height * scanlineLength;
  if (
    !Number.isSafeInteger(scanlineLength) ||
    !Number.isSafeInteger(expectedDecodedLength) ||
    expectedDecodedLength <= 0 ||
    expectedDecodedLength > MAX_DECODED_PNG_BYTES
  ) {
    throw new VerificationError(`${label} decoded image is too large`);
  }
  if (!BOUNDED_INFLATE_SUPPORTED) {
    throw new VerificationError(`${label} requires a Node runtime with bounded PNG inflate support`);
  }
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(idatData), { maxOutputLength: expectedDecodedLength });
  } catch {
    throw new VerificationError(`${label} has invalid PNG deflate data`);
  }
  if (decoded.length !== expectedDecodedLength) {
    throw new VerificationError(`${label} has an unexpected decoded scanline length`);
  }
  for (let row = 0; row < header.height; row += 1) {
    const filterByte = decoded[row * scanlineLength];
    if (filterByte > 4) throw new VerificationError(`${label} has an invalid PNG filter byte`);
  }
  return header;
}

function verifyPng(bytes, label, expectedWidth, expectedHeight) {
  const header = parsePng(bytes, label);
  if (header.width !== expectedWidth || header.height !== expectedHeight) {
    throw new VerificationError(
      `${label} dimensions are ${header.width}x${header.height}; expected ${expectedWidth}x${expectedHeight}`
    );
  }
  return header;
}

function verifyIco(bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
    throw new VerificationError("icon.ico has an invalid ICO header");
  }
  const count = bytes.readUInt16LE(4);
  if (count !== ICO_SIZES.length || bytes.length < 6 + count * 16) {
    throw new VerificationError("icon.ico has missing or truncated entries");
  }

  const entries = [];
  const seenSizes = new Set();
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    const width = bytes[entryOffset] || 256;
    const height = bytes[entryOffset + 1] || 256;
    const planes = bytes.readUInt16LE(entryOffset + 4);
    const bitCount = bytes.readUInt16LE(entryOffset + 6);
    const dataLength = bytes.readUInt32LE(entryOffset + 8);
    const dataOffset = bytes.readUInt32LE(entryOffset + 12);
    if (width !== height || !ICO_SIZES.includes(width) || seenSizes.has(width)) {
      throw new VerificationError("icon.ico has a duplicate or unexpected size");
    }
    if (planes !== 0 && planes !== 1 || bitCount !== 32 || dataLength === 0) {
      throw new VerificationError("icon.ico has an invalid entry format");
    }
    if (dataOffset < 6 + count * 16 || dataOffset + dataLength > bytes.length) {
      throw new VerificationError("icon.ico has a truncated image entry");
    }
    verifyPng(bytes.subarray(dataOffset, dataOffset + dataLength), `icon.ico ${width}x${height}`, width, height);
    seenSizes.add(width);
    entries.push(width);
  }
  if (seenSizes.size !== ICO_SIZES.length || !ICO_SIZES.every((size) => seenSizes.has(size))) {
    throw new VerificationError("icon.ico is missing a required size");
  }
  return entries.sort((left, right) => left - right);
}

function verifyIcns(bytes) {
  if (bytes.length < 16 || bytes.toString("ascii", 0, 4) !== "icns") {
    throw new VerificationError("icon.icns has an invalid ICNS header");
  }
  const declaredLength = bytes.readUInt32BE(4);
  if (declaredLength !== bytes.length) throw new VerificationError("icon.icns length is truncated or has trailing data");

  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new VerificationError("icon.icns has a truncated chunk header");
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > bytes.length) throw new VerificationError("icon.icns has a truncated chunk");
    chunks.push({ type, length, bytes: bytes.subarray(offset + 8, offset + length) });
    offset += length;
  }

  const toc = chunks.filter((chunk) => chunk.type === "TOC ");
  if (toc.length !== 1) throw new VerificationError("icon.icns must contain one TOC chunk");
  const iconChunks = chunks.filter((chunk) => chunk.type !== "TOC ");
  const expectedByType = new Map(ICNS_REPRESENTATIONS.map((representation) => [representation.type, representation]));
  const seenTypes = new Set();
  const representations = [];
  for (const chunk of iconChunks) {
    const expected = expectedByType.get(chunk.type);
    if (!expected) continue;
    if (seenTypes.has(chunk.type)) throw new VerificationError("icon.icns has a duplicate representation");
    verifyPng(chunk.bytes, `icon.icns ${chunk.type}`, expected.width, expected.height);
    seenTypes.add(chunk.type);
    representations.push({ ...expected });
  }
  if (seenTypes.size !== expectedByType.size || ![...expectedByType.keys()].every((type) => seenTypes.has(type))) {
    throw new VerificationError("icon.icns is missing a required representation");
  }

  const tocBytes = toc[0].bytes;
  if (tocBytes.length !== iconChunks.length * 8) throw new VerificationError("icon.icns TOC is truncated or inconsistent");
  for (let index = 0; index < iconChunks.length; index += 1) {
    const tocOffset = index * 8;
    const tocType = tocBytes.toString("ascii", tocOffset, tocOffset + 4);
    const tocLength = tocBytes.readUInt32BE(tocOffset + 4);
    if (tocType !== iconChunks[index].type || tocLength !== iconChunks[index].length) {
      throw new VerificationError("icon.icns TOC does not match representations");
    }
  }
  if (!seenTypes.has("ic10")) throw new VerificationError("icon.icns is missing effective 1024 data");
  return representations.sort((left, right) => {
    const leftIndex = ICNS_REPRESENTATIONS.findIndex((item) => item.type === left.type);
    const rightIndex = ICNS_REPRESENTATIONS.findIndex((item) => item.type === right.type);
    return leftIndex - rightIndex;
  });
}

function verifyPackage(packageFile) {
  const packageBytes = readRegularFile(packageFile, "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(packageBytes.toString("utf8"));
  } catch {
    throw new VerificationError("package.json is not valid JSON");
  }
  if (packageJson?.build?.win?.icon !== "build/mangohana-icon.ico") {
    throw new VerificationError("package.json Windows icon path is not exact");
  }
  if (packageJson?.build?.mac?.icon !== "build/icon.icns") {
    throw new VerificationError("package.json macOS icon path is not exact");
  }
  if (packageJson?.build?.linux?.icon !== "build/icons") {
    throw new VerificationError("package.json Linux icon path is not exact");
  }
}

function verify({ outputRoot, packageFile }) {
  regularDirectory(outputRoot, "build output root");
  const brandRoot = regularDirectory(resolve(outputRoot, "brand"), "build/brand");
  const iconsRoot = regularDirectory(resolve(outputRoot, "icons"), "build/icons");
  verifyPackage(packageFile);

  const sourceBytes = readRegularFile(resolve(brandRoot, "trio-concept-2-source.png"), "concept 2 source");
  const sourceHash = sha256(sourceBytes);
  if (sourceHash !== EXPECTED_SOURCE_SHA256) throw new VerificationError("concept 2 source SHA-256 is not approved");
  verifyPng(sourceBytes, "concept 2 source", EXPECTED_SOURCE.width, EXPECTED_SOURCE.height);

  const masterBytes = readRegularFile(resolve(brandRoot, "trio-master-1024.png"), "1024 master");
  const masterHeader = verifyPng(masterBytes, "1024 master", EXPECTED_MASTER.width, EXPECTED_MASTER.height);
  const linuxPngs = [];
  for (const size of LINUX_SIZES) {
    const pngPath = resolve(iconsRoot, `${size}x${size}.png`);
    verifyPng(readRegularFile(pngPath, `Linux ${size}x${size} PNG`), `Linux ${size}x${size} PNG`, size, size);
    linuxPngs.push(size);
  }

  const icoEntries = verifyIco(readRegularFile(resolve(outputRoot, "icon.ico"), "Windows ICO"));
  const mangohanaIcoEntries = verifyIco(readRegularFile(resolve(outputRoot, "mangohana-icon.ico"), "망고하나 Windows ICO"));
  const icnsRepresentations = verifyIcns(readRegularFile(resolve(outputRoot, "icon.icns"), "macOS ICNS"));
  return {
    ok: true,
    source: {
      path: "build/brand/trio-concept-2-source.png",
      sha256: sourceHash,
      width: EXPECTED_SOURCE.width,
      height: EXPECTED_SOURCE.height,
    },
    master: {
      path: "build/brand/trio-master-1024.png",
      sha256: sha256(masterBytes),
      width: masterHeader.width,
      height: masterHeader.height,
    },
    linuxPngs,
    icoEntries,
    mangohanaIcoEntries,
    icnsRepresentations,
  };
}

try {
  console.log(JSON.stringify(verify(parseArgs())));
} catch (error) {
  const message = error instanceof VerificationError ? error.message : "brand verification failed";
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}
