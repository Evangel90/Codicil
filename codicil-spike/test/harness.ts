// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// A tiny simulator around the compact-runtime: every call gets a fresh circuit
// context built from the current contract state, so each test controls block
// time and *who* is calling (their private state) per call.

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type CircuitContext,
  type ContractAddress,
  type Effects,
  type LogEvent,
} from '@midnight-ntwrk/compact-runtime';
import { checkProofData } from './proof-check.js';

const COIN_PK = '0'.repeat(64);

// Structural view of a compiled contract; the generated classes satisfy it.
interface CompiledContract<PS> {
  initialState(ctx: ReturnType<typeof createConstructorContext<PS>>, ...args: any[]): Promise<{
    currentContractState: unknown;
  }> | { currentContractState: unknown };
  impureCircuits: Record<string, (ctx: CircuitContext<PS>, ...args: any[]) => Promise<{
    result: unknown;
    context: CircuitContext<PS>;
  }>>;
}

export interface CallResult<R> {
  result: R;
  events: LogEvent[];
  effects: Effects;
}

export class Simulator<PS> {
  readonly address: ContractAddress = sampleContractAddress();
  private state: any;
  private proofDir?: string;

  private constructor(private readonly contract: CompiledContract<PS>, state: unknown) {
    this.state = state;
  }

  static async deploy<PS>(contract: CompiledContract<PS>, privateState: PS, ...args: unknown[]) {
    const res = await contract.initialState(createConstructorContext(privateState, COIN_PK), ...args);
    // Keep only the ledger data (a ChargedState): it is what both
    // createCircuitContext and the generated ledger() accept.
    return new Simulator<PS>(contract, (res.currentContractState as { data: unknown }).data);
  }

  /**
   * Also check every successful call against the compiled ZK circuit in
   * `<contractDir>/zkir`, i.e. that a proof for it could be generated.
   */
  withProofChecks(contractDir: string): this {
    this.proofDir = contractDir;
    return this;
  }

  /** Current public ledger state, as accepted by the generated `ledger()` function. */
  get ledgerState(): any {
    return this.state;
  }

  /**
   * Run an impure circuit at block time `time` (seconds) as a caller holding
   * `privateState`. State is committed only if the circuit succeeds.
   */
  async call<R = unknown>(
    circuitId: string,
    opts: { time: number; as: PS },
    ...args: unknown[]
  ): Promise<CallResult<R>> {
    const circuit = this.contract.impureCircuits[circuitId];
    if (!circuit) throw new Error(`unknown circuit ${circuitId}`);
    const ctx = createCircuitContext<PS>({
      circuitId,
      contractAddress: this.address,
      coinPublicKeyOrZswapState: COIN_PK,
      contractState: this.state,
      privateState: opts.as,
      time: opts.time,
    });
    const out = await circuit(ctx, ...args);
    if (this.proofDir) {
      const trace = out.context.callProofDataTrace;
      await checkProofData(this.proofDir, circuitId, trace[trace.length - 1] as any);
    }
    const qc = out.context.callContext.currentQueryContext;
    this.state = qc.state;
    return { result: out.result as R, events: out.context.events, effects: qc.effects };
  }
}

/** Concatenate every byte atom inside an emitted event's encoded payload. */
export function eventBytes(ev: LogEvent): Uint8Array {
  const chunks: Uint8Array[] = [];
  const walk = (v: unknown): void => {
    if (v instanceof Uint8Array) chunks.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v instanceof Map) v.forEach((val, key) => { walk(key); walk(val); });
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(ev.data);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function containsAscii(haystack: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

/** Amount this call asks the ledger to pay out to the given user address (hex). */
export function unshieldedPaidTo(effects: Effects, userAddressHex: string): bigint {
  let total = 0n;
  for (const [[, addr], amount] of effects.claimedUnshieldedSpends) {
    if (addr.tag === 'user' && addr.address === userAddressHex) total += amount;
  }
  return total;
}

/** Amount of unshielded input this call expects the contract to receive. */
export function unshieldedReceived(effects: Effects): bigint {
  let total = 0n;
  for (const amount of effects.unshieldedInputs.values()) total += amount;
  return total;
}
