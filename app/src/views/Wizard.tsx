// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Create a vault in nine steps: a will, and a sealed message if the owner has
// one. The side panel shows, as you go, what stays on this device and the real
// values that would go on-chain.

import { useEffect, useMemo, useState } from 'react';
import { HashChip, Icon, ICONS, FACE_ID, Logo, Segmented } from '../components/ui.js';
import {
  DAY, days, defaultSetup, demo, fitSetup, fmtShort, graceChoices, GUARDIANS, HEIRS, MESSAGE_MAX, OWNER_NAME, recipientName, recoveryDelayChoices, span,
  type MessageTo, type Snapshot, type VaultSetup,
} from '../demo/store.js';
import { PRESETS, presetFor } from '../demo/guide.js';
import { recoveryKeyGroups } from '../demo/recoveryKey.js';
import { DISCLOSURE_EXAMPLES, MESSAGE_EXAMPLES } from './MessagesView.js';
import { PlanSummary } from './PlanSummary.js';
import { RecoveryKeySheet } from './RecoveryKeySheet.js';
import { createDemoPasskey, createDevicePasskey, passkeySupport, type OwnerPasskey, type PasskeySupport } from '../demo/passkey.js';

const LABELS = ['Passkey', 'Heirs', 'Shares & dates', 'Guardians', 'Timers', 'Recovery key', 'Sealed message', 'Review', 'Deploy'];
const RECOVERY = 5;
const MESSAGE = 6;
const REVIEW = 7;
const DEPLOY = 8;
const COPY: [string, string, string][] = [
  ['Step 1 · Sign-in', 'Protect your vault with your face or fingerprint.', 'No passwords, no seed phrase. Your passkey is the only thing that can check in or change the will.'],
  ['Step 2 · Heirs', 'Who should inherit?', 'Nicknames stay on this device. Each heir made a key on their own phone and sent you only its public half.'],
  ['Step 3 · Shares', 'How much, and from when?', 'Shares can add up to less than 100%. Anything not allocated stays in the vault.'],
  ['Step 4 · Guardians (optional)', 'Who can confirm, early, that you’ve died?', 'Guardians are people you trust, such as family or a lawyer. They can start the switch before your deadline. You can still cancel.'],
  ['Step 5 · Timers', 'How long before the switch starts?', 'Choose a rhythm you’ll actually keep. These are fixed once the vault is created.'],
  ['Step 6 · Recovery key (optional)', 'What if you lose your passkey?', 'Without your passkey you cannot check in, so the will would be released while you are alive. A recovery key is a way back in. It also adds a risk, so read this step before you choose.'],
  ['Step 7 · Sealed message (optional)', 'Is there something to say, or to hand over?', 'A will passes on money. A sealed message passes on words: a letter, the recovery phrase of a wallet outside this vault, or documents that must come out if you cannot publish them yourself. Leave it empty to skip; you can write one later.'],
  ['Step 8 · Review', 'Read it once more.', 'Everything below stays on your device except where marked as on-chain.'],
  ['Step 9 · Deploy', 'Seal the will.', 'One confirmation creates your vault and seals the will.'],
];

const toDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const fromDate = (d: string) => Math.floor(Date.parse(d + 'T09:00:00Z') / 1000);
const pct = (bps: bigint) => Number(bps) / 100;

