// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// A blob store on Arweave through ar.io (docs/DECISIONS.md D22). Live mode
// uses the ar.io testnet sandbox: uploads there are free up to 5 MiB, are never
// posted to real Arweave, and are deleted after about three days. Mainnet is
// deferred; it is the same code with other endpoints and words.
//
// Each upload is an ANS-104 data item, signed here with a fresh Ed25519 key
// (the key type Solana uses) and posted to the upload service as raw bytes. A
// fresh key per file means two uploads cannot be linked by their signer. The
// key is thrown away: nothing about a data item needs it again. Writing the
// data item by hand keeps the Turbo SDK and the Node polyfills it needs out of
// the browser build. The body is already encrypted when it gets here.
//
// What the sandbox does, measured on 2026-11-28 (docs/PREPROD.md):
//   - an item of 5,242,880 bytes uploads free; one byte more gets 402
//   - a fresh upload is served at once: the upload service caches it at the gateway
//   - an id the gateway does not have gets 504 after about 16 seconds, not 404

import { BlobError, type BlobStore } from '@codicil/sdk';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256, sha384 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';

export interface ArweaveStoreConfig {
  /** Kept in pointers, so a reader knows which network holds the file. */
  name: string;
  /** Words for the person: how long a file lasts there. */
  lasts: string;
  /** The upload service. Data items are posted to `<uploadUrl>/v1/tx`. */
  uploadUrl: string;
  /** The gateway. Files are read from `<gatewayUrl>/raw/<id>`. */
  gatewayUrl: string;
  /** The largest body this store accepts, in bytes. */
  maxBytes: number;
  /** What to say when a file cannot be found after waiting for it. */
  missing: string;
  /** The waits between reads while a file is not served, in milliseconds. */
  readDelaysMs?: readonly number[];
  /** Stop waiting for a file once this long has passed, in milliseconds. */
  readBudgetMs?: number;
  /** How long one read may take, in milliseconds. */
  readTimeoutMs?: number;
  /** How long one upload may take, in milliseconds. */
  uploadTimeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  /** For tests: how to wait. */
  sleep?: (ms: number) => Promise<void>;
  /** For tests: the time in milliseconds. */
  now?: () => number;
}

const MIB = 1024 * 1024;

/** Signature type 2: Ed25519, a 32-byte public key and a 64-byte signature. */
const ED25519 = 2;

/** One tag, so a gateway serves the bytes as bytes. It names no app. */
const TAGS: readonly [string, string][] = [['Content-Type', 'application/octet-stream']];

/** The ar.io testnet sandbox (https://docs.ar.io/build/testnet/). */
export const ARWEAVE_SANDBOX = {
  name: 'arweave-sandbox',
  lasts: 'about three days: the test network deletes files after that',
  uploadUrl: 'https://upload.services.ar-io.dev',
  gatewayUrl: 'https://ar-io.dev',
  // The free tier takes items up to 5 MiB, header and signature included
  // (GET /info, freeTier.maxItemBytes). Larger items need paid credits.
  maxBytes: 5 * MIB - itemOverhead(),
  missing: 'This file is not on the test network. The test network deletes files after about three days, ' +
    'so it may be gone, or it may never have been uploaded.',
} as const satisfies ArweaveStoreConfig;

const READ_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const READ_BUDGET_MS = 20_000;

/** An Arweave id: 32 bytes in unpadded base64url. */
const ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function arweaveSandboxStore(over: Partial<ArweaveStoreConfig> = {}): BlobStore {
  return arweaveStore({ ...ARWEAVE_SANDBOX, ...over });
}

