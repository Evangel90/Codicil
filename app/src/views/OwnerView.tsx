// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { duration, PhaseBadge } from '../components/ui.js';
import { demo, fmtDate, OWNER_NAME, type Snapshot } from '../demo/store.js';
import { Timeline } from './Timeline.js';
import { WillEditor } from './WillEditor.js';

export function OwnerView({ s }: { s: Snapshot }) {
  const left = s.deadline - s.now;
  const busy = s.tx?.status === 'running';
  const viaDevice = s.passkey?.kind === 'device';
  const [editing, setEditing] = useState(false);
  const canEdit = s.phase === Phase.armed && s.now < s.deadline;
  const kofi = s.heirs.find((h) => h.profile.id === 'kofi')!;

  return (
    <div className="owner stack" style={{ ['--gap' as string]: '28px' }}>
      {s.phase === Phase.armed && (
        <section className="alive" aria-labelledby="alive-title">
          <PhaseBadge phase={s.phase} explain />
          <h2 id="alive-title" className="countdown">
            {left > 0 ? <>Next check-in due in <span className="num">{duration(left)}</span></> : 'Your check-in deadline has passed'}
          </h2>
          <p className="muted">Deadline: {fmtDate(s.deadline)}. Checking in moves it 30 days from today.</p>
          {left > 0 ? (
            <button type="button" className="btn btn-seal alive-btn" disabled={busy} onClick={() => void demo.checkIn()}>
              I'm alive{viaDevice ? ', confirm with Face ID / Touch ID' : ''}
            </button>
          ) : (
            <p>Once anyone starts the countdown you will have a week to cancel it with a check-in.</p>
          )}
        </section>
      )}

      {s.phase === Phase.pending && (
        <section className="alive alive-pending" aria-labelledby="pending-title" role="alert">
          <PhaseBadge phase={s.phase} explain />
          <h2 id="pending-title" className="countdown">
            Your heirs can claim in <span className="num">{duration(s.pendingUntil - s.now)}</span>
          </h2>
          <p>
            Someone started the countdown. If you are here, confirm it is you and the countdown stops. Every
            guardian report made so far stops counting too.
          </p>
          <button type="button" className="btn btn-seal alive-btn" disabled={busy || s.now >= s.pendingUntil} onClick={() => void demo.checkIn()}>
            I'm here, cancel the countdown
          </button>
        </section>
      )}

      {s.phase === Phase.released && (
        <section className="alive alive-released">
          <PhaseBadge phase={s.phase} explain />
          <h2 className="countdown">This vault was released on {fmtDate(s.releasedAt)}</h2>
          <p className="muted">It can no longer be changed. Switch to an heir above to see their side.</p>
        </section>
      )}

      <section className="facts" aria-label="Vault summary">
        <div><span className="muted small">Estate</span><strong>{s.estate.toLocaleString()} demo tokens</strong></div>
        <div><span className="muted small">Heirs</span><strong>3{kofi.named ? ', plus 1 backup' : ''}</strong></div>
        <div><span className="muted small">Guardian reports this round</span><strong>{s.guardianVotes.toString()} of {s.guardianThreshold.toString()} needed</strong></div>
        <div><span className="muted small">Check-ins</span><strong>{s.nonce.toString()}</strong></div>
      </section>

      {s.phase === Phase.armed && (
        <div className="row-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void demo.deposit(5_000n)}>Add 5,000 demo tokens</button>
        </div>
      )}

      <section aria-labelledby="will-title" className="stack">
        <div className="will-head">
          <h2 id="will-title">Your will</h2>
          {canEdit && !editing && (
            <button type="button" className="btn btn-quiet" onClick={() => setEditing(true)}>Change the will</button>
          )}
        </div>
        <p className="muted small">
          Only you can read this. It lives on your device; the chain holds a single sealed number
          {s.willVersion > 0n ? ` (version ${(s.willVersion + 1n).toString()})` : ''}.
        </p>
        {editing && canEdit ? <WillEditor s={s} onDone={() => setEditing(false)} /> : (
        <table className="will">
          <thead><tr><th>Heir</th><th>Share</th><th>Available</th></tr></thead>
          <tbody>
            {s.heirs.filter((h) => !h.profile.backup).map((h) => (
              <tr key={h.profile.id}>
                <td className="private">{h.profile.name} <span className="muted small">{h.profile.relation}</span>
                  {h.profile.id === 'ada' && kofi.named && <div className="muted small">Backup: Kofi, if Ada does not claim within 30 days</div>}
                </td>
                <td className="private">{Number(h.shareBps) / 100}%</td>
                <td className="private">{h.unlockAt ? `From ${fmtDate(h.unlockAt)}` : 'On release'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </section>

      <Timeline items={s.activity} title={`${OWNER_NAME}'s vault activity`} />
    </div>
  );
}
