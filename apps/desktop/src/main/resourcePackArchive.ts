import {
  lstat,
  mkdir,
  open as openFile,
  realpath,
  rm,
  rmdir
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { open as openZip, type Entry, type ZipFile } from "yauzl";
import {
  CmsSignatureValidationError,
  verifyDetachedCmsSignature,
  type CmsPublisherAllowlist,
  type CmsSignatureVerification
} from "./cmsSignatureVerifier.js";
import {
  PipelinePathValidationError,
  validatePipelineRelativePath,
  validatePipelineRelativePathList
} from "./pipelinePathSecurity.js";
import type {
  ResourcePackManifestV1
} from "../shared/pipelineResources.js";
import {
  PipelineResourceValidationError,
  parseResourcePackManifestV1
} from "../shared/pipelineResources.js";

// Defaults intentionally bound disk, CPU, and RAM exposure. The staged
// win32-x64 Production OCR release contains 17,708 payload files and its signed
// manifest is 3,831,849 bytes. These remain fixed fail-closed limits with
// headroom for an equivalent rebuilt runtime, rather than accepting an
// unbounded archive or metadata payload.
export const RESOURCE_ARCHIVE_MAX_ENTRY_COUNT = 32_768;
export const RESOURCE_ARCHIVE_MAX_SINGLE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
export const RESOURCE_ARCHIVE_MAX_TOTAL_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;
export const RESOURCE_ARCHIVE_MAX_COMPRESSION_RATIO = 200;
export const RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
export const RESOURCE_ARCHIVE_MAX_CENTRAL_ENTRY_METADATA_BYTES = 16 * 1024;
export const RESOURCE_ARCHIVE_MAX_CENTRAL_METADATA_BYTES = 4 * 1024 * 1024;

export const DEFAULT_RESOURCE_ARCHIVE_POLICY = Object.freeze({
  maxEntryCount: RESOURCE_ARCHIVE_MAX_ENTRY_COUNT,
  maxSingleUncompressedBytes: RESOURCE_ARCHIVE_MAX_SINGLE_UNCOMPRESSED_BYTES,
  maxTotalUncompressedBytes: RESOURCE_ARCHIVE_MAX_TOTAL_UNCOMPRESSED_BYTES,
  maxCompressionRatio: RESOURCE_ARCHIVE_MAX_COMPRESSION_RATIO,
  metadataMemoryLimitBytes: RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES,
  maxCentralEntryMetadataBytes: RESOURCE_ARCHIVE_MAX_CENTRAL_ENTRY_METADATA_BYTES,
  maxCentralMetadataBytes: RESOURCE_ARCHIVE_MAX_CENTRAL_METADATA_BYTES
});

export type ResourcePackArchiveValidationCode =
  | "RESOURCE_ARCHIVE_INVALID"
  | "RESOURCE_ARCHIVE_ENTRY_COUNT_LIMIT"
  | "RESOURCE_ARCHIVE_SINGLE_SIZE_LIMIT"
  | "RESOURCE_ARCHIVE_TOTAL_SIZE_LIMIT"
  | "RESOURCE_ARCHIVE_COMPRESSION_RATIO_LIMIT"
  | "RESOURCE_ARCHIVE_ENTRY_METADATA_LIMIT"
  | "RESOURCE_ARCHIVE_TOTAL_METADATA_LIMIT"
  | "RESOURCE_ARCHIVE_ENTRY_TYPE_INVALID"
  | "RESOURCE_ARCHIVE_ENCRYPTED"
  | "RESOURCE_ARCHIVE_COMPRESSION_UNSUPPORTED"
  | "RESOURCE_ARCHIVE_ZIP64_UNSUPPORTED"
  | "RESOURCE_ARCHIVE_METADATA_MISSING"
  | "RESOURCE_ARCHIVE_METADATA_SIZE_LIMIT"
  | "RESOURCE_ARCHIVE_MANIFEST_MISMATCH"
  | "RESOURCE_ARCHIVE_DESTINATION_INVALID"
  | "RESOURCE_ARCHIVE_DESTINATION_EXISTS"
  | "RESOURCE_ARCHIVE_STREAM_SIZE_MISMATCH";

export class ResourcePackArchiveValidationError extends Error {
  readonly code: ResourcePackArchiveValidationCode;

  constructor(code: ResourcePackArchiveValidationCode) {
    super("Invalid resource pack archive");
    this.name = "ResourcePackArchiveValidationError";
    this.code = code;
  }
}

export type ResourcePackArchiveExtraction = {
  manifest: ResourcePackManifestV1;
  signer: CmsSignatureVerification;
  extractedFileCount: number;
};

export async function extractResourcePackArchive(
  archivePath: string,
  stagingRoot: string,
  publisherAllowlist: CmsPublisherAllowlist
): Promise<ResourcePackArchiveExtraction> {
  let zipFile: ZipFile | undefined;
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];

  try {
    const verifiedRoot = await verifyStagingRoot(stagingRoot);
    zipFile = await openArchive(archivePath);
    const centralDirectoryOffset = (
      zipFile as unknown as { readEntryCursor: number }
    ).readEntryCursor;
    const entries = await inspectCentralDirectory(zipFile);
    const manifestEntry = requireMetadataEntry(entries, manifestName);
    const signatureEntry = requireMetadataEntry(entries, signatureName);
    await validateLocalFileHeaders(
      zipFile,
      entries,
      centralDirectoryOffset
    );

    const manifestBytes = await readEntryBytes(zipFile, manifestEntry, true);
    const signatureBytes = await readEntryBytes(zipFile, signatureEntry, true);
    const signer = await verifyDetachedCmsSignature(
      manifestBytes,
      signatureBytes,
      publisherAllowlist
    );
    const manifest = parseManifest(manifestBytes);
    validateSignedManifestAgainstArchive(manifest, entries);
    await ensureDestinationsAvailable(verifiedRoot, entries);

    const extractionOrder = [
      manifestEntry,
      signatureEntry,
      ...entries.filter((entry) =>
        !entry.isDirectory
        && entry.path !== manifestName
        && entry.path !== signatureName
      ),
      ...entries.filter((entry) => entry.isDirectory)
    ];

    for (const inspected of extractionOrder) {
      if (inspected.isDirectory) {
        await ensureDirectory(
          verifiedRoot,
          inspected.path,
          createdDirectories
        );
        continue;
      }

      await extractFile(
        zipFile,
        inspected,
        verifiedRoot,
        createdFiles,
        createdDirectories
      );
    }

    return {
      manifest,
      signer,
      extractedFileCount: entries.filter((entry) => !entry.isDirectory).length
    };
  } catch (error) {
    await cleanupCreated(createdFiles, createdDirectories);
    if (isExpectedValidationError(error)) throw error;
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_INVALID");
  } finally {
    zipFile?.close();
  }
}

