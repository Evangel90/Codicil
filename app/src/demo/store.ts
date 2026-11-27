// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The demo world: one owner, a three-heir will with a backup heir and a
// tranche, three hidden guardians, and a demo clock. The owner configures the
// shares, the backup, the guardian threshold, the timers, an optional grace
// period and an optional recovery key in the setup wizard, and every action
// runs the real vault circuit on the in-browser DemoChain. After setup the
// owner can replace the guardians and name an attestor, and a recovery key can
// put a new passkey in charge after a public delay.
//
// Next to the vault sits one more contract, Harbour Savings: the example
// escrow from contracts/src/inheritable_escrow.compact, holding tokens for a
// beneficiary and paying out only when it has asked the vault "released?".

import { useSyncExternalStore } from 'react';
import {
  encodeContractAddress, encodeRawTokenType, encodeUserAddress, sampleRawTokenType, sampleUserAddress, type ContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Phase, pureCircuits, type HeirLeaf } from '@codicil/contracts/vault';
import * as escrowModule from '@codicil/contracts/escrow';
import * as sealsModule from '@codicil/contracts/seals';
import {
  attestationDigest,
  buildGuardianSet,
  buildWill,
  checkHeirLetter,
  checkInDigest,
  claimPackage,
  contractErrorCode,
  currentSettings,
  decodeHeirLetter,
  encodeHeirLetter,
  explainError,
  guardianLeaf,
  handOverArgs,
  isCurrentGuardian,
  keeperCommitment,
  lastRecoveryStart,
  letterFingerprint,
  guardianSecrets,
  newGuardianSecret,
  newHeirKey,
  newP256Key,
  newRecoverySecret,
  newSalt,
  openMessageText,
  payoutFor,
  pieceCommitment,
  piecesHandedOver,
  recoveryCommitment,
  recoveryConfig,
  recoveryStatus,
  registerProvesOwner,
  rpIdHash,
  sealArgs,
  sealedFingerprint,
  sealedFromText,
  sealedToText,
  sealMessage as sealForRecipient,
  SealedError,
  sealsWitnesses,
  settingsDigest,
  signAttestation,
  timeoutOpensAt,
  VAULT_EVENTS,
  VAULT_OPTIONS_OFF,
  vaultId,
  willUpdateDigest,
  withPasskeyApproval,
  type CodicilPrivateState,
  type GuardianSecrets,
  type GuardianSet,
  type HeirKey,
  type KeyPiece,
  type P256Key,
  type RecoveryStatus,
  type SealedMessage,
  type SealsLedger,
  type VaultEventName,
  type Will,
} from '@codicil/sdk';
import { DemoChain, type CallOutcome } from './chain.js';
import { approveWithPasskey, createDemoPasskey, createDevicePasskey, type OwnerPasskey } from './passkey.js';
import { decodeRecoveryKey, encodeRecoveryKey } from './recoveryKey.js';

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

export interface GuardianProfile { id: number; name: string; relation: string }

/** The guardians the wizard sets up. */
export const GUARDIANS: GuardianProfile[] = [
  { id: 0, name: 'Dr. Mensah', relation: 'Family doctor' },
  { id: 1, name: 'Sarah Lin', relation: 'Lawyer' },
  { id: 2, name: 'Tomás', relation: 'Old friend' },
];

/** People Amara can ask later, when she changes her guardians. */
export const MORE_GUARDIANS: GuardianProfile[] = [
  { id: 3, name: 'Ngozi', relation: 'Sister' },
  { id: 4, name: 'Mr. Bello', relation: 'Accountant' },
];

/** Everyone who can be a guardian in the demo; a guardian's id is their index here. */
export const GUARDIAN_POOL: GuardianProfile[] = [...GUARDIANS, ...MORE_GUARDIANS];
export const guardianById = (id: number): GuardianProfile => GUARDIAN_POOL[id];

/** The one attestor Amara can name: an office that can start the switch with a signed notice. */
export const ATTESTOR = { name: 'Lagos Probate Registry', relation: 'Registers deaths and signs a notice' };

// ─── The inheritable position ───────────────────────────────────────────────
/** Amara's savings in a contract written by someone else, made inheritable. */
export const POSITION = {
  name: 'Harbour Savings',
  amount: 8_000n,
  /** Known to Amara and to the beneficiary; the chain holds only a commitment. */
  beneficiary: 'ben' as HeirProfile['id'],
};

/** The assert messages of the savings contract, as the vault's are in the SDK. */
export type PositionRefusal = 'vault not released' | 'not the beneficiary' | 'already withdrawn';

export interface PositionAttempt {
  at: number;
  /** Who tried, by first name; never published. */
  by: string;
  ok: boolean;
  /** The contract's own assert message when it refused. */
  code?: string;
  /** The circuits the transaction ran, in the order they finished. */
  calls?: { contract: 'vault' | 'savings'; circuit: string }[];
}

export interface PositionView {
  name: string;
  address: string;
  // The savings contract's public ledger.
  vault: string;
  beneficiaryCommit: string;
  held: bigint;
  withdrawn: boolean;
  // Off-chain knowledge.
  beneficiary: HeirProfile['id'];
  paidTo?: string;
  lastAttempt?: PositionAttempt;
}

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
  /** Who the guardians are: ids from GUARDIAN_POOL. The wizard starts with the first three. */
  guardians: number[];
  /** Guardian reports needed. */
  threshold: number;
  /** Check-in interval, seconds. */
  every: number;
  /** Challenge window, seconds. */
  window: number;
  /** Grace period after a missed check-in, seconds; 0 = none. */
  grace: number;
  /** Public wait before a recovery takes effect, seconds; 0 = no recovery key. */
  recoveryDelay: number;
  /** Whether an attestor can also start the switch. Off at deployment; set later in Settings. */
  attestor: boolean;
}

export function defaultSetup(now = Math.floor(Date.now() / 1000)): VaultSetup {
  return {
    ada: 5000n, ben: 3000n, cleo: 2000n, kofiBackup: true, cleoUnlock: now + 400 * DAY,
    guardians: GUARDIANS.map((g) => g.id), threshold: 2, every: CHECK_IN_EVERY, window: CHALLENGE,
    grace: 0, recoveryDelay: 0, attestor: false,
  };
}

/**
 * Grace periods the wizard offers for a check-in interval. The contract caps
 * grace at the longest check-in period; the app keeps it within one interval.
 */
export const graceChoices = (every: number): number[] => [0, DAY, 3 * DAY, 7 * DAY].filter((g) => g <= every);

/**
 * Recovery delays the wizard offers. The contract needs at least a day; a
 * delay as long as the check-in interval could never finish before a deadline.
 */
export const recoveryDelayChoices = (every: number): number[] => [DAY, 3 * DAY, 7 * DAY].filter((d) => d < every);

/** A setup with its grace period and recovery delay brought back inside what `every` allows. */
export function fitSetup(p: VaultSetup): VaultSetup {
  const delays = recoveryDelayChoices(p.every);
  return {
    ...p,
    grace: Math.min(p.grace, p.every),
    recoveryDelay: p.recoveryDelay === 0 ? 0 : Math.min(p.recoveryDelay, delays[delays.length - 1]),
  };
}

