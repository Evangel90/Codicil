// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { describe, expect, it } from 'vitest';
import {
  checkInProblem,
  CLOCK_SLACK_S,
  DEFAULT_TIMERS,
  estimateRun,
  extendedDeadline,
  finalDeadline,
  firstDeadline,
  formatDuration,
  MIN_ACTION_BUDGET_S,
  timersFromEnv,
  validateTimers,
  type Timers,
} from '../src/timers.js';

const NOW = 1_800_000_000;

describe('timer selection', () => {
  it('ships defaults that are valid', () => {
    expect(validateTimers(DEFAULT_TIMERS)).toEqual([]);
    expect(timersFromEnv({})).toEqual(DEFAULT_TIMERS);
  });

  it('refuses what the contract refuses: a zero max period or challenge window', () => {
    expect(validateTimers({ ...DEFAULT_TIMERS, maxPeriodS: 0 }).join(' ')).toMatch(/CODICIL_MAX_PERIOD_S must be above 0/);
    expect(validateTimers({ ...DEFAULT_TIMERS, challengeWindowS: 0 }).join(' ')).toMatch(/CODICIL_CHALLENGE_S must be above 0/);
  });

  it('refuses timers too short to land a transaction in', () => {
    expect(validateTimers({ ...DEFAULT_TIMERS, finalPeriodS: MIN_ACTION_BUDGET_S - 1 })).toHaveLength(1);
    expect(validateTimers({ ...DEFAULT_TIMERS, firstDeadlineS: 30 })).toHaveLength(1);
  });

  it('keeps the final period inside what a check-in may set', () => {
    const t: Timers = { ...DEFAULT_TIMERS, maxPeriodS: 400, finalPeriodS: 400 };
    expect(validateTimers(t).join(' ')).toMatch(/CODICIL_FINAL_PERIOD_S must be at most/);
    expect(validateTimers({ ...t, finalPeriodS: 400 - CLOCK_SLACK_S })).toEqual([]);
  });

  it('reads overrides from the environment and reports every bad one', () => {
    expect(timersFromEnv({ CODICIL_CHALLENGE_S: '60', CODICIL_FINAL_PERIOD_S: '180' })).toEqual({ ...DEFAULT_TIMERS, challengeWindowS: 60, finalPeriodS: 180 });
    const bad = (): unknown => timersFromEnv({ CODICIL_CHALLENGE_S: 'soon', CODICIL_MAX_PERIOD_S: '-5' });
    expect(bad).toThrow(/CODICIL_CHALLENGE_S="soon" is not a whole number/);
    expect(bad).toThrow(/CODICIL_MAX_PERIOD_S="-5" is not a whole number/);
    expect(() => timersFromEnv({ CODICIL_CHALLENGE_S: '0' })).toThrow(/above 0/);
  });
});

describe('deadlines', () => {
  it('puts the first deadline firstDeadlineS after deployment', () => {
    expect(firstDeadline(NOW, DEFAULT_TIMERS)).toBe(BigInt(NOW + DEFAULT_TIMERS.firstDeadlineS));
  });

  it('extends as far as the contract allows, less the clock slack', () => {
    const next = extendedDeadline(NOW, DEFAULT_TIMERS);
    expect(next).toBe(BigInt(NOW + DEFAULT_TIMERS.maxPeriodS - CLOCK_SLACK_S));
    expect(checkInProblem(NOW, next, BigInt(NOW + 100), true, BigInt(DEFAULT_TIMERS.maxPeriodS))).toBeUndefined();
  });

  it('uses the final period, unless the last check-in was slow', () => {
    expect(finalDeadline(NOW, DEFAULT_TIMERS)).toBe(BigInt(NOW + DEFAULT_TIMERS.finalPeriodS));
    expect(finalDeadline(NOW, DEFAULT_TIMERS, 20)).toBe(BigInt(NOW + DEFAULT_TIMERS.finalPeriodS));
    // A 200 s check-in asks for 3 × 200 + slack = 660 s.
    expect(finalDeadline(NOW, DEFAULT_TIMERS, 200)).toBe(BigInt(NOW + 660));
    // Never past now + maxPeriod - slack, whatever was measured.
    expect(finalDeadline(NOW, DEFAULT_TIMERS, 10_000)).toBe(BigInt(NOW + DEFAULT_TIMERS.maxPeriodS - CLOCK_SLACK_S));
  });

  it('names the contract error a check-in would hit', () => {
    const max = 1200n;
    expect(checkInProblem(NOW, BigInt(NOW + 600), BigInt(NOW - 1), true, max)).toBe('switch already expired');
    // While pending (a veto), the old deadline no longer matters.
    expect(checkInProblem(NOW, BigInt(NOW + 600), BigInt(NOW - 1), false, max)).toBeUndefined();
    expect(checkInProblem(NOW, BigInt(NOW), BigInt(NOW + 100), true, max)).toBe('deadline must be in the future');
    expect(checkInProblem(NOW, BigInt(NOW + 1201), BigInt(NOW + 100), true, max)).toBe('deadline too far');
    expect(checkInProblem(NOW, BigInt(NOW + 30), BigInt(NOW + 100), true, max)).toMatch(/may not land in time/);
  });
});

describe('run estimate', () => {
  it('adds the fixed waits to the assumed transaction time', () => {
    const e = estimateRun(DEFAULT_TIMERS);
    expect(e.waitS).toBe(DEFAULT_TIMERS.finalPeriodS + DEFAULT_TIMERS.challengeWindowS);
    expect(e.totalS).toBeGreaterThan(e.waitS);
    expect(e.totalS).toBeLessThan(30 * 60);
    expect(estimateRun(DEFAULT_TIMERS, { escrow: true }).totalS).toBe(e.totalS + 180);
    // The seal register: a deploy, the owner proof, a seal and two hand-overs. Its refused calls send nothing.
    const withSeals = estimateRun(DEFAULT_TIMERS, { seals: true });
    expect(withSeals.totalS).toBe(e.totalS + 300);
    expect(withSeals.waitS).toBe(e.waitS);
    expect(withSeals.lines.join('\n')).toMatch(/seal register is 5 of those transactions/);
    expect(e.lines.join('\n')).not.toMatch(/seal register/);
    expect(estimateRun(DEFAULT_TIMERS, { escrow: true, seals: true }).totalS).toBe(e.totalS + 480);
  });

  it('formats durations for people', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(300)).toBe('5 min');
    expect(formatDuration(425)).toBe('7 min 5 s');
    expect(formatDuration(3 * 3600 + 30 * 60)).toBe('3 h 30 min');
  });
});
