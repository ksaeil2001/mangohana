import { DomainError } from './errors.js';
import { validUnicode } from './validation.js';

// Duplicate keys are rejected before JSON.parse can discard the first value.
export function parseStrictJson(text: string, maxBytes = 262144): unknown {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new DomainError('INPUT_INVALID', 413);
  let at = 0;
  const fail = (): never => { throw new DomainError('INPUT_INVALID', 422); };
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[at] ?? '') && at < text.length) at++; };
  const string = (): string => {
    if (text[at++] !== '"') return fail();
    const start = at - 1;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === '\\') { at++; continue; }
      if (ch === '"') {
        let value: string;
        try { value = JSON.parse(text.slice(start, at)); } catch { return fail(); }
        if (!validUnicode(value)) return fail();
        return value;
      }
    }
    return fail();
  };
  const value = (depth = 0): void => {
    if (depth > 100) return fail();
    whitespace();
    if (text[at] === '"') { string(); return; }
    if (text[at] === '{') {
      at++; whitespace(); const keys = new Set<string>();
      if (text[at] === '}') { at++; return; }
      for (;;) {
        const key = string(); if (keys.has(key)) return fail(); keys.add(key);
        whitespace(); if (text[at++] !== ':') return fail(); value(depth + 1); whitespace();
        const end = text[at++]; if (end === '}') return; if (end !== ',') return fail(); whitespace();
      }
    }
    if (text[at] === '[') {
      at++; whitespace(); if (text[at] === ']') { at++; return; }
      for (;;) { value(depth + 1); whitespace(); const end = text[at++]; if (end === ']') return; if (end !== ',') return fail(); }
    }
    const token = text.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) return fail();
    if (!['true','false','null'].includes(token) && (!Number.isFinite(Number(token)) || Math.abs(Number(token)) > Number.MAX_SAFE_INTEGER)) return fail();
    at += token.length;
  };
  value(); whitespace(); if (at !== text.length) return fail();
  try { return JSON.parse(text); } catch { return fail(); }
}
