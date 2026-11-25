// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The recovery key: new owner keys after a public delay, cancelled by anything
// a current owner key signs. docs/DECISIONS.md D18.

import { beforeEach, describe, expect, it } from 'vitest';
import { Phase, pureCircuits } from '@codicil/contracts/vault';
import {
  lastRecoveryStart,
  MIN_RECOVERY_DELAY,
  MissingSecretError,
  newRecoverySecret,
  recoveryCommitment,
  recoveryConfig,
  recoveryStatus,
  VAULT_EVENTS,
  VAULT_OPTIONS_OFF,
  vaultEventName,
  type RecoveryProposal,
} from '@codicil/sdk';
import { collectBytes, containsValue, eventBytes } from './support/harness.js';
import {
  asClaimant,
  checkIn,
  DAY,
  deployVault,
  FIRST_DEADLINE,
  L,
  MAX_PERIOD,
  newOwner,
  newRecipient,
  nobody,
  release,
  T0,
  updateWill,
  vote,
  type DeployOptions,
  type Owner,
  type Via,
  type World,
} from './support/world.js';

const DELAY = 3 * DAY;
const T = T0 + DAY;            // when the recovery starts in most tests
const READY = T + DELAY;       // well before the first deadline (T0 + 10 days)
const ZERO32 = new Uint8Array(32);

interface Recoverable { w: World; secret: Uint8Array }

async function deployRecoverable(opts: DeployOptions = {}): Promise<Recoverable> {
  const secret = newRecoverySecret();
  const w = await deployVault({ ...opts, config: { ...recoveryConfig(secret, BigInt(DELAY)), ...opts.config } });
  return { w, secret };
}

/** The commitments that make `owner` the owner. */
function proposalFor(owner: Owner, nextSecret?: Uint8Array): RecoveryProposal {
  return {
    passkeyCommit: pureCircuits.passkeyCommitment(owner.passkey.pk, owner.state.passkey!.salt),
    edCommit: pureCircuits.edKeyCommitment(owner.wallet.pk, owner.state.wallet!.salt),
    nextRecoveryKeyCommit: nextSecret ? recoveryCommitment(nextSecret) : ZERO32,
  };
}

function start(w: World, secret: Uint8Array, p: RecoveryProposal, time = T, asOf = time) {
  return w.sim.call('startRecovery', { time, as: { recovery: { secret } } },
    p.passkeyCommit, p.edCommit, p.nextRecoveryKeyCommit, BigInt(asOf));
}

const finish = (w: World, time: number) => w.sim.call('finishRecovery', { time, as: nobody });
const as = (w: World, owner: Owner): World => ({ ...w, owner });
const status = (w: World, time: number) => recoveryStatus(L(w.sim), BigInt(time));

