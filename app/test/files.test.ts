// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Sealed files in the demo (D22): a file is sealed like a message, under its
// own key, and its encrypted body is kept in a store. After the release the
// app rebuilds it by itself. Guardians' apps hand their pieces over by
// themselves, once, and never before the release.

import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '@codicil/sdk';
import { CHALLENGE, demo } from '../src/demo/store.js';
import { createDemoPasskey } from '../src/demo/passkey.js';
import { messageStage } from '../src/demo/guide.js';

const s = () => demo.getSnapshot();
const msg = (to = 'ada') => s().messages.find((m) => m.to === to)!;

/** A small PDF, as bytes. */
function pdf(words = 'Deed of the house'): { name: string; type: string; bytes: Uint8Array } {
  const text = `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${words}\n${'x'.repeat(3000)}\n%%EOF\n`;
  return { name: 'deed.pdf', type: 'application/pdf', bytes: new TextEncoder().encode(text) };
}

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

/** Everything public: the vault's ledger, the register's ledger, and what each action published. */
const publicText = () => JSON.stringify([s().chain, s().register, s().activity.map((a) => a.published), s().events], (k, v) => (
  k === 'statement' || k === 'lastAttempt' ? undefined : typeof v === 'bigint' ? v.toString() : v));

beforeEach(async () => {
  demo.stageDelayMs = 0;
  demo.reset();
  await demo.setUp(createDemoPasskey());
});

