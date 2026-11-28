// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// What a person's browser keeps about a vault, and the ways it moves:
//
//   records      one per vault this person owns, inherits from or guards. They
//                hold what the chain never sees: the will, the salts, the
//                maintenance key, and any key that cannot be rebuilt from the
//                person's own root (keyring.ts).
//   invitations  the owner asks an heir or a guardian to make their own keys.
//                No secret is in it. The invitee answers with a reply:
//                fingerprints of their keys and a public encryption key.
//   letters      what the owner sends back once the vault exists (the heir
//                letter, the guardian's proof), encrypted to that person.
//   kits         the older way: the owner's device makes the person's keys and
//                hands them over. Quicker, but the owner knows those keys.
//   backups      all records in one file. Old files were locked with a
//                passphrase; new ones with the keyring (keyring.ts).
//
// Nothing here talks to a network.

import type { HeirLeaf } from '@codicil/contracts/vault';
import { decodeHeirLetter, type MerklePath } from '@codicil/sdk';
import type { DeploymentRecord } from '../chain/types.js';
import type { OwnerPasskey } from '../demo/passkey.js';
import { decodeJson, encodeJson, fromBase64Url, toBase64Url, toHex } from './codec.js';
import { InputProblem } from './problems.js';

// ─── Records ────────────────────────────────────────────────────────────────

/** The vault's timers, in seconds. Fixed once the vault is created. */
export interface LiveTimers {
  /** How often the owner checks in. */
  every: number;
  /** The challenge window: time to cancel after the switch starts. */
  window: number;
  /** Extra time to check in after a missed deadline; 0 = none. */
  grace: number;
  /** Minutes instead of days, for trying the whole flow in one sitting. */
  testing: boolean;
}

/**
 * How the owner reaches a person who made their own keys: the invitation they
 * answered, and the public key letters to them are encrypted to.
 */
export interface Invitee {
  inviteId: string;
  boxPublicKey: Uint8Array;
}

/**
 * One person in the will. Either they made their own key and sent a reply
 * (`invitee` is set, and the owner never sees their key), or the owner's
 * device made it and hands it over in a kit (`sk` and `keySalt` are set).
 */
export interface HeirSecret {
  id: string;
  name: string;
  shareBps: bigint;
  /** Unix seconds before which this share cannot be claimed; 0 = at release. */
  unlockAt: bigint;
  sk?: bigint;
  keySalt?: Uint8Array;
  invitee?: Invitee;
  backup?: { name: string; sk?: bigint; keySalt?: Uint8Array; invitee?: Invitee };
}

export interface GuardianSecret {
  id: string;
  name: string;
  /** Kit flow: the secret, made on the owner's device. */
  secret?: Uint8Array;
  /** Reply flow: the fingerprint the guardian sent. Their secret stays with them. */
  leaf?: Uint8Array;
  invitee?: Invitee;
}

export interface ActivityEntry {
  at: number;
  what: string;
  tone: 'armed' | 'pending' | 'released' | 'public' | 'plain';
  txHash?: string;
}

/** A recovery this device started: the new passkey that takes over when it finishes. */
export interface PendingRecovery {
  passkey: OwnerPasskey;
  salt: Uint8Array;
  /** Which recovery key the vault will hold afterwards (see `recoveryLabel`). */
  generation: number;
  startedAt: number;
}

interface RecordBase {
  id: string;
  network: string;
  /**
   * The root this record's keys come from, when it is not this browser's own:
   * a record restored from another keyring keeps the root it was made with.
   */
  root?: Uint8Array;
}

