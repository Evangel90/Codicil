// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The ar.io sandbox store, with a pretend network. `npm run arweave:smoke`
// does the same round trip on the real sandbox.

import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';
import { BlobError, fetchBody, storeBody } from '@codicil/sdk';
import {
  ARWEAVE_SANDBOX, arweaveSandboxStore, deepHash, encodeTags, signDataItem,
} from '../src/live/arweave.js';

const MIB = 1024 * 1024;

/** A pretend sandbox: an upload service and a gateway over one map. */
function sandbox(options: { hideFor?: number; statusFor?: (url: string, method: string) => number | undefined } = {}) {
  const items = new Map<string, Uint8Array>();
  const calls: { method: string; url: string }[] = [];
  let hidden = options.hideFor ?? 0;
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const forced = options.statusFor?.(url, method);
    if (forced) return new Response(`status ${forced}`, { status: forced });
    if (method === 'POST' && url === `${ARWEAVE_SANDBOX.uploadUrl}/v1/tx`) {
      const item = parseItem(new Uint8Array(init!.body as Uint8Array));
      items.set(item.id, item.data);
      return Response.json({ id: item.id, winc: '0' });
    }
    const id = url.match(/\/raw\/([^/]+)$/)?.[1];
    if (method === 'GET' && id) {
      const data = items.get(id);
      if (data && hidden-- <= 0) return new Response(data as Uint8Array<ArrayBuffer>);
      return new Response('Not found', { status: 404 });
    }
    return new Response('no such route', { status: 400 });
  };
  return { fetch: fake, items, calls };
}

/** Read a data item back and check its signature, as the upload service does. */
function parseItem(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  expect(view.getUint16(0, true)).toBe(2);
  const signature = bytes.subarray(2, 66);
  const owner = bytes.subarray(66, 98);
  expect(bytes[98]).toBe(0); // no target
  expect(bytes[99]).toBe(0); // no anchor
  const tagCount = Number(view.getBigUint64(100, true));
  const tagLength = Number(view.getBigUint64(108, true));
  const tags = bytes.subarray(116, 116 + tagLength);
  const data = bytes.subarray(116 + tagLength);
  const message = deepHash([
    utf8ToBytes('dataitem'), utf8ToBytes('1'), utf8ToBytes('2'),
    owner, new Uint8Array(0), new Uint8Array(0), tags, data,
  ]);
  expect(ed25519.verify(signature, message, owner)).toBe(true);
  return { id: base64urlnopad.encode(sha256(signature)), tagCount, tags, data: data.slice(), owner };
}

const noWait = { sleep: async () => {} };

describe('data items', () => {
  it('are signed ANS-104 items whose id is the hash of the signature', () => {
    const data = utf8ToBytes('sealed bytes');
    const item = signDataItem(data);
    const parsed = parseItem(item.bytes);
    expect(parsed.id).toBe(item.id);
    expect(item.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parsed.tagCount).toBe(1);
    expect(bytesToHex(parsed.data)).toBe(bytesToHex(data));
    expect(item.bytes.length).toBe(data.length + 156);
  });

  it('use a fresh key each time, so two uploads are not linked', () => {
    const a = parseItem(signDataItem(new Uint8Array(4)).bytes);
    const b = parseItem(signDataItem(new Uint8Array(4)).bytes);
    expect(bytesToHex(a.owner)).not.toBe(bytesToHex(b.owner));
    expect(a.id).not.toBe(b.id);
  });

  it('carry only a content type tag, in Avro', () => {
    const tags = encodeTags([['Content-Type', 'application/octet-stream']]);
    expect(bytesToHex(tags)).toBe(
      '02' + '18' + bytesToHex(utf8ToBytes('Content-Type')) + '30' + bytesToHex(utf8ToBytes('application/octet-stream')) + '00',
    );
    expect(encodeTags([])).toEqual(new Uint8Array(0));
  });

  it('sign the same way with the same key', () => {
    const key = new Uint8Array(32).fill(7);
    expect(signDataItem(new Uint8Array(3), key).id).toBe(signDataItem(new Uint8Array(3), key).id);
  });
});

