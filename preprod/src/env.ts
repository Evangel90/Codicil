// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Environment and network selection for gate V14. Everything here is pure:
// it reads strings and returns values, so it is unit-tested without a network.
//
// Endpoints come from docs.midnight.network/guides/networks-and-environments
// (read 2026-11-25). Preprod is served by Blockfrost and every URL carries a
// project token; Preview is Midnight-hosted and needs none.

export type NetworkName = 'preprod' | 'preview' | 'undeployed';

export const NETWORK_NAMES: readonly NetworkName[] = ['preprod', 'preview', 'undeployed'];

/** Variables this workspace reads, from `.env` at the repo root or the process environment. */
export const ENV_KEYS = {
  network: 'MIDNIGHT_NETWORK',
  seed: 'WALLET_SEED',
  blockfrost: 'BLOCKFROST_PROJECT_ID',
  proofServer: 'PROOF_SERVER_URL',
  nodeUrl: 'MIDNIGHT_NODE_URL',
  indexerUrl: 'MIDNIGHT_INDEXER_URL',
  indexerWsUrl: 'MIDNIGHT_INDEXER_WS_URL',
} as const;

export type Env = Readonly<Record<string, string | undefined>>;

export interface NetworkConfig {
  name: NetworkName;
  /** The id Midnight.js and the wallet SDK build transactions and addresses for. */
  networkId: string;
  /** What `system_chain` answers on this network's node. */
  chainName: string | undefined;
  nodeHttp: string;
  nodeWs: string;
  indexerHttp: string;
  indexerWs: string;
  proofServer: string;
  faucet: string | undefined;
  /** Prefix of an unshielded address on this network. */
  addressPrefix: string;
  /** Values that must never reach a log, a state file or a results file. */
  secrets: readonly string[];
}

export type Resolved<T> = { ok: true; value: T; warnings: string[] } | { ok: false; problems: string[] };

export const DEFAULT_PROOF_SERVER = 'http://localhost:6300';
/** The image tag the compatibility matrix lists for ledger 9 (Preview, Preprod, Mainnet). */
export const EXPECTED_PROOF_SERVER_VERSION = '9.0.2';
/** Ledger 9 networks report protocol version 2000000 or later. */
export const LEDGER9_PROTOCOL_VERSION = 2_000_000;

/**
 * Parse `.env` text: `KEY=value` lines, `#` comments, optional quotes and an
 * optional `export ` prefix. No interpolation and no multi-line values.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    out[m[1]] = value;
  }
  return out;
}

/** `.env` values, overridden by the process environment. Empty strings count as unset. */
export function mergeEnv(dotEnv: Record<string, string>, processEnv: Env): Env {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(dotEnv)) if (v !== '') out[k] = v;
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

/**
 * Set `key` in `.env` text, keeping every other line. Used by `init` to add a
 * seed without disturbing what the human already wrote.
 */
export function upsertDotEnv(text: string, key: string, value: string): string {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l));
  if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  return lines.join('\n') + '\n';
}

export function parseNetworkName(value: string | undefined): NetworkName | undefined {
  const v = (value ?? 'preprod').trim().toLowerCase();
  if (v === 'local' || v === 'standalone') return 'undeployed';
  return (NETWORK_NAMES as readonly string[]).includes(v) ? (v as NetworkName) : undefined;
}

/** A wallet seed is 32 bytes, written as 64 hex characters. */
export function seedProblem(seed: string | undefined): string | undefined {
  if (seed === undefined) return `${ENV_KEYS.seed} is not set (run \`npm run preprod:init\`)`;
  if (!/^[0-9a-fA-F]{64}$/.test(seed)) return `${ENV_KEYS.seed} must be 64 hex characters (32 bytes)`;
  return undefined;
}

const withToken = (url: string, token: string): string =>
  `${url}${url.includes('?') ? '&' : '?'}project_id=${encodeURIComponent(token)}`;

const toWs = (url: string): string => url.replace(/^http/, 'ws');

