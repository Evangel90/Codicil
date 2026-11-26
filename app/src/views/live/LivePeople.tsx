// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The screens for the two people an owner invites: an heir, who waits and
// then claims with their own wallet, and a guardian, who can vote.

import { useEffect, useId, useRef, useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { HashChip, Icon, ICONS, Logo } from '../../components/ui.js';
import { walletReadiness } from '../../live/problems.js';
import { live, session, type Connection } from '../../live/session.js';
import { fmtWhen, span, type GuardianView, type HeirView } from '../../live/store.js';
import { formatNight, networkName } from '../../live/wallet.js';
import { AnyoneCan, PhaseLine, ProblemCard, ProofServerNote, shortAddress } from './parts.js';

export function LiveHeir({ me, now, busy, connection }: { me: HeirView; now: number; busy: boolean; connection: Connection }) {
  const v = me.vault!;
  const owner = me.ownerName;
  const share = `${Number(me.shareBps) / 100}%`;
  const blocked = busy || connection.proofServerUp === false || connection.provingKeys === false;
  const to = connection.address;
  const readiness = connection.balances && walletReadiness(connection.balances, 'call', { network: connection.network, wallet: connection.walletName, address: to?.bech32 });
  const firstHeirUntil = v.releasedAt + v.claimWindow;
  const copy: Record<NonNullable<HeirView['status']>, [string, string]> = {
    stale: ['This invitation no longer matches the will.', `${owner} changed the will after sending it, or it is for a different vault. It cannot claim anything. Ask ${owner} for a new invitation. If none comes, you may no longer be named.`],
    locked: ['You are named in a will.', `${owner} included you in their will. It is sealed, which means ${owner} is checking in. There is nothing you need to do, and nothing you can do yet.`],
    pending: ['The will may open soon.', `${owner} has not checked in, so a waiting period has started. If ${owner} is well, one check-in cancels it. Nothing has been released. It ends on ${fmtWhen(v.pendingUntil)}.`],
    waiting: me.backup
      ? [`You may be able to claim on ${fmtWhen(firstHeirUntil)}.`, 'You are the backup for this share. Its first heir can claim it until then. If they do, there is nothing for you to claim, which is how it should be.']
      : [`Your share will be ready on ${fmtWhen(me.opensAt ?? me.unlockAt)}.`, `The will has been released. ${owner} asked that your share become available on a particular date. Until then it is held in the vault, and nobody else can take it.`],
    claimable: ['Your share is ready when you are.', 'We are sorry for your loss. There is no rush: your share stays in the vault until you claim it.'],
    claimed: [`Thank you, ${me.name}.`, 'Your share has been paid to your wallet. Everything is complete.'],
    taken: ['This share has already been claimed.', me.backup ? 'Its first heir claimed it in time, so there is nothing left for you to claim.' : 'It was claimed by the backup named for it, after the time you had to claim it first had passed. It cannot be claimed twice.'],
  };
  const [title, body] = copy[me.status ?? 'locked'];
  const stepIdx = me.status === 'waiting' ? 1 : me.status === 'claimable' || me.status === 'claimed' ? 2 : 0;
  const steps: [string, string][] = [['Sealed', 'The owner is checking in'], ['Waiting', 'Released, opens on a set date'], ['Ready', 'Yours to claim']];

  return (
    <main className="wrap page" id="main">
      <div className="heir narrow">
        <div className="heir-head">
          <span className="eyebrow">For {me.name} · from {owner}{me.backup ? ' · backup heir' : ''}</span>
          <h1 className="disp">{title}</h1>
          <p className="lede">{body}</p>
        </div>

        {me.status !== 'stale' && me.status !== 'taken' && (
          <ol className="steps3" aria-label="Status of your share">
            {steps.map(([label, sub], i) => (
              <li key={label} aria-current={i === stepIdx ? 'step' : undefined} className={i < stepIdx || me.status === 'claimed' ? 'is-done' : i === stepIdx ? 'is-current' : ''}>
                <span className="steps3-label"><span className="mono steps3-mark">{i < stepIdx || me.status === 'claimed' ? '✓' : i + 1}</span>{label}</span>
                <span className="small muted">{sub}</span>
              </li>
            ))}
          </ol>
        )}

        <section className="card pad-24 stack-12" aria-label="Your share">
          <div className="claim-top">
            <span>Your share · {share}</span>
            <span className="mono claim-amount">{formatNight(me.claimed?.amount ?? me.amount ?? 0n)} <span className="unit">tNIGHT</span></span>
          </div>
          <span className="small muted">
            {v.phase === Phase.released
              ? `${share} of the ${formatNight(v.estateSnapshot)} tNIGHT the vault held when it was released.`
              : `${share} of what the vault holds today, ${formatNight(v.estate)} tNIGHT. The amount is fixed when the will is released.`}
            {' '}tNIGHT is a test token and has no value.
          </span>
          <PhaseLine vault={v} />
          <span className="small muted">Vault <HashChip value={v.address} /> on Midnight {networkName(connection.network ?? '')}</span>
        </section>

        {me.status !== 'stale' && me.status !== 'claimed' && me.status !== 'taken' && (
          <>
            <ProofServerNote up={connection.proofServerUp} keys={connection.provingKeys} />
            {(v.canStartSwitch || v.canRelease || me.status === 'claimable') && readiness && <ProblemCard problem={readiness} onRetry={() => void session.refresh()} retryLabel="Check again" />}
            <AnyoneCan vault={v} busy={blocked} who={owner} onStart={() => void live.startSwitch()} onRelease={() => void live.release()} />
          </>
        )}

        {me.status === 'claimable' && to && (
          <section className="card claim fade-in" aria-labelledby="claim-h">
            <h2 id="claim-h" className="disp h-card">Claim your share</h2>
            <p className="muted">
              It is paid to the wallet you are connected with, <span className="mono">{shortAddress(to.bech32)}</span>. Your browser proves
              that you are named in the will without saying which heir you are. Your wallet pays the network fee, less than 1 DUST.
            </p>
            <button type="button" className="btn btn-primary btn-lg" disabled={blocked} onClick={() => void live.claim(to.hex)}>
              Claim {formatNight(me.amount ?? 0n)} tNIGHT to my wallet
            </button>
            <p className="small muted">
              The payment is visible on the network as a transfer from the vault to your address.
              {me.backup ? '' : ` You can claim at any time. If a backup was named for your share, they may claim it after ${fmtWhen(firstHeirUntil)} if you have not.`}
            </p>
          </section>
        )}

        {me.status === 'claimed' && me.claimed && (
          <section className="card claimed">
            <span className="seal-press tone-armed" aria-hidden="true"><Logo size={56} /></span>
            <div>
              <h2 className="disp">Your share is <em>with you.</em></h2>
              <p className="muted">
                {formatNight(me.claimed.amount)} tNIGHT was paid on {fmtWhen(me.claimed.at)}. It can never be claimed again by anyone.
                {me.claimed.txHash && <> Transaction <HashChip value={me.claimed.txHash} /></>}
              </p>
            </div>
          </section>
        )}

        <p className="small muted heir-foot">
          <Icon d={ICONS.letter} size={14} />
          Your invitation is saved in this browser. Keep the copy {owner} sent you as well: if this browser's data is cleared, you
          will need it again, or a backup file.
        </p>
      </div>
    </main>
  );
}

function ConfirmVote({ owner, onClose, onVote }: { owner: string; onClose: () => void; onVote: () => void }) {
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
        This is a serious statement. If you are wrong, {owner} can cancel during the challenge window. Your vote cannot be taken
        back, but it also cannot move any money by itself.
      </p>
      <label className="check">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        I have reliable knowledge that {owner} has died.
      </label>
      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>Go back</button>
        <button type="button" className="btn btn-danger" disabled={!sure} onClick={() => { ref.current?.close(); onVote(); }}>Cast my vote</button>
      </div>
    </dialog>
  );
}

