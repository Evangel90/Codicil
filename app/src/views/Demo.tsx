// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { useEffect, useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { Mark, TxSheet } from '../components/ui.js';
import {
  CHALLENGE,
  DAY,
  demo,
  fmtDate,
  GUARDIANS,
  HEIRS,
  OWNER_NAME,
  useDemo,
  type Actor,
  type Snapshot,
} from '../demo/store.js';
import { createDemoPasskey, createDevicePasskey, passkeySupport, type PasskeySupport } from '../demo/passkey.js';
import { OwnerView } from './OwnerView.js';
import { HeirView } from './HeirView.js';
import { GuardianView } from './GuardianView.js';
import { LensView } from './LensView.js';

function Setup() {
  const [support, setSupport] = useState<PasskeySupport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { void passkeySupport().then(setSupport); }, []);

  const seal = async (kind: 'device' | 'demo') => {
    setBusy(true);
    setError(undefined);
    try {
      await demo.setUp(kind === 'device' ? await createDevicePasskey() : createDemoPasskey());
    } catch (e) {
      setError(e instanceof Error && e.name === 'NotAllowedError'
        ? 'Passkey creation was cancelled. Try again, or continue with a demo key.'
        : `Could not create the passkey: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="wrap setup">
      <h1>Seal a demo vault</h1>
      <p className="lede">
        You are {OWNER_NAME}. Your will leaves half to your daughter Ada (with your brother Kofi as
        backup), 30% to your son Ben, and 20% to your granddaughter Cleo when she turns 18. Three
        guardians can report your death; any two are enough to start a countdown you can cancel.
      </p>
      <div className="setup-choice">
        <div>
          <h2>Your proof of life</h2>
          <p className="muted">
            Codicil uses a passkey, not a seed phrase. The vault stores only a sealed commitment to it, so
            nobody can tell whose vault this is.
          </p>
        </div>
        <div className="setup-actions">
          <button type="button" className="btn btn-seal" disabled={busy || !support?.available} onClick={() => seal('device')}>
            Create a passkey with Face ID or Touch ID
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => seal('demo')}>
            Use a demo key instead
          </button>
          {support && !support.available && <p className="muted small">{support.reason}</p>}
          {error && <p className="error small" role="alert">{error}</p>}
        </div>
      </div>
      <p className="muted small">
        This demo runs the real Codicil vault contract in your browser on a simulated chain with a clock you
        control. It skips proof generation and network fees; everything else is the same code.
      </p>
    </main>
  );
}

type Tab = 'act' | 'lens';

function ActorSwitcher({ s }: { s: Snapshot }) {
  const value = s.actor.kind === 'owner' ? 'owner' : `${s.actor.kind}:${s.actor.id}`;
  return (
    <label className="actor-switch">
      <span className="sr-only">Act as</span>
      <select
        value={value}
        onChange={(e) => {
          const [kind, id] = e.target.value.split(':');
          const actor: Actor = kind === 'owner' ? { kind: 'owner' }
            : kind === 'heir' ? { kind: 'heir', id: id as never }
            : { kind: 'guardian', id: Number(id) };
          demo.setActor(actor);
        }}
      >
        <option value="owner">{OWNER_NAME} (owner)</option>
        <optgroup label="Heirs">
          {HEIRS.map((h) => <option key={h.id} value={`heir:${h.id}`}>{h.name}, {h.relation.toLowerCase()}</option>)}
        </optgroup>
        <optgroup label="Guardians">
          {GUARDIANS.map((g) => <option key={g.id} value={`guardian:${g.id}`}>{g.name}, {g.relation.toLowerCase()}</option>)}
        </optgroup>
      </select>
    </label>
  );
}

function Clock({ s }: { s: Snapshot }) {
  const jumps: { label: string; to: number }[] = [{ label: '+1 day', to: s.now + DAY }, { label: '+1 week', to: s.now + 7 * DAY }];
  if (s.phase === Phase.armed && s.now < s.deadline) jumps.push({ label: 'Skip to the deadline', to: s.deadline });
  if (s.phase === Phase.pending && s.now < s.pendingUntil) jumps.push({ label: 'Skip the challenge window', to: s.pendingUntil });
  const cleo = s.heirs.find((h) => h.profile.id === 'cleo');
  if (s.phase === Phase.released && cleo && s.now < cleo.unlockAt) jumps.push({ label: "Skip to Cleo's 18th birthday", to: cleo.unlockAt });
  return (
    <div className="clock" aria-label="Demo clock">
      <span className="clock-now">
        <span className="muted small">Demo date</span>
        <strong>{fmtDate(s.now)}</strong>
      </span>
      <div className="clock-jumps">
        {jumps.map((j) => (
          <button key={j.label} type="button" className="btn btn-quiet" onClick={() => demo.advanceTo(j.to)}>{j.label}</button>
        ))}
      </div>
    </div>
  );
}

/** What anyone can do right now to move the vault forward. */
function PublicActions({ s, who }: { s: Snapshot; who: string }) {
  if (s.phase === Phase.armed && s.now >= s.deadline) {
    return (
      <div className="public-action">
        <p>The owner missed their check-in on {fmtDate(s.deadline)}. Anyone can start the {CHALLENGE / DAY}-day countdown.</p>
        <button type="button" className="btn" onClick={() => void demo.startCountdown(who)}>Start the countdown</button>
      </div>
    );
  }
  if (s.phase === Phase.pending && s.now >= s.pendingUntil) {
    return (
      <div className="public-action">
        <p>The challenge window ended on {fmtDate(s.pendingUntil)} without the owner cancelling. Anyone can release the will.</p>
        <button type="button" className="btn" onClick={() => void demo.release(who)}>Release the will</button>
      </div>
    );
  }
  return null;
}

export function Demo() {
  const s = useDemo();
  const [tab, setTab] = useState<Tab>('act');
  const who = s.actor.kind === 'owner' ? OWNER_NAME
    : s.actor.kind === 'heir' ? HEIRS.find((h) => h.id === (s.actor as { id: string }).id)!.name
    : 'A guardian';

  return (
    <div className="demo">
      <header className="appbar">
        <div className="wrap appbar-row">
          <a href="#/" className="brand"><Mark /> <span>Codicil</span><span className="demo-tag">Demo</span></a>
          {s.ready && <ActorSwitcher s={s} />}
          {s.ready && (
            <button type="button" className="btn btn-quiet small" onClick={() => { demo.reset(); setTab('act'); }}>Start over</button>
          )}
        </div>
        {s.ready && <div className="wrap"><Clock s={s} /></div>}
      </header>

      {!s.ready ? <Setup /> : (
        <main className="wrap app-main">
          <nav className="tabs" aria-label="View">
            <button type="button" aria-pressed={tab === 'act'} onClick={() => setTab('act')}>
              {s.actor.kind === 'owner' ? 'My vault' : s.actor.kind === 'heir' ? 'My inheritance' : 'Guardian duty'}
            </button>
            <button type="button" aria-pressed={tab === 'lens'} onClick={() => setTab('lens')}>Privacy lens</button>
          </nav>
          {tab === 'lens' ? <LensView s={s} /> : (
            <>
              <PublicActions s={s} who={who} />
              {s.actor.kind === 'owner' && <OwnerView s={s} />}
              {s.actor.kind === 'heir' && <HeirView s={s} id={s.actor.id} />}
              {s.actor.kind === 'guardian' && <GuardianView s={s} id={s.actor.id} />}
            </>
          )}
        </main>
      )}
      <TxSheet tx={s.tx} />
    </div>
  );
}
