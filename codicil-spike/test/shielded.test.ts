// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Gate V11: a contract holds a shielded coin and pays an heir with
// sendShielded, and we measure exactly what becomes public.

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { encodeRawTokenType, sampleRawTokenType } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../contracts/managed/shielded_payout/contract/index.js';
import { collectBytes, containsBytes, Simulator } from './harness.js';

const DIR = new URL('../contracts/managed/shielded_payout', import.meta.url).pathname;
const T = 1_800_000_000;

describe('Shielded payout from a contract-held coin [V11]', () => {
  let sim: Simulator<object>;
  const color = encodeRawTokenType(sampleRawTokenType());
  // The transcript drops trailing zero bytes of a value, so a nonce that ends in
  // one cannot be found by the byte search below (one run in 256). Keep the last byte odd.
  const coin = { nonce: Uint8Array.from(randomBytes(32), (b, i) => (i === 31 ? b | 1 : b)), color, value: 1_000n };
  const heir = { bytes: randomBytes(32) };   // the heir's ZswapCoinPublicKey

  beforeEach(async () => {
    sim = (await Simulator.deploy<object>(new Contract({}), {})).withProofChecks(DIR);
    const r = await sim.call('fund', { time: T, as: {} }, coin);
    expect(r.effects.claimedShieldedReceives).toHaveLength(1);
    // Positive control for the byte search below: the funded coin's nonce was
    // disclosed, so it must be findable in this call's public transcript.
    expect(containsBytes(collectBytes(r.publicTranscript), coin.nonce)).toBe(true);
  });

  it('pays part of the pot to a shielded recipient and keeps the change', async () => {
    const r = await sim.call('payShielded', { time: T, as: {} }, heir, 333n);
    const fx = r.effects;
    expect(fx.claimedNullifiers).toHaveLength(1);        // the pot coin is spent
    expect(fx.claimedShieldedSpends).toHaveLength(2);    // heir's coin + change coin
    expect(fx.claimedShieldedReceives).toHaveLength(1);  // change returns to the contract
    const l = ledger(sim.ledgerState);
    expect(l.funded).toBe(true);
    expect(l.pot.value).toBe(667n);
  });

  it("never publishes the heir's key: only a coin commitment", async () => {
    const r = await sim.call('payShielded', { time: T, as: {} }, heir, 333n);
    expect(containsBytes(collectBytes(r.publicTranscript), heir.bytes)).toBe(false);
  });

  it('LEAK (documented): the paid amount is derivable from the public change coin', async () => {
    const before = ledger(sim.ledgerState).pot.value;
    await sim.call('payShielded', { time: T, as: {} }, heir, 333n);
    expect(before - ledger(sim.ledgerState).pot.value).toBe(333n);
  });

  it('empties the pot on a full payout', async () => {
    const r = await sim.call('payShielded', { time: T, as: {} }, heir, 1_000n);
    expect(r.effects.claimedShieldedSpends).toHaveLength(1);
    expect(ledger(sim.ledgerState).funded).toBe(false);
    await expect(sim.call('payShielded', { time: T, as: {} }, heir, 1n)).rejects.toThrow('no funds');
  });
});
