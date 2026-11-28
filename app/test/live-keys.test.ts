// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Live mode without a single point of failure (docs/DECISIONS.md D22), on the
// in-memory chain: records locked under a keyring, the recovery key every
// live vault gets, and heirs and guardians who make their own keys.

import { describe, expect, it } from 'vitest';
import { Phase } from '@codicil/contracts/vault';
import { deriveFromRoot, newRecoveryCode, recoveryCodeToText, recoveryCommitment } from '@codicil/sdk';
import { MemoryHost } from '../src/demo/chain.js';
import { approveWithPasskey, createDemoPasskey } from '../src/demo/passkey.js';
import { toHex } from '../src/live/codec.js';
import { readStored, readWithCode } from '../src/live/keyring.js';
import {
  decodeInvitation, decodeReply, encodeRecords, memoryStorage, type HeirRecord, type OwnerRecord, type VaultRecord,
} from '../src/live/records.js';
import {
  DAY, draftProblems, LiveStore, type GuardianView, type HeirView, type InvitedView, type OwnerView, type VaultDraft,
} from '../src/live/store.js';

const T0 = 1_800_000_000;
const passkeys = { approve: approveWithPasskey };
const ADDRESS = 'ab'.repeat(32);
const TIMERS = { every: 30 * DAY, window: 14 * DAY, grace: 0, testing: false };

/** A browser, set up with its own printed code (and, optionally, a passkey that answers PRF). */
async function browser(host?: MemoryHost, prf?: Uint8Array) {
  const storage = memoryStorage();
  const store = new LiveStore({ storage, passkeys, rpId: 'localhost' });
  const bytes = newRecoveryCode();
  await store.setUp({ code: bytes, ...(prf ? { prf: { secret: prf, prfInput: new Uint8Array(32).fill(7), credentialId: 'c0ffee' } } : {}) });
  if (host) await store.attach(host);
  return { store, storage, code: recoveryCodeToText(bytes) };
}

async function plainOwner(host: MemoryHost) {
  const b = await browser(host);
  const ok = await b.store.createVault({
    ownerName: 'Ngozi', heirs: [{ name: 'Tunde', sharePct: 100 }], guardians: [], threshold: 1, timers: TIMERS,
  }, createDemoPasskey());
  expect(ok).toBe(true);
  return { ...b, view: () => b.store.getSnapshot().active as OwnerView };
}

const ledgerOf = async (host: MemoryHost, address: string) => (await host.openVault(address)).ledger;
const done = (s: LiveStore) => s.dismissTx();

