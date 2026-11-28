// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  addSlot, BlobError, boxKeyPair, boxSecretFromRoot, deriveFromRoot, fetchBody, guardianSecretFromRoot, heirKeyFromRoot,
  KeyringError, keyringFromText, keyringToText, memoryBlobStore, newKeyring, newPrfInput, newRecoveryCode, newRoot,
  openBox, openKeyring, openSealedFile, opensWithoutWebsite, packFile, padmeLength, pointerFromText, pointerToText,
  recoveryCodeFromText, recoveryCodeToText, removeSlot, sealedFingerprint, sealFile, sealedFromPointer, sealTo,
  SealedError, unpackFile, walletSlotSecret, walletSecretFromSignature, WALLET_SLOT_MESSAGE, type BlobStore,
} from '../src/index.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const VAULT = 'cd'.repeat(32);

describe('a keyring', () => {
  it('opens with any of its slots, and the root is the same each way', async () => {
    const root = newRoot();
    const prf = randomBytes(32);
    const code = newRecoveryCode();
    let ring = await newKeyring(root, { kind: 'passkey', secret: prf, label: 'iPhone', credentialId: 'abcd', prfInput: newPrfInput() });
    expect(opensWithoutWebsite(ring)).toBe(false);
    ring = await addSlot(ring, root, { kind: 'recovery-code', secret: code, label: 'printed' });
    expect(opensWithoutWebsite(ring)).toBe(true);
    expect(hex(await openKeyring(ring, 'passkey', prf))).toBe(hex(root));
    expect(hex(await openKeyring(ring, 'recovery-code', code))).toBe(hex(root));
  });

  it('refuses a wrong secret, and a slot of the wrong kind', async () => {
    const root = newRoot();
    const code = newRecoveryCode();
    const ring = await newKeyring(root, { kind: 'recovery-code', secret: code, label: 'printed' });
    await expect(openKeyring(ring, 'recovery-code', newRecoveryCode())).rejects.toThrow(KeyringError);
    await expect(openKeyring(ring, 'passkey', code)).rejects.toThrow(/no passkey/);
  });

  it('a slot moved into another keyring does not open there', async () => {
    const code = newRecoveryCode();
    const a = await newKeyring(newRoot(), { kind: 'recovery-code', secret: code, label: 'a' });
    const b = await newKeyring(newRoot(), { kind: 'recovery-code', secret: newRecoveryCode(), label: 'b' });
    await expect(openKeyring({ ...b, slots: a.slots }, 'recovery-code', code)).rejects.toThrow(KeyringError);
  });

  it('survives being written as text, and keeps at least one slot', async () => {
    const root = newRoot();
    const code = newRecoveryCode();
    let ring = await newKeyring(root, { kind: 'recovery-code', secret: code, label: 'printed' });
    expect(() => removeSlot(ring, 0)).toThrow(/at least one/);
    const prf = randomBytes(32);
    ring = await addSlot(ring, root, { kind: 'passkey', secret: prf, label: 'Mac', credentialId: 'ff', prfInput: newPrfInput() });
    const back = keyringFromText(keyringToText(ring));
    expect(hex(await openKeyring(back, 'passkey', prf))).toBe(hex(root));
    const fewer = removeSlot(back, 0);
    await expect(openKeyring(fewer, 'recovery-code', code)).rejects.toThrow(/no recovery code/);
  });
});

describe('the recovery code', () => {
  it('round-trips through text, forgiving case, spaces and look-alike letters', () => {
    for (let i = 0; i < 50; i++) {
      const code = newRecoveryCode();
      const text = recoveryCodeToText(code);
      expect(text).toMatch(/^([0-9A-Z]{5}-){5}[0-9A-Z]{2}$/);
      expect(hex(recoveryCodeFromText(text))).toBe(hex(code));
      expect(hex(recoveryCodeFromText(` ${text.toLowerCase().replace(/-/g, ' ')} `))).toBe(hex(code));
      expect(hex(recoveryCodeFromText(text.replace(/0/g, 'O').replace(/1/g, 'l')))).toBe(hex(code));
    }
  });

  it('catches a one-character typing mistake', () => {
    let caught = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      const text = recoveryCodeToText(newRecoveryCode()).replace(/-/g, '');
      const at = i % 26;
      const swapped = text[at] === 'A' ? 'B' : 'A';
      try {
        recoveryCodeFromText(text.slice(0, at) + swapped + text.slice(at + 1));
      } catch (e) {
        if (e instanceof KeyringError) caught++;
      }
    }
    // One check character of 5 bits: about 31 in 32 mistakes are caught.
    expect(caught / trials).toBeGreaterThan(0.9);
  });
});

describe('the wallet slot', () => {
  it('opens with a deterministic signature, and refuses a wallet whose signatures change', async () => {
    const sk = ed25519.utils.randomSecretKey();
    const msg = new TextEncoder().encode(WALLET_SLOT_MESSAGE);
    const sig = ed25519.sign(msg, sk);
    const secret = walletSlotSecret(sig, ed25519.sign(msg, sk));
    const root = newRoot();
    const ring = await newKeyring(root, { kind: 'wallet', secret, label: 'Lace', walletAddress: 'addr' });
    expect(hex(await openKeyring(ring, 'wallet', walletSecretFromSignature(ed25519.sign(msg, sk))))).toBe(hex(root));
    expect(() => walletSlotSecret(randomBytes(64), randomBytes(64))).toThrow(/differently each time/);
  });
});

