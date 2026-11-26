// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The live store: real vaults, for real people, on whatever chain it is given.
//
// It differs from the demo store (demo/store.ts) where a real person differs
// from a guided tour: there is no cast and no "act as", the people are the
// ones the owner types in, time is the chain's own, and everything private is
// kept in a record that survives a reload and can be backed up.
//
// It is written against the chain boundary (chain/types.ts) and touches no
// browser API, so the same code runs in three places: the web app (Lace and a
// Midnight network), the unit tests (the in-memory chain) and the end-to-end
// script (a wallet from a seed and a real network).

import { encodeUserAddress } from '@midnight-ntwrk/compact-runtime';
import { Phase, pureCircuits, type HeirLeaf, type Ledger, type VaultConfig } from '@codicil/contracts/vault';
import {
  buildGuardianSet,
  buildWill,
  checkHeirLetter,
  checkInDigest,
  claimPackage,
  decodeHeirLetter,
  encodeHeirLetter,
  guardianLeaf,
  guardianSecrets,
  heirKeyFromScalar,
  isCurrentGuardian,
  MerkleTree,
  newGuardianSecret,
  newHeirKey,
  newSalt,
  payoutFor,
  rpIdHash,
  timeoutOpensAt,
  VAULT_OPTIONS_OFF,
  vaultId,
  withPasskeyApproval,
  type CodicilPrivateState,
  type GuardianSet,
  type WebAuthnAssertion,
  type Will,
} from '@codicil/sdk';
import type { CallStage, DeploymentRecord, DeployStage, VaultChain, VaultHost } from '../chain/types.js';
import type { OwnerPasskey } from '../demo/passkey.js';
import { newLocalId, toHex } from './codec.js';
import { describeProblem, InputProblem, type Problem } from './problems.js';
import {
  decodeKit, decodeRecords, encodeKit, encodeRecords, exportBackup, importBackup, mergeRecords, recordAddress,
  type ActivityEntry, type GuardianRecord, type HeirRecord, type LiveTimers, type OwnerRecord, type RecordStorage, type VaultRecord,
} from './records.js';
import { formatNight, networkName } from './wallet.js';

export const MINUTE = 60;
export const DAY = 86_400;

/** How long a backup heir waits after release before they may claim. */
const claimWindowFor = (t: LiveTimers): number => (t.testing ? 10 * MINUTE : 30 * DAY);
/** A check-in may set the next deadline up to this far ahead (docs/DECISIONS.md D9). */
const maxPeriodFor = (t: LiveTimers): number => (t.testing ? 2 * t.every : Math.max(2 * t.every, 60 * DAY));
/**
 * With minute-long timers, creating the vault (eight transactions, each one
 * approved by hand) would eat the first check-in period. The first deadline
 * is pushed out by this much; every later one is exactly `every` away.
 */
export const DEPLOY_ALLOWANCE = 15 * MINUTE;
/**
 * A network's clock is a block or two behind this device's. Anything that
 * must happen "at or after" a time waits this much longer before it is tried,
 * and a guardian's vote is stamped this far in the past.
 */
export const CLOCK_MARGIN = 30;
/** The shortest timers that still leave room to prove, approve and land a transaction (preprod/src/timers.ts). */
export const MIN_EVERY = 5 * MINUTE;
export const MIN_WINDOW = 2 * MINUTE;

/** Timers for trying everything in one sitting. Not for a real will. */
export const TESTING_TIMERS: LiveTimers = { every: 10 * MINUTE, window: 3 * MINUTE, grace: 0, testing: true };
export const DEFAULT_TIMERS: LiveTimers = { every: 30 * DAY, window: 14 * DAY, grace: 0, testing: false };

// ─── What the owner types in ────────────────────────────────────────────────

export interface HeirDraft {
  name: string;
  /** Percent of the estate, up to two decimals. */
  sharePct: number;
  /** Unix seconds before which the share stays locked; omit for "at release". */
  unlockAt?: number;
  /** Someone who may claim this share if the heir has not within the claim window. */
  backupName?: string;
}

export interface VaultDraft {
  ownerName: string;
  heirs: HeirDraft[];
  /** Names of the guardians; none is fine. */
  guardians: string[];
  /** How many guardians must agree. Ignored when there are no guardians. */
  threshold: number;
  timers: LiveTimers;
}

export const emptyDraft = (): VaultDraft => ({
  ownerName: '', heirs: [{ name: '', sharePct: 100 }], guardians: [], threshold: 1, timers: { ...DEFAULT_TIMERS },
});

const toBps = (pct: number): bigint => BigInt(Math.round(pct * 100));

