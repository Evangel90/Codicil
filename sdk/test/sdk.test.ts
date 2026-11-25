// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// SDK unit tests: deployment config, passkey and wallet formats, will
// building, witnesses. Contract behaviour is tested in contracts/test.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ApprovalMismatchError,
  buildGuardianSet,
  buildWill,
  challengeFor,
  clientDataJSONFor,
  clientDataLengths,
  COMPILED_CLIENT_DATA_LENGTHS,
  createWitnesses,
  DEFAULT_ORIGIN,
  fromCoseSign1,
  guardianLeaf,
  guardianSecrets,
  heirKeyFromScalar,
  MissingSecretError,
  newEdKey,
  newGuardianSecret,
  newHeirKey,
  newP256Key,
  newSalt,
  parseDerSignature,
  payoutFor,
  publicKeyFromCoseKey,
  signAttestation,
  signLikePasskey,
  signLikeWallet,
  toWebAuthnAssertion,
  VAULT_EVENTS,
  vaultEventName,
  verifyCip30Signature,
  verifyWebAuthnAssertion,
} from '../src/index.js';

const VAULT_SOURCE = new URL('../../contracts/src/codicil_vault.compact', import.meta.url);
const LOCAL_WALLET_FIXTURE = new URL('../../planning/fixtures/capture-chrome-1.json', import.meta.url);

describe('deployment config', () => {
  it('compiled clientDataJSON lengths match the configured origin', () => {
    expect(clientDataLengths(DEFAULT_ORIGIN)).toEqual(COMPILED_CLIENT_DATA_LENGTHS);
  });

  it('matches the generic arguments in the vault source', () => {
    const m = readFileSync(VAULT_SOURCE, 'utf8').match(/^import "lib\/WebAuthn"<(\d+), (\d+)>;$/m);
    expect(m && { short: Number(m[1]), long: Number(m[2]) }).toEqual(COMPILED_CLIENT_DATA_LENGTHS);
  });

  it('computes the documented lengths for a production origin', () => {
    expect(clientDataLengths('https://codicil.app')).toEqual({ short: 132, long: 241 });
    expect(clientDataJSONFor(new Uint8Array(32), 'https://codicil.app').length).toBe(132);
    expect(clientDataJSONFor(new Uint8Array(32), 'https://codicil.app', true).length).toBe(241);
  });
});

describe('passkey (WebAuthn) helpers', () => {
  it('encodes the challenge as unpadded base64url', () => {
    for (const d of [new Uint8Array(32).fill(0xff), new Uint8Array(32), randomBytes(32)]) {
      expect(challengeFor(d)).toBe(Buffer.from(d).toString('base64url'));
      expect(challengeFor(d)).toHaveLength(43);
    }
    expect(() => challengeFor(new Uint8Array(31))).toThrow('32 bytes');
  });

  it('parses DER signatures with and without leading zero bytes', () => {
    for (let i = 0; i < 20; i++) {
      const { secretKey } = p256.keygen();
      const der = p256.sign(randomBytes(32), secretKey, { prehash: false, format: 'der' });
      const compact = p256.Signature.fromBytes(der, 'der');
      expect(parseDerSignature(der)).toEqual({ r: compact.r, s: compact.s });
    }
  });

  it('software passkey assertions verify, in both forms', () => {
    const key = newP256Key();
    const digest = randomBytes(32);
    for (const chromeLongForm of [false, true]) {
      const a = signLikePasskey(key.sk, digest, { chromeLongForm });
      expect(a.longForm).toBe(chromeLongForm);
      expect(a.clientData).toHaveLength(COMPILED_CLIENT_DATA_LENGTHS.long);
      expect(verifyWebAuthnAssertion(a, digest, key.pk)).toBe(true);
      expect(verifyWebAuthnAssertion(a, randomBytes(32), key.pk)).toBe(false);
      expect(verifyWebAuthnAssertion(a, digest, newP256Key().pk)).toBe(false);
      expect(verifyWebAuthnAssertion(a, digest, key.pk, 'evil.example')).toBe(false);
    }
  });

  it('refuses assertions from an origin the vault was not compiled for', () => {
    const digest = randomBytes(32);
    const raw = {
      authenticatorData: new Uint8Array(37),
      clientDataJSON: clientDataJSONFor(digest, 'https://example.org'),
      signature: p256.sign(randomBytes(32), p256.keygen().secretKey, { prehash: false, format: 'der' }),
    };
    expect(() => toWebAuthnAssertion(raw)).toThrow('wrong origin');
    expect(() => toWebAuthnAssertion({ ...raw, authenticatorData: new Uint8Array(70) })).toThrow('extensions');
  });
});

