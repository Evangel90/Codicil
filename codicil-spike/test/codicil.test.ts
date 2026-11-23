// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Simulator tests for the Phase 0 spike. Each test names the validation gate
// it provides evidence for (see docs/VALIDATION.md).

import { beforeEach, describe, expect, it } from 'vitest';
import {
  encodeRawTokenType,
  encodeUserAddress,
  sampleRawTokenType,
  sampleUserAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract,
  Phase,
  ledger,
  pureCircuits,
  type HeirLeaf,
} from '../contracts/managed/codicil_spike/contract/index.js';
import { containsAscii, eventBytes, Simulator, unshieldedPaidTo, unshieldedReceived } from './harness.js';
import { newEdKey, newHeirKey, newP256Key, salt, WillTree } from './crypto.js';
import { witnesses, type HeirSecrets, type OwnerSecrets, type SpikePrivateState } from './witnesses.js';

const CONTRACT_DIR = new URL('../contracts/managed/codicil_spike', import.meta.url).pathname;
const DAY = 86_400;
const T0 = 1_800_000_000;            // "now" at deployment, seconds
const FIRST_DEADLINE = T0 + 10 * DAY;
const MAX_PERIOD = 30 * DAY;
const CHALLENGE = 7 * DAY;
const LOCKED_UNTIL = T0 + 400 * DAY; // tranche for heir #2

type Sim = Simulator<SpikePrivateState>;

interface World {
  sim: Sim;
  owner: OwnerSecrets;
  heirs: HeirSecrets[];
  outsider: HeirSecrets;
  color: Uint8Array;
}

function makeOwner(): OwnerSecrets {
  return { passkey: newP256Key(), passkeySalt: salt(), ed: newEdKey(), edSalt: salt() };
}

function makeHeir(shareBps: bigint, unlockAt: bigint): Omit<HeirSecrets, 'path'> {
  const key = newHeirKey();
  const keySalt = salt();
  const leaf: HeirLeaf = {
    heirKeyCommit: pureCircuits.edKeyCommitment(key.pk, keySalt),
    shareBps,
    unlockAt,
    salt: salt(),
  };
  return { leaf, key, keySalt };
}

async function deploy(): Promise<World> {
  const owner = makeOwner();
  const drafts = [
    makeHeir(5000n, 0n),
    makeHeir(3333n, 0n),
    makeHeir(1667n, BigInt(LOCKED_UNTIL)),
  ];
  const tree = new WillTree(drafts.map((h) => pureCircuits.heirLeafHash(h.leaf)));
  const heirs = drafts.map((h, i) => ({ ...h, path: tree.pathFor(i) }));

  // Someone with a well-formed leaf that was never put in the will.
  const stray = makeHeir(10_000n, 0n);
  const strayTree = new WillTree([pureCircuits.heirLeafHash(stray.leaf)]);
  const outsider = { ...stray, path: strayTree.pathFor(0) };

  const color = encodeRawTokenType(sampleRawTokenType());
  const sim = await Simulator.deploy<SpikePrivateState>(
    new Contract(witnesses),
    {},
    pureCircuits.passkeyCommitment(owner.passkey.pk, owner.passkeySalt),
    pureCircuits.edKeyCommitment(owner.ed.pk, owner.edSalt),
    tree.root,
    BigInt(FIRST_DEADLINE),
    BigInt(MAX_PERIOD),
    BigInt(CHALLENGE),
    color,
  );
  sim.withProofChecks(CONTRACT_DIR);
  return { sim, owner, heirs, outsider, color };
}

const L = (sim: Sim) => ledger(sim.ledgerState);
const asOwner = (o: OwnerSecrets): SpikePrivateState => ({ owner: o });
const asHeir = (h: HeirSecrets): SpikePrivateState => ({ heir: h });
const nobody: SpikePrivateState = {};

function newRecipient() {
  const hex = sampleUserAddress();
  return { hex, address: { bytes: encodeUserAddress(hex) } };
}

/** Drive the vault to `released` via the timeout path; returns release time. */
async function release(sim: Sim): Promise<number> {
  await sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
  const t = FIRST_DEADLINE + CHALLENGE;
  await sim.call('finalizeRelease', { time: t, as: nobody });
  return t;
}