const manifestName = "resource-manifest.json";
const signatureName = "resource-manifest.p7s";
const windowsFileAttributeDirectory = 0x10;
const windowsFileAttributeReparsePoint = 0x400;
const dataDescriptorFlag = 0x8;
const utf8FileNameFlag = 0x800;
const localFileHeaderSignature = 0x04034b50;
const localFileHeaderFixedBytes = 30;
const dataDescriptorSignature = 0x08074b50;
const unsignedDataDescriptorBytes = 12;
const signedDataDescriptorBytes = 16;
const zip64ExtraFieldId = 0x0001;
const zip64MinimumVersion = 45;
const unixFileTypeMask = 0o170000;
const unixRegularFile = 0o100000;
const unixDirectory = 0o040000;

type InspectedEntry = {
  path: string;
  archiveName: string;
  rawFileName: Buffer;
  isDirectory: boolean;
  generalPurposeBitFlag: number;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  relativeOffsetOfLocalHeader: number;
};

async function verifyStagingRoot(stagingRoot: string): Promise<string> {
  try {
    const root = resolve(stagingRoot);
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_DESTINATION_INVALID");
    }
    const canonicalRoot = await realpath(root);
    if (!pathsAreEqual(root, canonicalRoot)) {
      throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_DESTINATION_INVALID");
    }
    return canonicalRoot;
  } catch (error) {
    if (error instanceof ResourcePackArchiveValidationError) throw error;
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_DESTINATION_INVALID");
  }
}

function openArchive(archivePath: string): Promise<ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    openZip(archivePath, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: false,
      validateEntrySizes: false,
      strictFileNames: true
    }, (error, zipFile) => {
      if (error !== null || zipFile === undefined) {
        rejectPromise(new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_INVALID"));
        return;
      }
      resolvePromise(zipFile);
    });
  });
}

