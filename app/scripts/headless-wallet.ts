// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The wallet boundary (src/live/wallet.ts) without a browser extension: a
// wallet built from a seed with the wallet SDK, as the command-line run in
// preprod/ uses. It lets the end-to-end script drive the app's own live chain
// and store on a real network with nobody clicking "approve".
//
// It is for the throwaway test wallet only. The seed is read by the caller
// and is never logged here.

import type { NetworkConfig } from '../../preprod/src/env.js';
import {
  currentState, readBalances, waitSettled, walletTransactions, type TxTimings, type WalletSession,
} from '../../preprod/src/wallet.js';
import type { WalletAdapter, WalletAddress, WalletBalances, WalletServices } from '../src/live/wallet.js';

export class HeadlessWallet implements WalletAdapter {
  readonly name = 'the test wallet';
  readonly timings: TxTimings = {};
  private readonly txs;

  constructor(
    private readonly session: WalletSession,
    private readonly cfg: NetworkConfig,
    log: (line: string) => void = () => {},
    /** How long to wait for the wallet to apply its last transaction before building the next. */
    private readonly settleTimeoutMs = 600_000,
  ) {
    this.txs = walletTransactions(session, this.timings, log);
  }

  async services(): Promise<WalletServices> {
    return {
      networkId: this.cfg.networkId,
      indexerUri: this.cfg.indexerHttp,
      indexerWsUri: this.cfg.indexerWs,
      nodeUri: this.cfg.nodeHttp,
      proofServerUri: this.cfg.proofServer,
    };
  }

  async address(): Promise<WalletAddress> {
    return { bech32: this.session.identity.address, hex: this.session.identity.addressHex };
  }

  async shieldedKeys(): Promise<{ coinPublicKey: string; encryptionPublicKey: string }> {
    return { coinPublicKey: this.session.identity.coinPublicKey, encryptionPublicKey: this.session.identity.encryptionPublicKey };
  }

  async balances(): Promise<WalletBalances> {
    const b = readBalances(await currentState(this.session));
    return { night: b.night, dust: b.dust };
  }

  async balanceTransaction(tx: Uint8Array, ttl?: Date): Promise<Uint8Array> {
    // "Wait until the wallet has applied the confirmation before you build the
    // next transaction" (Midnight docs): otherwise the DUST it would spend is
    // still locked by the previous one.
    await waitSettled(this.session, this.settleTimeoutMs);
    return this.txs.balance(tx, ttl);
  }

  async submitTransaction(tx: Uint8Array): Promise<void> {
    await this.txs.submit(tx);
  }
}
