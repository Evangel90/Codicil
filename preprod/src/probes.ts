// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Read-only probes of the three services a run needs: the proof server, the
// indexer and the node. Plain `fetch`, no SDK, so a failure here is about the
// service and not about our wiring.

import { EXPECTED_PROOF_SERVER_VERSION, LEDGER9_PROTOCOL_VERSION, redact, type NetworkConfig } from './env.js';

export interface Probe<T> {
  ok: boolean;
  /** One line for the terminal. Already redacted. */
  detail: string;
  value?: T;
  warnings: string[];
}

export type Fetch = typeof fetch;

/** Turn a failed `fetch` into words. Node reports the reason on `cause`. */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
  if (cause?.code === 'ECONNREFUSED') return 'connection refused (nothing is listening)';
  if (cause?.code === 'ENOTFOUND') return 'host not found (no network?)';
  if (cause?.code) return `${cause.code}${cause.message ? `: ${cause.message}` : ''}`;
  return cause?.message ?? error.message;
}

async function getText(f: Fetch, url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: (await res.text()).trim() };
}

async function postJson(f: Fetch, url: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: unknown; text: string; date: string | null }> {
  const res = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text, date: res.headers.get('date') };
}

// ─── Proof server ───────────────────────────────────────────────────────────

export interface ProofServerInfo {
  version: string;
  status?: string;
  jobsProcessing?: number;
  jobsPending?: number;
  jobCapacity?: number;
}

export const PROOF_SERVER_START =
  `docker run -d --name proof-server -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:${EXPECTED_PROOF_SERVER_VERSION}`;

export async function probeProofServer(url: string, f: Fetch = fetch, timeoutMs = 5000): Promise<Probe<ProofServerInfo>> {
  const warnings: string[] = [];
  let version: string;
  try {
    const res = await getText(f, `${url}/version`, timeoutMs);
    if (res.status !== 200) return { ok: false, warnings, detail: `proof server at ${url} answered HTTP ${res.status} to /version` };
    version = res.body;
  } catch (e) {
    return {
      ok: false,
      warnings,
      detail: `proof server not reachable at ${url}: ${describeFetchError(e)}. Start Docker, then run: ${PROOF_SERVER_START}`,
    };
  }
  if (version !== EXPECTED_PROOF_SERVER_VERSION) {
    warnings.push(`proof server is ${version}; the compatibility matrix lists ${EXPECTED_PROOF_SERVER_VERSION} for ledger 9`);
  }
  const info: ProofServerInfo = { version };
  try {
    const res = await getText(f, `${url}/ready`, timeoutMs);
    const ready = JSON.parse(res.body) as Partial<ProofServerInfo>;
    Object.assign(info, { status: ready.status, jobsProcessing: ready.jobsProcessing, jobsPending: ready.jobsPending, jobCapacity: ready.jobCapacity });
    if (res.status !== 200) warnings.push(`proof server /ready answered HTTP ${res.status} (${ready.status ?? 'unknown'})`);
  } catch (e) {
    warnings.push(`proof server /ready could not be read: ${describeFetchError(e)}`);
  }
  const queue = info.status === undefined ? '' : `, ${info.status}, ${info.jobsProcessing ?? '?'} proving, ${info.jobsPending ?? '?'} waiting`;
  return { ok: true, warnings, value: info, detail: `proof server ${version} at ${url}${queue}` };
}

// ─── Indexer ────────────────────────────────────────────────────────────────

export interface IndexerBlock {
  height: number;
  hash: string;
  /** Unix seconds. */
  timestamp: number;
  protocolVersion: number;
  /** How far the block's timestamp is behind this machine's clock, in seconds. */
  ageS: number;
}

const BLOCK_QUERY = '{ block { height hash timestamp protocolVersion } }';

/** The indexer's latest block. It serves finalized blocks only, so it trails the node by a few. */
export async function latestBlock(indexerHttp: string, f: Fetch = fetch, timeoutMs = 15_000): Promise<IndexerBlock> {
  const res = await postJson(f, indexerHttp, { query: BLOCK_QUERY }, timeoutMs);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  const body = res.json as { data?: { block?: { height: number; hash: string; timestamp: number; protocolVersion: number } | null }; errors?: { message: string }[] };
  if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  const b = body?.data?.block;
  if (!b) throw new Error('the indexer returned no block');
  // The indexer reports milliseconds; accept seconds too.
  const ts = b.timestamp > 1e12 ? Math.floor(b.timestamp / 1000) : b.timestamp;
  return { height: b.height, hash: b.hash, timestamp: ts, protocolVersion: b.protocolVersion, ageS: Math.floor(Date.now() / 1000) - ts };
}

