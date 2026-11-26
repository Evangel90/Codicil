// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Deploying a contract that is too big for one block.
//
// A Midnight block may write 50,000 bytes of state. A deployment writes the
// contract's initial state and one verifier key per circuit, and the 16-circuit
// vault comes to about 48,600 bytes before the fee payment is added. The node
// refuses it: "Transaction would exhaust the block limits" (found on Preview,
// 26 Nov 2026; docs/VALIDATION.md V14).
//
// So the vault is deployed in stages. The deploy transaction carries the whole
// initial state but leaves some circuits out; each of those is then added,
// with its verifier key, by its own maintenance transaction signed with the
// contract's maintenance key. A circuit cannot be called until it is in, so a
// half-deployed vault only lacks features. The contract is the same: once
// every circuit is inserted, its state is what one deployment would have
// produced.

import { sampleSigningKey } from '@midnight-ntwrk/compact-runtime';
import { ContractDeploy, ContractState, Intent, LedgerParameters, Transaction } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { createUnprovenDeployTx, submitInsertVerifierKeyTx, submitTx } from '@midnight-ntwrk/midnight-js/contracts';
import { LedgerTransaction } from '@midnight-ntwrk/midnight-js/types';

/** Share of a block's write budget the deploy transaction may use before the fee payment is added. */
export const WRITE_BUDGET = 0.6;

type Log = (line: string) => void;

/** A contract maintenance key, as the runtime makes it. Whoever holds it can change the contract's verifier keys. */
export interface MaintenanceKey { tag: string; value: string }

export interface DeployPlan {
  /** Circuits whose verifier keys are left out of the deploy transaction, in insertion order. */
  deferred: string[];
  /** Share of the block's write limit the deploy transaction uses (by the ledger's initial parameters). */
  writeShare: number;
  /** The same, if nothing were deferred; above 1 means it cannot fit at all. */
  writeShareAllAtOnce: number;
}

/** Bytes written by a deployment of `stateBytes` with `deferred` slots blank, as a share of the block limit. */
export function writeShare(stateBytes: Uint8Array, deferred: readonly string[], networkId: string): number {
  const { tx } = compose(stateBytes, deferred, networkId, new Date(Date.now() + 3600_000));
  const params = LedgerParameters.initialParameters();
  const cost = tx.cost(params);
  try {
    return params.normalizeFullness(cost).bytesWritten;
  } catch {
    // Over a limit: normalizeFullness refuses. Scale by hand against a transaction that fits.
    return Number(cost.bytesWritten) / blockWriteLimit();
  }
}

let cachedLimit: number | undefined;
/** The block write limit, read out of the ledger's initial parameters. */
export function blockWriteLimit(): number {
  if (cachedLimit === undefined) {
    const m = /block_limits[\s\S]*?bytes_written:\s*(\d+)/.exec(LedgerParameters.initialParameters().toString());
    cachedLimit = m ? Number(m[1]) : 50_000;
  }
  return cachedLimit;
}

function compose(stateBytes: Uint8Array, deferred: readonly string[], networkId: string, ttl: Date) {
  const full = ContractState.deserialize(stateBytes);
  for (const circuit of deferred) {
    if (full.operation(circuit) === undefined) throw new Error(`the contract has no circuit "${circuit}" to defer`);
  }
  // A deferred circuit is left out altogether. Declaring it with an empty key
  // slot does not work: the node refuses such a deployment with code 110,
  // VerifierKeyNotSet.
  const state = new ContractState();
  state.data = full.data;
  state.maintenanceAuthority = full.maintenanceAuthority;
  state.balance = full.balance;
  const skip = new Set(deferred);
  for (const entry of full.operations()) {
    const name = typeof entry === 'string' ? entry : new TextDecoder().decode(entry);
    if (!skip.has(name)) state.setOperation(entry, full.operation(entry)!);
  }
  const deploy = new ContractDeploy(state);
  const tx = Transaction.fromParts(networkId, undefined, undefined, Intent.new(ttl).addDeploy(deploy));
  return { tx, address: deploy.address };
}

/**
 * Decide which verifier keys to leave out of the deploy transaction: none if
 * it fits, otherwise circuits from `deferOrder` (least needed first) until the
 * transaction is within the budget.
 */
export function planDeploy(stateBytes: Uint8Array, deferOrder: readonly string[], networkId: string, budget = WRITE_BUDGET): DeployPlan {
  const writeShareAllAtOnce = writeShare(stateBytes, [], networkId);
  const deferred: string[] = [];
  let share = writeShareAllAtOnce;
  for (const circuit of deferOrder) {
    if (share <= budget) break;
    deferred.push(circuit);
    share = writeShare(stateBytes, deferred, networkId);
  }
  if (share > budget) {
    throw new Error(`the deployment uses ${(share * 100).toFixed(0)}% of a block's write limit even with ${deferred.length} verifier keys deferred; add more circuits to the defer order`);
  }
  return { deferred, writeShare: share, writeShareAllAtOnce };
}