export interface OwnerRecord extends RecordBase {
  role: 'owner';
  createdAt: number;
  ownerName: string;
  passkey: OwnerPasskey;
  ownerSalt: Uint8Array;
  timers: LiveTimers;
  /** The longest a check-in may push the deadline, seconds. */
  maxPeriod: number;
  heirs: HeirSecret[];
  /** The will as sealed, entry for entry with `heirs`. */
  leaves: HeirLeaf[];
  guardians: GuardianSecret[];
  threshold: number;
  /** Set as soon as a deployment starts; `complete` once every circuit is in. */
  deployment?: DeploymentRecord;
  firstDeadline?: number;
  lastCheckIn?: number;
  /** The public wait before a recovery takes effect, seconds. Absent on vaults made without a recovery key. */
  recoveryDelay?: number;
  /** How many recoveries have finished: picks which secret the vault's recovery key is now. */
  recoveryGeneration?: number;
  pendingRecovery?: PendingRecovery;
  activity: ActivityEntry[];
}

export interface HeirRecord extends RecordBase {
  role: 'heir';
  address: string;
  name: string;
  ownerName: string;
  /** The heir letter: the will entry and its Merkle path. */
  letter: string;
  /** Kit flow only. In the reply flow the key is rebuilt from the root and `inviteId`. */
  sk?: bigint;
  keySalt?: Uint8Array;
  inviteId?: string;
  /** True when this person is the backup for the entry, not its first heir. */
  backup: boolean;
  claimed?: { at: number; amount: bigint; to: string; txHash?: string };
  /** What this person did from this browser. */
  activity?: ActivityEntry[];
}

export interface GuardianRecord extends RecordBase {
  role: 'guardian';
  address: string;
  name: string;
  ownerName: string;
  /** Kit flow only. In the reply flow the secret is rebuilt from the root and `inviteId`. */
  secret?: Uint8Array;
  inviteId?: string;
  path: MerklePath;
  /** The round this guardian last voted in. */
  votedRound?: bigint;
  /** What this person did from this browser. */
  activity?: ActivityEntry[];
}

/** An invitation this person answered, waiting for the owner's letter. */
export interface InvitedRecord extends RecordBase {
  role: 'invited';
  inviteId: string;
  invitedAs: 'heir' | 'guardian';
  name: string;
  ownerName: string;
  backup: boolean;
  activity?: ActivityEntry[];
}

export type VaultRecord = OwnerRecord | HeirRecord | GuardianRecord | InvitedRecord;

/** The address of the vault a record is about, once it has one. */
export const recordAddress = (r: VaultRecord): string | undefined =>
  (r.role === 'owner' ? r.deployment?.address : r.role === 'invited' ? undefined : r.address);

/** The label a vault's recovery secret is derived with, from the owner's root. */
export const recoveryLabel = (recordId: string, generation = 0): string =>
  generation === 0 ? `vault-recovery:${recordId}` : `vault-recovery:${recordId}:${generation}`;

// ─── Storage ────────────────────────────────────────────────────────────────

/** Where records are kept. One string: the whole set is small and is written whole. */
export interface RecordStorage {
  load(): string | null;
  save(text: string): void;
  /**
   * Keep a copy of stored text this version cannot read, before anything new
   * is written over it: damaged or from a newer version, it may still be
   * someone's only copy of their keys.
   */
  keepAside?(text: string): void;
}

export const STORAGE_KEY = 'codicil.vaults.v1';

export function memoryStorage(initial: string | null = null): RecordStorage & { text: string | null } {
  return {
    text: initial,
    load() { return this.text; },
    save(text) { this.text = text; },
  };
}

/** The browser's local storage: stays on this device, in this browser profile, until it is cleared. */
export function browserStorage(key = STORAGE_KEY): RecordStorage {
  return {
    load: () => { try { return localStorage.getItem(key); } catch { return null; } },
    save: (text) => { localStorage.setItem(key, text); },
    keepAside: (text) => { try { localStorage.setItem(`${key}.unreadable.${Date.now()}`, text); } catch { /* storage full: nothing more to do */ } },
  };
}

const FORMAT = 1;

export function encodeRecords(records: readonly VaultRecord[]): string {
  return encodeJson({ format: FORMAT, records });
}

