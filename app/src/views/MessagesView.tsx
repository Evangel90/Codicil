// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Sealed messages: something a vault releases besides money. The owner writes
// to one person and seals it on her own device. The recipient holds the sealed
// text and half of its key; the guardians hold the other half in pieces, and
// hand them over when the vault says "released". The encryption and the key
// splitting here are real; nothing on this screen is a transaction.

import { useState } from 'react';
import { Phase } from '@codicil/contracts/vault';
import { Icon, ICONS } from '../components/ui.js';
import { messageStage, type MessageStage } from '../demo/guide.js';
import {
  demo, fmtDate, guardianById, HEIRS, MESSAGE_MAX, OWNER_FIRST, type HeirProfile, type MessageView, type Snapshot,
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

const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const pieces = (n: number) => `${n} piece${n === 1 ? '' : 's'}`;
const personById = (id: HeirProfile['id']) => HEIRS.find((h) => h.id === id)!;

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
        </dl>
        <p className="small">Guardians cannot read a message: they never get the recipient's half. The recipient cannot read it early: they never get the guardians' half until the vault releases.</p>
      </div>
      <div className="savings-side savings-public">
        <h2><Icon d={ICONS.chain} size={16} stroke={2} />What anyone can read</h2>
        <p className="small">Nothing. Sealing, handing over a piece and opening are not transactions. The chain has no record that a message exists, who wrote it or who it is for.</p>
      </div>
      <div className="savings-side">
        <h2><Icon d={ICONS.shield} size={16} stroke={2} />What it relies on</h2>
        <p className="small">
          Guardians keep their pieces until the vault says released. The vault is the signal nobody can fake or stop;
          keeping a piece until then is a promise. Opening a message early would take {k === 1 ? 'one guardian' : `${k} guardians`} and
          the recipient, acting together.
        </p>
        {k === 1 && you === 'owner' && (
          <p className="small msg-warn">With 1 needed, any one guardian and the recipient could open a message early. Raise the number in Settings.</p>
        )}
      </div>
    </aside>
  );
}

// ─── The owner ──────────────────────────────────────────────────────────────
function Editor({ to, start, onDone }: { to: HeirProfile; start: string; onDone: () => void }) {
  const [text, setText] = useState(start);
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const length = text.trim().length;
  const over = length > MESSAGE_MAX;
  const seal = async () => {
    setBusy(true);
    const wrong = await demo.sealMessage(to.id, text);
    setBusy(false);
    if (wrong) setProblem(wrong);
    else onDone();
  };
  return (
    <div className="stack-12">
      <label className="field-label">
        Your message for {to.name}
        <textarea
          className="field msg-text" value={text} rows={8} aria-invalid={over || undefined}
          placeholder={`Write to ${to.name}. Only ${to.name} will ever read this.`}
          onChange={(e) => { setText(e.target.value); setProblem(undefined); }}
        />
      </label>
      <div className="msg-under">
        <span className="small muted">
          Or start from an example:{' '}
          {MESSAGE_EXAMPLES.map((x, i) => (
            <span key={x.label}>
              <button type="button" className="linkish" onClick={() => { setText(x.text(to.name)); setProblem(undefined); }}>{x.label.toLowerCase()}</button>
              {i < MESSAGE_EXAMPLES.length - 1 && ', '}
            </span>
          ))}
        </span>
        <span className={`small mono ${over ? 'msg-over' : 'muted'}`}>{length.toLocaleString()} / {MESSAGE_MAX.toLocaleString()}</span>
      </div>
      {problem && <p className="err-inline" role="alert">{problem}</p>}
      <div className="btn-row">
        <button type="button" className="btn btn-primary" disabled={busy || length === 0 || over} onClick={() => void seal()}>
          Seal for {to.name}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>Cancel</button>
        <span className="small muted">Sealed on this device. Nothing is sent to the chain.</span>
      </div>
    </div>
  );
}

