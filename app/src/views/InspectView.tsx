// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The public inspector: everything a stranger can read about a vault, in
// plain words, from the ledger alone. No key, no sign-in.

import { useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { HashChip, StateTag } from '../components/ui.js';
import { days, fmtDate, TOKEN, type Snapshot } from '../demo/store.js';

export function InspectView({ s }: { s: Snapshot }) {
  const [addr, setAddr] = useState(s.chain.address);
  const clean = addr.trim().replace(/^0x/, '').toLowerCase();
  const found = clean === s.chain.address.toLowerCase();
  const k = s.guardianThreshold.toString();
  const claims = s.chain.claimNullifiers.length;

  const state = s.phase === Phase.armed
    ? (s.now < s.deadline
      ? `Armed. Someone has been checking in; the next check-in is due by ${fmtDate(s.deadline)}.`
      : `Armed, but the check-in due ${fmtDate(s.deadline)} was missed. Anyone may start the switch.`)
    : s.phase === Phase.pending
      ? `Pending. The switch started; whoever controls the vault can cancel until ${fmtDate(s.pendingUntil)}.`
      : `Released on ${fmtDate(s.releasedAt)}. Heirs may claim.`;

  const rows: [string, React.ReactNode, string][] = [
    ['State', state, 'The contract must enforce time, so the clock is public by design.'],
    ['Owner', <HashChip key="o" value={s.chain.ownerPasskeyCommit} />, 'A sealed commitment to a passkey. Not a name, a wallet or a device; two vaults by the same person look unrelated.'],
    ['Heirs', <HashChip key="h" value={s.chain.willRoot} />, `One 32-byte fingerprint of the will (version ${(s.willVersion + 1n).toString()}). Not how many heirs, not who, not how much, not when.`],
    ['Guardians', <span key="g"><HashChip value={s.chain.guardianRoot} /> · {k} must agree</span>, `An unknown number of unnamed people. This round: ${s.guardianVotes} vote${s.guardianVotes === 1n ? '' : 's'}, from guardians nobody can identify.`],
    ['Owner actions', <span key="n" className="mono">{s.nonce.toString()}</span>, 'A counter that stops old signatures being replayed. Each check-in is a fresh signature that links to no wallet.'],
    ['Challenge window', <span key="w" className="mono">{days(s.setup!.window)} days</span>, 'How long the owner has to cancel once the switch starts.'],
    ['Claims', <span key="c" className="mono">{claims} one-time stamp{claims === 1 ? '' : 's'}</span>, claims ? 'Each stamp stops a share being claimed twice. It says nothing about who claimed or which share it was.' : 'Nobody has claimed.'],
    ['Balance', <span key="b" className="mono">{s.estate.toLocaleString()} {TOKEN}</span>, s.phase === Phase.released ? `Payouts went to fresh addresses, so they can't be tied to the heirs or to each other.` : 'The total is public; how it divides is not.'],
  ];

  return (
    <div className="inspect stack-32">
      <div className="stack-12">
        <span className="eyebrow">Public inspector · no key needed</span>
        <h1 className="disp h-sm">What <em>anyone</em> can learn.</h1>
        <p className="lede">
          Everything a stranger, an exchange or a chain analyst can read about a Codicil vault, straight from the public
          ledger. Paste any vault address.
        </p>
      </div>
      <label className="field-label inspect-addr">
        Vault address
        <input className="field mono" value={addr} spellCheck={false} onChange={(e) => setAddr(e.target.value)} />
      </label>

      {!found ? (
        <p className="err-inline" role="alert">No vault at that address on the demo chain. The demo has one vault, {`0x${s.chain.address.slice(0, 4)}…${s.chain.address.slice(-4)}`}.</p>
      ) : (
        <>
          <div className="inspect-state"><StateTag phase={s.phase} /></div>
          <dl className="inspect-rows">
            {rows.map(([key, value, meaning]) => (
              <div key={key}>
                <dt className="eyebrow">{key}</dt>
                <dd>
                  <span className="inspect-v">{value}</span>
                  <span className="small muted">{meaning}</span>
                </dd>
              </div>
            ))}
          </dl>
          <section className="card pad-24 stack-12 inspect-cant">
            <h2 className="disp h-card">What nobody can learn from this</h2>
            <ul>
              <li>Who owns the vault, or that it belongs to the same person as any other vault.</li>
              <li>Who the heirs are, how many there are, what each gets, or when.</li>
              <li>Who the guardians are, or which of them voted.</li>
              <li>Which heir claimed, or where a payout went next.</li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
