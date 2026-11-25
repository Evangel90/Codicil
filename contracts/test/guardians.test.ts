// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Hidden k-of-n guardians and the attestation trigger, each followed by the
// owner's challenge window. Brief §7.1 "Guardians", "Veto" and "Attestation".

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { Phase, pureCircuits } from '@codicil/contracts/vault';
import {
  buildGuardianSet,
  guardianLeaf,
  guardianSecrets,
  newGuardianSecret,
  newP256Key,
  vaultId,
} from '@codicil/sdk';
import { collectBytes, containsValue } from './support/harness.js';
import {
  asGuardian,
  attestation,
  CHALLENGE,
  checkIn,
  DAY,
  deployVault,
  FIRST_DEADLINE,
  L,
  nobody,
  T0,
  vote,
  type World,
} from './support/world.js';

const T = T0 + DAY;   // well before the owner's deadline

describe('guardians', () => {
  let w: World;
  beforeEach(async () => {
    w = await deployVault();
  });

  it('k−1 votes do nothing; the k-th vote starts the challenge window, even before the deadline', async () => {
    await vote(w, 0, T);
    expect(L(w.sim).phase).toBe(Phase.armed);
    expect(L(w.sim).guardianVotes).toBe(1n);
    await vote(w, 2, T + 60);
    expect(L(w.sim).phase).toBe(Phase.pending);
    expect(L(w.sim).pendingUntil).toBe(BigInt(T + 60 + CHALLENGE));
    await w.sim.call('finalizeRelease', { time: T + 60 + CHALLENGE, as: nobody });
    expect(L(w.sim).phase).toBe(Phase.released);
  });

  it('rejects a second vote from the same guardian', async () => {
    await vote(w, 1, T);
    await expect(vote(w, 1, T + 1)).rejects.toThrow('already voted');
    expect(L(w.sim).guardianVotes).toBe(1n);
  });

  it('rejects someone who is not a guardian', async () => {
    const stranger = newGuardianSecret();
    const ownSet = buildGuardianSet([guardianLeaf(stranger)], 1);
    await expect(w.sim.call('guardianAttest', { time: T, as: { guardian: guardianSecrets(ownSet, stranger) } }, BigInt(T)))
      .rejects.toThrow('not a guardian');
    // A real guardian's path with a guessed secret:
    const forged = { guardian: { ...guardianSecrets(w.guardianSet, w.guardians[0]), secret: randomBytes(32) } };
    await expect(w.sim.call('guardianAttest', { time: T, as: forged }, BigInt(T))).rejects.toThrow('not a guardian');
  });

  it('rejects timestamps in the future or more than 15 minutes old', async () => {
    await expect(vote(w, 0, T, T + 1)).rejects.toThrow('stale timestamp');
    await expect(vote(w, 0, T, T - 900)).rejects.toThrow('stale timestamp');
    await vote(w, 0, T, T - 899);
  });

  it('cannot vote once the countdown has started', async () => {
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
    await expect(vote(w, 0, FIRST_DEADLINE + 1)).rejects.toThrow('not armed');
  });

  it('is disabled when the vault has no guardians', async () => {
    const v = await deployVault({ config: { guardianThreshold: 0n } });
    await expect(vote(v, 0, T)).rejects.toThrow('no guardians');
  });

  it('owner veto: old votes stop counting and guardians can vote again in the new round', async () => {
    await vote(w, 0, T);
    await vote(w, 1, T);
    expect(L(w.sim).phase).toBe(Phase.pending);
    await checkIn(w, 'passkey', T + 20 * DAY, T + DAY);
    expect(L(w.sim).phase).toBe(Phase.armed);
    expect(L(w.sim).guardianRound).toBe(1n);
    expect(L(w.sim).guardianVotes).toBe(0n);
    await vote(w, 0, T + 2 * DAY);                 // same guardian, new round
    expect(L(w.sim).phase).toBe(Phase.armed);     // one vote is not enough any more
  });

  it('any check-in voids votes cast so far, not only during a countdown', async () => {
    await vote(w, 0, T);
    await checkIn(w, 'wallet', T + 20 * DAY, T + 60);
    await vote(w, 1, T + 120);
    expect(L(w.sim).phase).toBe(Phase.armed);
    expect(L(w.sim).guardianVotes).toBe(1n);
  });

  it('publishes an unlinkable nullifier, not which guardian voted', async () => {
    const r = await vote(w, 2, T);
    const t = collectBytes(r.publicTranscript);
    expect(containsValue(t, w.guardians[2])).toBe(false);
    expect(containsValue(t, guardianLeaf(w.guardians[2]))).toBe(false);
    const id = vaultId(w.sim.address);
    const n0 = pureCircuits.guardianNullifier(id, w.guardians[2], 0n);
    expect(L(w.sim).guardianNullifiers.member(n0)).toBe(true);
    // Different in the next round and in another vault:
    expect(pureCircuits.guardianNullifier(id, w.guardians[2], 1n)).not.toEqual(n0);
    const other = await deployVault();
    expect(pureCircuits.guardianNullifier(vaultId(other.sim.address), w.guardians[2], 0n)).not.toEqual(n0);
  });
});

describe('attestation trigger', () => {
  let w: World;
  beforeEach(async () => {
    w = await deployVault();
  });

  const trigger = (as = attestation(w), time = T, asOf = time) =>
    w.sim.call('triggerAttestation', { time, as }, BigInt(asOf));

  it('a valid attestation starts the challenge window', async () => {
    await trigger();
    expect(L(w.sim).phase).toBe(Phase.pending);
    expect(L(w.sim).pendingUntil).toBe(BigInt(T + CHALLENGE));
  });

  it('rejects a key other than the committed attestor', async () => {
    const impostor = newP256Key();
    const as = attestation(w, { signer: impostor });
    as.attestor!.pk = impostor.pk;
    await expect(trigger(as)).rejects.toThrow('unknown attestor');
  });

  it('rejects a forged signature from the right attestor key', async () => {
    await expect(trigger(attestation(w, { signer: newP256Key() }))).rejects.toThrow('bad attestation');
  });

  it('rejects an attestation signed before the owner last checked in', async () => {
    const early = attestation(w);                      // round 0
    await checkIn(w, 'passkey', T + 20 * DAY, T);      // round 1
    await expect(trigger(early, T + 60)).rejects.toThrow('bad attestation');
  });

  it('cannot be replayed after the owner vetoes it', async () => {
    const att = attestation(w);
    await trigger(att);
    await checkIn(w, 'passkey', T + 20 * DAY, T + DAY);
    expect(L(w.sim).phase).toBe(Phase.armed);
    await expect(trigger(att, T + 2 * DAY)).rejects.toThrow('bad attestation');
  });

  it('rejects stale timestamps (cannot backdate the challenge window)', async () => {
    await expect(trigger(attestation(w), T, T - 3 * DAY)).rejects.toThrow('stale timestamp');
  });

  it('is disabled when the vault has no attestor', async () => {
    const v = await deployVault({ config: { attestorKeyCommit: new Uint8Array(32) } });
    await expect(v.sim.call('triggerAttestation', { time: T, as: attestation(v) }, BigInt(T)))
      .rejects.toThrow('unknown attestor');
  });
});
