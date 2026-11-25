// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The inheritable position: a second contract, Harbour Savings, that holds
// tokens for one beneficiary and pays out only after it has asked the vault
// whether the will is released. Every withdrawal here runs the real escrow
// circuit, which calls the real vault circuit.

import { useState } from 'react';
import { sampleUserAddress } from '@midnight-ntwrk/compact-runtime';
import { HashChip, Icon, ICONS, Logo, short } from '../components/ui.js';
import { positionStage, type PositionStage } from '../demo/guide.js';
import { INTEGRATION_SOURCE } from '../demo/integration.js';
import { demo, fmtDate, HEIRS, OWNER_FIRST, TOKEN, type PositionAttempt, type Snapshot } from '../demo/store.js';

const STEPS: [PositionStage, string, string][] = [
  ['locked', 'Locked', 'Until the will is released'],
  ['open', 'Open', 'The beneficiary can withdraw'],
  ['paid', 'Paid out', 'Nothing left to withdraw'],
];

const WHY: Record<string, string> = {
  'vault not released': 'The savings contract ran the vault’s isReleasedForContract circuit, the vault answered no, and the contract stopped. Nothing moved.',
  'not the beneficiary': 'The secret did not match the commitment on the ledger, so the contract stopped before it asked the vault anything.',
  'already withdrawn': 'The savings contract pays once. Its ledger already says withdrawn.',
};

