// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Owner authentication: check-ins and will updates, by passkey (WebAuthn)
// and by wallet (CIP-30 Ed25519). Brief §7.1 "Auth" and "Will update".

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { Phase } from '@codicil/contracts/vault';
import {
  ApprovalMismatchError,
  buildWill,
  checkHeirLetter,
  checkInDigest,
  claimPackage,
  FLAG_UP,
  newSalt,
  VAULT_EVENTS,
  vaultEventName,
} from '@codicil/sdk';
import { eventBytes } from './support/harness.js';
import {
  approve,
  asClaimant,
  checkIn,
  DAY,
  deployVault,
  FIRST_DEADLINE,
  L,
  MAX_PERIOD,
  newOwner,
  newPerson,
  newRecipient,
  nobody,
  release,
  T0,
  updateWill,
  type Via,
  type World,
} from './support/world.js';

const VIAS: Via[] = ['passkey', 'wallet'];

describe.each(VIAS)('owner check-in via %s', (via) => {
  let w: World;
  beforeEach(async () => {
    w = await deployVault();
  });

  it('extends the deadline and bumps the nonce', async () => {
    const next = T0 + 20 * DAY;
    await checkIn(w, via, next, T0);
    expect(L(w.sim).deadline).toBe(BigInt(next));
    expect(L(w.sim).nonce).toBe(1n);
    await checkIn(w, via, next + DAY, T0 + DAY);
    expect(L(w.sim).nonce).toBe(2n);
  });

  it('rejects a replayed approval (old nonce)', async () => {
    const next = T0 + 20 * DAY;
    const oldDigest = checkInDigest(w.sim.address, BigInt(next), 0n);
    await checkIn(w, via, next, T0);
    const msg = via === 'passkey' ? 'passkey signed something else' : 'wallet signed something else';
    await expect(checkIn(w, via, next, T0, { digest: oldDigest })).rejects.toThrow(msg);
    expect(L(w.sim).nonce).toBe(1n);
  });

  it('rejects an approval for a different deadline', async () => {
    const other = checkInDigest(w.sim.address, BigInt(T0 + 29 * DAY), 0n);
    const msg = via === 'passkey' ? 'passkey signed something else' : 'wallet signed something else';
    await expect(checkIn(w, via, T0 + 20 * DAY, T0, { digest: other })).rejects.toThrow(msg);
  });

  it('rejects an approval bound to another vault', async () => {
    const elsewhere = await deployVault({ owner: w.owner });
    const foreign = checkInDigest(elsewhere.sim.address, BigInt(T0 + 20 * DAY), 0n);
    const msg = via === 'passkey' ? 'passkey signed something else' : 'wallet signed something else';
    await expect(checkIn(w, via, T0 + 20 * DAY, T0, { digest: foreign })).rejects.toThrow(msg);
  });

  it('rejects a key that does not open the owner commitment', async () => {
    await expect(checkIn(w, via, T0 + 20 * DAY, T0, { signer: newOwner() })).rejects.toThrow('unknown owner key');
  });

  it('rejects a forged signature from the right key', async () => {
    const next = BigInt(T0 + 20 * DAY);
    const digest = checkInDigest(w.sim.address, next, 0n);
    const state = approve(w, via, digest);
    if (via === 'passkey') state.passkey!.approval!.proof.sig.s ^= 1n;
    else state.wallet!.approval!.proof.sig.s ^= 1n;
    const circuit = via === 'passkey' ? 'checkInPasskey' : 'checkInEd25519';
    await expect(w.sim.call(circuit, { time: T0, as: state }, next)).rejects.toThrow('bad owner signature');
  });

  it('rejects deadlines in the past or more than maxPeriod from now', async () => {
    await expect(checkIn(w, via, T0 - 1, T0)).rejects.toThrow('deadline must be in the future');
    await expect(checkIn(w, via, T0, T0)).rejects.toThrow('deadline must be in the future');
    await expect(checkIn(w, via, T0 + MAX_PERIOD + 1, T0)).rejects.toThrow('deadline too far');
    await checkIn(w, via, T0 + MAX_PERIOD, T0);   // exactly the limit is fine
  });

  it('cannot chain check-ins to push the deadline beyond now + maxPeriod', async () => {
    await checkIn(w, via, T0 + MAX_PERIOD, T0);
    await expect(checkIn(w, via, T0 + MAX_PERIOD + DAY, T0 + 1)).rejects.toThrow('deadline too far');
    await checkIn(w, via, T0 + MAX_PERIOD + DAY, T0 + DAY);   // a day later, a day further
  });

  it('handles a maxPeriod longer than the deadline itself', async () => {
    const v = await deployVault({ config: { maxPeriod: 2n ** 40n } });
    await checkIn(v, via, T0 + 1000 * DAY, T0);
    expect(L(v.sim).deadline).toBe(BigInt(T0 + 1000 * DAY));
  });

  it('rejects a check-in after the switch expired while armed', async () => {
    await expect(checkIn(w, via, FIRST_DEADLINE + DAY, FIRST_DEADLINE)).rejects.toThrow('switch already expired');
  });

  it('vetoes a trigger during the challenge window', async () => {
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
    expect(L(w.sim).phase).toBe(Phase.pending);
    const t = FIRST_DEADLINE + DAY;
    await checkIn(w, via, t + 10 * DAY, t);
    expect(L(w.sim).phase).toBe(Phase.armed);
    expect(L(w.sim).deadline).toBe(BigInt(t + 10 * DAY));
  });

  it('cannot check in once released', async () => {
    await release(w);
    await expect(checkIn(w, via, FIRST_DEADLINE + 30 * DAY, FIRST_DEADLINE + 8 * DAY))
      .rejects.toThrow('vault already released');
  });
});

