// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Key generation in the exact TypeScript shapes the Compact runtime expects.

import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { randomBytes } from '@noble/hashes/utils.js';
import type { Curve25519Point, Secp256r1Point } from '@midnight-ntwrk/compact-runtime';

export const ED25519_ORDER: bigint = ed25519.Point.Fn.ORDER;

/** A fresh 32-byte salt for commitments and will leaves. */
export const newSalt = (): Uint8Array => randomBytes(32);

// ─── P-256: passkeys (and software passkeys for tests / demo mode) ──────────
export interface P256Key { sk: Uint8Array; pk: Secp256r1Point }

export function newP256Key(): P256Key {
  const { secretKey, publicKey } = p256.keygen();
  return { sk: secretKey, pk: p256PointFromBytes(publicKey) };
}

/** Uncompressed (0x04‖x‖y) or compressed SEC1 bytes → runtime point. */
export function p256PointFromBytes(bytes: Uint8Array): Secp256r1Point {
  const { x, y } = p256.Point.fromBytes(bytes).toAffine();
  return { x, y, identity: false };
}

// ─── Ed25519: owner wallet keys (CIP-30) ────────────────────────────────────
export interface EdKey { sk: Uint8Array; pk: Curve25519Point }

export function newEdKey(): EdKey {
  const { secretKey, publicKey } = ed25519.keygen();
  return { sk: secretKey, pk: edPointFromBytes(publicKey) };
}

/** RFC 8032 encoded point (32 bytes) → runtime point. */
export function edPointFromBytes(bytes: Uint8Array): Curve25519Point {
  const { x, y } = ed25519.Point.fromBytes(bytes).toAffine();
  return { x, y };
}

// ─── Heir keys: a Curve25519 scalar, proven in-circuit with ecMulGenerator ──
export interface HeirKey { sk: bigint; pk: Curve25519Point }

export function heirKeyFromScalar(sk: bigint): HeirKey {
  if (sk <= 0n || sk >= ED25519_ORDER) throw new Error('heir key out of range');
  const { x, y } = ed25519.Point.BASE.multiply(sk).toAffine();
  return { sk, pk: { x, y } };
}

/** A random heir key, or one derived from 64 bytes of seed material. */
export function newHeirKey(seed: Uint8Array = randomBytes(64)): HeirKey {
  if (seed.length < 48) throw new Error('heir key seed too short');
  const sk = bytesToNumberLE(seed) % ED25519_ORDER;
  return sk === 0n ? newHeirKey() : heirKeyFromScalar(sk);
}
