// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Asking the proof server for a proof, written for a browser tab.
//
// The proof server is sent the circuit's proving key with every request, and
// the passkey check-in's key is 448 MB. Midnight.js's own HTTP proof provider
// builds that request in memory several times over: the key is fetched once to
// check the call and again to prove it, copied into the ledger's WebAssembly
// memory, copied out inside the request body, and the body is copied once more
// before it is sent. In Node that works. In a browser tab it came to more than
// 3 GB and the tab crashed (found on Preview on 26 Nov 2026, in the first
// check-in ever made from a real browser).
//
// This provider speaks the same two endpoints, `/check` and `/prove`, and
// sends the same bytes, without holding a large key in the page's memory:
//
//   - a large key is handed over as a Blob. In a browser that Blob is the copy
//     in Cache Storage, on disk, so the key never becomes a JavaScript array;
//   - the request body is not assembled in WebAssembly. The ledger builds the
//     small part of it (everything but the proving key), and the key's Blob is
//     put in its place. The browser sends the parts from where they are.
//
// For a large key the body is byte-for-byte what `createProvingPayload`
// produces; a unit test checks that against the ledger. Small keys go through
// `createProvingPayload` itself.

import {
  CostModel, createCheckPayload, createProvingPayload, parseCheckResult, type ProvingProvider,
} from '@midnight-ntwrk/midnight-js-protocol/v9';
import { createLedger9ProofProvider, type ProofProvider } from '@midnight-ntwrk/midnight-js/types';

/** The three files a proof needs, by circuit. */
export interface KeySource {
  getProverKey(circuit: string): Promise<Uint8Array>;
  getVerifierKey(circuit: string): Promise<Uint8Array>;
  getZKIR(circuit: string): Promise<Uint8Array>;
  /** The proving key without reading it into memory, where that is possible. */
  getProverKeyBlob?(circuit: string): Promise<Blob>;
  /** Called when the proving key is no longer needed in memory. */
  release?(circuit: string): void;
}

/** Keys at least this large are sent as a Blob spliced into the request; smaller ones the ledger packs itself. */
export const LARGE_KEY_BYTES = 16 * 1024 * 1024;

export class ProofServerProblem extends Error {
  override name = 'ProofServerError';
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * The request body for `/prove`, as parts: what comes before the proving key,
 * the key itself, and what comes after. Joined, they are exactly
 * `createProvingPayload(preimage, bindingInput, { proverKey, verifierKey, ir })`.
 *
 * The ledger writes the three files one after another, each with its length
 * in front, the proving key first. So the same call with an empty proving key
 * gives the bytes around it, and the only difference is the length field.
 */
export function provingPayloadParts(
  preimage: Uint8Array,
  bindingInput: bigint | undefined,
  key: { proverKey: Uint8Array | Blob; verifierKey: Uint8Array; ir: Uint8Array },
): (Uint8Array | Blob)[] {
  const withKey = (proverKey: Uint8Array) => createProvingPayload(preimage, bindingInput, { proverKey, verifierKey: key.verifierKey, ir: key.ir });
  // Two stand-ins of different lengths show where the key sits and how its length is written.
  const a = withKey(new Uint8Array(0));
  const b = withKey(new Uint8Array(1));
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  const afterKey = a.length - (at + 1);
  // `a` has the length 0 at `at`; `b` has the length 1 (written as 4, see compactLength) and one key byte after it.
  if (a[at] !== 0 || b[at] !== 4 || b.length !== a.length + 1 || afterKey < 0) {
    throw new Error('the proving payload is not laid out as expected; refusing to build it by hand');
  }
  const tail = a.subarray(at + 1);
  const length = key.proverKey instanceof Blob ? key.proverKey.size : key.proverKey.length;
  return [a.subarray(0, at), compactLength(length), key.proverKey, tail];
}

/**
 * A length as the ledger's serializer writes it (SCALE compact integers):
 * one byte up to 63, two up to 16,383, four up to 2^30 - 1.
 */
export function compactLength(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** 30) throw new Error('length out of range');
  if (n < 1 << 6) return Uint8Array.of(n << 2);
  if (n < 1 << 14) return Uint8Array.of(((n & 0x3f) << 2) | 1, n >> 6);
  const v = n * 4 + 2;
  return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

/** The spliced body, or undefined if a future ledger lays the payload out differently: then the ledger packs it. */
function splice(...args: Parameters<typeof provingPayloadParts>): (Uint8Array | Blob)[] | undefined {
  try {
    return provingPayloadParts(...args);
  } catch {
    return undefined;
  }
}

export interface ProofServerOptions {
  fetch?: typeof fetch;
  /** Give up on a request after this long. A k = 18 proof took 27 s on a laptop. */
  timeoutMs?: number;
}

/** The ledger's proving interface, answered by a proof server over HTTP. */
export function proofServerProver(url: string, keys: KeySource, options: ProofServerOptions = {}): ProvingProvider {
  const base = url.replace(/\/$/, '');
  const fetchFn = options.fetch ?? ((...args) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const post = async (path: string, parts: (Uint8Array | Blob)[]): Promise<Uint8Array> => {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method: 'POST',
        // A Blob of parts: the browser sends each part from where it is, without joining them first.
        body: new Blob(parts as BlobPart[]),
        headers: { 'Content-Type': 'application/octet-stream' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw Object.assign(new ProofServerProblem(`the proof server at ${base} did not answer`), { cause });
    }
    if (!res.ok) throw new ProofServerProblem(`the proof server answered ${res.status} ${res.statusText}`.trim(), res.status);
    return new Uint8Array(await res.arrayBuffer());
  };
  return {
    async check(preimage, circuit) {
      return parseCheckResult(await post('/check', [createCheckPayload(preimage, await keys.getZKIR(circuit))]));
    },
    async prove(preimage, circuit, bindingInput) {
      const verifierKey = await keys.getVerifierKey(circuit);
      const ir = await keys.getZKIR(circuit);
      const blob = await keys.getProverKeyBlob?.(circuit);
      if (blob && blob.size >= LARGE_KEY_BYTES) {
        const spliced = splice(preimage, bindingInput, { proverKey: blob, verifierKey, ir });
        if (spliced) return post('/prove', spliced);
      }
      const proverKey = blob ? new Uint8Array(await blob.arrayBuffer()) : await keys.getProverKey(circuit);
      const parts = (proverKey.length >= LARGE_KEY_BYTES && splice(preimage, bindingInput, { proverKey, verifierKey, ir }))
        || [createProvingPayload(preimage, bindingInput, { proverKey, verifierKey, ir })];
      // From here the request holds the only reference to the key.
      keys.release?.(circuit);
      return post('/prove', parts);
    },
    // The ledger asks for nothing through this; the proof server is given the key in `prove`.
    async lookupKey() {
      return undefined;
    },
  };
}

/** A Midnight.js proof provider on a proof server, for transactions of the current ledger. */
export function proofServerProofProvider(url: string, keys: KeySource, options: ProofServerOptions = {}): ProofProvider {
  return createLedger9ProofProvider(proofServerProver(url, keys, options), CostModel.initialCostModel());
}