describe('Codicil spike', () => {
  let w: World;
  beforeEach(async () => {
    w = await deploy();
  });

  it('deploys armed, storing only commitments and a Merkle root [V2]', () => {
    const l = L(w.sim);
    expect(l.phase).toBe(Phase.armed);
    expect(l.deadline).toBe(BigInt(FIRST_DEADLINE));
    expect(l.nonce).toBe(0n);
    expect(l.ownerPasskeyCommit).toEqual(
      pureCircuits.passkeyCommitment(w.owner.passkey.pk, w.owner.passkeySalt),
    );
    expect(l.claimNullifiers.isEmpty()).toBe(true);
  });

  it('accepts deposits and records the unshielded input [V10]', async () => {
    const r1 = await w.sim.call('deposit', { time: T0, as: nobody }, 600n);
    expect(unshieldedReceived(r1.effects)).toBe(600n);
    await w.sim.call('deposit', { time: T0, as: nobody }, 400n);
    expect(L(w.sim).estateTotal).toBe(1000n);
  });

  it('extends the deadline with a passkey (P-256) check-in', async () => {
    const next = BigInt(T0 + 20 * DAY);
    await w.sim.call('checkInPasskey', { time: T0, as: asOwner(w.owner) }, next);
    expect(L(w.sim).deadline).toBe(next);
    expect(L(w.sim).nonce).toBe(1n);
  });

  it('extends the deadline with an Ed25519 check-in', async () => {
    const next = BigInt(T0 + 25 * DAY);
    await w.sim.call('checkInEd25519', { time: T0, as: asOwner(w.owner) }, next);
    expect(L(w.sim).deadline).toBe(next);
    expect(L(w.sim).nonce).toBe(1n);
  });

  it('rejects a check-in from a key that does not open the commitment', async () => {
    const attacker = makeOwner();
    const next = BigInt(T0 + 20 * DAY);
    await expect(w.sim.call('checkInPasskey', { time: T0, as: asOwner(attacker) }, next))
      .rejects.toThrow('unknown owner key');
    await expect(w.sim.call('checkInEd25519', { time: T0, as: asOwner(attacker) }, next))
      .rejects.toThrow('unknown owner key');
  });

  it('rejects a signature over the wrong digest (replay / tamper)', async () => {
    const next = BigInt(T0 + 20 * DAY);
    const tampered = asOwner({ ...w.owner, tamperSignature: true });
    await expect(w.sim.call('checkInPasskey', { time: T0, as: tampered }, next))
      .rejects.toThrow('bad owner signature');
    await expect(w.sim.call('checkInEd25519', { time: T0, as: tampered }, next))
      .rejects.toThrow('bad owner signature');
    expect(L(w.sim).nonce).toBe(0n);
  });

  it('rejects deadlines in the past or beyond maxPeriod', async () => {
    const o = asOwner(w.owner);
    await expect(w.sim.call('checkInPasskey', { time: T0, as: o }, BigInt(T0 - 1)))
      .rejects.toThrow('deadline must be in the future');
    await expect(w.sim.call('checkInPasskey', { time: T0, as: o }, BigInt(FIRST_DEADLINE + MAX_PERIOD + 1)))
      .rejects.toThrow('deadline too far');
  });

  it('rejects a check-in after the switch expired while armed', async () => {
    await expect(w.sim.call('checkInPasskey', { time: FIRST_DEADLINE, as: asOwner(w.owner) }, BigInt(FIRST_DEADLINE + DAY)))
      .rejects.toThrow('switch already expired');
  });

  it('only times out once the deadline has passed', async () => {
    await expect(w.sim.call('triggerTimeout', { time: FIRST_DEADLINE - 1, as: nobody }))
      .rejects.toThrow('owner is still alive');
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
    expect(L(w.sim).phase).toBe(Phase.pending);
    expect(L(w.sim).pendingUntil).toBe(BigInt(FIRST_DEADLINE + CHALLENGE));
  });

  it('lets the owner veto during the challenge window', async () => {
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
    const t = FIRST_DEADLINE + DAY;
    await w.sim.call('checkInPasskey', { time: t, as: asOwner(w.owner) }, BigInt(t + 10 * DAY));
    expect(L(w.sim).phase).toBe(Phase.armed);
    await expect(w.sim.call('finalizeRelease', { time: t + CHALLENGE, as: nobody }))
      .rejects.toThrow('not pending');
  });

  it('releases after the challenge window, snapshots the estate and emits an event [V13]', async () => {
    await w.sim.call('deposit', { time: T0, as: nobody }, 1_000_001n);
    await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
    await expect(w.sim.call('finalizeRelease', { time: FIRST_DEADLINE + CHALLENGE - 1, as: nobody }))
      .rejects.toThrow('challenge window open');
    const r = await w.sim.call('finalizeRelease', { time: FIRST_DEADLINE + CHALLENGE, as: nobody });
    const l = L(w.sim);
    expect(l.phase).toBe(Phase.released);
    expect(l.estateSnapshot).toBe(1_000_001n);
    expect(l.releasedAt).toBe(BigInt(FIRST_DEADLINE + CHALLENGE));
    expect(r.events).toHaveLength(1);
    expect(containsAscii(eventBytes(r.events[0]), 'codicil:released:v1')).toBe(true);
    await expect(w.sim.call('deposit', { time: FIRST_DEADLINE + CHALLENGE, as: nobody }, 1n))
      .rejects.toThrow('vault closed');
  });

  it('rejects claims before release', async () => {
    await expect(w.sim.call('claim', { time: T0, as: asHeir(w.heirs[0]) }, newRecipient().address))
      .rejects.toThrow('vault not released');
  });

  it('pays an heir their exact share via Merkle membership + key proof [V8, V9, V10]', async () => {
    await w.sim.call('deposit', { time: T0, as: nobody }, 1_000_001n);
    const t = await release(w.sim);
    const to = newRecipient();
    const r = await w.sim.call('claim', { time: t, as: asHeir(w.heirs[1]) }, to.address);
    // 3333 bps of 1,000,001 = 333,300.3333 → floor
    expect(unshieldedPaidTo(r.effects, to.hex)).toBe(333_300n);
    expect(L(w.sim).claimNullifiers.size()).toBe(1n);
  });

  it('rejects a second claim of the same leaf', async () => {
    await w.sim.call('deposit', { time: T0, as: nobody }, 1000n);
    const t = await release(w.sim);
    await w.sim.call('claim', { time: t, as: asHeir(w.heirs[0]) }, newRecipient().address);
    await expect(w.sim.call('claim', { time: t, as: asHeir(w.heirs[0]) }, newRecipient().address))
      .rejects.toThrow('already claimed');
  });

  it('rejects someone who is not in the will, or who lacks the heir key [V8]', async () => {
    const t = await release(w.sim);
    await expect(w.sim.call('claim', { time: t, as: asHeir(w.outsider) }, newRecipient().address))
      .rejects.toThrow('not in will');
    const thief = { ...w.heirs[0], key: newHeirKey() };   // knows the leaf, not the key
    await expect(w.sim.call('claim', { time: t, as: asHeir(thief) }, newRecipient().address))
      .rejects.toThrow('not the heir');
  });

  it('keeps a tranche locked until its unlock date', async () => {
    await w.sim.call('deposit', { time: T0, as: nobody }, 10_000n);
    const t = await release(w.sim);
    await expect(w.sim.call('claim', { time: t, as: asHeir(w.heirs[2]) }, newRecipient().address))
      .rejects.toThrow('share still locked');
    const to = newRecipient();
    const r = await w.sim.call('claim', { time: LOCKED_UNTIL, as: asHeir(w.heirs[2]) }, to.address);
    expect(unshieldedPaidTo(r.effects, to.hex)).toBe(1667n);
  });

  it('rejects a witness that lies about the payout quotient [V9]', async () => {
    await w.sim.call('deposit', { time: T0, as: nobody }, 1_000_001n);
    const t = await release(w.sim);
    const greedy = { ...w.heirs[0], inflatePayout: 1n };
    await expect(w.sim.call('claim', { time: t, as: asHeir(greedy) }, newRecipient().address))
      .rejects.toThrow('bad payout math');
  });

  it('never pays out more than the snapshot across all heirs [V9]', async () => {
    const estate = 1_000_001n;
    await w.sim.call('deposit', { time: T0, as: nobody }, estate);
    await release(w.sim);
    let paid = 0n;
    for (const h of w.heirs) {
      const to = newRecipient();
      const r = await w.sim.call('claim', { time: LOCKED_UNTIL, as: asHeir(h) }, to.address);
      paid += unshieldedPaidTo(r.effects, to.hex);
    }
    expect(paid).toBeLessThanOrEqual(estate);
    expect(estate - paid).toBeLessThan(BigInt(w.heirs.length)); // only rounding dust remains
  });
});
