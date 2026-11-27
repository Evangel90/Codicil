// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The seal register: the pieces of a sealed message's key are handed over
// through a contract that asks the vault first. Before the release it refuses
// every piece; after it, it accepts only genuine ones and publishes them, and
// the message opens from what is on the ledger.

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { encodeRawTokenType, sampleRawTokenType } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits as vaultPure, type VaultConfig } from '@codicil/contracts/vault';
import { ledger as sealsLedger } from '@codicil/contracts/seals';
import {
  buildWill,
  handOverArgs,
  keeperCommitment,
  newEdKey,
  newHeirKey,
  newP256Key,
  newSalt,
  openMessageText,
  pieceCommitment,
  piecesHandedOver,
  rpIdHash,
  sealArgs,
  sealedFingerprint,
  sealedFromText,
  sealedToText,
  sealMessage,
  sealOn,
  sealsWitnesses,
  SEAL_TIME_SLACK,
  VAULT_OPTIONS_OFF,
  witnesses as vaultWitnesses,
  type KeyPiece,
  type SealedMessage,
} from '@codicil/sdk';
import { loadModule, TestChain, type Deployed } from './support/chain.js';
import { CHALLENGE, CLAIM_WINDOW, DAY, FIRST_DEADLINE, MAX_PERIOD, RELEASED_AT, T0 } from './support/world.js';

const TEXT = 'If this is public, I could not publish it myself. The ledger is in the folder below.';

interface World {
  chain: TestChain;
  vault: Deployed;
  register: Deployed;
  keeper: Uint8Array;
  sealed: SealedMessage;
  pieces: KeyPiece[];
  fingerprint: Uint8Array;
}

async function deployWorld(): Promise<World> {
  const chain = new TestChain();
  const heir = newHeirKey();
  const config: VaultConfig = {
    ownerPasskeyCommit: vaultPure.passkeyCommitment(newP256Key().pk, newSalt()),
    ownerEdCommit: vaultPure.edKeyCommitment(newEdKey().pk, newSalt()),
    passkeyRpIdHash: rpIdHash(),
    willRoot: buildWill([{ heir: { pk: heir.pk, salt: newSalt() }, shareBps: 10_000n }]).root,
    firstDeadline: BigInt(FIRST_DEADLINE),
    maxPeriod: BigInt(MAX_PERIOD),
    challengeWindow: BigInt(CHALLENGE),
    claimWindow: BigInt(CLAIM_WINDOW),
    tokenColor: encodeRawTokenType(sampleRawTokenType()),
    guardianRoot: 0n,
    guardianThreshold: 0n,
    attestorKeyCommit: new Uint8Array(32),
    ...VAULT_OPTIONS_OFF,
  };
  const vault = await chain.deploy(await loadModule('codicil_vault'), [config], vaultWitnesses);
  const keeper = randomBytes(32);
  const register = await chain.deploy(await loadModule('codicil_seals'), [vault.encodedAddress, keeperCommitment(keeper)], sealsWitnesses());
  const { sealed, pieces } = await sealMessage({ vault: vault.address, message: TEXT, pieces: 3, needed: 2 });
  return { chain, vault, register, keeper, sealed, pieces, fingerprint: sealedFingerprint(sealed) };
}

