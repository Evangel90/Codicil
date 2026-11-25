// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The grace period: a late check-in that is late but fine, a switch nobody
// can start until grace is over, and every place the demo says what happens
// next. Run through the same store, guide and palette the UI uses.

import { beforeEach, describe, expect, it } from 'vitest';
import { Phase } from '@codicil/contracts/vault';
import { CHALLENGE, CHECK_IN_EVERY, DAY, defaultSetup, demo, fitSetup, graceChoices, type VaultSetup } from '../src/demo/store.js';
import { createDemoPasskey } from '../src/demo/passkey.js';
import { checkInState, nextUp, planSummary, settingsOpen } from '../src/demo/guide.js';
import { commands, jumpsFor } from '../src/demo/commands.js';

const GRACE = 3 * DAY;
const s = () => demo.getSnapshot();
const ctx = { setTab: () => {}, reset: () => {}, toggleTheme: () => {}, downloadReminders: () => {} };
const labels = () => commands(s(), ctx).map((c) => c.label);
const jumps = () => jumpsFor(s()).map((j) => j.label);

async function ok(p: Promise<boolean>) {
  expect(await p, s().tx?.message).toBe(true);
  const message = s().tx!.message!;
  demo.dismissTx();
  return message;
}

/** The action failed with this contract error, shown to the person as `message`. */
async function refused(p: Promise<boolean>, code: string, message: RegExp) {
  expect(await p).toBe(false);
  expect(s().tx).toMatchObject({ status: 'error', code });
  expect(s().tx!.message).toMatch(message);
  demo.dismissTx();
}

async function deploy(overrides: Partial<VaultSetup> = {}) {
  demo.stageDelayMs = 0;
  demo.reset();
  await demo.setUp(createDemoPasskey(), { ...defaultSetup(), ...overrides });
}

describe('choosing a grace period', () => {
  it('is off unless chosen, and never longer than the check-in period', () => {
    expect(defaultSetup().grace).toBe(0);
    expect(graceChoices(30 * DAY)).toEqual([0, DAY, 3 * DAY, 7 * DAY]);
    expect(graceChoices(3 * DAY)).toEqual([0, DAY, 3 * DAY]);
    // Shortening the check-in period pulls a longer grace period back in.
    expect(fitSetup({ ...defaultSetup(), every: 3 * DAY, grace: 7 * DAY }).grace).toBe(3 * DAY);
    expect(fitSetup({ ...defaultSetup(), grace: 7 * DAY }).grace).toBe(7 * DAY);
  });

  it('says in plain words what it does, and counts it in the worst case', () => {
    const rule = (p: VaultSetup, topic: string) => planSummary(p, 0).rules.find((r) => r.topic === topic)!;
    const off = defaultSetup();
    expect(rule(off, 'Grace period').rule).toBe('None.');
    expect(rule(off, 'Worst case').rule).toMatch(/44 days after your last check-in/);
    const on = { ...off, grace: GRACE };
    expect(rule(on, 'Grace period').rule).toMatch(/3 days more to check in as usual/);
    expect(rule(on, 'Grace period').meaning).toMatch(/Guardians are not delayed/);
    expect(rule(on, 'Worst case').rule).toMatch(/47 days after your last check-in/);
    expect(planSummary(on, 0).warnings).toEqual([]);
  });
});

