// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The offline parts of the run: the vault's keys surviving a restart, the
// vault configuration, the event match, the wallet identity and its lock.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pureCircuits as pure } from '@codicil/contracts/vault';
import { checkInDigest, rootFromPath, softwareSigners, verifyCip30Signature, verifyWebAuthnAssertion } from '@codicil/sdk';
import { networkPaths } from '../src/paths.js';
import { castFrom, eventNameHex, matchesEventName, newActors, RELEASE_EVENT_NAME, vaultConfigFor } from '../src/run.js';
import { decodeJson, encodeJson, type Actors } from '../src/state.js';
import { DEFAULT_TIMERS } from '../src/timers.js';
import { acquireLock, deriveIdentity, errorText, newSeedHex } from '../src/wallet.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('the throwaway vault\'s keys', () => {
  it('come back identical from the state file, so a rerun can still sign and claim', () => {
    const actors = newActors();
    const restored = decodeJson<Actors>(encodeJson(actors));
    const before = castFrom(actors);
    const after = castFrom(restored);
    expect(after.will.root).toBe(before.will.root);
    expect(after.passkey.pk).toEqual(before.passkey.pk);
    expect(after.wallet.pk).toEqual(before.wallet.pk);
    expect(after.base.claimant?.key.sk).toBe(before.base.claimant?.key.sk);

    // The restored keys still produce approvals the circuits accept.
    const address = 'ab'.repeat(32);
    const digest = checkInDigest(address, 1_800_000_600n, 0n);
    expect(verifyWebAuthnAssertion(softwareSigners.passkey(after.passkey, digest), digest, before.passkey.pk)).toBe(true);
    expect(verifyCip30Signature(softwareSigners.wallet(after.wallet, digest), digest, before.wallet.pk)).toBe(true);
  });

  it('give heir 0 a claim package that opens the will', () => {
    const cast = castFrom(newActors());
    const claimant = cast.base.claimant!;
    expect(rootFromPath(claimant.path)).toBe(cast.will.root);
    expect(claimant.leaf.shareBps).toBe(6000n);
    expect(pure.edKeyCommitment(claimant.key.pk, claimant.keySalt)).toEqual(claimant.leaf.heirKeyCommit);
    expect(cast.will.leaves.reduce((sum, l) => sum + l.shareBps, 0n)).toBe(10_000n);
  });

  it('configure the vault from the timers, with guardians and the attestor switched off', () => {
    const cast = castFrom(newActors());
    const config = vaultConfigFor(cast, DEFAULT_TIMERS, 1_800_000_000);
    expect(config.firstDeadline).toBe(BigInt(1_800_000_000 + DEFAULT_TIMERS.firstDeadlineS));
    expect(config.maxPeriod).toBe(BigInt(DEFAULT_TIMERS.maxPeriodS));
    expect(config.challengeWindow).toBe(BigInt(DEFAULT_TIMERS.challengeWindowS));
    expect(config.willRoot).toBe(cast.will.root);
    expect(config.guardianThreshold).toBe(0n);
    expect(config.attestorKeyCommit).toEqual(new Uint8Array(32));
    // tNIGHT is the all-zero unshielded token type.
    expect(config.tokenColor).toEqual(new Uint8Array(32));
    expect(config.ownerPasskeyCommit).toEqual(pure.passkeyCommitment(cast.passkey.pk, cast.base.passkey!.salt));
  });
});

describe('release event', () => {
  const hex = eventNameHex(RELEASE_EVENT_NAME);

  it('matches the name however the indexer pads or prefixes it', () => {
    expect(hex).toBe('636f646963696c3a72656c65617365643a7631');
    expect(matchesEventName(hex, RELEASE_EVENT_NAME)).toBe(true);
    expect(matchesEventName(hex.padEnd(64, '0'), RELEASE_EVENT_NAME)).toBe(true);
    expect(matchesEventName(`0x${hex.toUpperCase()}`.padEnd(66, '0'), RELEASE_EVENT_NAME)).toBe(true);
  });

  it('does not match another event or an empty field', () => {
    expect(matchesEventName(eventNameHex('codicil:other:v1').padEnd(64, '0'), RELEASE_EVENT_NAME)).toBe(false);
    expect(matchesEventName(undefined, RELEASE_EVENT_NAME)).toBe(false);
    expect(matchesEventName('', RELEASE_EVENT_NAME)).toBe(false);
  });
});

describe('test wallet', () => {
  it('derives the same identity from the same seed, with the network in the address', () => {
    const seed = newSeedHex();
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    const preprod = deriveIdentity(seed, 'preprod');
    expect(preprod.address).toMatch(/^mn_addr_preprod1/);
    expect(deriveIdentity(seed, 'preprod').address).toBe(preprod.address);
    expect(deriveIdentity(seed, 'preview').address).toMatch(/^mn_addr_preview1/);
    expect(deriveIdentity(seed, 'preview').addressHex).toBe(preprod.addressHex);
    expect(preprod.addressHex).toMatch(/^[0-9a-f]{64}$/);
    expect(preprod.dustAddress).toMatch(/^mn_dust_preprod1/);
    expect(deriveIdentity(newSeedHex(), 'preprod').address).not.toBe(preprod.address);
  });

  it('keeps one wallet session per seed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codicil-lock-'));
    dirs.push(dir);
    const lock = join(dir, 'wallet.lock');
    const release = acquireLock(lock);
    // The same process may take it again (a command that restarts its session).
    acquireLock(lock)();
    release();
    // A lock left by a process that no longer exists is stale and is taken over.
    writeFileSync(lock, '2147483646\n');
    acquireLock(lock)();
    // A lock held by a live process other than this one is refused.
    writeFileSync(lock, `${process.ppid}\n`);
    expect(() => acquireLock(lock)).toThrow(/another command is using this wallet/);
  });

  it('keeps secrets and working state under .midnight, per network', () => {
    const p = networkPaths('preprod', '/repo');
    expect(p.state).toBe('/repo/.midnight/codicil/preprod/state.json');
    expect(p.walletSnapshot).toBe('/repo/.midnight/codicil/preprod/wallet.json');
    expect(networkPaths('preview', '/repo').dir).not.toBe(p.dir);
  });

  it('describes errors with their causes', () => {
    expect(errorText(new Error('outer', { cause: new Error('inner') }))).toBe('outer (caused by: inner)');
    expect(errorText({ _tag: 'Wallet.Sync', message: 'lost' })).toBe('Wallet.Sync: lost');
    expect(errorText('plain')).toBe('plain');
  });
});
