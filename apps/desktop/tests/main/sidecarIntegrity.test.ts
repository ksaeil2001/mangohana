import { createHash } from "node:crypto";
import { existsSync, rmSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CmsSignatureValidationError,
  type CmsSignatureVerification
} from "../../src/main/cmsSignatureVerifier";
import {
  PipelinePathValidationError
} from "../../src/main/pipelinePathSecurity";
import {
  PipelineResourceValidationError
} from "../../src/shared/pipelineResources";
import {
  SidecarIntegrityValidationError,
  verifySidecarIntegrity,
  type SidecarIntegrityValidationCode
} from "../../src/main/sidecarIntegrity";
import * as sidecarIntegrityModule from "../../src/main/sidecarIntegrity";

const boundaryState = vi.hoisted(() => ({
  useRealCms: false
}));

vi.mock("../../src/main/cmsSignatureVerifier", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/cmsSignatureVerifier")>();
  return {
    ...actual,
    verifyDetachedCmsSignature: async (
      manifestBytes: Uint8Array,
      signatureBytes: Uint8Array,
      publisherAllowlist: { current: string; next?: string }
    ) => {
      if (boundaryState.useRealCms) {
        return actual.verifyDetachedCmsSignature(
          manifestBytes,
          signatureBytes,
          publisherAllowlist
        );
      }
      return {
        signerThumbprint: "AA".repeat(32),
        matchedPublisher: "current" as const
      };
    }
  };
});