/** Everything wrong with a draft, each as a sentence; empty when it can be sealed. */
export function draftProblems(d: VaultDraft): string[] {
  const out: string[] = [];
  if (d.ownerName.trim() === '') out.push('Add your name. It is shown to your heirs and guardians in their invitations, and never published.');
  if (d.heirs.length === 0) out.push('Add at least one heir.');
  if (d.heirs.some((h) => h.name.trim() === '')) out.push('Give every heir a name.');
  if (d.heirs.some((h) => h.backupName !== undefined && h.backupName.trim() === '')) out.push('Give every backup heir a name, or remove the backup.');
  if (d.heirs.some((h) => !(h.sharePct > 0) || h.sharePct > 100)) out.push('Each share must be more than 0% and at most 100%.');
  const total = d.heirs.reduce((sum, h) => sum + (Number.isFinite(h.sharePct) ? toBps(h.sharePct) : 0n), 0n);
  if (total > 10_000n) out.push(`The shares add up to ${Number(total) / 100}%. Lower one so the total is 100% or less.`);
  if (d.guardians.some((g) => g.trim() === '')) out.push('Give every guardian a name, or remove the empty one.');
  if (d.guardians.length > 0 && (!Number.isInteger(d.threshold) || d.threshold < 1 || d.threshold > d.guardians.length)) {
    out.push(`Choose how many of your ${d.guardians.length} guardians must agree: between 1 and ${d.guardians.length}.`);
  }
  if (d.timers.every < MIN_EVERY) out.push('The check-in period must be at least 5 minutes, or a check-in cannot land before its own deadline.');
  if (d.timers.window < MIN_WINDOW) out.push('The challenge window must be at least 2 minutes.');
  if (d.timers.grace > d.timers.every) out.push('The grace period cannot be longer than the check-in period.');
  return out;
}

// ─── What the screens show ──────────────────────────────────────────────────

export type LiveStageId = 'prepare' | 'approve' | 'proof' | 'wallet' | 'record';
export interface LiveTxStage { id: LiveStageId; label: string; detail: string; skipped?: boolean; tag?: string }
/** Shaped like the demo's `Tx`, so the same progress sheet draws it. */
export interface LiveTx {
  title: string;
  stages: LiveTxStage[];
  current: number;
  status: 'running' | 'done' | 'error';
  message?: string;
  code?: string;
  /** When something went wrong: what, and what to do. */
  problem?: Problem;
  startedAt: number;
  endedAt?: number;
  times: (number | undefined)[];
}

export interface Toast { id: number; title: string }

/** The vault's public state, as numbers the screens can use. Everyone sees the same. */
export interface VaultFacts {
  address: string;
  phase: Phase;
  deadline: number;
  grace: number;
  /** When anyone may start the switch: the deadline plus the grace period. */
  switchOpensAt: number;
  window: number;
  pendingUntil: number;
  releasedAt: number;
  claimWindow: number;
  /** What the vault holds now, in STAR. */
  estate: bigint;
  estateSnapshot: bigint;
  estatePaid: bigint;
  nonce: bigint;
  guardianVotes: number;
  guardianThreshold: number;
  guardianRound: bigint;
  /** Anyone can start the switch now. */
  canStartSwitch: boolean;
  /** Anyone can release the will now. */
  canRelease: boolean;
}

export type CheckInState = 'onTime' | 'grace' | 'expired';

export interface OwnerView {
  role: 'owner';
  id: string;
  ownerName: string;
  /** `creating`: a deployment is running. `interrupted`: one was started and is not finished. `ready`: the vault is whole. */
  status: 'creating' | 'interrupted' | 'ready';
  passkey: OwnerPasskey['kind'];
  timers: LiveTimers;
  heirs: { id: string; name: string; shareBps: bigint; unlockAt: number; backupName?: string; keyEnd: string }[];
  guardians: { id: string; name: string }[];
  threshold: number;
  firstDeadline?: number;
  lastCheckIn?: number;
  checkIn?: CheckInState;
  activity: ActivityEntry[];
  deployment?: DeploymentRecord;
  vault?: VaultFacts;
}

export type HeirStatus = 'stale' | 'locked' | 'pending' | 'waiting' | 'claimable' | 'claimed' | 'taken';

export interface HeirView {
  role: 'heir';
  id: string;
  name: string;
  ownerName: string;
  backup: boolean;
  shareBps: bigint;
  unlockAt: number;
  status?: HeirStatus;
  /** What this share is worth: of the estate now, or of the snapshot once released. */
  amount?: bigint;
  /** When this person may claim, once the will is released. */
  opensAt?: number;
  claimed?: HeirRecord['claimed'];
  vault?: VaultFacts;
}

export interface GuardianView {
  role: 'guardian';
  id: string;
  name: string;
  ownerName: string;
  /** This device's proof still leads to the guardians root on the chain. */
  current?: boolean;
  /** This guardian has voted in the current round. */
  voted?: boolean;
  vault?: VaultFacts;
}

export type ActiveView = OwnerView | HeirView | GuardianView;

export interface DeployProgress {
  running: boolean;
  /** Transactions finished, of `total`. */
  done: number;
  total: number;
  /** What is happening right now, in plain words. */
  label: string;
  /** What the transaction in hand is doing: proving, waiting for the wallet, waiting for the network. */
  stage?: CallStage['stage'];
  problem?: Problem;
}

export interface LiveSnapshot {
  now: number;
  network?: string;
  /** Every vault this browser knows, newest first. */
  records: { id: string; role: VaultRecord['role']; title: string; subtitle: string; address?: string; network: string }[];
  activeId?: string;
  active?: ActiveView;
  /** Reading the active vault from the chain. */
  load: { state: 'idle' | 'loading' | 'ready' | 'error'; problem?: Problem };
  deploy?: DeployProgress;
  tx?: LiveTx;
  toast?: Toast;
}

export interface PasskeySigner {
  /** Ask the passkey to approve `digest`: Face ID or Touch ID for a device passkey. */
  approve(passkey: OwnerPasskey, digest: Uint8Array): Promise<WebAuthnAssertion>;
}

export interface LiveDeps {
  storage: RecordStorage;
  passkeys: PasskeySigner;
  /** The hostname passkeys are bound to. Defaults to the page's, or "localhost". */
  rpId?: string;
}

