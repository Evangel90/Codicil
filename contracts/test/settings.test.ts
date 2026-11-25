// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Owner-signed settings updates: replacing the guardians, the threshold and
// the attestor after deployment, by passkey and by wallet. docs/DECISIONS.md D17.

import { beforeEach, describe, expect, it } from 'vitest';
import { numberToBytesBE, numberToBytesLE } from '@noble/curves/utils.js';
import { Phase, pureCircuits, type VaultSettings } from '@codicil/contracts/vault';
import {
  buildGuardianSet,
  checkInDigest,
  currentSettings,
  guardianLeaf,
  guardianSecrets,
  isCurrentGuardian,
  newGuardianSecret,
  newP256Key,
  newSalt,
  settingsDigest,
  willUpdateDigest,
  type GuardianSet,
} from '@codicil/sdk';
import { collectBytes, containsValue } from './support/harness.js';
import {
  approve,
  attestation,
  CHALLENGE,
  checkIn,
  DAY,
  deployVault,
  FIRST_DEADLINE,
  L,
  newOwner,
  nobody,
  release,
  T0,
  updateWill,
  vote,
  type SignOptions,
  type Via,
  type World,
} from './support/world.js';

const VIAS: Via[] = ['passkey', 'wallet'];
const T = T0 + DAY;
const ZERO32 = new Uint8Array(32);
const circuitFor = (via: Via) => (via === 'passkey' ? 'updateSettingsPasskey' : 'updateSettingsEd25519');
const rejected = (via: Via) => (via === 'passkey' ? 'passkey signed something else' : 'wallet signed something else');

/** Sign and send a settings update exactly as the app would. */
function updateSettings(w: World, via: Via, settings: VaultSettings, time: number, opts: SignOptions = {}) {
  const digest = settingsDigest(w.sim.address, settings, L(w.sim).nonce);
  return w.sim.call(circuitFor(via), { time, as: approve(w, via, digest, opts) }, settings);
}

/** A new guardian set of `n` fresh guardians. */
function freshGuardians(n: number, threshold: number): { secrets: Uint8Array[]; set: GuardianSet } {
  const secrets = Array.from({ length: n }, newGuardianSecret);
  return { secrets, set: buildGuardianSet(secrets.map(guardianLeaf), threshold) };
}

const voteWith = (w: World, set: GuardianSet, secret: Uint8Array, time: number) =>
  w.sim.call('guardianAttest', { time, as: { guardian: guardianSecrets(set, secret) } }, BigInt(time));