/** What the owner changes in one signed settings update. */
export interface SettingsChange {
  /** Ids from GUARDIAN_POOL. */
  guardians: number[];
  threshold: number;
  attestor: boolean;
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

/** The approval step of a recovery: no signature, a new passkey is made instead. */
const newPasskeyStage = (kind?: OwnerPasskey['kind']): Pick<TxStage, 'label' | 'detail'> => (kind === 'device'
  ? { label: 'Creating a passkey on the new device', detail: 'Confirm with Face ID, Touch ID or your device PIN. The lost passkey is not needed.' }
  : { label: 'Creating a new demo key', detail: 'It stands in for the passkey on your new device. The lost passkey is not needed.' });

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
  /** This person has opened their page since the will last changed. */
  sawWillChange: boolean;
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

/** A guardian, past or present, as the demo cast knows them. */
export interface GuardianView extends GuardianProfile {
  /** Whether the proof on this guardian's device still leads to the guardians root on the chain. */
  current: boolean;
}

/** The longest message the demo seals, in characters. */
export const MESSAGE_MAX = 2000;

/** Who a sealed message is for: one person in the will, or everyone (a public disclosure). */
export type MessageTo = HeirProfile['id'] | 'everyone';
/**
 * How the guardians' pieces travel after the release. By hand: guardian to
 * recipient, with no trace on the chain. Through the register: a contract that
 * accepts a piece only once the vault has released, and publishes it.
 */
export type MessageVia = 'hand' | 'register';
export const MESSAGE_TO: MessageTo[] = [...(['ada', 'ben', 'cleo', 'kofi'] as const), 'everyone'];
/** Who a message is for, as a name. */
export const recipientName = (to: MessageTo): string => (to === 'everyone' ? 'everyone' : HEIRS.find((h) => h.id === to)!.name);

/** The assert messages of the seal register a guardian or a stranger can meet. */
export type RegisterRefusal = 'vault not released' | 'not a genuine piece' | 'no such seal';

export interface RegisterAttempt {
  at: number;
  /** Who tried, by first name; never published. */
  by: string;
  ok: boolean;
  /** The contract's own assert message when it refused. */
  code?: string;
  /** The circuits the transaction ran, in the order they finished. */
  calls?: { contract: 'vault' | 'register'; circuit: string }[];
}

/** The seal register's public ledger, and what the demo cast knows beside it. */
export interface RegisterView {
  address: string;
  // The public ledger.
  vault: string;
  keeperCommit: string;
  seals: { fingerprint: string; needed: number; pieces: number; sealedBefore: number }[];
  pieceChecks: number;
  handedOver: { seal: string; x: number; y: string }[];
  /** All zeros until the owner stands behind a statement. */
  statementFingerprint: string;
  /** The owner commitment the register's keeper proved it can open; all zeros until it has. */
  ownerCommit: string;
  /** Whether that commitment is the one on the vault's own ledger: the register was made by the vault's owner. */
  provesOwner: boolean;
  // Off-chain.
  /** The statement on the owner's public page, and whether it matches the fingerprint on the ledger. */
  statement?: { text: string; at: number; genuine: boolean };
  lastAttempt?: RegisterAttempt;
}

/**
 * A sealed message, as the demo cast holds it. Each part is on a different
 * person's device. By hand, none of it is on the chain; through the register,
 * the chain holds a fingerprint and commitments, and later the pieces.
 */
export interface MessageView {
  to: MessageTo;
  /** How the guardians' pieces reach the reader. */
  via: MessageVia;
  /** Through the register only: the fingerprint of the sealed text, as the chain records it. */
  fingerprint?: string;
  /** Through the register only: the chain accepted the seal before this time. */
  sealedBefore?: number;
  sealedAt: number;
  /** What the owner wrote, as the owner's own device keeps it. */
  text: string;
  /** Size of the sealed text the recipient holds, in bytes. */
  bytes: number;
  /** The start of the sealed text, hex: what it looks like without its key. */
  sealedStart: string;
  /** The whole sealed text as one line, the way it would be sent or posted. Useless without the key. */
  sealedText: string;
  /** How many guardian pieces open it, together with the recipient's own half of the key. */
  needed: number;
  /** Guardians who hold a piece. */
  holders: number[];
  /** Guardians whose piece has reached the reader: by hand, or on the register's public ledger. */
  handed: number[];
  /** What the recipient read, once it was opened on their device. */
  opened?: { at: number; text: string };
}

export interface RecoveryView {
  /** From the SDK's `recoveryStatus()`: public ledger fields and the clock, nothing else. */
  state: RecoveryStatus['state'];
  /** When the proposed keys take over, while a recovery stands; otherwise 0. */
  readyAt: number;
  /** The public delay, seconds. */
  delay: number;
  /** The latest moment a recovery can start and still finish before the deadline. */
  lastStart: number;
  // What the owner's device remembers; none of it is on the chain.
  startedAt?: number;
  cancelledAt?: number;
  completedAt?: number;
  /** A recovery just ended and the owner has not yet dismissed the note about it. */
  notice?: 'cancelled' | 'finished';
  /** A next recovery key is waiting to be saved. */
  nextKeyToSave: boolean;
  /** A recovery replaced a passkey, and the demo still holds the old one to try. */
  formerPasskey: boolean;
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
  /** Grace period, seconds; 0 = none. */
  grace: number;
  /** When anyone may start the switch by timeout: the deadline plus the grace period. */
  switchOpensAt: number;
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
  /** Release fee in basis points; the demo deploys with none. */
  feeBps: bigint;
  /** Public ledger values, hex. */
  chain: {
    address: string;
    willRoot: string;
    guardianRoot: string;
    ownerPasskeyCommit: string;
    /** All zeros when no attestor is set. */
    attestorKeyCommit: string;
    /** All zeros when the vault has no recovery key. */
    recoveryKeyCommit: string;
    /** 0 unless a recovery was started; it stays after a cancellation. */
    recoveryReadyAt: number;
    /** The owner action count when the last recovery started. */
    recoveryNonce: bigint;
    recoveryPasskeyCommit: string;
    claimNullifiers: string[];
    guardianNullifierCount: number;
  };
  /** Everyone who is or was a guardian, in the order they joined. */
  guardians: GuardianView[];
  recovery: RecoveryView;
  /** Events the vault has emitted, oldest first. Each is a name with no payload. */
  events: { name: VaultEventName; at: number }[];
  /** When the last "will changed" event arrived, if any. */
  willChangedAt?: number;
  heirs: HeirView[];
  /** The savings contract that pays out when this vault is released. */
  position: PositionView;
  /** The contract that hands over key pieces once this vault is released. */
  register: RegisterView;
  /** Sealed messages, in the order of the cast; the public disclosure last. */
  messages: MessageView[];
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
function describeFailure(e: unknown, explain?: (code: string) => string | undefined): string {
  const code = contractErrorCode(e);
  if (code) return explain?.(code) ?? explainError(e);
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
/** "3 days", "1 day", "5 hours" or "a few minutes": a length of time in words. */
export function span(seconds: number): string {
  const n = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`;
  if (seconds >= DAY) return n(Math.round(seconds / DAY), 'day');
  if (seconds >= 3600) return n(Math.floor(seconds / 3600), 'hour');
  return 'a few minutes';
}
/** The same, before a noun: "3-day", "1-day", "5-hour". */
export const spanAdj = (seconds: number): string => (seconds >= 3600 ? span(seconds).replace(/s$/, '').replace(' ', '-') : 'short');
const ZERO32 = new Uint8Array(32);
const isZeroBytes = (b: Uint8Array) => b.every((x) => x === 0);

interface Keys {
  ownerSalt: Uint8Array;
  heirKeys: Record<HeirProfile['id'], { key: HeirKey; salt: Uint8Array }>;
  /** One per person in GUARDIAN_POOL, each made on that person's own device. */
  guardianSecretsList: Uint8Array[];
  /** Made on the beneficiary's device; Amara only ever receives its commitment. */
  beneficiarySecret: Uint8Array;
  /** Made on the owner's device: it alone may seal on the register. Only its commitment goes on-chain. */
  keeperSecret: Uint8Array;
  /** Made in the wizard; it goes on paper, and only its commitment goes on-chain. */
  recoverySecret: Uint8Array;
  /** The attestor's own signing key; Amara only ever receives its commitment. */
  attestor: { key: P256Key; salt: Uint8Array };
}

/** What `run` may change for an action that is not a plain vault call. */
interface RunOptions {
  stages?: Partial<Record<TxStageId, Pick<TxStage, 'label' | 'detail'>>>;
  /** A message that fits this action better than the general one for a contract error. */
  explain?: (code: string) => string | undefined;
}

/** Witnesses for the savings contract: the secret comes from the caller's own device. */
const savingsWitnesses = (secret?: Uint8Array) => ({
  beneficiarySecret: (ctx: { privateState: unknown }): [unknown, Uint8Array] => {
    if (!secret) throw new Error('no beneficiary secret on this device');
    return [ctx.privateState, secret];
  },
});

const REGISTER_REFUSALS: Record<RegisterRefusal, string> = {
  'vault not released': 'The register asked the vault, and the vault said it has not released. The piece stays where it was, and nothing was published.',
  'not a genuine piece': 'The register checked this piece against the commitments made when the message was sealed. It matches none of them, so nothing was recorded.',
  'no such seal': 'The register holds no sealed text with this fingerprint. Its owner took it back, so no piece of its key can be handed over here.',
};

const REGISTER_STAGES: RunOptions['stages'] = {
  circuit: {
    label: 'Running the seal register, which calls the vault',
    detail: 'Two compiled circuits run on this device: the register and, inside it, the vault\'s "is it released?" check.',
  },
  proof: { label: 'Generating two zero-knowledge proofs', detail: 'On Midnight this step proves both circuits ran correctly, one proof each, in one transaction.' },
};

const POSITION_REFUSALS: Record<PositionRefusal, string> = {
  'vault not released': `${POSITION.name} asked the vault, and the vault said the will is not released. Nothing was paid. Try again once the will is released.`,
  'not the beneficiary': `${POSITION.name} refused: that secret does not match its beneficiary. Nothing was paid. Only the beneficiary's own device can withdraw.`,
  'already withdrawn': `${POSITION.name} has already paid out. There is nothing left to withdraw.`,
};

/** One sealed message and where each part of it is. */
interface HeldMessage {
  /** On the owner's device: what she wrote. */
  text: string;
  via: MessageVia;
  /** Through the register: the fingerprint it holds for this sealed text. */
  fingerprint?: Uint8Array;
  sealedAt: number;
  /** On the recipient's device: the sealed text and their half of the key. */
  sealed: SealedMessage;
  /** On each guardian's device: their piece of the other half. */
  pieces: Map<number, KeyPiece>;
  /** Pieces that have reached the recipient, and when. */
  handed: Map<number, number>;
  opened?: { at: number; text: string };
}

interface World extends Keys {
  chain: DemoChain;
  passkey: OwnerPasskey;
  setup: VaultSetup;
  will: Will;
  guardianSet: GuardianSet;
  /** What each guardian's device holds: their secret and the path the owner last sent them. */
  guardianHeld: Map<number, GuardianSecrets>;
  /** Everyone who is or was a guardian, in the order they joined. */
  guardianCast: number[];
  /** The recovery key as Amara saved it, on paper. Absent when the vault has none. */
  savedRecovery?: Uint8Array;
  /** A recovery started in this demo: the new device's passkey and the next recovery key. */
  pendingRecovery?: { passkey: OwnerPasskey; salt: Uint8Array; nextSecret: Uint8Array; startedAt: number };
  /** The passkey a finished recovery replaced. */
  formerPasskey?: { passkey: OwnerPasskey; salt: Uint8Array };
  recoveryCancelledAt?: number;
  recoveryCompletedAt?: number;
  recoveryNotice?: 'cancelled' | 'finished';
  /** Events the vault emitted, as an app following the vault would collect them. */
  events: { name: VaultEventName; at: number }[];
  willChangedAt?: number;
  /** Heirs who have opened their page since the will last changed. */
  sawWillChange: Set<HeirProfile['id']>;
  deployedAt: number;
  lastCheckIn: number;
  /** The savings contract deployed next to the vault. */
  position: { address: ContractAddress; paidTo?: string; lastAttempt?: PositionAttempt };
  claimed: Map<number, string>;   // leaf → nullifier hex
  /** Letters each heir has loaded on their own device. */
  held: Map<HeirProfile['id'], string>;
  /** Sealed messages, by recipient. */
  messages: Map<MessageTo, HeldMessage>;
  register: { address: ContractAddress; lastAttempt?: RegisterAttempt; statement?: { text: string; at: number } };
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
  private guardianChecks?: { root: bigint; current: Map<number, boolean> };
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
      guardianSecretsList: GUARDIAN_POOL.map(() => newGuardianSecret()),
      beneficiarySecret: randomBytes(32),
      keeperSecret: randomBytes(32),
      recoverySecret: newRecoverySecret(),
      attestor: { key: newP256Key(), salt: newSalt() },
    };
    return this.keys;
  }

