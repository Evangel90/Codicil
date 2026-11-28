// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// One identity root per person, kept behind several key slots
// (docs/DECISIONS.md D22).
//
// A root is 32 random bytes. Everything a person holds for a vault (an heir's
// key, a guardian's secret, an encryption key, the key to their records) is
// derived from it, so the root is the one thing to protect. It is stored
// encrypted in a keyring with one or more slots, any one of which opens it:
//
//   passkey        32 bytes from the WebAuthn PRF extension. The same passkey
//                  gives the same bytes on every device it syncs to. Tied to
//                  the website the passkey was made on.
//   recovery-code  128 random bits written as text to print or write down.
//                  Tied to nothing.
//   wallet         a hash of the wallet's signature over a fixed message.
//                  Tied to the wallet, not to a website.
//
// Losing a website closes the passkey slot and leaves the others open.

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { newHeirKey, type HeirKey } from './keys.js';

const DOMAIN = 'codicil:keyring:v1';
const ROOT_BYTES = 32;

export type SlotKind = 'passkey' | 'recovery-code' | 'wallet';

/** One way into a keyring. Holds the root encrypted under a key only this slot's secret gives. */
export interface KeySlot {
  kind: SlotKind;
  /** Words for the person: "iPhone passkey", "printed code". Never needed to open it. */
  label: string;
  /** passkey: the credential to ask for, as hex. */
  credentialId?: string;
  /** passkey: the PRF input. Random per slot, so one passkey's output differs between keyrings. */
  prfInput?: Uint8Array;
  /** wallet: the address that signed, so the app can ask the right wallet. */
  walletAddress?: string;
  salt: Uint8Array;
  iv: Uint8Array;
  wrapped: Uint8Array;
}

export interface Keyring {
  format: 'codicil-keyring';
  version: 1;
  /** Random, so two keyrings of one person cannot be linked by it. */
  id: string;
  slots: KeySlot[];
}

/** Why a keyring could not be opened or changed. */
export class KeyringError extends Error {
  override name = 'KeyringError';
}

export const newRoot = (): Uint8Array => randomBytes(ROOT_BYTES);

// ─── Deriving what a person holds ───────────────────────────────────────────

/**
 * A value derived from a root for one purpose. `label` names the purpose and
 * the context (an invitation id, a vault address), so values for different
 * vaults cannot be linked to each other.
 */
export function deriveFromRoot(root: Uint8Array, label: string, length = 32): Uint8Array {
  if (root.length !== ROOT_BYTES) throw new KeyringError('a root is 32 bytes');
  return hkdf(sha256, root, utf8ToBytes('codicil:root:v1'), utf8ToBytes(label), length);
}

/** An heir's key for one invitation, from their root. */
export const heirKeyFromRoot = (root: Uint8Array, context: string): HeirKey =>
  newHeirKey(deriveFromRoot(root, `heir-key:${context}`, 64));

/** A guardian's secret for one invitation, from their root. */
export const guardianSecretFromRoot = (root: Uint8Array, context: string): Uint8Array =>
  deriveFromRoot(root, `guardian-secret:${context}`);

/** The salt for an heir's key commitment for one invitation. */
export const keySaltFromRoot = (root: Uint8Array, context: string): Uint8Array =>
  deriveFromRoot(root, `key-salt:${context}`);

/** The secret of a person's encryption key (box.ts) for one invitation. */
export const boxSecretFromRoot = (root: Uint8Array, context: string): Uint8Array =>
  deriveFromRoot(root, `box:${context}`);

/** The key that encrypts a person's own records, wherever they are stored. */
export const recordsKeyFromRoot = (root: Uint8Array): Uint8Array => deriveFromRoot(root, 'records');

// ─── Slots ──────────────────────────────────────────────────────────────────

/** What it takes to add a slot: its kind, its secret, and what the app needs to ask for it again. */
export interface SlotInput {
  kind: SlotKind;
  /** The 32 PRF bytes, the recovery code's 16 bytes, or the wallet secret. */
  secret: Uint8Array;
  label: string;
  credentialId?: string;
  prfInput?: Uint8Array;
  walletAddress?: string;
}

const aad = (ringId: string, kind: SlotKind): Uint8Array => utf8ToBytes(`${DOMAIN}:${ringId}:${kind}`);

async function slotKey(secret: Uint8Array, salt: Uint8Array, kind: SlotKind, use: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (secret.length < 16) throw new KeyringError('a slot secret is at least 16 bytes');
  const raw = hkdf(sha256, secret, salt, utf8ToBytes(`${DOMAIN}:slot:${kind}`), 32);
  return globalThis.crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [use]);
}

