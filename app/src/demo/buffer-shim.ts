// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// compact-runtime 0.21 converts hex with Node's `Buffer` inside its
// cross-contract call path (`fromHex` / `toHex` in its utils). Browsers have no
// `Buffer`, so a contract-to-contract call would stop there. This provides the
// two conversions the runtime uses, and nothing else. It is installed only
// where `Buffer` is missing, so Node and the tests keep the real one.

const HEX = /^([0-9a-f]{2})*$/i;

/** Bytes that print themselves as hex, as `Buffer.from(bytes).toString('hex')` does. */
export class HexBytes extends Uint8Array {
  // Derived arrays (slice, map) are plain Uint8Arrays.
  static get [Symbol.species]() {
    return Uint8Array;
  }

  override toString(encoding?: string): string {
    if (encoding !== 'hex') throw new Error(`Buffer shim: toString('${encoding}') is not supported, only 'hex'`);
    return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join('');
  }
}

function from(data: string, encoding?: string): Uint8Array;
function from(data: ArrayLike<number>): HexBytes;
function from(data: string | ArrayLike<number>, encoding?: string): Uint8Array {
  if (typeof data !== 'string') return HexBytes.from(data);
  if (encoding !== 'hex' || !HEX.test(data)) throw new Error(`Buffer shim: only hex strings are supported, got encoding '${encoding}'`);
  const out = new Uint8Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(data.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const hexBuffer = { from, isBuffer: (_x: unknown): boolean => false };

/** Make `Buffer` available to the contract runtime where the platform has none. */
export function installBufferShim(target: { Buffer?: unknown } = globalThis as { Buffer?: unknown }): void {
  if (typeof target.Buffer === 'undefined') target.Buffer = hexBuffer;
}
