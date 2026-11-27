// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// A vault read as a signal, the way a canary is read: while its owner keeps
// checking in, a statement they stand behind holds. When the check-ins stop,
// everyone can see it, and nobody has to say anything. The status comes from
// the vault's public ledger; the statement's fingerprint from the seal register.

import { useState } from 'react';
import { signal } from '../demo/guide.js';
import { demo, fmtDate, type Snapshot } from '../demo/store.js';

const TONE = { checkingIn: 'armed', silent: 'pending', released: 'released' } as const;

export const STATEMENT_EXAMPLE = 'As of today, nobody has ordered us to hand over data, or to keep quiet about an order.';

/** The vault's public status in plain words, with the owner's statement if there is one. */
export function SignalCard({ s, mine = false }: { s: Snapshot; mine?: boolean }) {
  const sig = signal(s);
  const st = s.register.statement;
  return (
    <section className="card signal" aria-labelledby="sig-h">
      <span className="small muted">{mine ? 'What anyone sees on your public page' : 'This vault, read as a signal'}</span>
      <h2 id="sig-h" className="disp signal-title">
        <span className={`dot tone-${TONE[sig.state]}`} aria-hidden="true" />{sig.title}
      </h2>
      <p>{sig.detail}</p>
      {st && (
        <>
          <blockquote className="signal-quote">{st.text}</blockquote>
          <p className="small muted">
            {st.genuine
              ? `The owner stood behind this statement on ${fmtDate(st.at)}: its fingerprint is on the seal register, so the page cannot have changed it. `
              : 'This text does not match the fingerprint on the seal register. Do not rely on it. '}
            {sig.state === 'checkingIn'
              ? 'It holds for as long as the check-ins continue.'
              : 'The check-ins have stopped, so it no longer holds.'}
          </p>
        </>
      )}
    </section>
  );
}

/** Where the owner writes the statement their public page shows. */
export function StatementEditor({ s }: { s: Snapshot }) {
  const [text, setText] = useState(s.register.statement?.text ?? '');
  const busy = s.tx?.status === 'running';
  const same = text.trim() === (s.register.statement?.text ?? '');
  return (
    <section className="card pad-24 stack-16" aria-labelledby="stmt-h">
      <div className="stack-6">
        <h2 id="stmt-h" className="disp h-card">A public signal</h2>
        <p className="small muted">
          Your vault's status is public: checking in, gone silent, or released. Put a statement next to it that is true
          while you keep checking in, and people can watch one page instead of waiting to hear from you. This is how
          a canary works. Going silent says it for you.
        </p>
      </div>
      <label className="field-label">
        Your statement
        <textarea className="field" rows={3} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" disabled={busy || same || !text.trim()} onClick={() => void demo.setStatement(text)}>
          Stand behind this statement
        </button>
        <button type="button" className="linkish" onClick={() => setText(STATEMENT_EXAMPLE)}>Use an example</button>
      </div>
      <SignalCard s={s} mine />
    </section>
  );
}
