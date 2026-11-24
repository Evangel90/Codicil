// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { Phase } from '@codicil/contracts/vault';
import { duration, PhaseBadge } from '../components/ui.js';
import { CLAIM_WINDOW, demo, fmtDate, OWNER_NAME, type HeirProfile, type Snapshot } from '../demo/store.js';

export function HeirView({ s, id }: { s: Snapshot; id: HeirProfile['id'] }) {
  const me = s.heirs.find((h) => h.profile.id === id)!;
  const primary = s.heirs.find((h) => !h.profile.backup && h.profile.leaf === me.profile.leaf)!;
  const busy = s.tx?.status === 'running';
  const released = s.phase === Phase.released;
  const backupOpensAt = s.releasedAt + CLAIM_WINDOW;

  let status: { title: string; body: string; canClaim: boolean };
  if (!me.named) {
    status = {
      title: 'You are no longer in this will',
      body: `${OWNER_NAME.split(' ')[0]} removed the backup heir in a later version. Your key cannot claim anything.`,
      canClaim: false,
    };
  } else if (!released) {
    status = {
      title: 'Nothing to claim yet',
      body: `${OWNER_NAME}'s vault is ${s.phase === Phase.pending ? 'in its countdown' : 'active'}. Your share can only be claimed after the will is released. Until then, nobody else can see that you are in it.`,
      canClaim: false,
    };
  } else if (me.claimed) {
    status = { title: 'Claimed', body: 'This share has been paid out. It cannot be claimed twice.', canClaim: false };
  } else if (me.profile.backup && s.now < backupOpensAt) {
    status = {
      title: `You can claim from ${fmtDate(backupOpensAt)} if Ada has not`,
      body: `You are the backup heir for Ada's share. She has ${duration(backupOpensAt - s.now)} left to claim it first.`,
      canClaim: false,
    };
  } else if (me.unlockAt > s.now) {
    status = {
      title: `Unlocks on ${fmtDate(me.unlockAt)}`,
      body: `Your share is held for you until then (${duration(me.unlockAt - s.now)}).`,
      canClaim: false,
    };
  } else {
    status = { title: 'Your share is ready', body: 'Claiming proves you hold the key named in the will, without revealing which entry is yours.', canClaim: true };
  }

  return (
    <div className="stack" style={{ ['--gap' as string]: '28px' }}>
      <section className={`alive ${released ? 'alive-released' : ''}`}>
        <PhaseBadge phase={s.phase} />
        <h2 className="countdown">{status.title}</h2>
        <p className="muted">{status.body}</p>
        {status.canClaim && (
          <button type="button" className="btn btn-seal alive-btn" disabled={busy} onClick={() => void demo.claim(id)}>
            Claim {me.amount.toLocaleString()} demo tokens
          </button>
        )}
      </section>

      <section className="facts" aria-label="Your share">
        <div><span className="muted small">You are</span><strong className="private">{me.profile.name}, {me.profile.relation.toLowerCase()}</strong></div>
        <div><span className="muted small">Your share</span><strong className="private">{Number(primary.shareBps) / 100}%{released ? `, ${me.amount.toLocaleString()} tokens` : ''}</strong></div>
        <div><span className="muted small">What you hold</span><strong>An heir key, given to you privately by {OWNER_NAME.split(' ')[0]}</strong></div>
      </section>

      <p className="muted small">
        Each payout goes to a brand-new address, so it cannot be traced to you, to the other heirs, or to this
        vault's owner.
      </p>
    </div>
  );
}
