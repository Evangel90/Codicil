// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The demo world: one owner, a three-heir will with a backup heir and a
// tranche, three hidden guardians (any two can report), and a demo clock.
// Every action runs the real vault circuit on the in-browser DemoChain.

import { useSyncExternalStore } from 'react';
import { encodeRawTokenType, encodeUserAddress, sampleRawTokenType, sampleUserAddress } from '@midnight-ntwrk/compact-runtime';
import { Phase, pureCircuits, type HeirLeaf } from '@codicil/contracts/vault';
import {
  buildGuardianSet,
  buildWill,
  checkInDigest,
  claimPackage,
  contractErrorCode,
  decodeHeirLetter,
  encodeHeirLetter,
  explainError,
  guardianLeaf,
  guardianSecrets,
  newGuardianSecret,
  newHeirKey,
  newSalt,
  payoutFor,
  rpIdHash,
  vaultId,
  willUpdateDigest,
  withPasskeyApproval,
  type CodicilPrivateState,
  type GuardianSet,
  type HeirKey,
  type Will,
} from '@codicil/sdk';
import { DemoChain } from './chain.js';
import { approveWithPasskey, type OwnerPasskey } from './passkey.js';

export const DAY = 86_400;
export const CHECK_IN_EVERY = 30 * DAY;
export const MAX_PERIOD = 60 * DAY;
export const CHALLENGE = 7 * DAY;
export const CLAIM_WINDOW = 30 * DAY;
export const ESTATE = 25_000n;

// ─── Cast ───────────────────────────────────────────────────────────────────
export const OWNER_NAME = 'Amara Okafor';

export interface HeirProfile {
  id: 'ada' | 'ben' | 'cleo' | 'kofi';
  name: string;
  relation: string;
  /** Index of the will entry this person can claim. */
  leaf: number;
  backup: boolean;
}

export const HEIRS: HeirProfile[] = [
  { id: 'ada', name: 'Ada', relation: 'Daughter', leaf: 0, backup: false },
  { id: 'ben', name: 'Ben', relation: 'Son', leaf: 1, backup: false },
  { id: 'cleo', name: 'Cleo', relation: 'Granddaughter', leaf: 2, backup: false },
  { id: 'kofi', name: 'Kofi', relation: 'Brother, backup for Ada', leaf: 0, backup: true },
];

export const GUARDIANS = [
  { id: 0, name: 'Dr. Mensah', relation: 'Family doctor' },
  { id: 1, name: 'Sarah Lin', relation: 'Lawyer' },
  { id: 2, name: 'Tomás', relation: 'Old friend' },
];

export type Actor =
  | { kind: 'owner' }
  | { kind: 'heir'; id: HeirProfile['id'] }
  | { kind: 'guardian'; id: number };

// ─── Activity and transactions ──────────────────────────────────────────────
export interface Activity {
  at: number;
  who: string;
  what: string;
  /** What the transaction put on the public ledger. */
  published: string[];
  /** What stayed on the actor's device. */
  keptPrivate: string[];
}

export type TxStageId = 'prepare' | 'approve' | 'circuit' | 'record';
export interface TxStage { id: TxStageId; label: string; detail: string }
export interface Tx {
  title: string;
  stages: TxStage[];
  current: number;
  status: 'running' | 'done' | 'error';
  message?: string;
  startedAt: number;
  endedAt?: number;
}

const STAGES: Record<TxStageId, TxStage> = {
  prepare: { id: 'prepare', label: 'Preparing', detail: 'Gathering what the circuit needs from this device.' },
  approve: { id: 'approve', label: 'Approve with your passkey', detail: 'Face ID, Touch ID or your device PIN signs this exact action.' },
  circuit: {
    id: 'circuit',
    label: 'Running the zero-knowledge circuit',
    detail: 'The vault rules run on your device. On a live network this step produces the proof (a few seconds).',
  },
  record: { id: 'record', label: 'Recorded on the demo chain', detail: 'Only the public result is written. Your secrets never left this device.' },
};

// ─── Snapshot for the UI ────────────────────────────────────────────────────
export interface HeirView {
  profile: HeirProfile;
  shareBps: bigint;
  unlockAt: number;
  claimed: boolean;
  amount: bigint;
  /** False for a backup heir the owner has since removed. */
  named: boolean;
}