describe('wallet (CIP-30) helpers', () => {
  /** COSE_Sign1 exactly as a wallet returns it. */
  function walletOutput(digest: Uint8Array) {
    const { secretKey, publicKey } = ed25519.keygen();
    const address = new Uint8Array([0x01, ...randomBytes(56)]);
    const s = signLikeWallet(secretKey, digest, address);
    const prot = [0xa2, 0x01, 0x27, 0x67, ...utf8ToBytes('address'), 0x58, 0x39, ...address];
    const raw = ed25519.sign(s.sigStructure, secretKey);
    const cose = new Uint8Array([0x84, 0x58, 0x46, ...prot, 0xa0, 0x58, 0x20, ...digest, 0x58, 0x40, ...raw]);
    const coseKey = new Uint8Array([0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21, 0x58, 0x20, ...publicKey]);
    return { cose, coseKey, publicKey };
  }

  it('parses a wallet COSE_Sign1 and COSE_Key into a verifiable signature', () => {
    const digest = randomBytes(32);
    const { cose, coseKey } = walletOutput(digest);
    const parsed = fromCoseSign1(bytesToHex(cose));
    const pk = publicKeyFromCoseKey(coseKey);
    expect(parsed.payload).toEqual(digest);
    expect(parsed.sigStructure).toHaveLength(119);
    expect(verifyCip30Signature(parsed, digest, pk)).toBe(true);
    expect(verifyCip30Signature(parsed, randomBytes(32), pk)).toBe(false);
  });

  it('rejects COSE layouts the vault cannot verify', () => {
    const { cose } = walletOutput(randomBytes(32));
    expect(() => fromCoseSign1(cose.subarray(0, 150))).toThrow('unsupported wallet signature format');
    const tampered = Uint8Array.from(cose);
    tampered[5] = 0x26;   // alg -7 (ES256) instead of -8 (EdDSA)
    expect(() => fromCoseSign1(tampered)).toThrow('unsupported wallet signature header');
  });

  it('app-held keys sign in the same format', () => {
    const key = newEdKey();
    const digest = randomBytes(32);
    expect(verifyCip30Signature(signLikeWallet(key.sk, digest), digest, key.pk)).toBe(true);
  });

  const real = existsSync(LOCAL_WALLET_FIXTURE) ? JSON.parse(readFileSync(LOCAL_WALLET_FIXTURE, 'utf8')).cip30 : [];
  it.skipIf(real.length === 0)('parses and verifies real wallet captures [local only]', () => {
    for (const c of real) {
      const parsed = fromCoseSign1(c.coseSign1);
      expect(bytesToHex(parsed.payload)).toBe(c.payload);
      expect(verifyCip30Signature(parsed, hexToBytes(c.payload), publicKeyFromCoseKey(c.coseKey))).toBe(true);
    }
  });
});

describe('keys', () => {
  it('heir keys are valid scalars whose public key matches', () => {
    const k = newHeirKey();
    expect(heirKeyFromScalar(k.sk)).toEqual(k);
    expect(() => heirKeyFromScalar(0n)).toThrow('out of range');
    expect(() => newHeirKey(new Uint8Array(16))).toThrow('too short');
  });
});

describe('will builder', () => {
  const someone = () => ({ pk: newHeirKey().pk, salt: newSalt() });

  it('validates shares', () => {
    expect(() => buildWill([])).toThrow('at least one heir');
    expect(() => buildWill([{ heir: someone(), shareBps: 0n }])).toThrow('between');
    expect(() => buildWill([{ heir: someone(), shareBps: 10_001n }])).toThrow('between');
    expect(() => buildWill([{ heir: someone(), shareBps: 6000n }, { heir: someone(), shareBps: 4001n }]))
      .toThrow('more than 100%');
  });

  it('hides each leaf with a fresh salt, so identical entries get different leaves', () => {
    const h = someone();
    const w = buildWill([{ heir: h, shareBps: 5000n }, { heir: h, shareBps: 5000n }]);
    expect(w.leaves[0].salt).not.toEqual(w.leaves[1].salt);
    expect(w.leaves[0].backupKeyCommit).toEqual(new Uint8Array(32));
    expect(buildWill([{ heir: h, shareBps: 5000n }]).root).not.toBe(buildWill([{ heir: h, shareBps: 5000n }]).root);
  });

  it('rounds payouts down', () => {
    expect(payoutFor(1_000_001n, 3333n)).toBe(333_300n);
    expect(payoutFor(9999n, 1n)).toBe(0n);
    expect(payoutFor(10n ** 30n, 10_000n)).toBe(10n ** 30n);
  });
});

