// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The recovery key on a sheet the owner can print, download or copy, in the
// same paper form as an heir letter. It is shown when the key is made and not
// again: the app keeps no copy of it after that.

import { useEffect, useRef, useState } from 'react';
import { Logo } from '../components/ui.js';
import { fmtDate, span } from '../demo/store.js';
import { downloadText, RECOVERY_KEY_PREFIX, recoveryKeyFile, recoveryKeyGroups } from '../demo/recoveryKey.js';
import { Qr } from './HeirLetters.js';

export function RecoveryKeySheet({ keyText, delay, replaces = false, onClose }: {
  keyText: string;
  /** The vault's public recovery delay, seconds. */
  delay: number;
  /** True for the key that takes over when a recovery in progress finishes. */
  replaces?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const madeOn = fmtDate(Math.floor(Date.now() / 1000));

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    const close = () => onClose();
    d?.addEventListener('close', close);
    return () => d?.removeEventListener('close', close);
  }, [onClose]);

  return (
    <dialog ref={ref} className="letter-dialog" aria-labelledby="rk-sheet-title">
      <article className="letter">
        <header>
          <span className="letter-mark"><Logo size={28} /></span>
          <h2 id="rk-sheet-title">{replaces ? 'Your next recovery key' : 'Your recovery key'}</h2>
        </header>
        <div className="letter-body">
          <div className="letter-text">
            <p>
              {replaces
                ? 'When the recovery in progress finishes, this key replaces the one you used to start it. The old one stops working then.'
                : 'If you lose your passkey, this key can put a new passkey in charge of your Codicil vault.'}
            </p>
            <p>
              A recovery takes {span(delay)} and everyone can see it start. Anything your current passkey signs in that
              time cancels it and retires the key for good.
            </p>
            <p className="rk-sheet-key">
              <span>{RECOVERY_KEY_PREFIX}</span>
              <span className="rk-sheet-groups">{recoveryKeyGroups(keyText).map((g, i) => <span key={i}>{g}</span>)}</span>
            </p>
            <p className="muted small">
              Made on {madeOn}, for one vault only. Keep it on paper or offline, away from the device that holds your
              passkey. Anyone who finds it can try to take over the vault.
            </p>
          </div>
          <Qr text={keyText} label="QR code holding the recovery key" />
        </div>
      </article>
      <div className="letter-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()}>Print</button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => downloadText(recoveryKeyFile(keyText, Math.round(delay / 86_400), madeOn), 'codicil-recovery-key.txt')}
        >
          Download as a text file
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => { void navigator.clipboard?.writeText(keyText).catch(() => undefined); setCopied(true); }}
        >
          {copied ? 'Copied' : 'Copy as text'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => ref.current?.close()}>Close</button>
      </div>
    </dialog>
  );
}
