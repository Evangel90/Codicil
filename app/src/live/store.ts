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
//
// Everything private is encrypted under a key from the person's identity
// root, and the root is kept in a keyring that Face ID or the printed
// recovery code opens (keyring.ts, docs/DECISIONS.md D22). Until it is
// opened the store holds no records at all.

import { encodeUserAddress } from '@midnight-ntwrk/compact-runtime';
import { Phase, pureCircuits, type HeirLeaf, type Ledger, type VaultConfig } from '@codicil/contracts/vault';
import {
  addSlot,
  BoxError,
  boxKeyPair,
  boxSecretFromRoot,
  BPS_TOTAL,
  buildGuardianSet,
  checkHeirLetter,
  checkInDigest,
  claimPackage,
  decodeHeirLetter,
  deriveFromRoot,
  encodeHeirLetter,
  guardianLeaf,
  guardianSecretFromRoot,
  heirKeyFromRoot,
  heirKeyFromScalar,
  isCurrentGuardian,
  keyCommitment,
  keySaltFromRoot,
  lastRecoveryStart,
  MAX_LEAVES,
  MerkleTree,
  newGuardianSecret,
  newHeirKey,
  newKeyring,
  newRoot,
  newSalt,
  openBox,
  payoutFor,
  recoveryCommitment,
  recoveryConfig,
  recoveryStatus,
  rpIdHash,
  sealTo,
  timeoutOpensAt,
  VAULT_OPTIONS_OFF,
  vaultId,
  WALLET_SLOT_MESSAGE,
  walletSecretFromSignature,
  walletSlotSecret,
  withPasskeyApproval,
  type CodicilPrivateState,
  type GuardianSet,
  type HeirKey,
  type Keyring,
  type RecoveryStatus,
  type SlotKind,
  type WebAuthnAssertion,
  type Will,
} from '@codicil/sdk';
import type { CallStage, DeploymentRecord, DeployStage, VaultChain, VaultHost } from '../chain/types.js';
import type { OwnerPasskey } from '../demo/passkey.js';
import { newLocalId, toHex } from './codec.js';
import { backupToText, lock as lockRecords, openWith, readBackup, readStored, storedToText, unlock as unlockRecords, type Locked } from './keyring.js';
import type { PrfRequest, PrfSlot } from './prf.js';
import { describeProblem, InputProblem, type Problem } from './problems.js';
import {
  decodeInvitation, decodeKit, decodeLetterBody, decodeReply, decodeSealedLetter, encodeInvitation, encodeKit, encodeLetterBody,
  encodeReply, encodeSealedLetter, importBackup, letterContext, mergeRecords, newInvitation, recordAddress, recoveryLabel,
  type ActivityEntry, type GuardianRecord, type HeirRecord, type Invitation, type InvitedRecord, type LetterBody, type LiveTimers,
  type OwnerRecord, type RecordStorage, type Reply, type SealedLetter, type VaultRecord,
} from './records.js';
import { formatNight, networkName } from './wallet.js';

export const MINUTE = 60;
export const DAY = 86_400;

/** How long a backup heir waits after release before they may claim. */
const claimWindowFor = (t: LiveTimers): number => (t.testing ? 10 * MINUTE : 30 * DAY);
/**
 * A check-in may set the next deadline up to this far ahead (docs/DECISIONS.md D9).
 * At least two days, because the recovery delay (at least one day) must be shorter.
 */
const maxPeriodFor = (t: LiveTimers): number => (t.testing ? Math.max(2 * t.every, 2 * DAY) : Math.max(2 * t.every, 60 * DAY));
/**
 * The public wait before a recovery takes effect (D18). A quarter of the
 * check-in period, between one and seven days, so a recovery started after a
 * loss can still finish before the deadline. The contract's floor is a day,
 * so with testing timers a recovery cannot finish in time; the app says so.
 */
export const recoveryDelayFor = (t: LiveTimers): number =>
  (t.testing ? DAY : Math.min(7 * DAY, Math.max(DAY, Math.floor(t.every / 4 / DAY) * DAY)));
const ZERO32 = new Uint8Array(32);
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
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
  /** With `keys: 'theirs'`: the reply this heir sent back. */
  reply?: string;
  /** With `keys: 'theirs'`: the reply the backup sent back. */
  backupReply?: string;
}

export interface VaultDraft {
  ownerName: string;
  heirs: HeirDraft[];
  /** Names of the guardians; none is fine. */
  guardians: string[];
  /** With `keys: 'theirs'`: each guardian's reply, entry for entry with `guardians`. */
  guardianReplies?: (string | undefined)[];
  /** How many guardians must agree. Ignored when there are no guardians. */
  threshold: number;
  timers: LiveTimers;
  /**
   * Who makes the heirs' keys and the guardians' secrets. `theirs`: each person
   * on their own device, answering an invitation; the owner never learns them.
   * `mine` (the default): this device, faster, but the owner then knows them.
   */
  keys?: 'theirs' | 'mine';
}

export const emptyDraft = (): VaultDraft => ({
  ownerName: '', heirs: [{ name: '', sharePct: 100 }], guardians: [], threshold: 1, timers: { ...DEFAULT_TIMERS }, keys: 'theirs',
});

/** A reply, read and checked against the role it is pasted for. Throws an `InputProblem`. */
function replyAs(text: string | undefined, role: Reply['role'], who: string): Reply {
  if (!text || text.trim() === '') throw new InputProblem(`Paste the reply from ${who}.`);
  let reply: Reply;
  try {
    reply = decodeReply(text);
  } catch (e) {
    throw new InputProblem(`The reply for ${who}: ${e instanceof Error ? e.message : String(e)}.`);
  }
  if (reply.role !== role) throw new InputProblem(`The reply pasted for ${who} answers ${reply.role === 'heir' ? 'an heir' : 'a guardian'}'s invitation. Paste the one from their ${role === 'heir' ? 'heir' : 'guardian'} invitation.`);
  return reply;
}