describe('what a root derives', () => {
  it('is fixed for one context and different between contexts', () => {
    const root = newRoot();
    expect(hex(deriveFromRoot(root, 'x'))).toBe(hex(deriveFromRoot(root, 'x')));
    expect(hex(deriveFromRoot(root, 'x'))).not.toBe(hex(deriveFromRoot(root, 'y')));
    expect(heirKeyFromRoot(root, 'inv-1').sk).toBe(heirKeyFromRoot(root, 'inv-1').sk);
    expect(heirKeyFromRoot(root, 'inv-1').sk).not.toBe(heirKeyFromRoot(root, 'inv-2').sk);
    expect(hex(guardianSecretFromRoot(root, 'inv-1'))).not.toBe(hex(guardianSecretFromRoot(root, 'inv-2')));
  });
});

describe('encrypting to a person', () => {
  it('opens only for its recipient and only in its context', async () => {
    const alice = boxKeyPair(boxSecretFromRoot(newRoot(), 'a'));
    const bob = boxKeyPair(boxSecretFromRoot(newRoot(), 'b'));
    const plain = randomBytes(100);
    const box = await sealTo(alice.publicKey, plain, 'letter');
    expect(hex(await openBox(alice, box, 'letter'))).toBe(hex(plain));
    await expect(openBox(bob, box, 'letter')).rejects.toThrow(/not for this key/);
    await expect(openBox(alice, box, 'piece')).rejects.toThrow(/not for this key/);
    const changed = box.slice();
    changed[changed.length - 1] ^= 1;
    await expect(openBox(alice, changed, 'letter')).rejects.toThrow(/changed/);
  });

  it('refuses a public key that gives no shared secret', async () => {
    await expect(sealTo(new Uint8Array(32), Uint8Array.of(1), 'x')).rejects.toThrow();
  });
});

describe('a sealed file', () => {
  const pdf = { name: 'will.pdf', type: 'application/pdf', bytes: new Uint8Array(200_000).map((_, i) => (i * 7919) & 255) };

  it('is padded, packed and unpacked intact', () => {
    const body = packFile(pdf);
    expect(body.length).toBe(padmeLength(body.length));
    expect(body.length).toBeGreaterThanOrEqual(pdf.bytes.length);
    expect(body.length / pdf.bytes.length).toBeLessThan(1.13);
    const back = unpackFile(body);
    expect(back.name).toBe('will.pdf');
    expect(back.type).toBe('application/pdf');
    expect(hex(back.bytes)).toBe(hex(pdf.bytes));
  });

  it('Padmé keeps few bits of the size', () => {
    expect(padmeLength(0)).toBe(0);
    expect(padmeLength(1000)).toBe(1024);
    for (const n of [5000, 123_456, 9_999_999]) {
      const p = padmeLength(n);
      expect(p).toBeGreaterThanOrEqual(n);
      expect((p - n) / n).toBeLessThan(0.12);
    }
  });

  it('opens at release from the recipient half and enough pieces, fetched from its store', async () => {
    const store = memoryBlobStore();
    const { pointer, pieces, sealed } = await sealFile({ vault: VAULT, file: pdf, pieces: 3, needed: 2, store });
    expect(store.size).toBe(1);
    expect(hex(pointer.fingerprint)).toBe(hex(sealedFingerprint(sealed)));
    const opened = await openSealedFile(pointerFromText(pointerToText(pointer)), pieces.slice(1), [store]);
    expect(opened.name).toBe('will.pdf');
    expect(hex(opened.bytes)).toBe(hex(pdf.bytes));
    await expect(openSealedFile(pointer, pieces.slice(0, 1), [store])).rejects.toThrow(SealedError);
  });

  it('catches a body that was swapped or damaged in the store', async () => {
    const good = memoryBlobStore('x');
    const { pointer, pieces } = await sealFile({ vault: VAULT, file: pdf, pieces: 2, needed: 1, store: good });
    const liar: BlobStore = { name: 'x', lasts: '', put: good.put, get: async (id) => { const b = await good.get(id); b[10] ^= 1; return b; } };
    await expect(openSealedFile(pointer, pieces, [liar])).rejects.toThrow(BlobError);
    await expect(openSealedFile(pointer, pieces, [memoryBlobStore('elsewhere')])).rejects.toThrow(/cannot reach/);
    // A body that hashes right but belongs to another seal is refused too.
    const other = await sealFile({ vault: VAULT, file: pdf, pieces: 2, needed: 1, store: good });
    expect(() => sealedFromPointer(pointer, other.sealed.ciphertext)).toThrow(/does not belong/);
    await expect(fetchBody([good], { ...pointer.body, id: 'nope' })).rejects.toThrow(/not in this store/);
  });

  it('refuses a file over the limit', () => {
    expect(() => packFile({ name: 'big', type: '', bytes: new Uint8Array(25 * 1024 * 1024 + 1) })).toThrow(/at most 25 MB/);
  });
});
