// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Encrypting to a person (docs/DECISIONS.md D22). Every person has an X25519
// key derived from their root. Anything meant for them (the recipient's half of
// a sealed key, a guardian's piece, a fresh heir letter) is encrypted to it and
// can then be stored anywhere, in public, because only they can open it.
//
// A box is: version (1 byte) ‖ ephemeral public key (32) ‖ nonce (12) ‖
// AES-256-GCM ciphertext. The AES key is HKDF-SHA-256 of the X25519 shared
// secret, salted with both public keys, with the box's context as info. A box
// made for one context does not open in another.

import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const DOMAIN = 'codicil:box:v1';
const VERSION = 1;
const HEADER = 1 + 32 + 12;

export interface BoxKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

/** Why a box could not be opened. */
export class BoxError extends Error {
  override name = 'BoxError';
}

/** A person's encryption key from 32 secret bytes (see `boxSecretFromRoot`). */
export function boxKeyPair(secret: Uint8Array): BoxKeyPair {
  if (secret.length !== 32) throw new BoxError('a box secret is 32 bytes');
  return { secretKey: secret, publicKey: x25519.getPublicKey(secret) };
}

async function boxKey(shared: Uint8Array, ephemeral: Uint8Array, recipient: Uint8Array, context: string, use: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (shared.every((b) => b === 0)) throw new BoxError('that is not a usable public key');
  const raw = hkdf(sha256, shared, concatBytes(ephemeral, recipient), utf8ToBytes(`${DOMAIN}:${context}`), 32);
  return globalThis.crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [use]);
}

/** Encrypt `plain` so that only the holder of `recipient`'s secret key can read it, in `context`. */
export async function sealTo(recipient: Uint8Array, plain: Uint8Array, context: string): Promise<Uint8Array> {
  if (recipient.length !== 32) throw new BoxError('a public encryption key is 32 bytes');
  const eph = x25519.keygen();
  const nonce = randomBytes(12);
  const key = await boxKey(x25519.getSharedSecret(eph.secretKey, recipient), eph.publicKey, recipient, context, 'encrypt');
  const body = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, plain as BufferSource));
  return concatBytes(Uint8Array.of(VERSION), eph.publicKey, nonce, body);
}

/** Open a box made for `keys`. Throws a BoxError when it is not for them, not for this context, or changed. */
export async function openBox(keys: BoxKeyPair, box: Uint8Array, context: string): Promise<Uint8Array> {
  if (box.length < HEADER + 16 || box[0] !== VERSION) throw new BoxError('this is not a sealed box');
  const eph = box.subarray(1, 33);
  const nonce = box.subarray(33, HEADER);
  try {
    const key = await boxKey(x25519.getSharedSecret(keys.secretKey, eph), eph, keys.publicKey, context, 'decrypt');
    return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce.slice() as BufferSource }, key, box.subarray(HEADER).slice() as BufferSource));
  } catch (e) {
    if (e instanceof BoxError) throw e;
    throw new BoxError('this box is not for this key, or it was changed');
  }
}
