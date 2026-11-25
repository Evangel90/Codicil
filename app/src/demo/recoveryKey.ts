// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The recovery key as text: what the owner prints or writes down, and types
// back in from paper years later. It is the 32-byte recovery secret plus two
// check bytes, in hexadecimal, so a typing mistake is caught on the device
// before anything is sent.
//
//   codicil:recovery:v1:3f9a 12bc … (17 groups of four)
//
// Nothing here touches the chain. The secret's commitment is computed by the
// SDK (`recoveryCommitment`), with the contract's own circuit.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const RECOVERY_KEY_PREFIX = 'codicil:recovery:v1:';
const SECRET_BYTES = 32;
const CHECK_BYTES = 2;

/** A problem with a recovery key someone typed; its message is shown as is. */
export class RecoveryKeyError extends Error {
  override name = 'InputError';
}

const check = (secret: Uint8Array): Uint8Array =>
  sha256(new Uint8Array([...new TextEncoder().encode(RECOVERY_KEY_PREFIX), ...secret])).slice(0, CHECK_BYTES);

/** The secret as the owner saves it: a prefix and 17 groups of four hex digits. */
export function encodeRecoveryKey(secret: Uint8Array): string {
  if (secret.length !== SECRET_BYTES) throw new RecoveryKeyError('a recovery secret is 32 bytes');
  const hex = bytesToHex(secret) + bytesToHex(check(secret));
  return RECOVERY_KEY_PREFIX + hex.match(/.{4}/g)!.join(' ');
}

/** Just the groups, for display under the prefix. */
export const recoveryKeyGroups = (text: string): string[] =>
  text.slice(RECOVERY_KEY_PREFIX.length).trim().split(/\s+/);

/**
 * Reads a recovery key however it was typed: with or without the prefix,
 * spaces, dashes or line breaks, in either case.
 */
export function decodeRecoveryKey(text: string): Uint8Array {
  let t = text.trim().toLowerCase();
  if (!t) throw new RecoveryKeyError('enter your recovery key');
  if (t.startsWith(RECOVERY_KEY_PREFIX)) t = t.slice(RECOVERY_KEY_PREFIX.length);
  else if (t.startsWith('codicil:')) throw new RecoveryKeyError('this is not a Codicil recovery key. A recovery key starts with codicil:recovery');
  const hex = t.replace(/[\s-]/g, '');
  if (!/^[0-9a-f]*$/.test(hex)) throw new RecoveryKeyError('a recovery key has only the digits 0 to 9 and the letters a to f. Check it against your copy');
  const want = 2 * (SECRET_BYTES + CHECK_BYTES);
  if (hex.length !== want) {
    throw new RecoveryKeyError(`this recovery key is ${hex.length < want ? 'too short' : 'too long'}: it has ${hex.length} characters and should have ${want}. Check it against your copy`);
  }
  const bytes = hexToBytes(hex);
  const secret = bytes.slice(0, SECRET_BYTES);
  if (bytesToHex(check(secret)) !== bytesToHex(bytes.slice(SECRET_BYTES))) {
    throw new RecoveryKeyError('this recovery key has a typing mistake somewhere. Check each group against your copy');
  }
  return secret;
}

/** The text file the owner can download and keep offline. */
export function recoveryKeyFile(key: string, delayDays: number, madeOn: string): string {
  return [
    'Codicil recovery key',
    `Made on ${madeOn}.`,
    '',
    key,
    '',
    'What it does',
    `If you lose your passkey, this key lets you put a new passkey in charge of your vault. The change takes ${delayDays} day${delayDays === 1 ? '' : 's'} and everyone can see it start.`,
    'Anything your current passkey signs in that time, such as a check-in, cancels the change and retires this key for good.',
    '',
    'How to keep it',
    'Keep it on paper or offline, away from the device that holds your passkey.',
    'Anyone who finds it can try to take over your vault, and succeeds if nobody cancels in time.',
    'Use it for this vault only.',
    '',
  ].join('\n');
}

export function downloadText(text: string, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
