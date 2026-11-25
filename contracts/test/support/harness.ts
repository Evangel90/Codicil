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
  /** The public transcript of this call: exactly what goes on-chain besides the proof. */
  publicTranscript: unknown;
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

  /**
   * The same deployed contract (address, state) driven by a different client,
   * e.g. one with malicious witnesses. State changes do not flow back.
   */
  withContract(contract: CompiledContract<PS>): Simulator<PS> {
    const other = new Simulator<PS>(contract, this.state);
    (other as { address: ContractAddress }).address = this.address;
    other.proofDir = this.proofDir;
    return other;
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
    const trace = out.context.callProofDataTrace;
    const proofData = trace[trace.length - 1];
    if (this.proofDir) await checkProofData(this.proofDir, circuitId, proofData as any);
    const qc = out.context.callContext.currentQueryContext;
    this.state = qc.state;
    return {
      result: out.result as R,
      events: out.context.events,
      effects: qc.effects,
      publicTranscript: proofData.publicTranscript,
    };
  }
}

/** Concatenate every byte atom inside an emitted event's encoded payload. */
export function eventBytes(ev: LogEvent): Uint8Array {
  return collectBytes(ev.data);
}

/** Concatenate every Uint8Array found anywhere inside a (nested) JS value. */
export function collectBytes(value: unknown): Uint8Array {
  const chunks: Uint8Array[] = [];
  const walk = (v: unknown): void => {
    if (v instanceof Uint8Array) chunks.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v instanceof Map) v.forEach((val, key) => { walk(key); walk(val); });
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function containsAscii(haystack: Uint8Array, needle: string): boolean {
  return containsBytes(haystack, new TextEncoder().encode(needle));
}

export function containsBytes(haystack: Uint8Array, n: Uint8Array): boolean {
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Whether a ledger value (a `Bytes<32>` commitment, salt or secret) appears in
 * a transcript. The runtime stores values with trailing zero bytes trimmed, so
 * one value in 256 is a byte shorter there: search for the trimmed form, which
 * also matches the full one.
 */
export function containsValue(haystack: Uint8Array, value: Uint8Array): boolean {
  let end = value.length;
  while (end > 0 && value[end - 1] === 0) end--;
  if (end === 0) throw new Error('cannot search a transcript for an all-zero value');
  return containsBytes(haystack, value.subarray(0, end));
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
