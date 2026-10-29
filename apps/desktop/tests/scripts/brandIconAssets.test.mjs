import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd());
const generatorPath = join(repoRoot, "scripts", "generate-brand-icons.py");
const verifierPath = join(repoRoot, "scripts", "verify-brand-icons.mjs");
const buildRoot = join(repoRoot, "build");
const packagePath = join(repoRoot, "package.json");
const sourcePath = join(buildRoot, "brand", "trio-concept-2-source.png");
const expectedPngSizes = [16, 24, 32, 48, 64, 128, 256, 512];
const expectedOutputHashes = {
  "brand/trio-concept-2-source.png": "08276cdab69d6d2da74d3b46134af812b4b1f130b8ac9eee2316c8c154473a08",
  "brand/trio-master-1024.png": "1a30b7da7d54b313b0d5e58ce6ca151b9900d32bfc20bf4f7f70558b9074e1ab",
  "icon.ico": "856ff296cebaebcfad2335c5061e050b2ddd784399a598a18da6447190a07199",
  "icon.icns": "8d878378d5c473ae732dd4cd5b0aa2c24ddcbd76157b17d12037ae1381117564",
  "icons/16x16.png": "8c46d25b48c828d4cfea751b950415e9d575b41ed59ecb0593172bd8ef2e4086",
  "icons/24x24.png": "d1b1dcb212e483b1d466594b7da4c6dc6c40c245728980ce08f01d2cb51faa47",
  "icons/32x32.png": "f03a51ae6c76ffaca1fff254c6dd6bf467ab505d5529c4df555e2093c324b9b1",
  "icons/48x48.png": "63e0ea48b4feedca91b1e068666eb26d74c216af85922ee7cbf80959e791d8a6",
  "icons/64x64.png": "cfd38273e0c0f93558a6a987807ce523f6524e17e803d85364b559b7bb1a7b9f",
  "icons/128x128.png": "f855b3f4177bbe3cfc820ea1826f21c38442a6d314121c0fbe151741503dc7b8",
  "icons/256x256.png": "a9236cab989fe78c50e7b3de2f116ec888499e6f6a5b3f62dd7dc141bab5af99",
  "icons/512x512.png": "0b2d6688c1f88b0bbc1590f7032b3abe062f3fc0d57a036b02531dd9c9acacc7",
};
const expectedOutputPaths = Object.keys(expectedOutputHashes);
const mangohanaIconHash = "e7ce1cc0d26fef76b2ed46ee79e6fb2528f0ac1fda5688e0bb6c8fefaab4b59c";
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function probePillow() {
  const commands = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  const attempts = [];
  for (const command of commands) {
    const result = spawnSync(command, ["-c", "import PIL; print(PIL.__version__)"], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error) {
      attempts.push(`${command}: unavailable`);
      continue;
    }
    const version = result.stdout.trim();
    if (result.status === 0 && version === "12.1.0") {
      return { available: true, command, reason: `${command} Pillow==12.1.0` };
    }
    attempts.push(`${command}: ${version || "no version"}`);
  }
  return {
    available: false,
    command: null,
    reason: `SKIPPED: Pillow==12.1.0 prerequisite unavailable (${attempts.join(", ")})`,
  };
}