export function Wizard({ s, onDone }: { s: Snapshot; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [support, setSupport] = useState<PasskeySupport>();
  const [passkey, setPasskey] = useState<OwnerPasskey>();
  const [setup, setSetup] = useState<VaultSetup>(() => defaultSetup());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The owner confirms the recovery key is saved before going on; it is not shown again.
  const [keySaved, setKeySaved] = useState(false);
  const [sheet, setSheet] = useState(false);
  // A message written here is sealed on this device right after the vault exists.
  const [noteTo, setNoteTo] = useState<MessageTo>('ada');
  const [note, setNote] = useState('');
  useEffect(() => { void passkeySupport().then(setSupport); }, []);

  const preview = useMemo(() => demo.preview(setup, passkey), [setup, passkey]);
  const total = pct(setup.ada + setup.ben + setup.cleo);
  const over = total > 100;
  // A shorter check-in period can make the chosen grace period or recovery delay too long; bring them back in range.
  const patch = (p: Partial<VaultSetup>) => setSetup((x) => fitSetup({ ...x, ...p }));
  const deployed = s.ready;
  const wantsKey = setup.recoveryDelay > 0;
  const recoveryKey = useMemo(() => (wantsKey ? demo.draftRecoveryKey() : ''), [wantsKey]);
  const delays = recoveryDelayChoices(setup.every);
  const noteOpen = noteTo === 'everyone';
  const noteFor = { name: recipientName(noteTo) };
  const noteExamples = noteOpen ? DISCLOSURE_EXAMPLES : MESSAGE_EXAMPLES.map((x) => ({ label: x.label, text: x.text(noteFor.name) }));
  const noteLength = note.trim().length;
  const noteOver = noteLength > MESSAGE_MAX;
  const holders = setup.guardians.length;
  const noteLine = noteLength > 0 ? `For ${noteFor.name}, ${noteLength.toLocaleString()} character${noteLength === 1 ? '' : 's'}` : 'None';

  const register = async (kind: 'device' | 'demo') => {
    setBusy(true);
    setError(undefined);
    try {
      setPasskey(kind === 'device' ? await createDevicePasskey() : createDemoPasskey());
    } catch (e) {
      setError(e instanceof Error && e.name === 'NotAllowedError'
        ? 'Passkey creation was cancelled. Try again, or use a demo key.'
        : `Could not create the passkey: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const deploy = async () => {
    if (!passkey) return;
    setBusy(true);
    setError(undefined);
    try {
      await demo.setUp(passkey, setup);
      if (noteLength > 0) {
        const wrong = await demo.sealMessage(noteTo, note, undefined, { quiet: true });
        if (wrong) setError(`Your vault is created, but the message was not sealed. ${wrong} You can seal it under Messages.`);
      }
    } catch (e) {
      setError(`The vault could not be deployed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const blocked = (step === 0 && !passkey) || (step === 2 && (over || !!preview.problem)) || (step === RECOVERY && wantsKey && !keySaved) || (step === MESSAGE && noteOver);
  const [eyebrow, title, plainLede] = COPY[step];
  const lede = step === DEPLOY && noteLength > 0
    ? (noteOpen
      ? 'One confirmation creates your vault and seals the will. Your disclosure is sealed on this device at the same moment, and only its fingerprint goes to the chain.'
      : `One confirmation creates your vault and seals the will. Your message for ${noteFor.name} is sealed on this device at the same moment, and never goes to the chain.`)
    : plainLede;
  const keyEnd = (id: string) => demo.heirKeyEnd(id as never);

  return (
    <div className="wizard wrap">
      <div className="wiz-progress" aria-hidden="true"><span style={{ width: `${((step + 1) / LABELS.length) * 100}%` }} /></div>
      <div className="wiz-grid">
        <nav className="wiz-steps" aria-label="Steps">
          <ol>
            {LABELS.map((label, i) => (
              <li key={label}>
                <button
                  type="button"
                  aria-current={i === step ? 'step' : undefined}
                  className={i < step ? 'is-done' : undefined}
                  disabled={deployed || (i > step && blocked) || (i > 0 && !passkey)}
                  onClick={() => setStep(i)}
                >
                  <span className="mono wiz-mark">{i < step ? '✓' : i + 1}</span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <main className="wiz-main" id="main">
          <div className="wiz-head">
            <span className="eyebrow">{eyebrow}</span>
            <h1 className="disp">{title}</h1>
            <p className="lede">{lede}</p>
          </div>

          {step === 0 && (
            <div className="card wiz-card">
              {!passkey ? (
                <div className="wiz-actions">
                  <button type="button" className="btn btn-primary btn-lg" disabled={busy || !support?.available} onClick={() => void register('device')}>
                    <Icon d={FACE_ID} size={20} stroke={1.6} />Register Face ID or Touch ID
                  </button>
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void register('demo')}>Use a demo key instead</button>
                  {support && !support.available && <p className="small muted">{support.reason}</p>}
                </div>
              ) : (
                <div className="wiz-ok fade-in">
                  <span className="ok-ring"><Icon d={ICONS.check} size={20} stroke={1.8} /></span>
                  <div>
                    <strong>{passkey.kind === 'device' ? 'Passkey registered on this device.' : 'Demo key created in this tab.'}</strong>
                    <div className="small muted">Public key <HashChip value={passkey.pk.x.toString(16).padStart(64, '0')} tone="private" /></div>
                  </div>
                </div>
              )}
              {error && <p className="err-inline" role="alert">{error}</p>}
              <details className="disclose">
                <summary>Why is there no seed phrase?</summary>
                <p>
                  Your vault is controlled by a passkey, a key created inside your device's secure chip. It can't be copied,
                  phished or written down wrongly, and it only works with your face, fingerprint or device PIN. The chain
                  stores only a sealed commitment to it, so nobody can tell whose vault this is.
                </p>
              </details>
            </div>
          )}

          {step === 1 && (
            <div className="wiz-list">
              {HEIRS.filter((h) => !h.backup).map((h) => (
                <div key={h.id} className="card wiz-heir">
                  <div>
                    <span className="wiz-heir-name">{h.name}</span>
                    <span className="small muted">{h.relation}</span>
                  </div>
                  <span className="mono tag-private">◆ stays on this device</span>
                  <span className="wiz-heir-key">
                    <span className="small muted">Their public key</span>
                    <span className="chip chip-private">key …{keyEnd(h.id)}</span>
                    <span className="state-tag tone-armed"><span className="dot" aria-hidden="true" />Joined</span>
                  </span>
                </div>
              ))}
              <p className="small muted">
                In a real vault you would paste each key, or send an invite link that makes the key on their phone.
                The demo has made {HEIRS.filter((h) => !h.backup).length} heirs and a backup for you, so you can try every path.
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="wiz-list">
              {(['ada', 'ben', 'cleo'] as const).map((id) => {
                const h = HEIRS.find((x) => x.id === id)!;
                return (
                  <div key={id} className="card wiz-share">
                    <label className="share-row">
                      <span className="share-name">{h.name}</span>
                      <input
                        type="range" className="range" min={5} max={100} step={5}
                        value={pct(setup[id])}
                        aria-label={`Share for ${h.name}`}
                        onChange={(e) => patch({ [id]: BigInt(Number(e.target.value) * 100) })}
                      />
                      <span className="mono share-pct">{pct(setup[id])}%</span>
                    </label>
                    {id === 'cleo' && (
                      <label className="field-label">
                        Unlocks (Cleo turns 18)
                        <input type="date" className="field" value={toDate(setup.cleoUnlock)} onChange={(e) => e.target.value && patch({ cleoUnlock: fromDate(e.target.value) })} />
                      </label>
                    )}
                  </div>
                );
              })}
              <div className={`total ${over ? 'is-over' : total === 100 ? 'is-full' : ''}`} role="status" aria-live="polite">
                <div className="total-row"><span>Total allocated</span><span className="mono">{total}% <span className="muted">of 100%</span></span></div>
                <div className="total-bar" aria-hidden="true"><span style={{ width: `${Math.min(total, 100)}%` }} /></div>
                <span className="small">{over ? `That’s ${total - 100}% too much. Lower a share to continue.` : total === 100 ? 'Everything is allocated.' : `${100 - total}% unallocated, kept in the vault.`}</span>
              </div>
              <label className="field-label">
                Backup heir for Ada (claims her share if she hasn't within 30 days)
                <select className="field" value={setup.kofiBackup ? 'kofi' : 'none'} onChange={(e) => patch({ kofiBackup: e.target.value === 'kofi' })}>
                  <option value="kofi">Kofi, Amara's brother</option>
                  <option value="none">None</option>
                </select>
              </label>
            </div>
          )}

          {step === 3 && (
            <div className="card wiz-card">
              <ul className="wiz-guardians">
                {GUARDIANS.map((g) => (
                  <li key={g.id}><span>{g.name}</span><span className="small muted">{g.relation}</span><span className="mono tag-private">◆ private</span></li>
                ))}
              </ul>
              <div className="stepper-row">
                <span>Votes needed to start the switch early</span>
                <div className="stepper">
                  <button type="button" className="icon-btn" aria-label="Fewer votes needed" disabled={setup.threshold <= 1} onClick={() => patch({ threshold: setup.threshold - 1 })}>−</button>
                  <span className="mono" aria-live="polite">{setup.threshold} of {GUARDIANS.length}</span>
                  <button type="button" className="icon-btn" aria-label="More votes needed" disabled={setup.threshold >= GUARDIANS.length} onClick={() => patch({ threshold: setup.threshold + 1 })}>+</button>
                </div>
              </div>
              <p className="muted">
                If {setup.threshold} of your {GUARDIANS.length} guardians say you have died, the switch starts early. You still get the
                full challenge window to cancel. Guardians never learn each other's identity.
              </p>
            </div>
          )}

          {step === 4 && (
            <div className="card wiz-card">
              <fieldset>
                <legend>Start from a preset</legend>
                <div className="presets" role="group" aria-label="Presets">
                  {PRESETS.map((p) => (
                    <button key={p.id} type="button" className="preset" aria-pressed={presetFor(setup) === p.id} onClick={() => patch(p.values)}>
                      <span className="preset-name">{p.name}</span>
                      <span className="small">{p.tagline}</span>
                      <span className="mono preset-values">{days(p.values.every)}d · {days(p.values.window)}d · {p.values.threshold} of {GUARDIANS.length}</span>
                      <span className="small muted">{p.forWhom}</span>
                    </button>
                  ))}
                </div>
                <span className="small muted">A preset sets the timers below and the guardian threshold. Everything stays editable.</span>
              </fieldset>
              <fieldset>
                <legend>How often will you check in?</legend>
                <Segmented<number>
                  label="Check-in interval"
                  value={setup.every}
                  options={[7, 30, 90, 180].map((d) => ({ value: d * DAY, label: `${d} days` }))}
                  onChange={(v) => patch({ every: v })}
                />
                <span className="small muted">You'd be reminded 7 days and 1 day before.</span>
              </fieldset>
              <fieldset>
                <legend>Challenge window: your time to cancel after the switch starts</legend>
                <Segmented<number>
                  label="Challenge window"
                  value={setup.window}
                  options={[3, 7, 14, 30].map((d) => ({ value: d * DAY, label: `${d} days` }))}
                  onChange={(v) => patch({ window: v })}
                />
              </fieldset>
              <fieldset>
                <legend>Grace period: extra time to check in after you miss a deadline</legend>
                <Segmented<number>
                  label="Grace period"
                  value={setup.grace}
                  options={graceChoices(setup.every).map((g) => ({ value: g, label: g === 0 ? 'None' : span(g) }))}
                  onChange={(v) => patch({ grace: v })}
                />
                <span className="small muted">
                  {setup.grace > 0
                    ? `If you are up to ${span(setup.grace)} late, your check-in still works as usual and nobody can start the switch over it. Your time to cancel is counted from the end of the grace period, so it is never shortened. Heirs wait ${span(setup.grace)} longer, and a late check-in is visibly late on the chain.`
                    : 'With no grace period, anyone can start the switch the moment you miss a check-in. If you are a day late, you cancel a countdown that everyone can see.'}
                </span>
              </fieldset>
              <div className="worst">In the worst case, heirs can claim <strong>{days(setup.every + setup.grace + setup.window)} days</strong> after your last check-in.</div>
            </div>
          )}

          {step === RECOVERY && (
            <div className="card wiz-card">
              <fieldset>
                <legend>Do you want a recovery key?</legend>
                <Segmented<string>
                  label="Recovery key"
                  value={wantsKey ? 'yes' : 'no'}
                  options={[{ value: 'no', label: 'No recovery key' }, { value: 'yes', label: 'Create a recovery key' }]}
                  onChange={(v) => { setKeySaved(false); patch({ recoveryDelay: v === 'yes' ? (delays.includes(3 * DAY) ? 3 * DAY : delays[0]) : 0 }); }}
                />
                {!wantsKey && (
                  <span className="small muted">
                    Without one, a lost passkey cannot be replaced. You could no longer check in or change the will, and the
                    will would be released to your heirs at your deadline. You cannot add a recovery key later.
                  </span>
                )}
              </fieldset>

              {wantsKey && (
                <>
                  <fieldset>
                    <legend>How long must a recovery wait before it takes effect?</legend>
                    <Segmented<number>
                      label="Recovery delay"
                      value={setup.recoveryDelay}
                      options={delays.map((d) => ({ value: d, label: span(d) }))}
                      onChange={(v) => patch({ recoveryDelay: v })}
                    />
                    <span className="small muted">
                      The delay is your protection: during it, anything your passkey signs cancels the recovery. Choose one
                      long enough that you would notice, and short enough to fit before a deadline. It is always shorter
                      than your check-in period of {days(setup.every)} days.
                    </span>
                  </fieldset>

                  <div className="rk-box fade-in">
                    <div className="stack-6">
                      <h2 className="rk-title">Your recovery key</h2>
                      <span className="small muted">Made on this device just now. Only a fingerprint of it goes on-chain. Save it before you continue: it is not shown again.</span>
                    </div>
                    <p className="mono rk-groups" aria-label="Your recovery key">
                      {recoveryKeyGroups(recoveryKey).map((g, i) => <span key={i}>{g}</span>)}
                    </p>
                    <div className="btn-row">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSheet(true)}>Open the sheet to print or download</button>
                    </div>
                    <label className="check">
                      <input type="checkbox" checked={keySaved} onChange={(e) => setKeySaved(e.target.checked)} />
                      I have saved my recovery key somewhere away from this device.
                    </label>
                  </div>

                  <div className="stack-8">
                    <h2 className="rk-title">What to know before you rely on it</h2>
                    <ul className="plain-list">
                      <li>Anyone who finds the key can start a recovery. If your passkey signs nothing for {span(setup.recoveryDelay)}, they become the owner. That includes after your death, if a deadline is further away than the delay.</li>
                      <li>It must be used at least {span(setup.recoveryDelay)} before a check-in deadline. If you discover the loss later than that, it cannot help and the will is released.</li>
                      <li>It works once. If a recovery is cancelled, the key is retired for good, and this version of Codicil cannot give the vault a new one.</li>
                      <li>It cannot delay, stop or cancel a release. Only a check-in does that.</li>
                      <li>Everyone can see that this vault has a recovery key, and can see a recovery start.</li>
                    </ul>
                  </div>
                </>
              )}
            </div>
          )}
          {sheet && <RecoveryKeySheet keyText={recoveryKey} delay={setup.recoveryDelay} onClose={() => setSheet(false)} />}

          {step === MESSAGE && (
            <div className="card wiz-card">
              <label className="field-label">
                Who is it for?
                <select
                  className="field" value={noteTo}
                  onChange={(e) => {
                    const to = e.target.value as MessageTo;
                    // An example that was written to the last person is rewritten to the new one.
                    const used = noteOpen ? -1 : MESSAGE_EXAMPLES.findIndex((x) => x.text(noteFor.name) === note);
                    if (used >= 0) setNote(to === 'everyone' ? '' : MESSAGE_EXAMPLES[used].text(recipientName(to)));
                    else if (noteOpen && DISCLOSURE_EXAMPLES.some((x) => x.text === note)) setNote('');
                    setNoteTo(to);
                  }}
                >
                  {HEIRS.map((h) => <option key={h.id} value={h.id}>{h.name}, {h.relation[0].toLowerCase() + h.relation.slice(1)}</option>)}
                  <option value="everyone">Everyone, as a public disclosure</option>
                </select>
              </label>
              <div className="stack-12">
                <label className="field-label">
                  {noteOpen ? 'Your disclosure, for everyone' : `Your message for ${noteFor.name}`}
                  <textarea
                    className="field msg-text" value={note} rows={8} aria-invalid={noteOver || undefined}
                    placeholder={noteOpen ? 'Write what should come out if you can no longer say it yourself.' : `Write to ${noteFor.name}. Only ${noteFor.name} will ever read this.`}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <div className="msg-under">
                  <span className="small muted">
                    Or start from an example:{' '}
                    {noteExamples.map((x, i) => (
                      <span key={x.label}>
                        <button type="button" className="linkish" onClick={() => setNote(x.text)}>{x.label.toLowerCase()}</button>
                        {i < noteExamples.length - 1 && ', '}
                      </span>
                    ))}
                  </span>
                  <span className={`small mono ${noteOver ? 'msg-over' : 'muted'}`}>{noteLength.toLocaleString()} / {MESSAGE_MAX.toLocaleString()}</span>
                </div>
                {noteOver && <p className="err-inline" role="alert">That is too long. The demo seals up to {MESSAGE_MAX.toLocaleString()} characters.</p>}
              </div>
              <div className="stack-8">
                <h2 className="rk-title">How it stays shut</h2>
                {noteOpen ? (
                  <ul className="plain-list">
                    <li>It is locked on this device when you create the vault. The sealed text can be posted anywhere: without its key it is noise.</li>
                    <li>A fingerprint of it goes on the chain, in a contract called the seal register. Later, that shows the text existed today and was not changed.</li>
                    <li>{holders === 1 ? 'Your guardian keeps the key' : `Your ${holders} guardians each keep a piece of the key`}. The register refuses {holders === 1 ? 'it' : 'every piece'} until your vault has released. After that{holders === 1 ? '' : `, once ${setup.threshold} ${setup.threshold === 1 ? 'is' : 'are'} handed over`}, anyone can open the text.</li>
                    <li>It rests on that promise. {setup.threshold === 1 ? 'One guardian' : `Any ${setup.threshold} guardians`}, acting together, could open it early, so choose guardians you trust with it.</li>
                  </ul>
                ) : (
                  <ul className="plain-list">
                    <li>It is locked on this device when you create the vault. Nothing about it goes on the chain, not even that it exists.</li>
                    <li>{noteFor.name} keeps the locked text and half of the key. {holders === 1
                      ? 'Your guardian keeps the other half'
                      : `Your ${holders} guardians each keep a piece of the other half`} and {holders === 1 ? 'hands' : 'hand'} it over only after the vault releases{holders === 1 ? '' : `; ${setup.threshold} of them ${setup.threshold === 1 ? 'is' : 'are'} needed`}.</li>
                    <li>It rests on that promise. {setup.threshold === 1 ? 'One guardian' : `Any ${setup.threshold} guardians`} and {noteFor.name}, acting together, could open it early, so choose guardians you trust with it.</li>
                  </ul>
                )}
              </div>
            </div>
          )}

          {step === REVIEW && (
            <div className="card review">
              {([
                ['Sign-in', passkey?.kind === 'device' ? 'Passkey on this device' : 'Demo key in this tab', 0],
                ['Heirs', `Ada ${pct(setup.ada)}% · Ben ${pct(setup.ben)}% · Cleo ${pct(setup.cleo)}%`, 2],
                ['Unlock dates', `Ada: on release · Ben: on release · Cleo: ${fmtShort(setup.cleoUnlock)}`, 2],
                ['Backup heir', setup.kofiBackup ? 'Kofi, for Ada’s share' : 'None', 2],
                ['Guardians', `${setup.threshold} of ${GUARDIANS.length} must agree`, 3],
                ['Timers', `Check in every ${days(setup.every)} days · ${setup.grace > 0 ? `${span(setup.grace)} of grace` : 'no grace period'} · ${days(setup.window)}-day challenge window`, 4],
                ['Recovery key', wantsKey ? `Saved by you · takes effect after ${span(setup.recoveryDelay)}` : 'None', RECOVERY],
                ['Sealed message', noteLength > 0 ? `${noteLine}. ${noteOpen ? 'Only its fingerprint goes on the chain.' : 'Kept off the chain.'}` : 'None', MESSAGE],
              ] as const).map(([k, v, go]) => (
                <div key={k} className="review-row">
                  <span className="eyebrow">{k}</span>
                  <span>{v}</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(go)}>Edit</button>
                </div>
              ))}
            </div>
          )}

          {step === REVIEW && <PlanSummary setup={setup} now={Math.floor(Date.now() / 1000)} />}

          {step === DEPLOY && (
            <div className="card deploy">
              {!deployed ? (
                <>
                  <svg className={`deploy-ring ${busy ? 'is-busy' : ''}`} width="96" height="96" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                    <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="0.8" strokeDasharray="2 2" />
                  </svg>
                  <p className="muted">
                    Deploying runs the vault's constructor on this device and seals the will on the demo chain. On
                    Midnight this takes about 20 seconds.
                  </p>
                  <button type="button" className="btn btn-primary btn-lg" disabled={busy} onClick={() => void deploy()}>
                    {busy ? 'Sealing…' : 'Seal & deploy vault'}
                  </button>
                  {error && <p className="err-inline" role="alert">{error}</p>}
                </>
              ) : (
                <>
                  <span className="seal-press" aria-hidden="true"><Logo size={56} /></span>
                  <h2 className="disp">Your will is <em>sealed.</em></h2>
                  <p className="muted">Vault deployed. Your first check-in is due on {fmtShort(s.deadline)}.</p>
                  {s.messages.length > 0 && (
                    <p className="muted">
                      {noteOpen
                        ? 'Your disclosure is sealed too, and its fingerprint is on the seal register. It opens only after the vault releases.'
                        : `Your message for ${noteFor.name} is sealed too. It opens only after the vault releases, and only for ${noteFor.name}.`}
                    </p>
                  )}
                  {error && <p className="err-inline" role="alert">{error}</p>}
                  <button type="button" className="btn btn-primary" onClick={onDone} autoFocus>
                    Go to my vault <span className="arw" aria-hidden="true">→</span>
                  </button>
                </>
              )}
            </div>
          )}

          {!deployed && (
            <div className="wiz-nav">
              <button type="button" className="btn btn-ghost" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>← Back</button>
              {step < DEPLOY && (
                <button type="button" className="btn btn-primary" disabled={blocked} onClick={() => setStep(step + 1)}>
                  {step === REVIEW ? 'Looks right, deploy' : 'Continue'} <span className="arw" aria-hidden="true">→</span>
                </button>
              )}
            </div>
          )}
        </main>

        <aside className="wiz-aside" aria-label="What stays private and what goes on-chain">
          <div className="side-block side-private">
            <span className="eyebrow"><Icon d={ICONS.phone} size={14} stroke={2} />Stays private on your device</span>
            <dl>
              <div><dt>Owner</dt><dd>{OWNER_NAME}</dd></div>
              <div><dt>Passkey (private half)</dt><dd>{passkey ? (passkey.kind === 'device' ? 'Secure Enclave' : 'Demo key, memory') : '—'}</dd></div>
              <div><dt>Ada</dt><dd>{pct(setup.ada)}% · key …{keyEnd('ada')}{setup.kofiBackup ? ' · backup Kofi' : ''}</dd></div>
              <div><dt>Ben</dt><dd>{pct(setup.ben)}% · key …{keyEnd('ben')}</dd></div>
              <div><dt>Cleo</dt><dd>{pct(setup.cleo)}% · {fmtShort(setup.cleoUnlock)}</dd></div>
              <div><dt>Guardian identities</dt><dd>{GUARDIANS.length} people</dd></div>
              <div><dt>Recovery key</dt><dd>{wantsKey ? 'On paper, with you' : 'None'}</dd></div>
              <div><dt>Sealed message</dt><dd>{noteLine}</dd></div>
            </dl>
          </div>
          <div className="side-cross mono"><Icon d={ICONS.down} size={14} stroke={2} />zero-knowledge: only fingerprints cross</div>
          <div className="side-block side-public">
            <span className="eyebrow"><Icon d={ICONS.chain} size={14} stroke={2} />Goes on-chain (public)</span>
            <dl>
              <div><dt>Owner key</dt><dd className="mono">{preview.ownerCommit ? `commit 0x${preview.ownerCommit.slice(0, 4)}…${preview.ownerCommit.slice(-4)}` : '—'}</dd></div>
              <div><dt>Heirs root</dt><dd className="mono">{preview.willRoot ? `0x${preview.willRoot.slice(0, 4)}…${preview.willRoot.slice(-4)}` : 'not valid yet'}</dd></div>
              <div><dt>Guardians root</dt><dd className="mono">0x{preview.guardianRoot.slice(0, 4)}…{preview.guardianRoot.slice(-4)}</dd></div>
              <div><dt>Threshold</dt><dd className="mono">k = {setup.threshold}</dd></div>
              <div><dt>Check-in every</dt><dd className="mono">{setup.every.toLocaleString('en-GB')} s</dd></div>
              <div><dt>Challenge window</dt><dd className="mono">{setup.window.toLocaleString('en-GB')} s</dd></div>
              <div><dt>Grace period</dt><dd className="mono">{setup.grace > 0 ? `${setup.grace.toLocaleString('en-GB')} s` : 'none'}</dd></div>
              <div><dt>Recovery key</dt><dd className="mono">{preview.recoveryCommit ? `commit 0x${preview.recoveryCommit.slice(0, 4)}…${preview.recoveryCommit.slice(-4)}` : 'none'}</dd></div>
              {wantsKey && <div><dt>Recovery delay</dt><dd className="mono">{setup.recoveryDelay.toLocaleString('en-GB')} s</dd></div>}
              <div><dt>Release fee</dt><dd className="mono">none</dd></div>
              <div><dt>Sealed message</dt><dd className="mono">{noteOpen && noteLength > 0 ? 'a fingerprint' : 'nothing'}</dd></div>
            </dl>
            <p className="small muted">
              The heirs root changes as you edit. It is a fingerprint of the whole will, computed by the real circuit, so it
              reveals neither how many heirs there are nor who they are.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