describe('a vault with a three-day grace period', () => {
  beforeEach(() => deploy({ grace: GRACE }));

  it('puts the grace length on the ledger and works out when the switch can start', () => {
    expect(s().grace).toBe(GRACE);
    expect(s().switchOpensAt).toBe(s().deadline + GRACE);
    expect(checkInState(s())).toBe('onTime');
    expect(jumps()).toEqual(['+1 day', 'Skip to deadline']);
    expect(s().activity.at(-1)!.published.join(' ')).toMatch(/3 days of grace/);
  });

  it('after a missed deadline nobody can start the switch, and the demo says why', async () => {
    demo.advanceTo(s().deadline);
    expect(checkInState(s())).toBe('grace');
    const up = nextUp(s());
    expect(up.action).toBeUndefined();
    expect(up.who).toEqual([{ kind: 'owner' }]);
    expect(up.text).toMatch(/missed her check-in, but her 3-day grace period runs until/);
    expect(jumps()).toEqual(['+1 day', 'Skip the grace period']);
    expect(labels()).not.toContain('Start the switch');
    expect(labels()).toContain('Check in late as Amara, inside the grace period');
    await refused(demo.startCountdown('Ben'), 'grace period open', /inside a 3-day grace period and can still check in as usual\. The switch can start on /);
    expect(s().phase).toBe(Phase.armed);
  });

  it('a late check-in is late but fine', async () => {
    demo.advanceTo(s().deadline + DAY);
    const message = await ok(demo.checkIn());
    expect(message).toMatch(/^Check-in recorded, 1 day late\. You were inside your grace period, so nothing else happened\./);
    expect(s().phase).toBe(Phase.armed);
    expect(s().deadline).toBe(s().now + CHECK_IN_EVERY);
    expect(s().activity[0].what).toMatch(/^Late check-in, inside the grace period/);
    expect(s().activity[0].published.join(' ')).toMatch(/came after the deadline: block time is public/);
    expect(checkInState(s())).toBe('onTime');
  });

  it('keeps the will and the guardians locked from the deadline, and says to check in first', async () => {
    demo.advanceTo(s().deadline + 60);
    expect(settingsOpen(s())).toBe(false);
    await refused(demo.updateWill({ ada: 5000n, ben: 4000n, cleo: 1000n, kofiBackup: true }), 'switch already expired', /Check in first: you are still inside your grace period/);
    await refused(demo.updateSettings({ guardians: [0, 1], threshold: 1, attestor: false }), 'switch already expired', /Check in first: you are still inside your grace period/);
    await ok(demo.checkIn());
    await ok(demo.updateWill({ ada: 5000n, ben: 4000n, cleo: 1000n, kofiBackup: true }));
  });

  it('when grace ends anyone can start the switch, and the owner keeps the whole window', async () => {
    const opens = s().switchOpensAt;
    demo.advanceTo(opens - 1);
    expect(checkInState(s())).toBe('grace');
    demo.advanceTo(opens + 2 * DAY);                    // nobody noticed for two more days
    expect(checkInState(s())).toBe('expired');
    expect(nextUp(s())).toMatchObject({ action: 'startSwitch' });
    expect(nextUp(s()).text).toMatch(/her grace period is over/);
    expect(labels()).toContain('Start the switch');
    expect(labels().some((l) => /^Check in/.test(l))).toBe(false);   // it would be refused
    await refused(demo.checkIn(), 'switch already expired', /your grace period ended on .*Start the switch, then check in to cancel it/);

    const message = await ok(demo.startCountdown('Ben'));
    // The window is counted from the end of the grace period, whenever the trigger arrives.
    expect(s().pendingUntil).toBe(opens + CHALLENGE);
    expect(message).toMatch(/The owner can cancel until .*, 12 days from now\./);
    expect(s().activity[0].what).toBe('Deadline and grace period passed · switch started');
    await ok(demo.checkIn());
    expect(s().phase).toBe(Phase.armed);
  });

  it('does not delay guardians', async () => {
    demo.advanceTo(s().deadline + DAY);
    await ok(demo.guardianReport(0));
    await ok(demo.guardianReport(1));
    expect(s().phase).toBe(Phase.pending);
    expect(s().pendingUntil).toBe(s().now + CHALLENGE);
  });
});

describe('a vault without a grace period', () => {
  beforeEach(() => deploy());

  it('goes straight from the deadline to "anyone can start the switch"', async () => {
    expect(s().switchOpensAt).toBe(s().deadline);
    demo.advanceTo(s().deadline);
    expect(checkInState(s())).toBe('expired');
    expect(jumps()).toEqual(['+1 day']);
    expect(nextUp(s()).text).not.toMatch(/grace/);
    await refused(demo.checkIn(), 'switch already expired', /^Your check-in was due on [^,]*, so a check-in alone no longer works/);
    await ok(demo.startCountdown('Ben'));
  });
});
