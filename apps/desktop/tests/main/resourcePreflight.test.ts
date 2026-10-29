import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  preflightPipelineResources,
  ResourcePreflightError,
  type ResourcePlatformProbe,
  type ResourcePreflightOptions
} from "../../src/main/resourcePreflight";
import {
  verifyInstalledResourcePack
} from "../../src/main/resourcePackInstaller";
import {
  PipelineResourceValidationError,
  parsePipelineResourceLockV1,
  parseResourcePackManifestV1,
  parseSidecarIntegrityManifestV1,
  type PipelineResourceLockEntryV1,
  type PipelineResourceLockV1,
  type PipelineResourceRole,
  type ResourcePackManifestV1
} from "../../src/shared/pipelineResources";

const sha256 = "a".repeat(64);
const trustedSignature = Buffer.from("trusted-signature");
const temporaryRoots: string[] = [];
const cmsBoundary = vi.hoisted(() => ({
  callCount: 0,
  pauseFirst: false,
  firstReached: Promise.resolve(),
  resolveFirstReached: undefined as (() => void) | undefined,
  resumeFirst: Promise.resolve(),
  resolveResumeFirst: undefined as (() => void) | undefined,
  expectedCurrentByResource: {} as Record<string, string>
}));

vi.mock("../../src/main/cmsSignatureVerifier", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/main/cmsSignatureVerifier")
  >();
  return {
    ...actual,
    verifyDetachedCmsSignature: async (
      content: Uint8Array,
      signature: Uint8Array,
      allowlist: { current: string; next?: string }
    ) => {
      if (!Buffer.from(signature).equals(trustedSignature)) {
        throw new Error("Invalid deterministic test signature");
      }
      let manifest: {
        resourceId?: unknown;
        role?: unknown;
        version?: unknown;
      };
      try {
        manifest = JSON.parse(Buffer.from(content).toString("utf8"));
      } catch {
        throw new Error("Invalid deterministic test manifest");
      }
      if (
        typeof manifest.resourceId !== "string"
        || typeof manifest.role !== "string"
        || typeof manifest.version !== "string"
      ) {
        throw new Error("Incomplete deterministic test manifest");
      }

      cmsBoundary.callCount += 1;
      if (cmsBoundary.pauseFirst && cmsBoundary.callCount === 1) {
        cmsBoundary.resolveFirstReached?.();
        await cmsBoundary.resumeFirst;
      }

      const expectedCurrent =
        cmsBoundary.expectedCurrentByResource[manifest.resourceId]
        ?? "A".repeat(64);
      if (allowlist.current.toUpperCase() !== expectedCurrent) {
        throw new Error("Publisher pin does not match manifest signer");
      }
      return {
        signerThumbprint: expectedCurrent,
        matchedPublisher: "current" as const
      };
    }
  };
});

afterEach(async () => {
  cmsBoundary.callCount = 0;
  cmsBoundary.pauseFirst = false;
  cmsBoundary.firstReached = Promise.resolve();
  cmsBoundary.resolveFirstReached = undefined;
  cmsBoundary.resumeFirst = Promise.resolve();
  cmsBoundary.resolveResumeFirst = undefined;
  cmsBoundary.expectedCurrentByResource = {};
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    )
  );
});

