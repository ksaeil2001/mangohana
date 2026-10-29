import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildStablePublicAssetPolicy,
  createCandidateEvidence,
  parseUpdaterYaml,
  verifyCandidateEvidence
} from "../../scripts/release-candidate-evidence.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "0.1.4";

const verification = {
  windows: {
    expectedPublisherMatched: true,
    authenticodeChainValid: true,
    digestAlgorithm: "SHA-256",
    timestampValid: true,
    appExecutableVerified: true,
    nsisInstallerVerified: true
  },
  linux: {
    updaterDisabled: true
  },
  pretendard: {
    cmsValid: true,
    hashValid: true,
    publisherAllowed: true,
    identityMatched: true,
    glyphCoverageValid: true
  }
};

function digest(bytes) {
  return createHash("sha512").update(bytes).digest("base64");
}

function digest256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeFixture({
  includeChecksum = false,
  includeEvidence = false,
  extra = [],
  windowsSha512 = true,
  windowsSize = true
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "trio-release-evidence-"));
  const policy = buildStablePublicAssetPolicy(VERSION);
  const files = new Map([
    [policy.windows.installer, Buffer.from("synthetic windows installer")],
    [policy.windows.blockmap, Buffer.from("synthetic windows blockmap")],
    [policy.linux.appImage, Buffer.from("synthetic linux appimage")],
    [policy.ancillary.sbom, Buffer.from('{"bomFormat":"CycloneDX","specVersion":"1.6","components":[]}\n')],
    [policy.ancillary.notices, Buffer.from("Third-party notices\n")],
    [policy.ancillary.releaseNotes, Buffer.from("Trio 0.1.4 release notes\n")]
  ]);

  const windowsEntries = [
    `  - url: ${policy.windows.installer}`,
    ...(windowsSha512 ? [`    sha512: ${digest(files.get(policy.windows.installer))}`] : []),
    ...(windowsSize ? [`    size: ${files.get(policy.windows.installer).byteLength}`] : [])
  ];
  files.set(
    policy.windows.metadata,
    Buffer.from(
      [
        `version: ${VERSION}`,
        "files:",
        ...windowsEntries,
        `path: ${policy.windows.installer}`,
        ...(windowsSha512 ? [`sha512: ${digest(files.get(policy.windows.installer))}`] : []),
        ...(windowsSize ? [`size: ${files.get(policy.windows.installer).byteLength}`] : [])
      ].join("\n") + "\n"
    )
  );

  for (const [name, content] of files) {
    await writeFile(join(directory, name), content);
  }
  for (const name of extra) {
    await writeFile(join(directory, name), Buffer.from("unexpected"));
  }
  if (includeChecksum) {
    const checksumNames = [...files.keys()].sort((left, right) => left.localeCompare(right));
    const checksum = checksumNames
      .map((name) => `${digest256(files.get(name))}  ${name}`)
      .join("\n") + "\n";
    await writeFile(join(directory, policy.ancillary.checksums), checksum);
  }
  if (includeEvidence) {
    await writeFile(join(directory, policy.evidence.file), "{}\n");
    await writeFile(join(directory, policy.evidence.digest), "0".repeat(64) + "  release-evidence.json\n");
  }
  return { directory, policy };
}

