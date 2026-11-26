// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The chain boundary. Everything the app needs from "a chain" fits in two
// small interfaces, and there are two implementations of them:
//
//   demo/chain.ts       the compiled contract in this tab, against an
//                       in-memory ledger with a clock the demo moves
//   live/live-chain.ts  the same contract on a Midnight network, through
//                       Midnight.js, a proof server and the person's wallet
//
// A store written against these interfaces does not know which one it is on.
// That is how the live store is unit-tested (on the in-memory chain) and then
// run unchanged on a network.

import type { Ledger, VaultConfig } from '@codicil/contracts/vault';
import type { CodicilPrivateState } from '@codicil/sdk';

/** One circuit a transaction ran. */
export interface CircuitRun {
  address: string;
  circuitId: string;
}

/** Where a transaction landed, when it went to a network. */
export interface TxReceipt {
  txHash: string;
  blockHeight: number;
  /** Fee paid, in SPECK (10^15 per DUST), when the indexer reports it. */
  fee?: bigint;
}

export interface CallOutcome {
  /** Values the transaction published, besides the proof. Only the in-memory chain reports them. */
  publicTranscript?: unknown;
  /** Names of the events the vault emitted. */
  events: { name: string }[];
  /** Unshielded payouts made by this call: [user address hex, amount]. */
  payouts: [string, bigint][];
  /** Every circuit this transaction ran, in the order they finished: callees first. */
  trace: CircuitRun[];
  /** Present when the call was a real transaction. */
  receipt?: TxReceipt;
}

/**
 * What a call is doing right now, for the progress sheet. The in-memory chain
 * never reports any: its calls finish in one step.
 */
export type CallStage =
  /** Fetching the circuit's proving key, with bytes so far and in total. */
  | { stage: 'keys'; circuit: string; loaded: number; total: number }
  | { stage: 'proving' }
  /** Waiting for the person to approve in their wallet. */
  | { stage: 'approving' }
  | { stage: 'submitting' }
  /** Submitted; waiting for a block to include it and for that block to be final. */
  | { stage: 'finalizing'; txId?: string };

export type StageListener = (stage: CallStage) => void;

/** One deployed vault. */
export interface VaultChain {
  /** The vault's contract address, 64 hex characters. */
  readonly address: string;
  /** The vault's public ledger, as last read. */
  readonly ledger: Ledger;
  /** The time the chain goes by, unix seconds: the demo clock, or real time on a network. */
  readonly now: number;
  /**
   * Run a vault circuit as a caller holding `privateState`. Resolves once the
   * result is final, and `ledger` already shows it. Nothing changes on failure.
   */
  call(circuitId: string, privateState: CodicilPrivateState, ...args: unknown[]): Promise<CallOutcome>;
  /** Read the public ledger again from the source. */
  refresh(): Promise<Ledger>;
  /** Be told when the public ledger changes, including through someone else's transaction. */
  subscribe(listener: () => void): () => void;
  /** Be told what the call in progress is doing. */
  onStage?(listener: StageListener): () => void;
}

/** One step of creating a vault, for the screen that explains the wait. */
export type DeployStage =
  | { step: 'deploy'; total: number }
  | { step: 'insert'; circuit: string; done: number; total: number };

/**
 * A deployment that has started. It is written down before the first
 * transaction is sent, so closing the tab at any point loses nothing: the
 * address is known in advance, and the chain itself says which parts landed.
 */
export interface DeploymentRecord {
  /** The address the vault has, or will have once its deploy transaction lands. */
  address: string;
  /**
   * The vault's maintenance key. It signs the transactions that add the
   * remaining circuits, and anyone holding it could change the vault's rules,
   * so it is kept with the vault's other secrets.
   */
  maintenanceKey: string;
  /** Circuits left out of the deploy transaction, in the order they are added. */
  deferred: string[];
  /** Hash of the deploy transaction, once it is final. */
  deployTxHash?: string;
  /** Circuits added so far, with the transaction that added each. */
  inserted: { circuit: string; txHash: string }[];
  /** True once every circuit is in. */
  complete: boolean;
}

export interface CreateVaultOptions {
  /** A deployment to continue instead of starting a new one. */
  resume?: DeploymentRecord;
  /** Called with the record every time it changes; save it before returning. */
  onRecord: (record: DeploymentRecord) => void | Promise<void>;
  onStage?: (stage: DeployStage) => void;
}

/** Somewhere vaults live: the in-memory demo chain, or a Midnight network. */
export interface VaultHost {
  readonly kind: 'memory' | 'network';
  /** The network's id ("preprod"), or "memory". */
  readonly networkId: string;
  /** The time this chain goes by, unix seconds. */
  readonly now: number;
  /** The token the vault holds: tNIGHT on a network. 32 bytes. */
  readonly tokenColor: Uint8Array;
  /**
   * Create a vault. On a network this is several transactions (a block is too
   * small for the whole contract), and it can be continued after an interruption.
   */
  createVault(config: VaultConfig, options: CreateVaultOptions): Promise<VaultChain>;
  /** Attach to a vault that exists. Rejects if there is none at `address`. */
  openVault(address: string): Promise<VaultChain>;
  /** Rejects if a transaction cannot be made right now, for a reason the person can fix (no proof server). */
  preflight?(): Promise<void>;
  /** Be told what the transaction in hand is doing, while a vault is being created. */
  onStage?(listener: StageListener): () => void;
}
