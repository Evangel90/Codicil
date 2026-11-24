// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The owner's will: who gets what, changing it, and the letters for heirs.

import { useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { HashChip } from '../components/ui.js';
import { fmtShort, type Snapshot } from '../demo/store.js';
import { WillEditor } from './WillEditor.js';
import { HeirLetters } from './HeirLetters.js';
import { PlanSummary } from './PlanSummary.js';

export function WillView({ s }: { s: Snapshot }) {
  const [editing, setEditing] = useState(false);
  const canEdit = s.phase === Phase.armed && s.now < s.deadline;
  const rows = s.heirs.filter((h) => !h.profile.backup);
  const kofi = s.heirs.find((h) => h.profile.id === 'kofi')!;
  const total = rows.reduce((a, h) => a + Number(h.shareBps), 0) / 100;

  return (
    <div className="will stack-40">
      <div className="owner-head">
        <div className="stack-12">
          <span className="eyebrow">Version {(s.willVersion + 1n).toString()} · sealed</span>
          <h1 className="disp h-sm">Your <span className="it">will.</span></h1>
          <p className="lede">
            Everything on this page stays on your device. The chain holds one fingerprint of it, <HashChip value={s.chain.willRoot} />,
            which changes completely if anything changes.
          </p>
        </div>
        {!editing && (
          <button type="button" className="btn btn-secondary" disabled={!canEdit} onClick={() => setEditing(true)}>
            Change the will
          </button>
        )}
      </div>

      {editing ? <WillEditor s={s} onDone={() => setEditing(false)} /> : (
        <div className="table-wrap">
          <table className="will-table">
            <caption className="sr-only">Who inherits what</caption>
            <thead><tr><th scope="col">Heir</th><th scope="col">Share</th><th scope="col">Unlocks</th><th scope="col">Backup</th><th scope="col" className="num">Today</th></tr></thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.profile.id}>
                  <th scope="row"><span className="tone-private">{h.profile.name}</span> <span className="muted small">{h.profile.relation}</span></th>
                  <td className="mono">{Number(h.shareBps) / 100}%</td>
                  <td>{h.unlockAt > 0 ? fmtShort(h.unlockAt) : 'On release'}</td>
                  <td>{h.profile.id === 'ada' && kofi.named ? <span className="tone-private">Kofi</span> : <span className="muted">—</span>}</td>
                  <td className="mono num">{h.amount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">
            {total < 100 ? `${100 - total}% is not allocated and stays in the vault. ` : ''}
            {canEdit ? 'You can change the will any time before your deadline.' : 'The will can no longer be changed: the deadline has passed.'}
          </p>
        </div>
      )}

      <PlanSummary setup={s.setup!} now={s.now} title="Your rules, in plain words" />

      <HeirLetters s={s} />
    </div>
  );
}