describe("pipeline resource contracts", () => {
  it("accepts one language-neutral Production OCR resource role", () => {
    expect(parseResourcePackManifestV1({
      schemaVersion: 1,
      resourceId: "trio-production-ocr-win32-x64",
      role: "ocr_production",
      version: "1.0.0",
      compatiblePipelineVersions: ["1.0.0"],
      files: [{ relativePath: "payload.bin", byteSize: 12, sha256 }],
      licenseFiles: ["LICENSE"]
    }).role).toBe("ocr_production");
  });

  it("rejects unsupported manifest schema versions before the manifest can be trusted", () => {
    expectValidationCode(() =>
      parseSidecarIntegrityManifestV1({
        schemaVersion: 2,
        pipelineVersion: "1.0.0",
        buildPlatform: "win32-x64",
        files: []
      }),
      "PIPELINE_RESOURCE_INVALID_SCHEMA_VERSION"
    );
  });

  it("rejects a resource pack role outside the frozen resource-role set", () => {
    expectValidationCode(() =>
      parseResourcePackManifestV1({
        schemaVersion: 1,
        resourceId: "ocr-ja",
        role: "ocr_ko",
        version: "1.0.0",
        compatiblePipelineVersions: ["1.0.0"],
        files: [],
        licenseFiles: []
      }),
      "PIPELINE_RESOURCE_INVALID_ROLE"
    );
  });

  it("rejects a resource distribution outside bundled and download", () => {
    expectValidationCode(() => parsePipelineResourceLockV1(lockWith({ distribution: "local" })),
      "PIPELINE_RESOURCE_INVALID_DISTRIBUTION"
    );
  });

  it.each([
    {
      download: {
        archiveUrl: "http://releases.example.invalid/pack.zip",
        manifestUrl: "https://releases.example.invalid/resource-manifest.json",
        signatureUrl: "https://releases.example.invalid/resource-manifest.p7s"
      }
    },
    {
      download: {
        archiveUrl: "https://releases.example.invalid/pack.zip",
        manifestUrl: "https://releases.example.invalid/resource-manifest.json"
      }
    },
    {
      download: {
        archiveUrl: "https://releases.example.invalid/pack.zip",
        manifestUrl: "https://releases.example.invalid/resource-manifest.json",
        signatureUrl: "https://releases.example.invalid/resource-manifest.p7s",
        mirrorUrl: "https://releases.example.invalid/mirror"
      }
    }
  ])("rejects download resources without the exact HTTPS URL set", (resource) => {
    expectValidationCode(() => parsePipelineResourceLockV1(lockWith({ distribution: "download", ...resource })),
      "PIPELINE_RESOURCE_INVALID_DOWNLOAD_URLS"
    );
  });

  it.each([
    { relativePath: "model.bin", byteSize: 12 },
    { relativePath: "model.bin", byteSize: 12, sha256, unexpected: true },
    { relativePath: "model.bin", byteSize: 12.5, sha256 }
  ])("rejects file entries that are not exactly relativePath, byteSize, and sha256", (file) => {
    expectValidationCode(() =>
      parseResourcePackManifestV1({
        schemaVersion: 1,
        resourceId: "ocr-ja",
        role: "ocr_ja",
        version: "1.0.0",
        compatiblePipelineVersions: ["1.0.0"],
        files: [file],
        licenseFiles: ["LICENSE"]
      }),
      "PIPELINE_RESOURCE_INVALID_FILE_ENTRY"
    );
  });

  it.each([
    ["role", [
      lockEntry({ role: "ocr_ja", resourceId: "ocr-ja" }),
      lockEntry({ role: "ocr_ja", resourceId: "ocr-ja-2" })
    ]],
    ["resourceId", [
      lockEntry({ role: "ocr_ja", resourceId: "shared-model" }),
      lockEntry({ role: "ocr_en", resourceId: "shared-model" })
    ]],
    ["case-insensitive resourceId", [
      lockEntry({ role: "ocr_ja", resourceId: "Shared-Model" }),
      lockEntry({ role: "ocr_en", resourceId: "shared-model" })
    ]]
  ] as const)("rejects duplicate resource %s bindings in the lock", (_kind, resources) => {
    expectValidationCode(
      () => parsePipelineResourceLockV1(validLock([...resources])),
      "PIPELINE_RESOURCE_INVALID_LOCK"
    );
  });
});

