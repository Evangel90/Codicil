// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Gate V7: Cardano CIP-30 signData (COSE_Sign1, plain Ed25519) verified
// in-circuit.
//
// CI uses synthetic COSE_Sign1 messages built byte-for-byte like a real wallet's.
// The real wallet captures (Nightly, mainnet address) are personal data and
// are kept out of git; when present locally in planning/fixtures/ they are
// verified too.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Contract } from '../contracts/managed/cip30/contract/index.js';
import { Simulator } from './harness.js';

const DIR = new URL('../contracts/managed/cip30', import.meta.url).pathname;
const LOCAL_FIXTURE = new URL('../../planning/fixtures/capture-chrome-1.json', import.meta.url);
const T = 1_800_000_000;

const point = (b: Uint8Array) => {
  const { x, y } = ed25519.Point.fromBytes(b).toAffine();
  return { x, y };
};

/** CBOR Sig_structure ["Signature1", protected, h'', payload] for a 57-byte address. */
function sigStructure(address: Uint8Array, payload: Uint8Array): Uint8Array {
  const prot = new Uint8Array([0xa2, 0x01, 0x27, 0x67, ...utf8ToBytes('address'), 0x58, 0x39, ...address]);
  return new Uint8Array([0x84, 0x6a, ...utf8ToBytes('Signature1'), 0x58, 0x46, ...prot, 0x40, 0x58, 0x20, ...payload]);
}

/** Parse a wallet COSE_Sign1 (base-address layout) into what the circuit needs. */
function fromCoseSign1(coseHex: string, keyHex: string) {
  const cose = hexToBytes(coseHex);
  const prot = cose.slice(3, 73);
  const payload = cose.slice(76, 108);
  const sig = cose.slice(110, 174);
  return {
    digest: payload,
    pk: point(hexToBytes(keyHex).slice(-32)),
    witness: {
      sigStructure: sigStructure(prot.slice(13), payload),
      sig: { r: point(sig.slice(0, 32)), s: bytesToNumberLE(sig.slice(32)) },
    },
  };
}

function synthetic(digest: Uint8Array) {
  const { secretKey, publicKey } = ed25519.keygen();
  const address = new Uint8Array([0x01, ...randomBytes(56)]);   // base address, testnet-style header
  const msg = sigStructure(address, digest);
  const raw = ed25519.sign(msg, secretKey);
  return {
    digest,
    pk: point(publicKey),
    witness: { sigStructure: msg, sig: { r: point(raw.slice(0, 32)), s: bytesToNumberLE(raw.slice(32)) } },
  };
}

type Case = ReturnType<typeof synthetic>;

async function verify(digest: Uint8Array, pk: Case['pk'], witness: Case['witness']) {
  const w = { cip30Signature: (ctx: any): [any, Case['witness']] => [ctx.privateState, ctx.privateState.w] };
  const sim = (await Simulator.deploy<any>(new Contract(w), {})).withProofChecks(DIR);
  return sim.call('verifyCip30', { time: T, as: { w: witness } }, digest, pk);
}

describe('CIP-30 signData verification in-circuit [V7]', () => {
  it('builds a 119-byte Sig_structure with the digest at offset 87', () => {
    const s = sigStructure(new Uint8Array(57), new Uint8Array(32).fill(7));
    expect(s.length).toBe(119);
    expect(s.slice(87)).toEqual(new Uint8Array(32).fill(7));
  });

  it('verifies a wallet-format signature', async () => {
    const c = synthetic(randomBytes(32));
    await verify(c.digest, c.pk, c.witness);
  });

  it('rejects a signature presented for a different digest', async () => {
    const c = synthetic(randomBytes(32));
    await expect(verify(randomBytes(32), c.pk, c.witness)).rejects.toThrow('not a CIP-30 signature over this digest');
  });

  it('rejects a different wallet key', async () => {
    const c = synthetic(randomBytes(32));
    await expect(verify(c.digest, synthetic(randomBytes(32)).pk, c.witness)).rejects.toThrow('bad wallet signature');
  });

  it('rejects an Ed25519 signature that is not a CIP-30 Sig_structure', async () => {
    const { secretKey, publicKey } = ed25519.keygen();
    const digest = randomBytes(32);
    const msg = sigStructure(new Uint8Array(57), digest);
    msg[2] ^= 0x20;                             // "signature1": wrong COSE context string
    const raw = ed25519.sign(msg, secretKey);    // a perfectly valid signature over other bytes
    await expect(verify(digest, point(publicKey), {
      sigStructure: msg, sig: { r: point(raw.slice(0, 32)), s: bytesToNumberLE(raw.slice(32)) },
    })).rejects.toThrow('not a CIP-30 signature over this digest');
  });

  const real = existsSync(LOCAL_FIXTURE) ? JSON.parse(readFileSync(LOCAL_FIXTURE, 'utf8')).cip30 : [];
  const realCases: [number, string, any][] = real.map((c: any, i: number) => [i, c.wallet, c]);
  it.skipIf(real.length === 0).each(realCases)(
    'verifies real wallet capture #%i (%s) [local only]',
    async (_i, _w, c: any) => {
      const r = fromCoseSign1(c.coseSign1, c.coseKey);
      expect(Buffer.from(r.digest).toString('hex')).toBe(c.payload);
      await verify(r.digest, r.pk, r.witness);
    },
  );
});
