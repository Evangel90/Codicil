// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The recovery key in the demo: the text the owner saves, the "I lost my
// passkey" path (start, wait out the public delay, finish), and the owner's
// side: any signature cancels a recovery and retires the key for good.

import { beforeEach, describe, expect, it } from 'vitest';
import { Phase } from '@codicil/contracts/vault';
import { newRecoverySecret, recoveryCommitment, VAULT_EVENTS } from '@codicil/sdk';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DAY, defaultSetup, demo, fitSetup, recoveryDelayChoices, type VaultSetup } from '../src/demo/store.js';
import { createDemoPasskey } from '../src/demo/passkey.js';
import { decodeRecoveryKey, encodeRecoveryKey, RECOVERY_KEY_PREFIX, recoveryKeyFile, recoveryKeyGroups } from '../src/demo/recoveryKey.js';
import { eventSummary, nextUp, planSummary, recoveryLabel, recoveryLive } from '../src/demo/guide.js';
import { commands, jumpsFor } from '../src/demo/commands.js';

const DELAY = 3 * DAY;
const s = () => demo.getSnapshot();
const r = () => s().recovery;
const ctx = { setTab: () => {}, reset: () => {}, toggleTheme: () => {}, downloadReminders: () => {} };
const labels = () => commands(s(), ctx).map((c) => c.label);
const jumps = () => jumpsFor(s()).map((j) => j.label);

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

/** Deploys a vault; returns the recovery key exactly as the wizard showed it. */
async function deploy(overrides: Partial<VaultSetup> = { recoveryDelay: DELAY }): Promise<string> {
  demo.stageDelayMs = 0;
  demo.reset();
  const shown = demo.draftRecoveryKey();
  await demo.setUp(createDemoPasskey(), { ...defaultSetup(), ...overrides });
  return shown;
}

describe('the recovery key as text', () => {
  const secret = newRecoverySecret();
  const key = encodeRecoveryKey(secret);

  it('is a prefix and 17 groups of four, and reads back however it is typed', () => {
    expect(key.startsWith(RECOVERY_KEY_PREFIX)).toBe(true);
    expect(recoveryKeyGroups(key)).toHaveLength(17);
    expect(recoveryKeyGroups(key).every((g) => /^[0-9a-f]{4}$/.test(g))).toBe(true);
    expect(decodeRecoveryKey(key)).toEqual(secret);
    const bare = recoveryKeyGroups(key);
    expect(decodeRecoveryKey(bare.join('-').toUpperCase())).toEqual(secret);          // no prefix, dashes, capitals
    expect(decodeRecoveryKey(`  ${RECOVERY_KEY_PREFIX}\n${bare.join('\n')}  `)).toEqual(secret);
  });

  it('catches a typing mistake on the device, before anything is sent', () => {
    const groups = recoveryKeyGroups(key);
    const typo = [...groups];
    typo[3] = typo[3].replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    expect(() => decodeRecoveryKey(typo.join(' '))).toThrow(/typing mistake somewhere/);
    expect(() => decodeRecoveryKey(groups.slice(0, 16).join(' '))).toThrow(/too short: it has 64 characters and should have 68/);
    expect(() => decodeRecoveryKey(groups.join(' ') + ' abcd')).toThrow(/too long/);
    expect(() => decodeRecoveryKey(groups.join(' ').replace(/.$/, 'z'))).toThrow(/only the digits 0 to 9 and the letters a to f/);
    expect(() => decodeRecoveryKey('codicil:claim:v1:abcd')).toThrow(/not a Codicil recovery key/);
    expect(() => decodeRecoveryKey('   ')).toThrow(/enter your recovery key/);
  });

  it('downloads as a short file that says how to keep it', () => {
    const file = recoveryKeyFile(key, 3, '25 November 2026');
    expect(file).toContain(key);
    expect(file).toMatch(/takes 3 days and everyone can see it start/);
    expect(file).toMatch(/away from the device that holds your passkey/);
  });
});

