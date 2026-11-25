// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Events the vault emits. Each is a `Misc` event whose first 32 bytes are an
// ASCII name; none carries a payload, because everything an app needs is on
// the public ledger. An event only says "look at the ledger now".

/** Event names, exactly as the contract writes them. */
export const VAULT_EVENTS = {
  /** `finalizeRelease`: the will was released; heirs can claim. */
  released: 'codicil:released:v1',
  /** A will update: every letter issued before it is out of date. */
  willChanged: 'codicil:will-changed:v1',
  /** `startRecovery`: someone with the recovery key proposed new owner keys. If it was not the owner, sign anything (a check-in will do). */
  recoveryStarted: 'codicil:recovery-started:v1',
} as const;

export type VaultEventName = (typeof VAULT_EVENTS)[keyof typeof VAULT_EVENTS];

const KNOWN = new Set<string>(Object.values(VAULT_EVENTS));

/** First byte string inside an event's encoded data (the 288-byte `Misc` value, zero-trimmed). */
function firstBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = firstBytes(v);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') return firstBytes(Object.values(value));
  return undefined;
}

/**
 * The name of a vault event as the runtime or indexer reports it, or
 * `undefined` if it is not one of ours.
 */
export function vaultEventName(event: { data: unknown }): VaultEventName | undefined {
  const bytes = firstBytes(event.data);
  if (!bytes) return undefined;
  const name = bytes.subarray(0, 32);
  let end = name.length;
  while (end > 0 && name[end - 1] === 0) end--;
  const text = new TextDecoder().decode(name.subarray(0, end));
  return KNOWN.has(text) ? (text as VaultEventName) : undefined;
}
