// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Pure guidance, no I/O: who should act next in the demo, what to try on the
// savings screen, the will's rules in plain words with warnings for risky
// choices, and the setup presets.

import { Phase } from '@codicil/contracts/vault';
import { VAULT_EVENTS } from '@codicil/sdk';
import {
  ATTESTOR, CLAIM_WINDOW, DAY, fmtDate, guardianById, HEIRS, OWNER_FIRST, recipientName, span, spanAdj,
  type Actor, type MessageView, type RecoveryView, type Snapshot, type VaultSetup,
} from './store.js';

const d = (seconds: number) => {
  const n = Math.round(seconds / DAY);
  return `${n} day${n === 1 ? '' : 's'}`;
};

// ─── Where the check-in stands ──────────────────────────────────────────────
/**
 * `onTime`: before the deadline. `grace`: the deadline was missed, but a
 * check-in still works and nobody can start the switch by timeout. `expired`:
 * anyone can start the switch, and a check-in alone no longer works.
 */
export type CheckInState = 'onTime' | 'grace' | 'expired';

export const checkInState = (s: Pick<Snapshot, 'now' | 'deadline' | 'switchOpensAt'>): CheckInState =>
  s.now < s.deadline ? 'onTime' : s.now < s.switchOpensAt ? 'grace' : 'expired';

/** A recovery that can still take effect: it stands, the vault is armed and the deadline has not passed. */
export const recoveryLive = (s: Pick<Snapshot, 'phase' | 'now' | 'deadline' | 'recovery'>): boolean =>
  (s.recovery.state === 'waiting' || s.recovery.state === 'ready') && s.phase === Phase.armed && s.now < s.deadline;

/** Whether the owner can change guardians and the attestor now; the contract locks them otherwise. */
export const settingsOpen = (s: Pick<Snapshot, 'phase' | 'now' | 'deadline'>): boolean =>
  s.phase === Phase.armed && s.now < s.deadline;

/** The same, as the end of a sentence. */
export function recoveryBrief(r: RecoveryView): string {
  switch (r.state) {
    case 'off': return 'no recovery key';
    case 'idle': return 'recovery key ready';
    case 'waiting': return 'a recovery is in progress';
    case 'ready': return 'a recovery can be finished now';
    case 'retired': return 'recovery key retired for good';
  }
}

/** The recovery key's status in a few words, for a row on the dashboard. */
export function recoveryLabel(r: RecoveryView): string {
  switch (r.state) {
    case 'off': return 'None';
    case 'idle': return `Ready · ${spanAdj(r.delay)} delay`;
    case 'waiting': return `Recovery in progress · until ${fmtDate(r.readyAt)}`;
    case 'ready': return 'Recovery can be finished now';
    case 'retired': return 'Retired for good';
  }
}

const EVENT_WORDS: Record<string, string> = {
  [VAULT_EVENTS.willChanged]: 'will changed',
  [VAULT_EVENTS.recoveryStarted]: 'recovery started',
  [VAULT_EVENTS.released]: 'released',
};

