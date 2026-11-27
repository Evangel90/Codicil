// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Reading a vault and its seal register from a Midnight network with no
// wallet: only the public ledger, through the network's indexer. Enough to
// read a vault as a signal, to check a copy of a sealed text against the
// register, and, after the release, to rebuild a key from the pieces on the
// ledger and open a public disclosure in the reader's own browser.

import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ledger as sealsLedger } from '@codicil/contracts/seals';
import { ledger as vaultLedger, type Phase } from '@codicil/contracts/vault';
import {
  openMessageText, SealedError, sealedFingerprint, sealedFromText, timeoutOpensAt, type KeyPiece, type SealedMessage,
} from '@codicil/sdk';

export interface Indexer { queryURL: string; subscriptionURL: string }

/** Midnight's Preview test network: its indexer answers without a token. */
export const PREVIEW: Indexer = {
  queryURL: 'https://indexer.preview.midnight.network/api/v4/graphql',
  subscriptionURL: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
};

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const cleanAddress = (text: string): string => text.trim().replace(/^0x/i, '').toLowerCase();
export const looksLikeAddress = (text: string): boolean => /^[0-9a-f]{64}$/.test(cleanAddress(text));

/** What a vault's public ledger says about time: enough to read it as a signal. */
export interface VaultReading {
  address: string;
  phase: Phase;
  deadline: number;
  switchOpensAt: number;
  pendingUntil: number;
  releasedAt: number;
}

export interface RegisterReading {
  address: string;
  /** The vault this register asks, as hex. */
  vault: string;
  seals: { fingerprint: string; needed: number; pieces: number; sealedBefore: number }[];
  handedOver: { seal: string; piece: KeyPiece }[];
  statementFingerprint: string;
}

export type FetchState = (address: string) => Promise<ContractState | undefined>;

/** Fetches a contract's current state from an indexer. */
export function indexerReader(indexer: Indexer = PREVIEW): FetchState {
  const data = indexerPublicDataProvider(indexer);
  return async (address) => {
    const read = await data.queryContractState(address);
    return read ? read.contractState.deserialize({ v9: ContractState }) : undefined;
  };
}

export async function readVault(fetchState: FetchState, address: string): Promise<VaultReading | undefined> {
  const id = cleanAddress(address);
  const state = await fetchState(id);
  if (!state) return undefined;
  const l = vaultLedger(state.data);
  return {
    address: id, phase: l.phase, deadline: Number(l.deadline), switchOpensAt: Number(timeoutOpensAt(l)),
    pendingUntil: Number(l.pendingUntil), releasedAt: Number(l.releasedAt),
  };
}

export async function readRegister(fetchState: FetchState, address: string): Promise<RegisterReading | undefined> {
  const id = cleanAddress(address);
  const state = await fetchState(id);
  if (!state) return undefined;
  const l = sealsLedger(state.data);
  const seals = [...l.seals].map(([fp, seal]) => ({ fingerprint: hex(fp), needed: Number(seal.needed), pieces: Number(seal.pieces), sealedBefore: Number(seal.sealedBefore) }));
  return {
    address: id,
    vault: hex(l.vault.bytes),
    seals,
    handedOver: [...l.handedOver].map(([, p]) => ({ seal: hex(p.seal), piece: { x: Number(p.x), y: p.y } })),
    statementFingerprint: hex(l.statement),
  };
}

export type CopyCheck =
  | { ok: false; why: string }
  | { ok: true; sealed: SealedMessage; fingerprint: string; sealedBefore: number; needed: number; pieces: number; onLedger: KeyPiece[] };

/** Checks a pasted sealed text against a register reading: is this exact text sealed there, and how many pieces of its key are out? */
export function checkCopy(register: RegisterReading, text: string): CopyCheck {
  let sealed: SealedMessage;
  let fingerprint: string;
  try {
    sealed = sealedFromText(text.trim());
    fingerprint = hex(sealedFingerprint(sealed));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, why: `${why.charAt(0).toUpperCase()}${why.slice(1)}. Paste the whole sealed text, from the first brace to the last.` };
  }
  const seal = register.seals.find((x) => x.fingerprint === fingerprint);
  if (!seal) {
    return { ok: false, why: `Its fingerprint is 0x${fingerprint.slice(0, 8)}…, and this register holds no seal with that fingerprint. Either the copy was changed, or it was never sealed here.` };
  }
  if (sealed.vault !== register.vault) return { ok: false, why: 'This text was sealed for a different vault than the one this register asks.' };
  const onLedger = register.handedOver.filter((p) => p.seal === fingerprint).map((p) => p.piece).sort((a, b) => a.x - b.x);
  return { ok: true, sealed, fingerprint, sealedBefore: seal.sealedBefore, needed: seal.needed, pieces: seal.pieces, onLedger };
}

/** Opens a checked copy with the pieces on the ledger. Returns the text, or why it stays shut. */
export async function openCopy(check: Extract<CopyCheck, { ok: true }>): Promise<{ text: string } | { why: string }> {
  try {
    return { text: await openMessageText(check.sealed, check.onLedger) };
  } catch (e) {
    if (e instanceof SealedError && e.problem === 'not enough pieces') {
      const have = check.onLedger.length;
      return { why: `It is still locked. It needs ${check.needed} piece${check.needed === 1 ? '' : 's'} of its key and ${have === 0 ? 'none is' : have === 1 ? 'one is' : `${have} are`} on the register.` };
    }
    if (e instanceof SealedError && e.problem === 'cannot open') {
      return { why: 'The pieces on the register rebuild the guardians\' half of the key, but this text also needs a half only its recipient holds. It is a private message, not a public disclosure.' };
    }
    return { why: 'The pieces on the register do not fit this text.' };
  }
}