describe('the sandbox store', () => {
  it('says which network it is and how long files last', () => {
    const store = arweaveSandboxStore();
    expect(store.name).toBe('arweave-sandbox');
    expect(store.lasts).toMatch(/three days/);
  });

  it('uploads and reads back, through storeBody and fetchBody', async () => {
    const net = sandbox();
    const store = arweaveSandboxStore({ fetch: net.fetch, ...noWait });
    const body = new Uint8Array(2048).map((_, i) => i % 251);
    const where = await storeBody(store, body);
    expect(where.store).toBe('arweave-sandbox');
    expect(net.calls[0]).toEqual({ method: 'POST', url: 'https://upload.services.ar-io.dev/v1/tx' });
    expect(await fetchBody([store], where)).toEqual(body);
    expect(net.calls.at(-1)).toEqual({ method: 'GET', url: `https://ar-io.dev/raw/${where.id}` });
  });

  it('uses the endpoints it is given, so mainnet is a change of config', async () => {
    const calls: string[] = [];
    const store = arweaveSandboxStore({
      uploadUrl: 'https://upload.example/', gatewayUrl: 'https://gw.example/',
      fetch: async (input, init) => {
        calls.push(String(input));
        if (init?.method === 'POST') return Response.json({ id: parseItem(new Uint8Array(init.body as Uint8Array)).id });
        return new Response(new Uint8Array(1));
      },
    });
    const id = await store.put(new Uint8Array(1));
    await store.get(id);
    expect(calls).toEqual(['https://upload.example/v1/tx', `https://gw.example/raw/${id}`]);
  });

  it('waits for a fresh upload that is not served yet', async () => {
    const net = sandbox({ hideFor: 2 });
    const waits: number[] = [];
    const store = arweaveSandboxStore({ fetch: net.fetch, sleep: async (ms) => { waits.push(ms); } });
    const id = await store.put(new Uint8Array([1, 2, 3]));
    expect(await store.get(id)).toEqual(new Uint8Array([1, 2, 3]));
    expect(waits).toEqual([500, 1000]);
  });

  it('gives up on a file that is not there, and says the test network deletes files', async () => {
    const net = sandbox();
    let clock = 0;
    const store = arweaveSandboxStore({ fetch: net.fetch, sleep: async (ms) => { clock += ms; }, now: () => clock });
    const error = await store.get('A'.repeat(43)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlobError);
    expect((error as BlobError).problem).toBe('not found');
    expect((error as BlobError).message).toMatch(/deletes files after about three days/);
    expect(clock).toBeLessThanOrEqual(20_000);
    expect(net.calls.length).toBe(6);
  });

  it('reads the gateway\'s 504 for an unknown id as not found', async () => {
    const net = sandbox({ statusFor: (_, method) => (method === 'GET' ? 504 : undefined) });
    let clock = 0;
    // Each 504 took 16 seconds on the real gateway.
    const store = arweaveSandboxStore({ fetch: net.fetch, sleep: async (ms) => { clock += ms; }, now: () => (clock += 8000) });
    const error = await store.get('A'.repeat(43)).catch((e: unknown) => e) as BlobError;
    expect(error.problem).toBe('not found');
    expect(net.calls.length).toBeLessThanOrEqual(3);
  });

  it('says the gateway had a problem on other 5xx', async () => {
    const net = sandbox({ statusFor: (_, method) => (method === 'GET' ? 502 : undefined) });
    const store = arweaveSandboxStore({ fetch: net.fetch, ...noWait });
    await expect(store.get('A'.repeat(43))).rejects.toMatchObject({ problem: 'unreachable' });
  });

  it('refuses something that is not an id without asking the network', async () => {
    const net = sandbox();
    const store = arweaveSandboxStore({ fetch: net.fetch, ...noWait });
    await expect(store.get('../info')).rejects.toMatchObject({ problem: 'not found' });
    await expect(store.get('B'.repeat(43))).rejects.toMatchObject({ problem: 'not found' });
    expect(net.calls).toEqual([]);
  });

  it('refuses a file over the free tier before uploading', async () => {
    const net = sandbox();
    const store = arweaveSandboxStore({ fetch: net.fetch });
    expect(ARWEAVE_SANDBOX.maxBytes).toBe(5 * MIB - 156);
    await store.put(new Uint8Array(ARWEAVE_SANDBOX.maxBytes));
    const error = await store.put(new Uint8Array(ARWEAVE_SANDBOX.maxBytes + 1)).catch((e: unknown) => e) as BlobError;
    expect(error.problem).toBe('too large');
    expect(error.message).toMatch(/up to 5\.0 MiB/);
    expect(net.calls.length).toBe(1);
  });

  it('refuses plainly when the service wants payment', async () => {
    const net = sandbox({ statusFor: (_, method) => (method === 'POST' ? 402 : undefined) });
    const store = arweaveSandboxStore({ fetch: net.fetch });
    const error = await store.put(new Uint8Array(10)).catch((e: unknown) => e) as BlobError;
    expect(error.problem).toBe('refused');
    expect(error.message).toMatch(/paid uploads are not set up/);
  });

  it('passes on the service saying too large', async () => {
    const net = sandbox({ statusFor: (_, method) => (method === 'POST' ? 413 : undefined) });
    await expect(arweaveSandboxStore({ fetch: net.fetch }).put(new Uint8Array(10))).rejects.toMatchObject({ problem: 'too large' });
  });

  it('tries an upload twice when the network drops, then says it is unreachable', async () => {
    let tries = 0;
    const store = arweaveSandboxStore({ fetch: async () => { tries++; throw new TypeError('fetch failed'); } });
    const error = await store.put(new Uint8Array(10)).catch((e: unknown) => e) as BlobError;
    expect(error.problem).toBe('unreachable');
    expect(error.message).toMatch(/could not be reached/);
    expect(tries).toBe(2);
  });

  it('does not trust an answer with another id', async () => {
    const store = arweaveSandboxStore({ fetch: async () => Response.json({ id: 'A'.repeat(43) }) });
    await expect(store.put(new Uint8Array(10))).rejects.toMatchObject({ problem: 'refused' });
  });

  it('catches a gateway that changed the bytes', async () => {
    const net = sandbox();
    const store = arweaveSandboxStore({ fetch: net.fetch, ...noWait });
    const where = await storeBody(store, new Uint8Array([1, 2, 3]));
    net.items.set(where.id, new Uint8Array([1, 2, 4]));
    await expect(fetchBody([store], where)).rejects.toMatchObject({ problem: 'changed' });
  });
});
