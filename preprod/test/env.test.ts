// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROOF_SERVER,
  mergeEnv,
  parseDotEnv,
  parseNetworkName,
  redact,
  resolveNetwork,
  seedProblem,
  upsertDotEnv,
} from '../src/env.js';

const TOKEN = 'nightpreprodAbCdEf0123456789';

describe('.env parsing', () => {
  it('reads keys, skips comments and blanks, strips quotes and trailing comments', () => {
    const env = parseDotEnv([
      '# a comment',
      '',
      'MIDNIGHT_NETWORK=preview',
      'export WALLET_SEED = "abc"',
      "PROOF_SERVER_URL='http://localhost:6300'",
      'CODICIL_CHALLENGE_S=120   # two minutes',
      'not a line',
      'EMPTY=',
    ].join('\n'));
    expect(env).toEqual({
      MIDNIGHT_NETWORK: 'preview',
      WALLET_SEED: 'abc',
      PROOF_SERVER_URL: 'http://localhost:6300',
      CODICIL_CHALLENGE_S: '120',
      EMPTY: '',
    });
  });

  it('lets the process environment override the file, and treats empty values as unset', () => {
    const env = mergeEnv({ A: 'file', B: 'file', C: '' }, { B: 'process', D: '', E: undefined });
    expect(env).toEqual({ A: 'file', B: 'process' });
  });

  it('adds a key without touching other lines, and replaces an existing one in place', () => {
    const text = '# mine\nBLOCKFROST_PROJECT_ID=x\nWALLET_SEED=\n';
    expect(upsertDotEnv(text, 'WALLET_SEED', 'ff')).toBe('# mine\nBLOCKFROST_PROJECT_ID=x\nWALLET_SEED=ff\n');
    expect(upsertDotEnv('# mine\nA=1', 'WALLET_SEED', 'ff')).toBe('# mine\nA=1\nWALLET_SEED=ff\n');
    expect(upsertDotEnv('', 'WALLET_SEED', 'ff')).toBe('WALLET_SEED=ff\n');
  });
});

