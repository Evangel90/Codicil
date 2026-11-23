// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Key generation, signing and Merkle-tree helpers that produce values in the
// exact TypeScript shapes the Compact runtime expects.

import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  CompactTypeField,
  CompactTypeVector,
  degradeToTransient,
  transientHash,
  type Curve25519Point,
  type Secp256r1Point,
} from '@midnight-ntwrk/compact-runtime';

export const ED25519_ORDER: bigint = ed25519.Point.Fn.ORDER;

// ─── P-256 (passkey / WebCrypto) ────────────────────────────────────────────
export interface P256Key { sk: Uint8Array; pk: Secp256r1Point }
export interface P256Sig { r: bigint; s: bigint }

export function newP256Key(): P256Key {
  const { secretKey, publicKey } = p256.keygen();
  const { x, y } = p256.Point.fromBytes(publicKey).toAffine();
  return { sk: secretKey, pk: { x, y, identity: false } };
}

/** Sign a 32-byte digest as-is (the circuit does not hash for us). */
export function signP256(sk: Uint8Array, digest: Uint8Array): P256Sig {
  const sig = p256.Signature.fromBytes(p256.sign(digest, sk, { prehash: false }), 'compact');
  return { r: sig.r, s: sig.s };
}

// ─── Ed25519 (owner key, plain RFC 8032) ────────────────────────────────────
export interface EdKey { sk: Uint8Array; pk: Curve25519Point }
export interface EdSig { r: Curve25519Point; s: bigint }

export function newEdKey(): EdKey {
  const { secretKey, publicKey } = ed25519.keygen();
  const { x, y } = ed25519.Point.fromBytes(publicKey).toAffine();
  return { sk: secretKey, pk: { x, y } };
}

export function signEd25519(sk: Uint8Array, msg: Uint8Array): EdSig {
  const sig = ed25519.sign(msg, sk);
  const { x, y } = ed25519.Point.fromBytes(sig.subarray(0, 32)).toAffine();
  return { r: { x, y }, s: bytesToNumberLE(sig.subarray(32)) };
}

// ─── Heir keys: a raw Curve25519 scalar, proven in-circuit via ecMulGenerator
export interface HeirKey { sk: bigint; pk: Curve25519Point }

export function newHeirKey(): HeirKey {
  let sk = 0n;
  while (sk === 0n) sk = bytesToNumberLE(randomBytes(64)) % ED25519_ORDER;
  const { x, y } = ed25519.Point.BASE.multiply(sk).toAffine();
  return { sk, pk: { x, y } };
}

export const salt = (): Uint8Array => randomBytes(32);

// ─── Merkle tree matching merkleTreePathRootNoLeafHash<DEPTH> ───────────────
// Stdlib definition: leaf digest = degradeToTransient(leafBytes);
// node = transientHash<Vector<2, Field>>([left, right]).
export const DEPTH = 10;
const PAIR = new CompactTypeVector(2, CompactTypeField);
const node = (l: bigint, r: bigint): bigint => transientHash(PAIR, [l, r]);

export interface MerklePath {
  leaf: Uint8Array;
  path: { sibling: { field: bigint }; goes_left: boolean }[];
}

export class WillTree {
  private readonly levels: bigint[][];
  private readonly zeros: bigint[];

  constructor(private readonly leaves: Uint8Array[]) {
    if (leaves.length > 2 ** DEPTH) throw new Error('too many leaves');
    this.zeros = [0n];
    for (let i = 0; i < DEPTH; i++) this.zeros.push(node(this.zeros[i], this.zeros[i]));
    this.levels = [leaves.map((l) => degradeToTransient(l))];
    for (let l = 0; l < DEPTH; l++) {
      const cur = this.levels[l];
      const next: bigint[] = [];
      for (let i = 0; i < Math.max(1, Math.ceil(cur.length / 2)); i++) {
        next.push(node(cur[2 * i] ?? this.zeros[l], cur[2 * i + 1] ?? this.zeros[l]));
      }
      this.levels.push(next);
    }
  }

  get root(): bigint {
    return this.levels[DEPTH][0];
  }

  pathFor(index: number): MerklePath {
    const path: MerklePath['path'] = [];
    let idx = index;
    for (let l = 0; l < DEPTH; l++) {
      const sib = this.levels[l][idx ^ 1] ?? this.zeros[l];
      path.push({ sibling: { field: sib }, goes_left: (idx & 1) === 0 });
      idx >>= 1;
    }
    return { leaf: this.leaves[index], path };
  }
}
