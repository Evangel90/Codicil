// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Sealed messages: something a vault releases besides money. The owner writes
// to one person, or to everyone, and seals it on her own device. The reader
// holds the sealed text and half of its key; the guardians hold the other half
// in pieces, and hand them over when the vault says "released".
//
// A message travels one of two ways. By hand: guardian to recipient, with no
// trace on the chain. Through the seal register: a contract that refuses every
// piece until the vault has released, checks it, and publishes it. A public
// disclosure always goes through the register. The encryption, the key
// splitting and the contract calls here are real.

import { useEffect, useMemo, useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { HashChip, Icon, ICONS, Segmented } from '../components/ui.js';
import { messageStage, type MessageStage } from '../demo/guide.js';
import { SignalCard, StatementEditor } from './Signal.js';
import {
  demo, fmtDate, guardianById, HEIRS, MESSAGE_MAX, OWNER_FIRST, recipientName,
  type HeirProfile, type MessageTo, type MessageVia, type MessageView, type RegisterAttempt, type Snapshot,
} from '../demo/store.js';

export const MESSAGE_EXAMPLES: { label: string; text: (to: string) => string }[] = [
  {
    label: 'A letter',
    text: (to) => `${to}, if you are reading this, I have been gone a while.\n\nThe papers for the house are with Sarah Lin. Do not sell the workshop in a hurry: wait a year, then decide. Look after each other.\n\nI am proud of you.\n${OWNER_FIRST}`,
  },
  {
    label: 'A recovery phrase',
    text: (to) => `${to}, this is the recovery phrase for my everyday wallet, the one that is not in the vault:\n\nharbor velvet orbit lantern copper meadow signal anchor ribbon quartz willow ember\n\nThe hardware wallet is in the desk, second drawer. Its PIN is on the card inside my passport.`,
  },
  {
    label: 'Documents to publish',
    text: (to) => `${to}, if this reaches you, I could not publish it myself.\n\nThe contracts and the payment ledger are in the folder below. The password is on the second line.\n\nfolder: files.example/d/7f3a91\npassword: marigold-fathom-22\n\nSources 2 and 4 agreed to be named. Do not name the others. Check the ledger against the bank letters before you run anything.`,
  },
];

/** What a disclosure for everyone might say. */
export const DISCLOSURE_EXAMPLES: { label: string; text: string }[] = [
  {
    label: 'Documents to publish',
    text: 'If you are reading this, I could not publish it myself.\n\nThe contracts and the payment ledger are in the folder below. The password is on the second line.\n\nfolder: files.example/d/7f3a91\npassword: marigold-fathom-22\n\nSources 2 and 4 agreed to be named. Do not name the others. Check the ledger against the bank letters before you run anything.',
  },
  {
    label: 'A statement',
    text: 'If this is public, I have been out of contact for more than a month, and not by choice.\n\nI was working on the port contracts. My notes are with my editor. Ask her for them, and ask the port authority why the audit stopped in March.',
  },
];

const VIA: Record<MessageVia, { label: string; note: (name: string) => string }> = {
  hand: {
    label: 'By hand',
    note: (name) => `After the release your guardians send their pieces straight to ${name}. Nothing about the message is ever on the chain. Your guardians learn who it is for.`,
  },
  register: {
    label: 'Through the register',
    note: (name) => `After the release your guardians hand their pieces to the seal register, a contract that refuses them until your vault has released. They never learn it is for ${name}. The chain shows that a sealed text exists, and nothing about it.`,
  },
};

const WHY_REFUSED: Record<string, string> = {
  'vault not released': 'The register asks the vault before it accepts any piece. The vault has not released, so the register stopped there.',
  'not a genuine piece': 'When the message was sealed, the register took a commitment to each genuine piece. This one matches none of them.',
  'no such seal': 'The owner took this sealed text back, so the register accepts no piece for it.',
};

const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const pieces = (n: number) => `${n} piece${n === 1 ? '' : 's'}`;
const personById = (id: HeirProfile['id']) => HEIRS.find((h) => h.id === id)!;
const everyone = (s: Snapshot) => s.messages.find((m) => m.to === 'everyone');

const STAGE_WORDS: Record<MessageStage, string> = {
  sealed: 'Shut until your vault releases',
  collecting: 'Released: waiting for guardians to hand over their pieces',
  ready: 'Enough pieces have arrived: it can be opened',
  opened: 'Opened',
};

/** How many of the needed pieces have reached the recipient. */
function PieceCount({ m }: { m: MessageView }) {
  const have = Math.min(m.handed.length, m.needed);
  return (
    <div className="msg-count" role="img" aria-label={`${have} of ${m.needed} pieces have arrived`}>
      <div className="vote-dots" aria-hidden="true">
        {Array.from({ length: m.needed }, (_, i) => <span key={i} className={i < have ? 'on' : ''} />)}
      </div>
      <span className="small muted">{have} of {pieces(m.needed)} arrived</span>
    </div>
  );
}

/** Where each part of a message's key is, and what the chain knows: nothing. */
function LockPanel({ s, you }: { s: Snapshot; you: 'owner' | 'recipient' | 'guardian' | 'stranger' }) {
  const n = s.guardians.filter((g) => g.current).length;
  const k = Number(s.guardianThreshold);
  const guardians = you === 'owner' ? 'Your guardians' : you === 'guardian' ? 'You and the other guardians' : `${OWNER_FIRST}'s guardians`;
  return (
    <aside className="card estate savings-ledger" aria-label="How a sealed message is locked">
      <div className="savings-side savings-private">
        <h2><Icon d={ICONS.phone} size={16} stroke={2} />Where the parts are kept</h2>
        <dl>
          <div><dt>The sealed text</dt><dd>{you === 'recipient' ? 'On your device' : 'With the recipient'}</dd></div>
          <div><dt>One half of the key</dt><dd>{you === 'recipient' ? 'On your device' : 'With the recipient'}</dd></div>
          <div><dt>The other half</dt><dd>{n === 1 ? 'With the one guardian' : `Cut into ${pieces(n)}`}</dd></div>
          <div><dt>Pieces needed</dt><dd>{k} of {n}</dd></div>
          <div><dt>Held by</dt><dd>{guardians}</dd></div>
          {everyone(s) && <div><dt>The public disclosure</dt><dd>Posted for everyone, with its half</dd></div>}
        </dl>
        <p className="small">Guardians cannot read a message: they never get the recipient's half. The recipient cannot read it early: they never get the guardians' half until the vault releases.</p>
      </div>
      <div className="savings-side savings-public">
        <h2><Icon d={ICONS.chain} size={16} stroke={2} />What anyone can read</h2>
        {s.register.seals.length === 0 ? (
          <p className="small">Nothing. A message delivered by hand is never a transaction: the chain has no record that it exists, who wrote it or who it is for.</p>
        ) : (
          <>
            <dl>
              <div><dt>Seal register</dt><dd><HashChip value={s.register.address} /></dd></div>
              <div><dt>Sealed texts, by fingerprint</dt><dd>{s.register.seals.length}</dd></div>
              <div><dt>Commitments to pieces</dt><dd>{s.register.pieceChecks}</dd></div>
              <div><dt>Pieces handed over</dt><dd>{s.register.handedOver.length}</dd></div>
              <div><dt>Made by the vault's owner</dt><dd>{s.register.provesOwner ? 'Proven' : 'Not proven'}</dd></div>
            </dl>
            <p className="small">That is all the register holds: no message, no key, no name. A message delivered by hand is not here at all.</p>
          </>
        )}
      </div>
      <div className="savings-side">
        <h2><Icon d={ICONS.shield} size={16} stroke={2} />What it relies on</h2>
        <p className="small">
          Guardians keep their pieces until the vault says released. The vault is the signal nobody can fake or stop, and
          the register will not take a piece before it; keeping a piece to yourself until then is a promise. Opening a
          private message early would take {k === 1 ? 'one guardian' : `${k} guardians`} and the recipient, acting together.
          A public disclosure has no recipient to hold a half, so {k === 1 ? 'one guardian' : `${k} guardians`} could open it.
          The vault does not know its register, so the register proves whose it is: a reader checks that it holds the vault's own owner commitment.
        </p>
        {k === 1 && you === 'owner' && (
          <p className="small msg-warn">With 1 needed, any one guardian and the recipient could open a message early. Raise the number in Settings.</p>
        )}
      </div>
    </aside>
  );
}

/** Whether the register has proved it was made by the vault's owner, in words anyone can act on. */
function OwnerProof({ s }: { s: Snapshot }) {
  const mine = s.actor.kind === 'owner';
  const busy = s.tx?.status === 'running';
  if (s.register.provesOwner) {
    return (
      <p className="small muted owner-proof">
        <Icon d={ICONS.check} size={14} stroke={2} />
        <span>
          This register is {mine ? 'yours' : `${OWNER_FIRST}'s`}, and it proves it. It holds the same owner commitment as the vault,{' '}
          <HashChip value={s.register.ownerCommit} />, put there by a zero-knowledge proof that only the vault's owner can make.
        </span>
      </p>
    );
  }
  return (
    <div className="savings-note owner-proof-missing" role="status">
      <p>
        {mine
          ? 'Your vault has a new owner key, so the seal register no longer proves it is yours. Until you prove it again, a reader cannot tell it from a register somebody else pointed at your vault.'
          : `This register has not proved that it belongs to the owner of this vault. Anyone can deploy a register that points at a vault, so treat what it holds with care until ${OWNER_FIRST} proves it.`}
      </p>
      {mine && (
        <div><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void demo.proveRegister()}>Prove the register is yours</button></div>
      )}
    </div>
  );
}

