// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The Privacy Lens: the real public ledger next to what only the owner's
// device knows. Point at a row to light up its counterpart.

import { useState } from 'react';
import { Icon, ICONS, short } from '../components/ui.js';
import { ATTESTOR, days, demo, fmtShort, HEIRS, OWNER_FIRST, span, TOKEN, type Snapshot } from '../demo/store.js';
import { eventSummary } from '../demo/guide.js';

type PubId = 'owner' | 'root' | 'deadline' | 'grace' | 'window' | 'counter' | 'guard' | 'attest' | 'rec' | 'recp' | 'fee' | 'events' | 'nulls' | 'bal' | 'pos' | 'msg';
type Active = { side: 'pub' | 'priv'; id: string } | undefined;

const NOTES: Record<string, [string, string]> = {
  owner: ['You → a commitment', 'The chain stores a sealed fingerprint of your passkey. When you check in, you prove you hold the key behind it, without revealing the key or which device you used.'],
  root: ['Every heir → one root', 'Each heir and share is a leaf in a Merkle tree. Only the root is public. It doesn’t even reveal how many heirs there are.'],
  ada: ['Ada’s share is a leaf hidden inside the root', 'When Ada claims, her device proves her leaf is in the tree and that she holds its key. The chain learns that a valid heir claimed, but not who, or what the will said about her.'],
  cleo: ['Cleo’s unlock date is inside her leaf too', 'The chain checks “today is after this heir’s date” inside the proof. The date itself is never published.'],
  bak: ['The backup heir is part of a leaf', 'After the claim window, the backup can prove they back up that leaf and take only that unclaimed share.'],
  deadline: ['Deadlines are public, by design', 'The contract must enforce time, so the deadline is visible. It shows that someone checks in, never who.'],
  window: ['The challenge window is public', 'Everyone can verify the owner had time to cancel before release.'],
  grace: ['The grace period is public', 'The contract enforces it, so everyone can see how much slack the owner chose. A check-in made during it is visibly late, because block time is public.'],
  counter: ['A counter, not a diary', 'The chain counts owner actions so old signatures can’t be replayed. It doesn’t store where you checked in from.'],
  guard: ['Guardians → a root and a count', 'Guardian identities are leaves in their own tree. Votes are counted with nullifiers, so “1 of 2” is public but who voted never is. When the owner changes the guardians the root changes, which shows that they changed and nothing about who.'],
  attest: ['The attestor → a commitment', 'The chain holds a sealed fingerprint of the attestor’s key, or zeros when there is none. It shows whether an attestor is set, never who it is.'],
  rec: ['The recovery key → a commitment and a delay', 'Everyone can see that this vault has a recovery key and how long a recovery must wait. That tells a thief it is worth looking for. The secret itself exists only on paper.'],
  recp: ['A recovery is public on purpose', 'When someone uses the recovery key, the date the new keys take over goes on the ledger, with sealed commitments to those keys. The owner can only cancel what the owner can see. After a cancellation the fields stay, so anyone can tell that a recovery was tried and stopped.'],
  fee: ['No release fee', 'A vault can be deployed with a fee of up to 10% of the estate, paid to a public address at release. This one has none: nothing is taken, and no operator address links it to other vaults.'],
  events: ['Events: a name, nothing else', 'The vault emits “will changed”, “recovery started” and “released”. Each tells apps to read the ledger again. None carries any content, and none is addressed to anyone.'],
  nulls: ['Nullifiers: one-time stamps', 'Each claim leaves a random-looking stamp so it can’t be repeated. The stamps can’t be linked to heirs.'],
  bal: ['The total is public, the split is not', 'Anyone can see what the vault holds. Only you know how it divides.'],
  msg: ['Sealed messages leave no trace', 'A message is sealed, handed over and opened between people’s devices. None of that is a transaction, so the ledger has no field for it. The one thing a message takes from the chain is the vault’s state: released, or not.'],
  pos: ['A second contract, the same privacy', 'The savings contract stores the vault it asks, the amount and a commitment to its beneficiary. It asks the vault one question, released or not, and never learns who is in the will.'],
};
const IDLE: [string, string] = ['Point at, or tap, any row', 'Its counterpart on the other ledger lights up. Warm ink is private and stays on your device. Cool slate is public, on the chain.'];