export interface StagedDeployOptions {
  // The Midnight.js types for providers and contracts are generic over the
  // contract; this helper works for any, so it takes them untyped.
  providers: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  compiledContract: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  args: unknown[];
  initialPrivateState: unknown;
  /** Circuits to defer first if the deployment does not fit, least needed first. */
  deferOrder: readonly string[];
  log?: Log;
  /** Called once the deploy transaction is final and before any key is inserted, so a crash can resume. */
  onDeployed?: (info: { address: string; signingKey: MaintenanceKey; pending: string[] }) => void | Promise<void>;
  /** Called after each verifier key is inserted. */
  onInserted?: (circuit: string, remaining: string[]) => void | Promise<void>;
}

export interface StagedDeployResult {
  address: string;
  signingKey: MaintenanceKey;
  plan: DeployPlan;
  /** The finalized deploy transaction, as Midnight.js reports it. */
  deployTx: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  inserts: { circuit: string; txHash: string; blockHeight: number }[];
}

/** Deploy, leaving out as many verifier keys as needed to fit a block, then insert them. */
export async function deployInStages(opts: StagedDeployOptions): Promise<StagedDeployResult> {
  const log = opts.log ?? (() => {});
  const { providers, compiledContract } = opts;
  const networkId: string = providers.config.networkId;
  const signingKey = sampleSigningKey() as MaintenanceKey;

  // Run the constructor the normal way to get the initial state, with the
  // maintenance authority set to `signingKey` and every verifier key in place.
  const built = await createUnprovenDeployTx(providers, {
    compiledContract, args: opts.args, initialPrivateState: opts.initialPrivateState, signingKey,
  } as never);
  const stateBytes: Uint8Array = (built.public.initialContractState as { deserialize(d: object): ContractState })
    .deserialize({ v9: ContractState }).serialize();

  const plan = planDeploy(stateBytes, opts.deferOrder, networkId);
  if (plan.deferred.length === 0) {
    log(`  the deployment uses ${(plan.writeShare * 100).toFixed(0)}% of a block's write limit: one transaction`);
  } else {
    log(`  all at once the deployment would use ${(plan.writeShareAllAtOnce * 100).toFixed(0)}% of a block's write limit, before the fee payment; the node refuses it`);
    log(`  deploying with ${plan.deferred.length} verifier key(s) left out (${(plan.writeShare * 100).toFixed(0)}% of the limit), then inserting: ${plan.deferred.join(', ')}`);
  }

  const ttl = new Date(Date.now() + (providers.config.ttlSeconds ?? 3600) * 1000);
  const { tx, address } = compose(stateBytes, plan.deferred, networkId, ttl);
  const deployTx = await submitTx(providers, { unprovenTx: LedgerTransaction.seal('v9', 'Unproven', tx) });
  if (deployTx.status !== 'SucceedEntirely') throw new Error(`the deploy transaction ended as ${deployTx.status}`);
  await providers.privateStateProvider.setSigningKey(address, signingKey);
  await opts.onDeployed?.({ address, signingKey, pending: [...plan.deferred] });

  const inserts = await insertVerifierKeys({ providers, compiledContract, address, circuits: plan.deferred, log, onInserted: opts.onInserted });
  return { address, signingKey, plan, deployTx, inserts };
}

/** Fill blank verifier-key slots, one maintenance transaction each. The signing key must already be with the provider. */
export async function insertVerifierKeys(opts: {
  providers: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  compiledContract: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  address: string;
  circuits: readonly string[];
  log?: Log;
  onInserted?: (circuit: string, remaining: string[]) => void | Promise<void>;
}): Promise<{ circuit: string; txHash: string; blockHeight: number }[]> {
  const log = opts.log ?? (() => {});
  const done: { circuit: string; txHash: string; blockHeight: number }[] = [];
  const remaining = [...opts.circuits];
  for (const circuit of opts.circuits) {
    const vk = await opts.providers.zkConfigProvider.getVerifierKey(circuit);
    const started = Date.now();
    const r = await submitInsertVerifierKeyTx(opts.providers, opts.compiledContract, opts.address, circuit as never, vk);
    const pub = (r as { public: { txHash: string; blockHeight: number; status: string } }).public;
    if (pub.status !== 'SucceedEntirely') throw new Error(`inserting the verifier key for ${circuit} ended as ${pub.status}`);
    remaining.shift();
    done.push({ circuit, txHash: pub.txHash, blockHeight: pub.blockHeight });
    log(`  verifier key for ${circuit} inserted in block ${pub.blockHeight} (${((Date.now() - started) / 1000).toFixed(0)} s), tx ${pub.txHash}`);
    await opts.onInserted?.(circuit, [...remaining]);
  }
  return done;
}
