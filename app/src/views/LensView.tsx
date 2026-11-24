// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Privacy lens: the will as the owner sees it, beside the ledger as everyone
// else sees it. Hovering or focusing a row lights up the public value that
// stands for it, which is the same sealed number for every row.

import { useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { Hash } from '../components/ui.js';
import { fmtDate, GUARDIANS, type Snapshot } from '../demo/store.js';

type Focus = 'will' | 'guardians' | 'owner' | 'claims' | undefined;

export function LensView({ s }: { s: Snapshot }) {
  const [focus, setFocus] = useState<Focus>();
  const on = (f: Focus) => ({
    onMouseEnter: () => setFocus(f), onMouseLeave: () => setFocus(undefined),
    onFocus: () => setFocus(f), onBlur: () => setFocus(undefined), tabIndex: 0,
  });
  const lit = (f: Focus) => (focus === f ? ' is-lit' : '');
  const phaseWord = s.phase === Phase.armed ? 'armed' : s.phase === Phase.pending ? 'pending' : 'released';

  return (
    <div className="lens">
      <p className="lede lens-intro">
        Left: what the owner, heirs and guardians know. Right: everything the public ledger holds. Point at a row to see
        what it turns into.
      </p>
      <div className="lens-grid">
        <section aria-labelledby="lens-private" className="lens-private">
          <h2 id="lens-private">Known privately</h2>
          <h3 className="lens-sub">The will</h3>
          <ul className="lens-rows">
            {s.heirs.filter((h) => !h.profile.backup).map((h, i) => (
              <li key={h.profile.id} className={`lens-row${lit('will')}`} {...on('will')}>
                <span className="private">{h.profile.name}</span>
                <span className="private">{Number(h.shareBps) / 100}%</span>
                <span className="private small">{h.unlockAt ? `from ${fmtDate(h.unlockAt)}` : 'on release'}{h.profile.id === 'ada' && s.heirs.find((x) => x.profile.id === 'kofi')!.named ? ', backup Kofi' : ''}</span>
                <span className="hash small" aria-label={`Entry ${i + 1} hash`}>leaf {s.leafHashes[i]?.slice(0, 6)}…</span>
              </li>
            ))}
          </ul>
          <h3 className="lens-sub">Guardians, any 2 of 3</h3>
          <ul className="lens-rows">
            {GUARDIANS.map((g) => (
              <li key={g.id} className={`lens-row${lit('guardians')}`} {...on('guardians')}>
                <span className="private">{g.name}</span>
                <span className="muted small">{s.votedThisRound.includes(g.id) ? 'reported this round' : 'no report'}</span>
              </li>
            ))}
          </ul>
          <h3 className="lens-sub">Owner</h3>
          <ul className="lens-rows">
            <li className={`lens-row${lit('owner')}`} {...on('owner')}>
              <span className="private">{s.passkey?.kind === 'device' ? 'A passkey on this device (Face ID / Touch ID)' : 'A demo key held in this browser tab'}</span>
            </li>
          </ul>
          <h3 className="lens-sub">Claims</h3>
          <ul className="lens-rows">
            {s.heirs.filter((h) => h.claimed && !h.profile.backup).map((h) => (
              <li key={h.profile.id} className={`lens-row${lit('claims')}`} {...on('claims')}>
                <span className="private">{h.profile.name}'s share was claimed</span>
              </li>
            ))}
            {!s.heirs.some((h) => h.claimed) && <li className="muted small">No claims yet.</li>}
          </ul>
        </section>

        <section aria-labelledby="lens-public" className="lens-public">
          <h2 id="lens-public">On the public ledger</h2>
          <dl className="ledger">
            <div><dt>Contract</dt><dd><Hash value={s.chain.address} /></dd></div>
            <div><dt>phase</dt><dd>{phaseWord}</dd></div>
            <div className={lit('will')}><dt>willRoot</dt><dd><Hash value={s.chain.willRoot} /></dd></div>
            <div><dt>deadline</dt><dd>{fmtDate(s.deadline)}</dd></div>
            <div><dt>estate</dt><dd>{(s.estate + s.estatePaid).toLocaleString()} in, {s.estatePaid.toLocaleString()} paid</dd></div>
            <div className={lit('owner')}><dt>ownerPasskeyCommit</dt><dd><Hash value={s.chain.ownerPasskeyCommit} /></dd></div>
            <div className={lit('owner')}><dt>nonce</dt><dd>{s.nonce.toString()} check-in{s.nonce === 1n ? '' : 's'}</dd></div>
            <div className={lit('guardians')}><dt>guardianRoot</dt><dd><Hash value={s.chain.guardianRoot} /></dd></div>
            <div className={lit('guardians')}><dt>guardianVotes</dt><dd>{s.guardianVotes.toString()} of {s.guardianThreshold.toString()} (round {s.guardianRound.toString()})</dd></div>
            <div className={lit('claims')}><dt>claimNullifiers</dt>
              <dd>{s.chain.claimNullifiers.length === 0 ? 'none' : s.chain.claimNullifiers.map((n) => <Hash key={n} value={n} />)}</dd>
            </div>
          </dl>
          <p className="muted small">
            Not on the ledger at all: names, shares, unlock dates, the backup heir, who the guardians are, which guardian
            reported, which heir claimed, and the passkey itself.
          </p>
        </section>
      </div>
    </div>
  );
}