describe('setting one up', () => {
  it('is off unless chosen, and the delay is always shorter than the check-in period', async () => {
    expect(defaultSetup().recoveryDelay).toBe(0);
    expect(recoveryDelayChoices(30 * DAY)).toEqual([DAY, 3 * DAY, 7 * DAY]);
    expect(recoveryDelayChoices(7 * DAY)).toEqual([DAY, 3 * DAY]);
    expect(fitSetup({ ...defaultSetup(), every: 7 * DAY, recoveryDelay: 7 * DAY }).recoveryDelay).toBe(3 * DAY);
    expect(fitSetup({ ...defaultSetup(), every: 7 * DAY }).recoveryDelay).toBe(0);

    await deploy({});
    expect(r()).toMatchObject({ state: 'off', delay: 0 });
    expect(recoveryLabel(r())).toBe('None');
    expect(s().chain.recoveryKeyCommit).toMatch(/^0{64}$/);
    expect(demo.savedRecoveryKey()).toBeUndefined();
    expect(labels().some((l) => /recovery as Amara/.test(l))).toBe(false);
    await refused(demo.startRecovery(encodeRecoveryKey(newRecoverySecret())), 'unknown recovery key', /^This vault has no recovery key/);
    expect(planSummary(s().setup!, s().now).rules.find((x) => x.topic === 'Recovery key')!.rule).toBe('None.');
  });

  it('deploys the commitment of exactly the key the wizard showed', async () => {
    demo.reset();
    const passkey = createDemoPasskey();
    const setup = { ...defaultSetup(), recoveryDelay: DELAY };
    const shown = demo.draftRecoveryKey();
    const preview = demo.preview(setup, passkey);
    expect(demo.preview(defaultSetup(), passkey).recoveryCommit).toBeUndefined();
    await demo.setUp(passkey, setup);
    expect(s().chain.recoveryKeyCommit).toBe(preview.recoveryCommit);
    expect(s().chain.recoveryKeyCommit).toBe(bytesToHex(recoveryCommitment(decodeRecoveryKey(shown))));
    expect(demo.savedRecoveryKey()).toBe(shown);
    expect(r()).toMatchObject({ state: 'idle', delay: DELAY, lastStart: s().deadline - DELAY - 1 });
    expect(recoveryLabel(r())).toBe('Ready · 3-day delay');
    expect(s().activity.at(-1)!.published.join(' ')).toMatch(/has a recovery key \(a commitment\), and its 3-day delay/);
    const { rules, warnings } = planSummary(setup, s().now);
    expect(rules.find((x) => x.topic === 'Recovery key')!.rule).toMatch(/after a public wait of 3 days/);
    expect(warnings.map((w) => w.topic)).toEqual(['Recovery key']);           // honest about the added risk
  });
});

describe('lost passkey: recovering with the saved key', () => {
  let key: string;
  beforeEach(async () => { key = await deploy(); });

  it('refuses a mistyped key on the device and a wrong key at the vault', async () => {
    const typo = key.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    await refused(demo.startRecovery(typo), undefined, /^This recovery key has a typing mistake somewhere\./);
    await refused(demo.startRecovery(encodeRecoveryKey(newRecoverySecret())), 'unknown recovery key', /valid recovery key, but not the one for this vault/);
    expect(r().state).toBe('idle');
    expect(s().events).toEqual([]);
  });

  it('start, wait out the public delay, finish: the new passkey works and the old one is refused', async () => {
    const oldCommit = s().chain.ownerPasskeyCommit;
    const oldPasskey = s().passkey;
    const deadline = s().deadline;
    expect(labels()).toContain('Start a recovery as Amara, who lost her passkey');

    const message = await ok(demo.startRecovery(key));
    expect(message).toMatch(/^Recovery started\. The new passkey takes over on .* Save your next recovery key now\.$/);
    expect(r()).toMatchObject({ state: 'waiting', readyAt: s().now + DELAY, startedAt: s().now, nextKeyToSave: true });
    expect(recoveryLive(s())).toBe(true);
    expect(s().chain.ownerPasskeyCommit).toBe(oldCommit);           // nothing has changed hands yet
    expect(s().chain.recoveryPasskeyCommit).toMatch(/^(?!0{64})[0-9a-f]{64}$/);
    expect(s().events.map((e) => e.name)).toEqual([VAULT_EVENTS.recoveryStarted]);
    expect(eventSummary(s().events)).toBe('recovery started × 1');
    expect(s().activity[0].keptPrivate).toContain('The recovery key');
    const next = demo.nextRecoveryKey()!;
    expect(next).not.toBe(key);

    // The demo says what is happening and offers the way through the delay.
    expect(nextUp(s())).toMatchObject({ tone: 'attention', who: [{ kind: 'owner' }] });
    expect(nextUp(s()).text).toMatch(/A new passkey takes over on .* unless her current passkey signs anything first/);
    expect(jumps()).toEqual(['+1 day', 'Skip the recovery delay', 'Skip to deadline']);
    expect(labels()).toContain('Cancel the recovery as Amara, with a check-in');
    await refused(demo.finishRecovery('Someone'), 'recovery delay open', /^The recovery delay runs until .*anything the current passkey signs cancels it\.$/);

    demo.advanceTo(r().readyAt);
    expect(r().state).toBe('ready');
    expect(nextUp(s()).action).toBe('finishRecovery');
    expect(labels()).toContain('Finish the recovery');
    expect(jumps()).not.toContain('Skip the recovery delay');
    await ok(demo.finishRecovery('Someone'));                       // anyone may send this

    expect(r()).toMatchObject({ state: 'idle', notice: 'finished', nextKeyToSave: false, formerPasskey: true, completedAt: s().now });
    expect(s().chain.ownerPasskeyCommit).not.toBe(oldCommit);
    expect(s().passkey).not.toBe(oldPasskey);
    expect(s().deadline).toBe(deadline);                            // a recovery never moves the deadline
    expect(s().chain.recoveryReadyAt).toBe(0);
    await ok(demo.checkIn());                                       // signed by the new passkey
    await refused(demo.tryFormerPasskey(), 'unknown owner key', /^The vault refused the old passkey/);

    // The used key is replaced by the one saved during the recovery.
    expect(demo.savedRecoveryKey()).toBe(next);
    expect(demo.nextRecoveryKey()).toBeUndefined();
    await refused(demo.startRecovery(key), 'unknown recovery key', /not the one for this vault/);
    await ok(demo.startRecovery(next));
    demo.dismissRecoveryNotice();
    expect(r().notice).toBeUndefined();
  });

  it('cannot start so close to the deadline that it could not finish', async () => {
    demo.advanceTo(r().lastStart + 1);
    await refused(demo.startRecovery(key), 'too late to recover', /^A recovery takes 3 days, and your check-in is due on .* It had to start by .* Without a check-in, the will goes to your heirs as written\.$/);
    expect(r().state).toBe('idle');
  });
});