describe.each(VIAS)('settings update via %s', (via) => {
  let w: World;
  let before: VaultSettings;
  beforeEach(async () => {
    w = await deployVault();
    before = currentSettings(L(w.sim));
  });

  it('replaces the guardians and the threshold: the new set can vote, the old one cannot', async () => {
    const next = freshGuardians(4, 3);
    await updateSettings(w, via, { ...before, guardianRoot: next.set.root, guardianThreshold: next.set.threshold }, T);
    const l = L(w.sim);
    expect(l.guardianRoot).toBe(next.set.root);
    expect(l.guardianThreshold).toBe(3n);
    expect(l.attestorKeyCommit).toEqual(before.attestorKeyCommit);   // untouched
    expect(l.nonce).toBe(1n);

    const old = guardianSecrets(w.guardianSet, w.guardians[0]);
    expect(isCurrentGuardian(old, l.guardianRoot)).toBe(false);
    await expect(vote(w, 0, T + 60)).rejects.toThrow('not a guardian');

    expect(isCurrentGuardian(guardianSecrets(next.set, next.secrets[0]), l.guardianRoot)).toBe(true);
    await voteWith(w, next.set, next.secrets[0], T + 60);
    await voteWith(w, next.set, next.secrets[1], T + 60);
    expect(L(w.sim).phase).toBe(Phase.armed);                         // the new threshold is 3
    await voteWith(w, next.set, next.secrets[3], T + 60);
    expect(L(w.sim).phase).toBe(Phase.pending);
  });

  it('voids a vote round in progress, so old votes never count towards a new threshold', async () => {
    await vote(w, 0, T);                                              // 1 of 2
    expect(L(w.sim).guardianVotes).toBe(1n);
    // Same guardians, threshold lowered to 1: the vote already cast must not trigger anything.
    await updateSettings(w, via, { ...before, guardianThreshold: 1n }, T + 60);
    expect(L(w.sim).guardianVotes).toBe(0n);
    expect(L(w.sim).guardianRound).toBe(1n);
    expect(L(w.sim).phase).toBe(Phase.armed);
    // The guardian who voted can vote again in the new round, and now one vote is enough.
    await vote(w, 0, T + 120);
    expect(L(w.sim).phase).toBe(Phase.pending);
    expect(L(w.sim).pendingUntil).toBe(BigInt(T + 120 + CHALLENGE));
  });

  it('replaces the attestor: the old one is refused, the new one can start the countdown', async () => {
    const next = { key: newP256Key(), salt: newSalt() };
    const commit = pureCircuits.attestorCommitment(next.key.pk, next.salt);
    await updateSettings(w, via, { ...before, attestorKeyCommit: commit }, T);
    expect(L(w.sim).attestorKeyCommit).toEqual(commit);
    expect(L(w.sim).guardianRoot).toBe(before.guardianRoot);          // untouched

    await expect(w.sim.call('triggerAttestation', { time: T + 60, as: attestation(w) }, BigInt(T + 60)))
      .rejects.toThrow('unknown attestor');
    const v: World = { ...w, attestor: next };
    await w.sim.call('triggerAttestation', { time: T + 60, as: attestation(v) }, BigInt(T + 60));
    expect(L(w.sim).phase).toBe(Phase.pending);
  });

  it('voids attestations signed before the update, even from an attestor who was kept', async () => {
    const early = attestation(w);                                     // signed for round 0
    await updateSettings(w, via, { ...before, guardianThreshold: 3n }, T);
    await expect(w.sim.call('triggerAttestation', { time: T + 60, as: early }, BigInt(T + 60)))
      .rejects.toThrow('bad attestation');
    await w.sim.call('triggerAttestation', { time: T + 60, as: attestation(w) }, BigInt(T + 60));   // re-signed
  });

  it('can switch guardians and the attestor off', async () => {
    await updateSettings(w, via, { guardianRoot: 0n, guardianThreshold: 0n, attestorKeyCommit: ZERO32 }, T);
    await expect(vote(w, 0, T + 60)).rejects.toThrow('no guardians');
    await expect(w.sim.call('triggerAttestation', { time: T + 60, as: attestation(w) }, BigInt(T + 60)))
      .rejects.toThrow('unknown attestor');
    // The timeout still works: the vault is a plain dead man's switch again.
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
  });

  it('changes nothing else: will, deadline, estate and owner keys stay as they were', async () => {
    await w.sim.call('deposit', { time: T0, as: nobody }, 500n);
    const l0 = L(w.sim);
    const r = await updateSettings(w, via, { ...before, guardianThreshold: 3n }, T);
    const l1 = L(w.sim);
    expect(r.events).toEqual([]);
    expect(l1.willRoot).toBe(l0.willRoot);
    expect(l1.willVersion).toBe(0n);
    expect(l1.deadline).toBe(l0.deadline);
    expect(l1.estateTotal).toBe(500n);
    expect(l1.ownerPasskeyCommit).toEqual(l0.ownerPasskeyCommit);
    expect(l1.ownerEdCommit).toEqual(l0.ownerEdCommit);
    expect(l1.phase).toBe(Phase.armed);
    // The owner can carry on as usual afterwards.
    await checkIn(w, via, T + 20 * DAY, T);
    await updateWill(w, via, 123n, T);
    expect(L(w.sim).nonce).toBe(3n);
  });

  it('rejects a replayed approval (old nonce)', async () => {
    const settings = { ...before, guardianThreshold: 3n };
    const used = settingsDigest(w.sim.address, settings, 0n);
    await updateSettings(w, via, settings, T);
    // The owner later goes back to k = 2; the first approval must not restore k = 3.
    await updateSettings(w, via, { ...before, guardianThreshold: 2n }, T);
    await expect(updateSettings(w, via, settings, T, { digest: used })).rejects.toThrow(rejected(via));
    expect(L(w.sim).guardianThreshold).toBe(2n);
    expect(L(w.sim).nonce).toBe(2n);
  });

  it('rejects an approval bound to another vault', async () => {
    const elsewhere = await deployVault({ owner: w.owner });
    const settings = { ...before, guardianThreshold: 1n };
    const foreign = settingsDigest(elsewhere.sim.address, settings, 0n);
    await expect(updateSettings(w, via, settings, T, { digest: foreign })).rejects.toThrow(rejected(via));
  });

  it('rejects settings that differ from what was signed, in any field', async () => {
    const signed = { ...before, guardianThreshold: 2n };
    const digest = settingsDigest(w.sim.address, signed, 0n);
    const tampered: VaultSettings[] = [
      { ...signed, guardianThreshold: 1n },
      { ...signed, guardianRoot: freshGuardians(1, 1).set.root },
      { ...signed, attestorKeyCommit: pureCircuits.attestorCommitment(newP256Key().pk, newSalt()) },
      { ...signed, attestorKeyCommit: ZERO32 },
    ];
    for (const settings of tampered) {
      await expect(updateSettings(w, via, settings, T, { digest })).rejects.toThrow(rejected(via));
    }
    expect(currentSettings(L(w.sim))).toEqual(before);
    await updateSettings(w, via, signed, T, { digest });               // exactly what was signed is fine
  });

  it('cannot use a check-in or will approval to change settings, nor the reverse', async () => {
    const settings = { ...before, guardianThreshold: 1n };
    const next = BigInt(T + 20 * DAY);
    for (const digest of [checkInDigest(w.sim.address, next, 0n), willUpdateDigest(w.sim.address, 123n, 0n)]) {
      await expect(updateSettings(w, via, settings, T, { digest })).rejects.toThrow(rejected(via));
    }
    const settingsApproval = settingsDigest(w.sim.address, settings, 0n);
    await expect(checkIn(w, via, next, T, { digest: settingsApproval })).rejects.toThrow(rejected(via));
    await expect(updateWill(w, via, 123n, T, { digest: settingsApproval })).rejects.toThrow(rejected(via));
    expect(L(w.sim).nonce).toBe(0n);
  });

  it('rejects an update from someone else, and a forged signature from the right key', async () => {
    const settings = { ...before, guardianThreshold: 1n };
    await expect(updateSettings(w, via, settings, T, { signer: newOwner() })).rejects.toThrow('unknown owner key');
    const state = approve(w, via, settingsDigest(w.sim.address, settings, 0n));
    if (via === 'passkey') state.passkey!.approval!.proof.sig.s ^= 1n;
    else state.wallet!.approval!.proof.sig.s ^= 1n;
    await expect(w.sim.call(circuitFor(via), { time: T, as: state }, settings)).rejects.toThrow('bad owner signature');
    expect(currentSettings(L(w.sim))).toEqual(before);
  });

  it('is locked once a countdown starts, after the deadline, and after release', async () => {
    const settings = { ...before, guardianThreshold: 1n };
    await expect(updateSettings(w, via, settings, FIRST_DEADLINE)).rejects.toThrow('switch already expired');

    // Guardians report the owner: the owner must veto first, then may replace them.
    await vote(w, 0, T);
    await vote(w, 1, T);
    await expect(updateSettings(w, via, settings, T + 60)).rejects.toThrow('settings locked');
    await checkIn(w, via, T + 20 * DAY, T + 60);
    await updateSettings(w, via, settings, T + 60);
    expect(L(w.sim).guardianThreshold).toBe(1n);

    const v = await deployVault();
    await release(v);
    await expect(updateSettings(v, via, settings, FIRST_DEADLINE + 8 * DAY)).rejects.toThrow('settings locked');
  });

  it('publishes the new root, threshold and attestor commitment, but no owner key, salt or digest', async () => {
    const next = freshGuardians(2, 2);
    const attestor = { key: newP256Key(), salt: newSalt() };
    const settings: VaultSettings = {
      guardianRoot: next.set.root,
      guardianThreshold: 2n,
      attestorKeyCommit: pureCircuits.attestorCommitment(attestor.key.pk, attestor.salt),
    };
    const r = await updateSettings(w, via, settings, T);
    const transcript = collectBytes(r.publicTranscript);
    expect(containsValue(transcript, settings.attestorKeyCommit)).toBe(true);   // positive control

    const secret = via === 'passkey' ? w.owner.state.passkey! : w.owner.state.wallet!;
    expect(containsValue(transcript, secret.salt)).toBe(false);
    for (const coord of [secret.pk.x, secret.pk.y]) {
      expect(containsValue(transcript, numberToBytesLE(coord, 32))).toBe(false);
      expect(containsValue(transcript, numberToBytesBE(coord, 32))).toBe(false);
    }
    expect(containsValue(transcript, settingsDigest(w.sim.address, settings, 0n))).toBe(false);
    // Nothing about who the new guardians or the new attestor are.
    for (const s of next.secrets) {
      expect(containsValue(transcript, s)).toBe(false);
      expect(containsValue(transcript, guardianLeaf(s))).toBe(false);
    }
    expect(containsValue(transcript, attestor.salt)).toBe(false);
    expect(containsValue(transcript, numberToBytesLE(attestor.key.pk.x, 32))).toBe(false);
    expect(containsValue(transcript, numberToBytesBE(attestor.key.pk.x, 32))).toBe(false);
  });
});