/** Records from storage. Anything unreadable is dropped rather than breaking the app. */
export function decodeRecords(text: string | null): VaultRecord[] {
  if (!text) return [];
  try {
    const parsed = decodeJson<{ format?: number; records?: unknown }>(text);
    if (parsed.format !== FORMAT || !Array.isArray(parsed.records)) return [];
    return (parsed.records as VaultRecord[]).filter(isRecord);
  } catch {
    return [];
  }
}

function isRecord(r: unknown): r is VaultRecord {
  if (r === null || typeof r !== 'object') return false;
  const o = r as Partial<VaultRecord>;
  return typeof o.id === 'string' && typeof o.network === 'string' && (o.role === 'owner' || o.role === 'heir' || o.role === 'guardian' || o.role === 'invited');
}

// ─── Kits ───────────────────────────────────────────────────────────────────

export const HEIR_KIT_PREFIX = 'codicil:heir-kit:v1:';
export const GUARDIAN_KIT_PREFIX = 'codicil:guardian-kit:v1:';

export interface HeirKit {
  kind: 'heir';
  network: string;
  /** The heir's name as the owner wrote it; never published. */
  name: string;
  ownerName: string;
  letter: string;
  sk: bigint;
  keySalt: Uint8Array;
  backup: boolean;
}

export interface GuardianKit {
  kind: 'guardian';
  network: string;
  address: string;
  name: string;
  ownerName: string;
  secret: Uint8Array;
  path: MerklePath;
}

export type Kit = HeirKit | GuardianKit;

const pack = (prefix: string, value: unknown): string => prefix + toBase64Url(new TextEncoder().encode(encodeJson(value)));

export function encodeKit(kit: Kit): string {
  const { kind, ...rest } = kit;
  return pack(kind === 'heir' ? HEIR_KIT_PREFIX : GUARDIAN_KIT_PREFIX, rest);
}

/** A link that opens the app with the kit already in hand. The kit is in the fragment, which browsers do not send to servers. */
export const kitLink = (origin: string, kit: string): string => `${origin}/#/app/join/${kit}`;

/**
 * Read what an owner sent: the kit text itself, or a link that carries it.
 * Throws an `InputProblem` whose message can be shown as it is.
 */
