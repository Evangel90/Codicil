// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Building a will: heir leaves, the Merkle root stored on-chain, and the
// private package each heir receives.

import type { Curve25519Point } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits, type HeirLeaf } from '@codicil/contracts/vault';
import { newSalt, type HeirKey } from './keys.js';
import { MAX_LEAVES, MerkleTree, type MerklePath } from './merkle.js';

export const BPS_TOTAL = 10_000n;
const ZERO32 = new Uint8Array(32);

/** A public key plus the salt that hides it inside its commitment. */
export interface KeyCommitmentOpening { pk: Curve25519Point; salt: Uint8Array }

export interface HeirEntry {
  heir: KeyCommitmentOpening;
  backup?: KeyCommitmentOpening;
  shareBps: bigint;
  /** Unix seconds before which this share cannot be claimed; 0 = at release. */
  unlockAt?: bigint;
}

export interface Will {
  leaves: HeirLeaf[];
  tree: MerkleTree;
  /** The only part of the will that goes on-chain. */
  root: bigint;
}

export const keyCommitment = (k: KeyCommitmentOpening): Uint8Array => pureCircuits.edKeyCommitment(k.pk, k.salt);

/** Validate a will and compute its leaves and Merkle root. */
export function buildWill(entries: readonly HeirEntry[]): Will {
  if (entries.length === 0) throw new Error('a will needs at least one heir');
  if (entries.length > MAX_LEAVES) throw new Error(`a will can have at most ${MAX_LEAVES} heirs`);
  let total = 0n;
  for (const e of entries) {
    if (e.shareBps <= 0n || e.shareBps > BPS_TOTAL) throw new Error('each share must be between 0.01% and 100%');
    total += e.shareBps;
  }
  if (total > BPS_TOTAL) throw new Error('shares add up to more than 100%');
  const leaves: HeirLeaf[] = entries.map((e) => ({
    heirKeyCommit: keyCommitment(e.heir),
    backupKeyCommit: e.backup ? keyCommitment(e.backup) : ZERO32,
    shareBps: e.shareBps,
    unlockAt: e.unlockAt ?? 0n,
    salt: newSalt(),
  }));
  const tree = new MerkleTree(leaves.map((l) => pureCircuits.heirLeafHash(l)));
  return { leaves, tree, root: tree.root };
}

/** Everything an heir (or backup) needs to claim: given to them privately. */
export interface ClaimPackage {
  leaf: HeirLeaf;
  path: MerklePath;
}

export function claimPackage(will: Will, index: number): ClaimPackage {
  return { leaf: will.leaves[index], path: will.tree.pathFor(index) };
}

/** Private state of whoever is claiming: their package plus their key. */
export interface ClaimantSecrets extends ClaimPackage {
  key: HeirKey;
  keySalt: Uint8Array;
}

/** Exactly what the vault sends to the fee address at release (rounded down; 0 when there is no fee). */
export function releaseFeeFor(estateTotal: bigint, feeBps: bigint): bigint {
  return (estateTotal * feeBps) / BPS_TOTAL;
}

/** What is left for the heirs: the snapshot their shares are taken of. */
export function snapshotAfterFee(estateTotal: bigint, feeBps: bigint): bigint {
  return estateTotal - releaseFeeFor(estateTotal, feeBps);
}

/** Exactly what the vault pays for a share (rounded down). */
export function payoutFor(snapshot: bigint, shareBps: bigint): bigint {
  return (snapshot * shareBps) / BPS_TOTAL;
}
