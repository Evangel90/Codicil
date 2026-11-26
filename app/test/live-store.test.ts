// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The live store, on the in-memory chain. This is the same store the web app
// runs on a Midnight network: only the host behind the chain boundary differs.
// Three people are three stores with their own storage, as three browsers are.

import { describe, expect, it } from 'vitest';
import { Phase, type VaultConfig } from '@codicil/contracts/vault';
import type { CreateVaultOptions, DeploymentRecord, VaultChain, VaultHost } from '../src/chain/types.js';
import { MemoryHost } from '../src/demo/chain.js';
import { approveWithPasskey, createDemoPasskey } from '../src/demo/passkey.js';
import { ProofServerDown } from '../src/live/problems.js';
import { decodeRecords, memoryStorage, type OwnerRecord } from '../src/live/records.js';
import {
  DAY, DEPLOY_ALLOWANCE, draftProblems, emptyDraft, LiveStore, MINUTE, TESTING_TIMERS,
  type GuardianView, type HeirView, type OwnerView, type VaultDraft,
} from '../src/live/store.js';

const T0 = 1_800_000_000;
const passkeys = { approve: approveWithPasskey };
const ADDRESS = 'ab'.repeat(32);

const draft = (over: Partial<VaultDraft> = {}): VaultDraft => ({
  ownerName: 'Ngozi Adeyemi',
  heirs: [
    { name: 'Tunde', sharePct: 60, backupName: 'Funke' },
    { name: 'Sade', sharePct: 40 },
  ],
  guardians: ['Dr. Bello', 'Aunt Kemi', 'Mr. Okon'],
  threshold: 2,
  timers: { every: 30 * DAY, window: 14 * DAY, grace: 0, testing: false },
  ...over,
});

function newStore(storage = memoryStorage()) {
  return { store: new LiveStore({ storage, passkeys, rpId: 'localhost' }), storage };
}

async function ownerWithVault(over: Partial<VaultDraft> = {}) {
  const host = new MemoryHost(T0);
  const { store, storage } = newStore();
  await store.attach(host);
  expect(await store.createVault(draft(over), createDemoPasskey())).toBe(true);
  const view = () => store.getSnapshot().active as OwnerView;
  return { host, store, storage, view };
}

async function joined(host: VaultHost, kit: string) {
  const { store, storage } = newStore();
  await store.attach(host);
  await store.join(kit);
  return { store, storage };
}