describe("resource preflight", () => {
  it("returns verified bundled and download bindings from exact trusted roots after their real probes succeed", async () => {
    const fixture = await createFixture([
      lockEntry({
        role: "font_ko_fallback",
        resourceId: "font-ko",
        distribution: "bundled"
      }),
      lockEntry({
        role: "ocr_ja",
        resourceId: "ocr-ja",
        distribution: "download"
      })
    ]);
    await writeValidPack(fixture, fixture.lock.resources[0]!);
    await writeValidPack(fixture, fixture.lock.resources[1]!);
    freezeCallerLock(fixture.lock);
    const options = preflightOptions(
      fixture,
      ["font_ko_fallback", "ocr_ja"]
    );

    const bindings = await preflightPipelineResources(options);

    expect(bindings).toEqual([
      {
        role: "font_ko_fallback",
        resourceId: "font-ko",
        version: "1.0.0",
        distribution: "bundled",
        absolutePath: join(
          fixture.bundledResourceRoot,
          "font-ko",
          "1.0.0"
        )
      },
      {
        role: "ocr_ja",
        resourceId: "ocr-ja",
        version: "1.0.0",
        distribution: "download",
        absolutePath: join(
          fixture.userDataRoot,
          "pipeline-resources",
          "ocr-ja",
          "1.0.0"
        )
      }
    ]);
    expect(bindings.every((binding) => isAbsolute(binding.absolutePath))).toBe(true);
    expect(Object.isFrozen(bindings)).toBe(true);
    expect(bindings.every((binding) => Object.isFrozen(binding))).toBe(true);
  });

  it("defensively copies the lock before asynchronous pack verification", async () => {
    const entry = lockEntry({ role: "ocr_ja", resourceId: "ocr-ja" });
    const fixture = await createFixture([entry]);
    await writeValidPack(fixture, entry);
    const verification = preflightPipelineResources(
      preflightOptions(fixture, ["ocr_ja"])
    );
    entry.manifestSha256 = "f".repeat(64);

    const bindings = await verification;

    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.resourceId).toBe("ocr-ja");
  });

  it("pins one invocation-time publisher allowlist across every candidate", async () => {
    const first = lockEntry({
      role: "font_ko_fallback",
      resourceId: "font-ko",
      distribution: "bundled"
    });
    const second = lockEntry({
      role: "ocr_ja",
      resourceId: "ocr-ja",
      distribution: "download"
    });
    const fixture = await createFixture([first, second]);
    await writeValidPack(fixture, first);
    await writeValidPack(fixture, second);
    const options = preflightOptions(
      fixture,
      ["font_ko_fallback", "ocr_ja"]
    );
    cmsBoundary.expectedCurrentByResource = {
      "font-ko": "A".repeat(64),
      "ocr-ja": "A".repeat(64)
    };
    pauseFirstCmsBoundary();

    const verification = preflightPipelineResources(options);
    await cmsBoundary.firstReached;
    options.publisherAllowlist.current = "c".repeat(64);
    cmsBoundary.resolveResumeFirst?.();

    const bindings = await verification;

    expect(bindings.map((binding) => binding.resourceId)).toEqual([
      "font-ko",
      "ocr-ja"
    ]);
  });

  it("pins a direct installed-pack verification entry before its first await", async () => {
    const entry = lockEntry({ role: "ocr_ja", resourceId: "ocr-ja" });
    const fixture = await createFixture([entry]);
    await writeValidPack(fixture, entry);

    const verification = verifyInstalledResourcePack({
      packRoot: packRoot(fixture, entry),
      entry,
      pipelineVersion: fixture.lock.pipelineVersion,
      publisherAllowlist: {
        current: "a".repeat(64)
      }
    });
    entry.manifestSha256 = "f".repeat(64);
    entry.role = "ocr_en";
    entry.version = "2.0.0";

    await expect(verification).resolves.toEqual({
      absolutePath: join(
        fixture.userDataRoot,
        "pipeline-resources",
        "ocr-ja",
        "1.0.0"
      )
    });
  });

  it("pins direct verification trust and return-path options across its CMS await", async () => {
    const entry = lockEntry({ role: "ocr_ja", resourceId: "ocr-ja" });
    const fixture = await createFixture([entry]);
    await writeValidPack(fixture, entry);
    const originalPackRoot = packRoot(fixture, entry);
    const publisherAllowlist = {
      current: "a".repeat(64)
    };
    const retainedOptions = {
      packRoot: originalPackRoot,
      entry,
      pipelineVersion: fixture.lock.pipelineVersion,
      publisherAllowlist
    };
    pauseFirstCmsBoundary();

    const verification = verifyInstalledResourcePack(retainedOptions);
    await cmsBoundary.firstReached;
    publisherAllowlist.current = "c".repeat(64);
    retainedOptions.packRoot = join(fixture.root, "caller-mutated-pack-root");
    cmsBoundary.resolveResumeFirst?.();

    await expect(verification).resolves.toEqual({
      absolutePath: originalPackRoot
    });
  });

  it.each([
    ["pack root", async (fixture: PreflightFixture, entry: PipelineResourceLockEntryV1) => {
      await writeValidPack(fixture, entry);
      await rm(packRoot(fixture, entry), { recursive: true, force: true });
    }],
    ["declared payload file", async (
      fixture: PreflightFixture,
      entry: PipelineResourceLockEntryV1
    ) => {
      await writeValidPack(fixture, entry);
      await rm(join(packRoot(fixture, entry), "payload.bin"));
    }]
  ] as const)("classifies an absent %s as RESOURCE_MISSING", async (_name, arrange) => {
    const entry = lockEntry({ role: "ocr_ja", resourceId: "ocr-ja" });
    const fixture = await createFixture([entry]);
    await arrange(fixture, entry);

    await expectPreflightCode(
      preflightOptions(fixture, ["ocr_ja"]),
      "RESOURCE_MISSING"
    );
  });

  it.each([
    ["signature", async (fixture: PreflightFixture, entry: PipelineResourceLockEntryV1) => {
      await writeValidPack(fixture, entry);
      await writeFile(
        join(packRoot(fixture, entry), "resource-manifest.p7s"),
        "untrusted-signature"
      );
    }],
    ["manifest schema", async (
      fixture: PreflightFixture,
      entry: PipelineResourceLockEntryV1
    ) => {
      const bytes = Buffer.from("{");
      await writePack(fixture, entry, { manifestBytes: bytes });
      entry.manifestSha256 = hash(bytes);
    }],
    ["manifest hash", async (
      fixture: PreflightFixture,
      entry: PipelineResourceLockEntryV1
    ) => {
      await writeValidPack(fixture, entry);
      entry.manifestSha256 = "e".repeat(64);
    }],
    ["tree", async (fixture: PreflightFixture, entry: PipelineResourceLockEntryV1) => {
      await writeValidPack(fixture, entry);
      await writeFile(join(packRoot(fixture, entry), "unexpected.bin"), "extra");
    }],
    ["payload hash", async (
      fixture: PreflightFixture,
      entry: PipelineResourceLockEntryV1
    ) => {
      await writeValidPack(fixture, entry);
      await writeFile(
        join(packRoot(fixture, entry), "payload.bin"),
        Buffer.from("tampered-payload")
      );
    }]
  ] as const)("classifies corrupt %s state as RESOURCE_CORRUPT", async (_name, arrange) => {
    const entry = lockEntry({ role: "ocr_ja", resourceId: "ocr-ja" });
    const fixture = await createFixture([entry]);
    await arrange(fixture, entry);

    await expectPreflightCode(
      preflightOptions(fixture, ["ocr_ja"]),
      "RESOURCE_CORRUPT"
    );
  });

  it.each([
    ["resourceId", { resourceId: "ocr-other" }],
    ["role", { role: "ocr_en" as const }],
    ["version", { version: "2.0.0" }],
    ["pipeline", { compatiblePipelineVersions: ["2.0.0"] }]
  ])("classifies a manifest with incompatible %s as RESOURCE_INCOMPATIBLE", async (
    _name,
    manifestChange
  ) => {
    const entry = lockEntry({ role: "ocr_ja", resourceId: "ocr-ja" });
    const fixture = await createFixture([entry]);
    const manifest = resourceManifest(entry, manifestChange);
    await writePack(fixture, entry, {
      manifest,
      payloadBytes: probePayload(manifest.role)
    });

    await expectPreflightCode(
      preflightOptions(fixture, ["ocr_ja"]),
      "RESOURCE_INCOMPATIBLE"
    );
  });

  it("does not search a caller-selected download root outside userData/pipeline-resources", async () => {
    const entry = lockEntry({ role: "ocr_ja", resourceId: "ocr-ja" });
    const fixture = await createFixture([entry]);
    await writePack(fixture, entry, {
      root: join(fixture.userDataRoot, entry.resourceId, entry.version)
    });

    await expectPreflightCode(
      preflightOptions(fixture, ["ocr_ja"]),
      "RESOURCE_MISSING"
    );
  });

  it.each([
    ["absolute", "C:\\caller-selected\\font-ko"],
    ["escaped", "../font-ko"]
  ])("rejects an %s bundled location instead of exposing it", async (
    _name,
    bundledLocation
  ) => {
    const entry = lockEntry({
      role: "font_ko_fallback",
      resourceId: "font-ko",
      distribution: "bundled"
    });
    const fixture = await createFixture([entry]);
    fixture.bundledLocations.font_ko_fallback = bundledLocation;

    await expectPreflightCode(
      preflightOptions(fixture, ["font_ko_fallback"]),
      "RESOURCE_CORRUPT"
    );
  });

  it("requires a bundled location declaration for a bundled lock entry", async () => {
    const entry = lockEntry({
      role: "font_ko_fallback",
      resourceId: "font-ko",
      distribution: "bundled"
    });
    const fixture = await createFixture([entry]);
    delete fixture.bundledLocations.font_ko_fallback;

    await expectPreflightCode(
      preflightOptions(fixture, ["font_ko_fallback"]),
      "RESOURCE_INCOMPATIBLE"
    );
  });

  it("requires a role-specific platform probe before it can return a binding", async () => {
    const entry = lockEntry({ role: "ocr_ja", resourceId: "ocr-ja" });
    const fixture = await createFixture([entry]);
    await writeValidPack(fixture, entry);
    const options = preflightOptions(fixture, ["ocr_ja"]);
    delete options.probes.ocr_ja;

    await expectPreflightCode(options, "RESOURCE_INCOMPATIBLE");
  });

  it("maps an invalid lock distribution to RESOURCE_CORRUPT without resolving a pack path", async () => {
    const entry = {
      ...lockEntry({ role: "ocr_ja", resourceId: "ocr-ja" }),
      distribution: "local"
    };
    const fixture = await createFixture([]);
    fixture.lock.resources = [entry as unknown as PipelineResourceLockEntryV1];

    await expectPreflightCode(
      preflightOptions(fixture, ["ocr_ja"]),
      "RESOURCE_CORRUPT"
    );
  });

  it("classifies a role-specific platform probe failure as RESOURCE_CORRUPT", async () => {
    const entry = lockEntry({ role: "ocr_ja", resourceId: "ocr-ja" });
    const fixture = await createFixture([entry]);
    await writeValidPack(fixture, entry);
    const options = preflightOptions(fixture, ["ocr_ja"]);
    options.probes.ocr_ja = async (binding) => {
      const bytes = await readFile(join(binding.absolutePath, "payload.bin"));
      if (bytes.equals(Buffer.from("never-the-pack-payload"))) return;
      throw new Error("model open rejected the pack");
    };

    await expectPreflightCode(options, "RESOURCE_CORRUPT");
  });

  it("does not let a valid pack for one role satisfy a different required role", async () => {
    const entry = lockEntry({ role: "ocr_ja", resourceId: "ocr-ja" });
    const fixture = await createFixture([entry]);
    await writeValidPack(fixture, entry);

    await expectPreflightCode(
      preflightOptions(fixture, ["ocr_en"]),
      "RESOURCE_MISSING"
    );
  });

  it("exposes no partially verified binding when a later pack is corrupt", async () => {
    const first = lockEntry({
      role: "ocr_ja",
      resourceId: "ocr-ja"
    });
    const second = lockEntry({
      role: "ocr_en",
      resourceId: "ocr-en"
    });
    const fixture = await createFixture([first, second]);
    await writeValidPack(fixture, first);
    await writeValidPack(fixture, second);
    await writeFile(join(packRoot(fixture, second), "unexpected.bin"), "extra");
    let probeObservedPath = false;
    const options = preflightOptions(fixture, ["ocr_ja", "ocr_en"]);
    options.probes.ocr_ja = async (binding) => {
      probeObservedPath = true;
      await assertProbePayload(binding);
    };

    await expectPreflightCode(options, "RESOURCE_CORRUPT");
    expect(probeObservedPath).toBe(false);
  });
});