/** The problems with the replies in a draft whose people make their own keys: all of them, or one step's. */
export function replyProblems(d: VaultDraft, only?: 'heirs' | 'guardians'): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const check = (text: string | undefined, role: Reply['role'], who: string) => {
    try {
      const r = replyAs(text, role, who);
      if (seen.has(r.inviteId)) out.push(`The reply pasted for ${who} is pasted for someone else too. Each person answers their own invitation.`);
      seen.add(r.inviteId);
    } catch (e) {
      out.push(e instanceof Error ? e.message : String(e));
    }
  };
  if (only !== 'guardians') d.heirs.forEach((h, i) => {
    check(h.reply, 'heir', h.name.trim() || `heir ${i + 1}`);
    if (h.backupName !== undefined) check(h.backupReply, 'heir', h.backupName.trim() || `the backup for ${h.name.trim() || `heir ${i + 1}`}`);
  });
  if (only !== 'heirs') d.guardians.forEach((g, i) => check(d.guardianReplies?.[i], 'guardian', g.trim() || `guardian ${i + 1}`));
  return out;
}

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
  if (d.keys === 'theirs' && out.length === 0) out.push(...replyProblems(d));
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
  /** `ownKey`: the person made their own key, and gets a sealed letter rather than a kit. */
  heirs: { id: string; name: string; shareBps: bigint; unlockAt: number; backupName?: string; keyEnd: string; ownKey: boolean; backupOwnKey?: boolean }[];
  guardians: { id: string; name: string; ownKey: boolean }[];
  threshold: number;
  firstDeadline?: number;
  lastCheckIn?: number;
  checkIn?: CheckInState;
  activity: ActivityEntry[];
  deployment?: DeploymentRecord;
  vault?: VaultFacts;
  /** The recovery key: what replaces a lost passkey. Absent on vaults made before it was required. */
  recovery?: RecoveryView;
}

export interface RecoveryView {
  /** From the SDK's `recoveryStatus()`; `off` until the vault is read. */
  state: RecoveryStatus['state'];
  /** The public wait, seconds. */
  delay: number;
  /** When a recovery in progress takes effect; 0 otherwise. */
  readyAt: number;
  /** The recovery in progress was started from this browser, with a passkey made here. */
  mine: boolean;
  /** The last moment a recovery can start and still finish before the deadline. */
  lastStart: number;
}

/** An invitation this person answered: the reply to send back, and the letter still to come. */
export interface InvitedView {
  role: 'invited';
  id: string;
  name: string;
  ownerName: string;
  invitedAs: 'heir' | 'guardian';
  backup: boolean;
  /** The reply to send to the owner. Holds no secret. */
  reply: string;
}