/** "will changed × 2, recovery started × 1", in the order each first happened. */
export function eventSummary(events: Snapshot['events']): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${EVENT_WORDS[name] ?? name} × ${n}`).join(', ');
}

// ─── Who acts next ──────────────────────────────────────────────────────────
export interface NextUp {
  /** One plain sentence about where the story is and what to try. */
  text: string;
  /** People whose turn it is; their "Act as" buttons are highlighted. */
  who: Actor[];
  /** An action anyone may take right now. */
  action?: 'startSwitch' | 'release' | 'finishRecovery';
  tone: 'calm' | 'attention' | 'done';
}

export function nextUp(s: Snapshot): NextUp {
  const k = Number(s.guardianThreshold);
  const votes = Number(s.guardianVotes);
  const owner: Actor = { kind: 'owner' };
  if (s.phase === Phase.armed) {
    const due = checkInState(s);
    if (due === 'grace') {
      return {
        tone: 'attention', who: [owner],
        text: `${OWNER_FIRST} missed her check-in, but her ${spanAdj(s.grace)} grace period runs until ${fmtDate(s.switchOpensAt)}. She can still check in as usual and nobody can start the switch. Skip the grace period to see what happens if she stays silent.`,
      };
    }
    if (due === 'expired') {
      return {
        tone: 'attention', action: 'startSwitch', who: [{ kind: 'public' }, owner],
        text: `${OWNER_FIRST} missed her check-in${s.grace > 0 ? ' and her grace period is over' : ''}. Anyone can now start the switch. ${OWNER_FIRST} then has until ${fmtDate(s.switchOpensAt + s.setup!.window)} to cancel it.`,
      };
    }
    // A recovery outranks everything else while the owner is on time: it is a
    // change of owner that only she can stop.
    if (s.recovery.state === 'ready') {
      return {
        tone: 'attention', action: 'finishRecovery', who: [{ kind: 'public' }, owner],
        text: `The recovery delay is over. Anyone can finish the recovery, and the new passkey then owns the vault. A check-in with ${OWNER_FIRST}'s current passkey still cancels it.`,
      };
    }
    if (s.recovery.state === 'waiting') {
      return {
        tone: 'attention', who: [owner],
        text: `A recovery started with ${OWNER_FIRST}'s recovery key. A new passkey takes over on ${fmtDate(s.recovery.readyAt)} unless her current passkey signs anything first. Check in as ${OWNER_FIRST} to cancel it, or skip the recovery delay to let it finish.`,
      };
    }
    if (votes > 0) {
      const left = s.guardians.filter((g) => g.current && !s.votedThisRound.includes(g.id)).map((g): Actor => ({ kind: 'guardian', id: g.id }));
      return { tone: 'attention', who: [...left, owner], text: `${votes} of ${k} guardians ${votes === 1 ? 'has' : 'have'} voted. Another vote starts the switch; a check-in by ${OWNER_FIRST} resets the count.` };
    }
    // The will changed and an heir who has not looked since still holds a letter for the old one.
    const stale = s.heirs.filter((h) => h.letter && h.letter.vaultMatches && !h.letter.inCurrentWill && !h.sawWillChange);
    if (stale.length) {
      const names = stale.map((h) => h.profile.name);
      return {
        tone: 'attention', who: stale.map((h): Actor => ({ kind: 'heir', id: h.profile.id })),
        text: `${OWNER_FIRST} changed her will, so the letter${names.length === 1 ? '' : 's'} ${names.join(' and ')} ${names.length === 1 ? 'holds is' : 'hold are'} out of date. Act as ${names[0]} to see what an heir is told.`,
      };
    }
    return { tone: 'calm', who: [owner], text: `${OWNER_FIRST} is checking in, so nothing happens. Check in, or skip to the deadline to see what happens if she stops.` };
  }
  if (s.phase === Phase.pending) {
    if (s.now >= s.pendingUntil) {
      return { tone: 'attention', action: 'release', who: [{ kind: 'public' }], text: 'The challenge window ended and nobody cancelled. Anyone can now release the will.' };
    }
    return { tone: 'attention', who: [owner], text: `The switch has started. ${OWNER_FIRST} can cancel with one touch, or skip the challenge window to let it run out.` };
  }
  // Released: who can claim now, and who must wait.
  const ready = s.heirs.filter((h) => {
    if (!h.named || h.claimed) return false;
    const leafTaken = s.heirs.some((x) => x.profile.leaf === h.profile.leaf && x.claimed);
    if (leafTaken) return false;
    if (h.profile.backup) return s.now >= s.releasedAt + CLAIM_WINDOW;
    return s.now >= h.unlockAt;
  });
  if (ready.length) {
    const names = ready.map((h) => h.profile.name);
    return {
      tone: 'attention',
      who: ready.map((h): Actor => ({ kind: 'heir', id: h.profile.id })),
      text: `Released. ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`} can claim now, each proving they're named without saying who they are.`,
    };
  }
  const waiting = s.heirs.filter((h) => h.named && !h.claimed && !s.heirs.some((x) => x.profile.leaf === h.profile.leaf && x.claimed));
  if (waiting.length) {
    return { tone: 'calm', who: [], text: `Every share that can be claimed has been. ${waiting.map((h) => h.profile.name).join(' and ')} must wait for a later date; skip ahead to see it.` };
  }
  return { tone: 'done', who: [], text: 'Every share has been claimed. The ledger shows only one-time stamps, never who.' };
}