export function decodeKit(text: string): Kit {
  const t = text.trim();
  const at = Math.max(t.indexOf(HEIR_KIT_PREFIX), t.indexOf(GUARDIAN_KIT_PREFIX));
  if (at < 0) {
    throw new InputProblem(t.startsWith('codicil:claim:')
      ? 'that is a bare heir letter, which is not enough to claim by itself. Ask the owner for the full invitation: it starts with "codicil:heir-kit"'
      : t.includes(REPLY_PREFIX)
        ? 'that is a reply. It goes back to the person who invited you, who pastes it into their will'
        : 'that is not a Codicil invitation. It should start with "codicil:invite", "codicil:letter", "codicil:heir-kit" or "codicil:guardian-kit", or be the link the owner sent you');
  }
  const body = t.slice(at).split(/[\s"'<>]/)[0];
  const heir = body.startsWith(HEIR_KIT_PREFIX);
  let raw: Record<string, unknown>;
  try {
    raw = decodeJson<Record<string, unknown>>(new TextDecoder().decode(fromBase64Url(body.slice((heir ? HEIR_KIT_PREFIX : GUARDIAN_KIT_PREFIX).length))));
  } catch {
    throw new InputProblem('that invitation is incomplete or damaged. Copy it again, all of it, or ask the owner to send it again');
  }
  const str = (k: string): string => {
    if (typeof raw[k] !== 'string') throw new InputProblem('that invitation is missing a part. Ask the owner to send it again');
    return raw[k] as string;
  };
  const bytes = (k: string): Uint8Array => {
    if (!(raw[k] instanceof Uint8Array)) throw new InputProblem('that invitation is missing a part. Ask the owner to send it again');
    return raw[k] as Uint8Array;
  };
  if (heir) {
    if (typeof raw.sk !== 'bigint') throw new InputProblem('that invitation is missing its key. Ask the owner to send it again');
    const letter = str('letter');
    try {
      decodeHeirLetter(letter);
    } catch (e) {
      throw new InputProblem(e instanceof Error ? e.message : String(e));
    }
    return { kind: 'heir', network: str('network'), name: str('name'), ownerName: str('ownerName'), letter, sk: raw.sk, keySalt: bytes('keySalt'), backup: raw.backup === true };
  }
  const path = raw.path as MerklePath | undefined;
  if (!path || !(path.leaf instanceof Uint8Array) || !Array.isArray(path.path)) throw new InputProblem('that invitation is missing its proof. Ask the owner to send it again');
  const address = str('address');
  if (!/^[0-9a-f]{64}$/i.test(address)) throw new InputProblem('that invitation names a vault address that cannot be right. Ask the owner to send it again');
  return { kind: 'guardian', network: str('network'), address, name: str('name'), ownerName: str('ownerName'), secret: bytes('secret'), path };
}

// ─── Invitations, replies and letters ───────────────────────────────────────
// The way that keeps each person's keys with them (docs/DECISIONS.md D22):
//
//   owner → invitee   an invitation: who is asking, for what. No secret.
//   invitee → owner   a reply: fingerprints of the invitee's own keys, made
//                     from their root, and their public encryption key.
//   owner → invitee   once the vault exists, a letter (the heir letter or the
//                     guardian's proof) encrypted to that key. Safe to send
//                     any way at all: only the invitee can open it.

export const INVITE_PREFIX = 'codicil:invite:v1:';
export const REPLY_PREFIX = 'codicil:reply:v1:';
export const LETTER_BOX_PREFIX = 'codicil:letter:v1:';

export interface Invitation {
  kind: 'invite';
  /** Random. The invitee's keys for this vault are derived with it, so it is never reused. */
  id: string;
  network: string;
  ownerName: string;
  role: 'heir' | 'guardian';
  /** The invitee's name as the owner wrote it. */
  name: string;
  /** An heir invited as the backup for someone else's share. */
  backup: boolean;
}

export interface Reply {
  kind: 'reply';
  inviteId: string;
  role: 'heir' | 'guardian';
  /** The name from the invitation, so the owner can tell replies apart. */
  name: string;
  boxPublicKey: Uint8Array;
  /** Heir: `edKeyCommitment(pk, salt)` of their own key. */
  heirKeyCommit?: Uint8Array;
  /** Guardian: `guardianLeaf(secret)` of their own secret. */
  guardianLeaf?: Uint8Array;
}

/** A letter for one invitee, sealed to their encryption key. */
export interface SealedLetter {
  kind: 'letter';
  inviteId: string;
  box: Uint8Array;
}

/** What is inside a sealed letter. */
export type LetterBody =
  | { kind: 'heir'; network: string; ownerName: string; name: string; letter: string; backup: boolean }
  | { kind: 'guardian'; network: string; ownerName: string; name: string; address: string; path: MerklePath };

/** The context a letter is sealed in: a box made for one invitation does not open as another's. */
export const letterContext = (inviteId: string): string => `codicil:letter:${inviteId}`;

export function newInvitation(i: Omit<Invitation, 'kind' | 'id'>): Invitation {
  return { kind: 'invite', id: toHex(crypto.getRandomValues(new Uint8Array(16))), ...i };
}

const strip = <T extends { kind: string }>(v: T): Omit<T, 'kind'> => {
  const { kind: _kind, ...rest } = v;
  return rest;
};
export const encodeInvitation = (i: Invitation): string => pack(INVITE_PREFIX, strip(i));
export const encodeReply = (r: Reply): string => pack(REPLY_PREFIX, strip(r));
export const encodeSealedLetter = (l: SealedLetter): string => pack(LETTER_BOX_PREFIX, strip(l));

function unpack(text: string, prefix: string, what: string): Record<string, unknown> | undefined {
  const t = text.trim();
  const at = t.indexOf(prefix);
  if (at < 0) return undefined;
  const body = t.slice(at + prefix.length).split(/[\s"'<>]/)[0];
  try {
    return decodeJson<Record<string, unknown>>(new TextDecoder().decode(fromBase64Url(body)));
  } catch {
    throw new InputProblem(`that ${what} is incomplete or damaged. Copy it again, all of it`);
  }
}

const missing = (what: string) => new InputProblem(`that ${what} is missing a part. Ask for it to be sent again`);
const isBytes = (v: unknown, length?: number): v is Uint8Array => v instanceof Uint8Array && (length === undefined || v.length === length);

/** An invitation, from its text or a link that carries it; undefined when the text is not one. */
export function decodeInvitation(text: string): Invitation | undefined {
  const raw = unpack(text, INVITE_PREFIX, 'invitation');
  if (!raw) return undefined;
  const { id, network, ownerName, role, name } = raw;
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id) || typeof network !== 'string' || typeof ownerName !== 'string'
    || (role !== 'heir' && role !== 'guardian') || typeof name !== 'string') throw missing('invitation');
  return { kind: 'invite', id, network, ownerName, role, name, backup: raw.backup === true };
}

/** A reply an invitee sent back. Throws an `InputProblem` that can be shown as it is. */
export function decodeReply(text: string): Reply {
  const raw = unpack(text, REPLY_PREFIX, 'reply');
  if (!raw) {
    throw new InputProblem(text.includes(INVITE_PREFIX)
      ? 'that is the invitation itself. Send it to them; their reply starts with "codicil:reply"'
      : 'that is not a reply. It should start with "codicil:reply"');
  }
  const { inviteId, role, name, boxPublicKey, heirKeyCommit, guardianLeaf } = raw;
  if (typeof inviteId !== 'string' || (role !== 'heir' && role !== 'guardian') || typeof name !== 'string' || !isBytes(boxPublicKey, 32)) throw missing('reply');
  if (role === 'heir' && !isBytes(heirKeyCommit, 32)) throw missing('reply');
  if (role === 'guardian' && !isBytes(guardianLeaf, 32)) throw missing('reply');
  return {
    kind: 'reply', inviteId, role, name, boxPublicKey,
    ...(role === 'heir' ? { heirKeyCommit: heirKeyCommit as Uint8Array } : { guardianLeaf: guardianLeaf as Uint8Array }),
  };
}

export function decodeSealedLetter(text: string): SealedLetter | undefined {
  const raw = unpack(text, LETTER_BOX_PREFIX, 'letter');
  if (!raw) return undefined;
  if (typeof raw.inviteId !== 'string' || !isBytes(raw.box)) throw missing('letter');
  return { kind: 'letter', inviteId: raw.inviteId, box: raw.box };
}

export function encodeLetterBody(body: LetterBody): Uint8Array {
  return new TextEncoder().encode(encodeJson(body));
}

export function decodeLetterBody(bytes: Uint8Array): LetterBody {
  let raw: Record<string, unknown>;
  try {
    raw = decodeJson<Record<string, unknown>>(new TextDecoder().decode(bytes));
  } catch {
    throw new InputProblem('that letter opened, but what is inside is damaged. Ask the owner to send it again');
  }
  const str = (k: string): string => {
    if (typeof raw[k] !== 'string') throw missing('letter');
    return raw[k] as string;
  };
  if (raw.kind === 'heir') {
    const letter = str('letter');
    try {
      decodeHeirLetter(letter);
    } catch (e) {
      throw new InputProblem(e instanceof Error ? e.message : String(e));
    }
    return { kind: 'heir', network: str('network'), ownerName: str('ownerName'), name: str('name'), letter, backup: raw.backup === true };
  }
  const path = raw.path as MerklePath | undefined;
  if (raw.kind !== 'guardian' || !path || !(path.leaf instanceof Uint8Array) || !Array.isArray(path.path)) throw missing('letter');
  const address = str('address');
  if (!/^[0-9a-f]{64}$/i.test(address)) throw missing('letter');
  return { kind: 'guardian', network: str('network'), ownerName: str('ownerName'), name: str('name'), address, path };
}

// ─── Backups ────────────────────────────────────────────────────────────────

export const BACKUP_FORMAT = 'codicil-backup';
const KDF_ITERATIONS = 310_000;
export const MIN_PASSPHRASE = 8;

interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: 1;
  exportedAt: string;
  /** How many vaults are inside; readable without the passphrase. */
  vaults: number;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  data: string;
}

async function keyFrom(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt.slice().buffer as ArrayBuffer, iterations },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** Every record, encrypted with a key made from the passphrase. The result is the text of the backup file. */
export async function exportBackup(records: readonly VaultRecord[], passphrase: string, now: Date = new Date()): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE) throw new InputProblem(`choose a passphrase of at least ${MIN_PASSPHRASE} characters`);
  if (records.length === 0) throw new InputProblem('there is nothing to back up yet');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(passphrase, salt, KDF_ITERATIONS);
  const plain = new TextEncoder().encode(encodeRecords(records));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const file: BackupFile = {
    format: BACKUP_FORMAT, version: 1, exportedAt: now.toISOString(), vaults: records.length,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toBase64Url(salt) },
    cipher: { name: 'AES-GCM', iv: toBase64Url(iv) },
    data: toBase64Url(data),
  };
  return JSON.stringify(file, null, 2);
}