function lockWith(resource: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    appVersion: "0.1.0",
    pipelineVersion: "1.0.0",
    resources: [
      {
        role: "ocr_ja",
        resourceId: "ocr-ja",
        version: "1.0.0",
        manifestSha256: sha256,
        requiredFor: ["ocr"],
        ...resource
      }
    ]
  };
}

function expectValidationCode(action: () => unknown, code: string) {
  let thrown: unknown;

  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(PipelineResourceValidationError);
  if (!(thrown instanceof PipelineResourceValidationError)) return;
  expect(thrown.code).toBe(code);
}

type MutablePreflightOptions = Omit<ResourcePreflightOptions, "probes"> & {
  probes: Partial<Record<PipelineResourceRole, ResourcePlatformProbe>>;
};

type PreflightFixture = {
  root: string;
  userDataRoot: string;
  bundledResourceRoot: string;
  bundledLocations: Partial<Record<PipelineResourceRole, string>>;
  lock: PipelineResourceLockV1;
};

async function createFixture(
  entries: PipelineResourceLockEntryV1[]
): Promise<PreflightFixture> {
  const root = await mkdtemp(join(process.cwd(), ".resource-preflight-"));
  temporaryRoots.push(root);
  const userDataRoot = join(root, "user-data");
  const bundledResourceRoot = join(root, "bundled-resources");
  await mkdir(userDataRoot, { recursive: true });
  await mkdir(bundledResourceRoot, { recursive: true });
  const bundledLocations: Partial<Record<PipelineResourceRole, string>> = {};
  for (const entry of entries) {
    if (entry.distribution === "bundled") {
      bundledLocations[entry.role] = `${entry.resourceId}/${entry.version}`;
    }
  }
  return {
    root,
    userDataRoot,
    bundledResourceRoot,
    bundledLocations,
    lock: validLock(entries)
  };
}

