// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The seal register (contracts/src/codicil_seals.compact) from the outside:
// what to send it when a message is sealed, what a guardian sends to hand a
// piece over, and how a reader collects the pieces from its public ledger.

import { pureCircuits, type Ledger as SealsLedger, type Seal } from '@codicil/contracts/seals';
import { sealedFingerprint, type KeyPiece, type SealedMessage } from './sealed.js';
import type { PasskeyOwner, WalletOwner } from './witnesses.js';

export type { SealsLedger, Seal };

/** How many piece commitments one seal carries. */
export const SEAL_SLOTS = 8;
/** How far ahead of the clock a seal's "sealed before" time is set, in seconds. */
export const SEAL_TIME_SLACK = 600;

/** The owner key a register's keeper can prove it holds: the same key and salt the vault's ledger commits to. */
export interface RegisterOwner {
  passkey?: PasskeyOwner;
  wallet?: WalletOwner;
}

/**
 * Witnesses for the register. The keeper's secret and the owner's key come
 * from the owner's own device; anyone else calls with neither, which is all
 * `handOver` needs.
 */
export const sealsWitnesses = (keeperSecret?: Uint8Array, owner: RegisterOwner = {}) => {
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`no ${what} on this device`);
    return value;
  };
  type Ctx = { privateState: unknown };
  return {
    keeperSecret: (ctx: Ctx): [unknown, Uint8Array] => [ctx.privateState, need(keeperSecret, 'keeper secret')],
    ownerPasskey: (ctx: Ctx): [unknown, PasskeyOwner['pk']] => [ctx.privateState, need(owner.passkey, 'owner passkey').pk],
    ownerPasskeySalt: (ctx: Ctx): [unknown, Uint8Array] => [ctx.privateState, need(owner.passkey, 'owner passkey').salt],
    ownerEdKey: (ctx: Ctx): [unknown, WalletOwner['pk']] => [ctx.privateState, need(owner.wallet, 'owner wallet key').pk],
    ownerEdSalt: (ctx: Ctx): [unknown, Uint8Array] => [ctx.privateState, need(owner.wallet, 'owner wallet key').salt],
  };
};

export const keeperCommitment = (secret: Uint8Array): Uint8Array => pureCircuits.keeperCommitment(secret);

/** The commitment the register holds for one piece of one sealed key. */
export function pieceCommitment(fingerprint: Uint8Array, piece: KeyPiece): Uint8Array {
  return pureCircuits.pieceCommitment(fingerprint, BigInt(piece.x), piece.y);
}

/** Arguments of the register's `seal` circuit for a sealed message and the pieces of its key. */
export function sealArgs(
  sealed: SealedMessage, pieces: readonly KeyPiece[], now: number,
): [fingerprint: Uint8Array, needed: bigint, pieces: bigint, checks: Uint8Array[], sealedBefore: bigint] {
  if (pieces.length < 1 || pieces.length > SEAL_SLOTS) throw new Error(`the register takes 1 to ${SEAL_SLOTS} pieces for a key`);
  if (pieces.some((p) => p.y.length !== 32)) throw new Error('the register takes pieces of 32 bytes');
  const fingerprint = sealedFingerprint(sealed);
  const checks = Array.from({ length: SEAL_SLOTS }, (_, i) => (pieces[i] ? pieceCommitment(fingerprint, pieces[i]) : new Uint8Array(32)));
  return [fingerprint, BigInt(sealed.needed), BigInt(pieces.length), checks, BigInt(now + SEAL_TIME_SLACK)];
}

/** Arguments of the register's `handOver` circuit. */
export function handOverArgs(fingerprint: Uint8Array, piece: KeyPiece): [fingerprint: Uint8Array, x: bigint, y: Uint8Array] {
  return [fingerprint, BigInt(piece.x), piece.y];
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** The seal the register holds for a fingerprint, if any. */
export function sealOn(ledger: SealsLedger, fingerprint: Uint8Array): Seal | undefined {
  return ledger.seals.member(fingerprint) ? ledger.seals.lookup(fingerprint) : undefined;
}

/** Every piece of one sealed key that has been handed over so far, in piece order. */
export function piecesHandedOver(ledger: SealsLedger, fingerprint: Uint8Array): KeyPiece[] {
  const out: KeyPiece[] = [];
  for (const [, piece] of ledger.handedOver) {
    if (sameBytes(piece.seal, fingerprint)) out.push({ x: Number(piece.x), y: piece.y });
  }
  return out.sort((a, b) => a.x - b.x);
}

const isZero = (b: Uint8Array): boolean => b.every((v) => v === 0);

/**
 * Whether a register was made by a vault's owner: the register's keeper proved,
 * in zero knowledge, that it can open one of the owner commitments on the
 * vault's own ledger. Uses nothing but the two public ledgers.
 */
export function registerProvesOwner(
  vault: { ownerPasskeyCommit: Uint8Array; ownerEdCommit: Uint8Array }, register: { ownerCommit: Uint8Array },
): boolean {
  if (isZero(register.ownerCommit)) return false;
  return sameBytes(register.ownerCommit, vault.ownerPasskeyCommit) || sameBytes(register.ownerCommit, vault.ownerEdCommit);
}
