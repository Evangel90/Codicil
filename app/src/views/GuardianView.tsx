// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { Phase } from '@codicil/contracts/vault';
import { PhaseBadge } from '../components/ui.js';
import { CHALLENGE, DAY, demo, GUARDIANS, OWNER_NAME, type Snapshot } from '../demo/store.js';

export function GuardianView({ s, id }: { s: Snapshot; id: number }) {
  const g = GUARDIANS[id];
  const busy = s.tx?.status === 'running';
  const voted = s.votedThisRound.includes(id);
  const armed = s.phase === Phase.armed;

  return (
    <div className="stack" style={{ ['--gap' as string]: '28px' }}>
      <section className="alive">
        <PhaseBadge phase={s.phase} />
        <h2 className="countdown">
          {!armed ? 'No report needed' : voted ? 'Your report is recorded' : `Has ${OWNER_NAME.split(' ')[0]} died?`}
        </h2>
        <p className="muted">
          {!armed
            ? s.phase === Phase.pending
              ? 'The countdown is already running.'
              : 'The will has been released.'
            : voted
              ? `${s.guardianVotes.toString()} of ${s.guardianThreshold.toString()} guardians have reported. If ${OWNER_NAME.split(' ')[0]} checks in, every report is cancelled.`
              : `If ${s.guardianThreshold.toString()} of the ${GUARDIANS.length} guardians report, a ${CHALLENGE / DAY}-day countdown starts. ${OWNER_NAME.split(' ')[0]} can cancel it by checking in. Nobody can see which guardians reported, or who the guardians are.`}
        </p>
        {armed && !voted && (
          <button type="button" className="btn alive-btn" disabled={busy} onClick={() => void demo.guardianReport(id)}>
            Report {OWNER_NAME.split(' ')[0]}'s death
          </button>
        )}
      </section>

      <section className="facts" aria-label="Guardian">
        <div><span className="muted small">You are</span><strong className="private">{g.name}, {g.relation.toLowerCase()}</strong></div>
        <div><span className="muted small">Reports this round</span><strong>{s.guardianVotes.toString()} of {s.guardianThreshold.toString()} needed</strong></div>
        <div><span className="muted small">What you hold</span><strong>A guardian secret, never published</strong></div>
      </section>
    </div>
  );
}
