// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Deployment configuration that the compiled vault depends on.

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
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
export const VAULT_OPTIONS_OFF = {} as const satisfies Partial<VaultConfig>;
