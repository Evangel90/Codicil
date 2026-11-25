// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The demo world: one owner, a three-heir will with a backup heir and a
// tranche, three hidden guardians, and a demo clock. The owner configures the
// shares, the backup, the guardian threshold and the timers in the setup
// wizard, and every action runs the real vault circuit on the in-browser
// DemoChain.

import { useSyncExternalStore } from 'react';
import { encodeRawTokenType, encodeUserAddress, sampleRawTokenType, sampleUserAddress } from '@midnight-ntwrk/compact-runtime';
import { Phase, pureCircuits, type HeirLeaf } from '@codicil/contracts/vault';
import {
  buildGuardianSet,
  buildWill,
  checkHeirLetter,
  checkInDigest,
  claimPackage,
  contractErrorCode,
  decodeHeirLetter,
  encodeHeirLetter,
  explainError,
  guardianLeaf,
  letterFingerprint,
  guardianSecrets,
  newGuardianSecret,
  newHeirKey,
  newSalt,
  payoutFor,
  rpIdHash,
  VAULT_OPTIONS_OFF,
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
export const CHALLENGE = 14 * DAY;
export const CLAIM_WINDOW = 30 * DAY;
export const ESTATE = 25_000n;
export const TOKEN = 'demo tokens';

// ─── Cast ───────────────────────────────────────────────────────────────────
export const OWNER_NAME = 'Amara Okafor';
export const OWNER_FIRST = 'Amara';

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
  | { kind: 'guardian'; id: number }
  | { kind: 'public' };

// ─── Setup ──────────────────────────────────────────────────────────────────
export interface WillDraft {
  ada: bigint;
  ben: bigint;
  cleo: bigint;
  kofiBackup: boolean;
}

export interface VaultSetup extends WillDraft {
  /** Unix seconds when Cleo's share unlocks. */
  cleoUnlock: number;
  /** Guardian reports needed, of 3. */
  threshold: number;
  /** Check-in interval, seconds. */
  every: number;
  /** Challenge window, seconds. */
  window: number;
}

export function defaultSetup(now = Math.floor(Date.now() / 1000)): VaultSetup {
  return { ada: 5000n, ben: 3000n, cleo: 2000n, kofiBackup: true, cleoUnlock: now + 400 * DAY, threshold: 2, every: CHECK_IN_EVERY, window: CHALLENGE };
}

// ─── Activity and transactions ──────────────────────────────────────────────
export interface Activity {
  at: number;
  who: string;
  what: string;
  tone: 'armed' | 'pending' | 'released' | 'public' | 'plain';
  /** What the transaction put on the public ledger. */
  published: string[];
  /** What stayed on the actor's device. */
  keptPrivate: string[];
}

export type TxStageId = 'prepare' | 'approve' | 'circuit' | 'proof' | 'record';
export interface TxStage { id: TxStageId; label: string; detail: string; skipped?: boolean; tag?: string }
export interface Tx {
  title: string;
  stages: TxStage[];
  current: number;
  status: 'running' | 'done' | 'error';
  message?: string;
  /** Contract error code, shown small for support. */
  code?: string;
  startedAt: number;
  endedAt?: number;
  /** Stage timings in seconds, by index. */
  times: (number | undefined)[];
}

export interface Toast { id: number; title: string; body?: string }

const STAGES: Record<TxStageId, TxStage> = {
  prepare: { id: 'prepare', label: 'Preparing', detail: 'Gathering what the circuit needs from this device.' },
  approve: { id: 'approve', label: 'Waiting for Face ID', detail: 'Confirm with Face ID, Touch ID or your device PIN to sign this exact action.' },
  circuit: { id: 'circuit', label: 'Running the vault rules on this device', detail: 'The compiled Compact circuit checks every rule, exactly as the chain will.' },
  proof: {
    id: 'proof', label: 'Generating zero-knowledge proof', tag: 'skipped in demo', skipped: true,
    detail: 'On Midnight this step proves the circuit ran correctly, in a few seconds.',
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
  /** Last 4 hex digits of the heir's public key. */
  keyEnd: string;
  /** The letter this person holds on their device, as checked there. */
  letter?: HeldLetter;
}

export interface HeldLetter {
  text: string;
  fingerprint: string;
  shareBps: bigint;
  unlockAt: number;
  vaultMatches: boolean;
  inCurrentWill: boolean;
  role: 'heir' | 'backup' | 'none';
}

export interface Snapshot {
  ready: boolean;
  passkey?: OwnerPasskey;
  setup?: VaultSetup;
  actor: Actor;
  now: number;
  deployedAt: number;
  lastCheckIn: number;
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
  toast?: Toast;
}

/** A problem with what the person entered; its message is shown as is. */
class InputError extends Error {
  override name = 'InputError';
}

/** Plain-language message for anything an action can throw. */
function describeFailure(e: unknown): string {
  if (contractErrorCode(e)) return explainError(e);
  if (e instanceof Error && e.name === 'InputError') return e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.';
  if (e instanceof Error && e.name === 'NotAllowedError') return 'Face ID was cancelled or timed out. Nothing was sent and nothing changed.';
  return explainError(e);
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fieldHex = (f: bigint) => f.toString(16).padStart(64, '0');
const wait = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
export const fmtDate = (t: number) =>
  new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
export const fmtShort = (t: number) =>
  new Date(t * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
export const days = (seconds: number) => Math.round(seconds / DAY);

interface Keys {
  ownerSalt: Uint8Array;
  heirKeys: Record<HeirProfile['id'], { key: HeirKey; salt: Uint8Array }>;
  guardianSecretsList: Uint8Array[];
}

interface World extends Keys {
  chain: DemoChain;
  passkey: OwnerPasskey;
  setup: VaultSetup;
  will: Will;
  guardianSet: GuardianSet;
  deployedAt: number;
  lastCheckIn: number;
  claimed: Map<number, string>;   // leaf → nullifier hex
  /** Letters each heir has loaded on their own device. */
  held: Map<HeirProfile['id'], string>;
  votedRound: Map<number, bigint>;
}

class DemoStore {
  private keys?: Keys;
  /** The will last shown in the wizard, so deploying seals exactly that one. */
  private previewed?: { key: string; will: Will };
  private world?: World;
  private actor: Actor = { kind: 'owner' };
  private activity: Activity[] = [];
  private tx?: Tx;
  private toast?: Toast;
  private lastAction?: () => Promise<boolean>;
  private clock?: ReturnType<typeof setInterval>;
  private snapshot: Snapshot;
  private listeners = new Set<() => void>();
  /** Pause between progress stages so people can follow them. Tests set 0. */
  stageDelayMs = 420;

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
  /** Heir keys, guardian secrets and the owner salt, made once per session. */
  private ensureKeys(): Keys {
    this.keys ??= {
      ownerSalt: newSalt(),
      heirKeys: Object.fromEntries(HEIRS.map((h) => [h.id, { key: newHeirKey(), salt: newSalt() }])) as Keys['heirKeys'],
      guardianSecretsList: GUARDIANS.map(() => newGuardianSecret()),
    };
    return this.keys;
  }

  /** Last 4 hex digits of an heir's public key, for the setup screens. */
  heirKeyEnd(id: HeirProfile['id']): string {
    return this.ensureKeys().heirKeys[id].key.pk.x.toString(16).slice(-4);
  }

  /** What the chain would receive for this setup: real commitments, computed here. */
  preview(setup: VaultSetup, passkey?: OwnerPasskey): { ownerCommit?: string; willRoot?: string; guardianRoot: string; problem?: string } {
    const k = this.ensureKeys();
    const guardianRoot = fieldHex(buildGuardianSet(k.guardianSecretsList.map(guardianLeaf), setup.threshold).root);
    const ownerCommit = passkey ? hex(pureCircuits.passkeyCommitment(passkey.pk, k.ownerSalt)) : undefined;
    try {
      return { ownerCommit, guardianRoot, willRoot: fieldHex(this.draftWill(setup).root) };
    } catch (e) {
      return { ownerCommit, guardianRoot, problem: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Builds the will for a setup once; the same setup gives the same will (and salts). */
  private draftWill(setup: VaultSetup): Will {
    const key = JSON.stringify(setup, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    if (this.previewed?.key !== key) this.previewed = { key, will: this.willFor(this.ensureKeys(), setup, BigInt(setup.cleoUnlock)) };
    return this.previewed.will;
  }

  async setUp(passkey: OwnerPasskey, setup: VaultSetup = defaultSetup()): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const k = this.ensureKeys();
    const will = this.draftWill(setup);
    const guardianSet = buildGuardianSet(k.guardianSecretsList.map(guardianLeaf), setup.threshold);

    const chain = await DemoChain.deploy({
      ownerPasskeyCommit: pureCircuits.passkeyCommitment(passkey.pk, k.ownerSalt),
      ownerEdCommit: new Uint8Array(32),
      passkeyRpIdHash: rpIdHash(globalThis.location?.hostname ?? 'localhost'),
      willRoot: will.root,
      firstDeadline: BigInt(now + setup.every),
      // A check-in may set the next deadline up to this far ahead (D9).
      maxPeriod: BigInt(Math.max(2 * setup.every, 60 * DAY)),
      challengeWindow: BigInt(setup.window),
      claimWindow: BigInt(CLAIM_WINDOW),
      tokenColor: encodeRawTokenType(sampleRawTokenType()),
      guardianRoot: guardianSet.root,
      guardianThreshold: guardianSet.threshold,
      attestorKeyCommit: new Uint8Array(32),
      ...VAULT_OPTIONS_OFF,
    }, now);
    this.world = {
      ...k, chain, passkey, setup, will, guardianSet, deployedAt: now, lastCheckIn: now, claimed: new Map(), votedRound: new Map(), held: new Map(),
    };
    this.activity = [{
      at: now, who: OWNER_NAME, what: 'Vault deployed and will sealed', tone: 'plain',
      published: ['A commitment to your passkey', 'The heirs root (one 32-byte number)', `The guardians root and "${setup.threshold} of 3"`, 'Your first deadline and the timers'],
      keptPrivate: ['The passkey itself', 'Names, shares, unlock dates and the backup heir', 'Who the guardians are'],
    }];
    await chain.call('deposit', {}, ESTATE);
    this.log(OWNER_NAME, `Deposit · ${ESTATE.toLocaleString()} ${TOKEN}`, 'public', ['The amount'], []);
    this.emit();
  }

  reset() {
    this.stopClock();
    this.world = undefined;
    this.keys = undefined;
    this.previewed = undefined;
    this.activity = [];
    this.tx = undefined;
    this.toast = undefined;
    this.lastAction = undefined;
    this.actor = { kind: 'owner' };
    this.emit();
  }

  /** The will entries for a set of shares, with fresh salts. */
  private willFor(k: Pick<Keys, 'heirKeys'>, d: WillDraft, cleoUnlock: bigint): Will {
    const open = (id: HeirProfile['id']) => ({ pk: k.heirKeys[id].key.pk, salt: k.heirKeys[id].salt });
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

  /** Close the sheet; a finished action leaves a toast behind. */
  dismissTx() {
    if (this.tx?.status === 'running') return;
    if (this.tx?.status === 'done' && this.tx.message) this.toast = { id: Date.now(), title: this.tx.message };
    this.tx = undefined;
    this.emit();
  }

  dismissToast() {
    this.toast = undefined;
    this.emit();
  }

  retry() {
    const again = this.lastAction;
    this.tx = undefined;
    this.emit();
    return again ? again() : Promise.resolve(false);
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

  /** Let demo time run with the wall clock, one second per second. */
  startClock() {
    if (this.clock) return;
    this.clock = setInterval(() => { if (this.world && this.tx?.status !== 'running') this.advance(1); }, 1000);
  }

  stopClock() {
    if (this.clock) clearInterval(this.clock);
    this.clock = undefined;
  }

  // ─── Actions ──────────────────────────────────────────────────────────────
  private log(who: string, what: string, tone: Activity['tone'], published: string[], keptPrivate: string[]) {
    this.activity = [{ at: this.world!.chain.now, who, what, tone, published, keptPrivate }, ...this.activity];
  }

  /** Runs an action through the transaction sheet. Returns true on success. */
  private async run(
    title: string,
    stageIds: TxStageId[],
    body: (stage: (id: TxStageId) => Promise<void>) => Promise<string>,
  ): Promise<boolean> {
    if (!this.world || this.tx?.status === 'running') return false;
    this.lastAction = () => this.run(title, stageIds, body);
    const stages = stageIds.map((id) => id === 'approve' && this.world!.passkey.kind === 'demo'
      ? { ...STAGES.approve, label: 'Signing with the demo key', detail: 'A software key signs in the exact passkey format. With a device passkey this is Face ID or Touch ID.' }
      : STAGES[id]);
    const t0 = performance.now();
    let mark = t0;
    this.tx = { title, stages, current: 0, status: 'running', startedAt: t0, times: [] };
    this.toast = undefined;
    this.emit();
    const stage = async (id: TxStageId) => {
      const now = performance.now();
      const times = [...this.tx!.times];
      times[this.tx!.current] = (now - mark) / 1000;
      mark = now;
      this.tx = { ...this.tx!, current: stages.findIndex((s) => s.id === id), times };
      this.emit();
      await wait(this.stageDelayMs);
    };
    try {
      await stage('prepare');
      const message = await body(stage);
      if (stageIds.includes('proof')) await stage('proof');
      await stage('record');
      const times = [...this.tx!.times];
      times[this.tx!.current] = (performance.now() - mark) / 1000;
      this.tx = { ...this.tx!, current: stages.length, status: 'done', message, endedAt: performance.now(), times };
      this.emit();
      return true;
    } catch (e) {
      if (!contractErrorCode(e)) console.warn('[codicil demo]', e);
      this.tx = { ...this.tx!, status: 'error', message: describeFailure(e), code: contractErrorCode(e), endedAt: performance.now() };
      this.emit();
      return false;
    }
  }

  private ownerState(digest: Uint8Array, assertion: Awaited<ReturnType<typeof approveWithPasskey>>): CodicilPrivateState {
    const w = this.world!;
    return withPasskeyApproval({ passkey: { pk: w.passkey.pk, salt: w.ownerSalt } }, digest, assertion);
  }

  checkIn() {
    const wasPending = this.world?.chain.ledger.phase === Phase.pending;
    return this.run(wasPending ? 'Cancelling the switch' : 'Recording your check-in', ['prepare', 'approve', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      const next = BigInt(w.chain.now + w.setup.every);
      const digest = checkInDigest(w.chain.address, next, w.chain.ledger.nonce);
      await stage('approve');
      const assertion = await approveWithPasskey(w.passkey, digest);
      await stage('circuit');
      const pending = w.chain.ledger.phase === Phase.pending;
      await w.chain.call('checkInPasskey', this.ownerState(digest, assertion), next);
      w.lastCheckIn = w.chain.now;
      this.log(OWNER_NAME, pending ? `Switch cancelled · deadline moved to ${fmtShort(Number(next))}` : `Check-in · deadline moved to ${fmtShort(Number(next))}`, 'armed', [
        'The new deadline', 'Check-in counter +1', 'Guardian round +1, so earlier reports no longer count',
      ], ['Your passkey and its signature', 'Who this vault belongs to']);
      return pending
        ? `Switch cancelled. Your next deadline is ${fmtDate(Number(next))}.`
        : `Check-in recorded. Your next deadline is ${fmtDate(Number(next))}.`;
    });
  }

  /** Prove the owner is present (Face ID) before showing private data. */
  async verifyOwner(): Promise<boolean> {
    const w = this.world;
    if (!w) return false;
    try {
      await approveWithPasskey(w.passkey, crypto.getRandomValues(new Uint8Array(32)));
      return true;
    } catch {
      return false;
    }
  }

  /** The letter the owner hands this heir (a backup gets the entry they back up). */
  letterFor(heirId: HeirProfile['id']): string {
    const w = this.world!;
    const h = HEIRS.find((x) => x.id === heirId)!;
    return encodeHeirLetter({ vault: w.chain.address, ...claimPackage(w.will, h.leaf) });
  }

  /**
   * An heir loads a letter on their device (pasted, scanned, or the one the
   * owner gave them). Returns a plain-language problem if it can't be read.
   */
  holdLetter(heirId: HeirProfile['id'], text?: string): string | undefined {
    const w = this.world;
    if (!w) return 'There is no vault yet.';
    const t = (text ?? this.letterFor(heirId)).trim();
    try {
      decodeHeirLetter(t);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return m.charAt(0).toUpperCase() + m.slice(1) + '.';
    }
    w.held.set(heirId, t);
    this.emit();
    return undefined;
  }

  forgetLetter(heirId: HeirProfile['id']) {
    this.world?.held.delete(heirId);
    this.emit();
  }

  updateWill(draft: WillDraft) {
    return this.run('Sealing the new will', ['prepare', 'approve', 'circuit', 'proof', 'record'], async (stage) => {
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
      await w.chain.call('updateWillPasskey', this.ownerState(digest, assertion), will.root);
      w.will = will;
      w.setup = { ...w.setup, ...draft };
      this.log(OWNER_NAME, `Will updated to version ${(w.chain.ledger.willVersion + 1n).toString()}`, 'plain', [
        'A new heirs root (one 32-byte number)', 'Will version +1',
      ], ['Who gets what, and what changed', draft.kofiBackup ? 'The backup heir' : 'That the backup heir was removed']);
      return 'Your new will is sealed. Letters for the old one no longer work.';
    });
  }

  deposit(amount: bigint) {
    return this.run('Adding to the estate', ['prepare', 'circuit', 'record'], async (stage) => {
      await stage('circuit');
      await this.world!.chain.call('deposit', {}, amount);
      this.log(OWNER_NAME, `Deposit · ${amount.toLocaleString()} ${TOKEN}`, 'public', ['The amount'], []);
      return `Deposit received. ${amount.toLocaleString()} ${TOKEN} added to the estate.`;
    });
  }

  startCountdown(who: string) {
    return this.run('Starting the switch', ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      await stage('circuit');
      await this.world!.chain.call('triggerTimeout', {});
      this.log(who, 'Deadline passed · switch started', 'pending', ['Vault state: pending', 'When the challenge window ends'], []);
      return `The switch has started. The owner has ${days(this.world!.setup.window)} days to cancel.`;
    });
  }

  guardianReport(id: number) {
    const g = GUARDIANS[id];
    return this.run('Casting your vote', ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      await stage('circuit');
      const state: CodicilPrivateState = { guardian: guardianSecrets(w.guardianSet, w.guardianSecretsList[id]) };
      const round = w.chain.ledger.guardianRound;
      await w.chain.call('guardianAttest', state, BigInt(w.chain.now));
      w.votedRound.set(id, round);
      const l = w.chain.ledger;
      const started = l.phase === Phase.pending;
      this.log('A guardian', started ? 'Guardians agreed · switch started' : 'A guardian voted', started ? 'pending' : 'plain', [
        'A one-time vote stamp that cannot be linked to the guardian', `Votes this round: ${l.guardianVotes} of ${l.guardianThreshold}`,
      ], [`That it was ${g.name}`, 'The guardian secret']);
      return started
        ? `Your vote is recorded. Enough guardians agreed, so the switch has started.`
        : `Your vote is recorded: ${l.guardianVotes} of ${l.guardianThreshold} so far. No one can see who voted.`;
    });
  }

  release(who: string) {
    return this.run('Releasing the will', ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      await stage('circuit');
      await this.world!.chain.call('finalizeRelease', {});
      this.log(who, 'Challenge window ended · will released', 'released', ['Vault state: released', `Estate snapshot: ${this.world!.chain.ledger.estateSnapshot.toLocaleString()}`, 'A "released" event'], []);
      return 'The will is released. Heirs can now claim their shares.';
    });
  }

  /**
   * `to` is a 64-hex unshielded address; a fresh one is made if omitted. The
   * claim uses the letter the heir holds (or, in tests, the current one).
   */
  claim(heirId: HeirProfile['id'], to: string = sampleUserAddress()) {
    const h = HEIRS.find((x) => x.id === heirId)!;
    return this.run('Claiming your share', ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      if (!/^[0-9a-f]{64}$/i.test(to)) throw new InputError('that does not look like an address. It should be 64 hexadecimal characters');
      await stage('circuit');
      const k = w.heirKeys[heirId];
      // The heir works only from the letter they were given and their own key.
      const letter = decodeHeirLetter(w.held.get(heirId) ?? this.letterFor(heirId));
      const state: CodicilPrivateState = { claimant: { leaf: letter.leaf, path: letter.path, key: k.key, keySalt: k.salt } };
      const out = await w.chain.call(h.backup ? 'claimAsBackup' : 'claim', state, { bytes: encodeUserAddress(to.toLowerCase()) });
      const paid = out.payouts.reduce((a, [, v]) => a + v, 0n);
      const nul = hex(pureCircuits.claimNullifier(vaultId(w.chain.address), pureCircuits.heirLeafHash(w.will.leaves[h.leaf])));
      w.claimed.set(h.leaf, nul);
      this.log('An heir', 'A share was claimed', 'released', [
        'A one-time claim stamp', `${paid.toLocaleString()} ${TOKEN} to a fresh address`,
      ], [`That it was ${h.name}`, 'Which entry in the will', 'The heir key']);
      return `${paid.toLocaleString()} ${TOKEN} sent to ${to.slice(0, 6)}…${to.slice(-4)}.`;
    });
  }

  private heldLetter(w: World, id: HeirProfile['id']): HeldLetter | undefined {
    const text = w.held.get(id);
    if (!text) return undefined;
    const letter = decodeHeirLetter(text);
    const k = w.heirKeys[id];
    const check = checkHeirLetter(letter, { vault: w.chain.address, willRoot: w.chain.ledger.willRoot, key: { pk: k.key.pk, salt: k.salt } });
    return {
      text, fingerprint: letterFingerprint(letter), shareBps: letter.leaf.shareBps, unlockAt: Number(letter.leaf.unlockAt),
      vaultMatches: check.vaultMatches, inCurrentWill: check.inCurrentWill, role: check.role ?? 'none',
    };
  }

  // ─── Snapshot ─────────────────────────────────────────────────────────────
  private build(): Snapshot {
    const w = this.world;
    if (!w) {
      return {
        ready: false, actor: this.actor, now: Math.floor(Date.now() / 1000), deployedAt: 0, lastCheckIn: 0, phase: Phase.armed, deadline: 0,
        pendingUntil: 0, releasedAt: 0, estate: 0n, estateSnapshot: 0n, estatePaid: 0n, nonce: 0n, willVersion: 0n,
        guardianRound: 0n, guardianVotes: 0n, guardianThreshold: 0n,
        chain: { address: '', willRoot: '', guardianRoot: '', ownerPasskeyCommit: '', claimNullifiers: [], guardianNullifierCount: 0 },
        heirs: [], leafHashes: [], votedThisRound: [], activity: [], tx: this.tx, toast: this.toast,
      };
    }
    const l = w.chain.ledger;
    const snapshotBase = l.phase === Phase.released ? l.estateSnapshot : l.estateTotal;
    const leaves: HeirLeaf[] = w.will.leaves;
    return {
      ready: true,
      passkey: w.passkey,
      setup: w.setup,
      actor: this.actor,
      now: w.chain.now,
      deployedAt: w.deployedAt,
      lastCheckIn: w.lastCheckIn,
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
          keyEnd: w.heirKeys[profile.id].key.pk.x.toString(16).slice(-4),
          letter: this.heldLetter(w, profile.id),
        };
      }),
      leafHashes: leaves.map((leaf) => hex(pureCircuits.heirLeafHash(leaf))),
      votedThisRound: [...w.votedRound].filter(([, r]) => r === l.guardianRound).map(([id]) => id),
      activity: this.activity,
      tx: this.tx,
      toast: this.toast,
    };
  }
}

export const demo = new DemoStore();
export const useDemo = (): Snapshot => useSyncExternalStore(demo.subscribe, demo.getSnapshot);
