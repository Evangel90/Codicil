// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The owner's screens in live mode: the vault being created (eight
// transactions, resumable), and the vault itself with its check-in, its
// estate and the invitations to send.

import { useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { Countdown, duration, FACE_ID, HashChip, Icon, ICONS, Logo, PHASE } from '../../components/ui.js';
import { kitLink } from '../../live/records.js';
import { walletReadiness } from '../../live/problems.js';
import { live, session, type Connection } from '../../live/session.js';
import { fmtWhen, span, type DeployProgress, type OwnerView } from '../../live/store.js';
import { formatNight, networkName, parseNight } from '../../live/wallet.js';
import { AnyoneCan, CopyLine, downloadText, ProblemCard, ProofServerNote } from './parts.js';

const STAGE_WORDS: Record<string, string> = {
  keys: 'Fetching what the proof needs',
  proving: 'Preparing the transaction',
  approving: 'Waiting for you to approve it in your wallet',
  submitting: 'Sending it to the network',
  finalizing: 'Waiting for the network to confirm it',
};

/** Creating the vault: what is happening, why there are several approvals, and how to carry on after an interruption. */
export function LiveDeploy({ me, deploy, connection }: { me: OwnerView; deploy?: DeployProgress; connection: Connection }) {
  const d = me.deployment;
  const total = deploy?.total ?? (d ? 1 + d.deferred.length : 8);
  const done = deploy?.done ?? (d ? (d.deployTxHash ? 1 : 0) + d.inserted.length : 0);
  const running = deploy?.running === true;
  const wallet = connection.walletName ?? 'your wallet';
  return (
    <main className="wrap page narrow stack-32" id="main">
      <div className="stack-18">
        <span className="eyebrow">{running ? 'Creating your vault' : 'Your vault is not finished'}</span>
        <h1 className="disp h-sm">
          {running ? <>Transaction {Math.min(done + 1, total)} of {total}.</> : done > 0 ? <>{done} of {total} transactions are done.</> : <>Nothing has been sent yet.</>}
        </h1>
        <p className="lede">
          {running
            ? `Keep this tab open and approve each request in ${wallet}. There are ${total} in all, because the vault's rules are too large for one block on Midnight: the first transaction creates the vault and seals your will, and the others add the remaining rules one at a time.`
            : done > 0
              ? 'Your vault exists and your will is sealed in it, but some of its rules have not been added yet. Until they are, it cannot be used. Nothing is lost: carry on from where it stopped.'
              : 'Everything you entered is saved in this browser. Creating the vault has not started, or its first transaction did not go through.'}
        </p>
      </div>

      <section className="card pad-24 stack-16" aria-label="Progress">
        <div className="pbar">
          <div className="pbar-track tone-armed" aria-hidden="true">
            <span className="pbar-rail" /><span className="pbar-fill" style={{ width: `${(done / total) * 100}%` }} />
          </div>
          <div className="pbar-labels"><span>{done} done</span><span className="hide-sm">about 20 seconds each, once approved</span><span>{total} in all</span></div>
        </div>
        {running && deploy && (
          <div className="stack-6" role="status" aria-live="polite">
            <strong>{deploy.label}</strong>
            <span className="muted">{deploy.stage ? STAGE_WORDS[deploy.stage] : 'Getting the next transaction ready'}.</span>
            <span className="bar" aria-hidden="true"><span /></span>
          </div>
        )}
        {d && <span className="small muted">Vault address <HashChip value={d.address} /> on Midnight {networkName(connection.network ?? '')}</span>}
      </section>

      {!running && deploy?.problem && <ProblemCard problem={deploy.problem} />}
      {!running && <ProofServerNote up={connection.proofServerUp} keys={connection.provingKeys} />}
      {!running && (
        <div className="btn-row">
          <button type="button" className="btn btn-primary btn-lg" disabled={connection.proofServerUp === false || connection.provingKeys === false} onClick={() => void live.resumeDeployment(me.id)}>
            {done > 0 ? `Continue with the remaining ${total - done}` : 'Create the vault'}
          </button>
          <span className="small muted">The app first checks the network to see which transactions already went through, so nothing is done twice.</span>
        </div>
      )}
      <p className="small muted">
        Closing this tab part-way is safe. Your will, your heirs' keys and the key that finishes the vault are saved in this
        browser, and this page continues the next time you open it.
      </p>
    </main>
  );
}

function Invitations({ me }: { me: OwnerView }) {
  const [open, setOpen] = useState<string>();
  const people = [
    ...me.heirs.flatMap((h) => [
      { key: h.id, name: h.name, role: `Heir · ${Number(h.shareBps) / 100}%${h.unlockAt ? ` · from ${new Date(h.unlockAt * 1000).toLocaleDateString('en-GB')}` : ''}`, kit: () => live.heirKit(h.id) },
      ...(h.backupName ? [{ key: `${h.id}:backup`, name: h.backupName, role: `Backup for ${h.name}`, kit: () => live.heirKit(h.id, true) }] : []),
    ]),
    ...me.guardians.map((g) => ({ key: g.id, name: g.name, role: 'Guardian', kit: () => live.guardianKit(g.id) })),
  ];
  return (
    <section className="stack-16" aria-labelledby="inv-h">
      <div className="stack-6">
        <h2 id="inv-h" className="disp h-card">Invitations to send</h2>
        <p className="muted">
          Each person needs their invitation to act from their own browser: an heir to claim, a guardian to vote. Send each one
          privately, to that person only. An heir's invitation holds the key to their share, so whoever has it can claim it once
          the will is released.
        </p>
      </div>
      <ul className="people">
        {people.map((p) => {
          const kit = open === p.key ? p.kit() : undefined;
          return (
            <li key={p.key}>
              <span><span className="people-name">{p.name}</span> <span className="small muted">{p.role}</span></span>
              <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open === p.key} onClick={() => setOpen(open === p.key ? undefined : p.key)}>
                {open === p.key ? 'Hide the invitation' : 'Show the invitation'}
              </button>
              {kit && (
                <div className="live-kit stack-12 fade-in">
                  <CopyLine text={kitLink(window.location.origin, kit)} shown={`${window.location.origin}/#/app/join/${kit.slice(0, 40)}…`} label="Copy the link" />
                  <div className="btn-row">
                    <button
                      type="button" className="btn btn-ghost btn-sm"
                      onClick={() => downloadText(`codicil-invitation-${p.name.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}.txt`, [
                        `Codicil invitation for ${p.name}, from ${me.ownerName}.`,
                        '',
                        `Keep this file private. Open ${window.location.origin}/#/app in Chrome with the Lace wallet,`,
                        'choose "I was given an invitation", and paste the line below.',
                        '',
                        kit,
                        '',
                      ].join('\n'))}
                    >
                      Download as a file
                    </button>
                    <span className="small muted">The link and the file hold the same thing. Either is enough.</span>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function LiveOwner({ me, now, busy, connection }: { me: OwnerView; now: number; busy: boolean; connection: Connection }) {
  const [amount, setAmount] = useState<string>();
  const v = me.vault!;
  const armed = v.phase === Phase.armed;
  const key = me.passkey === 'device' ? 'Face ID, Touch ID or your device PIN' : 'the key stored in this browser';
  const star = amount === undefined ? undefined : parseNight(amount);
  const readiness = connection.balances && walletReadiness(connection.balances, 'call', { network: connection.network, wallet: connection.walletName, address: connection.address?.bech32 });
  const blocked = busy || connection.proofServerUp === false || connection.provingKeys === false;

  const deposit = async () => {
    if (star === undefined) return;
    if (await live.deposit(star)) setAmount(undefined);
  };

  return (
    <main className="wrap page" id="main">
      <div className="owner">
        <div className="owner-head">
          <h1 className="disp h-sm">Your vault, <span className="it">{me.ownerName}.</span></h1>
          <span className="small muted vault-id">Vault <HashChip value={v.address} /> on Midnight {networkName(connection.network ?? '')}</span>
        </div>

        <ol className="lifecycle" aria-label="Vault lifecycle">
          {[Phase.armed, Phase.pending, Phase.released].map((p) => (
            <li key={p} aria-current={p === v.phase ? 'step' : undefined} className={`tone-${PHASE[p].key} ${p === v.phase ? 'is-current' : ''}`}>
              <span className="mono life-label"><span className={`life-dot ${p === v.phase && p !== Phase.released ? 'pulse' : ''}`} aria-hidden="true" />{PHASE[p].label}</span>
              <span className="life-sentence hide-sm">{PHASE[p].sentence}</span>
            </li>
          ))}
        </ol>

        <ProofServerNote up={connection.proofServerUp} keys={connection.provingKeys} />
        {readiness && v.phase !== Phase.released && <ProblemCard problem={readiness} onRetry={() => void session.refresh()} retryLabel="Check again" />}

        <div className="split">
          <section className="split-main" aria-labelledby="st-h">
            {armed && me.checkIn === 'onTime' && (
              <div className="stack-20">
                <h2 id="st-h" className="sub">Your next check-in is due in</h2>
                <Countdown seconds={v.deadline - now} />
                <span className="small muted">By {fmtWhen(v.deadline)}.</span>
              </div>
            )}
            {armed && me.checkIn === 'grace' && (
              <div className="stack-20">
                <h2 id="st-h" className="sub">You missed your check-in on {fmtWhen(v.deadline)}. You are inside your {span(v.grace)} grace period: check in before it ends and nothing else happens. It ends in</h2>
                <Countdown seconds={v.switchOpensAt - now} />
              </div>
            )}
            {armed && me.checkIn === 'expired' && (
              <div className="stack-18">
                <h2 id="st-h" className="disp big h-sm">Your check-in was due by {fmtWhen(v.deadline)}.</h2>
                <p className="lede">
                  Anyone can now start the switch, and a check-in alone no longer works. Once the switch has started you can cancel it
                  with one check-in, for {span(v.window)}. Starting it yourself is the quickest way back.
                </p>
              </div>
            )}
            {v.phase === Phase.pending && (
              <div className="stack-18">
                <h2 id="st-h" className="disp big h-sm">
                  Your heirs can claim in <span className="mono tone-pending num">{duration(v.pendingUntil - now)}</span>. <span className="it">If you are here,</span> cancel now.
                </h2>
                <p className="lede">
                  The switch has started{v.guardianThreshold > 0 && v.guardianVotes >= v.guardianThreshold ? ' because your guardians reported your death' : ' because no check-in arrived in time'}.
                  Nothing has been released. One check-in cancels it and sets a new deadline. You have until {fmtWhen(v.pendingUntil)}.
                </p>
              </div>
            )}
            {v.phase === Phase.released && (
              <>
                <div className="stack-18">
                  <h2 id="st-h" className="disp big h-sm">This will has been <span className="it">released.</span></h2>
                  <p className="lede">The time to cancel ended on {fmtWhen(v.pendingUntil)}. Each heir can now claim their share with their invitation. This page can no longer change anything.</p>
                </div>
                <dl className="stats">
                  <div><dt className="eyebrow">Estate at release</dt><dd className="mono">{formatNight(v.estateSnapshot)}</dd></div>
                  <div><dt className="eyebrow">Claimed so far</dt><dd className="mono">{formatNight(v.estatePaid)}</dd></div>
                  <div><dt className="eyebrow">Still in the vault</dt><dd className="mono">{formatNight(v.estate)}</dd></div>
                </dl>
              </>
            )}

            {armed && me.checkIn !== 'expired' && (
              <div className="alive-row">
                <button type="button" className="btn btn-primary btn-lg alive btn-xl" disabled={blocked} onClick={() => void live.checkIn()}>
                  <Icon d={FACE_ID} size={20} />I'm alive
                </button>
                <span className="alive-note">
                  You confirm with {key}, then approve one transaction in {connection.walletName ?? 'your wallet'}. Your deadline moves to {span(me.timers.every)} from now.
                  The proof for a check-in is the largest one: the first time, the app fetches a 448 MB file for it, and making the proof takes about half a minute.
                </span>
              </div>
            )}
            {armed && me.checkIn === 'expired' && (
              <div className="alive-row">
                <button type="button" className="btn btn-primary btn-lg" disabled={blocked || !v.canStartSwitch} onClick={() => void live.startSwitch()}>Start the switch so I can cancel it</button>
                <span className="alive-note">
                  Nothing is released by starting it. You then cancel with one check-in.
                  {!v.canStartSwitch && ' The button unlocks in a few seconds: the network\'s clock runs slightly behind yours.'}
                </span>
              </div>
            )}
            {v.phase === Phase.pending && (
              <div className="alive-row">
                <button type="button" className="btn btn-primary btn-lg alive btn-xl" disabled={blocked} onClick={() => void live.checkIn()}>I'm here, cancel the switch</button>
                <span className="alive-note">If you do nothing, anyone can release the will after {fmtWhen(v.pendingUntil)}, and each heir can then claim their share.</span>
              </div>
            )}

            <Invitations me={me} />

            <section className="activity" aria-labelledby="act-h">
              <div className="activity-head"><h2 id="act-h" className="disp h-card">What has happened</h2></div>
              <ul className="people">
                {me.activity.map((a, i) => (
                  <li key={i}>
                    <span><span className={`dot tone-${a.tone === 'plain' ? 'armed' : a.tone}`} aria-hidden="true" /> {a.what}</span>
                    <span className="small muted">{fmtWhen(a.at)}{a.txHash && <> · transaction <HashChip value={a.txHash} /></>}</span>
                  </li>
                ))}
              </ul>
              <span className="small muted">This list is kept in this browser. It shows what you did here, not what others did.</span>
            </section>
          </section>

          <aside className="card estate" aria-label="Estate">
            <div className="estate-top">
              <span className="eyebrow">In the vault</span>
              <div className="estate-amount"><span className="mono">{formatNight(v.estate)}</span><span className="mono unit">tNIGHT</span></div>
              {!armed ? null : amount === undefined ? (
                <div className="btn-pair">
                  <button type="button" className="btn btn-secondary btn-sm" disabled={blocked} onClick={() => setAmount('10')}>Add tNIGHT</button>
                </div>
              ) : (
                <form className="deposit" onSubmit={(e) => { e.preventDefault(); void deposit(); }}>
                  <label className="sr-only" htmlFor="dep">Amount of tNIGHT to add</label>
                  <input id="dep" className="field mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} autoFocus />
                  <button type="submit" className="btn btn-primary btn-sm" disabled={star === undefined || blocked}>Add</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAmount(undefined)}>Cancel</button>
                </form>
              )}
              <span className="small muted">
                {armed
                  ? 'tNIGHT is a test token with no value. What you add moves from your wallet into the vault and stays there until the will is released. This version cannot take it back out, and the amount is public.'
                  : v.phase === Phase.pending ? 'Nothing can be added while the switch is running. Cancel it first.' : 'What is left is what heirs have not claimed yet, and any part of the estate the will did not allocate.'}
              </span>
            </div>
            <dl className="estate-facts">
              <div><dt>Heirs</dt><dd className="tone-private">{me.heirs.length} · names private</dd></div>
              <div><dt>Guardians</dt><dd>{me.guardians.length === 0 ? 'None' : `${v.guardianVotes} of ${v.guardianThreshold} votes this round`}</dd></div>
              <div><dt>Rhythm</dt><dd>Every {span(me.timers.every)} · {v.grace > 0 ? `${span(v.grace)} of grace · ` : ''}{span(v.window)} to cancel</dd></div>
              <div><dt>Check-ins so far</dt><dd>{v.nonce.toString()}</dd></div>
              <div><dt>Signs with</dt><dd>{me.passkey === 'device' ? 'A passkey on this device' : 'A key stored in this browser'}</dd></div>
            </dl>
          </aside>
        </div>

        {v.canRelease && <AnyoneCan vault={v} busy={blocked} who="you" onStart={() => void live.startSwitch()} onRelease={() => void live.release()} />}
      </div>
    </main>
  );
}

/** Shown once, right after the last transaction of a new vault. */
export function Sealed({ deadline, onDone }: { deadline: number; onDone: () => void }) {
  return (
    <main className="wrap page narrow" id="main">
      <div className="card deploy">
        <span className="seal-press" aria-hidden="true"><Logo size={56} /></span>
        <h2 className="disp">Your will is <em>sealed.</em></h2>
        <p className="muted">
          The vault is created. Your first check-in is due by {fmtWhen(deadline)}. Two things to do now: save a backup file, and
          send each heir and guardian their invitation. Both are on the next screen.
        </p>
        <button type="button" className="btn btn-primary" onClick={onDone} autoFocus>Go to my vault</button>
      </div>
    </main>
  );
}