  /** The guardian tree for a list of people: each gave the owner only their leaf. */
  private guardianSetFor(k: Pick<Keys, 'guardianSecretsList'>, ids: readonly number[], threshold: number): GuardianSet {
    return buildGuardianSet(ids.map((id) => guardianLeaf(k.guardianSecretsList[id])), threshold);
  }

  /**
   * The recovery key for the vault being set up, as text to save. It is made
   * once per session, so the key the wizard shows is the one that is deployed.
   */
  draftRecoveryKey(): string {
    return encodeRecoveryKey(this.ensureKeys().recoverySecret);
  }

  /** Last 4 hex digits of an heir's public key, for the setup screens. */
  heirKeyEnd(id: HeirProfile['id']): string {
    return this.ensureKeys().heirKeys[id].key.pk.x.toString(16).slice(-4);
  }

  /** What the chain would receive for this setup: real commitments, computed here. */
  preview(setup: VaultSetup, passkey?: OwnerPasskey): {
    ownerCommit?: string; willRoot?: string; guardianRoot: string; recoveryCommit?: string; problem?: string;
  } {
    const k = this.ensureKeys();
    const guardianRoot = fieldHex(this.guardianSetFor(k, setup.guardians, setup.threshold).root);
    const ownerCommit = passkey ? hex(pureCircuits.passkeyCommitment(passkey.pk, k.ownerSalt)) : undefined;
    const recoveryCommit = setup.recoveryDelay > 0 ? hex(recoveryCommitment(k.recoverySecret)) : undefined;
    try {
      return { ownerCommit, guardianRoot, recoveryCommit, willRoot: fieldHex(this.draftWill(setup).root) };
    } catch (e) {
      return { ownerCommit, guardianRoot, recoveryCommit, problem: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Builds the will for a setup once; the same shares and dates give the same will (and salts). */
  private draftWill(setup: VaultSetup): Will {
    const { ada, ben, cleo, kofiBackup, cleoUnlock } = setup;
    const key = JSON.stringify({ ada, ben, cleo, kofiBackup, cleoUnlock }, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    if (this.previewed?.key !== key) this.previewed = { key, will: this.willFor(this.ensureKeys(), setup, BigInt(setup.cleoUnlock)) };
    return this.previewed.will;
  }

  async setUp(passkey: OwnerPasskey, setup: VaultSetup = defaultSetup()): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const k = this.ensureKeys();
    const will = this.draftWill(setup);
    const guardianSet = this.guardianSetFor(k, setup.guardians, setup.threshold);
    // A check-in may set the next deadline up to this far ahead (D9).
    const maxPeriod = BigInt(Math.max(2 * setup.every, 60 * DAY));

    const chain = await DemoChain.deploy({
      ownerPasskeyCommit: pureCircuits.passkeyCommitment(passkey.pk, k.ownerSalt),
      ownerEdCommit: new Uint8Array(32),
      passkeyRpIdHash: rpIdHash(globalThis.location?.hostname ?? 'localhost'),
      willRoot: will.root,
      firstDeadline: BigInt(now + setup.every),
      maxPeriod,
      challengeWindow: BigInt(setup.window),
      claimWindow: BigInt(CLAIM_WINDOW),
      tokenColor: encodeRawTokenType(sampleRawTokenType()),
      guardianRoot: guardianSet.root,
      guardianThreshold: guardianSet.threshold,
      attestorKeyCommit: new Uint8Array(32),
      // The release fee stays off in the demo; grace and the recovery key are the owner's choice.
      ...VAULT_OPTIONS_OFF,
      gracePeriod: BigInt(setup.grace),
      ...(setup.recoveryDelay > 0 ? recoveryConfig(k.recoverySecret, BigInt(setup.recoveryDelay), maxPeriod) : {}),
    }, now);
    // The savings contract is fixed at deployment to this vault and to a
    // commitment to the beneficiary's secret. It holds its own token.
    const position = await chain.deployContract(
      'inheritable_escrow', escrowModule, savingsWitnesses(),
      { bytes: encodeContractAddress(chain.address) },
      encodeRawTokenType(sampleRawTokenType()),
      escrowModule.pureCircuits.beneficiaryCommitment(k.beneficiarySecret),
    );
    // The seal register is fixed to this vault too, and to a commitment to a
    // secret only the owner's device holds.
    const register = await chain.deployContract(
      'codicil_seals', sealsModule, sealsWitnesses(), { bytes: encodeContractAddress(chain.address) }, keeperCommitment(k.keeperSecret),
    );
    // The register proves whose it is: its keeper shows, in zero knowledge,
    // that it holds the key and salt behind the vault's owner commitment.
    await chain.callContract(register, 'provePasskeyOwner', {
      witnesses: sealsWitnesses(k.keeperSecret, { passkey: { pk: passkey.pk, salt: k.ownerSalt } }),
    });
    this.world = {
      ...k, chain, passkey, setup: { ...setup, attestor: false }, will, guardianSet, deployedAt: now, lastCheckIn: now,
      register: { address: register },
      claimed: new Map(), votedRound: new Map(), held: new Map(), messages: new Map(),
      // Each guardian's device gets the path to its leaf; nobody else does.
      guardianHeld: new Map(setup.guardians.map((id) => [id, guardianSecrets(guardianSet, k.guardianSecretsList[id])])),
      guardianCast: [...setup.guardians],
      savedRecovery: setup.recoveryDelay > 0 ? k.recoverySecret : undefined,
      events: [],
      sawWillChange: new Set(),
      position: { address: position },
    };
    this.activity = [{
      at: now, who: OWNER_NAME, what: 'Vault deployed and will sealed', tone: 'plain',
      published: [
        'A commitment to your passkey', 'The heirs root (one 32-byte number)',
        `The guardians root and "${setup.threshold} must agree"`,
        setup.grace > 0 ? `Your first deadline and the timers, including the ${span(setup.grace)} of grace` : 'Your first deadline and the timers. Grace period: none',
        ...(setup.recoveryDelay > 0 ? [`That the vault has a recovery key (a commitment), and its ${spanAdj(setup.recoveryDelay)} delay`] : ['Recovery key: none']),
        'Release fee: none',
      ],
      keptPrivate: [
        'The passkey itself', 'Names, shares, unlock dates and the backup heir', 'Who the guardians are, and how many',
        ...(setup.recoveryDelay > 0 ? ['The recovery key itself, which is only on paper'] : []),
      ],
    }];
    await chain.call('deposit', {}, ESTATE);
    this.log(OWNER_NAME, `Deposit · ${ESTATE.toLocaleString()} ${TOKEN}`, 'public', ['The amount'], []);
    await chain.callContract(position, 'deposit', { witnesses: savingsWitnesses() }, POSITION.amount);
    this.log(OWNER_NAME, `${POSITION.name} made inheritable · ${POSITION.amount.toLocaleString()} ${TOKEN}`, 'public', [
      'The address of the vault it asks before paying', 'A commitment to its beneficiary', 'The amount it holds',
    ], ['Who the beneficiary is', "The beneficiary's secret, which never left their device"]);
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
    this.guardianChecks = undefined;
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
    if (actor.kind === 'heir') this.world?.sawWillChange.add(actor.id);
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
    options: RunOptions = {},
  ): Promise<boolean> {
    if (!this.world || this.tx?.status === 'running') return false;
    this.lastAction = () => this.run(title, stageIds, body, options);
    const stages = stageIds.map((id) => id === 'approve' && this.world!.passkey.kind === 'demo' && !options.stages?.approve
      ? { ...STAGES.approve, label: 'Signing with the demo key', detail: 'A software key signs in the exact passkey format. With a device passkey this is Face ID or Touch ID.' }
      : { ...STAGES[id], ...options.stages?.[id] });
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
      this.tx = { ...this.tx!, status: 'error', message: describeFailure(e, options.explain), code: contractErrorCode(e), endedAt: performance.now() };
      this.emit();
      return false;
    }
  }

  private ownerState(digest: Uint8Array, assertion: Awaited<ReturnType<typeof approveWithPasskey>>): CodicilPrivateState {
    const w = this.world!;
    return withPasskeyApproval({ passkey: { pk: w.passkey.pk, salt: w.ownerSalt } }, digest, assertion);
  }

  /** Whether a recovery stands right now: the next thing the owner signs cancels it. */
  private recoveryStands(): boolean {
    const w = this.world!;
    const state = recoveryStatus(w.chain.ledger, BigInt(w.chain.now)).state;
    return state === 'waiting' || state === 'ready';
  }

  /**
   * Call after anything the owner signed. If a recovery stood before it, that
   * recovery is now cancelled and its key retired: the owner nonce moved, which
   * is all the contract needs (D18). Returns a sentence for the result.
   */
  private afterOwnerSigned(stood: boolean): string {
    if (!stood) return '';
    const w = this.world!;
    w.recoveryCancelledAt = w.chain.now;
    w.recoveryNotice = 'cancelled';
    w.pendingRecovery = undefined;
    this.log(OWNER_NAME, 'Recovery cancelled · recovery key retired for good', 'armed', [
      'Nothing extra: the owner action counter moved, so it no longer matches the one the recovery recorded',
      'The cancelled proposal and the dead recovery key commitment stay on the ledger',
    ], ['Your passkey and its signature']);
    return ' It also cancelled the recovery that was in progress, and the recovery key is now retired for good.';
  }

  /** Collect the events a call emitted, as an app following the vault would. */
  private noteEvents(out: CallOutcome) {
    const w = this.world!;
    const known = new Set<string>(Object.values(VAULT_EVENTS));
    for (const e of out.events) {
      if (!known.has(e.name)) continue;
      w.events.push({ name: e.name as VaultEventName, at: w.chain.now });
      // "Look at the ledger now": every letter issued before this is out of date (D14).
      if (e.name === VAULT_EVENTS.willChanged) {
        w.willChangedAt = w.chain.now;
        w.sawWillChange.clear();
      }
    }
  }

  /** Whether the owner is late but still inside the grace period. */
  private inGrace(): boolean {
    const w = this.world!;
    const l = w.chain.ledger;
    return l.phase === Phase.armed && w.chain.now >= Number(l.deadline) && w.chain.now < Number(timeoutOpensAt(l));
  }

  checkIn() {
    const wasPending = this.world?.chain.ledger.phase === Phase.pending;
    const title = wasPending ? 'Cancelling the switch' : this.world && this.recoveryStands() ? 'Checking in, which cancels the recovery' : 'Recording your check-in';
    return this.run(title, ['prepare', 'approve', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      const before = w.chain.ledger;
      const next = BigInt(w.chain.now + w.setup.every);
      const digest = checkInDigest(w.chain.address, next, before.nonce);
      await stage('approve');
      const assertion = await approveWithPasskey(w.passkey, digest);
      await stage('circuit');
      const pending = before.phase === Phase.pending;
      // Late but fine: after the deadline, before the grace period ends.
      const lateBy = pending ? -1 : w.chain.now - Number(before.deadline);
      const stood = this.recoveryStands();
      await w.chain.call('checkInPasskey', this.ownerState(digest, assertion), next);
      w.lastCheckIn = w.chain.now;
      const moved = `deadline moved to ${fmtShort(Number(next))}`;
      this.log(OWNER_NAME, pending ? `Switch cancelled · ${moved}` : lateBy >= 0 ? `Late check-in, inside the grace period · ${moved}` : `Check-in · ${moved}`, 'armed', [
        'The new deadline', 'Check-in counter +1', 'Guardian round +1, so earlier reports no longer count',
        ...(lateBy >= 0 ? ['That this check-in came after the deadline: block time is public'] : []),
      ], ['Your passkey and its signature', 'Who this vault belongs to']);
      const cancelled = this.afterOwnerSigned(stood);
      const due = `Your next deadline is ${fmtDate(Number(next))}.`;
      return (pending ? `Switch cancelled. ${due}`
        : lateBy >= 0 ? `Check-in recorded, ${span(lateBy)} late. You were inside your grace period, so nothing else happened. ${due}`
        : `Check-in recorded. ${due}`) + cancelled;
    }, {
      explain: (code) => {
        if (code !== 'switch already expired') return undefined;
        const w = this.world!;
        const l = w.chain.ledger;
        const had = l.gracePeriod > 0n ? ` and your grace period ended on ${fmtDate(Number(timeoutOpensAt(l)))}` : '';
        return `Your check-in was due on ${fmtDate(Number(l.deadline))}${had}, so a check-in alone no longer works. Start the switch, then check in to cancel it: you get the full ${days(w.setup.window)} days to do that.`;
      },
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
      const stood = this.recoveryStands();
      const out = await w.chain.call('updateWillPasskey', this.ownerState(digest, assertion), will.root);
      this.noteEvents(out);
      w.will = will;
      w.setup = { ...w.setup, ...draft };
      this.log(OWNER_NAME, `Will updated to version ${(w.chain.ledger.willVersion + 1n).toString()}`, 'plain', [
        'A new heirs root (one 32-byte number)', 'Will version +1', 'A "will changed" event with no details, so heirs\' apps know their letters are out of date',
      ], ['Who gets what, and what changed', draft.kofiBackup ? 'The backup heir' : 'That the backup heir was removed']);
      return 'Your new will is sealed. Letters for the old one no longer work.' + this.afterOwnerSigned(stood);
    }, {
      // Inside the grace period the way back is a check-in, not a countdown.
      explain: (code) => (code === 'switch already expired' && this.inGrace()
        ? 'Your check-in deadline has passed, so the will is locked. Check in first: you are still inside your grace period. Then change the will.'
        : undefined),
    });
  }

  /**
   * Replace the guardians, the number that must agree, and the attestor, in
   * one update signed like a check-in. The owner always signs the complete new
   * settings; every update starts a new voting round (D17).
   */
  updateSettings(change: SettingsChange) {
    return this.run('Changing who can start the switch', ['prepare', 'approve', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      const ids = [...new Set(change.guardians)].sort((a, b) => a - b);
      if (ids.some((id) => !GUARDIAN_POOL[id])) throw new InputError('one of those people is not in the demo');
      let set: GuardianSet;
      try {
        set = this.guardianSetFor(w, ids, change.threshold);
      } catch (e) {
        throw new InputError(e instanceof Error ? e.message : String(e));
      }
      const before = w.chain.ledger;
      const settings = {
        ...currentSettings(before),
        guardianRoot: set.root,
        guardianThreshold: set.threshold,
        attestorKeyCommit: change.attestor ? pureCircuits.attestorCommitment(w.attestor.key.pk, w.attestor.salt) : ZERO32,
      };
      const digest = settingsDigest(w.chain.address, settings, before.nonce);
      await stage('approve');
      const assertion = await approveWithPasskey(w.passkey, digest);
      await stage('circuit');
      const stood = this.recoveryStands();
      await w.chain.call('updateSettingsPasskey', this.ownerState(digest, assertion), settings);

      const added = ids.filter((id) => !w.setup.guardians.includes(id));
      const removed = w.setup.guardians.filter((id) => !ids.includes(id));
      const attestorChanged = change.attestor !== w.setup.attestor;
      w.guardianSet = set;
      w.setup = { ...w.setup, guardians: ids, threshold: change.threshold, attestor: change.attestor };
      // Every guardian in the new set needs a new path, kept or new: the demo
      // delivers it. A removed guardian keeps the old one, which no longer works.
      for (const id of ids) {
        w.guardianHeld.set(id, guardianSecrets(set, w.guardianSecretsList[id]));
        if (!w.guardianCast.includes(id)) w.guardianCast.push(id);
      }
      // A sealed message's key is cut into one piece per guardian, so new
      // guardians mean a new key and new pieces.
      const resealed = await this.resealMessages(w);
      const voided = before.guardianVotes;
      this.log(OWNER_NAME, `Guardians and attestor updated · ${change.threshold} must agree`, 'plain', [
        'The guardians root, the number that must agree, and the attestor commitment (zeros for none)',
        'Owner action counter +1', 'Guardian round +1, so earlier votes and attestations no longer count',
      ], [
        'Who was added, removed or kept', 'How many guardians there are', 'Who the attestor is', 'Your passkey and its signature',
      ]);
      const names = (list: number[]) => list.map((id) => guardianById(id).name).join(' and ');
      return [
        `Saved. ${change.threshold} of your ${ids.length} guardian${ids.length === 1 ? '' : 's'} must now agree.`,
        added.length ? `${names(added)} can vote from now on.` : '',
        removed.length ? `${names(removed)} can no longer vote.` : '',
        attestorChanged ? (change.attestor ? `${ATTESTOR.name} can now start the switch with a signed notice.` : `${ATTESTOR.name} can no longer start the switch.`) : '',
        `A new voting round has started${voided > 0n ? `, so the ${voided === 1n ? 'vote' : `${voided} votes`} cast before no longer count${voided === 1n ? 's' : ''}` : ''}.`,
        resealed ? `Your sealed message${resealed === 1 ? ' was' : 's were'} sealed again, with a new piece of the key for each guardian.` : '',
      ].filter(Boolean).join(' ') + this.afterOwnerSigned(stood);
    }, {
      explain: (code) => {
        const w = this.world!;
        if (code === 'settings locked') {
          return w.chain.ledger.phase === Phase.released
            ? 'This will has been released, so guardians and the attestor can no longer be changed.'
            : 'A countdown has started, so guardians and the attestor are locked. Check in to cancel the countdown, then change them.';
        }
        if (code === 'switch already expired' && this.inGrace()) {
          return 'Your check-in deadline has passed, so guardians and the attestor are locked. Check in first: you are still inside your grace period. Then change them.';
        }
        return undefined;
      },
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
      const w = this.world!;
      await stage('circuit');
      const grace = w.chain.ledger.gracePeriod > 0n;
      await w.chain.call('triggerTimeout', {});
      const until = Number(w.chain.ledger.pendingUntil);
      this.log(who, grace ? 'Deadline and grace period passed · switch started' : 'Deadline passed · switch started', 'pending', ['Vault state: pending', 'When the challenge window ends'], []);
      return `The switch has started. The owner can cancel until ${fmtDate(until)}, ${span(until - w.chain.now)} from now.`;
    }, {
      explain: (code) => {
        if (code !== 'grace period open') return undefined;
        const l = this.world!.chain.ledger;
        return `The owner missed the check-in due on ${fmtDate(Number(l.deadline))}, but is inside a ${spanAdj(Number(l.gracePeriod))} grace period and can still check in as usual. The switch can start on ${fmtDate(Number(timeoutOpensAt(l)))} if there is still no check-in.`;
      },
    });
  }

  /**
   * Anyone holding a notice signed by the attestor can start the switch. In
   * the demo the registry signs for the current round and the notice is sent
   * straight away.
   */
  attest(who: string) {
    return this.run(`Sending the notice signed by ${ATTESTOR.name}`, ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      await stage('circuit');
      const digest = attestationDigest(w.chain.address, w.chain.ledger.guardianRound);
      const state: CodicilPrivateState = {
        attestor: { pk: w.attestor.key.pk, salt: w.attestor.salt, approval: { digest, proof: signAttestation(w.attestor.key.sk, digest) } },
      };
      await w.chain.call('triggerAttestation', state, BigInt(w.chain.now));
      const until = Number(w.chain.ledger.pendingUntil);
      this.log(who, 'A signed notice from the attestor · switch started', 'pending', ['Vault state: pending', 'When the challenge window ends', 'The time on the notice'], [
        `That the attestor is ${ATTESTOR.name}`, "The attestor's key and signature",
      ]);
      return `The vault accepted the notice, so the switch has started. ${OWNER_FIRST} can cancel until ${fmtDate(until)}.`;
    }, {
      explain: (code) => (code === 'unknown attestor'
        ? `This vault has no attestor, or not this one, so the notice was refused. ${OWNER_FIRST} names an attestor under Settings.`
        : code === 'not armed' ? 'A countdown has already started or the will was released, so a notice changes nothing now.' : undefined),
    });
  }

  guardianReport(id: number) {
    const g = guardianById(id);
    return this.run('Casting your vote', ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      await stage('circuit');
      // The guardian works from what their own device holds: their secret and
      // the path the owner last sent. After being removed, that path is stale.
      const held = w.guardianHeld.get(id);
      const state: CodicilPrivateState = held ? { guardian: held } : {};
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
    }, {
      explain: (code) => (code === 'not a guardian'
        ? `You are no longer a guardian of this will: ${OWNER_FIRST} changed the guardians. Your vote was not counted and nothing was recorded.`
        : undefined),
    });
  }

