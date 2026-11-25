// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The recovery key and the settings update together: a settings update is an
// owner action like any other, so it cancels a recovery too (D17, D18).

import { describe, expect, it } from 'vitest';
import { pureCircuits, type VaultSettings } from '@codicil/contracts/vault';
import { currentSettings, newRecoverySecret, recoveryConfig, recoveryStatus, settingsDigest } from '@codicil/sdk';
import { approve, checkIn, DAY, deployVault, L, newOwner, nobody, T0, type Via, type World } from './support/world.js';

const DELAY = 3 * DAY;
const T = T0 + DAY;
const READY = T + DELAY;

function updateSettings(w: World, via: Via, settings: VaultSettings, time: number) {
  const digest = settingsDigest(w.sim.address, settings, L(w.sim).nonce);
  const circuit = via === 'passkey' ? 'updateSettingsPasskey' : 'updateSettingsEd25519';
  return w.sim.call(circuit, { time, as: approve(w, via, digest) }, settings);
}

async function recoverable() {
  const secret = newRecoverySecret();
  const w = await deployVault({ config: recoveryConfig(secret, BigInt(DELAY)) });
  const fresh = newOwner();
  const start = (time: number) => w.sim.call('startRecovery', { time, as: { recovery: { secret } } },
    pureCircuits.passkeyCommitment(fresh.passkey.pk, fresh.state.passkey!.salt),
    pureCircuits.edKeyCommitment(fresh.wallet.pk, fresh.state.wallet!.salt),
    new Uint8Array(32), BigInt(time));
  return { w, fresh, start };
}

describe('settings updates and the recovery key', () => {
  it.each<Via>(['passkey', 'wallet'])('a settings update by %s cancels a recovery and retires the recovery key', async (via) => {
    const { w, start } = await recoverable();
    await start(T);
    await updateSettings(w, via, { ...currentSettings(L(w.sim)), guardianThreshold: 3n }, T + DAY);
    expect(L(w.sim).guardianThreshold).toBe(3n);
    expect(recoveryStatus(L(w.sim), BigInt(READY))).toEqual({ state: 'retired' });
    await expect(w.sim.call('finishRecovery', { time: READY, as: nobody })).rejects.toThrow('recovery cancelled');
    await expect(start(T + 2 * DAY)).rejects.toThrow('recovery key retired');
  });

  it('a settings update before a recovery does not retire the key', async () => {
    const { w, fresh, start } = await recoverable();
    await updateSettings(w, 'passkey', { ...currentSettings(L(w.sim)), guardianThreshold: 1n }, T);
    expect(recoveryStatus(L(w.sim), BigInt(T))).toEqual({ state: 'idle' });
    await start(T + 60);
    await w.sim.call('finishRecovery', { time: T + 60 + DELAY, as: nobody });
    await checkIn({ ...w, owner: fresh }, 'wallet', T + 20 * DAY, T + 60 + DELAY);
    expect(L(w.sim).guardianThreshold).toBe(1n);   // the settings survive the change of owner
  });
});
