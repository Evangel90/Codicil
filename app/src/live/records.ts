// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// What a person's browser keeps about a vault, and the three ways it moves:
//
//   records   one per vault this person owns, inherits from or guards. They
//             hold every secret the chain never sees: the will, the salts,
//             heirs' keys, guardians' secrets, the maintenance key.
//   kits      what an owner hands an heir or a guardian so they can act from
//             their own browser: one line of text, or a link.
//   backups   all records in one file, locked with a passphrase, so a cleared
//             browser is not a lost vault.
//
// Nothing here talks to a network.

import type { HeirLeaf } from '@codicil/contracts/vault';
import { decodeHeirLetter, type MerklePath } from '@codicil/sdk';
import type { DeploymentRecord } from '../chain/types.js';
import type { OwnerPasskey } from '../demo/passkey.js';
import { decodeJson, encodeJson, fromBase64Url, toBase64Url } from './codec.js';
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

export interface HeirSecret {
  id: string;
  name: string;
  shareBps: bigint;
  /** Unix seconds before which this share cannot be claimed; 0 = at release. */
  unlockAt: bigint;
  /** The heir's key, made on the owner's device and handed over in their kit. */
  sk: bigint;
  keySalt: Uint8Array;
  backup?: { name: string; sk: bigint; keySalt: Uint8Array };
}

export interface GuardianSecret {
  id: string;
  name: string;
  secret: Uint8Array;
}

export interface ActivityEntry {
  at: number;
  what: string;
  tone: 'armed' | 'pending' | 'released' | 'public' | 'plain';
  txHash?: string;
}

export interface OwnerRecord {
  role: 'owner';
  id: string;
  network: string;
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
  activity: ActivityEntry[];
}

export interface HeirRecord {
  role: 'heir';
  id: string;
  network: string;
  address: string;
  name: string;
  ownerName: string;
  /** The heir letter: the will entry and its Merkle path. */
  letter: string;
  sk: bigint;
  keySalt: Uint8Array;
  /** True when this person is the backup for the entry, not its first heir. */
  backup: boolean;
  claimed?: { at: number; amount: bigint; to: string; txHash?: string };
}

export interface GuardianRecord {
  role: 'guardian';
  id: string;
  network: string;
  address: string;
  name: string;
  ownerName: string;
  secret: Uint8Array;
  path: MerklePath;
  /** The round this guardian last voted in. */
  votedRound?: bigint;
}

export type VaultRecord = OwnerRecord | HeirRecord | GuardianRecord;

/** The address of the vault a record is about, once it has one. */
export const recordAddress = (r: VaultRecord): string | undefined => (r.role === 'owner' ? r.deployment?.address : r.address);

// ─── Storage ────────────────────────────────────────────────────────────────

/** Where records are kept. One string: the whole set is small and is written whole. */
export interface RecordStorage {
  load(): string | null;
  save(text: string): void;
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
  return typeof o.id === 'string' && typeof o.network === 'string' && (o.role === 'owner' || o.role === 'heir' || o.role === 'guardian');
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
      : 'that is not a Codicil invitation. It should start with "codicil:heir-kit" or "codicil:guardian-kit", or be the link the owner sent you');
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
    const further = mine.role === 'owner' && r.role === 'owner'
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