describe('sealing a file', () => {
  it('seals a file on its own, by hand, with nothing on the chain', async () => {
    const ledgers = () => JSON.stringify([s().chain, s().register], (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    const chain = ledgers();
    expect(await demo.sealMessage('ada', '', 'hand', { file: pdf() })).toBeUndefined();
    const m = msg();
    expect(m).toMatchObject({ text: '', bytes: 0, needed: 2, holders: [0, 1, 2], handed: [] });
    expect(m.file).toMatchObject({ name: 'deed.pdf', type: 'application/pdf', size: pdf().bytes.length, store: 'memory' });
    // The stored body is padded, so its size says little about the real one.
    expect(m.file!.stored.length).toBeGreaterThanOrEqual(pdf().bytes.length);
    expect(m.file!.fingerprint).toBeUndefined();
    expect(JSON.parse(m.file!.pointerText)).toMatchObject({ codicil: 'sealed-file' });
    expect(m.file!.pointerText).not.toContain('Deed');
    expect(s().toast?.body).toMatch(/encrypted file is kept in this page's store/);
    expect(ledgers()).toBe(chain);
    expect(s().activity[0].published).toEqual([]);
    expect(s().register.seals).toEqual([]);
  });

  it('seals words and a file together, each under its own key, on the register', async () => {
    expect(await demo.sealMessage('everyone', 'The papers are attached.', 'register', { file: pdf() })).toBeUndefined();
    expect(s().tx?.status).toBe('done');
    demo.dismissTx();
    const m = msg('everyone');
    expect(m.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(m.file!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(m.file!.fingerprint).not.toBe(m.fingerprint);
    expect(s().register.seals.map((x) => x.fingerprint).sort()).toEqual([m.fingerprint, m.file!.fingerprint].sort());
    expect(s().register.pieceChecks).toBe(6);
    expect(publicText()).not.toMatch(/deed|Deed|papers are attached/);
  });

  it('keeps the file when only the words change, and drops it when asked', async () => {
    await demo.sealMessage('ada', 'First words', 'hand', { file: pdf() });
    await demo.sealMessage('ada', 'Second words');
    expect(msg()).toMatchObject({ text: 'Second words', file: { name: 'deed.pdf' } });
    await demo.sealMessage('ada', 'Third words', 'hand', { file: null });
    expect(msg().file).toBeUndefined();
  });

  it('refuses an empty file and one that is too large, in words', async () => {
    expect(await demo.sealMessage('ada', '', 'hand', { file: { name: 'a.pdf', type: 'application/pdf', bytes: new Uint8Array(0) } }))
      .toBe('That file is empty. Choose another one.');
    expect(await demo.sealMessage('ada', '', 'hand', { file: { name: 'a.pdf', type: 'application/pdf', bytes: new Uint8Array(MAX_FILE_BYTES + 1) } }))
      .toBe('That file is 25.0 MB. A sealed file can be up to 25 MB.');
    expect(await demo.sealMessage('ada', '   ')).toBe('Write the message or attach a file first.');
    expect(s().messages).toEqual([]);
  });

  it('is sealed again for new guardians', async () => {
    await demo.sealMessage('ada', '', 'hand', { file: pdf() });
    const first = msg().file!.stored.id;
    await ok(demo.updateSettings({ guardians: [0, 1, 3], threshold: 2, attestor: false }));
    expect(msg().file!.stored.id).not.toBe(first);
    expect(msg().holders).toEqual([0, 1, 3]);
  });
});

describe('opening a file', () => {
  it('is refused before the release, and says why', async () => {
    await demo.sealMessage('ada', '', 'hand', { file: pdf() });
    expect(await demo.openFile('ada')).toMatch(/^It cannot be opened yet\. The vault has not released/);
    expect(await demo.openMessage('ada')).toMatch(/^It cannot be opened yet/);
    expect(msg().file!.opened).toBeUndefined();
  });

  it('opens after the release with the bytes intact, by hand', async () => {
    const file = pdf();
    await demo.sealMessage('ada', '', 'hand', { file });
    await release();
    demo.handOverPieces(0);
    expect(await demo.openFile('ada')).toBe('It is still locked. It needs 2 guardian pieces and one has arrived. The file opens as soon as enough are in.');
    demo.handOverPieces(2);
    expect(await demo.openFile('ada')).toBeUndefined();
    const opened = msg().file!.opened!;
    expect(opened).toMatchObject({ name: 'deed.pdf', type: 'application/pdf' });
    expect([...opened.bytes]).toEqual([...file.bytes]);
    expect(opened.steps).toHaveLength(5);
    expect(opened.steps[0]).toBe('Collected the 2 pieces of its key the guardians handed over');
    // A file on its own counts as the whole message.
    expect(messageStage(s(), msg())).toBe('opened');
  });

  it('opens a public file from the pieces on the register, with its words', async () => {
    const file = pdf('Ledger of payments');
    expect(await demo.sealMessage('everyone', 'Read the ledger.', 'register', { file })).toBeUndefined();
    demo.dismissTx();
    await release();
    await ok(demo.publishPieces(0));
    await ok(demo.publishPieces(1));
    expect(msg('everyone').handed).toEqual([0, 1]);
    expect(await demo.openMessage('everyone')).toBeUndefined();
    const m = msg('everyone');
    expect(m.opened?.text).toBe('Read the ledger.');
    expect([...m.file!.opened!.bytes]).toEqual([...file.bytes]);
    expect(m.file!.opened!.steps[0]).toBe("Collected 2 pieces of its key from the register's public ledger");
    expect(s().register.handedOver).toHaveLength(4);
  });

  it('catches a damaged copy in the store, and does not open it', async () => {
    await demo.sealMessage('ada', '', 'hand', { file: pdf() });
    await release();
    demo.handOverPieces(0);
    demo.handOverPieces(1);
    expect(demo.damageStoredFile('ada')).toBe(true);
    expect(await demo.openFile('ada')).toBe('The stored copy of the file is not the one that was sealed: it was changed or damaged. It was not opened.');
    expect(msg().file!.opened).toBeUndefined();
  });
});

describe("a guardian's app hands over by itself", () => {
  it('does nothing before the release', async () => {
    await demo.sealMessage('ada', '', 'hand', { file: pdf() });
    expect(await demo.autoHandOver(0)).toBe(false);
    expect(msg().handed).toEqual([]);
    expect(s().tx).toBeUndefined();
  });

  it('hands over by hand once, after the release', async () => {
    await demo.sealMessage('ada', 'A letter', 'hand', { file: pdf() });
    await release();
    expect(await demo.autoHandOver(0)).toBe(true);
    expect(msg().handed).toEqual([0]);
    expect(s().toast?.title).toBe('Your app handed over your 2 pieces by itself');
    expect(await demo.autoHandOver(0)).toBe(false);
    expect(demo.handOverPieces(0)).toBe('This device holds no piece to hand over.');
  });

  it('hands over through the register in the transaction sheet, once', async () => {
    expect(await demo.sealMessage('everyone', '', 'register', { file: pdf() })).toBeUndefined();
    demo.dismissTx();
    await release();
    expect(await demo.autoHandOver(1)).toBe(true);
    expect(s().tx).toMatchObject({ status: 'done', title: 'Your app is handing over your pieces by itself' });
    expect(s().tx!.message).toMatch(/^Your app saw that the vault has released and handed over by itself/);
    demo.dismissTx();
    expect(s().register.handedOver).toHaveLength(1);
    expect(await demo.autoHandOver(1)).toBe(false);
    expect(s().tx).toBeUndefined();
    expect(s().register.handedOver).toHaveLength(1);
    // The manual button still works for what is left, and finds nothing to repeat.
    expect(await demo.publishPieces(1)).toBe(false);
    expect(s().tx?.message).toMatch(/no piece that is still to be handed over/);
    demo.dismissTx();
    await ok(demo.publishPieces(2));
    expect(await demo.openFile('everyone')).toBeUndefined();
  });

  it('waits while another transaction is on screen', async () => {
    expect(await demo.sealMessage('everyone', '', 'register', { file: pdf() })).toBeUndefined();
    demo.dismissTx();
    demo.advanceTo(s().deadline);
    await ok(demo.startCountdown('Someone'));
    demo.advance(CHALLENGE);
    expect(await demo.release('Someone')).toBe(true);
    // The release sheet is still open.
    expect(await demo.autoHandOver(0)).toBe(false);
    demo.dismissTx();
    expect(await demo.autoHandOver(0)).toBe(true);
  });
});
