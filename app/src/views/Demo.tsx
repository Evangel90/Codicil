// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The demo app shell: header, the demo bar (clock and who you are acting as),
// and the screen for the current person.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { Brand, Icon, ICONS, Segmented, ThemeToggle, Toast, TxSheet } from '../components/ui.js';
import { toggleTheme } from '../theme.js';
import { jumpsFor, type CommandContext, type Tab } from '../demo/commands.js';
import { calendarFile, downloadCalendar, remindersFor } from '../demo/ics.js';
import { IS_MAC, Palette, usePaletteShortcut } from './Palette.js';
import { DAY, demo, GUARDIANS, HEIRS, OWNER_FIRST, useDemo, type Actor, type Snapshot } from '../demo/store.js';
import { nextUp, positionNext, positionStage, sameActor, type NextUp } from '../demo/guide.js';
import { Wizard } from './Wizard.js';
import { OwnerView } from './OwnerView.js';
import { WillView } from './WillView.js';
import { HeirView } from './HeirView.js';
import { GuardianView } from './GuardianView.js';
import { LensView } from './LensView.js';
import { InspectView } from './InspectView.js';
import { SavingsView } from './SavingsView.js';

export type { Tab };

const upper = (t: number) =>
  new Date(t * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();

function Nav({ s, tab, setTab }: { s: Snapshot; tab: Tab; setTab: (t: Tab) => void }) {
  const first = s.actor.kind === 'owner' ? 'Vault' : s.actor.kind === 'heir' ? 'Your share' : s.actor.kind === 'guardian' ? 'Guardian' : 'Inspect';
  const items: [Tab, string][] = [['vault', first], ...(s.actor.kind === 'owner' ? [['will', 'Will'] as [Tab, string]] : []), ['savings', 'Savings'], ['lens', 'Privacy Lens']];
  return (
    <nav className="pillnav" aria-label="Sections">
      {items.map(([id, label]) => (
        <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
          {label}
        </button>
      ))}
    </nav>
  );
}

const actorName = (a: Actor) =>
  a.kind === 'owner' ? OWNER_FIRST : a.kind === 'public' ? 'Anyone'
    : a.kind === 'heir' ? HEIRS.find((h) => h.id === a.id)!.name : GUARDIANS[a.id].name;

/** A label with a pulsing dot when it's this person's turn. */
const turn = (label: string, next: boolean) => (
  <>{label}{next && <span className="next-dot" aria-hidden="true" />}{next && <span className="sr-only"> (next)</span>}</>
);

function ActAs({ s, up }: { s: Snapshot; up: NextUp }) {
  const role = s.actor.kind;
  const isNext = (a: Actor) => up.who.some((w) => sameActor(w, a));
  const roleNext = (k: Actor['kind']) => up.who.some((w) => w.kind === k);
  const people = role === 'heir'
    ? HEIRS.map((h) => ({ value: h.id as string, label: turn(h.name, isNext({ kind: 'heir', id: h.id })) }))
    : role === 'guardian' ? GUARDIANS.map((g) => ({ value: String(g.id), label: turn(g.name, isNext({ kind: 'guardian', id: g.id })) })) : [];
  const person = s.actor.kind === 'heir' ? s.actor.id : s.actor.kind === 'guardian' ? String(s.actor.id) : '';
  const firstOf = (k: Actor['kind']): Actor => up.who.find((w) => w.kind === k)
    ?? (k === 'owner' ? { kind: 'owner' } : k === 'heir' ? { kind: 'heir', id: 'ben' } : k === 'guardian' ? { kind: 'guardian', id: 0 } : { kind: 'public' });
  return (
    <div className="actas">
      <span className="eyebrow">Act as</span>
      <Segmented<Actor['kind']>
        label="Act as"
        size="sm"
        value={role}
        options={([['owner', OWNER_FIRST], ['heir', 'Heir'], ['guardian', 'Guardian'], ['public', 'Anyone']] as const).map(([value, label]) => ({
          value, label: turn(label, roleNext(value) && role !== value),
        }))}
        onChange={(k) => demo.setActor(firstOf(k))}
      />
      {people.length > 0 && (
        <Segmented<string>
          label={role === 'heir' ? 'Which heir' : 'Which guardian'}
          size="sm"
          value={person}
          options={people}
          onChange={(v) => demo.setActor(role === 'heir' ? { kind: 'heir', id: v as never } : { kind: 'guardian', id: Number(v) })}
        />
      )}
    </div>
  );
}

function DemoBar({ s, tab, setTab, onReset }: { s: Snapshot; tab: Tab; setTab: (t: Tab) => void; onReset: () => void }) {
  // The savings screen has its own next step; everywhere else the vault's story leads.
  const up = tab === 'savings' ? positionNext(s) : nextUp(s);
  const jumps = jumpsFor(s);
  const day = Math.floor((s.now - s.deployedAt) / DAY) + 1;
  return (
    <div className="demobar" aria-label="Demo controls" role="region">
      <div className="wrap demobar-row">
        <span className="eyebrow demo-word">Demo</span>
        <span className="mono demo-date" aria-label={`Demo date: day ${day}`}>DAY {day} · {upper(s.now)}</span>
        <ActAs s={s} up={up} />
        <span className="grow" />
        <div className="demo-jumps">
          {jumps.map((j) => (
            <button key={j.label} type="button" className="btn btn-secondary btn-sm" onClick={() => demo.advanceTo(j.to)}>
              {j.label}{j.label.startsWith('Skip') && <span className="arw" aria-hidden="true">→</span>}
            </button>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>Reset</button>
        </div>
      </div>
      <NextBar s={s} up={up} openSavings={tab !== 'savings' && positionStage(s) === 'open' ? () => setTab('savings') : undefined} />
    </div>
  );
}

/** Where the story is, whose turn it is, and what anyone can do right now. */
function NextBar({ s, up, openSavings }: { s: Snapshot; up: NextUp; openSavings?: () => void }) {
  const who = s.actor.kind === 'public' ? 'Someone' : actorName(s.actor);
  const busy = s.tx?.status === 'running';
  const others = up.who.filter((w) => !sameActor(w, s.actor) && w.kind !== 'public').slice(0, 3);
  return (
    <div className={`nextbar tone-${up.tone}`} role="status" aria-live="polite">
      <div className="wrap nextbar-row">
        <span className={`dot ${up.tone === 'attention' ? 'pulse' : ''}`} aria-hidden="true" />
        <span className="nextbar-text">
          <span className="mono eyebrow-inline">Next</span> {up.text}
          {openSavings && <>{' '}<button type="button" className="linkish" onClick={openSavings}>{s.position.name} can pay out now too.</button></>}
        </span>
        <span className="nextbar-actions">
          {up.action === 'startSwitch' && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void demo.startCountdown(who)}>
              Start the switch <span className="arw" aria-hidden="true">→</span>
            </button>
          )}
          {up.action === 'release' && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void demo.release(who)}>
              Release the will <span className="arw" aria-hidden="true">→</span>
            </button>
          )}
          {!up.action && others.map((a) => (
            <button key={actorName(a)} type="button" className="btn btn-secondary btn-sm" onClick={() => demo.setActor(a)}>
              Act as {actorName(a)}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

export function Demo() {
  const s = useDemo();
  const [tab, setTab] = useState<Tab>('vault');
  const [sealed, setSealed] = useState(s.ready);

  useEffect(() => {
    demo.startClock();
    return () => demo.stopClock();
  }, []);
  // The Will tab is the owner's alone.
  useEffect(() => { if (s.actor.kind !== 'owner' && tab === 'will') setTab('vault'); }, [s.actor.kind, tab]);

  // Each screen starts at the top.
  useEffect(() => { window.scrollTo(0, 0); }, [tab, sealed, s.actor.kind]);

  const reset = useCallback(() => { demo.reset(); setSealed(false); setTab('vault'); }, []);
  const inApp = s.ready && sealed;
  const [palette, setPalette] = usePaletteShortcut();
  const ctx = useMemo<CommandContext>(() => ({
    setTab,
    reset,
    toggleTheme,
    downloadReminders: () => {
      const x = demo.getSnapshot();
      downloadCalendar(calendarFile(remindersFor(x.deadline, x.now), x.now, `${location.origin}/#/demo`));
    },
  }), [reset]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="wrap topbar-row">
          <Brand />
          {inApp && <Nav s={s} tab={tab} setTab={setTab} />}
          <span className="grow" />
          <span className="net hide-sm"><span className="dot tone-armed" aria-hidden="true" />Demo chain · in your browser</span>
          {inApp && (
            <button type="button" className="kbd-btn" onClick={() => setPalette(true)} aria-label="Open the command palette" title="Command palette">
              <Icon d={ICONS.search} size={15} stroke={1.6} />
              <span className="mono hide-sm" aria-hidden="true">{IS_MAC ? '⌘K' : 'Ctrl K'}</span>
            </button>
          )}
          <ThemeToggle />
        </div>
      </header>
      {inApp && <DemoBar s={s} tab={tab} setTab={setTab} onReset={reset} />}

      {!inApp ? <Wizard s={s} onDone={() => setSealed(true)} /> : (
        <main className="wrap page" id="main">
          {tab === 'lens' ? <LensView s={s} />
            : tab === 'savings' ? <SavingsView s={s} />
            : tab === 'will' && s.actor.kind === 'owner' ? <WillView s={s} />
            : s.actor.kind === 'owner' ? <OwnerView s={s} openTab={setTab} />
            : s.actor.kind === 'heir' ? <HeirView s={s} id={s.actor.id} openTab={setTab} />
            : s.actor.kind === 'guardian' ? <GuardianView s={s} id={s.actor.id} />
            : <InspectView s={s} />}
        </main>
      )}
      {inApp && (
        <footer className="wrap appfoot">
          <Icon d={ICONS.lens} size={14} stroke={1.6} />
          <span>
            This demo runs the real Codicil vault contract, and the savings contract that calls it, in your browser, on a simulated chain with a clock you control.
            It skips proof generation and fees. Everything else is the same code.
          </span>
        </footer>
      )}
      {inApp && <Palette s={s} ctx={ctx} open={palette} onClose={() => setPalette(false)} />}
      <TxSheet tx={s.tx} />
      <Toast toast={s.toast} />
    </div>
  );
}