  release(who: string) {
    return this.run('Releasing the will', ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      await stage('circuit');
      this.noteEvents(await this.world!.chain.call('finalizeRelease', {}));
      this.log(who, 'Challenge window ended · will released', 'released', ['Vault state: released', `Estate snapshot: ${this.world!.chain.ledger.estateSnapshot.toLocaleString()}`, 'A "released" event'], []);
      return 'The will is released. Heirs can now claim their shares.';
    });
  }

  // ─── Sealed messages ──────────────────────────────────────────────────────
  // None of these is a transaction. A message is sealed, handed over and
  // opened between people's devices; the chain only says when: "released".

  private sealsLedger(w: World): SealsLedger {
    return sealsModule.ledger(w.chain.ledgerOf(w.register.address));
  }

  private async sealFor(w: World, text: string, via: MessageVia): Promise<HeldMessage> {
    const holders = w.setup.guardians;
    const { sealed, pieces } = await sealForRecipient({ vault: w.chain.address, message: text, pieces: holders.length, needed: w.setup.threshold });
    return {
      text, via, sealedAt: w.chain.now, sealed, pieces: new Map(holders.map((id, i) => [id, pieces[i]])), handed: new Map(),
      fingerprint: via === 'register' ? sealedFingerprint(sealed) : undefined,
    };
  }

