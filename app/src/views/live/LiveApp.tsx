// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The live app at #/app: a real vault on a Midnight test network, through the
// person's own wallet. No cast, no "act as", no clock to move. The guided
// demo stays at #/demo.

import { useEffect, useRef, useState } from 'react';
import { Brand, FACE_ID, Icon, ICONS, ThemeToggle, Toast, TxSheet } from '../../components/ui.js';
import { askPrf, createPasskeyWithPrf, NoPrf, passkeysHere } from '../../live/prf.js';
import { live, session, useConnection, useLive, type Connection } from '../../live/session.js';
import type { LiveSnapshot } from '../../live/store.js';
import { FAUCETS, formatDust, formatNight, networkName } from '../../live/wallet.js';
import { LiveDeploy, LiveOwner, Sealed } from './LiveOwner.js';
import { AccessGate, passkeyTrouble, sentence } from './LiveAccess.js';
import { LiveGuardian, LiveHeir, LiveInvited } from './LivePeople.js';
import { LiveWizard } from './LiveWizard.js';
import { CopyLine, downloadText, NetworkLine, ProblemCard, shortAddress } from './parts.js';
import '../../live.css';

/** What a link like #/app/join/codicil:invite:v1:… carries: an invitation, a sealed letter or a kit. */
const kitFromHash = (): string | undefined => {
  const m = /^#\/app\/join\/(.+)$/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : undefined;
};

function Welcome({ c, hasInvitation, saved }: { c: Connection; hasInvitation: boolean; saved: number | 'locked' }) {
  return (
    <main className="wrap page narrow stack-32" id="main">
      <div className="stack-18">
        <span className="eyebrow">Codicil on a Midnight test network</span>
        <h1 className="disp h-sm">{hasInvitation ? 'Connect your wallet to open your invitation.' : 'Connect your wallet to begin.'}</h1>
        <p className="lede">
          This is the real vault contract on a real network, used through your own wallet. It runs on Midnight's test networks,
          Preview and Preprod, where tokens are free and have no value. Use it to see exactly how Codicil works, not yet to hold
          anything that matters: test networks can be reset.
        </p>
      </div>

      {c.problem && <ProblemCard problem={c.problem} onRetry={() => void session.connect()} retryLabel="Connect again" />}

      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-lg" disabled={c.status === 'connecting'} onClick={() => void session.connect()}>
          {c.status === 'connecting' ? 'Waiting for Lace' : 'Connect Lace'}
        </button>
        <span className="small muted">
          {saved === 'locked' ? 'Your vaults are saved in this browser, locked. ' : saved > 0 ? `${saved} ${saved === 1 ? 'vault is' : 'vaults are'} saved in this browser. ` : ''}
          Lace will ask whether this site may see your address and propose transactions. It cannot move anything without your approval each time.
        </span>
      </div>

      <section className="card pad-24 stack-16">
        <h2 className="disp h-card">What you need</h2>
        <ol className="numbered">
          <li><span className="mono">1</span><span><strong>Chrome and the Lace wallet</strong>, set to a Midnight test network. Preview is the quicker one to start on: a new wallet is ready there in minutes. <a className="linkish" href="https://www.lace.io/" target="_blank" rel="noreferrer">Get Lace</a></span></li>
          <li><span className="mono">2</span><span><strong>Test tokens.</strong> Ask a faucet for tNIGHT (<a className="linkish" href={FAUCETS.preview} target="_blank" rel="noreferrer">Preview faucet</a>, <a className="linkish" href={FAUCETS.preprod} target="_blank" rel="noreferrer">Preprod faucet</a>), then turn on "Generate tDUST" in Lace. DUST pays the fees and builds up over a few minutes.</span></li>
          <li><span className="mono">3</span><span><strong>A proof server on this computer.</strong> Proofs are made locally so your secrets never leave your machine. With Docker running:</span></li>
        </ol>
        <CopyLine text="docker run -d --name proof-server -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:9.0.2" label="Copy the command" />
        <p className="small muted">
          Give Docker at least 8 GB of memory: the largest proof needs about 5. An owner needs all three. An heir or
          guardian opening an invitation needs them too, but only a little DUST: one transaction costs less than 1.
        </p>
      </section>

      <p className="small muted">
        Want to look around first, with nothing to install? <a className="linkish" href="#/demo">Open the guided demo</a>. It runs the same contract in your browser with a made-up family and a clock you control.
      </p>
    </main>
  );
}