async function makeSlot(ringId: string, root: Uint8Array, input: SlotInput): Promise<KeySlot> {
  if (input.kind === 'passkey' && (!input.credentialId || !input.prfInput)) throw new KeyringError('a passkey slot needs its credential and PRF input');
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = await slotKey(input.secret, salt, input.kind, 'encrypt');
  const wrapped = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(ringId, input.kind) as BufferSource }, key, root as BufferSource,
  ));
  const slot: KeySlot = { kind: input.kind, label: input.label, salt, iv, wrapped };
  if (input.credentialId) slot.credentialId = input.credentialId;
  if (input.prfInput) slot.prfInput = input.prfInput;
  if (input.walletAddress) slot.walletAddress = input.walletAddress;
  return slot;
}

/** A new keyring for `root`, opened by the first slot. */
export async function newKeyring(root: Uint8Array, first: SlotInput): Promise<Keyring> {
  if (root.length !== ROOT_BYTES) throw new KeyringError('a root is 32 bytes');
  const id = bytesToHex(randomBytes(16));
  return { format: 'codicil-keyring', version: 1, id, slots: [await makeSlot(id, root, first)] };
}

/** The keyring with one more slot. Needs the root, so only someone who already opened it can add one. */
export async function addSlot(ring: Keyring, root: Uint8Array, input: SlotInput): Promise<Keyring> {
  return { ...ring, slots: [...ring.slots, await makeSlot(ring.id, root, input)] };
}

/** The keyring without slot `index`. The last slot cannot be removed: nothing would open the keyring. */
export function removeSlot(ring: Keyring, index: number): Keyring {
  if (ring.slots.length <= 1) throw new KeyringError('a keyring needs at least one way in');
  if (index < 0 || index >= ring.slots.length) throw new KeyringError('there is no such slot');
  return { ...ring, slots: ring.slots.filter((_, i) => i !== index) };
}

/** Which kinds of slot a keyring has, for "you can open this with…". */
export const slotKinds = (ring: Keyring): SlotKind[] => [...new Set(ring.slots.map((s) => s.kind))];

/** Whether the keyring can still be opened without a passkey, that is, without the website. */
export const opensWithoutWebsite = (ring: Keyring): boolean => ring.slots.some((s) => s.kind !== 'passkey');

/**
 * The root, from the secret of any slot of `kind`. Tries every slot of that
 * kind, so a person with two passkeys or two codes does not need to say which.
 */
export async function openKeyring(ring: Keyring, kind: SlotKind, secret: Uint8Array): Promise<Uint8Array> {
  const candidates = ring.slots.filter((s) => s.kind === kind);
  if (candidates.length === 0) throw new KeyringError(`this keyring has no ${kindWords[kind]}`);
  for (const slot of candidates) {
    try {
      const key = await slotKey(secret, slot.salt, kind, 'decrypt');
      const root = new Uint8Array(await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: slot.iv as BufferSource, additionalData: aad(ring.id, kind) as BufferSource }, key, slot.wrapped as BufferSource,
      ));
      if (root.length === ROOT_BYTES) return root;
    } catch {
      // Not this slot; try the next.
    }
  }
  throw new KeyringError(`that ${kindWords[kind]} does not open this keyring`);
}

const kindWords: Record<SlotKind, string> = { passkey: 'passkey', 'recovery-code': 'recovery code', wallet: 'wallet' };

/** A fresh PRF input for a new passkey slot. */
export const newPrfInput = (): Uint8Array => randomBytes(32);

// ─── The recovery code ──────────────────────────────────────────────────────
// 16 random bytes as 26 Crockford base32 characters plus one check character,
// in groups of five: easy to write by hand, and a typing mistake is caught
// before anything is tried.

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_BYTES = 16;
const CODE_CHARS = 26;

export const newRecoveryCode = (): Uint8Array => randomBytes(CODE_BYTES);

const checkChar = (bytes: Uint8Array): string => B32[sha256(concatBytes(utf8ToBytes(`${DOMAIN}:code`), bytes))[0] & 31];

/** The code as text: `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX`, the last character being the check. */
export function recoveryCodeToText(bytes: Uint8Array): string {
  if (bytes.length !== CODE_BYTES) throw new KeyringError('a recovery code is 16 bytes');
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  bits <<= 2n;   // 128 bits → 130, a whole number of 5-bit characters
  let chars = '';
  for (let i = CODE_CHARS - 1; i >= 0; i--) chars = B32[Number((bits >> BigInt(5 * (CODE_CHARS - 1 - i))) & 31n)] + chars;
  chars += checkChar(bytes);
  return chars.match(/.{1,5}/g)!.join('-');
}