/** The register's answer to the last piece anyone sent it. */
function LastAttempt({ a }: { a: RegisterAttempt }) {
  return (
    <section className="card attempt" aria-labelledby="reg-att-h" role="status">
      <span className={a.ok ? 'ok-ring' : 'bad-ring'} aria-hidden="true"><Icon d={a.ok ? ICONS.check : ICONS.close} size={18} stroke={1.8} /></span>
      <div>
        <h2 id="reg-att-h">{a.ok ? `Accepted on ${fmtDate(a.at)}` : `Refused on ${fmtDate(a.at)}`}</h2>
        {a.ok ? (
          <>
            <p>One transaction ran two circuits. On Midnight each one gets its own proof.</p>
            <ol className="calls">
              {(a.calls ?? []).map((c, i) => (
                <li key={c.circuit}>
                  <span className="mono calls-n" aria-hidden="true">{i + 1}</span>
                  <span>
                    <code className="mono">{c.contract}.{c.circuit}</code>
                    <span className="small muted">
                      {c.contract === 'vault'
                        ? 'The vault answered yes: it has released.'
                        : 'The register checked the piece against its commitment and wrote it to the public ledger.'}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <>
            <p>
              {a.by} sent the register a piece, and it answered with its own error:{' '}
              {a.code ? <code className="mono attempt-code">{a.code}</code> : 'the request could not be read'}
            </p>
            {a.code && WHY_REFUSED[a.code] && <p className="small muted">{WHY_REFUSED[a.code]}</p>}
          </>
        )}
      </div>
    </section>
  );
}

// ─── The owner ──────────────────────────────────────────────────────────────
function Editor({ to, start, startVia, onDone }: { to: MessageTo; start: string; startVia: MessageVia; onDone: () => void }) {
  const [text, setText] = useState(start);
  const [via, setVia] = useState<MessageVia>(startVia);
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const length = text.trim().length;
  const over = length > MESSAGE_MAX;
  const open = to === 'everyone';
  const name = recipientName(to);
  const examples = open ? DISCLOSURE_EXAMPLES.map((x) => ({ label: x.label, text: x.text })) : MESSAGE_EXAMPLES.map((x) => ({ label: x.label, text: x.text(name) }));
  const seal = async () => {
    setBusy(true);
    const wrong = await demo.sealMessage(to, text, via);
    setBusy(false);
    if (wrong) setProblem(wrong);
    else onDone();
  };
  return (
    <div className="stack-12">
      <label className="field-label">
        {open ? 'Your disclosure, for everyone' : `Your message for ${name}`}
        <textarea
          className="field msg-text" value={text} rows={8} aria-invalid={over || undefined} autoFocus
          placeholder={open ? 'Write what should come out if you can no longer say it yourself.' : `Write to ${name}. Only ${name} will ever read this.`}
          onChange={(e) => { setText(e.target.value); setProblem(undefined); }}
        />
      </label>
      <div className="msg-under">
        <span className="small muted">
          Or start from an example:{' '}
          {examples.map((x, i) => (
            <span key={x.label}>
              <button type="button" className="linkish" onClick={() => { setText(x.text); setProblem(undefined); }}>{x.label.toLowerCase()}</button>
              {i < examples.length - 1 && ', '}
            </span>
          ))}
        </span>
        <span className={`small mono ${over ? 'msg-over' : 'muted'}`}>{length.toLocaleString()} / {MESSAGE_MAX.toLocaleString()}</span>
      </div>
      {open ? (
        <p className="small muted">
          A disclosure goes through the seal register. Its fingerprint is recorded now, which later shows the text
          existed today. After your vault releases, the register accepts your guardians' pieces, and then anyone can open it.
        </p>
      ) : (
        <fieldset className="msg-via">
          <legend>How should the pieces of its key travel?</legend>
          <Segmented<MessageVia>
            label="How the pieces travel" size="sm" value={via} onChange={setVia}
            options={(['hand', 'register'] as const).map((v) => ({ value: v, label: VIA[v].label }))}
          />
          <span className="small muted">{VIA[via].note(name)}</span>
        </fieldset>
      )}
      {problem && <p className="err-inline" role="alert">{problem}</p>}
      <div className="btn-row">
        <button type="button" className="btn btn-primary" disabled={busy || length === 0 || over} onClick={() => void seal()}>
          Seal for {name}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>Cancel</button>
        <span className="small muted">
          {open || via === 'register' ? 'Sealed on this device. Only a fingerprint goes to the chain.' : 'Sealed on this device. Nothing is sent to the chain.'}
        </span>
      </div>
    </div>
  );
}

function OwnerRow({ s, to, title, relation, editing, setEditing, setProblem }: {
  s: Snapshot; to: MessageTo; title: string; relation: string; editing: boolean;
  setEditing: (to?: MessageTo) => void; setProblem: (p?: string) => void;
}) {
  const released = s.phase === Phase.released;
  const m = s.messages.find((x) => x.to === to);
  const stage = m && messageStage(s, m);
  const open = to === 'everyone';
  const name = recipientName(to);
  return (
    <li className="card msg-row">
      <div className="msg-row-head">
        <div className="stack-6">
          <h2 className="msg-name">{title} <span className="muted">· {relation}</span></h2>
          <span className="small muted">
            {!m ? 'Nothing sealed'
              : stage === 'opened' ? (open ? `Opened on ${fmtDate(m.opened!.at)}: it is public now` : `Opened by ${name} on ${fmtDate(m.opened!.at)}`)
              : `Sealed on ${fmtDate(m.sealedAt)} · ${m.text.length.toLocaleString()} characters · ${STAGE_WORDS[stage!]}`}
          </span>
        </div>
        {!editing && !released && (
          <div className="btn-row">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditing(to); setProblem(undefined); }}>
              {m ? 'Read or change' : open ? 'Write a disclosure' : `Write to ${name}`}
            </button>
            {m && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void demo.removeMessage(to).then(setProblem)}>
                {open ? 'Take back' : 'Remove'}
              </button>
            )}
          </div>
        )}
      </div>
      {editing && !released && <Editor to={to} start={m?.text ?? ''} startVia={m?.via ?? (open ? 'register' : 'hand')} onDone={() => setEditing(undefined)} />}
      {m && !editing && (
        <span className="small muted">
          {m.holders.length === 1
            ? `${guardianById(m.holders[0]).name} holds the guardians' half of its key.`
            : `${list(m.holders.map((id) => guardianById(id).name))} each hold a piece of its key. Any ${m.needed} of them open it, ${open ? 'for everyone' : `together with ${name}`}.`}
          {m.via === 'register' && !open && ' Their pieces go through the seal register, so none of them learns who it is for.'}
        </span>
      )}
      {m?.fingerprint && !editing && (
        <span className="small muted msg-fp">
          On the register: fingerprint <HashChip value={m.fingerprint} />
          {m.sealedBefore !== undefined && <> recorded before {fmtDate(m.sealedBefore)}</>}
        </span>
      )}
    </li>
  );
}

