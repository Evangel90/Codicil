// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The preflight, driven with a fake `fetch` and artifact folders built in a
// temp directory. No network.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonIrToBinary } from '@midnightntwrk/zkir-v3';
import { checkArtifacts, circuitK, estimateProofMemoryGiB, estimateProofSeconds } from '../src/artifacts.js';
import { formatLine, formatMissing, preflight } from '../src/check.js';
import { VAULT_DIR } from '../src/paths.js';
import { describeFetchError, latestBlock, probeNode, probeProofServer, type Fetch } from '../src/probes.js';

const TOKEN = 'nightpreprodSECRETSECRET123';
const SEED = '0f'.repeat(32);

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A compiled-contract folder with real (tiny) ZKIR and fake keys, as `compile:full` lays it out. */
function fakeContract(circuits: string[], opts: { keys?: boolean; manifestKeys?: boolean; runtime?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'codicil-artifacts-'));
  dirs.push(dir);
  for (const sub of ['compiler', 'keys', 'zkir']) mkdirSync(join(dir, sub));
  // The smallest real circuit this repo compiles; `npm run compile` writes its .zkir text.
  const bzkir = jsonIrToBinary(readFileSync(join(VAULT_DIR, 'zkir', 'triggerTimeout.zkir'), 'utf8'));
  const manifest: Record<string, Record<string, unknown>> = { keys: { type: 'directory' }, zkir: { type: 'directory' } };
  for (const c of circuits) {
    writeFileSync(join(dir, 'zkir', `${c}.bzkir`), bzkir);
    manifest.zkir[`${c}.bzkir`] = { type: 'file', size: bzkir.length, hash: 'x' };
    if (opts.keys !== false) {
      writeFileSync(join(dir, 'keys', `${c}.prover`), new Uint8Array(100));
      writeFileSync(join(dir, 'keys', `${c}.verifier`), new Uint8Array(10));
      if (opts.manifestKeys !== false) {
        manifest.keys[`${c}.prover`] = { type: 'file', size: 100, hash: 'x' };
        manifest.keys[`${c}.verifier`] = { type: 'file', size: 10, hash: 'x' };
      }
    }
  }
  writeFileSync(join(dir, 'compiler', 'contract-info.json'), JSON.stringify({
    'compiler-version': '0.36.1',
    'runtime-version': opts.runtime ?? '0.21.0',
    circuits: [{ name: 'somePureHelper', pure: true, proof: false }, ...circuits.map((name) => ({ name, pure: false, proof: true }))],
  }));
  writeFileSync(join(dir, 'compiler', 'contract-manifest.json'), JSON.stringify(manifest));
  return dir;
}

const VAULT_CIRCUITS = ['deposit', 'checkInPasskey', 'checkInEd25519', 'triggerTimeout', 'finalizeRelease', 'claim', 'isReleasedForContract'];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const refused = (): never => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:6300' } });
};

/** A network where everything answers; override pieces per test. */
function fakeNetwork(over: { proof?: () => Response; block?: () => Response; chain?: string } = {}): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    if (url.includes(':6300')) {
      if (over.proof) return over.proof();
      if (url.endsWith('/version')) return new Response('9.0.2');
      return json({ status: 'ok', jobsProcessing: 0, jobsPending: 0, jobCapacity: 10 });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string; method?: string };
    if (body.query) {
      return over.block ? over.block() : json({ data: { block: { height: 3_400_000, hash: 'ab'.repeat(32), timestamp: Date.now() - 18_000, protocolVersion: 2_001_100 } } });
    }
    const result = {
      system_chain: over.chain ?? 'Midnight Preprod',
      system_version: '2.1.101-abc',
      system_health: { peers: 9, isSyncing: false, shouldHavePeers: true },
      chain_getHeader: { number: '0x33e143' },
      midnight_ledgerVersion: '1.0.1',
    }[body.method ?? ''];
    return json({ jsonrpc: '2.0', id: 1, result }, 200, { date: new Date().toUTCString() });
  }) as Fetch;
  return { fetch: f, urls };
}