function inspectCentralDirectory(zipFile: ZipFile): Promise<InspectedEntry[]> {
  if (zipFile.entryCount > RESOURCE_ARCHIVE_MAX_ENTRY_COUNT) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_ENTRY_COUNT_LIMIT");
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const inspected: InspectedEntry[] = [];
    let totalUncompressedBytes = 0;
    let totalCentralMetadataBytes = 0;
    let settled = false;

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };

    zipFile.once("error", rejectOnce);
    zipFile.on("entry", (entry: Entry) => {
      if (settled) return;
      try {
        rejectUnsupportedZip64Entry(entry);
        const centralMetadataBytes = entry.fileNameLength
          + entry.extraFieldLength
          + entry.fileCommentLength;
        if (centralMetadataBytes > RESOURCE_ARCHIVE_MAX_CENTRAL_ENTRY_METADATA_BYTES) {
          throw new ResourcePackArchiveValidationError(
            "RESOURCE_ARCHIVE_ENTRY_METADATA_LIMIT"
          );
        }
        totalCentralMetadataBytes += centralMetadataBytes;
        if (totalCentralMetadataBytes > RESOURCE_ARCHIVE_MAX_CENTRAL_METADATA_BYTES) {
          throw new ResourcePackArchiveValidationError(
            "RESOURCE_ARCHIVE_TOTAL_METADATA_LIMIT"
          );
        }
        const rawFileName = copyRawEntryName(entry);
        if (rawFileName.length !== entry.fileNameLength) throwArchiveInvalid();
        const name = decodeEntryName(rawFileName, entry.generalPurposeBitFlag);
        const isDirectory = name.endsWith("/");
        const canonicalPath = isDirectory ? name.slice(0, -1) : name;
        validatePipelineRelativePath(canonicalPath);
        validateEntryKind(entry, isDirectory);
        validateEntryLimits(entry);
        totalUncompressedBytes += entry.uncompressedSize;
        if (totalUncompressedBytes > RESOURCE_ARCHIVE_MAX_TOTAL_UNCOMPRESSED_BYTES) {
          throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_TOTAL_SIZE_LIMIT");
        }
        inspected.push({
          path: canonicalPath,
          archiveName: name,
          rawFileName,
          isDirectory,
          generalPurposeBitFlag: entry.generalPurposeBitFlag,
          compressionMethod: entry.compressionMethod,
          crc32: entry.crc32,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          relativeOffsetOfLocalHeader: entry.relativeOffsetOfLocalHeader
        });
        zipFile.readEntry();
      } catch (error) {
        rejectOnce(error);
      }
    });
    zipFile.once("end", () => {
      if (settled) return;
      try {
        if (inspected.length !== zipFile.entryCount) {
          throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_INVALID");
        }
        validatePipelineRelativePathList(inspected.map((entry) => entry.path));
        settled = true;
        resolvePromise(inspected);
      } catch (error) {
        rejectOnce(error);
      }
    });
    zipFile.readEntry();
  });
}

function copyRawEntryName(entry: Entry): Buffer {
  const rawName = (entry as unknown as { fileName: Buffer }).fileName;
  if (!Buffer.isBuffer(rawName)) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_INVALID");
  }
  return Buffer.from(rawName);
}

function decodeEntryName(rawName: Buffer, generalPurposeBitFlag: number): string {
  if ((generalPurposeBitFlag & utf8FileNameFlag) === 0) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_INVALID");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawName);
  } catch {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_INVALID");
  }
}

function rejectUnsupportedZip64Entry(entry: Entry): void {
  if (
    entry.versionNeededToExtract >= zip64MinimumVersion
    || entry.extraFields.some((field) => field.id === zip64ExtraFieldId)
    || entry.compressedSize >= 0xffffffff
    || entry.uncompressedSize >= 0xffffffff
  ) {
    throw new ResourcePackArchiveValidationError(
      "RESOURCE_ARCHIVE_ZIP64_UNSUPPORTED"
    );
  }
}