/** Whether this browser's records are open, and what can open them. */
export interface AccessView {
  /** `new`: nothing set up here yet. `locked`: records here, waiting for Face ID or the code. `open`: in use. */
  state: 'new' | 'locked' | 'open';
  /** The passkeys that can open the records, to ask with Face ID. */
  passkeys: PrfRequest[];
  code: boolean;
  wallet: boolean;
  /** Vaults kept here before records were locked. They are locked when this browser is set up. */
  legacy: number;
  /** This person has a passkey that signs check-ins. */
  signer?: OwnerPasskey['kind'];
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

export type ActiveView = OwnerView | HeirView | GuardianView | InvitedView;

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
  access: AccessView;
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

/**
 * A will from key fingerprints alone: what the owner holds when heirs made
 * their own keys. The same checks and the same leaves as the SDK's `buildWill`.
 */
function willFromCommits(entries: readonly { heir: Uint8Array; backup?: Uint8Array; shareBps: bigint; unlockAt: bigint }[]): Will {
  if (entries.length === 0) throw new InputProblem('a will needs at least one heir');
  if (entries.length > MAX_LEAVES) throw new InputProblem(`a will can have at most ${MAX_LEAVES} heirs`);
  const total = entries.reduce((sum, e) => sum + e.shareBps, 0n);
  if (entries.some((e) => e.shareBps <= 0n || e.shareBps > BPS_TOTAL) || total > BPS_TOTAL) throw new InputProblem('the shares must each be above 0% and add up to at most 100%');
  return willFrom(entries.map((e) => ({ heirKeyCommit: e.heir, backupKeyCommit: e.backup ?? ZERO32, shareBps: e.shareBps, unlockAt: e.unlockAt, salt: newSalt() })));
}

const guardianLeafOf = (g: OwnerRecord['guardians'][number]): Uint8Array => g.leaf ?? guardianLeaf(g.secret!);

function guardianSetFrom(r: Pick<OwnerRecord, 'guardians' | 'threshold'>): GuardianSet | undefined {
  return r.guardians.length === 0 ? undefined : buildGuardianSet(r.guardians.map(guardianLeafOf), r.threshold);
}

/** What an invitee's root gives for one invitation. */
function inviteeKeys(root: Uint8Array, inviteId: string) {
  return {
    heir: heirKeyFromRoot(root, inviteId),
    salt: keySaltFromRoot(root, inviteId),
    guardianSecret: guardianSecretFromRoot(root, inviteId),
    box: boxKeyPair(boxSecretFromRoot(root, inviteId)),
  };
}

/**
 * @param margin seconds to wait past a time before saying "now you can": 0 on
 * the in-memory chain, `CLOCK_MARGIN` on a network, whose clock trails ours
 */
export function factsFrom(address: string, l: Ledger, now: number, margin = 0): VaultFacts {
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
    canStartSwitch: l.phase === Phase.armed && now >= switchOpensAt + margin,
    canRelease: l.phase === Phase.pending && now >= Number(l.pendingUntil) + margin,
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
  /** The identity root, while the records are open. Never stored as it is. */
  private root?: Uint8Array;
  private keyring?: Keyring;
  /** The encrypted records, until they are opened. */
  private locked?: Locked;
  /** Plain records from before the keyring; locked when this browser is set up. */
  private legacy: VaultRecord[] = [];
  /** The passkey this person signs check-ins with. */
  private passkey?: OwnerPasskey;
  /** Writes happen one after another; encrypting takes a moment. */
  private writing: Promise<void> = Promise.resolve();
  /** Keys rebuilt from the root, kept so a second's re-render does not redo them. */
  private derived = new Map<string, ReturnType<typeof inviteeKeys>>();

  constructor(private readonly deps: LiveDeps) {
    const text = deps.storage.load();
    const stored = readStored(text);
    // Text that is there but cannot be read is set aside, never written over.
    if (stored.kind === 'empty' && text && text.trim()) deps.storage.keepAside?.(text);
    this.records = [];
    if (stored.kind === 'locked') {
      this.locked = stored.locked;
      this.keyring = stored.locked.keyring;
    } else if (stored.kind === 'plain') {
      this.legacy = stored.records;
    }
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

  /**
   * Encrypt and save every record. Writes are queued in order; `saved()`
   * resolves once the last one is on disk. Nothing is written while the
   * records are not open: there is no key to encrypt them with.
   */
  private persist(): Promise<void> {
    const { root, keyring } = this;
    if (!root || !keyring) return this.writing;
    const payload = { records: this.records, passkey: this.passkey };
    this.writing = this.writing
      .then(async () => { this.deps.storage.save(storedToText(await lockRecords(root, keyring, payload))); })
      .catch((e: unknown) => { console.warn('[codicil live] could not save', e); });
    return this.writing;
  }

  /** Resolves once everything changed so far is saved. */
  saved(): Promise<void> {
    return this.writing;
  }

  private requireOpen(): Uint8Array {
    if (!this.root) throw new InputProblem(this.keyring ? 'unlock your records first' : 'set up this browser first');
    return this.root;
  }

  /** The root a record's keys come from: its own, if it was restored from another keyring, or this browser's. */
  private rootFor(r: VaultRecord): Uint8Array {
    return r.root ?? this.requireOpen();
  }

  private inviteeKeysFor(r: VaultRecord, inviteId: string) {
    const root = this.rootFor(r);
    const key = `${toHex(root.subarray(0, 8))}:${inviteId}`;
    let keys = this.derived.get(key);
    if (!keys) this.derived.set(key, keys = inviteeKeys(root, inviteId));
    return keys;
  }

  /** An heir's key: from their kit, or rebuilt from their root. */
  private heirKeyOf(r: HeirRecord): { key: HeirKey; salt: Uint8Array } {
    if (r.sk !== undefined && r.keySalt) return { key: heirKeyFromScalar(r.sk), salt: r.keySalt };
    if (!r.inviteId) throw new Error('this record has no key');
    const k = this.inviteeKeysFor(r, r.inviteId);
    return { key: k.heir, salt: k.salt };
  }

  private guardianSecretOf(r: GuardianRecord): Uint8Array {
    if (r.secret) return r.secret;
    if (!r.inviteId) throw new Error('this record has no secret');
    return this.inviteeKeysFor(r, r.inviteId).guardianSecret;
  }

  // ─── The keyring ──────────────────────────────────────────────────────────

  /**
   * Set this browser up: a new identity root, opened by the printed recovery
   * code and, when the browser and passkey support it, by Face ID. The
   * records kept here before (in plain text) are locked with it now.
   *
   * @param code the recovery code's 16 bytes, already shown to the person and confirmed
   * @param passkey the passkey made for this person, which also signs check-ins
   * @param prf what the passkey answered for its keyring slot; absent when it cannot
   */
  async setUp({ code, passkey, prf }: { code: Uint8Array; passkey?: OwnerPasskey; prf?: PrfSlot }): Promise<void> {
    if (this.root || this.keyring) throw new InputProblem('this browser is already set up. Unlock it instead');
    const root = newRoot();
    let ring = await newKeyring(root, { kind: 'recovery-code', secret: code, label: 'Printed recovery code' });
    if (prf) ring = await addSlot(ring, root, { kind: 'passkey', secret: prf.secret, label: 'Passkey', credentialId: prf.credentialId, prfInput: prf.prfInput });
    this.root = root;
    this.keyring = ring;
    this.passkey = passkey;
    this.records = [...this.legacy];
    this.legacy = [];
    this.pickActive();
    await this.persist();
    this.emit();
    await this.open();
  }

  /** Open the records with one of the keyring's ways in. A recovery code may be given as the text the person typed. */
  async unlock(kind: SlotKind, secret: Uint8Array | string): Promise<void> {
    if (this.root) return;
    if (!this.locked) throw new InputProblem('there is nothing locked in this browser');
    const root = await openWith(this.locked.keyring, kind, secret);
    const opened = await unlockRecords(root, this.locked);
    this.root = root;
    this.records = opened.records;
    this.passkey = opened.passkey;
    this.locked = undefined;
    this.pickActive();
    this.emit();
    await this.open();
  }

  /** Lock the records again: they stay saved, and the root leaves memory. */
  async lock(): Promise<void> {
    if (!this.root || !this.keyring) return;
    await this.persist();
    this.locked = await lockRecords(this.root, this.keyring, { records: this.records, passkey: this.passkey });
    this.root = undefined;
    this.records = [];
    this.passkey = undefined;
    this.derived.clear();
    for (const off of this.unsubscribe.values()) off();
    this.unsubscribe.clear();
    this.chains.clear();
    this.activeId = undefined;
    this.emit();
  }

  /** Let this passkey open the records too, for example a new one made during a recovery. */
  async addPasskeySlot(prf: PrfSlot, label = 'Passkey'): Promise<void> {
    const root = this.requireOpen();
    if (this.keyring!.slots.some((s) => s.kind === 'passkey' && s.credentialId === prf.credentialId)) return;
    this.keyring = await addSlot(this.keyring!, root, { kind: 'passkey', secret: prf.secret, label, credentialId: prf.credentialId, prfInput: prf.prfInput });
    await this.persist();
    this.emit();
  }

  /**
   * Let the wallet open the records too. It signs a fixed sentence twice; only
   * a wallet that gives the same signature both times can be used, or it
   * could not open them later.
   */
  async addWalletSlot(sign: (message: string) => Promise<Uint8Array>, address: string): Promise<void> {
    const root = this.requireOpen();
    const first = await sign(WALLET_SLOT_MESSAGE);
    const second = await sign(WALLET_SLOT_MESSAGE);
    let secret: Uint8Array;
    try {
      secret = walletSlotSecret(first, second);
    } catch {
      throw new InputProblem(`${this.walletName} signs the same words differently each time, so it cannot be used to open your records. Face ID and your printed recovery code still work`);
    }
    this.keyring = await addSlot(this.keyring!, root, { kind: 'wallet', secret, label: `${this.walletName} wallet`, walletAddress: address });
    await this.persist();
    this.emit();
  }

  async unlockWithWallet(sign: (message: string) => Promise<Uint8Array>): Promise<void> {
    return this.unlock('wallet', walletSecretFromSignature(await sign(WALLET_SLOT_MESSAGE)));
  }

  private pickActive() {
    const here = this.host ? this.records.find((r) => r.network === this.host!.networkId) : undefined;
    this.activeId = here?.id ?? this.records[0]?.id;
  }

  private accessView(): AccessView {
    const ring = this.keyring;
    return {
      state: this.root ? 'open' : ring ? 'locked' : 'new',
      passkeys: ring?.slots.filter((s) => s.kind === 'passkey' && s.credentialId && s.prfInput).map((s) => ({ credentialId: s.credentialId!, prfInput: s.prfInput! })) ?? [],
      code: ring?.slots.some((s) => s.kind === 'recovery-code') ?? false,
      wallet: ring?.slots.some((s) => s.kind === 'wallet') ?? false,
      legacy: this.legacy.length,
      signer: this.passkey?.kind,
    };
  }

  /** The passkey this person signs with, if they made one here: the wizard offers it. */
  signer(): OwnerPasskey | undefined {
    return this.passkey;
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
    if (!r) return;
    this.update<VaultRecord>(id, { activity: [{ at: this.now, what, tone, txHash }, ...(r.activity ?? [])].slice(0, 200) });
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
    this.requireOpen();
    const problems = draftProblems(draft);
    if (problems.length > 0) throw new InputProblem(problems[0]);
    if (!this.host) throw new Error('connect a wallet first');
    const theirs = draft.keys === 'theirs';
    const invitee = (r: Reply) => ({ inviteId: r.inviteId, boxPublicKey: r.boxPublicKey });
    // Each heir's fingerprint, and what the owner keeps to reach them: a kit's key, or the reply's public key.
    const people = draft.heirs.map((h, i) => {
      const name = h.name.trim();
      const base = { id: newLocalId(), name, shareBps: toBps(h.sharePct), unlockAt: BigInt(h.unlockAt ?? 0) };
      if (theirs) {
        const reply = replyAs(h.reply, 'heir', name || `heir ${i + 1}`);
        const backupReply = h.backupName !== undefined ? replyAs(h.backupReply, 'heir', h.backupName.trim()) : undefined;
        return {
          secret: { ...base, invitee: invitee(reply), backup: backupReply && { name: h.backupName!.trim(), invitee: invitee(backupReply) } },
          heirCommit: reply.heirKeyCommit!, backupCommit: backupReply?.heirKeyCommit,
        };
      }
      const key = { sk: newHeirKey().sk, keySalt: newSalt() };
      const backup = h.backupName !== undefined ? { name: h.backupName.trim(), sk: newHeirKey().sk, keySalt: newSalt() } : undefined;
      return {
        secret: { ...base, ...key, backup },
        heirCommit: keyCommitment({ pk: heirKeyFromScalar(key.sk).pk, salt: key.keySalt }),
        backupCommit: backup && keyCommitment({ pk: heirKeyFromScalar(backup.sk).pk, salt: backup.keySalt }),
      };
    });
    const will = willFromCommits(people.map((p) => ({ heir: p.heirCommit, backup: p.backupCommit, shareBps: p.secret.shareBps, unlockAt: p.secret.unlockAt })));
    const guardians = draft.guardians.map((g, i) => {
      const name = g.trim();
      if (!theirs) return { id: newLocalId(), name, secret: newGuardianSecret() };
      const reply = replyAs(draft.guardianReplies?.[i], 'guardian', name);
      return { id: newLocalId(), name, leaf: reply.guardianLeaf!, invitee: invitee(reply) };
    });
    const record: OwnerRecord = {
      role: 'owner', id: newLocalId(), network: this.host.networkId, createdAt: this.now, ownerName: draft.ownerName.trim(),
      passkey, ownerSalt: newSalt(), timers: { ...draft.timers }, maxPeriod: maxPeriodFor(draft.timers),
      heirs: people.map((p) => p.secret), leaves: will.leaves,
      guardians,
      threshold: draft.guardians.length === 0 ? 0 : draft.threshold,
      recoveryDelay: recoveryDelayFor(draft.timers),
      recoveryGeneration: 0,
      activity: [],
    };
    this.records = [record, ...this.records];
    this.activeId = record.id;
    // The passkey this vault signs with is the person's own from now on.
    this.passkey ??= passkey;
    await this.persist();
    this.emit();
    return this.deploy(record.id);
  }

  // ─── The recovery key ─────────────────────────────────────────────────────

  /**
   * The vault's recovery secret, rebuilt from the owner's root. The first is
   * the one the vault was created with; each finished recovery installs the
   * next. Nothing about it is stored: the printed recovery code opens the
   * root, and the root gives the secret.
   */
  private recoverySecret(r: OwnerRecord, generation = r.recoveryGeneration ?? 0): Uint8Array {
    return deriveFromRoot(this.rootFor(r), recoveryLabel(r.id, generation));
  }

  /**
   * Which of the owner's recovery secrets the vault holds now. Looks a few
   * ahead, in case this record was restored from a backup made before a
   * recovery finished.
   */
  private currentRecovery(r: OwnerRecord, l: Ledger): { generation: number; secret: Uint8Array } | undefined {
    const from = r.recoveryGeneration ?? 0;
    for (let g = from; g < from + 8; g++) {
      const secret = this.recoverySecret(r, g);
      if (sameBytes(recoveryCommitment(secret), l.recoveryKeyCommit)) return { generation: g, secret };
    }
    return undefined;
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
      // No release fee in this version of live mode.
      ...VAULT_OPTIONS_OFF,
      gracePeriod: BigInt(r.timers.grace),
      // A recovery key, always, so the vault never depends on the passkey alone (D18, D22).
      // Records from before it was required have no delay and keep none.
      ...(r.recoveryDelay ? recoveryConfig(this.recoverySecret(r, 0), BigInt(r.recoveryDelay), BigInt(r.maxPeriod)) : {}),
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
          // Saved before the host sends the next transaction.
          return this.saved();
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
      const recoveryStood = ['waiting', 'ready'].includes(recoveryStatus(before, BigInt(chain.now)).state);
      const out = await chain.call('checkInPasskey', state, next);
      const late = before.phase === Phase.armed && chain.now >= Number(before.deadline);
      this.update<OwnerRecord>(r.id, { lastCheckIn: chain.now, pendingRecovery: undefined });
      this.note(r.id, before.phase === Phase.pending ? 'Switch cancelled' : late ? 'Late check-in, inside the grace period' : 'Check-in', 'armed', out.receipt?.txHash);
      if (recoveryStood) this.note(r.id, 'Recovery cancelled, and the recovery key retired', 'armed');
      const due = `Your next check-in is due by ${fmtWhen(Number(chain.ledger.deadline))}.`;
      const cancelled = recoveryStood ? ' It also cancelled the recovery that was in progress. That recovery key can no longer be used.' : '';
      return (before.phase === Phase.pending ? `The switch is cancelled. ${due}` : `Check-in recorded. ${due}`) + cancelled;
    }, (code, l) => (code === 'switch already expired'
      ? `Your check-in was due by ${fmtWhen(Number(l.deadline))}, so a check-in alone no longer works. Start the switch, then check in to cancel it: you get the full ${span(Number(l.challengeWindow))} to do that.`
      : code === 'unknown owner key'
        ? 'This passkey no longer owns the vault. A recovery replaced it. Check in from the device that holds the new passkey.'
        : undefined));
  }

