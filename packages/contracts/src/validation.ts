import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import wire from '../schemas/wire-v1.schema.json' with {type:'json'};
import manifest from '../schemas/manifest-v1.schema.json' with {type:'json'};
import signature from '../schemas/signature-v1.schema.json' with {type:'json'};
import { DomainError } from './errors.js';

const validator = new Ajv({ strict: true, allErrors: true, validateFormats: true });
addFormats(validator);
validator.addSchema(wire);
const definitions = new Map<string, ReturnType<typeof validator.compile>>();
for (const name of Object.keys(wire.definitions)) definitions.set(name, validator.compile({ $ref: `${wire.$id}#/definitions/${name}` }));
const validateManifest = validator.compile(manifest);
const validateSignature = validator.compile(signature);

export function assertWire<T>(name: keyof typeof wire.definitions, value: unknown): asserts value is T {
  if (!definitions.get(name)?.(value)) throw new DomainError('INPUT_INVALID', 422);
  validatePreciseValues(value);
}
export function assertManifest<T>(value: unknown): asserts value is T {
  if (!validateManifest(value)) throw new DomainError('FILE_INVALID', 422);
  validatePreciseValues(value);
}
export function assertSignature<T>(value: unknown): asserts value is T {
  if (!validateSignature(value)) throw new DomainError('FILE_INVALID', 422);
}
export function counter(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new DomainError('INPUT_INVALID', 422);
  const parsed = BigInt(value);
  if (parsed > 9223372036854775807n) throw new DomainError('INPUT_INVALID', 422);
  return parsed;
}
export function money(value: string, signed = false): string {
  const pattern = signed ? /^-?(0|[1-9]\d{0,15})(\.\d{1,12})?$/ : /^(0|[1-9]\d{0,15})(\.\d{1,12})?$/;
  if (!pattern.test(value)) throw new DomainError('INPUT_INVALID', 422);
  return value;
}
export function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { const low = value.charCodeAt(++index); if (!(low >= 0xdc00 && low <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function validatePreciseValues(value: unknown): void {
  if (typeof value === 'string') { if (!validUnicode(value)) throw new DomainError('INPUT_INVALID', 422); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new DomainError('INPUT_INVALID', 422); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && /(?:Revision|Generation|Version|Seq|BytesLength|bytesLength|baselineRevision)$/.test(key) && /^\d+$/.test(entry)) counter(entry);
    if (typeof entry === 'string' && /(?:Credit|Usd|creditDelta|paidCumulativeBaseline)$/.test(key)) money(entry, key === 'creditDelta');
    validatePreciseValues(entry);
  }
}
