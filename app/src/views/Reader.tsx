// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Read a real vault with no wallet. Everything on this page comes from the
// public ledger of Midnight's Preview test network, fetched from its indexer:
// whether the vault's owner is still checking in, what its seal register
// holds, whether a pasted sealed text is the one that was sealed, and, once
// enough pieces are on the ledger, the text itself, opened in this browser.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brand, HashChip, ThemeToggle } from '../components/ui.js';
import { signal } from '../demo/guide.js';
import { EXAMPLE } from '../live/example.js';
import {
  checkCopy, cleanAddress, indexerReader, looksLikeAddress, openCopy, provesOwner, readRegister, readVault, WrongContractError, type RegisterReading, type VaultReading,
} from '../live/reader.js';

/** Test networks run on short timers, so the time of day matters here. */
const when = (t: number) => new Date(t * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const TONE = { checkingIn: 'armed', silent: 'pending', released: 'released' } as const;

type Reading =
  | { status: 'idle' }
  | { status: 'reading' }
  | { status: 'failed'; why: string }
  | { status: 'done'; at: number; vault?: VaultReading; register?: RegisterReading; registerAsked: boolean; vaultWrong: boolean; registerWrong: boolean };

/** `#/read/<vault>/<register>` fills the form, so a reading can be shared as a link. */
function fromHash(): { vault: string; register: string } {
  const [, , vault = '', register = ''] = window.location.hash.split('/');
  return { vault: looksLikeAddress(vault) ? cleanAddress(vault) : '', register: looksLikeAddress(register) ? cleanAddress(register) : '' };
}

export function Reader() {
  const [vault, setVault] = useState(() => fromHash().vault);
  const [register, setRegister] = useState(() => fromHash().register);
  const [copy, setCopy] = useState('');
  const [reading, setReading] = useState<Reading>({ status: 'idle' });
  const [opened, setOpened] = useState<{ text: string } | { why: string }>();
  const fetchState = useMemo(() => indexerReader(), []);

  // Only the latest reading counts: an earlier one that answers late is dropped.
  const latest = useRef(0);

  const read = useCallback(async (v: string, r: string) => {
    const mine = ++latest.current;
    setReading({ status: 'reading' });
    setOpened(undefined);
    // A contract of another kind at an address is a finding, not a failure.
    const one = async <T,>(p: Promise<T | undefined>): Promise<{ value?: T; wrong: boolean }> => {
      try {
        return { value: await p, wrong: false };
      } catch (e) {
        if (e instanceof WrongContractError) return { wrong: true };
        throw e;
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The indexer client retries quietly; give up in words after a while.
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Preview did not answer in 25 seconds')), 25_000); });
      const [vaultRead, registerRead] = await Promise.race([
        Promise.all([one(readVault(fetchState, v)), r ? one(readRegister(fetchState, r)) : Promise.resolve({ value: undefined, wrong: false })]),
        late,
      ]);
      if (mine !== latest.current) return;
      setReading({
        status: 'done', at: Math.floor(Date.now() / 1000), vault: vaultRead.value, register: registerRead.value, registerAsked: !!r,
        vaultWrong: vaultRead.wrong, registerWrong: registerRead.wrong,
      });
      if (/^#\/read(\/|$)/.test(window.location.hash)) {
        window.history.replaceState(null, '', `#/read/${cleanAddress(v)}${r ? `/${cleanAddress(r)}` : ''}`);
      }
    } catch (e) {
      if (mine === latest.current) setReading({ status: 'failed', why: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(timer);
    }
  }, [fetchState]);

  // A link that carries addresses reads them straight away, and so does a new link opened on this page.
  useEffect(() => {
    const follow = () => {
      const at = fromHash();
      if (!at.vault) return;
      setVault(at.vault);
      setRegister(at.register);
      void read(at.vault, at.register);
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => { window.removeEventListener('hashchange', follow); latest.current += 1; };
  }, [read]);

  const done = reading.status === 'done' ? reading : undefined;
  const sig = done?.vault ? signal({ ...done.vault, now: done.at }, when) : undefined;
  const mismatch = done?.vault && done.register && done.register.vault !== done.vault.address;
  const check = done?.register && copy.trim() ? checkCopy(done.register, copy) : undefined;
  const ready = looksLikeAddress(vault) && (!register.trim() || looksLikeAddress(register));
  const useExample = () => {
    setVault(EXAMPLE.vault);
    setRegister(EXAMPLE.register);
    setCopy(EXAMPLE.sealedText);
    void read(EXAMPLE.vault, EXAMPLE.register);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="wrap topbar-row">
          <Brand />
          <span className="grow" />
          <span className="net hide-sm"><span className="dot tone-armed" aria-hidden="true" />Midnight Preview · read only</span>
          <ThemeToggle />
        </div>
      </header>
      <main className="wrap reader" id="main">
        <div className="wiz-head">
          <h1 className="disp">Read a vault. No wallet needed.</h1>
          <p className="lede">
            A Codicil vault's status is public. Paste a vault's address and this page asks Midnight's Preview test
            network whether its owner is still checking in. Add its seal register and a sealed text to check the text
            against the chain and, once the vault has released, to open it here.
          </p>
        </div>

        <form className="card pad-24 stack-16" onSubmit={(e) => { e.preventDefault(); if (ready) void read(vault, register.trim()); }}>
          <label className="field-label">
            Vault address
            <input className="field mono" value={vault} spellCheck={false} placeholder="64 hexadecimal characters" onChange={(e) => setVault(e.target.value)} />
          </label>
          <label className="field-label">
            Seal register address, if the owner gave you one
            <input className="field mono" value={register} spellCheck={false} placeholder="Leave empty to read the vault alone" onChange={(e) => setRegister(e.target.value)} />
          </label>
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={!ready || reading.status === 'reading'}>
              {reading.status === 'reading' ? 'Reading from Preview…' : 'Read from Preview'}
            </button>
            {EXAMPLE.vault && <button type="button" className="linkish" disabled={reading.status === 'reading'} onClick={useExample}>Use the example vault</button>}
          </div>
          {vault.trim() !== '' && !looksLikeAddress(vault) && <p className="small muted">A vault address is 64 hexadecimal characters.</p>}
          {register.trim() !== '' && !looksLikeAddress(register) && <p className="small muted">A register address is 64 hexadecimal characters. Clear the field to read the vault alone.</p>}
          <p className="small muted">
            Anyone can deploy a register that points at a vault. A genuine one proves it was made by the vault's owner,
            and this page checks that proof for you.
          </p>
        </form>

        {reading.status === 'failed' && (
          <p className="err-inline" role="alert">The network could not be read: {reading.why}. Check your connection and try again.</p>
        )}

        {done && !done.vault && (
          <p className="err-inline" role="alert">
            {done.vaultWrong
              ? 'There is a contract at that vault address, but it is not a Codicil vault. If it is a seal register, put it in the second field.'
              : 'Preview has no contract at that vault address. Check the address and the network.'}
          </p>
        )}

        {done?.vault && sig && (
          <section className="card signal" aria-labelledby="read-sig-h">
            <span className="small muted">Vault <HashChip value={done.vault.address} /> on Preview, read on {when(done.at)}</span>
            <h2 id="read-sig-h" className="disp signal-title"><span className={`dot tone-${TONE[sig.state]}`} aria-hidden="true" />{sig.title}</h2>
            <p>{sig.detail}</p>
          </section>
        )}

        {done?.registerAsked && !done.register && (
          <p className="err-inline" role="alert">
            {done.registerWrong
              ? 'There is a contract at that register address, but it is not a seal register.'
              : 'Preview has no contract at that register address.'}
          </p>
        )}

        {done?.register && (
          <section className="card pad-24 stack-16" aria-labelledby="read-reg-h">
            <h2 id="read-reg-h" className="disp h-card">What the seal register holds</h2>
            {mismatch && (
              <p className="err-inline" role="alert">
                This register asks a different vault than the one above. Its seals follow that other vault's release.
              </p>
            )}
            {done.vault && !mismatch && (provesOwner(done.vault, done.register) ? (
              <p className="copy-ok" role="status">
                Made by this vault's owner. The register holds the vault's own owner commitment, <HashChip value={done.register.ownerCommit} />,
                which only a zero-knowledge proof by the owner can put there.
              </p>
            ) : (
              <p className="err-inline" role="alert">
                This register has not proved that it belongs to this vault's owner. Anyone could have deployed it, so
                do not treat what it holds as the owner's.
              </p>
            ))}
            <dl className="msg-facts reader-facts">
              <div><dt>Sealed texts, by fingerprint</dt><dd>{done.register.seals.length}</dd></div>
              <div><dt>Pieces of keys handed over</dt><dd>{done.register.handedOver.length}</dd></div>
              <div><dt>A public statement</dt><dd>{/[1-9a-f]/.test(done.register.statementFingerprint) ? <HashChip value={done.register.statementFingerprint} /> : 'None'}</dd></div>
            </dl>
            {done.register.seals.map((x) => (
              <p key={x.fingerprint} className="small muted msg-fp">
                <HashChip value={x.fingerprint} /> recorded before {when(x.sealedBefore)}, {x.needed} of {x.pieces} pieces needed,{' '}
                {done.register!.handedOver.filter((p) => p.seal === x.fingerprint).length} handed over
              </p>
            ))}
            <label className="field-label">
              A sealed text to check
              <textarea className="field mono msg-copy" rows={4} spellCheck={false} value={copy} onChange={(e) => { setCopy(e.target.value); setOpened(undefined); }} />
            </label>
            {check && (check.ok ? (
              <>
                <p className="copy-ok" role="status">
                  It matches. This register recorded fingerprint <HashChip value={check.fingerprint} /> before {when(check.sealedBefore)}.
                  {' '}It needs {check.needed} piece{check.needed === 1 ? '' : 's'} of its key, and {check.onLedger.length} {check.onLedger.length === 1 ? 'is' : 'are'} on the ledger.
                </p>
                <div className="btn-row">
                  <button type="button" className="btn btn-primary" onClick={() => void openCopy(check).then(setOpened)}>Open it in this browser</button>
                  <span className="small muted">The key is rebuilt here from the pieces on the ledger. Nothing is sent anywhere.</span>
                </div>
              </>
            ) : <p className="err-inline" role="alert">{check.why}</p>)}
            {opened && ('text' in opened ? (
              <article className="letter msg-letter" aria-label="The opened text">
                <p className="msg-open">{opened.text}</p>
              </article>
            ) : <p className="err-inline" role="alert">{opened.why}</p>)}
          </section>
        )}

        <p className="small muted">
          This page never asks for a key and never sends a transaction. It reads contract state from Preview's public
          indexer, and all checking and opening happens on this device. To see every step with a clock you control,{' '}
          <a href="#/demo">try the guided demo</a>.
        </p>
      </main>
    </div>
  );
}
