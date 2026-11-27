// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Everything the demo can do, as a flat list for the ⌘K palette, plus the
// time jumps the demo bar offers. Built from a snapshot; no DOM here.

import { Phase } from '@codicil/contracts/vault';
import { ATTESTOR, CLAIM_WINDOW, DAY, demo, guardianById, HEIRS, OWNER_FIRST, type Actor, type Snapshot, recipientName,
} from './store.js';
import { checkInState, messageStage, nextUp, positionStage, recoveryLive, sameActor } from './guide.js';

export interface Jump { label: string; to: number }

/** The useful places to skip to from here. */
export function jumpsFor(s: Snapshot): Jump[] {
  const out: Jump[] = [{ label: '+1 day', to: s.now + DAY }];
  if (s.phase === Phase.armed) {
    const due = checkInState(s);
    // A recovery always ends before the deadline, so its jump comes first.
    if (recoveryLive(s) && s.recovery.state === 'waiting') out.push({ label: 'Skip the recovery delay', to: s.recovery.readyAt });
    if (due === 'onTime') out.push({ label: 'Skip to deadline', to: s.deadline });
    if (due === 'grace') out.push({ label: 'Skip the grace period', to: s.switchOpensAt });
  }
  if (s.phase === Phase.pending && s.now < s.pendingUntil) out.push({ label: 'Skip challenge window', to: s.pendingUntil });
  if (s.phase === Phase.released) {
    const cleo = s.heirs.find((h) => h.profile.id === 'cleo')!;
    const waits = [s.releasedAt + CLAIM_WINDOW, ...s.heirs.filter((h) => !h.claimed).map((h) => h.unlockAt)]
      .filter((t) => t > s.now).sort((a, b) => a - b);
    if (waits.length) out.push({ label: waits[0] === cleo.unlockAt ? "Skip to Cleo's unlock date" : 'Skip to the backup date', to: waits[0] });
  }
  return out;
}

export type Tab = 'vault' | 'will' | 'settings' | 'savings' | 'messages' | 'lens';

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
  return `${guardianById(a.id).name} (guardian)`;
}

