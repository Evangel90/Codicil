// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The inheritable position: a second compiled contract next to the vault that
// asks the vault "released?" before it pays. Nothing here is mocked: every
// withdrawal runs the escrow circuit, which runs the vault's own circuit.

import { beforeEach, describe, expect, it } from 'vitest';
import { encodeRawTokenType, sampleRawTokenType } from '@midnight-ntwrk/compact-runtime';
import { Phase, pureCircuits } from '@codicil/contracts/vault';
import { buildWill, newHeirKey, newP256Key, newSalt, rpIdHash, VAULT_OPTIONS_OFF } from '@codicil/sdk';
import escrowSource from '../../contracts/src/inheritable_escrow.compact?raw';
import { CHALLENGE, DAY, demo, ESTATE, POSITION } from '../src/demo/store.js';
import { createDemoPasskey } from '../src/demo/passkey.js';
import { DemoChain } from '../src/demo/chain.js';
import { HexBytes, hexBuffer, installBufferShim } from '../src/demo/buffer-shim.js';
import { nextUp, positionNext, positionStage } from '../src/demo/guide.js';
import { commands, filterCommands } from '../src/demo/commands.js';
import { HOOK_LINE, INTEGRATION_SOURCE } from '../src/demo/integration.js';

const s = () => demo.getSnapshot();
const pos = () => s().position;
const ben = { kind: 'heir', id: 'ben' } as const;

async function ok(p: Promise<boolean>) {
  expect(await p, s().tx?.message).toBe(true);
  demo.dismissTx();
}

/** The action failed with this contract error, shown to the person as `message`. */
async function refused(p: Promise<boolean>, code: string, message: RegExp) {
  expect(await p).toBe(false);
  expect(s().tx).toMatchObject({ status: 'error', code });
  expect(s().tx!.message).toMatch(message);
  demo.dismissTx();
}

async function release() {
  demo.advanceTo(s().deadline);
  await ok(demo.startCountdown('Someone'));
  demo.advance(CHALLENGE);
  await ok(demo.release('Someone'));
}

beforeEach(async () => {
  demo.stageDelayMs = 0;
  demo.reset();
  await demo.setUp(createDemoPasskey());
});

describe('the savings contract next to the vault', () => {
  it('is deployed pointing at the vault, funded, with its beneficiary as a commitment', () => {
    expect(pos().vault).toBe(s().chain.address);
    expect(pos().address).not.toBe(s().chain.address);
    expect(pos()).toMatchObject({ held: POSITION.amount, withdrawn: false });
    expect(pos().beneficiaryCommit).toMatch(/^[0-9a-f]{64}$/);
    expect(s().estate).toBe(ESTATE);                      // its tokens are not the vault's
    expect(s().activity[0]).toMatchObject({ what: 'Harbour Savings made inheritable · 8,000 demo tokens' });
    expect(s().activity[0].published.join(' ')).not.toMatch(/Ben/);
  });

  it("refuses a withdrawal with the contract's own error until the vault is released", async () => {
    await refused(demo.withdrawPosition(ben), 'vault not released', /the vault said the will is not released.*Try again once/);
    expect(pos().lastAttempt).toMatchObject({ ok: false, by: 'Ben', code: 'vault not released' });

    demo.advanceTo(s().deadline);
    await ok(demo.startCountdown('Someone'));
    expect(s().phase).toBe(Phase.pending);
    await refused(demo.withdrawPosition(ben), 'vault not released', /not released/);   // pending is not released
    await ok(demo.checkIn());                                                         // the owner cancels
    await refused(demo.withdrawPosition(ben), 'vault not released', /not released/);

    expect(pos()).toMatchObject({ held: POSITION.amount, withdrawn: false });
    expect(pos().paidTo).toBeUndefined();
    expect(s().activity.some((a) => /paid out/.test(a.what))).toBe(false);            // a refusal never reaches the chain
  });

  it('pays the beneficiary after the release, through a call into the vault', async () => {
    await release();
    const to = 'ab'.repeat(32);
    await ok(demo.withdrawPosition(ben, to));
    // One transaction, two circuits: the vault's finishes first, inside the escrow's.
    expect(pos().lastAttempt).toMatchObject({
      ok: true,
      calls: [{ contract: 'vault', circuit: 'isReleasedForContract' }, { contract: 'savings', circuit: 'withdrawToBeneficiary' }],
    });
    expect(pos()).toMatchObject({ withdrawn: true, paidTo: to });
    expect(s().estate).toBe(ESTATE);
    expect(s().activity[0]).toMatchObject({ what: 'Harbour Savings paid out · 8,000 demo tokens', who: 'The beneficiary' });
    expect(s().activity[0].published.join(' ')).not.toMatch(/Ben/);
    await refused(demo.withdrawPosition(ben), 'already withdrawn', /already paid out/);
  });

  it('refuses anyone without the beneficiary secret, before and after the release', async () => {
    await refused(demo.withdrawPosition({ kind: 'owner' }), 'not the beneficiary', /does not match its beneficiary/);
    await release();
    await refused(demo.withdrawPosition({ kind: 'heir', id: 'ada' }), 'not the beneficiary', /does not match/);
    await refused(demo.withdrawPosition({ kind: 'public' }), 'not the beneficiary', /does not match/);
    expect(pos().lastAttempt).toMatchObject({ ok: false, by: 'Someone' });
    expect(pos().withdrawn).toBe(false);
    await ok(demo.withdrawPosition(ben));
  });

  it('refuses a payout address that is not 32 bytes of hex', async () => {
    await release();
    expect(await demo.withdrawPosition(ben, 'mn_addr_nope')).toBe(false);
    expect(s().tx!.message).toMatch(/^That does not look like an address/);
    demo.dismissTx();
    expect(pos().withdrawn).toBe(false);
  });

  it('starts again from nothing when the demo is reset', async () => {
    await release();
    await ok(demo.withdrawPosition(ben));
    const old = pos().address;
    demo.reset();
    expect(pos()).toMatchObject({ address: '', withdrawn: false });
    await demo.setUp(createDemoPasskey());
    expect(pos().address).not.toBe(old);
    expect(pos()).toMatchObject({ held: POSITION.amount, withdrawn: false });
    expect(pos().lastAttempt).toBeUndefined();
    expect(pos().paidTo).toBeUndefined();
  });
});

