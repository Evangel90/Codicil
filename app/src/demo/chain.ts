// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Demo chain: runs the real compiled vault contract in the browser against an
// in-memory ledger, with a clock the demo can fast-forward. Each call executes
// the same circuit code and produces the same public transcript a real
// transaction would; only proof generation and network submission are skipped.

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type ContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, type Ledger, type VaultConfig } from '@codicil/contracts/vault';
import { createWitnesses, type CodicilPrivateState } from '@codicil/sdk';

const COIN_PK = '0'.repeat(64);

export interface CallOutcome {
  /** Values the transaction would publish, besides the proof. */
  publicTranscript: unknown;
  events: { name: string }[];
  /** Unshielded payouts requested by this call: [user address hex, amount]. */
  payouts: [string, bigint][];
}

export class DemoChain {
  readonly address: ContractAddress = sampleContractAddress();
  private readonly contract = new Contract(createWitnesses());
  private state: any;
  /** Demo clock, unix seconds. */
  now: number;

  private constructor(state: unknown, now: number) {
    this.state = state;
    this.now = now;
  }

  static async deploy(config: VaultConfig, now: number): Promise<DemoChain> {
    const contract = new Contract(createWitnesses());
    const res = await contract.initialState(createConstructorContext<CodicilPrivateState>({}, COIN_PK), config);
    return new DemoChain((res.currentContractState as { data: unknown }).data, now);
  }

  get ledger(): Ledger {
    return ledger(this.state);
  }

  advance(seconds: number): void {
    this.now += Math.max(0, Math.floor(seconds));
  }

  /** Run a circuit as a caller holding `privateState`. State changes only if it succeeds. */
  async call(circuitId: string, privateState: CodicilPrivateState, ...args: unknown[]): Promise<CallOutcome> {
    const circuit = (this.contract.impureCircuits as Record<string, any>)[circuitId];
    if (!circuit) throw new Error(`unknown circuit ${circuitId}`);
    const ctx = createCircuitContext<CodicilPrivateState>({
      circuitId,
      contractAddress: this.address,
      coinPublicKeyOrZswapState: COIN_PK,
      contractState: this.state,
      privateState,
      time: this.now,
    });
    const out = await circuit(ctx, ...args);
    const trace = out.context.callProofDataTrace;
    const qc = out.context.callContext.currentQueryContext;
    this.state = qc.state;
    const payouts: [string, bigint][] = [];
    for (const [[, addr], amount] of qc.effects.claimedUnshieldedSpends) {
      if (addr.tag === 'user') payouts.push([addr.address, amount]);
    }
    return {
      publicTranscript: trace[trace.length - 1]?.publicTranscript,
      events: out.context.events.map(() => ({ name: 'codicil:released:v1' })),
      payouts,
    };
  }
}
