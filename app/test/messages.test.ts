// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Sealed messages in the demo: sealed on the owner's device, shut until the
// vault releases, opened by the one person they are for. The encryption and
// the key splitting are real; the vault that gives the signal is the compiled
// contract. None of these actions is a transaction.

import { beforeEach, describe, expect, it } from 'vitest';
import { Phase } from '@codicil/contracts/vault';
import { CHALLENGE, demo, MESSAGE_MAX } from '../src/demo/store.js';
import { createDemoPasskey } from '../src/demo/passkey.js';
import { messagesNext, messageStage } from '../src/demo/guide.js';
import { commands, filterCommands } from '../src/demo/commands.js';

const s = () => demo.getSnapshot();
const msg = (to = 'ada') => s().messages.find((m) => m.to === to)!;
const LETTER = 'Ada, the recovery phrase for my other wallet is in the blue notebook.';

async function ok(p: Promise<boolean>) {
  expect(await p, s().tx?.message).toBe(true);
  const message = s().tx!.message!;
  demo.dismissTx();
  return message;
}

async function release() {
  demo.advanceTo(s().deadline);
  await ok(demo.startCountdown('Someone'));
  demo.advance(CHALLENGE);
  await ok(demo.release('Someone'));
}

/** Everything the chain holds or has been told, as text to search. */
const chainText = () => JSON.stringify([s().chain, s().activity.map((a) => a.published), s().events], (_, v) => (typeof v === 'bigint' ? v.toString() : v));

beforeEach(async () => {
  demo.stageDelayMs = 0;
  demo.reset();
  await demo.setUp(createDemoPasskey());
});

describe('sealing a message', () => {
  it('starts with none, and the guide invites the owner to write one', () => {
    expect(s().messages).toEqual([]);
    expect(messagesNext(s())).toMatchObject({ tone: 'attention', who: [{ kind: 'owner' }] });
  });

  it('gives every guardian a piece and needs as many as the vault needs votes', async () => {
    expect(await demo.sealMessage('ada', LETTER)).toBeUndefined();
    expect(msg()).toMatchObject({ to: 'ada', text: LETTER, needed: 2, holders: [0, 1, 2], handed: [], opened: undefined });
    expect(messageStage(s(), msg())).toBe('sealed');
    expect(s().toast).toMatchObject({ title: 'Sealed for Ada', body: 'Each of your 3 guardians holds a piece of the key. 2 of them are needed.' });
  });

  it('what the recipient holds is not the message', async () => {
    await demo.sealMessage('ada', 'blue notebook '.repeat(30));
    expect(msg().bytes).toBe('blue notebook '.repeat(30).trim().length + 16);   // the text plus the seal's check value
    expect(msg().sealedStart).toMatch(/^[0-9a-f]{48}$/);
    expect(Buffer.from(msg().sealedStart, 'hex').toString('latin1')).not.toContain('blue');
  });

  it('is not a transaction: the chain and its counters do not change', async () => {
    const before = { nonce: s().nonce, chain: s().chain };
    await demo.sealMessage('ada', LETTER);
    expect({ nonce: s().nonce, chain: s().chain }).toEqual(before);
    expect(s().tx).toBeUndefined();
    expect(s().activity[0]).toMatchObject({ what: 'Message sealed for Ada', published: [] });
    expect(chainText()).not.toMatch(/Ada|message|notebook/i);
  });

  it('refuses an empty message and one that is too long, in words', async () => {
    expect(await demo.sealMessage('ada', '   \n ')).toBe('Write the message first.');
    expect(await demo.sealMessage('ada', 'x'.repeat(MESSAGE_MAX + 1))).toBe('That is 2,001 characters. The demo seals up to 2,000.');
    expect(s().messages).toEqual([]);
    expect(await demo.sealMessage('ada', 'x'.repeat(MESSAGE_MAX))).toBeUndefined();
  });

  it('a second message for the same person replaces the first, under a new key', async () => {
    await demo.sealMessage('ada', LETTER);
    const first = msg().sealedStart;
    await demo.sealMessage('ada', 'Changed my mind.');
    expect(s().messages).toHaveLength(1);
    expect(msg().text).toBe('Changed my mind.');
    expect(msg().sealedStart).not.toBe(first);
    expect(s().activity[0].what).toBe('Sealed message for Ada replaced');
  });

  it('can be removed while the vault is armed', async () => {
    await demo.sealMessage('ada', LETTER);
    expect(demo.removeMessage('ada')).toBeUndefined();
    expect(s().messages).toEqual([]);
    expect(demo.removeMessage('ada')).toBe('There is no sealed message for that person.');
  });

  it('several people can each have their own', async () => {
    await demo.sealMessage('cleo', 'For Cleo.');
    await demo.sealMessage('ada', 'For Ada.');
    expect(s().messages.map((m) => m.to)).toEqual(['ada', 'cleo']);   // the order of the cast, not of sealing
  });
});

