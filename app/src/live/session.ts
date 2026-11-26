// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The live app's session in this browser tab: the one live store, and the
// connection to the person's wallet. This is the only live module that
// touches the browser (local storage, `window.midnight`, the page's origin);
// everything it wires together runs in Node too.

import { useSyncExternalStore } from 'react';
import { approveWithPasskey } from '../demo/passkey.js';
import { connectLace, type LaceWallet } from './lace.js';
import { LiveHost } from './live-chain.js';
import { describeProblem, type Problem } from './problems.js';
import { browserStorage } from './records.js';
import { LiveStore, type LiveSnapshot } from './store.js';
import { TEST_NETWORKS, type WalletAddress, type WalletBalances } from './wallet.js';
import { browserArtifactCache } from './zk-artifacts.js';

const LAST_NETWORK_KEY = 'codicil.network';
/** Balances change as DUST generates and as transactions land. */
const BALANCE_POLL_MS = 15_000;

export const live = new LiveStore({ storage: browserStorage(), passkeys: { approve: approveWithPasskey } });
export const useLive = (): LiveSnapshot => useSyncExternalStore(live.subscribe, live.getSnapshot);

export interface Connection {
  status: 'idle' | 'connecting' | 'connected';
  /** Why the last attempt to connect failed. */
  problem?: Problem;
  walletName?: string;
  network?: string;
  address?: WalletAddress;
  balances?: WalletBalances;
  /** Where proofs are made, as the wallet reports it. */
  proofServer?: string;
  /** False when the proof server did not answer the last time it was asked. */
  proofServerUp?: boolean;
  /** False when this copy of the app was built without proving keys. */
  provingKeys?: boolean;
}

class Session {
  private state: Connection = { status: 'idle' };
  private listeners = new Set<() => void>();
  private wallet?: LaceWallet;
  private host?: LiveHost;
  private poll?: ReturnType<typeof setInterval>;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<Connection>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  /** Ask the wallet for access, find out which test network it is on, and read the person's vaults from it. */
  async connect(): Promise<boolean> {
    if (this.state.status === 'connecting') return false;
    this.set({ status: 'connecting', problem: undefined });
    try {
      let prefer: string | undefined;
      try { prefer = localStorage.getItem(LAST_NETWORK_KEY) ?? undefined; } catch { /* storage is off */ }
      const wallet = await connectLace({ networks: TEST_NETWORKS, prefer });
      const host = await LiveHost.connect({
        wallet,
        allowedNetworks: TEST_NETWORKS,
        artifactsUrl: `${window.location.origin}/zk/codicil_vault`,
        artifactCache: browserArtifactCache(),
      });
      this.wallet = wallet;
      this.host = host;
      live.walletName = wallet.name;
      try { localStorage.setItem(LAST_NETWORK_KEY, host.networkId); } catch { /* storage is off */ }
      const address = await wallet.address();
      this.set({ status: 'connected', walletName: wallet.name, network: host.networkId, address, proofServer: host.services.proofServerUri });
      void this.refresh();
      this.poll = setInterval(() => { void this.refresh(); }, BALANCE_POLL_MS);
      await live.attach(host);
      return true;
    } catch (e) {
      console.warn('[codicil live] could not connect', e);
      this.set({ status: 'idle', problem: describeProblem(e, { wallet: 'Lace' }) });
      return false;
    }
  }

  disconnect() {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    this.wallet = undefined;
    this.host = undefined;
    live.detach();
    this.state = { status: 'idle' };
    this.listeners.forEach((fn) => fn());
  }

  /** Read balances again, and check the two things a transaction needs besides them. */
  async refresh(): Promise<void> {
    const { wallet, host } = this;
    if (!wallet || !host) return;
    if (!(await wallet.stillConnected())) {
      this.disconnect();
      this.set({ problem: { kind: 'disconnected', title: 'Your wallet disconnected', body: 'Lace was locked or switched to another network. Unlock it and connect again. Your vaults are still saved in this browser.', retry: true } });
      return;
    }
    const [balances, proofServerUp, provingKeys] = await Promise.all([
      wallet.balances().catch(() => this.state.balances),
      host.checkProofServer().then(() => true, () => false),
      this.state.provingKeys ?? host.hasProvingKey('deposit'),
    ]);
    if (this.wallet === wallet) this.set({ balances, proofServerUp, provingKeys });
  }
}

export const session = new Session();
export const useConnection = (): Connection => useSyncExternalStore(session.subscribe, session.getSnapshot);
