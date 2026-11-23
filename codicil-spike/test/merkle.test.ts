// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Gate V8 (off-chain half): the TypeScript will tree must produce paths that
// fold to its root exactly as stdlib `merkleTreePathRootNoLeafHash` does:
//   acc = degradeToTransient(path.leaf)
//   acc = goes_left ? H([acc, sibling]) : H([sibling, acc])
// The in-circuit half is the claim tests in codicil.test.ts.

import { describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  CompactTypeField,
  CompactTypeVector,
  degradeToTransient,
  transientHash,
} from '@midnight-ntwrk/compact-runtime';
import { DEPTH, WillTree, type MerklePath } from './crypto.js';

const PAIR = new CompactTypeVector(2, CompactTypeField);

function foldPath(p: MerklePath): bigint {
  return p.path.reduce(
    (acc, e) => transientHash(PAIR, e.goes_left ? [acc, e.sibling.field] : [e.sibling.field, acc]),
    degradeToTransient(p.leaf),
  );
}

describe('Will Merkle tree [V8]', () => {
  it.each([1, 2, 3, 8, 33])('every path of a %i-leaf tree folds to the root', (n) => {
    const leaves = Array.from({ length: n }, () => randomBytes(32));
    const tree = new WillTree(leaves);
    for (let i = 0; i < n; i++) {
      const p = tree.pathFor(i);
      expect(p.path).toHaveLength(DEPTH);
      expect(foldPath(p)).toBe(tree.root);
    }
  });

  it('a leaf from another tree does not fold to this root', () => {
    const tree = new WillTree([randomBytes(32), randomBytes(32)]);
    const other = new WillTree([randomBytes(32)]);
    expect(foldPath(other.pathFor(0))).not.toBe(tree.root);
    expect(foldPath({ ...tree.pathFor(0), leaf: randomBytes(32) })).not.toBe(tree.root);
  });
});
