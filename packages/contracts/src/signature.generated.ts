/* Generated from application-owned schemas by npm run contracts:generate. Do not edit. */

/**
 * This interface was referenced by `SignatureEnvelope`'s JSON-Schema
 * via the `definition` "version".
 */
export type Version = string;
/**
 * This interface was referenced by `SignatureEnvelope`'s JSON-Schema
 * via the `definition` "id".
 */
export type Id = string;

export interface SignatureEnvelope {
  schemaVersion: 1;
  keyId: Version;
  algorithm: "Ed25519";
  signatureBase64: string;
}
