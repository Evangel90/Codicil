// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Gate V12: an escrow contract becomes "inheritable" by calling
// vault.isReleasedForContract(); kernel.caller() inside the vault sees the
// escrow's address, and direct user calls are rejected.

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  encodeRawTokenType,
  encodeUserAddress,
  sampleRawTokenType,
  sampleUserAddress,
} from '@midnight-ntwrk/compact-runtime';
import { pureCircuits as vaultPure } from '../contracts/managed/codicil_spike/contract/index.js';
import { pureCircuits as escrowPure } from '../contracts/managed/inheritable_escrow/contract/index.js';
import { loadModule, TestChain, type Deployed } from './chain.js';
import { newEdKey, newP256Key, salt, WillTree } from './crypto.js';
import { unshieldedPaidTo } from './harness.js';
import { witnesses as vaultWitnesses } from './witnesses.js';

const DAY = 86_400;
const T0 = 1_800_000_000;
const DEADLINE = T0 + 10 * DAY;
const CHALLENGE = 7 * DAY;
const RELEASED_AT = DEADLINE + CHALLENGE;

interface World {
  chain: TestChain;
  vault: Deployed;
  escrow: Deployed;
  secret: Uint8Array;
}

async function deployWorld(): Promise<World> {
  const chain = new TestChain();
  const passkey = newP256Key();
  const ed = newEdKey();
  const color = encodeRawTokenType(sampleRawTokenType());
  const vault = await chain.deploy(await loadModule('codicil_spike'), [
    vaultPure.passkeyCommitment(passkey.pk, salt()),
    vaultPure.edKeyCommitment(ed.pk, salt()),
    new WillTree([]).root,
    BigInt(DEADLINE),
    BigInt(30 * DAY),
    BigInt(CHALLENGE),
    color,
  ], vaultWitnesses);

  const secret = randomBytes(32);
  const escrow = await chain.deploy(await loadModule('inheritable_escrow'), [
    vault.encodedAddress,
    color,
    escrowPure.beneficiaryCommitment(secret),
  ], escrowWitnesses());
  return { chain, vault, escrow, secret };
}

/** Escrow witnesses: only the beneficiary's device knows the secret. */
const escrowWitnesses = (secret?: Uint8Array) => ({
  beneficiarySecret: (ctx: any) => {
    if (!secret) throw new Error('no beneficiary secret on this device');
    return [ctx.privateState, secret];
  },
});
const beneficiary = (secret: Uint8Array) => ({ witnesses: escrowWitnesses(secret) });

function newRecipient() {
  const hex = sampleUserAddress();
  return { hex, address: { bytes: encodeUserAddress(hex) } };
}

async function releaseVault(w: World) {
  const opts = (time: number) => ({ time, witnesses: vaultWitnesses });
  await w.chain.call(w.vault, 'triggerTimeout', opts(DEADLINE));
  await w.chain.call(w.vault, 'finalizeRelease', opts(RELEASED_AT));
}

describe('Inheritable escrow via cross-contract call [V12]', () => {
  let w: World;
  beforeEach(async () => {
    w = await deployWorld();
    await w.chain.call(w.escrow, 'deposit', { time: T0, witnesses: escrowWitnesses() }, 5_000n);
  });

  it('blocks withdrawal while the vault is still armed', async () => {
    await expect(
      w.chain.call(w.escrow, 'withdrawToBeneficiary', { time: T0, ...beneficiary(w.secret) }, newRecipient().address),
    ).rejects.toThrow('vault not released');
  });

  it('pays the beneficiary once the vault is released, via a proven vault sub-call', async () => {
    await releaseVault(w);
    const to = newRecipient();
    const r = await w.chain.call(
      w.escrow, 'withdrawToBeneficiary', { time: RELEASED_AT, ...beneficiary(w.secret) }, to.address,
    );
    expect(unshieldedPaidTo(r.effects, to.hex)).toBe(5_000n);
    // Two proofs in one transaction, listed in completion order: the vault
    // sub-call finishes first, then the escrow circuit that made it.
    expect(r.trace).toEqual([
      [w.vault.address, 'isReleasedForContract'],
      [w.escrow.address, 'withdrawToBeneficiary'],
    ]);
    await expect(
      w.chain.call(w.escrow, 'withdrawToBeneficiary', { time: RELEASED_AT, ...beneficiary(w.secret) }, to.address),
    ).rejects.toThrow('already withdrawn');
  });

  it('rejects someone who does not know the beneficiary secret', async () => {
    await releaseVault(w);
    await expect(
      w.chain.call(w.escrow, 'withdrawToBeneficiary', { time: RELEASED_AT, ...beneficiary(randomBytes(32)) }, newRecipient().address),
    ).rejects.toThrow('not the beneficiary');
  });

  it('rejects a direct user call to the vault hook (kernel.caller() is none)', async () => {
    await releaseVault(w);
    await expect(w.chain.call(w.vault, 'isReleasedForContract', { time: RELEASED_AT, witnesses: vaultWitnesses }))
      .rejects.toThrow('callable by contracts only');
  });
});