export const sameActor = (a: Actor, b: Actor) =>
  a.kind === b.kind && (a.kind === 'owner' || a.kind === 'public' || (a as { id: unknown }).id === (b as { id: unknown }).id);

// ─── The savings screen ─────────────────────────────────────────────────────
/** Where the inheritable position is: locked, open to its beneficiary, or paid. */
export type PositionStage = 'locked' | 'open' | 'paid';

export const positionStage = (s: Snapshot): PositionStage =>
  s.position.withdrawn ? 'paid' : s.phase === Phase.released ? 'open' : 'locked';

/**
 * What to try on the savings screen. Before the release it invites one
 * withdrawal that the contract refuses; once that has been seen, it hands back
 * to the vault's own story, because only a release unlocks the savings.
 */
export function positionNext(s: Snapshot): NextUp {
  const p = s.position;
  const beneficiary: Actor = { kind: 'heir', id: p.beneficiary };
  const name = HEIRS.find((h) => h.id === p.beneficiary)!.name;
  const stage = positionStage(s);
  if (stage === 'paid') {
    return { tone: 'done', who: [], text: `${p.name} has paid out. It asked the vault first and got a yes, both in one transaction.` };
  }
  if (stage === 'open') {
    return { tone: 'attention', who: [beneficiary], text: `The will is released, so ${p.name} will pay. ${name} can withdraw now.` };
  }
  if (p.lastAttempt?.code === 'vault not released') {
    const up = nextUp(s);
    return { ...up, text: `${p.name} refused, as it should. ${up.text}` };
  }
  return { tone: 'attention', who: [beneficiary], text: `${p.name} pays ${name} only after the will is released. Try a withdrawal as ${name} now and watch it refuse.` };
}

// ─── The will in plain words ────────────────────────────────────────────────
// ─── The vault as a signal ──────────────────────────────────────────────────
export type SignalState = 'checkingIn' | 'silent' | 'released';

/** A vault's public status, said the way a canary is read. Uses nothing but the public ledger. */
export function signal(s: Snapshot): { state: SignalState; title: string; detail: string } {
  if (s.phase === Phase.released) {
    return { state: 'released', title: 'Released', detail: `The owner stayed silent through the whole challenge window. The vault released on ${fmtDate(s.releasedAt)}, and nothing can undo that.` };
  }
  if (s.phase === Phase.pending) {
    return { state: 'silent', title: 'Gone silent', detail: `A check-in was missed and the countdown is running. Unless the owner checks in by ${fmtDate(s.pendingUntil)}, the vault releases.` };
  }
  const due = checkInState(s);
  if (due === 'onTime') return { state: 'checkingIn', title: 'Still checking in', detail: `The owner is checking in. The next check-in is due by ${fmtDate(s.deadline)}.` };
  return {
    state: 'silent', title: 'Gone silent',
    detail: due === 'grace'
      ? `The check-in due on ${fmtDate(s.deadline)} has not come. The owner has until ${fmtDate(s.switchOpensAt)} before anyone can start the countdown.`
      : `The check-in due on ${fmtDate(s.deadline)} has not come. Anyone can start the countdown now.`,
  };
}

