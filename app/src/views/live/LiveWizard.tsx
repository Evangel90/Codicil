// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Create a real vault in five steps: you, your heirs, your guardians, your
// timers, and a last look. The same screen as the demo's wizard, with the
// owner's own people in place of the demo's cast.

import { useEffect, useState } from 'react';
import { FACE_ID, HashChip, Icon, ICONS, Segmented } from '../../components/ui.js';
import { createDemoPasskey, createDevicePasskey, passkeySupport, type OwnerPasskey } from '../../demo/passkey.js';
import { walletReadiness } from '../../live/problems.js';
import { live, session, type Connection } from '../../live/session.js';
import { DAY, DEFAULT_TIMERS, DEPLOY_ALLOWANCE, draftProblems, emptyDraft, span, TESTING_TIMERS, type HeirDraft, type VaultDraft } from '../../live/store.js';
import { networkName } from '../../live/wallet.js';
import { ProblemCard, ProofServerNote } from './parts.js';

const LABELS = ['You', 'Heirs', 'Guardians', 'Timers', 'Review'];
const COPY: [string, string, string][] = [
  ['Step 1 of 5', 'Who is this vault for, and how will you sign?', 'Your name goes into the invitations you send to your heirs and guardians. It is never published. Your passkey is what proves, each time you check in, that it is really you.'],
  ['Step 2 of 5', 'Who should inherit?', 'Names and shares stay in this browser. The network only ever sees one number that seals the whole list.'],
  ['Step 3 of 5', 'Who can say, early, that you have died?', 'Guardians are optional. They are people you trust who can start the switch before your deadline. You can still cancel it.'],
  ['Step 4 of 5', 'How long before the switch starts?', 'Choose a rhythm you will keep. The timers are fixed once the vault is created.'],
  ['Step 5 of 5', 'Read it once more.', 'Creating the vault seals this will. Heirs and shares cannot be changed in this version of the app once it is sealed.'],
];

const toDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const fromDate = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);