function validLock(
  resources: PipelineResourceLockEntryV1[]
): PipelineResourceLockV1 {
  return {
    schemaVersion: 1,
    appVersion: "0.1.0",
    pipelineVersion: "1.0.0",
    resources
  };
}

function lockEntry(
  overrides: Partial<PipelineResourceLockEntryV1> & {
    role?: PipelineResourceRole;
  } = {}
): PipelineResourceLockEntryV1 {
  const distribution = overrides.distribution ?? "download";
  const base = {
    role: overrides.role ?? "ocr_ja",
    resourceId: overrides.resourceId ?? "ocr-ja",
    version: overrides.version ?? "1.0.0",
    manifestSha256: overrides.manifestSha256 ?? "0".repeat(64),
    requiredFor: overrides.requiredFor ?? ["ocr" as const]
  };
  if (distribution === "download") {
    return {
      ...base,
      distribution,
      download: overrides.download ?? {
        archiveUrl: "https://releases.example.invalid/resource.zip",
        manifestUrl: "https://releases.example.invalid/resource-manifest.json",
        signatureUrl: "https://releases.example.invalid/resource-manifest.p7s"
      }
    };
  }
  return {
    ...base,
    distribution
  };
}

function preflightOptions(
  fixture: PreflightFixture,
  requiredRoles: PipelineResourceRole[]
): MutablePreflightOptions {
  const probes: MutablePreflightOptions["probes"] = {};
  for (const role of requiredRoles) {
    probes[role] = assertProbePayload;
  }
  return {
    lock: fixture.lock,
    requiredRoles,
    trustedRoots: {
      userDataRoot: fixture.userDataRoot,
      bundledResourceRoot: fixture.bundledResourceRoot,
      bundledLocations: fixture.bundledLocations
    },
    publisherAllowlist: {
      current: "a".repeat(64)
    },
    probes
  };
}