  /** Records a sealed text on the register: its fingerprint and a commitment to each piece of its key. */
  private async registerSeal(w: World, m: HeldMessage): Promise<void> {
    await w.chain.callContract(
      w.register.address, 'seal', { witnesses: sealsWitnesses(w.keeperSecret) }, ...sealArgs(m.sealed, [...m.pieces.values()], w.chain.now),
    );
  }

  private async unregisterSeal(w: World, m: HeldMessage): Promise<void> {
    if (m.fingerprint) await w.chain.callContract(w.register.address, 'unseal', { witnesses: sealsWitnesses(w.keeperSecret) }, m.fingerprint);
  }

  /** Seal every message again for the current guardians. Returns how many. */
  private async resealMessages(w: World): Promise<number> {
    for (const [to, m] of w.messages) {
      const next = await this.sealFor(w, m.text, m.via);
      // The new seal goes on before the old one comes off, so a failure
      // between the two leaves the register holding what this device holds.
      if (m.via === 'register') {
        await this.registerSeal(w, next);
        w.messages.set(to, next);
        await this.unregisterSeal(w, m);
      } else {
        w.messages.set(to, next);
      }
    }
    return w.messages.size;
  }

  /** Seals, records on the register when asked to, and notes it in the activity. Returns the words to show. */
  private async placeSeal(w: World, to: MessageTo, body: string, via: MessageVia): Promise<string> {
    const old = w.messages.get(to);
    const next = await this.sealFor(w, body, via);
    // New seal first, old seal off second: see resealMessages.
    if (via === 'register') await this.registerSeal(w, next);
    w.messages.set(to, next);
    if (old?.via === 'register') await this.unregisterSeal(w, old);
    const name = recipientName(to);
    const n = w.setup.guardians.length;
    const k = w.setup.threshold;
    const held = n === 1
      ? `${guardianById(w.setup.guardians[0]).name} holds the guardians' half of the key.`
      : `Each of your ${n} guardians holds a piece of the key. ${k} of them are needed.`;
    const what = to === 'everyone'
      ? (old ? 'Public disclosure replaced' : 'Public disclosure sealed')
      : old ? `Sealed message for ${name} replaced` : `Message sealed for ${name}`;
    this.log(OWNER_NAME, what, 'plain', via === 'register' ? [
      'A fingerprint of the sealed text', `Commitments to ${n} piece${n === 1 ? '' : 's'} of its key, and that ${k} ${k === 1 ? 'is' : 'are'} needed`,
      'That it was sealed before a time a few minutes from now',
    ] : [], to === 'everyone' ? [
      'What it says', 'The key and its pieces', 'Who your guardians are',
    ] : [
      'The message', via === 'register' ? 'Who it is for' : 'That a message exists, and who it is for',
      `The key: half with ${name}, half cut into ${n} piece${n === 1 ? '' : 's'} for your guardians`,
    ]);
    if (via === 'hand') return held;
    return to === 'everyone'
      ? `Sealed for everyone. The register now holds its fingerprint, which later shows it existed today. ${held}`
      : `Sealed for ${name}. The register holds a fingerprint and nothing that says who it is for. ${held}`;
  }