function checkUrl(name: string, value: string, schemes: readonly string[], problems: string[]): void {
  try {
    const u = new URL(value);
    if (!schemes.includes(u.protocol)) problems.push(`${name} must start with ${schemes.map((s) => `${s}//`).join(' or ')}`);
  } catch {
    problems.push(`${name} is not a valid URL`);
  }
}

/**
 * Work out every endpoint for the selected network, or say exactly what is
 * missing. Built when it is used, not at import time, so a missing token is a
 * clear message here rather than a 403 deep inside a wallet sync.
 */
export function resolveNetwork(env: Env): Resolved<NetworkConfig> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const name = parseNetworkName(env[ENV_KEYS.network]);
  if (!name) {
    return { ok: false, problems: [`${ENV_KEYS.network}="${env[ENV_KEYS.network]}" is not one of ${NETWORK_NAMES.join(', ')}`] };
  }
  const proofServer = env[ENV_KEYS.proofServer]?.trim() || DEFAULT_PROOF_SERVER;
  checkUrl(ENV_KEYS.proofServer, proofServer, ['http:', 'https:'], problems);

  const secrets: string[] = [];
  let base: Pick<NetworkConfig, 'nodeHttp' | 'nodeWs' | 'indexerHttp' | 'indexerWs' | 'faucet' | 'chainName'>;
  if (name === 'preprod') {
    const token = env[ENV_KEYS.blockfrost]?.trim();
    const custom = env[ENV_KEYS.nodeUrl] && env[ENV_KEYS.indexerUrl];
    if (!token && !custom) {
      problems.push(
        `${ENV_KEYS.blockfrost} is not set. Preprod's node and indexer are served by Blockfrost and reject requests `
        + `without a project token (create a "Midnight Preprod" project at https://blockfrost.io). `
        + `Or set ${ENV_KEYS.network}=preview, which needs no token.`,
      );
    }
    if (token) {
      secrets.push(token);
      if (token.startsWith('nightmainnet')) {
        problems.push(`${ENV_KEYS.blockfrost} is a Midnight Mainnet project id; Preprod needs one that starts with "nightpreprod"`);
      } else if (!token.startsWith('nightpreprod')) {
        warnings.push(`${ENV_KEYS.blockfrost} does not start with "nightpreprod"; Blockfrost answers 403 to a token for another network`);
      }
    }
    const t = token ?? '';
    base = {
      chainName: 'Midnight Preprod',
      nodeHttp: withToken('https://rpc.midnight-preprod.blockfrost.io', t),
      nodeWs: withToken('wss://rpc.midnight-preprod.blockfrost.io', t),
      indexerHttp: withToken('https://midnight-preprod.blockfrost.io/api/v0', t),
      indexerWs: withToken('wss://midnight-preprod.blockfrost.io/api/v0/ws', t),
      faucet: 'https://midnight-tmnight-preprod.nethermind.dev/',
    };
  } else if (name === 'preview') {
    base = {
      chainName: 'Midnight Preview',
      nodeHttp: 'https://rpc.preview.midnight.network',
      nodeWs: 'wss://rpc.preview.midnight.network',
      indexerHttp: 'https://indexer.preview.midnight.network/api/v4/graphql',
      indexerWs: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
      faucet: 'https://faucet.preview.midnight.network/',
    };
  } else {
    base = {
      chainName: undefined,
      nodeHttp: 'http://localhost:9944',
      nodeWs: 'ws://localhost:9944',
      indexerHttp: 'http://localhost:8088/api/v4/graphql',
      indexerWs: 'ws://localhost:8088/api/v4/graphql/ws',
      faucet: undefined,
    };
  }

  // Optional overrides, for a self-hosted node and indexer.
  const nodeHttp = env[ENV_KEYS.nodeUrl]?.trim() || base.nodeHttp;
  const indexerHttp = env[ENV_KEYS.indexerUrl]?.trim() || base.indexerHttp;
  const overriddenWs = env[ENV_KEYS.indexerWsUrl]?.trim();
  const indexerWs = overriddenWs || (env[ENV_KEYS.indexerUrl] ? `${toWs(indexerHttp)}/ws` : base.indexerWs);
  const nodeWs = env[ENV_KEYS.nodeUrl] ? toWs(nodeHttp) : base.nodeWs;
  checkUrl(ENV_KEYS.nodeUrl, nodeHttp, ['http:', 'https:'], problems);
  checkUrl(ENV_KEYS.indexerUrl, indexerHttp, ['http:', 'https:'], problems);
  checkUrl(ENV_KEYS.indexerWsUrl, indexerWs, ['ws:', 'wss:'], problems);

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    warnings,
    value: {
      name,
      networkId: name,
      chainName: base.chainName,
      nodeHttp,
      nodeWs,
      indexerHttp,
      indexerWs,
      proofServer: proofServer.replace(/\/$/, ''),
      faucet: base.faucet,
      addressPrefix: `mn_addr_${name}1`,
      secrets,
    },
  };
}

/**
 * Remove secrets from text bound for a terminal or a file. Library errors
 * include the full request URL, token and all, so every message goes through
 * here before it is shown or stored.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  // Stops at punctuation that can follow a URL in a sentence, and never re-matches its own output.
  let out = text.replace(/(project_id=)[^&\s"'`)<>:,;]+/gi, '$1<redacted>');
  for (const s of secrets) {
    if (s.length < 8) continue;
    out = out.split(s).join('<redacted>');
    const encoded = encodeURIComponent(s);
    if (encoded !== s) out = out.split(encoded).join('<redacted>');
  }
  return out;
}

/** A URL safe to print: no query string values. */
export function displayUrl(url: string): string {
  return redact(url);
}