describe('passkey specifics', () => {
  let w: World;
  beforeEach(async () => {
    w = await deployVault();
  });

  it("accepts Chrome's long clientDataJSON form", async () => {
    await checkIn(w, 'passkey', T0 + 20 * DAY, T0, { passkey: { chromeLongForm: true } });
    expect(L(w.sim).nonce).toBe(1n);
  });

  it('rejects a passkey created for another website', async () => {
    await expect(checkIn(w, 'passkey', T0 + 20 * DAY, T0, { passkey: { rpId: 'evil.example' } }))
      .rejects.toThrow('passkey is for another site');
  });

  it('requires user verification (Face ID / Touch ID), not just presence', async () => {
    await expect(checkIn(w, 'passkey', T0 + 20 * DAY, T0, { passkey: { flags: FLAG_UP } }))
      .rejects.toThrow('passkey user not verified');
  });

  // The two format checks of the WebAuthn module, reached by handing the
  // circuit a malformed assertion directly, as a hostile client would.
  const malformed = (edit: (clientData: Uint8Array) => void) => {
    const next = BigInt(T0 + 20 * DAY);
    const state = approve(w, 'passkey', checkInDigest(w.sim.address, next, 0n));
    edit(state.passkey!.approval!.proof.clientData);
    return w.sim.call('checkInPasskey', { time: T0, as: state }, next);
  };

  it('rejects client data that is not a WebAuthn assertion', async () => {
    // Byte 0 is the opening brace of {"type":"webauthn.get","challenge":"
    await expect(malformed((cd) => { cd[0] = 0x5b; })).rejects.toThrow('bad passkey data');
  });

  it('rejects a challenge that is not base64url', async () => {
    // The challenge starts at byte 36; "!" is outside the base64url alphabet.
    await expect(malformed((cd) => { cd[36] = 0x21; })).rejects.toThrow('bad passkey challenge');
  });
});

describe('wallet specifics', () => {
  it('rejects a signature that is not in the CIP-30 wallet format', async () => {
    const w = await deployVault();
    const next = BigInt(T0 + 20 * DAY);
    const state = approve(w, 'wallet', checkInDigest(w.sim.address, next, 0n));
    // Byte 0 is the CBOR array header of the COSE Sig_structure.
    state.wallet!.approval!.proof.sigStructure[0] ^= 0xff;
    await expect(w.sim.call('checkInEd25519', { time: T0, as: state }, next)).rejects.toThrow('not a wallet signature');
  });
});

describe('vaults with only one owner key', () => {
  it('rejects wallet check-ins when only a passkey is registered', async () => {
    const w = await deployVault({ config: { ownerEdCommit: new Uint8Array(32) } });
    await checkIn(w, 'passkey', T0 + 20 * DAY, T0);
    await expect(checkIn(w, 'wallet', T0 + 21 * DAY, T0)).rejects.toThrow('unknown owner key');
  });

  it('rejects passkey check-ins when only a wallet is registered', async () => {
    const w = await deployVault({ config: { ownerPasskeyCommit: new Uint8Array(32) } });
    await checkIn(w, 'wallet', T0 + 20 * DAY, T0);
    await expect(checkIn(w, 'passkey', T0 + 21 * DAY, T0)).rejects.toThrow('unknown owner key');
  });

  it('refuses to create a vault with no owner key at all', async () => {
    const zero = new Uint8Array(32);
    await expect(deployVault({ config: { ownerPasskeyCommit: zero, ownerEdCommit: zero } }))
      .rejects.toThrow('vault needs an owner key');
  });

  it('refuses zero-length periods', async () => {
    await expect(deployVault({ config: { challengeWindow: 0n } })).rejects.toThrow('invalid vault settings');
    await expect(deployVault({ config: { maxPeriod: 0n } })).rejects.toThrow('invalid vault settings');
  });
});

