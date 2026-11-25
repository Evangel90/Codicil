// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The optional release fee: a share of the estate, in basis points, sent to a
// fee address once, when the will is released. Heirs' shares are taken of
// what remains. docs/DECISIONS.md D16.

import { describe, expect, it } from 'vitest';
import { Contract, Phase } from '@codicil/contracts/vault';
import {
  createWitnesses,
  MAX_FEE_BPS,
  payoutFor,
  releaseFeeConfig,
  releaseFeeFor,
  snapshotAfterFee,
  VAULT_OPTIONS_OFF,
} from '@codicil/sdk';
import { collectBytes, containsValue, unshieldedPaidTo } from './support/harness.js';
import {
  asClaimant,
  checkIn,
  DAY,
  deployVault,
  FIRST_DEADLINE,
  L,
  LOCKED_UNTIL,
  newPerson,
  newRecipient,
  nobody,
  RELEASED_AT,
  T0,
  type Person,
  type World,
} from './support/world.js';

const ESTATE = 1_000_001n;
const FEE_BPS = 250n;   // 2.5%
const opening = (p: Person) => ({ pk: p.key.pk, salt: p.keySalt });

/** Every unshielded payment a call asks the ledger to make. */
const spends = (effects: { claimedUnshieldedSpends: Map<unknown, bigint> }) => [...effects.claimedUnshieldedSpends.values()];

async function funded(feeBps: bigint, opts: Parameters<typeof deployVault>[0] = {}, estate = ESTATE) {
  const treasury = newRecipient();
  const w = await deployVault({ ...opts, config: { ...opts.config, ...releaseFeeConfig(feeBps, treasury.hex) } });
  if (estate > 0n) await w.sim.call('deposit', { time: T0, as: nobody }, estate);
  await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
  return { w, treasury };
}

const finalize = (w: World) => w.sim.call('finalizeRelease', { time: RELEASED_AT, as: nobody });

async function claim(w: World, index: number, who: Person, time = LOCKED_UNTIL) {
  const to = newRecipient();
  const r = await w.sim.call('claim', { time, as: asClaimant(w.will, index, who) }, to.address);
  return unshieldedPaidTo(r.effects, to.hex);
}