describe('preflight', () => {
  it('passes when everything is there, and never shows the token', async () => {
    const net = fakeNetwork();
    const pre = await preflight({
      env: { BLOCKFROST_PROJECT_ID: TOKEN, WALLET_SEED: SEED },
      vaultDir: fakeContract(VAULT_CIRCUITS),
      escrowDir: fakeContract(['deposit', 'withdrawToBeneficiary']),
      escrow: true,
      fetch: net.fetch,
    });
    expect(pre.missing).toEqual([]);
    expect(pre.lines.filter((l) => l.level === 'fail')).toEqual([]);
    expect(pre.proofServer?.version).toBe('9.0.2');
    expect(pre.indexer?.height).toBe(3_400_000);
    expect(pre.node?.height).toBe(0x33e143);
    expect(pre.maxK).toBeGreaterThan(0);
    const printed = pre.lines.map(formatLine).join('\n');
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain(SEED);
    // The token did go where it must: on the requests to Blockfrost.
    expect(net.urls.some((u) => u.includes(`project_id=${TOKEN}`))).toBe(true);
  });

  it('checks the seal register only when asked, and with it the vault circuit it calls', async () => {
    const net = fakeNetwork();
    const base = { env: { BLOCKFROST_PROJECT_ID: TOKEN, WALLET_SEED: SEED }, escrowDir: fakeContract([]), escrow: false, fetch: net.fetch };
    const ready = await preflight({ ...base, vaultDir: fakeContract(VAULT_CIRCUITS), sealsDir: fakeContract(['seal', 'unseal', 'handOver', 'state']), seals: true });
    expect(ready.missing).toEqual([]);
    expect(ready.artifacts.map((a) => a.contract)).toEqual(['codicil_vault', 'codicil_seals']);
    expect(ready.lines.map(formatLine).join('\n')).toMatch(/codicil_seals: 4 verifier keys, 2 prover keys/);

    // The register's keys are missing: said once, by name.
    const noKeys = await preflight({ ...base, vaultDir: fakeContract(VAULT_CIRCUITS), sealsDir: fakeContract(['seal', 'unseal', 'handOver', 'state'], { keys: false }), seals: true });
    expect(noKeys.missing.join(' ')).toMatch(/codicil_seals has no proving keys/);

    // A vault built without the hook the register calls is not enough.
    const noHook = await preflight({ ...base, vaultDir: fakeContract(VAULT_CIRCUITS.filter((c) => c !== 'isReleasedForContract')), sealsDir: fakeContract(['seal', 'handOver']), seals: true });
    expect(noHook.missing.join(' ')).toMatch(/codicil_vault has no circuit "isReleasedForContract"/);

    // Not asked for: the register is not looked at, even when its directory is given.
    const off = await preflight({ ...base, vaultDir: fakeContract(VAULT_CIRCUITS.filter((c) => c !== 'isReleasedForContract')), sealsDir: '/nowhere' });
    expect(off.missing).toEqual([]);
    expect(off.artifacts.map((a) => a.contract)).toEqual(['codicil_vault']);
  });

  it('says exactly what is missing on a fresh checkout', async () => {
    const pre = await preflight({
      env: {},
      vaultDir: fakeContract(VAULT_CIRCUITS, { keys: false }),
      escrowDir: fakeContract(['deposit']),
      escrow: false,
      fetch: fakeNetwork({ proof: refused }).fetch,
    });
    const text = formatMissing(pre.missing);
    expect(pre.missing).toHaveLength(4);
    expect(text).toMatch(/1\. BLOCKFROST_PROJECT_ID is not set/);
    expect(text).toMatch(/2\. WALLET_SEED is not set \(run `npm run preprod:init`\)/);
    expect(text).toMatch(/3\. proof server not reachable at http:\/\/localhost:6300: connection refused.*docker run -d --name proof-server -p 127\.0\.0\.1:6300:6300 midnightntwrk\/proof-server:9\.0\.2/);
    expect(text).toMatch(/4\. codicil_vault has no proving keys: run `npm run compile:full`/);
    expect(pre.lines.some((l) => l.level === 'skip' && /indexer and node not checked/.test(l.text))).toBe(true);
  });

  it('checks the indexer and node on preview with no token', async () => {
    const net = fakeNetwork({ chain: 'Midnight Preview' });
    const pre = await preflight({
      env: { MIDNIGHT_NETWORK: 'preview', WALLET_SEED: SEED },
      vaultDir: fakeContract(VAULT_CIRCUITS),
      escrowDir: fakeContract([]),
      escrow: false,
      fetch: net.fetch,
    });
    expect(pre.missing).toEqual([]);
    expect(net.urls).toContain('https://indexer.preview.midnight.network/api/v4/graphql');
    expect(net.urls).toContain('http://localhost:6300/version');
    expect(net.urls.every((u) => !u.includes('project_id'))).toBe(true);
  });

  it('fails when the node is a different chain than the one selected', async () => {
    const pre = await preflight({
      env: { MIDNIGHT_NETWORK: 'preview', WALLET_SEED: SEED },
      vaultDir: fakeContract(VAULT_CIRCUITS),
      escrowDir: fakeContract([]),
      escrow: false,
      fetch: fakeNetwork({ chain: 'Midnight Preprod' }).fetch,
    });
    expect(pre.missing.join(' ')).toMatch(/is "Midnight Preprod", expected "Midnight Preview"/);
  });

  it('reports a rejected Blockfrost token without echoing it', async () => {
    const pre = await preflight({
      env: { BLOCKFROST_PROJECT_ID: TOKEN, WALLET_SEED: SEED },
      vaultDir: fakeContract(VAULT_CIRCUITS),
      escrowDir: fakeContract([]),
      escrow: false,
      fetch: fakeNetwork({ block: () => json({ error: 'Forbidden', message: `Invalid project token. ${TOKEN}`, status_code: 403 }, 403) }).fetch,
    });
    const text = pre.missing.join('\n');
    expect(text).toMatch(/indexer not usable.*HTTP 403.*missing or wrong Blockfrost token/);
    expect(text).not.toContain(TOKEN);
  });
});