describe('SDK witnesses in strict mode (as the app runs them)', () => {
  it('refuse an approval for another digest before any proof is attempted', async () => {
    const w = await deployVault({ strictWitnesses: true });
    const wrong = checkInDigest(w.sim.address, BigInt(T0 + 29 * DAY), 0n);
    const next = BigInt(T0 + 20 * DAY);
    const state = approve(w, 'passkey', wrong, { digest: wrong });
    await expect(w.sim.call('checkInPasskey', { time: T0, as: state }, next)).rejects.toThrow(ApprovalMismatchError);
    await checkIn(w, 'passkey', next, T0);
  });

  it('explain which secret is missing', async () => {
    const w = await deployVault({ strictWitnesses: true });
    await expect(w.sim.call('checkInPasskey', { time: T0, as: nobody }, BigInt(T0 + DAY)))
      .rejects.toThrow('this device has no passkey for this vault');
  });
});

describe.each(VIAS)('will update via %s', (via) => {
  let w: World;
  beforeEach(async () => {
    w = await deployVault();
  });

  it('replaces the will: new heirs can claim, old leaves cannot', async () => {
    const newcomer = newPerson();
    const next = buildWill([{ heir: { pk: newcomer.key.pk, salt: newcomer.keySalt }, shareBps: 10_000n }]);
    await updateWill(w, via, next.root, T0);
    expect(L(w.sim).willRoot).toBe(next.root);
    expect(L(w.sim).willVersion).toBe(1n);
    expect(L(w.sim).nonce).toBe(1n);

    await w.sim.call('deposit', { time: T0, as: nobody }, 1000n);
    await release(w);
    const t = FIRST_DEADLINE + 8 * DAY;
    await expect(w.sim.call('claim', { time: t, as: asClaimant(w.will, 0, w.heirs[0]) }, newRecipient().address))
      .rejects.toThrow('not in will');
    await w.sim.call('claim', { time: t, as: asClaimant(next, 0, newcomer) }, newRecipient().address);
  });

  it("emits a notice so heirs' apps know their letters are out of date", async () => {
    const letter = { vault: w.sim.address, ...claimPackage(w.will, 0) };
    const current = () => ({ vault: w.sim.address, willRoot: L(w.sim).willRoot });
    expect(checkHeirLetter(letter, current()).inCurrentWill).toBe(true);

    // The same heirs and shares still make a new tree, so every old letter is stale.
    const next = buildWill([{ heir: { pk: w.heirs[0].key.pk, salt: w.heirs[0].keySalt }, shareBps: 5000n }]);
    const r = await updateWill(w, via, next.root, T0);
    expect(r.events.map(vaultEventName)).toEqual([VAULT_EVENTS.willChanged]);
    expect(checkHeirLetter(letter, current()).inCurrentWill).toBe(false);
    // The event is only a name: no root, no version, nothing about the will.
    expect(eventBytes(r.events[0])).toEqual(new TextEncoder().encode(VAULT_EVENTS.willChanged));

    // A check-in is not a will change.
    expect((await checkIn(w, via, T0 + 20 * DAY, T0)).events).toEqual([]);
  });

  it('rejects a replayed or mismatched will approval', async () => {
    const root = buildWill([{ heir: { pk: w.heirs[0].key.pk, salt: newSalt() }, shareBps: 1n }]).root;
    await updateWill(w, via, root, T0);
    const msg = via === 'passkey' ? 'passkey signed something else' : 'wallet signed something else';
    await expect(updateWill(w, via, root, T0, { digest: randomBytes(32) })).rejects.toThrow(msg);
  });

  it('cannot use a check-in approval to change the will', async () => {
    const digest = checkInDigest(w.sim.address, BigInt(T0 + 20 * DAY), 0n);
    const msg = via === 'passkey' ? 'passkey signed something else' : 'wallet signed something else';
    await expect(updateWill(w, via, 123n, T0, { digest })).rejects.toThrow(msg);
  });

  it('rejects an update from someone else', async () => {
    await expect(updateWill(w, via, 123n, T0, { signer: newOwner() })).rejects.toThrow('unknown owner key');
  });

  it('is locked once the countdown starts, and after expiry', async () => {
    await expect(updateWill(w, via, 123n, FIRST_DEADLINE)).rejects.toThrow('switch already expired');
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
    await expect(updateWill(w, via, 123n, FIRST_DEADLINE + DAY)).rejects.toThrow('will locked');
  });
});
