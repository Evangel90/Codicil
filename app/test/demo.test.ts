// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The whole demo story, run through the same store the UI uses.

import { beforeEach, describe, expect, it } from 'vitest';
import { Phase } from '@codicil/contracts/vault';
import { CHALLENGE, CLAIM_WINDOW, DAY, demo, ESTATE } from '../src/demo/store.js';
import { createDemoPasskey } from '../src/demo/passkey.js';

const s = () => demo.getSnapshot();
const lastTx = () => s().tx!;

async function ok(p: Promise<boolean | undefined>) {
  const done = await p;
  expect(lastTx().status, lastTx().message).toBe('done');
  expect(done).toBe(true);
  demo.dismissTx();
}

async function fails(p: Promise<boolean | undefined>, message: RegExp) {
  expect(await p).toBe(false);
  expect(lastTx().status).toBe('error');
  expect(lastTx().message).toMatch(message);
  demo.dismissTx();
}

beforeEach(async () => {
  demo.stageDelayMs = 0;
  demo.reset();
  await demo.setUp(createDemoPasskey());
});

describe('demo store', () => {
  it('seals a vault and funds it', () => {
    expect(s().ready).toBe(true);
    expect(s().phase).toBe(Phase.armed);
    expect(s().estate).toBe(ESTATE);
    expect(s().heirs.map((h) => h.amount)).toEqual([12_500n, 7_500n, 5_000n, 12_500n]);
    expect(s().chain.willRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  it('checks in with the passkey and moves the deadline', async () => {
    const before = s().deadline;
    demo.advance(10 * DAY);
    await ok(demo.checkIn());
    expect(s().deadline).toBe(before + 10 * DAY);
    expect(s().nonce).toBe(1n);
    expect(s().activity[0].what).toBe('Checked in');
  });

  it('refuses to start the countdown before the deadline', async () => {
    await fails(demo.startCountdown('Ben'), /checked in on time/i);
    expect(s().phase).toBe(Phase.armed);
  });

  it('lets the owner cancel a missed-deadline countdown', async () => {
    demo.advanceTo(s().deadline);
    await ok(demo.startCountdown('Ben'));
    expect(s().phase).toBe(Phase.pending);
    demo.advance(2 * DAY);
    await ok(demo.checkIn());
    expect(s().phase).toBe(Phase.armed);
    expect(s().activity[0].what).toMatch(/Cancelled/);
  });

  it('two guardian reports start the countdown; a check-in voids them', async () => {
    await ok(demo.guardianReport(0));
    expect(s().guardianVotes).toBe(1n);
    expect(s().votedThisRound).toEqual([0]);
    await fails(demo.guardianReport(0), /already/i);
    await ok(demo.guardianReport(2));
    expect(s().phase).toBe(Phase.pending);
    await ok(demo.checkIn());
    expect(s().phase).toBe(Phase.armed);
    expect(s().guardianVotes).toBe(0n);
    expect(s().votedThisRound).toEqual([]);
    await ok(demo.guardianReport(0));   // a fresh round
  });

  it('releases, pays heirs, enforces the tranche and the backup window', async () => {
    await ok(demo.deposit(5_000n));
    demo.advanceTo(s().deadline);
    await ok(demo.startCountdown('Ben'));
    await fails(demo.release('Ben'), /can still cancel/i);
    demo.advance(CHALLENGE);
    await ok(demo.release('Ben'));
    expect(s().phase).toBe(Phase.released);
    expect(s().estateSnapshot).toBe(30_000n);

    await ok(demo.claim('ben'));
    expect(s().estatePaid).toBe(9_000n);
    await fails(demo.claim('ben'), /already/i);
    await fails(demo.claim('cleo'), /unlocks at a later date/i);
    await fails(demo.claim('kofi'), /main heir still has time/i);

    demo.advance(CLAIM_WINDOW);
    await ok(demo.claim('kofi'));        // Ada never claimed; her backup can
    await fails(demo.claim('ada'), /already/i);
    expect(s().chain.claimNullifiers).toHaveLength(2);

    demo.advanceTo(s().heirs.find((h) => h.profile.id === 'cleo')!.unlockAt);
    await ok(demo.claim('cleo'));
    expect(s().estatePaid).toBe(30_000n);
    expect(s().estate).toBe(0n);
  });
});


describe('will updates', () => {
  it('explains an over-allocated will in plain words', async () => {
    await fails(demo.updateWill({ ada: 6000n, ben: 4000n, cleo: 1000n, kofiBackup: true }), /^Shares add up to more than 100%\.$/);
    expect(s().willVersion).toBe(0n);
  });

  it('re-seals a new will; old shares and removed backups stop working', async () => {
    const oldRoot = s().chain.willRoot;
    await ok(demo.updateWill({ ada: 4000n, ben: 4000n, cleo: 2000n, kofiBackup: false }));
    expect(s().chain.willRoot).not.toBe(oldRoot);
    expect(s().willVersion).toBe(1n);
    expect(s().heirs.find((h) => h.profile.id === 'kofi')!.named).toBe(false);

    demo.advanceTo(s().deadline);
    await ok(demo.startCountdown('Ben'));
    demo.advance(CHALLENGE);
    await ok(demo.release('Ben'));
    await ok(demo.claim('ben'));
    expect(s().estatePaid).toBe(10_000n);   // 40% of 25,000 under the new will
    demo.advance(CLAIM_WINDOW);
    await fails(demo.claim('kofi'), /backup|not/i);
  });

  it('cannot change the will after the deadline', async () => {
    demo.advanceTo(s().deadline);
    await fails(demo.updateWill({ ada: 5000n, ben: 4000n, cleo: 1000n, kofiBackup: true }), /deadline has passed/i);
  });
});
