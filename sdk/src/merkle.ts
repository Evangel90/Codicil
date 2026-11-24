// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Merkle tree matching the stdlib's merkleTreePathRootNoLeafHash<DEPTH>:
// leaf digest = degradeToTransient(leafBytes);
// node        = transientHash<Vector<2, Field>>([left, right]);
// empty slots hash as all-zero subtrees.

import {
  CompactTypeField,
  CompactTypeVector,
  degradeToTransient,
  transientHash,
} from '@midnight-ntwrk/compact-runtime';

export const DEPTH = 10;
export const MAX_LEAVES = 2 ** DEPTH;

const PAIR = new CompactTypeVector(2, CompactTypeField);
const node = (l: bigint, r: bigint): bigint => transientHash(PAIR, [l, r]);

/** The witness shape of MerkleTreePath<DEPTH, Bytes<32>>. */
export interface MerklePath {
  leaf: Uint8Array;
  path: { sibling: { field: bigint }; goes_left: boolean }[];
}

export class MerkleTree {
  private readonly levels: bigint[][];
  private readonly zeros: bigint[];

  constructor(private readonly leaves: readonly Uint8Array[]) {
    if (leaves.length > MAX_LEAVES) throw new Error(`at most ${MAX_LEAVES} leaves`);
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

  get size(): number {
    return this.leaves.length;
  }

  pathFor(index: number): MerklePath {
    if (index < 0 || index >= this.leaves.length) throw new Error('leaf index out of range');
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

/** The root a Merkle path leads to; equal to the on-chain root when the leaf is in the tree. */
export function rootFromPath(p: MerklePath): bigint {
  let h = degradeToTransient(p.leaf);
  for (const { sibling, goes_left } of p.path) h = goes_left ? node(h, sibling.field) : node(sibling.field, h);
  return h;
}
