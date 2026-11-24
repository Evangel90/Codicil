// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Cardano CIP-30 `signData` signatures in the shape the vault's Cip30 module
// verifies: contracts/src/lib/Cip30.compact.

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Curve25519Point } from '@midnight-ntwrk/compact-runtime';
import { edPointFromBytes } from './keys.js';

/** Witness value for `Cip30Signature`. */
export interface Cip30Signature {
  sigStructure: Uint8Array;                       // 119 bytes
  sig: { r: Curve25519Point; s: bigint };
}

const ADDRESS_LEN = 57;   // Shelley base address
const SIG_STRUCTURE_LEN = 119;
const toBytes = (v: string | Uint8Array) => (typeof v === 'string' ? hexToBytes(v) : v);

/** CBOR Sig_structure ["Signature1", protected, h'', payload] for a base address. */
export function sigStructure(address: Uint8Array, digest: Uint8Array): Uint8Array {
  if (address.length !== ADDRESS_LEN) throw new Error('only 57-byte base addresses are supported');
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  const prot = [0xa2, 0x01, 0x27, 0x67, ...utf8ToBytes('address'), 0x58, 0x39, ...address];
  return new Uint8Array([0x84, 0x6a, ...utf8ToBytes('Signature1'), 0x58, 0x46, ...prot, 0x40, 0x58, 0x20, ...digest]);
}

function splitSignature(raw: Uint8Array): Cip30Signature['sig'] {
  return { r: edPointFromBytes(raw.subarray(0, 32)), s: bytesToNumberLE(raw.subarray(32, 64)) };
}

/**
 * Parse the `signature` (COSE_Sign1) returned by `api.signData(addr, digestHex)`.
 * Throws for layouts the vault does not accept (e.g. enterprise addresses).
 */
export function fromCoseSign1(coseSign1: string | Uint8Array): Cip30Signature & { payload: Uint8Array } {
  const c = toBytes(coseSign1);
  // 84 | 58 46 <protected 70> | a0 | 58 20 <payload 32> | 58 40 <signature 64>
  const ok = c.length === 174 && c[0] === 0x84 && c[1] === 0x58 && c[2] === 0x46 && c[73] === 0xa0
    && c[74] === 0x58 && c[75] === 0x20 && c[108] === 0x58 && c[109] === 0x40;
  if (!ok) throw new Error('unsupported wallet signature format (expected a base-address COSE_Sign1 over 32 bytes)');
  const prot = c.subarray(3, 73);
  if (bytesToHex(prot.subarray(0, 13)) !== bytesToHex(new Uint8Array([0xa2, 0x01, 0x27, 0x67, ...utf8ToBytes('address'), 0x58, 0x39]))) {
    throw new Error('unsupported wallet signature header');
  }
  const payload = c.slice(76, 108);
  return {
    payload,
    sigStructure: sigStructure(prot.slice(13), payload),
    sig: splitSignature(c.subarray(110, 174)),
  };
}

/** Public key from the `key` (COSE_Key) returned by `api.signData`. */
export function publicKeyFromCoseKey(coseKey: string | Uint8Array): Curve25519Point {
  const k = toBytes(coseKey);
  // ... -2 (0x21): bstr(32) (0x58 0x20) <x> — always last in wallet output
  if (k.length < 35 || k[k.length - 35] !== 0x21 || k[k.length - 34] !== 0x58 || k[k.length - 33] !== 0x20) {
    throw new Error('unsupported wallet key format');
  }
  return edPointFromBytes(k.subarray(k.length - 32));
}

export function verifyCip30Signature(s: Cip30Signature, digest: Uint8Array, pk: Curve25519Point): boolean {
  if (s.sigStructure.length !== SIG_STRUCTURE_LEN) return false;
  if (bytesToHex(s.sigStructure.subarray(87)) !== bytesToHex(digest)) return false;
  const r = ed25519.Point.fromAffine(s.sig.r).toBytes();
  const sig = new Uint8Array([...r, ...numberToBytesLE(s.sig.s, 32)]);
  const pub = ed25519.Point.fromAffine(pk).toBytes();
  return ed25519.verify(sig, s.sigStructure, pub, { zip215: false });
}

/**
 * Sign `digest` exactly as a CIP-30 wallet would, with an app-held Ed25519
 * key (tests, and owners without a Cardano wallet).
 */
export function signLikeWallet(sk: Uint8Array, digest: Uint8Array, address?: Uint8Array): Cip30Signature {
  const addr = address ?? new Uint8Array([0x00, ...randomBytes(ADDRESS_LEN - 1)]);
  const msg = sigStructure(addr, digest);
  return { sigStructure: msg, sig: splitSignature(ed25519.sign(msg, sk)) };
}
