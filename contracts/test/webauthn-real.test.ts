// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Real Touch ID assertions (Chrome 157, macOS; gate V6) through the vault's
// own WebAuthn module (src/lib/WebAuthn.compact with the vault's generic
// arguments), converted by the SDK exactly as the app converts browser output.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils.js';
import { p256 } from '@noble/curves/nist.js';
import { Contract } from '@codicil/contracts/test/webauthn-harness';
import { rpIdHash, toWebAuthnAssertion, verifyWebAuthnAssertion, type WebAuthnAssertion } from '@codicil/sdk';
import { Simulator } from './support/harness.js';

const DIR = new URL('../managed/webauthn_harness', import.meta.url).pathname;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/webauthn-chrome-macos.json', import.meta.url), 'utf8'));
const pk = {
  x: BigInt('0x' + fixture.passkey.publicKey.x),
  y: BigInt('0x' + fixture.passkey.publicKey.y),
  identity: false,
};

// The fixture stores r and s; the browser returns DER, so rebuild DER and go
// through the same conversion the app uses.
const cases = fixture.assertions.map((a: any) => {
  const der = new p256.Signature(BigInt('0x' + a.r), BigInt('0x' + a.s)).toBytes('der');
  return {
    digest: hexToBytes(a.digest),
    assertion: toWebAuthnAssertion({
      authenticatorData: hexToBytes(a.authenticatorData),
      clientDataJSON: hexToBytes(a.clientDataJSONHex),
      signature: der,
    }),
  };
}) as { digest: Uint8Array; assertion: WebAuthnAssertion }[];

async function verifyInCircuit(digest: Uint8Array, assertion: WebAuthnAssertion) {
  const witnesses = { assertion: (ctx: any): [unknown, WebAuthnAssertion] => [ctx.privateState, assertion] };
  const sim = (await Simulator.deploy<unknown>(new Contract(witnesses), {})).withProofChecks(DIR);
  return sim.call('verify', { time: 1_800_000_000, as: {} }, digest, rpIdHash(), pk);
}

describe('real passkey assertions through the vault WebAuthn module', () => {
  it('covers both clientDataJSON forms', () => {
    expect(new Set(cases.map((c) => c.assertion.longForm))).toEqual(new Set([false, true]));
  });

  it.each(cases.map((c, i) => [i, c] as const))('assertion #%i verifies off-chain (SDK) and in-circuit', async (_i, c) => {
    expect(verifyWebAuthnAssertion(c.assertion, c.digest, pk)).toBe(true);
    await verifyInCircuit(c.digest, c.assertion);
  });

  it('rejects a real assertion for another digest, in the SDK and in the circuit', async () => {
    const other = cases[1].digest;
    expect(verifyWebAuthnAssertion(cases[0].assertion, other, pk)).toBe(false);
    await expect(verifyInCircuit(other, cases[0].assertion)).rejects.toThrow('passkey signed something else');
  });
});