async function validateLocalFileHeaders(
  zipFile: ZipFile,
  entries: readonly InspectedEntry[],
  centralDirectoryOffset: number
): Promise<void> {
  const archiveReader = getArchiveReader(zipFile);
  const localOffsets = entries
    .map((entry) => entry.relativeOffsetOfLocalHeader)
    .sort((left, right) => left - right);

  if (
    !Number.isSafeInteger(centralDirectoryOffset)
    || centralDirectoryOffset < 0
    || centralDirectoryOffset > zipFile.fileSize
  ) {
    throwArchiveInvalid();
  }

  for (const entry of entries) {
    const nextLocalOffset = localOffsets.find(
      (offset) => offset > entry.relativeOffsetOfLocalHeader
    );
    const structuralBoundary = nextLocalOffset === undefined
      ? centralDirectoryOffset
      : Math.min(nextLocalOffset, centralDirectoryOffset);
    await validateLocalFileHeader(
      archiveReader,
      zipFile.fileSize,
      structuralBoundary,
      entry
    );
  }
}

async function validateLocalFileHeader(
  archiveReader: ArchiveReader,
  archiveSize: number,
  structuralBoundary: number,
  central: InspectedEntry
): Promise<void> {
  const offset = central.relativeOffsetOfLocalHeader;
  if (
    !Number.isSafeInteger(offset)
    || offset < 0
    || offset + localFileHeaderFixedBytes > archiveSize
  ) {
    throwArchiveInvalid();
  }

  const fixedHeader = Buffer.alloc(localFileHeaderFixedBytes);
  await readExactly(archiveReader, fixedHeader, offset);
  if (fixedHeader.readUInt32LE(0) !== localFileHeaderSignature) {
    throwArchiveInvalid();
  }

  const localVersionNeeded = fixedHeader.readUInt16LE(4);
  const localFlags = fixedHeader.readUInt16LE(6);
  const localCompressionMethod = fixedHeader.readUInt16LE(8);
  const localCrc32 = fixedHeader.readUInt32LE(14);
  const localCompressedSize = fixedHeader.readUInt32LE(18);
  const localUncompressedSize = fixedHeader.readUInt32LE(22);
  const localNameLength = fixedHeader.readUInt16LE(26);
  const localExtraLength = fixedHeader.readUInt16LE(28);

  if (localVersionNeeded >= zip64MinimumVersion) {
    throw new ResourcePackArchiveValidationError(
      "RESOURCE_ARCHIVE_ZIP64_UNSUPPORTED"
    );
  }
  if (
    localFlags !== central.generalPurposeBitFlag
    || localCompressionMethod !== central.compressionMethod
    || localNameLength + localExtraLength
      > RESOURCE_ARCHIVE_MAX_CENTRAL_ENTRY_METADATA_BYTES
  ) {
    throwArchiveInvalid();
  }

  const localName = Buffer.alloc(localNameLength);
  await readExactly(
    archiveReader,
    localName,
    offset + localFileHeaderFixedBytes
  );
  const decodedLocalName = decodeEntryName(localName, localFlags);
  if (
    !localName.equals(central.rawFileName)
    || decodedLocalName !== central.archiveName
  ) {
    throwArchiveInvalid();
  }

  const localExtra = Buffer.alloc(localExtraLength);
  await readExactly(
    archiveReader,
    localExtra,
    offset + localFileHeaderFixedBytes + localNameLength
  );
  rejectUnsupportedLocalExtra(localExtra);

  const hasDataDescriptor = (localFlags & dataDescriptorFlag) !== 0;
  if (hasDataDescriptor) {
    if (
      localCrc32 !== 0
      || localCompressedSize !== 0
      || localUncompressedSize !== 0
    ) {
      throwArchiveInvalid();
    }
  } else if (
    localCrc32 !== central.crc32
    || localCompressedSize !== central.compressedSize
    || localUncompressedSize !== central.uncompressedSize
  ) {
    throwArchiveInvalid();
  }

  const dataStart = offset
    + localFileHeaderFixedBytes
    + localNameLength
    + localExtraLength;
  if (
    !Number.isSafeInteger(dataStart)
    || dataStart > archiveSize
    || dataStart > structuralBoundary
    || central.compressedSize > structuralBoundary - dataStart
  ) {
    throwArchiveInvalid();
  }

  if (hasDataDescriptor) {
    await validateDataDescriptor(
      archiveReader,
      dataStart + central.compressedSize,
      structuralBoundary,
      central
    );
  }
}

