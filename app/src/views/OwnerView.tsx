// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The owner's vault: where the switch is, the check-in, the estate, and what
// has happened so far.

import { useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { Countdown, duration, FACE_ID, HashChip, Icon, PHASE } from '../components/ui.js';
import { days, demo, fmtDate, fmtShort, OWNER_FIRST, TOKEN, type Snapshot } from '../demo/store.js';
import { Activity } from './Activity.js';
import type { Tab } from './Demo.js';

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

function Lifecycle({ phase }: { phase: Phase }) {
  return (
    <ol className="lifecycle" aria-label="Vault lifecycle">
      {[Phase.armed, Phase.pending, Phase.released].map((p) => {
        const meta = PHASE[p];
        const cur = p === phase;
        return (
          <li key={p} aria-current={cur ? 'step' : undefined} className={`tone-${meta.key} ${cur ? 'is-current' : ''}`}>
            <span className="mono life-label"><span className={`life-dot ${cur && p !== Phase.released ? 'pulse' : ''}`} aria-hidden="true" />{meta.label.toUpperCase()}</span>
            <span className="life-sentence hide-sm">{meta.sentence}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ProgressBar({ from, to, now, tone, ticks, labels }: {
  from: number; to: number; now: number; tone: string; ticks: number[]; labels: [string, string, string];
}) {
  const pos = (t: number) => Math.min(100, Math.max(0, ((t - from) / Math.max(1, to - from)) * 100));
  const w = pos(now);
  return (
    <div className="pbar">
      <div className={`pbar-track tone-${tone}`} aria-hidden="true">
        <span className="pbar-rail" />
        <span className="pbar-fill" style={{ width: `${w}%` }} />
        {ticks.map((t) => <span key={t} className="pbar-tick" style={{ left: `${pos(t)}%` }} />)}
        <span className="pbar-knob" style={{ left: `${w}%` }} />
      </div>
      <div className="pbar-labels"><span>{labels[0]}</span><span className="hide-sm">{labels[1]}</span><span>{labels[2]}</span></div>
    </div>
  );
}

export function OwnerView({ s, openTab }: { s: Snapshot; openTab: (t: Tab) => void }) {
  const [amount, setAmount] = useState<string>();
  const [whatIf, setWhatIf] = useState(false);
  const busy = s.tx?.status === 'running';
  const setup = s.setup!;
  const named = s.heirs.filter((h) => !h.profile.backup);
  const claimed = named.filter((h) => h.claimed).length;
  const overdue = s.phase === Phase.armed && s.now >= s.deadline;

  const deposit = async () => {
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0) return;
    if (await demo.deposit(BigInt(n))) setAmount(undefined);
  };

  return (
    <div className="owner">
      <div className="owner-head">
        <h1 className="disp h-sm">{greeting()}, <span className="it">{OWNER_FIRST}.</span></h1>
        <span className="small muted vault-id">Vault <HashChip value={s.chain.address} /></span>
      </div>

      <Lifecycle phase={s.phase} />

      <div className="split">
        <section className="split-main" aria-labelledby="st-h">
          {s.phase === Phase.armed && (
            <div className="stack-20">
              <h2 id="st-h" className="sub">
                {overdue ? `Your check-in was due on ${fmtDate(s.deadline)}. Check in now, before anyone starts the switch.` : 'Your next check-in is due in'}
              </h2>
              <Countdown seconds={s.deadline - s.now} />
            </div>
          )}
          {s.phase === Phase.pending && (
            <div className="stack-18">
              <h2 id="st-h" className="disp big h-sm">
                Your heirs' claim opens in <span className="mono tone-pending num">{duration(s.pendingUntil - s.now)}</span>.{' '}
                <span className="it">If you're here,</span> tap to cancel.
              </h2>
              <p className="lede">
                {s.guardianVotes >= s.guardianThreshold && s.guardianThreshold > 0n
                  ? `${s.guardianVotes} of your guardians reported your death, so the switch has started.`
                  : `We didn't receive a check-in before ${fmtDate(s.deadline)}, so the switch has started.`}{' '}
                Nothing has been released. Cancelling takes one {s.passkey?.kind === 'device' ? 'Face ID' : 'passkey'} touch and resets your deadline.
              </p>
            </div>
          )}
          {s.phase === Phase.released && (
            <>
              <div className="stack-18">
                <h2 id="st-h" className="disp big h-sm">This will has been <span className="it">released.</span></h2>
                <p className="lede">
                  The challenge window closed on {fmtDate(s.pendingUntil)}. Heirs are claiming privately. This page is now read-only.
                </p>
              </div>
              <dl className="stats">
                <div><dt className="eyebrow">Estate at release</dt><dd className="mono">{s.estateSnapshot.toLocaleString()}</dd></div>
                <div><dt className="eyebrow">Claimed so far</dt><dd className="mono">{s.estatePaid.toLocaleString()}</dd></div>
                <div><dt className="eyebrow">Shares claimed</dt><dd className="mono">{claimed} of {named.length}</dd></div>
              </dl>
            </>
          )}

          {s.phase === Phase.armed && (
            <ProgressBar
              from={s.lastCheckIn} to={s.deadline} now={s.now} tone={overdue ? 'pending' : 'armed'}
              ticks={[s.deadline - 7 * 86_400, s.deadline - 86_400].filter((t) => t > s.lastCheckIn)}
              labels={[`Last check-in · ${fmtShort(s.lastCheckIn)}`, 'Reminders 7 days and 1 day before', `Deadline · ${fmtShort(s.deadline)}`]}
            />
          )}
          {s.phase === Phase.pending && (
            <ProgressBar
              from={s.pendingUntil - setup.window} to={s.pendingUntil} now={s.now} tone="pending" ticks={[]}
              labels={[`Switch started · ${fmtShort(s.pendingUntil - setup.window)}`, `${days(setup.window)}-day challenge window`, `Will opens · ${fmtShort(s.pendingUntil)}`]}
            />
          )}

          {s.phase === Phase.armed && (
            <div className="alive-row">
              <button type="button" className="btn btn-primary btn-lg alive btn-xl" disabled={busy} onClick={() => void demo.checkIn()}>
                <Icon d={FACE_ID} size={20} />I'm alive
              </button>
              <span className="alive-note">
                One touch with {s.passkey?.kind === 'device' ? 'Face ID' : 'your demo key'}. Your deadline moves to {days(setup.every)} days from now, and nobody can tell it was you.
              </span>
            </div>
          )}
          {s.phase === Phase.pending && (
            <div className="stack-18">
              <div className="alive-row">
                <button type="button" className="btn btn-primary btn-lg alive btn-xl" disabled={busy} onClick={() => void demo.checkIn()}>
                  I'm here, cancel the switch
                </button>
                <button type="button" className="linkish" aria-expanded={whatIf} onClick={() => setWhatIf(!whatIf)}>What happens if I don't?</button>
              </div>
              {whatIf && (
                <p className="lede fade-in">
                  On {fmtDate(s.pendingUntil)} anyone can release the will. Each heir then proves, privately, that they are
                  named in it and claims their share to a fresh address. Nobody learns who they are.
                </p>
              )}
            </div>
          )}
        </section>

        <aside className="card estate" aria-label="Estate">
          <div className="estate-top">
            <span className="eyebrow">Estate balance</span>
            <div className="estate-amount"><span className="mono">{s.estate.toLocaleString()}</span><span className="mono unit">{TOKEN}</span></div>
            {amount === undefined ? (
              <div className="btn-pair">
                <button type="button" className="btn btn-secondary btn-sm" disabled={s.phase !== Phase.armed || busy} onClick={() => setAmount('5000')}>Deposit</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => document.getElementById('act-h')?.scrollIntoView({ behavior: 'smooth' })}>History</button>
              </div>
            ) : (
              <form className="deposit" onSubmit={(e) => { e.preventDefault(); void deposit(); }}>
                <label className="sr-only" htmlFor="dep">Amount to deposit</label>
                <input id="dep" className="field mono" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} autoFocus />
                <button type="submit" className="btn btn-primary btn-sm" disabled={!Number(amount) || busy}>Add</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAmount(undefined)}>Cancel</button>
              </form>
            )}
          </div>
          <dl className="estate-facts">
            <div><dt>Will</dt><dd>Version {(s.willVersion + 1n).toString()} · sealed</dd></div>
            <div><dt>Heirs</dt><dd className="tone-private">{named.length} · names private</dd></div>
            <div><dt>Guardian votes</dt><dd>{s.guardianVotes.toString()} of {s.guardianThreshold.toString()} · round {(s.guardianRound + 1n).toString()}</dd></div>
            <div><dt>Rhythm</dt><dd>Every {days(setup.every)} days · {days(setup.window)}-day window</dd></div>
          </dl>
          <button type="button" className="rowlink lens-link" onClick={() => openTab('lens')}>
            <span className="lens-icon" aria-hidden="true"><span /><span /></span>
            <span className="lens-text"><span>Open the Privacy Lens</span><span>See exactly what the chain knows</span></span>
            <span aria-hidden="true" className="muted">→</span>
          </button>
        </aside>
      </div>

      <Activity s={s} />
    </div>
  );
}
