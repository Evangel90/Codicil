// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Gate V15: convert an X25519 (Montgomery u) public key to the Edwards point
// Compact's Curve25519Point expects, and back.
//   Edwards → Montgomery: u = (1 + y) / (1 - y)
//   Montgomery → Edwards: y = (u - 1) / (u + 1); x is recovered from the
//   sign bit, which X25519 does not carry, so the caller supplies it.

import { describe, expect, it } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js';
import { isValidCurve25519Point, type Curve25519Point } from '@midnight-ntwrk/compact-runtime';

const P = ed25519.Point.Fp.ORDER;
const mod = (a: bigint) => ((a % P) + P) % P;
const inv = (a: bigint) => ed25519.Point.Fp.inv(mod(a));

export function edwardsToMontgomeryU(pt: Curve25519Point): bigint {
  return mod((1n + pt.y) * inv(1n - pt.y));
}

export function montgomeryUToEdwards(u: bigint, xIsOdd: boolean): Curve25519Point {
  const y = mod((u - 1n) * inv(u + 1n));
  const enc = numberToBytesLE(y, 32);
  if (xIsOdd) enc[31] |= 0x80;
  const { x, y: yy } = ed25519.Point.fromBytes(enc).toAffine();
  return { x, y: yy };
}

describe('Curve25519 Montgomery ⇄ Edwards [V15]', () => {
  it('matches noble toMontgomery and round-trips back to the same Edwards point', () => {
    for (let i = 0; i < 20; i++) {
      const { publicKey } = ed25519.keygen();
      const ed = ed25519.Point.fromBytes(publicKey).toAffine();
      const u = edwardsToMontgomeryU(ed);
      expect(u).toBe(bytesToNumberLE(ed25519.utils.toMontgomery(publicKey)));
      const back = montgomeryUToEdwards(u, (ed.x & 1n) === 1n);
      expect(back).toEqual({ x: ed.x, y: ed.y });
      expect(isValidCurve25519Point(back)).toBe(true);
    }
  });

  it('agrees on X25519 shared secrets computed via either form', () => {
    const a = ed25519.keygen();
    const b = x25519.keygen();
    const aMont = ed25519.utils.toMontgomery(a.publicKey);
    const aSecretMont = ed25519.utils.toMontgomerySecret(a.secretKey);
    expect(x25519.getSharedSecret(b.secretKey, aMont))
      .toEqual(x25519.getSharedSecret(aSecretMont, b.publicKey));
  });
});
