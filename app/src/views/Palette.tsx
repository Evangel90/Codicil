// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// ⌘K / Ctrl+K: do anything in the demo from the keyboard.

import { useEffect, useMemo, useRef, useState } from 'react';
import { commands, filterCommands, type CommandContext } from '../demo/commands.js';
import type { Snapshot } from '../demo/store.js';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Opens on ⌘K / Ctrl+K anywhere; returns [open, setOpen]. */
export function usePaletteShortcut() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  return [open, setOpen] as const;
}

export function Palette({ s, ctx, open, onClose }: { s: Snapshot; ctx: CommandContext; open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setQ('');
      setSel(0);
      d.showModal();
      requestAnimationFrame(() => input.current?.focus());
    }
    if (!open && d.open) d.close();
  }, [open]);

  const all = useMemo(() => (open ? commands(s, ctx) : []), [open, s, ctx]);
  const list = useMemo(() => filterCommands(all, q), [all, q]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => { document.getElementById(`cmd-${sel}`)?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const run = (i: number) => {
    const c = list[i];
    if (!c) return;
    onClose();
    c.run();
  };

  let group = '';
  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Command palette"
      onClose={onClose}
      onClick={(e) => { if (e.target === dialog.current) onClose(); }}
    >
      <div className="palette-search">
        <span className="mono palette-k" aria-hidden="true">{IS_MAC ? '⌘K' : 'Ctrl K'}</span>
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Check in, skip a month, act as Ben…"
          aria-label="Search commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={list.length ? `cmd-${sel}` : undefined}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, list.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
          }}
        />
      </div>
      <ul id="palette-list" role="listbox" aria-label="Commands" className="palette-list">
        {list.length === 0 && <li className="palette-empty small muted">Nothing matches “{q}”.</li>}
        {list.map((c, i) => {
          const head = c.group !== group ? (group = c.group) : undefined;
          return (
            <li key={c.id} role="presentation">
              {head && <div className="eyebrow palette-group" role="presentation">{head}</div>}
              <div
                id={`cmd-${i}`}
                role="option"
                aria-selected={i === sel}
                className="palette-item"
                onMouseMove={() => setSel(i)}
                onClick={() => run(i)}
              >
                <span>{c.label}</span>
                {c.hint && <span className={`mono palette-hint ${c.hint === 'next' ? 'is-next' : ''}`}>{c.hint}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="palette-foot mono" aria-hidden="true">
        <span>↑↓ choose</span><span>↵ run</span><span>esc close</span>
      </div>
    </dialog>
  );
}
