import { createHash } from "node:crypto";
import { webcrypto } from "node:crypto";
import {
  Certificate,
  ContentInfo,
  setEngine,
  SignedData
} from "pkijs";

// The Electron main process and Vitest's Node environment do not guarantee a
// browser-like global crypto object. PKIJS needs an explicit WebCrypto engine
// before it can verify CMS signatures.
setEngine(
  "node-webcrypto",
  webcrypto as unknown as Crypto,
  webcrypto.subtle as unknown as SubtleCrypto
);

export type CmsSignatureValidationCode =
  | "CMS_THUMBPRINT_INVALID"
  | "CMS_ALLOWLIST_INVALID"
  | "CMS_FORMAT_INVALID"
  | "CMS_NOT_DETACHED"
  | "CMS_SIGNER_COUNT_INVALID"
  | "CMS_ALGORITHM_UNSUPPORTED"
  | "CMS_CERTIFICATE_INVALID"
  | "CMS_SIGNATURE_INVALID"
  | "CMS_SIGNER_UNPINNED";

export type CmsPublisherAllowlist = {
  current: string;
  next?: string;
};

export type CmsSignatureVerification = {
  signerThumbprint: string;
  matchedPublisher: "current" | "next";
};

export class CmsSignatureValidationError extends Error {
  readonly code: CmsSignatureValidationCode;

  constructor(code: CmsSignatureValidationCode) {
    super("Invalid detached CMS signature");
    this.name = "CmsSignatureValidationError";
    this.code = code;
  }
}

const sha256Oid = "2.16.840.1.101.3.4.2.1";
const rsaEncryptionOid = "1.2.840.113549.1.1.1";
const sha256WithRsaEncryptionOid = "1.2.840.113549.1.1.11";

export function normalizeCertificateThumbprint(thumbprint: string): string {
  if (typeof thumbprint !== "string" || !/^[0-9a-fA-F]{64}$/.test(thumbprint)) {
    throw new CmsSignatureValidationError("CMS_THUMBPRINT_INVALID");
  }

  return thumbprint.toUpperCase();
}

export async function verifyDetachedCmsSignature(
  manifestBytes: Uint8Array,
  signatureBytes: Uint8Array,
  allowlist: CmsPublisherAllowlist
): Promise<CmsSignatureVerification> {
  const normalizedAllowlist = normalizeCmsPublisherAllowlist(allowlist);
  const signedData = parseDetachedSignedData(signatureBytes);
  enforceSignerAndAlgorithmPolicy(signedData);

  const verification = await verifyCmsSignature(signedData, manifestBytes);
  const signerCertificate = verification.signerCertificate;
  if (!(signerCertificate instanceof Certificate)) {
    throw new CmsSignatureValidationError("CMS_CERTIFICATE_INVALID");
  }

  await verifyCertificate(signerCertificate, signedData);
  await enforceRsa3072Sha256Key(signerCertificate);

  const signerThumbprint = createHash("sha256")
    .update(new Uint8Array(signerCertificate.toSchema(true).toBER(false)))
    .digest("hex")
    .toUpperCase();

  if (signerThumbprint === normalizedAllowlist.current) {
    return { signerThumbprint, matchedPublisher: "current" };
  }
  if (signerThumbprint === normalizedAllowlist.next) {
    return { signerThumbprint, matchedPublisher: "next" };
  }

  throw new CmsSignatureValidationError("CMS_SIGNER_UNPINNED");
}

export function normalizeCmsPublisherAllowlist(
  allowlist: CmsPublisherAllowlist
): Readonly<CmsPublisherAllowlist> {
  if (typeof allowlist !== "object" || allowlist === null || Array.isArray(allowlist)) {
    throw new CmsSignatureValidationError("CMS_ALLOWLIST_INVALID");
  }

  const record = allowlist as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    !Object.hasOwn(record, "current") ||
    keys.length < 1 ||
    keys.length > 2 ||
    keys.some((key) => key !== "current" && key !== "next")
  ) {
    throw new CmsSignatureValidationError("CMS_ALLOWLIST_INVALID");
  }

  const current = normalizeCertificateThumbprint(record.current as string);
  const next = Object.hasOwn(record, "next")
    ? normalizeCertificateThumbprint(record.next as string)
    : undefined;

  if (next === current) {
    throw new CmsSignatureValidationError("CMS_ALLOWLIST_INVALID");
  }

  return Object.freeze(
    next === undefined ? { current } : { current, next }
  );
}

