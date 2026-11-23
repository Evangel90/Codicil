// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Gate V6: real passkey assertions (Chrome 157 / macOS / Touch ID, captured
// with tools/webauthn-capture) verified by the WebAuthn circuit, plus
// targeted tampering and synthetic edge cases.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Contract, pureCircuits } from '../contracts/managed/webauthn/contract/index.js';
import { Simulator } from './harness.js';

const DIR = new URL('../contracts/managed/webauthn', import.meta.url).pathname;
const T = 1_800_000_000;
const ORIGIN = 'http://localhost:5173';
const RP_ID_HASH = sha256(utf8ToBytes('localhost'));

interface Assertion {
  authenticatorData: Uint8Array;
  clientData: Uint8Array;
  longForm: boolean;
  sig: { r: bigint; s: bigint };
}
interface Case { digest: Uint8Array; assertion: Assertion }
interface PS { assertion?: Assertion }

const fixture = JSON.parse(readFileSync(new URL('./fixtures/webauthn-chrome-macos.json', import.meta.url), 'utf8'));
const realPk = {
  x: BigInt('0x' + fixture.passkey.publicKey.x),
  y: BigInt('0x' + fixture.passkey.publicKey.y),
  identity: false,
};

function toAssertion(authData: Uint8Array, cdj: Uint8Array, r: bigint, s: bigint): Assertion {
  if (cdj.length !== 134 && cdj.length !== 243) throw new Error(`unsupported clientDataJSON length ${cdj.length}`);
  const clientData = new Uint8Array(243);
  clientData.set(cdj);
  return { authenticatorData: authData, clientData, longForm: cdj.length === 243, sig: { r, s } };
}

const realCases: Case[] = fixture.assertions.map((a: any) => ({
  digest: hexToBytes(a.digest),
  assertion: toAssertion(
    hexToBytes(a.authenticatorData),
    hexToBytes(a.clientDataJSONHex),
    BigInt('0x' + a.r),
    BigInt('0x' + a.s),
  ),
}));

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** Build a passkey-style assertion with a software key, for edge cases. */
function synthetic(digest: Uint8Array, opts: { flags?: number } = {}) {
  const { secretKey, publicKey } = p256.keygen();
  const { x, y } = p256.Point.fromBytes(publicKey).toAffine();
  const authData = new Uint8Array(37);
  authData.set(RP_ID_HASH);
  authData[32] = opts.flags ?? 0x05;
  const cdj = utf8ToBytes(
    `{"type":"webauthn.get","challenge":"${b64url(digest)}","origin":"${ORIGIN}","crossOrigin":false}`,
  );
  const msg = sha256(new Uint8Array([...authData, ...sha256(cdj)]));
  const sig = p256.Signature.fromBytes(p256.sign(msg, secretKey, { prehash: false }), 'compact');
  return { pk: { x, y, identity: false }, assertion: toAssertion(authData, cdj, sig.r, sig.s) };
}

async function verify(digest: Uint8Array, assertion: Assertion, pk = realPk, rpIdHash = RP_ID_HASH) {
  const witnesses = { webauthnAssertion: (ctx: any): [PS, Assertion] => [ctx.privateState, ctx.privateState.assertion] };
  const sim = (await Simulator.deploy<PS>(new Contract(witnesses), {})).withProofChecks(DIR);
  return sim.call('verifyPasskey', { time: T, as: { assertion } }, digest, rpIdHash, pk);
}

const tamper = (a: Assertion, at: number): Assertion => {
  const clientData = Uint8Array.from(a.clientData);
  clientData[at] ^= 0x01;
  return { ...a, clientData };
};

describe('WebAuthn passkey verification in-circuit [V6]', () => {
  it('persistentHash<Bytes<N>> is plain SHA-256', () => {
    const x = randomBytes(134);
    expect(pureCircuits.sha256of134(x)).toEqual(sha256(x));
  });

  it.each(realCases.map((c, i) => [i, c.assertion.longForm ? 243 : 134, c] as const))(
    'verifies real Chrome assertion #%i (%i-byte clientDataJSON)',
    async (_i, _len, c) => {
      await verify(c.digest, c.assertion);
    },
  );

  it('covers both the standard and the Chrome long form', () => {
    expect(new Set(realCases.map((c) => c.assertion.longForm))).toEqual(new Set([false, true]));
  });

  it('rejects a real assertion presented for a different digest', async () => {
    await expect(verify(randomBytes(32), realCases[0].assertion)).rejects.toThrow('challenge mismatch');
  });

  it('rejects an assertion from another relying party', async () => {
    await expect(verify(realCases[0].digest, realCases[0].assertion, realPk, sha256(utf8ToBytes('evil.example'))))
      .rejects.toThrow('wrong relying party');
  });

  it('rejects tampered client data (origin byte flipped)', async () => {
    await expect(verify(realCases[0].digest, tamper(realCases[0].assertion, 100)))
      .rejects.toThrow('bad passkey signature');
  });

  it('rejects lying about the clientDataJSON form', async () => {
    const short = realCases.find((c) => !c.assertion.longForm)!;
    await expect(verify(short.digest, { ...short.assertion, longForm: true }))
      .rejects.toThrow('bad passkey signature');
  });

  it('rejects non-zero padding on the short form', async () => {
    const short = realCases.find((c) => !c.assertion.longForm)!;
    await expect(verify(short.digest, tamper(short.assertion, 200))).rejects.toThrow('bad client data');
  });

  it('rejects a signature from a different key', async () => {
    await expect(verify(realCases[0].digest, realCases[0].assertion, synthetic(randomBytes(32)).pk))
      .rejects.toThrow('bad passkey signature');
  });

  it.each([
    ['all zeros', new Uint8Array(32)],
    ['all ones', new Uint8Array(32).fill(0xff)],
    ['base64url "-" and "_" characters', new Uint8Array(32).fill(0xfb).map((b, i) => (i % 3 === 2 ? 0xff : b))],
  ])('decodes edge-case challenges: %s', async (_name, digest) => {
    const s = synthetic(digest, { flags: 0x1d });   // UP | UV | BE | BS, as Touch ID sets
    await verify(digest, s.assertion, s.pk);
  });

  it('requires user verification (Face ID / Touch ID), not just presence', async () => {
    const digest = randomBytes(32);
    const s = synthetic(digest, { flags: 0x01 });   // UP only
    await expect(verify(digest, s.assertion, s.pk)).rejects.toThrow('user not verified');
  });
});
