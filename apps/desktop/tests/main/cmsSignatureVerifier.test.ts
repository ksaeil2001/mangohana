import { createHash } from "node:crypto";
// @vitest-environment node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as asn1js from "asn1js";
import { Certificate, ContentInfo, SignedData } from "pkijs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CmsSignatureValidationError,
  normalizeCertificateThumbprint,
  verifyDetachedCmsSignature,
  type CmsPublisherAllowlist,
  type CmsSignatureValidationCode
} from "../../src/main/cmsSignatureVerifier";

const fixtureDirectory = join(process.cwd(), "tests", "fixtures", "pipeline-signing");
const sha256Oid = "2.16.840.1.101.3.4.2.1";
const sha1WithRsaOid = "1.2.840.113549.1.1.5";

let manifestBytes: Uint8Array;
let validSignatureBytes: Uint8Array;
let untrustedSignatureBytes: Uint8Array;
let sameSubjectSignatureBytes: Uint8Array;
let sha1SignatureBytes: Uint8Array;
let rsa2048SignatureBytes: Uint8Array;
let pinnedThumbprint: string;
let rsa2048Thumbprint: string;

beforeAll(async () => {
  [
    manifestBytes,
    validSignatureBytes,
    untrustedSignatureBytes,
    sameSubjectSignatureBytes,
    sha1SignatureBytes,
    rsa2048SignatureBytes
  ] = await Promise.all([
    readFixture("pipeline-manifest.json"),
    readFixture("valid-signature.p7s"),
    readFixture("untrusted-signature.p7s"),
    readFixture("same-subject-signature.p7s"),
    readFixture("sha1-signature.p7s"),
    readFixture("rsa2048-signature.p7s")
  ]);
  pinnedThumbprint = createHash("sha256")
    .update(await readFixture("test-publisher.cer"))
    .digest("hex")
    .toUpperCase();
  rsa2048Thumbprint = createHash("sha256")
    .update(await readFixture("rsa2048-publisher.cer"))
    .digest("hex")
    .toUpperCase();
});

describe("detached CMS manifest signature verification", () => {
  it("verifies the exact manifest bytes with the current pinned publisher", async () => {
    await expect(verifyDetachedCmsSignature(
      manifestBytes,
      validSignatureBytes,
      { current: pinnedThumbprint.toLowerCase() }
    )).resolves.toEqual({
      signerThumbprint: pinnedThumbprint,
      matchedPublisher: "current"
    });
  });

  it("accepts the pinned publisher in the optional next slot", async () => {
    await expect(verifyDetachedCmsSignature(
      manifestBytes,
      validSignatureBytes,
      { current: "11".repeat(32), next: pinnedThumbprint }
    )).resolves.toEqual({
      signerThumbprint: pinnedThumbprint,
      matchedPublisher: "next"
    });
  });

  it("rejects one-byte payload tampering", async () => {
    const tamperedManifest = Uint8Array.from(manifestBytes);
    tamperedManifest[0] ^= 1;

    await expectCmsError(
      () => verifyDetachedCmsSignature(tamperedManifest, validSignatureBytes, pinnedAllowlist()),
      "CMS_SIGNATURE_INVALID"
    );
  });

  it("rejects signer signature tampering", async () => {
    const tamperedSignature = mutateSignedData(validSignatureBytes, (signedData) => {
      const value = Uint8Array.from(signedData.signerInfos[0]!.signature.valueBlock.valueHexView);
      value[0] ^= 1;
      signedData.signerInfos[0]!.signature.valueBlock.valueHexView = value;
    });

    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, tamperedSignature, pinnedAllowlist()),
      "CMS_SIGNATURE_INVALID"
    );
  });

  it("verifies cryptography before rejecting a different unpinned signer", async () => {
    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, untrustedSignatureBytes, pinnedAllowlist()),
      "CMS_SIGNER_UNPINNED"
    );

    const tamperedUntrustedSignature = mutateSignedData(untrustedSignatureBytes, (signedData) => {
      const value = Uint8Array.from(signedData.signerInfos[0]!.signature.valueBlock.valueHexView);
      value[0] ^= 1;
      signedData.signerInfos[0]!.signature.valueBlock.valueHexView = value;
    });
    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, tamperedUntrustedSignature, pinnedAllowlist()),
      "CMS_SIGNATURE_INVALID"
    );
  });

  it("rejects a certificate with the same subject but a different thumbprint", async () => {
    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, sameSubjectSignatureBytes, pinnedAllowlist()),
      "CMS_SIGNER_UNPINNED"
    );
  });

  it("rejects SHA-1 digest algorithms", async () => {
    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, sha1SignatureBytes, pinnedAllowlist()),
      "CMS_ALGORITHM_UNSUPPORTED"
    );
  });

  it("rejects a SHA-1 signature algorithm identifier", async () => {
    const sha1SignatureAlgorithm = mutateSignedData(validSignatureBytes, (signedData) => {
      signedData.digestAlgorithms[0]!.algorithmId = sha256Oid;
      signedData.signerInfos[0]!.digestAlgorithm.algorithmId = sha256Oid;
      signedData.signerInfos[0]!.signatureAlgorithm.algorithmId = sha1WithRsaOid;
    });

    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, sha1SignatureAlgorithm, pinnedAllowlist()),
      "CMS_ALGORITHM_UNSUPPORTED"
    );
  });

  it("rejects an otherwise-valid RSA-2048/SHA-256 signer", async () => {
    await expectCmsError(
      () => verifyDetachedCmsSignature(
        manifestBytes,
        rsa2048SignatureBytes,
        { current: rsa2048Thumbprint }
      ),
      "CMS_ALGORITHM_UNSUPPORTED"
    );
  });

  it("rejects zero signers", async () => {
    const zeroSignerSignature = mutateSignedData(validSignatureBytes, (signedData) => {
      signedData.signerInfos = [];
    });

    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, zeroSignerSignature, pinnedAllowlist()),
      "CMS_SIGNER_COUNT_INVALID"
    );
  });

  it("rejects two signers", async () => {
    const twoSignerSignature = mutateSignedData(validSignatureBytes, (signedData) => {
      signedData.signerInfos.push(signedData.signerInfos[0]!);
    });

    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, twoSignerSignature, pinnedAllowlist()),
      "CMS_SIGNER_COUNT_INVALID"
    );
  });

  it("rejects a CMS object with embedded content instead of detached content", async () => {
    const attachedSignature = mutateSignedData(validSignatureBytes, (signedData) => {
      signedData.encapContentInfo.eContent = new asn1js.OctetString({
        valueHex: manifestBytes
      });
    });

    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, attachedSignature, pinnedAllowlist()),
      "CMS_NOT_DETACHED"
    );
  });

  it("rejects a signer certificate whose own signature is invalid", async () => {
    const invalidCertificateSignature = mutateSignedData(validSignatureBytes, (signedData) => {
      const certificate = requireSingleCertificate(signedData);
      const value = Uint8Array.from(certificate.signatureValue.valueBlock.valueHexView);
      value[0] ^= 1;
      certificate.signatureValue.valueBlock.valueHexView = value;
    });

    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, invalidCertificateSignature, pinnedAllowlist()),
      "CMS_CERTIFICATE_INVALID"
    );
  });

  it("returns a typed generic error for malformed CMS bytes", async () => {
    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, Uint8Array.of(1, 2, 3), pinnedAllowlist()),
      "CMS_FORMAT_INVALID"
    );
  });
});

