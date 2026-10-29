import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  installResourcePack,
  ResourcePackInstallError,
  type ResourcePackInstallOptions
} from "../../src/main/resourcePackInstaller";
import { RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES } from "../../src/main/resourcePackArchive";
import type {
  PipelineResourceLockV1,
  ResourcePackManifestV1
} from "../../src/shared/pipelineResources";

const transactionId = "11111111-1111-4111-8111-111111111111";
const promotionEventName = "resource-pack-installer:promotion-phase";
const windowsLockFixtureTimeoutMs = 20_000;

const boundary = vi.hoisted(() => ({
  failure: undefined as
    | "staging"
    | "download"
    | "cms"
    | "extract"
    | "rename"
    | "cleanup"
    | "final-reverify"
    | undefined,
  rejectUnexpectedDownload: false,
  manifestBytes: Buffer.alloc(0),
  signatureBytes: Buffer.from([7, 8, 9]),
  payloadBytes: Buffer.from("model-v1"),
  licenseBytes: Buffer.from("license-v1"),
  extractionMutation: undefined as
    | "license-missing"
    | "hash"
    | "size"
    | "unregistered"
    | undefined,
  extractionCalls: 0,
  cmsCalls: 0,
  metadataDownloadLimits: [] as Array<{
    kind: "manifest" | "signature";
    maxDownloadBytes: number | undefined;
  }>,
  observedTransactionRoot: undefined as string | undefined,
  renameFailureObserved: false,
  renameLockReleasedSynchronously: false,
  locks: [] as Array<{
    terminateSynchronously(): void;
    releaseAndVerifySynchronously(): void;
    exited: Promise<void>;
  }>,
  unsubscribers: [] as Array<() => void>
}));

vi.mock("../../src/main/resourcePackDownloader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/resourcePackDownloader")>();
  return {
    ...actual,
    downloadResourcePack: async (
      source: string | URL,
      destination: {
        truncate(length?: number): Promise<void>;
        write(
          buffer: Uint8Array,
          options: { offset: number; length: number; position: number }
        ): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
      },
      options?: {
        policy?: {
          maxDownloadBytes?: number;
        };
      }
    ) => {
      if (boundary.rejectUnexpectedDownload) {
        throw new Error("download must not occur");
      }
      if (boundary.failure === "download") {
        throw new Error("injected download failure");
      }
      const url = source.toString();
      const bytes = url.endsWith("resource-manifest.json")
        ? boundary.manifestBytes
        : url.endsWith("resource-manifest.p7s")
          ? boundary.signatureBytes
          : Buffer.from("archive");
      if (url.endsWith("resource-manifest.json")) {
        boundary.metadataDownloadLimits.push({
          kind: "manifest",
          maxDownloadBytes: options?.policy?.maxDownloadBytes
        });
      } else if (url.endsWith("resource-manifest.p7s")) {
        boundary.metadataDownloadLimits.push({
          kind: "signature",
          maxDownloadBytes: options?.policy?.maxDownloadBytes
        });
      }
      if (
        options?.policy?.maxDownloadBytes !== undefined
        && bytes.length > options.policy.maxDownloadBytes
      ) {
        throw new Error("injected metadata download cap");
      }
      await destination.truncate(0);
      await destination.write(bytes, {
        offset: 0,
        length: bytes.length,
        position: 0
      });
      return { bytesWritten: bytes.length, finalUrl: url, redirectCount: 0 };
    }
  };
});

vi.mock("../../src/main/cmsSignatureVerifier", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/cmsSignatureVerifier")>();
  return {
    ...actual,
    verifyDetachedCmsSignature: async () => {
      boundary.cmsCalls += 1;
      if (boundary.failure === "cms") throw new Error("injected CMS failure");
      if (
        boundary.failure === "final-reverify"
        && boundary.cmsCalls === 3
      ) {
        throw new Error("injected final verification failure");
      }
      return {
        signerThumbprint: "a".repeat(64),
        matchedPublisher: "current"
      };
    }
  };
});

