// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Before anything else in live mode: setting this browser up, or opening it.
// Everything a person keeps here is encrypted. Face ID opens it on any device
// their passkey syncs to; their printed recovery code opens it anywhere, and
// also replaces a lost passkey on their vault. Neither alone is the only way in.

import { useMemo, useState } from 'react';
import { newRecoveryCode, recoveryCodeToText } from '@codicil/sdk';
import { FACE_ID, Icon, ICONS } from '../../components/ui.js';
import type { OwnerPasskey } from '../../demo/passkey.js';
import { askPrf, createPasskeyWithPrf, NoPrf, passkeysHere, type PrfSlot } from '../../live/prf.js';
import { live, session } from '../../live/session.js';
import type { AccessView } from '../../live/store.js';
import { downloadText } from './parts.js';

export const sentence = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.charAt(0).toUpperCase() + m.slice(1) + (/[.!?]$/.test(m) ? '' : '.');
};

/** Words for a failed passkey request. */
export function passkeyTrouble(e: unknown): string {
  if (e instanceof NoPrf) return 'Your passkey works, but this browser or passkey provider cannot unlock Codicil with it. Use your printed recovery code.';
  if (e instanceof Error && e.name === 'NotAllowedError') return 'The passkey request was cancelled or timed out. Try again, or use your printed recovery code.';
  return sentence(e);
}

/** First use in this browser: a passkey if possible, and always a recovery code, written down and checked. */
function SetUp({ access, onRestore }: { access: AccessView; onRestore: () => void }) {
  const [step, setStep] = useState<'passkey' | 'code'>('passkey');
  const [made, setMade] = useState<{ passkey: OwnerPasskey; prf?: PrfSlot }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const code = useMemo(() => newRecoveryCode(), []);
  const text = useMemo(() => recoveryCodeToText(code), [code]);
  const groups = text.split('-');
  // Which group to type back: one of the first five, never the short last one.
  const ask = useMemo(() => Math.floor(Math.random() * 5), []);
  const [typed, setTyped] = useState('');
  const confirmed = typed.trim().toUpperCase() === groups[ask];

  const makePasskey = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setMade(await createPasskeyWithPrf());
    } catch (e) {
      setError(passkeyTrouble(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await live.setUp({ code, passkey: made?.passkey, prf: made?.prf });
    } catch (e) {
      setError(sentence(e));
      setBusy(false);
    }
  };

  return (
    <main className="wrap page narrow stack-32" id="main">
      <div className="stack-18">
        <span className="eyebrow">{step === 'passkey' ? 'Step 1 of 2' : 'Step 2 of 2'}</span>
        <h1 className="disp h-sm">{step === 'passkey' ? 'Lock what this browser keeps.' : 'Write down your recovery code.'}</h1>
        <p className="lede">
          {step === 'passkey'
            ? 'Your will, your keys and your invitations are kept in this browser, encrypted. Two things can open them: your passkey, and a recovery code you print or write down. Either one is enough, so losing one is not losing everything.'
            : 'This code opens your records in any browser, on any device, even without your passkey. If you create a vault, it can also replace a lost passkey on it, after a public wait. Codicil cannot show it to you again or recover it.'}
        </p>
        {access.legacy > 0 && step === 'passkey' && (
          <p className="small muted">This browser holds {access.legacy} {access.legacy === 1 ? 'vault' : 'vaults'} from before records were locked. {access.legacy === 1 ? 'It is' : 'They are'} locked with the rest when you finish.</p>
        )}
      </div>

      {step === 'passkey' && (
        <section className="card pad-24 stack-12">
          <h2 className="disp h-card">Face ID unlocks this on any of your devices</h2>
          <p className="muted">
            A passkey lives in your device and syncs through your Apple, Google or Microsoft account. The same passkey signs
            your check-ins if you create a vault.
          </p>
          {!made ? (
            <div className="btn-row">
              <button type="button" className="btn btn-primary" disabled={busy || !passkeysHere()} onClick={() => void makePasskey()}>
                <Icon d={FACE_ID} size={20} stroke={1.6} />Create a passkey
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setStep('code')}>Skip, use only the recovery code</button>
            </div>
          ) : (
            <div className="wiz-ok fade-in">
              <span className="ok-ring"><Icon d={ICONS.check} size={20} stroke={1.8} /></span>
              <div>
                <strong>{made.prf ? 'Passkey created. Face ID will unlock this.' : 'Passkey created. It can sign check-ins, but it cannot unlock this browser.'}</strong>
                {!made.prf && (
                  <div className="small muted">
                    This browser or passkey provider does not support unlocking with a passkey. You will type your recovery code
                    each time you open Codicil here. Everything else works the same.
                  </div>
                )}
              </div>
            </div>
          )}
          {!passkeysHere() && <p className="small muted">This browser cannot make passkeys. Your recovery code will open your records.</p>}
          {error && <p className="err-inline" role="alert">{error}</p>}
          {made && <div><button type="button" className="btn btn-primary" onClick={() => setStep('code')}>Continue</button></div>}
        </section>
      )}

      {step === 'passkey' && (
        <section className="card pad-24 stack-12">
          <h2 className="disp h-card">I have a backup file</h2>
          <p className="muted">Bring back your vaults from another browser. Your passkey or your printed recovery code opens the file.</p>
          <div><button type="button" className="btn btn-secondary" onClick={onRestore}>Restore from a backup</button></div>
        </section>
      )}

      {step === 'code' && (
        <section className="card pad-24 stack-16">
          <h2 className="disp h-card">Your printed recovery code</h2>
          <p className="mono live-code" aria-label="Your recovery code">{groups.map((g, i) => <span key={i}>{g}</span>)}</p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}>Print this page</button>
            <button
              type="button" className="btn btn-ghost btn-sm"
              onClick={() => downloadText('codicil-recovery-code.txt', [
                'Codicil recovery code',
                '',
                text,
                '',
                'This opens your Codicil records in any browser, and can replace a lost passkey on your vault.',
                'Keep it on paper, somewhere safe. Delete this file once it is printed.',
                '',
              ].join('\n'))}
            >
              Save as a file to print
            </button>
          </div>
          <p className="small muted">
            Keep it on paper, with your important documents. Whoever has it and your backup file can open your records, so do not
            keep the two together, and do not store the code in this browser or in an email.
          </p>
          <label className="field-label">
            To check you have it, type group {ask + 1} of the code
            <input className="field mono" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
          {typed.trim().length >= 5 && !confirmed && <p className="err-inline" role="alert">That is not group {ask + 1}. Check what you wrote down.</p>}
          {error && <p className="err-inline" role="alert">{error}</p>}
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setStep('passkey')}>Back</button>
            <button type="button" className="btn btn-primary" disabled={busy || !confirmed} onClick={() => void finish()}>I have written it down</button>
          </div>
        </section>
      )}
    </main>
  );
}