describe('creating a vault', () => {
  it('seals the will the owner typed and opens the vault', async () => {
    const { view, store } = await ownerWithVault();
    const v = view();
    expect(v.status).toBe('ready');
    expect(v.ownerName).toBe('Ngozi Adeyemi');
    expect(v.heirs.map((h) => [h.name, h.shareBps, h.backupName])).toEqual([['Tunde', 6000n, 'Funke'], ['Sade', 4000n, undefined]]);
    expect(v.guardians.map((g) => g.name)).toEqual(['Dr. Bello', 'Aunt Kemi', 'Mr. Okon']);
    expect(v.vault?.phase).toBe(Phase.armed);
    expect(v.vault?.deadline).toBe(T0 + 30 * DAY);
    expect(v.vault?.guardianThreshold).toBe(2);
    expect(v.checkIn).toBe('onTime');
    expect(store.getSnapshot().deploy).toBeUndefined();
    expect(v.activity[0].what).toMatch(/Vault created/);
  });

  it('gives the first deadline extra room when the timers are minutes long', async () => {
    const { view } = await ownerWithVault({ timers: TESTING_TIMERS });
    expect(view().vault?.deadline).toBe(T0 + TESTING_TIMERS.every + DEPLOY_ALLOWANCE);
    expect(view().vault?.window).toBe(TESTING_TIMERS.window);
  });

  it('works with no guardians at all', async () => {
    const { view } = await ownerWithVault({ guardians: [], threshold: 1 });
    expect(view().vault?.guardianThreshold).toBe(0);
    expect(view().guardians).toEqual([]);
  });

  it('says what is wrong with a draft, one sentence each', () => {
    expect(draftProblems(draft())).toEqual([]);
    expect(draftProblems(emptyDraft()).join(' ')).toMatch(/Add your name/);
    expect(draftProblems(draft({ heirs: [{ name: 'A', sharePct: 70 }, { name: 'B', sharePct: 40 }] })).join(' ')).toMatch(/add up to 110%/);
    expect(draftProblems(draft({ threshold: 4 })).join(' ')).toMatch(/between 1 and 3/);
    expect(draftProblems(draft({ timers: { every: 2 * MINUTE, window: 60, grace: 0, testing: true } }))).toHaveLength(2);
    expect(draftProblems(draft({ heirs: [{ name: '', sharePct: 0 }] })).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps every secret in the record, and nothing leaves through the snapshot', async () => {
    const { storage, view } = await ownerWithVault();
    const [record] = decodeRecords(storage.text) as OwnerRecord[];
    expect(record.heirs[0].sk).toBeTypeOf('bigint');
    expect(record.heirs[0].backup?.keySalt).toBeInstanceOf(Uint8Array);
    expect(record.guardians[0].secret).toHaveLength(32);
    expect(record.leaves).toHaveLength(2);
    expect(record.deployment?.complete).toBe(true);
    expect(JSON.stringify(view(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(record.heirs[0].sk.toString());
  });
});

describe('the whole life of a vault, three people on three devices', () => {
  it('deposit, check-in, guardians, cancel, timeout, release, claims', async () => {
    const { host, store: owner, view } = await ownerWithVault();
    expect(await owner.deposit(25_000_000n)).toBe(true);
    owner.dismissTx();
    expect(view().vault?.estate).toBe(25_000_000n);

    // The heir opens the invitation the owner sent.
    const tunde = await joined(host, owner.heirKit(view().heirs[0].id));
    const tundeView = () => tunde.store.getSnapshot().active as HeirView;
    expect(tundeView()).toMatchObject({ role: 'heir', name: 'Tunde', ownerName: 'Ngozi Adeyemi', shareBps: 6000n, backup: false, status: 'locked' });
    expect(tundeView().amount).toBe(15_000_000n);

    // Two guardians vote; the switch starts early.
    const bello = await joined(host, owner.guardianKit(view().guardians[0].id));
    const kemi = await joined(host, owner.guardianKit(view().guardians[1].id));
    const belloView = () => bello.store.getSnapshot().active as GuardianView;
    expect(belloView()).toMatchObject({ role: 'guardian', name: 'Dr. Bello', current: true, voted: false });
    host.advance(2 * DAY);
    expect(await bello.store.vote()).toBe(true);
    expect(bello.store.getSnapshot().tx?.message).toMatch(/1 of 2 so far/);
    bello.store.dismissTx();
    expect(belloView().voted).toBe(true);
    expect(await bello.store.vote()).toBe(false);
    expect(bello.store.getSnapshot().tx?.problem).toMatchObject({ kind: 'contract', detail: 'already voted' });
    bello.store.dismissTx();
    expect(await kemi.store.vote()).toBe(true);
    kemi.store.dismissTx();
    expect(view().vault?.phase).toBe(Phase.pending);
    expect(tundeView().status).toBe('pending');

    // The owner is alive: one check-in cancels it and starts a new round.
    expect(await owner.checkIn()).toBe(true);
    expect(owner.getSnapshot().tx?.message).toMatch(/switch is cancelled/);
    owner.dismissTx();
    expect(owner.getSnapshot().toast?.title).toMatch(/cancelled/);
    expect(view().vault?.phase).toBe(Phase.armed);
    expect(view().vault?.deadline).toBe(host.now + 30 * DAY);
    expect(belloView().voted).toBe(false);
    expect(view().activity[0].what).toBe('Switch cancelled');

    // Then the owner goes silent. Nobody can start the switch early.
    expect(await tunde.store.startSwitch()).toBe(false);
    expect(tunde.store.getSnapshot().tx?.problem?.body).toMatch(/can be started in 30 days/);
    tunde.store.dismissTx();
    host.advance(30 * DAY + 1);
    expect(view().checkIn).toBe('expired');
    expect(tundeView().vault?.canStartSwitch).toBe(true);
    expect(await tunde.store.startSwitch()).toBe(true);
    tunde.store.dismissTx();
    expect(await tunde.store.release()).toBe(false);
    tunde.store.dismissTx();
    host.advance(14 * DAY + 1);
    expect(tundeView().vault?.canRelease).toBe(true);
    expect(await tunde.store.release()).toBe(true);
    tunde.store.dismissTx();
    expect(tundeView().status).toBe('claimable');
    expect(view().vault?.phase).toBe(Phase.released);

    // The backup heir must wait for the claim window; the heir claims first.
    const funke = await joined(host, owner.heirKit(view().heirs[0].id, true));
    const funkeView = () => funke.store.getSnapshot().active as HeirView;
    expect(funkeView()).toMatchObject({ name: 'Funke', backup: true, status: 'waiting' });
    expect(await tunde.store.claim(ADDRESS)).toBe(true);
    expect(tunde.store.getSnapshot().tx?.message).toMatch(/15 tNIGHT is on its way/);
    tunde.store.dismissTx();
    expect(tundeView()).toMatchObject({ status: 'claimed', claimed: { amount: 15_000_000n, to: ADDRESS } });
    expect(funkeView().status).toBe('taken');
    expect(view().vault?.estatePaid).toBe(15_000_000n);

    // The other heir claims the rest; a second claim is refused.
    const sade = await joined(host, owner.heirKit(view().heirs[1].id));
    expect(await sade.store.claim('cd'.repeat(32))).toBe(true);
    sade.store.dismissTx();
    expect(await sade.store.claim('cd'.repeat(32))).toBe(false);
    expect(view().vault?.estate).toBe(0n);
  });

  it('a late owner starts the switch and cancels it, as the contract allows', async () => {
    const { host, store, view } = await ownerWithVault({ guardians: [], threshold: 1 });
    host.advance(30 * DAY + 60);
    expect(await store.checkIn()).toBe(false);
    expect(store.getSnapshot().tx?.problem?.body).toMatch(/Start the switch, then check in to cancel it/);
    store.dismissTx();
    expect(await store.startSwitch()).toBe(true);
    store.dismissTx();
    expect(await store.checkIn()).toBe(true);
    expect(view().vault?.phase).toBe(Phase.armed);
  });

  it('a backup heir can claim once the first heir has let the claim window pass', async () => {
    const { host, store, view } = await ownerWithVault({ guardians: [], threshold: 1, timers: TESTING_TIMERS });
    await store.deposit(1_000_000n);
    store.dismissTx();
    host.advance(TESTING_TIMERS.every + DEPLOY_ALLOWANCE);
    await store.startSwitch();
    store.dismissTx();
    host.advance(TESTING_TIMERS.window);
    await store.release();
    store.dismissTx();
    const funke = await joined(host, store.heirKit(view().heirs[0].id, true));
    expect(await funke.store.claim(ADDRESS)).toBe(false);
    expect(funke.store.getSnapshot().tx?.problem?.body).toMatch(/You are the backup for this share/);
    funke.store.dismissTx();
    host.advance(10 * MINUTE);
    expect((funke.store.getSnapshot().active as HeirView).status).toBe('claimable');
    expect(await funke.store.claim(ADDRESS)).toBe(true);
  });
});

describe('what survives a reload', () => {
  it('a new store on the same storage finds the vault and reads it again', async () => {
    const { host, storage, store } = await ownerWithVault();
    await store.deposit(3_000_000n);
    const again = new LiveStore({ storage, passkeys, rpId: 'localhost' });
    expect(again.getSnapshot().records).toHaveLength(1);
    expect(again.getSnapshot().active).toMatchObject({ role: 'owner', status: 'ready', vault: undefined });
    await again.attach(host);
    const v = again.getSnapshot().active as OwnerView;
    expect(v.vault?.estate).toBe(3_000_000n);
    expect(v.activity.map((a) => a.what)).toEqual(['Deposit of 3 tNIGHT', 'Vault created and will sealed']);
    expect(await again.checkIn()).toBe(true);
  });

  it('refuses to read a vault from the wrong network, and says which one it is on', async () => {
    const { storage } = await ownerWithVault();
    const elsewhere: VaultHost = Object.assign(new MemoryHost(T0), { networkId: 'preview' });
    const again = new LiveStore({ storage, passkeys });
    await again.attach(elsewhere);
    expect(again.getSnapshot().load).toMatchObject({ state: 'error', problem: { kind: 'wrong-network' } });
    expect(again.getSnapshot().load.problem).toMatchObject({ title: 'This vault is on Memory' });
    expect(again.getSnapshot().load.problem?.body).toMatch(/created on Midnight Memory.*wallet is on Preview/);
  });

  it('forgetting a vault removes it from this device only', async () => {
    const { host, store, view } = await ownerWithVault();
    const heir = await joined(host, store.heirKit(view().heirs[1].id));
    heir.store.forget(heir.store.getSnapshot().activeId!);
    expect(heir.store.getSnapshot().records).toEqual([]);
    expect(decodeRecords(heir.storage.text)).toEqual([]);
    expect(view().vault?.phase).toBe(Phase.armed);
  });
});

/** A host whose deployments stop part-way, as a closed tab or a declined approval would stop them. */
class InterruptedHost extends MemoryHost {
  failures = 1;
  resumedWith: (DeploymentRecord | undefined)[] = [];
  proofServerUp = true;

  override async preflight(): Promise<void> {
    if (!this.proofServerUp) throw new ProofServerDown('http://localhost:6300');
  }

  override async createVault(config: VaultConfig, options: CreateVaultOptions) {
    this.resumedWith.push(options.resume);
    if (this.failures > 0) {
      this.failures--;
      const chain = await super.createVault(config, { onRecord: () => {} });
      options.onStage?.({ step: 'deploy', total: 8 });
      // The deploy transaction landed and two circuits were added, then the approval was declined.
      await options.onRecord({
        address: chain.address, maintenanceKey: '{"tag":"schnorr","value":"00"}', deferred: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        deployTxHash: 'f0'.repeat(32), inserted: [{ circuit: 'a', txHash: '01' }, { circuit: 'b', txHash: '02' }], complete: false,
      });
      options.onStage?.({ step: 'insert', circuit: 'updateWillPasskey', done: 3, total: 8 });
      throw Object.assign(new Error('User rejected the request'), { type: 'DAppConnectorAPIError', code: 'Rejected', reason: 'User rejected the request' });
    }
    const chain: VaultChain = await this.openVault(options.resume!.address);
    await options.onRecord({ ...options.resume!, inserted: options.resume!.deferred.map((circuit) => ({ circuit, txHash: '03' })), complete: true });
    return chain as Awaited<ReturnType<MemoryHost['createVault']>>;
  }
}

describe('a deployment that is interrupted', () => {
  it('keeps what was typed, says what happened, and continues where it stopped', async () => {
    const host = new InterruptedHost(T0);
    const { store, storage } = newStore();
    await store.attach(host);
    expect(await store.createVault(draft(), createDemoPasskey())).toBe(false);

    const stopped = store.getSnapshot();
    expect(stopped.active).toMatchObject({ role: 'owner', status: 'interrupted', vault: undefined });
    expect(stopped.deploy).toMatchObject({ running: false, done: 3, total: 8, problem: { kind: 'rejected' } });
    expect(stopped.deploy?.label).toBe('Adding the part for changing the will');
    const [saved] = decodeRecords(storage.text) as OwnerRecord[];
    expect(saved.deployment).toMatchObject({ complete: false, deployTxHash: 'f0'.repeat(32) });
    expect(saved.heirs.map((h) => h.name)).toEqual(['Tunde', 'Sade']);
    // No invitations from half a vault.
    expect(() => store.heirKit(saved.heirs[0].id)).toThrow(/finish creating the vault first/);

    // The tab is closed. Later, in a new one:
    const later = new LiveStore({ storage, passkeys, rpId: 'localhost' });
    await later.attach(host);
    expect(later.getSnapshot().active).toMatchObject({ status: 'interrupted' });
    expect(await later.resumeDeployment()).toBe(true);
    expect(host.resumedWith[1]).toMatchObject({ address: saved.deployment!.address, complete: false });
    const done = later.getSnapshot();
    expect(done.deploy).toBeUndefined();
    expect(done.active).toMatchObject({ status: 'ready' });
    expect((done.active as OwnerView).vault?.phase).toBe(Phase.armed);
    // The deadline is the one the vault was deployed with, not a new one.
    expect((decodeRecords(storage.text)[0] as OwnerRecord).firstDeadline).toBe(saved.firstDeadline);
    expect(later.heirKit(saved.heirs[0].id)).toMatch(/^codicil:heir-kit:v1:/);
  });

  it('stops before anything is sent when the proof server is not running', async () => {
    const host = new InterruptedHost(T0);
    host.failures = 0;
    const { store } = newStore();
    await store.attach(host);
    // Deployed on a plain host first, so there is a vault to act on.
    const plain = new MemoryHost(T0);
    await store.attach(plain);
    await store.createVault(draft(), createDemoPasskey());
    Object.assign(plain, { preflight: async () => { throw new ProofServerDown('http://localhost:6300'); } });
    expect(await store.checkIn()).toBe(false);
    const p = store.getSnapshot().tx?.problem;
    expect(p).toMatchObject({ kind: 'proof-server', title: 'Start your proof server', retry: true });
    expect(p?.command).toMatch(/^docker run .*proof-server:9\.0\.2$/);
    // Fixed, and tried again from the same sheet.
    Object.assign(plain, { preflight: async () => {} });
    expect(await store.retry()).toBe(true);
  });
});

describe('invitations', () => {
  it('an invitation can be opened twice without making two records, and a link works too', async () => {
    const { host, store, view } = await ownerWithVault();
    const kit = store.heirKit(view().heirs[0].id);
    const heir = await joined(host, kit);
    await heir.store.join(`https://codicil.example/#/app/join/${kit}`);
    expect(heir.store.getSnapshot().records).toHaveLength(1);
    expect(heir.store.getSnapshot().records[0]).toMatchObject({ role: 'heir', title: "Ngozi Adeyemi's will", subtitle: 'You are an heir' });
  });

  it('one person can hold several vaults, each with its own role', async () => {
    const { host, store, view } = await ownerWithVault();
    await store.join(store.guardianKit(view().guardians[2].id));
    const s = store.getSnapshot();
    expect(s.records.map((r) => r.role)).toEqual(['guardian', 'owner']);
    expect(s.active).toMatchObject({ role: 'guardian', name: 'Mr. Okon', current: true });
    await store.select(s.records[1].id);
    expect(store.getSnapshot().active?.role).toBe('owner');
    void host;
  });

  it('refuses an invitation for another network before saving anything', async () => {
    const { store, view } = await ownerWithVault();
    const kit = store.heirKit(view().heirs[0].id);
    const elsewhere = newStore();
    await elsewhere.store.attach(Object.assign(new MemoryHost(T0), { networkId: 'preprod' }));
    await expect(elsewhere.store.join(kit)).rejects.toThrow(/for a vault on Midnight Memory, and your wallet is on Preprod/);
    expect(elsewhere.store.getSnapshot().records).toEqual([]);
  });
});
