// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The public inspector: everything a stranger can read about a vault, in
// plain words, from the ledger alone. No key, no sign-in.

import { useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { HashChip, StateTag } from '../components/ui.js';
import { SignalCard } from './Signal.js';
import { checkInState, eventSummary } from '../demo/guide.js';
import { days, fmtDate, span, spanAdj, TOKEN, type Snapshot } from '../demo/store.js';

export function InspectView({ s }: { s: Snapshot }) {
  const [addr, setAddr] = useState(s.chain.address);
  const clean = addr.trim().replace(/^0x/, '').toLowerCase();
  const found = clean === s.chain.address.toLowerCase();
  const k = s.guardianThreshold.toString();
  const claims = s.chain.claimNullifiers.length;
  const due = checkInState(s);
  const r = s.recovery;
  const attestor = /[1-9a-f]/.test(s.chain.attestorKeyCommit);

  const state = s.phase === Phase.armed
    ? (due === 'onTime'
      ? `Armed. Someone has been checking in; the next check-in is due by ${fmtDate(s.deadline)}.`
      : due === 'grace'
        ? `Armed. The check-in due ${fmtDate(s.deadline)} was missed, but this vault has a grace period: the owner can still check in as usual, and nobody may start the switch before ${fmtDate(s.switchOpensAt)}.`
        : `Armed, but the check-in due ${fmtDate(s.deadline)} was missed${s.grace > 0 ? ` and the grace period ended on ${fmtDate(s.switchOpensAt)}` : ''}. Anyone may start the switch.`)
    : s.phase === Phase.pending
      ? `Pending. The switch started; whoever controls the vault can cancel until ${fmtDate(s.pendingUntil)}.`
      : `Released on ${fmtDate(s.releasedAt)}. Heirs may claim.`;

  const recoveryValue: Record<typeof r.state, React.ReactNode> = {
    off: <span className="mono">None</span>,
    idle: <span><HashChip value={s.chain.recoveryKeyCommit} /> · <span className="mono">{spanAdj(r.delay)} delay</span></span>,
    waiting: <span><HashChip value={s.chain.recoveryKeyCommit} /> · <span className="mono">recovery started, takes effect {fmtDate(r.readyAt)}</span></span>,
    ready: <span><HashChip value={s.chain.recoveryKeyCommit} /> · <span className="mono">recovery can be finished since {fmtDate(r.readyAt)}</span></span>,
    retired: <span><HashChip value={s.chain.recoveryKeyCommit} /> · <span className="mono">a recovery was cancelled, key retired</span></span>,
  };
  const recoveryMeaning: Record<typeof r.state, string> = {
    off: 'This vault has no recovery key: nothing off the chain can replace the owner keys.',
    idle: 'A recovery secret exists somewhere off the chain. Whoever holds it can replace the owner keys, but only after this public wait, during which the owner can cancel. Not the secret, and not where it is kept.',
    waiting: 'Someone holding the recovery secret has proposed new owner keys. They take effect on that date unless the owner signs anything first. This is public on purpose: the owner can only cancel what the owner can see. The new keys are sealed commitments.',
    ready: 'The public wait is over, so anyone may finish the recovery and install the proposed owner keys. Until then an owner signature still cancels it.',
    retired: 'A recovery was started and the owner then signed something, which cancelled it. The owner action count no longer matches the one the recovery recorded. The key that started it can never be used again, though its commitment stays on the ledger.',
  };

  const p = s.position;
  const rows: [string, React.ReactNode, string][] = [
    ['State', state, 'The contract must enforce time, so the clock is public by design.'],
    ['Owner', <HashChip key="o" value={s.chain.ownerPasskeyCommit} />, 'A sealed commitment to a passkey. Not a name, a wallet or a device; two vaults by the same person look unrelated.'],
    ['Heirs', <HashChip key="h" value={s.chain.willRoot} />, `One 32-byte fingerprint of the will (version ${(s.willVersion + 1n).toString()}). Not how many heirs, not who, not how much, not when.`],
    ['Guardians', <span key="g"><HashChip value={s.chain.guardianRoot} /> · {k} must agree</span>, `An unknown number of unnamed people. This round (round ${(s.guardianRound + 1n).toString()}): ${s.guardianVotes} vote${s.guardianVotes === 1n ? '' : 's'}, from guardians nobody can identify. If the owner replaces the guardians, this fingerprint changes; it shows that they changed, not who.`],
    ['Attestor', attestor ? <HashChip key="a" value={s.chain.attestorKeyCommit} /> : <span key="a" className="mono">None</span>, attestor ? 'A sealed commitment to a key that can start the switch with a signed notice. It shows that an attestor is set, not who it is.' : 'Nobody can start the switch with a signed notice.'],
    ['Owner actions', <span key="n" className="mono">{s.nonce.toString()}</span>, 'A count of check-ins, will changes and settings changes. It stops old signatures being replayed. Each one is a fresh signature that links to no wallet.'],
    ['Grace period', <span key="gr" className="mono">{s.grace > 0 ? span(s.grace) : 'None'}</span>, s.grace > 0 ? 'How long after a missed check-in the owner can still check in before anyone may start the switch. A check-in made in that time is visibly late, because block time is public.' : 'Anyone may start the switch the moment a check-in is missed.'],
    ['Challenge window', <span key="w" className="mono">{days(s.setup!.window)} days</span>, 'How long the owner has to cancel once the switch starts.'],
    ['Recovery key', <span key="r">{recoveryValue[r.state]}</span>, recoveryMeaning[r.state]],
    ['Release fee', <span key="f" className="mono">{s.feeBps > 0n ? `${Number(s.feeBps) / 100}% of the estate` : 'None'}</span>, s.feeBps > 0n ? 'Taken once, at release, and sent to a public address that is the same for every vault paying this operator.' : 'Nothing is taken from the estate at release, and no operator address links this vault to others.'],
    ['Events', <span key="e" className="mono">{s.events.length ? eventSummary(s.events) : 'None yet'}</span>, 'Signals with a name and no content. They tell apps to read the ledger again: a will changed, a recovery started, the will was released. They say nothing about heirs, shares or keys.'],
    ['Claims', <span key="c" className="mono">{claims} one-time stamp{claims === 1 ? '' : 's'}</span>, claims ? 'Each stamp stops a share being claimed twice. It says nothing about who claimed or which share it was.' : 'Nobody has claimed.'],
    ['Balance', <span key="b" className="mono">{s.estate.toLocaleString()} {TOKEN}</span>, s.phase === Phase.released ? `Payouts went to fresh addresses, so they can't be tied to the heirs or to each other.` : 'The total is public; how it divides is not.'],
    ['Linked contracts', <span key="l"><HashChip value={p.address} /> · <span className="mono">{p.held.toLocaleString()} {TOKEN}{p.withdrawn ? ', paid out' : ''}</span></span>, `Another contract, ${p.name}, asks this vault "released?" before it pays. The link and the amount are public. Its beneficiary is a sealed commitment, not a name or an address.`],
    ['Seal register', <span key="r"><HashChip value={s.register.address} /> · <span className="mono">{s.register.seals.length} sealed · {s.register.handedOver.length} piece{s.register.handedOver.length === 1 ? '' : 's'} handed over</span></span>, 'Another contract asks this vault "released?" before it accepts a piece of a sealed message\'s key. It holds fingerprints and commitments: no message, no key, and nothing that says who a message is for. ' + (s.register.provesOwner ? 'It also holds this vault\'s owner commitment, which only the owner could have put there, so it is the owner\'s register.' : 'It has not proved that it belongs to this vault\'s owner.')],
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
          <SignalCard s={s} />
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
              <li>Who the guardians are, how many there are, which of them voted, or who was added or removed.</li>
              <li>Who the attestor is, if there is one.</li>
              <li>The recovery secret, where it is kept, or which keys a recovery would install.</li>
              <li>Which heir claimed, or where a payout went next.</li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
