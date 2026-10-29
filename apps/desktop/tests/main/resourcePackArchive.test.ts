import { deflateRawSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CmsSignatureValidationError,
  type CmsSignatureVerification
} from "../../src/main/cmsSignatureVerifier";
import {
  PipelinePathValidationError
} from "../../src/main/pipelinePathSecurity";
import {
  PipelineResourceValidationError,
  type ManifestFileEntryV1
} from "../../src/shared/pipelineResources";
import {
  RESOURCE_ARCHIVE_MAX_ENTRY_COUNT,
  RESOURCE_ARCHIVE_MAX_CENTRAL_ENTRY_METADATA_BYTES,
  RESOURCE_ARCHIVE_MAX_CENTRAL_METADATA_BYTES,
  RESOURCE_ARCHIVE_MAX_SINGLE_UNCOMPRESSED_BYTES,
  RESOURCE_ARCHIVE_MAX_TOTAL_UNCOMPRESSED_BYTES,
  RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES,
  ResourcePackArchiveValidationError,
  extractResourcePackArchive,
  type ResourcePackArchiveValidationCode
} from "../../src/main/resourcePackArchive";

const cmsState = vi.hoisted(() => ({
  useRealCms: false,
  manifestBytes: undefined as Uint8Array | undefined,
  signatureBytes: undefined as Uint8Array | undefined
}));

vi.mock("../../src/main/cmsSignatureVerifier", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/cmsSignatureVerifier")>();
  return {
    ...actual,
    verifyDetachedCmsSignature: async (
      manifestBytes: Uint8Array,
      signatureBytes: Uint8Array,
      allowlist: { current: string; next?: string }
    ) => {
      cmsState.manifestBytes = Uint8Array.from(manifestBytes);
      cmsState.signatureBytes = Uint8Array.from(signatureBytes);
      if (cmsState.useRealCms) {
        return actual.verifyDetachedCmsSignature(manifestBytes, signatureBytes, allowlist);
      }
      return fakeSigner;
    }
  };
});