describe("release candidate evidence", () => {
  it("creates deterministic evidence and verifies a synthetic stable bundle", async () => {
    const fixture = await writeFixture();

    const created = await createCandidateEvidence({
      assetsDir: fixture.directory,
      sourceSha: SOURCE_SHA,
      packageVersion: VERSION,
      verification
    });
    const verified = await verifyCandidateEvidence({
      assetsDir: fixture.directory,
      sourceSha: SOURCE_SHA,
      packageVersion: VERSION
    });

    expect(created.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verified.evidence.sourceSha).toBe(SOURCE_SHA);
    expect(verified.evidence.packageVersion).toBe(VERSION);
    expect(verified.evidence.publicAssets.map((asset) => asset.name)).toEqual(
      [...verified.evidence.publicAssets.map((asset) => asset.name)].sort((left, right) => left.localeCompare(right))
    );
    expect(await readFile(join(fixture.directory, fixture.policy.ancillary.checksums), "utf8")).toMatch(
      /^[a-f0-9]{64}  .+(?:\n|$)/
    );
  });

  it("rejects wildcard-style and unexpected assets", async () => {
    const fixture = await writeFixture({ extra: ["builder-debug.yml"] });
    await expect(
      createCandidateEvidence({
        assetsDir: fixture.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification
      })
    ).rejects.toThrow(/unexpected|allowlist/i);
  });

  it.each(["source.tar.gz", "project.ctp", "page-assets.bin", "signing.log", "certificate.pfx", "private.pem", "api.token"])(
    "rejects prohibited asset %s",
    async (name) => {
      const fixture = await writeFixture({ extra: [name] });
      await expect(
        createCandidateEvidence({
          assetsDir: fixture.directory,
          sourceSha: SOURCE_SHA,
          packageVersion: VERSION,
          verification
        })
      ).rejects.toThrow(/unexpected|prohibited|allowlist/i);
    }
  );

  it("rejects symlinks and nested paths", async () => {
    const fixture = await writeFixture();
    await symlink(fixture.policy.windows.installer, join(fixture.directory, "linked.exe"));
    await mkdir(join(fixture.directory, "nested"));
    await writeFile(join(fixture.directory, "nested", "Trio-0.1.4.exe"), "nested");

    await expect(
      createCandidateEvidence({
        assetsDir: fixture.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification
      })
    ).rejects.toThrow(/symlink|nested|unexpected|allowlist/i);
  });

  it("rejects traversal or remote updater metadata references", async () => {
    const fixture = await writeFixture();
    const metadataPath = join(fixture.directory, fixture.policy.windows.metadata);
    const metadata = await readFile(metadataPath, "utf8");
    await writeFile(metadataPath, metadata.replaceAll(fixture.policy.windows.installer, "../Trio-Setup-0.1.4.exe"));
    await expect(
      createCandidateEvidence({
        assetsDir: fixture.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification
      })
    ).rejects.toThrow(/reference|path|traversal|remote|metadata/i);
  });

  it("rejects duplicate updater file entries", async () => {
    const fixture = await writeFixture();
    const metadataPath = join(fixture.directory, fixture.policy.windows.metadata);
    const metadata = await readFile(metadataPath, "utf8");
    await writeFile(
      metadataPath,
      metadata.replace(
        "path: Trio-Setup-0.1.4.exe",
        "  - url: Trio-Setup-0.1.4.exe\n    sha512: " + digest(Buffer.from("synthetic windows installer")) + "\n    size: 27\npath: Trio-Setup-0.1.4.exe"
      )
    );
    await expect(
      createCandidateEvidence({
        assetsDir: fixture.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification
      })
    ).rejects.toThrow(/duplicate|reference|metadata/i);
  });

  it.each([
    [
      "root blockmap aliases",
      "blockmap: Trio-0.1.4.dmg.blockmap\nblockMap: Trio-0.1.4.dmg.blockmap"
    ],
    [
      "root blockmap URL aliases",
      "blockmapUrl: Trio-0.1.4.dmg.blockmap\nblockMapUrl: Trio-0.1.4.dmg.blockmap"
    ],
    ["root path case aliases", "path: Trio-Setup-0.1.4.exe\nPATH: Trio-Setup-0.1.4.exe"],
    ["root version case aliases", "version: 0.1.4\nVERSION: 0.1.4"],
    ["root digest case aliases", "sha512: value\nSHA512: value"],
    ["root size case aliases", "size: 1\nSIZE: 1"],
    [
      "record URL case aliases",
      "  - url: Trio-Setup-0.1.4.exe\n    URL: Trio-Setup-0.1.4.exe"
    ],
    [
      "record digest case aliases",
      "  - url: Trio-Setup-0.1.4.exe\n    sha512: value\n    SHA512: value"
    ],
    [
      "record size case aliases",
      "  - url: Trio-Setup-0.1.4.exe\n    size: 1\n    Size: 1"
    ],
    [
      "record blockmap aliases",
      "  - url: Trio-Setup-0.1.4.exe\n    blockmap: Trio-0.1.4.dmg.blockmap\n    blockMap: Trio-0.1.4.dmg.blockmap"
    ]
  ])("rejects duplicate semantic updater field: %s", (_label, duplicateFields) => {
    expect(() =>
      parseUpdaterYaml(
        `version: 0.1.4\nfiles:\n${duplicateFields}\npath: Trio-Setup-0.1.4.exe`,
        "duplicate-fixture.yml"
      )
    ).toThrow(/duplicate|field/i);
  });

  it("allows the same logical fields in separate file records", () => {
    const validSha512 = Buffer.alloc(64).toString("base64");
    const parsed = parseUpdaterYaml(
      [
        "version: 0.1.4",
        "files:",
        "  - url: Trio-Setup-0.1.4.exe",
        `    sha512: ${validSha512}`,
        "    size: 1",
        "  - url: Trio-0.1.4.dmg",
        `    sha512: ${validSha512}`,
        "    size: 2",
        "path: Trio-Setup-0.1.4.exe"
      ].join("\n"),
      "separate-records.yml"
    );
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]).toEqual({ url: "Trio-Setup-0.1.4.exe", sha512: validSha512, size: 1 });
    expect(parsed.records[1]).toEqual({ url: "Trio-0.1.4.dmg", sha512: validSha512, size: 2 });
  });

  it("rejects wrong updater SHA-512 and size metadata", async () => {
    const fixture = await writeFixture({ windowsSha512: false });
    await expect(
      createCandidateEvidence({
        assetsDir: fixture.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification
      })
    ).rejects.toThrow(/sha512|metadata|windows/i);

    const sized = await writeFixture();
    const metadataPath = join(sized.directory, sized.policy.windows.metadata);
    const metadata = await readFile(metadataPath, "utf8");
    await writeFile(metadataPath, metadata.replace(/size: \d+/, "size: 1"));
    await expect(
      createCandidateEvidence({
        assetsDir: sized.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification
      })
    ).rejects.toThrow(/size|metadata|windows/i);
  });

  it("rejects macOS artifacts outside the MVP asset allowlist", async () => {
    const fixture = await writeFixture({ extra: ["latest-mac.yml"] });
    await expect(
      createCandidateEvidence({
        assetsDir: fixture.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification
      })
    ).rejects.toThrow(/unexpected|allowlist/i);
  });

  it("rejects Linux updater metadata and blockmaps", async () => {
    const fixture = await writeFixture({ extra: ["latest-linux.yml"] });
    await expect(
      createCandidateEvidence({
        assetsDir: fixture.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification
      })
    ).rejects.toThrow(/unexpected|Linux|allowlist/i);
  });

  it("rejects checksum mismatches and non-canonical ordering", async () => {
    const fixture = await writeFixture({ includeChecksum: true });
    const checksumPath = join(fixture.directory, fixture.policy.ancillary.checksums);
    const checksum = await readFile(checksumPath, "utf8");
    await writeFile(checksumPath, checksum.replace(/^./, "0"));
    await expect(
      createCandidateEvidence({
        assetsDir: fixture.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification
      })
    ).rejects.toThrow(/checksum|SHA-256|digest/i);

    const ordered = await writeFixture({ includeChecksum: true });
    const orderedPath = join(ordered.directory, ordered.policy.ancillary.checksums);
    const orderedChecksum = await readFile(orderedPath, "utf8");
    await writeFile(orderedPath, orderedChecksum.split("\n").reverse().join("\n"));
    await expect(
      createCandidateEvidence({
        assetsDir: ordered.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification
      })
    ).rejects.toThrow(/canonical|sorted|checksum/i);
  });

  it("rejects false or missing stable signing and resource evidence", async () => {
    const fixture = await writeFixture();
    const falseEvidence = structuredClone(verification);
    falseEvidence.windows.authenticodeChainValid = false;
    await expect(
      createCandidateEvidence({
        assetsDir: fixture.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification: falseEvidence
      })
    ).rejects.toThrow(/verification|Windows|authenticode/i);

    const missingEvidence = structuredClone(verification);
    delete missingEvidence.pretendard.glyphCoverageValid;
    await expect(
      createCandidateEvidence({
        assetsDir: (await writeFixture()).directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification: missingEvidence
      })
    ).rejects.toThrow(/verification|Pretendard|glyph/i);
  });

  it("rejects absolute paths and raw verification logs", async () => {
    const fixture = await writeFixture();
    const unsafe = structuredClone(verification);
    unsafe.windows.rawLog = "C:\\Users\\ksaei\\signing.log";
    await expect(
      createCandidateEvidence({
        assetsDir: fixture.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        verification: unsafe
      })
    ).rejects.toThrow(/verification|log|path|sanitized/i);
  });

  it("rejects a changed evidence digest, source, or package version", async () => {
    const fixture = await writeFixture();
    await createCandidateEvidence({
      assetsDir: fixture.directory,
      sourceSha: SOURCE_SHA,
      packageVersion: VERSION,
      verification
    });
    const digestPath = join(fixture.directory, fixture.policy.evidence.digest);
    await writeFile(digestPath, `${"0".repeat(64)}  release-evidence.json\n`);
    await expect(
      verifyCandidateEvidence({
        assetsDir: fixture.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION
      })
    ).rejects.toThrow(/evidence|digest/i);

    const sourceMismatch = await writeFixture();
    await createCandidateEvidence({
      assetsDir: sourceMismatch.directory,
      sourceSha: SOURCE_SHA,
      packageVersion: VERSION,
      verification
    });
    await expect(
      verifyCandidateEvidence({
        assetsDir: sourceMismatch.directory,
        sourceSha: "fedcba9876543210fedcba9876543210fedcba98",
        packageVersion: VERSION
      })
    ).rejects.toThrow(/source/i);

    await expect(
      verifyCandidateEvidence({
        assetsDir: sourceMismatch.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: "0.1.5"
      })
    ).rejects.toThrow(/version/i);
  });

  it("rejects non-canonical evidence JSON and checksum omission", async () => {
    const fixture = await writeFixture();
    await createCandidateEvidence({
      assetsDir: fixture.directory,
      sourceSha: SOURCE_SHA,
      packageVersion: VERSION,
      verification
    });
    const evidencePath = join(fixture.directory, fixture.policy.evidence.file);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
    await expect(
      verifyCandidateEvidence({
        assetsDir: fixture.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION
      })
    ).rejects.toThrow(/canonical|evidence/i);

    const missingChecksum = await writeFixture();
    await createCandidateEvidence({
      assetsDir: missingChecksum.directory,
      sourceSha: SOURCE_SHA,
      packageVersion: VERSION,
      verification
    });
    await writeFile(join(missingChecksum.directory, missingChecksum.policy.ancillary.checksums), "");
    await expect(
      verifyCandidateEvidence({
        assetsDir: missingChecksum.directory,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION
      })
    ).rejects.toThrow(/checksum|missing/i);
  });
});
