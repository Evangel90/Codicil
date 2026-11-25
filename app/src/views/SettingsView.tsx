// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The owner's settings: who can start the switch early (guardians and an
// attestor), changed with one signed update, and the recovery key: where it
// stands, and the "I lost my passkey" path.

import { useId, useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { HashChip, Icon, ICONS } from '../components/ui.js';
import { checkInState, recoveryLive, settingsOpen } from '../demo/guide.js';
import { decodeRecoveryKey } from '../demo/recoveryKey.js';
import { ATTESTOR, demo, fmtDate, GUARDIAN_POOL, guardianById, OWNER_FIRST, span, type Snapshot } from '../demo/store.js';
import { RecoveryAlert, RecoveryNotice } from './RecoveryAlert.js';
import { RecoveryKeySheet } from './RecoveryKeySheet.js';

/** Why guardians and the attestor cannot be changed right now, if they cannot. */
function lockReason(s: Snapshot): string | undefined {
  if (settingsOpen(s)) return undefined;
  if (s.phase === Phase.released) return 'This will has been released, so guardians and the attestor can no longer be changed.';
  if (s.phase === Phase.pending) return 'A countdown has started, so guardians and the attestor are locked. Check in to cancel the countdown, then change them.';
  return checkInState(s) === 'grace'
    ? 'Your check-in deadline has passed, so guardians and the attestor are locked. Check in first: you are still inside your grace period.'
    : 'Your check-in deadline has passed, so guardians and the attestor are locked. Start the switch, check in to cancel it, then change them.';
}

const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Choose the guardians, how many must agree, and the attestor; one signature saves all three. */
function GuardianEditor({ s, onDone }: { s: Snapshot; onDone: () => void }) {
  const setup = s.setup!;
  const [ids, setIds] = useState<number[]>(setup.guardians);
  const [threshold, setThreshold] = useState(setup.threshold);
  const [attestor, setAttestor] = useState(setup.attestor);
  const noteId = useId();
  const busy = s.tx?.status === 'running';
  const n = ids.length;
  const k = Math.min(threshold, Math.max(n, 1));
  const added = ids.filter((id) => !setup.guardians.includes(id));
  const removed = setup.guardians.filter((id) => !ids.includes(id));
  const changed = added.length > 0 || removed.length > 0 || k !== setup.threshold || attestor !== setup.attestor;
  const votes = Number(s.guardianVotes);
  const names = (x: number[]) => list(x.map((id) => guardianById(id).name));

  const toggle = (id: number) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].sort((a, b) => a - b)));
  const save = async () => {
    if (n === 0 || !changed) return;
    if (await demo.updateSettings({ guardians: ids, threshold: k, attestor })) onDone();
  };

  return (
    <form className="card settings-editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <fieldset className="stack-8">
        <legend>Guardians</legend>
        <ul className="people">
          {GUARDIAN_POOL.map((g) => {
            const on = ids.includes(g.id);
            const was = setup.guardians.includes(g.id);
            return (
              <li key={g.id}>
                <label className="check">
                  <input type="checkbox" checked={on} onChange={() => toggle(g.id)} />
                  <span className="people-name"><span className="tone-private">{g.name}</span> <span className="muted small">{g.relation}</span></span>
                </label>
                <span className="small muted">{on ? (was ? 'Guardian' : 'Will be added') : was ? 'Will be removed' : 'Not a guardian'}</span>
              </li>
            );
          })}
        </ul>
        {n === 0 && <p className="err-inline" role="alert">Choose at least one guardian. The demo does not support a vault with none.</p>}
      </fieldset>

      <div className="stepper-row">
        <span>Votes needed to start the switch early</span>
        <div className="stepper">
          <button type="button" className="icon-btn" aria-label="Fewer votes needed" disabled={k <= 1} onClick={() => setThreshold(k - 1)}>−</button>
          <span className="mono" aria-live="polite">{n === 0 ? '0 of 0' : `${k} of ${n}`}</span>
          <button type="button" className="icon-btn" aria-label="More votes needed" disabled={k >= n} onClick={() => setThreshold(k + 1)}>+</button>
        </div>
      </div>

      <label className="check settings-attestor">
        <input type="checkbox" checked={attestor} onChange={(e) => setAttestor(e.target.checked)} />
        <span>
          {ATTESTOR.name} can also start the switch, with a signed notice
          <span className="small muted">An attestor is an office you trust to confirm a death. Like a guardian, it can only start the clock, and you can still cancel.</span>
        </span>
      </label>

      <div className="settings-effect" id={noteId}>
        <h3>What saving does</h3>
        <ul className="plain-list">
          {added.length > 0 && (
            <li>
              Adds {names(added)}. {added.length === 1 ? 'They' : 'Each of them'} made a guardian secret on their own phone and sent you only its
              fingerprint, the same way your first guardians did. In a real vault you would send an invite link; the demo has done it for you.
            </li>
          )}
          {removed.length > 0 && <li>Removes {names(removed)}. Their proof of membership stops working at once, and they are not told by the chain.</li>}
          {k !== setup.threshold && n > 0 && <li>{k} of {n} must agree, where it was {setup.threshold} of {setup.guardians.length}.</li>}
          {attestor !== setup.attestor && <li>{attestor ? `Names ${ATTESTOR.name} as your attestor.` : `Removes ${ATTESTOR.name} as your attestor.`}</li>}
          <li>
            Starts a new voting round. {votes > 0 ? `The ${votes === 1 ? 'vote' : `${votes} votes`} already cast this round will no longer count` : 'Any vote already cast stops counting'},
            and so does any notice an attestor signed before.
          </li>
          <li>Every guardian you keep needs a new proof of membership from you. The demo delivers it; a real app sends it to their phone.</li>
        </ul>
      </div>

      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={busy || n === 0 || !changed} aria-describedby={noteId}>
          Save and start a new round{s.passkey?.kind === 'device' ? ' with Face ID' : ''}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>Cancel</button>
      </div>
      <p className="muted small">
        {changed
          ? 'You sign the complete new settings in one approval, like a check-in. The chain sees a new guardians fingerprint, the number that must agree, and whether an attestor is set. Not who, and not how many guardians there are.'
          : 'Nothing is changed yet.'}
      </p>
    </form>
  );
}