describe('records are locked under the keyring', () => {
  it('nothing readable is stored, a reload is locked, and the code opens it', async () => {
    const host = new MemoryHost(T0);
    const { store, storage, code } = await plainOwner(host);
    await store.saved();
    expect(storage.text).not.toContain('Ngozi');
    expect(storage.text).not.toContain('Tunde');
    expect(readStored(storage.text).kind).toBe('locked');

    const reload = new LiveStore({ storage, passkeys, rpId: 'localhost' });
    expect(reload.getSnapshot().access).toMatchObject({ state: 'locked', code: true, passkeys: [] });
    expect(reload.getSnapshot().records).toEqual([]);
    await expect(reload.createVault({ ownerName: 'x', heirs: [{ name: 'y', sharePct: 1 }], guardians: [], threshold: 1, timers: TIMERS }, createDemoPasskey()))
      .rejects.toThrow(/unlock your records first/);
    await expect(reload.unlock('recovery-code', recoveryCodeToText(newRecoveryCode()))).rejects.toThrow(/does not open this/);
    await expect(reload.unlock('recovery-code', code.slice(0, -1) + (code.endsWith('0') ? '1' : '0'))).rejects.toThrow(/typing mistake/);
    await reload.unlock('recovery-code', code.toLowerCase().replace(/-/g, ' '));
    await reload.attach(host);
    expect(reload.getSnapshot().active).toMatchObject({ role: 'owner', ownerName: 'Ngozi', status: 'ready' });
    expect(await reload.checkIn()).toBe(true);

    // Locking again takes the records out of memory; they stay saved.
    await reload.lock();
    expect(reload.getSnapshot()).toMatchObject({ access: { state: 'locked' }, records: [] });
  });

  it('plain records from before are locked on first set-up, and nothing plain is left', async () => {
    const host = new MemoryHost(T0);
    const old = await plainOwner(host);
    const records = (await readWithCode((await old.store.saved(), old.storage.text!), old.code)).records;
    // A browser from before the keyring: the same records, in plain text.
    const storage = memoryStorage(encodeRecords(records));
    const store = new LiveStore({ storage, passkeys, rpId: 'localhost' });
    expect(store.getSnapshot().access).toMatchObject({ state: 'new', legacy: 1 });
    expect(store.getSnapshot().records).toEqual([]);
    const bytes = newRecoveryCode();
    await store.setUp({ code: bytes });
    await store.saved();
    expect(storage.text).not.toContain('Ngozi');
    expect(store.getSnapshot().access).toMatchObject({ state: 'open', legacy: 0 });
    await store.attach(host);
    expect(await store.checkIn()).toBe(true);
    expect((await readWithCode(storage.text!, recoveryCodeToText(bytes))).records.map((r) => r.id)).toEqual([records[0].id]);
  });

  it('Face ID opens it where the passkey answers, and the code is always there for where it does not', async () => {
    const prf = new Uint8Array(32).fill(42);
    const { store, storage, code } = await browser(undefined, prf);
    expect(store.getSnapshot().access).toMatchObject({ code: true, passkeys: [{ credentialId: 'c0ffee' }] });
    await store.saved();
    const viaPasskey = new LiveStore({ storage, passkeys });
    await expect(viaPasskey.unlock('passkey', new Uint8Array(32).fill(41))).rejects.toThrow(/passkey does not open this. Try your recovery code/);
    await viaPasskey.unlock('passkey', prf);
    expect(viaPasskey.getSnapshot().access.state).toBe('open');

    // A browser or provider without PRF: set up with the code alone, and it works the same.
    const without = await browser();
    expect(without.store.getSnapshot().access).toMatchObject({ state: 'open', passkeys: [], code: true });
    await without.store.saved();
    const again = new LiveStore({ storage: without.storage, passkeys });
    await expect(again.unlock('passkey', prf)).rejects.toThrow(/does not open this/);
    await again.unlock('recovery-code', without.code);
    expect(again.getSnapshot().access.state).toBe('open');
    void code;
  });

  it('a wallet opens it only if it signs the same words the same way twice', async () => {
    const { store, storage } = await browser();
    const sig = new Uint8Array(64).fill(9);
    await store.addWalletSlot(async () => sig, 'mn_addr_test1');
    expect(store.getSnapshot().access.wallet).toBe(true);
    await store.saved();
    const again = new LiveStore({ storage, passkeys });
    await again.unlockWithWallet(async () => sig);
    expect(again.getSnapshot().access.state).toBe('open');

    // BIP-340 signatures with fresh randomness differ each time: such a wallet is refused, not half-added.
    const other = await browser();
    let n = 0;
    await expect(other.store.addWalletSlot(async () => new Uint8Array(64).fill(++n), 'mn_addr_test1')).rejects.toThrow(/signs the same words differently each time/);
    expect(other.store.getSnapshot().access.wallet).toBe(false);
  });
});

