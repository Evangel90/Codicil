// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The reader page's logic: someone with no wallet and no key reads a vault
// and its seal register, checks a copy of a sealed text, and opens it once
// enough pieces are on the ledger. Here the contract states come from the
// demo chain instead of a network's indexer; the reading code is the same.

import { beforeEach, describe, expect, it } from 'vitest';
import { Phase } from '@codicil/contracts/vault';
import { CHALLENGE, demo } from '../src/demo/store.js';
import { createDemoPasskey } from '../src/demo/passkey.js';
import { signal } from '../src/demo/guide.js';
import { checkCopy, cleanAddress, looksLikeAddress, openCopy, readRegister, readVault, type FetchState } from '../src/live/reader.js';

const s = () => demo.getSnapshot();
const fetchState: FetchState = (address) => demo.contractState(address);
const TEXT = 'If you are reading this, I could not publish it myself.';

async function done(p: Promise<unknown>) {
  await p;
  expect(s().tx, s().tx?.message).toMatchObject({ status: 'done' });
  demo.dismissTx();
}

async function release() {
  demo.advanceTo(s().deadline);
  await done(demo.startCountdown('Someone'));
  demo.advance(CHALLENGE);
  await done(demo.release('Someone'));
}

const register = async () => (await readRegister(fetchState, s().register.address))!;
const sealedText = (to = 'everyone') => s().messages.find((m) => m.to === to)!.sealedText;

beforeEach(async () => {
  demo.stageDelayMs = 0;
  demo.reset();
  await demo.setUp(createDemoPasskey());
});

describe('reading a vault with no wallet', () => {
  it('reads the times a signal needs, and nothing at an address with no contract', async () => {
    const v = (await readVault(fetchState, `0x${s().chain.address.toUpperCase()}`))!;
    expect(v).toEqual({
      address: s().chain.address, phase: Phase.armed, deadline: s().deadline, switchOpensAt: s().switchOpensAt, pendingUntil: 0, releasedAt: 0,
    });
    expect(signal({ ...v, now: s().now }).title).toBe('Still checking in');
    expect(await readVault(fetchState, 'ab'.repeat(32))).toBeUndefined();
    expect(await readRegister(fetchState, 'ab'.repeat(32))).toBeUndefined();
  });

  it('follows the vault to silent and to released', async () => {
    demo.advanceTo(s().deadline);
    expect(signal({ ...(await readVault(fetchState, s().chain.address))!, now: s().now }).title).toBe('Gone silent');
    await done(demo.startCountdown('Someone'));
    demo.advance(CHALLENGE);
    await done(demo.release('Someone'));
    const v = (await readVault(fetchState, s().chain.address))!;
    expect(v.phase).toBe(Phase.released);
    expect(signal({ ...v, now: s().now }).title).toBe('Released');
  });

  it('knows an address when it sees one', () => {
    expect(looksLikeAddress(` 0x${'AB'.repeat(32)} `)).toBe(true);
    expect(cleanAddress(` 0x${'AB'.repeat(32)} `)).toBe('ab'.repeat(32));
    expect(looksLikeAddress('abc')).toBe(false);
  });
});

describe('reading a seal register with no wallet', () => {
  it('shows which vault it asks, and its seals, without a word of any message', async () => {
    await done(demo.sealMessage('everyone', TEXT));
    const r = await register();
    expect(r.vault).toBe(s().chain.address);
    expect(r.seals).toEqual(s().register.seals);
    expect(r.handedOver).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/publish it myself/);
  });

  it('a true copy matches and stays shut until enough pieces are on the ledger', async () => {
    await done(demo.sealMessage('everyone', TEXT));
    const check = checkCopy(await register(), sealedText());
    expect(check).toMatchObject({ ok: true, needed: 2, pieces: 3, onLedger: [] });
    if (!check.ok) throw new Error('unreachable');
    expect(await openCopy(check)).toEqual({ why: 'It is still locked. It needs 2 pieces of its key and none is on the register.' });

    await release();
    await done(demo.publishPieces(1));
    const one = checkCopy(await register(), sealedText());
    if (!one.ok) throw new Error('unreachable');
    expect(await openCopy(one)).toEqual({ why: 'It is still locked. It needs 2 pieces of its key and one is on the register.' });

    await done(demo.publishPieces(2));
    const two = checkCopy(await register(), sealedText());
    if (!two.ok) throw new Error('unreachable');
    expect(two.onLedger.map((p) => p.x)).toEqual([2, 3]);
    expect(await openCopy(two)).toEqual({ text: TEXT });
  });

  it('a changed copy, and something that is not a sealed text, are told apart', async () => {
    await done(demo.sealMessage('everyone', TEXT));
    const copy = sealedText();
    const at = copy.indexOf('"nonce":"') + 9;
    const changed = copy.slice(0, at) + (copy[at] === '0' ? '1' : '0') + copy.slice(at + 1);
    expect(checkCopy(await register(), changed)).toMatchObject({ ok: false, why: expect.stringMatching(/holds no seal with that fingerprint/) });
    expect(checkCopy(await register(), 'hello')).toMatchObject({ ok: false, why: expect.stringMatching(/^This is not a sealed text\./) });
  });

  it('a private message sent through the register does not open for a stranger, even with every piece public', async () => {
    await done(demo.sealMessage('ben', 'Ben, the workshop keys are with Sarah Lin.', 'register'));
    await release();
    await done(demo.publishPieces(0));
    await done(demo.publishPieces(1));
    // A stranger who got hold of the sealed text, but with the recipient's half blanked out as it never leaves Ben's device.
    const mine = JSON.parse(sealedText('ben')) as Record<string, unknown>;
    const stolen = JSON.stringify({ ...mine, recipientHalf: '00'.repeat(32) });
    // Without the true half the fingerprint is different, so it does not even match the seal.
    expect(checkCopy(await register(), stolen)).toMatchObject({ ok: false });
    // Ben's own copy matches and opens.
    const check = checkCopy(await register(), sealedText('ben'));
    if (!check.ok) throw new Error('unreachable');
    expect(await openCopy(check)).toEqual({ text: 'Ben, the workshop keys are with Sarah Lin.' });
  });
});
