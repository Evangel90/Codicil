// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Hidden guardians (k-of-n) and the attestation trigger.
//
// Each guardian generates a secret on their own device and gives the owner
// only guardianLeaf(secret). The owner puts the leaves in a Merkle tree whose
// root goes on-chain, and gives each guardian their path. To vote, a guardian
// proves membership and publishes a per-round nullifier: nobody learns which
// guardians voted, or who the guardians are.

import { p256 } from '@noble/curves/nist.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { pureCircuits } from '@codicil/contracts/vault';
import { MAX_LEAVES, MerkleTree, type MerklePath } from './merkle.js';
import { vaultId } from './owner.js';

/** A guardian's secret, created and kept on the guardian's device. */
export const newGuardianSecret = (): Uint8Array => randomBytes(32);

/** What a guardian hands the owner: reveals nothing about the secret. */
export const guardianLeaf = (secret: Uint8Array): Uint8Array => pureCircuits.guardianLeaf(secret);

export interface GuardianSet {
  leaves: Uint8Array[];
  tree: MerkleTree;
  root: bigint;
  threshold: bigint;
}

export function buildGuardianSet(leaves: readonly Uint8Array[], threshold: number): GuardianSet {
  if (leaves.length === 0) throw new Error('add at least one guardian');
  if (leaves.length > MAX_LEAVES) throw new Error(`at most ${MAX_LEAVES} guardians`);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > leaves.length) {
    throw new Error(`the threshold must be between 1 and ${leaves.length}`);
  }
  if (threshold > 255) throw new Error('the threshold can be at most 255');
  const tree = new MerkleTree(leaves);
  return { leaves: [...leaves], tree, root: tree.root, threshold: BigInt(threshold) };
}

/** Private state of a guardian: their secret and their Merkle path. */
export interface GuardianSecrets {
  secret: Uint8Array;
  path: MerklePath;
}

export function guardianSecrets(set: GuardianSet, secret: Uint8Array): GuardianSecrets {
  const leaf = guardianLeaf(secret);
  const index = set.leaves.findIndex((l) => l.length === leaf.length && l.every((b, i) => b === leaf[i]));
  if (index < 0) throw new Error('this secret is not one of the vault guardians');
  return { secret, path: set.tree.pathFor(index) };
}

// ─── Attestation ────────────────────────────────────────────────────────────
export interface P256Signature { r: bigint; s: bigint }

/** Digest an attestor signs; `round` is the vault's current guardianRound. */
export function attestationDigest(address: string, round: bigint): Uint8Array {
  return pureCircuits.attestationDigest(vaultId(address), round);
}

/** Raw P-256 signature over the 32-byte digest (no extra hashing). */
export function signAttestation(sk: Uint8Array, digest: Uint8Array): P256Signature {
  const sig = p256.Signature.fromBytes(p256.sign(digest, sk, { prehash: false }), 'compact');
  return { r: sig.r, s: sig.s };
}