// ─── The messages screen ────────────────────────────────────────────────────
/** Where a sealed message is: shut, waiting for guardians' pieces, ready to open, or read. */
export type MessageStage = 'sealed' | 'collecting' | 'ready' | 'opened';

export const messageStage = (s: Pick<Snapshot, 'phase'>, m: MessageView): MessageStage =>
  m.opened ? 'opened' : m.handed.length >= m.needed ? 'ready' : s.phase === Phase.released ? 'collecting' : 'sealed';

/** What to try on the messages screen: seal one, then follow it through the release to its reader. */
export function messagesNext(s: Snapshot): NextUp {
  const open = (m: MessageView) => m.to === 'everyone';
  const name = (m: MessageView) => recipientName(m.to);
  const reader = (m: MessageView): Actor => (m.to === 'everyone' ? { kind: 'public' } : { kind: 'heir', id: m.to });
  if (s.messages.length === 0 && s.register.statement) {
    const sig = signal(s);
    return sig.state === 'checkingIn'
      ? { tone: 'attention', who: [{ kind: 'public' }], text: `The statement is on ${OWNER_FIRST}'s public page, and anyone can read it. Skip to the deadline to see what the page says when she stops checking in.` }
      : { tone: sig.state === 'released' ? 'done' : 'attention', who: [{ kind: 'public' }], text: `The public page now says "${sig.title}", and that the statement no longer holds. Nobody had to announce it.` };
  }
  if (s.messages.length === 0) {
    return s.phase === Phase.released
      ? { tone: 'done', who: [], text: 'The will is released and no message was sealed. Reset the demo to seal one and follow it through.' }
      : { tone: 'attention', who: [{ kind: 'owner' }], text: `${OWNER_FIRST} can seal a message for one person, or a disclosure for everyone. It opens only after the vault releases.` };
  }
  const at = (stage: MessageStage) => s.messages.filter((m) => messageStage(s, m) === stage);
  const ready = at('ready');
  if (ready.length) {
    const m = ready[0];
    return {
      tone: 'attention', who: ready.map(reader),
      text: open(m) ? 'Enough pieces are on the register. Anyone can open the disclosure now.' : `Enough pieces have arrived. ${name(m)} can open the message now.`,
    };
  }
  const collecting = at('collecting');
  if (collecting.length) {
    const m = collecting[0];
    const waiting = [...new Set(collecting.flatMap((c) => c.holders.filter((id) => !c.handed.includes(id))))];
    const more = m.needed - m.handed.length;
    return {
      tone: 'attention', who: waiting.map((id): Actor => ({ kind: 'guardian', id })),
      text: `The vault has released, so guardians can hand over their pieces. ${more === 1 ? 'One more is' : `${more} more are`} needed before ${open(m) ? 'anyone can open the disclosure' : `${name(m)} can open the message`}.`,
    };
  }
  if (at('sealed').length) {
    const up = nextUp(s);
    return { ...up, text: `Sealed, and shut until the vault releases. ${up.text}` };
  }
  return s.messages.every((m) => m.via === 'hand')
    ? { tone: 'done', who: [], text: 'Every sealed message has been opened by the person it was for. None of it touched the chain.' }
    : { tone: 'done', who: [], text: 'Every sealed message has been opened. The register held fingerprints and key pieces, and never a word of a message.' };
}

export interface Rule { topic: string; rule: string; meaning: string }
export interface Warning { topic: string; tone: 'warn' | 'info'; text: string }

/**
 * `recoveryKey` says where the key stands on a live vault; in the wizard it
 * follows from the setup ('ready' when a delay is chosen, 'none' otherwise).
 */