const manifestName = "resource-manifest.json";
const signatureName = "resource-manifest.p7s";
const allowlist = { current: "AA".repeat(32) };
const fakeSigner: CmsSignatureVerification = {
  signerThumbprint: "AA".repeat(32),
  matchedPublisher: "current"
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  cmsState.useRealCms = false;
  cmsState.manifestBytes = undefined;
  cmsState.signatureBytes = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("safe resource pack archive extraction", () => {
  it("extracts a valid stored/deflated pack only after validating its signed manifest", async () => {
    const fixture = await createArchive(validEntries());

    await expect(extractResourcePackArchive(
      fixture.archivePath,
      fixture.stagingRoot,
      allowlist
    )).resolves.toMatchObject({
      manifest: {
        schemaVersion: 1,
        resourceId: "ocr-ja",
        files: [
          expect.objectContaining({ relativePath: "models/model.bin", byteSize: 5 }),
          expect.objectContaining({ relativePath: "licenses/LICENSE.txt", byteSize: 7 })
        ]
      },
      signer: fakeSigner,
      extractedFileCount: 4
    });
    await expect(readFile(join(fixture.stagingRoot, "models", "model.bin"), "utf8"))
      .resolves.toBe("model");
    await expect(readFile(join(fixture.stagingRoot, "licenses", "LICENSE.txt"), "utf8"))
      .resolves.toBe("license");
  });

  it("passes the archive manifest and P7S bytes to CMS byte-for-byte unchanged", async () => {
    const entries = validEntries();
    const expectedManifest = Buffer.from(
      entries.find((entry) => entry.name === manifestName)!.data
    );
    const expectedSignature = Buffer.from(
      entries.find((entry) => entry.name === signatureName)!.data
    );
    const fixture = await createArchive(entries);

    await extractResourcePackArchive(fixture.archivePath, fixture.stagingRoot, allowlist);

    expect(Buffer.from(cmsState.manifestBytes ?? [])).toEqual(expectedManifest);
    expect(Buffer.from(cmsState.signatureBytes ?? [])).toEqual(expectedSignature);
  });

  it.each([
    ["zip slip", "../outside.bin"],
    ["rooted path", "/outside.bin"],
    ["drive-rooted path", "C:\\outside.bin"],
    ["drive-relative path", "C:outside.bin"],
    ["UNC path", "\\\\server\\share\\outside.bin"]
  ])("rejects %s through A2 before extracting an earlier payload", async (_reason, unsafePath) => {
    const fixture = await createArchive([
      ...validEntries(),
      zipEntry(unsafePath, "attack")
    ]);

    await expectPathFailure(fixture, "PIPELINE_PATH_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects duplicate central-directory paths before extraction", async () => {
    const fixture = await createArchive([
      ...validEntries(),
      zipEntry("models/model.bin", "second")
    ]);

    await expectPathFailure(fixture, "PIPELINE_PATH_DUPLICATE");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects case-colliding central-directory paths before extraction", async () => {
    const fixture = await createArchive([
      ...validEntries(),
      zipEntry("MODELS/MODEL.BIN", "second")
    ]);

    await expectPathFailure(fixture, "PIPELINE_PATH_CASE_COLLISION");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects an entry-count bomb from the central directory", async () => {
    const entries = validEntries();
    for (let index = entries.length; index <= RESOURCE_ARCHIVE_MAX_ENTRY_COUNT; index += 1) {
      entries.push(zipEntry(`padding/${index}.bin`, ""));
    }
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_ENTRY_COUNT_LIMIT");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a single-entry declared-size bomb before extraction", async () => {
    const fixture = await createArchive([
      ...validEntries(),
      zipEntry("oversized.bin", "", {
        declaredUncompressedSize: RESOURCE_ARCHIVE_MAX_SINGLE_UNCOMPRESSED_BYTES + 1
      })
    ]);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_SINGLE_SIZE_LIMIT");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a total declared-size bomb before extraction", async () => {
    const eachSize = RESOURCE_ARCHIVE_MAX_SINGLE_UNCOMPRESSED_BYTES;
    const fixture = await createArchive([
      ...validEntries(),
      ...Array.from({ length: Math.floor(RESOURCE_ARCHIVE_MAX_TOTAL_UNCOMPRESSED_BYTES / eachSize) + 1 },
        (_value, index) => zipEntry(`large/${index}.bin`, "", {
          declaredCompressedSize: Math.ceil(eachSize / 200),
          declaredUncompressedSize: eachSize
        }))
    ]);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_TOTAL_SIZE_LIMIT");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a compression-ratio bomb before extraction", async () => {
    const fixture = await createArchive([
      ...validEntries(),
      zipEntry("ratio.bin", "", {
        declaredCompressedSize: 1,
        declaredUncompressedSize: 201
      })
    ]);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_COMPRESSION_RATIO_LIMIT");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects an encrypted entry flag before extraction", async () => {
    const fixture = await createArchive([
      ...validEntries(),
      zipEntry("encrypted.bin", "payload", { flags: 0x1 })
    ]);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_ENCRYPTED");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects encryption present only in the local header", async () => {
    const entries = validEntries();
    entries.find((entry) => entry.name === "models/model.bin")!.localFlags = 0x1;
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    expect(cmsState.manifestBytes).toBeUndefined();
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects an invalid local file-header signature", async () => {
    const entries = validEntries();
    entries.find((entry) => entry.name === "models/model.bin")!
      .localSignature = 0x01020304;
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    expect(cmsState.manifestBytes).toBeUndefined();
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a UTF-8 flag present only in the central directory", async () => {
    const entries = validEntries();
    entries.find((entry) => entry.name === "models/model.bin")!.localUtf8 = false;
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a local compression method that differs from the central directory", async () => {
    const entries = validEntries();
    entries.find((entry) => entry.name === "models/model.bin")!
      .localCompressionMethod = 0;
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects local filename bytes that differ from the central directory", async () => {
    const entries = validEntries();
    entries.find((entry) => entry.name === "models/model.bin")!
      .localName = "models/model.bim";
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a local CRC that differs from the central directory", async () => {
    const entries = validEntries();
    entries.find((entry) => entry.name === "models/model.bin")!
      .localCrc32 = 0x12345678;
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a local declared size that differs from the central directory", async () => {
    const entries = validEntries();
    entries.find((entry) => entry.name === "models/model.bin")!
      .localUncompressedSize = 6;
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a local compressed size that differs from the central directory", async () => {
    const entries = validEntries();
    entries.find((entry) => entry.name === "models/model.bin")!
      .localCompressedSize = 1;
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it.each([true, false])(
    "accepts a valid non-ZIP64 data descriptor (signature: %s)",
    async (signature) => {
      const entries = validEntries();
      enableDataDescriptor(
        entries.find((entry) => entry.name === "models/model.bin")!,
        { signature }
      );
      const fixture = await createArchive(entries);

      await expect(extractResourcePackArchive(
        fixture.archivePath,
        fixture.stagingRoot,
        allowlist
      )).resolves.toMatchObject({ extractedFileCount: 4 });
    }
  );

  it.each([
    ["unsigned", false],
    ["signed", true]
  ] as const)(
    "accepts a valid %s descriptor when the actual payload CRC equals the signature marker",
    async (_form, signature) => {
      const entries = signatureMarkerCrcEntries();
      const model = entries.find((entry) => entry.name === "models/model.bin")!;
      expect(crc32(model.data)).toBe(0x08074b50);
      enableDataDescriptor(model, { signature });
      const fixture = await createArchive(entries);

      await expect(extractResourcePackArchive(
        fixture.archivePath,
        fixture.stagingRoot,
        allowlist
      )).resolves.toMatchObject({ extractedFileCount: 4 });
    }
  );

  it("rejects signature-marker descriptor fields shifted into the unsigned positions", async () => {
    const entries = signatureMarkerCrcEntries();
    enableDataDescriptor(
      entries.find((entry) => entry.name === "models/model.bin")!,
      {
        signature: true,
        crc32: 4,
        compressedSize: 0x08074b50,
        uncompressedSize: 4
      }
    );
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects bit 3 when the required data descriptor is absent", async () => {
    const entries = validEntries();
    const model = entries.find((entry) => entry.name === "models/model.bin")!;
    enableDataDescriptor(model);
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a truncated data descriptor before the central directory", async () => {
    const entries = validEntries();
    const license = entries.find((entry) => entry.name === "licenses/LICENSE.txt")!;
    enableDataDescriptor(license, { signature: true, truncateToBytes: 8 });
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects contradictory nonzero local CRC/size fields when bit 3 is set", async () => {
    const entries = validEntries();
    const model = entries.find((entry) => entry.name === "models/model.bin")!;
    enableDataDescriptor(model, { signature: true });
    model.localCrc32 = 1;
    model.localCompressedSize = 1;
    model.localUncompressedSize = 1;
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a data-descriptor CRC mismatch", async () => {
    const entries = validEntries();
    enableDataDescriptor(
      entries.find((entry) => entry.name === "models/model.bin")!,
      { signature: true, crc32: 0x12345678 }
    );
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a data-descriptor compressed-size mismatch", async () => {
    const entries = validEntries();
    enableDataDescriptor(
      entries.find((entry) => entry.name === "models/model.bin")!,
      { signature: false, compressedSize: 1 }
    );
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a data-descriptor uncompressed-size mismatch", async () => {
    const entries = validEntries();
    enableDataDescriptor(
      entries.find((entry) => entry.name === "models/model.bin")!,
      { signature: true, uncompressedSize: 1 }
    );
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a descriptor that overlaps the next local header", async () => {
    const entries = validEntries();
    enableDataDescriptor(
      entries.find((entry) => entry.name === "models/model.bin")!,
      { signature: true, truncateToBytes: 8 }
    );
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects ZIP64 extra metadata instead of guessing a descriptor width", async () => {
    const entries = validEntries();
    entries.find((entry) => entry.name === "models/model.bin")!.centralExtra =
      Buffer.from([0x01, 0x00, 0x00, 0x00]);
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_ZIP64_UNSUPPORTED");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a legacy-encoded filename without the explicit UTF-8 flag", async () => {
    const entries = validEntries();
    entries.find((entry) => entry.name === "models/model.bin")!.utf8 = false;
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects Unix symlink metadata before extraction", async () => {
    const fixture = await createArchive([
      ...validEntries(),
      zipEntry("link", "models/model.bin", {
        versionMadeBy: (3 << 8) | 20,
        externalFileAttributes: 0o120777 << 16
      })
    ]);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_ENTRY_TYPE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects Windows reparse metadata before extraction", async () => {
    const fixture = await createArchive([
      ...validEntries(),
      zipEntry("junction", "", {
        externalFileAttributes: 0x400
      })
    ]);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_ENTRY_TYPE_INVALID");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects an unsupported compression method before extraction", async () => {
    const fixture = await createArchive([
      ...validEntries(),
      zipEntry("bzip.bin", "payload", { compressionMethod: 12 })
    ]);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_COMPRESSION_UNSUPPORTED");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects one central-directory entry whose retained metadata exceeds its cap", async () => {
    const entries = validEntries();
    entries.find((entry) => entry.name === "payload/")!.centralExtra =
      Buffer.alloc(RESOURCE_ARCHIVE_MAX_CENTRAL_ENTRY_METADATA_BYTES);
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_ENTRY_METADATA_LIMIT");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects aggregate retained central-directory metadata above its cap", async () => {
    const paddingEntries = Array.from({
      length: Math.floor(
        RESOURCE_ARCHIVE_MAX_CENTRAL_METADATA_BYTES
          / RESOURCE_ARCHIVE_MAX_CENTRAL_ENTRY_METADATA_BYTES
      ) + 1
    }, (_value, index) => {
      const name = `metadata-padding/${index}/`;
      return zipEntry(name, "", {
        centralComment: Buffer.alloc(
          RESOURCE_ARCHIVE_MAX_CENTRAL_ENTRY_METADATA_BYTES
            - Buffer.byteLength(name)
        )
      });
    });
    const fixture = await createArchive([...validEntries(), ...paddingEntries]);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_TOTAL_METADATA_LIMIT");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it.each([manifestName, signatureName])("rejects a missing %s entry", async (missingName) => {
    const fixture = await createArchive(
      validEntries().filter((entry) => entry.name !== missingName)
    );

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_METADATA_MISSING");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it.each([manifestName, signatureName])("rejects an oversized %s entry in memory", async (oversizedName) => {
    const fixture = await createArchive(validEntries().map((entry) =>
      entry.name === oversizedName
        ? {
            ...entry,
            declaredCompressedSize: Math.ceil(
              (RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES + 1) / 200
            ),
            declaredUncompressedSize: RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES + 1
          }
        : entry
    ));

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_METADATA_SIZE_LIMIT");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects invalid CMS before extracting any archive entry", async () => {
    const fixture = await createArchive(validEntries());
    cmsState.useRealCms = true;

    await expect(extractResourcePackArchive(
      fixture.archivePath,
      fixture.stagingRoot,
      allowlist
    )).rejects.toBeInstanceOf(CmsSignatureValidationError);
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects an invalid resource manifest through A1 before extraction", async () => {
    const entries = validEntries();
    replaceEntry(entries, manifestName, JSON.stringify({
      ...manifestObject(),
      schemaVersion: 2
    }));
    const fixture = await createArchive(entries);

    await expect(extractResourcePackArchive(
      fixture.archivePath,
      fixture.stagingRoot,
      allowlist
    )).rejects.toBeInstanceOf(PipelineResourceValidationError);
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects a signed manifest file that is missing from the archive", async () => {
    const fixture = await createArchive(
      validEntries().filter((entry) => entry.name !== "models/model.bin")
    );

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_MANIFEST_MISMATCH");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("rejects an archive payload that is not registered by the signed manifest", async () => {
    const fixture = await createArchive([
      ...validEntries(),
      zipEntry("models/unregistered.bin", "extra")
    ]);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_MANIFEST_MISMATCH");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("counts actual streamed bytes, rejects declared-size mismatch, and cleans only its outputs", async () => {
    const entries = validEntries();
    replaceEntry(entries, manifestName, JSON.stringify(manifestObject([
      manifestFile("models/model.bin", 1),
      manifestFile("licenses/LICENSE.txt", 7)
    ])));
    const model = entries.find((entry) => entry.name === "models/model.bin")!;
    model.declaredUncompressedSize = 1;
    const fixture = await createArchive(entries);
    const installedRoot = await makeTemporaryDirectory();
    const installedFile = join(installedRoot, "installed-pack.bin");
    await writeFile(installedFile, "keep");

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_STREAM_SIZE_MISMATCH");
    await expectStagingEmpty(fixture.stagingRoot);
    await expect(readFile(installedFile, "utf8")).resolves.toBe("keep");
  });

  it("rejects when a payload stream ends below its declared uncompressed size", async () => {
    const entries = validEntries();
    replaceEntry(entries, manifestName, JSON.stringify(manifestObject([
      manifestFile("models/model.bin", 6),
      manifestFile("licenses/LICENSE.txt", 7)
    ])));
    entries.find((entry) => entry.name === "models/model.bin")!
      .declaredUncompressedSize = 6;
    const fixture = await createArchive(entries);

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_STREAM_SIZE_MISMATCH");
    await expectStagingEmpty(fixture.stagingRoot);
  });

  it("never overwrites an existing staging path", async () => {
    const fixture = await createArchive(validEntries());
    const existingPath = join(fixture.stagingRoot, manifestName);
    await writeFile(existingPath, "keep");

    await expectArchiveFailure(fixture, "RESOURCE_ARCHIVE_DESTINATION_EXISTS");
    await expect(readFile(existingPath, "utf8")).resolves.toBe("keep");
  });
});

type ArchiveFixture = {
  archivePath: string;
  stagingRoot: string;
};

type ZipEntryFixture = {
  name: string;
  data: Buffer;
  compressionMethod: number;
  flags: number;
  versionMadeBy: number;
  externalFileAttributes: number;
  utf8: boolean;
  centralExtra: Buffer;
  centralComment: Buffer;
  localName?: string;
  localSignature?: number;
  localUtf8?: boolean;
  localFlags?: number;
  localCompressionMethod?: number;
  localCrc32?: number;
  localCompressedSize?: number;
  localUncompressedSize?: number;
  dataDescriptor?: DataDescriptorFixture;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
};

type DataDescriptorFixture = {
  signature: boolean;
  crc32?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  truncateToBytes?: number;
};

function zipEntry(
  name: string,
  data: string | Buffer,
  options: Partial<Omit<ZipEntryFixture, "name" | "data">> = {}
): ZipEntryFixture {
  return {
    name,
    data: Buffer.isBuffer(data) ? data : Buffer.from(data),
    compressionMethod: options.compressionMethod ?? 0,
    flags: options.flags ?? 0,
    versionMadeBy: options.versionMadeBy ?? 20,
    externalFileAttributes: options.externalFileAttributes ?? (name.endsWith("/") ? 0x10 : 0),
    utf8: options.utf8 ?? true,
    centralExtra: options.centralExtra ?? Buffer.alloc(0),
    centralComment: options.centralComment ?? Buffer.alloc(0),
    localName: options.localName,
    localSignature: options.localSignature,
    localUtf8: options.localUtf8,
    localFlags: options.localFlags,
    localCompressionMethod: options.localCompressionMethod,
    localCrc32: options.localCrc32,
    localCompressedSize: options.localCompressedSize,
    localUncompressedSize: options.localUncompressedSize,
    dataDescriptor: options.dataDescriptor,
    declaredCompressedSize: options.declaredCompressedSize,
    declaredUncompressedSize: options.declaredUncompressedSize
  };
}

function enableDataDescriptor(
  entry: ZipEntryFixture,
  descriptor?: Partial<DataDescriptorFixture>
): void {
  entry.flags |= 0x8;
  entry.localFlags = entry.flags;
  entry.localCrc32 = 0;
  entry.localCompressedSize = 0;
  entry.localUncompressedSize = 0;
  if (descriptor !== undefined) {
    entry.dataDescriptor = {
      signature: descriptor.signature ?? true,
      crc32: descriptor.crc32,
      compressedSize: descriptor.compressedSize,
      uncompressedSize: descriptor.uncompressedSize,
      truncateToBytes: descriptor.truncateToBytes
    };
  }
}

function validEntries(): ZipEntryFixture[] {
  return [
    zipEntry("payload/", ""),
    zipEntry("models/model.bin", "model", { compressionMethod: 8 }),
    zipEntry(manifestName, JSON.stringify(manifestObject())),
    zipEntry(signatureName, Buffer.from([1, 2, 3])),
    zipEntry("licenses/LICENSE.txt", "license")
  ];
}

function signatureMarkerCrcEntries(): ZipEntryFixture[] {
  const entries = validEntries();
  const model = entries.find((entry) => entry.name === "models/model.bin")!;
  model.data = Buffer.from("ac0a7ad5", "hex");
  model.compressionMethod = 0;
  replaceEntry(entries, manifestName, JSON.stringify(manifestObject([
    manifestFile("models/model.bin", 4),
    manifestFile("licenses/LICENSE.txt", 7)
  ])));
  return entries;
}

function manifestObject(files: ManifestFileEntryV1[] = [
  manifestFile("models/model.bin", 5),
  manifestFile("licenses/LICENSE.txt", 7)
]) {
  return {
    schemaVersion: 1,
    resourceId: "ocr-ja",
    role: "ocr_ja",
    version: "1.0.0",
    compatiblePipelineVersions: ["1.0.0"],
    files,
    licenseFiles: ["licenses/LICENSE.txt"]
  };
}

function manifestFile(relativePath: string, byteSize: number): ManifestFileEntryV1 {
  return {
    relativePath,
    byteSize,
    sha256: "a".repeat(64)
  };
}

function replaceEntry(entries: ZipEntryFixture[], name: string, data: string): void {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`Missing test entry: ${name}`);
  entry.data = Buffer.from(data);
}

async function createArchive(entries: ZipEntryFixture[]): Promise<ArchiveFixture> {
  const root = await makeTemporaryDirectory();
  const archivePath = join(root, "pack.zip");
  const stagingRoot = join(root, "staging");
  await mkdir(stagingRoot);
  await writeFile(archivePath, buildZip(entries));
  return { archivePath, stagingRoot };
}

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(process.cwd(), ".resource-pack-archive-"));
  temporaryDirectories.push(path);
  return path;
}

async function expectPathFailure(
  fixture: ArchiveFixture,
  code: string
): Promise<void> {
  let thrown: unknown;
  try {
    await extractResourcePackArchive(fixture.archivePath, fixture.stagingRoot, allowlist);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(PipelinePathValidationError);
  if (thrown instanceof PipelinePathValidationError) expect(thrown.code).toBe(code);
}

async function expectArchiveFailure(
  fixture: ArchiveFixture,
  code: ResourcePackArchiveValidationCode
): Promise<void> {
  let thrown: unknown;
  try {
    await extractResourcePackArchive(fixture.archivePath, fixture.stagingRoot, allowlist);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ResourcePackArchiveValidationError);
  if (thrown instanceof ResourcePackArchiveValidationError) expect(thrown.code).toBe(code);
}

async function expectStagingEmpty(stagingRoot: string): Promise<void> {
  await expect(readdir(stagingRoot)).resolves.toEqual([]);
}

function buildZip(entries: ZipEntryFixture[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileName = Buffer.from(entry.name, "utf8");
    const localFileName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const encoded = entry.compressionMethod === 8
      ? deflateRawSync(entry.data)
      : entry.data;
    const compressedSize = entry.declaredCompressedSize ?? encoded.length;
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.data.length;
    const utf8Flag = entry.utf8 ? 0x800 : 0;
    const flags = entry.flags | utf8Flag;
    const localUtf8Flag = (entry.localUtf8 ?? entry.utf8) ? 0x800 : 0;
    const localFlags = (entry.localFlags ?? entry.flags) | localUtf8Flag;
    const crc = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(entry.localSignature ?? 0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(localFlags, 6);
    localHeader.writeUInt16LE(entry.localCompressionMethod ?? entry.compressionMethod, 8);
    localHeader.writeUInt32LE(entry.localCrc32 ?? crc, 14);
    localHeader.writeUInt32LE(entry.localCompressedSize ?? compressedSize, 18);
    localHeader.writeUInt32LE(entry.localUncompressedSize ?? uncompressedSize, 22);
    localHeader.writeUInt16LE(localFileName.length, 26);
    localHeader.writeUInt16LE(entry.centralExtra.length, 28);
    const descriptor = buildDataDescriptor(
      entry.dataDescriptor,
      crc,
      compressedSize,
      uncompressedSize
    );
    localParts.push(
      localHeader,
      localFileName,
      entry.centralExtra,
      encoded,
      descriptor
    );

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(entry.versionMadeBy, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(entry.compressionMethod, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt16LE(entry.centralExtra.length, 30);
    centralHeader.writeUInt16LE(entry.centralComment.length, 32);
    centralHeader.writeUInt32LE(entry.externalFileAttributes >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(
      centralHeader,
      fileName,
      entry.centralExtra,
      entry.centralComment
    );
    localOffset += localHeader.length
      + localFileName.length
      + entry.centralExtra.length
      + encoded.length
      + descriptor.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function buildDataDescriptor(
  fixture: DataDescriptorFixture | undefined,
  crc: number,
  compressedSize: number,
  uncompressedSize: number
): Buffer {
  if (fixture === undefined) return Buffer.alloc(0);
  const descriptor = Buffer.alloc(fixture.signature ? 16 : 12);
  const valueOffset = fixture.signature ? 4 : 0;
  if (fixture.signature) descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(fixture.crc32 ?? crc, valueOffset);
  descriptor.writeUInt32LE(
    fixture.compressedSize ?? compressedSize,
    valueOffset + 4
  );
  descriptor.writeUInt32LE(
    fixture.uncompressedSize ?? uncompressedSize,
    valueOffset + 8
  );
  return descriptor.subarray(0, fixture.truncateToBytes ?? descriptor.length);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
