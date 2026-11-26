// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  isGenuinePiece, joinPieces, openMessage, openMessageText, sealMessage, SealedError, splitSecret, type KeyPiece,
} from '../src/index.js';

const VAULT = 'ab'.repeat(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Every way to choose `k` items of a list. */
function choose<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [first, ...rest] = items;
  return [...choose(rest, k - 1).map((c) => [first, ...c]), ...choose(rest, k)];
}

const problemOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'opened';
  } catch (e) {
    return e instanceof SealedError ? e.problem : `unexpected: ${String(e)}`;
  }
};

describe('splitting a key into pieces', () => {
  it('any `needed` pieces rebuild the secret, for every choice of them', () => {
    for (const [pieces, needed] of [[1, 1], [3, 1], [3, 2], [3, 3], [5, 3], [7, 4]] as const) {
      const secret = randomBytes(32);
      const all = splitSecret(secret, pieces, needed);
      expect(all).toHaveLength(pieces);
      for (const chosen of choose(all, needed)) expect(hex(joinPieces(chosen))).toBe(hex(secret));
      // More than needed works too.
      expect(hex(joinPieces(all))).toBe(hex(secret));
    }
  });

  it('fewer than `needed` pieces give some other value', () => {
    const secret = randomBytes(32);
    const all = splitSecret(secret, 5, 3);
    for (const chosen of choose(all, 2)) expect(hex(joinPieces(chosen))).not.toBe(hex(secret));
  });

  it('with one piece missing, every secret is still possible', () => {
    // Two of three pieces: for any guess at the secret there is a third piece
    // that fits, so one piece says nothing. Shown here for a one-byte secret.
    const [first] = splitSecret(Uint8Array.of(0x5a), 3, 2);
    const reachable = new Set<number>();
    for (let y = 0; y < 256; y++) reachable.add(joinPieces([first, { x: 2, y: Uint8Array.of(y) }])[0]);
    expect(reachable.size).toBe(256);
  });

  it('works at the largest size, 255 pieces', () => {
    const secret = randomBytes(16);
    const all = splitSecret(secret, 255, 200);
    expect(hex(joinPieces(all.slice(55)))).toBe(hex(secret));
  });

  it('refuses sizes that make no sense', () => {
    const secret = randomBytes(8);
    expect(() => splitSecret(secret, 0, 1)).toThrow(/1 to 255 pieces/);
    expect(() => splitSecret(secret, 256, 2)).toThrow(/1 to 255 pieces/);
    expect(() => splitSecret(secret, 3, 0)).toThrow(/between 1 and 3/);
    expect(() => splitSecret(secret, 3, 4)).toThrow(/between 1 and 3/);
  });

  it('refuses pieces that cannot belong together', () => {
    const [a, b] = splitSecret(randomBytes(8), 3, 2);
    expect(() => joinPieces([])).toThrow(/no pieces/);
    expect(() => joinPieces([a, a])).toThrow(/given twice/);
    expect(() => joinPieces([a, { x: 0, y: b.y }])).toThrow(/cannot be right/);
    expect(() => joinPieces([a, { x: 2, y: b.y.slice(1) }])).toThrow(/not from the same key/);
  });
});

