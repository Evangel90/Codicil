// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Obsidian building blocks shared by every screen.

import { useEffect, useState, type ReactNode } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { demo, type Toast as ToastT, type Tx } from '../demo/store.js';
import { toggleTheme, useTheme } from '../theme.js';

/** The Codicil mark: a seal ring with a keyhole. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="11" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="12" cy="12" r="7.6" stroke="currentColor" strokeWidth="0.8" strokeDasharray="0.6 2.2" strokeLinecap="round" />
      <circle cx="12" cy="10.4" r="1.9" fill="currentColor" />
      <path d="M11.2 11.6h1.6l.5 4.2h-2.6z" fill="currentColor" />
    </svg>
  );
}

export function Brand({ href = '#/' }: { href?: string }) {
  return (
    <a href={href} className="brand" aria-label="Codicil home">
      <Logo />
      <span className="disp brand-word">Codicil</span>
    </a>
  );
}

export const FACE_ID = 'M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9v1M15 9v1M12 9v4h-1M9.5 16c1.5 1 3.5 1 5 0';

export function Icon({ d, size = 18, stroke = 1.6 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const ICONS = {
  check: 'M20 6 9 17l-5-5',
  close: 'M6 6l12 12M18 6 6 18',
  sun: 'M12 4V2M12 22v-2M4.9 4.9 3.5 3.5M20.5 20.5l-1.4-1.4M4 12H2M22 12h-2M4.9 19.1l-1.4 1.4M20.5 3.5l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  lens: 'M12 3a9 9 0 1 0 0 18V3z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  phone: 'M8 2h8a2.5 2.5 0 0 1 2.5 2.5v15A2.5 2.5 0 0 1 16 22H8a2.5 2.5 0 0 1-2.5-2.5v-15A2.5 2.5 0 0 1 8 2zM11 18h2',
  chain: 'M3 3h7v7H3zM14 14h7v7h-7zM10 6.5h4v11',
  down: 'M12 5v14M6 13l6 6 6-6',
  letter: 'M3 6h18v12H3zM3 6l9 7 9-7',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  shield: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z',
} as const;

export function ThemeToggle() {
  const theme = useTheme();
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggleTheme}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <Icon d={theme === 'dark' ? ICONS.sun : ICONS.moon} size={17} stroke={1.5} />
    </button>
  );
}

/** Words for each vault state, shown with a dot and a sentence, never colour alone. */
export const PHASE = {
  [Phase.armed]: { key: 'armed', label: 'Armed', sentence: 'The owner is checking in. Nothing happens.' },
  [Phase.pending]: { key: 'pending', label: 'Pending', sentence: 'The switch has started. The owner can still cancel.' },
  [Phase.released]: { key: 'released', label: 'Released', sentence: 'Heirs can prove they are named and claim.' },
} as const;

export function StateTag({ phase, pulse = true }: { phase: Phase; pulse?: boolean }) {
  const p = PHASE[phase];
  return (
    <span className={`state-tag tone-${p.key}`}>
      <span className={`dot ${pulse && phase !== Phase.released ? 'pulse' : ''}`} aria-hidden="true" />
      {p.label}
    </span>
  );
}

