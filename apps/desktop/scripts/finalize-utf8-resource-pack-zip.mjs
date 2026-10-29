import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const endOfCentralDirectorySignature = 0x06054b50;
const centralDirectorySignature = 0x02014b50;
const localFileHeaderSignature = 0x04034b50;
const utf8FileNameFlag = 0x800;
const endOfCentralDirectoryMinimumBytes = 22;
const maximumZipCommentBytes = 0xffff;
const centralDirectoryFixedBytes = 46;
const localFileHeaderFixedBytes = 30;

/**
 * Mark every pre-existing ZIP filename as UTF-8 after validating that the
 * archive is non-ZIP64 and every raw filename already decodes as UTF-8.
 *
 * ZIP writers commonly omit bit 11 for ASCII-only names. TRIO intentionally
 * rejects that ambiguity, so this changes only the encoding declaration in
 * matching local and central headers; it never changes payload bytes.
 */
export async function finalizeUtf8ResourcePackZip(archiveInput) {
  const archivePath = resolve(archiveInput);
  const handle = await open(archivePath, "r+");
  try {
    const size = (await handle.stat()).size;
    const eocd = await findEndOfCentralDirectory(handle, size);
    const entryCount = eocd.readUInt16LE(10);
    const centralDirectorySize = eocd.readUInt32LE(12);
    const centralDirectoryOffset = eocd.readUInt32LE(16);
    if (
      entryCount === 0xffff
      || centralDirectorySize === 0xffffffff
      || centralDirectoryOffset === 0xffffffff
    ) {
      throw new Error("ZIP64 resource packs are unsupported");
    }
    if (centralDirectoryOffset + centralDirectorySize > size) {
      throw new Error("ZIP central directory exceeds the archive");
    }

    let centralOffset = centralDirectoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
      const central = await readExactly(handle, centralOffset, centralDirectoryFixedBytes);
      if (central.readUInt32LE(0) !== centralDirectorySignature) {
        throw new Error("ZIP central directory entry is invalid");
      }
      const flag = central.readUInt16LE(8);
      const nameLength = central.readUInt16LE(28);
      const extraLength = central.readUInt16LE(30);
      const commentLength = central.readUInt16LE(32);
      const localOffset = central.readUInt32LE(42);
      const name = await readExactly(handle, centralOffset + centralDirectoryFixedBytes, nameLength);
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(name);
      } catch {
        throw new Error("ZIP filename is not valid UTF-8");
      }
      const local = await readExactly(handle, localOffset, localFileHeaderFixedBytes);
      if (local.readUInt32LE(0) !== localFileHeaderSignature || local.readUInt16LE(6) !== flag) {
        throw new Error("ZIP local header does not match the central directory");
      }
      await writeUInt16(handle, centralOffset + 8, flag | utf8FileNameFlag);
      await writeUInt16(handle, localOffset + 6, flag | utf8FileNameFlag);
      centralOffset += centralDirectoryFixedBytes + nameLength + extraLength + commentLength;
    }
    if (centralOffset !== centralDirectoryOffset + centralDirectorySize) {
      throw new Error("ZIP central directory length is inconsistent");
    }
  } finally {
    await handle.close();
  }
}

async function findEndOfCentralDirectory(handle, size) {
  const tailLength = Math.min(size, endOfCentralDirectoryMinimumBytes + maximumZipCommentBytes);
  const tailOffset = size - tailLength;
  const tail = await readExactly(handle, tailOffset, tailLength);
  for (let offset = tail.length - endOfCentralDirectoryMinimumBytes; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== endOfCentralDirectorySignature) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + endOfCentralDirectoryMinimumBytes + commentLength === tail.length) {
      return tail.subarray(offset, offset + endOfCentralDirectoryMinimumBytes);
    }
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

async function readExactly(handle, position, length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, position + offset);
    if (bytesRead <= 0) throw new Error("Unexpected end of ZIP archive");
    offset += bytesRead;
  }
  return bytes;
}

async function writeUInt16(handle, position, value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value, 0);
  const { bytesWritten } = await handle.write(bytes, 0, bytes.length, position);
  if (bytesWritten !== bytes.length) throw new Error("Unable to update ZIP filename encoding flag");
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const archivePath = process.argv[2];
  if (!archivePath) throw new Error("Usage: <resource-pack.zip>");
  await finalizeUtf8ResourcePackZip(archivePath);
}
