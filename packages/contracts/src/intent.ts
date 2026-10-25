import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { DomainError } from './errors.js';

export function digest(value: unknown): string {
  let bytes: string | undefined;
  try { bytes = canonicalize(value); } catch { throw new DomainError('INPUT_INVALID', 422); }
  if (bytes === undefined) throw new DomainError('INPUT_INVALID', 422);
  return createHash('sha256').update(bytes).digest('hex');
}
export function intentDigest(command: { commandId: string; [key: string]: unknown }): string {
  const { commandId: _transportId, ...intent } = command;
  return digest(intent);
}
export function sha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