/** Read a code typed by a person. Accepts any case and spacing; O is read as 0, I and L as 1. */
export function recoveryCodeFromText(text: string): Uint8Array {
  const chars = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (chars.length !== CODE_CHARS + 1) throw new KeyringError(`a recovery code has ${CODE_CHARS + 1} characters; this one has ${chars.length}`);
  let bits = 0n;
  for (const c of chars.slice(0, CODE_CHARS)) {
    const v = B32.indexOf(c);
    if (v < 0) throw new KeyringError(`"${c}" is not a character a recovery code uses`);
    bits = (bits << 5n) | BigInt(v);
  }
  if ((bits & 3n) !== 0n) throw new KeyringError('that recovery code has a typing mistake');
  bits >>= 2n;
  const bytes = new Uint8Array(CODE_BYTES);
  for (let i = CODE_BYTES - 1; i >= 0; i--) {
    bytes[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  if (checkChar(bytes) !== chars[CODE_CHARS]) throw new KeyringError('that recovery code has a typing mistake');
  return bytes;
}

// ─── The wallet slot ────────────────────────────────────────────────────────

/** What a wallet signs to open a wallet slot. Fixed, so the same wallet always gives the same secret. */
export const WALLET_SLOT_MESSAGE = 'Codicil: open my keyring.\n\nSigning this does not send anything or move any funds.';

/**
 * The wallet slot's secret from two signatures over WALLET_SLOT_MESSAGE. They
 * must agree: a wallet whose signatures change each time cannot open a slot
 * later, so it is refused now rather than locking the person out.
 */
export function walletSlotSecret(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (first.length < 32) throw new KeyringError('that is not a signature');
  if (bytesToHex(first) !== bytesToHex(second)) {
    throw new KeyringError('this wallet signs the same message differently each time, so it cannot be used to open a keyring');
  }
  return sha256(concatBytes(utf8ToBytes(`${DOMAIN}:wallet`), first));
}

/** The secret from one signature, when opening (the slot was checked when it was added). */
export const walletSecretFromSignature = (signature: Uint8Array): Uint8Array =>
  sha256(concatBytes(utf8ToBytes(`${DOMAIN}:wallet`), signature));

// ─── As text ────────────────────────────────────────────────────────────────

export function keyringToText(ring: Keyring): string {
  return JSON.stringify({
    format: ring.format, version: ring.version, id: ring.id,
    slots: ring.slots.map((s) => ({
      kind: s.kind, label: s.label,
      ...(s.credentialId ? { credentialId: s.credentialId } : {}),
      ...(s.prfInput ? { prfInput: bytesToHex(s.prfInput) } : {}),
      ...(s.walletAddress ? { walletAddress: s.walletAddress } : {}),
      salt: bytesToHex(s.salt), iv: bytesToHex(s.iv), wrapped: bytesToHex(s.wrapped),
    })),
  });
}

export function keyringFromText(text: string): Keyring {
  let raw: { format?: unknown; version?: unknown; id?: unknown; slots?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    throw new KeyringError('this is not a keyring');
  }
  if (raw?.format !== 'codicil-keyring') throw new KeyringError('this is not a keyring');
  if (raw.version !== 1) throw new KeyringError('this keyring was made by a newer version');
  if (typeof raw.id !== 'string' || !Array.isArray(raw.slots) || raw.slots.length === 0) throw new KeyringError('this keyring is incomplete');
  const hex = (v: unknown): Uint8Array => {
    if (typeof v !== 'string' || !/^([0-9a-f]{2})+$/.test(v)) throw new KeyringError('this keyring is damaged');
    return hexToBytes(v);
  };
  const slots = (raw.slots as Record<string, unknown>[]).map((s): KeySlot => {
    if (s.kind !== 'passkey' && s.kind !== 'recovery-code' && s.kind !== 'wallet') throw new KeyringError('this keyring has a slot this version does not know');
    const slot: KeySlot = { kind: s.kind, label: typeof s.label === 'string' ? s.label : '', salt: hex(s.salt), iv: hex(s.iv), wrapped: hex(s.wrapped) };
    if (typeof s.credentialId === 'string') slot.credentialId = s.credentialId;
    if (s.prfInput !== undefined) slot.prfInput = hex(s.prfInput);
    if (typeof s.walletAddress === 'string') slot.walletAddress = s.walletAddress;
    return slot;
  });
  return { format: 'codicil-keyring', version: 1, id: raw.id, slots };
}
