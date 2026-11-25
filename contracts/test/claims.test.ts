// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Heir claims, tranches, backup heirs and payout arithmetic.
// Brief §7.1 "Claims" and "Backup heirs".

import { beforeEach, describe, expect, it } from 'vitest';
import { numberToBytesLE } from '@noble/curves/utils.js';
import { Contract, pureCircuits } from '@codicil/contracts/vault';
import {
  buildWill,
  createWitnesses,
  keyCommitment,
  MerkleTree,
  newSalt,
  payoutFor,
  vaultId,
  type CodicilPrivateState,
} from '@codicil/sdk';
import { collectBytes, containsValue, unshieldedPaidTo } from './support/harness.js';
import {
  asClaimant,
  CLAIM_WINDOW,
  DAY,
  deployVault,
  L,
  LOCKED_UNTIL,
  newPerson,
  newRecipient,
  nobody,
  release,
  RELEASED_AT,
  T0,
  type Person,
  type World,
} from './support/world.js';

const ESTATE = 1_000_001n;
const AFTER = RELEASED_AT + DAY;             // inside the primary claim window
const BACKUP_TIME = RELEASED_AT + CLAIM_WINDOW;
const opening = (p: Person) => ({ pk: p.key.pk, salt: p.keySalt });

async function fundedAndReleased(opts?: Parameters<typeof deployVault>[0]): Promise<World> {
  const w = await deployVault(opts);
  await w.sim.call('deposit', { time: T0, as: nobody }, ESTATE);
  await release(w);
  return w;
}

async function claim(w: World, as: CodicilPrivateState, time = AFTER, circuit: 'claim' | 'claimAsBackup' = 'claim') {
  const to = newRecipient();
  const r = await w.sim.call(circuit, { time, as }, to.address);
  return { r, paid: unshieldedPaidTo(r.effects, to.hex) };
}

describe('claims', () => {
  let w: World;
  beforeEach(async () => {
    w = await fundedAndReleased();
  });

  it('pays an heir exactly floor(snapshot × bps / 10000)', async () => {
    const { paid } = await claim(w, asClaimant(w.will, 1, w.heirs[1]));   // 3333 bps
    expect(paid).toBe(333_300n);                                          // 1_000_001 × 0.3333, rounded down
    expect(paid).toBe(payoutFor(ESTATE, 3333n));
    expect(L(w.sim).estatePaid).toBe(paid);
  });

  it('rejects claims before release', async () => {
    const v = await deployVault();
    await expect(claim(v, asClaimant(v.will, 0, v.heirs[0]), T0)).rejects.toThrow('vault not released');
  });

  it('rejects a second claim of the same share', async () => {
    await claim(w, asClaimant(w.will, 0, w.heirs[0]));
    await expect(claim(w, asClaimant(w.will, 0, w.heirs[0]))).rejects.toThrow('already claimed');
  });

  it("rejects someone holding a real heir's claim package but not their key", async () => {
    await expect(claim(w, asClaimant(w.will, 0, newPerson()))).rejects.toThrow('not the heir');
    // ...and an heir using another heir's package
    await expect(claim(w, asClaimant(w.will, 0, w.heirs[1]))).rejects.toThrow('not the heir');
  });

  it('rejects a well-formed leaf that is not in the will', async () => {
    await expect(claim(w, { claimant: w.outsider })).rejects.toThrow('not in will');
  });

  it('rejects a tampered leaf (inflated share)', async () => {
    const as = asClaimant(w.will, 1, w.heirs[1]);
    as.claimant!.leaf = { ...as.claimant!.leaf, shareBps: 10_000n };
    await expect(claim(w, as)).rejects.toThrow('not in will');
  });

  it('holds a tranche until its unlock date', async () => {
    const as = asClaimant(w.will, 2, w.heirs[2]);
    await expect(claim(w, as, LOCKED_UNTIL - 1)).rejects.toThrow('share still locked');
    const { paid } = await claim(w, as, LOCKED_UNTIL);
    expect(paid).toBe(payoutFor(ESTATE, 1667n));
  });

  it('pays every heir once, never more than the snapshot in total', async () => {
    let total = 0n;
    for (let i = 0; i < 3; i++) total += (await claim(w, asClaimant(w.will, i, w.heirs[i]), LOCKED_UNTIL)).paid;
    expect(total).toBe(payoutFor(ESTATE, 5000n) + payoutFor(ESTATE, 3333n) + payoutFor(ESTATE, 1667n));
    expect(total).toBeLessThanOrEqual(ESTATE);
    expect(L(w.sim).estatePaid).toBe(total);
  });

  it('rejects a wrong payout quotient from a modified client', async () => {
    const liar = createWitnesses({ strict: false });
    const honest = liar.payoutDivision;
    liar.payoutDivision = (ctx, snapshot, bps) => {
      const [s, [q, r]] = honest(ctx, snapshot, bps);
      return [s, [q + 1n, r]];
    };
    const evil = w.sim.withContract(new Contract(liar));
    await expect(claim({ ...w, sim: evil }, asClaimant(w.will, 1, w.heirs[1]))).rejects.toThrow('bad payout math');
  });

  it('publishes a nullifier, not which leaf or heir claimed', async () => {
    const as = asClaimant(w.will, 1, w.heirs[1]);
    const { r } = await claim(w, as);
    const t = collectBytes(r.publicTranscript);
    const leafHash = pureCircuits.heirLeafHash(w.will.leaves[1]);
    expect(L(w.sim).claimNullifiers.member(pureCircuits.claimNullifier(vaultId(w.sim.address), leafHash))).toBe(true);
    expect(containsValue(t, leafHash)).toBe(false);
    expect(containsValue(t, w.will.leaves[1].heirKeyCommit)).toBe(false);
    expect(containsValue(t, w.heirs[1].keySalt)).toBe(false);
    expect(containsValue(t, numberToBytesLE(w.heirs[1].key.pk.x, 32))).toBe(false);
  });
});