const STAGES: Record<LiveStageId, LiveTxStage> = {
  prepare: { id: 'prepare', label: 'Getting ready', detail: 'Reading the vault and checking your proof server.' },
  approve: { id: 'approve', label: 'Waiting for your passkey', detail: 'Confirm with Face ID, Touch ID or your device PIN. It signs this exact action and nothing else.' },
  proof: { id: 'proof', label: 'Making the proof', detail: 'Your proof server is proving that the vault\'s rules were followed, without revealing your secrets. This can take up to a minute.' },
  wallet: { id: 'wallet', label: 'Waiting for your wallet', detail: 'Approve the transaction in your wallet. It pays the network fee in DUST.' },
  record: { id: 'record', label: 'Waiting for the network', detail: 'The transaction is sent. A block usually includes it within half a minute.' },
};

const mb = (bytes: number): string => `${Math.round(bytes / 1_048_576)} MB`;
const CIRCUIT_WORDS: Record<string, string> = {
  updateSettingsEd25519: 'changing guardians with a wallet key',
  updateSettingsPasskey: 'changing guardians',
  startRecovery: 'starting a recovery',
  finishRecovery: 'finishing a recovery',
  updateWillEd25519: 'changing the will with a wallet key',
  updateWillPasskey: 'changing the will',
  triggerAttestation: 'a signed notice of death',
  guardianAttest: 'guardian votes',
  claimAsBackup: 'backup heirs',
};