function OwnerMessages({ s }: { s: Snapshot }) {
  const [editing, setEditing] = useState<HeirProfile['id']>();
  const [problem, setProblem] = useState<string>();
  const released = s.phase === Phase.released;
  return (
    <div className="messages">
      <div className="owner-head">
        <div className="stack-12">
          <h1 className="disp h-sm">Sealed messages</h1>
          <p className="lede">
            Write to one person: a letter, the recovery phrase of a wallet you keep outside this vault, or documents
            that must come out if you cannot publish them yourself. It is locked on this device and opens only after
            your vault releases, and only for them.
          </p>
        </div>
      </div>
      <div className="split">
        <div className="split-main msg-main">
          {released && <p className="savings-note">Your vault has released, so messages can no longer be sealed or changed.</p>}
          {problem && <p className="err-inline" role="alert">{problem}</p>}
          <ul className="msg-list">
            {HEIRS.map((h) => {
              const m = s.messages.find((x) => x.to === h.id);
              const stage = m && messageStage(s, m);
              return (
                <li key={h.id} className="card msg-row">
                  <div className="msg-row-head">
                    <div className="stack-6">
                      <h2 className="msg-name">{h.name} <span className="muted">· {h.relation}</span></h2>
                      <span className="small muted">
                        {!m ? 'Nothing sealed'
                          : stage === 'opened' ? `Opened by ${h.name} on ${fmtDate(m.opened!.at)}`
                          : `Sealed on ${fmtDate(m.sealedAt)} · ${m.text.length.toLocaleString()} characters · ${STAGE_WORDS[stage!]}`}
                      </span>
                    </div>
                    {editing !== h.id && !released && (
                      <div className="btn-row">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditing(h.id); setProblem(undefined); }}>
                          {m ? 'Read or change' : `Write to ${h.name}`}
                        </button>
                        {m && (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setProblem(demo.removeMessage(h.id))}>Remove</button>
                        )}
                      </div>
                    )}
                  </div>
                  {editing === h.id && !released && <Editor to={h} start={m?.text ?? ''} onDone={() => setEditing(undefined)} />}
                  {m && editing !== h.id && (
                    <span className="small muted">
                      {m.holders.length === 1
                        ? `${guardianById(m.holders[0]).name} holds the guardians' half of its key.`
                        : `${list(m.holders.map((id) => guardianById(id).name))} each hold a piece of its key. Any ${m.needed} of them open it, together with ${h.name}.`}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <details className="disclose">
            <summary>Can I take a message back?</summary>
            <p>
              While your vault is armed you can change or remove a message. The message is sealed again under a new key
              and your guardians' apps replace their pieces. That relies on their apps: someone who kept a copy of an
              old piece, and a recipient who kept the old sealed text, could still open the old message after a release.
            </p>
          </details>
        </div>
        <LockPanel s={s} you="owner" />
      </div>
    </div>
  );
}

// ─── The recipient ──────────────────────────────────────────────────────────
function RecipientMessage({ s, id }: { s: Snapshot; id: HeirProfile['id'] }) {
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const me = personById(id);
  const m = s.messages.find((x) => x.to === id);
  if (!m) {
    return (
      <div className="narrow stack-18">
        <h1 className="disp h-sm">No sealed message on this device.</h1>
        <p className="lede">
          {me.name}, if {OWNER_FIRST} seals a message for you, it arrives here locked. The chain cannot tell you
          whether one exists, and it cannot tell anyone else either: only the devices involved know.
        </p>
        <div><button type="button" className="btn btn-secondary" onClick={() => demo.setActor({ kind: 'owner' })}>Act as {OWNER_FIRST} to write one</button></div>
      </div>
    );
  }
  const stage = messageStage(s, m);
  const waiting = m.holders.filter((g) => !m.handed.includes(g));
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
            {stage === 'sealed' && `It stays shut while her vault is armed. You hold the sealed text and half of its key. The other half is in pieces with her guardians, who hand them over once the vault releases.`}
            {stage === 'collecting' && `Her vault has released. The guardians can now hand over their pieces of the key: ${m.needed === 1 ? 'one is' : `${m.needed} are`} needed.`}
            {stage === 'ready' && 'Enough pieces have arrived. Together with the half you already hold, they rebuild the key on this device.'}
            {stage === 'opened' && `Opened on ${fmtDate(m.opened!.at)}, on this device. Nobody else has read it, and the chain has no record that it exists.`}
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
                {stage === 'collecting' && 'Pieces arrive as guardians hand them over. Each one is checked on arrival, so a wrong piece is caught.'}
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
  const released = s.phase === Phase.released;
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
                  {mine.length === 1 ? 'It went' : 'Each went'} to the person the message is for, and to nobody else. There is nothing more to do.
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
              <button type="button" className="btn btn-primary btn-lg" onClick={() => setProblem(demo.handOverPieces(id))}>
                {left.length === 1 ? 'Hand over my piece' : `Hand over my ${left.length} pieces`}
              </button>
              {problem && <p className="err-inline" role="alert">{problem}</p>}
              <p className="small muted">
                {released
                  ? `The vault has released, so this is the moment ${OWNER_FIRST} asked you to wait for.`
                  : `Your app reads the vault from the chain before it sends anything, and it will refuse now. Try it.`}
              </p>
            </section>
          )}
          <section className="card pad-24 stack-16">
            <h2 className="disp h-card">What {OWNER_FIRST} asked of you</h2>
            <ol className="numbered">
              <li><span className="mono">1</span><span><strong>Keep the piece.</strong> It sits on this device. It is not a copy of the message and it is not the key.</span></li>
              <li><span className="mono">2</span><span><strong>Wait for the vault.</strong> When it says released, hand the piece over. Until then, do nothing, whoever asks.</span></li>
              <li><span className="mono">3</span><span><strong>That is all.</strong> {k === 1 ? 'Your piece alone completes the key' : `It takes ${k} guardians' pieces to complete the key`}, and even then only the recipient can read the message.</span></li>
            </ol>
          </section>
        </div>
        <LockPanel s={s} you="guardian" />
      </div>
    </div>
  );
}

// ─── Anyone else ────────────────────────────────────────────────────────────
function StrangerMessages({ s }: { s: Snapshot }) {
  return (
    <div className="messages">
      <div className="owner-head">
        <div className="stack-12">
          <h1 className="disp h-sm">Nothing here for a stranger.</h1>
          <p className="lede">
            {OWNER_FIRST} may have sealed messages, or none. The chain has no record either way. The one thing a sealed
            message takes from the chain is the vault's state, which is already public: armed, pending or released.
          </p>
        </div>
      </div>
      <div className="split">
        <div className="split-main msg-main">
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={() => demo.setActor({ kind: 'owner' })}>Act as {OWNER_FIRST}</button>
            <span className="small muted">to seal a message and follow it through.</span>
          </div>
        </div>
        <LockPanel s={s} you="stranger" />
      </div>
    </div>
  );
}

export function MessagesView({ s }: { s: Snapshot }) {
  // Each person's screen keeps its own state, so switching people starts it fresh.
  if (s.actor.kind === 'owner') return <OwnerMessages s={s} />;
  if (s.actor.kind === 'heir') return <RecipientMessage key={s.actor.id} s={s} id={s.actor.id} />;
  if (s.actor.kind === 'guardian') return <GuardianPieces key={s.actor.id} s={s} id={s.actor.id} />;
  return <StrangerMessages s={s} />;
}