describe('network selection', () => {
  it('defaults to preprod and accepts aliases for the local network', () => {
    expect(parseNetworkName(undefined)).toBe('preprod');
    expect(parseNetworkName(' Preview ')).toBe('preview');
    expect(parseNetworkName('local')).toBe('undeployed');
    expect(parseNetworkName('testnet-02')).toBeUndefined();
  });

  it('refuses preprod without a Blockfrost token and says how to get one or avoid it', () => {
    const r = resolveNetwork({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join(' ')).toMatch(/BLOCKFROST_PROJECT_ID is not set/);
    expect(r.problems.join(' ')).toMatch(/MIDNIGHT_NETWORK=preview/);
  });

  it('builds the Blockfrost endpoints for preprod with the token on every URL', () => {
    const r = resolveNetwork({ BLOCKFROST_PROJECT_ID: TOKEN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value;
    expect(c.networkId).toBe('preprod');
    expect(c.chainName).toBe('Midnight Preprod');
    expect(c.nodeHttp).toBe(`https://rpc.midnight-preprod.blockfrost.io?project_id=${TOKEN}`);
    expect(c.nodeWs).toBe(`wss://rpc.midnight-preprod.blockfrost.io?project_id=${TOKEN}`);
    expect(c.indexerHttp).toBe(`https://midnight-preprod.blockfrost.io/api/v0?project_id=${TOKEN}`);
    expect(c.indexerWs).toBe(`wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${TOKEN}`);
    expect(c.proofServer).toBe(DEFAULT_PROOF_SERVER);
    expect(c.addressPrefix).toBe('mn_addr_preprod1');
    expect(c.secrets).toEqual([TOKEN]);
    expect(r.warnings).toEqual([]);
  });

  it('rejects a mainnet token on preprod and warns about an unfamiliar one', () => {
    const mainnet = resolveNetwork({ BLOCKFROST_PROJECT_ID: 'nightmainnetAbCdEf0123456789' });
    expect(mainnet.ok).toBe(false);
    const odd = resolveNetwork({ BLOCKFROST_PROJECT_ID: 'preprodAbCdEf0123456789' });
    expect(odd.ok).toBe(true);
    if (odd.ok) expect(odd.warnings.join(' ')).toMatch(/nightpreprod/);
  });

  it('needs no token on preview or the local network', () => {
    const preview = resolveNetwork({ MIDNIGHT_NETWORK: 'preview' });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.value.indexerHttp).toBe('https://indexer.preview.midnight.network/api/v4/graphql');
      expect(preview.value.indexerWs).toBe('wss://indexer.preview.midnight.network/api/v4/graphql/ws');
      expect(preview.value.nodeWs).toBe('wss://rpc.preview.midnight.network');
      expect(preview.value.secrets).toEqual([]);
    }
    const local = resolveNetwork({ MIDNIGHT_NETWORK: 'undeployed' });
    expect(local.ok).toBe(true);
    if (local.ok) {
      expect(local.value.nodeHttp).toBe('http://localhost:9944');
      expect(local.value.indexerWs).toBe('ws://localhost:8088/api/v4/graphql/ws');
      expect(local.value.faucet).toBeUndefined();
    }
  });

  it('accepts a self-hosted node and indexer in place of Blockfrost', () => {
    const r = resolveNetwork({ MIDNIGHT_NODE_URL: 'http://10.0.0.5:9944', MIDNIGHT_INDEXER_URL: 'http://10.0.0.5:8088/api/v4/graphql' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodeWs).toBe('ws://10.0.0.5:9944');
    expect(r.value.indexerWs).toBe('ws://10.0.0.5:8088/api/v4/graphql/ws');
  });

  it('reports a bad network name and a bad proof server URL', () => {
    expect(resolveNetwork({ MIDNIGHT_NETWORK: 'moon' }).ok).toBe(false);
    const r = resolveNetwork({ MIDNIGHT_NETWORK: 'preview', PROOF_SERVER_URL: 'localhost:6300' });
    expect(r.ok).toBe(false);
  });
});

describe('secrets', () => {
  it('accepts only a 32-byte hex seed', () => {
    expect(seedProblem(undefined)).toMatch(/not set/);
    expect(seedProblem('abc')).toMatch(/64 hex/);
    expect(seedProblem('zz'.repeat(32))).toMatch(/64 hex/);
    expect(seedProblem('0f'.repeat(32))).toBeUndefined();
  });

  it('removes tokens from URLs and from free text', () => {
    const r = resolveNetwork({ BLOCKFROST_PROJECT_ID: TOKEN });
    if (!r.ok) throw new Error('expected a config');
    const noisy = `request to ${r.value.indexerHttp} failed; disconnected from ${r.value.nodeWs}: 1000; token was ${TOKEN}`;
    const clean = redact(noisy, r.value.secrets);
    expect(clean).not.toContain(TOKEN);
    expect(clean).toContain('project_id=<redacted>');
    expect(clean).toContain('midnight-preprod.blockfrost.io/api/v0');
  });

  it('redacts a project_id even when the token is not known, and a URL-encoded secret', () => {
    expect(redact('wss://x.io?project_id=whatever123&a=1')).toBe('wss://x.io?project_id=<redacted>&a=1');
    // Redacting twice changes nothing, and punctuation after the URL survives.
    const once = redact('not usable at https://x.io/api?project_id=whatever123: HTTP 403');
    expect(once).toBe('not usable at https://x.io/api?project_id=<redacted>: HTTP 403');
    expect(redact(once)).toBe(once);
    expect(redact('seed a+b/c==zzzz and a%2Bb%2Fc%3D%3Dzzzz', ['a+b/c==zzzz'])).toBe('seed <redacted> and <redacted>');
  });
});