describe('artifacts', () => {
  it('accepts a full compile', () => {
    const r = checkArtifacts('vault', fakeContract(['deposit', 'claim']), ['deposit']);
    expect(r).toMatchObject({ ok: true, missing: [], problems: [], compilerVersion: '0.36.1', runtimeVersion: '0.21.0', circuits: ['deposit', 'claim'] });
    expect(r.proverKeyBytes).toEqual({ deposit: 100 });
  });

  it('needs a verifier key for every circuit, not only the ones it proves', () => {
    const dir = fakeContract(['deposit', 'claim']);
    rmSync(join(dir, 'keys', 'claim.verifier'));
    const r = checkArtifacts('vault', dir, ['deposit']);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['keys/claim.verifier']);
  });

  it('tells a --skip-zk compile from a full one', () => {
    const r = checkArtifacts('vault', fakeContract(['deposit'], { keys: false }), ['deposit']);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/no proving keys: run `npm run compile:full`/);
  });

  it('notices keys left on disk after a --skip-zk recompile rewrote the manifest', () => {
    const r = checkArtifacts('vault', fakeContract(['deposit'], { manifestKeys: false }), ['deposit']);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/on disk but not in contract-manifest\.json/);
  });

  it('notices a key that changed size, a wrong runtime and an unknown circuit', () => {
    const dir = fakeContract(['deposit']);
    writeFileSync(join(dir, 'keys', 'deposit.prover'), new Uint8Array(7));
    expect(checkArtifacts('vault', dir, ['deposit']).problems.join(' ')).toMatch(/is 7 bytes but the manifest says 100/);
    expect(checkArtifacts('vault', fakeContract(['deposit'], { runtime: '0.16.0' }), ['deposit']).problems.join(' ')).toMatch(/compact-runtime 0\.16\.0, expected 0\.21\.0/);
    expect(checkArtifacts('vault', fakeContract(['deposit']), ['withdraw']).problems.join(' ')).toMatch(/no circuit "withdraw"/);
  });

  it('says so when the contract is not compiled at all', () => {
    const empty = mkdtempSync(join(tmpdir(), 'codicil-artifacts-'));
    dirs.push(empty);
    expect(checkArtifacts('vault', empty, ['deposit']).problems.join(' ')).toMatch(/is not compiled/);
  });

  it('reads the circuit size from the binary ZKIR and scales the estimates from it', () => {
    const k = circuitK(fakeContract(['deposit']), 'deposit');
    expect(k).toBeGreaterThanOrEqual(5);
    expect(k).toBeLessThanOrEqual(12);
    expect(estimateProofMemoryGiB(18)).toBe(5);
    expect(estimateProofMemoryGiB(17)).toBe(2.5);
    expect(estimateProofSeconds(18)).toBe(17);
    expect(estimateProofSeconds(16)).toBe(4.3);
  });
});

