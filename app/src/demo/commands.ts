// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Everything the demo can do, as a flat list for the ⌘K palette, plus the
// time jumps the demo bar offers. Built from a snapshot; no DOM here.

import { Phase } from '@codicil/contracts/vault';
import { CLAIM_WINDOW, DAY, demo, GUARDIANS, HEIRS, OWNER_FIRST, type Actor, type Snapshot } from './store.js';
import { nextUp, sameActor } from './guide.js';

export interface Jump { label: string; to: number }

/** The useful places to skip to from here. */
export function jumpsFor(s: Snapshot): Jump[] {
  const out: Jump[] = [{ label: '+1 day', to: s.now + DAY }];
  if (s.phase === Phase.armed && s.now < s.deadline) out.push({ label: 'Skip to deadline', to: s.deadline });
  if (s.phase === Phase.pending && s.now < s.pendingUntil) out.push({ label: 'Skip challenge window', to: s.pendingUntil });
  if (s.phase === Phase.released) {
    const cleo = s.heirs.find((h) => h.profile.id === 'cleo')!;
    const waits = [s.releasedAt + CLAIM_WINDOW, ...s.heirs.filter((h) => !h.claimed).map((h) => h.unlockAt)]
      .filter((t) => t > s.now).sort((a, b) => a - b);
    if (waits.length) out.push({ label: waits[0] === cleo.unlockAt ? "Skip to Cleo's unlock date" : 'Skip to the backup date', to: waits[0] });
  }
  return out;
}

export type Tab = 'vault' | 'will' | 'lens';

export interface Command {
  id: string;
  label: string;
  group: 'Do' | 'Time' | 'Act as' | 'Go to' | 'Demo';
  /** Shown on the right: a shortcut or a short note. */
  hint?: string;
  /** Extra words to match when searching. */
  keywords?: string;
  run: () => void;
}

export interface CommandContext {
  setTab: (t: Tab) => void;
  reset: () => void;
  toggleTheme: () => void;
  downloadReminders: () => void;
}

export function actorLabel(a: Actor): string {
  if (a.kind === 'owner') return `${OWNER_FIRST} (owner)`;
  if (a.kind === 'public') return 'Anyone (public inspector)';
  if (a.kind === 'heir') {
    const h = HEIRS.find((x) => x.id === a.id)!;
    return `${h.name} (${h.backup ? 'backup heir' : 'heir'})`;
  }
  return `${GUARDIANS[a.id].name} (guardian)`;
}

export function commands(s: Snapshot, ctx: CommandContext): Command[] {
  const out: Command[] = [];
  const up = nextUp(s);
  const busy = s.tx?.status === 'running';
  const owner = s.actor.kind === 'owner';
  const me = s.actor.kind === 'public' ? 'Someone' : actorLabel(s.actor).replace(/ \(.*\)$/, '');
  const as = (a: Actor, then?: () => void) => () => { demo.setActor(a); ctx.setTab('vault'); then?.(); };

  // What moves the story forward right now.
  if (!busy) {
    if (s.phase !== Phase.released) {
      out.push({
        id: 'checkin',
        label: s.phase === Phase.pending ? `Cancel the switch as ${OWNER_FIRST}` : `Check in as ${OWNER_FIRST}`,
        group: 'Do',
        keywords: "i'm alive alive proof of life veto",
        run: as({ kind: 'owner' }, () => void demo.checkIn()),
      });
    }
    if (up.action === 'startSwitch') out.push({ id: 'start', label: 'Start the switch', group: 'Do', hint: 'anyone', keywords: 'timeout countdown', run: () => void demo.startCountdown(me) });
    if (up.action === 'release') out.push({ id: 'release', label: 'Release the will', group: 'Do', hint: 'anyone', run: () => void demo.release(me) });
    if (owner && s.phase === Phase.armed && s.now < s.deadline) {
      out.push({ id: 'ics', label: 'Download check-in reminders', group: 'Do', hint: '.ics', keywords: 'calendar reminder', run: ctx.downloadReminders });
    }
  }

  const [day, ...skips] = jumpsFor(s);
  for (const j of [day, { label: '+1 week', to: s.now + 7 * DAY }, ...skips]) {
    out.push({ id: `jump:${j.label}`, label: j.label, group: 'Time', keywords: 'skip advance clock time', run: () => demo.advanceTo(j.to) });
  }

  const people: Actor[] = [
    { kind: 'owner' },
    ...HEIRS.map((h): Actor => ({ kind: 'heir', id: h.id })),
    ...GUARDIANS.map((g): Actor => ({ kind: 'guardian', id: g.id })),
    { kind: 'public' },
  ];
  // Whoever's turn it is comes first.
  const isNext = (a: Actor) => up.who.some((w) => sameActor(w, a));
  people.sort((a, b) => Number(isNext(b)) - Number(isNext(a)));
  for (const a of people) {
    if (sameActor(a, s.actor)) continue;
    out.push({ id: `as:${actorLabel(a)}`, label: `Act as ${actorLabel(a)}`, group: 'Act as', hint: isNext(a) ? 'next' : undefined, run: as(a) });
  }

  const first = owner ? 'Vault' : s.actor.kind === 'heir' ? 'Your share' : s.actor.kind === 'guardian' ? 'Guardian' : 'Inspector';
  out.push({ id: 'go:vault', label: first, group: 'Go to', keywords: 'home dashboard', run: () => ctx.setTab('vault') });
  if (owner) out.push({ id: 'go:will', label: 'Will and heir letters', group: 'Go to', keywords: 'edit change letters qr', run: () => ctx.setTab('will') });
  out.push({ id: 'go:lens', label: 'Privacy Lens', group: 'Go to', keywords: 'ledger public private', run: () => ctx.setTab('lens') });

  out.push({ id: 'theme', label: 'Switch theme', group: 'Demo', keywords: 'dark light appearance', run: ctx.toggleTheme });
  out.push({ id: 'reset', label: 'Reset the demo', group: 'Demo', keywords: 'start over new vault', run: ctx.reset });
  return out;
}

/** Case-insensitive match on every word of the query. */
export function filterCommands(list: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((c) => {
    const text = `${c.label} ${c.group} ${c.hint ?? ''} ${c.keywords ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