function probeSymlinkSupport() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "trio-brand-symlink-probe-"));
  const source = join(fixtureRoot, "source.txt");
  const link = join(fixtureRoot, "link.txt");
  writeFileSync(source, "fixture");
  try {
    symlinkSync("source.txt", link);
    return { available: true, reason: "symlink creation supported" };
  } catch (error) {
    return {
      available: false,
      reason: `SKIPPED: symlink creation unavailable (${error?.code ?? error?.name ?? "unknown"})`,
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

const pillowCapability = probePillow();
const symlinkCapability = probeSymlinkSupport();

function runNode(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

function runVerifier(outputRoot = buildRoot, packageFile = packagePath) {
  return runNode(verifierPath, ["--output-root", outputRoot, "--package", packageFile]);
}

function runGenerator(outputRoot) {
  return spawnSync(pillowCapability.command, [
    generatorPath,
    "--source",
    sourcePath,
    "--output-root",
    outputRoot,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function copyFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "trio-brand-fixture-"));
  const fixtureBuild = join(fixtureRoot, "build");
  const fixturePackage = join(fixtureRoot, "package.json");
  mkdirSync(join(fixtureBuild, "brand"), { recursive: true });
  mkdirSync(join(fixtureBuild, "icons"), { recursive: true });
  for (const outputPath of expectedOutputPaths) {
    const destination = join(fixtureBuild, outputPath);
    mkdirSync(join(destination, ".."), { recursive: true });
    copyFileSync(join(buildRoot, outputPath), destination);
  }
  copyFileSync(join(buildRoot, "mangohana-icon.ico"), join(fixtureBuild, "mangohana-icon.ico"));
  copyFileSync(packagePath, fixturePackage);
  return { fixtureRoot, fixtureBuild, fixturePackage };
}

function withFixture(mutator) {
  const fixture = copyFixture();
  try {
    mutator(fixture);
    return runVerifier(fixture.fixtureBuild, fixture.fixturePackage);
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function expectVerifierFailure(result) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
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

function parsePngChunks(bytes) {
  if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error("invalid PNG fixture signature");
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const end = dataEnd + 4;
    if (end > bytes.length) throw new Error("truncated PNG fixture");
    chunks.push({ type, data: Buffer.from(bytes.subarray(dataStart, dataEnd)) });
    offset = end;
  }
  return chunks;
}

function encodePngChunks(chunks) {
  const pieces = [pngSignature];
  for (const chunk of chunks) {
    const data = Buffer.from(chunk.data);
    const type = Buffer.from(chunk.type, "ascii");
    const crcInput = Buffer.concat([type, data]);
    const crc = chunk.crcOverride ?? crc32(crcInput);
    const encoded = Buffer.alloc(12 + data.length);
    encoded.writeUInt32BE(data.length, 0);
    type.copy(encoded, 4);
    data.copy(encoded, 8);
    encoded.writeUInt32BE(crc >>> 0, 8 + data.length);
    pieces.push(encoded);
  }
  return Buffer.concat(pieces);
}

function mutatePngBytes(bytes, mutation) {
  const chunks = parsePngChunks(bytes);
  const idatIndex = chunks.findIndex((chunk) => chunk.type === "IDAT");
  if (idatIndex < 0 && mutation !== "missing-idat") throw new Error("PNG fixture has no IDAT");

  if (mutation === "missing-idat") {
    return encodePngChunks(chunks.filter((chunk) => chunk.type !== "IDAT"));
  }

  const mutated = chunks.map((chunk) => ({ type: chunk.type, data: Buffer.from(chunk.data) }));
  const idat = mutated[idatIndex];
  if (mutation === "corrupt-idat") {
    idat.data[0] ^= 0xff;
  } else if (mutation === "crc") {
    idat.crcOverride = (crc32(Buffer.concat([Buffer.from(idat.type, "ascii"), idat.data])) ^ 1) >>> 0;
  } else if (mutation === "truncated-deflate") {
    idat.data = Buffer.from([0x78]);
  } else if (mutation === "over-expansion") {
    idat.data = deflateSync(Buffer.alloc(1024 * 1024, 0));
  } else {
    throw new Error(`unknown PNG mutation ${mutation}`);
  }
  return encodePngChunks(mutated);
}

function patchPngIhdr(filePath, patch) {
  const chunks = parsePngChunks(readFileSync(filePath));
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  if (!ihdr) throw new Error("PNG fixture has no IHDR");
  if (patch.width !== undefined) ihdr.data.writeUInt32BE(patch.width, 0);
  if (patch.height !== undefined) ihdr.data.writeUInt32BE(patch.height, 4);
  if (patch.colorType !== undefined) ihdr.data[9] = patch.colorType;
  writeFileSync(filePath, encodePngChunks(chunks));
}

function mutatePngFile(filePath, mutation) {
  writeFileSync(filePath, mutatePngBytes(readFileSync(filePath), mutation));
}

function readIcoEntries(bytes) {
  const count = bytes.readUInt16LE(4);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = bytes[offset] || 256;
    const height = bytes[offset + 1] || 256;
    const dataLength = bytes.readUInt32LE(offset + 8);
    const dataOffset = bytes.readUInt32LE(offset + 12);
    entries.push({
      width,
      height,
      planes: bytes.readUInt16LE(offset + 4),
      bitCount: bytes.readUInt16LE(offset + 6),
      data: Buffer.from(bytes.subarray(dataOffset, dataOffset + dataLength)),
    });
  }
  return entries;
}

function writeIcoEntries(entries) {
  const headerSize = 6 + entries.length * 16;
  const output = Buffer.alloc(headerSize + entries.reduce((sum, entry) => sum + entry.data.length, 0));
  output.writeUInt16LE(0, 0);
  output.writeUInt16LE(1, 2);
  output.writeUInt16LE(entries.length, 4);
  let dataOffset = headerSize;
  entries.forEach((entry, index) => {
    const offset = 6 + index * 16;
    output[offset] = entry.width === 256 ? 0 : entry.width;
    output[offset + 1] = entry.height === 256 ? 0 : entry.height;
    output.writeUInt16LE(entry.planes, offset + 4);
    output.writeUInt16LE(entry.bitCount, offset + 6);
    output.writeUInt32LE(entry.data.length, offset + 8);
    output.writeUInt32LE(dataOffset, offset + 12);
    entry.data.copy(output, dataOffset);
    dataOffset += entry.data.length;
  });
  return output;
}

function mutateIcoEmbedded(filePath, targetWidth, mutation) {
  const entries = readIcoEntries(readFileSync(filePath));
  const target = entries.find((entry) => entry.width === targetWidth);
  if (!target) throw new Error(`ICO fixture has no ${targetWidth} entry`);
  target.data = mutatePngBytes(target.data, mutation);
  writeFileSync(filePath, writeIcoEntries(entries));
}

function readIcnsChunks(bytes) {
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset + 4);
    chunks.push({
      type: bytes.toString("ascii", offset, offset + 4),
      data: Buffer.from(bytes.subarray(offset + 8, offset + length)),
    });
    offset += length;
  }
  return chunks;
}

function writeIcnsChunks(iconChunks) {
  const tocLength = 8 + iconChunks.length * 8;
  const dataLength = iconChunks.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0);
  const output = Buffer.alloc(8 + tocLength + dataLength);
  output.write("icns", 0, "ascii");
  output.writeUInt32BE(output.length, 4);
  output.write("TOC ", 8, "ascii");
  output.writeUInt32BE(tocLength, 12);
  iconChunks.forEach((chunk, index) => {
    const tocOffset = 16 + index * 8;
    output.write(chunk.type, tocOffset, "ascii");
    output.writeUInt32BE(8 + chunk.data.length, tocOffset + 4);
  });
  let dataOffset = 8 + tocLength;
  for (const chunk of iconChunks) {
    output.write(chunk.type, dataOffset, "ascii");
    output.writeUInt32BE(8 + chunk.data.length, dataOffset + 4);
    chunk.data.copy(output, dataOffset + 8);
    dataOffset += 8 + chunk.data.length;
  }
  return output;
}