  /**
   * "I lost my passkey": prove the recovery secret, rebuilt from the root the
   * printed code opened, and propose `passkey` (made on this device) as the
   * new owner key. It takes over after the vault's public recovery delay,
   * unless the current passkey signs anything first (D18).
   */
  startRecovery(passkey: OwnerPasskey): Promise<boolean> {
    const r = this.record();
    if (r?.role !== 'owner') return Promise.resolve(false);
    return this.run('Starting a recovery', ['prepare', 'proof', 'wallet', 'record'], async (chain, stage) => {
      const l = chain.ledger;
      if (l.recoveryKeyCommit.every((b) => b === 0)) throw new InputProblem('this vault was created without a recovery key, so it cannot be recovered. Nothing was sent');
      const current = this.currentRecovery(r, l);
      if (!current) throw new InputProblem('the recovery key this vault holds is not one your records can rebuild. Restore the backup file of the browser that created the vault, then try again. Nothing was sent');
      const salt = newSalt();
      const generation = current.generation + 1;
      stage('proof');
      const out = await chain.call(
        'startRecovery', { recovery: { secret: current.secret } },
        pureCircuits.passkeyCommitment(passkey.pk, salt), ZERO32, recoveryCommitment(this.recoverySecret(r, generation)),
        // Stamped a little in the past: the vault accepts a time that is not ahead of the block's.
        BigInt(chain.now - (this.host?.kind === 'network' ? CLOCK_MARGIN : 0)),
      );
      this.update<OwnerRecord>(r.id, { pendingRecovery: { passkey, salt, generation, startedAt: chain.now } });
      const readyAt = Number(chain.ledger.recoveryReadyAt);
      this.note(r.id, `Recovery started: the new passkey takes over on ${fmtWhen(readyAt)}`, 'pending', out.receipt?.txHash);
      return `Recovery started. Your new passkey takes over on ${fmtWhen(readyAt)}, once you finish the recovery from here. If your old passkey signs anything before then, the recovery is cancelled.`;
    }, (code, l) => {
      if (code === 'too late to recover') return `A recovery takes ${span(Number(l.recoveryDelay))}, and the next check-in is due on ${fmtWhen(Number(l.deadline))}, so it could not finish in time. It had to start by ${fmtWhen(Number(lastRecoveryStart(l)))}. Nothing was sent. Without a check-in, the will goes to your heirs as written.`;
      if (code === 'not armed') return 'The switch has started, and a recovery does nothing while it runs. Only the current passkey can cancel it. Nothing was sent.';
      if (code === 'switch already expired') return 'The check-in deadline has passed, and a recovery only works before it. Nothing was sent.';
      if (code === 'recovery key retired') return 'An earlier recovery was cancelled by a check-in, and that retired the recovery key for good. Nothing was sent.';
      if (code === 'stale timestamp') return 'A recovery was started a moment ago. Wait a minute and try again.';
      if (code === 'unknown recovery key') return 'That recovery key is not this vault\'s. Nothing was sent.';
      return undefined;
    });
  }