describe('probes', () => {
  it('explains a refused connection and gives the command that fixes it', async () => {
    const p = await probeProofServer('http://localhost:6300', (async () => refused()) as Fetch);
    expect(p.ok).toBe(false);
    expect(p.detail).toMatch(/connection refused \(nothing is listening\)\. Start Docker, then run: docker run/);
  });

  it('warns about a proof server of another version', async () => {
    const f = (async (url: RequestInfo | URL) => (String(url).endsWith('/version') ? new Response('8.1.3\n') : json({ status: 'ok', jobsProcessing: 0, jobsPending: 0 }))) as Fetch;
    const p = await probeProofServer('http://localhost:6300', f);
    expect(p.ok).toBe(true);
    expect(p.warnings.join(' ')).toMatch(/proof server is 8\.1\.3; the compatibility matrix lists 9\.0\.2/);
  });

  it('reads the latest block, converting milliseconds to seconds', async () => {
    const ms = 1_795_636_932_000;
    const b = await latestBlock('https://indexer.example/graphql', (async () => json({ data: { block: { height: 7, hash: 'h', timestamp: ms, protocolVersion: 2_001_100 } } })) as Fetch);
    expect(b).toMatchObject({ height: 7, timestamp: 1_795_636_932, protocolVersion: 2_001_100 });
    await expect(latestBlock('https://indexer.example/graphql', (async () => json({ data: { block: null } })) as Fetch)).rejects.toThrow(/no block/);
    await expect(latestBlock('https://indexer.example/graphql', (async () => json({ errors: [{ message: 'boom' }] })) as Fetch)).rejects.toThrow(/boom/);
  });

  it('warns when this machine\'s clock is far from the node\'s', async () => {
    const skewed = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      const result = { system_chain: 'Midnight Preview', system_version: 'v', system_health: {}, chain_getHeader: { number: '0x1' }, midnight_ledgerVersion: '1' }[method];
      return json({ result }, 200, { date: new Date(Date.now() + 90_000).toUTCString() });
    }) as Fetch;
    const p = await probeNode({ nodeHttp: 'https://rpc.example', chainName: 'Midnight Preview', secrets: [] }, skewed);
    expect(p.ok).toBe(true);
    expect(p.warnings.join(' ')).toMatch(/clock is \d+ s behind the node's/);
  });

  it('puts fetch failures into words', () => {
    expect(describeFetchError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timed out');
    expect(describeFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toMatch(/host not found/);
    expect(describeFetchError(new Error('HTTP 403: nope'))).toBe('HTTP 403: nope');
  });
});