describe('release fee', () => {
  it('is off by default: release takes nothing, makes no transfer and asks no witness', async () => {
    expect(VAULT_OPTIONS_OFF.feeBps).toBe(0n);
    const w = await deployVault();
    expect(L(w.sim).feeBps).toBe(0n);
    await w.sim.call('deposit', { time: T0, as: nobody }, ESTATE);
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });

    // A client with no payout witness at all can still release a fee-less vault.
    const bare = createWitnesses({ strict: false });
    bare.payoutDivision = () => { throw new Error('the fee witness must not be consulted'); };
    const sim = w.sim.withContract(new Contract(bare));
    const r = await sim.call('finalizeRelease', { time: RELEASED_AT, as: nobody });
    expect(spends(r.effects)).toEqual([]);

    await finalize(w);
    expect(L(w.sim).estateSnapshot).toBe(ESTATE);
    expect(await claim(w, 1, w.heirs[1])).toBe(payoutFor(ESTATE, 3333n));   // exactly as without the feature
  });

  it('sends floor(estate × feeBps / 10000) to the fee address, once, at release', async () => {
    const { w, treasury } = await funded(FEE_BPS);
    const r = await finalize(w);
    const fee = unshieldedPaidTo(r.effects, treasury.hex);
    expect(fee).toBe(25_000n);                         // 1_000_001 × 2.5% = 25_000.025, rounded down
    expect(fee).toBe(releaseFeeFor(ESTATE, FEE_BPS));
    expect(spends(r.effects)).toEqual([fee]);          // the only transfer in the transaction

    const l = L(w.sim);
    expect(l.phase).toBe(Phase.released);
    expect(l.estateTotal).toBe(ESTATE);
    expect(l.estateSnapshot).toBe(ESTATE - fee);
    expect(l.estateSnapshot).toBe(snapshotAfterFee(ESTATE, FEE_BPS));
    expect(l.estatePaid).toBe(0n);
    await expect(finalize(w)).rejects.toThrow('not pending');   // it cannot be taken twice
  });

  it("takes heirs' shares of what remains, so fee plus claims never exceeds the estate", async () => {
    const { w, treasury } = await funded(FEE_BPS);
    const fee = unshieldedPaidTo((await finalize(w)).effects, treasury.hex);
    const snapshot = ESTATE - fee;
    let claimed = 0n;
    for (const [i, bps] of [5000n, 3333n, 1667n].entries()) {
      const paid = await claim(w, i, w.heirs[i]);
      expect(paid).toBe(payoutFor(snapshot, bps));
      claimed += paid;
    }
    expect(L(w.sim).estatePaid).toBe(claimed);
    expect(claimed).toBeLessThanOrEqual(snapshot);
    // The will allocates 100%, so all that is left in the vault is rounding dust:
    // less than one unit per heir, never paid twice, never lost to the fee.
    const dust = ESTATE - fee - claimed;
    expect(dust).toBeGreaterThanOrEqual(0n);
    expect(dust).toBeLessThan(3n);
  });

  it('pays no fee when the owner vetoes: the fee exists only at release', async () => {
    const { w } = await funded(FEE_BPS);
    const t = FIRST_DEADLINE + DAY;
    const r = await checkIn(w, 'passkey', t + 10 * DAY, t);
    expect(spends(r.effects)).toEqual([]);
    await expect(finalize(w)).rejects.toThrow('not pending');
    expect(L(w.sim).estateSnapshot).toBe(0n);
  });

  it('makes no transfer when the fee rounds down to nothing, or the estate is empty', async () => {
    const small = await funded(FEE_BPS, {}, 39n);            // 39 × 2.5% = 0.975
    expect(spends((await finalize(small.w)).effects)).toEqual([]);
    expect(L(small.w.sim).estateSnapshot).toBe(39n);

    const one = await funded(FEE_BPS, {}, 40n);              // 40 × 2.5% = 1
    expect(unshieldedPaidTo((await finalize(one.w)).effects, one.treasury.hex)).toBe(1n);
    expect(L(one.w.sim).estateSnapshot).toBe(39n);

    const empty = await funded(FEE_BPS, {}, 0n);
    expect(spends((await finalize(empty.w)).effects)).toEqual([]);
    expect(L(empty.w.sim).phase).toBe(Phase.released);
  });

  it('at the 10% cap, heirs with the whole estate still receive 90% and the vault is not overdrawn', async () => {
    const solo = newPerson();
    const { w, treasury } = await funded(MAX_FEE_BPS, { entries: () => [{ heir: opening(solo), shareBps: 10_000n }] });
    const fee = unshieldedPaidTo((await finalize(w)).effects, treasury.hex);
    expect(fee).toBe(100_000n);
    expect(await claim(w, 0, solo, RELEASED_AT)).toBe(ESTATE - fee);
    expect(L(w.sim).estatePaid).toBe(L(w.sim).estateSnapshot);
  });

  it('rejects a wrong fee from a modified client, in either direction', async () => {
    const { w } = await funded(FEE_BPS);
    const lie = (change: (q: bigint, r: bigint) => [bigint, bigint]) => {
      const liar = createWitnesses({ strict: false });
      const honest = liar.payoutDivision;
      liar.payoutDivision = (ctx, total, bps) => {
        const [s, [q, r]] = honest(ctx, total, bps);
        return [s, change(q, r)];
      };
      return w.sim.withContract(new Contract(liar)).call('finalizeRelease', { time: RELEASED_AT, as: nobody });
    };
    await expect(lie((q, r) => [q + 1n, r])).rejects.toThrow('bad fee math');            // a larger fee
    await expect(lie((q, r) => [q - 1n, r])).rejects.toThrow('bad fee math');            // a smaller fee
    await expect(lie((q, r) => [q - 1n, r + 10_000n])).rejects.toThrow('bad fee math');  // hiding it in the remainder
    await expect(lie(() => [0n, 0n])).rejects.toThrow('bad fee math');                   // skipping the fee
    expect(L(w.sim).phase).toBe(Phase.pending);
    await finalize(w);
  });

  it('refuses a fee above 10%, or a fee with nowhere to go', async () => {
    const treasury = newRecipient();
    await expect(deployVault({ config: { feeBps: MAX_FEE_BPS + 1n, feeRecipient: treasury.address } }))
      .rejects.toThrow('fee too high');
    await expect(deployVault({ config: { feeBps: 1n, feeRecipient: { bytes: new Uint8Array(32) } } }))
      .rejects.toThrow('fee needs an address');
    await deployVault({ config: { feeBps: MAX_FEE_BPS, feeRecipient: treasury.address } });
    // The SDK refuses the same settings before any deployment.
    expect(() => releaseFeeConfig(MAX_FEE_BPS + 1n, treasury.hex)).toThrow('between 0% and 10%');
    expect(() => releaseFeeConfig(1n, new Uint8Array(32))).toThrow('needs an address');
  });

  it('the fee rate and address are public by design, on the ledger and in the release transaction', async () => {
    const { w, treasury } = await funded(FEE_BPS);
    expect(L(w.sim).feeBps).toBe(FEE_BPS);
    expect(L(w.sim).feeRecipient.bytes).toEqual(treasury.address.bytes);
    const r = await finalize(w);
    expect(containsValue(collectBytes(r.publicTranscript), treasury.address.bytes)).toBe(true);
  });
});
