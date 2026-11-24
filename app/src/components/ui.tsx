// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { useEffect, useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { demo, type Tx } from '../demo/store.js';

/** The Codicil mark: a wax seal pressed over a folded page, with a keyhole. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M6 4h14l6 6v18H6z" fill="none" stroke="var(--vellum-dim)" strokeWidth="1.5" />
      <path d="M20 4v6h6" fill="none" stroke="var(--vellum-dim)" strokeWidth="1.5" />
      <circle cx="16" cy="19" r="7" fill="var(--brass)" />
      <circle cx="16" cy="17.6" r="1.7" fill="var(--brass-ink)" />
      <path d="M15.2 18.6h1.6l.6 3.6h-2.8z" fill="var(--brass-ink)" />
    </svg>
  );
}

const PHASES = {
  [Phase.armed]: { word: 'Active', cls: 'phase-armed', meaning: 'The owner is checking in. Nothing happens.' },
  [Phase.pending]: { word: 'Countdown', cls: 'phase-pending', meaning: 'The owner may have died. They can still cancel.' },
  [Phase.released]: { word: 'Released', cls: 'phase-released', meaning: 'Heirs can claim their shares.' },
} as const;

export function PhaseBadge({ phase, explain = false }: { phase: Phase; explain?: boolean }) {
  const p = PHASES[phase];
  return (
    <span className={`phase ${p.cls}`}>
      <PhaseIcon phase={phase} />
      {p.word}
      {explain && <span className="muted phase-meaning">{p.meaning}</span>}
    </span>
  );
}

function PhaseIcon({ phase }: { phase: Phase }) {
  if (phase === Phase.armed) {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10h4l2-5 4 10 2-5h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
    );
  }
  if (phase === Phase.pending) {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M10 5.5V10l3 2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14v10H3z M3 6l7 5 7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
  );
}

/** A hash shortened to 0x7c3a…e91f, copyable, read aloud by its ending. */
export function Hash({ value, full = false }: { value: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  const v = value.startsWith('0x') ? value.slice(2) : value;
  const shown = full ? `0x${v}` : `0x${v.slice(0, 6)}…${v.slice(-4)}`;
  return (
    <button
      type="button"
      className="hash hash-chip"
      aria-label={`Hash ending ${v.slice(-4)}. Copy`}
      onClick={() => {
        void navigator.clipboard?.writeText(`0x${v}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? 'Copied' : shown}
    </button>
  );
}

export function duration(seconds: number): string {
  if (seconds <= 0) return 'now';
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

/** Progress sheet for every action: stages, elapsed time, outcome. */
export function TxSheet({ tx }: { tx?: Tx }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (tx?.status !== 'running') return;
    const id = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [tx?.status]);
  if (!tx) return null;
  const elapsed = ((tx.endedAt ?? performance.now()) - tx.startedAt) / 1000;
  return (
    <div className="sheet" role="dialog" aria-modal="false" aria-labelledby="tx-title">
      <div className="sheet-head">
        <h3 id="tx-title">{tx.title}</h3>
        <span className="muted">{elapsed.toFixed(1)} s</span>
      </div>
      <ol className="stages">
        {tx.stages.map((s, i) => {
          const state = tx.status === 'error' && i === tx.current ? 'failed'
            : i < tx.current || tx.status === 'done' ? 'done'
            : i === tx.current ? 'active' : 'todo';
          return (
            <li key={s.id} className={`stage stage-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
              <span className="stage-dot" aria-hidden="true" />
              <div>
                <div className="stage-label">{s.label}</div>
                {state === 'active' && <div className="muted stage-detail">{s.detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {tx.status !== 'running' && (
        <div className={`sheet-result ${tx.status === 'error' ? 'is-error' : 'is-done'}`} role="status">
          <p>{tx.message}</p>
          <button type="button" className="btn btn-quiet" onClick={() => demo.dismissTx()}>Close</button>
        </div>
      )}
    </div>
  );
}
