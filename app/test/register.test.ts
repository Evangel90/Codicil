// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The seal register in the demo: a message delivered through it, and a public
// disclosure for everyone. Every step here that touches the register runs the
// compiled contract, which calls the compiled vault. The register refuses
// every piece until the vault has released, and then only takes genuine ones.

import { beforeEach, describe, expect, it } from 'vitest';
import { CHALLENGE, DAY, defaultSetup, demo } from '../src/demo/store.js';
import { createDemoPasskey } from '../src/demo/passkey.js';
import { messagesNext, messageStage, signal } from '../src/demo/guide.js';
import { commands, filterCommands } from '../src/demo/commands.js';

const s = () => demo.getSnapshot();
const msg = (to = 'everyone') => s().messages.find((m) => m.to === to)!;
const DISCLOSURE = 'If you are reading this, I could not publish it myself. The ledger is in the folder: files.example/d/7f3a91';
const LETTER = 'Ben, the workshop keys are with Sarah Lin.';

async function ok(p: Promise<boolean>) {
  expect(await p, s().tx?.message).toBe(true);
  const message = s().tx!.message!;
  demo.dismissTx();
  return message;
}

/** Runs an action the contract should refuse; returns its code and the words shown. */
async function refused(p: Promise<boolean>) {
  expect(await p).toBe(false);
  const { code, message } = s().tx!;
  demo.dismissTx();
  return { code, message };
}

