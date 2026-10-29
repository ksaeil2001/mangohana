import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { normalizeCmsPublisherAllowlist, verifyDetachedCmsSignature } from "../../src/main/cmsSignatureVerifier";
import { verifyInstalledResourcePack } from "../../src/main/resourcePackInstaller";
import { parsePipelineResourceLockV1 } from "../../src/shared/pipelineResources";

const repositoryRoot = process.cwd();
const sourceRoot = join(
  repositoryRoot,
  "resources",
  "font_ko_fallback",
  "pretendard-1.3.9"
);
const pipelineRoot = join(repositoryRoot, "resources", "pipeline-resources");
const temporaryPacks: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPacks.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const manifestRelativePath =
  "resources/font_ko_fallback/pretendard-1.3.9/resource-manifest.json";
const licenseRelativePath =
  "resources/font_ko_fallback/pretendard-1.3.9/LICENSE.txt";

describe("packaged production typeset font resource", () => {
  it("maps the fixed source and policy roots into the Main-owned resource root", () => {
    const extraResources = packageJson.build.extraResources;
    expect(extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "resources/pipeline-resources",
        to: "pipeline-resources"
      }),
      expect.objectContaining({
        from: "resources/font_ko_fallback/pretendard-1.3.9",
        to: "pipeline-resources/pretendard-ko-fallback/1.3.9"
      })
    ]));
  });

  it("pins the lock manifest hash to the committed manifest bytes", async () => {
    const manifestPath = join(sourceRoot, "resource-manifest.json");
    const lockPath = join(pipelineRoot, "pipeline-resource-lock.json");
    const manifestBytes = await readFile(manifestPath);
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      resources: Array<{ role: string; manifestSha256: string }>;
    };
    const fontResource = lock.resources.find(
      (resource) => resource.role === "font_ko_fallback"
    );

    expect(fontResource).toBeDefined();
    expect(fontResource!.manifestSha256).toBe(
      createHash("sha256").update(manifestBytes).digest("hex")
    );
  });

  it("protects manifest and declared text-license bytes from checkout conversion", async () => {
    const attributes = (await readFile(join(repositoryRoot, ".gitattributes"), "utf8"))
      .replace(/\r\n/g, "\n");
    const attributeLines = attributes
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    expect(attributeLines).toContain(`${manifestRelativePath} -text`);
    expect(attributeLines).toContain(`${licenseRelativePath} -text -whitespace`);

    const manifestBytes = await readFile(join(repositoryRoot, manifestRelativePath));
    const licenseBytes = await readFile(join(repositoryRoot, licenseRelativePath));
    expect(manifestBytes.includes(0x0d)).toBe(false);
    expect(licenseBytes.includes(0x0d)).toBe(false);

    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      files: Array<{ relativePath: string; byteSize: number; sha256: string }>;
    };
    for (const file of manifest.files) {
      const bytes = await readFile(join(sourceRoot, file.relativePath));
      expect(bytes.byteLength).toBe(file.byteSize);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
  });

  it("verifies the committed production detached CMS and pinned publisher without signing credentials", async () => {
    const { manifest, signature, allowlist, options } = await committedTrust();
    await expect(verifyDetachedCmsSignature(manifest, signature, allowlist)).resolves.toEqual({
      signerThumbprint: "CA17FDAB1BA0435732689799B64C9586EE28219AE5546B952371A97FDB84FF2B",
      matchedPublisher: "current"
    });
    await expect(verifyInstalledResourcePack(options)).resolves.toEqual({ absolutePath: options.packRoot });
  });

  it("fails closed for a wrong production publisher, modified CMS or manifest, and wrong lock hash", async () => {
    const { manifest, signature, allowlist, options } = await committedTrust();
    await expect(verifyDetachedCmsSignature(manifest, signature, { current: "00".repeat(32) }))
      .rejects.toMatchObject({ code: "CMS_SIGNER_UNPINNED" });
    const damagedSignature = Buffer.from(signature);
    damagedSignature[damagedSignature.length - 1]! ^= 1;
    await expect(verifyDetachedCmsSignature(manifest, damagedSignature, allowlist)).rejects.toThrow();
    await expect(verifyDetachedCmsSignature(Buffer.concat([manifest, Buffer.from("\n")]), signature, allowlist))
      .rejects.toMatchObject({ code: "CMS_SIGNATURE_INVALID" });
    await expect(verifyInstalledResourcePack({
      ...options, entry: { ...options.entry, manifestSha256: "00".repeat(32) }
    })).rejects.toMatchObject({ code: "RESOURCE_CORRUPT" });
    const fontPath = join(options.packRoot, "PretendardVariable.ttf");
    const fontBytes = await readFile(fontPath);
    fontBytes[fontBytes.length - 1]! ^= 1;
    await writeFile(fontPath, fontBytes);
    await expect(verifyInstalledResourcePack(options)).rejects.toMatchObject({ code: "RESOURCE_CORRUPT" });
  });
});

async function committedTrust() {
  const manifest = await readFile(join(sourceRoot, "resource-manifest.json"));
  const signature = await readFile(join(sourceRoot, "resource-manifest.p7s"));
  const allowlist = normalizeCmsPublisherAllowlist(JSON.parse(
    await readFile(join(pipelineRoot, "font-publisher-allowlist.json"), "utf8")
  ));
  const lock = parsePipelineResourceLockV1(JSON.parse(
    await readFile(join(pipelineRoot, "pipeline-resource-lock.json"), "utf8")
  ));
  const entry = lock.resources.find((resource) => resource.role === "font_ko_fallback")!;
  // Match extraResources: source-manifest.json is source provenance, not a payload.
  const packRoot = await mkdtemp(join(tmpdir(), "trio-committed-font-"));
  temporaryPacks.push(packRoot);
  for (const name of ["resource-manifest.json", "resource-manifest.p7s", "PretendardVariable.ttf", "LICENSE.txt"]) {
    await copyFile(join(sourceRoot, name), join(packRoot, name));
  }
  return { manifest, signature, allowlist, options: {
    packRoot, entry, pipelineVersion: lock.pipelineVersion, publisherAllowlist: allowlist
  } };
}
