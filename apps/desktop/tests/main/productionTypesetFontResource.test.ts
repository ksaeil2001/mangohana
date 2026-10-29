import { createHash, webcrypto } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as asn1js from "asn1js";
import { AttributeTypeAndValue, Certificate, ContentInfo, EncapsulatedContentInfo, IssuerAndSerialNumber, SignedData, SignerInfo } from "pkijs";
import { preflightPipelineResources } from "../../src/main/resourcePreflight";
import {
  PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY,
  PRODUCTION_TYPESET_FONT_URL
} from "../../src/shared/productionTypesetFontResource";
import {
  initializeProductionTypesetFontResource,
  type ProductionTypesetFontResource
} from "../../src/main/productionTypesetFontResource";

const temporaryRoots: string[] = [];
let testCertificate: Certificate;
let testPrivateKey: CryptoKey;
let testPublisherPin: string;

beforeAll(async () => {
  // Test-only signer: the private key exists only in memory and is never packaged.
  const keys = await webcrypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"
  }, true, ["sign", "verify"]);
  testPrivateKey = keys.privateKey as CryptoKey;
  testCertificate = new Certificate();
  testCertificate.version = 2;
  testCertificate.serialNumber = new asn1js.Integer({ value: 1 });
  const subject = new AttributeTypeAndValue({
    type: "2.5.4.3", value: new asn1js.Utf8String({ value: "Fixture Only - Not Production" })
  });
  testCertificate.subject.typesAndValues.push(subject);
  testCertificate.issuer.typesAndValues.push(subject);
  testCertificate.notBefore.value = new Date(Date.now() - 60_000);
  testCertificate.notAfter.value = new Date(Date.now() + 86_400_000);
  await testCertificate.subjectPublicKeyInfo.importKey(keys.publicKey as CryptoKey);
  await testCertificate.sign(testPrivateKey, "SHA-256");
  testPublisherPin = sha256(new Uint8Array(testCertificate.toSchema(true).toBER(false)));
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    )
  );
});