describe('while the vault has not released', () => {
  beforeEach(async () => { await demo.sealMessage('ada', LETTER); });

  it('a guardian\'s app keeps the piece', async () => {
    expect(demo.handOverPieces(0)).toBe('The vault has not released, so your piece stays on this device. Nothing was sent.');
    expect(msg().handed).toEqual([]);
    // Pending is not released either.
    demo.advanceTo(s().deadline);
    await ok(demo.startCountdown('Someone'));
    expect(s().phase).toBe(Phase.pending);
    expect(demo.handOverPieces(0)).toMatch(/has not released/);
    expect(msg().handed).toEqual([]);
  });

  it('the recipient cannot open it with their half alone', async () => {
    expect(await demo.openMessage('ada')).toBe('It is still locked. It needs 2 guardian pieces and none has arrived.');
    expect(msg().opened).toBeUndefined();
  });

  it('the guide says it is shut and hands back to the vault\'s own story', () => {
    expect(messagesNext(s()).text).toMatch(/^Sealed, and shut until the vault releases\. /);
  });

  it('someone with no message, or no piece, is told so', async () => {
    expect(await demo.openMessage('ben')).toBe('This device holds no sealed message.');
    expect(demo.handOverPieces(4)).toBe('This device holds no piece to hand over.');
  });
});

describe('after the vault releases', () => {
  beforeEach(async () => {
    await demo.sealMessage('ada', LETTER);
    await release();
  });

  it('opens once enough guardians have handed over their pieces, and not before', async () => {
    expect(messageStage(s(), msg())).toBe('collecting');
    expect(messagesNext(s())).toMatchObject({ who: [{ kind: 'guardian', id: 0 }, { kind: 'guardian', id: 1 }, { kind: 'guardian', id: 2 }] });
    expect(messagesNext(s()).text).toMatch(/2 more are needed before Ada can open the message\.$/);

    expect(demo.handOverPieces(2)).toBeUndefined();
    expect(msg().handed).toEqual([2]);
    expect(await demo.openMessage('ada')).toBe('It is still locked. It needs 2 guardian pieces and one has arrived.');
    expect(messagesNext(s()).text).toMatch(/One more is needed/);

    expect(demo.handOverPieces(0)).toBeUndefined();
    expect(messageStage(s(), msg())).toBe('ready');
    expect(messagesNext(s())).toMatchObject({ who: [{ kind: 'heir', id: 'ada' }] });

    expect(await demo.openMessage('ada')).toBeUndefined();
    expect(msg().opened).toMatchObject({ text: LETTER, at: s().now });
    expect(messageStage(s(), msg())).toBe('opened');
    expect(messagesNext(s())).toMatchObject({ tone: 'done', who: [] });
  });

  it('any two of the three guardians will do', async () => {
    demo.handOverPieces(1);
    demo.handOverPieces(2);
    expect(await demo.openMessage('ada')).toBeUndefined();
    expect(msg().opened!.text).toBe(LETTER);
  });

  it('a guardian hands over once; a second try has nothing left to send', () => {
    expect(demo.handOverPieces(1)).toBeUndefined();
    expect(demo.handOverPieces(1)).toBe('This device holds no piece to hand over.');
    expect(msg().handed).toEqual([1]);
  });

  it('none of it is on the chain, before or after it is read', async () => {
    const before = { nonce: s().nonce, chain: s().chain };
    demo.handOverPieces(0);
    demo.handOverPieces(1);
    await demo.openMessage('ada');
    expect({ nonce: s().nonce, chain: s().chain }).toEqual(before);
    expect(chainText()).not.toMatch(/Ada|message|notebook|piece/i);
    expect(s().activity.slice(0, 3).map((a) => a.published)).toEqual([[], [], []]);
  });

  it('the owner can no longer seal, change or remove', async () => {
    const closed = 'Your vault has released, so messages can no longer be sealed or changed.';
    expect(await demo.sealMessage('ben', 'Too late.')).toBe(closed);
    expect(await demo.sealMessage('ada', 'Changed.')).toBe(closed);
    expect(demo.removeMessage('ada')).toBe(closed);
    expect(msg().text).toBe(LETTER);
  });

  it('a guardian with pieces for two messages hands both over at once', async () => {
    demo.reset();
    await demo.setUp(createDemoPasskey());
    await demo.sealMessage('ada', 'For Ada.');
    await demo.sealMessage('ben', 'For Ben.');
    await release();
    demo.handOverPieces(0);
    expect(s().toast?.title).toBe('Your 2 pieces are handed over');
    demo.handOverPieces(1);
    expect(await demo.openMessage('ada')).toBeUndefined();
    expect(await demo.openMessage('ben')).toBeUndefined();
    expect([msg('ada').opened!.text, msg('ben').opened!.text]).toEqual(['For Ada.', 'For Ben.']);
  });
});