describe('the owner’s side: a recovery she did not start', () => {
  let key: string;
  beforeEach(async () => {
    key = await deploy();
    await ok(demo.startRecovery(key));
  });

  it('one check-in cancels it, and the recovery key is retired for good', async () => {
    demo.advance(DAY);
    const message = await ok(demo.checkIn());
    expect(message).toMatch(/^Check-in recorded\. .* It also cancelled the recovery that was in progress, and the recovery key is now retired for good\.$/);
    expect(r()).toMatchObject({ state: 'retired', notice: 'cancelled', cancelledAt: s().now, nextKeyToSave: false });
    expect(recoveryLive(s())).toBe(false);
    expect(recoveryLabel(r())).toBe('Retired for good');
    expect(s().activity[0].what).toBe('Recovery cancelled · recovery key retired for good');
    expect(s().activity[1].what).toMatch(/^Check-in/);
    // The cancelled proposal stays on the ledger; the nonce no longer matches it.
    expect(s().chain.recoveryReadyAt).toBeGreaterThan(0);
    expect(s().chain.recoveryNonce).not.toBe(s().nonce);

    demo.advance(5 * DAY);
    await refused(demo.finishRecovery('Someone'), 'recovery cancelled', /owner acted after this recovery started/);
    await refused(demo.startRecovery(key), 'recovery key retired', /cancelled a recovery made with this key/);   // one attempt only
    expect(nextUp(s()).tone).toBe('calm');
    expect(labels().some((l) => /recovery/i.test(l) && !/Guardians, attestor/.test(l))).toBe(false);
    const rule = planSummary(s().setup!, s().now, { recoveryKey: 'retired' }).rules.find((x) => x.topic === 'Recovery key')!;
    expect(rule.meaning).toMatch(/no usable recovery key now, and this version cannot set a new one/);
  });

  it('a will change cancels it too, and so does a guardian change', async () => {
    const message = await ok(demo.updateWill({ ada: 5000n, ben: 3500n, cleo: 1500n, kofiBackup: true }));
    expect(message).toMatch(/cancelled the recovery that was in progress/);
    expect(r().state).toBe('retired');

    key = await deploy();
    await ok(demo.startRecovery(key));
    expect(await ok(demo.updateSettings({ guardians: [0, 1], threshold: 2, attestor: false }))).toMatch(/cancelled the recovery that was in progress/);
    expect(r().state).toBe('retired');
  });

  it('a countdown stops a recovery from finishing; the owner’s veto then cancels it', async () => {
    await ok(demo.guardianReport(0));
    await ok(demo.guardianReport(1));
    expect(s().phase).toBe(Phase.pending);
    expect(recoveryLive(s())).toBe(false);
    demo.advanceTo(r().readyAt);
    await refused(demo.finishRecovery('Someone'), 'not armed', /cannot finish while a countdown is running/);
    await ok(demo.checkIn());
    expect(s().phase).toBe(Phase.armed);
    expect(r().state).toBe('retired');
  });
});