async function assertProbePayload(
  binding: Parameters<ResourcePlatformProbe>[0]
): Promise<void> {
  const actual = await readFile(join(binding.absolutePath, "payload.bin"));
  if (!actual.equals(probePayload(binding.role))) {
    throw new Error("Role-specific payload probe failed");
  }
}

function packRoot(
  fixture: PreflightFixture,
  entry: PipelineResourceLockEntryV1
): string {
  if (entry.distribution === "download") {
    return join(
      fixture.userDataRoot,
      "pipeline-resources",
      entry.resourceId,
      entry.version
    );
  }
  const location = fixture.bundledLocations[entry.role];
  if (location === undefined) {
    throw new Error("Test fixture has no bundled location");
  }
  return join(fixture.bundledResourceRoot, ...location.split("/"));
}

async function writeValidPack(
  fixture: PreflightFixture,
  entry: PipelineResourceLockEntryV1
): Promise<void> {
  await writePack(fixture, entry);
}

async function writePack(
  fixture: PreflightFixture,
  entry: PipelineResourceLockEntryV1,
  options: {
    root?: string;
    manifest?: ResourcePackManifestV1;
    manifestBytes?: Buffer;
    payloadBytes?: Buffer;
    signatureBytes?: Buffer;
  } = {}
): Promise<void> {
  const root = options.root ?? packRoot(fixture, entry);
  const payloadBytes = options.payloadBytes ?? probePayload(entry.role);
  const licenseBytes = Buffer.from("license-v1");
  const manifest = options.manifest ?? resourceManifest(entry, {}, {
    payloadBytes,
    licenseBytes
  });
  const manifestBytes = options.manifestBytes
    ?? Buffer.from(JSON.stringify(manifest));

  await mkdir(root, { recursive: true });
  await writeFile(join(root, "resource-manifest.json"), manifestBytes);
  await writeFile(
    join(root, "resource-manifest.p7s"),
    options.signatureBytes ?? trustedSignature
  );
  await writeFile(join(root, "payload.bin"), payloadBytes);
  await writeFile(join(root, "LICENSE"), licenseBytes);
  entry.manifestSha256 = hash(manifestBytes);
}