describe('recovery key', () => {
  let w: World;
  let secret: Uint8Array;
  let fresh: Owner;   // the keys the owner is recovering to (new devices)
  beforeEach(async () => {
    ({ w, secret } = await deployRecoverable());
    fresh = newOwner();
  });

  it('is off by default: nothing to start, nothing to finish, check-ins as before', async () => {
    expect(VAULT_OPTIONS_OFF.recoveryKeyCommit).toEqual(ZERO32);
    const v = await deployVault();
    expect(L(v.sim).recoveryKeyCommit).toEqual(ZERO32);
    expect(status(v, T)).toEqual({ state: 'off' });
    // No secret opens a vault without a recovery key, not even an all-zero one.
    await expect(start(v, newRecoverySecret(), proposalFor(fresh))).rejects.toThrow('unknown recovery key');
    await expect(start(v, ZERO32, proposalFor(fresh))).rejects.toThrow('unknown recovery key');
    await expect(finish(v, T)).rejects.toThrow('no recovery pending');
    await checkIn(v, 'passkey', T + 20 * DAY, T);
    expect(L(v.sim).recoveryKeyCommit).toEqual(ZERO32);
    expect(L(v.sim).recoveryReadyAt).toBe(0n);
    expect(status(v, T)).toEqual({ state: 'off' });
  });

  it.each<Via>(['passkey', 'wallet'])('after the public delay the new %s owns the vault and the old keys do not', async (via) => {
    const nextSecret = newRecoverySecret();
    const proposal = proposalFor(fresh, nextSecret);
    expect(status(w, T)).toEqual({ state: 'idle' });

    const r = await start(w, secret, proposal);
    expect(r.events.map(vaultEventName)).toEqual([VAULT_EVENTS.recoveryStarted]);
    expect(eventBytes(r.events[0])).toEqual(new TextEncoder().encode(VAULT_EVENTS.recoveryStarted));   // a name, no payload
    const pending = L(w.sim);
    expect(pending.recoveryReadyAt).toBe(BigInt(READY));
    expect(pending.recoveryPasskeyCommit).toEqual(proposal.passkeyCommit);
    expect(pending.recoveryEdCommit).toEqual(proposal.edCommit);
    expect(status(w, READY - 1)).toEqual({ state: 'waiting', readyAt: BigInt(READY) });
    expect(status(w, READY)).toEqual({ state: 'ready', readyAt: BigInt(READY) });
    // Nothing has changed hands yet: the new keys are refused until the delay is over.
    await expect(checkIn(as(w, fresh), via, READY + DAY, T + 60)).rejects.toThrow('unknown owner key');
    await expect(finish(w, READY - 1)).rejects.toThrow('recovery delay open');

    await finish(w, READY);                                       // anyone may send this
    const l = L(w.sim);
    expect(l.ownerPasskeyCommit).toEqual(proposal.passkeyCommit);
    expect(l.ownerEdCommit).toEqual(proposal.edCommit);
    expect(l.recoveryKeyCommit).toEqual(recoveryCommitment(nextSecret));
    expect(l.recoveryReadyAt).toBe(0n);
    expect(l.recoveryPasskeyCommit).toEqual(ZERO32);
    expect(l.recoveryEdCommit).toEqual(ZERO32);
    expect(l.recoveryNextKeyCommit).toEqual(ZERO32);
    expect(l.phase).toBe(Phase.armed);
    expect(l.deadline).toBe(BigInt(FIRST_DEADLINE));              // recovery does not move the deadline
    expect(status(w, READY)).toEqual({ state: 'idle' });          // the next recovery key is ready to use
    await expect(finish(w, READY)).rejects.toThrow('no recovery pending');

    await expect(checkIn(w, via, READY + 20 * DAY, READY)).rejects.toThrow('unknown owner key');
    await checkIn(as(w, fresh), via, READY + 20 * DAY, READY);
    expect(L(w.sim).deadline).toBe(BigInt(READY + 20 * DAY));
    await updateWill(as(w, fresh), via, 123n, READY);
    expect(L(w.sim).willRoot).toBe(123n);
  });

  it('replaces the used secret: only the next recovery key works afterwards', async () => {
    const nextSecret = newRecoverySecret();
    await start(w, secret, proposalFor(fresh, nextSecret));
    await finish(w, READY);
    await checkIn(as(w, fresh), 'passkey', READY + 25 * DAY, READY);   // the new owner carries on

    const again = newOwner();
    await expect(start(w, secret, proposalFor(again), READY + DAY)).rejects.toThrow('unknown recovery key');
    await start(w, nextSecret, proposalFor(again), READY + DAY);
    await finish(w, READY + DAY + DELAY);
    await checkIn(as(w, again), 'wallet', READY + 26 * DAY, READY + DAY + DELAY);
    // No next key was named this time, so the vault has no recovery key any more.
    expect(L(w.sim).recoveryKeyCommit).toEqual(ZERO32);
    expect(status(w, 0)).toEqual({ state: 'off' });
  });

  it('rejects a secret that is not the recovery key, including one from another vault', async () => {
    await expect(start(w, newRecoverySecret(), proposalFor(fresh))).rejects.toThrow('unknown recovery key');
    const other = await deployRecoverable();
    await expect(start(w, other.secret, proposalFor(fresh))).rejects.toThrow('unknown recovery key');
    await expect(start(other.w, secret, proposalFor(fresh))).rejects.toThrow('unknown recovery key');
    expect(L(w.sim).recoveryReadyAt).toBe(0n);
  });

  it.each<Via>(['passkey', 'wallet'])('a check-in by %s cancels a recovery and retires the recovery key', async (via) => {
    await start(w, secret, proposalFor(fresh));
    await checkIn(w, via, T + 20 * DAY, T + DAY);                 // the real owner still has a key
    expect(status(w, READY)).toEqual({ state: 'retired' });
    await expect(finish(w, READY)).rejects.toThrow('recovery cancelled');
    // A stolen recovery key gets one attempt: the same secret cannot start again, ever.
    await expect(start(w, secret, proposalFor(fresh), T + 2 * DAY)).rejects.toThrow('recovery key retired');
    await checkIn(w, via, T + 21 * DAY, T + 2 * DAY);
    await expect(start(w, secret, proposalFor(fresh), T + 3 * DAY)).rejects.toThrow('recovery key retired');
    await expect(finish(w, T + 9 * DAY)).rejects.toThrow('recovery cancelled');
    // The owner is still the owner; the proposed keys never were.
    await expect(checkIn(as(w, fresh), via, T + 22 * DAY, T + 2 * DAY)).rejects.toThrow('unknown owner key');
    expect(L(w.sim).ownerPasskeyCommit).toEqual(pureCircuits.passkeyCommitment(w.owner.passkey.pk, w.owner.state.passkey!.salt));
  });

  it.each<Via>(['passkey', 'wallet'])('a will update by %s cancels it too', async (via) => {
    await start(w, secret, proposalFor(fresh));
    await updateWill(w, via, 123n, T + DAY);
    expect(status(w, READY)).toEqual({ state: 'retired' });
    await expect(finish(w, READY)).rejects.toThrow('recovery cancelled');
    await expect(start(w, secret, proposalFor(fresh), T + 2 * DAY)).rejects.toThrow('recovery key retired');
  });

  it('owner actions before a recovery do not retire the key, and a rejected one cancels nothing', async () => {
    await checkIn(w, 'passkey', T + 20 * DAY, T);
    await updateWill(w, 'wallet', 123n, T);
    expect(status(w, T)).toEqual({ state: 'idle' });
    await start(w, secret, proposalFor(fresh), T + 60);
    // Someone without an owner key cannot cancel it.
    await expect(checkIn(w, 'passkey', T + 20 * DAY, T + 120, { signer: newOwner() })).rejects.toThrow('unknown owner key');
    await expect(updateWill(w, 'wallet', 5n, T + 120, { signer: newOwner() })).rejects.toThrow('unknown owner key');
    expect(status(w, T + 120)).toEqual({ state: 'waiting', readyAt: BigInt(T + 60 + DELAY) });
    await finish(w, T + 60 + DELAY);
    await checkIn(as(w, fresh), 'passkey', T + 20 * DAY, T + 60 + DELAY);
  });

  it('starting again replaces the proposal and restarts the delay; it can never bring the date forward', async () => {
    const thief = newOwner();
    await start(w, secret, proposalFor(thief));                    // ready at T + DELAY
    // Same or earlier timestamp (a copy of the first transaction, or a backdated one): refused.
    await expect(start(w, secret, proposalFor(thief), T + 60, T)).rejects.toThrow('stale timestamp');
    await expect(start(w, secret, proposalFor(fresh), T + 60, T - 100)).rejects.toThrow('stale timestamp');

    // The owner, who also holds the secret, starts again with their own keys.
    await start(w, secret, proposalFor(fresh), T + DAY);
    expect(L(w.sim).recoveryReadyAt).toBe(BigInt(T + DAY + DELAY));
    await expect(finish(w, READY)).rejects.toThrow('recovery delay open');   // the thief's date no longer counts
    await finish(w, T + DAY + DELAY);
    await checkIn(as(w, fresh), 'passkey', T + 25 * DAY, T + DAY + DELAY);
    await expect(checkIn(as(w, thief), 'passkey', T + 25 * DAY, T + DAY + DELAY)).rejects.toThrow('unknown owner key');
  });

  it('needs a fresh timestamp, so the delay cannot be backdated', async () => {
    await expect(start(w, secret, proposalFor(fresh), T, T + 1)).rejects.toThrow('stale timestamp');
    await expect(start(w, secret, proposalFor(fresh), T, T - 900)).rejects.toThrow('stale timestamp');
    await expect(start(w, secret, proposalFor(fresh), T, T - DELAY)).rejects.toThrow('stale timestamp');
    await start(w, secret, proposalFor(fresh), T, T - 899);
    expect(L(w.sim).recoveryReadyAt).toBe(BigInt(T - 899 + DELAY));
  });

  it('must be able to finish before the deadline, or it is refused up front', async () => {
    const last = Number(lastRecoveryStart(L(w.sim)));
    expect(last).toBe(FIRST_DEADLINE - DELAY - 1);
    await expect(start(w, secret, proposalFor(fresh), last + 1)).rejects.toThrow('too late to recover');
    await expect(start(w, secret, proposalFor(fresh), FIRST_DEADLINE - 1)).rejects.toThrow('too late to recover');
    expect(L(w.sim).recoveryReadyAt).toBe(0n);
    await start(w, secret, proposalFor(fresh), last);
    await finish(w, FIRST_DEADLINE - 1);
    await checkIn(as(w, fresh), 'passkey', FIRST_DEADLINE + 20 * DAY, FIRST_DEADLINE - 1);
  });

  it('cannot act once the deadline has passed or a countdown has started', async () => {
    await expect(start(w, secret, proposalFor(fresh), FIRST_DEADLINE)).rejects.toThrow('switch already expired');
    await start(w, secret, proposalFor(fresh));
    // Ready, but nobody finished it before the deadline: it is too late.
    await expect(finish(w, FIRST_DEADLINE)).rejects.toThrow('switch already expired');
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
    await expect(finish(w, FIRST_DEADLINE + 1)).rejects.toThrow('not armed');
    await expect(start(w, secret, proposalFor(fresh), FIRST_DEADLINE + 1)).rejects.toThrow('not armed');
  });

  it('never delays the switch: a vault with a recovery in progress times out and releases as usual', async () => {
    await w.sim.call('deposit', { time: T0, as: nobody }, 1000n);
    await start(w, secret, proposalFor(fresh));
    await release(w);                                             // timeout at the deadline, release after the window
    expect(L(w.sim).phase).toBe(Phase.released);
    await expect(finish(w, FIRST_DEADLINE + 8 * DAY)).rejects.toThrow('not armed');
    const to = newRecipient();
    await w.sim.call('claim', { time: FIRST_DEADLINE + 8 * DAY, as: asClaimant(w.will, 0, w.heirs[0]) }, to.address);
    expect(L(w.sim).estatePaid).toBe(500n);
  });

  it('guardians can stop a recovery by starting the countdown; a recovery key cannot veto one', async () => {
    await start(w, secret, proposalFor(fresh));
    await vote(w, 0, T + DAY);
    await vote(w, 1, T + DAY);
    expect(L(w.sim).phase).toBe(Phase.pending);
    await expect(finish(w, READY)).rejects.toThrow('not armed');
    // Only a current owner key can veto, and that also ends the recovery.
    await checkIn(w, 'passkey', READY + 20 * DAY, READY);
    expect(L(w.sim).phase).toBe(Phase.armed);
    await expect(finish(w, READY)).rejects.toThrow('recovery cancelled');
  });

  it('can recover to a single key, and refuses to leave the vault with none', async () => {
    await expect(start(w, secret, { ...proposalFor(fresh), passkeyCommit: ZERO32, edCommit: ZERO32 }))
      .rejects.toThrow('vault needs an owner key');
    await start(w, secret, { ...proposalFor(fresh), edCommit: ZERO32 });     // a new passkey only
    await finish(w, READY);
    await expect(checkIn(as(w, fresh), 'wallet', READY + 20 * DAY, READY)).rejects.toThrow('unknown owner key');
    await checkIn(as(w, fresh), 'passkey', READY + 20 * DAY, READY);
  });

  it('changes nothing but the owner keys: will, estate, timers and guardians stay', async () => {
    await w.sim.call('deposit', { time: T0, as: nobody }, 777n);
    await vote(w, 0, T);
    const l0 = L(w.sim);
    await start(w, secret, proposalFor(fresh));
    await finish(w, READY);
    const l1 = L(w.sim);
    expect(l1.willRoot).toBe(l0.willRoot);
    expect(l1.willVersion).toBe(l0.willVersion);
    expect(l1.estateTotal).toBe(777n);
    expect(l1.deadline).toBe(l0.deadline);
    expect(l1.nonce).toBe(l0.nonce);
    expect(l1.guardianRoot).toBe(l0.guardianRoot);
    expect(l1.guardianVotes).toBe(1n);
    expect(l1.passkeyRpIdHash).toEqual(l0.passkeyRpIdHash);
  });

  it('publishes the proposed commitments and the date, never the recovery secret', async () => {
    const nextSecret = newRecoverySecret();
    const proposal = proposalFor(fresh, nextSecret);
    const r = await start(w, secret, proposal);
    const transcript = collectBytes(r.publicTranscript);
    expect(containsValue(transcript, proposal.passkeyCommit)).toBe(true);    // positive controls
    expect(containsValue(transcript, proposal.nextRecoveryKeyCommit)).toBe(true);
    expect(containsValue(transcript, secret)).toBe(false);
    expect(containsValue(transcript, nextSecret)).toBe(false);
    // The new keys stay behind their salted commitments.
    expect(containsValue(transcript, fresh.state.passkey!.salt)).toBe(false);
    expect(containsValue(transcript, fresh.state.wallet!.salt)).toBe(false);

    const done = await finish(w, READY);
    const finishTranscript = collectBytes(done.publicTranscript);
    expect(containsValue(finishTranscript, proposal.edCommit)).toBe(true);   // positive control
    expect(containsValue(finishTranscript, secret)).toBe(false);
    expect(done.events).toEqual([]);
  });

  it('known leak, stated: one secret used for two vaults shows the same commitment on both', async () => {
    const reused = await deployVault({ config: recoveryConfig(secret, BigInt(DELAY)) });
    expect(L(reused.sim).recoveryKeyCommit).toEqual(L(w.sim).recoveryKeyCommit);
    // The SDK makes a new secret every time, which does not link.
    expect(recoveryCommitment(newRecoverySecret())).not.toEqual(recoveryCommitment(newRecoverySecret()));
  });
});