function rejectUnsupportedLocalExtra(extra: Buffer): void {
  let offset = 0;
  while (offset < extra.length) {
    if (extra.length - offset < 4) throwArchiveInvalid();
    const fieldId = extra.readUInt16LE(offset);
    const fieldSize = extra.readUInt16LE(offset + 2);
    const nextOffset = offset + 4 + fieldSize;
    if (nextOffset > extra.length) throwArchiveInvalid();
    if (fieldId === zip64ExtraFieldId) {
      throw new ResourcePackArchiveValidationError(
        "RESOURCE_ARCHIVE_ZIP64_UNSUPPORTED"
      );
    }
    offset = nextOffset;
  }
}

async function validateDataDescriptor(
  archiveReader: ArchiveReader,
  descriptorOffset: number,
  structuralBoundary: number,
  central: InspectedEntry
): Promise<void> {
  const unsignedCandidate = Buffer.alloc(unsignedDataDescriptorBytes);
  await readExactlyBefore(
    archiveReader,
    unsignedCandidate,
    descriptorOffset,
    structuralBoundary
  );
  if (descriptorValuesMatch(unsignedCandidate, 0, central)) return;

  if (unsignedCandidate.readUInt32LE(0) !== dataDescriptorSignature) {
    throwArchiveInvalid();
  }

  const signedCandidate = Buffer.alloc(signedDataDescriptorBytes);
  unsignedCandidate.copy(signedCandidate);
  await readExactlyBefore(
    archiveReader,
    signedCandidate.subarray(unsignedDataDescriptorBytes),
    descriptorOffset + unsignedDataDescriptorBytes,
    structuralBoundary
  );

  if (descriptorValuesMatch(signedCandidate, 4, central)) return;
  throwArchiveInvalid();
}

function descriptorValuesMatch(
  descriptor: Buffer,
  valueOffset: number,
  central: InspectedEntry
): boolean {
  return descriptor.readUInt32LE(valueOffset) === central.crc32
    && descriptor.readUInt32LE(valueOffset + 4) === central.compressedSize
    && descriptor.readUInt32LE(valueOffset + 8) === central.uncompressedSize;
}

async function readExactlyBefore(
  archiveReader: ArchiveReader,
  destination: Buffer,
  position: number,
  structuralBoundary: number
): Promise<void> {
  if (
    !Number.isSafeInteger(position)
    || position < 0
    || destination.length > structuralBoundary - position
  ) {
    throwArchiveInvalid();
  }
  await readExactly(archiveReader, destination, position);
}

async function readExactly(
  archiveReader: ArchiveReader,
  destination: Buffer,
  position: number
): Promise<void> {
  let offset = 0;
  while (offset < destination.length) {
    const bytesRead = await readArchive(
      archiveReader,
      destination,
      offset,
      destination.length - offset,
      position + offset
    );
    if (bytesRead === 0) throwArchiveInvalid();
    offset += bytesRead;
  }
}

type ArchiveReader = {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | null, bytesRead: number) => void
  ): void;
};

function getArchiveReader(zipFile: ZipFile): ArchiveReader {
  const reader = (zipFile as unknown as { reader?: ArchiveReader }).reader;
  if (reader === undefined || typeof reader.read !== "function") {
    throwArchiveInvalid();
  }
  return reader;
}

function readArchive(
  archiveReader: ArchiveReader,
  destination: Buffer,
  offset: number,
  length: number,
  position: number
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    archiveReader.read(
      destination,
      offset,
      length,
      position,
      (error, bytesRead) => {
        if (error !== null) {
          rejectPromise(new ResourcePackArchiveValidationError(
            "RESOURCE_ARCHIVE_INVALID"
          ));
          return;
        }
        resolvePromise(bytesRead);
      }
    );
  });
}

function validateEntryKind(entry: Entry, isDirectory: boolean): void {
  const hostSystem = entry.versionMadeBy >>> 8;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = unixMode & unixFileTypeMask;
  const dosAttributes = entry.externalFileAttributes & 0xffff;

  if ((dosAttributes & windowsFileAttributeReparsePoint) !== 0) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_ENTRY_TYPE_INVALID");
  }
  if (hostSystem === 3 && unixType !== 0) {
    const expectedType = isDirectory ? unixDirectory : unixRegularFile;
    if (unixType !== expectedType) {
      throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_ENTRY_TYPE_INVALID");
    }
  }
  if (!isDirectory && (dosAttributes & windowsFileAttributeDirectory) !== 0) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_ENTRY_TYPE_INVALID");
  }
  if (isDirectory && (entry.compressedSize !== 0 || entry.uncompressedSize !== 0)) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_ENTRY_TYPE_INVALID");
  }
}