export async function probeIndexer(cfg: Pick<NetworkConfig, 'indexerHttp' | 'secrets'>, f: Fetch = fetch): Promise<Probe<IndexerBlock>> {
  const warnings: string[] = [];
  try {
    const b = await latestBlock(cfg.indexerHttp, f);
    if (b.protocolVersion < LEDGER9_PROTOCOL_VERSION) {
      warnings.push(`indexer reports protocol version ${b.protocolVersion}; ledger 9 networks report ${LEDGER9_PROTOCOL_VERSION} or later`);
    }
    if (b.ageS > 120) warnings.push(`the indexer's latest block is ${b.ageS} s old; it may be lagging, or this machine's clock is ahead`);
    if (b.ageS < -5) warnings.push(`the indexer's latest block is ${-b.ageS} s in the future: this machine's clock is behind`);
    return {
      ok: true,
      warnings,
      value: b,
      detail: `indexer at block ${b.height} (${b.ageS} s old, protocol version ${b.protocolVersion})`,
    };
  } catch (e) {
    const why = redact(describeFetchError(e), cfg.secrets);
    const hint = /403/.test(why) ? ' (403 means a missing or wrong Blockfrost token)' : '';
    return { ok: false, warnings, detail: `indexer not usable at ${redact(cfg.indexerHttp)}: ${why}${hint}` };
  }
}

// ─── Node ───────────────────────────────────────────────────────────────────

export interface NodeInfo {
  chain: string;
  version: string;
  peers?: number;
  isSyncing?: boolean;
  /** Height of the node's best block. */
  height?: number;
  ledgerVersion?: string;
  /** This machine's clock minus the server's HTTP `Date`, in seconds. */
  clockSkewS?: number;
}

async function rpc(f: Fetch, url: string, method: string, timeoutMs = 15_000): Promise<{ result: unknown; date: string | null }> {
  const res = await postJson(f, url, { jsonrpc: '2.0', id: 1, method, params: [] }, timeoutMs);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  const body = res.json as { result?: unknown; error?: { message: string } };
  if (body?.error) throw new Error(`${method}: ${body.error.message}`);
  return { result: body?.result, date: res.date };
}

export async function probeNode(cfg: Pick<NetworkConfig, 'nodeHttp' | 'chainName' | 'secrets'>, f: Fetch = fetch): Promise<Probe<NodeInfo>> {
  const warnings: string[] = [];
  try {
    const before = Date.now();
    const chain = await rpc(f, cfg.nodeHttp, 'system_chain');
    const after = Date.now();
    const info: NodeInfo = { chain: String(chain.result), version: '?' };
    if (chain.date) {
      const server = Date.parse(chain.date);
      // The Date header has one-second resolution, so only a skew of several seconds means anything.
      if (!Number.isNaN(server)) info.clockSkewS = Math.round(((before + after) / 2 - server) / 1000);
    }
    info.version = String((await rpc(f, cfg.nodeHttp, 'system_version')).result);
    try {
      const health = (await rpc(f, cfg.nodeHttp, 'system_health')).result as { peers?: number; isSyncing?: boolean };
      info.peers = health.peers;
      info.isSyncing = health.isSyncing;
      const header = (await rpc(f, cfg.nodeHttp, 'chain_getHeader')).result as { number?: string };
      if (header?.number) info.height = parseInt(header.number, 16);
      info.ledgerVersion = String((await rpc(f, cfg.nodeHttp, 'midnight_ledgerVersion')).result);
    } catch (e) {
      warnings.push(`node answered system_chain but not every query: ${redact(describeFetchError(e), cfg.secrets)}`);
    }
    if (cfg.chainName && info.chain !== cfg.chainName) {
      return { ok: false, warnings, value: info, detail: `node at ${redact(cfg.nodeHttp)} is "${info.chain}", expected "${cfg.chainName}"` };
    }
    if (info.isSyncing) warnings.push('the node reports it is still syncing');
    if (info.clockSkewS !== undefined && Math.abs(info.clockSkewS) > 5) {
      warnings.push(
        `this machine's clock is ${Math.abs(info.clockSkewS)} s ${info.clockSkewS > 0 ? 'ahead of' : 'behind'} the node's. `
        + 'Deadline checks and DUST registration use the local clock; fix the clock before running',
      );
    }
    return {
      ok: true,
      warnings,
      value: info,
      detail: `node "${info.chain}" ${info.version}`
        + (info.height !== undefined ? `, best block ${info.height}` : '')
        + (info.peers !== undefined ? `, ${info.peers} peers` : '')
        + (info.ledgerVersion ? `, ledger ${info.ledgerVersion}` : ''),
    };
  } catch (e) {
    const why = redact(describeFetchError(e), cfg.secrets);
    const hint = /403/.test(why) ? ' (403 means a missing or wrong Blockfrost token)' : '';
    return { ok: false, warnings, detail: `node not usable at ${redact(cfg.nodeHttp)}: ${why}${hint}` };
  }
}