  /** Once the recovery delay is over, install the new passkey. Anyone may send it; what it installs was fixed at the start. */
  finishRecovery(): Promise<boolean> {
    const id = this.activeId;
    return this.run('Finishing the recovery', ['prepare', 'proof', 'wallet', 'record'], async (chain, stage) => {
      const l = chain.ledger;
      if (l.recoveryReadyAt > 0n) this.waitedFor(Number(l.recoveryReadyAt), 'The recovery can be finished');
      stage('proof');
      const out = await chain.call('finishRecovery', {});
      const r = this.record(id);
      const p = r?.role === 'owner' ? r.pendingRecovery : undefined;
      if (r?.role === 'owner' && p && sameBytes(chain.ledger.ownerPasskeyCommit, pureCircuits.passkeyCommitment(p.passkey.pk, p.salt))) {
        this.update<OwnerRecord>(r.id, { passkey: p.passkey, ownerSalt: p.salt, recoveryGeneration: p.generation, pendingRecovery: undefined });
        this.passkey = p.passkey;
        void this.persist();
        this.note(r.id, 'Recovery finished: the new passkey owns the vault', 'armed', out.receipt?.txHash);
        return 'The recovery is finished. The passkey on this device now owns the vault, and the old one no longer works. Your check-in deadline did not move.';
      }
      if (id) this.note(id, 'A recovery was finished', 'pending', out.receipt?.txHash);
      return 'The recovery is finished. The keys it proposed now own the vault.';
    }, (code, l) => {
      if (code === 'recovery delay open') return `The recovery delay runs until ${fmtWhen(Number(l.recoveryReadyAt))}.`;
      if (code === 'recovery cancelled') return 'The current passkey signed something after the recovery started, which cancelled it. It cannot be finished.';
      if (code === 'not armed') return 'A recovery cannot finish while the switch is running.';
      if (code === 'switch already expired') return 'The check-in deadline passed before the recovery was finished, so it can no longer finish.';
      return undefined;
    });
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
      const { key, salt } = this.heirKeyOf(r);
      const state: CodicilPrivateState = { claimant: { leaf: letter.leaf, path: letter.path, key, keySalt: salt } };
      const paidBefore = chain.ledger.estatePaid;
      stage('proof');
      const out = await chain.call(r.backup ? 'claimAsBackup' : 'claim', state, { bytes: encodeUserAddress(to.toLowerCase()) });
      const amount = chain.ledger.estatePaid - paidBefore;
      this.update<HeirRecord>(r.id, { claimed: { at: chain.now, amount, to: to.toLowerCase(), txHash: out.receipt?.txHash } });
      this.note(r.id, `Share claimed: ${formatNight(amount)} tNIGHT`, 'released', out.receipt?.txHash);
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
      const out = await chain.call('guardianAttest', { guardian: { secret: this.guardianSecretOf(r), path: r.path } }, BigInt(chain.now - CLOCK_MARGIN));
      this.update<GuardianRecord>(r.id, { votedRound: round });
      this.note(r.id, 'Vote cast', 'pending', out.receipt?.txHash);
      const l = chain.ledger;
      return l.phase === Phase.pending
        ? `Your vote is recorded. Enough guardians agreed, so the switch has started. ${r.ownerName} can cancel until ${fmtWhen(Number(l.pendingUntil))}.`
        : `Your vote is recorded: ${l.guardianVotes} of ${l.guardianThreshold} so far. Nobody can see who voted.`;
    }, (code) => (code === 'not a guardian'
      ? `You are no longer a guardian of this will: ${r.ownerName} changed the guardians. Your vote was not counted and nothing was recorded.`
      : undefined));
  }

  // ─── Invitations: the owner ───────────────────────────────────────────────

  /**
   * An invitation for someone to make their own keys: an heir, a backup heir
   * or a guardian. It holds no secret, so it can be sent any way at all.
   */
  makeInvitation(role: Invitation['role'], name: string, ownerName: string, backup = false): string {
    this.requireOpen();
    if (!this.host) throw new InputProblem('connect a wallet first');
    if (ownerName.trim() === '') throw new InputProblem('add your name first: the invitation says who it is from');
    if (name.trim() === '') throw new InputProblem('give this person a name first');
    return encodeInvitation(newInvitation({ network: this.host.networkId, ownerName: ownerName.trim(), role, name: name.trim(), backup }));
  }

  /** What the owner sends an heir (or their backup) whose key this device made: one line that lets them claim. */
  heirKit(heirId: string, backup = false, id: string | undefined = this.activeId): string {
    const r = this.record(id);
    if (r?.role !== 'owner' || !r.deployment?.complete) throw new InputProblem('finish creating the vault first');
    const index = r.heirs.findIndex((h) => h.id === heirId);
    const h = r.heirs[index];
    if (!h || (backup && !h.backup)) throw new InputProblem('that person is not in this will');
    const who = backup ? h.backup! : h;
    if (who.sk === undefined || !who.keySalt) throw new InputProblem(`${who.name} made their own key. Send them their sealed letter instead`);
    const letter = encodeHeirLetter({ vault: r.deployment.address, ...claimPackage(willFrom(r.leaves), index) });
    return encodeKit({ kind: 'heir', network: r.network, name: who.name, ownerName: r.ownerName, letter, sk: who.sk, keySalt: who.keySalt, backup });
  }

  /** What the owner sends a guardian whose secret this device made. */
  guardianKit(guardianId: string, id: string | undefined = this.activeId): string {
    const r = this.record(id);
    if (r?.role !== 'owner' || !r.deployment?.complete) throw new InputProblem('finish creating the vault first');
    const index = r.guardians.findIndex((x) => x.id === guardianId);
    const g = r.guardians[index];
    const set = guardianSetFrom(r);
    if (!g || !set) throw new InputProblem('that person is not a guardian of this vault');
    if (!g.secret) throw new InputProblem(`${g.name} made their own secret. Send them their sealed letter instead`);
    return encodeKit({ kind: 'guardian', network: r.network, address: r.deployment.address, name: g.name, ownerName: r.ownerName, secret: g.secret, path: set.tree.pathFor(index) });
  }

  /**
   * The letter for someone who made their own keys: their heir letter, or
   * their proof as a guardian, sealed to the encryption key in their reply.
   * Only they can open it, so it can be sent any way at all.
   */
  async sealedLetter(personId: string, backup = false, id: string | undefined = this.activeId): Promise<string> {
    const r = this.record(id);
    if (r?.role !== 'owner' || !r.deployment?.complete) throw new InputProblem('finish creating the vault first');
    let body: LetterBody;
    let invitee;
    const heirAt = r.heirs.findIndex((h) => h.id === personId);
    if (heirAt >= 0) {
      const h = r.heirs[heirAt];
      if (backup && !h.backup) throw new InputProblem('that person is not in this will');
      const who = backup ? h.backup! : h;
      invitee = who.invitee;
      const letter = encodeHeirLetter({ vault: r.deployment.address, ...claimPackage(willFrom(r.leaves), heirAt) });
      body = { kind: 'heir', network: r.network, ownerName: r.ownerName, name: who.name, letter, backup };
    } else {
      const at = r.guardians.findIndex((g) => g.id === personId);
      const set = guardianSetFrom(r);
      if (at < 0 || !set) throw new InputProblem('that person is not in this vault');
      invitee = r.guardians[at].invitee;
      body = { kind: 'guardian', network: r.network, ownerName: r.ownerName, name: r.guardians[at].name, address: r.deployment.address, path: set.tree.pathFor(at) };
    }
    if (!invitee) throw new InputProblem(`this device made ${body.name}'s keys. Send them their invitation instead`);
    const box = await sealTo(invitee.boxPublicKey, encodeLetterBody(body), letterContext(invitee.inviteId));
    return encodeSealedLetter({ kind: 'letter', inviteId: invitee.inviteId, box });
  }

  // ─── Invitations: the person invited ──────────────────────────────────────

  /**
   * Take what an owner sent: an invitation, a sealed letter, or a kit (the
   * text, or a link that carries it). Returns the record's id.
   */
  async join(text: string): Promise<string> {
    this.requireOpen();
    const invitation = decodeInvitation(text);
    if (invitation) return this.acceptInvitation(invitation);
    const sealed = decodeSealedLetter(text);
    if (sealed) return this.openLetter(sealed);
    const kit = decodeKit(text);
    this.checkNetwork(kit.network);
    const address = kit.kind === 'heir' ? decodeHeirLetter(kit.letter).vault : kit.address;
    const existing = this.records.find((r) => (r.role === 'heir' && kit.kind === 'heir' && r.address === address && r.sk === kit.sk)
      || (r.role === 'guardian' && kit.kind === 'guardian' && r.address === address && r.secret && toHex(r.secret) === toHex(kit.secret)));
    const id = existing?.id ?? newLocalId();
    if (!existing) {
      const record: VaultRecord = kit.kind === 'heir'
        ? { role: 'heir', id, network: kit.network, address, name: kit.name, ownerName: kit.ownerName, letter: kit.letter, sk: kit.sk, keySalt: kit.keySalt, backup: kit.backup }
        : { role: 'guardian', id, network: kit.network, address, name: kit.name, ownerName: kit.ownerName, secret: kit.secret, path: kit.path };
      this.records = [record, ...this.records];
      void this.persist();
    } else if (existing.role === 'heir' && kit.kind === 'heir' && existing.letter !== kit.letter) {
      // A new letter for the same person: the owner changed the will.
      this.update<HeirRecord>(id, { letter: kit.letter });
    } else if (existing.role === 'guardian' && kit.kind === 'guardian') {
      this.update<GuardianRecord>(id, { path: kit.path });
    }
    await this.saved();
    await this.select(id);
    return id;
  }

  private checkNetwork(network: string) {
    if (this.host && network !== this.host.networkId) {
      throw new InputProblem(`that invitation is for a vault on Midnight ${networkName(network)}, and your wallet is on ${networkName(this.host.networkId)}. Switch your wallet to ${networkName(network)} and try again`);
    }
  }

  private byInvite(inviteId: string): VaultRecord | undefined {
    return this.records.find((r) => (r.role === 'invited' || r.role === 'heir' || r.role === 'guardian') && r.inviteId === inviteId);
  }

  private async acceptInvitation(inv: Invitation): Promise<string> {
    this.checkNetwork(inv.network);
    const existing = this.byInvite(inv.id);
    if (!existing) {
      const record: InvitedRecord = {
        role: 'invited', id: newLocalId(), network: inv.network, inviteId: inv.id, invitedAs: inv.role,
        name: inv.name, ownerName: inv.ownerName, backup: inv.backup,
      };
      this.records = [record, ...this.records];
      await this.persist();
    }
    await this.select(existing?.id ?? this.records[0].id);
    return this.activeId!;
  }

  /**
   * The reply to an invitation: fingerprints of this person's own keys, made
   * from their root for this invitation alone, and their public encryption
   * key. Nothing in it lets anyone act as them.
   */
  replyFor(id: string | undefined = this.activeId): string {
    const r = this.record(id);
    if (!r || r.role === 'owner' || !r.inviteId) throw new InputProblem('there is no invitation to answer here');
    const role = r.role === 'invited' ? r.invitedAs : r.role;
    const k = this.inviteeKeysFor(r, r.inviteId);
    return encodeReply({
      kind: 'reply', inviteId: r.inviteId, role, name: r.name, boxPublicKey: k.box.publicKey,
      ...(role === 'heir' ? { heirKeyCommit: keyCommitment({ pk: k.heir.pk, salt: k.salt }) } : { guardianLeaf: guardianLeaf(k.guardianSecret) }),
    });
  }

  private async openLetter(sealed: SealedLetter): Promise<string> {
    const r = this.byInvite(sealed.inviteId);
    if (!r || r.role === 'owner' || !r.inviteId) {
      throw new InputProblem('this letter answers an invitation this browser has not seen. Open the invitation first, or restore the backup file from the browser that answered it');
    }
    const k = this.inviteeKeysFor(r, r.inviteId);
    let body: LetterBody;
    try {
      body = decodeLetterBody(await openBox(k.box, sealed.box, letterContext(sealed.inviteId)));
    } catch (e) {
      if (e instanceof BoxError) throw new InputProblem('this letter is not for you, or it was changed on the way. Ask the owner to send it again');
      throw e;
    }
    this.checkNetwork(body.network);
    const common = { id: r.id, network: body.network, name: r.name, ownerName: body.ownerName, inviteId: r.inviteId, activity: r.activity, ...(r.root ? { root: r.root } : {}) };
    let next: VaultRecord;
    if (body.kind === 'heir') {
      const letter = decodeHeirLetter(body.letter);
      const mine = keyCommitment({ pk: k.heir.pk, salt: k.salt });
      if (!sameBytes(letter.leaf.heirKeyCommit, mine) && !sameBytes(letter.leaf.backupKeyCommit, mine)) {
        throw new InputProblem('this letter is for you, but the will it carries does not name your key. Ask the owner to paste your reply again and send a new letter');
      }
      next = { ...common, role: 'heir', address: letter.vault, letter: body.letter, backup: sameBytes(letter.leaf.backupKeyCommit, mine), ...(r.role === 'heir' && r.claimed ? { claimed: r.claimed } : {}) };
    } else {
      if (!sameBytes(body.path.leaf, guardianLeaf(k.guardianSecret))) {
        throw new InputProblem('this letter is for you, but it does not carry your guardian proof. Ask the owner to send it again');
      }
      next = { ...common, role: 'guardian', address: body.address, path: body.path, ...(r.role === 'guardian' && r.votedRound !== undefined ? { votedRound: r.votedRound } : {}) };
    }
    this.records = this.records.map((x) => (x.id === r.id ? next : x));
    this.unsubscribe.get(r.id)?.();
    this.unsubscribe.delete(r.id);
    this.chains.delete(r.id);
    await this.persist();
    await this.select(r.id);
    return r.id;
  }

  /** Remove a vault from this device. The vault itself is untouched; without a backup this copy of its secrets is gone. */
  forget(id: string) {
    this.unsubscribe.get(id)?.();
    this.unsubscribe.delete(id);
    this.chains.delete(id);
    this.records = this.records.filter((r) => r.id !== id);
    if (this.activeId === id) this.activeId = this.records[0]?.id;
    void this.persist();
    this.emit();
    void this.open();
  }

  // ─── Backups ──────────────────────────────────────────────────────────────

  /**
   * The text of a backup file holding every vault on this device. It is
   * locked like the records here: Face ID or the printed recovery code opens it.
   */
  async exportBackup(): Promise<string> {
    const root = this.requireOpen();
    if (this.records.length === 0) throw new InputProblem('there is nothing to back up yet');
    return backupToText(await lockRecords(root, this.keyring!, { records: this.records, passkey: this.passkey }), this.records.length);
  }

  /** What a backup file asks for: a passphrase (older files), or what opens its keyring. */
  backupNeeds(text: string): { kind: 'passphrase' } | { kind: 'keyring'; passkeys: PrfRequest[]; code: boolean; vaults?: number } {
    const b = readBackup(text);
    if (b.kind === 'passphrase') return b;
    return {
      kind: 'keyring', vaults: b.vaults, code: b.locked.keyring.slots.some((s) => s.kind === 'recovery-code'),
      passkeys: b.locked.keyring.slots.filter((s) => s.kind === 'passkey' && s.credentialId && s.prfInput).map((s) => ({ credentialId: s.credentialId!, prfInput: s.prfInput! })),
    };
  }

  /**
   * Bring back the vaults in a backup file. Vaults already here are kept.
   *
   * A file from before the keyring needs its passphrase. A newer one opens
   * with Face ID or the printed recovery code. In a browser that is not set
   * up yet, a newer file's keyring becomes this browser's; in one that is, its
   * records keep the root they came with, so every key in them still works.
   */
  async importBackup(text: string, key: { passphrase: string } | { kind: SlotKind; secret: Uint8Array | string }): Promise<{ added: number; updated: number }> {
    const b = readBackup(text);
    let incoming: VaultRecord[];
    if (b.kind === 'passphrase') {
      if (!('passphrase' in key)) throw new InputProblem('this backup is locked with a passphrase');
      incoming = await importBackup(text, key.passphrase);
      if (!this.root) {
        if (this.keyring) throw new InputProblem('unlock this browser first');
        // Kept until this browser is set up, then locked with everything else.
        const merged = mergeRecords(this.legacy, incoming);
        this.legacy = merged.records;
        this.emit();
        return { added: merged.added, updated: merged.updated };
      }
    } else {
      if ('passphrase' in key) throw new InputProblem('this backup opens with Face ID or your printed recovery code, not a passphrase');
      const fileRoot = await openWith(b.locked.keyring, key.kind, key.secret);
      const opened = await unlockRecords(fileRoot, b.locked);
      if (!this.root && !this.keyring) {
        this.root = fileRoot;
        this.keyring = b.locked.keyring;
        this.passkey = opened.passkey;
        this.records = [...this.legacy];
        this.legacy = [];
        incoming = opened.records;
      } else {
        const root = this.requireOpen();
        incoming = sameBytes(fileRoot, root) ? opened.records : opened.records.map((r) => (r.root ? r : { ...r, root: fileRoot }));
        this.passkey ??= opened.passkey;
      }
    }
    const merged = mergeRecords(this.records, incoming);
    this.records = merged.records;
    if (!this.activeId) this.pickActive();
    await this.persist();
    this.emit();
    await this.open();
    return { added: merged.added, updated: merged.updated };
  }

  // ─── Snapshot ─────────────────────────────────────────────────────────────

  private build(): LiveSnapshot {
    const now = this.now;
    const active = this.record();
    const chain = active ? this.chains.get(active.id) : undefined;
    const facts = chain ? factsFrom(chain.address, chain.ledger, now, this.host?.kind === 'network' ? CLOCK_MARGIN : 0) : undefined;
    return {
      now,
      network: this.host?.networkId,
      access: this.accessView(),
      records: this.records.map((r) => ({
        id: r.id, role: r.role, address: recordAddress(r), network: r.network,
        title: r.role === 'owner' ? 'Your vault' : r.role === 'heir' ? `${r.ownerName}'s will` : r.role === 'invited' ? `${r.ownerName}'s invitation` : `${r.ownerName}'s vault`,
        subtitle: r.role === 'owner' ? `You are the owner${r.deployment?.complete ? '' : ' · not finished'}`
          : r.role === 'heir' ? (r.backup ? 'You are a backup heir' : 'You are an heir')
          : r.role === 'invited' ? 'Waiting for their letter' : 'You are a guardian',
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
      const l = chain?.ledger;
      const p = r.pendingRecovery;
      const recovery: RecoveryView | undefined = r.recoveryDelay === undefined ? undefined : {
        state: l ? recoveryStatus(l, BigInt(now)).state : 'off',
        delay: r.recoveryDelay,
        readyAt: l ? Number(l.recoveryReadyAt) : 0,
        mine: !!(l && p && sameBytes(l.recoveryPasskeyCommit, pureCircuits.passkeyCommitment(p.passkey.pk, p.salt))),
        lastStart: l ? Number(lastRecoveryStart(l)) : 0,
      };
      return {
        role: 'owner', id: r.id, ownerName: r.ownerName,
        status: r.deployment?.complete ? 'ready' : this.deployProgress?.running ? 'creating' : 'interrupted',
        passkey: r.passkey.kind, timers: r.timers,
        heirs: r.heirs.map((h, i) => ({
          id: h.id, name: h.name, shareBps: h.shareBps, unlockAt: Number(h.unlockAt), backupName: h.backup?.name,
          keyEnd: r.leaves[i] ? toHex(r.leaves[i].heirKeyCommit).slice(-4) : '',
          ownKey: !!h.invitee, ...(h.backup ? { backupOwnKey: !!h.backup.invitee } : {}),
        })),
        guardians: r.guardians.map((g) => ({ id: g.id, name: g.name, ownKey: !!g.invitee })),
        threshold: r.threshold, firstDeadline: r.firstDeadline, lastCheckIn: r.lastCheckIn,
        checkIn: vault && (now < vault.deadline ? 'onTime' : now < vault.switchOpensAt ? 'grace' : 'expired'),
        activity: r.activity, deployment: r.deployment, vault, recovery,
      };
    }
    if (r.role === 'invited') {
      return { role: 'invited', id: r.id, name: r.name, ownerName: r.ownerName, invitedAs: r.invitedAs, backup: r.backup, reply: this.replyFor(r.id) };
    }
    if (r.role === 'guardian') {
      const l = chain?.ledger;
      const secret = this.guardianSecretOf(r);
      return {
        role: 'guardian', id: r.id, name: r.name, ownerName: r.ownerName, vault,
        current: l && isCurrentGuardian({ secret, path: r.path }, l.guardianRoot),
        voted: l && l.guardianNullifiers.member(pureCircuits.guardianNullifier(vaultId(r.address), secret, l.guardianRound)),
      };
    }
    const letter = decodeHeirLetter(r.letter);
    const base: HeirView = {
      role: 'heir', id: r.id, name: r.name, ownerName: r.ownerName, backup: r.backup,
      shareBps: letter.leaf.shareBps, unlockAt: Number(letter.leaf.unlockAt), claimed: r.claimed, vault,
    };
    const l = chain?.ledger;
    if (!l || !vault) return base;
    const { key, salt } = this.heirKeyOf(r);
    const check = checkHeirLetter(letter, { vault: r.address, willRoot: l.willRoot, key: { pk: key.pk, salt } });
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