describe('every live vault has a recovery key, from the owner\'s root', () => {
  it('is set at creation, and its commitment is the one the root gives', async () => {
    const host = new MemoryHost(T0);
    const { store, view } = await plainOwner(host);
    const l = await ledgerOf(host, view().vault!.address);
    expect(l.recoveryKeyCommit.some((b) => b !== 0)).toBe(true);
    expect(l.recoveryDelay).toBe(7n * BigInt(DAY));
    expect(view().recovery).toMatchObject({ state: 'idle', delay: 7 * DAY, mine: false });
    // The secret is rebuilt, never stored: the record holds no recovery secret.
    const root = (store as unknown as { root: Uint8Array }).root;
    const id = (store.getSnapshot().active as OwnerView).id;
    expect(toHex(recoveryCommitment(deriveFromRoot(root, `vault-recovery:${id}`)))).toBe(toHex(l.recoveryKeyCommit));
  });

  it('the printed code and the backup file replace a lost passkey on a new device', async () => {
    const host = new MemoryHost(T0);
    const old = await plainOwner(host);
    const file = await old.store.exportBackup();

    // The old device is gone. A new one, with fresh storage, has the file and the paper.
    const fresh = new LiveStore({ storage: memoryStorage(), passkeys, rpId: 'localhost' });
    await fresh.attach(host);
    await fresh.importBackup(file, { kind: 'recovery-code', secret: old.code });
    const view = () => fresh.getSnapshot().active as OwnerView;
    expect(view()).toMatchObject({ role: 'owner', status: 'ready', recovery: { state: 'idle' } });

    const newPasskey = createDemoPasskey();
    expect(await fresh.startRecovery(newPasskey)).toBe(true);
    expect(fresh.getSnapshot().tx?.message).toMatch(/Recovery started/);
    done(fresh);
    expect(view().recovery).toMatchObject({ state: 'waiting', mine: true, readyAt: host.now + 7 * DAY });
    // The old device, if it were still around, would be warned: the recovery is not its own.
    expect((old.store.getSnapshot().active as OwnerView).recovery).toMatchObject({ state: 'waiting', mine: false });

    expect(await fresh.finishRecovery()).toBe(false);
    expect(fresh.getSnapshot().tx?.problem?.body).toMatch(/can be finished in 7 days/);
    done(fresh);
    host.advance(7 * DAY);
    expect(await fresh.finishRecovery()).toBe(true);
    expect(fresh.getSnapshot().tx?.message).toMatch(/passkey on this device now owns the vault/);
    done(fresh);

    // The new passkey checks in; the old one no longer can.
    expect(await fresh.checkIn()).toBe(true);
    done(fresh);
    expect(await old.store.checkIn()).toBe(false);
    expect(old.store.getSnapshot().tx?.problem?.body).toMatch(/A recovery replaced it/);
    done(old.store);
    // The vault now holds the next recovery key, which the same root still rebuilds.
    expect(view().recovery?.state).toBe('idle');
    const rec = (await readWithCode((await fresh.saved(), (fresh as unknown as { deps: { storage: { text: string } } }).deps.storage.text), old.code)).records[0] as OwnerRecord;
    expect(rec.recoveryGeneration).toBe(1);
    expect(rec.pendingRecovery).toBeUndefined();
  });

  it('a check-in from the current passkey cancels a recovery, and retires the key', async () => {
    const host = new MemoryHost(T0);
    const owner = await plainOwner(host);
    const thief = new LiveStore({ storage: memoryStorage(), passkeys, rpId: 'localhost' });
    await thief.attach(host);
    await thief.importBackup(await owner.store.exportBackup(), { kind: 'recovery-code', secret: owner.code });
    expect(await thief.startRecovery(createDemoPasskey())).toBe(true);
    done(thief);
    expect(await owner.store.checkIn()).toBe(true);
    expect(owner.store.getSnapshot().tx?.message).toMatch(/cancelled the recovery/);
    done(owner.store);
    expect(owner.view().recovery?.state).toBe('retired');
    host.advance(7 * DAY);
    expect(await thief.finishRecovery()).toBe(false);
    expect(thief.getSnapshot().tx?.problem?.body).toMatch(/cancelled it/);
    done(thief);
    expect(await thief.startRecovery(createDemoPasskey())).toBe(false);
    expect(thief.getSnapshot().tx?.problem?.body).toMatch(/retired the recovery key for good/);
  });

  it('with testing timers the key is set, and the app says a recovery cannot finish in time', async () => {
    const host = new MemoryHost(T0);
    const b = await browser(host);
    await b.store.createVault({
      ownerName: 'Ngozi', heirs: [{ name: 'Tunde', sharePct: 100 }], guardians: [], threshold: 1,
      timers: { every: 600, window: 180, grace: 0, testing: true },
    }, createDemoPasskey());
    const v = b.store.getSnapshot().active as OwnerView;
    expect(v.recovery).toMatchObject({ state: 'idle', delay: DAY });
    expect(v.recovery!.lastStart).toBeLessThan(host.now);
    expect(await b.store.startRecovery(createDemoPasskey())).toBe(false);
    expect(b.store.getSnapshot().tx?.problem?.body).toMatch(/could not finish in time/);
  });
});