function Start({ onCreate, onBackup, onBack, network, elsewhere }: {
  onCreate: () => void; onBackup: () => void; onBack?: () => void; network: string; elsewhere: string[];
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const join = async () => {
    setError(undefined);
    try {
      await live.join(text);
      setText('');
    } catch (e) {
      setError(sentence(e));
    }
  };
  return (
    <main className="wrap page narrow stack-32" id="main">
      <div className="stack-18">
        <h1 className="disp h-sm">{onBack ? 'Add a vault to this browser.' : 'What brings you here?'}</h1>
        {!onBack && (
          <p className="lede">
            There are no vaults in this browser on Midnight {networkName(network)} yet.
            {elsewhere.length > 0 && ` You have ${elsewhere.length === 1 ? 'a vault' : 'vaults'} saved on ${[...new Set(elsewhere)].map(networkName).join(' and ')}: each test network is a separate chain, so switch Lace to that network and connect again to see ${elsewhere.length === 1 ? 'it' : 'them'}.`}
          </p>
        )}
        {onBack && <div><button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>Back to my vault</button></div>}
      </div>
      <section className="card pad-24 stack-12">
        <h2 className="disp h-card">I want to create my will</h2>
        <p className="muted">Name your heirs, choose how often you will check in, and seal your will. About ten minutes, most of it waiting for the network.</p>
        <div><button type="button" className="btn btn-primary" onClick={onCreate}>Create your will</button></div>
      </section>
      <section className="card pad-24 stack-12">
        <h2 className="disp h-card">I was given an invitation</h2>
        <p className="muted">An owner asked you to be an heir or a guardian and sent you a link or a line of text. Paste it here. Paste the letter they send you later here too.</p>
        <label className="sr-only" htmlFor="kit">Your invitation</label>
        <textarea id="kit" className="field mono letter-input" spellCheck={false} placeholder="codicil:invite:v1:… or the link you were sent" value={text} onChange={(e) => setText(e.target.value)} />
        {error && <p className="err-inline" role="alert">{error}</p>}
        <div><button type="button" className="btn btn-secondary" disabled={text.trim() === ''} onClick={() => void join()}>Open my invitation</button></div>
      </section>
      <section className="card pad-24 stack-12">
        <h2 className="disp h-card">I have a backup file</h2>
        <p className="muted">Bring back the vaults you saved from another browser, or from this one before its data was cleared.</p>
        <div><button type="button" className="btn btn-secondary" onClick={onBackup}>Restore from a backup</button></div>
      </section>
    </main>
  );
}

type Needs = ReturnType<typeof live.backupNeeds>;

function BackupDialog({ s, onClose }: { s: LiveSnapshot; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = s.access.state === 'open';
  const [mode, setMode] = useState<'save' | 'restore'>(open && s.records.length > 0 ? 'save' : 'restore');
  const [pass, setPass] = useState('');
  const [code, setCode] = useState('');
  const [file, setFile] = useState<{ name: string; text: string; needs?: Needs }>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const sign = session.walletSigner();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    d?.addEventListener('close', onClose);
    return () => d?.removeEventListener('close', onClose);
  }, [onClose]);

  const act = async (how: () => Promise<string>) => {
    setBusy(true);
    setNote(undefined);
    try {
      setNote({ ok: true, text: await how() });
      setPass('');
      setCode('');
    } catch (e) {
      setNote({ ok: false, text: passkeyTrouble(e) });
    } finally {
      setBusy(false);
    }
  };
  const save = () => act(async () => {
    downloadText(`codicil-backup-${new Date().toISOString().slice(0, 10)}.json`, await live.exportBackup(), 'application/json');
    return 'Saved to your downloads. Keep it somewhere other than your recovery code. Save a new one after you create another vault or accept another invitation.';
  });
  const restored = (r: { added: number; updated: number }) => (r.added + r.updated === 0
    ? 'Everything in that backup was already in this browser.'
    : `Restored ${r.added + r.updated} ${r.added + r.updated === 1 ? 'vault' : 'vaults'}.${live.getSnapshot().access.state === 'open' ? '' : ' Now lock them: set up this browser.'}`);
  const restore = (key: Parameters<typeof live.importBackup>[1]) => act(async () => restored(await live.importBackup(file!.text, key)));
  const pick = (f: File) => void f.text().then((text) => {
    let needs: Needs | undefined;
    try {
      needs = live.backupNeeds(text);
      setNote(undefined);
    } catch (e) {
      setNote({ ok: false, text: sentence(e) });
    }
    setFile({ name: f.name, text, needs });
  });
  const needs = file?.needs;

  return (
    <dialog ref={ref} className="dialog live-dialog" aria-labelledby="bk-h">
      <h2 id="bk-h">{mode === 'save' ? 'Save a backup file' : 'Restore from a backup file'}</h2>
      {mode === 'save' ? (
        <>
          <p className="muted">
            Everything that makes your vaults usable is kept only in this browser: your will, the invitations, the key that
            maintains the vault. If this browser's data is cleared, a backup file brings them back. The file is locked the same
            way as this browser: your passkey or your printed recovery code opens it, in any browser. Codicil cannot open it
            for you.
          </p>
          <p className="small muted">
            Opens with: {[s.access.passkeys.length > 0 && 'Face ID', s.access.code && 'your printed recovery code', s.access.wallet && 'your wallet'].filter(Boolean).join(', ')}.
          </p>
          {!s.access.wallet && sign && (
            <div className="btn-row">
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(async () => {
                await live.addWalletSlot(sign, session.getSnapshot().address?.bech32 ?? '');
                return `${session.getSnapshot().walletName ?? 'Your wallet'} can now open this too.`;
              })}>Let my wallet open this too</button>
              <span className="small muted">Your wallet signs a fixed sentence twice. It only works with a wallet that signs it the same way each time.</span>
            </div>
          )}
          {s.access.passkeys.length === 0 && passkeysHere() && (
            <div className="btn-row">
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(async () => {
                const made = await createPasskeyWithPrf();
                if (!made.prf) throw new NoPrf();
                await live.addPasskeySlot(made.prf);
                return 'Face ID now opens this too.';
              })}>Let Face ID open this too</button>
            </div>
          )}
        </>
      ) : (
        <p className="muted">Choose the file you saved. Vaults already in this browser are kept.</p>
      )}
      {mode === 'restore' && (
        <label className="field-label">
          Backup file
          <input type="file" className="field" accept=".json,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }} />
        </label>
      )}
      {mode === 'restore' && needs?.kind === 'passphrase' && (
        <label className="field-label">
          This older backup is locked with a passphrase
          <input type="password" className="field" value={pass} autoComplete="current-password" onChange={(e) => setPass(e.target.value)} />
        </label>
      )}
      {mode === 'restore' && needs?.kind === 'keyring' && (
        <>
          {needs.passkeys.length > 0 && (
            <div><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act(async () => restored(await live.importBackup(file!.text, { kind: 'passkey', secret: await askPrf(needs.passkeys) })))}>
              <Icon d={FACE_ID} size={18} stroke={1.6} />Open it with Face ID
            </button></div>
          )}
          <label className="field-label">
            Or your printed recovery code
            <input className="field mono" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        </>
      )}
      {note && <p className={note.ok ? 'small' : 'err-inline'} role="status">{note.text}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={() => { setMode(mode === 'save' ? 'restore' : 'save'); setNote(undefined); }} disabled={mode === 'restore' && (!open || s.records.length === 0)}>
          {mode === 'save' ? 'Restore instead' : 'Save instead'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>Close</button>
        {mode === 'save' ? (
          <button type="button" className="btn btn-primary" disabled={busy || s.records.length === 0} onClick={() => void save()}>Save the backup file</button>
        ) : (
          <button
            type="button" className="btn btn-primary"
            disabled={busy || !needs || (needs.kind === 'passphrase' ? pass.length < 1 : code.trim().length < 20)}
            onClick={() => void restore(needs?.kind === 'passphrase' ? { passphrase: pass } : { kind: 'recovery-code', secret: code })}
          >
            Restore these vaults
          </button>
        )}
      </div>
    </dialog>
  );
}

