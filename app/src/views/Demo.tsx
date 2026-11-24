// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The demo app shell: header, the demo bar (clock and who you are acting as),
// and the screen for the current person.

import { useEffect, useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { Brand, Icon, ICONS, Segmented, ThemeToggle, Toast, TxSheet } from '../components/ui.js';
import { DAY, days, demo, GUARDIANS, HEIRS, OWNER_FIRST, OWNER_NAME, useDemo, type Actor, type Snapshot } from '../demo/store.js';
import { Wizard } from './Wizard.js';
import { OwnerView } from './OwnerView.js';
import { WillView } from './WillView.js';
import { HeirView } from './HeirView.js';
import { GuardianView } from './GuardianView.js';
import { LensView } from './LensView.js';

export type Tab = 'vault' | 'will' | 'lens';

const upper = (t: number) =>
  new Date(t * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();

function Nav({ s, tab, setTab }: { s: Snapshot; tab: Tab; setTab: (t: Tab) => void }) {
  const first = s.actor.kind === 'owner' ? 'Vault' : s.actor.kind === 'heir' ? 'Your share' : 'Guardian';
  const items: [Tab, string][] = [['vault', first], ...(s.actor.kind === 'owner' ? [['will', 'Will'] as [Tab, string]] : []), ['lens', 'Privacy Lens']];
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

function ActAs({ s }: { s: Snapshot }) {
  const role = s.actor.kind;
  const people = role === 'heir'
    ? HEIRS.map((h) => ({ value: h.id as string, label: h.name }))
    : role === 'guardian' ? GUARDIANS.map((g) => ({ value: String(g.id), label: g.name })) : [];
  const person = s.actor.kind === 'heir' ? s.actor.id : s.actor.kind === 'guardian' ? String(s.actor.id) : '';
  return (
    <div className="actas">
      <span className="eyebrow">Act as</span>
      <Segmented<Actor['kind']>
        label="Act as"
        size="sm"
        value={role}
        options={[{ value: 'owner', label: OWNER_FIRST }, { value: 'heir', label: 'Heir' }, { value: 'guardian', label: 'Guardian' }]}
        onChange={(k) => demo.setActor(k === 'owner' ? { kind: 'owner' } : k === 'heir' ? { kind: 'heir', id: 'ben' } : { kind: 'guardian', id: 0 })}
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

function DemoBar({ s, onReset }: { s: Snapshot; onReset: () => void }) {
  const jumps: { label: string; to: number }[] = [{ label: '+1 day', to: s.now + DAY }];
  if (s.phase === Phase.armed && s.now < s.deadline) jumps.push({ label: 'Skip to deadline', to: s.deadline });
  if (s.phase === Phase.pending && s.now < s.pendingUntil) jumps.push({ label: 'Skip challenge window', to: s.pendingUntil });
  const cleo = s.heirs.find((h) => h.profile.id === 'cleo');
  if (s.phase === Phase.released && cleo && s.now < cleo.unlockAt) jumps.push({ label: "Skip to Cleo's unlock date", to: cleo.unlockAt });
  const day = Math.floor((s.now - s.deployedAt) / DAY) + 1;
  return (
    <div className="demobar" aria-label="Demo controls" role="region">
      <div className="wrap demobar-row">
        <span className="eyebrow demo-word">Demo</span>
        <span className="mono demo-date" aria-label={`Demo date: day ${day}`}>DAY {day} · {upper(s.now)}</span>
        <ActAs s={s} />
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
      <PublicAction s={s} />
    </div>
  );
}

/** What anyone can do right now to move the vault forward. */
function PublicAction({ s }: { s: Snapshot }) {
  const who = s.actor.kind === 'owner' ? OWNER_NAME
    : s.actor.kind === 'heir' ? HEIRS.find((h) => h.id === (s.actor as { id: string }).id)!.name : 'A guardian';
  let action: { tone: string; text: string; button: string; run: () => void } | undefined;
  if (s.phase === Phase.armed && s.now >= s.deadline) {
    action = {
      tone: 'pending',
      text: `${OWNER_FIRST} missed the check-in due ${upper(s.deadline)}. Anyone can start the switch, which gives ${OWNER_FIRST} ${days(s.setup!.window)} days to cancel.`,
      button: 'Start the switch',
      run: () => void demo.startCountdown(who),
    };
  } else if (s.phase === Phase.pending && s.now >= s.pendingUntil) {
    action = {
      tone: 'released',
      text: `The challenge window ended ${upper(s.pendingUntil)} and nobody cancelled. Anyone can release the will.`,
      button: 'Release the will',
      run: () => void demo.release(who),
    };
  }
  if (!action) return null;
  return (
    <div className={`public-action tone-${action.tone}`}>
      <div className="wrap public-action-row">
        <span className="dot pulse" aria-hidden="true" />
        <span className="public-action-text"><span className="mono eyebrow-inline">Anyone</span> {action.text}</span>
        <button type="button" className="btn btn-primary btn-sm" disabled={s.tx?.status === 'running'} onClick={action.run}>
          {action.button} <span className="arw" aria-hidden="true">→</span>
        </button>
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

  const reset = () => { demo.reset(); setSealed(false); setTab('vault'); };
  const inApp = s.ready && sealed;

  return (
    <div className="app">
      <header className="topbar">
        <div className="wrap topbar-row">
          <Brand />
          {inApp && <Nav s={s} tab={tab} setTab={setTab} />}
          <span className="grow" />
          <span className="net hide-sm"><span className="dot tone-armed" aria-hidden="true" />Demo chain · in your browser</span>
          <ThemeToggle />
        </div>
      </header>
      {inApp && <DemoBar s={s} onReset={reset} />}

      {!inApp ? <Wizard s={s} onDone={() => setSealed(true)} /> : (
        <main className="wrap page" id="main">
          {tab === 'lens' ? <LensView s={s} />
            : tab === 'will' && s.actor.kind === 'owner' ? <WillView s={s} />
            : s.actor.kind === 'owner' ? <OwnerView s={s} openTab={setTab} />
            : s.actor.kind === 'heir' ? <HeirView s={s} id={s.actor.id} />
            : <GuardianView s={s} id={s.actor.id} />}
        </main>
      )}
      {inApp && (
        <footer className="wrap appfoot">
          <Icon d={ICONS.lens} size={14} stroke={1.6} />
          <span>
            This demo runs the real Codicil vault contract in your browser, on a simulated chain with a clock you control.
            It skips proof generation and fees. Everything else is the same code.
          </span>
        </footer>
      )}
      <TxSheet tx={s.tx} />
      <Toast toast={s.toast} />
    </div>
  );
}