function validateEntryLimits(entry: Entry): void {
  if (entry.isEncrypted()) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_ENCRYPTED");
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_COMPRESSION_UNSUPPORTED");
  }
  if (entry.uncompressedSize > RESOURCE_ARCHIVE_MAX_SINGLE_UNCOMPRESSED_BYTES) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_SINGLE_SIZE_LIMIT");
  }

  const ratio = entry.uncompressedSize === 0
    ? 0
    : entry.uncompressedSize / entry.compressedSize;
  if (!Number.isFinite(ratio) || ratio > RESOURCE_ARCHIVE_MAX_COMPRESSION_RATIO) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_COMPRESSION_RATIO_LIMIT");
  }
}

function requireMetadataEntry(
  entries: readonly InspectedEntry[],
  name: string
): InspectedEntry {
  const entry = entries.find((candidate) => candidate.path === name && !candidate.isDirectory);
  if (entry === undefined) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_METADATA_MISSING");
  }
  if (entry.uncompressedSize > RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_METADATA_SIZE_LIMIT");
  }
  return entry;
}

async function readEntryBytes(
  zipFile: ZipFile,
  entry: InspectedEntry,
  metadata: boolean
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let actualBytes = 0;
  const stream = await openEntryStream(zipFile, entry);

  try {
    for await (const chunkValue of stream) {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      actualBytes += chunk.length;
      if (actualBytes > entry.uncompressedSize) {
        stream.destroy();
        throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_STREAM_SIZE_MISMATCH");
      }
      if (actualBytes > RESOURCE_ARCHIVE_MAX_SINGLE_UNCOMPRESSED_BYTES) {
        stream.destroy();
        throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_SINGLE_SIZE_LIMIT");
      }
      if (metadata && actualBytes > RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES) {
        stream.destroy();
        throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_METADATA_SIZE_LIMIT");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ResourcePackArchiveValidationError) throw error;
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_INVALID");
  }

  if (actualBytes !== entry.uncompressedSize) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_STREAM_SIZE_MISMATCH");
  }
  return Buffer.concat(chunks);
}

function openEntryStream(zipFile: ZipFile, entry: InspectedEntry): Promise<NodeJS.ReadableStream & {
  destroy(error?: Error): void;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    zipFile.openReadStream(toYauzlStreamEntry(entry), (error, stream) => {
      if (error !== null || stream === undefined) {
        rejectPromise(new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_INVALID"));
        return;
      }
      resolvePromise(stream);
    });
  });
}

function toYauzlStreamEntry(entry: InspectedEntry): Entry {
  return {
    generalPurposeBitFlag: entry.generalPurposeBitFlag,
    compressionMethod: entry.compressionMethod,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    relativeOffsetOfLocalHeader: entry.relativeOffsetOfLocalHeader,
    isEncrypted: () => (entry.generalPurposeBitFlag & 0x1) !== 0
  } as unknown as Entry;
}

function parseManifest(manifestBytes: Uint8Array): ResourcePackManifestV1 {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new PipelineResourceValidationError(
      "PIPELINE_RESOURCE_INVALID_MANIFEST",
      "Invalid resource pack manifest"
    );
  }
  return parseResourcePackManifestV1(decoded);
}

function validateSignedManifestAgainstArchive(
  manifest: ResourcePackManifestV1,
  entries: readonly InspectedEntry[]
): void {
  const manifestPaths = validatePipelineRelativePathList(
    manifest.files.map((file) => file.relativePath)
  );
  validatePipelineRelativePathList(manifest.licenseFiles);
  const manifestByPath = new Map(
    manifest.files.map((file) => [file.relativePath, file])
  );
  if (manifest.licenseFiles.some((path) => !manifestByPath.has(path))) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_MANIFEST_MISMATCH");
  }

  const payloadEntries = entries.filter((entry) =>
    !entry.isDirectory
    && entry.path !== manifestName
    && entry.path !== signatureName
  );
  const payloadPaths = payloadEntries.map((entry) => entry.path);
  if (
    payloadPaths.length !== manifestPaths.length
    || payloadPaths.some((path) => !manifestByPath.has(path))
  ) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_MANIFEST_MISMATCH");
  }
  for (const entry of payloadEntries) {
    if (manifestByPath.get(entry.path)?.byteSize !== entry.uncompressedSize) {
      throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_MANIFEST_MISMATCH");
    }
  }
}