describe('heirs and guardians make their own keys', () => {
  async function family() {
    const host = new MemoryHost(T0);
    const owner = await browser(host);
    const people = {
      tunde: await browser(host), funke: await browser(host), sade: await browser(host),
      bello: await browser(host), kemi: await browser(host),
    };
    const ask = async (who: { store: LiveStore }, role: 'heir' | 'guardian', name: string, backup = false) => {
      const invitation = owner.store.makeInvitation(role, name, 'Ngozi Adeyemi', backup);
      // The invitation holds no secret: an id, who is asking, the network, the role.
      expect(Object.keys(decodeInvitation(invitation)!).sort()).toEqual(['backup', 'id', 'kind', 'name', 'network', 'ownerName', 'role']);
      await who.store.join(invitation);
      const v = who.store.getSnapshot().active as InvitedView;
      expect(v).toMatchObject({ role: 'invited', name, ownerName: 'Ngozi Adeyemi', invitedAs: role, backup });
      return v.reply;
    };
    const draft: VaultDraft = {
      ownerName: 'Ngozi Adeyemi', keys: 'theirs', timers: TIMERS, threshold: 2,
      heirs: [
        { name: 'Tunde', sharePct: 60, backupName: 'Funke', reply: await ask(people.tunde, 'heir', 'Tunde'), backupReply: await ask(people.funke, 'heir', 'Funke', true) },
        { name: 'Sade', sharePct: 40, reply: await ask(people.sade, 'heir', 'Sade') },
      ],
      guardians: ['Dr. Bello', 'Aunt Kemi'],
      guardianReplies: [await ask(people.bello, 'guardian', 'Dr. Bello'), await ask(people.kemi, 'guardian', 'Aunt Kemi')],
    };
    return { host, owner, people, draft };
  }

  it('the draft wants a reply for each person, of the right kind, once each', async () => {
    const { draft } = await family();
    expect(draftProblems(draft)).toEqual([]);
    expect(draftProblems({ ...draft, heirs: [{ ...draft.heirs[0], reply: undefined }, draft.heirs[1]] })).toEqual(['Paste the reply from Tunde.']);
    expect(draftProblems({ ...draft, heirs: [{ ...draft.heirs[0], reply: draft.guardianReplies![0] }, draft.heirs[1]] })[0]).toMatch(/answers a guardian's invitation/);
    expect(draftProblems({ ...draft, heirs: [draft.heirs[0], { ...draft.heirs[1], reply: draft.heirs[0].reply }] })[0]).toMatch(/pasted for someone else too/);
    expect(draftProblems({ ...draft, guardianReplies: [draft.guardianReplies![0], 'codicil:reply:v1:AAAA'] })[0]).toMatch(/Aunt Kemi/);
    // The quicker way needs no replies.
    expect(draftProblems({ ...draft, keys: 'mine' })).toEqual([]);
  });

  it('create, check in, guardians vote, release, and each heir claims from their own record', async () => {
    const { host, owner, people, draft } = await family();
    expect(await owner.store.createVault(draft, createDemoPasskey())).toBe(true);
    const view = () => owner.store.getSnapshot().active as OwnerView;
    expect(view().heirs.map((h) => [h.name, h.ownKey, h.backupOwnKey])).toEqual([['Tunde', true, true], ['Sade', true, undefined]]);
    expect(view().guardians.every((g) => g.ownKey)).toBe(true);
    await owner.store.deposit(10_000_000n);
    done(owner.store);

    // The owner holds no heir's key and no guardian's secret: only what the replies carried.
    const [record] = await (async () => { await owner.store.saved(); return (await readWithCode(owner.storage.text!, owner.code)).records as OwnerRecord[]; })();
    for (const h of record.heirs) {
      expect(h.sk).toBeUndefined();
      expect(h.keySalt).toBeUndefined();
      expect(h.backup?.sk).toBeUndefined();
    }
    for (const g of record.guardians) expect(g.secret).toBeUndefined();
    expect(toHex(record.leaves[0].heirKeyCommit)).toBe(toHex(decodeReply(draft.heirs[0].reply!).heirKeyCommit!));
    expect(() => owner.store.heirKit(view().heirs[0].id)).toThrow(/made their own key/);
    expect(() => owner.store.guardianKit(view().guardians[0].id)).toThrow(/made their own secret/);

    // Each person gets a letter sealed to them. Nobody else can open it.
    const letter = {
      tunde: await owner.store.sealedLetter(view().heirs[0].id),
      funke: await owner.store.sealedLetter(view().heirs[0].id, true),
      sade: await owner.store.sealedLetter(view().heirs[1].id),
      bello: await owner.store.sealedLetter(view().guardians[0].id),
      kemi: await owner.store.sealedLetter(view().guardians[1].id),
    };
    await expect(people.sade.store.join(letter.tunde)).rejects.toThrow(/invitation this browser has not seen/);
    for (const [name, text] of Object.entries(letter)) await people[name as keyof typeof people].store.join(text);
    const tunde = () => people.tunde.store.getSnapshot().active as HeirView;
    const funke = () => people.funke.store.getSnapshot().active as HeirView;
    const bello = () => people.bello.store.getSnapshot().active as GuardianView;
    expect(tunde()).toMatchObject({ role: 'heir', name: 'Tunde', shareBps: 6000n, backup: false, status: 'locked', amount: 6_000_000n });
    expect(funke()).toMatchObject({ role: 'heir', name: 'Funke', backup: true, status: 'locked' });
    expect(bello()).toMatchObject({ role: 'guardian', current: true, voted: false });
    // The heir's own record holds no key either: it is rebuilt from their root.
    await people.tunde.store.saved();
    const [mine] = (await readWithCode(people.tunde.storage.text!, people.tunde.code)).records as HeirRecord[];
    expect(mine).toMatchObject({ role: 'heir', inviteId: decodeReply(draft.heirs[0].reply!).inviteId });
    expect(mine.sk).toBeUndefined();

    // A check-in, then guardians vote and the owner stays silent.
    expect(await owner.store.checkIn()).toBe(true);
    done(owner.store);
    expect(await people.bello.store.vote()).toBe(true);
    done(people.bello.store);
    expect(bello().voted).toBe(true);
    expect(await people.kemi.store.vote()).toBe(true);
    done(people.kemi.store);
    expect(tunde().status).toBe('pending');
    host.advance(14 * DAY + 1);
    expect(await people.sade.store.release()).toBe(true);
    done(people.sade.store);
    expect(tunde().status).toBe('claimable');
    expect(funke().status).toBe('waiting');

    expect(await people.tunde.store.claim(ADDRESS)).toBe(true);
    done(people.tunde.store);
    expect(tunde()).toMatchObject({ status: 'claimed', claimed: { amount: 6_000_000n } });
    expect(funke().status).toBe('taken');
    expect(await people.sade.store.claim('cd'.repeat(32))).toBe(true);
    done(people.sade.store);
    expect(view().vault).toMatchObject({ phase: Phase.released, estate: 0n });
  });

  it('a backup file on a new device brings back an heir who made their own key', async () => {
    const { host, owner, people, draft } = await family();
    await owner.store.createVault(draft, createDemoPasskey());
    const view = () => owner.store.getSnapshot().active as OwnerView;
    await people.sade.store.join(await owner.store.sealedLetter(view().heirs[1].id));
    const file = await people.sade.store.exportBackup();
    // Into a browser that already has its own keyring: the record keeps the root it came with.
    const other = await browser(host);
    await other.store.importBackup(file, { kind: 'recovery-code', secret: people.sade.code });
    expect(other.store.getSnapshot().active).toMatchObject({ role: 'heir', name: 'Sade', status: 'locked' });
    const restored = (other.store as unknown as { records: VaultRecord[] }).records[0];
    expect(restored.root).toBeInstanceOf(Uint8Array);
    // And the reply it would send again is the same one.
    expect(other.store.replyFor()).toBe(people.sade.store.replyFor());
  });

  it('a letter that was changed on the way, or for another invitation, is refused', async () => {
    const { owner, people, draft } = await family();
    await owner.store.createVault(draft, createDemoPasskey());
    const view = () => owner.store.getSnapshot().active as OwnerView;
    const text = await owner.store.sealedLetter(view().heirs[1].id);
    const body = text.slice(text.indexOf('v1:') + 3);
    const tampered = text.slice(0, text.length - body.length) + body.slice(0, -6) + (body.endsWith('A') ? 'BBBBBB' : 'AAAAAA');
    await expect(people.sade.store.join(tampered)).rejects.toThrow(/not for you, or it was changed|damaged/);
    expect(people.sade.store.getSnapshot().active?.role).toBe('invited');
  });
});
