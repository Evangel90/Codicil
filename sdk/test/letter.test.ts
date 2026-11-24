// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { describe, expect, it } from 'vitest';
import { sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import {
  buildWill,
  claimPackage,
  decodeHeirLetter,
  encodeHeirLetter,
  LETTER_PREFIX,
  letterFingerprint,
  newHeirKey,
  newSalt,
} from '../src/index.js';

const open = () => ({ pk: newHeirKey().pk, salt: newSalt() });

function sampleWill() {
  return buildWill([
    { heir: open(), backup: open(), shareBps: 5000n },
    { heir: open(), shareBps: 3000n },
    { heir: open(), shareBps: 2000n, unlockAt: 1_900_000_000n },
  ]);
}

describe('heir letters', () => {
  it('round-trips every entry of a will exactly', () => {
    const will = sampleWill();
    const vault = sampleContractAddress();
    for (let i = 0; i < will.leaves.length; i++) {
      const pkg = claimPackage(will, i);
      const text = encodeHeirLetter({ vault, ...pkg });
      expect(text.startsWith(LETTER_PREFIX)).toBe(true);
      expect(text.length).toBeLessThan(700);   // fits a QR code comfortably
      expect(decodeHeirLetter(text)).toEqual({ vault, ...pkg });
    }
  });

  it('gives each entry a different fingerprint', () => {
    const will = sampleWill();
    const vault = sampleContractAddress();
    const prints = [0, 1, 2].map((i) => letterFingerprint(decodeHeirLetter(encodeHeirLetter({ vault, ...claimPackage(will, i) }))));
    expect(new Set(prints).size).toBe(3);
  });

  it('rejects anything that is not an intact letter', () => {
    const will = sampleWill();
    const text = encodeHeirLetter({ vault: sampleContractAddress(), ...claimPackage(will, 0) });
    expect(() => decodeHeirLetter('hello')).toThrow(/not a Codicil heir letter/);
    expect(() => decodeHeirLetter(text.slice(0, -8))).toThrow(/incomplete or damaged/);
    expect(() => decodeHeirLetter(text + '!')).toThrow(/do not belong/);
    const newer = LETTER_PREFIX + 'Ag' + text.slice(LETTER_PREFIX.length + 2);
    expect(() => decodeHeirLetter(newer)).toThrow(/newer version/);
  });

  it('accepts surrounding whitespace from copy and paste', () => {
    const will = sampleWill();
    const letter = { vault: sampleContractAddress(), ...claimPackage(will, 1) };
    expect(decodeHeirLetter(`  ${encodeHeirLetter(letter)}\n`)).toEqual(letter);
  });
});