describe('the demo chain with two contracts', () => {
  it('lets only contracts ask the vault whether it is released', async () => {
    const now = 1_800_000_000;
    const chain = await DemoChain.deploy({
      ownerPasskeyCommit: pureCircuits.passkeyCommitment(newP256Key().pk, newSalt()),
      ownerEdCommit: new Uint8Array(32),
      passkeyRpIdHash: rpIdHash(),
      willRoot: buildWill([{ heir: { pk: newHeirKey().pk, salt: newSalt() }, shareBps: 10_000n }]).root,
      firstDeadline: BigInt(now + DAY),
      maxPeriod: BigInt(30 * DAY),
      challengeWindow: BigInt(DAY),
      claimWindow: BigInt(DAY),
      tokenColor: encodeRawTokenType(sampleRawTokenType()),
      guardianRoot: 0n,
      guardianThreshold: 0n,
      attestorKeyCommit: new Uint8Array(32),
      ...VAULT_OPTIONS_OFF,
    }, now);
    await expect(chain.call('isReleasedForContract', {})).rejects.toThrow('callable by contracts only');
    await expect(chain.callContract('00'.repeat(32), 'deposit', {})).rejects.toThrow('nothing deployed');
  });
});

describe('what to try on the savings screen', () => {
  const who = () => positionNext(s()).who.map((a) => (a.kind === 'heir' ? a.id : a.kind));

  it('invites one refused withdrawal, hands back to the vault story, then pays', async () => {
    expect(positionStage(s())).toBe('locked');
    expect(who()).toEqual(['ben']);
    expect(positionNext(s()).text).toMatch(/Try a withdrawal as Ben now/);

    await refused(demo.withdrawPosition(ben), 'vault not released', /not released/);
    expect(positionNext(s()).text).toBe(`Harbour Savings refused, as it should. ${nextUp(s()).text}`);
    expect(who()).toEqual(['owner']);
    demo.advanceTo(s().deadline);
    expect(positionNext(s()).action).toBe('startSwitch');      // the vault's own next step, from this screen
    await ok(demo.startCountdown('Someone'));
    demo.advance(CHALLENGE);
    expect(positionNext(s()).action).toBe('release');
    await ok(demo.release('Someone'));

    expect(positionStage(s())).toBe('open');
    expect(positionNext(s()).tone).toBe('attention');
    expect(positionNext(s()).action).toBeUndefined();
    expect(who()).toEqual(['ben']);
    expect(nextUp(s()).who.map((a) => (a.kind === 'heir' ? a.id : a.kind))).toEqual(['ada', 'ben']);   // the vault story is unchanged

    await ok(demo.withdrawPosition(ben));
    expect(positionStage(s())).toBe('paid');
    expect(positionNext(s())).toMatchObject({ tone: 'done', who: [] });
  });

  it('a guess by someone else does not count as having seen the refusal', async () => {
    await refused(demo.withdrawPosition({ kind: 'owner' }), 'not the beneficiary', /does not match/);
    expect(positionNext(s()).text).toMatch(/Try a withdrawal as Ben now/);
  });
});

