// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The recovery key: a way back in for an owner who has lost every registered
// key (docs/DECISIONS.md D18).
//
// The recovery key is a 32-byte secret the owner keeps offline, for example
// printed and stored with their papers. Only its commitment is on-chain.
// Whoever knows the secret can propose new owner keys; they take effect after
// the vault's public `recoveryDelay`, unless a current owner key signs
// anything first (a check-in, a will update, a settings update). That cancels
// the proposal and retires the recovery key.

import { randomBytes } from '@noble/hashes/utils.js';
import { pureCircuits, type VaultConfig } from '@codicil/contracts/vault';

/** The contract refuses a recovery delay shorter than this (one day, in seconds). */
export const MIN_RECOVERY_DELAY = 86_400n;

/**
 * A fresh recovery secret. Always make a new one per vault: the commitment is
 * a plain hash of the secret, so reusing a secret would show the same
 * commitment on both vaults and link them.
 */
export const newRecoverySecret = (): Uint8Array => randomBytes(32);

/** What goes on-chain for a recovery secret; reveals nothing about it. */
export function recoveryCommitment(secret: Uint8Array): Uint8Array {
  if (secret.length !== 32) throw new Error('a recovery secret is 32 bytes');
  return pureCircuits.recoveryCommitment(secret);
}

/** Private state of whoever holds the recovery secret. */
export interface RecoverySecrets {
  secret: Uint8Array;
}

/**
 * Recovery settings for a `VaultConfig`. The contract enforces the same
 * limits; checking here gives a clear error before deployment.
 */
export function recoveryConfig(
  secret: Uint8Array,
  recoveryDelay: bigint,
  maxPeriod?: bigint,
): Pick<VaultConfig, 'recoveryKeyCommit' | 'recoveryDelay'> {
  if (recoveryDelay < MIN_RECOVERY_DELAY) throw new Error('the recovery delay must be at least one day');
  if (maxPeriod !== undefined && recoveryDelay >= maxPeriod) {
    throw new Error('the recovery delay must be shorter than the longest check-in period');
  }
  return { recoveryKeyCommit: recoveryCommitment(secret), recoveryDelay };
}

/** The owner keys a recovery proposes, and the recovery key that follows it. */
export interface RecoveryProposal {
  /** `passkeyCommitment(pk, salt)` of the new passkey, or 32 zero bytes for none. */
  passkeyCommit: Uint8Array;
  /** `edKeyCommitment(pk, salt)` of the new wallet key, or 32 zero bytes for none. */
  edCommit: Uint8Array;
  /** Commitment to a new recovery secret, or 32 zero bytes to have none afterwards. */
  nextRecoveryKeyCommit: Uint8Array;
}

export type RecoveryStatus =
  /** The vault has no recovery key. */
  | { state: 'off' }
  /** It has one, and no recovery is in progress. */
  | { state: 'idle' }
  /** Started; anything a current owner key signs cancels it. */
  | { state: 'waiting'; readyAt: bigint }
  /** The delay is over; anyone can finish it while the vault is armed and before the deadline. */
  | { state: 'ready'; readyAt: bigint }
  /**
   * An owner action cancelled a recovery. The recovery key is dead for good,
   * although its commitment and the cancelled proposal stay on the ledger.
   */
  | { state: 'retired' };

/**
 * Where a vault's recovery stands, from public ledger fields and the current
 * time (unix seconds). A recovery stands only while the owner `nonce` is the
 * one recorded when it started: every owner action moves the nonce.
 */
export function recoveryStatus(
  ledger: { recoveryKeyCommit: Uint8Array; recoveryReadyAt: bigint; recoveryNonce: bigint; nonce: bigint },
  now: bigint,
): RecoveryStatus {
  if (ledger.recoveryKeyCommit.every((b) => b === 0)) return { state: 'off' };
  if (ledger.recoveryReadyAt === 0n) return { state: 'idle' };
  if (ledger.recoveryNonce !== ledger.nonce) return { state: 'retired' };
  return { state: now >= ledger.recoveryReadyAt ? 'ready' : 'waiting', readyAt: ledger.recoveryReadyAt };
}

/**
 * The latest moment a recovery can be started and still finish before the
 * deadline (unix seconds). After it, `startRecovery` fails with
 * "too late to recover".
 */
export function lastRecoveryStart(ledger: { deadline: bigint; recoveryDelay: bigint }): bigint {
  return ledger.deadline - ledger.recoveryDelay - 1n;
}