const GLOSSARY: [string, string][] = [
  ['Commitment', 'A sealed envelope. Anyone can see it exists, but only the sender can show what’s inside.'],
  ['Merkle root', 'One fingerprint for a whole list. It changes if any name or share changes, yet reveals none of them.'],
  ['Nullifier', 'A one-time “used” stamp. It stops a share being claimed twice without saying whose share it was.'],
  ['Zero-knowledge proof', 'Showing you know the answer without saying it, like proving you’re over 18 without showing your birthday.'],
];

export function LensView({ s }: { s: Snapshot }) {
  const [revealed, setRevealed] = useState(false);
  const [asking, setAsking] = useState(false);
  const [active, setActive] = useState<Active>();
  const pct = (id: string) => `${Number(s.heirs.find((h) => h.profile.id === id)!.shareBps) / 100}%`;
  const amt = (id: string) => s.heirs.find((h) => h.profile.id === id)!.amount.toLocaleString();
  const kofi = s.heirs.find((h) => h.profile.id === 'kofi')!;
  const cleo = s.heirs.find((h) => h.profile.id === 'cleo')!;
  const claimedNames = s.heirs.filter((h) => h.claimed && (!h.profile.backup || !s.heirs.some((x) => !x.profile.backup && x.profile.leaf === h.profile.leaf && x.claimed)));
  const owner = s.actor.kind === 'owner';
  const r = s.recovery;
  const attestor = s.setup!.attestor;
  const stands = r.state === 'waiting' || r.state === 'ready';
  const zero = '0x0000…0000';

  const pub: [PubId, string, string, string][] = [
    ['owner', 'ownerPasskeyCommit', short(s.chain.ownerPasskeyCommit), `commitment ending ${s.chain.ownerPasskeyCommit.slice(-4)}`],
    ['root', 'willRoot', short(s.chain.willRoot), `hash ending ${s.chain.willRoot.slice(-4)}`],
    ['deadline', 'deadline', String(s.deadline), 'unix timestamp'],
    ['grace', 'gracePeriod', s.grace > 0 ? String(s.grace) : '0 · none', 'seconds'],
    ['window', 'challengeWindow', String(s.setup!.window), 'seconds'],
    ['counter', 'nonce', s.nonce.toString(), 'count'],
    ['guard', 'guardianRoot · k · votes · round', `${short(s.chain.guardianRoot)} · ${s.guardianThreshold} · ${s.guardianVotes} · ${s.guardianRound + 1n}`, 'root, threshold, votes, round'],
    ['attest', 'attestorKeyCommit', attestor ? short(s.chain.attestorKeyCommit) : `${zero} · none`, attestor ? `commitment ending ${s.chain.attestorKeyCommit.slice(-4)}` : 'no attestor'],
    ['rec', 'recoveryKeyCommit · recoveryDelay', r.state === 'off' ? `${zero} · none` : `${short(s.chain.recoveryKeyCommit)} · ${r.delay}`, r.state === 'off' ? 'no recovery key' : 'commitment and delay in seconds'],
    ['recp', 'recoveryReadyAt · recoveryNonce', s.chain.recoveryReadyAt === 0 ? '0 · no recovery started' : `${s.chain.recoveryReadyAt} · ${s.chain.recoveryNonce}${r.state === 'retired' ? ' · cancelled' : ''}`, 'when proposed keys take over, and the owner action count when it started'],
    ['fee', 'feeBps', s.feeBps > 0n ? s.feeBps.toString() : '0 · no release fee', 'basis points'],
    ['events', 'events', s.events.length ? eventSummary(s.events) : 'none yet', 'names of events emitted so far'],
    ['nulls', 'claimNullifiers', s.chain.claimNullifiers.length ? `${s.chain.claimNullifiers.length} spent · ${s.chain.claimNullifiers.map((n) => `0x${n.slice(0, 4)}…`).join(' ')}` : '{ } · 0 spent', 'set of stamps'],
    ['bal', 'estate', `${s.estate.toLocaleString()} ${TOKEN}`, 'balance'],
    ['pos', `escrow ${short(s.position.address)}`, `${s.position.held.toLocaleString()} · ${short(s.position.beneficiaryCommit)} · ${s.position.withdrawn ? 'withdrawn' : 'not withdrawn'}`, 'linked contract: amount held, beneficiary commitment, withdrawn or not'],
    ['msg', 'sealed messages', 'nothing · no field', 'not on the ledger'],
  ];
  const priv: [string, PubId, string, string][] = [
    ['me', 'owner', 'Owner', `${OWNER_FIRST} · ${s.passkey?.kind === 'device' ? 'passkey on this device' : 'demo key in this tab'}`],
    ['ada', 'root', 'Heir', `Ada · ${pct('ada')}`],
    ['ben', 'root', 'Heir', `Ben · ${pct('ben')}`],
    ['cleo', 'root', 'Heir', `Cleo · ${pct('cleo')} · from ${fmtShort(cleo.unlockAt)}`],
    ['bak', 'root', 'Backup heir', kofi.named ? 'Kofi, for Ada’s share' : 'None'],
    ['due', 'deadline', 'Next check-in due', fmtShort(s.deadline)],
    ['late', 'grace', 'If a check-in is late', s.grace > 0 ? `${span(s.grace)} of grace` : 'No grace period'],
    ['win', 'window', 'Time to cancel', `${days(s.setup!.window)} days`],
    ['hist', 'counter', 'Owner actions', `${s.nonce} · check-ins, will changes and settings changes`],
    ['g', 'guard', 'Guardians', s.guardians.filter((g) => g.current).map((g) => g.name).join(' · ')],
    ['att', 'attest', 'Attestor', attestor ? ATTESTOR.name : 'None'],
    ['rk', 'rec', 'Recovery key', r.state === 'off' ? 'None' : r.state === 'retired' ? 'Retired after a cancelled recovery' : `On paper, with ${OWNER_FIRST}`],
    ['rp', 'recp', 'Recovery in progress', stands ? 'A new passkey, made on another device' : r.state === 'retired' ? `Cancelled by ${OWNER_FIRST}’s passkey` : 'None'],
    ['nofee', 'fee', 'Release fee', s.feeBps > 0n ? `${Number(s.feeBps) / 100}% of the estate` : 'None'],
    ['evs', 'events', 'What the events were about', s.events.length ? 'Known only to the people involved' : 'Nothing has happened yet'],
    ['cl', 'nulls', 'Claims', claimedNames.length ? `${claimedNames.map((h) => h.profile.name).join(', ')} claimed` : 'No one has claimed'],
    ['split', 'bal', 'How it splits', `Ada ${amt('ada')} · Ben ${amt('ben')} · Cleo ${amt('cleo')}`],
    ['sav', 'pos', s.position.name, `${HEIRS.find((h) => h.id === s.position.beneficiary)!.name} is the beneficiary${s.position.withdrawn ? ' · paid out' : ''}`],
    ['sealed', 'msg', 'Sealed messages', s.messages.length ? `${s.messages.length}, for ${s.messages.map((m) => HEIRS.find((h) => h.id === m.to)!.name).join(' and ')}` : 'None'],
  ];

  const hiPub = active ? (active.side === 'pub' ? active.id : priv.find((p) => p[0] === active.id)?.[1]) : undefined;
  const noteKey = active ? (active.side === 'priv' && NOTES[active.id] ? active.id : hiPub) : undefined;
  const [noteTitle, noteBody] = noteKey ? NOTES[noteKey] : IDLE;
  const on = (side: 'pub' | 'priv', id: string) => ({
    onMouseEnter: () => setActive({ side, id }),
    onFocus: () => setActive({ side, id }),
    onClick: () => setActive({ side, id }),
    onMouseLeave: () => setActive(undefined),
    'aria-describedby': 'lens-note',
  });

  const reveal = async () => {
    if (revealed) { setRevealed(false); return; }
    if (!owner) { setRevealed(true); return; }
    setAsking(true);
    const ok = await demo.verifyOwner();
    setAsking(false);
    setRevealed(ok);
  };
  const revealLabel = owner ? (s.passkey?.kind === 'device' ? 'Reveal with Face ID' : 'Reveal with your demo key') : `Reveal ${OWNER_FIRST}'s view`;

  return (
    <div className="lens">
      <div className="lens-head">
        <div className="stack-12">
          <span className="eyebrow">Privacy Lens</span>
          <h1 className="disp h-sm">Two ledgers, <em>one</em> will.</h1>
          <p className="lede">
            Midnight keeps a <span className="tone-public">public ledger</span> everyone can read and a{' '}
            <span className="tone-private">private ledger</span> that lives only on your device. Point at any row to see its counterpart.
          </p>
        </div>
        <button type="button" className="btn btn-secondary" aria-pressed={revealed} disabled={asking} onClick={() => void reveal()}>
          {revealed ? 'Hide private data' : revealLabel}
        </button>
      </div>

      <div className="lens-grid">
        <section className="lens-side lens-public" aria-labelledby="pub-h">
          <div className="lens-side-head">
            <h2 id="pub-h"><Icon d={ICONS.chain} size={16} stroke={2} />What the blockchain sees</h2>
            <span className="mono small">contract {short(s.chain.address)}</span>
          </div>
          <div className="ledger">
            {pub.map(([id, k, v, sr]) => (
              <button key={id} type="button" className={`lens-row ${hiPub === id ? 'is-hi' : ''}`} {...on('pub', id)}>
                <span className="mono lens-k">{k}</span>
                <span className="mono lens-v" aria-label={`${k}: ${sr} ${v}`}>{v}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="lens-side lens-private" aria-labelledby="priv-h">
          <div className="lens-side-head">
            <h2 id="priv-h"><Icon d={ICONS.phone} size={16} stroke={2} />What {owner ? 'you see' : `${OWNER_FIRST} sees`}, on this device only</h2>
            <span className="small">decrypted locally · never uploaded</span>
          </div>
          <div className={`ledger ${revealed ? 'is-revealed' : 'is-sealed'}`} aria-hidden={!revealed}>
            {priv.map(([id, link, k, v]) => {
              const hi = active && ((active.side === 'priv' && active.id === id) || (active.side === 'pub' && active.id === link));
              return (
                <button key={id} type="button" tabIndex={revealed ? 0 : -1} className={`lens-row ${hi ? 'is-hi' : ''}`} {...on('priv', id)}>
                  <span className="lens-k">{k}</span>
                  <span className="lens-v">{v}</span>
                </button>
              );
            })}
          </div>
          {!revealed && (
            <div className="lens-glass glass">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
              <span className="disp lens-glass-title">Sealed on this device</span>
              <span className="small">This is all anyone else, including us, could ever see. Only {owner ? 'your' : `${OWNER_FIRST}'s`} passkey can lift the glass.</span>
              <button type="button" className="btn btn-primary" disabled={asking} onClick={() => void reveal()}>{revealLabel}</button>
            </div>
          )}
        </section>
      </div>

      <div id="lens-note" role="status" aria-live="polite" className={`lens-note ${active ? 'is-active' : ''}`}>
        <Icon d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4" size={22} stroke={1.5} />
        <div><strong>{noteTitle}</strong><span>{noteBody}</span></div>
      </div>

      <dl className="glossary">
        {GLOSSARY.map(([t, d]) => (
          <div key={t}><dt>{t}</dt><dd>{d}</dd></div>
        ))}
      </dl>
    </div>
  );
}
