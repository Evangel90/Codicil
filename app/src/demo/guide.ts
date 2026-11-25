// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Pure guidance, no I/O: who should act next in the demo, what to try on the
// savings screen, the will's rules in plain words with warnings for risky
// choices, and the setup presets.

import { Phase } from '@codicil/contracts/vault';
import { CLAIM_WINDOW, DAY, GUARDIANS, HEIRS, OWNER_FIRST, type Actor, type Snapshot, type VaultSetup } from './store.js';

const d = (seconds: number) => {
  const n = Math.round(seconds / DAY);
  return `${n} day${n === 1 ? '' : 's'}`;
};

// ─── Who acts next ──────────────────────────────────────────────────────────
export interface NextUp {
  /** One plain sentence about where the story is and what to try. */
  text: string;
  /** People whose turn it is; their "Act as" buttons are highlighted. */
  who: Actor[];
  /** An action anyone may take right now. */
  action?: 'startSwitch' | 'release';
  tone: 'calm' | 'attention' | 'done';
}

export function nextUp(s: Snapshot): NextUp {
  const k = Number(s.guardianThreshold);
  const votes = Number(s.guardianVotes);
  const owner: Actor = { kind: 'owner' };
  if (s.phase === Phase.armed) {
    if (s.now >= s.deadline) {
      return { tone: 'attention', action: 'startSwitch', who: [{ kind: 'public' }, owner], text: `${OWNER_FIRST} missed her check-in. Anyone can now start the switch, or ${OWNER_FIRST} can still check in.` };
    }
    if (votes > 0) {
      const left = GUARDIANS.filter((g) => !s.votedThisRound.includes(g.id)).map((g): Actor => ({ kind: 'guardian', id: g.id }));
      return { tone: 'attention', who: [...left, owner], text: `${votes} of ${k} guardians ${votes === 1 ? 'has' : 'have'} voted. Another vote starts the switch; a check-in by ${OWNER_FIRST} resets the count.` };
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
export interface Rule { topic: string; rule: string; meaning: string }
export interface Warning { topic: string; tone: 'warn' | 'info'; text: string }

export function planSummary(p: VaultSetup, now: number): { rules: Rule[]; warnings: Warning[] } {
  const n = GUARDIANS.length;
  const pct = (b: bigint) => Number(b) / 100;
  const total = pct(p.ada + p.ben + p.cleo);
  const rules: Rule[] = [];
  const warnings: Warning[] = [];

  rules.push({
    topic: 'Check-ins',
    rule: `You check in at least every ${d(p.every)}, with one touch of Face ID. Changing the will counts as a check-in.`,
    meaning: `If ${d(p.every)} pass without one, anyone can start the switch. A missed check-in proves nothing by itself; it only starts a clock you can stop.`,
  });
  if (p.every <= 7 * DAY) warnings.push({ topic: 'Check-ins', tone: 'warn', text: `Checking in every ${d(p.every)} is easy to miss on holiday or in hospital. Your challenge window is the safety net.` });

  rules.push({
    topic: 'Guardians',
    rule: `${GUARDIANS.map((g) => g.name).join(', ')} watch over the will. Any ${p.threshold} of ${n} can start the switch early.`,
    meaning: 'Guardians can only start the clock. They never see the will, never hold funds, and never learn who the other guardians are.',
  });
  if (p.threshold === 1) warnings.push({ topic: 'Guardians', tone: 'warn', text: 'A single guardian can start the switch on their own. You would still have the whole challenge window to cancel.' });
  if (p.threshold === n) warnings.push({ topic: 'Guardians', tone: 'info', text: `All ${n} guardians must agree. If one can't be reached, guardians can't start the switch early; your deadline still works.` });

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

  rules.push({
    topic: 'Privacy',
    rule: 'The chain stores one fingerprint of the will, a fingerprint of the guardians, and the timers.',
    meaning: 'Names, shares, dates and how many heirs there are stay on your device. Heirs prove they are in the will without saying which entry is theirs.',
  });
  rules.push({
    topic: 'Worst case',
    rule: `Heirs can claim at the earliest ${d(p.every + p.window)} after your last check-in.`,
    meaning: `Or ${d(p.window)} after ${p.threshold} guardian${p.threshold === 1 ? '' : 's'} vote, if that comes first.`,
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
