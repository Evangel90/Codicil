// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Where the bodies of sealed files are kept (docs/DECISIONS.md D22). A body is
// already encrypted when it gets here, so a store only has to keep bytes and
// give them back. Three stores share this interface: memory (tests and the
// guided demo), the ar.io sandbox (live mode on a test network, files purged
// after a few days), and Arweave mainnet later.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

export interface BlobStore {
  /** Short name kept in pointers, so a reader knows where to look: "memory", "arweave-sandbox". */
  readonly name: string;
  /** Words for the person: how long a stored file lasts here. */
  readonly lasts: string;
  /** Store bytes, returning the id they can be fetched by. */
  put(bytes: Uint8Array): Promise<string>;
  /** The bytes stored under `id`. Throws a BlobError if they are gone or never existed. */
  get(id: string): Promise<Uint8Array>;
}

export type BlobProblem = 'not found' | 'unreachable' | 'changed' | 'too large' | 'refused';

export class BlobError extends Error {
  override name = 'BlobError';
  constructor(readonly problem: BlobProblem, message: string) {
    super(message);
  }
}

/** Where a body is, and how to know it is the right one. */
export interface StoredBody {
  store: string;
  id: string;
  length: number;
  sha256: Uint8Array;
}

/** A store that keeps everything in this page. Survives nothing; used by tests and the guided demo. */
export function memoryBlobStore(name = 'memory'): BlobStore & { readonly size: number } {
  const items = new Map<string, Uint8Array>();
  return {
    name,
    lasts: 'until this page is closed',
    get size() { return items.size; },
    async put(bytes) {
      const id = bytesToHex(randomBytes(16));
      items.set(id, bytes.slice());
      return id;
    },
    async get(id) {
      const bytes = items.get(id);
      if (!bytes) throw new BlobError('not found', 'that file is not in this store');
      return bytes.slice();
    },
  };
}

/** Store a body and describe where it went. */
export async function storeBody(store: BlobStore, body: Uint8Array): Promise<StoredBody> {
  const id = await store.put(body);
  return { store: store.name, id, length: body.length, sha256: sha256(body) };
}

/**
 * Fetch a body from whichever of `stores` it was put in, and check it is the
 * one that was stored: same length, same SHA-256.
 */
export async function fetchBody(stores: readonly BlobStore[], where: StoredBody): Promise<Uint8Array> {
  const store = stores.find((s) => s.name === where.store);
  if (!store) throw new BlobError('unreachable', `this file is kept in "${where.store}", which this app cannot reach`);
  const bytes = await store.get(where.id);
  if (bytes.length !== where.length || bytesToHex(sha256(bytes)) !== bytesToHex(where.sha256)) {
    throw new BlobError('changed', 'the stored file is not the one that was sealed: it was changed or damaged');
  }
  return bytes;
}
