// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// A guardian's page: what their vote does, a deliberate confirmation, and
// the only thing the chain records, a count.

import { useEffect, useId, useRef, useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { Icon, ICONS } from '../components/ui.js';
import { days, demo, fmtDate, fmtShort, GUARDIANS, OWNER_FIRST, type Snapshot } from '../demo/store.js';

function Confirm({ onClose, onVote }: { onClose: () => void; onVote: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [sure, setSure] = useState(false);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    d?.addEventListener('close', onClose);
    return () => d?.removeEventListener('close', onClose);
  }, [onClose]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Before you vote</h2>
      <p className="muted">
        This is a serious statement. If you're wrong, {OWNER_FIRST} can cancel during the challenge window. Your vote
        can't be taken back, but it also can't move any money by itself.
      </p>
      <label className="check">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        I have reliable knowledge that {OWNER_FIRST} has died.
      </label>
      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>Go back</button>
        <button type="button" className="btn btn-danger" disabled={!sure} onClick={() => { ref.current?.close(); onVote(); }}>
          Cast my vote
        </button>
      </div>
    </dialog>
  );
}

export function GuardianView({ s, id }: { s: Snapshot; id: number }) {
  const [confirming, setConfirming] = useState(false);
  const me = GUARDIANS[id];
  const k = Number(s.guardianThreshold);
  const n = GUARDIANS.length;
  const votes = Number(s.guardianVotes);
  const voted = s.votedThisRound.includes(id);
  const busy = s.tx?.status === 'running';
  const win = days(s.setup!.window);
  const started = s.phase !== Phase.armed;

  return (
    <div className="guardian split">
      <div className="split-main stack-32">
        <div className="stack-18">
          <span className="eyebrow eyebrow-icon"><Icon d={ICONS.check} size={14} stroke={2.2} />Membership proven, anonymously · {me.name}</span>
          <h1 className="disp h-sm">You are one of the guardians of a will.</h1>
          <p className="lede">
            {OWNER_FIRST} trusted you to say, if it ever comes to it, that they have died. Your device proves you're one of
            their guardians without revealing which one, even to the other guardians.
          </p>
        </div>

        <section className="card pad-24 stack-16">
          <h2 className="disp h-card">What your vote does</h2>
          <ol className="numbered">
            <li><span className="mono">1</span><span>When <strong>{k} of {n}</strong> guardians vote, the switch starts, even if the owner's deadline hasn't passed.</span></li>
            <li><span className="mono">2</span><span>The owner then has a <strong>{win}-day challenge window</strong>. If they're alive, one touch cancels everything and resets the votes.</span></li>
            <li><span className="mono">3</span><span>Only after the window ends can heirs claim. Your vote alone never moves any money.</span></li>
          </ol>
          <details className="disclose">
            <summary>What does “round {(s.guardianRound + 1n).toString()}” mean?</summary>
            <p>Each time the owner checks in, the vote count resets and a new round starts. Old votes can't be reused, so a single mistaken vote can't pile up over time.</p>
          </details>
        </section>

        {voted ? (
          <div className="card pad-24 voted">
            <span className="ok-ring"><Icon d={ICONS.check} size={20} stroke={1.8} /></span>
            <div className="stack-6">
              <strong>Your vote is recorded.</strong>
              <span className="muted">
                {s.phase === Phase.pending
                  ? `Votes reached ${votes >= k ? k : votes} of ${k}, so the switch has started. ${OWNER_FIRST} can cancel until ${fmtDate(s.pendingUntil)}. Thank you for carrying this.`
                  : `Votes are ${votes} of ${k}. Nobody can see who voted, only how many.`}
              </span>
            </div>
          </div>
        ) : started ? (
          <p className="lede">
            {s.phase === Phase.pending ? `The switch has already started. ${OWNER_FIRST} can cancel until ${fmtDate(s.pendingUntil)}.` : 'The will has been released. There is nothing more for guardians to do.'}
          </p>
        ) : (
          <div className="btn-row">
            <button type="button" className="btn btn-danger btn-lg" disabled={busy} onClick={() => setConfirming(true)}>
              I confirm the owner has died
            </button>
            <span className="small muted">You'll be asked to confirm once more.</span>
          </div>
        )}
      </div>

      <aside className="split-side stack-16">
        <section className="card pad-24 stack-12" aria-label="Vote count">
          <div className="row-between"><span className="eyebrow">Round {(s.guardianRound + 1n).toString()}</span><span className="eyebrow">{k} needed</span></div>
          <div className="mono votes-big">{Math.min(votes, n)} <span className="muted">of {n}</span></div>
          <div className="vote-dots" aria-hidden="true">
            {GUARDIANS.map((g, i) => <span key={g.id} className={i < votes ? 'on' : ''} />)}
          </div>
          <span>{votes >= k ? 'Threshold reached. The challenge window is open.' : `${k - votes} more vote${k - votes === 1 ? '' : 's'} would start the switch.`}</span>
          <span className="small muted">The chain stores only this number. Who voted is never recorded.</span>
        </section>
        <section className="card pad-24 stack-8">
          <span className="eyebrow">Vault status</span>
          <span className={`state-line tone-${s.phase === Phase.armed ? 'armed' : s.phase === Phase.pending ? 'pending' : 'released'}`}>
            <Icon d={ICONS.clock} size={14} stroke={2} />
            {s.phase === Phase.armed ? 'Armed' : s.phase === Phase.pending ? 'Pending' : 'Released'}
          </span>
          <span className="small muted">
            {s.phase === Phase.armed ? `Owner's deadline: ${fmtShort(s.deadline)}. They are still checking in.`
              : s.phase === Phase.pending ? `The owner can still cancel until ${fmtShort(s.pendingUntil)}.`
              : `Released on ${fmtShort(s.releasedAt)}.`}
          </span>
        </section>
      </aside>

      {confirming && <Confirm onClose={() => setConfirming(false)} onVote={() => void demo.guardianReport(id)} />}
    </div>
  );
}