describe("publisher thumbprint policy", () => {
  it("normalizes a 32-byte SHA-256 thumbprint to uppercase hex", () => {
    expect(normalizeCertificateThumbprint("ab".repeat(32))).toBe("AB".repeat(32));
  });

  it.each([
    ["too short", "ab".repeat(31)],
    ["too long", "ab".repeat(33)],
    ["separator", "AA:BB".padEnd(64, "A")],
    ["whitespace", ` ${"ab".repeat(32)}`],
    ["non-hex", `${"ab".repeat(31)}zz`]
  ])("rejects an invalid thumbprint: %s", (_reason, thumbprint) => {
    expectSyncCmsError(
      () => normalizeCertificateThumbprint(thumbprint),
      "CMS_THUMBPRINT_INVALID"
    );
  });

  it("rejects duplicate current and next thumbprints after normalization", async () => {
    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, validSignatureBytes, {
        current: pinnedThumbprint,
        next: pinnedThumbprint.toLowerCase()
      }),
      "CMS_ALLOWLIST_INVALID"
    );
  });

  it("rejects more than the current and next allowlist slots", async () => {
    const tooMany = {
      current: pinnedThumbprint,
      next: "11".repeat(32),
      future: "22".repeat(32)
    } as unknown as CmsPublisherAllowlist;

    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, validSignatureBytes, tooMany),
      "CMS_ALLOWLIST_INVALID"
    );
  });

  it("rejects an invalid allowlist entry with a stable typed error", async () => {
    await expectCmsError(
      () => verifyDetachedCmsSignature(manifestBytes, validSignatureBytes, {
        current: "not-a-thumbprint"
      }),
      "CMS_THUMBPRINT_INVALID"
    );
  });
});

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(fixtureDirectory, name)));
}

function pinnedAllowlist(): CmsPublisherAllowlist {
  return { current: pinnedThumbprint };
}

function mutateSignedData(
  signatureBytes: Uint8Array,
  mutate: (signedData: SignedData) => void
): Uint8Array {
  const contentInfo = ContentInfo.fromBER(Uint8Array.from(signatureBytes).buffer);
  const signedData = new SignedData({ schema: contentInfo.content });
  mutate(signedData);
  contentInfo.content = signedData.toSchema(true);
  return new Uint8Array(contentInfo.toSchema().toBER(false));
}

function requireSingleCertificate(signedData: SignedData): Certificate {
  const certificates = signedData.certificates?.filter(
    (certificate): certificate is Certificate => certificate instanceof Certificate
  ) ?? [];
  expect(certificates).toHaveLength(1);
  return certificates[0]!;
}

async function expectCmsError(
  action: () => Promise<unknown>,
  code: CmsSignatureValidationCode
): Promise<void> {
  let thrown: unknown;

  try {
    await action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(CmsSignatureValidationError);
  if (!(thrown instanceof CmsSignatureValidationError)) return;
  expect(thrown.code).toBe(code);
  expect(thrown.message).toBe("Invalid detached CMS signature");
}

function expectSyncCmsError(
  action: () => unknown,
  code: CmsSignatureValidationCode
): void {
  let thrown: unknown;

  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(CmsSignatureValidationError);
  if (!(thrown instanceof CmsSignatureValidationError)) return;
  expect(thrown.code).toBe(code);
  expect(thrown.message).toBe("Invalid detached CMS signature");
}