export const fmtWhen = (t: number): string =>
  new Date(t * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** "3 days", "1 hour", "10 minutes": a length of time in words. */
export function span(seconds: number): string {
  const n = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`;
  if (seconds >= DAY) return n(Math.round(seconds / DAY), 'day');
  if (seconds >= 3600) return n(Math.round(seconds / 3600), 'hour');
  return n(Math.max(1, Math.round(seconds / 60)), 'minute');
}

function willFrom(leaves: HeirLeaf[]): Will {
  const tree = new MerkleTree(leaves.map((l) => pureCircuits.heirLeafHash(l)));
  return { leaves, tree, root: tree.root };
}

function guardianSetFrom(r: Pick<OwnerRecord, 'guardians' | 'threshold'>): GuardianSet | undefined {
  return r.guardians.length === 0 ? undefined : buildGuardianSet(r.guardians.map((g) => guardianLeaf(g.secret)), r.threshold);
}

export function factsFrom(address: string, l: Ledger, now: number): VaultFacts {
  const switchOpensAt = Number(timeoutOpensAt(l));
  return {
    address,
    phase: l.phase,
    deadline: Number(l.deadline),
    grace: Number(l.gracePeriod),
    switchOpensAt,
    window: Number(l.challengeWindow),
    pendingUntil: Number(l.pendingUntil),
    releasedAt: Number(l.releasedAt),
    claimWindow: Number(l.claimWindow),
    estate: l.estateTotal - l.estatePaid,
    estateSnapshot: l.estateSnapshot,
    estatePaid: l.estatePaid,
    nonce: l.nonce,
    guardianVotes: Number(l.guardianVotes),
    guardianThreshold: Number(l.guardianThreshold),
    guardianRound: l.guardianRound,
    canStartSwitch: l.phase === Phase.armed && now >= switchOpensAt,
    canRelease: l.phase === Phase.pending && now >= Number(l.pendingUntil),
  };
}

export class LiveStore {
  private records: VaultRecord[];
  private activeId?: string;
  private host?: VaultHost;
  private readonly chains = new Map<string, VaultChain>();
  private readonly unsubscribe = new Map<string, () => void>();
  private load: LiveSnapshot['load'] = { state: 'idle' };
  private deployProgress?: DeployProgress;
  private tx?: LiveTx;
  private toast?: Toast;
  private lastAction?: () => Promise<boolean>;
  private clock?: ReturnType<typeof setInterval>;
  private snapshot: LiveSnapshot;
  private listeners = new Set<() => void>();
  /** Words for the wallet in messages: "Lace". */
  walletName = 'your wallet';

  constructor(private readonly deps: LiveDeps) {
    this.records = decodeRecords(deps.storage.load());
    this.activeId = this.records[0]?.id;
    this.snapshot = this.build();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = this.build();
    this.listeners.forEach((fn) => fn());
  }

  private persist() {
    this.deps.storage.save(encodeRecords(this.records));
  }

  private record(id: string | undefined = this.activeId): VaultRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  private update<R extends VaultRecord>(id: string, patch: Partial<R>): R {
    const at = this.records.findIndex((r) => r.id === id);
    if (at < 0) throw new Error('that vault is no longer on this device');
    const next = { ...this.records[at], ...patch } as R;
    this.records = [...this.records.slice(0, at), next, ...this.records.slice(at + 1)];
    this.persist();
    return next;
  }

  private note(id: string, what: string, tone: ActivityEntry['tone'], txHash?: string) {
    const r = this.record(id);
    if (r?.role !== 'owner') return;
    this.update<OwnerRecord>(id, { activity: [{ at: this.now, what, tone, txHash }, ...r.activity].slice(0, 200) });
  }

  private get now(): number {
    return this.host?.now ?? Math.floor(Date.now() / 1000);
  }

  private problemContext() {
    return { network: this.host?.networkId, wallet: this.walletName };
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  /** Use this chain from now on, and read the active vault from it. */
  async attach(host: VaultHost): Promise<void> {
    this.detach();
    this.host = host;
    // Vaults are kept per network. Show one that lives where the wallet is, if there is one.
    if (this.record()?.network !== host.networkId) {
      this.activeId = this.records.find((r) => r.network === host.networkId)?.id ?? this.activeId;
    }
    this.emit();
    await this.open();
  }

  detach() {
    for (const off of this.unsubscribe.values()) off();
    this.unsubscribe.clear();
    this.chains.clear();
    this.host = undefined;
    this.load = { state: 'idle' };
    this.emit();
  }

  /** Re-render once a second, so countdowns move. */
  startClock() {
    this.clock ??= setInterval(() => { if (this.tx?.status !== 'running') this.emit(); }, 1000);
  }

  stopClock() {
    if (this.clock) clearInterval(this.clock);
    this.clock = undefined;
  }

  select(id: string): Promise<void> {
    this.activeId = id;
    this.emit();
    return this.open();
  }

  /** Read the active vault's public state, if it has an address and a chain is attached. */
  async open(id: string | undefined = this.activeId): Promise<void> {
    const r = this.record(id);
    const address = r && recordAddress(r);
    if (!r || !this.host || !address || this.chains.has(r.id)) return;
    if (r.role === 'owner' && !r.deployment?.complete) return;
    if (r.network !== this.host.networkId) {
      this.load = {
        state: 'error',
        problem: { kind: 'wrong-network', title: `This vault is on ${networkName(r.network)}`, body: `It was created on Midnight ${networkName(r.network)}, and your wallet is on ${networkName(this.host.networkId)}. Each test network is a separate chain, so the vault cannot be seen from here. Switch your wallet to ${networkName(r.network)} and connect again.`, retry: false },
      };
      this.emit();
      return;
    }
    this.load = { state: 'loading' };
    this.emit();
    try {
      const chain = await this.host.openVault(address);
      this.chains.set(r.id, chain);
      this.unsubscribe.set(r.id, chain.subscribe(() => this.emit()));
      this.load = { state: 'ready' };
    } catch (e) {
      this.load = { state: 'error', problem: describeProblem(e, this.problemContext()) };
    }
    this.emit();
  }

  // ─── Creating a vault ─────────────────────────────────────────────────────

  /**
   * Seal the will and create the vault. The record, with every key in it, is
   * saved before anything is sent, so nothing typed into the wizard is lost if
   * the deployment is interrupted.
   */
  async createVault(draft: VaultDraft, passkey: OwnerPasskey): Promise<boolean> {
    const problems = draftProblems(draft);
    if (problems.length > 0) throw new InputProblem(problems[0]);
    if (!this.host) throw new Error('connect a wallet first');
    const heirs = draft.heirs.map((h) => {
      const key = newHeirKey();
      const backup = h.backupName !== undefined ? { name: h.backupName.trim(), sk: newHeirKey().sk, keySalt: newSalt() } : undefined;
      return { id: newLocalId(), name: h.name.trim(), shareBps: toBps(h.sharePct), unlockAt: BigInt(h.unlockAt ?? 0), sk: key.sk, keySalt: newSalt(), backup };
    });
    const will = buildWill(heirs.map((h) => ({
      heir: { pk: heirKeyFromScalar(h.sk).pk, salt: h.keySalt },
      backup: h.backup && { pk: heirKeyFromScalar(h.backup.sk).pk, salt: h.backup.keySalt },
      shareBps: h.shareBps,
      unlockAt: h.unlockAt,
    })));
    const record: OwnerRecord = {
      role: 'owner', id: newLocalId(), network: this.host.networkId, createdAt: this.now, ownerName: draft.ownerName.trim(),
      passkey, ownerSalt: newSalt(), timers: { ...draft.timers }, maxPeriod: maxPeriodFor(draft.timers),
      heirs, leaves: will.leaves,
      guardians: draft.guardians.map((name) => ({ id: newLocalId(), name: name.trim(), secret: newGuardianSecret() })),
      threshold: draft.guardians.length === 0 ? 0 : draft.threshold,
      activity: [],
    };
    this.records = [record, ...this.records];
    this.activeId = record.id;
    this.persist();
    this.emit();
    return this.deploy(record.id);
  }

  /** Continue a deployment that was interrupted: the tab was closed, the wallet said no, the network dropped. */
  resumeDeployment(id: string | undefined = this.activeId): Promise<boolean> {
    return id ? this.deploy(id) : Promise.resolve(false);
  }

  private configFor(r: OwnerRecord, firstDeadline: number): VaultConfig {
    const set = guardianSetFrom(r);
    return {
      ownerPasskeyCommit: pureCircuits.passkeyCommitment(r.passkey.pk, r.ownerSalt),
      ownerEdCommit: new Uint8Array(32),
      passkeyRpIdHash: rpIdHash(this.deps.rpId ?? globalThis.location?.hostname ?? 'localhost'),
      willRoot: willFrom(r.leaves).root,
      firstDeadline: BigInt(firstDeadline),
      maxPeriod: BigInt(r.maxPeriod),
      challengeWindow: BigInt(r.timers.window),
      claimWindow: BigInt(claimWindowFor(r.timers)),
      tokenColor: this.host!.tokenColor,
      guardianRoot: set?.root ?? 0n,
      guardianThreshold: set?.threshold ?? 0n,
      attestorKeyCommit: new Uint8Array(32),
      // No release fee and no recovery key in this version of live mode.
      ...VAULT_OPTIONS_OFF,
      gracePeriod: BigInt(r.timers.grace),
    };
  }

  private async deploy(id: string): Promise<boolean> {
    const r = this.record(id);
    if (!r || r.role !== 'owner' || !this.host) return false;
    if (this.deployProgress?.running) return false;
    if (r.deployment?.complete) {
      await this.open(id);
      return true;
    }
    const host = this.host;
    const firstDeadline = this.now + r.timers.every + (r.timers.testing ? DEPLOY_ALLOWANCE : 0);
    const known = r.deployment;
    const total = known ? 1 + known.deferred.length : 8;
    this.deployProgress = {
      running: true, done: known ? (known.deployTxHash ? 1 : 0) + known.inserted.length : 0, total,
      label: known ? 'Checking how far the last attempt got' : 'Sealing your will into the vault',
    };
    this.emit();
    const offStage = host.onStage?.((s) => {
      if (!this.deployProgress?.running) return;
      this.deployProgress = { ...this.deployProgress, stage: s.stage };
      this.emit();
    });
    try {
      const chain = await host.createVault(this.configFor(r, firstDeadline), {
        resume: known,
        onRecord: (d) => {
          const before = this.record(id) as OwnerRecord;
          const sameVault = before.deployment?.address === d.address;
          this.update<OwnerRecord>(id, { deployment: d, firstDeadline: sameVault ? before.firstDeadline ?? firstDeadline : firstDeadline });
          this.deployProgress = { ...this.deployProgress!, done: (d.deployTxHash || d.complete ? 1 : 0) + d.inserted.length, total: 1 + d.deferred.length, stage: undefined };
          this.emit();
        },
        onStage: (s: DeployStage) => {
          this.deployProgress = {
            ...this.deployProgress!, total: s.total, stage: undefined,
            label: s.step === 'deploy'
              ? 'Creating the vault and sealing your will'
              : `Adding the part for ${CIRCUIT_WORDS[s.circuit] ?? s.circuit}`,
            ...(s.step === 'insert' ? { done: s.done } : {}),
          };
          this.emit();
        },
      });
      this.chains.set(id, chain);
      this.unsubscribe.get(id)?.();
      this.unsubscribe.set(id, chain.subscribe(() => this.emit()));
      this.load = { state: 'ready' };
      this.deployProgress = undefined;
      const now = this.now;
      const done = this.update<OwnerRecord>(id, { lastCheckIn: now });
      this.note(id, 'Vault created and will sealed', 'plain', done.deployment?.deployTxHash);
      this.emit();
      return true;
    } catch (e) {
      console.warn('[codicil live] deployment stopped', e);
      this.deployProgress = { ...this.deployProgress!, running: false, stage: undefined, problem: describeProblem(e, this.problemContext()) };
      this.emit();
      return false;
    } finally {
      offStage?.();
    }
  }

  // ─── Transactions ─────────────────────────────────────────────────────────

  /** Runs an action through the progress sheet. Returns true on success. */
  private async run(
    title: string,
    stageIds: LiveStageId[],
    body: (chain: VaultChain, stage: (id: LiveStageId) => void) => Promise<string>,
    explain?: (code: string, l: Ledger) => string | undefined,
  ): Promise<boolean> {
    const id = this.activeId;
    const chain = id ? this.chains.get(id) : undefined;
    if (!chain || !this.host || this.tx?.status === 'running') return false;
    this.lastAction = () => this.run(title, stageIds, body, explain);
    const stages = stageIds.map((s) => ({ ...STAGES[s] }));
    const t0 = performance.now();
    let mark = t0;
    this.tx = { title, stages, current: 0, status: 'running', startedAt: t0, times: [] };
    this.toast = undefined;
    this.emit();
    const stage = (to: LiveStageId, detail?: string) => {
      const at = stages.findIndex((s) => s.id === to);
      if (at < 0 || !this.tx) return;
      if (detail) stages[at] = { ...stages[at], detail };
      if (at !== this.tx.current) {
        const now = performance.now();
        const times = [...this.tx.times];
        times[this.tx.current] = (now - mark) / 1000;
        mark = now;
        this.tx = { ...this.tx, stages: [...stages], current: at, times };
      } else {
        this.tx = { ...this.tx, stages: [...stages] };
      }
      this.emit();
    };
    // What the chain reports while the call is under way moves the sheet along.
    const off = chain.onStage?.((s) => {
      if (s.stage === 'keys') {
        stage('proof', s.total > 0 && s.loaded < s.total
          ? `Fetching the proving key for this action: ${mb(s.loaded)} of ${mb(s.total)}. It is kept on this device, so the next time is quick.`
          : STAGES.proof.detail);
      } else if (s.stage === 'proving') stage('proof');
      else if (s.stage === 'approving') stage('wallet', `Approve the transaction in ${this.walletName}. It pays the network fee in DUST.`);
      else stage('record');
    });
    try {
      await this.host.preflight?.();
      await chain.refresh();
      const message = await body(chain, stage);
      const times = [...this.tx!.times];
      times[this.tx!.current] = (performance.now() - mark) / 1000;
      this.tx = { ...this.tx!, current: stages.length, status: 'done', message, endedAt: performance.now(), times };
      this.emit();
      return true;
    } catch (e) {
      let problem = describeProblem(e, this.problemContext());
      const better = problem.kind === 'contract' && problem.detail ? explain?.(problem.detail, chain.ledger) : undefined;
      if (better) problem = { ...problem, body: better };
      if (problem.kind !== 'contract' && problem.kind !== 'rejected' && problem.kind !== 'input') console.warn('[codicil live]', e);
      this.tx = { ...this.tx!, status: 'error', message: problem.body, code: problem.detail, problem, endedAt: performance.now() };
      this.emit();
      return false;
    } finally {
      off?.();
    }
  }

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

  retry(): Promise<boolean> {
    const again = this.lastAction;
    this.tx = undefined;
    this.emit();
    return again ? again() : Promise.resolve(false);
  }

  /** On a network, "at or after T" is only safe a little after T: the chain's clock trails this device's. */
  private waitedFor(target: number, what: string) {
    const margin = this.host?.kind === 'network' ? CLOCK_MARGIN : 0;
    const left = target + margin - this.now;
    if (left > 0) throw new InputProblem(`${what} in ${left > 90 ? span(left) : `${left} seconds`}. The network's clock runs a little behind yours, so the app waits a few extra seconds to be sure`);
  }

  // ─── The owner ────────────────────────────────────────────────────────────

  checkIn(): Promise<boolean> {
    const r = this.record();
    if (r?.role !== 'owner') return Promise.resolve(false);
    const pending = this.chains.get(r.id)?.ledger.phase === Phase.pending;
    return this.run(pending ? 'Cancelling the switch' : 'Recording your check-in', ['prepare', 'approve', 'proof', 'wallet', 'record'], async (chain, stage) => {
      const before = chain.ledger;
      const next = BigInt(chain.now + r.timers.every);
      const digest = checkInDigest(chain.address, next, before.nonce);
      stage('approve');
      const assertion = await this.deps.passkeys.approve(r.passkey, digest);
      stage('proof');
      const state: CodicilPrivateState = withPasskeyApproval({ passkey: { pk: r.passkey.pk, salt: r.ownerSalt } }, digest, assertion);
      const out = await chain.call('checkInPasskey', state, next);
      const late = before.phase === Phase.armed && chain.now >= Number(before.deadline);
      this.update<OwnerRecord>(r.id, { lastCheckIn: chain.now });
      this.note(r.id, before.phase === Phase.pending ? 'Switch cancelled' : late ? 'Late check-in, inside the grace period' : 'Check-in', 'armed', out.receipt?.txHash);
      const due = `Your next check-in is due by ${fmtWhen(Number(chain.ledger.deadline))}.`;
      return before.phase === Phase.pending ? `The switch is cancelled. ${due}` : `Check-in recorded. ${due}`;
    }, (code, l) => (code === 'switch already expired'
      ? `Your check-in was due by ${fmtWhen(Number(l.deadline))}, so a check-in alone no longer works. Start the switch, then check in to cancel it: you get the full ${span(Number(l.challengeWindow))} to do that.`
      : undefined));
  }

  /** `amount` is in STAR (1,000,000 per tNIGHT). The wallet adds the tokens when it balances the transaction. */
  deposit(amount: bigint): Promise<boolean> {
    const id = this.activeId;
    return this.run('Adding to the estate', ['prepare', 'proof', 'wallet', 'record'], async (chain, stage) => {
      if (amount <= 0n) throw new InputProblem('enter an amount above zero');
      stage('proof');
      const out = await chain.call('deposit', {}, amount);
      if (id) this.note(id, `Deposit of ${formatNight(amount)} tNIGHT`, 'public', out.receipt?.txHash);
      return `${formatNight(amount)} tNIGHT added. The vault now holds ${formatNight(chain.ledger.estateTotal - chain.ledger.estatePaid)} tNIGHT.`;
    });
  }

  // ─── Anyone ───────────────────────────────────────────────────────────────

  /** After the deadline (and any grace period), anyone may start the countdown. */
  startSwitch(): Promise<boolean> {
    const id = this.activeId;
    return this.run('Starting the switch', ['prepare', 'proof', 'wallet', 'record'], async (chain, stage) => {
      const l = chain.ledger;
      if (l.phase === Phase.armed) this.waitedFor(Number(timeoutOpensAt(l)), 'The switch can be started');
      stage('proof');
      const out = await chain.call('triggerTimeout', {});
      if (id) this.note(id, 'Deadline passed and the switch was started', 'pending', out.receipt?.txHash);
      return `The switch has started. The owner can cancel until ${fmtWhen(Number(chain.ledger.pendingUntil))}. After that, anyone can release the will.`;
    });
  }

  /** After the challenge window, anyone may release the will. */
  release(): Promise<boolean> {
    const id = this.activeId;
    return this.run('Releasing the will', ['prepare', 'proof', 'wallet', 'record'], async (chain, stage) => {
      const l = chain.ledger;
      if (l.phase === Phase.pending) this.waitedFor(Number(l.pendingUntil), 'The will can be released');
      stage('proof');
      const out = await chain.call('finalizeRelease', {});
      if (id) this.note(id, 'Challenge window ended and the will was released', 'released', out.receipt?.txHash);
      return 'The will is released. Each heir can now claim their share.';
    });
  }

  // ─── An heir ──────────────────────────────────────────────────────────────

  /** Claim this heir's share to `to`, a 64-character hex address: normally the heir's own wallet. */
  claim(to: string): Promise<boolean> {
    const r = this.record();
    if (r?.role !== 'heir') return Promise.resolve(false);
    return this.run('Claiming your share', ['prepare', 'proof', 'wallet', 'record'], async (chain, stage) => {
      if (!/^[0-9a-f]{64}$/i.test(to)) throw new InputProblem('that is not an address this vault can pay to');
      const letter = decodeHeirLetter(r.letter);
      const state: CodicilPrivateState = { claimant: { leaf: letter.leaf, path: letter.path, key: heirKeyFromScalar(r.sk), keySalt: r.keySalt } };
      const paidBefore = chain.ledger.estatePaid;
      stage('proof');
      const out = await chain.call(r.backup ? 'claimAsBackup' : 'claim', state, { bytes: encodeUserAddress(to.toLowerCase()) });
      const amount = chain.ledger.estatePaid - paidBefore;
      this.update<HeirRecord>(r.id, { claimed: { at: chain.now, amount, to: to.toLowerCase(), txHash: out.receipt?.txHash } });
      return `${formatNight(amount)} tNIGHT is on its way to your wallet.`;
    }, (code, l) => (code === 'primary claim window open'
      ? `You are the backup for this share. Its first heir can claim until ${fmtWhen(Number(l.releasedAt + l.claimWindow))}. If they have not by then, you can.`
      : undefined));
  }

  // ─── A guardian ───────────────────────────────────────────────────────────

  vote(): Promise<boolean> {
    const r = this.record();
    if (r?.role !== 'guardian') return Promise.resolve(false);
    return this.run('Casting your vote', ['prepare', 'proof', 'wallet', 'record'], async (chain, stage) => {
      const round = chain.ledger.guardianRound;
      stage('proof');
      // Stamped a little in the past: the vault accepts a vote whose time is not ahead of the block's.
      await chain.call('guardianAttest', { guardian: { secret: r.secret, path: r.path } }, BigInt(chain.now - CLOCK_MARGIN));
      this.update<GuardianRecord>(r.id, { votedRound: round });
      const l = chain.ledger;
      return l.phase === Phase.pending
        ? `Your vote is recorded. Enough guardians agreed, so the switch has started. ${r.ownerName} can cancel until ${fmtWhen(Number(l.pendingUntil))}.`
        : `Your vote is recorded: ${l.guardianVotes} of ${l.guardianThreshold} so far. Nobody can see who voted.`;
    }, (code) => (code === 'not a guardian'
      ? `You are no longer a guardian of this will: ${r.ownerName} changed the guardians. Your vote was not counted and nothing was recorded.`
      : undefined));
  }

  // ─── Invitations ──────────────────────────────────────────────────────────

  /** What the owner sends an heir (or their backup): one line of text that lets them claim from their own browser. */
  heirKit(heirId: string, backup = false, id: string | undefined = this.activeId): string {
    const r = this.record(id);
    if (r?.role !== 'owner' || !r.deployment?.complete) throw new InputProblem('finish creating the vault first');
    const index = r.heirs.findIndex((h) => h.id === heirId);
    const h = r.heirs[index];
    if (!h || (backup && !h.backup)) throw new InputProblem('that person is not in this will');
    const letter = encodeHeirLetter({ vault: r.deployment.address, ...claimPackage(willFrom(r.leaves), index) });
    const who = backup ? h.backup! : h;
    return encodeKit({ kind: 'heir', network: r.network, name: who.name, ownerName: r.ownerName, letter, sk: who.sk, keySalt: who.keySalt, backup });
  }

  /** What the owner sends a guardian. */
  guardianKit(guardianId: string, id: string | undefined = this.activeId): string {
    const r = this.record(id);
    if (r?.role !== 'owner' || !r.deployment?.complete) throw new InputProblem('finish creating the vault first');
    const g = r.guardians.find((x) => x.id === guardianId);
    const set = guardianSetFrom(r);
    if (!g || !set) throw new InputProblem('that person is not a guardian of this vault');
    return encodeKit({ kind: 'guardian', network: r.network, address: r.deployment.address, name: g.name, ownerName: r.ownerName, ...guardianSecrets(set, g.secret) });
  }

  /** Take an invitation: the text or link an owner sent. Returns the new record's id. */
  async join(text: string): Promise<string> {
    const kit = decodeKit(text);
    if (this.host && kit.network !== this.host.networkId) {
      throw new InputProblem(`that invitation is for a vault on Midnight ${networkName(kit.network)}, and your wallet is on ${networkName(this.host.networkId)}. Switch your wallet to ${networkName(kit.network)} and try again`);
    }
    const address = kit.kind === 'heir' ? decodeHeirLetter(kit.letter).vault : kit.address;
    const existing = this.records.find((r) => (r.role === 'heir' && kit.kind === 'heir' && r.address === address && r.sk === kit.sk)
      || (r.role === 'guardian' && kit.kind === 'guardian' && r.address === address && toHex(r.secret) === toHex(kit.secret)));
    const id = existing?.id ?? newLocalId();
    if (!existing) {
      const record: VaultRecord = kit.kind === 'heir'
        ? { role: 'heir', id, network: kit.network, address, name: kit.name, ownerName: kit.ownerName, letter: kit.letter, sk: kit.sk, keySalt: kit.keySalt, backup: kit.backup }
        : { role: 'guardian', id, network: kit.network, address, name: kit.name, ownerName: kit.ownerName, secret: kit.secret, path: kit.path };
      this.records = [record, ...this.records];
      this.persist();
    } else if (existing.role === 'heir' && kit.kind === 'heir' && existing.letter !== kit.letter) {
      // A new letter for the same person: the owner changed the will.
      this.update<HeirRecord>(id, { letter: kit.letter });
    } else if (existing.role === 'guardian' && kit.kind === 'guardian') {
      this.update<GuardianRecord>(id, { path: kit.path });
    }
    await this.select(id);
    return id;
  }

  /** Remove a vault from this device. The vault itself is untouched; without a backup this copy of its secrets is gone. */
  forget(id: string) {
    this.unsubscribe.get(id)?.();
    this.unsubscribe.delete(id);
    this.chains.delete(id);
    this.records = this.records.filter((r) => r.id !== id);
    if (this.activeId === id) this.activeId = this.records[0]?.id;
    this.persist();
    this.emit();
    void this.open();
  }

  // ─── Backups ──────────────────────────────────────────────────────────────

  /** The text of a backup file holding every vault on this device, locked with `passphrase`. */
  exportBackup(passphrase: string): Promise<string> {
    return exportBackup(this.records, passphrase);
  }

  /** Bring back the vaults in a backup file. Vaults already here are kept. */
  async importBackup(text: string, passphrase: string): Promise<{ added: number; updated: number }> {
    const merged = mergeRecords(this.records, await importBackup(text, passphrase));
    this.records = merged.records;
    this.activeId ??= this.records[0]?.id;
    this.persist();
    this.emit();
    await this.open();
    return { added: merged.added, updated: merged.updated };
  }

  // ─── Snapshot ─────────────────────────────────────────────────────────────

  private build(): LiveSnapshot {
    const now = this.now;
    const active = this.record();
    const chain = active ? this.chains.get(active.id) : undefined;
    const facts = chain ? factsFrom(chain.address, chain.ledger, now) : undefined;
    return {
      now,
      network: this.host?.networkId,
      records: this.records.map((r) => ({
        id: r.id, role: r.role, address: recordAddress(r), network: r.network,
        title: r.role === 'owner' ? 'Your vault' : r.role === 'heir' ? `${r.ownerName}'s will` : `${r.ownerName}'s vault`,
        subtitle: r.role === 'owner' ? `You are the owner${r.deployment?.complete ? '' : ' · not finished'}` : r.role === 'heir' ? (r.backup ? 'You are a backup heir' : 'You are an heir') : 'You are a guardian',
      })),
      activeId: active?.id,
      active: active && this.view(active, chain, facts, now),
      load: this.load,
      deploy: this.deployProgress,
      tx: this.tx,
      toast: this.toast,
    };
  }

  private view(r: VaultRecord, chain: VaultChain | undefined, vault: VaultFacts | undefined, now: number): ActiveView {
    if (r.role === 'owner') {
      return {
        role: 'owner', id: r.id, ownerName: r.ownerName,
        status: r.deployment?.complete ? 'ready' : this.deployProgress?.running ? 'creating' : 'interrupted',
        passkey: r.passkey.kind, timers: r.timers,
        heirs: r.heirs.map((h) => ({
          id: h.id, name: h.name, shareBps: h.shareBps, unlockAt: Number(h.unlockAt), backupName: h.backup?.name,
          keyEnd: heirKeyFromScalar(h.sk).pk.x.toString(16).slice(-4),
        })),
        guardians: r.guardians.map((g) => ({ id: g.id, name: g.name })),
        threshold: r.threshold, firstDeadline: r.firstDeadline, lastCheckIn: r.lastCheckIn,
        checkIn: vault && (now < vault.deadline ? 'onTime' : now < vault.switchOpensAt ? 'grace' : 'expired'),
        activity: r.activity, deployment: r.deployment, vault,
      };
    }
    if (r.role === 'guardian') {
      const l = chain?.ledger;
      return {
        role: 'guardian', id: r.id, name: r.name, ownerName: r.ownerName, vault,
        current: l && isCurrentGuardian({ secret: r.secret, path: r.path }, l.guardianRoot),
        voted: l && l.guardianNullifiers.member(pureCircuits.guardianNullifier(vaultId(r.address), r.secret, l.guardianRound)),
      };
    }
    const letter = decodeHeirLetter(r.letter);
    const base: HeirView = {
      role: 'heir', id: r.id, name: r.name, ownerName: r.ownerName, backup: r.backup,
      shareBps: letter.leaf.shareBps, unlockAt: Number(letter.leaf.unlockAt), claimed: r.claimed, vault,
    };
    const l = chain?.ledger;
    if (!l || !vault) return base;
    const check = checkHeirLetter(letter, { vault: r.address, willRoot: l.willRoot, key: { pk: heirKeyFromScalar(r.sk).pk, salt: r.keySalt } });
    const taken = l.claimNullifiers.member(pureCircuits.claimNullifier(vaultId(r.address), pureCircuits.heirLeafHash(letter.leaf)));
    const opensAt = r.backup ? vault.releasedAt + vault.claimWindow : Math.max(base.unlockAt, vault.releasedAt);
    const status: HeirStatus = r.claimed ? 'claimed'
      : taken ? 'taken'
      : !check.inCurrentWill || check.role === 'none' ? 'stale'
      : l.phase === Phase.armed ? 'locked'
      : l.phase === Phase.pending ? 'pending'
      : now < opensAt ? 'waiting' : 'claimable';
    return {
      ...base, status, opensAt: l.phase === Phase.released ? opensAt : undefined,
      amount: payoutFor(l.phase === Phase.released ? l.estateSnapshot : l.estateTotal, letter.leaf.shareBps),
    };
  }
}
