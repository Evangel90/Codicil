// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Any Midnight contract can become inheritable with one cross-contract call:
// the example escrow pays its beneficiary only once vault.isReleasedForContract()
// returns true. kernel.caller() inside the vault sees the escrow; direct user
// calls are rejected. Brief §6.2 and §7.1 "Cross-contract".

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { encodeRawTokenType, sampleRawTokenType } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits as vaultPure, type VaultConfig } from '@codicil/contracts/vault';
import { pureCircuits as escrowPure } from '@codicil/contracts/escrow';
import { buildWill, newEdKey, newHeirKey, newP256Key, newSalt, rpIdHash, witnesses as vaultWitnesses } from '@codicil/sdk';
import { loadModule, TestChain, type Deployed } from './support/chain.js';
import { unshieldedPaidTo } from './support/harness.js';
import { CHALLENGE, CLAIM_WINDOW, DAY, FIRST_DEADLINE, MAX_PERIOD, newRecipient, RELEASED_AT, T0 } from './support/world.js';

interface World {
  chain: TestChain;
  vault: Deployed;
  escrow: Deployed;
  secret: Uint8Array;
}

/** Escrow witnesses: only the beneficiary's device knows the secret. */
const escrowWitnesses = (secret?: Uint8Array) => ({
  beneficiarySecret: (ctx: { privateState: unknown }) => {
    if (!secret) throw new Error('no beneficiary secret on this device');
    return [ctx.privateState, secret];
  },
});

async function deployWorld(): Promise<World> {
  const chain = new TestChain();
  const color = encodeRawTokenType(sampleRawTokenType());
  const heir = newHeirKey();
  const config: VaultConfig = {
    ownerPasskeyCommit: vaultPure.passkeyCommitment(newP256Key().pk, newSalt()),
    ownerEdCommit: vaultPure.edKeyCommitment(newEdKey().pk, newSalt()),
    passkeyRpIdHash: rpIdHash(),
    willRoot: buildWill([{ heir: { pk: heir.pk, salt: newSalt() }, shareBps: 10_000n }]).root,
    firstDeadline: BigInt(FIRST_DEADLINE),
    maxPeriod: BigInt(MAX_PERIOD),
    challengeWindow: BigInt(CHALLENGE),
    claimWindow: BigInt(CLAIM_WINDOW),
    tokenColor: color,
  };
  const vault = await chain.deploy(await loadModule('codicil_vault'), [config], vaultWitnesses);
  const secret = randomBytes(32);
  const escrow = await chain.deploy(await loadModule('inheritable_escrow'), [
    vault.encodedAddress,
    color,
    escrowPure.beneficiaryCommitment(secret),
  ], escrowWitnesses());
  return { chain, vault, escrow, secret };
}

describe('inheritable escrow (cross-contract hook)', () => {
  let w: World;
  const releaseVault = async () => {
    await w.chain.call(w.vault, 'triggerTimeout', { time: FIRST_DEADLINE, witnesses: vaultWitnesses });
    await w.chain.call(w.vault, 'finalizeRelease', { time: RELEASED_AT, witnesses: vaultWitnesses });
  };
  const withdraw = (secret: Uint8Array, to = newRecipient(), time = RELEASED_AT + DAY) =>
    w.chain.call(w.escrow, 'withdrawToBeneficiary', { time, witnesses: escrowWitnesses(secret) }, to.address);

  beforeEach(async () => {
    w = await deployWorld();
    await w.chain.call(w.escrow, 'deposit', { time: T0, witnesses: escrowWitnesses() }, 5_000n);
  });

  it('blocks withdrawal while the vault is armed or pending', async () => {
    await expect(withdraw(w.secret, newRecipient(), T0)).rejects.toThrow('vault not released');
    await w.chain.call(w.vault, 'triggerTimeout', { time: FIRST_DEADLINE, witnesses: vaultWitnesses });
    await expect(withdraw(w.secret, newRecipient(), FIRST_DEADLINE + DAY)).rejects.toThrow('vault not released');
  });

  it('pays the beneficiary once the vault is released, via a proven vault sub-call', async () => {
    await releaseVault();
    const to = newRecipient();
    const r = await withdraw(w.secret, to);
    expect(unshieldedPaidTo(r.effects, to.hex)).toBe(5_000n);
    // Two proofs in one transaction, in completion order: the vault sub-call
    // finishes first, then the escrow circuit that made it.
    expect(r.trace).toEqual([
      [w.vault.address, 'isReleasedForContract'],
      [w.escrow.address, 'withdrawToBeneficiary'],
    ]);
    await expect(withdraw(w.secret, to)).rejects.toThrow('already withdrawn');
  });

  it('rejects someone who does not know the beneficiary secret', async () => {
    await releaseVault();
    await expect(withdraw(randomBytes(32))).rejects.toThrow('not the beneficiary');
  });

  it('rejects a direct user call to the vault hook', async () => {
    await releaseVault();
    await expect(w.chain.call(w.vault, 'isReleasedForContract', { time: RELEASED_AT, witnesses: vaultWitnesses }))
      .rejects.toThrow('callable by contracts only');
  });
});