describe('recovery settings', () => {
  it('refuses a delay under one day, or one no recovery could finish within a check-in period', async () => {
    const commit = recoveryCommitment(newRecoverySecret());
    await expect(deployVault({ config: { recoveryKeyCommit: commit, recoveryDelay: MIN_RECOVERY_DELAY - 1n } }))
      .rejects.toThrow('recovery delay too short');
    await expect(deployVault({ config: { recoveryKeyCommit: commit, recoveryDelay: 0n } }))
      .rejects.toThrow('recovery delay too short');
    await expect(deployVault({ config: { recoveryKeyCommit: commit, recoveryDelay: BigInt(MAX_PERIOD) } }))
      .rejects.toThrow('recovery delay too long');
    await deployVault({ config: { recoveryKeyCommit: commit, recoveryDelay: MIN_RECOVERY_DELAY } });
    await deployVault({ config: { recoveryKeyCommit: commit, recoveryDelay: BigInt(MAX_PERIOD - 1) } });
    // The SDK refuses the same settings before any deployment.
    expect(() => recoveryConfig(newRecoverySecret(), MIN_RECOVERY_DELAY - 1n)).toThrow('at least one day');
    expect(() => recoveryConfig(newRecoverySecret(), BigInt(MAX_PERIOD), BigInt(MAX_PERIOD))).toThrow('shorter than');
  });

  it('with no recovery key the delay is ignored', async () => {
    const w = await deployVault({ config: { recoveryKeyCommit: new Uint8Array(32), recoveryDelay: 5n } });
    await expect(start(w, newRecoverySecret(), proposalFor(newOwner()))).rejects.toThrow('unknown recovery key');
  });

  it('the app witnesses say plainly when this device has no recovery key', async () => {
    const { w } = await deployRecoverable({ strictWitnesses: true });
    const p = proposalFor(newOwner());
    await expect(w.sim.call('startRecovery', { time: T, as: nobody }, p.passkeyCommit, p.edCommit, p.nextRecoveryKeyCommit, BigInt(T)))
      .rejects.toThrow(MissingSecretError);
  });
});