vi.mock("../../src/main/resourcePackArchive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/resourcePackArchive")>();
  const path = await import("node:path");
  return {
    ...actual,
    extractResourcePackArchive: async (_archivePath: string, stagingRoot: string) => {
      boundary.extractionCalls += 1;
      if (boundary.failure === "extract") throw new Error("injected extraction failure");
      boundary.observedTransactionRoot = path.dirname(stagingRoot);
      const fs = await import("node:fs/promises");
      const manifest = JSON.parse(
        boundary.manifestBytes.toString("utf8")
      ) as ResourcePackManifestV1;
      await fs.mkdir(path.join(stagingRoot, "models"), { recursive: true });
      await fs.mkdir(path.join(stagingRoot, "licenses"), { recursive: true });
      await fs.writeFile(
        path.join(stagingRoot, "resource-manifest.json"),
        boundary.manifestBytes
      );
      await fs.writeFile(
        path.join(stagingRoot, "resource-manifest.p7s"),
        boundary.signatureBytes
      );
      await fs.writeFile(
        path.join(stagingRoot, "models", "model.bin"),
        boundary.extractionMutation === "hash"
          ? Buffer.from("tampered")
          : boundary.extractionMutation === "size"
            ? Buffer.from("model-v1-extra")
            : boundary.payloadBytes
      );
      if (boundary.extractionMutation !== "license-missing") {
        await fs.writeFile(
          path.join(stagingRoot, "licenses", "LICENSE.txt"),
          boundary.licenseBytes
        );
      }
      if (boundary.extractionMutation === "unregistered") {
        await fs.writeFile(path.join(stagingRoot, "extra.bin"), "extra");
      }
      if (boundary.failure === "rename") {
        const heldLock = await holdWindowsFile(
          path.join(stagingRoot, "models", "model.bin")
        );
        const expectedTransactionId = path.basename(path.dirname(stagingRoot));
        const listener = (message: unknown) => {
          if (
            isPromotionMessage(message)
            && message.phase === "rename-failed"
            && message.transactionId === expectedTransactionId
          ) {
            boundary.renameFailureObserved = true;
            heldLock.releaseAndVerifySynchronously();
            boundary.renameLockReleasedSynchronously = true;
          }
        };
        process.on(promotionEventName, listener);
        boundary.unsubscribers.push(() =>
          process.off(promotionEventName, listener)
        );
      }
      if (boundary.failure === "cleanup") {
        await holdWindowsFile(
          path.join(path.dirname(stagingRoot), "resource-manifest.json")
        );
      }
      return {
        manifest,
        signer: {
          signerThumbprint: "a".repeat(64),
          matchedPublisher: "current"
        },
        extractedFileCount: 4
      };
    }
  };

  async function holdWindowsFile(filePath: string): Promise<{
    terminateSynchronously(): void;
    releaseAndVerifySynchronously(): void;
    exited: Promise<void>;
  }> {
    const { spawn, spawnSync } = await import("node:child_process");
    const { renameSync } = await import("node:fs");
    const script = [
      "$p=[Environment]::GetEnvironmentVariable('RESOURCE_PACK_LOCK_PATH')",
      "$s=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)",
      "[Console]::Out.WriteLine('READY')",
      "[Console]::Out.Flush()",
      "[Console]::In.ReadLine() | Out-Null",
      "$s.Dispose()"
    ].join("; ");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        env: {
          ...process.env,
          RESOURCE_PACK_LOCK_PATH: filePath
        },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    const exited = new Promise<void>((resolvePromise) => {
      child.once("close", () => resolvePromise());
    });
    child.stdin.on("error", () => {
      // Teardown still terminates and awaits the child below.
    });
    let terminated = false;
    const terminateSynchronously = () => {
      if (terminated || child.pid === undefined) return;
      if (child.exitCode !== null) {
        terminated = true;
        return;
      }
      const control = spawnSync(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        {
          stdio: "ignore"
        }
      );
      if (control.error !== undefined || control.status !== 0) {
        let fallbackTerminated = false;
        try {
          fallbackTerminated = child.kill();
        } catch {
          // The registered close promise is still awaited by teardown.
        }
        if (!fallbackTerminated && child.exitCode === null && !child.killed) {
          throw control.error ?? new Error(
            `Windows lock termination failed (${control.status ?? "signal"})`
          );
        }
        terminated = true;
        return;
      }
      terminated = true;
    };
    const heldLock = {
      terminateSynchronously,
      releaseAndVerifySynchronously: () => {
        const lockReleaseWait = new Int32Array(
          new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
        );
        const transientWindowsLockErrors = new Set(["EACCES", "EBUSY", "EPERM"]);
        terminateSynchronously();
        const probePath = `${filePath}.release-probe`;
        const deadline = Date.now() + windowsLockFixtureTimeoutMs;
        let movedToProbe = false;
        while (true) {
          try {
            if (!movedToProbe) {
              renameSync(filePath, probePath);
              movedToProbe = true;
            }
            renameSync(probePath, filePath);
            return;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (
              process.platform !== "win32"
              || code === undefined
              || !transientWindowsLockErrors.has(code)
            ) {
              throw error;
            }
            if (Date.now() >= deadline) {
              throw new Error(
                `Timed out waiting ${windowsLockFixtureTimeoutMs}ms for Windows file-lock release (${code})`
              );
            }
            Atomics.wait(lockReleaseWait, 0, 0, 10);
          }
        }
      },
      exited
    };
    boundary.locks.push(heldLock);

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        let ready = false;
        const timer = setTimeout(() => {
          rejectPromise(new Error("PowerShell file-lock fixture timed out"));
        }, windowsLockFixtureTimeoutMs);
        child.once("error", (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        });
        child.once("close", () => {
          if (!ready) {
            clearTimeout(timer);
            rejectPromise(new Error("PowerShell file-lock fixture failed"));
          }
        });
        child.stdout.once("data", (chunk) => {
          if (!chunk.toString().includes("READY")) return;
          ready = true;
          clearTimeout(timer);
          resolvePromise();
        });
      });
      return heldLock;
    } catch (error) {
      heldLock.terminateSynchronously();
      await heldLock.exited;
      boundary.locks = boundary.locks.filter((candidate) =>
        candidate !== heldLock
      );
      throw error;
    }
  }

  function isPromotionMessage(
    message: unknown
  ): message is { phase: string; transactionId: string } {
    return typeof message === "object"
      && message !== null
      && "phase" in message
      && typeof message.phase === "string"
      && "transactionId" in message
      && typeof message.transactionId === "string";
  }
});

