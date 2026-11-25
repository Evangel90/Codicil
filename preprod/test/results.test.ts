// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { describe, expect, it } from 'vitest';
import { buildResults, formatDust, formatNight, parseNight, resultsMarkdown, summaryTable } from '../src/results.js';
import { encodeJson, STATE_VERSION, type RunState, type StepRecord } from '../src/state.js';
import { DEFAULT_TIMERS } from '../src/timers.js';

const SECRET_SK = new Uint8Array(32).fill(0xa5);
const SECRET_HEX = 'a5'.repeat(32);

const deploy: StepRecord = {
  step: 'deploy',
  startedAt: '2026-11-25T10:00:00.000Z',
  finishedAt: '2026-11-25T10:00:41.000Z',
  totalMs: 41_000,
  txId: 'id-1',
  txHash: 'aa'.repeat(32),
  blockHeight: 3_400_001,
  blockHash: 'bb'.repeat(32),
  blockTimestamp: 1_800_000_040,
  status: 'SucceedEntirely',
  feePaid: '1250000000000000',
  feeEstimated: '1300000000000000',
  proveMs: 0,
  balanceMs: 2100,
  confirmMs: 24_000,
  notes: ['vault address ' + 'cc'.repeat(32)],
};
const checkIn: StepRecord = {
  step: 'checkInPasskey',
  startedAt: '2026-11-25T10:02:00.000Z',
  finishedAt: '2026-11-25T10:02:50.000Z',
  totalMs: 50_000,
  txHash: 'dd'.repeat(32),
  blockHeight: 3_400_020,
  status: 'SucceedEntirely',
  feePaid: '750000000000000',
  proveMs: 17_400,
  balanceMs: 1900,
  confirmMs: 22_000,
  circuits: ['checkInPasskey'],
};
const recovered: StepRecord = { step: 'deposit', startedAt: '2026-11-25T10:01:00.000Z', finishedAt: '2026-11-25T10:01:01.000Z', totalMs: 1000, status: 'recovered', notes: ['already on chain'] };

function state(): RunState {
  return {
    version: STATE_VERSION,
    network: 'preprod',
    createdAt: '2026-11-25T10:00:00.000Z',
    timers: DEFAULT_TIMERS,
    actors: {
      passkey: { sk: SECRET_SK, pk: { x: 1n, y: 2n }, salt: SECRET_SK },
      wallet: { sk: SECRET_SK, pk: { x: 3n, y: 4n }, salt: SECRET_SK },
      heirs: [{ sk: 99n, keySalt: SECRET_SK, shareBps: 6000n }],
      leaves: [],
      escrowSecret: SECRET_SK,
    },
    vault: { address: 'cc'.repeat(32), deployedAt: 1_800_000_000, firstDeadline: 1n, maxPeriod: 1n, challengeWindow: 1n, claimWindow: 1n, depositAmount: 10_000_000n },
    steps: { deploy, deposit: recovered, checkInPasskey: checkIn },
    releaseEvent: { id: 42, eventType: 'Misc', name: 'codicil:released:v1', payloadVersion: 1, protocolVersion: 2_001_100 },
  };
}

describe('amounts', () => {
  it('formats NIGHT from STAR and DUST from SPECK', () => {
    expect(formatNight(5_000_000_000n)).toBe('5000.000000');
    expect(formatNight(1n)).toBe('0.000001');
    expect(formatDust(405_083_000_000n, 15)).toBe('0.000405083000000');
    expect(formatDust(1_250_000_000_000_000n)).toBe('1.250000');
    expect(formatDust(20_999_999_999_999_999n, 0)).toBe('20');
  });

  it('parses NIGHT amounts and refuses anything else', () => {
    expect(parseNight('10')).toBe(10_000_000n);
    expect(parseNight(' 2.5 ')).toBe(2_500_000n);
    expect(parseNight('0.000001')).toBe(1n);
    for (const bad of ['', '-1', '1.0000001', 'ten', '1e3']) expect(() => parseNight(bad)).toThrow(/not a NIGHT amount/);
  });
});

describe('results', () => {
  const results = buildResults(state(), { remaining: ['checkInEd25519', 'triggerTimeout'], walletAddress: 'mn_addr_preprod1xyz', versions: { 'Midnight.js': '5.0.1' }, now: new Date('2026-11-25T11:00:00Z') });

  it('lists finished steps in run order with totals', () => {
    expect(results.steps.map((s) => s.step)).toEqual(['deploy', 'deposit', 'checkInPasskey']);
    expect(results.complete).toBe(false);
    expect(results.totals).toEqual({ transactions: 2, feePaidSpeck: '2000000000000000', proveMs: 17_400, wallMs: 92_000 });
    expect(results.vaultAddress).toBe('cc'.repeat(32));
  });

  it('carries nothing secret: no key, salt or escrow secret reaches the results', () => {
    const json = encodeJson(results);
    expect(json).not.toContain(SECRET_HEX);
    expect(json).not.toContain('actors');
    expect(resultsMarkdown(results)).not.toContain(SECRET_HEX);
  });

  it('prints one table row per step with times, block and fee', () => {
    const table = summaryTable(results.steps);
    const rows = table.split('\n');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatch(/^step\s+block\s+tx hash\s+status\s+prove s\s+balance s\s+confirm s\s+total s\s+fee DUST$/);
    expect(rows[2]).toMatch(/^deploy\s+3400001\s+aaaaaaaaaa…\s+SucceedEntirely\s+0\.0\s+2\.1\s+24\.0\s+41\.0\s+1\.250000$/);
    expect(rows[3]).toMatch(/^deposit\s+-\s+-\s+recovered/);
    expect(rows[4]).toMatch(/checkInPasskey\s+3400020.*17\.4.*0\.750000$/);
    expect(summaryTable([])).toMatch(/no steps finished/);
  });

  it('writes a page with full hashes, what is left, the event and the notes', () => {
    const md = resultsMarkdown(results);
    expect(md).toContain('# Gate V14 on preprod');
    expect(md).toContain('Still to do: checkInEd25519, triggerTimeout');
    expect(md).toContain('aa'.repeat(32));
    expect(md).toContain('2 transactions, 2.000000 DUST in fees');
    expect(md).toContain('`codicil:released:v1`');
    expect(md).toContain('- deposit: already on chain');
    expect(md).toContain('- Midnight.js: 5.0.1');
  });

  it('says complete when nothing remains', () => {
    const done = buildResults(state(), { remaining: [] });
    expect(done.complete).toBe(true);
    expect(resultsMarkdown(done)).toContain('Status: **complete**');
  });
});