export interface WillDraft {
  ada: bigint;
  ben: bigint;
  cleo: bigint;
  kofiBackup: boolean;
}

export interface Snapshot {
  ready: boolean;
  passkey?: OwnerPasskey;
  actor: Actor;
  now: number;
  phase: Phase;
  deadline: number;
  pendingUntil: number;
  releasedAt: number;
  estate: bigint;
  estateSnapshot: bigint;
  estatePaid: bigint;
  nonce: bigint;
  willVersion: bigint;
  guardianRound: bigint;
  guardianVotes: bigint;
  guardianThreshold: bigint;
  /** Public ledger values, hex. */
  chain: {
    address: string;
    willRoot: string;
    guardianRoot: string;
    ownerPasskeyCommit: string;
    claimNullifiers: string[];
    guardianNullifierCount: number;
  };
  heirs: HeirView[];
  /** Leaf hashes, computed on the owner's device only. */
  leafHashes: string[];
  votedThisRound: number[];
  activity: Activity[];
  tx?: Tx;
}

/** A problem with what the person entered; its message is shown as is. */
class InputError extends Error {
  override name = 'InputError';
}

/** Plain-language message for anything an action can throw. */
function describeFailure(e: unknown): string {
  if (contractErrorCode(e)) return explainError(e);
  if (e instanceof Error && e.name === 'InputError') return e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.';
  if (e instanceof Error && e.name === 'NotAllowedError') return 'The passkey request was cancelled or timed out. Nothing was changed.';
  return explainError(e);
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fieldHex = (f: bigint) => f.toString(16).padStart(64, '0');
const wait = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const fmtDate = (t: number) =>
  new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

interface World {
  chain: DemoChain;
  passkey: OwnerPasskey;
  ownerSalt: Uint8Array;
  will: Will;
  heirKeys: Record<HeirProfile['id'], { key: HeirKey; salt: Uint8Array }>;
  guardianSecretsList: Uint8Array[];
  guardianSet: GuardianSet;
  claimed: Map<number, string>;   // leaf → nullifier hex
  votedRound: Map<number, bigint>;
}

class DemoStore {
  private world?: World;
  private actor: Actor = { kind: 'owner' };
  private activity: Activity[] = [];
  private tx?: Tx;
  private snapshot: Snapshot;
  private listeners = new Set<() => void>();
  /** Pause between progress stages so people can follow them. Tests set 0. */
  stageDelayMs = 450;

  constructor() {
    this.snapshot = this.build();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = this.build();
    this.listeners.forEach((fn) => fn());
  }

  // ─── Setup ────────────────────────────────────────────────────────────────
  async setUp(passkey: OwnerPasskey): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const heirKeys = Object.fromEntries(
      HEIRS.map((h) => [h.id, { key: newHeirKey(), salt: newSalt() }]),
    ) as World['heirKeys'];
    const will = this.willFor({ heirKeys }, { ada: 5000n, ben: 3000n, cleo: 2000n, kofiBackup: true }, BigInt(now + 400 * DAY));
    const guardianSecretsList = GUARDIANS.map(() => newGuardianSecret());
    const guardianSet = buildGuardianSet(guardianSecretsList.map(guardianLeaf), 2);
    const ownerSalt = newSalt();

    const chain = await DemoChain.deploy({
      ownerPasskeyCommit: pureCircuits.passkeyCommitment(passkey.pk, ownerSalt),
      ownerEdCommit: new Uint8Array(32),
      passkeyRpIdHash: rpIdHash(globalThis.location?.hostname ?? 'localhost'),
      willRoot: will.root,
      firstDeadline: BigInt(now + CHECK_IN_EVERY),
      maxPeriod: BigInt(MAX_PERIOD),
      challengeWindow: BigInt(CHALLENGE),
      claimWindow: BigInt(CLAIM_WINDOW),
      tokenColor: encodeRawTokenType(sampleRawTokenType()),
      guardianRoot: guardianSet.root,
      guardianThreshold: guardianSet.threshold,
      attestorKeyCommit: new Uint8Array(32),
    }, now);
    this.world = { chain, passkey, ownerSalt, will, heirKeys, guardianSecretsList, guardianSet, claimed: new Map(), votedRound: new Map() };
    this.activity = [{
      at: now,
      who: OWNER_NAME,
      what: 'Sealed the vault',
      published: ['A commitment to the owner passkey', 'The will root (one 32-byte number)', 'The guardian root and "2 of 3"', 'The first check-in deadline'],
      keptPrivate: ['The passkey itself', 'Heir names, shares, unlock dates and the backup heir', 'Who the guardians are'],
    }];
    await chain.call('deposit', {}, ESTATE);
    this.log(OWNER_NAME, `Deposited ${ESTATE.toLocaleString()} demo tokens`, ['The amount'], []);
    this.emit();
  }

  reset() {
    this.world = undefined;
    this.activity = [];
    this.tx = undefined;
    this.actor = { kind: 'owner' };
    this.emit();
  }

  /** The will entries for a set of shares, with fresh salts. */
  private willFor(w: Pick<World, 'heirKeys'>, d: WillDraft, cleoUnlock: bigint): Will {
    const open = (id: HeirProfile['id']) => ({ pk: w.heirKeys[id].key.pk, salt: w.heirKeys[id].salt });
    return buildWill([
      { heir: open('ada'), backup: d.kofiBackup ? open('kofi') : undefined, shareBps: d.ada },
      { heir: open('ben'), shareBps: d.ben },
      // Cleo is a minor: her share unlocks on her 18th birthday.
      { heir: open('cleo'), shareBps: d.cleo, unlockAt: cleoUnlock },
    ]);
  }

  setActor(actor: Actor) {
    this.actor = actor;
    this.emit();
  }

  dismissTx() {
    if (this.tx?.status !== 'running') {
      this.tx = undefined;
      this.emit();
    }
  }

  // ─── Clock ────────────────────────────────────────────────────────────────
  advance(seconds: number) {
    if (!this.world) return;
    this.world.chain.advance(seconds);
    this.emit();
  }

  advanceTo(t: number) {
    if (!this.world) return;
    this.advance(t - this.world.chain.now);
  }

  // ─── Actions ──────────────────────────────────────────────────────────────
  private log(who: string, what: string, published: string[], keptPrivate: string[]) {
    this.activity = [{ at: this.world!.chain.now, who, what, published, keptPrivate }, ...this.activity];
  }

  /** Runs an action through the transaction sheet. Returns true on success. */
  private async run(title: string, stageIds: TxStageId[], body: (stage: (id: TxStageId) => Promise<void>) => Promise<string>) {
    if (!this.world || this.tx?.status === 'running') return false;
    const stages = stageIds.map((id) => id === 'approve' && this.world!.passkey.kind === 'demo'
      ? { ...STAGES.approve, label: 'Signing with the demo key', detail: 'A software key signs in the exact passkey format. With a device passkey this is Face ID or Touch ID.' }
      : STAGES[id]);
    this.tx = { title, stages, current: 0, status: 'running', startedAt: performance.now() };
    this.emit();
    const stage = async (id: TxStageId) => {
      this.tx = { ...this.tx!, current: stages.findIndex((s) => s.id === id) };
      this.emit();
      await wait(this.stageDelayMs);
    };
    try {
      await stage('prepare');
      const message = await body(stage);
      await stage('record');
      this.tx = { ...this.tx!, current: stages.length, status: 'done', message, endedAt: performance.now() };
      this.emit();
      return true;
    } catch (e) {
      if (!contractErrorCode(e)) console.warn('[codicil demo]', e);
      this.tx = { ...this.tx!, status: 'error', message: describeFailure(e), endedAt: performance.now() };
      this.emit();
      return false;
    }
  }

  checkIn() {
    return this.run("Confirm you're alive", ['prepare', 'approve', 'circuit', 'record'], async (stage) => {
      const w = this.world!;
      const next = BigInt(w.chain.now + CHECK_IN_EVERY);
      const digest = checkInDigest(w.chain.address, next, w.chain.ledger.nonce);
      await stage('approve');
      const assertion = await approveWithPasskey(w.passkey, digest);
      await stage('circuit');
      const wasPending = w.chain.ledger.phase === Phase.pending;
      const state = withPasskeyApproval({ passkey: { pk: w.passkey.pk, salt: w.ownerSalt } }, digest, assertion);
      await w.chain.call('checkInPasskey', state, next);
      this.log(OWNER_NAME, wasPending ? 'Cancelled the countdown by checking in' : 'Checked in', [
        `New deadline: ${fmtDate(Number(next))}`, 'Check-in counter +1', 'Guardian round +1 (earlier reports no longer count)',
      ], ['The passkey and its signature', 'Which person this vault belongs to']);
      return wasPending
        ? `Countdown cancelled. Your next deadline is ${fmtDate(Number(next))}.`
        : `Check-in recorded. Your next deadline is ${fmtDate(Number(next))}.`;
    });
  }

  /** The letter the owner hands this heir (a backup gets the entry they back up). */
  letterFor(heirId: HeirProfile['id']): string {
    const w = this.world!;
    const h = HEIRS.find((x) => x.id === heirId)!;
    return encodeHeirLetter({ vault: w.chain.address, ...claimPackage(w.will, h.leaf) });
  }

  updateWill(draft: WillDraft) {
    return this.run('Seal the new will', ['prepare', 'approve', 'circuit', 'record'], async (stage) => {
      const w = this.world!;
      let will: Will;
      try {
        will = this.willFor(w, draft, w.will.leaves[2].unlockAt);
      } catch (e) {
        throw new InputError(e instanceof Error ? e.message : String(e));
      }
      const digest = willUpdateDigest(w.chain.address, will.root, w.chain.ledger.nonce);
      await stage('approve');
      const assertion = await approveWithPasskey(w.passkey, digest);
      await stage('circuit');
      const state = withPasskeyApproval({ passkey: { pk: w.passkey.pk, salt: w.ownerSalt } }, digest, assertion);
      await w.chain.call('updateWillPasskey', state, will.root);
      w.will = will;
      this.log(OWNER_NAME, 'Updated the will', [
        'A new will root (one 32-byte number)', 'Will version +1',
      ], ['Who gets what, and what changed', 'That a backup heir was ' + (draft.kofiBackup ? 'kept' : 'removed')]);
      return 'Your new will is sealed. The old one can no longer be claimed against.';
    });
  }

  deposit(amount: bigint) {
    return this.run('Add to the estate', ['prepare', 'circuit', 'record'], async (stage) => {
      await stage('circuit');
      await this.world!.chain.call('deposit', {}, amount);
      this.log(OWNER_NAME, `Deposited ${amount.toLocaleString()} demo tokens`, ['The amount'], []);
      return `${amount.toLocaleString()} demo tokens added to the estate.`;
    });
  }

  startCountdown(who: string) {
    return this.run('Start the countdown', ['prepare', 'circuit', 'record'], async (stage) => {
      await stage('circuit');
      await this.world!.chain.call('triggerTimeout', {});
      this.log(who, 'Started the countdown (deadline missed)', ['Phase: pending', 'When the challenge window ends'], []);
      return `The owner missed their deadline. They have ${CHALLENGE / DAY} days to cancel before the will is released.`;
    });
  }

  guardianReport(id: number) {
    const g = GUARDIANS[id];
    return this.run('Report a death', ['prepare', 'circuit', 'record'], async (stage) => {
      const w = this.world!;
      await stage('circuit');
      const state: CodicilPrivateState = { guardian: guardianSecrets(w.guardianSet, w.guardianSecretsList[id]) };
      const round = w.chain.ledger.guardianRound;
      await w.chain.call('guardianAttest', state, BigInt(w.chain.now));
      w.votedRound.set(id, round);
      const l = w.chain.ledger;
      const started = l.phase === Phase.pending;
      this.log('A guardian', started ? 'Reported a death; enough guardians agreed, so the countdown started' : 'Reported a death', [
        'A one-time vote token (cannot be linked to the guardian)', `Votes this round: ${l.guardianVotes} of ${l.guardianThreshold}`,
      ], [`That it was ${g.name}`, 'The guardian secret']);
      return started
        ? `Enough guardians agreed. The owner has ${CHALLENGE / DAY} days to cancel.`
        : `Report recorded anonymously: ${l.guardianVotes} of ${l.guardianThreshold} guardians so far.`;
    });
  }

  release(who: string) {
    return this.run('Release the will', ['prepare', 'circuit', 'record'], async (stage) => {
      await stage('circuit');
      await this.world!.chain.call('finalizeRelease', {});
      this.log(who, 'Released the will', ['Phase: released', `Estate snapshot: ${this.world!.chain.ledger.estateSnapshot.toLocaleString()}`, 'A "released" event'], []);
      return 'The will is released. Heirs can now claim their shares.';
    });
  }

  claim(heirId: HeirProfile['id']) {
    const h = HEIRS.find((x) => x.id === heirId)!;
    return this.run('Claim your share', ['prepare', 'circuit', 'record'], async (stage) => {
      const w = this.world!;
      await stage('circuit');
      const k = w.heirKeys[heirId];
      // The heir works only from the letter they were given and their own key.
      const letter = decodeHeirLetter(this.letterFor(heirId));
      const state: CodicilPrivateState = { claimant: { leaf: letter.leaf, path: letter.path, key: k.key, keySalt: k.salt } };
      const to = sampleUserAddress();
      const out = await w.chain.call(h.backup ? 'claimAsBackup' : 'claim', state, { bytes: encodeUserAddress(to) });
      const paid = out.payouts.reduce((a, [, v]) => a + v, 0n);
      const nul = hex(pureCircuits.claimNullifier(vaultId(w.chain.address), pureCircuits.heirLeafHash(w.will.leaves[h.leaf])));
      w.claimed.set(h.leaf, nul);
      this.log('An heir', 'Claimed a share', [
        'A one-time claim token', `${paid.toLocaleString()} demo tokens to a fresh address`,
      ], [`That it was ${h.name}`, 'Which will entry', 'The heir key']);
      return `${paid.toLocaleString()} demo tokens sent to your new address ${to.slice(0, 8)}…${to.slice(-4)}.`;
    });
  }

  // ─── Snapshot ─────────────────────────────────────────────────────────────
  private build(): Snapshot {
    const w = this.world;
    if (!w) {
      return {
        ready: false, actor: this.actor, now: Math.floor(Date.now() / 1000), phase: Phase.armed, deadline: 0,
        pendingUntil: 0, releasedAt: 0, estate: 0n, estateSnapshot: 0n, estatePaid: 0n, nonce: 0n, willVersion: 0n,
        guardianRound: 0n, guardianVotes: 0n, guardianThreshold: 0n,
        chain: { address: '', willRoot: '', guardianRoot: '', ownerPasskeyCommit: '', claimNullifiers: [], guardianNullifierCount: 0 },
        heirs: [], leafHashes: [], votedThisRound: [], activity: [], tx: this.tx,
      };
    }
    const l = w.chain.ledger;
    const snapshotBase = l.phase === Phase.released ? l.estateSnapshot : l.estateTotal;
    const leaves: HeirLeaf[] = w.will.leaves;
    return {
      ready: true,
      passkey: w.passkey,
      actor: this.actor,
      now: w.chain.now,
      phase: l.phase,
      deadline: Number(l.deadline),
      pendingUntil: Number(l.pendingUntil),
      releasedAt: Number(l.releasedAt),
      estate: l.estateTotal - l.estatePaid,
      estateSnapshot: l.estateSnapshot,
      estatePaid: l.estatePaid,
      nonce: l.nonce,
      willVersion: l.willVersion,
      guardianRound: l.guardianRound,
      guardianVotes: l.guardianVotes,
      guardianThreshold: l.guardianThreshold,
      chain: {
        address: w.chain.address,
        willRoot: fieldHex(l.willRoot),
        guardianRoot: fieldHex(l.guardianRoot),
        ownerPasskeyCommit: hex(l.ownerPasskeyCommit),
        claimNullifiers: [...w.claimed.values()].filter((n) => l.claimNullifiers.member(Uint8Array.from(n.match(/../g)!.map((x) => parseInt(x, 16))))),
        guardianNullifierCount: Number(l.guardianNullifiers.size()),
      },
      heirs: HEIRS.map((profile) => {
        const leaf = leaves[profile.leaf];
        return {
          profile,
          shareBps: leaf.shareBps,
          unlockAt: Number(leaf.unlockAt),
          claimed: w.claimed.has(profile.leaf),
          amount: payoutFor(snapshotBase, leaf.shareBps),
          named: !profile.backup || leaf.backupKeyCommit.some((b) => b !== 0),
        };
      }),
      leafHashes: leaves.map((leaf) => hex(pureCircuits.heirLeafHash(leaf))),
      votedThisRound: [...w.votedRound].filter(([, r]) => r === l.guardianRound).map(([id]) => id),
      activity: this.activity,
      tx: this.tx,
    };
  }
}

export const demo = new DemoStore();
export const useDemo = (): Snapshot => useSyncExternalStore(demo.subscribe, demo.getSnapshot);
export { fmtDate };