/** A hash shortened to 0x7c3a…e91f (6+4), copyable, read aloud by its ending. */
export function HashChip({ value, tone = 'public', label }: { value: string; tone?: 'public' | 'private'; label?: string }) {
  const [copied, setCopied] = useState(false);
  const v = value.startsWith('0x') ? value.slice(2) : value;
  const shown = label ?? `0x${v.slice(0, 4)}…${v.slice(-4)}`;
  return (
    <button
      type="button"
      className={`chip ${tone === 'private' ? 'chip-private' : ''} ${copied ? 'chip-copied' : ''}`}
      aria-label={`${tone === 'private' ? 'Private value' : 'Hash'} ending ${v.slice(-4)}. Copy`}
      onClick={() => {
        void navigator.clipboard?.writeText(`0x${v}`).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? 'copied ✓' : shown}
      {!copied && <Icon d={ICONS.copy} size={12} stroke={2} />}
    </button>
  );
}

export const short = (hex: string) => `0x${hex.slice(0, 4)}…${hex.slice(-4)}`;

/** Days, hours, minutes and seconds, each at least 0. */
export function split(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return { d: Math.floor(s / 86_400), h: Math.floor((s % 86_400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

export function duration(seconds: number): string {
  if (seconds <= 0) return 'now';
  const { d, h, m } = split(seconds);
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${Math.max(1, m)}m`;
}

/** Four mono digit cells over hairlines, read by screen readers as one phrase. */
export function Countdown({ seconds, size = 'lg' }: { seconds: number; size?: 'lg' | 'md' }) {
  const t = split(seconds);
  const cells: [string, number][] = [['Days', t.d], ['Hours', t.h], ['Min', t.m], ['Sec', t.s]];
  return (
    <div
      className={`countdown countdown-${size}`}
      role="timer"
      aria-label={`${t.d} days ${t.h} hours ${t.m} minutes`}
    >
      {cells.map(([l, v]) => (
        <div key={l} className="cd-cell" aria-hidden="true">
          <span className="mono cd-v">{String(v).padStart(2, '0')}</span>
          <span className="eyebrow">{l}</span>
        </div>
      ))}
    </div>
  );
}

/** Rows of key and value over hairlines. */
export function Facts({ rows, className = '' }: { rows: [ReactNode, ReactNode, string?][]; className?: string }) {
  return (
    <dl className={`facts ${className}`}>
      {rows.map(([k, v, tone], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd className={tone ? `tone-${tone}` : undefined}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A segmented pill group; the active option is inverted. */
export function Segmented<T extends string | number>({
  label, options, value, onChange, size = 'md',
}: { label: string; options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; size?: 'sm' | 'md' }) {
  return (
    <div role="group" aria-label={label} className={`seg seg-${size}`}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const clock = (s: number) => {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

/** Glass progress sheet for every action: stages, timings, and the outcome. */
export function TxSheet({ tx }: { tx?: Tx }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (tx?.status !== 'running') return;
    const id = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [tx?.status]);
  useEffect(() => {
    if (!tx || tx.status === 'running') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') demo.dismissTx(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tx]);
  if (!tx) return null;
  const elapsed = ((tx.endedAt ?? performance.now()) - tx.startedAt) / 1000;
  const failed = tx.status === 'error';
  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) demo.dismissTx(); }}>
      <div className="sheet glass" role="dialog" aria-modal="true" aria-labelledby="tx-title">
        <div className="sheet-head">
          <h2 id="tx-title">{tx.title}</h2>
          <span className="mono sheet-time">{clock(elapsed)}</span>
        </div>
        <ol className="stages">
          {tx.stages.map((s, i) => {
            const state = failed && i === tx.current ? 'failed'
              : i < tx.current || tx.status === 'done' ? (s.skipped ? 'skip' : 'done')
              : i === tx.current && !failed ? 'active' : 'todo';
            const t = tx.times[i];
            return (
              <li key={s.id} className={`stage stage-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
                <span className="stage-dot" aria-hidden="true" />
                <div className="stage-body">
                  <span className="stage-label">{s.label}{s.tag && <span className="mono stage-tag"> · {s.tag}</span>}</span>
                  {state === 'active' && (
                    <>
                      <span className="stage-detail">{s.detail}</span>
                      <span className="bar" aria-hidden="true"><span /></span>
                    </>
                  )}
                </div>
                <span className="mono stage-t">{state === 'skip' ? '—' : t !== undefined && state === 'done' ? `${t.toFixed(1)}s` : ''}</span>
              </li>
            );
          })}
        </ol>
        {tx.status === 'running' && <p className="sheet-note">Nothing leaves this device until the last step.</p>}
        {tx.status === 'done' && (
          <div className="sheet-result" role="status">
            <Icon d={ICONS.check} size={18} stroke={2} />
            <p>{tx.message}</p>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => demo.dismissTx()} autoFocus>Close</button>
          </div>
        )}
        {failed && (
          <div className="err-row" role="status">
            <span className="mono err-tag">ERROR</span>
            <div className="err-body">
              <span>{tx.message}</span>
              {tx.code && <span className="mono err-code">{tx.code}</span>}
            </div>
            <div className="err-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void demo.retry()}>Try again</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => demo.dismissTx()} autoFocus>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Glass pill toast; auto-dismisses after 7 seconds. */
export function Toast({ toast }: { toast?: ToastT }) {
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => demo.dismissToast(), 7000);
    return () => clearTimeout(id);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className="toast glass" role="status" key={toast.id}>
      <span className="toast-icon"><Icon d={ICONS.check} size={16} stroke={2} /></span>
      <span className="toast-text">{toast.title}</span>
      <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => demo.dismissToast()}>
        <Icon d={ICONS.close} size={14} stroke={1.8} />
      </button>
    </div>
  );
}
