// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Deposits, timeout, release, events and what the public ledger reveals.
// Brief §7.1 "Release" and the public/private table in docs/PRIVACY.md.

import { beforeEach, describe, expect, it } from 'vitest';
import { numberToBytesBE, numberToBytesLE } from '@noble/curves/utils.js';
import { Phase, pureCircuits } from '@codicil/contracts/vault';
import { checkInDigest, timeoutOpensAt, VAULT_EVENTS, vaultEventName, VAULT_OPTIONS_OFF } from '@codicil/sdk';
import { collectBytes, containsAscii, containsBytes, containsValue, eventBytes, unshieldedReceived } from './support/harness.js';
import {
  CHALLENGE,
  checkIn,
  DAY,
  deployVault,
  FIRST_DEADLINE,
  L,
  MAX_PERIOD,
  nobody,
  RELEASED_AT,
  T0,
  updateWill,
  vote,
  type Via,
  type World,
} from './support/world.js';

describe('vault lifecycle', () => {
  let w: World;
  beforeEach(async () => {
    w = await deployVault();
  });

  it('deploys armed, storing only commitments and the will root', () => {
    const l = L(w.sim);
    expect(l.phase).toBe(Phase.armed);
    expect(l.deadline).toBe(BigInt(FIRST_DEADLINE));
    expect(l.nonce).toBe(0n);
    expect(l.willRoot).toBe(w.will.root);
    expect(l.ownerPasskeyCommit).toEqual(
      pureCircuits.passkeyCommitment(w.owner.passkey.pk, w.owner.state.passkey!.salt),
    );
    expect(l.claimNullifiers.isEmpty()).toBe(true);
  });

  it('accepts deposits from anyone while armed', async () => {
    const r = await w.sim.call('deposit', { time: T0, as: nobody }, 600n);
    expect(unshieldedReceived(r.effects)).toBe(600n);
    await w.sim.call('deposit', { time: T0, as: nobody }, 400n);
    expect(L(w.sim).estateTotal).toBe(1000n);
  });

  it('stops accepting deposits once the countdown starts', async () => {
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
    await expect(w.sim.call('deposit', { time: FIRST_DEADLINE, as: nobody }, 1n)).rejects.toThrow('vault closed');
  });

  it('only times out once the deadline has passed, and only once', async () => {
    await expect(w.sim.call('triggerTimeout', { time: FIRST_DEADLINE - 1, as: nobody }))
      .rejects.toThrow('owner is still alive');
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
    expect(L(w.sim).phase).toBe(Phase.pending);
    expect(L(w.sim).pendingUntil).toBe(BigInt(FIRST_DEADLINE + CHALLENGE));
    await expect(w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody })).rejects.toThrow('not armed');
  });

  it('a check-in pushes the timeout back', async () => {
    await checkIn(w, 'passkey', FIRST_DEADLINE + 5 * DAY, T0);
    await expect(w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody }))
      .rejects.toThrow('owner is still alive');
  });

  it('after a veto, the vault can time out again later', async () => {
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
    const t = FIRST_DEADLINE + DAY;
    await checkIn(w, 'wallet', t + 10 * DAY, t);
    await expect(w.sim.call('finalizeRelease', { time: RELEASED_AT, as: nobody })).rejects.toThrow('not pending');
    await w.sim.call('triggerTimeout', { time: t + 10 * DAY, as: nobody });
    expect(L(w.sim).pendingUntil).toBe(BigInt(t + 10 * DAY + CHALLENGE));
  });

  it('releases after the challenge window, snapshots the estate and emits an event', async () => {
    await w.sim.call('deposit', { time: T0, as: nobody }, 1_000_001n);
    await expect(w.sim.call('finalizeRelease', { time: T0, as: nobody })).rejects.toThrow('not pending');
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
    await expect(w.sim.call('finalizeRelease', { time: RELEASED_AT - 1, as: nobody }))
      .rejects.toThrow('challenge window open');
    const r = await w.sim.call('finalizeRelease', { time: RELEASED_AT, as: nobody });
    const l = L(w.sim);
    expect(l.phase).toBe(Phase.released);
    expect(l.releasedAt).toBe(BigInt(RELEASED_AT));
    expect(l.estateSnapshot).toBe(1_000_001n);
    expect(r.events).toHaveLength(1);
    expect(containsAscii(eventBytes(r.events[0]), 'codicil:released:v1')).toBe(true);
    expect(vaultEventName(r.events[0])).toBe(VAULT_EVENTS.released);
  });

  it('rejects direct user calls to the integrator hook', async () => {
    await expect(w.sim.call('isReleasedForContract', { time: T0, as: nobody }))
      .rejects.toThrow('callable by contracts only');
  });
});