export function LiveGuardian({ me, busy, connection }: { me: GuardianView; busy: boolean; connection: Connection }) {
  const [confirming, setConfirming] = useState(false);
  const v = me.vault!;
  const owner = me.ownerName;
  const blocked = busy || connection.proofServerUp === false || connection.provingKeys === false;
  const readiness = connection.balances && walletReadiness(connection.balances, 'call', { network: connection.network, wallet: connection.walletName, address: connection.address?.bech32 });

  if (me.current === false) {
    return (
      <main className="wrap page" id="main">
        <div className="guardian narrow stack-18">
          <h1 className="disp h-sm">You are no longer a guardian of this vault.</h1>
          <p className="lede">
            {me.name}, {owner} has changed the guardians, or this invitation is for a different vault. The proof in this browser no
            longer matches what the network holds, so a vote from here would be refused. The network does not say who was removed or why.
          </p>
          <p className="lede">There is nothing you need to do. If you think this is a mistake, ask {owner} for a new invitation.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="wrap page" id="main">
      <div className="guardian split">
        <div className="split-main stack-32">
          <div className="stack-18">
            <span className="eyebrow eyebrow-icon"><Icon d={ICONS.check} size={14} stroke={2.2} />For {me.name} · from {owner}</span>
            <h1 className="disp h-sm">You are one of the guardians of {owner}'s vault.</h1>
            <p className="lede">
              {owner} trusted you to say, if it ever comes to it, that they have died. Your browser proves you are one of the
              guardians without revealing which one, even to the other guardians.
            </p>
          </div>

          <section className="card pad-24 stack-16">
            <h2 className="disp h-card">What your vote does</h2>
            <ol className="numbered">
              <li><span className="mono">1</span><span>When <strong>{v.guardianThreshold}</strong> {v.guardianThreshold === 1 ? 'guardian votes' : 'guardians vote'}, the switch starts, even if {owner}'s check-in is not yet due.</span></li>
              <li><span className="mono">2</span><span>{owner} then has <strong>{span(v.window)}</strong> to cancel. If they are alive, one check-in cancels everything and the votes start again from zero.</span></li>
              <li><span className="mono">3</span><span>Only after that can heirs claim. Your vote alone never moves any money.</span></li>
            </ol>
          </section>

          <ProofServerNote up={connection.proofServerUp} keys={connection.provingKeys} />
          {v.phase === Phase.armed && !me.voted && readiness && <ProblemCard problem={readiness} onRetry={() => void session.refresh()} retryLabel="Check again" />}

          {me.voted ? (
            <div className="card pad-24 voted">
              <span className="ok-ring"><Icon d={ICONS.check} size={20} stroke={1.8} /></span>
              <div className="stack-6">
                <strong>Your vote is recorded.</strong>
                <span className="muted">
                  {v.phase === Phase.pending
                    ? `Enough guardians agreed, so the switch has started. ${owner} can cancel until ${fmtWhen(v.pendingUntil)}. Thank you for carrying this.`
                    : `Votes are ${v.guardianVotes} of ${v.guardianThreshold}. Nobody can see who voted, only how many.`}
                </span>
              </div>
            </div>
          ) : v.phase !== Phase.armed ? (
            <p className="lede">
              {v.phase === Phase.pending ? `The switch has already started. ${owner} can cancel until ${fmtWhen(v.pendingUntil)}.` : 'The will has been released. There is nothing more for guardians to do.'}
            </p>
          ) : (
            <div className="btn-row">
              <button type="button" className="btn btn-danger btn-lg" disabled={blocked} onClick={() => setConfirming(true)}>I confirm {owner} has died</button>
              <span className="small muted">You will be asked to confirm once more. Your wallet pays the network fee, less than 1 DUST.</span>
            </div>
          )}

          <AnyoneCan vault={v} busy={blocked} who={owner} onStart={() => void live.startSwitch()} onRelease={() => void live.release()} />
        </div>

        <aside className="split-side stack-16">
          <section className="card pad-24 stack-12" aria-label="Vote count">
            <div className="row-between"><span className="eyebrow">This round</span><span className="eyebrow">{v.guardianThreshold} needed</span></div>
            <div className="mono votes-big">{v.guardianVotes} <span className="muted">of {v.guardianThreshold}</span></div>
            <span>
              {v.phase !== Phase.armed ? (v.guardianVotes >= v.guardianThreshold ? 'Enough guardians agreed.' : 'Votes are no longer being counted.')
                : `${v.guardianThreshold - v.guardianVotes} more ${v.guardianThreshold - v.guardianVotes === 1 ? 'vote' : 'votes'} would start the switch.`}
            </span>
            <span className="small muted">The network stores only this number. Who voted is never recorded. A check-in by {owner} starts a new round.</span>
          </section>
          <section className="card pad-24 stack-8">
            <span className="eyebrow">Vault status</span>
            <PhaseLine vault={v} />
            <span className="small muted">
              {v.phase === Phase.armed ? `${owner}'s next check-in is due by ${fmtWhen(v.deadline)}.` : v.phase === Phase.pending ? `${owner} can cancel until ${fmtWhen(v.pendingUntil)}.` : `Released on ${fmtWhen(v.releasedAt)}.`}
            </span>
            <span className="small muted">Vault <HashChip value={v.address} /> on Midnight {networkName(connection.network ?? '')}</span>
          </section>
        </aside>

        {confirming && <ConfirmVote owner={owner} onClose={() => setConfirming(false)} onVote={() => void live.vote()} />}
      </div>
    </main>
  );
}