describe('settings updates and owner keys', () => {
  it('a vault with only a passkey cannot be changed by wallet, and the reverse', async () => {
    const p = await deployVault({ config: { ownerEdCommit: new Uint8Array(32) } });
    const settings = { ...currentSettings(L(p.sim)), guardianThreshold: 1n };
    await expect(updateSettings(p, 'wallet', settings, T)).rejects.toThrow('unknown owner key');
    await updateSettings(p, 'passkey', settings, T);

    const q = await deployVault({ config: { ownerPasskeyCommit: new Uint8Array(32) } });
    await expect(updateSettings(q, 'passkey', settings, T)).rejects.toThrow('unknown owner key');
    await updateSettings(q, 'wallet', { ...currentSettings(L(q.sim)), guardianThreshold: 1n }, T);
  });

  it('a vault deployed without guardians can add them later', async () => {
    const w = await deployVault({ config: { guardianRoot: 0n, guardianThreshold: 0n } });
    await expect(vote(w, 0, T)).rejects.toThrow('no guardians');
    await updateSettings(w, 'passkey', {
      ...currentSettings(L(w.sim)),
      guardianRoot: w.guardianSet.root,
      guardianThreshold: w.guardianSet.threshold,
    }, T);
    await vote(w, 0, T + 60);
    await vote(w, 1, T + 60);
    expect(L(w.sim).phase).toBe(Phase.pending);
  });
});