async function ensureDestinationsAvailable(
  stagingRoot: string,
  entries: readonly InspectedEntry[]
): Promise<void> {
  for (const entry of entries) {
    const outputPath = resolveOutputPath(stagingRoot, entry.path);
    try {
      await lstat(outputPath);
      throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_DESTINATION_EXISTS");
    } catch (error) {
      if (error instanceof ResourcePackArchiveValidationError) throw error;
      if (!isMissingPathError(error)) {
        throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_DESTINATION_INVALID");
      }
    }
  }
}

async function extractFile(
  zipFile: ZipFile,
  inspected: InspectedEntry,
  stagingRoot: string,
  createdFiles: string[],
  createdDirectories: string[]
): Promise<void> {
  const parentPath = dirname(inspected.path).replaceAll("\\", "/");
  if (parentPath !== ".") {
    await ensureDirectory(stagingRoot, parentPath, createdDirectories);
  }
  const outputPath = resolveOutputPath(stagingRoot, inspected.path);
  let handle;
  try {
    handle = await openFile(outputPath, "wx");
    createdFiles.push(outputPath);
  } catch {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_DESTINATION_EXISTS");
  }

  let actualBytes = 0;
  try {
    const stream = await openEntryStream(zipFile, inspected);
    for await (const chunkValue of stream) {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      actualBytes += chunk.length;
      if (
        actualBytes > inspected.uncompressedSize
        || actualBytes > RESOURCE_ARCHIVE_MAX_SINGLE_UNCOMPRESSED_BYTES
      ) {
        stream.destroy();
        throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_STREAM_SIZE_MISMATCH");
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset);
        if (bytesWritten === 0) {
          throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_INVALID");
        }
        offset += bytesWritten;
      }
    }
    if (actualBytes !== inspected.uncompressedSize) {
      throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_STREAM_SIZE_MISMATCH");
    }
  } finally {
    await handle.close();
  }
}

async function ensureDirectory(
  stagingRoot: string,
  relativeDirectory: string,
  createdDirectories: string[]
): Promise<void> {
  let current = stagingRoot;
  for (const segment of relativeDirectory.split("/")) {
    current = resolve(current, segment);
    resolveOutputPath(stagingRoot, relative(stagingRoot, current).replaceAll("\\", "/"));
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_DESTINATION_INVALID");
      }
      const canonical = await realpath(current);
      if (!isWithinRoot(stagingRoot, canonical)) {
        throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_DESTINATION_INVALID");
      }
    } catch (error) {
      if (error instanceof ResourcePackArchiveValidationError) throw error;
      if (!isMissingPathError(error)) {
        throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_DESTINATION_INVALID");
      }
      try {
        await mkdir(current);
        createdDirectories.push(current);
      } catch {
        throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_DESTINATION_EXISTS");
      }
    }
  }
}

function resolveOutputPath(stagingRoot: string, archivePath: string): string {
  validatePipelineRelativePath(archivePath);
  const outputPath = resolve(stagingRoot, ...archivePath.split("/"));
  if (!isWithinRoot(stagingRoot, outputPath)) {
    throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_DESTINATION_INVALID");
  }
  return outputPath;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot.length > 0
    && !isAbsolute(pathFromRoot)
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`);
}

async function cleanupCreated(
  createdFiles: readonly string[],
  createdDirectories: readonly string[]
): Promise<void> {
  for (const filePath of [...createdFiles].reverse()) {
    try {
      await rm(filePath, { force: true });
    } catch {
      // Never broaden cleanup beyond files created by this invocation.
    }
  }
  for (const directoryPath of [...createdDirectories].reverse()) {
    try {
      await rmdir(directoryPath);
    } catch {
      // A non-empty directory may have been changed concurrently; keep it.
    }
  }
}

function isExpectedValidationError(error: unknown): boolean {
  return error instanceof ResourcePackArchiveValidationError
    || error instanceof PipelinePathValidationError
    || error instanceof PipelineResourceValidationError
    || error instanceof CmsSignatureValidationError;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function pathsAreEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function throwArchiveInvalid(): never {
  throw new ResourcePackArchiveValidationError("RESOURCE_ARCHIVE_INVALID");
}
