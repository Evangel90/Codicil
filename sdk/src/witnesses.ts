// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Witness implementations: the only place private data enters the vault.
// They run on the user's own device and read from the private state.
//
// Signing is asynchronous in a browser (Face ID prompt, wallet popup) but
// witnesses are synchronous, so the app first obtains an *approval* for the
// exact digest (see owner.ts), stores it in the private state, then calls the
// circuit. The witness hands the approval over only if its digest matches.

import type { Curve25519Point, Secp256r1Point } from '@midnight-ntwrk/compact-runtime';
import type { Witnesses } from '@codicil/contracts/vault';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Cip30Signature } from './cip30.js';
import type { GuardianSecrets, P256Signature } from './guardians.js';
import type { RecoverySecrets } from './recovery.js';
import { BPS_TOTAL, type ClaimantSecrets } from './will.js';
import type { WebAuthnAssertion } from './webauthn.js';

export interface Approval<T> { digest: Uint8Array; proof: T }

export interface PasskeyOwner {
  pk: Secp256r1Point;
  salt: Uint8Array;
  approval?: Approval<WebAuthnAssertion>;
}

export interface WalletOwner {
  pk: Curve25519Point;
  salt: Uint8Array;
  approval?: Approval<Cip30Signature>;
}

/** An attestor's key, and an attestation they signed for the current round. */
export interface Attestor {
  pk: Secp256r1Point;
  salt: Uint8Array;
  approval?: Approval<P256Signature>;
}

export interface CodicilPrivateState {
  passkey?: PasskeyOwner;
  wallet?: WalletOwner;
  claimant?: ClaimantSecrets;
  guardian?: GuardianSecrets;
  attestor?: Attestor;
  recovery?: RecoverySecrets;
}

export class MissingSecretError extends Error {
  constructor(what: string) {
    super(`this device has no ${what} for this vault`);
    this.name = 'MissingSecretError';
  }
}

export class ApprovalMismatchError extends Error {
  constructor() {
    super('the approval was signed for a different action; sign again');
    this.name = 'ApprovalMismatchError';
  }
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new MissingSecretError(what);
  return value;
}

function approvalFor<T>(a: Approval<T> | undefined, digest: Uint8Array, strict: boolean, what: string): T {
  const approval = need(a, what);
  if (strict && bytesToHex(approval.digest) !== bytesToHex(digest)) throw new ApprovalMismatchError();
  return approval.proof;
}

export interface WitnessOptions {
  /**
   * Refuse approvals made for another digest before proving (default true).
   * Tests turn this off to show the circuit itself rejects such approvals.
   */
  strict?: boolean;
}

export function createWitnesses(opts: WitnessOptions = {}): Witnesses<CodicilPrivateState> {
  const strict = opts.strict ?? true;
  return {
    ownerPasskey: ({ privateState: s }) => [s, need(s.passkey, 'passkey').pk],
    ownerPasskeySalt: ({ privateState: s }) => [s, need(s.passkey, 'passkey').salt],
    ownerPasskeyAssertion: ({ privateState: s }, digest) =>
      [s, approvalFor(need(s.passkey, 'passkey').approval, digest, strict, 'passkey approval')],
    ownerEdKey: ({ privateState: s }) => [s, need(s.wallet, 'wallet key').pk],
    ownerEdSalt: ({ privateState: s }) => [s, need(s.wallet, 'wallet key').salt],
    ownerEdSignature: ({ privateState: s }, digest) =>
      [s, approvalFor(need(s.wallet, 'wallet key').approval, digest, strict, 'wallet approval')],
    claimantLeaf: ({ privateState: s }) => [s, need(s.claimant, 'claim package').leaf],
    claimantLeafPath: ({ privateState: s }) => [s, need(s.claimant, 'claim package').path],
    claimantSecretKey: ({ privateState: s }) => [s, need(s.claimant, 'claim package').key.sk],
    claimantKeySalt: ({ privateState: s }) => [s, need(s.claimant, 'claim package').keySalt],
    guardianSecret: ({ privateState: s }) => [s, need(s.guardian, 'guardian secret').secret],
    guardianPath: ({ privateState: s }) => [s, need(s.guardian, 'guardian secret').path],
    attestorKey: ({ privateState: s }) => [s, need(s.attestor, 'attestation').pk],
    attestorSalt: ({ privateState: s }) => [s, need(s.attestor, 'attestation').salt],
    attestorSignature: ({ privateState: s }, digest) =>
      [s, approvalFor(need(s.attestor, 'attestation').approval, digest, strict, 'attestation')],
    recoverySecret: ({ privateState: s }) => [s, need(s.recovery, 'recovery key').secret],
    payoutDivision: ({ privateState: s }, snapshot, bps) => {
      const product = snapshot * bps;
      return [s, [product / BPS_TOTAL, product % BPS_TOTAL]];
    },
  };
}

export const witnesses: Witnesses<CodicilPrivateState> = createWitnesses();