describe("Main-owned production typeset font resource", () => {
  it("preflights the fixed bundled pack and serves only the exact font URL", async () => {
    const fixture = await createFixture();
    const resource = await initializeProductionTypesetFontResource(fixture.root);

    expect(resource.enabled).toBe(true);
    await expect(
      resource.verifyInstalledTypesetFontResource(
        PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY
      )
    ).resolves.toBe(true);
    await expect(
      resource.verifyInstalledTypesetFontResource("Pretendard@1.3.9")
    ).resolves.toBe(false);

    const response = await resource.handleProtocolRequest({
      url: PRODUCTION_TYPESET_FONT_URL
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("font/ttf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer()).equals(fixture.fontBytes)).toBe(true);

    for (const url of [
      "trio-resource://font/pretendard-variable.ttf?cache=1",
      "trio-resource://font/../pretendard-variable.ttf",
      "trio-resource://other/pretendard-variable.ttf",
      "trio-resource://font/other.ttf",
      "https://example.test/font/pretendard-variable.ttf"
    ]) {
      const rejected = await resource.handleProtocolRequest({ url });
      expect(rejected.status).toBe(404);
    }
  });

  it("fails closed when the production allowlist or detached signature is absent", async () => {
    const fixture = await createFixture();
    await rm(join(fixture.pipelineRoot, "font-publisher-allowlist.json"));
    const resource = await initializeProductionTypesetFontResource(fixture.root);

    expect(resource.enabled).toBe(false);
    await expect(
      resource.verifyInstalledTypesetFontResource(
        PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY
      )
    ).resolves.toBe(false);
    await expect(
      resource.handleProtocolRequest({ url: PRODUCTION_TYPESET_FONT_URL })
    ).resolves.toMatchObject({ status: 404 });
  });

  it("fails closed when the fixed resource binding or font probe does not match", async () => {
    const fixture = await createFixture();
    const lockPath = join(fixture.pipelineRoot, "pipeline-resource-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      resources: Array<{ resourceId: string }>;
    };
    lock.resources[0]!.resourceId = "unexpected-font";
    await writeFile(lockPath, JSON.stringify(lock));
    const resource = await initializeProductionTypesetFontResource(fixture.root);

    expect(resource.enabled).toBe(false);
    await expect(
      resource.handleProtocolRequest({ url: PRODUCTION_TYPESET_FONT_URL })
    ).resolves.toMatchObject({ status: 404 });
  });

  it.each(["wrong publisher", "modified manifest", "reserialized manifest", "modified font", "missing signature", "malformed CMS"])(
    "rejects %s through the real CMS and hash verification path", async (failure) => {
      const fixture = await createFixture();
      const packRoot = join(fixture.pipelineRoot, "pretendard-ko-fallback", "1.3.9");
      if (failure === "wrong publisher") {
        await writeFile(join(fixture.pipelineRoot, "font-publisher-allowlist.json"), JSON.stringify({ current: "11".repeat(32) }));
      } else if (failure === "modified manifest" || failure === "reserialized manifest") {
        const manifestPath = join(packRoot, "resource-manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (failure === "modified manifest") manifest.compatiblePipelineVersions.push("2.0.0");
        const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
        await writeFile(manifestPath, bytes);
        // Even a matching lock hash must not replace exact-byte CMS verification.
        const lockPath = join(fixture.pipelineRoot, "pipeline-resource-lock.json");
        const lock = JSON.parse(await readFile(lockPath, "utf8"));
        lock.resources[0].manifestSha256 = sha256(bytes);
        await writeFile(lockPath, JSON.stringify(lock));
      } else if (failure === "modified font") {
        const bytes = Buffer.from(fixture.fontBytes);
        bytes[bytes.length - 1] ^= 1;
        await writeFile(join(packRoot, "PretendardVariable.ttf"), bytes);
      } else if (failure === "missing signature") {
        await rm(join(packRoot, "resource-manifest.p7s"));
      } else {
        await writeFile(join(packRoot, "resource-manifest.p7s"), Buffer.from([1, 2, 3]));
      }
      await expectDisabled(await initializeProductionTypesetFontResource(fixture.root));
    }
  );

  it("rejects a font replaced between preflight hash verification and protocol byte capture", async () => {
    const fixture = await createFixture();
    const resource = await initializeProductionTypesetFontResource(fixture.root, {
      preflight: (options) => preflightPipelineResources({
        ...options,
        probes: { font_ko_fallback: async (binding) => {
          const bytes = Buffer.from(fixture.fontBytes);
          bytes[bytes.length - 1] ^= 1;
          await writeFile(join(binding.absolutePath, "PretendardVariable.ttf"), bytes);
          await options.probes.font_ko_fallback!(binding);
        } }
      })
    });
    await expectDisabled(resource);
  });

  it("rejects a pack reached through a directory junction", async () => {
    const fixture = await createFixture(true);
    await expectDisabled(await initializeProductionTypesetFontResource(fixture.root));
  });
});

async function expectDisabled(resource: ProductionTypesetFontResource): Promise<void> {
  expect(resource.enabled).toBe(false);
  await expect(resource.verifyInstalledTypesetFontResource(PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY)).resolves.toBe(false);
  await expect(resource.handleProtocolRequest({ url: PRODUCTION_TYPESET_FONT_URL })).resolves.toMatchObject({ status: 404 });
}

type Fixture = Readonly<{
  root: string;
  pipelineRoot: string;
  fontBytes: Buffer;
}>;

async function createFixture(junction = false): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "trio-font-"));
  temporaryRoots.push(root);
  const pipelineRoot = join(root, "pipeline-resources");
  const expectedPackRoot = join(
    pipelineRoot,
    "pretendard-ko-fallback",
    "1.3.9"
  );
  const packRoot = junction ? join(root, "relocated-pack") : expectedPackRoot;
  if (junction) {
    await mkdir(join(pipelineRoot, "pretendard-ko-fallback"), { recursive: true });
  }
  await mkdir(packRoot, { recursive: true });

  const fontBytes = await readFile(join(process.cwd(), "resources/font_ko_fallback/pretendard-1.3.9/PretendardVariable.ttf"));
  const licenseBytes = Buffer.from("OFL test license");
  const manifest = {
    schemaVersion: 1,
    resourceId: "pretendard-ko-fallback",
    role: "font_ko_fallback",
    version: "1.3.9",
    compatiblePipelineVersions: ["1.0.0"],
    files: [
      {
        relativePath: "PretendardVariable.ttf",
        byteSize: fontBytes.byteLength,
        sha256: sha256(fontBytes)
      },
      {
        relativePath: "LICENSE.txt",
        byteSize: licenseBytes.byteLength,
        sha256: sha256(licenseBytes)
      }
    ],
    licenseFiles: ["LICENSE.txt"]
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(packRoot, "resource-manifest.json"), manifestBytes);
  const signedData = new SignedData({
    encapContentInfo: new EncapsulatedContentInfo({ eContentType: ContentInfo.DATA }),
    certificates: [testCertificate],
    signerInfos: [new SignerInfo({
      sid: new IssuerAndSerialNumber({ issuer: testCertificate.issuer, serialNumber: testCertificate.serialNumber })
    })]
  });
  await signedData.sign(testPrivateKey, 0, "SHA-256", Uint8Array.from(manifestBytes).buffer);
  const cms = new ContentInfo({ contentType: ContentInfo.SIGNED_DATA, content: signedData.toSchema(true) });
  await writeFile(join(packRoot, "resource-manifest.p7s"), new Uint8Array(cms.toSchema().toBER(false)));
  await writeFile(join(packRoot, "PretendardVariable.ttf"), fontBytes);
  await writeFile(join(packRoot, "LICENSE.txt"), licenseBytes);
  await writeFile(
    join(pipelineRoot, "font-publisher-allowlist.json"),
    JSON.stringify({ current: testPublisherPin })
  );
  await writeFile(
    join(pipelineRoot, "pipeline-resource-lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      appVersion: "0.1.4",
      pipelineVersion: "1.0.0",
      resources: [
        {
          role: "font_ko_fallback",
          resourceId: "pretendard-ko-fallback",
          version: "1.3.9",
          manifestSha256: sha256(manifestBytes),
          distribution: "bundled",
          requiredFor: ["typeset"]
        }
      ]
    })
  );
  if (junction) await symlink(packRoot, expectedPackRoot, process.platform === "win32" ? "junction" : "dir");
  return { root, pipelineRoot, fontBytes };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
