// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { useId, useState } from 'react';
import { demo, type Snapshot, type WillDraft } from '../demo/store.js';

type Pct = { ada: string; ben: string; cleo: string };

const toBps = (pct: string): bigint | undefined => {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(pct.trim())) return undefined;
  return BigInt(Math.round(Number(pct) * 100));
};

/** Change the shares and the backup heir, then re-seal with the passkey. */
export function WillEditor({ s, onDone }: { s: Snapshot; onDone: () => void }) {
  const share = (id: string) => String(Number(s.heirs.find((h) => h.profile.id === id)!.shareBps) / 100);
  const [pct, setPct] = useState<Pct>({ ada: share('ada'), ben: share('ben'), cleo: share('cleo') });
  const [kofi, setKofi] = useState(s.heirs.find((h) => h.profile.id === 'kofi')!.named);
  const ids = { ada: useId(), ben: useId(), cleo: useId(), kofi: useId(), total: useId() };

  const bps = { ada: toBps(pct.ada), ben: toBps(pct.ben), cleo: toBps(pct.cleo) };
  const invalid = Object.values(bps).some((b) => b === undefined || b <= 0n || b > 10_000n);
  const total = invalid ? undefined : bps.ada! + bps.ben! + bps.cleo!;
  const problem = invalid
    ? 'Each share must be a number between 0.01 and 100.'
    : total! > 10_000n
      ? `The shares add up to ${Number(total) / 100}%, more than 100%.`
      : undefined;
  const busy = s.tx?.status === 'running';

  const submit = async () => {
    if (problem || total === undefined) return;
    const draft: WillDraft = { ada: bps.ada!, ben: bps.ben!, cleo: bps.cleo!, kofiBackup: kofi };
    if (await demo.updateWill(draft)) onDone();
  };

  const row = (id: keyof Pct, name: string, note: string) => (
    <div className="edit-row">
      <label htmlFor={ids[id]}><span className="private">{name}</span> <span className="muted small">{note}</span></label>
      <span className="pct-input">
        <input
          id={ids[id]}
          inputMode="decimal"
          value={pct[id]}
          aria-describedby={ids.total}
          aria-invalid={bps[id] === undefined || undefined}
          onChange={(e) => setPct({ ...pct, [id]: e.target.value })}
        />
        <span aria-hidden="true">%</span>
      </span>
    </div>
  );

  return (
    <form className="will-editor" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {row('ada', 'Ada', 'Daughter')}
      <label className="edit-check" htmlFor={ids.kofi}>
        <input id={ids.kofi} type="checkbox" checked={kofi} onChange={(e) => setKofi(e.target.checked)} />
        Kofi can claim Ada's share if she has not within 30 days
      </label>
      {row('ben', 'Ben', 'Son')}
      {row('cleo', 'Cleo', 'Granddaughter, unlocks on her 18th birthday')}
      <p id={ids.total} className={problem ? 'error small' : 'muted small'} role={problem ? 'alert' : undefined}>
        {problem ?? `Total ${Number(total) / 100}%.${total! < 10_000n ? ' Anything not allocated stays in the vault.' : ''}`}
      </p>
      <div className="row-actions">
        <button type="submit" className="btn btn-seal" disabled={busy || !!problem}>
          Seal the new will{s.passkey?.kind === 'device' ? ' with Face ID / Touch ID' : ''}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>Cancel</button>
      </div>
      <p className="muted small">
        Only a new 32-byte number reaches the chain. Nobody can tell what changed, or whether anything did.
      </p>
    </form>
  );
}
