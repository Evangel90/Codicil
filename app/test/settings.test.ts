// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Changing guardians and the attestor after setup, through the app's store:
// one update signed like a check-in, a new voting round every time, and a lock
// once a countdown has started.

import { beforeEach, describe, expect, it } from 'vitest';
import { Phase } from '@codicil/contracts/vault';
import { ATTESTOR, CHALLENGE, demo, GUARDIAN_POOL } from '../src/demo/store.js';
import { createDemoPasskey } from '../src/demo/passkey.js';
import { nextUp, planSummary, settingsOpen } from '../src/demo/guide.js';
import { commands } from '../src/demo/commands.js';

const s = () => demo.getSnapshot();
const ctx = { setTab: () => {}, reset: () => {}, toggleTheme: () => {}, downloadReminders: () => {} };
const labels = () => commands(s(), ctx).map((c) => c.label);
const current = () => s().guardians.filter((g) => g.current).map((g) => g.name);
const NAMES = new RegExp(GUARDIAN_POOL.map((g) => g.name.replace('.', '\\.')).join('|'));

async function ok(p: Promise<boolean>) {
  expect(await p, s().tx?.message).toBe(true);
  const message = s().tx!.message!;
  demo.dismissTx();
  return message;
}

async function refused(p: Promise<boolean>, code: string | undefined, message: RegExp) {
  expect(await p).toBe(false);
  expect(s().tx).toMatchObject({ status: 'error', code });
  expect(s().tx!.message).toMatch(message);
  demo.dismissTx();
}

beforeEach(async () => {
  demo.stageDelayMs = 0;
  demo.reset();
  await demo.setUp(createDemoPasskey());
});