function WalletBar({ c, s, onBackup, onNew }: { c: Connection; s: LiveSnapshot; onBackup: () => void; onNew: () => void }) {
  return (
    <div className="demobar live-bar" role="region" aria-label="Wallet and vaults">
      <div className="wrap demobar-row">
        <span className="eyebrow demo-word">Test network</span>
        <span className="small">
          Midnight {networkName(c.network ?? '')}. Tokens here have no value.
        </span>
        <span className="grow" />
        {c.address && (
          <span className="small muted live-wallet" title={c.address.bech32}>
            {c.walletName} <span className="mono">{shortAddress(c.address.bech32)}</span>
            {c.balances && <> · <span className="mono">{formatNight(c.balances.night, 0)}</span> tNIGHT · <span className="mono">{formatDust(c.balances.dust)}</span> DUST</>}
          </span>
        )}
        {s.records.length > 1 && (
          <label className="live-switch">
            <span className="sr-only">Vault shown</span>
            <select className="field" value={s.activeId} onChange={(e) => void live.select(e.target.value)}>
              {s.records.map((r) => (
                <option key={r.id} value={r.id}>{r.title} · {r.subtitle}{r.network !== c.network ? ` · on ${networkName(r.network)}` : ''}</option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onBackup}>Backup</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onNew}>Add a vault</button>
      </div>
    </div>
  );
}

export function LiveApp() {
  const s = useLive();
  const c = useConnection();
  const [backup, setBackup] = useState(false);
  const [adding, setAdding] = useState<'menu' | 'wizard'>();
  const [sealedSeen, setSealedSeen] = useState<string>();
  const [pendingKit, setPendingKit] = useState(kitFromHash);
  const [kitError, setKitError] = useState<string>();
  const wasCreating = useRef<string | undefined>(undefined);

  useEffect(() => {
    live.startClock();
    return () => live.stopClock();
  }, []);

  // An invitation link: keep the invitation, drop it from the address bar, and open it once a wallet is connected and the records are open.
  const isOpen = s.access.state === 'open';
  useEffect(() => {
    if (pendingKit) window.history.replaceState(null, '', '#/app');
    if (!pendingKit || c.status !== 'connected' || !isOpen) return;
    setPendingKit(undefined);
    live.join(pendingKit).then(() => setAdding(undefined), (e: unknown) => setKitError(sentence(e)));
  }, [pendingKit, c.status, isOpen]);

  // Leave the wizard as soon as the vault it made exists as a record.
  const active = s.active;
  useEffect(() => {
    if (active?.role === 'owner' && active.status === 'creating') {
      wasCreating.current = active.id;
      setAdding(undefined);
    }
  }, [active]);
  useEffect(() => { window.scrollTo(0, 0); }, [s.activeId, adding, c.status]);

  const connected = c.status === 'connected';
  const here = s.records.filter((r) => r.network === c.network);
  const busy = s.tx?.status === 'running';
  const justSealed = active?.role === 'owner' && active.status === 'ready' && wasCreating.current === active.id && sealedSeen !== active.id;

  let body;
  if (!connected) body = <Welcome c={c} hasInvitation={!!pendingKit} saved={s.access.state === 'locked' ? 'locked' : s.records.length + s.access.legacy} />;
  else if (!isOpen) body = <AccessGate access={s.access} onRestore={() => setBackup(true)} />;
  else if (adding === 'wizard') body = <LiveWizard connection={c} onCancel={() => setAdding(undefined)} />;
  else if (adding === 'menu' || here.length === 0 || !active) {
    body = (
      <Start
        network={c.network ?? ''} elsewhere={s.records.filter((r) => r.network !== c.network).map((r) => r.network)}
        onCreate={() => setAdding('wizard')} onBackup={() => setBackup(true)} onBack={adding === 'menu' && here.length > 0 ? () => setAdding(undefined) : undefined}
      />
    );
  }
  else if (active.role === 'owner' && active.status !== 'ready') body = <LiveDeploy me={active} deploy={s.deploy} connection={c} />;
  else if (justSealed && active.role === 'owner') body = <Sealed deadline={active.vault?.deadline ?? active.firstDeadline ?? 0} onDone={() => setSealedSeen(active.id)} />;
  else if (active.role === 'invited') body = <LiveInvited me={active} />;
  else if (!active.vault) {
    body = (
      <main className="wrap page narrow stack-18" id="main">
        {s.load.state === 'error' && s.load.problem
          ? <ProblemCard problem={s.load.problem} onRetry={() => void live.open()} />
          : <div className="live-loading" aria-busy="true"><span className="eyebrow">Reading the vault from Midnight {networkName(c.network ?? '')}</span><span className="boot-bar" aria-hidden="true"><span /></span></div>}
      </main>
    );
  } else if (active.role === 'owner') body = <LiveOwner me={active} now={s.now} busy={busy} connection={c} />;
  else if (active.role === 'heir') body = <LiveHeir me={active} now={s.now} busy={busy} connection={c} />;
  else body = <LiveGuardian me={active} busy={busy} connection={c} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="wrap topbar-row">
          <Brand />
          <span className="grow" />
          <span className="hide-sm"><NetworkLine network={c.network} /></span>
          <a className="btn btn-ghost btn-sm hide-sm" href="#/demo">Guided demo</a>
          {connected && <button type="button" className="btn btn-ghost btn-sm" onClick={() => session.disconnect()}>Disconnect</button>}
          <ThemeToggle />
        </div>
      </header>
      {connected && isOpen && <WalletBar c={c} s={s} onBackup={() => setBackup(true)} onNew={() => setAdding('menu')} />}
      {kitError && (
        <div className="wrap live-top-note">
          <ProblemCard problem={{ kind: 'input', title: 'That invitation could not be opened', body: kitError, retry: false }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setKitError(undefined)}>Dismiss</button>
          </ProblemCard>
        </div>
      )}
      {body}
      {connected && isOpen && here.length > 0 && !adding && (
        <footer className="wrap appfoot">
          <Icon d={ICONS.lens} size={14} stroke={1.6} />
          <span>
            Your vaults' secrets are kept only in this browser, encrypted. <button type="button" className="linkish" onClick={() => setBackup(true)}>Save a backup file</button> so
            a cleared browser is not a lost vault. This is a test network: tokens have no value and the network can be reset.
            {active && <> <button type="button" className="linkish" onClick={() => { if (window.confirm('Remove this vault from this browser? The vault itself stays on the network, but without a backup file or the invitation this browser can no longer use it.')) live.forget(active.id); }}>Remove this vault from this browser</button></>}
          </span>
        </footer>
      )}
      {backup && <BackupDialog s={s} onClose={() => setBackup(false)} />}
      <TxSheet tx={s.tx} onDismiss={() => live.dismissTx()} onRetry={() => void live.retry()} />
      <Toast toast={s.toast} onDismiss={() => live.dismissToast()} />
    </div>
  );
}
