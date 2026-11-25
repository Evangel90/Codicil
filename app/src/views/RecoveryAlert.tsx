// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// What the owner sees when someone uses the recovery key. A recovery replaces
// the owner's keys, so the warning says what is happening, when, and the one
// thing that stops it: anything the current passkey signs.

import { duration, Icon, ICONS } from '../components/ui.js';
import { demo, fmtDate, type Snapshot } from '../demo/store.js';

/** Shown while a recovery stands and can still take effect. */
export function RecoveryAlert({ s }: { s: Snapshot }) {
  const r = s.recovery;
  const busy = s.tx?.status === 'running';
  const ready = r.state === 'ready';
  const key = s.passkey?.kind === 'device' ? 'Face ID' : 'your demo key';
  return (
    <section className="alert-card" role="alert" aria-labelledby="rec-alert-h">
      <span className="bad-ring" aria-hidden="true"><Icon d={ICONS.clock} size={18} stroke={1.8} /></span>
      <div className="alert-body">
        <h2 id="rec-alert-h">
          {ready
            ? 'The recovery of your vault can be finished at any moment.'
            : <>Someone is replacing your passkey. It takes effect in <span className="mono">{duration(r.readyAt - s.now)}</span>.</>}
        </h2>
        <p>
          {r.startedAt ? `On ${fmtDate(r.startedAt)} your` : 'Your'} recovery key was used to propose a new passkey for this vault.{' '}
          {ready
            ? 'The waiting time is over, so anyone can now finish the recovery. From then on the new passkey owns the vault and the one on this device stops working.'
            : `On ${fmtDate(r.readyAt)} the new passkey takes over, and the one on this device stops working.`}
        </p>
        <p>
          <strong>If this was not you, check in now.</strong> Anything this passkey signs cancels the recovery, and the
          recovery key is then retired for good, so nobody can try again with it.
        </p>
        <p className="small muted">
          If it was you, on a new device because this passkey is lost, do nothing here. {ready ? 'Finish the recovery from the new device.' : `Finish the recovery on ${fmtDate(r.readyAt)}.`}
        </p>
        <div className="btn-row">
          <button type="button" className="btn btn-primary btn-wrap" disabled={busy} onClick={() => void demo.checkIn()}>
            Check in with {key} and cancel the recovery
          </button>
        </div>
      </div>
    </section>
  );
}

/** Shown once after a recovery ended, until the owner dismisses it. */
export function RecoveryNotice({ s }: { s: Snapshot }) {
  const r = s.recovery;
  if (!r.notice) return null;
  const cancelled = r.notice === 'cancelled';
  return (
    <section className="notice-card" role="status" aria-labelledby="rec-note-h">
      <span className="ok-ring" aria-hidden="true"><Icon d={ICONS.check} size={18} stroke={1.8} /></span>
      <div className="alert-body">
        <h2 id="rec-note-h">{cancelled ? 'The recovery was cancelled.' : 'The recovery is finished.'}</h2>
        {cancelled ? (
          <p>
            Your passkey signed{r.cancelledAt ? ` on ${fmtDate(r.cancelledAt)}` : ''}, and that was enough: the proposed keys will never be installed.
            The recovery key that was used is retired for good. This vault now has no usable recovery key, and this
            version of Codicil cannot set a new one.
          </p>
        ) : (
          <p>
            Since {r.completedAt ? fmtDate(r.completedAt) : 'the recovery'}, the new passkey owns this vault and the old one is refused.
            Your check-in deadline did not move. The recovery key you saved during the recovery is the one that works now.
          </p>
        )}
        <div className="btn-row">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => demo.dismissRecoveryNotice()}>Dismiss</button>
        </div>
      </div>
    </section>
  );
}