function LastAttempt({ a, name, amount, paidTo }: { a: PositionAttempt; name: string; amount: string; paidTo?: string }) {
  return (
    <section className="card attempt" aria-labelledby="att-h" role="status">
      <span className={a.ok ? 'ok-ring' : 'bad-ring'} aria-hidden="true"><Icon d={a.ok ? ICONS.check : ICONS.close} size={18} stroke={1.8} /></span>
      <div>
        <h2 id="att-h">{a.ok ? `Paid out on ${fmtDate(a.at)}` : `Refused on ${fmtDate(a.at)}`}</h2>
        {a.ok ? (
          <>
            <p>One transaction ran two circuits. On Midnight each one gets its own proof.</p>
            <ol className="calls">
              {(a.calls ?? []).map((c, i) => (
                <li key={c.circuit}>
                  <span className="mono calls-n" aria-hidden="true">{i + 1}</span>
                  <span>
                    <code className="mono">{c.contract === 'vault' ? 'vault' : 'savings'}.{c.circuit}</code>
                    <span className="small muted">
                      {c.contract === 'vault'
                        ? 'The vault answered yes: the will is released.'
                        : `${name} sent ${amount} ${TOKEN}${paidTo ? ` to ${short(paidTo)}` : ''}.`}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <>
            <p>
              {a.by} asked to withdraw, and {name} answered with its own error:{' '}
              {a.code ? <code className="mono attempt-code">{a.code}</code> : 'the request could not be read'}
            </p>
            {a.code && WHY[a.code] && <p className="small muted">{WHY[a.code]}</p>}
          </>
        )}
      </div>
    </section>
  );
}

export function SavingsView({ s }: { s: Snapshot }) {
  const p = s.position;
  const [to, setTo] = useState(() => sampleUserAddress());
  const busy = s.tx?.status === 'running';
  const stage = positionStage(s);
  const stageIdx = STEPS.findIndex(([id]) => id === stage);
  const heir = HEIRS.find((h) => h.id === p.beneficiary)!;
  const isOwner = s.actor.kind === 'owner';
  const isBeneficiary = s.actor.kind === 'heir' && s.actor.id === p.beneficiary;
  const amount = p.held.toLocaleString();
  const addrOk = /^[0-9a-f]{64}$/i.test(to);

  const lede = isBeneficiary
    ? `${OWNER_FIRST} keeps ${amount} ${TOKEN} in ${p.name}, a contract written by another team, and named you as its beneficiary. It points at her vault and pays you only when the vault says the will is released.`
    : isOwner
      ? `You also keep ${amount} ${TOKEN} in ${p.name}, a contract written by another team. You made that position inheritable: it points at your vault and names one beneficiary. It pays out only when your vault says the will is released.`
      : `${OWNER_FIRST} also keeps ${amount} ${TOKEN} in ${p.name}, a contract written by another team. She made that position inheritable: it points at her vault and names one beneficiary. It pays out only when the vault says the will is released.`;

  return (
    <div className="savings">
      <div className="owner-head">
        <div className="stack-12">
          <h1 className="disp h-sm">Savings that follow the will</h1>
          <p className="lede">{lede}</p>
        </div>
        <span className="small muted vault-id">{p.name} <HashChip value={p.address} /></span>
      </div>

      <ol className="steps3" aria-label="Status of the savings">
        {STEPS.map(([id, label, sub], i) => (
          <li key={id} aria-current={i === stageIdx ? 'step' : undefined} className={i < stageIdx || stage === 'paid' ? 'is-done' : i === stageIdx ? 'is-current' : ''}>
            <span className="steps3-label"><span className="mono steps3-mark">{i < stageIdx || stage === 'paid' ? '✓' : i + 1}</span>{label}</span>
            <span className="small muted">{sub}</span>
          </li>
        ))}
      </ol>

      <div className="split">
        <div className="split-main savings-main">
          {stage === 'paid' ? (
            <section className="card claimed" aria-labelledby="sv-h">
              <span className="seal-press tone-armed" aria-hidden="true"><Logo size={56} /></span>
              <div>
                <h2 id="sv-h" className="disp">Paid to the beneficiary</h2>
                <p className="muted">
                  {amount} {TOKEN} went to {p.paidTo ? short(p.paidTo) : 'a new address'}. {p.name} is closed now, and it refuses any further withdrawal.
                </p>
              </div>
            </section>
          ) : (
            <section className="card claim" aria-labelledby="sv-h">
              <div className="claim-top">
                <h2 id="sv-h" className="savings-label">Held for the beneficiary</h2>
                <span className="mono claim-amount">{amount} <span className="unit">{TOKEN}</span></span>
              </div>
              {isBeneficiary ? (
                <>
                  <label className="field-label">
                    Where should it go?
                    <input className="field mono" value={to} spellCheck={false} aria-invalid={!addrOk || undefined} onChange={(e) => setTo(e.target.value.trim())} />
                    <span className="small muted">
                      A new address is safest: nobody can link it to you or to {OWNER_FIRST}.{' '}
                      <button type="button" className="linkish" onClick={() => setTo(sampleUserAddress())}>Make another</button>
                    </span>
                  </label>
                  {!addrOk && <p className="err-inline" role="alert">That is not an address. It should be 64 hexadecimal characters; choose Make another for a new one.</p>}
                  <button type="button" className="btn btn-primary btn-lg" disabled={busy || !addrOk} onClick={() => void demo.withdrawPosition(s.actor, to)}>
                    Withdraw {amount} {TOKEN}
                  </button>
                  <p className="small muted">
                    {stage === 'locked'
                      ? `The will is not released, so ${p.name} will refuse. Try it: you will see the contract's own error, word for word.`
                      : `${p.name} checks your secret against its commitment, then asks the vault whether the will is released. Both run in one transaction.`}
                  </p>
                </>
              ) : (
                <>
                  <p className="savings-note">
                    Only {heir.name}'s device holds the secret that matches the beneficiary commitment, so only {heir.name} can withdraw.
                    {isOwner ? ' You cannot take them out early either: this contract pays only its beneficiary, and only after the release.' : ''}
                  </p>
                  <div className="btn-row">
                    <button type="button" className="btn btn-primary" onClick={() => demo.setActor({ kind: 'heir', id: p.beneficiary })}>
                      Act as {heir.name}
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void demo.withdrawPosition(s.actor)}>
                      Try to withdraw with a guessed secret
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {p.lastAttempt && <LastAttempt a={p.lastAttempt} name={p.name} amount={amount} paidTo={p.paidTo} />}

          <section className="card pad-24 stack-16" aria-labelledby="how-h">
            <h2 id="how-h" className="disp h-card">How {isOwner ? 'you' : OWNER_FIRST} made it inheritable</h2>
            <ol className="numbered">
              <li>
                <span className="mono">1</span>
                <span><strong>Pointed it at {isOwner ? 'your' : 'her'} vault.</strong> {p.name} stores the vault's address and will only ever ask that one vault.</span>
              </li>
              <li>
                <span className="mono">2</span>
                <span>
                  <strong>Named a beneficiary without naming anyone.</strong>{' '}
                  {isBeneficiary ? 'Your device' : `${heir.name}'s device`} made a secret and gave {isOwner ? 'you' : OWNER_FIRST} only its commitment.
                  The commitment is what went on the ledger.
                </span>
              </li>
              <li>
                <span className="mono">3</span>
                <span>
                  <strong>Left the rest to the will.</strong> There is no second deadline to keep alive. While {isOwner ? 'you keep' : `${OWNER_FIRST} keeps`} checking
                  in, the savings stay shut. When the will is released, they open.
                </span>
              </li>
            </ol>
          </section>
        </div>

        <aside className="card estate savings-ledger" aria-label={`What is public about ${p.name}`}>
          <div className="savings-side savings-public">
            <h2><Icon d={ICONS.chain} size={16} stroke={2} />What anyone can read</h2>
            <dl>
              <div><dt>Vault it asks</dt><dd><HashChip value={p.vault} /></dd></div>
              <div><dt>Amount held</dt><dd className="mono">{amount} {TOKEN}</dd></div>
              <div><dt>Beneficiary</dt><dd><HashChip value={p.beneficiaryCommit} /></dd></div>
              <div><dt>Withdrawn</dt><dd className="mono">{p.withdrawn ? 'yes' : 'no'}</dd></div>
            </dl>
            <p className="small">The beneficiary is stored as a commitment: a sealed fingerprint of a secret, not a name or an address.</p>
          </div>
          <div className="savings-side savings-private">
            <h2><Icon d={ICONS.phone} size={16} stroke={2} />What stays off the chain</h2>
            <dl>
              <div><dt>Who the beneficiary is</dt><dd>{heir.name}</dd></div>
              <div><dt>The beneficiary's secret</dt><dd>On {heir.name}'s device</dd></div>
            </dl>
            <p className="small">{p.name} never sees the will, the heirs or the guardians. It learns one thing from the vault: released, or not.</p>
          </div>
        </aside>
      </div>

      <section className="savings-dev stack-16" aria-labelledby="dev-h">
        <h2 id="dev-h" className="disp h-sec">The one line a developer writes</h2>
        <p className="lede">
          {p.name} knows nothing about wills. It declares the one question it wants to ask a Codicil vault, then asks it
          before it pays. Any Midnight contract can become inheritable the same way.
        </p>
        <pre className="code" tabIndex={0} aria-label="The integration in the savings contract, written in Compact">
          <code>
            {INTEGRATION_SOURCE.map((l, i) => {
              // Indentation is drawn as padding, so a long line wraps under its own start on a phone.
              const indent = l.text.length - l.text.trimStart().length;
              return (
                <span key={i} className={l.key ? 'code-line is-key' : 'code-line'} style={{ '--indent': indent } as React.CSSProperties}>
                  {l.text.trimStart() || ' '}
                </span>
              );
            })}
          </code>
        </pre>
        <p className="small muted savings-src">
          From <span className="mono">contracts/src/inheritable_escrow.compact</span>. The highlighted line is the whole integration.
          The vault answers it only for contracts: a person who calls <span className="mono">isReleasedForContract</span> directly is
          refused with “callable by contracts only”.
        </p>
      </section>
    </div>
  );
}
