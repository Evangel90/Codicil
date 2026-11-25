// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Deposits, timeout, release, events and what the public ledger reveals.
// Brief §7.1 "Release" and the public/private table in docs/PRIVACY.md.

import { beforeEach, describe, expect, it } from 'vitest';
import { numberToBytesBE, numberToBytesLE } from '@noble/curves/utils.js';
import { Phase, pureCircuits } from '@codicil/contracts/vault';
import { checkInDigest, VAULT_EVENTS, vaultEventName } from '@codicil/sdk';
import { collectBytes, containsAscii, containsBytes, eventBytes, unshieldedReceived } from './support/harness.js';
import {
  CHALLENGE,
  checkIn,
  DAY,
  deployVault,
  FIRST_DEADLINE,
  L,
  nobody,
  RELEASED_AT,
  T0,
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
    expect(containsBytes(transcript, secret.salt)).toBe(false);
    for (const coord of [secret.pk.x, secret.pk.y]) {
      expect(containsBytes(transcript, minimalLE(coord, 32))).toBe(false);
      expect(containsBytes(transcript, numberToBytesLE(coord, 32))).toBe(false);
      expect(containsBytes(transcript, numberToBytesBE(coord, 32))).toBe(false);
    }
    expect(containsBytes(transcript, checkInDigest(w.sim.address, next, 0n))).toBe(false);
  });
});