describe('seal register (release-gated key pieces)', () => {
  let w: World;
  const ledger = () => sealsLedger(w.chain.ledgerState(w.register.address).state);
  const seal = (opts: { keeper?: Uint8Array; time?: number; sealed?: SealedMessage; pieces?: KeyPiece[] } = {}) =>
    w.chain.call(
      w.register, 'seal', { time: opts.time ?? T0, witnesses: sealsWitnesses(opts.keeper ?? w.keeper) },
      ...sealArgs(opts.sealed ?? w.sealed, opts.pieces ?? w.pieces, T0),
    );
  const handOver = (piece: KeyPiece, time = RELEASED_AT + DAY, fingerprint = w.fingerprint) =>
    w.chain.call(w.register, 'handOver', { time, witnesses: sealsWitnesses() }, ...handOverArgs(fingerprint, piece));
  const releaseVault = async () => {
    await w.chain.call(w.vault, 'triggerTimeout', { time: FIRST_DEADLINE, witnesses: vaultWitnesses });
    await w.chain.call(w.vault, 'finalizeRelease', { time: RELEASED_AT, witnesses: vaultWitnesses });
  };

  beforeEach(async () => {
    w = await deployWorld();
  });

  it('records a fingerprint and piece commitments, and nothing that could open the message', async () => {
    await seal();
    const l = ledger();
    expect(sealOn(l, w.fingerprint)).toEqual({ needed: 2n, pieces: 3n, sealedBefore: BigInt(T0 + SEAL_TIME_SLACK) });
    expect(l.pieceChecks.size()).toBe(3n);
    for (const p of w.pieces) expect(l.pieceChecks.member(pieceCommitment(w.fingerprint, p))).toBe(true);
    expect(l.handedOver.isEmpty()).toBe(true);
    // The whole public state, as bytes: no piece, no key half, no sealed text.
    const everything = Buffer.from((await w.chain.getContractState('', w.register.address))!.serialize()).toString('hex');
    expect(everything).toContain(Buffer.from(w.fingerprint).toString('hex'));
    for (const secret of [...w.pieces.map((p) => p.y), w.sealed.recipientHalf, w.sealed.ciphertext]) {
      expect(everything).not.toContain(Buffer.from(secret).toString('hex'));
    }
  });

  it('refuses every piece while the vault is armed or pending', async () => {
    await seal();
    await expect(handOver(w.pieces[0], T0)).rejects.toThrow('vault not released');
    await w.chain.call(w.vault, 'triggerTimeout', { time: FIRST_DEADLINE, witnesses: vaultWitnesses });
    await expect(handOver(w.pieces[0], FIRST_DEADLINE + DAY)).rejects.toThrow('vault not released');
    expect(ledger().handedOver.isEmpty()).toBe(true);
  });

  it('after the release, publishes genuine pieces through a proven vault sub-call, and the message opens from the ledger', async () => {
    await seal();
    await releaseVault();
    const r = await handOver(w.pieces[2]);
    expect(r.trace).toEqual([
      [w.vault.address, 'isReleasedForContract'],
      [w.register.address, 'handOver'],
    ]);
    // One piece of two: still shut.
    await expect(openMessageText(w.sealed, piecesHandedOver(ledger(), w.fingerprint))).rejects.toThrow(/needs 2 pieces and 1 was given/);
    await handOver(w.pieces[0]);
    const onLedger = piecesHandedOver(ledger(), w.fingerprint);
    expect(onLedger.map((p) => p.x)).toEqual([1, 3]);
    // The reader needs only the sealed text (here, sent as text) and the public ledger.
    expect(await openMessageText(sealedFromText(sealedToText(w.sealed)), onLedger)).toBe(TEXT);
    // Handing the same piece over twice changes nothing.
    await handOver(w.pieces[0]);
    expect(ledger().handedOver.size()).toBe(2n);
  });

  it('refuses a piece that is not genuine, even after the release', async () => {
    await seal();
    await releaseVault();
    await expect(handOver({ x: 1, y: randomBytes(32) })).rejects.toThrow('not a genuine piece');
    // A genuine piece under the wrong number is not genuine either.
    await expect(handOver({ x: 2, y: w.pieces[0].y })).rejects.toThrow('not a genuine piece');
    // Nor is a piece of another message's key.
    const other = await sealMessage({ vault: w.vault.address, message: 'another', pieces: 3, needed: 2 });
    await expect(handOver(other.pieces[0])).rejects.toThrow('not a genuine piece');
    await expect(handOver(other.pieces[0], RELEASED_AT + DAY, sealedFingerprint(other.sealed))).rejects.toThrow('no such seal');
    expect(ledger().handedOver.isEmpty()).toBe(true);
  });

  it('only the keeper seals, and the same sealed text only once', async () => {
    await expect(seal({ keeper: randomBytes(32) })).rejects.toThrow('not the keeper');
    await seal();
    await expect(seal()).rejects.toThrow('already sealed');
  });

  it('refuses piece counts that make no sense, and a seal that arrives too late', async () => {
    const call = (needed: bigint, pieces: bigint, time = T0) => {
      const [fingerprint, , , checks, before] = sealArgs(w.sealed, w.pieces, T0);
      return w.chain.call(w.register, 'seal', { time, witnesses: sealsWitnesses(w.keeper) }, fingerprint, needed, pieces, checks, before);
    };
    await expect(call(0n, 3n)).rejects.toThrow('bad piece count');
    await expect(call(4n, 3n)).rejects.toThrow('bad piece count');
    await expect(call(2n, 9n)).rejects.toThrow('bad piece count');
    await expect(call(2n, 3n, T0 + SEAL_TIME_SLACK)).rejects.toThrow('seal time has passed');
    expect(() => sealArgs(w.sealed, [], T0)).toThrow(/1 to 8 pieces/);
  });

  it('a seal the keeper took back cannot be opened through the register', async () => {
    await seal();
    await expect(w.chain.call(w.register, 'unseal', { time: T0 + DAY, witnesses: sealsWitnesses(randomBytes(32)) }, w.fingerprint))
      .rejects.toThrow('not the keeper');
    await w.chain.call(w.register, 'unseal', { time: T0 + DAY, witnesses: sealsWitnesses(w.keeper) }, w.fingerprint);
    expect(sealOn(ledger(), w.fingerprint)).toBeUndefined();
    await releaseVault();
    await expect(handOver(w.pieces[0])).rejects.toThrow('no such seal');
  });

  it('a seal cannot be taken back after the release', async () => {
    await seal();
    await releaseVault();
    await expect(w.chain.call(w.register, 'unseal', { time: RELEASED_AT + DAY, witnesses: sealsWitnesses(w.keeper) }, w.fingerprint))
      .rejects.toThrow('vault released');
    await expect(w.chain.call(w.register, 'unseal', { time: RELEASED_AT + DAY, witnesses: sealsWitnesses(w.keeper) }, randomBytes(32)))
      .rejects.toThrow('no such seal');
  });

  it('a public statement is recorded as a fingerprint, by the keeper only', async () => {
    const fp = randomBytes(32);
    await expect(w.chain.call(w.register, 'state', { time: T0, witnesses: sealsWitnesses(randomBytes(32)) }, fp)).rejects.toThrow('not the keeper');
    await w.chain.call(w.register, 'state', { time: T0, witnesses: sealsWitnesses(w.keeper) }, fp);
    expect(Buffer.from(ledger().statement).toString('hex')).toBe(Buffer.from(fp).toString('hex'));
  });

  it('a sealed text that was changed no longer matches its fingerprint', async () => {
    const changed = { ...w.sealed, ciphertext: Uint8Array.from(w.sealed.ciphertext, (b, i) => (i === 0 ? b ^ 1 : b)) };
    expect(Buffer.from(sealedFingerprint(changed)).toString('hex')).not.toBe(Buffer.from(w.fingerprint).toString('hex'));
    expect(() => sealedFromText('{"codicil":"sealed","version":2}')).toThrow(/newer version/);
    expect(() => sealedFromText('hello')).toThrow(/not a sealed text/);
  });
});
