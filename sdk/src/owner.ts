// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// What the owner signs. The app computes the digest with the contract's own
// pure circuits (never re-implemented in TypeScript), asks the passkey or
// wallet to sign it, and stores the result as an approval in the private state.

import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits } from '@codicil/contracts/vault';
import { signLikeWallet, type Cip30Signature } from './cip30.js';
import type { EdKey, P256Key } from './keys.js';
import { signLikePasskey, type WebAuthnAssertion } from './webauthn.js';
import type { CodicilPrivateState } from './witnesses.js';

/** Contract address (hex, as the wallet/indexer report it) → the bytes circuits hash. */
export const vaultId = (address: string): Uint8Array => encodeContractAddress(address);

/** Digest that approves moving the deadline to `nextDeadline`; `nonce` from the ledger. */
export function checkInDigest(address: string, nextDeadline: bigint, nonce: bigint): Uint8Array {
  return pureCircuits.aliveDigest(vaultId(address), nextDeadline, nonce);
}

/** Digest that approves replacing the will with `newRoot`; `nonce` from the ledger. */
export function willUpdateDigest(address: string, newRoot: bigint, nonce: bigint): Uint8Array {
  return pureCircuits.willUpdateDigest(vaultId(address), newRoot, nonce);
}

/**
 * When anyone may start the countdown by timeout: the deadline plus the grace
 * period (unix seconds). Until then the owner can still check in normally.
 */
export function timeoutOpensAt(ledger: { deadline: bigint; gracePeriod: bigint }): bigint {
  return ledger.deadline + ledger.gracePeriod;
}

/** Private state with a passkey approval attached. */
export function withPasskeyApproval(
  s: CodicilPrivateState,
  digest: Uint8Array,
  proof: WebAuthnAssertion,
): CodicilPrivateState {
  if (!s.passkey) throw new Error('no passkey in private state');
  return { ...s, passkey: { ...s.passkey, approval: { digest, proof } } };
}

/** Private state with a wallet approval attached. */
export function withWalletApproval(
  s: CodicilPrivateState,
  digest: Uint8Array,
  proof: Cip30Signature,
): CodicilPrivateState {
  if (!s.wallet) throw new Error('no wallet key in private state');
  return { ...s, wallet: { ...s.wallet, approval: { digest, proof } } };
}

/**
 * Software signers with the exact passkey / wallet output format, for tests
 * and demo mode. Real devices go through `toWebAuthnAssertion` / `fromCoseSign1`.
 */
export const softwareSigners = {
  passkey: (key: P256Key, digest: Uint8Array, opts?: Parameters<typeof signLikePasskey>[2]) =>
    signLikePasskey(key.sk, digest, opts),
  wallet: (key: EdKey, digest: Uint8Array) => signLikeWallet(key.sk, digest),
};