describe('witnesses', () => {
  const ctx = (privateState: object) => ({ privateState }) as any;

  it('explain what is missing on this device', () => {
    const w = createWitnesses();
    expect(() => w.ownerPasskey(ctx({}))).toThrow(MissingSecretError);
    expect(() => w.claimantLeaf(ctx({}))).toThrow('no claim package');
  });

  it('only hand over an approval for the digest being proven', () => {
    const key = newP256Key();
    const digest = randomBytes(32);
    const state = { passkey: { pk: key.pk, salt: newSalt(), approval: { digest, proof: signLikePasskey(key.sk, digest) } } };
    expect(createWitnesses().ownerPasskeyAssertion(ctx(state), digest)[1]).toBe(state.passkey.approval.proof);
    expect(() => createWitnesses().ownerPasskeyAssertion(ctx(state), randomBytes(32))).toThrow(ApprovalMismatchError);
    expect(() => createWitnesses({ strict: false }).ownerPasskeyAssertion(ctx(state), randomBytes(32))).not.toThrow();
  });

  it('computes the payout quotient and remainder', () => {
    const [, [q, r]] = createWitnesses().payoutDivision(ctx({}), 1_000_001n, 3333n);
    expect(q * 10_000n + r).toBe(1_000_001n * 3333n);
    expect(r < 10_000n).toBe(true);
  });
});

describe('guardian sets', () => {
  const secrets = [newGuardianSecret(), newGuardianSecret(), newGuardianSecret()];
  const leaves = secrets.map(guardianLeaf);

  it('validates the threshold', () => {
    expect(() => buildGuardianSet([], 1)).toThrow('at least one guardian');
    expect(() => buildGuardianSet(leaves, 0)).toThrow('between 1 and 3');
    expect(() => buildGuardianSet(leaves, 4)).toThrow('between 1 and 3');
    expect(buildGuardianSet(leaves, 2).threshold).toBe(2n);
  });

  it('gives each guardian their own path, and refuses unknown secrets', () => {
    const set = buildGuardianSet(leaves, 2);
    expect(guardianSecrets(set, secrets[1]).path).toEqual(set.tree.pathFor(1));
    expect(() => guardianSecrets(set, newGuardianSecret())).toThrow('not one of the vault guardians');
  });

  it('leaves reveal nothing obvious about the secret', () => {
    expect(guardianLeaf(secrets[0])).not.toEqual(secrets[0]);
    expect(guardianLeaf(secrets[0])).toEqual(guardianLeaf(Uint8Array.from(secrets[0])));
  });

  it('attestations are raw P-256 signatures over the digest', () => {
    const key = newP256Key();
    const digest = randomBytes(32);
    const { r, s } = signAttestation(key.sk, digest);
    const pub = p256.Point.fromAffine({ x: key.pk.x, y: key.pk.y }).toBytes();
    expect(p256.verify(new p256.Signature(r, s).toBytes('compact'), digest, pub, { prehash: false, lowS: false })).toBe(true);
  });
});

describe('vault events', () => {
  /** A `Misc` event as the runtime reports it: one 288-byte value with trailing zeros trimmed. */
  const misc = (name: string) => ({
    version: 1,
    eventType: 'misc',
    data: { tag: 'cell', content: { value: [utf8ToBytes(name)], alignment: [{ tag: 'atom', value: { tag: 'bytes', length: 288 } }] } },
  });

  it('names the events the vault emits and ignores everything else', () => {
    expect(vaultEventName(misc('codicil:released:v1'))).toBe(VAULT_EVENTS.released);
    expect(vaultEventName(misc('codicil:will-changed:v1'))).toBe(VAULT_EVENTS.willChanged);
    expect(vaultEventName(misc('someone-else:event'))).toBeUndefined();
    expect(vaultEventName({ data: { tag: 'null' } })).toBeUndefined();
    // A payload after the 32-byte name does not change the name.
    const withPayload = new Uint8Array(288);
    withPayload.set(utf8ToBytes(VAULT_EVENTS.willChanged));
    withPayload[40] = 7;
    expect(vaultEventName({ data: { content: { value: [withPayload] } } })).toBe(VAULT_EVENTS.willChanged);
  });
});
