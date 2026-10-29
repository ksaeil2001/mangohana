import { randomBytes, scryptSync } from "node:crypto";
import type { SecretProjectSecurityV1 } from "../shared/projectTypes.js";

export type SecretProjectProtection = {
  containerKey: Buffer;
  containerSalt: Buffer;
  artifactMasterKey: Buffer;
  passwordBytes: Buffer;
};

export function createSecretProtection(
  password: string,
  artifactMasterKey: Buffer = randomBytes(32),
  salt: Buffer = randomBytes(16)
): SecretProjectProtection {
  if (!password) throw new Error("A password is required for secret projects");
  if (artifactMasterKey.length !== 32) throw new Error("Artifact master key must be 32 bytes");
  if (salt.length !== 16) throw new Error("Container salt must be 16 bytes");
  return {
    containerKey: scryptSync(password, salt, 32),
    containerSalt: Buffer.from(salt),
    artifactMasterKey: Buffer.from(artifactMasterKey),
    passwordBytes: Buffer.from(password, "utf8")
  };
}

export function rekeySecretProtection(
  current: SecretProjectProtection,
  newPassword: string
): SecretProjectProtection {
  return createSecretProtection(newPassword, current.artifactMasterKey);
}

export function securityFromArtifactKey(artifactMasterKey: Buffer): SecretProjectSecurityV1 {
  if (artifactMasterKey.length !== 32) throw new Error("Artifact master key must be 32 bytes");
  return {
    artifactKeyVersion: 1,
    artifactMasterKeyB64: artifactMasterKey.toString("base64")
  };
}

export function artifactKeyFromSecurity(security: SecretProjectSecurityV1): Buffer {
  if (security.artifactKeyVersion !== 1) throw new Error("Unsupported artifact key version");
  const key = Buffer.from(security.artifactMasterKeyB64, "base64");
  if (key.length !== 32) throw new Error("Invalid artifact master key");
  return key;
}

export function zeroizeProtection(protection: SecretProjectProtection): void {
  protection.containerKey.fill(0);
  protection.containerSalt.fill(0);
  protection.artifactMasterKey.fill(0);
  protection.passwordBytes.fill(0);
}