function Guardians({ s }: { s: Snapshot }) {
  const [editing, setEditing] = useState(false);
  const setup = s.setup!;
  const locked = lockReason(s);
  const current = s.guardians.filter((g) => g.current);
  const former = s.guardians.filter((g) => !g.current);
  const votes = Number(s.guardianVotes);

  return (
    <section className="stack-16" aria-labelledby="set-g">
      <div className="settings-head">
        <div className="stack-8">
          <h2 id="set-g" className="disp h-sec">Who can start the switch early</h2>
          <p className="lede">
            Your guardians, and an attestor if you name one, can start the countdown before your deadline. They cannot
            see the will or move money, and you always get the full challenge window to cancel.
          </p>
        </div>
        {!editing && (
          <button type="button" className="btn btn-secondary" disabled={!!locked} onClick={() => setEditing(true)}>
            Change guardians or the attestor
          </button>
        )}
      </div>

      {locked && <p className="settings-locked" role="status"><Icon d={ICONS.clock} size={16} stroke={1.8} /><span>{locked}</span></p>}

      {editing && !locked ? <GuardianEditor s={s} onDone={() => setEditing(false)} /> : (
        <>
          <ul className="people people-read">
            {current.map((g) => (
              <li key={g.id}>
                <span className="people-name"><span className="tone-private">{g.name}</span> <span className="muted small">{g.relation}</span></span>
                <span className="small muted">Guardian</span>
              </li>
            ))}
            {former.map((g) => (
              <li key={g.id}>
                <span className="people-name"><span className="muted">{g.name}</span> <span className="muted small">{g.relation}</span></span>
                <span className="small muted">Removed, can no longer vote</span>
              </li>
            ))}
          </ul>
          <dl className="facts">
            <div><dt>Votes needed</dt><dd>{s.guardianThreshold.toString()} of {current.length}</dd></div>
            <div><dt>This round</dt><dd>Round {(s.guardianRound + 1n).toString()} · {votes} vote{votes === 1 ? '' : 's'} so far</dd></div>
            <div><dt>Attestor</dt><dd className={setup.attestor ? 'tone-private' : undefined}>{setup.attestor ? ATTESTOR.name : 'None'}</dd></div>
            <div><dt>What the chain holds</dt><dd><HashChip value={s.chain.guardianRoot} /></dd></div>
          </dl>
          {setup.attestor && s.phase === Phase.armed && (
            <p className="small muted">
              To see the attestor's part, the demo can send a notice signed by {ATTESTOR.name} for this round.{' '}
              <button type="button" className="linkish" disabled={s.tx?.status === 'running'} onClick={() => void demo.attest(ATTESTOR.name)}>
                Send the signed notice (demo)
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** The "I lost my passkey" path: type the saved key in, as on a new device. */
function StartRecovery({ s }: { s: Snapshot }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string>();
  const fieldId = useId();
  const busy = s.tx?.status === 'running';
  const r = s.recovery;
  const tooLate = s.now > r.lastStart;

  const start = async () => {
    try {
      decodeRecoveryKey(text);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setProblem(m.charAt(0).toUpperCase() + m.slice(1) + '.');
      return;
    }
    setProblem(undefined);
    if (await demo.startRecovery(text)) setText('');
  };

  return (
    <form className="card recover" onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <div className="stack-6">
        <h3>Lost your passkey? Start a recovery</h3>
        <p className="small muted">
          On a new device you would open Codicil, find your vault and type in the key from your paper copy. The demo
          plays that here: it makes a new passkey, as the new device would, and proposes it to the vault. Nothing
          changes hands for {span(r.delay)}.
        </p>
      </div>
      <label className="field-label" htmlFor={fieldId}>
        Recovery key
        <textarea
          id={fieldId} className="field mono letter-input" rows={3} placeholder="codicil:recovery:v1:…" spellCheck={false}
          value={text} aria-invalid={problem ? true : undefined} onChange={(e) => { setText(e.target.value); setProblem(undefined); }}
        />
      </label>
      {problem && <p className="err-inline" role="alert">{problem}</p>}
      {tooLate && (
        <p className="err-inline" role="status">
          It is too late to recover before your deadline on {fmtDate(s.deadline)}: a recovery takes {span(r.delay)} and had to start
          by {fmtDate(r.lastStart)}. The vault will refuse it.
        </p>
      )}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>Start the recovery</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setText(demo.savedRecoveryKey() ?? ''); setProblem(undefined); }}>
          Use the key {OWNER_FIRST} saved (demo)
        </button>
      </div>
    </form>
  );
}

function Recovery({ s }: { s: Snapshot }) {
  const [sheet, setSheet] = useState(false);
  const r = s.recovery;
  const busy = s.tx?.status === 'running';
  const live = recoveryLive(s);
  const stands = r.state === 'waiting' || r.state === 'ready';
  const nextKey = demo.nextRecoveryKey();

  const status: Record<typeof r.state, [string, string]> = {
    off: ['This vault has no recovery key.', 'If you lose your passkey you can no longer check in or change the will, and the will is released to your heirs at your deadline. A recovery key can only be set when a vault is created, so it cannot be added here. To try one, reset the demo and choose “Create a recovery key” in step 6.'],
    idle: ['Your recovery key is ready.', `You saved it on paper${r.completedAt ? ' during your last recovery' : ' when you created the vault'}. With it, a new passkey can take over after a public wait of ${span(r.delay)}. Anything your current passkey signs during that wait cancels it.`],
    waiting: ['A recovery is in progress.', `A new passkey takes over on ${fmtDate(r.readyAt)}. Until then, anything the current passkey signs cancels it and retires the recovery key.`],
    ready: ['A recovery can be finished now.', 'The delay is over. Anyone can finish it, and the new passkey then owns the vault. Until someone does, a signature from the current passkey still cancels it.'],
    retired: ['Your recovery key is retired for good.', `${r.cancelledAt ? `On ${fmtDate(r.cancelledAt)} your passkey signed something, which cancelled a recovery.` : 'A recovery was cancelled.'} The key that started it can never be used again, so a thief gets one attempt. This vault now has no usable recovery key, and this version of Codicil cannot set a new one. If you lose your passkey, the will is released at your deadline.`],
  };
  const [title, body] = status[r.state];

  return (
    <section className="stack-16" aria-labelledby="set-r">
      <div className="stack-8">
        <h2 id="set-r" className="disp h-sec">Recovery key</h2>
        <p className="lede">
          A way back in if you lose your passkey. It is weaker than a passkey on purpose: it works only after a delay
          everyone can see, and any signature from your passkey stops it.
        </p>
      </div>

      {live ? <RecoveryAlert s={s} /> : <RecoveryNotice s={s} />}

      <div className={`card recovery-status state-${r.state}`}>
        <div className="stack-6">
          <h3>{title}</h3>
          <p className="small muted">{body}</p>
        </div>
        {r.state !== 'off' && (
          <dl className="facts">
            <div><dt>Delay before new keys take over</dt><dd>{span(r.delay)}</dd></div>
            {r.state === 'idle' && s.phase === Phase.armed && s.now < s.deadline && (
              <div><dt>Last day to start one before your deadline</dt><dd>{fmtDate(r.lastStart)}</dd></div>
            )}
            {stands && <div><dt>New keys take over</dt><dd className="tone-pending">{fmtDate(r.readyAt)}</dd></div>}
            <div><dt>What the chain holds</dt><dd><HashChip value={s.chain.recoveryKeyCommit} /></dd></div>
          </dl>
        )}
        {stands && !live && (
          <p className="small muted">
            {s.phase === Phase.armed
              ? 'It can no longer finish: your check-in deadline has passed, and a recovery only works before it.'
              : 'It cannot finish while a countdown is running. A check-in cancels the countdown, and the recovery with it.'}
          </p>
        )}
        {r.nextKeyToSave && nextKey && (
          <div className="rk-next">
            <p className="small">
              <strong>Save your next recovery key.</strong> It replaces the one you just used when the recovery finishes, and it is not shown after that.
            </p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSheet(true)}>Open my next recovery key</button>
          </div>
        )}
        {r.state === 'ready' && live && (
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void demo.finishRecovery(OWNER_FIRST)}>Finish the recovery</button>
          </div>
        )}
        {r.formerPasskey && r.state !== 'waiting' && r.state !== 'ready' && s.phase !== Phase.released && (
          <p className="small muted">
            The passkey that was replaced is still in this demo.{' '}
            <button type="button" className="linkish" disabled={busy} onClick={() => void demo.tryFormerPasskey()}>
              Try a check-in with the old passkey
            </button>{' '}
            and watch the vault refuse it.
          </p>
        )}
      </div>

      {r.state === 'idle' && s.phase === Phase.armed && s.now < s.deadline && <StartRecovery s={s} />}
      {r.state === 'idle' && !(s.phase === Phase.armed && s.now < s.deadline) && (
        <p className="small muted">A recovery key works only while the vault is active and before the check-in deadline, so it can do nothing right now.</p>
      )}

      {r.state !== 'off' && (
        <details className="disclose">
          <summary>What a recovery key cannot do</summary>
          <p>
            It cannot delay, stop or cancel a release, and it stops working the moment a countdown starts. It must be
            used at least {span(r.delay)} before a check-in deadline, so a loss you discover late cannot be recovered.
            Anyone who finds it can take over the vault if your passkey signs nothing for {span(r.delay)}, which includes
            after your death. And everyone can see that this vault has one.
          </p>
        </details>
      )}
      {sheet && nextKey && <RecoveryKeySheet keyText={nextKey} delay={r.delay} replaces onClose={() => setSheet(false)} />}
    </section>
  );
}

export function SettingsView({ s }: { s: Snapshot }) {
  return (
    <div className="settings stack-40">
      <div className="owner-head">
        <div className="stack-12">
          <h1 className="disp h-sm">Guardians and recovery</h1>
          <p className="lede">
            The things you change rarely: who can start the switch early, and the way back in if you lose your passkey.
            Changes here are signed with {s.passkey?.kind === 'device' ? 'Face ID' : 'your demo key'}, like a check-in.
          </p>
        </div>
      </div>
      <Guardians s={s} />
      <Recovery s={s} />
    </div>
  );
}