const manifestName = "sidecar-integrity-manifest.json";
const signatureName = "sidecar-integrity-manifest.p7s";
const fakeSignature = Uint8Array.of(1, 2, 3);
const fakeSigner: CmsSignatureVerification = {
  signerThumbprint: "AA".repeat(32),
  matchedPublisher: "current"
};
const allowlist = { current: "AA".repeat(32) };
const corePayload = "core payload";
const coreHash = "3aea94c231b7fc8004c300e068e6abbf3056def1ab9ccaf66c5ed3bbbc994a86";
const streamedPayload = "streamed payload";
const streamedHash = "53cf5b03c75069281bf38b9265742110965bd860ed8793ce7970bd590737b4ba";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  boundaryState.useRealCms = false;
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("sidecar tree integrity verification", () => {
  it("accepts a matching tree while excluding only the exact manifest and signature names", async () => {
    const root = await createSidecar([
      entry("pipeline-core.exe", corePayload, coreHash.toUpperCase())
    ]);

    await expect(verifySidecarIntegrity(root, allowlist)).resolves.toEqual({
      pipelineVersion: "fixture-1.0.0",
      fileCount: 1,
      signer: fakeSigner
    });
  });

  it("verifies the real detached CMS before invoking the filesystem enumeration boundary", async () => {
    const root = await makeTemporaryDirectory();
    const manifestBytes = await readFile(join(
      process.cwd(),
      "tests",
      "fixtures",
      "pipeline-signing",
      "pipeline-manifest.json"
    ));
    const signatureBytes = await readFile(join(
      process.cwd(),
      "tests",
      "fixtures",
      "pipeline-signing",
      "valid-signature.p7s"
    ));
    signatureBytes[signatureBytes.length - 1] ^= 1;
    await writeFile(join(root, manifestName), manifestBytes);
    await writeFile(join(root, signatureName), signatureBytes);
    const outside = await makeTemporaryDirectory();
    await symlink(
      outside,
      join(root, "must-not-enumerate"),
      process.platform === "win32" ? "junction" : "dir"
    );
    boundaryState.useRealCms = true;

    let thrown: unknown;
    try {
      await verifySidecarIntegrity(root, {
        current: createHash("sha256")
          .update(await readFile(join(
            process.cwd(),
            "tests",
            "fixtures",
            "pipeline-signing",
            "test-publisher.cer"
          )))
          .digest("hex")
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CmsSignatureValidationError);
  });

  it("does not export a production injection factory that can bypass CMS verification", async () => {
    const root = await createSidecar([
      entry("pipeline-core.exe", corePayload, coreHash)
    ]);
    const factory = (
      sidecarIntegrityModule as unknown as {
        createSidecarIntegrityVerifier?: (
          dependencies: {
            verifyCmsSignature: () => Promise<CmsSignatureVerification>;
          }
        ) => typeof verifySidecarIntegrity;
      }
    ).createSidecarIntegrityVerifier;

    if (factory !== undefined) {
      boundaryState.useRealCms = true;
      await expect(factory({
        verifyCmsSignature: async () => fakeSigner
      })(root, allowlist)).rejects.toBeInstanceOf(CmsSignatureValidationError);
    }
    expect(factory).toBeUndefined();
  });

  it("hashes payloads through a FileHandle stream instead of a path-based stream", async () => {
    const root = await createSidecar([
      entry("bin/pipeline-core.exe", streamedPayload, streamedHash)
    ]);
    const prototype = await getFileHandlePrototype();
    const handleStream = vi.spyOn(prototype, "createReadStream");

    await expect(verifySidecarIntegrity(root, allowlist)).resolves.toMatchObject({
      fileCount: 1
    });
    expect(handleStream).toHaveBeenCalled();
  });

  it("rejects a payload changed while its opened handle is being streamed", async () => {
    const root = await createSidecar([
      entry("pipeline-core.exe", streamedPayload, streamedHash)
    ]);
    const payloadPath = join(root, "pipeline-core.exe");
    const prototype = await getFileHandlePrototype();
    const originalCreateReadStream = prototype.createReadStream;
    vi.spyOn(prototype, "createReadStream").mockImplementation(function (
      this: FileHandle,
      options
    ) {
      const source = originalCreateReadStream.call(this, options);
      return Readable.from((async function* () {
        let changed = false;
        for await (const chunk of source) {
          yield chunk;
          if (!changed) {
            changed = true;
            await writeFile(payloadPath, "replacement payload with a different size");
          }
        }
      })()) as ReturnType<FileHandle["createReadStream"]>;
    });

    await expectSidecarFailure(
      () => verifySidecarIntegrity(root, allowlist),
      "SIDECAR_FILE_CHANGED"
    );
  });

  it("rejects a same-inode same-size overwrite after all streamed bytes are read", async () => {
    const root = await createSidecar([
      entry("pipeline-core.exe", streamedPayload, streamedHash)
    ]);
    const payloadPath = join(root, "pipeline-core.exe");
    const originalMetadata = await lstat(payloadPath);
    const prototype = await getFileHandlePrototype();
    const originalCreateReadStream = prototype.createReadStream;
    vi.spyOn(prototype, "createReadStream").mockImplementation(function (
      this: FileHandle,
      options
    ) {
      const source = originalCreateReadStream.call(this, options);
      return Readable.from((async function* () {
        for await (const chunk of source) {
          yield chunk;
        }
        await writeFile(payloadPath, "replaced payload");
        await utimes(
          payloadPath,
          originalMetadata.atime,
          new Date(originalMetadata.mtimeMs + 60_000)
        );
      })()) as ReturnType<FileHandle["createReadStream"]>;
    });

    await expectSidecarFailure(
      () => verifySidecarIntegrity(root, allowlist),
      "SIDECAR_FILE_CHANGED"
    );
  });

  it("rejects a distinct inode renamed onto the pathname after the verified handle opens", async () => {
    const root = await createSidecar([
      entry("pipeline-core.exe", streamedPayload, streamedHash)
    ]);
    const swapDirectory = await makeTemporaryDirectory();
    const payloadPath = join(root, "pipeline-core.exe");
    const originalBackupPath = join(swapDirectory, "original.bin");
    const replacementPath = join(swapDirectory, "replacement.bin");
    const { originalMetadata, replacementMetadata } =
      await createObservablyDistinctReplacement(
        payloadPath,
        replacementPath,
        "replaced payload"
      );
    expect(
      observableIdentitiesDiffer(originalMetadata, replacementMetadata)
    ).toBe(true);

    const prototype = await getFileHandlePrototype();
    const originalCreateReadStream = prototype.createReadStream;
    let swapped = false;
    vi.spyOn(prototype, "createReadStream").mockImplementation(function (
      this: FileHandle,
      options
    ) {
      const source = originalCreateReadStream.call(this, options);
      return Readable.from((async function* () {
        for await (const chunk of source) {
          yield chunk;
        }
        if (!swapped) {
          swapped = true;
          await rename(payloadPath, originalBackupPath);
          await rename(replacementPath, payloadPath);
        }
      })()) as ReturnType<FileHandle["createReadStream"]>;
    });

    await expectSidecarFailure(
      () => verifySidecarIntegrity(root, allowlist),
      "SIDECAR_FILE_CHANGED"
    );
  });

  it("maps a manifest removed between inspection and open to the manifest read error", async () => {
    const root = await createSidecar([
      entry("pipeline-core.exe", corePayload, coreHash)
    ]);
    await removeTargetImmediatelyBeforeOpen(join(root, manifestName));

    await expectSidecarFailure(
      () => verifySidecarIntegrity(root, allowlist),
      "SIDECAR_MANIFEST_READ_FAILED"
    );
  });

  it("maps a signature removed between inspection and open to the signature read error", async () => {
    const root = await createSidecar([
      entry("pipeline-core.exe", corePayload, coreHash)
    ]);
    await removeTargetImmediatelyBeforeOpen(join(root, signatureName));

    await expectSidecarFailure(
      () => verifySidecarIntegrity(root, allowlist),
      "SIDECAR_SIGNATURE_READ_FAILED"
    );
  });

  it("rejects malformed JSON through the A1 runtime manifest validator", async () => {
    const root = await makeTemporaryDirectory();
    await writeFile(join(root, manifestName), "{not-json");
    await writeFile(join(root, signatureName), fakeSignature);

    await expectTypedFailure(
      () => verifySidecarIntegrity(root, allowlist),
      PipelineResourceValidationError,
      "PIPELINE_RESOURCE_INVALID_MANIFEST"
    );
  });

  it("rejects unsafe manifest paths through A2 validation", async () => {
    const root = await createSidecar([
      entry("../outside.exe", corePayload, coreHash)
    ], false);

    await expectTypedFailure(
      () => verifySidecarIntegrity(root, allowlist),
      PipelinePathValidationError,
      "PIPELINE_PATH_INVALID"
    );
  });

  it("rejects duplicate manifest paths independently", async () => {
    const root = await createSidecar([
      entry("pipeline-core.exe", corePayload, coreHash),
      entry("pipeline-core.exe", corePayload, coreHash)
    ]);

    await expectTypedFailure(
      () => verifySidecarIntegrity(root, allowlist),
      PipelinePathValidationError,
      "PIPELINE_PATH_DUPLICATE"
    );
  });

  it("rejects case-colliding manifest paths independently", async () => {
    const root = await createSidecar([
      entry("pipeline-core.exe", corePayload, coreHash),
      entry("PIPELINE-CORE.EXE", corePayload, coreHash)
    ], false);

    await expectTypedFailure(
      () => verifySidecarIntegrity(root, allowlist),
      PipelinePathValidationError,
      "PIPELINE_PATH_CASE_COLLISION"
    );
  });

  it("does not self-exclude a differently-cased manifest alias", async () => {
    const root = await createSidecar([
      entry("SIDECAR-INTEGRITY-MANIFEST.JSON", corePayload, coreHash)
    ], false);

    await expectTypedFailure(
      () => verifySidecarIntegrity(root, allowlist),
      PipelinePathValidationError,
      "PIPELINE_PATH_SELF_EXCLUSION_ALIAS"
    );
  });

  it("rejects a missing registered file independently", async () => {
    const root = await createSidecar([
      entry("pipeline-core.exe", corePayload, coreHash)
    ], false);

    await expectSidecarFailure(
      () => verifySidecarIntegrity(root, allowlist),
      "SIDECAR_FILE_MISSING"
    );
  });

  it("rejects an unregistered regular file independently", async () => {
    const root = await createSidecar([]);
    await writeFile(join(root, "extra.bin"), "extra payload");

    await expectSidecarFailure(
      () => verifySidecarIntegrity(root, allowlist),
      "SIDECAR_FILE_UNREGISTERED"
    );
  });

  it("rejects a byte-size mismatch independently", async () => {
    const root = await createSidecar([
      entry("pipeline-core.exe", corePayload, coreHash, 11)
    ]);

    await expectSidecarFailure(
      () => verifySidecarIntegrity(root, allowlist),
      "SIDECAR_FILE_SIZE_MISMATCH"
    );
  });

  it("rejects a SHA-256 mismatch independently", async () => {
    const root = await createSidecar([
      entry("pipeline-core.exe", corePayload, "00".repeat(32))
    ]);

    await expectSidecarFailure(
      () => verifySidecarIntegrity(root, allowlist),
      "SIDECAR_FILE_HASH_MISMATCH"
    );
  });

  it("rejects a junction or directory symlink without following it", async () => {
    const root = await createSidecar([]);
    const target = await makeTemporaryDirectory();
    await writeFile(join(target, "outside.bin"), "outside payload");
    await symlink(target, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");

    await expectSidecarFailure(
      () => verifySidecarIntegrity(root, allowlist),
      "SIDECAR_FILE_TYPE_UNSUPPORTED"
    );
  });

  it("rejects a caller-supplied sidecar root that is a junction or symlink alias", async () => {
    const targetRoot = await createSidecar([
      entry("pipeline-core.exe", corePayload, coreHash)
    ]);
    const aliasParent = await makeTemporaryDirectory();
    const aliasRoot = join(aliasParent, "sidecar-alias");
    await symlink(
      targetRoot,
      aliasRoot,
      process.platform === "win32" ? "junction" : "dir"
    );

    await expectSidecarFailure(
      () => verifySidecarIntegrity(aliasRoot, allowlist),
      "SIDECAR_ROOT_INVALID"
    );
  });
});

function entry(
  relativePath: string,
  payload: string,
  sha256: string,
  byteSize = Buffer.byteLength(payload)
) {
  return { relativePath, payload, byteSize, sha256 };
}

async function createSidecar(
  entries: Array<{
    relativePath: string;
    payload: string;
    byteSize: number;
    sha256: string;
  }>,
  writePayloads = true
): Promise<string> {
  const root = await makeTemporaryDirectory();
  const manifest = {
    schemaVersion: 1,
    pipelineVersion: "fixture-1.0.0",
    buildPlatform: "win32-x64",
    files: entries.map(({ relativePath, byteSize, sha256 }) => ({
      relativePath,
      byteSize,
      sha256
    }))
  };
  await writeFile(join(root, manifestName), JSON.stringify(manifest));
  await writeFile(join(root, signatureName), fakeSignature);

  if (writePayloads) {
    const uniqueEntries = new Map(entries.map((item) => [item.relativePath, item]));
    for (const item of uniqueEntries.values()) {
      const absolutePath = join(root, ...item.relativePath.split("/"));
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, item.payload);
    }
  }

  return root;
}

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "trio-sidecar-integrity-"));
  temporaryDirectories.push(path);
  return path;
}