export function commands(s: Snapshot, ctx: CommandContext): Command[] {
  const out: Command[] = [];
  const up = nextUp(s);
  const busy = s.tx?.status === 'running';
  const owner = s.actor.kind === 'owner';
  const me = s.actor.kind === 'public' ? 'Someone' : actorLabel(s.actor).replace(/ \(.*\)$/, '');
  const as = (a: Actor, then?: () => void) => () => { demo.setActor(a); ctx.setTab('vault'); then?.(); };
  const armed = s.phase === Phase.armed;
  const due = checkInState(s);
  const recovering = recoveryLive(s);

  // What moves the story forward right now.
  if (!busy) {
    // Once the grace period is over, a check-in alone is refused until the switch has started.
    if (s.phase === Phase.pending || (armed && due !== 'expired')) {
      out.push({
        id: 'checkin',
        label: s.phase === Phase.pending ? `Cancel the switch as ${OWNER_FIRST}`
          : recovering ? `Cancel the recovery as ${OWNER_FIRST}, with a check-in`
          : due === 'grace' ? `Check in late as ${OWNER_FIRST}, inside the grace period`
          : `Check in as ${OWNER_FIRST}`,
        group: 'Do',
        keywords: "i'm alive alive proof of life veto",
        run: as({ kind: 'owner' }, () => void demo.checkIn()),
      });
    }
    if (up.action === 'startSwitch') out.push({ id: 'start', label: 'Start the switch', group: 'Do', hint: 'anyone', keywords: 'timeout countdown', run: () => void demo.startCountdown(me) });
    if (up.action === 'release') out.push({ id: 'release', label: 'Release the will', group: 'Do', hint: 'anyone', run: () => void demo.release(me) });
    if (up.action === 'finishRecovery') out.push({ id: 'finish-recovery', label: 'Finish the recovery', group: 'Do', hint: 'anyone', keywords: 'recovery key new passkey', run: () => void demo.finishRecovery(me) });
    if (armed && due === 'onTime' && s.recovery.state === 'idle') {
      out.push({
        id: 'recover',
        label: `Start a recovery as ${OWNER_FIRST}, who lost her passkey`,
        group: 'Do',
        hint: 'saved key',
        keywords: 'recovery key lost keys phone new passkey',
        run: () => { demo.setActor({ kind: 'owner' }); ctx.setTab('settings'); void demo.startRecovery(); },
      });
    }
    if (armed && s.setup?.attestor) {
      out.push({
        id: 'attest',
        label: `Send a notice signed by ${ATTESTOR.name}`,
        group: 'Do',
        hint: 'starts the switch',
        keywords: 'attestor attestation death notice registry notary',
        run: () => void demo.attest(me),
      });
    }
    if (owner && armed && due === 'onTime') {
      out.push({ id: 'ics', label: 'Download check-in reminders', group: 'Do', hint: '.ics', keywords: 'calendar reminder', run: ctx.downloadReminders });
    }
    // The savings contract: refused until the will is released, then paid once.
    const stage = positionStage(s);
    if (stage !== 'paid') {
      const beneficiary: Actor = { kind: 'heir', id: s.position.beneficiary };
      out.push({
        id: 'withdraw',
        label: `Withdraw from ${s.position.name} as ${HEIRS.find((h) => h.id === s.position.beneficiary)!.name}`,
        group: 'Do',
        hint: stage === 'locked' ? 'will be refused' : undefined,
        keywords: 'escrow inheritable position payout hook',
        run: () => { demo.setActor(beneficiary); ctx.setTab('savings'); void demo.withdrawPosition(beneficiary); },
      });
    }
    // Sealed messages: guardians hand over pieces after the release, then the recipient opens.
    for (const m of s.messages) {
      if (messageStage(s, m) !== 'ready') continue;
      const to = m.to;
      out.push(to === 'everyone' ? {
        id: 'open-message:everyone', label: 'Open the public disclosure', group: 'Do', keywords: 'sealed message read decrypt disclosure journalist publish',
        run: () => { demo.setActor({ kind: 'public' }); ctx.setTab('messages'); void demo.openMessage('everyone'); },
      } : {
        id: `open-message:${to}`, label: `Open the sealed message as ${recipientName(to)}`, group: 'Do', keywords: 'sealed message read decrypt disclosure',
        run: () => { demo.setActor({ kind: 'heir', id: to }); ctx.setTab('messages'); void demo.openMessage(to); },
      });
    }
    const waiting = s.messages.filter((m) => messageStage(s, m) === 'collecting')
      .flatMap((m) => m.holders.filter((id) => !m.handed.includes(id)).map((id) => ({ id, via: m.via })))[0];
    if (waiting) {
      out.push({
        id: 'hand-over', label: `Hand over a piece of the key as ${guardianById(waiting.id).name}`, group: 'Do', keywords: 'sealed message piece share guardian release register',
        run: () => {
          demo.setActor({ kind: 'guardian', id: waiting.id });
          ctx.setTab('messages');
          if (waiting.via === 'register') void demo.publishPieces(waiting.id);
          else demo.handOverPieces(waiting.id);
        },
      });
    }
  }

  const [day, ...skips] = jumpsFor(s);
  for (const j of [day, { label: '+1 week', to: s.now + 7 * DAY }, ...skips]) {
    out.push({ id: `jump:${j.label}`, label: j.label, group: 'Time', keywords: 'skip advance clock time', run: () => demo.advanceTo(j.to) });
  }

  const people: Actor[] = [
    { kind: 'owner' },
    ...HEIRS.map((h): Actor => ({ kind: 'heir', id: h.id })),
    ...s.guardians.map((g): Actor => ({ kind: 'guardian', id: g.id })),
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
  if (owner) out.push({ id: 'go:settings', label: 'Guardians, attestor and recovery key', group: 'Go to', keywords: 'settings change add remove replace threshold lost passkey recover', run: () => ctx.setTab('settings') });
  out.push({ id: 'go:savings', label: s.position.name, group: 'Go to', hint: 'inheritable position', keywords: 'inheritable position escrow cross-contract integration developer hook', run: () => ctx.setTab('savings') });
  out.push({ id: 'go:messages', label: 'Sealed messages', group: 'Go to', hint: s.messages.length ? `${s.messages.length} sealed` : undefined, keywords: 'message letter disclosure journalist secret recovery phrase documents pieces', run: () => ctx.setTab('messages') });
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
