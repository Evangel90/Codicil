// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The Lace wallet, through the Midnight DApp connector (the API version 4
// that `@midnight-ntwrk/dapp-connector-api` 4.1.0 describes). A wallet
// extension puts an entry under `window.midnight`; `connect(networkId)` asks
// the person for access and returns the API this file wraps.
//
// Written from the connector's published types. It has not been run against
// the Lace extension by the authors' tooling, which cannot click an
// extension; the pure parts (choosing a wallet, choosing a network, reading
// errors) are unit-tested with a stand-in.

import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { fromHex, toHex } from './codec.js';
import { NoWallet, OldWallet, WrongNetwork } from './problems.js';
import {
  addressToHex, coinPublicKeyToHex, encryptionPublicKeyToHex, LOCAL_PROOF_SERVER, TEST_NETWORKS,
  type WalletAdapter, type WalletAddress, type WalletBalances, type WalletServices,
} from './wallet.js';

/** tNIGHT's token type as the connector keys balances: the ledger's native unshielded token, 32 zero bytes. */
export const NIGHT_TOKEN = '0'.repeat(64);

/** The connector major version this file was written against. */
const CONNECTOR_MAJOR = 4;

const isInitialApi = (x: unknown): x is InitialAPI =>
  typeof x === 'object' && x !== null && typeof (x as InitialAPI).connect === 'function' && typeof (x as InitialAPI).apiVersion === 'string';

/** Every Midnight wallet this page can see. Extensions register under their own key in `window.midnight`. */
export function findWallets(scope: { midnight?: unknown } = globalThis as { midnight?: unknown }): InitialAPI[] {
  const registry = scope.midnight;
  if (typeof registry !== 'object' || registry === null) return [];
  return Object.values(registry as Record<string, unknown>).filter(isInitialApi);
}

/** Lace if it is there, otherwise the first wallet that speaks a connector version we know. */
export function pickWallet(wallets: readonly InitialAPI[]): InitialAPI | undefined {
  const usable = wallets.filter((w) => majorOf(w.apiVersion) >= CONNECTOR_MAJOR);
  const pool = usable.length > 0 ? usable : wallets;
  return pool.find((w) => /lace/i.test(`${w.rdns} ${w.name}`)) ?? pool[0];
}

const majorOf = (version: string): number => Number(/^(\d+)\./.exec(version)?.[1] ?? 0);

const wasDeclined = (e: unknown): boolean => {
  const code = (e as { code?: unknown })?.code;
  return code === 'Rejected' || code === 'PermissionRejected';
};

export interface ConnectOptions {
  /** Networks to accept, tried in this order. */
  networks?: readonly string[];
  /** The network used last time, tried first. */
  prefer?: string;
  scope?: { midnight?: unknown };
}

/**
 * Find a wallet, ask it for access, and learn which test network it is on.
 *
 * `connect` takes the network the app wants. The app works on any test
 * network, so it asks for each in turn and takes the first the wallet agrees
 * to. If the person declines, it stops there: asking again would only nag.
 */
export async function connectLace(options: ConnectOptions = {}): Promise<LaceWallet> {
  const networks = options.networks ?? TEST_NETWORKS;
  const initial = pickWallet(findWallets(options.scope));
  if (!initial) throw new NoWallet();
  if (majorOf(initial.apiVersion) < CONNECTOR_MAJOR) throw new OldWallet(initial.apiVersion);

  const order = [...new Set([options.prefer, ...networks].filter((n): n is string => !!n && networks.includes(n)))];
  let lastError: unknown;
  for (const network of order) {
    let api: ConnectedAPI;
    try {
      api = await initial.connect(network);
    } catch (e) {
      if (wasDeclined(e)) throw e;
      lastError = e;
      continue;
    }
    const config = await api.getConfiguration();
    if (!networks.includes(config.networkId)) throw new WrongNetwork(config.networkId, networks);
    return new LaceWallet(initial.name || 'Lace', api, {
      networkId: config.networkId,
      indexerUri: config.indexerUri,
      indexerWsUri: config.indexerWsUri,
      nodeUri: config.substrateNodeUri,
      // The wallet may not name a proof server; the one on this computer is the convention.
      proofServerUri: config.proverServerUri ?? LOCAL_PROOF_SERVER,
    });
  }
  throw Object.assign(new WrongNetwork('', networks), { cause: lastError });
}

export class LaceWallet implements WalletAdapter {
  constructor(readonly name: string, private readonly api: ConnectedAPI, private readonly config: WalletServices) {}

  async services(): Promise<WalletServices> {
    return this.config;
  }

  async address(): Promise<WalletAddress> {
    const { unshieldedAddress } = await this.api.getUnshieldedAddress();
    return { bech32: unshieldedAddress, hex: addressToHex(unshieldedAddress, this.config.networkId) };
  }

  async shieldedKeys(): Promise<{ coinPublicKey: string; encryptionPublicKey: string }> {
    const a = await this.api.getShieldedAddresses();
    return {
      coinPublicKey: coinPublicKeyToHex(a.shieldedCoinPublicKey, this.config.networkId),
      encryptionPublicKey: encryptionPublicKeyToHex(a.shieldedEncryptionPublicKey, this.config.networkId),
    };
  }

  async balances(): Promise<WalletBalances> {
    const [unshielded, dust] = await Promise.all([this.api.getUnshieldedBalances(), this.api.getDustBalance()]);
    return { night: unshielded[NIGHT_TOKEN] ?? 0n, dust: dust.balance };
  }

  /** Lace shows the person the transaction here, and adds the fee and its signatures when they approve. */
  async balanceTransaction(tx: Uint8Array): Promise<Uint8Array> {
    const { tx: balanced } = await this.api.balanceUnsealedTransaction(toHex(tx));
    return fromHex(balanced);
  }

  async submitTransaction(tx: Uint8Array): Promise<void> {
    await this.api.submitTransaction(toHex(tx));
  }

  /** False once the wallet has been locked, or switched to another network. */
  async stillConnected(): Promise<boolean> {
    try {
      const status = await this.api.getConnectionStatus();
      return status.status === 'connected' && status.networkId === this.config.networkId;
    } catch {
      return false;
    }
  }
}