function OwnerMessages({ s, focus, onFocused }: { s: Snapshot; focus?: Focus; onFocused?: () => void }) {
  // A story that is about the disclosure opens its editor straight away, once.
  const [editing, setEditing] = useState<MessageTo | undefined>(() => (focus === 'everyone' && !everyone(s) && s.phase !== Phase.released ? 'everyone' : undefined));
  const [problem, setProblem] = useState<string>();
  const released = s.phase === Phase.released;
  // Tell the shell the story's opening move has been made, so coming back here does not repeat it.
  useEffect(() => { if (focus === 'everyone') onFocused?.(); }, [focus, onFocused]);
  return (
    <div className="messages">
      <div className="owner-head">
        <div className="stack-12">
          <h1 className="disp h-sm">Sealed messages</h1>
          <p className="lede">
            Write to one person: a letter, or the recovery phrase of a wallet you keep outside this vault. Or seal a
            disclosure for everyone: what must come out if you can no longer publish it yourself. Either is locked on
            this device and opens only after your vault releases.
          </p>
        </div>
      </div>
      <div className="split">
        <div className="split-main msg-main">
          {released && <p className="savings-note">Your vault has released, so messages can no longer be sealed or changed.</p>}
          {problem && <p className="err-inline" role="alert">{problem}</p>}
          {!s.register.provesOwner && <OwnerProof s={s} />}
          {focus === 'statement' && <StatementEditor s={s} />}
          <ul className="msg-list">
            {HEIRS.map((h) => (
              <OwnerRow
                key={h.id} s={s} to={h.id} title={h.name} relation={h.relation}
                editing={editing === h.id} setEditing={setEditing} setProblem={setProblem}
              />
            ))}
            <OwnerRow
              s={s} to="everyone" title="Everyone" relation="A public disclosure"
              editing={editing === 'everyone'} setEditing={setEditing} setProblem={setProblem}
            />
          </ul>
          {s.register.lastAttempt && <LastAttempt a={s.register.lastAttempt} />}
          {focus !== 'statement' && <StatementEditor s={s} />}
          <details className="disclose">
            <summary>Can I take a message back?</summary>
            <p>
              While your vault is armed you can change or remove a message. The message is sealed again under a new key
              and your guardians' apps replace their pieces. On the register, the old seal is removed, so it accepts no
              piece for it. That still relies on people: someone who kept a copy of an old piece, and a reader who kept
              the old sealed text, could open the old message after a release.
            </p>
          </details>
        </div>
        <LockPanel s={s} you="owner" />
      </div>
    </div>
  );
}