function resourceManifest(
  entry: PipelineResourceLockEntryV1,
  overrides: Partial<ResourcePackManifestV1> = {},
  bytes: {
    payloadBytes?: Buffer;
    licenseBytes?: Buffer;
  } = {}
): ResourcePackManifestV1 {
  const payloadBytes = bytes.payloadBytes ?? probePayload(entry.role);
  const licenseBytes = bytes.licenseBytes ?? Buffer.from("license-v1");
  return {
    schemaVersion: 1,
    resourceId: entry.resourceId,
    role: entry.role,
    version: entry.version,
    compatiblePipelineVersions: ["1.0.0"],
    files: [
      {
        relativePath: "payload.bin",
        byteSize: payloadBytes.byteLength,
        sha256: hash(payloadBytes)
      },
      {
        relativePath: "LICENSE",
        byteSize: licenseBytes.byteLength,
        sha256: hash(licenseBytes)
      }
    ],
    licenseFiles: ["LICENSE"],
    ...overrides
  };
}

function probePayload(role: PipelineResourceRole): Buffer {
  return Buffer.from(`probe:${role}`);
}

function freezeCallerLock(lock: PipelineResourceLockV1): void {
  for (const entry of lock.resources) {
    if (entry.download !== undefined) Object.freeze(entry.download);
    Object.freeze(entry.requiredFor);
    Object.freeze(entry);
  }
  Object.freeze(lock.resources);
  Object.freeze(lock);
}

function pauseFirstCmsBoundary(): void {
  cmsBoundary.pauseFirst = true;
  cmsBoundary.firstReached = new Promise<void>((resolve) => {
    cmsBoundary.resolveFirstReached = resolve;
  });
  cmsBoundary.resumeFirst = new Promise<void>((resolve) => {
    cmsBoundary.resolveResumeFirst = resolve;
  });
}

async function expectPreflightCode(
  options: ResourcePreflightOptions,
  code: ResourcePreflightError["code"]
): Promise<void> {
  let thrown: unknown;
  try {
    await preflightPipelineResources(options);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ResourcePreflightError);
  if (thrown instanceof ResourcePreflightError) {
    expect(thrown.code).toBe(code);
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
