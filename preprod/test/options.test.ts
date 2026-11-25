// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { describe, expect, it } from 'vitest';
import { planInit } from '../src/init.js';
import { parseArgs, settingsFromEnv } from '../src/options.js';

describe('command line', () => {
  it('parses a command and its flags', () => {
    expect(parseArgs(['run', '--escrow', '--fresh'])).toMatchObject({ command: 'run', escrow: true, fresh: true, freshSync: false });
    expect(parseArgs(['check', '--no-wallet', '--sync-timeout=600'])).toMatchObject({ command: 'check', noWallet: true, syncTimeoutS: 600 });
    expect(parseArgs(['dryrun', '--', '--prove'])).toMatchObject({ command: 'dryrun', prove: true });
  });

  it('shows help for no command or --help', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['run', '--help']).command).toBe('help');
  });

  it('refuses what it does not know', () => {
    expect(() => parseArgs(['deploy'])).toThrow(/unknown command "deploy"/);
    expect(() => parseArgs(['run', '--yolo'])).toThrow(/unknown flag --yolo/);
    expect(() => parseArgs(['run', 'again'])).toThrow(/unexpected argument/);
    expect(() => parseArgs(['check', '--sync-timeout=soon'])).toThrow(/whole number of seconds/);
  });
});

describe('settings', () => {
  it('has safe defaults', () => {
    const s = settingsFromEnv({});
    expect(s.depositStar).toBe(10_000_000n);
    expect(s.escrowStar).toBe(5_000_000n);
    expect(s.minDustSpeck).toBe(20n * 10n ** 15n);
    expect(s.proofTimeoutMs).toBe(900_000);
    expect(s.syncTimeoutMs).toBe(6 * 3600 * 1000);
  });

  it('reads overrides and rejects bad ones', () => {
    const s = settingsFromEnv({ CODICIL_DEPOSIT: '2.5', CODICIL_MIN_DUST: '5', CODICIL_PROOF_TIMEOUT_S: '60' });
    expect(s).toMatchObject({ depositStar: 2_500_000n, minDustSpeck: 5n * 10n ** 15n, proofTimeoutMs: 60_000 });
    expect(() => settingsFromEnv({ CODICIL_DEPOSIT: '0' })).toThrow(/above 0/);
    expect(() => settingsFromEnv({ CODICIL_MIN_DUST: '1.5' })).toThrow(/whole number of DUST/);
    expect(() => settingsFromEnv({ CODICIL_SYNC_TIMEOUT_S: '0' })).toThrow(/positive whole number/);
  });
});

describe('init', () => {
  const SEED = '0f'.repeat(32);
  const OTHER = 'e1'.repeat(32);
  const fail = (): string => { throw new Error('must not generate a seed'); };

  it('creates a seed when there is no .env, and writes only that line', () => {
    const plan = planInit(undefined, undefined, () => SEED);
    expect(plan).toEqual({ source: 'new', seed: SEED, write: `WALLET_SEED=${SEED}\n` });
  });

  it('adds a seed to an existing .env without disturbing it', () => {
    const text = '# my settings\nBLOCKFROST_PROJECT_ID=nightpreprodXYZ\nWALLET_SEED=\n';
    const plan = planInit(text, undefined, () => SEED);
    expect(plan.source).toBe('new');
    expect(plan.write).toBe(`# my settings\nBLOCKFROST_PROJECT_ID=nightpreprodXYZ\nWALLET_SEED=${SEED}\n`);
  });

  it('never replaces a seed that is already in .env', () => {
    const plan = planInit(`WALLET_SEED=${OTHER}\n`, undefined, fail);
    expect(plan).toEqual({ source: 'env-file', seed: OTHER });
    expect(plan.write).toBeUndefined();
  });

  it('uses a seed from the process environment without writing it to disk', () => {
    const plan = planInit('MIDNIGHT_NETWORK=preview\n', OTHER, fail);
    expect(plan).toEqual({ source: 'process', seed: OTHER });
  });

  it('stops rather than overwrite a malformed seed', () => {
    expect(() => planInit('WALLET_SEED=abandon abandon abandon\n', undefined, fail)).toThrow(/init will not replace it/);
    expect(() => planInit(undefined, 'short', fail)).toThrow(/64 hex/);
  });
});
