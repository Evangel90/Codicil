// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Sealed files in the guided demo (docs/DECISIONS.md D22). The encrypted body
// of a file is kept in a store in this page. In live mode it would be kept on
// the test network's storage instead, behind the same interface.

import { MAX_FILE_BYTES, memoryBlobStore, type BlobStore, type PlainFile } from '@codicil/sdk';

/** The demo's store, plus one thing a real store never offers: changing a stored byte, to show it is caught. */
export interface DemoBlobStore extends BlobStore {
  damage(id: string): void;
}

export function demoBlobStore(): DemoBlobStore {
  const inner = memoryBlobStore();
  const damaged = new Set<string>();
  return {
    name: inner.name,
    lasts: inner.lasts,
    put: (bytes) => inner.put(bytes),
    async get(id) {
      const bytes = await inner.get(id);
      if (damaged.has(id)) bytes[Math.floor(bytes.length / 2)] ^= 0x01;
      return bytes;
    },
    damage: (id) => { damaged.add(id); },
  };
}

/** A size in words: "812 bytes", "14 KB", "3.2 MB". */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n.toLocaleString()} byte${n === 1 ? '' : 's'}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024).toLocaleString()} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The largest file the demo seals, in words. */
export const MAX_FILE_WORDS = `${MAX_FILE_BYTES / 1024 / 1024} MB`;

/** What is wrong with a file before it is read, if anything. */
export function fileProblem(f: { size: number }): string | undefined {
  if (f.size === 0) return 'That file is empty. Choose another one.';
  if (f.size > MAX_FILE_BYTES) return `That file is ${fmtBytes(f.size)}. A sealed file can be up to ${MAX_FILE_WORDS}.`;
  return undefined;
}

/** Read a file the person picked. Throws an Error with words to show. */
export async function readPicked(f: File): Promise<PlainFile> {
  const wrong = fileProblem(f);
  if (wrong) throw new Error(wrong);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await f.arrayBuffer());
  } catch {
    throw new Error('This browser could not read that file. Try choosing it again.');
  }
  return { name: f.name || 'file', type: f.type || 'application/octet-stream', bytes };
}
