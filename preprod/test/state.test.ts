// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALL_STEPS,
  decodeJson,
  encodeJson,
  isComplete,
  loadState,
  nextStep,
  recordStep,
  saveState,
  stateProblems,
  STATE_VERSION,
  VAULT_STEPS,
  type RunState,
  type Step,
  type StepRecord,
} from '../src/state.js';
import { DEFAULT_TIMERS } from '../src/timers.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'codicil-state-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const done = (step: Step): StepRecord => ({ step, startedAt: '2026-11-25T10:00:00.000Z', finishedAt: '2026-11-25T10:00:30.000Z', totalMs: 30_000, txHash: `hash-${step}` });

function fresh(): RunState {
  return {
    version: STATE_VERSION,
    network: 'preprod',
    createdAt: '2026-11-25T10:00:00.000Z',
    timers: DEFAULT_TIMERS,
    actors: {
      passkey: { sk: new Uint8Array([1, 2, 3]), pk: { x: 11n, y: 12n }, salt: new Uint8Array(32).fill(7) },
      wallet: { sk: new Uint8Array([4, 5]), pk: { x: 21n, y: 22n }, salt: new Uint8Array(32).fill(8) },
      heirs: [{ sk: 123456789012345678901234567890n, keySalt: new Uint8Array(32).fill(9), shareBps: 6000n }],
      leaves: [{ heirKeyCommit: new Uint8Array(32).fill(1), backupKeyCommit: new Uint8Array(32), shareBps: 6000n, unlockAt: 0n, salt: new Uint8Array(32).fill(2) }],
    },
    steps: {},
  };
}

const withSteps = (...steps: Step[]): RunState => steps.reduce((s, step) => recordStep(s, done(step)), fresh());

describe('resume logic', () => {
  it('starts at deploy and walks the vault steps in order', () => {
    let s = fresh();
    const seen: Step[] = [];
    for (let next = nextStep(s, { escrow: false }); next; next = nextStep(s, { escrow: false })) {
      seen.push(next);
      s = recordStep(s, done(next));
    }
    expect(seen).toEqual([...VAULT_STEPS]);
    expect(isComplete(s, { escrow: false })).toBe(true);
  });

  it('continues from the first unfinished step after a restart', () => {
    const s = withSteps('deploy', 'deposit', 'checkInPasskey');
    expect(nextStep(s, { escrow: false })).toBe('checkInEd25519');
  });

  it('adds the escrow steps after the vault steps when asked', () => {
    const vaultDone = withSteps(...VAULT_STEPS);
    expect(nextStep(vaultDone, { escrow: false })).toBeUndefined();
    expect(nextStep(vaultDone, { escrow: true })).toBe('escrowDeploy');
    expect(nextStep(withSteps(...ALL_STEPS), { escrow: true })).toBeUndefined();
  });

  it('does not change the state it was given', () => {
    const before = fresh();
    const after = recordStep(before, done('deploy'));
    expect(before.steps).toEqual({});
    expect(after.steps.deploy?.txHash).toBe('hash-deploy');
  });
});

describe('refusing a state that cannot be resumed', () => {
  it('accepts a normal state', () => {
    expect(stateProblems({ ...withSteps('deploy'), vault: vaultInfo() }, 'preprod')).toEqual([]);
  });

  it('refuses another network', () => {
    expect(stateProblems(fresh(), 'preview').join(' ')).toMatch(/state file is for preprod, but this run targets preview/);
  });

  it('refuses steps recorded out of order', () => {
    const s = { ...withSteps('deploy', 'checkInPasskey'), vault: vaultInfo() };
    expect(stateProblems(s, 'preprod').join(' ')).toMatch(/"checkInPasskey" is recorded but the earlier step "deposit" is not/);
  });

  it('refuses a deploy record with no address, and an unknown version', () => {
    expect(stateProblems(withSteps('deploy'), 'preprod').join(' ')).toMatch(/vault address is missing/);
    expect(stateProblems({ ...fresh(), version: 99 as typeof STATE_VERSION }, 'preprod').join(' ')).toMatch(/version 99/);
  });
});

function vaultInfo() {
  return { address: 'ab'.repeat(32), deployedAt: 1_800_000_000, firstDeadline: 1_800_001_200n, maxPeriod: 1200n, challengeWindow: 120n, claimWindow: 600n, depositAmount: 10_000_000n };
}

describe('state file', () => {
  it('round-trips bigints, bytes and awkward strings', () => {
    const value = { big: 2n ** 200n, bytes: new Uint8Array([0, 255, 16]), plain: 'hello', tricky: ['n:5', 'x:ff', 's:x'], nested: { n: 0n } };
    const back = decodeJson<typeof value>(encodeJson(value));
    expect(back).toEqual(value);
    expect(back.bytes).toBeInstanceOf(Uint8Array);
    expect(typeof back.tricky[0]).toBe('string');
  });

  it('rejects a corrupted byte string instead of guessing', () => {
    expect(() => decodeJson('{"a":"x:zz"}')).toThrow(/corrupt state file/);
  });

  it('saves and loads a whole run, readable by the owner only', () => {
    const path = join(tmp(), 'nested', 'state.json');
    const state = { ...withSteps('deploy', 'deposit'), vault: vaultInfo() };
    saveState(path, state);
    expect(loadState(path)).toEqual(state);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('"n:10000000"');
  });

  it('returns undefined when there is no state yet', () => {
    expect(loadState(join(tmp(), 'missing.json'))).toBeUndefined();
  });
});
