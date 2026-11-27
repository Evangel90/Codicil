// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Sealed messages: something a vault releases besides money. A message is
// encrypted on the owner's device under a key made of two halves:
//
//   - the recipient's half, which only the recipient holds;
//   - the guardians' half, split into pieces so that any `needed` of them
//     rebuild it and fewer reveal nothing (Shamir's scheme over GF(256)).
//
// Guardians alone cannot read the message, because they lack the recipient's
// half. The recipient alone cannot read it early, because they lack the
// guardians' half. Guardians hand their pieces over once the vault says
// "released"; the chain is the signal, and nothing about a message is ever
// written to it.
//
// What this does not do: stop `needed` guardians and the recipient from
// agreeing to open a message early. That is a promise people make, not a rule
// the chain enforces.

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const DOMAIN = 'codicil:sealed:v1';
const HALF_BYTES = 32;
const NONCE_BYTES = 12;
/** A piece's number is one byte and 0 is the secret itself, so 255 pieces at most. */
export const MAX_PIECES = 255;

/** One guardian's piece of the guardians' half of a key. */
export interface KeyPiece {
  /** Which piece this is, from 1. */
  x: number;
  y: Uint8Array;
}

/** What the recipient holds: the sealed text and their own half of the key. */
export interface SealedMessage {
  version: 1;
  /** The vault whose release opens this message, as hex. The key is bound to it. */
  vault: string;
  /** How many guardian pieces it takes. */
  needed: number;
  recipientHalf: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  /** A fingerprint of every genuine piece, so a wrong or damaged one is caught on arrival. */
  pieceChecks: Uint8Array[];
}

export type SealedProblem = 'not enough pieces' | 'not a genuine piece' | 'cannot open';

/** Why a sealed message could not be opened. */
export class SealedError extends Error {
  override name = 'SealedError';
  constructor(readonly problem: SealedProblem, message: string) {
    super(message);
  }
}

// ─── GF(256), the field AES uses ────────────────────────────────────────────
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
{
  let v = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = v;
    LOG[v] = i;
    // Multiply by the generator 3: v·2 + v.
    v ^= ((v << 1) ^ (v & 0x80 ? 0x11b : 0)) & 0xff;
  }
  for (let i = 255; i < 510; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number): number => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a: number, b: number): number => (a ? EXP[LOG[a] + 255 - LOG[b]] : 0);

/**
 * Split a secret into `pieces` pieces so that any `needed` of them rebuild it.
 * With fewer than `needed`, every value of the secret is equally likely.
 */
export function splitSecret(
  secret: Uint8Array, pieces: number, needed: number, random: (n: number) => Uint8Array = randomBytes,
): KeyPiece[] {
  if (!Number.isInteger(pieces) || pieces < 1 || pieces > MAX_PIECES) throw new Error(`a key can be split into 1 to ${MAX_PIECES} pieces`);
  if (!Number.isInteger(needed) || needed < 1 || needed > pieces) throw new Error(`the number needed must be between 1 and ${pieces}`);
  // One random polynomial of degree needed-1 per byte; the secret is its value at 0.
  const coeffs = random(secret.length * (needed - 1));
  return Array.from({ length: pieces }, (_, p) => {
    const x = p + 1;
    const y = new Uint8Array(secret.length);
    for (let i = 0; i < secret.length; i++) {
      let acc = 0;
      for (let c = needed - 2; c >= 0; c--) acc = mul(acc, x) ^ coeffs[i * (needed - 1) + c];
      y[i] = mul(acc, x) ^ secret[i];
    }
    return { x, y };
  });
}

/**
 * Rebuild a secret from pieces. It cannot tell whether enough genuine pieces
 * were given: too few, or a wrong one, gives a different value, not an error.
 */
export function joinPieces(pieces: readonly KeyPiece[]): Uint8Array {
  if (pieces.length === 0) throw new Error('no pieces');
  const size = pieces[0].y.length;
  const seen = new Set<number>();
  for (const p of pieces) {
    if (!Number.isInteger(p.x) || p.x < 1 || p.x > MAX_PIECES) throw new Error('a piece has a number that cannot be right');
    if (seen.has(p.x)) throw new Error('the same piece was given twice');
    if (p.y.length !== size) throw new Error('the pieces are not from the same key');
    seen.add(p.x);
  }
  const out = new Uint8Array(size);
  for (const p of pieces) {
    // The Lagrange weight of this piece at 0.
    let weight = 1;
    for (const q of pieces) if (q.x !== p.x) weight = mul(weight, div(q.x, q.x ^ p.x));
    for (let i = 0; i < size; i++) out[i] ^= mul(p.y[i], weight);
  }
  return out;
}

const pieceCheck = (vault: string, p: KeyPiece): Uint8Array =>
  sha256(concatBytes(utf8ToBytes(`${DOMAIN}:piece:${vault}:`), Uint8Array.of(p.x), p.y));

const same = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

/** Whether a piece is one of the genuine pieces of this message's key. */
export function isGenuinePiece(sealed: SealedMessage, piece: KeyPiece): boolean {
  const expected = sealed.pieceChecks[piece.x - 1];
  return !!expected && same(expected, pieceCheck(sealed.vault, piece));
}

async function contentKey(vault: string, recipientHalf: Uint8Array, guardianHalf: Uint8Array, use: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const raw = hkdf(sha256, concatBytes(recipientHalf, guardianHalf), utf8ToBytes(`${DOMAIN}:${vault}`), utf8ToBytes('content key'), 32);
  return globalThis.crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [use]);
}

