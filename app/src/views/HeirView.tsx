// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// An heir's page: calm, one column, no blockchain words unless asked for.

import { useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { sampleUserAddress } from '@midnight-ntwrk/compact-runtime';
import { duration, Icon, ICONS, Logo } from '../components/ui.js';
import { CLAIM_WINDOW, demo, fmtDate, fmtShort, OWNER_FIRST, TOKEN, type HeirProfile, type Snapshot } from '../demo/store.js';

type Status = 'removed' | 'locked' | 'pending' | 'waiting' | 'claimable' | 'claimed';

export function HeirView({ s, id }: { s: Snapshot; id: HeirProfile['id'] }) {
  const me = s.heirs.find((h) => h.profile.id === id)!;
  const primary = s.heirs.find((h) => !h.profile.backup && h.profile.leaf === me.profile.leaf)!;
  const [to, setTo] = useState(() => sampleUserAddress());
  const busy = s.tx?.status === 'running';
  const released = s.phase === Phase.released;
  const backupOpensAt = s.releasedAt + CLAIM_WINDOW;
  const opensAt = me.profile.backup ? backupOpensAt : Math.max(me.unlockAt, s.releasedAt);
  const earliest = s.phase === Phase.pending ? s.pendingUntil : s.deadline + s.setup!.window;
  const leafTaken = s.heirs.some((h) => h.profile.leaf === me.profile.leaf && h.claimed);

  let status: Status;
  if (!me.named) status = 'removed';
  else if (me.claimed) status = 'claimed';
  else if (s.phase === Phase.armed) status = 'locked';
  else if (s.phase === Phase.pending) status = 'pending';
  else if (s.now < opensAt || leafTaken) status = 'waiting';
  else status = 'claimable';

  const shareText = `${Number(primary.shareBps) / 100}%`;
  const copy: Record<Status, [string, string]> = {
    removed: ['You are no longer in this will.', `${OWNER_FIRST} removed the backup heir in a later version of the will. Your key can no longer claim anything, and nobody else can tell you were ever in it.`],
    locked: ['You are named in a will.', 'Someone who cares about you included you in their will. It’s sealed, which means they are active and well. There’s nothing you need to do.'],
    pending: ['The will may open soon.', `${OWNER_FIRST} hasn't checked in, so a waiting period has started. If ${OWNER_FIRST} is well, one touch cancels it. Nothing has been released and there is nothing you need to do.`],
    waiting: leafTaken
      ? ['This share has already been claimed.', me.profile.backup ? `Ada claimed her share in time, so there is nothing left for you to claim. That is how it should be.` : 'It cannot be claimed twice.']
      : me.profile.backup
        ? [`You may be able to claim on ${fmtDate(backupOpensAt)}.`, `You are the backup for Ada's share. She has ${duration(backupOpensAt - s.now)} to claim it first. If she doesn't, it comes to you.`]
        : [`Your share will be ready on ${fmtDate(me.unlockAt)}.`, 'The will has been opened. Its owner asked that your share become available on a particular date. Until then it’s held safely, and no one else can take it.'],
    claimable: ['Your share is ready when you are.', 'We’re sorry for your loss. There’s no rush. When you feel ready, choose where to send your share.'],
    claimed: [`Thank you, ${me.profile.name}.`, 'Everything is complete. We’re sorry for your loss.'],
  };
  const [title, body] = copy[status];
  const stepIdx = status === 'locked' || status === 'pending' || status === 'removed' ? 0 : status === 'waiting' ? 1 : 2;
  const steps: [string, string][] = [['Locked', 'Sealed, owner active'], ['Waiting', 'Opens on a set date'], ['Claimable', 'Yours to claim']];
  const marks = [
    { label: 'Will sealed', date: fmtShort(s.deployedAt), on: true },
    { label: released ? 'Will opened' : 'Earliest it could open', date: released ? fmtShort(s.releasedAt) : `not before ${fmtShort(earliest)}`, on: released },
    {
      label: me.profile.backup ? 'Backup may claim' : 'Your share unlocks',
      date: me.profile.backup ? (released ? fmtShort(backupOpensAt) : '30 days after it opens') : me.unlockAt > 0 ? fmtShort(Math.max(me.unlockAt, released ? s.releasedAt : 0)) : released ? fmtShort(s.releasedAt) : 'when it opens',
      on: stepIdx === 2,
    },
  ];
  const progress = stepIdx === 0 ? 8 : stepIdx === 1 ? 55 : 100;
  const addrOk = /^[0-9a-f]{64}$/i.test(to);

  return (
    <div className="heir narrow">
      <div className="heir-head">
        <span className="eyebrow">For {me.profile.name} · key ending {me.keyEnd}</span>
        <h1 className="disp">{title}</h1>
        <p className="lede">{body}</p>
      </div>

      {status !== 'removed' && (
        <>
          <ol className="steps3" aria-label="Status of your share">
            {steps.map(([label, sub], i) => (
              <li key={label} aria-current={i === stepIdx ? 'step' : undefined} className={i < stepIdx || status === 'claimed' ? 'is-done' : i === stepIdx ? 'is-current' : ''}>
                <span className="steps3-label"><span className="mono steps3-mark">{i < stepIdx || status === 'claimed' ? '✓' : i + 1}</span>{label}</span>
                <span className="small muted">{sub}</span>
              </li>
            ))}
          </ol>

          <section className="card timeline" aria-label="Timeline">
            <span className="eyebrow">What happens, and when</span>
            <div className="tl-track" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
            <div className="tl-marks">
              {marks.map((m) => (
                <div key={m.label} className={m.on ? 'is-on' : ''}>
                  <span className="tl-dot" aria-hidden="true" />
                  <span>{m.label}</span>
                  <span className="mono small muted">{m.date}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {status === 'claimable' && (
        <section className="card claim fade-in" aria-labelledby="claim-h">
          <div className="claim-top">
            <span id="claim-h">Your share · {shareText}</span>
            <span className="mono claim-amount">{me.amount.toLocaleString()} <span className="unit">{TOKEN}</span></span>
          </div>
          <label className="field-label">
            Where should we send it?
            <input className="field mono" value={to} spellCheck={false} aria-invalid={!addrOk || undefined} onChange={(e) => setTo(e.target.value.trim())} />
            <span className="small muted">
              A brand-new address is safest: it can't be linked to you, the other heirs or {OWNER_FIRST}.{' '}
              <button type="button" className="linkish" onClick={() => setTo(sampleUserAddress())}>Make another</button>
            </span>
          </label>
          <button type="button" className="btn btn-primary btn-lg" disabled={busy || !addrOk} onClick={() => void demo.claim(id, to)}>
            Claim my share
          </button>
          <p className="small muted">
            Your device proves you're named in the will without revealing who you are. On Midnight it takes about 10 seconds.
            {me.profile.backup ? '' : ` You can claim any time; after ${fmtDate(s.releasedAt + CLAIM_WINDOW)} a backup heir may claim first if there is one.`}
          </p>
        </section>
      )}

      {status === 'claimed' && (
        <section className="card claimed">
          <span className="seal-press tone-armed" aria-hidden="true"><Logo size={56} /></span>
          <div>
            <h2 className="disp">Your share is <em>with you.</em></h2>
            <p className="muted">
              It arrived at your new address. It can never be claimed again by anyone. On the public ledger it shows only
              as a one-time stamp, with no name attached.
            </p>
          </div>
        </section>
      )}

      <p className="small muted heir-foot">
        <Icon d={ICONS.letter} size={14} />
        {me.profile.backup
          ? `You hold an heir key and a letter from ${OWNER_FIRST} naming you as the backup for one share. Neither works alone.`
          : `You hold an heir key and a letter from ${OWNER_FIRST}. Neither works alone, and the letter never shows your name on-chain.`}{' '}
        You don't need to understand blockchains to use this page.
      </p>
    </div>
  );
}