describe('when the guardians change', () => {
  it('messages are sealed again: the new guardians hold the pieces and the removed one does not', async () => {
    await demo.sealMessage('ada', LETTER);
    const before = msg().sealedStart;
    const message = await ok(demo.updateSettings({ guardians: [0, 1, 3], threshold: 2, attestor: false }));
    expect(message).toMatch(/Your sealed message was sealed again, with a new piece of the key for each guardian\./);
    expect(msg()).toMatchObject({ text: LETTER, holders: [0, 1, 3], needed: 2, handed: [] });
    expect(msg().sealedStart).not.toBe(before);

    await release();
    expect(demo.handOverPieces(2)).toBe('This device holds no piece to hand over.');   // Tomás was removed
    demo.handOverPieces(3);
    demo.handOverPieces(0);
    expect(await demo.openMessage('ada')).toBeUndefined();
    expect(msg().opened!.text).toBe(LETTER);
  });

  it('a new number needed applies to the messages too', async () => {
    await demo.sealMessage('ada', LETTER);
    await ok(demo.updateSettings({ guardians: [0, 1, 2], threshold: 3, attestor: false }));
    expect(msg().needed).toBe(3);
    // Three guardians must now vote, so the timeout releases it here.
    await release();
    demo.handOverPieces(0);
    demo.handOverPieces(1);
    expect(await demo.openMessage('ada')).toMatch(/needs 3 guardian pieces and 2 have arrived/);
    demo.handOverPieces(2);
    expect(await demo.openMessage('ada')).toBeUndefined();
  });

  it('with no message sealed, changing guardians says nothing about messages', async () => {
    const message = await ok(demo.updateSettings({ guardians: [0, 1, 3], threshold: 2, attestor: false }));
    expect(message).not.toMatch(/sealed/);
  });
});

describe('the owner checking in', () => {
  it('cancels a countdown and the message stays shut', async () => {
    await demo.sealMessage('ada', LETTER);
    demo.advanceTo(s().deadline);
    await ok(demo.startCountdown('Someone'));
    await ok(demo.checkIn());
    expect(s().phase).toBe(Phase.armed);
    expect(demo.handOverPieces(0)).toMatch(/has not released/);
    expect(messageStage(s(), msg())).toBe('sealed');
  });
});

describe('the command palette', () => {
  const ctx = { setTab: () => {}, reset: () => {}, toggleTheme: () => {}, downloadReminders: () => {} };
  const labels = (q: string) => filterCommands(commands(s(), ctx), q).map((c) => c.label);

  it('finds the screen by what people would call it', () => {
    for (const q of ['message', 'journalist', 'recovery phrase', 'documents']) expect(labels(q)).toContain('Sealed messages');
  });

  it('offers the next step of a sealed message once the vault has released', async () => {
    await demo.sealMessage('ada', LETTER);
    expect(labels('piece')).not.toContain('Hand over a piece of the key as Dr. Mensah');
    await release();
    expect(labels('piece')).toContain('Hand over a piece of the key as Dr. Mensah');
    demo.handOverPieces(0);
    expect(labels('piece')).toContain('Hand over a piece of the key as Sarah Lin');
    demo.handOverPieces(1);
    expect(labels('sealed message')).toContain('Open the sealed message as Ada');
  });
});