// ─── A public disclosure, as anyone sees it ─────────────────────────────────
function Disclosure({ s }: { s: Snapshot }) {
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const m = everyone(s);
  // What was refused a moment ago may be allowed now: drop the old answer when the facts change.
  useEffect(() => setProblem(undefined), [s.phase, m?.handed.length]);
  if (!m) return null;
  const stage = messageStage(s, m);
  const waiting = m.holders.filter((g) => !m.handed.includes(g));
  const open = async () => {
    setBusy(true);
    setProblem(await demo.openMessage('everyone'));
    setBusy(false);
  };
  if (m.opened) {
    return (
      <article className="letter msg-letter" aria-label="The disclosure">
        <header><span className="small muted">Sealed before {fmtDate(m.sealedBefore ?? m.sealedAt)} · opened on {fmtDate(m.opened.at)}</span></header>
        <p className="msg-open">{m.opened.text}</p>
      </article>
    );
  }
  return (
    <section className="card claim" aria-labelledby="disc-h">
      <div className="claim-top">
        <h2 id="disc-h" className="savings-label">A public disclosure</h2>
        <code className="mono msg-noise">{m.sealedStart}…</code>
        <span className="small muted">
          {m.bytes.toLocaleString()} bytes of sealed text, posted where anyone can fetch it. Without its key it is noise.
        </span>
      </div>
      <dl className="msg-facts">
        <div><dt>Fingerprint on the register</dt><dd>{m.fingerprint && <HashChip value={m.fingerprint} />}</dd></div>
        <div><dt>Recorded before</dt><dd>{m.sealedBefore !== undefined ? fmtDate(m.sealedBefore) : 'unknown'}</dd></div>
      </dl>
      <OwnerProof s={s} />
      <PieceCount m={m} />
      <button type="button" className="btn btn-primary btn-lg" disabled={busy} onClick={() => void open()}>Open the disclosure</button>
      {problem && <p className="err-inline" role="alert">{problem}</p>}
      <p className="small muted">
        {stage === 'sealed' && 'It will not open yet: no piece of its key is on the register, and the register takes none until the vault releases.'}
        {stage === 'collecting' && 'The vault has released. Each guardian can now hand a piece to the register, which checks it and publishes it.'}
        {stage === 'ready' && 'Enough pieces are on the register. Anyone can rebuild the key from them and open the text, on their own device.'}
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn-ghost btn-sm" disabled={s.tx?.status === 'running'} onClick={() => void demo.plantPiece('everyone')}>
          Send the register a made-up piece
        </button>
        {stage === 'collecting' && waiting.slice(0, 3).map((g) => (
          <button key={g} type="button" className="btn btn-secondary btn-sm" onClick={() => demo.setActor({ kind: 'guardian', id: g })}>
            Act as {guardianById(g).name}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Anyone can check a copy of a sealed text against the register: proof it existed, unchanged, before a date. */
function CheckCopy({ s }: { s: Snapshot }) {
  const m = everyone(s);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  // The demo's clock redraws this every second; the check only runs again when its inputs change.
  const result = useMemo(() => (text.trim() ? demo.checkSealedCopy(text) : undefined), [text, s.register.seals]);
  if (s.register.seals.length === 0) return null;
  const copy = async () => {
    if (!m) return;
    try {
      await navigator.clipboard.writeText(m.sealedText);
      setCopied(true);
    } catch {
      setText(m.sealedText);
    }
  };
  return (
    <section className="card pad-24 stack-16" aria-labelledby="copy-h">
      <div className="stack-6">
        <h2 id="copy-h" className="disp h-card">Check a copy against the chain</h2>
        <p className="small muted">
          A sealed text can be posted anywhere, by anyone. Paste a copy here and this device works out its fingerprint
          and looks it up on the register. A match means this exact text was sealed before the date shown. Change one
          character and it no longer matches.
        </p>
      </div>
      <label className="field-label">
        A sealed text
        <textarea className="field mono msg-copy" rows={4} spellCheck={false} value={text} onChange={(e) => { setText(e.target.value); setCopied(false); }} />
      </label>
      {m && (
        <div className="btn-row">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setText(m.sealedText)}>Paste the public disclosure</button>
          <button type="button" className="linkish" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy it to the clipboard'}</button>
        </div>
      )}
      {result && (result.ok ? (
        <p className="copy-ok" role="status">
          It matches. The register recorded fingerprint <HashChip value={result.fingerprint} /> before {fmtDate(result.sealedBefore)},
          with {result.needed} of {pieces(result.pieces)} needed to open it.
        </p>
      ) : (
        <p className="err-inline" role="alert">{result.why}</p>
      ))}
    </section>
  );
}

// ─── The recipient ──────────────────────────────────────────────────────────
function RecipientMessage({ s, id }: { s: Snapshot; id: HeirProfile['id'] }) {
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const me = personById(id);
  const m = s.messages.find((x) => x.to === id);
  useEffect(() => setProblem(undefined), [s.phase, m?.handed.length]);
  if (!m) {
    return (
      <div className="messages">
        <div className="narrow stack-18">
          <h1 className="disp h-sm">No sealed message on this device.</h1>
          <p className="lede">
            {me.name}, if {OWNER_FIRST} seals a message for you, it arrives here locked. Nothing on the chain says who a
            message is for, so nobody else can tell whether you have one.
          </p>
          <div><button type="button" className="btn btn-secondary" onClick={() => demo.setActor({ kind: 'owner' })}>Act as {OWNER_FIRST} to write one</button></div>
        </div>
        {everyone(s) && (
          <div className="split">
            <div className="split-main msg-main">
              <Disclosure s={s} />
              {s.register.lastAttempt && <LastAttempt a={s.register.lastAttempt} />}
            </div>
            <LockPanel s={s} you="stranger" />
          </div>
        )}
      </div>
    );
  }
  const stage = messageStage(s, m);
  const waiting = m.holders.filter((g) => !m.handed.includes(g));
  const byRegister = m.via === 'register';
  const open = async () => {
    setBusy(true);
    setProblem(await demo.openMessage(id));
    setBusy(false);
  };
  return (
    <div className="messages">
      <div className="owner-head">
        <div className="stack-12">
          <h1 className="disp h-sm">
            {stage === 'opened' ? `${OWNER_FIRST}'s message to you.` : `${OWNER_FIRST} left you a sealed message.`}
          </h1>
          <p className="lede">
            {stage === 'sealed' && (byRegister
              ? 'It stays shut while her vault is armed. You hold the sealed text and half of its key. The other half is in pieces with her guardians, who hand them to the seal register once the vault releases. They do not know it is for you.'
              : 'It stays shut while her vault is armed. You hold the sealed text and half of its key. The other half is in pieces with her guardians, who hand them over once the vault releases.')}
            {stage === 'collecting' && `Her vault has released. The guardians can now hand over their pieces of the key: ${m.needed === 1 ? 'one is' : `${m.needed} are`} needed.`}
            {stage === 'ready' && (byRegister
              ? 'Enough pieces are on the register. Anyone can read them there, but only you hold the other half of the key, so only this device can open the message.'
              : 'Enough pieces have arrived. Together with the half you already hold, they rebuild the key on this device.')}
            {stage === 'opened' && (byRegister
              ? `Opened on ${fmtDate(m.opened!.at)}, on this device. Nobody else has read it. The chain shows that a sealed text existed, and not that it was yours.`
              : `Opened on ${fmtDate(m.opened!.at)}, on this device. Nobody else has read it, and the chain has no record that it exists.`)}
          </p>
        </div>
      </div>
      <div className="split">
        <div className="split-main msg-main">
          {m.opened ? (
            <article className="letter msg-letter" aria-label={`Message from ${OWNER_FIRST}`}>
              <header><span className="small muted">From {OWNER_FIRST} · sealed on {fmtDate(m.sealedAt)}</span></header>
              <p className="msg-open">{m.opened.text}</p>
            </article>
          ) : (
            <section className="card claim" aria-labelledby="msg-h">
              <div className="claim-top">
                <h2 id="msg-h" className="savings-label">What you hold</h2>
                <code className="mono msg-noise">{m.sealedStart}…</code>
                <span className="small muted">{m.bytes.toLocaleString()} bytes of sealed text. Without the whole key it is noise.</span>
              </div>
              <PieceCount m={m} />
              <button type="button" className="btn btn-primary btn-lg" disabled={busy} onClick={() => void open()}>Open the message</button>
              {problem && <p className="err-inline" role="alert">{problem}</p>}
              <p className="small muted">
                {stage === 'sealed' && 'It will not open yet. Try it: your half of the key is not enough without the pieces.'}
                {stage === 'collecting' && (byRegister
                  ? 'Pieces appear on the register as guardians hand them over. The register checks each one, so a wrong piece never lands.'
                  : 'Pieces arrive as guardians hand them over. Each one is checked on arrival, so a wrong piece is caught.')}
                {stage === 'ready' && 'It opens on this device. Nothing is sent anywhere.'}
              </p>
              {stage === 'collecting' && waiting.length > 0 && (
                <div className="btn-row">
                  {waiting.slice(0, 3).map((g) => (
                    <button key={g} type="button" className="btn btn-secondary btn-sm" onClick={() => demo.setActor({ kind: 'guardian', id: g })}>
                      Act as {guardianById(g).name}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          <Disclosure s={s} />
          {s.register.lastAttempt && <LastAttempt a={s.register.lastAttempt} />}
        </div>
        <LockPanel s={s} you="recipient" />
      </div>
    </div>
  );
}

// ─── A guardian ─────────────────────────────────────────────────────────────
function GuardianPieces({ s, id }: { s: Snapshot; id: number }) {
  const [problem, setProblem] = useState<string>();
  const me = guardianById(id);
  const mine = s.messages.filter((m) => m.holders.includes(id));
  useEffect(() => setProblem(undefined), [s.phase]);
  if (mine.length === 0) {
    return (
      <div className="narrow stack-18">
        <h1 className="disp h-sm">This device holds no piece of a key.</h1>
        <p className="lede">
          {me.name}, when {OWNER_FIRST} seals a message, each of her guardians gets a piece of its key. Either nothing
          is sealed yet, or you are no longer one of her guardians.
        </p>
      </div>
    );
  }
  const left = mine.filter((m) => !m.handed.includes(id));
  const byHand = left.filter((m) => m.via === 'hand');
  const byRegister = left.filter((m) => m.via === 'register');
  const sentByRegister = mine.some((m) => m.via === 'register');
  const sentByHand = mine.some((m) => m.via === 'hand');
  const released = s.phase === Phase.released;
  const busy = s.tx?.status === 'running';
  const k = Number(s.guardianThreshold);
  return (
    <div className="messages">
      <div className="owner-head">
        <div className="stack-12">
          <h1 className="disp h-sm">{mine.length === 1 ? 'You hold a piece of a key.' : `You hold ${mine.length} pieces of keys.`}</h1>
          <p className="lede">
            {OWNER_FIRST} sealed {mine.length === 1 ? 'a message' : `${mine.length} messages`} and cut half of {mine.length === 1 ? 'its key' : 'each key'} into
            pieces, one per guardian. Yours opens nothing by itself. You cannot tell what a message says or who it is for.
          </p>
        </div>
      </div>
      <div className="split">
        <div className="split-main msg-main">
          {left.length === 0 ? (
            <div className="card pad-24 voted">
              <span className="ok-ring"><Icon d={ICONS.check} size={20} stroke={1.8} /></span>
              <div className="stack-6">
                <strong>{mine.length === 1 ? 'Your piece is handed over.' : 'Your pieces are handed over.'}</strong>
                <span className="muted">
                  {sentByHand && `${mine.length === 1 ? 'It went' : 'By hand, each went'} to the person the message is for, and to nobody else. `}
                  {sentByRegister && `${mine.length === 1 ? 'It is' : 'The rest are'} on the register's public ledger, where the reader collects ${mine.length === 1 ? 'it' : 'them'}. `}
                  There is nothing more to do.
                </span>
              </div>
            </div>
          ) : (
            <section className="card claim" aria-labelledby="gp-h">
              <div className="claim-top">
                <h2 id="gp-h" className="savings-label">The vault says</h2>
                <span className={`state-line tone-${s.phase === Phase.armed ? 'armed' : released ? 'released' : 'pending'}`}>
                  <Icon d={ICONS.clock} size={14} stroke={2} />
                  {s.phase === Phase.armed ? 'Armed' : released ? 'Released' : 'Pending'}
                </span>
              </div>
              {byHand.length > 0 && (
                <>
                  <button type="button" className="btn btn-primary btn-lg" onClick={() => setProblem(demo.handOverPieces(id))}>
                    {byHand.length === 1 ? 'Hand over my piece' : `Hand over my ${byHand.length} pieces`}
                  </button>
                  {problem && <p className="err-inline" role="alert">{problem}</p>}
                  <p className="small muted">
                    {released
                      ? `The vault has released, so this is the moment ${OWNER_FIRST} asked you to wait for.`
                      : `Your app reads the vault from the chain before it sends anything, and it will refuse now. Try it.`}
                  </p>
                </>
              )}
              {byRegister.length > 0 && (
                <>
                  <button type="button" className={`btn ${byHand.length > 0 ? 'btn-secondary' : 'btn-primary'} btn-lg`} disabled={busy} onClick={() => void demo.publishPieces(id)}>
                    {byRegister.length === 1 ? 'Hand over through the register' : `Hand over ${byRegister.length} pieces through the register`}
                  </button>
                  <p className="small muted">
                    {released
                      ? 'The register will ask the vault, check your piece against the commitment made when the message was sealed, and publish it. You do not need to know who reads it.'
                      : 'The register asks the vault before it accepts a piece, and the vault has not released. The contract will refuse. Try it.'}
                  </p>
                </>
              )}
            </section>
          )}
          {s.register.lastAttempt && <LastAttempt a={s.register.lastAttempt} />}
          <section className="card pad-24 stack-16">
            <h2 className="disp h-card">What {OWNER_FIRST} asked of you</h2>
            <ol className="numbered">
              <li><span className="mono">1</span><span><strong>Keep the piece.</strong> It sits on this device. It is not a copy of the message and it is not the key.</span></li>
              <li><span className="mono">2</span><span><strong>Wait for the vault.</strong> When it says released, hand the piece over. Until then, do nothing, whoever asks.</span></li>
              <li><span className="mono">3</span><span><strong>That is all.</strong> {k === 1 ? 'Your piece alone completes the guardians\' half of the key' : `It takes ${k} guardians' pieces to complete their half of the key`}. A private message still needs the half only its recipient holds.</span></li>
            </ol>
          </section>
          <Disclosure s={s} />
        </div>
        <LockPanel s={s} you="guardian" />
      </div>
    </div>
  );
}

// ─── Anyone else ────────────────────────────────────────────────────────────
function StrangerMessages({ s }: { s: Snapshot }) {
  const disclosure = everyone(s);
  return (
    <div className="messages">
      <div className="owner-head">
        <div className="stack-12">
          <h1 className="disp h-sm">
            {!disclosure ? 'Nothing here for a stranger.' : disclosure.opened ? 'The disclosure is public.' : 'A sealed disclosure is waiting.'}
          </h1>
          <p className="lede">
            {!disclosure && `${OWNER_FIRST} may have sealed private messages, or none. One delivered by hand leaves no record on the chain. One that goes through the seal register leaves a fingerprint, and nothing about what it says or who it is for.`}
            {disclosure && !disclosure.opened && `The owner of this vault sealed a text for everyone. You can fetch it and check it against the fingerprint on the chain, but it opens only after the vault releases and ${disclosure.needed === 1 ? 'a guardian hands over the key' : `${disclosure.needed} guardians hand over their pieces of the key`}.`}
            {disclosure?.opened && 'The vault released, the guardians handed their pieces to the register, and the key was rebuilt from the public ledger. The fingerprint shows this is the text that was sealed, unchanged.'}
          </p>
        </div>
      </div>
      <div className="split">
        <div className="split-main msg-main">
          <SignalCard s={s} />
          <Disclosure s={s} />
          {s.register.lastAttempt && <LastAttempt a={s.register.lastAttempt} />}
          <CheckCopy s={s} />
          {!disclosure && (
            <div className="btn-row">
              <button type="button" className="btn btn-primary" onClick={() => demo.setActor({ kind: 'owner' })}>Act as {OWNER_FIRST}</button>
              <span className="small muted">to seal a message and follow it through.</span>
            </div>
          )}
        </div>
        <LockPanel s={s} you="stranger" />
      </div>
    </div>
  );
}

/** What the story the visitor picked is about, so the owner's screen can start there. */
export type Focus = 'everyone' | 'statement';

export function MessagesView({ s, focus, onFocused }: { s: Snapshot; focus?: Focus; onFocused?: () => void }) {
  // Each person's screen keeps its own state, so switching people starts it fresh.
  if (s.actor.kind === 'owner') return <OwnerMessages s={s} focus={focus} onFocused={onFocused} />;
  if (s.actor.kind === 'heir') return <RecipientMessage key={s.actor.id} s={s} id={s.actor.id} />;
  if (s.actor.kind === 'guardian') return <GuardianPieces key={s.actor.id} s={s} id={s.actor.id} />;
  return <StrangerMessages s={s} />;
}