describe('over-allocated wills', () => {
  it('the SDK refuses to build a will over 100%', () => {
    const p = newPerson();
    expect(() => buildWill([
      { heir: opening(p), shareBps: 6000n },
      { heir: opening(p), shareBps: 6000n },
    ])).toThrow('more than 100%');
  });

  it('the vault never pays out more than the snapshot, even if shares exceed 100%', async () => {
    // Built by hand, as a buggy or malicious client might.
    const w = await fundedAndReleased({
      will: ({ heirs }) => {
        const leaves = heirs.slice(0, 2).map((h) => ({
          heirKeyCommit: keyCommitment(opening(h)),
          backupKeyCommit: new Uint8Array(32),
          shareBps: 6000n,
          unlockAt: 0n,
          salt: newSalt(),
        }));
        const tree = new MerkleTree(leaves.map((l) => pureCircuits.heirLeafHash(l)));
        return { leaves, tree, root: tree.root };
      },
    });
    const first = await claim(w, asClaimant(w.will, 0, w.heirs[0]));
    expect(first.paid).toBe(payoutFor(ESTATE, 6000n));
    await expect(claim(w, asClaimant(w.will, 1, w.heirs[1]))).rejects.toThrow('estate exhausted');
    expect(L(w.sim).estatePaid).toBe(first.paid);
  });
});

describe('backup heirs', () => {
  let w: World;
  beforeEach(async () => {
    w = await fundedAndReleased();
  });

  it('cannot claim during the primary claim window', async () => {
    await expect(claim(w, asClaimant(w.will, 0, w.backup), BACKUP_TIME - 1, 'claimAsBackup'))
      .rejects.toThrow('primary claim window open');
  });

  it('can claim an unclaimed share after the window; the primary then cannot', async () => {
    const { paid } = await claim(w, asClaimant(w.will, 0, w.backup), BACKUP_TIME, 'claimAsBackup');
    expect(paid).toBe(payoutFor(ESTATE, 5000n));
    await expect(claim(w, asClaimant(w.will, 0, w.heirs[0]), BACKUP_TIME)).rejects.toThrow('already claimed');
  });

  it('cannot claim a share the primary already took', async () => {
    await claim(w, asClaimant(w.will, 0, w.heirs[0]));
    await expect(claim(w, asClaimant(w.will, 0, w.backup), BACKUP_TIME, 'claimAsBackup'))
      .rejects.toThrow('already claimed');
  });

  it('only the named backup can use the backup path', async () => {
    await expect(claim(w, asClaimant(w.will, 0, w.heirs[0]), BACKUP_TIME, 'claimAsBackup'))
      .rejects.toThrow('not the backup heir');
    await expect(claim(w, asClaimant(w.will, 1, newPerson()), BACKUP_TIME, 'claimAsBackup'))
      .rejects.toThrow('not the backup heir');
  });

  it('a share with no backup cannot be claimed through the backup path', async () => {
    // Leaf 1 has backupKeyCommit = 0, which no key commitment can equal.
    const zeroKeyed = asClaimant(w.will, 1, { key: w.heirs[1].key, keySalt: newSalt() });
    await expect(claim(w, zeroKeyed, BACKUP_TIME, 'claimAsBackup')).rejects.toThrow('not the backup heir');
  });

  it('a backup is also subject to the share unlock date', async () => {
    const v = await fundedAndReleased({
      entries: ({ heirs, backup }) => [
        { heir: opening(heirs[0]), backup: opening(backup), shareBps: 10_000n, unlockAt: BigInt(BACKUP_TIME + DAY) },
      ],
    });
    await expect(claim(v, asClaimant(v.will, 0, v.backup), BACKUP_TIME, 'claimAsBackup'))
      .rejects.toThrow('share still locked');
    await claim(v, asClaimant(v.will, 0, v.backup), BACKUP_TIME + DAY, 'claimAsBackup');
  });
});