/** The records inside a backup file. Throws an `InputProblem` for a wrong passphrase or a file that is not a backup. */
export async function importBackup(text: string, passphrase: string): Promise<VaultRecord[]> {
  let file: Partial<BackupFile>;
  try {
    file = JSON.parse(text) as Partial<BackupFile>;
  } catch {
    throw new InputProblem('that file is not a Codicil backup');
  }
  if (file.format !== BACKUP_FORMAT || !file.kdf || !file.cipher || typeof file.data !== 'string') throw new InputProblem('that file is not a Codicil backup');
  if (file.version !== 1) throw new InputProblem('that backup was made by a newer version of Codicil. Update the app and try again');
  let plain: ArrayBuffer;
  try {
    const key = await keyFrom(passphrase, fromBase64Url(file.kdf.salt), file.kdf.iterations);
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(file.cipher.iv).slice().buffer as ArrayBuffer }, key, fromBase64Url(file.data).slice().buffer as ArrayBuffer);
  } catch {
    throw new InputProblem('that passphrase does not open this backup. Check it and try again');
  }
  const records = decodeRecords(new TextDecoder().decode(plain));
  if (records.length === 0) throw new InputProblem('that backup has no vaults in it');
  return records;
}

/**
 * Add restored records to the ones already here. A vault this browser already
 * holds is replaced by the copy that knows more: a finished deployment beats
 * an unfinished one, and otherwise the copy already here is kept.
 */
export function mergeRecords(current: readonly VaultRecord[], incoming: readonly VaultRecord[]): { records: VaultRecord[]; added: number; updated: number } {
  const out = [...current];
  let added = 0;
  let updated = 0;
  for (const r of incoming) {
    const at = out.findIndex((x) => x.id === r.id);
    if (at < 0) {
      out.push(r);
      added++;
      continue;
    }
    const mine = out[at];
    // A letter arrived on the other device: the invitation became an heir's or a guardian's record.
    const answered = mine.role === 'invited' && r.role !== 'invited';
    const further = answered || mine.role === 'owner' && r.role === 'owner'
      && (r.deployment?.complete === true && mine.deployment?.complete !== true
        || (r.deployment?.inserted.length ?? -1) > (mine.deployment?.inserted.length ?? -1)
        || r.activity.length > mine.activity.length);
    if (further) {
      out[at] = r;
      updated++;
    }
  }
  return { records: out, added, updated };
}