const gcm = (vault: string, nonce: Uint8Array) =>
  ({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: utf8ToBytes(`${DOMAIN}:${vault}`) as BufferSource });

/**
 * Seal a message for one recipient. Returns what the recipient keeps and one
 * piece per guardian. The plain text never leaves the caller.
 */
export async function sealMessage(opts: {
  vault: string;
  message: string | Uint8Array;
  /** How many guardians get a piece. */
  pieces: number;
  /** How many pieces open the message, together with the recipient's half. */
  needed: number;
}): Promise<{ sealed: SealedMessage; pieces: KeyPiece[] }> {
  const vault = opts.vault.toLowerCase();
  const plain = typeof opts.message === 'string' ? utf8ToBytes(opts.message) : opts.message;
  const recipientHalf = randomBytes(HALF_BYTES);
  const guardianHalf = randomBytes(HALF_BYTES);
  const pieces = splitSecret(guardianHalf, opts.pieces, opts.needed);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await contentKey(vault, recipientHalf, guardianHalf, 'encrypt');
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(gcm(vault, nonce), key, plain as BufferSource));
  return {
    sealed: {
      version: 1, vault, needed: opts.needed, recipientHalf, nonce, ciphertext,
      pieceChecks: pieces.map((p) => pieceCheck(vault, p)),
    },
    pieces,
  };
}

/**
 * Open a sealed message with the recipient's half (inside `sealed`) and the
 * pieces guardians handed over. Throws a SealedError when it cannot.
 */
export async function openMessage(sealed: SealedMessage, pieces: readonly KeyPiece[]): Promise<Uint8Array> {
  const genuine = new Map<number, KeyPiece>();
  for (const p of pieces) {
    if (!isGenuinePiece(sealed, p)) throw new SealedError('not a genuine piece', `piece ${p.x} is not a piece of this message's key`);
    genuine.set(p.x, p);
  }
  if (genuine.size < sealed.needed) {
    throw new SealedError('not enough pieces', `this message needs ${sealed.needed} pieces and ${genuine.size} ${genuine.size === 1 ? 'was' : 'were'} given`);
  }
  const guardianHalf = joinPieces([...genuine.values()].slice(0, sealed.needed));
  try {
    const key = await contentKey(sealed.vault, sealed.recipientHalf, guardianHalf, 'decrypt');
    return new Uint8Array(await globalThis.crypto.subtle.decrypt(gcm(sealed.vault, sealed.nonce), key, sealed.ciphertext as BufferSource));
  } catch {
    throw new SealedError('cannot open', 'the sealed text does not match its key: it was changed, or it belongs to another vault');
  }
}

/** The message as text. */
export async function openMessageText(sealed: SealedMessage, pieces: readonly KeyPiece[]): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(await openMessage(sealed, pieces));
}

// ─── The sealed text as something to keep, post or anchor ───────────────────

const u32 = (n: number): Uint8Array => Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

/**
 * A fingerprint of everything the recipient holds. A seal register records it,
 * so anyone handed a sealed text can check it is the one that was sealed, and
 * that it existed when the register says.
 */
export function sealedFingerprint(sealed: SealedMessage): Uint8Array {
  return sha256(concatBytes(
    utf8ToBytes(`${DOMAIN}:fingerprint:${sealed.vault}:`),
    Uint8Array.of(sealed.needed, sealed.pieceChecks.length),
    sealed.recipientHalf, sealed.nonce, u32(sealed.ciphertext.length), sealed.ciphertext, ...sealed.pieceChecks,
  ));
}

/** The sealed text as one line of JSON: safe to store, send or post. It is useless without the pieces. */
export function sealedToText(sealed: SealedMessage): string {
  return JSON.stringify({
    codicil: 'sealed',
    version: sealed.version,
    vault: sealed.vault,
    needed: sealed.needed,
    recipientHalf: bytesToHex(sealed.recipientHalf),
    nonce: bytesToHex(sealed.nonce),
    ciphertext: bytesToHex(sealed.ciphertext),
    pieceChecks: sealed.pieceChecks.map(bytesToHex),
  });
}

/** Read a sealed text back. Throws a plain Error that says what is wrong with it. */
export function sealedFromText(text: string): SealedMessage {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('this is not a sealed text');
  }
  if (!raw || raw.codicil !== 'sealed') throw new Error('this is not a sealed text');
  if (raw.version !== 1) throw new Error('this sealed text was made by a newer version');
  const bytes = (v: unknown, name: string, size?: number): Uint8Array => {
    if (typeof v !== 'string' || !/^([0-9a-f]{2})*$/.test(v)) throw new Error(`the sealed text has a damaged ${name}`);
    const out = hexToBytes(v);
    if (size !== undefined && out.length !== size) throw new Error(`the sealed text has a damaged ${name}`);
    return out;
  };
  const checks = raw.pieceChecks;
  if (typeof raw.vault !== 'string' || !Array.isArray(checks) || checks.length < 1 || checks.length > MAX_PIECES) throw new Error('the sealed text is incomplete');
  const needed = raw.needed;
  if (typeof needed !== 'number' || !Number.isInteger(needed) || needed < 1 || needed > checks.length) throw new Error('the sealed text is incomplete');
  return {
    version: 1,
    vault: raw.vault,
    needed,
    recipientHalf: bytes(raw.recipientHalf, 'key half', HALF_BYTES),
    nonce: bytes(raw.nonce, 'nonce', NONCE_BYTES),
    ciphertext: bytes(raw.ciphertext, 'body'),
    pieceChecks: checks.map((c) => bytes(c, 'piece check', 32)),
  };
}
