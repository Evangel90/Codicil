// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// A person's records, kept encrypted under a key from their identity root,
// with the keyring that opens the root beside them (docs/DECISIONS.md D22).
//
//   in the browser   { format: 2, keyring, iv, data }: the records and the
//                    person's passkey, encrypted with recordsKeyFromRoot(root).
//   a backup file    the same, as a file. It needs no passphrase: whatever
//                    opens the keyring (Face ID, the printed recovery code)
//                    opens the file.
//
// Older browsers kept the records in plain text, and older backup files are
// locked with a passphrase. Both are still read (records.ts).
//
// Nothing here talks to a network or asks a person for anything.

import {
  keyringFromText, keyringToText, KeyringError, openKeyring, recordsKeyFromRoot, recoveryCodeFromText,
  type Keyring, type SlotKind,
} from '@codicil/sdk';
import type { OwnerPasskey } from '../demo/passkey.js';
import { decodeJson, encodeJson, fromHex, toHex } from './codec.js';
import { InputProblem } from './problems.js';
import { BACKUP_FORMAT, decodeRecords, type VaultRecord } from './records.js';

/** What is encrypted: every record, and the passkey this person signs with, if they made one here. */
export interface Unlocked {
  records: VaultRecord[];
  passkey?: OwnerPasskey;
}

/** Encrypted records and the keyring that opens them. */
export interface Locked {
  keyring: Keyring;
  iv: Uint8Array;
  data: Uint8Array;
}

export const LOCKED_FORMAT = 2;

/** What a browser's storage holds. */
export type Stored =
  | { kind: 'empty' }
  /** Records from before the keyring, in plain text. They are encrypted on first unlock. */
  | { kind: 'plain'; records: VaultRecord[] }
  | { kind: 'locked'; locked: Locked };

const aad = (ring: Keyring): Uint8Array => new TextEncoder().encode(`codicil:records:v1:${ring.id}`);

async function recordsKey(root: Uint8Array, use: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', recordsKeyFromRoot(root) as BufferSource, 'AES-GCM', false, [use]);
}

/** Encrypt `payload` for `root`'s owner. */
export async function lock(root: Uint8Array, keyring: Keyring, payload: Unlocked): Promise<Locked> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(encodeJson({ format: 1, records: payload.records, passkey: payload.passkey }));
  const data = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(keyring) as BufferSource }, await recordsKey(root, 'encrypt'), plain as BufferSource,
  ));
  return { keyring, iv, data };
}

/** Decrypt with the root the keyring opened. Throws a KeyringError when the root is not this one. */
export async function unlock(root: Uint8Array, locked: Locked): Promise<Unlocked> {
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: locked.iv as BufferSource, additionalData: aad(locked.keyring) as BufferSource },
      await recordsKey(root, 'decrypt'), locked.data as BufferSource,
    );
  } catch {
    throw new KeyringError('these records were not locked with this key');
  }
  const text = new TextDecoder().decode(plain);
  const parsed = decodeJson<{ passkey?: OwnerPasskey }>(text);
  return { records: decodeRecords(text), ...(parsed.passkey ? { passkey: parsed.passkey } : {}) };
}

export function storedToText(locked: Locked): string {
  return JSON.stringify({ format: LOCKED_FORMAT, keyring: keyringToText(locked.keyring), iv: toHex(locked.iv), data: toHex(locked.data) });
}

/** Read a browser's storage. Anything unreadable counts as empty rather than breaking the app. */
export function readStored(text: string | null): Stored {
  if (!text) return { kind: 'empty' };
  try {
    const raw = JSON.parse(text) as { format?: unknown; keyring?: unknown; iv?: unknown; data?: unknown };
    if (raw.format === LOCKED_FORMAT && typeof raw.keyring === 'string' && typeof raw.iv === 'string' && typeof raw.data === 'string') {
      return { kind: 'locked', locked: { keyring: keyringFromText(raw.keyring), iv: fromHex(raw.iv), data: fromHex(raw.data) } };
    }
  } catch {
    return { kind: 'empty' };
  }
  const records = decodeRecords(text);
  return records.length > 0 ? { kind: 'plain', records } : { kind: 'empty' };
}

// ─── Backup files ───────────────────────────────────────────────────────────

/** A backup file holding the keyring and the encrypted records. */
export function backupToText(locked: Locked, vaults: number, now: Date = new Date()): string {
  return JSON.stringify({
    format: BACKUP_FORMAT, version: 2, exportedAt: now.toISOString(), vaults,
    keyring: JSON.parse(keyringToText(locked.keyring)) as unknown,
    cipher: { name: 'AES-GCM', iv: toHex(locked.iv) },
    data: toHex(locked.data),
  }, null, 2);
}

/** What a backup file needs to be opened. */
export type BackupKind =
  | { kind: 'passphrase' }
  | { kind: 'keyring'; locked: Locked; vaults?: number };

/** Which kind of backup file this is. Throws an `InputProblem` for a file that is not one. */
export function readBackup(text: string): BackupKind {
  let file: { format?: unknown; version?: unknown; keyring?: unknown; cipher?: { iv?: unknown }; data?: unknown; vaults?: unknown };
  try {
    file = JSON.parse(text) as typeof file;
  } catch {
    throw new InputProblem('that file is not a Codicil backup');
  }
  if (file?.format !== BACKUP_FORMAT) throw new InputProblem('that file is not a Codicil backup');
  if (file.version === 1) return { kind: 'passphrase' };
  if (file.version !== 2) throw new InputProblem('that backup was made by a newer version of Codicil. Update the app and try again');
  if (typeof file.keyring !== 'object' || typeof file.cipher?.iv !== 'string' || typeof file.data !== 'string') throw new InputProblem('that backup is incomplete');
  try {
    return {
      kind: 'keyring',
      locked: { keyring: keyringFromText(JSON.stringify(file.keyring)), iv: fromHex(file.cipher.iv), data: fromHex(file.data) },
      vaults: typeof file.vaults === 'number' ? file.vaults : undefined,
    };
  } catch (e) {
    throw new InputProblem(e instanceof Error ? e.message : 'that backup is damaged');
  }
}

/**
 * The root, from a slot's secret, with the person's words for what went wrong.
 * A recovery code may be given as text.
 */
export async function openWith(ring: Keyring, kind: SlotKind, secret: Uint8Array | string): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = typeof secret === 'string' ? recoveryCodeFromText(secret) : secret;
  } catch (e) {
    throw new InputProblem(e instanceof Error ? e.message : String(e));
  }
  try {
    return await openKeyring(ring, kind, bytes);
  } catch {
    throw new InputProblem(kind === 'recovery-code'
      ? 'that recovery code does not open this. Check each group against your printed copy'
      : kind === 'passkey'
        ? 'that passkey does not open this. Try your recovery code'
        : 'that wallet does not open this. Try your recovery code');
  }
}

/** The records in a browser's storage or a backup file, opened with a recovery code. For tests and tools. */
export async function readWithCode(text: string, code: string): Promise<Unlocked> {
  const stored = readStored(text);
  const locked = stored.kind === 'locked' ? stored.locked : (() => {
    const b = readBackup(text);
    if (b.kind !== 'keyring') throw new InputProblem('that is not locked with a keyring');
    return b.locked;
  })();
  return unlock(await openWith(locked.keyring, 'recovery-code', code), locked);
}
