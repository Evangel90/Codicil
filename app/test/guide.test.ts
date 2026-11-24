// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Guidance, letters held by heirs, and calendar reminders.

import { beforeEach, describe, expect, it } from 'vitest';
import { CHALLENGE, CLAIM_WINDOW, DAY, defaultSetup, demo } from '../src/demo/store.js';
import { createDemoPasskey } from '../src/demo/passkey.js';
import { nextUp, planSummary, presetFor, PRESETS } from '../src/demo/guide.js';
import { calendarFile, remindersFor } from '../src/demo/ics.js';
import { commands, filterCommands } from '../src/demo/commands.js';

const s = () => demo.getSnapshot();
const run = async (p: Promise<boolean>) => { expect(await p, s().tx?.message).toBe(true); demo.dismissTx(); };
const who = () => nextUp(s()).who.map((a) => (a.kind === 'heir' ? a.id : a.kind === 'guardian' ? `g${a.id}` : a.kind));

beforeEach(async () => {
  demo.stageDelayMs = 0;
  demo.reset();
  await demo.setUp(createDemoPasskey());
});

describe('who acts next', () => {
  it('walks the whole story', async () => {
    expect(who()).toEqual(['owner']);
    await run(demo.guardianReport(0));
    expect(who()).toEqual(['g1', 'g2', 'owner']);
    await run(demo.checkIn());
    demo.advanceTo(s().deadline);
    expect(nextUp(s()).action).toBe('startSwitch');
    await run(demo.startCountdown('Someone'));
    expect(who()).toEqual(['owner']);
    demo.advance(CHALLENGE);
    expect(nextUp(s()).action).toBe('release');
    await run(demo.release('Someone'));
    expect(who()).toEqual(['ada', 'ben']);           // Cleo waits for her date, Kofi for 30 days
    await run(demo.claim('ben'));
    demo.advance(CLAIM_WINDOW);
    expect(who()).toEqual(['ada', 'kofi']);
    await run(demo.claim('kofi'));
    expect(nextUp(s()).text).toMatch(/Cleo must wait/);
    demo.advanceTo(s().heirs.find((h) => h.profile.id === 'cleo')!.unlockAt);
    await run(demo.claim('cleo'));
    expect(nextUp(s()).tone).toBe('done');
  });
});

describe('the will in plain words', () => {
  it('has no warnings for the balanced default', () => {
    const setup = defaultSetup();
    expect(presetFor(setup)).toBe('balanced');
    expect(planSummary(setup, 0).warnings).toEqual([]);
  });

  it('warns about risky combinations', () => {
    const topics = (p: Parameters<typeof planSummary>[0]) => planSummary(p, 0).warnings.map((w) => `${w.topic}:${w.tone}`);
    const base = defaultSetup();
    expect(topics({ ...base, threshold: 1 })).toContain('Guardians:warn');
    expect(topics({ ...base, threshold: 3 })).toContain('Guardians:info');
    expect(topics({ ...base, window: 7 * DAY })).toContain('Challenge window:info');
    expect(topics({ ...base, every: 7 * DAY })).toContain('Check-ins:warn');
    expect(topics({ ...base, ada: 4000n, kofiBackup: false })).toEqual(['Heirs:info', 'Backup:info']);
  });

  it('presets only fill in values', () => {
    for (const p of PRESETS) expect(presetFor({ ...defaultSetup(), ...p.values })).toBe(p.id);
  });
});

describe('letters held by heirs', () => {
  const ben = () => s().heirs.find((h) => h.profile.id === 'ben')!;

  it('checks a letter on the heir device and notices when the will changes', async () => {
    expect(demo.holdLetter('ben', 'hello')).toBe('This is not a Codicil heir letter.');
    expect(demo.holdLetter('ben')).toBeUndefined();
    expect(ben().letter).toMatchObject({ vaultMatches: true, inCurrentWill: true, role: 'heir', shareBps: 3000n });

    await run(demo.updateWill({ ada: 5000n, ben: 3500n, cleo: 1500n, kofiBackup: true }));
    expect(ben().letter?.inCurrentWill).toBe(false);   // the old letter no longer proves anything

    demo.advanceTo(s().deadline);
    await run(demo.startCountdown('Someone'));
    demo.advance(CHALLENGE);
    await run(demo.release('Someone'));
    expect(await demo.claim('ben')).toBe(false);       // the stale letter can't claim
    demo.dismissTx();
    expect(demo.holdLetter('ben')).toBeUndefined();     // the new one can
    await run(demo.claim('ben'));
  });

  it("knows a letter meant for someone else", () => {
    const adas = demo.letterFor('ada');
    demo.holdLetter('ben', adas);
    expect(ben().letter?.role).toBe('none');
    demo.holdLetter('kofi', adas);
    expect(s().heirs.find((h) => h.profile.id === 'kofi')!.letter?.role).toBe('backup');
  });
});

describe('calendar reminders', () => {
  it('makes two reminders that say nothing about the will', () => {
    const now = 1_800_000_000;
    const r = remindersFor(now + 30 * DAY, now);
    expect(r.map((x) => x.at)).toEqual([now + 23 * DAY, now + 29 * DAY]);
    const ics = calendarFile(r, now, 'http://localhost:5173/#/demo');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).not.toMatch(/heir|Ada|Ben|Cleo|share/i);
    expect(remindersFor(now + 3 * DAY, now)).toHaveLength(1);
  });
});

describe('the command palette', () => {
  const ctx = { setTab: () => {}, reset: () => {}, toggleTheme: () => {}, downloadReminders: () => {} };
  const settled = async () => {
    while (s().tx?.status === 'running') await new Promise((r) => setTimeout(r, 1));
    expect(s().tx?.status).toBe('done');
    demo.dismissTx();
  };
  const labels = () => commands(s(), ctx).map((c) => c.label);

  it('offers what fits the moment, and puts whoever is next first', async () => {
    expect(labels()).toContain('Check in as Amara');
    expect(labels()).toContain('Skip to deadline');
    expect(labels()).not.toContain('Act as Amara (owner)');   // already Amara
    demo.advanceTo(s().deadline);
    expect(labels()).toContain('Start the switch');
    commands(s(), ctx).find((c) => c.label === 'Start the switch')!.run();
    await settled();
    expect(s().phase).toBe(1);
    expect(labels()).toContain('Cancel the switch as Amara');
    demo.advance(CHALLENGE);
    commands(s(), ctx).find((c) => c.label === 'Release the will')!.run();
    await settled();
    const actAs = commands(s(), ctx).filter((c) => c.group === 'Act as');
    expect(actAs.slice(0, 2).map((c) => c.hint)).toEqual(['next', 'next']);
    expect(actAs[0].label).toBe('Act as Ada (heir)');
  });

  it('matches every word of the query, including keywords', () => {
    const list = commands(s(), ctx);
    expect(filterCommands(list, 'alive').map((c) => c.id)).toEqual(['checkin']);
    expect(filterCommands(list, 'act ben').map((c) => c.label)).toEqual(['Act as Ben (heir)']);
    expect(filterCommands(list, 'calendar')[0].id).toBe('ics');
    expect(filterCommands(list, 'zzz')).toEqual([]);
  });
});
