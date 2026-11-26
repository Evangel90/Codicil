// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Small encoders shared by the live layer: hex, base64url, and JSON that
// survives bigints and byte arrays (vault records are full of both).

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error('not a hexadecimal value');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function toBase64Url(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not a base64url value');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** JSON with `{"$n":"123"}` for a bigint and `{"$b":"0a0b"}` for bytes. */
export function encodeJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return { $n: v.toString() };
    if (v instanceof Uint8Array) return { $b: toHex(v) };
    return v;
  }, space);
}

export function decodeJson<T>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && typeof o.$n === 'string' && /^-?\d+$/.test(o.$n)) return BigInt(o.$n);
      if (keys.length === 1 && typeof o.$b === 'string') return fromHex(o.$b);
    }
    return v;
  }) as T;
}

/** A random id for a record kept on this device. Never published. */
export function newLocalId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(8)));
}
