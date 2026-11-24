// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Heir letters: what the owner hands each heir, on paper or by message.
// Each letter holds the heir's will entry and its proof of membership, never
// their secret key, and works only with the current version of the will.

import { useEffect, useMemo, useRef, useState } from 'react';
import { encode } from 'uqr';
import { decodeHeirLetter, letterFingerprint } from '@codicil/sdk';
import { demo, fmtDate, HEIRS, OWNER_NAME, type HeirProfile, type Snapshot } from '../demo/store.js';

function Qr({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
    return { size: qr.size, path: d };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function Letter({ s, id, onClose }: { s: Snapshot; id: HeirProfile['id']; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const h = HEIRS.find((x) => x.id === id)!;
  const text = demo.letterFor(id);
  const print = letterFingerprint(decodeHeirLetter(text));
  const entry = s.heirs.find((x) => x.profile.id === id)!;
  const first = OWNER_NAME.split(' ')[0];

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    const close = () => onClose();
    d?.addEventListener('close', close);
    return () => d?.removeEventListener('close', close);
  }, [onClose]);

  return (
    <dialog ref={ref} className="letter-dialog" aria-labelledby="letter-title">
      <article className="letter">
        <header>
          <p className="letter-kicker">A letter from {OWNER_NAME}</p>
          <h2 id="letter-title">For {h.name}</h2>
        </header>
        <div className="letter-body">
          <div className="letter-text">
            <p>
              {h.backup
                ? `You are the backup for one share of my estate. If its main heir has not claimed it within 30 days of my will being released, you can.`
                : `You are named in my will. When it is released, open Codicil with the heir key you created and this letter, and claim your share.`}
            </p>
            <p>
              Keep this letter with the heir key you created. The letter alone cannot claim anything, and the key alone
              does not know which share is yours.
            </p>
            {entry.unlockAt > 0 && !h.backup && <p>Your share unlocks on {fmtDate(entry.unlockAt)}.</p>}
            <p className="muted small">
              Letter {print} · will version {(s.willVersion + 1n).toString()}. If {first} changes the will, this letter
              stops working and you will get a new one.
            </p>
          </div>
          <Qr text={text} label={`QR code holding ${h.name}'s heir letter`} />
        </div>
        <details className="letter-raw">
          <summary>Letter as text</summary>
          <code className="hash">{text}</code>
        </details>
      </article>
      <div className="letter-actions">
        <button type="button" className="btn btn-seal" onClick={() => window.print()}>Print</button>
        <button
          type="button"
          className="btn"
          onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true); }}
        >
          {copied ? 'Copied' : 'Copy as text'}
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => ref.current?.close()}>Close</button>
      </div>
    </dialog>
  );
}

export function HeirLetters({ s }: { s: Snapshot }) {
  const [open, setOpen] = useState<HeirProfile['id']>();
  const recipients = s.heirs.filter((h) => h.named);
  return (
    <section aria-labelledby="letters-title" className="stack">
      <h2 id="letters-title">Heir letters</h2>
      <p className="muted small">
        Give each heir their letter in person or in a sealed envelope. It tells them which share is theirs and proves it
        is in the will, without revealing anything to anyone else.
        {s.willVersion > 0n && ' You changed the will, so letters given out before that no longer work. Hand out these new ones.'}
      </p>
      <ul className="letter-list">
        {recipients.map((h) => (
          <li key={h.profile.id}>
            <span className="private">{h.profile.name}</span>
            <span className="muted small">{h.profile.backup ? 'backup for Ada' : `${Number(h.shareBps) / 100}%`}</span>
            <button type="button" className="btn btn-quiet" onClick={() => setOpen(h.profile.id)}>
              Open {h.profile.name}'s letter
            </button>
          </li>
        ))}
      </ul>
      {open && <Letter s={s} id={open} onClose={() => setOpen(undefined)} />}
    </section>
  );
}