describe('the savings commands in the palette', () => {
  const tabs: string[] = [];
  const ctx = { setTab: (t: string) => { tabs.push(t); }, reset: () => {}, toggleTheme: () => {}, downloadReminders: () => {} };
  const settled = async () => { while (s().tx?.status === 'running') await new Promise((r) => setTimeout(r, 1)); };
  const withdraw = () => commands(s(), ctx).find((c) => c.id === 'withdraw');

  it('withdraws as Ben from anywhere: refused first, paid after the release, then gone', async () => {
    expect(withdraw()).toMatchObject({ label: 'Withdraw from Harbour Savings as Ben', group: 'Do', hint: 'will be refused' });
    withdraw()!.run();
    await settled();
    expect(s().actor).toEqual(ben);
    expect(tabs.at(-1)).toBe('savings');
    expect(s().tx).toMatchObject({ status: 'error', code: 'vault not released' });
    demo.dismissTx();

    await release();
    expect(withdraw()!.hint).toBeUndefined();
    withdraw()!.run();
    await settled();
    expect(s().tx?.status).toBe('done');
    demo.dismissTx();
    expect(pos().withdrawn).toBe(true);
    expect(withdraw()).toBeUndefined();
  });

  it('is found by the words a developer would type', () => {
    const list = commands(s(), ctx);
    expect(filterCommands(list, 'cross-contract').map((c) => c.id)).toEqual(['go:savings']);
    expect(filterCommands(list, 'escrow').map((c) => c.id)).toEqual(['withdraw', 'go:savings']);
    expect(filterCommands(list, 'harbour savings').map((c) => c.id)).toEqual(['withdraw', 'go:savings']);
    tabs.length = 0;
    list.find((c) => c.id === 'go:savings')!.run();
    expect(tabs).toEqual(['savings']);
  });
});

describe('the code shown to developers', () => {
  it('is the code in the contract, line for line', () => {
    const contract = escrowSource.split('\n').map((l) => l.trim());
    for (const { text } of INTEGRATION_SOURCE) {
      if (text.trim()) expect(contract, text).toContain(text.trim());
    }
    expect(INTEGRATION_SOURCE.filter((l) => l.key).map((l) => l.text.trim())).toEqual([HOOK_LINE]);
  });
});

describe('the Buffer stand-in for browsers', () => {
  it('converts hex both ways, as the contract runtime expects', () => {
    const bytes = hexBuffer.from('00ff10a7', 'hex');
    expect(bytes.constructor).toBe(Uint8Array);
    expect([...bytes]).toEqual([0, 255, 16, 167]);
    expect(hexBuffer.from(new Uint8Array([0, 255, 16, 167])).toString('hex')).toBe('00ff10a7');
    expect(hexBuffer.from(bytes).slice(1).constructor).toBe(Uint8Array);
    expect(hexBuffer.from(bytes)).toBeInstanceOf(HexBytes);
  });

  it('says so when asked for anything else', () => {
    expect(() => hexBuffer.from('aGVsbG8=', 'base64')).toThrow(/only hex/);
    expect(() => hexBuffer.from('abc', 'hex')).toThrow(/only hex/);
    expect(() => hexBuffer.from([1, 2]).toString('utf8')).toThrow(/only 'hex'/);
  });

  it('is installed only where Buffer is missing', () => {
    const browser: { Buffer?: unknown } = {};
    installBufferShim(browser);
    expect(browser.Buffer).toBe(hexBuffer);
    const node = { Buffer: 'the real one' };
    installBufferShim(node);
    expect(node.Buffer).toBe('the real one');
  });
});