describe('sealed messages', () => {
  const text = 'Ada: the recovery phrase for my other wallet is in the blue notebook. Ünïcödé too. 🔑';

  it('opens with the needed pieces, whichever they are', async () => {
    const { sealed, pieces } = await sealMessage({ vault: VAULT, message: text, pieces: 3, needed: 2 });
    for (const chosen of choose(pieces, 2)) expect(await openMessageText(sealed, chosen)).toBe(text);
    expect(await openMessageText(sealed, pieces)).toBe(text);
  });

  it('seals bytes as well as text, and an empty message', async () => {
    const bytes = randomBytes(1000);
    const a = await sealMessage({ vault: VAULT, message: bytes, pieces: 2, needed: 2 });
    expect(hex(await openMessage(a.sealed, a.pieces))).toBe(hex(bytes));
    const b = await sealMessage({ vault: VAULT, message: '', pieces: 1, needed: 1 });
    expect(await openMessageText(b.sealed, b.pieces)).toBe('');
  });

  it('the sealed text does not contain the message', async () => {
    const { sealed } = await sealMessage({ vault: VAULT, message: 'blue notebook '.repeat(20), pieces: 3, needed: 2 });
    expect(Buffer.from(sealed.ciphertext).toString('latin1')).not.toContain('blue notebook');
  });

  it('does not open with too few pieces', async () => {
    const { sealed, pieces } = await sealMessage({ vault: VAULT, message: text, pieces: 3, needed: 2 });
    expect(await problemOf(openMessage(sealed, []))).toBe('not enough pieces');
    expect(await problemOf(openMessage(sealed, [pieces[0]]))).toBe('not enough pieces');
    // The same piece twice is still one piece.
    expect(await problemOf(openMessage(sealed, [pieces[0], pieces[0]]))).toBe('not enough pieces');
  });

  it('catches a piece that is not genuine, and says which', async () => {
    const { sealed, pieces } = await sealMessage({ vault: VAULT, message: text, pieces: 3, needed: 2 });
    const forged: KeyPiece = { x: 2, y: randomBytes(32) };
    expect(isGenuinePiece(sealed, pieces[1])).toBe(true);
    expect(isGenuinePiece(sealed, forged)).toBe(false);
    expect(isGenuinePiece(sealed, { x: 9, y: pieces[0].y })).toBe(false);
    expect(await problemOf(openMessage(sealed, [pieces[0], forged]))).toBe('not a genuine piece');
    await expect(openMessage(sealed, [pieces[0], forged])).rejects.toThrow(/piece 2/);
  });

  it('pieces of one message do not open another', async () => {
    const a = await sealMessage({ vault: VAULT, message: text, pieces: 3, needed: 2 });
    const b = await sealMessage({ vault: VAULT, message: text, pieces: 3, needed: 2 });
    expect(await problemOf(openMessage(a.sealed, b.pieces))).toBe('not a genuine piece');
  });

  it('the guardians alone cannot open it: without the recipient half the key is wrong', async () => {
    const { sealed, pieces } = await sealMessage({ vault: VAULT, message: text, pieces: 3, needed: 2 });
    // All three guardians together, guessing at the half they were never given.
    const guess = { ...sealed, recipientHalf: randomBytes(32) };
    expect(await problemOf(openMessage(guess, pieces))).toBe('cannot open');
  });

  it('a changed sealed text, nonce or vault is refused', async () => {
    const { sealed, pieces } = await sealMessage({ vault: VAULT, message: text, pieces: 3, needed: 2 });
    const flipped = Uint8Array.from(sealed.ciphertext);
    flipped[0] ^= 1;
    expect(await problemOf(openMessage({ ...sealed, ciphertext: flipped }, pieces))).toBe('cannot open');
    expect(await problemOf(openMessage({ ...sealed, nonce: randomBytes(12) }, pieces))).toBe('cannot open');
    // Moved to another vault: its pieces no longer match the checks made for this one.
    expect(await problemOf(openMessage({ ...sealed, vault: 'cd'.repeat(32) }, pieces))).toBe('not a genuine piece');
  });

  it('makes a new key every time, so the same message never seals the same way twice', async () => {
    const a = await sealMessage({ vault: VAULT, message: text, pieces: 3, needed: 2 });
    const b = await sealMessage({ vault: VAULT, message: text, pieces: 3, needed: 2 });
    expect(hex(a.sealed.ciphertext)).not.toBe(hex(b.sealed.ciphertext));
    expect(hex(a.sealed.recipientHalf)).not.toBe(hex(b.sealed.recipientHalf));
  });
});