async function seal(to: Parameters<typeof demo.sealMessage>[0], text: string, via?: Parameters<typeof demo.sealMessage>[2]) {
  expect(await demo.sealMessage(to, text, via)).toBeUndefined();
  expect(s().tx, s().tx?.message).toMatchObject({ status: 'done' });
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

/** Everything public: the vault's ledger, the register's ledger, and what each action published. */
const publicText = () => JSON.stringify([s().chain, s().register, s().activity.map((a) => a.published), s().events], (k, v) => (
  k === 'statement' || k === 'lastAttempt' ? undefined : typeof v === 'bigint' ? v.toString() : v));

beforeEach(async () => {
  demo.stageDelayMs = 0;
  demo.reset();
  await demo.setUp(createDemoPasskey());
});

describe('the register beside the vault', () => {
  it('is deployed with the vault, fixed to it, and empty', () => {
    const r = s().register;
    expect(r.address).toMatch(/^[0-9a-f]{64}$/);
    expect(r.vault).toBe(s().chain.address);
    expect(r).toMatchObject({ seals: [], pieceChecks: 0, handedOver: [], statementFingerprint: '0'.repeat(64) });
    expect(r.keeperCommit).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('proving whose register it is', () => {
  it('holds the vault\'s own owner commitment from the start, put there by the owner\'s proof', () => {
    const r = s().register;
    expect(r.provesOwner).toBe(true);
    expect(r.ownerCommit).toBe(s().chain.ownerPasskeyCommit);
  });

  it('stops proving it when the owner\'s key changes, until the owner proves it again', async () => {
    demo.reset();
    const key = demo.draftRecoveryKey();
    await demo.setUp(createDemoPasskey(), { ...defaultSetup(), recoveryDelay: 3 * DAY });
    expect(s().register.provesOwner).toBe(true);
    const before = s().chain.ownerPasskeyCommit;

    await ok(demo.startRecovery(key));
    demo.advanceTo(s().recovery.readyAt);
    await ok(demo.finishRecovery('Someone'));
    // The vault has a new owner commitment; the register still holds the old one.
    expect(s().chain.ownerPasskeyCommit).not.toBe(before);
    expect(s().register.ownerCommit).toBe(before);
    expect(s().register.provesOwner).toBe(false);

    expect(await ok(demo.proveRegister())).toMatch(/^The register now holds the same owner commitment as your vault\./);
    expect(s().register.ownerCommit).toBe(s().chain.ownerPasskeyCommit);
    expect(s().register.provesOwner).toBe(true);
    expect(s().activity[0].published).toEqual(['The same owner commitment the vault holds, now on the register too']);
  });
});

describe('a public disclosure', () => {
  it('is sealed in a transaction that records a fingerprint and commitments, and nothing else', async () => {
    const said = await seal('everyone', DISCLOSURE);
    expect(said).toMatch(/^Sealed for everyone\. The register now holds its fingerprint/);
    const m = msg();
    expect(m).toMatchObject({ to: 'everyone', via: 'register', needed: 2, holders: [0, 1, 2], handed: [] });
    expect(m.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(s().register.seals).toEqual([{ fingerprint: m.fingerprint, needed: 2, pieces: 3, sealedBefore: m.sealedBefore }]);
    expect(m.sealedBefore).toBeGreaterThan(s().now);
    expect(s().register.pieceChecks).toBe(3);
    expect(publicText()).not.toMatch(/publish it myself|files\.example/);
    expect(s().activity[0]).toMatchObject({ what: 'Public disclosure sealed' });
    expect(s().activity[0].published).toHaveLength(3);
  });

  it('a seal that could not run says so, and nothing is kept', async () => {
    demo.stageDelayMs = 30;
    const checkIn = demo.checkIn();
    expect(await demo.sealMessage('everyone', DISCLOSURE)).toBe('Another transaction is still running. Try again when it has finished.');
    await ok(checkIn);
    expect(s().messages).toEqual([]);
    expect(s().register.seals).toEqual([]);
  });

  it('must go through the register', async () => {
    expect(await demo.sealMessage('everyone', DISCLOSURE, 'hand')).toMatch(/goes through the register/);
    expect(s().messages).toEqual([]);
  });

  it('before the release the contract refuses every piece, genuine or made up', async () => {
    await seal('everyone', DISCLOSURE);
    expect(await refused(demo.publishPieces(0))).toMatchObject({ code: 'vault not released', message: expect.stringMatching(/^The register asked the vault/) });
    expect(s().register.lastAttempt).toMatchObject({ ok: false, code: 'vault not released', by: 'Dr. Mensah' });
    expect(await refused(demo.plantPiece('everyone'))).toMatchObject({ code: 'vault not released' });
    expect(s().register.handedOver).toEqual([]);
    expect(await demo.openMessage('everyone')).toBe('It is still locked. It needs 2 guardian pieces and none is on the register.');
    expect(messagesNext(s()).text).toMatch(/^Sealed, and shut until the vault releases\. /);
  });

  it('after the release, guardians publish pieces through the register and anyone opens it from the ledger', async () => {
    await seal('everyone', DISCLOSURE);
    await release();
    expect(messageStage(s(), msg())).toBe('collecting');
    expect(messagesNext(s()).text).toMatch(/2 more are needed before anyone can open the disclosure\.$/);

    expect(await ok(demo.publishPieces(2))).toMatch(/^The register checked your piece and published it\./);
    expect(s().register.lastAttempt).toMatchObject({
      ok: true, calls: [{ contract: 'vault', circuit: 'isReleasedForContract' }, { contract: 'register', circuit: 'handOver' }],
    });
    expect(msg().handed).toEqual([2]);
    expect(await demo.openMessage('everyone')).toBe('It is still locked. It needs 2 guardian pieces and one is on the register.');

    await ok(demo.publishPieces(0));
    expect(msg().handed).toEqual([0, 2]);
    expect(s().register.handedOver.map((p) => [p.seal, p.x])).toEqual([[msg().fingerprint, 1], [msg().fingerprint, 3]]);
    expect(messagesNext(s())).toMatchObject({ who: [{ kind: 'public' }], text: 'Enough pieces are on the register. Anyone can open the disclosure now.' });

    expect(await demo.openMessage('everyone')).toBeUndefined();
    expect(msg().opened).toMatchObject({ text: DISCLOSURE });
    expect(messagesNext(s())).toMatchObject({ tone: 'done' });
    // The words were never on the chain; the pieces are.
    expect(publicText()).not.toMatch(/publish it myself|files\.example/);
  });

  it('a made-up piece is refused after the release too, by the commitment check', async () => {
    await seal('everyone', DISCLOSURE);
    await release();
    expect(await refused(demo.plantPiece('everyone', { kind: 'public' }))).toMatchObject({
      code: 'not a genuine piece', message: expect.stringMatching(/matches none of them/),
    });
    expect(s().register.lastAttempt).toMatchObject({ ok: false, code: 'not a genuine piece', by: 'Someone' });
    expect(s().register.handedOver).toEqual([]);
  });

  it('a guardian who has handed over has nothing left to send', async () => {
    await seal('everyone', DISCLOSURE);
    await release();
    await ok(demo.publishPieces(1));
    expect(await refused(demo.publishPieces(1))).toMatchObject({ message: 'This device holds no piece that is still to be handed over.' });
    expect(s().register.handedOver).toHaveLength(1);
  });

  it('can be replaced or taken back while the vault is armed, and the register follows', async () => {
    await seal('everyone', DISCLOSURE);
    const first = msg().fingerprint;
    await seal('everyone', 'A second draft.');
    expect(msg().fingerprint).not.toBe(first);
    expect(s().register.seals.map((x) => x.fingerprint)).toEqual([msg().fingerprint]);
    expect(s().activity[0].what).toBe('Public disclosure replaced');

    expect(await demo.removeMessage('everyone')).toBeUndefined();
    expect(s().tx).toMatchObject({ status: 'done' });
    demo.dismissTx();
    expect(s().messages).toEqual([]);
    expect(s().register.seals).toEqual([]);
    expect(await demo.removeMessage('everyone')).toBe('There is no public disclosure to take back.');
  });

  it('cannot be changed or taken back once the vault has released', async () => {
    await seal('everyone', DISCLOSURE);
    await release();
    const closed = 'Your vault has released, so messages can no longer be sealed or changed.';
    expect(await demo.sealMessage('everyone', 'Changed my mind.')).toBe(closed);
    expect(await demo.removeMessage('everyone')).toBe(closed);
    expect(s().register.seals).toHaveLength(1);
  });
});

describe('checking a copy of a sealed text against the chain', () => {
  it('a true copy matches its seal, and one changed character does not', async () => {
    await seal('everyone', DISCLOSURE);
    const copy = msg().sealedText;
    expect(copy).not.toMatch(/publish it myself/);
    expect(demo.checkSealedCopy(`  ${copy}\n`)).toEqual({ ok: true, fingerprint: msg().fingerprint, sealedBefore: msg().sealedBefore, needed: 2, pieces: 3 });
    const at = copy.indexOf('"ciphertext":"') + 14;
    const changed = copy.slice(0, at) + (copy[at] === '0' ? '1' : '0') + copy.slice(at + 1);
    expect(demo.checkSealedCopy(changed)).toMatchObject({ ok: false, why: expect.stringMatching(/the register holds no seal with that fingerprint/) });
    expect(demo.checkSealedCopy('hello')).toMatchObject({ ok: false, why: expect.stringMatching(/^This is not a sealed text\. Paste the whole sealed text/) });
  });

  it('a message sealed by hand is not on the register, so its copy matches nothing', async () => {
    await demo.sealMessage('ada', 'By hand.');
    expect(demo.checkSealedCopy(msg('ada').sealedText)).toMatchObject({ ok: false });
  });
});

describe('a private message through the register', () => {
  it('leaves a fingerprint on the chain and nothing about who it is for', async () => {
    expect(await seal('ben', LETTER, 'register')).toMatch(/^Sealed for Ben\. The register holds a fingerprint and nothing that says who it is for\./);
    expect(msg('ben')).toMatchObject({ via: 'register', handed: [] });
    expect(s().register.seals).toHaveLength(1);
    expect(publicText()).not.toMatch(/Ben|workshop|Sarah/);
  });

  it('opens only for the recipient, from pieces anyone can read', async () => {
    await seal('ben', LETTER, 'register');
    await release();
    // A guardian's by-hand button has nothing to do: this message does not travel by hand.
    expect(demo.handOverPieces(0)).toBe('This device holds no piece to hand over.');
    await ok(demo.publishPieces(0));
    await ok(demo.publishPieces(1));
    expect(msg('ben').handed).toEqual([0, 1]);
    expect(await demo.openMessage('ben')).toBeUndefined();
    expect(msg('ben').opened!.text).toBe(LETTER);
    // The pieces are public, the words are not, and nothing names the reader.
    expect(s().register.handedOver).toHaveLength(2);
    expect(publicText()).not.toMatch(/Ben|workshop|Sarah/);
  });

  it('one guardian publishes the pieces of every message at once', async () => {
    await seal('ben', LETTER, 'register');
    await seal('everyone', DISCLOSURE);
    await demo.sealMessage('ada', 'By hand.');
    await release();
    expect(await ok(demo.publishPieces(0))).toMatch(/your 2 pieces/);
    expect(s().register.handedOver).toHaveLength(2);
    expect(msg('ada').handed).toEqual([]);
    expect(demo.handOverPieces(0)).toBeUndefined();
    expect(msg('ada').handed).toEqual([0]);
  });

  it('switching a message from the register to by hand removes its seal', async () => {
    await seal('ben', LETTER, 'register');
    await seal('ben', LETTER, 'hand');
    expect(msg('ben')).toMatchObject({ via: 'hand', fingerprint: undefined });
    expect(s().register.seals).toEqual([]);
  });
});

describe('when the guardians change', () => {
  it('a sealed disclosure is sealed again and the register holds only the new seal', async () => {
    await seal('everyone', DISCLOSURE);
    const before = msg().fingerprint;
    await ok(demo.updateSettings({ guardians: [0, 1, 3], threshold: 2, attestor: false }));
    expect(msg()).toMatchObject({ holders: [0, 1, 3], needed: 2 });
    expect(msg().fingerprint).not.toBe(before);
    expect(s().register.seals.map((x) => x.fingerprint)).toEqual([msg().fingerprint]);
    // The removed guardian's old piece opens nothing through the register.
    await release();
    expect(await refused(demo.publishPieces(2))).toMatchObject({ message: 'This device holds no piece that is still to be handed over.' });
  });
});

describe('the vault read as a signal', () => {
  it('says checking in, then silent, then released, from the public ledger alone', async () => {
    expect(signal(s())).toMatchObject({ state: 'checkingIn', title: 'Still checking in' });
    demo.advanceTo(s().deadline);
    expect(signal(s())).toMatchObject({ state: 'silent', title: 'Gone silent', detail: expect.stringMatching(/Anyone can start the countdown now\.$/) });
    await ok(demo.startCountdown('Someone'));
    expect(signal(s())).toMatchObject({ state: 'silent', detail: expect.stringMatching(/the countdown is running/) });
    await ok(demo.checkIn());
    expect(signal(s()).state).toBe('checkingIn');
    await release();
    expect(signal(s())).toMatchObject({ state: 'released', title: 'Released' });
  });
});

describe('a public statement', () => {
  it('puts only a fingerprint on the register, and the page can be checked against it', async () => {
    const text = 'As of today we have received no secret order to hand over data.';
    await ok(demo.setStatement(text));
    const r = s().register;
    expect(r.statement).toMatchObject({ text, genuine: true });
    expect(r.statementFingerprint).not.toBe('0'.repeat(64));
    expect(publicText()).not.toMatch(/secret order/);
    expect(await refused(demo.setStatement('   '))).toMatchObject({ message: 'Write the statement first.' });
  });
});

describe('the command palette', () => {
  const labels = (q: string) => filterCommands(commands(s(), { setTab: () => {}, reset: () => {}, toggleTheme: () => {}, downloadReminders: () => {} }), q).map((c) => c.label);

  it('offers the next step of a disclosure once the vault has released', async () => {
    await seal('everyone', DISCLOSURE);
    await release();
    expect(labels('hand over')).toContain('Hand over a piece of the key as Dr. Mensah');
    await ok(demo.publishPieces(0));
    await ok(demo.publishPieces(1));
    expect(labels('disclosure')).toContain('Open the public disclosure');
  });
});