function mutateIcnsEmbedded(filePath, targetType, mutation) {
  const chunks = readIcnsChunks(readFileSync(filePath)).filter((chunk) => chunk.type !== "TOC ");
  const target = chunks.find((chunk) => chunk.type === targetType);
  if (!target) throw new Error(`ICNS fixture has no ${targetType} chunk`);
  target.data = mutatePngBytes(target.data, mutation);
  writeFileSync(filePath, writeIcnsChunks(chunks));
}

function removeIcoEntry(filePath, targetWidth) {
  const entries = readIcoEntries(readFileSync(filePath)).filter((entry) => entry.width !== targetWidth);
  writeFileSync(filePath, writeIcoEntries(entries));
}

function removeIcnsChunk(filePath, targetType) {
  const chunks = readIcnsChunks(readFileSync(filePath))
    .filter((chunk) => chunk.type !== "TOC " && chunk.type !== targetType);
  writeFileSync(filePath, writeIcnsChunks(chunks));
}

function expectBoundedInflateFailure(result) {
  expectVerifierFailure(result);
  expect(result.stdout, `${result.stdout}\n${result.stderr}`).toContain("invalid PNG deflate data");
}

describe("approved concept 2 brand assets", () => {
  it("pins and verifies the actual Windows packaging icon", () => {
    expect(sha256(join(buildRoot, "mangohana-icon.ico"))).toBe(mangohanaIconHash);
    const report = JSON.parse(runVerifier().stdout);
    expect(report.mangohanaIcoEntries).toEqual(expectedPngSizes.slice(0, -1));
    const corrupted = withFixture(({ fixtureBuild }) => {
      mutateIcoEmbedded(join(fixtureBuild, "mangohana-icon.ico"), 16, "crc");
    });
    expectVerifierFailure(corrupted);
  });
  it("pins every committed output hash without requiring Python", () => {
    for (const [outputPath, expectedHash] of Object.entries(expectedOutputHashes)) {
      const filePath = join(buildRoot, outputPath);
      expect(existsSync(filePath), outputPath).toBe(true);
      expect(sha256(filePath), outputPath).toBe(expectedHash);
    }
  });

  it("verifies generated assets and emits sanitized representation JSON", () => {
    const result = runVerifier();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      ok: true,
      source: {
        sha256: expectedOutputHashes["brand/trio-concept-2-source.png"],
        width: 1254,
        height: 1254,
      },
      master: { width: 1024, height: 1024, sha256: expectedOutputHashes["brand/trio-master-1024.png"] },
      linuxPngs: expectedPngSizes,
      icoEntries: expectedPngSizes.slice(0, -1),
    });
    expect(report.icnsRepresentations).toEqual(expect.arrayContaining([
      { type: "ic11", width: 32, height: 32, effective: "16@2x" },
      { type: "ic12", width: 64, height: 64, effective: "32@2x" },
      { type: "ic07", width: 128, height: 128, effective: "128@1x" },
      { type: "ic13", width: 256, height: 256, effective: "128@2x" },
      { type: "ic08", width: 256, height: 256, effective: "256@1x" },
      { type: "ic14", width: 512, height: 512, effective: "256@2x" },
      { type: "ic09", width: 512, height: 512, effective: "512@1x" },
      { type: "ic10", width: 1024, height: 1024, effective: "512@2x" },
    ]));
  });

  const determinismTest = pillowCapability.available ? it : it.skip;
  determinismTest(`generates byte-identical outputs on a second run (${pillowCapability.reason})`, () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "trio-brand-determinism-"));
    const firstRoot = join(fixtureRoot, "first");
    const secondRoot = join(fixtureRoot, "second");
    try {
      const first = runGenerator(firstRoot);
      const second = runGenerator(secondRoot);
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
      expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
      for (const outputPath of expectedOutputPaths) {
        expect(sha256(join(firstRoot, outputPath)), outputPath).toBe(expectedOutputHashes[outputPath]);
        expect(sha256(join(secondRoot, outputPath)), outputPath).toBe(expectedOutputHashes[outputPath]);
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects a missing required master asset in a deliberate fixture", () => {
    const result = withFixture(({ fixtureBuild }) => {
      rmSync(join(fixtureBuild, "brand", "trio-master-1024.png"));
    });
    expectVerifierFailure(result);
  });

  it("rejects a source hash mismatch", () => {
    const result = withFixture(({ fixtureBuild }) => {
      const source = join(fixtureBuild, "brand", "trio-concept-2-source.png");
      const bytes = Buffer.from(readFileSync(source));
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(source, bytes);
    });
    expectVerifierFailure(result);
  });

  it("rejects a Linux PNG with missing alpha or the wrong dimensions", () => {
    const alphaResult = withFixture(({ fixtureBuild }) => {
      patchPngIhdr(join(fixtureBuild, "icons", "16x16.png"), { colorType: 2 });
    });
    expectVerifierFailure(alphaResult);

    const sizeResult = withFixture(({ fixtureBuild }) => {
      patchPngIhdr(join(fixtureBuild, "icons", "24x24.png"), { width: 23 });
    });
    expectVerifierFailure(sizeResult);
  });

  it("rejects corrupt, bad-CRC, missing-IDAT, and truncated-deflate PNGs", () => {
    for (const mutation of ["corrupt-idat", "crc", "missing-idat", "truncated-deflate"]) {
      const result = withFixture(({ fixtureBuild }) => {
        mutatePngFile(join(fixtureBuild, "icons", "16x16.png"), mutation);
      });
      expectVerifierFailure(result);
    }
  });

  it("rejects valid-CRC compressed over-expansion before unbounded allocation", () => {
    const standaloneResult = withFixture(({ fixtureBuild }) => {
      mutatePngFile(join(fixtureBuild, "icons", "16x16.png"), "over-expansion");
    });
    expectBoundedInflateFailure(standaloneResult);

    const icoResult = withFixture(({ fixtureBuild }) => {
      mutateIcoEmbedded(join(fixtureBuild, "icon.ico"), 16, "over-expansion");
    });
    expectBoundedInflateFailure(icoResult);

    const icnsResult = withFixture(({ fixtureBuild }) => {
      mutateIcnsEmbedded(join(fixtureBuild, "icon.icns"), "ic11", "over-expansion");
    });
    expectBoundedInflateFailure(icnsResult);
  });

  it("applies PNG payload validation to embedded ICO and ICNS images", () => {
    const icoResult = withFixture(({ fixtureBuild }) => {
      mutateIcoEmbedded(join(fixtureBuild, "icon.ico"), 16, "crc");
    });
    expectVerifierFailure(icoResult);

    const icnsResult = withFixture(({ fixtureBuild }) => {
      mutateIcnsEmbedded(join(fixtureBuild, "icon.icns"), "ic11", "truncated-deflate");
    });
    expectVerifierFailure(icnsResult);
  });

  it("rejects missing Linux, ICO, and effective-1024 ICNS representations", () => {
    const linuxResult = withFixture(({ fixtureBuild }) => {
      rmSync(join(fixtureBuild, "icons", "256x256.png"));
    });
    expectVerifierFailure(linuxResult);

    const icoResult = withFixture(({ fixtureBuild }) => {
      removeIcoEntry(join(fixtureBuild, "icon.ico"), 256);
    });
    expectVerifierFailure(icoResult);

    const icnsResult = withFixture(({ fixtureBuild }) => {
      removeIcnsChunk(join(fixtureBuild, "icon.icns"), "ic10");
    });
    expectVerifierFailure(icnsResult);
  });

  const symlinkTest = symlinkCapability.available ? it : it.skip;
  symlinkTest(`rejects a symlinked representation (${symlinkCapability.reason})`, () => {
    const fixture = copyFixture();
    try {
      const target = join(fixture.fixtureBuild, "icons", "16x16.png");
      rmSync(target);
      symlinkSync("24x24.png", target);
      expectVerifierFailure(runVerifier(fixture.fixtureBuild, fixture.fixturePackage));
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects an incorrect package icon path", () => {
    const result = withFixture(({ fixturePackage }) => {
      const packageJson = JSON.parse(readFileSync(fixturePackage, "utf8"));
      packageJson.build.win.icon = "build/wrong.ico";
      writeFileSync(fixturePackage, `${JSON.stringify(packageJson, null, 2)}\n`);
    });
    expectVerifierFailure(result);
  });
});
