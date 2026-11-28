// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The pure parts of the live layer: the chain boundary, what is kept and how
// it is backed up, invitations, the wallet connector's choices, the circuit
// key downloads, and the words for everything that can go wrong.

import { describe, expect, it } from 'vitest';
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import { createProvingPayload, unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { proofDataIntoSerializedPreimage } from '@midnightntwrk/onchain-runtime-v4';
import { Contract, Phase } from '@codicil/contracts/vault';
import { createWitnesses, newRecoveryCode, recoveryCodeToText, VAULT_OPTIONS_OFF, rpIdHash } from '@codicil/sdk';
import type { VaultChain, VaultHost } from '../src/chain/types.js';
import { DemoChain, MemoryHost } from '../src/demo/chain.js';
import { approveWithPasskey, createDemoPasskey } from '../src/demo/passkey.js';
import { decodeJson, encodeJson, fromBase64Url, toBase64Url } from '../src/live/codec.js';
import { readWithCode } from '../src/live/keyring.js';
import { connectLace, findWallets, NIGHT_TOKEN, pickWallet } from '../src/live/lace.js';
import {
  describeProblem, errorChain, InputProblem, nodeReason, NoWallet, OldWallet, ProofServerDown, walletReadiness, WrongNetwork,
} from '../src/live/problems.js';
import {
  decodeKit, decodeRecords, encodeRecords, exportBackup, importBackup, kitLink, memoryStorage, mergeRecords,
  type OwnerRecord, type VaultRecord,
} from '../src/live/records.js';
import { compactLength, LARGE_KEY_BYTES, proofServerProver, provingPayloadParts } from '../src/live/prover.js';
import { LiveStore, type OwnerView } from '../src/live/store.js';
import {
  addressFromHex, addressToHex, coinPublicKeyToHex, DUST_FOR_DEPLOYMENT, formatDust, formatNight, parseNight, SPECK_PER_DUST, STAR_PER_NIGHT,
} from '../src/live/wallet.js';
import { ArtifactError, HttpZkConfigProvider, type ArtifactCache, type ArtifactProgress } from '../src/live/zk-artifacts.js';

const T0 = 1_800_000_000;

describe('the chain boundary', () => {
  const config = {
    ownerPasskeyCommit: new Uint8Array(32).fill(1), ownerEdCommit: new Uint8Array(32), passkeyRpIdHash: rpIdHash('localhost'),
    willRoot: 5n, firstDeadline: BigInt(T0 + 600), maxPeriod: 1200n, challengeWindow: 120n, claimWindow: 600n,
    tokenColor: new Uint8Array(32).fill(7), guardianRoot: 0n, guardianThreshold: 0n, attestorKeyCommit: new Uint8Array(32), ...VAULT_OPTIONS_OFF,
  };

  it('the in-memory chain is a VaultChain: read, call, be told, and keep time', async () => {
    const chain: VaultChain = await DemoChain.deploy(config, T0);
    expect(chain.address).toMatch(/^[0-9a-f]{64}$/);
    expect(chain.ledger.phase).toBe(Phase.armed);
    expect(chain.now).toBe(T0);
    let told = 0;
    const off = chain.subscribe(() => { told++; });
    const out = await chain.call('deposit', {}, 9n);
    expect(out.trace).toEqual([{ address: chain.address, circuitId: 'deposit' }]);
    expect(out.receipt).toBeUndefined();
    expect(chain.ledger.estateTotal).toBe(9n);
    expect((await chain.refresh()).estateTotal).toBe(9n);
    expect(told).toBe(1);
    // A refused call changes nothing and tells nobody.
    await expect(chain.call('triggerTimeout', {})).rejects.toThrow(/owner is still alive/);
    expect(told).toBe(1);
    off();
    await chain.call('deposit', {}, 1n);
    expect(told).toBe(1);
  });

  it('the memory host creates, reopens and moves the clock of its vaults', async () => {
    const host: VaultHost & { advance(s: number): void } = new MemoryHost(T0);
    const records: unknown[] = [];
    const stages: unknown[] = [];
    const chain = await host.createVault(config, { onRecord: (r) => { records.push(r); }, onStage: (s) => stages.push(s) });
    expect(records).toEqual([{ address: chain.address, maintenanceKey: '', deferred: [], inserted: [], complete: true }]);
    expect(stages).toEqual([{ step: 'deploy', total: 1 }]);
    expect(await host.openVault(chain.address)).toBe(chain);
    await expect(host.openVault('00'.repeat(32))).rejects.toThrow(/there is no vault at/);
    host.advance(601);
    expect(host.now).toBe(T0 + 601);
    expect(chain.now).toBe(T0 + 601);
    await chain.call('triggerTimeout', {});
    expect(chain.ledger.phase).toBe(Phase.pending);
  });
});

describe('amounts and addresses', () => {
  it('shows tNIGHT and DUST the way a person reads them', () => {
    expect(formatNight(12_500_000n)).toBe('12.5');
    expect(formatNight(4_996_000_000n)).toBe('4,996');
    expect(formatNight(1n, 6)).toBe('0.000001');
    expect(formatDust(276_740_000_000_000_000n)).toBe('276.7');
    expect(formatDust(DUST_FOR_DEPLOYMENT, 0)).toBe('30');
  });

  it('reads a typed amount, or refuses it', () => {
    expect(parseNight('10')).toBe(10n * STAR_PER_NIGHT);
    expect(parseNight(' 0.25 ')).toBe(250_000n);
    for (const bad of ['', '0', 'abc', '1.0000001', '-3', '1e3']) expect(parseNight(bad)).toBeUndefined();
  });

  it('turns a wallet address into what a contract pays to, and back', () => {
    const hex = 'e613da4fd0eb77e32d376f2db02e2f4b55d8fa803ff6bddc9f3b43e732b9c869';
    const preview = addressFromHex(hex, 'preview');
    expect(preview).toMatch(/^mn_addr_preview1/);
    expect(addressToHex(preview, 'preview')).toBe(hex);
    expect(() => addressToHex(preview, 'preprod')).toThrow(/for another network \(it starts with mn_addr_preview\); this vault is on preprod/);
    expect(() => addressToHex('not an address', 'preview')).toThrow(/not a Midnight address/);
    expect(addressFromHex(hex, 'mainnet')).toMatch(/^mn_addr1/);
    // Hex keys pass through; the wallet's Bech32m form is decoded.
    expect(coinPublicKeyToHex(hex.toUpperCase(), 'preview')).toBe(hex);
  });

  it("knows tNIGHT's token type as the wallet connector keys it", () => {
    expect(NIGHT_TOKEN).toBe(unshieldedToken().raw);
  });
});

describe('what is kept in the browser', () => {
  it('encodes bigints and bytes and reads them back', () => {
    const value = { n: 2n ** 200n, b: new Uint8Array([0, 255, 16]), nested: [{ n: -5n }], plain: 'text', $n: 'not a bigint here' };
    expect(decodeJson(encodeJson(value))).toEqual(value);
    expect(fromBase64Url(toBase64Url(new Uint8Array(100_000).fill(200)))).toHaveLength(100_000);
  });

  it('ignores storage it cannot read instead of breaking', () => {
    expect(decodeRecords(null)).toEqual([]);
    expect(decodeRecords('{not json')).toEqual([]);
    expect(decodeRecords('{"format":99,"records":[]}')).toEqual([]);
    expect(decodeRecords(encodeJson({ format: 1, records: [{ junk: true }, null] }))).toEqual([]);
  });
});

async function vaultWithRecords() {
  const host = new MemoryHost(T0);
  const storage = memoryStorage();
  const store = new LiveStore({ storage, passkeys: { approve: approveWithPasskey }, rpId: 'localhost' });
  const bytes = newRecoveryCode();
  const code = recoveryCodeToText(bytes);
  await store.setUp({ code: bytes });
  await store.attach(host);
  await store.createVault({
    ownerName: 'Ngozi', heirs: [{ name: 'Tunde', sharePct: 100, backupName: 'Funke' }], guardians: ['Dr. Bello'], threshold: 1,
    timers: { every: 600, window: 180, grace: 0, testing: true },
  }, createDemoPasskey());
  const view = store.getSnapshot().active as OwnerView;
  await store.saved();
  return { host, store, storage, view, code, records: (await readWithCode(storage.text!, code)).records };
}

const cleanStore = () => new LiveStore({ storage: memoryStorage(), passkeys: { approve: approveWithPasskey }, rpId: 'localhost' });

describe('backups', () => {
  it('a backup opens with the printed recovery code in a clean browser, and the vault works again', async () => {
    const { host, store, records, code } = await vaultWithRecords();
    const file = await store.exportBackup();
    const parsed = JSON.parse(file) as Record<string, unknown>;
    expect(parsed).toMatchObject({ format: 'codicil-backup', version: 2, vaults: 1 });
    // Nothing readable without the code: no names, no keys.
    expect(file).not.toContain('Ngozi');
    expect(file).not.toContain('Tunde');
    expect(file).not.toContain(records[0].id);

    const clean = cleanStore();
    await clean.attach(host);
    expect(clean.backupNeeds(file)).toMatchObject({ kind: 'keyring', code: true, passkeys: [] });
    await expect(clean.importBackup(file, { kind: 'recovery-code', secret: recoveryCodeToText(newRecoveryCode()) })).rejects.toThrow(/does not open this/);
    expect(await clean.importBackup(file, { kind: 'recovery-code', secret: code })).toEqual({ added: 1, updated: 0 });
    // A clean browser takes the file's keyring as its own: the same code opens it from now on.
    expect(clean.getSnapshot().access.state).toBe('open');
    expect(clean.getSnapshot().active).toMatchObject({ role: 'owner', status: 'ready', ownerName: 'Ngozi' });
    expect(await clean.checkIn()).toBe(true);
    // Restoring the same file again changes nothing.
    expect(await clean.importBackup(file, { kind: 'recovery-code', secret: code })).toEqual({ added: 0, updated: 0 });
  });

  it('an older backup, locked with a passphrase, still opens, and is locked with the keyring once the browser is set up', async () => {
    const { host, records } = await vaultWithRecords();
    const file = await exportBackup(records, 'correct horse battery');
    const clean = cleanStore();
    await clean.attach(host);
    expect(clean.backupNeeds(file)).toEqual({ kind: 'passphrase' });
    await expect(clean.importBackup(file, { kind: 'recovery-code', secret: 'x' })).rejects.toThrow(/locked with a passphrase/);
    expect(await clean.importBackup(file, { passphrase: 'correct horse battery' })).toEqual({ added: 1, updated: 0 });
    // Not set up yet: the vault waits, and is locked with everything else at set-up.
    expect(clean.getSnapshot().access).toMatchObject({ state: 'new', legacy: 1 });
    await clean.setUp({ code: newRecoveryCode() });
    expect(clean.getSnapshot().active).toMatchObject({ role: 'owner', status: 'ready' });
    expect(await clean.checkIn()).toBe(true);
  });

  it('refuses a wrong passphrase, a short one, and a file that is not a backup', async () => {
    const { records } = await vaultWithRecords();
    const file = await exportBackup(records, 'correct horse battery');
    await expect(importBackup(file, 'correct horse batterx')).rejects.toThrow(/passphrase does not open this backup/);
    await expect(importBackup('{"hello":1}', 'x')).rejects.toThrow(/not a Codicil backup/);
    await expect(importBackup('not json', 'x')).rejects.toThrow(/not a Codicil backup/);
    await expect(importBackup(file.replace('"version": 1', '"version": 2'), 'correct horse battery')).rejects.toThrow(/newer version/);
    await expect(exportBackup(records, 'short')).rejects.toThrow(/at least 8 characters/);
    await expect(exportBackup([], 'long enough')).rejects.toBeInstanceOf(InputProblem);
    // A flipped byte in the data is caught, not restored as garbage.
    const body = JSON.parse(file) as { data: string };
    const tampered = JSON.stringify({ ...body, data: (body.data[0] === 'A' ? 'B' : 'A') + body.data.slice(1) });
    await expect(importBackup(tampered, 'correct horse battery')).rejects.toThrow(/passphrase does not open/);
  });

  it('merging keeps what is here and takes the copy that got further', async () => {
    const { records } = await vaultWithRecords();
    const mine = records[0] as OwnerRecord;
    const unfinished: OwnerRecord = { ...mine, deployment: { ...mine.deployment!, complete: false, inserted: [] } };
    const other = { ...mine, id: 'ffffffffffffffff' } as VaultRecord;
    expect(mergeRecords([unfinished], [mine])).toMatchObject({ added: 0, updated: 1, records: [{ deployment: { complete: true } }] });
    expect(mergeRecords([mine], [unfinished])).toMatchObject({ added: 0, updated: 0, records: [{ deployment: { complete: true } }] });
    expect(mergeRecords([mine], [other]).records.map((r) => r.id)).toEqual([mine.id, 'ffffffffffffffff']);
    expect(decodeRecords(encodeRecords([mine, other]))).toHaveLength(2);
  });
});

describe('invitations', () => {
  it('an heir invitation carries the letter and the key, and survives being wrapped in a link or a sentence', async () => {
    const { store, view } = await vaultWithRecords();
    const kit = store.heirKit(view.heirs[0].id);
    const decoded = decodeKit(kit);
    expect(decoded).toMatchObject({ kind: 'heir', network: 'memory', name: 'Tunde', ownerName: 'Ngozi', backup: false });
    expect(decodeKit(store.heirKit(view.heirs[0].id, true))).toMatchObject({ name: 'Funke', backup: true });
    expect(decodeKit(kitLink('http://localhost:5173', kit))).toEqual(decoded);
    expect(decodeKit(`Here it is:\n  ${kit}\nKeep it safe.`)).toEqual(decoded);
    expect(decodeKit(store.guardianKit(view.guardians[0].id))).toMatchObject({ kind: 'guardian', name: 'Dr. Bello', address: view.vault!.address });
  });

  it('says what is wrong with something that is not an invitation', async () => {
    const { store, view } = await vaultWithRecords();
    const kit = store.heirKit(view.heirs[0].id);
    expect(() => decodeKit('hello')).toThrow(/not a Codicil invitation/);
    expect(() => decodeKit('codicil:claim:v1:AAAA')).toThrow(/bare heir letter, which is not enough to claim by itself/);
    expect(() => decodeKit(kit.slice(0, kit.length - 40))).toThrow(/incomplete or damaged/);
    expect(() => decodeKit('codicil:guardian-kit:v1:e30')).toThrow(/missing/);
    expect(() => store.heirKit('nobody')).toThrow(/not in this will/);
  });
});

/** A wallet under `window.midnight`, shaped as the DApp connector 4.1.0 types describe. */
function fakeWallet(over: { network: string; apiVersion?: string; name?: string; decline?: boolean }) {
  const asked: string[] = [];
  const api = {
    getConfiguration: async () => ({ networkId: over.network, indexerUri: 'https://i/api', indexerWsUri: 'wss://i/ws', substrateNodeUri: 'https://n', proverServerUri: undefined }),
    getConnectionStatus: async () => ({ status: 'connected', networkId: over.network }),
    getUnshieldedAddress: async () => ({ unshieldedAddress: addressFromHex('ab'.repeat(32), over.network) }),
    getShieldedAddresses: async () => ({ shieldedAddress: '', shieldedCoinPublicKey: 'cd'.repeat(32), shieldedEncryptionPublicKey: 'ef'.repeat(32) }),
    getUnshieldedBalances: async () => ({ [NIGHT_TOKEN]: 7n * STAR_PER_NIGHT, ['11'.repeat(32)]: 99n }),
    getDustBalance: async () => ({ cap: 100n * SPECK_PER_DUST, balance: 3n * SPECK_PER_DUST }),
    balanceUnsealedTransaction: async (tx: string) => ({ tx: `${tx}ff` }),
    submitTransaction: async (tx: string) => { asked.push(`submit:${tx}`); },
  };
  // Only the methods the app calls; a real wallet has more.
  const initial: InitialAPI = {
    rdns: 'io.lace', name: over.name ?? 'Lace', icon: '', apiVersion: over.apiVersion ?? '4.1.0',
    connect: async (networkId: string) => {
      asked.push(networkId);
      if (over.decline) throw Object.assign(new Error('no'), { type: 'DAppConnectorAPIError', code: 'Rejected', reason: 'User rejected' });
      if (networkId !== over.network) throw Object.assign(new Error('other network'), { type: 'DAppConnectorAPIError', code: 'InvalidRequest', reason: 'network mismatch' });
      return api as unknown as ConnectedAPI;
    },
  };
  return { initial, asked };
}

describe('the wallet connector', () => {
  it('finds wallets, prefers Lace, and ignores junk under window.midnight', () => {
    const lace = fakeWallet({ network: 'preview' }).initial;
    const other = { ...fakeWallet({ network: 'preview', name: 'Other' }).initial, rdns: 'com.other' };
    expect(findWallets({})).toEqual([]);
    expect(findWallets({ midnight: { a: 1, b: null, c: other, d: lace } })).toEqual([other, lace]);
    expect(pickWallet([other, lace])).toBe(lace);
    expect(pickWallet([other])).toBe(other);
    expect(pickWallet([])).toBeUndefined();
  });

  it('connects on whichever test network the wallet is on, trying the last one used first', async () => {
    const preprod = fakeWallet({ network: 'preprod' });
    const wallet = await connectLace({ scope: { midnight: { x: preprod.initial } } });
    expect(preprod.asked).toEqual(['preview', 'preprod']);
    expect(await wallet.services()).toEqual({ networkId: 'preprod', indexerUri: 'https://i/api', indexerWsUri: 'wss://i/ws', nodeUri: 'https://n', proofServerUri: 'http://localhost:6300' });
    expect(await wallet.balances()).toEqual({ night: 7n * STAR_PER_NIGHT, dust: 3n * SPECK_PER_DUST });
    expect(await wallet.address()).toEqual({ bech32: addressFromHex('ab'.repeat(32), 'preprod'), hex: 'ab'.repeat(32) });
    expect(await wallet.shieldedKeys()).toEqual({ coinPublicKey: 'cd'.repeat(32), encryptionPublicKey: 'ef'.repeat(32) });
    expect(await wallet.stillConnected()).toBe(true);
    // Transactions cross as hex strings and come back as bytes.
    expect(await wallet.balanceTransaction(new Uint8Array([1, 2, 254]))).toEqual(new Uint8Array([1, 2, 254, 255]));
    await wallet.submitTransaction(new Uint8Array([10, 11]));
    expect(preprod.asked.at(-1)).toBe('submit:0a0b');

    const again = fakeWallet({ network: 'preprod' });
    await connectLace({ scope: { midnight: { x: again.initial } }, prefer: 'preprod' });
    expect(again.asked).toEqual(['preprod']);
  });

  it('stops at once when the person declines, and explains the other ways it can fail', async () => {
    const declined = fakeWallet({ network: 'preview', decline: true });
    const e = await connectLace({ scope: { midnight: { x: declined.initial } } }).catch((x: unknown) => x);
    expect(declined.asked).toEqual(['preview']);
    expect(describeProblem(e, { wallet: 'Lace' })).toMatchObject({ kind: 'rejected', title: 'You declined in your wallet' });

    await expect(connectLace({ scope: {} })).rejects.toBeInstanceOf(NoWallet);
    await expect(connectLace({ scope: { midnight: { x: fakeWallet({ network: 'preview', apiVersion: '3.0.0' }).initial } } })).rejects.toBeInstanceOf(OldWallet);
    const mainnet = await connectLace({ scope: { midnight: { x: fakeWallet({ network: 'mainnet' }).initial } } }).catch((x: unknown) => x);
    expect(mainnet).toBeInstanceOf(WrongNetwork);
    expect(describeProblem(mainnet, { wallet: 'Lace' }).body).toMatch(/test networks only: Preview or Preprod/);
  });
});

/** Cache Storage, as far as the app uses it. */
function memoryCache(): ArtifactCache & { size: number } {
  const kept = new Map<string, { tag: string; bytes: Uint8Array }>();
  return {
    get size() { return kept.size; },
    get: async (url, tag) => (kept.get(url)?.tag === tag ? new Response(kept.get(url)!.bytes.slice().buffer as ArrayBuffer) : undefined),
    put: async (url, tag, response) => { kept.set(url, { tag, bytes: new Uint8Array(await response.arrayBuffer()) }); },
  };
}

function fakeServer(files: Record<string, Uint8Array>, tags: Record<string, string> = {}) {
  const requests: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${new URL(url).pathname}`);
    const body = files[new URL(url).pathname];
    if (!body) return new Response('<html>the app</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const headers = { 'content-type': 'application/octet-stream', 'content-length': String(body.length), etag: tags[new URL(url).pathname] ?? '"v1"' };
    return new Response(method === 'HEAD' ? null : body.slice().buffer as ArrayBuffer, { status: 200, headers });
  }) as typeof fetch;
  return { fetchFn, requests };
}

describe('circuit keys over HTTP', () => {
  const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
  const files = {
    '/zk/keys/claim.prover': big,
    '/zk/keys/claim.verifier': new Uint8Array([1, 2, 3]),
    '/zk/zkir/claim.bzkir': new Uint8Array([4, 5]),
    '/zk/compiler/contract-info.json': new TextEncoder().encode('{"runtime-version":"0.21.0"}'),
  };

  it('fetches each kind of file, reports progress on the large one, and reads the runtime version', async () => {
    const { fetchFn, requests } = fakeServer(files);
    const progress: ArtifactProgress[] = [];
    const zk = new HttpZkConfigProvider<string>('http://app.test/zk', { fetch: fetchFn, onProgress: (p) => progress.push(p) });
    expect(await zk.getVerifierKey('claim')).toEqual(new Uint8Array([1, 2, 3]));
    expect(await zk.getZKIR('claim')).toEqual(new Uint8Array([4, 5]));
    expect(await zk.getArtifactRuntimeVersion()).toBe('0.21.0');
    const key = await zk.getProverKey('claim');
    expect(key).toEqual(big);
    const mine = progress.filter((p) => p.kind === 'prover');
    expect(mine[0]).toMatchObject({ circuit: 'claim', loaded: 0, total: big.length, cached: false });
    expect(mine.at(-1)).toMatchObject({ loaded: big.length, total: big.length });
    // Small files are fetched once; asking again costs nothing.
    await zk.getVerifierKey('claim');
    expect(requests.filter((r) => r.endsWith('claim.verifier'))).toHaveLength(1);
    expect(await zk.hasProverKey('claim')).toBe(true);
    expect(await zk.hasProverKey('missing')).toBe(false);
  });

  it('keeps a proving key between visits, until the file on the server changes', async () => {
    const cache = memoryCache();
    const tags = { '/zk/keys/claim.prover': '"v1"' };
    const { fetchFn, requests } = fakeServer(files, tags);
    const progress: ArtifactProgress[] = [];
    const visit = () => new HttpZkConfigProvider<string>('http://app.test/zk/', { fetch: fetchFn, cache, onProgress: (p) => progress.push(p) });
    await visit().getProverKey('claim');
    expect(requests).toEqual(['HEAD /zk/keys/claim.prover', 'GET /zk/keys/claim.prover']);
    expect(await visit().getProverKey('claim')).toEqual(big);
    expect(requests.filter((r) => r.startsWith('GET'))).toHaveLength(1);
    expect(progress.at(-1)).toMatchObject({ cached: true, loaded: big.length });
    tags['/zk/keys/claim.prover'] = '"v2"';
    await visit().getProverKey('claim');
    expect(requests.filter((r) => r.startsWith('GET'))).toHaveLength(2);
  });

  it('asked twice in one proof, a proving key is fetched and held once, and can be let go', async () => {
    const { fetchFn, requests } = fakeServer(files);
    const zk = new HttpZkConfigProvider<string>('http://app.test/zk', { fetch: fetchFn });
    const first = await zk.getProverKey('claim');
    expect(await zk.getProverKey('claim')).toBe(first);
    expect(requests.filter((r) => r === 'GET /zk/keys/claim.prover')).toHaveLength(1);
    zk.release('claim');
    await zk.getProverKey('claim');
    expect(requests.filter((r) => r === 'GET /zk/keys/claim.prover')).toHaveLength(2);
  });

  it('hands a proving key over as a Blob that is the cached copy, downloaded once as a stream', async () => {
    const cache = memoryCache();
    const { fetchFn, requests } = fakeServer(files);
    const progress: ArtifactProgress[] = [];
    const zk = new HttpZkConfigProvider<string>('http://app.test/zk', { fetch: fetchFn, cache, onProgress: (p) => progress.push(p) });
    const blob = await zk.getProverKeyBlob('claim');
    expect(same(new Uint8Array(await blob.arrayBuffer()), big)).toBe(true);
    expect(cache.size).toBe(1);
    expect(progress[0]).toMatchObject({ kind: 'prover', loaded: 0, total: big.length, cached: false });
    expect(progress.at(-1)).toMatchObject({ loaded: big.length, cached: false });
    expect((await zk.getProverKeyBlob('claim')).size).toBe(big.length);
    expect(progress.at(-1)).toMatchObject({ loaded: big.length, cached: true });
    expect(requests.filter((r) => r.startsWith('GET'))).toEqual(['GET /zk/keys/claim.prover']);
    // With nowhere to keep it (Node), the Blob is made from memory.
    const plain = new HttpZkConfigProvider<string>('http://app.test/zk', { fetch: fetchFn });
    expect((await plain.getProverKeyBlob('claim')).size).toBe(big.length);
    // A cache that refuses the file (a private window) is given up on, and the key still arrives.
    let puts = 0;
    const refusing: ArtifactCache = { get: async () => undefined, put: async (_u, _t, response) => { puts++; await response.body?.cancel(); } };
    const priv = new HttpZkConfigProvider<string>('http://app.test/zk', { fetch: fetchFn, cache: refusing });
    expect(same(new Uint8Array(await (await priv.getProverKeyBlob('claim')).arrayBuffer()), big)).toBe(true);
    await priv.getProverKeyBlob('claim');
    expect(puts).toBe(1);
  });

  it('tells "the keys were never built" apart from a dropped connection', async () => {
    const { fetchFn } = fakeServer(files);
    const zk = new HttpZkConfigProvider<string>('http://app.test/zk', { fetch: fetchFn });
    const missing = await zk.getProverKey('checkInPasskey').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ArtifactError);
    expect(describeProblem(missing)).toMatchObject({ kind: 'keys-missing', command: 'npm run compile:full', retry: false });
    const offline = new HttpZkConfigProvider<string>('http://app.test/zk', { fetch: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch });
    expect(describeProblem(await offline.getVerifierKey('claim').catch((e: unknown) => e))).toMatchObject({ kind: 'network', retry: true });
  });
});

/** A real proof preimage: a deposit run through the compiled vault, as the proof server would receive it. */
async function depositPreimage(): Promise<Uint8Array> {
  const contract = new Contract(createWitnesses());
  const init = await contract.initialState(createConstructorContext({}, '0'.repeat(64)), {
    ownerPasskeyCommit: new Uint8Array(32).fill(1), ownerEdCommit: new Uint8Array(32), passkeyRpIdHash: rpIdHash('localhost'),
    willRoot: 5n, firstDeadline: BigInt(T0 + 600), maxPeriod: 1200n, challengeWindow: 120n, claimWindow: 600n,
    tokenColor: new Uint8Array(32).fill(7), guardianRoot: 0n, guardianThreshold: 0n, attestorKeyCommit: new Uint8Array(32), ...VAULT_OPTIONS_OFF,
  });
  const ctx = createCircuitContext({
    circuitId: 'deposit', contractAddress: sampleContractAddress(), coinPublicKeyOrZswapState: '0'.repeat(64),
    contractState: init.currentContractState, privateState: {}, time: T0, parentBlockHash: '0'.repeat(64),
  });
  const out = await contract.impureCircuits.deposit(ctx, 9n);
  const data = out.context.callProofDataTrace.at(-1)!;
  return proofDataIntoSerializedPreimage(data.input, data.output, data.publicTranscript, data.privateTranscriptOutputs, 'deposit');
}

function pattern(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}
const joined = async (parts: (Uint8Array | Blob)[]) => new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
/** Byte equality that stays quick, and quiet on failure, for megabytes. */
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));

describe('asking the proof server, without a 448 MB key in memory', () => {
  const verifierKey = pattern(1353, 3);
  const ir = pattern(1026, 5);

  it('writes lengths the way the ledger does', () => {
    expect([...compactLength(0)]).toEqual([0]);
    expect([...compactLength(63)]).toEqual([0xfc]);
    expect([...compactLength(64)]).toEqual([0x01, 0x01]);
    expect([...compactLength(16383)]).toEqual([0xfd, 0xff]);
    expect([...compactLength(16384)]).toEqual([0x02, 0x00, 0x01, 0x00]);
    // The passkey check-in's proving key, 448 MB: four bytes, little-endian, the length times four plus two.
    const big = compactLength(469_859_416);
    expect(new DataView(big.buffer).getUint32(0, true)).toBe(469_859_416 * 4 + 2);
    expect(() => compactLength(2 ** 30)).toThrow(/out of range/);
  });

  it("builds the request body around the key, byte for byte what the ledger's own function gives", async () => {
    const preimage = await depositPreimage();
    for (const size of [0, 1, 63, 64, 300, 16_383, 16_384, 70_000, 3_000_000]) {
      for (const binding of [undefined, 77n]) {
        const proverKey = pattern(size, 9);
        const whole = createProvingPayload(preimage, binding, { proverKey, verifierKey, ir });
        expect(same(await joined(provingPayloadParts(preimage, binding, { proverKey, verifierKey, ir })), whole), `key of ${size} bytes`).toBe(true);
        // The key as a Blob: it is never read here, only placed.
        expect(same(await joined(provingPayloadParts(preimage, binding, { proverKey: new Blob([proverKey as BlobPart]), verifierKey, ir })), whole), `Blob of ${size} bytes`).toBe(true);
      }
    }
  });

  it('sends a small key packed by the ledger and a large one spliced in as a Blob, and both arrive whole', async () => {
    const preimage = await depositPreimage();
    const posts: { path: string; body: Uint8Array }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ path: new URL(String(input)).pathname, body: new Uint8Array(await new Response(init?.body).arrayBuffer()) });
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    const small = pattern(200_000, 1);
    const large = pattern(LARGE_KEY_BYTES + 5, 2);
    let blobAsked = 0;
    let released = 0;
    const keys = (proverKey: Uint8Array, asBlob: boolean) => ({
      getProverKey: async () => proverKey,
      getVerifierKey: async () => verifierKey,
      getZKIR: async () => ir,
      ...(asBlob ? { getProverKeyBlob: async () => { blobAsked++; return new Blob([proverKey as BlobPart]); } } : {}),
      release: () => { released++; },
    });

    expect(await proofServerProver('http://localhost:6300/', keys(small, false), { fetch: fetchFn }).prove(preimage, 'deposit', undefined)).toEqual(new Uint8Array([1, 2, 3]));
    expect(posts[0].path).toBe('/prove');
    expect(same(posts[0].body, createProvingPayload(preimage, undefined, { proverKey: small, verifierKey, ir }))).toBe(true);
    expect(released).toBe(1);

    await proofServerProver('http://localhost:6300', keys(large, true), { fetch: fetchFn }).prove(preimage, 'deposit', 5n);
    expect(blobAsked).toBe(1);
    expect(same(posts[1].body, createProvingPayload(preimage, 5n, { proverKey: large, verifierKey, ir }))).toBe(true);

    // Large, but only available as bytes (Node): still spliced, still identical.
    await proofServerProver('http://localhost:6300', keys(large, false), { fetch: fetchFn }).prove(preimage, 'deposit', undefined);
    expect(same(posts[2].body, createProvingPayload(preimage, undefined, { proverKey: large, verifierKey, ir }))).toBe(true);
  });

  it('says so when the proof server refuses or is not there', async () => {
    const preimage = await depositPreimage();
    const keys = { getProverKey: async () => pattern(10, 1), getVerifierKey: async () => verifierKey, getZKIR: async () => ir };
    const refusing = proofServerProver('http://localhost:6300', keys, { fetch: (async () => new Response('no', { status: 500, statusText: 'Internal Server Error' })) as typeof fetch });
    const refused = await refusing.prove(preimage, 'deposit').catch((e: unknown) => e);
    expect(String(refused)).toMatch(/the proof server answered 500 Internal Server Error/);
    expect(describeProblem(refused)).toMatchObject({ kind: 'proof-server', title: 'The proof could not be made' });
    const absent = proofServerProver('http://localhost:6300', keys, { fetch: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch });
    expect(describeProblem(await absent.check(preimage, 'deposit').catch((e: unknown) => e))).toMatchObject({ kind: 'proof-server' });
  });
});

describe('what can go wrong, in words a person can act on', () => {
  const connector = (code: string, reason: string) => Object.assign(new Error(reason), { type: 'DAppConnectorAPIError', code, reason });

  it('reads the wallet connector, the passkey and the proof server', () => {
    expect(describeProblem(connector('Rejected', 'User rejected'), { wallet: 'Lace' })).toMatchObject({ kind: 'rejected', retry: true });
    expect(describeProblem(connector('Rejected', 'x'), { wallet: 'Lace' }).body).toMatch(/Nothing was sent and nothing changed.*approve the request in Lace/);
    expect(describeProblem(connector('InsufficientFunds', 'not enough'))).toMatchObject({ kind: 'no-dust', title: 'Not enough DUST for the fee yet' });
    expect(describeProblem(new Error('balancing failed', { cause: new Error('could not balance dust') })).kind).toBe('no-dust');
    expect(describeProblem(connector('Disconnected', 'gone'), { wallet: 'Lace' })).toMatchObject({ kind: 'disconnected', title: 'Lace disconnected' });
    // What Lace 2.5.2 answers when the wallet behind a connection is locked or not loaded.
    const notReady = describeProblem(connector('InternalError', 'Wallet is unavailable'), { wallet: 'Lace' });
    expect(notReady).toMatchObject({ kind: 'disconnected', title: 'Lace is not ready', retry: true });
    expect(notReady.body).toMatch(/unlock it/);
    expect(describeProblem(Object.assign(new Error('The operation either timed out or was not allowed'), { name: 'NotAllowedError' }))).toMatchObject({ kind: 'rejected', title: 'The passkey was not used' });
    const down = describeProblem(new ProofServerDown('http://localhost:6300'));
    expect(down).toMatchObject({ kind: 'proof-server', title: 'Start your proof server', retry: true });
    expect(down.body).toMatch(/Nothing answered at http:\/\/localhost:6300/);
    expect(down.command).toMatch(/^docker run /);
    expect(describeProblem(new NoWallet()).link).toEqual({ label: 'Get Lace', href: 'https://www.lace.io/' });
    expect(describeProblem(new OldWallet('3.0.0')).body).toMatch(/\(3\.0\.0\)/);
    expect(describeProblem(new InputProblem('enter an amount above zero'))).toMatchObject({ kind: 'input', body: 'Enter an amount above zero.' });
  });

  it("shows the node's own reason when it refuses a transaction", () => {
    // The shape found on Preview on 26 Nov 2026: the reason is three causes deep.
    const refused = new Error('Transaction submission failed', {
      cause: Object.assign(new Error('SubmissionError'), { _tag: 'Wallet.Submission', cause: new Error('1010: Invalid Transaction: Transaction would exhaust the block limits') }),
    });
    expect(nodeReason(refused)).toBe('1010: Invalid Transaction: Transaction would exhaust the block limits');
    const p = describeProblem(refused, { network: 'preview' });
    expect(p).toMatchObject({ kind: 'refused', title: 'The network refused the transaction', detail: '1010: Invalid Transaction: Transaction would exhaust the block limits' });
    expect(p.body).toMatch(/a Preview node turned it down, so nothing changed/);
    expect(describeProblem(new Error('x', { cause: new Error('Custom error: 110') })).detail).toBe('Custom error: 110');
    expect(nodeReason(new Error('just slow'))).toBeUndefined();
  });

  it("finds the vault's own refusal under Midnight.js's wrapping, and never shows a provider token", () => {
    const wrapped = new Error('Unexpected error executing circuit', { cause: new Error('failed assert: owner is still alive') });
    expect(describeProblem(wrapped)).toMatchObject({ kind: 'contract', detail: 'owner is still alive' });
    const leaky = new Error('request to https://x.blockfrost.io/api/v0?project_id=nightpreprodSECRET123 failed: fetch failed');
    expect(errorChain(leaky).join(' ')).not.toContain('SECRET123');
    expect(describeProblem(leaky, { network: 'preprod' })).toMatchObject({ kind: 'network', title: 'Could not reach Preprod' });
    expect(describeProblem(leaky).detail).toContain('project_id=<hidden>');
    expect(describeProblem('who knows')).toMatchObject({ kind: 'unknown', retry: true });
  });

  it('says what a wallet still needs, in the order a new person meets it', () => {
    const none = walletReadiness({ night: 0n, dust: 0n }, 'deployment', { network: 'preview', wallet: 'Lace', address: 'mn_addr_preview1xyz' });
    expect(none).toMatchObject({ kind: 'no-night', link: { label: 'Open the Preview faucet', href: 'https://faucet.preview.midnight.network/' }, detail: 'mn_addr_preview1xyz' });
    expect(walletReadiness({ night: 0n, dust: 0n }, 'call', { network: 'preprod' })?.link?.href).toBe('https://midnight-tmnight-preprod.nethermind.dev/');
    const noDust = walletReadiness({ night: 5000n * STAR_PER_NIGHT, dust: 0n }, 'deployment', { network: 'preview' });
    expect(noDust).toMatchObject({ kind: 'no-dust' });
    expect(noDust?.body).toMatch(/Generate tDUST.*about 30 DUST in all/);
    const low = walletReadiness({ night: 5000n * STAR_PER_NIGHT, dust: 12n * SPECK_PER_DUST }, 'deployment');
    expect(low).toMatchObject({ kind: 'low-dust' });
    expect(low?.body).toMatch(/holds 12 DUST.*eight transactions.*about 30 DUST/);
    expect(walletReadiness({ night: 5000n * STAR_PER_NIGHT, dust: 12n * SPECK_PER_DUST }, 'call')).toBeUndefined();
    expect(walletReadiness({ night: 5000n * STAR_PER_NIGHT, dust: 31n * SPECK_PER_DUST }, 'deployment')).toBeUndefined();
    // Tokens spent down to nothing, but DUST still there: fees can be paid.
    expect(walletReadiness({ night: 0n, dust: 2n * SPECK_PER_DUST }, 'call')).toBeUndefined();
  });
});