export function LiveWizard({ connection, onCancel }: { connection: Connection; onCancel?: () => void }) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<VaultDraft>(emptyDraft);
  const [passkey, setPasskey] = useState<OwnerPasskey>();
  const [deviceOk, setDeviceOk] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { void passkeySupport().then((s) => setDeviceOk(s.available)); }, []);

  const patch = (p: Partial<VaultDraft>) => setDraft((d) => ({ ...d, ...p }));
  const setHeir = (i: number, p: Partial<HeirDraft>) => patch({ heirs: draft.heirs.map((h, k) => (k === i ? { ...h, ...p } : h)) });
  const total = draft.heirs.reduce((sum, h) => sum + (Number.isFinite(h.sharePct) ? h.sharePct : 0), 0);
  const problems = draftProblems(draft);
  const network = connection.network ?? '';
  const readiness = connection.balances && walletReadiness(connection.balances, 'deployment', { network, wallet: connection.walletName, address: connection.address?.bech32 });
  const blockedHere = [
    !passkey || draft.ownerName.trim() === '',
    problems.some((p) => /heir|share/i.test(p)),
    problems.some((p) => /guardian/i.test(p)),
    problems.some((p) => /period|window/i.test(p)),
    problems.length > 0,
  ][step];

  const register = async (kind: 'device' | 'browser') => {
    setBusy(true);
    setError(undefined);
    try {
      setPasskey(kind === 'device' ? await createDevicePasskey() : createDemoPasskey());
    } catch (e) {
      setError(e instanceof Error && e.name === 'NotAllowedError'
        ? 'The passkey was not created: the request was cancelled or timed out. Try again when you are ready.'
        : `The passkey could not be created. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!passkey) return;
    setBusy(true);
    setError(undefined);
    try {
      await live.createVault(draft, passkey);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const [eyebrow, title, lede] = COPY[step];
  const t = draft.timers;
  const firstDeadline = Math.floor(Date.now() / 1000) + t.every + (t.testing ? DEPLOY_ALLOWANCE : 0);

  return (
    <div className="wizard wrap">
      <div className="wiz-progress" aria-hidden="true"><span style={{ width: `${((step + 1) / LABELS.length) * 100}%` }} /></div>
      <div className="wiz-grid">
        <nav className="wiz-steps" aria-label="Steps">
          <ol>
            {LABELS.map((label, i) => (
              <li key={label}>
                <button type="button" aria-current={i === step ? 'step' : undefined} className={i < step ? 'is-done' : undefined} disabled={i > step} onClick={() => setStep(i)}>
                  <span className="mono wiz-mark">{i < step ? '✓' : i + 1}</span>{label}
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
              <label className="field-label">
                Your name
                <input className="field" value={draft.ownerName} autoComplete="name" placeholder="As your heirs know you" onChange={(e) => patch({ ownerName: e.target.value })} />
              </label>
              {!passkey ? (
                <div className="wiz-actions">
                  <button type="button" className="btn btn-primary btn-lg" disabled={busy || !deviceOk} onClick={() => void register('device')}>
                    <Icon d={FACE_ID} size={20} stroke={1.6} />Create a passkey on this device
                  </button>
                  {deviceOk === false && (
                    <>
                      <p className="small muted">
                        A device passkey (Face ID, Touch ID or Windows Hello) is not available here. This version of the vault only
                        accepts passkeys made at http://localhost:5173, in a browser that supports them. You can still try everything
                        with a key that is stored in this browser instead. It is less safe than a passkey: anyone who can read this
                        browser's data, or your backup file, can check in as you. That is acceptable on a test network.
                      </p>
                      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void register('browser')}>Use a key stored in this browser</button>
                    </>
                  )}
                </div>
              ) : (
                <div className="wiz-ok fade-in">
                  <span className="ok-ring"><Icon d={ICONS.check} size={20} stroke={1.8} /></span>
                  <div>
                    <strong>{passkey.kind === 'device' ? 'Passkey created on this device.' : 'Key created and stored in this browser.'}</strong>
                    <div className="small muted">Public key <HashChip value={passkey.pk.x.toString(16).padStart(64, '0')} tone="private" /></div>
                  </div>
                </div>
              )}
              {error && <p className="err-inline" role="alert">{error}</p>}
              <p className="small muted">
                A passkey lives in your device and cannot be copied into a backup file. If it syncs through your Apple, Google or
                Microsoft account, it follows you to a new device. If it does not and you lose this device, nobody can check in, and
                the will is released to your heirs when the timers run out.
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="wiz-list">
              {draft.heirs.map((h, i) => (
                <div key={i} className="card wiz-share">
                  <div className="live-row">
                    <label className="field-label">
                      Name
                      <input className="field" value={h.name} placeholder="Their name" onChange={(e) => setHeir(i, { name: e.target.value })} />
                    </label>
                    <label className="field-label live-narrow">
                      Share, in percent
                      <input
                        className="field mono" inputMode="decimal" value={Number.isFinite(h.sharePct) ? String(h.sharePct) : ''}
                        onChange={(e) => setHeir(i, { sharePct: e.target.value === '' ? NaN : Math.round(Number(e.target.value.replace(',', '.')) * 100) / 100 })}
                      />
                    </label>
                  </div>
                  <div className="live-row">
                    <label className="check">
                      <input type="checkbox" checked={h.unlockAt !== undefined} onChange={(e) => setHeir(i, { unlockAt: e.target.checked ? Math.floor(Date.now() / 1000) + 365 * DAY : undefined })} />
                      Hold this share until a date, for example an 18th birthday
                    </label>
                    {h.unlockAt !== undefined && (
                      <input type="date" className="field live-narrow" aria-label={`Date ${h.name || 'this heir'}'s share unlocks`} value={toDate(h.unlockAt)} onChange={(e) => e.target.value && setHeir(i, { unlockAt: fromDate(e.target.value) })} />
                    )}
                  </div>
                  <div className="live-row">
                    <label className="check">
                      <input type="checkbox" checked={h.backupName !== undefined} onChange={(e) => setHeir(i, { backupName: e.target.checked ? '' : undefined })} />
                      Name a backup, who can claim this share if {h.name.trim() || 'this heir'} has not within {t.testing ? '10 minutes' : '30 days'} of release
                    </label>
                    {h.backupName !== undefined && (
                      <input className="field" aria-label="Backup heir's name" placeholder="Backup's name" value={h.backupName} onChange={(e) => setHeir(i, { backupName: e.target.value })} />
                    )}
                  </div>
                  {draft.heirs.length > 1 && (
                    <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => patch({ heirs: draft.heirs.filter((_, k) => k !== i) })}>Remove {h.name.trim() || 'this heir'}</button></div>
                  )}
                </div>
              ))}
              <div><button type="button" className="btn btn-secondary" onClick={() => patch({ heirs: [...draft.heirs, { name: '', sharePct: Math.max(0, Math.round((100 - total) * 100) / 100) }] })}>Add another heir</button></div>
              <div className={`total ${total > 100 ? 'is-over' : total === 100 ? 'is-full' : ''}`} role="status" aria-live="polite">
                <div className="total-row"><span>Total allocated</span><span className="mono">{Math.round(total * 100) / 100}% <span className="muted">of 100%</span></span></div>
                <div className="total-bar" aria-hidden="true"><span style={{ width: `${Math.min(total, 100)}%` }} /></div>
                <span className="small">{total > 100 ? `That is ${Math.round((total - 100) * 100) / 100}% too much. Lower a share to continue.` : total === 100 ? 'Everything is allocated.' : `${Math.round((100 - total) * 100) / 100}% is not allocated. It stays in the vault and nobody can claim it.`}</span>
              </div>
              <p className="small muted">
                This browser makes a key for each heir and puts it in their invitation, which you send them after the vault is
                created. Whoever holds an invitation can claim that share once the will is released, so send each one privately.
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="card wiz-card">
              {draft.guardians.length === 0 && <p className="muted">No guardians. The switch can then only start when you miss a check-in.</p>}
              {draft.guardians.map((g, i) => (
                <div key={i} className="live-row">
                  <input className="field" aria-label={`Guardian ${i + 1}'s name`} placeholder="Their name" value={g} onChange={(e) => patch({ guardians: draft.guardians.map((x, k) => (k === i ? e.target.value : x)) })} />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => patch({ guardians: draft.guardians.filter((_, k) => k !== i), threshold: Math.max(1, Math.min(draft.threshold, draft.guardians.length - 1)) })}>Remove</button>
                </div>
              ))}
              <div><button type="button" className="btn btn-secondary" onClick={() => patch({ guardians: [...draft.guardians, ''] })}>Add a guardian</button></div>
              {draft.guardians.length > 0 && (
                <>
                  <div className="stepper-row">
                    <span>How many must agree to start the switch early</span>
                    <div className="stepper">
                      <button type="button" className="icon-btn" aria-label="Fewer must agree" disabled={draft.threshold <= 1} onClick={() => patch({ threshold: draft.threshold - 1 })}>−</button>
                      <span className="mono" aria-live="polite">{Math.min(draft.threshold, draft.guardians.length)} of {draft.guardians.length}</span>
                      <button type="button" className="icon-btn" aria-label="More must agree" disabled={draft.threshold >= draft.guardians.length} onClick={() => patch({ threshold: draft.threshold + 1 })}>+</button>
                    </div>
                  </div>
                  <p className="muted">
                    If {Math.min(draft.threshold, draft.guardians.length)} of them say you have died, the switch starts early. You still get the
                    full challenge window to cancel. Nobody, including the other guardians, can see who they are or who voted.
                  </p>
                </>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="card wiz-card">
              <fieldset>
                <legend>What are you doing today?</legend>
                <Segmented<string>
                  label="Kind of timers"
                  value={t.testing ? 'test' : 'real'}
                  options={[{ value: 'real', label: 'Setting up a real rhythm, in days' }, { value: 'test', label: 'Trying it out, in minutes' }]}
                  onChange={(v) => patch({ timers: v === 'test' ? { ...TESTING_TIMERS } : { ...DEFAULT_TIMERS } })}
                />
                {t.testing && (
                  <span className="small muted">
                    Testing timers let you see a missed check-in, the switch, the release and a claim in about a quarter of an hour.
                    They are far too short for a real will: miss one check-in by minutes and the vault is released.
                  </span>
                )}
              </fieldset>
              <fieldset>
                <legend>How often will you check in?</legend>
                <Segmented<number>
                  label="Check-in period"
                  value={t.every}
                  options={(t.testing ? [5, 10, 30] : [7, 30, 90, 180]).map((n) => ({ value: n * (t.testing ? 60 : DAY), label: `${n} ${t.testing ? 'minutes' : 'days'}` }))}
                  onChange={(v) => patch({ timers: { ...t, every: v, grace: Math.min(t.grace, v) } })}
                />
              </fieldset>
              <fieldset>
                <legend>Challenge window: your time to cancel after the switch starts</legend>
                <Segmented<number>
                  label="Challenge window"
                  value={t.window}
                  options={(t.testing ? [2, 3, 5] : [3, 7, 14, 30]).map((n) => ({ value: n * (t.testing ? 60 : DAY), label: `${n} ${t.testing ? 'minutes' : 'days'}` }))}
                  onChange={(v) => patch({ timers: { ...t, window: v } })}
                />
              </fieldset>
              {!t.testing && (
                <fieldset>
                  <legend>Grace period: extra time to check in after you miss a deadline</legend>
                  <Segmented<number>
                    label="Grace period"
                    value={t.grace}
                    options={[0, 1, 3, 7].filter((n) => n * DAY <= t.every).map((n) => ({ value: n * DAY, label: n === 0 ? 'None' : span(n * DAY) }))}
                    onChange={(v) => patch({ timers: { ...t, grace: v } })}
                  />
                  <span className="small muted">
                    {t.grace > 0
                      ? `If you are up to ${span(t.grace)} late, your check-in still works and nobody can start the switch over it. Heirs wait ${span(t.grace)} longer.`
                      : 'With no grace period, anyone can start the switch the moment you miss a check-in. You would then cancel a countdown that everyone can see.'}
                  </span>
                </fieldset>
              )}
              <div className="worst">In the worst case, heirs can claim <strong>{span(t.every + t.grace + t.window)}</strong> after your last check-in.</div>
            </div>
          )}

          {step === 4 && (
            <>
              <div className="card review">
                {([
                  ['Owner', `${draft.ownerName.trim()} · ${passkey?.kind === 'device' ? 'passkey on this device' : 'key stored in this browser'}`, 0],
                  ['Heirs', draft.heirs.map((h) => `${h.name.trim()} ${h.sharePct}%${h.unlockAt ? `, from ${toDate(h.unlockAt)}` : ''}${h.backupName ? `, backup ${h.backupName.trim()}` : ''}`).join(' · '), 1],
                  ['Guardians', draft.guardians.length === 0 ? 'None' : `${draft.guardians.map((g) => g.trim()).join(', ')} · ${Math.min(draft.threshold, draft.guardians.length)} must agree`, 2],
                  ['Timers', `Check in every ${span(t.every)} · ${t.grace > 0 ? `${span(t.grace)} of grace` : 'no grace period'} · ${span(t.window)} to cancel${t.testing ? ' · testing timers' : ''}`, 3],
                  ['First check-in due', new Date(firstDeadline * 1000).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' }) + (t.testing ? ' (15 minutes are added so creating the vault does not use up the first period)' : ''), 3],
                  ['Network', `Midnight ${networkName(network)}, a test network. Its tokens have no value, and it can be reset.`, 4],
                ] as const).map(([k, v, go]) => (
                  <div key={k} className="review-row">
                    <span className="eyebrow">{k}</span>
                    <span>{v}</span>
                    {go < 4 ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(go)}>Edit</button> : <span />}
                  </div>
                ))}
              </div>
              <div className="card pad-24 stack-12">
                <h2 className="disp h-card">What happens when you press the button</h2>
                <p className="muted">
                  Creating a vault takes <strong>eight transactions</strong>, so {connection.walletName ?? 'your wallet'} will ask you to approve eight
                  times, over about three minutes. The vault's rules are too large for one block on Midnight, so the first transaction
                  creates the vault with the rules it needs straight away, and seven more add the rest. Together they cost about 30 DUST.
                  If anything interrupts it, this page picks up where it stopped.
                </p>
              </div>
              <ProofServerNote up={connection.proofServerUp} keys={connection.provingKeys} />
              {readiness && <ProblemCard problem={readiness} onRetry={() => void session.refresh()} retryLabel="Check again" />}
              {problems.length > 0 && <p className="err-inline" role="alert">{problems[0]}</p>}
              {error && <p className="err-inline" role="alert">{error}</p>}
            </>
          )}

          <div className="wiz-nav">
            {step === 0
              ? (onCancel ? <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button> : <span />)
              : <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setStep(step - 1)}>Back</button>}
            {step < 4
              ? <button type="button" className="btn btn-primary" disabled={blockedHere} onClick={() => setStep(step + 1)}>Continue</button>
              : (
                <button
                  type="button" className="btn btn-primary btn-lg"
                  disabled={busy || problems.length > 0 || !passkey || connection.proofServerUp === false || connection.provingKeys === false || (readiness !== undefined && readiness.kind !== 'low-dust')}
                  onClick={() => void create()}
                >
                  Seal the will and create the vault
                </button>
              )}
          </div>
        </main>

        <aside className="wiz-aside" aria-label="What stays private and what is published">
          <div className="side-block side-private">
            <span className="eyebrow"><Icon d={ICONS.phone} size={14} stroke={2} />Stays in this browser</span>
            <dl>
              <div><dt>Your name</dt><dd>{draft.ownerName.trim() || '—'}</dd></div>
              <div><dt>Heirs and shares</dt><dd>{draft.heirs.filter((h) => h.name.trim()).map((h) => `${h.name.trim()} ${h.sharePct}%`).join(', ') || '—'}</dd></div>
              <div><dt>Guardians</dt><dd>{draft.guardians.filter((g) => g.trim()).join(', ') || 'None'}</dd></div>
              <div><dt>Every key and secret</dt><dd>Kept here, and in the backup file you save</dd></div>
            </dl>
          </div>
          <div className="side-cross mono"><Icon d={ICONS.down} size={14} stroke={2} />only fingerprints cross</div>
          <div className="side-block side-public">
            <span className="eyebrow"><Icon d={ICONS.chain} size={14} stroke={2} />Published on Midnight {networkName(network)}</span>
            <dl>
              <div><dt>Owner key</dt><dd>A sealed fingerprint</dd></div>
              <div><dt>The will</dt><dd>One number, for any number of heirs</dd></div>
              <div><dt>Guardians</dt><dd>{draft.guardians.length > 0 ? `One number, and "${Math.min(draft.threshold, draft.guardians.length)} must agree"` : 'None'}</dd></div>
              <div><dt>Timers</dt><dd className="mono">{t.every.toLocaleString('en-GB')} s · {t.window.toLocaleString('en-GB')} s</dd></div>
              <div><dt>Deposits</dt><dd>Amounts are public</dd></div>
            </dl>
            <p className="small muted">Anyone can see that a vault exists, its timers and what it holds. Nobody can see whose it is or who inherits.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