export function arweaveStore(config: ArweaveStoreConfig): BlobStore {
  const doFetch = config.fetch ?? ((input, init) => fetch(input, init));
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = config.now ?? (() => Date.now());
  const delays = config.readDelaysMs ?? READ_DELAYS_MS;
  const budget = config.readBudgetMs ?? READ_BUDGET_MS;
  const upload = trimSlash(config.uploadUrl);
  const gateway = trimSlash(config.gatewayUrl);

  async function request(url: string, init: RequestInit, timeoutMs: number, doing: string): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const late = error instanceof Error && error.name === 'TimeoutError';
      throw new BlobError('unreachable', `Could not ${doing}: ${late ? 'it took too long' : 'the network could not be reached'}. ` +
        'Check the connection and try again.');
    }
  }

  return {
    name: config.name,
    lasts: config.lasts,

    async put(bytes) {
      if (bytes.length > config.maxBytes) {
        throw new BlobError('too large', `This file is ${formatSize(bytes.length)} once sealed. ` +
          `This store takes files up to ${formatSize(config.maxBytes)}.`);
      }
      const item = signDataItem(bytes);
      const send = () => request(`${upload}/v1/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: item.bytes as Uint8Array<ArrayBuffer>,
      }, config.uploadTimeoutMs ?? 300_000, 'upload the file');
      // Sending the same item twice stores it once, under the same id, so one retry is safe.
      const response = await send().catch(send);
      if (response.status === 413) {
        throw new BlobError('too large', 'The upload service says this file is too large.');
      }
      if (response.status === 402) {
        throw new BlobError('refused', 'The upload service wants payment for this file, and paid uploads are not set up. ' +
          'The free uploads from this connection may be used up: try another network, or a smaller file.');
      }
      if (response.status >= 500) {
        throw new BlobError('unreachable', `The upload service had a problem (${response.status}). Try again in a minute.`);
      }
      if (!response.ok) {
        throw new BlobError('refused', `The upload service refused the file (${response.status}${await reason(response)}).`);
      }
      const answer = await response.json().catch(() => null) as { id?: unknown } | null;
      if (answer?.id !== item.id) {
        throw new BlobError('refused', 'The upload service answered with an id that is not this file\'s.');
      }
      return item.id;
    },

    async get(id) {
      if (!ID.test(id)) throw new BlobError('not found', 'That is not an Arweave file id.');
      const start = now();
      for (let attempt = 0; ; attempt++) {
        const response = await request(`${gateway}/raw/${id}`, { method: 'GET' }, config.readTimeoutMs ?? 60_000, 'read the file');
        if (response.ok) return new Uint8Array(await response.arrayBuffer());
        // 404 can be a fresh upload not served yet; 5xx can pass.
        const wait = delays[attempt];
        const waitable = response.status === 404 || response.status >= 500;
        if (waitable && wait !== undefined && now() - start + wait <= budget) {
          await sleep(wait);
          continue;
        }
        // The gateway answers 504 for an id it cannot find anywhere.
        if (response.status === 404 || response.status === 504) throw new BlobError('not found', config.missing);
        if (response.status >= 500) {
          throw new BlobError('unreachable', `The gateway had a problem (${response.status}). Try again in a minute.`);
        }
        throw new BlobError('refused', `The gateway would not give the file (${response.status}${await reason(response)}).`);
      }
    },
  };
}

// ─── ANS-104 data items ─────────────────────────────────────────────────────
// https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md

export interface DataItem {
  /** The id Arweave knows it by: base64url of the SHA-256 of the signature. */
  id: string;
  bytes: Uint8Array;
}

/** Wrap `data` in a data item signed with a fresh key, or with `secretKey` (for tests). */
export function signDataItem(data: Uint8Array, secretKey = ed25519.utils.randomSecretKey()): DataItem {
  const owner = ed25519.getPublicKey(secretKey);
  const tags = encodeTags(TAGS);
  const message = deepHash([
    utf8ToBytes('dataitem'), utf8ToBytes('1'), utf8ToBytes(String(ED25519)),
    owner, new Uint8Array(0), new Uint8Array(0), tags, data,
  ]);
  const signature = ed25519.sign(message, secretKey);
  const bytes = concatBytes(
    u16(ED25519), signature, owner,
    Uint8Array.of(0), // no target
    Uint8Array.of(0), // no anchor
    u64(TAGS.length), u64(tags.length), tags,
    data,
  );
  return { id: base64urlnopad.encode(sha256(signature)), bytes };
}

/** How many bytes a data item adds around its data: 156. */
function itemOverhead(): number {
  return 2 + 64 + 32 + 1 + 1 + 8 + 8 + encodeTags(TAGS).length;
}

/** Arweave's deep hash, with SHA-384. */
export function deepHash(value: Uint8Array | readonly Uint8Array[]): Uint8Array {
  if (value instanceof Uint8Array) {
    const tag = concatBytes(utf8ToBytes('blob'), utf8ToBytes(String(value.length)));
    return sha384(concatBytes(sha384(tag), sha384(value)));
  }
  let acc = sha384(concatBytes(utf8ToBytes('list'), utf8ToBytes(String(value.length))));
  for (const part of value) acc = sha384(concatBytes(acc, deepHash(part)));
  return acc;
}

/** Tags in Avro: one block of {name: bytes, value: bytes} records, then an empty block. */
export function encodeTags(tags: readonly (readonly [string, string])[]): Uint8Array {
  if (tags.length === 0) return new Uint8Array(0);
  const parts: Uint8Array[] = [zigzag(tags.length)];
  for (const [name, value] of tags) {
    for (const text of [name, value]) {
      const raw = utf8ToBytes(text);
      parts.push(zigzag(raw.length), raw);
    }
  }
  parts.push(zigzag(0));
  return concatBytes(...parts);
}

/** An Avro long: zigzag, then 7 bits a byte. Only lengths and counts here, so never negative. */
function zigzag(n: number): Uint8Array {
  const out: number[] = [];
  let v = n * 2;
  while (v >= 0x80) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
  return Uint8Array.from(out);
}

function u16(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, n >> 8);
}

function u64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

// ─── Words ──────────────────────────────────────────────────────────────────

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function formatSize(bytes: number): string {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  return `${Math.ceil(bytes / 1024)} KiB`;
}

/** The service's own words, short, after a colon. */
async function reason(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).trim().slice(0, 200);
  return text ? `: ${text}` : '';
}