/** Records are here, locked: Face ID, the printed code, or the wallet opens them. */
function Unlock({ access }: { access: AccessView }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const sign = session.walletSigner();
  const attempt = async (how: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await how();
    } catch (e) {
      setError(passkeyTrouble(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="wrap page narrow stack-32" id="main">
      <div className="stack-18">
        <h1 className="disp h-sm">Unlock your vaults.</h1>
        <p className="lede">What this browser keeps is encrypted. Open it with your passkey, or with your printed recovery code.</p>
      </div>
      {access.passkeys.length > 0 && (
        <section className="card pad-24 stack-12">
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-lg" disabled={busy} onClick={() => void attempt(async () => live.unlock('passkey', await askPrf(access.passkeys)))}>
              <Icon d={FACE_ID} size={20} stroke={1.6} />Unlock with Face ID
            </button>
            <span className="small muted">Face ID, Touch ID or your device PIN.</span>
          </div>
        </section>
      )}
      <section className="card pad-24 stack-12">
        <form className="stack-12" onSubmit={(e) => { e.preventDefault(); void attempt(() => live.unlock('recovery-code', code)); }}>
          <label className="field-label">
            Your printed recovery code
            <input className="field mono" autoComplete="off" spellCheck={false} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <div><button type="submit" className="btn btn-secondary" disabled={busy || code.trim().length < 20}>Unlock with the code</button></div>
        </form>
        {access.wallet && sign && (
          <div><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void attempt(() => live.unlockWithWallet(sign))}>Unlock with my wallet</button></div>
        )}
        {error && <p className="err-inline" role="alert">{error}</p>}
      </section>
    </main>
  );
}

export function AccessGate({ access, onRestore }: { access: AccessView; onRestore: () => void }) {
  return access.state === 'locked' ? <Unlock access={access} /> : <SetUp access={access} onRestore={onRestore} />;
}