describe('changing the guardians', () => {
  it('replaces one: the new guardian can vote, the removed one cannot', async () => {
    const before = s().chain.guardianRoot;
    expect(current()).toEqual(['Dr. Mensah', 'Sarah Lin', 'Tomás']);
    const message = await ok(demo.updateSettings({ guardians: [0, 1, 3], threshold: 2, attestor: false }));
    expect(message).toMatch(/^Saved\. 2 of your 3 guardians must now agree\. Ngozi can vote from now on\. Tomás can no longer vote\. A new voting round has started\.$/);
    expect(s().chain.guardianRoot).not.toBe(before);
    expect(s().nonce).toBe(1n);                                   // signed like a check-in
    expect(current()).toEqual(['Dr. Mensah', 'Sarah Lin', 'Ngozi']);
    expect(s().guardians.find((g) => g.name === 'Tomás')).toMatchObject({ current: false });   // still in the cast, to see his side

    await refused(demo.guardianReport(2), 'not a guardian', /no longer a guardian of this will.*not counted/);
    expect(s().guardianVotes).toBe(0n);
    await ok(demo.guardianReport(3));                             // Ngozi, with the proof she was sent
    await ok(demo.guardianReport(0));                             // Dr. Mensah, kept, with his new proof
    expect(s().phase).toBe(Phase.pending);
  });

  it('always starts a new round, so votes cast before stop counting', async () => {
    await ok(demo.guardianReport(0));
    expect(s().guardianVotes).toBe(1n);
    const round = s().guardianRound;
    const message = await ok(demo.updateSettings({ guardians: [0, 1, 2], threshold: 3, attestor: false }));
    expect(message).toMatch(/3 of your 3 guardians must now agree\..*so the vote cast before no longer counts\./);
    expect(s().guardianVotes).toBe(0n);
    expect(s().guardianRound).toBe(round + 1n);
    expect(s().guardianThreshold).toBe(3n);
    expect(s().votedThisRound).toEqual([]);
    await ok(demo.guardianReport(0));                             // the same guardian votes again in the new round
    expect(s().guardianVotes).toBe(1n);
    expect(s().phase).toBe(Phase.armed);                          // it now takes three
  });

  it('refuses an impossible choice in plain words, before anything is signed', async () => {
    await refused(demo.updateSettings({ guardians: [0], threshold: 2, attestor: false }), undefined, /^The threshold must be between 1 and 1\.$/);
    await refused(demo.updateSettings({ guardians: [], threshold: 1, attestor: false }), undefined, /^Add at least one guardian\.$/);
    expect(s().nonce).toBe(0n);
  });

  it('is locked once a countdown has started, and open again after the owner cancels it', async () => {
    expect(settingsOpen(s())).toBe(true);
    await ok(demo.guardianReport(0));
    await ok(demo.guardianReport(1));
    expect(s().phase).toBe(Phase.pending);
    expect(settingsOpen(s())).toBe(false);
    const change = { guardians: [0, 3, 4], threshold: 2, attestor: false };
    await refused(demo.updateSettings(change), 'settings locked', /^A countdown has started, so guardians and the attestor are locked\. Check in to cancel the countdown, then change them\.$/);
    await ok(demo.checkIn());
    await ok(demo.updateSettings(change));
    expect(current()).toEqual(['Dr. Mensah', 'Ngozi', 'Mr. Bello']);

    demo.advanceTo(s().deadline);
    await ok(demo.startCountdown('Someone'));
    demo.advance(CHALLENGE);
    await ok(demo.release('Someone'));
    await refused(demo.updateSettings({ guardians: [0], threshold: 1, attestor: false }), 'settings locked', /has been released/);
  });

  it('publishes a fingerprint and a number, never who or how many', async () => {
    await ok(demo.updateSettings({ guardians: [1, 3, 4], threshold: 1, attestor: true }));
    const entry = s().activity[0];
    expect(entry.what).toBe('Guardians and attestor updated · 1 must agree');
    expect(entry.published.join(' ')).not.toMatch(NAMES);
    expect(entry.published.join(' ')).not.toMatch(new RegExp(ATTESTOR.name));
    expect(entry.keptPrivate).toContain('How many guardians there are');
  });

  it('carries through to the plain-words rules, the guide and the palette', async () => {
    await ok(demo.updateSettings({ guardians: [0, 4], threshold: 1, attestor: false }));
    const { rules, warnings } = planSummary(s().setup!, s().now);
    expect(rules.find((r) => r.topic === 'Guardians')!.rule).toBe('Dr. Mensah, Mr. Bello watch over the will. Any 1 of 2 can start the switch early.');
    expect(warnings.map((w) => w.topic)).toContain('Guardians');
    expect(labels()).toContain('Act as Mr. Bello (guardian)');
    expect(labels()).toContain('Act as Tomás (guardian)');        // removed, but his side can still be seen
    expect(labels()).toContain('Guardians, attestor and recovery key');
    await ok(demo.updateSettings({ guardians: [0, 1, 4], threshold: 2, attestor: false }));
    await ok(demo.guardianReport(4));
    expect(nextUp(s()).who).toEqual([{ kind: 'guardian', id: 0 }, { kind: 'guardian', id: 1 }, { kind: 'owner' }]);   // only current guardians who have not voted
  });
});

describe('the attestor', () => {
  it('is not set at deployment, so a signed notice is refused', async () => {
    expect(s().chain.attestorKeyCommit).toMatch(/^0{64}$/);
    expect(s().setup!.attestor).toBe(false);
    expect(labels().some((l) => l.includes(ATTESTOR.name))).toBe(false);
    await refused(demo.attest('Someone'), 'unknown attestor', /has no attestor/);
  });

  it('can be named in a settings update; its signed notice then starts the switch', async () => {
    const message = await ok(demo.updateSettings({ guardians: [0, 1, 2], threshold: 2, attestor: true }));
    expect(message).toMatch(/Lagos Probate Registry can now start the switch with a signed notice\./);
    expect(s().chain.attestorKeyCommit).toMatch(/^(?!0{64})[0-9a-f]{64}$/);
    expect(planSummary(s().setup!, s().now).rules.map((r) => r.topic)).toContain('Attestor');
    expect(labels()).toContain('Send a notice signed by Lagos Probate Registry');

    await ok(demo.attest('Someone'));
    expect(s().phase).toBe(Phase.pending);
    expect(s().pendingUntil).toBe(s().now + CHALLENGE);
    expect(s().activity[0].published.join(' ')).not.toMatch(/Lagos/);
    await ok(demo.checkIn());                                     // the owner is alive and cancels

    await ok(demo.updateSettings({ guardians: [0, 1, 2], threshold: 2, attestor: false }));
    expect(s().chain.attestorKeyCommit).toMatch(/^0{64}$/);
    await refused(demo.attest('Someone'), 'unknown attestor', /has no attestor/);
  });
});
