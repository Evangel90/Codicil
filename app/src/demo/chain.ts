// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Demo chain: runs the real compiled contracts in the browser against an
// in-memory ledger, with a clock the demo can fast-forward. Each call executes
// the same circuit code and produces the same public transcript a real
// transaction would; only proof generation and network submission are skipped.
//
// It holds the vault and any contract deployed next to it, and serves as the
// state and module provider for cross-contract calls, so a contract that calls
// `vault.isReleasedForContract()` runs the vault's own circuit against the
// vault's current state. The multi-contract part follows
// contracts/test/support/chain.ts (adapted from the Compact compiler's
// test-center, Apache-2.0), without its Node-only file and crypto APIs.

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type ChargedState,
  type CircuitContext,
  type ContractAddress,
  type ContractModuleProvider,
  type ContractState,
  type ContractStateProvider,
  type Module,
  type ModuleThunk,
} from '@midnight-ntwrk/compact-runtime';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as vaultModule from '@codicil/contracts/vault';
import { ledger, type Ledger, type VaultConfig } from '@codicil/contracts/vault';
import { createWitnesses, type CodicilPrivateState } from '@codicil/sdk';
import { installBufferShim } from './buffer-shim.js';
import { VERIFIER_KEY_TEMPLATE_BASE64 } from './verifier-template.js';

installBufferShim();

const COIN_PK = '0'.repeat(64);
const PARENT_BLOCK_HASH = '0'.repeat(64);

/** The exports of a generated `contract/index.js`, as the chain needs them. */
export type CompiledContract = Omit<Module, 'Contract'> & {
  readonly Contract: new (witnesses: any) => any;
};

export interface CircuitRun {
  address: ContractAddress;
  circuitId: string;
}

export interface CallOutcome {
  /** Values the transaction would publish, besides the proof. */
  publicTranscript: unknown;
  events: { name: string }[];
  /** Unshielded payouts requested by this call: [user address hex, amount]. */
  payouts: [string, bigint][];
  /** Every circuit this transaction ran, in the order they finished: callees first. */
  trace: CircuitRun[];
}

const VK_TEMPLATE = Uint8Array.from(atob(VERIFIER_KEY_TEMPLATE_BASE64), (c) => c.charCodeAt(0));

/**
 * A caller checks that the contract it calls is the one it was compiled
 * against, by comparing verifier key fingerprints. The demo has no proving
 * keys, so each circuit gets a stand-in key: a real key's envelope with its
 * last 32 bytes replaced by SHA-256(contract name:circuit).
 */
function verifierKeyFor(name: string, circuitId: string): Uint8Array {
  const key = Uint8Array.from(VK_TEMPLATE);
  key.set(sha256(new TextEncoder().encode(`${name}:${circuitId}`)), key.length - 32);
  return key;
}

export class DemoChain implements ContractStateProvider, ContractModuleProvider {
  private readonly states = new Map<ContractAddress, ContractState>();
  private readonly modules = new Map<ContractAddress, CompiledContract>();
  private vault: ContractAddress = '';
  /** Demo clock, unix seconds. */
  now: number;

  private constructor(now: number) {
    this.now = now;
  }

  static async deploy(config: VaultConfig, now: number): Promise<DemoChain> {
    const chain = new DemoChain(now);
    chain.vault = await chain.deployContract('codicil_vault', vaultModule, createWitnesses(), config);
    return chain;
  }

  /** The vault's address. */
  get address(): ContractAddress {
    return this.vault;
  }

  /** The vault's public ledger. */
  get ledger(): Ledger {
    return ledger(this.ledgerOf(this.vault));
  }

  /** The public ledger state of any deployed contract, for its generated `ledger()`. */
  ledgerOf(address: ContractAddress): ChargedState {
    const s = this.states.get(address);
    if (!s) throw new Error(`nothing deployed at ${address}`);
    return s.data;
  }

  advance(seconds: number): void {
    this.now += Math.max(0, Math.floor(seconds));
  }

  // ─── Providers for cross-contract calls ───────────────────────────────────
  async getContractState(_blockHash: string, address: ContractAddress): Promise<ContractState | undefined> {
    return this.states.get(address);
  }

  resolve(address: ContractAddress): ModuleThunk | undefined {
    const m = this.modules.get(address);
    return m && (() => Promise.resolve(m as Module));
  }

  /** Deploy a compiled contract on this chain and return its address. */
  async deployContract(name: string, module: CompiledContract, witnesses: object, ...args: unknown[]): Promise<ContractAddress> {
    const contract = new module.Contract(witnesses);
    const res = await contract.initialState(createConstructorContext({}, COIN_PK), ...args);
    const state: ContractState = res.currentContractState;

    const expectedVk: Record<string, string> = {};
    for (const entry of state.operations()) {
      const circuitId = typeof entry === 'string' ? entry : new TextDecoder().decode(entry);
      const op = state.operation(entry);
      if (!op) throw new Error(`operation ${circuitId} vanished`);
      const key = verifierKeyFor(name, circuitId);
      op.verifierKey = key;
      state.setOperation(entry, op);
      expectedVk[circuitId] = bytesToHex(sha256(key));
    }

    const address = sampleContractAddress();
    this.states.set(address, state);
    this.modules.set(address, { ...module, expectedVk });
    return address;
  }

  /** Run a vault circuit as a caller holding `privateState`. State changes only if it succeeds. */
  call(circuitId: string, privateState: CodicilPrivateState, ...args: unknown[]): Promise<CallOutcome> {
    return this.callContract(this.vault, circuitId, { witnesses: createWitnesses(), privateState }, ...args);
  }

  /**
   * Run a circuit of any deployed contract. If it calls another contract, that
   * contract's circuit runs too, against its current state, and every contract
   * the transaction touched is committed together. Nothing changes on failure.
   */
  async callContract(
    address: ContractAddress,
    circuitId: string,
    opts: { witnesses?: object; privateState?: unknown },
    ...args: unknown[]
  ): Promise<CallOutcome> {
    const module = this.modules.get(address);
    const state = this.states.get(address);
    if (!module || !state) throw new Error(`nothing deployed at ${address}`);
    const circuit = new module.Contract(opts.witnesses ?? {}).impureCircuits[circuitId];
    if (!circuit) throw new Error(`unknown circuit ${circuitId}`);
    const ctx = createCircuitContext({
      circuitId,
      contractAddress: address,
      coinPublicKeyOrZswapState: COIN_PK,
      contractState: state,
      privateState: opts.privateState ?? {},
      time: this.now,
      parentBlockHash: PARENT_BLOCK_HASH,
      crossContract: { stateProvider: this, moduleProvider: this },
    });
    const out = await circuit(ctx, ...args);
    const context = out.context as CircuitContext;

    for (const [touched, qc] of Object.entries(context.queryContexts)) {
      const s = this.states.get(touched)!;
      s.data = qc.state;
      this.states.set(touched, s);
    }

    const trace = context.callProofDataTrace;
    const payouts: [string, bigint][] = [];
    for (const [[, to], amount] of context.callContext.currentQueryContext.effects.claimedUnshieldedSpends) {
      if (to.tag === 'user') payouts.push([to.address, amount]);
    }
    return {
      publicTranscript: trace[trace.length - 1]?.publicTranscript,
      events: context.events.map(() => ({ name: 'codicil:released:v1' })),
      payouts,
      trace: trace.map((t) => ({ address: t.contractAddress, circuitId: t.circuitId })),
    };
  }
}