async function createObservablyDistinctReplacement(
  originalPath: string,
  replacementPath: string,
  payload: string
): Promise<{
  originalMetadata: Stats;
  replacementMetadata: Stats;
}> {
  const originalMetadata = await lstat(originalPath);
  const deadline = Date.now() + 5_000;
  let attempts = 0;

  while (true) {
    attempts += 1;
    await rm(replacementPath, { force: true });
    await writeFile(replacementPath, payload);
    const replacementMetadata = await lstat(replacementPath);
    if (observableIdentitiesDiffer(originalMetadata, replacementMetadata)) {
      return { originalMetadata, replacementMetadata };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after 5000ms creating a distinguishable replacement (${attempts} attempts)`
      );
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 10);
    });
  }
}

function observableIdentitiesDiffer(before: Stats, after: Stats): boolean {
  if (before.dev !== after.dev || before.ino !== after.ino) return true;
  return before.birthtimeMs !== after.birthtimeMs;
}

async function getFileHandlePrototype(): Promise<{
  createReadStream: FileHandle["createReadStream"];
  stat: FileHandle["stat"];
}> {
  const probeDirectory = await makeTemporaryDirectory();
  const probePath = join(probeDirectory, "probe.bin");
  await writeFile(probePath, "probe");
  const handle = await open(probePath, "r");
  try {
    return Object.getPrototypeOf(handle) as {
      createReadStream: FileHandle["createReadStream"];
      stat: FileHandle["stat"];
    };
  } finally {
    await handle.close();
  }
}

async function removeTargetImmediatelyBeforeOpen(targetPath: string): Promise<void> {
  const isManifest = targetPath.endsWith(manifestName);
  const targetMetadata = await lstat(targetPath);
  const prototype = Object.getPrototypeOf(targetMetadata) as {
    isFile: Stats["isFile"];
  };
  const originalIsFile = prototype.isFile;
  let isFileCallCount = 0;
  let removed = false;
  vi.spyOn(prototype, "isFile").mockImplementation(function (this: Stats) {
    const isFile = originalIsFile.call(this);
    if (!removed && isFile) {
      isFileCallCount += 1;
      const targetCall = isManifest ? 1 : 2;
      if (isFileCallCount === targetCall) {
        removed = true;
        rmSync(targetPath);
      }
    }
    return isFile;
  });
}

async function expectSidecarFailure(
  action: () => Promise<unknown>,
  code: SidecarIntegrityValidationCode
): Promise<void> {
  await expectTypedFailure(action, SidecarIntegrityValidationError, code);
}

async function expectTypedFailure(
  action: () => Promise<unknown>,
  errorType: new (...args: never[]) => Error,
  code: string
): Promise<void> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(errorType);
  expect((thrown as { code?: string }).code).toBe(code);
}