  /**
   * Seal a message for one person, or for everyone, replacing any earlier one.
   * By hand, nothing is sent anywhere. Through the register it is a
   * transaction, shown in the transaction sheet unless `quiet`.
   * Returns what went wrong, in words to show, or nothing when it worked.
   */
  async sealMessage(
    to: MessageTo, text: string, via: MessageVia = to === 'everyone' ? 'register' : 'hand', opts: { quiet?: boolean } = {},
  ): Promise<string | undefined> {
    const w = this.world;
    if (!w) return 'There is no vault yet.';
    const body = text.trim();
    if (!body) return 'Write the message first.';
    if (body.length > MESSAGE_MAX) return `That is ${body.length.toLocaleString()} characters. The demo seals up to ${MESSAGE_MAX.toLocaleString()}.`;
    if (w.chain.ledger.phase === Phase.released) return 'Your vault has released, so messages can no longer be sealed or changed.';
    if (to === 'everyone' && via !== 'register') return 'A public disclosure goes through the register, so that everyone can check it and open it.';
    const name = recipientName(to);
    if (via === 'hand' && w.messages.get(to)?.via !== 'register') {
      const held = await this.placeSeal(w, to, body, via);
      this.toast = { id: Date.now(), title: `Sealed for ${name}`, body: held };
      this.emit();
      return undefined;
    }
    if (opts.quiet) {
      try {
        await this.placeSeal(w, to, body, via);
      } catch (e) {
        return describeFailure(e);
      }
      this.emit();
      return undefined;
    }
    const title = via === 'hand' ? `Taking the message for ${name} off the register` : to === 'everyone' ? 'Sealing a public disclosure' : `Sealing a message for ${name}`;
    const went = await this.run(title, ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      await stage('circuit');
      return this.placeSeal(w, to, body, via);
    }, {
      stages: {
        prepare: { label: 'Sealing it on this device', detail: 'The message is encrypted here, and the guardians\' half of its key is cut into pieces. The plain text goes nowhere.' },
        circuit: via === 'hand' ? REGISTER_STAGES!.circuit : { label: 'Running the seal register, which calls the vault', detail: 'The register asks the vault that it has not released, then records a fingerprint of the sealed text and a commitment to each piece of its key.' },
        proof: REGISTER_STAGES!.proof,
      },
    });
    // Nothing was sealed if the transaction did not go through; the caller keeps what was typed.
    return went ? undefined : (this.tx?.status === 'error' ? this.tx.message : undefined) ?? 'Another transaction is still running. Try again when it has finished.';
  }

  /** Take a sealed message back. Returns what went wrong, if anything. */
  async removeMessage(to: MessageTo): Promise<string | undefined> {
    const w = this.world;
    const m = w?.messages.get(to);
    if (!w || !m) return to === 'everyone' ? 'There is no public disclosure to take back.' : 'There is no sealed message for that person.';
    if (w.chain.ledger.phase === Phase.released) return 'Your vault has released, so messages can no longer be sealed or changed.';
    const name = recipientName(to);
    if (m.via === 'register') {
      await this.run(to === 'everyone' ? 'Taking back the public disclosure' : `Taking back the message for ${name}`, ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
        await stage('circuit');
        await this.unregisterSeal(w, m);
        w.messages.delete(to);
        this.log(OWNER_NAME, to === 'everyone' ? 'Public disclosure taken back' : `Sealed message for ${name} removed`, 'plain', [
          'That the seal with this fingerprint was removed',
        ], ['What it said', to === 'everyone' ? 'Why' : 'Who it was for']);
        return 'The register no longer holds its seal, so no piece of its key can be handed over there. Copies of the sealed text that exist stay shut.';
      }, { stages: REGISTER_STAGES });
      return w.messages.has(to) && this.tx?.status !== 'error' ? 'Another transaction is still running. Try again when it has finished.' : undefined;
    }
    w.messages.delete(to);
    this.log(OWNER_NAME, `Sealed message for ${name} removed`, 'plain', [], ['That a message existed, and who it was for']);
    this.toast = { id: Date.now(), title: `Removed the message for ${name}`, body: "Your guardians' apps deleted their pieces of its key." };
    this.emit();
    return undefined;
  }

  /**
   * A guardian hands over, by hand, every piece their device holds for a
   * message delivered that way. Their app reads the vault's state from the
   * chain first and keeps the pieces unless it says released.
   */
  handOverPieces(id: number): string | undefined {
    const w = this.world;
    if (!w) return 'There is no vault yet.';
    const mine = [...w.messages.values()].filter((m) => m.via === 'hand' && m.pieces.has(id) && !m.handed.has(id));
    if (mine.length === 0) return 'This device holds no piece to hand over.';
    if (w.chain.ledger.phase !== Phase.released) {
      return `The vault has not released, so your piece${mine.length === 1 ? ' stays' : 's stay'} on this device. Nothing was sent.`;
    }
    for (const m of mine) m.handed.set(id, w.chain.now);
    this.log('A guardian', mine.length === 1 ? 'A guardian handed over a piece of a key' : `A guardian handed over ${mine.length} pieces of keys`, 'plain', [], [
      `That it was ${guardianById(id).name}`, 'The piece itself', 'Who it went to',
    ]);
    this.toast = {
      id: Date.now(), title: mine.length === 1 ? 'Your piece is handed over' : `Your ${mine.length} pieces are handed over`,
      body: `${mine.length === 1 ? 'It' : 'Each'} went to the person the message is for, and to nobody else.`,
    };
    this.emit();
    return undefined;
  }

  /**
   * A guardian hands over, through the register, every piece their device
   * holds for it. The register asks the vault first and refuses unless it has
   * released; then it checks each piece and writes it to the public ledger.
   * The guardian never learns who a message is for.
   */
  publishPieces(id: number): Promise<boolean> {
    return this.run('Handing over a piece through the register', ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      const l = this.sealsLedger(w);
      const mine = [...w.messages.values()].filter((m) => m.via === 'register' && m.pieces.has(id)
        && !l.handedOver.member(pieceCommitment(m.fingerprint!, m.pieces.get(id)!)));
      if (mine.length === 0) throw new InputError('this device holds no piece that is still to be handed over');
      await stage('circuit');
      const attempt = { at: w.chain.now, by: guardianById(id).name };
      try {
        let calls: RegisterAttempt['calls'];
        for (const m of mine) {
          const out = await w.chain.callContract(w.register.address, 'handOver', { witnesses: sealsWitnesses() }, ...handOverArgs(m.fingerprint!, m.pieces.get(id)!));
          calls = out.trace.map((t) => ({ contract: t.address === w.chain.address ? 'vault' as const : 'register' as const, circuit: t.circuitId }));
        }
        w.register.lastAttempt = { ...attempt, ok: true, calls };
        this.log('A guardian', mine.length === 1 ? 'A piece of a key was handed over through the register' : `${mine.length} pieces of keys were handed over through the register`, 'released', [
          'That the register asked this vault whether it is released', 'The piece: its number and its value', 'Which sealed text it belongs to, by fingerprint',
        ], [`That it was ${guardianById(id).name}`, 'Who the message is for', 'The message']);
        return mine.length === 1
          ? 'The register checked your piece and published it. The vault confirmed the release in the same transaction.'
          : `The register checked your ${mine.length} pieces and published them, one transaction each. The vault confirmed the release every time.`;
      } catch (e) {
        w.register.lastAttempt = { ...attempt, ok: false, code: contractErrorCode(e) };
        throw e;
      }
    }, { stages: REGISTER_STAGES, explain: (code) => REGISTER_REFUSALS[code as RegisterRefusal] });
  }

  /**
   * Someone who holds no piece sends the register a made-up one. Before the
   * release the register refuses it like any other; after, it fails the check
   * against the commitments made when the message was sealed.
   */
  plantPiece(to: MessageTo, actor: Actor = this.actor): Promise<boolean> {
    const by = actor.kind === 'owner' ? OWNER_FIRST : actor.kind === 'heir' ? HEIRS.find((h) => h.id === actor.id)!.name
      : actor.kind === 'guardian' ? guardianById(actor.id).name : 'Someone';
    return this.run('Sending the register a made-up piece', ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      const m = w.messages.get(to);
      if (!m?.fingerprint) throw new InputError('there is no sealed text on the register to try this on');
      await stage('circuit');
      const attempt = { at: w.chain.now, by };
      try {
        await w.chain.callContract(w.register.address, 'handOver', { witnesses: sealsWitnesses() }, ...handOverArgs(m.fingerprint, { x: 1, y: randomBytes(32) }));
      } catch (e) {
        w.register.lastAttempt = { ...attempt, ok: false, code: contractErrorCode(e) };
        throw e;
      }
      // 32 random bytes that match a commitment: not in this universe.
      throw new Error('the register accepted a made-up piece');
    }, { stages: REGISTER_STAGES, explain: (code) => REGISTER_REFUSALS[code as RegisterRefusal] });
  }

  /**
   * Open a message: with the pieces handed to the recipient, or, through the
   * register, with the pieces on its public ledger. A public disclosure can be
   * opened by anyone; a private one only on the device that holds its sealed
   * text and the recipient's half of the key.
   */
  async openMessage(to: MessageTo): Promise<string | undefined> {
    const w = this.world;
    const m = w?.messages.get(to);
    if (!w || !m) return to === 'everyone' ? 'There is no public disclosure.' : 'This device holds no sealed message.';
    if (m.opened) return undefined;
    const given = m.fingerprint
      ? piecesHandedOver(this.sealsLedger(w), m.fingerprint)
      : [...m.handed.keys()].map((id) => m.pieces.get(id)!);
    let text: string;
    try {
      text = await openMessageText(m.sealed, given);
    } catch (e) {
      if (e instanceof SealedError && e.problem === 'not enough pieces') {
        const have = given.length;
        const count = have === 0 ? 'none' : have === 1 ? 'one' : String(have);
        const verb = m.via === 'register' ? `${have > 1 ? 'are' : 'is'} on the register` : `${have > 1 ? 'have' : 'has'} arrived`;
        return `It is still locked. It needs ${m.sealed.needed} guardian piece${m.sealed.needed === 1 ? '' : 's'} and ${count} ${verb}.`;
      }
      if (e instanceof SealedError && e.problem === 'not a genuine piece') return 'One of the pieces is not a piece of this message’s key. Ask that guardian to send theirs again.';
      return 'The sealed text does not match its key, so it cannot be opened.';
    }
    m.opened = { at: w.chain.now, text };
    if (to === 'everyone') this.log('Someone', 'The public disclosure was opened', 'released', [], ['Who opened it: reading the ledger is not a transaction']);
    else this.log(recipientName(to), 'A sealed message was opened', 'released', [], ['The message', 'That it was opened, and by whom']);
    this.emit();
    return undefined;
  }

  /**
   * The owner stands behind a public statement, such as a canary: the words go
   * on her public page, and their fingerprint on the register, so anyone can
   * check that the page shows what she signed off.
   */
  setStatement(text: string): Promise<boolean> {
    return this.run('Standing behind a public statement', ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      const body = text.trim();
      if (!body) throw new InputError('write the statement first');
      if (body.length > 400) throw new InputError('keep the statement under 400 characters');
      await stage('circuit');
      await w.chain.callContract(w.register.address, 'state', { witnesses: sealsWitnesses(w.keeperSecret) }, sha256(utf8ToBytes(body)));
      w.register.statement = { text: body, at: w.chain.now };
      this.log(OWNER_NAME, 'Public statement updated', 'plain', ['A fingerprint of the statement'], ['Who wrote it', 'The words: they are on your public page, not on the chain']);
      return 'Your public page shows the statement, and the register holds its fingerprint. Anyone can check that the two match.';
    }, {
      stages: { circuit: { label: 'Running the seal register on this device', detail: 'The compiled circuit checks that this device is the keeper, then records the fingerprint.' } },
    });
  }

  /**
   * Check a copy of a sealed text against the register, as anyone can: work
   * out its fingerprint on this device and look it up on the public ledger.
   * Nothing is sent anywhere.
   */
  checkSealedCopy(text: string): { ok: true; fingerprint: string; sealedBefore: number; needed: number; pieces: number } | { ok: false; why: string } {
    const w = this.world;
    if (!w) return { ok: false, why: 'There is no vault yet.' };
    let fingerprint: Uint8Array;
    try {
      fingerprint = sealedFingerprint(sealedFromText(text.trim()));
    } catch (e) {
      return { ok: false, why: `${describeFailure(new InputError(e instanceof Error ? e.message : String(e)))} Paste the whole sealed text, from the first brace to the last.` };
    }
    const l = this.sealsLedger(w);
    if (!l.seals.member(fingerprint)) {
      return { ok: false, why: `Its fingerprint is 0x${hex(fingerprint).slice(0, 8)}…, and the register holds no seal with that fingerprint. Either this copy was changed, or it was never sealed here.` };
    }
    const seal = l.seals.lookup(fingerprint);
    return { ok: true, fingerprint: hex(fingerprint), sealedBefore: Number(seal.sealedBefore), needed: Number(seal.needed), pieces: Number(seal.pieces) };
  }

  /** A contract's public state on the demo chain, the way an indexer would serve it to a reader with no keys. */
  async contractState(address: string) {
    const w = this.world;
    if (!w || (address !== w.chain.address && address !== w.register.address && address !== w.position.address)) return undefined;
    return w.chain.getContractState('', address);
  }

  /**
   * The owner proves again that the seal register is theirs. Needed after the
   * owner's key changes, because the vault's commitment to it changes too.
   */
  proveRegister(): Promise<boolean> {
    return this.run('Proving the seal register is yours', ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      await stage('circuit');
      await w.chain.callContract(w.register.address, 'provePasskeyOwner', {
        witnesses: sealsWitnesses(w.keeperSecret, { passkey: { pk: w.passkey.pk, salt: w.ownerSalt } }),
      });
      this.log(OWNER_NAME, 'Seal register proven to be the owner\'s', 'plain', [
        'The same owner commitment the vault holds, now on the register too',
      ], ['Your passkey and the salt behind the commitment', 'Who you are']);
      return 'The register now holds the same owner commitment as your vault. Only someone with your key could have put it there, and anyone can compare the two.';
    }, {
      stages: {
        circuit: { label: 'Running the seal register on this device', detail: 'The circuit takes your passkey\'s public key and its salt, which never leave this device, and works out the commitment your vault already holds.' },
        proof: { label: 'Generating zero-knowledge proof', detail: 'On Midnight this proves you know the key behind the commitment without revealing it.' },
      },
    });
  }

  private registerView(w: World): RegisterView {
    const l = this.sealsLedger(w);
    const st = w.register.statement;
    return {
      address: w.register.address,
      vault: hex(l.vault.bytes),
      keeperCommit: hex(l.keeperCommit),
      seals: [...l.seals].map(([fp, seal]) => ({ fingerprint: hex(fp), needed: Number(seal.needed), pieces: Number(seal.pieces), sealedBefore: Number(seal.sealedBefore) })),
      pieceChecks: Number(l.pieceChecks.size()),
      handedOver: [...l.handedOver].map(([, p]) => ({ seal: hex(p.seal), x: Number(p.x), y: hex(p.y) })).sort((a, b) => a.seal.localeCompare(b.seal) || a.x - b.x),
      statementFingerprint: hex(l.statement),
      ownerCommit: hex(l.ownerCommit),
      provesOwner: registerProvesOwner(w.chain.ledger, l),
      statement: st && { ...st, genuine: hex(sha256(utf8ToBytes(st.text))) === hex(l.statement) },
      lastAttempt: w.register.lastAttempt,
    };
  }

  // ─── Recovery key ─────────────────────────────────────────────────────────
  /** The recovery key as Amara saved it, standing in for the paper in her drawer. */
  savedRecoveryKey(): string | undefined {
    const secret = this.world?.savedRecovery;
    return secret && encodeRecoveryKey(secret);
  }

  /** The key that replaces the used one when the recovery in progress finishes. */
  nextRecoveryKey(): string | undefined {
    const next = this.world?.pendingRecovery?.nextSecret;
    return next && encodeRecoveryKey(next);
  }

  /**
   * "I lost my passkey": on a new device, with only the recovery key. Proves
   * knowledge of the secret inside the circuit and proposes a new passkey and
   * the next recovery key. Nothing changes hands until the public delay is
   * over, and anything the current passkey signs before then cancels it (D18).
   * Without `keyText` the saved key is used, as a demo shortcut.
   */
  startRecovery(keyText?: string) {
    return this.run('Starting a recovery', ['prepare', 'approve', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      const secret = decodeRecoveryKey(keyText ?? this.savedRecoveryKey() ?? '');
      await stage('approve');
      // The new device makes its own passkey; the lost one is never needed.
      const passkey = w.passkey.kind === 'device' ? await createDevicePasskey() : createDemoPasskey();
      const salt = newSalt();
      const nextSecret = newRecoverySecret();
      await stage('circuit');
      const out = await w.chain.call(
        'startRecovery', { recovery: { secret } },
        pureCircuits.passkeyCommitment(passkey.pk, salt), ZERO32, recoveryCommitment(nextSecret), BigInt(w.chain.now),
      );
      this.noteEvents(out);
      w.pendingRecovery = { passkey, salt, nextSecret, startedAt: w.chain.now };
      w.recoveryNotice = undefined;
      const readyAt = Number(w.chain.ledger.recoveryReadyAt);
      this.log('Someone with the recovery key', `Recovery started · new keys take over on ${fmtShort(readyAt)}`, 'pending', [
        'Commitments to the owner keys it would install', 'A commitment to the next recovery key', `When it takes effect: ${fmtShort(readyAt)}`,
        'A "recovery started" event with no details, so the owner\'s app can raise the alarm',
      ], ['The recovery key', 'The new passkey', 'Who started it']);
      return `Recovery started. The new passkey takes over on ${fmtDate(readyAt)}, unless the current passkey signs anything before then. Save your next recovery key now.`;
    }, {
      stages: {
        approve: newPasskeyStage(this.world?.passkey.kind),
      },
      explain: (code) => {
        const w = this.world!;
        const l = w.chain.ledger;
        if (code === 'too late to recover') {
          return `A recovery takes ${span(Number(l.recoveryDelay))}, and your check-in is due on ${fmtDate(Number(l.deadline))}, so it could not finish in time. It had to start by ${fmtDate(Number(lastRecoveryStart(l)))}. Nothing was sent. Without a check-in, the will goes to your heirs as written.`;
        }
        if (code === 'not armed') return 'A countdown has started, and a recovery key does nothing during one. Only the current passkey can cancel a countdown. Nothing was sent.';
        if (code === 'switch already expired') return 'The check-in deadline has passed, and a recovery key only works before it. Nothing was sent.';
        if (code === 'stale timestamp') return 'A recovery was started a moment ago. Starting again must set a later date: move the clock forward and try again.';
        if (code === 'unknown recovery key') return isZeroBytes(l.recoveryKeyCommit)
          ? 'This vault has no recovery key, so nothing can be recovered. Nothing was sent.'
          : 'That is a valid recovery key, but not the one for this vault. Nothing was sent. Check that you have the right paper.';
        return undefined;
      },
    });
  }

  /** The owner has read the note about a recovery that was cancelled or finished. */
  dismissRecoveryNotice() {
    if (!this.world) return;
    this.world.recoveryNotice = undefined;
    this.emit();
  }

  /** Anyone may complete a recovery once its delay is over; what it installs was fixed at the start. */
  finishRecovery(who: string) {
    return this.run('Finishing the recovery', ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      await stage('circuit');
      await w.chain.call('finishRecovery', {});
      const p = w.pendingRecovery;
      if (p) {
        w.formerPasskey = { passkey: w.passkey, salt: w.ownerSalt };
        w.passkey = p.passkey;
        w.ownerSalt = p.salt;
        w.savedRecovery = p.nextSecret;
        w.pendingRecovery = undefined;
      }
      w.recoveryCompletedAt = w.chain.now;
      w.recoveryNotice = 'finished';
      this.log(who, 'Recovery finished · the new keys now own the vault', 'armed', [
        'The owner key commitments, replaced by the ones proposed at the start', 'The recovery key commitment, replaced by the next one',
      ], ['Nothing: finishing takes no private input, so anyone can do it']);
      return 'The recovery is finished. The new passkey now owns the vault and the old one no longer works. Your check-in deadline did not move.';
    }, {
      explain: (code) => {
        const l = this.world!.chain.ledger;
        if (code === 'recovery delay open') return `The recovery delay runs until ${fmtDate(Number(l.recoveryReadyAt))}. Until then, anything the current passkey signs cancels it.`;
        if (code === 'not armed') return 'A recovery cannot finish while a countdown is running. A check-in with the current passkey cancels the countdown, and the recovery with it.';
        if (code === 'switch already expired') return 'The check-in deadline passed before the recovery was finished, so it can no longer finish.';
        return undefined;
      },
    });
  }

  /** After a finished recovery: show that the passkey it replaced is refused. */
  tryFormerPasskey() {
    return this.run('Checking in with the old passkey', ['prepare', 'approve', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      const old = w.formerPasskey;
      if (!old) throw new InputError('no passkey has been replaced on this vault');
      const next = BigInt(w.chain.now + w.setup.every);
      const digest = checkInDigest(w.chain.address, next, w.chain.ledger.nonce);
      await stage('approve');
      const assertion = await approveWithPasskey(old.passkey, digest);
      await stage('circuit');
      await w.chain.call('checkInPasskey', withPasskeyApproval({ passkey: { pk: old.passkey.pk, salt: old.salt } }, digest, assertion), next);
      w.lastCheckIn = w.chain.now;
      return 'The old passkey was accepted.';
    }, {
      explain: (code) => (code === 'unknown owner key'
        ? 'The vault refused the old passkey: after the recovery it is no longer an owner key. Only the new passkey can check in or change the will.'
        : undefined),
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

  /**
   * Ask the savings contract to pay out to `to`. The contract checks the
   * caller's secret against its beneficiary commitment, then calls the vault's
   * `isReleasedForContract` circuit, and pays only if the vault says yes.
   *
   * Only the beneficiary's device holds the secret. Anyone else can only
   * guess one, which the contract refuses.
   */
  withdrawPosition(actor: Actor = this.actor, to: string = sampleUserAddress()) {
    const holder = actor.kind === 'heir' && actor.id === POSITION.beneficiary;
    const by = actor.kind === 'owner' ? OWNER_FIRST : actor.kind === 'heir' ? HEIRS.find((h) => h.id === actor.id)!.name
      : actor.kind === 'guardian' ? guardianById(actor.id).name : 'Someone';
    return this.run(`Withdrawing from ${POSITION.name}`, ['prepare', 'circuit', 'proof', 'record'], async (stage) => {
      const w = this.world!;
      if (!/^[0-9a-f]{64}$/i.test(to)) throw new InputError('that does not look like an address. It should be 64 hexadecimal characters');
      await stage('circuit');
      const secret = holder ? w.beneficiarySecret : randomBytes(32);
      const attempt = { at: w.chain.now, by };
      try {
        const out = await w.chain.callContract(
          w.position.address, 'withdrawToBeneficiary', { witnesses: savingsWitnesses(secret) }, { bytes: encodeUserAddress(to.toLowerCase()) },
        );
        const paid = out.payouts.reduce((a, [, v]) => a + v, 0n);
        w.position.paidTo = to.toLowerCase();
        w.position.lastAttempt = {
          ...attempt, ok: true,
          calls: out.trace.map((t) => ({ contract: t.address === w.chain.address ? 'vault' as const : 'savings' as const, circuit: t.circuitId })),
        };
        this.log('The beneficiary', `${POSITION.name} paid out · ${paid.toLocaleString()} ${TOKEN}`, 'released', [
          'That the savings contract asked this vault whether it is released', `${paid.toLocaleString()} ${TOKEN} to a fresh address`, 'Withdrawn: yes',
        ], [`That it was ${by}`, "The beneficiary's secret"]);
        return `${paid.toLocaleString()} ${TOKEN} sent from ${POSITION.name} to 0x${to.slice(0, 4)}…${to.slice(-4)}. The vault confirmed the release in the same transaction.`;
      } catch (e) {
        w.position.lastAttempt = { ...attempt, ok: false, code: contractErrorCode(e) };
        throw e;
      }
    }, {
      stages: {
        circuit: {
          label: `Running ${POSITION.name}, which calls the vault`,
          detail: 'Two compiled circuits run on this device: the savings contract and, inside it, the vault\'s "is it released?" check.',
        },
        proof: { label: 'Generating two zero-knowledge proofs', detail: 'On Midnight this step proves both circuits ran correctly, one proof each, in one transaction.' },
      },
      explain: (code) => POSITION_REFUSALS[code as PositionRefusal],
    });
  }

  private positionView(w: World): PositionView {
    const l = escrowModule.ledger(w.chain.ledgerOf(w.position.address));
    return {
      name: POSITION.name,
      address: w.position.address,
      vault: hex(l.vault.bytes),
      beneficiaryCommit: hex(l.beneficiaryCommit),
      held: l.held,
      withdrawn: l.withdrawn,
      beneficiary: POSITION.beneficiary,
      paidTo: w.position.paidTo,
      lastAttempt: w.position.lastAttempt,
    };
  }

  /**
   * Each guardian checks their own path against the public guardians root, as
   * their app would. The answer only changes when the root does, so it is kept.
   */
  private stillGuardian(w: World, id: number, root: bigint): boolean {
    if (this.guardianChecks?.root !== root) this.guardianChecks = { root, current: new Map() };
    const known = this.guardianChecks.current;
    if (!known.has(id)) known.set(id, isCurrentGuardian(w.guardianHeld.get(id)!, root));
    return known.get(id)!;
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
        grace: 0, switchOpensAt: 0, pendingUntil: 0, releasedAt: 0, estate: 0n, estateSnapshot: 0n, estatePaid: 0n, nonce: 0n, willVersion: 0n,
        guardianRound: 0n, guardianVotes: 0n, guardianThreshold: 0n, feeBps: 0n,
        chain: {
          address: '', willRoot: '', guardianRoot: '', ownerPasskeyCommit: '', attestorKeyCommit: '', recoveryKeyCommit: '',
          recoveryReadyAt: 0, recoveryNonce: 0n, recoveryPasskeyCommit: '', claimNullifiers: [], guardianNullifierCount: 0,
        },
        guardians: [], events: [],
        recovery: { state: 'off', readyAt: 0, delay: 0, lastStart: 0, nextKeyToSave: false, formerPasskey: false },
        heirs: [], messages: [], leafHashes: [], votedThisRound: [], activity: [], tx: this.tx, toast: this.toast,
        register: { address: '', vault: '', keeperCommit: '', seals: [], pieceChecks: 0, handedOver: [], statementFingerprint: '0'.repeat(64), ownerCommit: '0'.repeat(64), provesOwner: false },
        position: { name: POSITION.name, address: '', vault: '', beneficiaryCommit: '', held: 0n, withdrawn: false, beneficiary: POSITION.beneficiary },
      };
    }
    const l = w.chain.ledger;
    const snapshotBase = l.phase === Phase.released ? l.estateSnapshot : l.estateTotal;
    const leaves: HeirLeaf[] = w.will.leaves;
    const recovery = recoveryStatus(l, BigInt(w.chain.now));
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
      grace: Number(l.gracePeriod),
      switchOpensAt: Number(timeoutOpensAt(l)),
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
      feeBps: l.feeBps,
      chain: {
        address: w.chain.address,
        willRoot: fieldHex(l.willRoot),
        guardianRoot: fieldHex(l.guardianRoot),
        ownerPasskeyCommit: hex(l.ownerPasskeyCommit),
        attestorKeyCommit: hex(l.attestorKeyCommit),
        recoveryKeyCommit: hex(l.recoveryKeyCommit),
        recoveryReadyAt: Number(l.recoveryReadyAt),
        recoveryNonce: l.recoveryNonce,
        recoveryPasskeyCommit: hex(l.recoveryPasskeyCommit),
        claimNullifiers: [...w.claimed.values()].filter((n) => l.claimNullifiers.member(Uint8Array.from(n.match(/../g)!.map((x) => parseInt(x, 16))))),
        guardianNullifierCount: Number(l.guardianNullifiers.size()),
      },
      guardians: w.guardianCast.map((id) => ({ ...guardianById(id), current: this.stillGuardian(w, id, l.guardianRoot) })),
      recovery: {
        state: recovery.state,
        readyAt: 'readyAt' in recovery ? Number(recovery.readyAt) : 0,
        delay: Number(l.recoveryDelay),
        lastStart: Number(lastRecoveryStart(l)),
        startedAt: w.pendingRecovery?.startedAt,
        cancelledAt: w.recoveryCancelledAt,
        completedAt: w.recoveryCompletedAt,
        notice: w.recoveryNotice,
        nextKeyToSave: !!w.pendingRecovery,
        formerPasskey: !!w.formerPasskey,
      },
      events: w.events,
      willChangedAt: w.willChangedAt,
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
          sawWillChange: w.sawWillChange.has(profile.id),
        };
      }),
      position: this.positionView(w),
      register: this.registerView(w),
      messages: MESSAGE_TO.flatMap((to): MessageView[] => {
        const m = w.messages.get(to);
        if (!m) return [];
        const seals = this.sealsLedger(w);
        const onLedger = m.fingerprint ? piecesHandedOver(seals, m.fingerprint).map((p) => p.x) : [];
        return [{
          to, via: m.via, sealedAt: m.sealedAt, text: m.text, bytes: m.sealed.ciphertext.length, sealedStart: hex(m.sealed.ciphertext.slice(0, 24)),
          sealedText: sealedToText(m.sealed),
          fingerprint: m.fingerprint && hex(m.fingerprint),
          sealedBefore: m.fingerprint && seals.seals.member(m.fingerprint) ? Number(seals.seals.lookup(m.fingerprint).sealedBefore) : undefined,
          needed: m.sealed.needed, holders: [...m.pieces.keys()],
          handed: m.via === 'register' ? [...m.pieces].filter(([, p]) => onLedger.includes(p.x)).map(([id]) => id) : [...m.handed.keys()],
          opened: m.opened,
        }];
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