function parseDetachedSignedData(signatureBytes: Uint8Array): SignedData {
  let contentInfo: ContentInfo;
  let signedData: SignedData;

  try {
    contentInfo = ContentInfo.fromBER(toArrayBuffer(signatureBytes));
    if (contentInfo.contentType !== ContentInfo.SIGNED_DATA) {
      throw new Error("Unexpected CMS content type");
    }
    signedData = new SignedData({ schema: contentInfo.content });
  } catch {
    throw new CmsSignatureValidationError("CMS_FORMAT_INVALID");
  }

  if (signedData.encapContentInfo.eContent !== undefined) {
    throw new CmsSignatureValidationError("CMS_NOT_DETACHED");
  }
  if (signedData.encapContentInfo.eContentType !== ContentInfo.DATA) {
    throw new CmsSignatureValidationError("CMS_FORMAT_INVALID");
  }

  return signedData;
}

function enforceSignerAndAlgorithmPolicy(signedData: SignedData): void {
  if (signedData.signerInfos.length !== 1) {
    throw new CmsSignatureValidationError("CMS_SIGNER_COUNT_INVALID");
  }

  const signerInfo = signedData.signerInfos[0]!;
  const digestAlgorithmsAreSha256 = signedData.digestAlgorithms.length > 0
    && signedData.digestAlgorithms.every((algorithm) => algorithm.algorithmId === sha256Oid);
  const signatureAlgorithmIsSha256Rsa =
    signerInfo.signatureAlgorithm.algorithmId === sha256WithRsaEncryptionOid
    || signerInfo.signatureAlgorithm.algorithmId === rsaEncryptionOid;

  if (
    !digestAlgorithmsAreSha256
    || signerInfo.digestAlgorithm.algorithmId !== sha256Oid
    || !signatureAlgorithmIsSha256Rsa
  ) {
    throw new CmsSignatureValidationError("CMS_ALGORITHM_UNSUPPORTED");
  }
}

async function verifyCmsSignature(
  signedData: SignedData,
  manifestBytes: Uint8Array
): Promise<{
  signerCertificate: Certificate | null;
}> {
  try {
    const result = await signedData.verify({
      signer: 0,
      data: toArrayBuffer(manifestBytes),
      checkChain: false,
      extendedMode: true
    });

    if (result.signatureVerified !== true) {
      throw new Error("CMS signature did not verify");
    }
    return { signerCertificate: result.signerCertificate ?? null };
  } catch {
    throw new CmsSignatureValidationError("CMS_SIGNATURE_INVALID");
  }
}

async function verifyCertificate(
  signerCertificate: Certificate,
  signedData: SignedData
): Promise<void> {
  if (
    signerCertificate.signature.algorithmId !== sha256WithRsaEncryptionOid
    || signerCertificate.signatureAlgorithm.algorithmId !== sha256WithRsaEncryptionOid
  ) {
    throw new CmsSignatureValidationError("CMS_ALGORITHM_UNSUPPORTED");
  }

  const now = Date.now();
  if (
    signerCertificate.notBefore.value.getTime() > now
    || signerCertificate.notAfter.value.getTime() < now
  ) {
    throw new CmsSignatureValidationError("CMS_CERTIFICATE_INVALID");
  }

  const possibleIssuers = signedData.certificates?.filter(
    (certificate): certificate is Certificate =>
      certificate instanceof Certificate
      && signerCertificate.issuer.isEqual(certificate.subject)
  ) ?? [];

  for (const possibleIssuer of possibleIssuers) {
    try {
      if (await signerCertificate.verify(possibleIssuer)) return;
    } catch {
      // Try the remaining embedded issuer certificates.
    }
  }

  throw new CmsSignatureValidationError("CMS_CERTIFICATE_INVALID");
}

async function enforceRsa3072Sha256Key(signerCertificate: Certificate): Promise<void> {
  let publicKey: CryptoKey;

  try {
    publicKey = await signerCertificate.getPublicKey();
  } catch {
    throw new CmsSignatureValidationError("CMS_CERTIFICATE_INVALID");
  }

  const algorithm = publicKey.algorithm;
  const hash = "hash" in algorithm ? algorithm.hash : undefined;
  if (
    algorithm.name !== "RSASSA-PKCS1-v1_5"
    || !("modulusLength" in algorithm)
    || algorithm.modulusLength !== 3072
    || typeof hash !== "object"
    || hash === null
    || !("name" in hash)
    || hash.name !== "SHA-256"
  ) {
    throw new CmsSignatureValidationError("CMS_ALGORITHM_UNSUPPORTED");
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