describe("atomic resource pack installer", () => {
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    boundary.failure = undefined;
    boundary.rejectUnexpectedDownload = false;
    boundary.payloadBytes = Buffer.from("model-v1");
    boundary.licenseBytes = Buffer.from("license-v1");
    boundary.signatureBytes = Buffer.from([7, 8, 9]);
    boundary.extractionMutation = undefined;
    boundary.extractionCalls = 0;
    boundary.cmsCalls = 0;
    boundary.metadataDownloadLimits = [];
    boundary.observedTransactionRoot = undefined;
    boundary.renameFailureObserved = false;
    boundary.renameLockReleasedSynchronously = false;
    boundary.locks = [];
    boundary.unsubscribers = [];
    boundary.manifestBytes = Buffer.from(JSON.stringify(validManifest()));
  });

  afterEach(async () => {
    for (const unsubscribe of boundary.unsubscribers) unsubscribe();
    boundary.unsubscribers = [];
    let terminationFailure: unknown;
    for (const lock of boundary.locks) {
      try {
        lock.terminateSynchronously();
      } catch (error) {
        terminationFailure ??= error;
      }
    }
    await Promise.all(boundary.locks.map((lock) => lock.exited));
    boundary.locks = [];
    await Promise.all(
      temporaryDirectories.splice(0).map((path) =>
        rm(path, { recursive: true, force: true })
      )
    );
    if (terminationFailure !== undefined) throw terminationFailure;
  });

  it("downloads, verifies, atomically promotes, re-verifies, and cleans its owned transaction", async () => {
    const fixture = await createFixture();

    const result = await installResourcePack(fixture.options);

    expect(result).toEqual({
      resourceId: "ocr-ja",
      version: "1.0.0",
      absolutePath: join(fixture.storeRoot, "ocr-ja", "1.0.0"),
      installed: true
    });
    expect(isAbsolute(result.absolutePath)).toBe(true);
    await expect(readFile(join(result.absolutePath, "models", "model.bin")))
      .resolves.toEqual(Buffer.from("model-v1"));
    await expect(readFile(join(result.absolutePath, "licenses", "LICENSE.txt")))
      .resolves.toEqual(Buffer.from("license-v1"));
    await expect(readdir(join(fixture.storeRoot, ".partial"))).resolves.toEqual([]);
    expect(basename(boundary.observedTransactionRoot ?? "")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(basename(boundary.observedTransactionRoot ?? "")).toBe(
      transactionId
    );
    expect(JSON.stringify(fixture.lock)).toBe(fixture.lockSnapshot);
  });

  it("creates the owned resource store on a clean first install", async () => {
    const fixture = await createFixture();
    await rm(fixture.storeRoot, { recursive: true });

    const result = await installResourcePack(fixture.options);

    expect(result).toMatchObject({
      absolutePath: join(fixture.storeRoot, "ocr-ja", "1.0.0"),
      installed: true
    });
    await expect(lstat(fixture.storeRoot)).resolves.toMatchObject({});
    await expectOwnedPartialClean(fixture.storeRoot);
  });

  it.each(["root link", "ancestor link"])("rejects a noncanonical store through a %s", async (kind) => {
    const fixture = await createFixture();
    const alias = join(fixture.storeRoot, "..", "store-alias");
    await symlink(fixture.storeRoot, alias, process.platform === "win32" ? "junction" : "dir");
    const root = kind === "root link" ? alias : join(alias, "nested");
    if (kind === "ancestor link") await mkdir(join(fixture.storeRoot, "nested"));
    boundary.rejectUnexpectedDownload = true;

    await expectInstallCode({ ...fixture.options, resourceStoreRoot: root }, "RESOURCE_CORRUPT");

    expect(boundary.observedTransactionRoot).toBeUndefined();
    await expectOwnedPartialClean(fixture.storeRoot);
    await expect(lstat(join(root, ".partial"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically installs concurrent transactions into a clean store", async () => {
    const fixture = await createFixture();
    await rm(fixture.storeRoot, { recursive: true });
    const results = await Promise.all([
      installResourcePack(fixture.options),
      installResourcePack({ ...fixture.options, transactionId: "22222222-2222-4222-8222-222222222222" })
    ]);
    expect(results.map((result) => result.installed).sort()).toEqual([false, true]);
    await expect(readFile(join(results[0]!.absolutePath, "models", "model.bin"), "utf8"))
      .resolves.toBe("model-v1");
    await expectOwnedPartialClean(fixture.storeRoot);
  });

  it("streams a multi-chunk payload without using FileHandle.readFile", async () => {
    const fixture = await createFixture();
    const largePayload = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
    boundary.payloadBytes = largePayload;
    boundary.manifestBytes = Buffer.from(JSON.stringify(validManifest({
      files: [
        manifestFile("models/model.bin", largePayload),
        manifestFile("licenses/LICENSE.txt", boundary.licenseBytes)
      ]
    })));
    fixture.lock.resources[0]!.manifestSha256 = sha256(
      boundary.manifestBytes
    );
    const probe = await open(join(fixture.storeRoot, "read-file-probe"), "w+");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      readFile: typeof probe.readFile;
    };
    await probe.close();
    const readFileSpy = vi.spyOn(fileHandlePrototype, "readFile")
      .mockRejectedValue(new Error("FileHandle.readFile must not be used"));

    try {
      const result = await installResourcePack(fixture.options);
      expect(result).toMatchObject({ installed: true });
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it.each(["manifest", "signature"] as const)(
    "caps an oversized downloaded %s before installation",
    async (metadataKind) => {
      const fixture = await createFixture();
      setOversizedMetadata(fixture.lock, metadataKind);

      await expectInstallCode(fixture.options, "RESOURCE_CORRUPT");

      expect(boundary.metadataDownloadLimits).toContainEqual({
        kind: metadataKind,
        maxDownloadBytes: RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES
      });
      await expect(lstat(join(fixture.storeRoot, "ocr-ja", "1.0.0")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expectOwnedPartialClean(fixture.storeRoot);
    }
  );

  it.each(["manifest", "signature"] as const)(
    "rejects an oversized installed %s before trusting it",
    async (metadataKind) => {
      const fixture = await createFixture();
      setOversizedMetadata(fixture.lock, metadataKind);
      const finalRoot = join(fixture.storeRoot, "ocr-ja", "1.0.0");
      await writeValidPack(finalRoot);
      const before = await snapshotTree(finalRoot);

      await expectInstallCode(fixture.options, "RESOURCE_CORRUPT");

      expect(await snapshotTree(finalRoot)).toEqual(before);
    }
  );

  it("returns an existing valid same version without downloading, extracting, or overwriting", async () => {
    const fixture = await createFixture();
    const finalRoot = join(fixture.storeRoot, "ocr-ja", "1.0.0");
    await writeValidPack(finalRoot);
    const before = await snapshotTree(finalRoot);
    boundary.rejectUnexpectedDownload = true;
    boundary.failure = "extract";

    const result = await installResourcePack(fixture.options);

    expect(result).toMatchObject({
      absolutePath: finalRoot,
      installed: false
    });
    expect(await snapshotTree(finalRoot)).toEqual(before);
    expect(JSON.stringify(fixture.lock)).toBe(fixture.lockSnapshot);
  });

  it("returns RESOURCE_CORRUPT for an existing corrupt same version without deleting or replacing it", async () => {
    const fixture = await createFixture();
    const finalRoot = join(fixture.storeRoot, "ocr-ja", "1.0.0");
    await writeValidPack(finalRoot);
    await writeFile(join(finalRoot, "models", "model.bin"), "corrupt");
    const before = await snapshotTree(finalRoot);
    boundary.rejectUnexpectedDownload = true;

    await expectInstallCode(fixture.options, "RESOURCE_CORRUPT");

    expect(await snapshotTree(finalRoot)).toEqual(before);
    expect(JSON.stringify(fixture.lock)).toBe(fixture.lockSnapshot);
  });

  it("never cleans or changes a pre-existing transaction-ID collision it did not create", async () => {
    const fixture = await createFixture({ preserveSentinels: true });
    const collisionRoot = join(
      fixture.storeRoot,
      ".partial",
      transactionId
    );
    await mkdir(collisionRoot, { recursive: true });
    await writeFile(
      join(collisionRoot, "foreign.bin"),
      Buffer.from([0, 255, 17, 33])
    );
    const collisionBefore = await snapshotTree(collisionRoot);
    const preservedBefore = await snapshotPreservedPacks(fixture.storeRoot);

    await expectInstallCode(fixture.options, "RESOURCE_CORRUPT");

    expect(await snapshotTree(collisionRoot)).toEqual(collisionBefore);
    expect(await snapshotPreservedPacks(fixture.storeRoot)).toEqual(
      preservedBefore
    );
    await expect(lstat(join(fixture.storeRoot, "ocr-ja", "1.0.0")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["resourceId traversal", { resourceId: "../ocr-ja" }],
    ["relative resource store", { resourceStoreRoot: "relative/store" }],
    ["invalid lock version", { version: "../1.0.0" }]
  ] as Array<[
    string,
    Partial<{
      resourceId: string;
      resourceStoreRoot: string;
      version: string;
    }>
  ]>)("validates %s before constructing transaction paths", async (_name, mutation) => {
    const fixture = await createFixture();
    if (mutation.resourceId !== undefined) {
      fixture.options = { ...fixture.options, resourceId: mutation.resourceId };
    }
    if (mutation.resourceStoreRoot !== undefined) {
      fixture.options = {
        ...fixture.options,
        resourceStoreRoot: mutation.resourceStoreRoot
      };
    }
    if (mutation.version !== undefined) {
      fixture.lock.resources[0]!.version = mutation.version;
    }
    boundary.rejectUnexpectedDownload = true;

    await expectInstallCode(fixture.options, "RESOURCE_CORRUPT");

    await expectOwnedPartialClean(fixture.storeRoot);
    await expect(lstat(join(fixture.storeRoot, "ocr-ja", "1.0.0")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["wrong UUID version", "11111111-1111-5111-8111-111111111111"],
    ["uppercase UUID", "11111111-1111-4111-8111-AAAAAAAAAAAA"],
    ["braced UUID", "{11111111-1111-4111-8111-111111111111}"],
    ["traversal", "../11111111-1111-4111-8111-111111111111"],
    ["empty", ""]
  ] as const)(
    "rejects a manager transaction ID with %s before creating paths",
    async (_name, invalidTransactionId) => {
      const fixture = await createFixture();
      const before = await snapshotTree(fixture.storeRoot);
      fixture.options = {
        ...fixture.options,
        transactionId: invalidTransactionId
      };
      boundary.rejectUnexpectedDownload = true;

      await expectInstallCode(fixture.options, "RESOURCE_CORRUPT");

      expect(await snapshotTree(fixture.storeRoot)).toEqual(before);
      expect(boundary.observedTransactionRoot).toBeUndefined();
      expect(boundary.locks).toEqual([]);
    }
  );

  it.each([
    ["array", ["11111111-1111-4111-8111-111111111111"]],
    ["boxed String", new String("11111111-1111-4111-8111-111111111111")],
    ["null", null],
    ["object", { transactionId }],
    ["number", 4111],
    ["boolean", true]
  ] as const)(
    "rejects a runtime %s transaction ID before creating paths",
    async (_name, runtimeTransactionId) => {
      const fixture = await createFixture();
      const before = await snapshotTree(fixture.storeRoot);
      fixture.options = {
        ...fixture.options,
        transactionId: runtimeTransactionId as unknown as string
      };
      boundary.rejectUnexpectedDownload = true;

      await expectInstallCode(fixture.options, "RESOURCE_CORRUPT");

      expect(await snapshotTree(fixture.storeRoot)).toEqual(before);
      expect(boundary.observedTransactionRoot).toBeUndefined();
      expect(boundary.locks).toEqual([]);
    }
  );

  it("classifies a downloaded manifest that is incompatible with the immutable pipeline lock", async () => {
    const fixture = await createFixture({
      manifest: validManifest({ compatiblePipelineVersions: ["2.0.0"] })
    });

    await expectInstallCode(fixture.options, "RESOURCE_INCOMPATIBLE");

    await expectOwnedPartialClean(fixture.storeRoot);
    expect(JSON.stringify(fixture.lock)).toBe(fixture.lockSnapshot);
  });

  it.each([
    ["resourceId", { ...validManifest(), resourceId: "ocr-en" }],
    ["version", { ...validManifest(), version: "2.0.0" }],
    ["role", { ...validManifest(), role: "ocr_en" }],
    ["missing licenseFiles", withoutLicenseFiles(validManifest())],
    ["undeclared licenseFiles", {
      ...validManifest(),
      licenseFiles: ["licenses/MISSING.txt"]
    }]
  ] as const)(
    "rejects a CMS-valid manifest with mismatched %s as RESOURCE_CORRUPT",
    async (_name, manifestInput) => {
      boundary.manifestBytes = Buffer.from(JSON.stringify(manifestInput));
      const fixture = await createFixture({ preserveSentinels: true });
      const preservedBefore = await snapshotPreservedPacks(fixture.storeRoot);

      await expectInstallCode(fixture.options, "RESOURCE_CORRUPT");

      expect(boundary.extractionCalls).toBe(0);
      expect(await snapshotPreservedPacks(fixture.storeRoot)).toEqual(
        preservedBefore
      );
      expect(JSON.stringify(fixture.lock)).toBe(fixture.lockSnapshot);
      await expectOwnedPartialClean(fixture.storeRoot);
    }
  );

  it.each([
    ["staging creation", "staging", undefined, "RESOURCE_CORRUPT"],
    ["write/download", "download", undefined, "RESOURCE_CORRUPT"],
    ["CMS", "cms", undefined, "RESOURCE_CORRUPT"],
    ["schema", undefined, "invalid-schema", "RESOURCE_CORRUPT"],
    ["extraction", "extract", undefined, "RESOURCE_CORRUPT"],
    ["license presence", undefined, "license-missing", "RESOURCE_CORRUPT"],
    ["payload hash", undefined, "hash", "RESOURCE_CORRUPT"],
    ["payload size", undefined, "size", "RESOURCE_CORRUPT"],
    ["unregistered file", undefined, "unregistered", "RESOURCE_CORRUPT"],
    ["pipeline compatibility", undefined, "incompatible", "RESOURCE_INCOMPATIBLE"],
    ["final re-verification", "final-reverify", undefined, "RESOURCE_CORRUPT"],
    ["owned cleanup", "cleanup", undefined, "RESOURCE_CORRUPT"]
  ] as const)(
    "preserves every pre-existing pack byte-for-byte when %s fails",
    async (_name, failure, mutation, expectedCode) => {
      const fixture = await createFixture({ preserveSentinels: true });
      boundary.failure = failure;
      if (mutation === "invalid-schema") {
        boundary.manifestBytes = Buffer.from("{");
        fixture.lock.resources[0]!.manifestSha256 = sha256(boundary.manifestBytes);
      } else if (mutation === "incompatible") {
        boundary.manifestBytes = Buffer.from(JSON.stringify(validManifest({
          compatiblePipelineVersions: ["2.0.0"]
        })));
        fixture.lock.resources[0]!.manifestSha256 = sha256(boundary.manifestBytes);
      } else {
        boundary.extractionMutation = mutation;
      }
      const lockBefore = JSON.stringify(fixture.lock);
      const preservedBefore = await snapshotPreservedPacks(fixture.storeRoot);
      await injectFileSystemFailure(fixture.storeRoot, failure);

      await expectInstallCode(fixture.options, expectedCode);

      expect(await snapshotPreservedPacks(fixture.storeRoot)).toEqual(preservedBefore);
      expect(JSON.stringify(fixture.lock)).toBe(lockBefore);
      if (failure !== "staging" && failure !== "cleanup") {
        await expectOwnedPartialClean(fixture.storeRoot);
      }
    },
    windowsLockFixtureTimeoutMs
  );

  it.runIf(process.platform === "win32")(
    "preserves every pre-existing pack byte-for-byte when atomic rename fails",
    async () => {
      const fixture = await createFixture({ preserveSentinels: true });
      boundary.failure = "rename";
      const lockBefore = JSON.stringify(fixture.lock);
      const preservedBefore = await snapshotPreservedPacks(fixture.storeRoot);

      await expectInstallCode(fixture.options, "RESOURCE_CORRUPT");

      expect(await snapshotPreservedPacks(fixture.storeRoot)).toEqual(preservedBefore);
      expect(JSON.stringify(fixture.lock)).toBe(lockBefore);
      expect(boundary.renameFailureObserved).toBe(true);
      expect(boundary.renameLockReleasedSynchronously).toBe(true);
      await expectOwnedPartialClean(fixture.storeRoot);
    },
    windowsLockFixtureTimeoutMs
  );

  it("ignores a throwing promotion observer without changing installation", async () => {
    const fixture = await createFixture();
    let observerCalled = false;
    let observerPayloadFrozen = false;
    let observerPayloadKeys: string[] = [];
    const throwingObserver = (message: unknown) => {
      if (
        isPromotionMessage(message)
        && message.phase === "before-rename"
        && message.transactionId === transactionId
      ) {
        observerCalled = true;
        observerPayloadFrozen = Object.isFrozen(message);
        observerPayloadKeys = Object.keys(message).sort();
        throw new Error("observer failure must stay observational");
      }
    };
    process.on(promotionEventName, throwingObserver);

    try {
      const result = await installResourcePack(fixture.options);
      expect(result).toMatchObject({
        installed: true,
        absolutePath: join(fixture.storeRoot, "ocr-ja", "1.0.0")
      });
    } finally {
      process.off(promotionEventName, throwingObserver);
    }

    expect(observerCalled).toBe(true);
    expect(observerPayloadFrozen).toBe(true);
    expect(observerPayloadKeys).toEqual(["phase", "transactionId"]);
    await expect(readFile(
      join(fixture.storeRoot, "ocr-ja", "1.0.0", "models", "model.bin"),
      "utf8"
    )).resolves.toBe("model-v1");
    await expectOwnedPartialClean(fixture.storeRoot);
  });

  it("contains a rejected observer Promise without an unhandled rejection", async () => {
    const fixture = await createFixture();
    const unhandledRejections: unknown[] = [];
    let observerCalled = false;
    const rejectingObserver = (message: unknown) => {
      if (
        isPromotionMessage(message)
        && message.phase === "before-rename"
        && message.transactionId === transactionId
      ) {
        observerCalled = true;
        return Promise.reject(new Error("observer rejection must be contained"));
      }
      return undefined;
    };
    const recordUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on(promotionEventName, rejectingObserver);
    process.on("unhandledRejection", recordUnhandledRejection);

    try {
      const result = await installResourcePack(fixture.options);
      expect(result).toMatchObject({ installed: true });
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    } finally {
      process.off(promotionEventName, rejectingObserver);
      process.off("unhandledRejection", recordUnhandledRejection);
    }

    expect(observerCalled).toBe(true);
    expect(unhandledRejections).toEqual([]);
    await expectOwnedPartialClean(fixture.storeRoot);
  });

  it.each([
    ["truthy", "valid", false, true],
    ["falsey", "valid", false, false],
    ["thenable", "valid", false, Promise.resolve(false)],
    ["truthy", "corrupt", true, true],
    ["falsey", "corrupt", true, false],
    ["thenable", "corrupt", true, Promise.resolve(true)]
  ] as const)(
    "ignores a %s observer return when verifying a concurrently-created %s destination",
    async (_returnKind, _destinationKind, corrupt, observerReturn) => {
      const fixture = await createFixture({ preserveSentinels: true });
      const finalRoot = join(fixture.storeRoot, "ocr-ja", "1.0.0");
      const preservedBefore = await snapshotPreservedPacks(fixture.storeRoot);
      let collisionCreated = false;
      const listener = (message: unknown) => {
        if (
          !isPromotionMessage(message)
          || message.phase !== "before-rename"
          || message.transactionId !== transactionId
        ) {
          return;
        }
        collisionCreated = true;
        writeValidPackSync(finalRoot, corrupt);
        return observerReturn;
      };
      process.on(promotionEventName, listener);

      try {
        if (corrupt) {
          await expectInstallCode(fixture.options, "RESOURCE_CORRUPT");
        } else {
          const result = await installResourcePack(fixture.options);
          expect(result).toMatchObject({
            installed: false,
            absolutePath: join(fixture.storeRoot, "ocr-ja", "1.0.0")
          });
        }
      } finally {
        process.off(promotionEventName, listener);
      }

      expect(collisionCreated).toBe(true);
      await expect(readFile(join(finalRoot, "models", "model.bin"), "utf8"))
        .resolves.toBe(corrupt ? "corrupt" : "model-v1");
      expect(await snapshotPreservedPacks(fixture.storeRoot)).toEqual(preservedBefore);
      await expectOwnedPartialClean(fixture.storeRoot);
    }
  );

  it("never treats a sibling or ancestor as an owned cleanup target", async () => {
    const fixture = await createFixture({ preserveSentinels: true });
    boundary.failure = "download";
    const sibling = join(fixture.storeRoot, ".partial", "not-owned");
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "keep.bin"), Buffer.from([0, 1, 2, 255]));
    const siblingBefore = await snapshotTree(sibling);

    await expectInstallCode(fixture.options, "RESOURCE_CORRUPT");

    expect(await snapshotTree(sibling)).toEqual(siblingBefore);
    await expect(lstat(fixture.storeRoot)).resolves.toMatchObject({});
  });

  type Fixture = {
    storeRoot: string;
    lock: PipelineResourceLockV1;
    lockSnapshot: string;
    options: ResourcePackInstallOptions & { transactionId: string };
  };

  async function createFixture(options: {
    manifest?: ResourcePackManifestV1;
    preserveSentinels?: boolean;
  } = {}): Promise<Fixture> {
    const root = await mkdtemp(join(process.cwd(), ".resource-pack-installer-"));
    temporaryDirectories.push(root);
    const storeRoot = join(root, "pipeline-resources");
    await mkdir(storeRoot);
    if (options.manifest !== undefined) {
      boundary.manifestBytes = Buffer.from(JSON.stringify(options.manifest));
    }
    if (options.preserveSentinels) {
      await writeFile(join(storeRoot, "store-sentinel.bin"), Buffer.from([0, 255, 1]));
      await writeFile(join(storeRoot, "lock.json"), "persisted-lock-must-not-change");
      await mkdir(join(storeRoot, "ocr-ja", "0.9.0"), { recursive: true });
      await writeFile(
        join(storeRoot, "ocr-ja", "0.9.0", "old.bin"),
        Buffer.from([9, 8, 7, 0])
      );
      await mkdir(join(storeRoot, "other-resource", "5.0.0"), { recursive: true });
      await writeFile(
        join(storeRoot, "other-resource", "5.0.0", "other.bin"),
        Buffer.from([6, 5, 4, 0])
      );
    }
    const lock = validLock(boundary.manifestBytes);
    const lockSnapshot = JSON.stringify(lock);
    const fixtureOptions = {
      resourceStoreRoot: storeRoot,
      lock,
      resourceId: "ocr-ja",
      transactionId,
      publisherAllowlist: {
        current: "a".repeat(64)
      }
    };
    return {
      storeRoot,
      lock,
      lockSnapshot,
      options: fixtureOptions
    };
  }

  function setOversizedMetadata(
    lock: PipelineResourceLockV1,
    metadataKind: "manifest" | "signature"
  ): void {
    const oversizedBytes = RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES + 1;
    if (metadataKind === "manifest") {
      const manifest = Buffer.from(JSON.stringify(validManifest()));
      boundary.manifestBytes = Buffer.concat([
        manifest,
        Buffer.alloc(oversizedBytes - manifest.length, 0x20)
      ]);
      lock.resources[0]!.manifestSha256 = sha256(boundary.manifestBytes);
    } else {
      boundary.signatureBytes = Buffer.alloc(oversizedBytes, 0x5a);
    }
  }
});

type TreeSnapshot = Record<string, string>;

function validManifest(
  override: Partial<ResourcePackManifestV1> = {}
): ResourcePackManifestV1 {
  const payloadBytes = Buffer.from("model-v1");
  const licenseBytes = Buffer.from("license-v1");
  return {
    schemaVersion: 1,
    resourceId: "ocr-ja",
    role: "ocr_ja",
    version: "1.0.0",
    compatiblePipelineVersions: ["1.0.0"],
    files: [
      {
        relativePath: "models/model.bin",
        byteSize: payloadBytes.length,
        sha256: sha256(payloadBytes)
      },
      {
        relativePath: "licenses/LICENSE.txt",
        byteSize: licenseBytes.length,
        sha256: sha256(licenseBytes)
      }
    ],
    licenseFiles: ["licenses/LICENSE.txt"],
    ...override
  };
}

function validLock(manifestBytes: Uint8Array): PipelineResourceLockV1 {
  return {
    schemaVersion: 1,
    appVersion: "0.1.0",
    pipelineVersion: "1.0.0",
    resources: [{
      role: "ocr_ja",
      resourceId: "ocr-ja",
      version: "1.0.0",
      manifestSha256: sha256(manifestBytes),
      distribution: "download",
      download: {
        archiveUrl: "https://downloads.example.test/pack.zip",
        manifestUrl: "https://downloads.example.test/resource-manifest.json",
        signatureUrl: "https://downloads.example.test/resource-manifest.p7s"
      },
      requiredFor: ["ocr"]
    }]
  };
}

function withoutLicenseFiles(manifest: ResourcePackManifestV1) {
  const {
    licenseFiles: _licenseFiles,
    ...withoutLicenseFilesProperty
  } = manifest;
  return withoutLicenseFilesProperty;
}

function manifestFile(relativePath: string, bytes: Uint8Array) {
  return {
    relativePath,
    byteSize: bytes.byteLength,
    sha256: sha256(bytes)
  };
}

async function writeValidPack(root: string): Promise<void> {
  await mkdir(join(root, "models"), { recursive: true });
  await mkdir(join(root, "licenses"), { recursive: true });
  await writeFile(join(root, "resource-manifest.json"), boundary.manifestBytes);
  await writeFile(join(root, "resource-manifest.p7s"), boundary.signatureBytes);
  await writeFile(join(root, "models", "model.bin"), boundary.payloadBytes);
  await writeFile(join(root, "licenses", "LICENSE.txt"), boundary.licenseBytes);
}

function writeValidPackSync(root: string, corrupt: boolean): void {
  mkdirSync(join(root, "models"), { recursive: true });
  mkdirSync(join(root, "licenses"), { recursive: true });
  writeFileSync(
    join(root, "resource-manifest.json"),
    boundary.manifestBytes
  );
  writeFileSync(
    join(root, "resource-manifest.p7s"),
    boundary.signatureBytes
  );
  writeFileSync(
    join(root, "models", "model.bin"),
    corrupt ? Buffer.from("corrupt") : boundary.payloadBytes
  );
  writeFileSync(
    join(root, "licenses", "LICENSE.txt"),
    boundary.licenseBytes
  );
}

async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const result: TreeSnapshot = {};
  await visit(root, "");
  return result;

  async function visit(absoluteDirectory: string, relativeDirectory: string) {
    const names = (await readdir(absoluteDirectory)).sort();
    for (const name of names) {
      const absolutePath = join(absoluteDirectory, name);
      const relativePath = relativeDirectory === ""
        ? name
        : `${relativeDirectory}/${name}`;
      const metadata = await lstat(absolutePath);
      if (metadata.isDirectory()) {
        result[`${relativePath}/`] = "<directory>";
        await visit(absolutePath, relativePath);
      } else {
        result[relativePath] = Buffer.from(await readFile(absolutePath)).toString("hex");
      }
    }
  }
}

async function snapshotPreservedPacks(storeRoot: string): Promise<TreeSnapshot> {
  const snapshot: TreeSnapshot = {};
  for (const path of [
    "store-sentinel.bin",
    "lock.json",
    "ocr-ja/0.9.0/old.bin",
    "other-resource/5.0.0/other.bin"
  ]) {
    snapshot[path] = Buffer.from(await readFile(join(storeRoot, ...path.split("/"))))
      .toString("hex");
  }
  return snapshot;
}

async function expectOwnedPartialClean(storeRoot: string): Promise<void> {
  const partialRoot = join(storeRoot, ".partial");
  try {
    expect(await readdir(partialRoot)).toEqual([]);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

async function expectInstallCode(
  options: Parameters<typeof installResourcePack>[0],
  code: "RESOURCE_CORRUPT" | "RESOURCE_INCOMPATIBLE"
): Promise<void> {
  let thrown: unknown;
  try {
    await installResourcePack(options);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ResourcePackInstallError);
  if (thrown instanceof ResourcePackInstallError) {
    expect(thrown.code).toBe(code);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function isPromotionMessage(
  message: unknown
): message is { phase: string; transactionId: string } {
  return typeof message === "object"
    && message !== null
    && "phase" in message
    && typeof message.phase === "string"
    && "transactionId" in message
    && typeof message.transactionId === "string";
}

async function injectFileSystemFailure(
  storeRoot: string,
  failure: typeof boundary.failure
): Promise<void> {
  if (failure === "staging") {
    await writeFile(
      join(storeRoot, ".partial"),
      Buffer.from("staging-root-collision")
    );
  }
}
