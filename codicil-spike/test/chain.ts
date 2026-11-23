// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// An in-memory chain for cross-contract tests (gate V12). It is adapted from
// TestChain in the Compact compiler's test-center (Apache-2.0,
// github.com/LFDT-Minokawa/compact), trimmed to what Codicil needs.
//
// It serves as both the ContractStateProvider and the ContractModuleProvider,
// installs verifier keys so caller/callee key agreement has both sides, and
// checks every call in the tree against its compiled .zkir.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ocrt from '@midnightntwrk/onchain-runtime-v4';
import {
  createCircuitContext,
  createConstructorContext,
  type CircuitContext,
  type ContractModuleProvider,
  type ContractStateProvider,
  type Effects,
  type LogEvent,
  type Module,
  type ModuleThunk,
} from '@midnight-ntwrk/compact-runtime';
import { checkProofData } from './proof-check.js';

const COIN_PK = '0'.repeat(64);
const PARENT_BLOCK_HASH = '0'.repeat(64);

// A real compiled verifier key (escrow `deposit`), used only for its envelope.
// The ledger validates the envelope and never parses the payload, so each
// deployed circuit gets this key with its last 32 bytes replaced by
// SHA-256(contractDir:circuitId).
const VK_TEMPLATE = new Uint8Array(readFileSync(new URL('./fixtures/template.verifier', import.meta.url)));

function verifierKeyFor(contractDir: string, circuitId: string): Uint8Array {
  const key = Uint8Array.from(VK_TEMPLATE);
  key.set(createHash('sha256').update(`${contractDir}:${circuitId}`).digest(), key.length - 32);
  return key;
}

/** A generated contract module plus where its compiler output lives. */
export type ContractModule = Omit<Module, 'Contract'> & {
  readonly Contract: new (witnesses: any) => any;
  readonly contractDir: string;
};

export interface Deployed {
  address: ocrt.ContractAddress;
  encodedAddress: { bytes: Uint8Array };
  module: ContractModule;
}

export interface ChainCallResult<R> {
  result: R;
  events: LogEvent[];
  effects: Effects;
  /** Every circuit run in this transaction, root first: [contract address, circuit id]. */
  trace: [ocrt.ContractAddress, string][];
}

export class TestChain implements ContractStateProvider, ContractModuleProvider {
  private readonly states = new Map<ocrt.ContractAddress, ocrt.ContractState>();
  private readonly modules = new Map<ocrt.ContractAddress, ContractModule>();

  async getContractState(_blockHash: string, address: ocrt.ContractAddress) {
    return this.states.get(address);
  }

  resolve(address: ocrt.ContractAddress): ModuleThunk | undefined {
    const m = this.modules.get(address);
    return m && (() => Promise.resolve(m));
  }

  ledgerState(address: ocrt.ContractAddress): ocrt.ChargedState {
    const s = this.states.get(address);
    if (!s) throw new Error(`nothing deployed at ${address}`);
    return s.data;
  }

  async deploy(module: ContractModule, args: unknown[], witnesses: object = {}, privateState: unknown = {}): Promise<Deployed> {
    const contract = new module.Contract(witnesses);
    const res = await contract.initialState(createConstructorContext(privateState, COIN_PK), ...args);
    const state: ocrt.ContractState = res.currentContractState;

    const expectedVk: Record<string, string> = {};
    for (const entry of state.operations()) {
      const circuitId = typeof entry === 'string' ? entry : Buffer.from(entry).toString();
      const op = state.operation(entry);
      if (!op) throw new Error(`operation ${circuitId} vanished`);
      const key = verifierKeyFor(module.contractDir, circuitId);
      op.verifierKey = key;
      state.setOperation(entry, op);
      expectedVk[circuitId] = createHash('sha256').update(key).digest('hex');
    }

    const address = ocrt.sampleContractAddress();
    const bound: ContractModule = { ...module, expectedVk };
    this.states.set(address, state);
    this.modules.set(address, bound);
    return { address, encodedAddress: { bytes: ocrt.encodeContractAddress(address) }, module: bound };
  }

  async call<R = unknown>(
    target: Deployed,
    circuitId: string,
    opts: { time: number; witnesses?: object; as?: unknown },
    ...args: unknown[]
  ): Promise<ChainCallResult<R>> {
    const contract = new target.module.Contract(opts.witnesses ?? {});
    const ctx = createCircuitContext({
      circuitId,
      contractAddress: target.address,
      coinPublicKeyOrZswapState: COIN_PK,
      contractState: this.states.get(target.address)!,
      privateState: opts.as ?? {},
      time: opts.time,
      parentBlockHash: PARENT_BLOCK_HASH,
      crossContract: { stateProvider: this, moduleProvider: this },
    });
    const circuit = contract.impureCircuits[circuitId];
    if (!circuit) throw new Error(`unknown circuit ${circuitId}`);
    const out = await circuit(ctx, ...args);
    const context = out.context as CircuitContext;

    // Every circuit in the call tree must satisfy its own compiled ZK circuit.
    for (const entry of context.callProofDataTrace) {
      const dir = this.modules.get(entry.contractAddress)!.contractDir;
      await checkProofData(dir, entry.circuitId, entry as any);
    }

    // Commit every contract the transaction touched.
    for (const [address, qc] of Object.entries(context.queryContexts)) {
      const s = this.states.get(address)!;
      s.data = qc.state;
      this.states.set(address, s);
    }

    return {
      result: out.result as R,
      events: context.events,
      effects: context.callContext.currentQueryContext.effects,
      trace: context.callProofDataTrace.map((e) => [e.contractAddress, e.circuitId]),
    };
  }
}

/** Load a compiled contract module from `contracts/managed/<name>`. */
export async function loadModule(name: string): Promise<ContractModule> {
  const contractDir = new URL(`../contracts/managed/${name}`, import.meta.url).pathname;
  const mod = await import(join(contractDir, 'contract', 'index.js'));
  return { ...mod, contractDir };
}
