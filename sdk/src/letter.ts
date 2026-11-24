// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Heir letters: how an owner hands each heir what they need to claim later.
// A letter carries the vault address, the heir's will entry and its Merkle
// path, in a compact binary form that fits in a QR code. It does NOT carry the
// heir's secret key; the heir keeps that separately.
//
// A letter is tied to one version of the will. When the owner changes the
// will, every letter must be reissued (the root, and so the paths, change).
//
// Layout (461 bytes, then base64url with a text prefix):
//   1   version (1)
//   32  contract address
//   32  heirKeyCommit
//   32  backupKeyCommit
//   2   shareBps        (big-endian)
//   8   unlockAt        (big-endian, unix seconds)
//   32  leaf salt
//   10 × 32  Merkle siblings (field elements, big-endian)
//   2   goes_left bits  (bit i = level i)

import { pureCircuits, type HeirLeaf } from '@codicil/contracts/vault';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { DEPTH, rootFromPath, type MerklePath } from './merkle.js';
import { keyCommitment, type ClaimPackage, type KeyCommitmentOpening } from './will.js';

export const LETTER_PREFIX = 'codicil:claim:v1:';
const VERSION = 1;
const SIZE = 1 + 32 + 32 + 32 + 2 + 8 + 32 + DEPTH * 32 + 2;

export interface HeirLetter extends ClaimPackage {
  /** The vault contract address (hex). */
  vault: string;
}

export class LetterError extends Error {
  override name = 'LetterError';
}

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new LetterError('this letter has characters that do not belong in it');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

function putBig(out: Uint8Array, at: number, len: number, v: bigint) {
  if (v < 0n || v >= 1n << BigInt(8 * len)) throw new LetterError('value does not fit in a letter');
  for (let i = len - 1; i >= 0; i--) { out[at + i] = Number(v & 0xffn); v >>= 8n; }
}

function getBig(b: Uint8Array, at: number, len: number): bigint {
  let v = 0n;
  for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(b[at + i]);
  return v;
}

export function encodeHeirLetter(letter: HeirLetter): string {
  const { vault, leaf, path } = letter;
  if (!/^[0-9a-f]{64}$/i.test(vault)) throw new LetterError('the vault address must be 32 bytes of hex');
  if (path.path.length !== DEPTH) throw new LetterError(`a Merkle path must have ${DEPTH} levels`);
  const out = new Uint8Array(SIZE);
  let at = 0;
  out[at++] = VERSION;
  out.set(hexToBytes(vault), at); at += 32;
  out.set(leaf.heirKeyCommit, at); at += 32;
  out.set(leaf.backupKeyCommit, at); at += 32;
  putBig(out, at, 2, leaf.shareBps); at += 2;
  putBig(out, at, 8, leaf.unlockAt); at += 8;
  out.set(leaf.salt, at); at += 32;
  let bits = 0;
  path.path.forEach((p, i) => {
    putBig(out, at, 32, p.sibling.field); at += 32;
    if (p.goes_left) bits |= 1 << i;
  });
  putBig(out, at, 2, BigInt(bits));
  return LETTER_PREFIX + b64url(out);
}

export function decodeHeirLetter(text: string): HeirLetter {
  const t = text.trim();
  if (!t.startsWith(LETTER_PREFIX)) throw new LetterError('this is not a Codicil heir letter');
  const b = fromB64url(t.slice(LETTER_PREFIX.length));
  if (b.length !== SIZE) throw new LetterError('this letter is incomplete or damaged');
  if (b[0] !== VERSION) throw new LetterError('this letter was made by a newer version of Codicil');
  let at = 1;
  const take = (n: number) => { const s = b.slice(at, at + n); at += n; return s; };
  const vault = bytesToHex(take(32));
  const leaf: HeirLeaf = {
    heirKeyCommit: take(32),
    backupKeyCommit: take(32),
    shareBps: getBig(b, at, 2),
    unlockAt: getBig(b, at + 2, 8),
    salt: new Uint8Array(),
  };
  at += 10;
  leaf.salt = take(32);
  if (leaf.shareBps === 0n || leaf.shareBps > 10_000n) throw new LetterError('this letter has an impossible share');
  const siblings = Array.from({ length: DEPTH }, () => getBig(take(32), 0, 32));
  const bits = Number(getBig(b, at, 2));
  const path: MerklePath = {
    leaf: pureCircuits.heirLeafHash(leaf),
    path: siblings.map((field, i) => ({ sibling: { field }, goes_left: ((bits >> i) & 1) === 1 })),
  };
  return { vault, leaf, path };
}

/** Short fingerprint to compare a letter against the will it came from. */
export function letterFingerprint(letter: HeirLetter): string {
  return bytesToHex(letter.path.leaf).slice(0, 8);
}

export interface LetterCheck {
  /** The letter is for this vault. */
  vaultMatches: boolean;
  /** Its entry is in the will the chain holds now (its path leads to the current root). */
  inCurrentWill: boolean;
  /** Which part of the entry the given key opens, if a key was given. */
  role?: 'heir' | 'backup' | 'none';
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Checks a letter on the heir's own device, against public data only: the
 * vault address and the will root on the ledger. Nothing is sent anywhere.
 */
export function checkHeirLetter(
  letter: HeirLetter,
  current: { vault: string; willRoot: bigint; key?: KeyCommitmentOpening },
): LetterCheck {
  const check: LetterCheck = {
    vaultMatches: letter.vault.toLowerCase() === current.vault.toLowerCase(),
    inCurrentWill: rootFromPath(letter.path) === current.willRoot,
  };
  if (current.key) {
    const c = keyCommitment(current.key);
    check.role = sameBytes(c, letter.leaf.heirKeyCommit) ? 'heir' : sameBytes(c, letter.leaf.backupKeyCommit) ? 'backup' : 'none';
  }
  return check;
}
