// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Deployment configuration that the compiled vault depends on.

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { encodeUserAddress } from '@midnight-ntwrk/compact-runtime';
import type { VaultConfig } from '@codicil/contracts/vault';

/** Web origin the app is served from. Passkey signatures are bound to it. */
export const DEFAULT_ORIGIN = 'http://localhost:5173';
/** WebAuthn relying party id (the origin's hostname). */
export const DEFAULT_RP_ID = 'localhost';

/**
 * clientDataJSON lengths the vault was compiled for: the generic arguments of
 * `import "lib/WebAuthn"<134, 243>` in contracts/src/codicil_vault.compact.
 * A test fails if these disagree with `clientDataLengths(DEFAULT_ORIGIN)`.
 */
export const COMPILED_CLIENT_DATA_LENGTHS = { short: 134, long: 243 } as const;

/** Member Chrome randomly appends to clientDataJSON (seen in ~40% of real assertions). */
export const CHROME_EXTRA_MEMBER =
  ',"other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"';

/** clientDataJSON lengths for an origin: standard form and Chrome's long form. */
export function clientDataLengths(origin: string): { short: number; long: number } {
  const short = 113 + utf8ToBytes(origin).length;
  return { short, long: short + utf8ToBytes(CHROME_EXTRA_MEMBER).length };
}

/** SHA-256 of the relying party id, as stored in the vault and authenticatorData. */
export function rpIdHash(rpId: string = DEFAULT_RP_ID): Uint8Array {
  return sha256(utf8ToBytes(rpId));
}

/**
 * Every optional vault feature, switched off. Spread it into a `VaultConfig`
 * and override only what the vault uses; a vault deployed with these values
 * behaves exactly as if the feature did not exist.
 */
export const VAULT_OPTIONS_OFF = {
  /** No grace period: the countdown can start at the deadline itself. */
  gracePeriod: 0n,
  /** No release fee: nothing is taken from the estate and no extra transfer is made. */
  feeBps: 0n,
  feeRecipient: { bytes: new Uint8Array(32) },
} as const satisfies Partial<VaultConfig>;

/**
 * The contract refuses a release fee above this: 10% of the estate, in basis
 * points. A test fails if it disagrees with the vault source.
 */
export const MAX_FEE_BPS = 1_000n;

/**
 * Release-fee settings for a `VaultConfig`: `feeBps` basis points of the
 * estate go to `recipient` (a user address, hex or bytes) when the will is
 * released. Both are public on the ledger. The contract enforces the same
 * limits; checking here gives a clear error before deployment.
 */
export function releaseFeeConfig(
  feeBps: bigint,
  recipient: string | Uint8Array,
): Pick<VaultConfig, 'feeBps' | 'feeRecipient'> {
  if (feeBps < 0n || feeBps > MAX_FEE_BPS) throw new Error('the release fee must be between 0% and 10%');
  const bytes = typeof recipient === 'string' ? encodeUserAddress(recipient) : recipient;
  if (bytes.length !== 32) throw new Error('the fee address must be 32 bytes');
  if (feeBps > 0n && bytes.every((b) => b === 0)) throw new Error('a release fee needs an address');
  return { feeBps, feeRecipient: { bytes } };
}