export function planSummary(
  p: VaultSetup,
  now: number,
  live: { recoveryKey?: 'none' | 'ready' | 'retired' } = {},
): { rules: Rule[]; warnings: Warning[] } {
  const guardians = p.guardians.map(guardianById);
  const n = guardians.length;
  const pct = (b: bigint) => Number(b) / 100;
  const total = pct(p.ada + p.ben + p.cleo);
  const recoveryKey = live.recoveryKey ?? (p.recoveryDelay > 0 ? 'ready' : 'none');
  const rules: Rule[] = [];
  const warnings: Warning[] = [];

  rules.push({
    topic: 'Check-ins',
    rule: `You check in at least every ${d(p.every)}, with one touch of Face ID. Changing the will does not move your deadline.`,
    meaning: p.grace > 0
      ? `If ${d(p.every)} pass without one, your grace period starts. A missed check-in proves nothing by itself; it only starts clocks you can stop.`
      : `If ${d(p.every)} pass without one, anyone can start the switch. A missed check-in proves nothing by itself; it only starts a clock you can stop.`,
  });
  if (p.every <= 7 * DAY) warnings.push({ topic: 'Check-ins', tone: 'warn', text: `Checking in every ${d(p.every)} is easy to miss on holiday or in hospital. Your challenge window is the safety net.` });

  rules.push(p.grace > 0 ? {
    topic: 'Grace period',
    rule: `If you miss a check-in, you have ${d(p.grace)} more to check in as usual.`,
    meaning: 'Until the grace period ends, nobody can start the switch because of the missed check-in, and your time to cancel is counted from its end. Guardians are not delayed by it. A late check-in is visibly late on the chain, and heirs wait this much longer.',
  } : {
    topic: 'Grace period',
    rule: 'None.',
    meaning: 'Anyone can start the switch the moment a check-in is missed. Being a day late means cancelling a countdown that everyone can see.',
  });
  if (p.grace > 0 && p.grace >= p.every) warnings.push({ topic: 'Grace period', tone: 'info', text: `A grace period as long as the check-in period means you really have ${d(p.every + p.grace)} between check-ins.` });

  rules.push({
    topic: 'Guardians',
    rule: n === 1
      ? `${guardians[0].name} watches over the will and can start the switch early.`
      : `${guardians.map((g) => g.name).join(', ')} watch over the will. Any ${p.threshold} of ${n} can start the switch early.`,
    meaning: 'Guardians can only start the clock. They never see the will, never hold funds, and never learn who the other guardians are.',
  });
  if (p.threshold === 1 && n > 1) warnings.push({ topic: 'Guardians', tone: 'warn', text: 'A single guardian can start the switch on their own. You would still have the whole challenge window to cancel.' });
  if (n === 1) warnings.push({ topic: 'Guardians', tone: 'warn', text: `${guardians[0].name} is your only guardian and can start the switch alone. You would still have the whole challenge window to cancel.` });
  if (p.threshold === n && n > 1) warnings.push({ topic: 'Guardians', tone: 'info', text: `All ${n} guardians must agree. If one can't be reached, guardians can't start the switch early; your deadline still works.` });

  if (p.attestor) {
    rules.push({
      topic: 'Attestor',
      rule: `${ATTESTOR.name} can also start the switch, with a signed notice.`,
      meaning: 'Like the guardians, an attestor can only start the clock. A notice signed before your last check-in or settings change does not work.',
    });
  }

  rules.push({
    topic: 'Challenge window',
    rule: `Once the switch starts, you have ${d(p.window)} to cancel.`,
    meaning: `One check-in in that time cancels everything and resets guardian votes. After it, the will can be released and can no longer be stopped.`,
  });
  if (p.window < 14 * DAY) warnings.push({ topic: 'Challenge window', tone: 'info', text: `Only ${d(p.window)} to cancel a switch you didn't expect. 14 days or more gives more room.` });

  rules.push({
    topic: 'Heirs',
    rule: `Ada ${pct(p.ada)}%, Ben ${pct(p.ben)}%, Cleo ${pct(p.cleo)}% from ${new Date(p.cleoUnlock * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`,
    meaning: 'Each share is paid as a percentage of the estate when the will is released. Heirs claim to fresh addresses, so payouts can’t be linked to them.',
  });
  if (total < 100) warnings.push({ topic: 'Heirs', tone: 'info', text: `${Math.round((100 - total) * 100) / 100}% isn't allocated. It stays in the vault and no heir can claim it.` });
  if (p.cleoUnlock <= now) warnings.push({ topic: 'Heirs', tone: 'info', text: "Cleo's unlock date is already past, so her share is claimable as soon as the will is released." });

  rules.push({
    topic: 'Backup',
    rule: p.kofiBackup ? `Kofi backs up Ada's share.` : 'No backup heir.',
    meaning: p.kofiBackup
      ? `If Ada hasn't claimed within ${d(CLAIM_WINDOW)} of the release, Kofi can.`
      : `If an heir never claims, their share stays in the vault.`,
  });
  if (!p.kofiBackup) warnings.push({ topic: 'Backup', tone: 'info', text: "Without a backup, Ada's share is lost if her key or letter is lost." });

  if (recoveryKey === 'ready') {
    rules.push({
      topic: 'Recovery key',
      rule: `If you lose your passkey, your recovery key can put a new one in charge after a public wait of ${d(p.recoveryDelay)}.`,
      meaning: `Anything your current passkey signs in those ${d(p.recoveryDelay)} cancels it and retires the key for good. The key cannot delay or stop a release, and it must be used at least ${d(p.recoveryDelay)} before a deadline.`,
    });
    warnings.push({ topic: 'Recovery key', tone: 'info', text: `Anyone who finds your recovery key can take over the vault unless your passkey signs something within ${d(p.recoveryDelay)}. The chain shows that this vault has one.` });
  } else if (recoveryKey === 'retired') {
    rules.push({
      topic: 'Recovery key',
      rule: 'Retired. A recovery made with it was cancelled.',
      meaning: 'This vault has no usable recovery key now, and this version cannot set a new one. If you lose your passkey, the will is released at your deadline.',
    });
  } else {
    rules.push({
      topic: 'Recovery key',
      rule: 'None.',
      meaning: 'If you lose your passkey you cannot check in, and the will is released to your heirs at your deadline. A recovery key can only be set when the vault is created.',
    });
  }

  rules.push({
    topic: 'Privacy',
    rule: 'The chain stores one fingerprint of the will, a fingerprint of the guardians, and the timers.',
    meaning: 'Names, shares, dates and how many heirs there are stay on your device. Heirs prove they are in the will without saying which entry is theirs.',
  });
  rules.push({
    topic: 'Worst case',
    rule: `Heirs can claim at the earliest ${d(p.every + p.grace + p.window)} after your last check-in.`,
    meaning: `Or ${d(p.window)} after ${p.threshold} guardian${p.threshold === 1 ? '' : 's'} vote${p.threshold === 1 ? 's' : ''}, if that comes first.`,
  });
  return { rules, warnings };
}

// ─── Presets ────────────────────────────────────────────────────────────────
export interface Preset { id: string; name: string; tagline: string; forWhom: string; values: Pick<VaultSetup, 'every' | 'window' | 'threshold'> }

export const PRESETS: Preset[] = [
  { id: 'careful', name: 'Careful', tagline: 'Slow to start, hard to rush', forWhom: 'For long trips, or a large estate.', values: { every: 90 * DAY, window: 30 * DAY, threshold: 3 } },
  { id: 'balanced', name: 'Balanced', tagline: 'A month between check-ins', forWhom: 'What most people keep.', values: { every: 30 * DAY, window: 14 * DAY, threshold: 2 } },
  { id: 'quick', name: 'Quick', tagline: 'Heirs wait about five weeks', forWhom: 'For people who are rarely out of reach.', values: { every: 30 * DAY, window: 7 * DAY, threshold: 2 } },
];

export const presetFor = (p: VaultSetup) =>
  PRESETS.find((x) => x.values.every === p.every && x.values.window === p.window && x.values.threshold === p.threshold)?.id;