describe('grace period', () => {
  const GRACE = 3 * DAY;
  const OPENS = FIRST_DEADLINE + GRACE;
  let w: World;
  beforeEach(async () => {
    w = await deployVault({ config: { gracePeriod: BigInt(GRACE) } });
  });

  it('is off by default: the countdown can start at the deadline itself', async () => {
    expect(VAULT_OPTIONS_OFF.gracePeriod).toBe(0n);
    const v = await deployVault();
    expect(L(v.sim).gracePeriod).toBe(0n);
    expect(timeoutOpensAt(L(v.sim))).toBe(BigInt(FIRST_DEADLINE));
    await expect(v.sim.call('triggerTimeout', { time: FIRST_DEADLINE - 1, as: nobody }))
      .rejects.toThrow('owner is still alive');
    await v.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
    expect(L(v.sim).pendingUntil).toBe(BigInt(FIRST_DEADLINE + CHALLENGE));
    // ...and with no grace, an armed vault past its deadline cannot be checked in.
    const u = await deployVault();
    await expect(checkIn(u, 'passkey', FIRST_DEADLINE + DAY, FIRST_DEADLINE)).rejects.toThrow('switch already expired');
  });

  it('nobody can start the countdown by timeout until the grace period is over', async () => {
    expect(timeoutOpensAt(L(w.sim))).toBe(BigInt(OPENS));
    await expect(w.sim.call('triggerTimeout', { time: FIRST_DEADLINE - 1, as: nobody }))
      .rejects.toThrow('owner is still alive');
    await expect(w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody }))
      .rejects.toThrow('grace period open');
    await expect(w.sim.call('triggerTimeout', { time: OPENS - 1, as: nobody }))
      .rejects.toThrow('grace period open');
    expect(L(w.sim).phase).toBe(Phase.armed);
    await w.sim.call('triggerTimeout', { time: OPENS, as: nobody });
    expect(L(w.sim).phase).toBe(Phase.pending);
  });

  it.each<Via>(['passkey', 'wallet'])('a late check-in by %s during the grace period just works', async (via) => {
    const late = FIRST_DEADLINE + DAY;
    await checkIn(w, via, late + 20 * DAY, late);
    expect(L(w.sim).phase).toBe(Phase.armed);        // the vault never went pending
    expect(L(w.sim).deadline).toBe(BigInt(late + 20 * DAY));
    await expect(w.sim.call('triggerTimeout', { time: OPENS, as: nobody })).rejects.toThrow('owner is still alive');
  });

  it('after the grace period an armed vault cannot be checked in, exactly as after a deadline without grace', async () => {
    await checkIn(w, 'passkey', OPENS + DAY, OPENS - 1);                       // last second of grace
    const v = await deployVault({ config: { gracePeriod: BigInt(GRACE) } });
    await expect(checkIn(v, 'passkey', OPENS + DAY, OPENS)).rejects.toThrow('switch already expired');
    await expect(checkIn(v, 'wallet', OPENS + DAY, OPENS)).rejects.toThrow('switch already expired');
  });

  it('the challenge window starts when the grace period ends, so the owner keeps the full window to veto', async () => {
    await w.sim.call('triggerTimeout', { time: OPENS + 5 * DAY, as: nobody });   // triggered late
    expect(L(w.sim).pendingUntil).toBe(BigInt(OPENS + CHALLENGE));
    await expect(w.sim.call('finalizeRelease', { time: OPENS + CHALLENGE - 1, as: nobody }))
      .rejects.toThrow('challenge window open');
    const t = OPENS + CHALLENGE - 1;
    await checkIn(w, 'wallet', t + DAY, t);
    expect(L(w.sim).phase).toBe(Phase.armed);
  });

  it('a grace period longer than the challenge window still leaves the whole window', async () => {
    const v = await deployVault({ config: { gracePeriod: BigInt(MAX_PERIOD), challengeWindow: BigInt(DAY) } });
    const opens = FIRST_DEADLINE + MAX_PERIOD;
    await v.sim.call('triggerTimeout', { time: opens, as: nobody });
    await expect(v.sim.call('finalizeRelease', { time: opens + DAY - 1, as: nobody })).rejects.toThrow('challenge window open');
    await v.sim.call('finalizeRelease', { time: opens + DAY, as: nobody });
    expect(L(v.sim).releasedAt).toBe(BigInt(opens + DAY));
  });

  it('the will stays locked from the deadline itself; a late check-in unlocks it', async () => {
    const late = FIRST_DEADLINE + DAY;
    await expect(updateWill(w, 'passkey', 123n, late)).rejects.toThrow('switch already expired');
    await checkIn(w, 'passkey', late + 20 * DAY, late);
    await updateWill(w, 'passkey', 123n, late);
    expect(L(w.sim).willRoot).toBe(123n);
  });

  it('does not delay guardians: they can start the countdown during the grace period', async () => {
    const t = FIRST_DEADLINE + DAY;
    await vote(w, 0, t);
    await vote(w, 1, t);
    expect(L(w.sim).phase).toBe(Phase.pending);
    expect(L(w.sim).pendingUntil).toBe(BigInt(t + CHALLENGE));
  });

  it('cannot be longer than the longest check-in period', async () => {
    await expect(deployVault({ config: { gracePeriod: BigInt(MAX_PERIOD + 1) } })).rejects.toThrow('grace period too long');
    const v = await deployVault({ config: { gracePeriod: BigInt(MAX_PERIOD) } });
    expect(L(v.sim).gracePeriod).toBe(BigInt(MAX_PERIOD));
  });
});

/** Transcript values are little-endian with trailing zero bytes trimmed. */
const minimalLE = (n: bigint, size: number): Uint8Array => {
  const b = numberToBytesLE(n, size);
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return b.subarray(0, end);
};

describe('what a check-in reveals on-chain', () => {
  it.each(['passkey', 'wallet'] as const)('%s: the new deadline, but no owner key, salt or digest', async (via) => {
    const w = await deployVault();
    const next = BigInt(T0 + 20 * DAY);
    const r = await checkIn(w, via, next, T0);
    const transcript = collectBytes(r.publicTranscript);
    expect(containsBytes(transcript, minimalLE(next, 8))).toBe(true);   // positive control

    const secret = via === 'passkey' ? w.owner.state.passkey! : w.owner.state.wallet!;
    expect(containsValue(transcript, secret.salt)).toBe(false);
    for (const coord of [secret.pk.x, secret.pk.y]) {
      expect(containsBytes(transcript, minimalLE(coord, 32))).toBe(false);
      expect(containsValue(transcript, numberToBytesLE(coord, 32))).toBe(false);
      expect(containsValue(transcript, numberToBytesBE(coord, 32))).toBe(false);
    }
    expect(containsValue(transcript, checkInDigest(w.sim.address, next, 0n))).toBe(false);
  });
});
