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
import { ledger as vaultLedger, pureCircuits as vaultPure, type VaultConfig } from '@codicil/contracts/vault';
import { ledger as sealsLedger, pureCircuits as sealsPure } from '@codicil/contracts/seals';
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
  registerProvesOwner,
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
  type PasskeyOwner,
  type SealedMessage,
  type WalletOwner,
} from '@codicil/sdk';
import { loadModule, TestChain, type Deployed } from './support/chain.js';
import { CHALLENGE, CLAIM_WINDOW, DAY, FIRST_DEADLINE, MAX_PERIOD, RELEASED_AT, T0 } from './support/world.js';

const TEXT = 'If this is public, I could not publish it myself. The ledger is in the folder below.';

interface World {
  chain: TestChain;
  vault: Deployed;
  register: Deployed;
  keeper: Uint8Array;
  /** The vault owner's keys and salts: what only the owner's device holds. */
  passkey: PasskeyOwner;
  wallet: WalletOwner;
  sealed: SealedMessage;
  pieces: KeyPiece[];
  fingerprint: Uint8Array;
}

async function deployWorld(): Promise<World> {
  const chain = new TestChain();
  const heir = newHeirKey();
  const passkey: PasskeyOwner = { pk: newP256Key().pk, salt: newSalt() };
  const wallet: WalletOwner = { pk: newEdKey().pk, salt: newSalt() };
  const config: VaultConfig = {
    ownerPasskeyCommit: vaultPure.passkeyCommitment(passkey.pk, passkey.salt),
    ownerEdCommit: vaultPure.edKeyCommitment(wallet.pk, wallet.salt),
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
  return { chain, vault, register, keeper, passkey, wallet, sealed, pieces, fingerprint: sealedFingerprint(sealed) };
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

  it('a genuine piece of one sealed key cannot be planted under another', async () => {
    const other = await sealMessage({ vault: w.vault.address, message: 'another', pieces: 3, needed: 2 });
    await seal();
    await seal({ sealed: other.sealed, pieces: other.pieces });
    await releaseVault();
    // Both seals are on the register; each commitment is bound to its own fingerprint.
    await expect(handOver(other.pieces[0])).rejects.toThrow('not a genuine piece');
    await expect(handOver(w.pieces[0], RELEASED_AT + DAY, sealedFingerprint(other.sealed))).rejects.toThrow('not a genuine piece');
    await handOver(other.pieces[0], RELEASED_AT + DAY, sealedFingerprint(other.sealed));
    expect(piecesHandedOver(ledger(), w.fingerprint)).toEqual([]);
    expect(piecesHandedOver(ledger(), sealedFingerprint(other.sealed)).map((p) => p.x)).toEqual([1]);
  });

  it('nothing is sealed once the vault has released, so every seal predates the release', async () => {
    await releaseVault();
    const late = RELEASED_AT + DAY;
    await expect(w.chain.call(w.register, 'seal', { time: late, witnesses: sealsWitnesses(w.keeper) }, ...sealArgs(w.sealed, w.pieces, late)))
      .rejects.toThrow('vault released');
    expect(ledger().seals.isEmpty()).toBe(true);
  });

  it('the recorded time is within an hour of the block that accepted the seal', async () => {
    const call = (before: number, time = T0) => {
      const [fingerprint, needed, pieces, checks] = sealArgs(w.sealed, w.pieces, T0);
      return w.chain.call(w.register, 'seal', { time, witnesses: sealsWitnesses(w.keeper) }, fingerprint, needed, pieces, checks, BigInt(before));
    };
    await expect(call(T0 + 3601)).rejects.toThrow('seal time too far ahead');
    await expect(call(T0 + 365 * DAY)).rejects.toThrow('seal time too far ahead');
    await expect(call(1000)).rejects.toThrow('seal time has passed');
    await call(T0 + 3600);
    expect(sealOn(ledger(), w.fingerprint)!.sealedBefore).toBe(BigInt(T0 + 3600));
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

  describe('proving whose register it is', () => {
    const vault = () => vaultLedger(w.chain.ledgerState(w.vault.address).state);
    const prove = (circuit: 'provePasskeyOwner' | 'proveWalletOwner', witnesses: object, register = w.register) =>
      w.chain.call(register, circuit, { time: T0, witnesses });

    it('repeats the vault\'s owner commitments byte for byte', () => {
      const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');
      expect(hexOf(sealsPure.passkeyCommitment(w.passkey.pk, w.passkey.salt))).toBe(hexOf(vaultPure.passkeyCommitment(w.passkey.pk, w.passkey.salt)));
      expect(hexOf(sealsPure.edKeyCommitment(w.wallet.pk, w.wallet.salt))).toBe(hexOf(vaultPure.edKeyCommitment(w.wallet.pk, w.wallet.salt)));
    });

    it('starts unproven, and the owner proves it with the passkey without revealing it', async () => {
      expect(registerProvesOwner(vault(), ledger())).toBe(false);
      await prove('provePasskeyOwner', sealsWitnesses(w.keeper, { passkey: w.passkey }));
      expect(Buffer.from(ledger().ownerCommit).toString('hex')).toBe(Buffer.from(vault().ownerPasskeyCommit).toString('hex'));
      expect(registerProvesOwner(vault(), ledger())).toBe(true);
      // The salt that opens the commitment is nowhere in the register's public state.
      const everything = Buffer.from((await w.chain.getContractState('', w.register.address))!.serialize()).toString('hex');
      expect(everything).not.toContain(Buffer.from(w.passkey.salt).toString('hex'));
    });

    it('the owner can prove it with the wallet key instead', async () => {
      await prove('proveWalletOwner', sealsWitnesses(w.keeper, { wallet: w.wallet }));
      expect(Buffer.from(ledger().ownerCommit).toString('hex')).toBe(Buffer.from(vault().ownerEdCommit).toString('hex'));
      expect(registerProvesOwner(vault(), ledger())).toBe(true);
    });

    it('someone else\'s register pointed at the same vault cannot prove it', async () => {
      const theirs = randomBytes(32);
      const fake = await w.chain.deploy(await loadModule('codicil_seals'), [w.vault.encodedAddress, keeperCommitment(theirs)], sealsWitnesses());
      const fakeLedger = () => sealsLedger(w.chain.ledgerState(fake.address).state);
      // With a key of their own.
      await prove('provePasskeyOwner', sealsWitnesses(theirs, { passkey: { pk: newP256Key().pk, salt: newSalt() } }), fake);
      expect(registerProvesOwner(vault(), fakeLedger())).toBe(false);
      // Even knowing the owner's public key, without the salt.
      await prove('provePasskeyOwner', sealsWitnesses(theirs, { passkey: { pk: w.passkey.pk, salt: newSalt() } }), fake);
      expect(registerProvesOwner(vault(), fakeLedger())).toBe(false);
      await prove('proveWalletOwner', sealsWitnesses(theirs, { wallet: { pk: w.wallet.pk, salt: newSalt() } }), fake);
      expect(registerProvesOwner(vault(), fakeLedger())).toBe(false);
    });

    it('only the keeper can make the proof, and only with a key on the device', async () => {
      await expect(prove('provePasskeyOwner', sealsWitnesses(randomBytes(32), { passkey: w.passkey }))).rejects.toThrow('not the keeper');
      await expect(prove('provePasskeyOwner', sealsWitnesses(w.keeper))).rejects.toThrow('no owner passkey on this device');
      expect(registerProvesOwner(vault(), ledger())).toBe(false);
    });
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
    // Through text and back, the fingerprint is the same.
    expect(Buffer.from(sealedFingerprint(sealedFromText(sealedToText(w.sealed)))).toString('hex')).toBe(Buffer.from(w.fingerprint).toString('hex'));
    // A copy with a field that is not what it claims to be is refused, not guessed at.
    const raw = JSON.parse(sealedToText(w.sealed)) as Record<string, unknown>;
    const bad = (change: Record<string, unknown>) => () => sealedFromText(JSON.stringify({ ...raw, ...change }));
    expect(bad({ vault: `${String(raw.vault)}:\u0001` })).toThrow(/incomplete/);
    expect(bad({ needed: 4 })).toThrow(/incomplete/);
    expect(bad({ needed: 1.5 })).toThrow(/incomplete/);
    expect(bad({ pieceChecks: [] })).toThrow(/incomplete/);
    expect(bad({ nonce: 'zz' })).toThrow(/damaged nonce/);
    expect(bad({ recipientHalf: 'abcd' })).toThrow(/damaged key half/);
    expect(bad({ ciphertext: 'ABCD' })).toThrow(/damaged body/);
    expect(() => sealedFingerprint({ ...w.sealed, vault: 'not-a-vault' })).toThrow(/64 hexadecimal/);
  });
});
