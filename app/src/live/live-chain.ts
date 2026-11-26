// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The vault on a Midnight network: the second implementation of the chain
// boundary (chain/types.ts), built on Midnight.js 5.0.1.
//
//   public state     the network's indexer
//   proofs           a proof server, sent the circuit's keys with each request
//   circuit keys     fetched over HTTP from where the app is served
//   fees, signing    the person's wallet, behind the WalletAdapter boundary
//   private state    kept in memory here and handed in with every call; what
//                    survives a reload is the vault record the store saves
//
// The wiring follows preprod/src/providers.ts, which ran on Preprod and
// Preview on 26 Nov 2026. This file has no browser-only code: the end-to-end
// script runs it in Node with a wallet built from a seed.

import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';
import { Transaction, unshieldedToken, type SigningKey } from '@midnight-ntwrk/midnight-js-protocol/v9';
// The contract's generated `ledger()` reads state with the Compact runtime's own copy of the ledger types.
import { ContractState, encodeRawTokenType } from '@midnight-ntwrk/compact-runtime';
import {
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  type ContractPrivateStates,
  type PrivateStateProvider,
  type ProofProvider,
  type PublicDataProvider,
} from '@midnight-ntwrk/midnight-js/types';
import { findDeployedContract, type Ledger9ContractProviders } from '@midnight-ntwrk/midnight-js/contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { Contract as VaultContract, ledger as vaultLedger, type Ledger, type VaultConfig } from '@codicil/contracts/vault';
import { createWitnesses, type CodicilPrivateState } from '@codicil/sdk';
import { deployInStages, insertVerifierKeys, missingCircuits, VAULT_DEFER_ORDER, type MaintenanceKey } from '@codicil/sdk/staged-deploy';
import type {
  CallOutcome, CallStage, CreateVaultOptions, DeploymentRecord, StageListener, VaultChain, VaultHost,
} from '../chain/types.js';
import { ProofServerDown, WrongNetwork } from './problems.js';
import type { WalletAdapter, WalletServices } from './wallet.js';
import { HttpZkConfigProvider, type ArtifactCache } from './zk-artifacts.js';

/** How long a built transaction stays valid. One hour, as Midnight's own test kit uses. */
const TTL_SECONDS = 3600;
const PRIVATE_STATE_ID = 'codicil-vault';
/** How often an open vault re-reads its public state while someone is watching it. */
const POLL_MS = 12_000;

type Vault = VaultContract<CodicilPrivateState>;
type VaultProviders = Ledger9ContractProviders<Vault>;
type VaultCircuit = keyof Vault['impureCircuits'] & string;

export interface LiveHostOptions {
  wallet: WalletAdapter;
  /** Where `contracts/managed/codicil_vault` is served, e.g. `${origin}/zk/codicil_vault`. */
  artifactsUrl: string;
  /** Keeps downloaded proving keys between visits. */
  artifactCache?: ArtifactCache;
  /** The networks the app works on; a wallet on any other is refused. */
  allowedNetworks?: readonly string[];
  /** A proof can take a minute on a laptop; give up after this long. */
  proofTimeoutMs?: number;
  fetch?: typeof fetch;
  /** Diagnostics for the end-to-end script. The app passes none. */
  log?: (line: string) => void;
}

// ─── Private state ──────────────────────────────────────────────────────────
// Midnight.js reads the caller's private state from a provider. Ours is a map
// in memory: the store hands in exactly the secrets each call needs, and the
// maintenance key while a deployment is being finished.

function memoryPrivateStates(): PrivateStateProvider<string, CodicilPrivateState> {
  const states = new Map<string, CodicilPrivateState>();
  const signingKeys = new Map<string, SigningKey>();
  const unsupported = (what: string) => (): never => { throw new Error(`${what} is not supported: Codicil keeps private state in its own vault record`); };
  const forContract = (address: string): ContractPrivateStates<string, CodicilPrivateState> => {
    const prefix = `${address.toLowerCase()}:`;
    return {
      contractAddress: address.toLowerCase(),
      async set(id, state) { states.set(prefix + id, state); },
      async get(id) { return states.get(prefix + id) ?? null; },
      async remove(id) { states.delete(prefix + id); },
      async clear() { for (const k of [...states.keys()]) if (k.startsWith(prefix)) states.delete(k); },
      exportPrivateStates: unsupported('exporting private state'),
      importPrivateStates: unsupported('importing private state'),
    };
  };
  return {
    forContract,
    async clearAll() { states.clear(); },
    async setSigningKey(address, key) { signingKeys.set(address.toLowerCase(), key); },
    async getSigningKey(address) { return signingKeys.get(address.toLowerCase()) ?? null; },
    async removeSigningKey(address) { signingKeys.delete(address.toLowerCase()); },
    async clearSigningKeys() { signingKeys.clear(); },
    exportSigningKeys: unsupported('exporting signing keys'),
    importSigningKeys: unsupported('importing signing keys'),
  };
}

// ─── The host ───────────────────────────────────────────────────────────────

/** A Midnight network, reached through one wallet. */
export class LiveHost implements VaultHost {
  readonly kind = 'network' as const;
  readonly tokenColor: Uint8Array = encodeRawTokenType(unshieldedToken().raw);
  private readonly stageListeners = new Set<StageListener>();
  private readonly privateStates = memoryPrivateStates();
  private readonly publicData: PublicDataProvider;
  private readonly zk: HttpZkConfigProvider<VaultCircuit>;
  private readonly providers: VaultProviders;
  private readonly compiled;
  private readonly log: (line: string) => void;
  private readonly fetchFn: typeof fetch;

  private constructor(
    readonly services: WalletServices,
    private readonly wallet: WalletAdapter,
    keys: { coinPublicKey: string; encryptionPublicKey: string },
    options: LiveHostOptions,
  ) {
    this.log = options.log ?? (() => {});
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
    const emit = (stage: CallStage) => this.stageListeners.forEach((fn) => fn(stage));

    this.zk = new HttpZkConfigProvider<VaultCircuit>(options.artifactsUrl, {
      fetch: options.fetch,
      cache: options.artifactCache,
      onProgress: (p) => { if (p.kind === 'prover') emit({ stage: 'keys', circuit: p.circuit, loaded: p.loaded, total: p.total }); },
    });
    this.publicData = indexerPublicDataProvider({ queryURL: services.indexerUri, subscriptionURL: services.indexerWsUri });

    const prover = httpClientProofProvider({ url: services.proofServerUri, zkConfigProvider: this.zk, timeout: options.proofTimeoutMs ?? 15 * 60_000 });
    const proofProvider: ProofProvider = {
      supportedEras: prover.supportedEras,
      proveTx: async (tx, config) => {
        emit({ stage: 'proving' });
        const started = Date.now();
        try {
          return await prover.proveTx(tx, config);
        } finally {
          this.log(`  proved in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        }
      },
    };

    // The contract and its witnesses. The asset path is only a label here:
    // Midnight.js reads the artifacts through `zkConfigProvider`, never from disk.
    this.compiled = CompiledContract.make('codicil-vault', VaultContract<CodicilPrivateState>).pipe(
      CompiledContract.withWitnesses(createWitnesses()),
      CompiledContract.withCompiledFileAssets(options.artifactsUrl),
    );

    this.providers = {
      privateStateProvider: this.privateStates,
      publicDataProvider: this.publicData,
      zkConfigProvider: this.zk,
      proofProvider,
      walletProvider: createLedger9WalletProvider({
        balanceTx: async (tx, ttl) => {
          emit({ stage: 'approving' });
          return wallet.balanceTransaction(tx.serialize(), ttl);
        },
        getCoinPublicKey: () => keys.coinPublicKey,
        getEncryptionPublicKey: () => keys.encryptionPublicKey,
      }),
      midnightProvider: createLedger9MidnightProvider(async (tx) => {
        emit({ stage: 'submitting' });
        const bytes = tx.serialize();
        // The wallet relays the transaction; its id is in the transaction itself.
        const txId = Transaction.deserialize('signature', 'proof', 'binding', bytes).identifiers()[0];
        await wallet.submitTransaction(bytes);
        emit({ stage: 'finalizing', txId });
        return txId;
      }),
      config: { networkId: services.networkId, ttlSeconds: TTL_SECONDS },
    };
  }

  /** Ask the wallet where the network is and who the person is, and build the providers. */
  static async connect(options: LiveHostOptions): Promise<LiveHost> {
    const services = await options.wallet.services();
    if (options.allowedNetworks && !options.allowedNetworks.includes(services.networkId)) {
      throw new WrongNetwork(services.networkId, options.allowedNetworks);
    }
    const keys = await options.wallet.shieldedKeys();
    return new LiveHost(services, options.wallet, keys, options);
  }

  get networkId(): string {
    return this.services.networkId;
  }

  /** Real time. A circuit is checked again against the block that includes it, a few seconds later. */
  get now(): number {
    return Math.floor(Date.now() / 1000);
  }

  onStage(listener: StageListener): () => void {
    this.stageListeners.add(listener);
    return () => { this.stageListeners.delete(listener); };
  }

  /** Throws `ProofServerDown` unless the proof server answers. Cheap: one small request. */
  async checkProofServer(): Promise<string> {
    const url = this.services.proofServerUri.replace(/\/$/, '');
    try {
      const res = await this.fetchFn(`${url}/version`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.text()).trim();
    } catch (cause) {
      throw Object.assign(new ProofServerDown(url), { cause });
    }
  }

  async preflight(): Promise<void> {
    await this.checkProofServer();
  }

  /** Whether the app was built with this circuit's proving key. */
  hasProvingKey(circuit: string): Promise<boolean> {
    return this.zk.hasProverKey(circuit as VaultCircuit);
  }

  /** The contract at `address` as the indexer has it, or undefined if there is none. */
  private async contractState(address: string): Promise<ContractState | undefined> {
    const read = await this.publicData.queryContractState(address);
    return read ? read.contractState.deserialize({ v9: ContractState }) : undefined;
  }

  async createVault(config: VaultConfig, options: CreateVaultOptions): Promise<VaultChain> {
    await this.checkProofServer();
    let record = options.resume && !options.resume.complete ? { ...options.resume } : undefined;
    const save = async (next: DeploymentRecord) => { record = next; await options.onRecord(next); };

    // An interrupted deployment: the chain says how far it got.
    if (record) {
      let onChain = await this.contractState(record.address);
      // The deploy transaction may have been sent moments before the tab closed.
      for (let i = 0; !onChain && !record.deployTxHash && i < 4; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        onChain = await this.contractState(record.address);
      }
      if (onChain) {
        const pending = missingCircuits(onChain, record.deferred);
        this.log(`resuming the vault at ${record.address}: ${pending.length} of ${record.deferred.length} circuits still to add`);
        await this.addCircuits(record, pending, save, options);
        return this.openVault(record.address);
      }
      this.log(`nothing was deployed at ${record.address}; starting again`);
      record = undefined;
    }

    options.onStage?.({ step: 'deploy', total: 1 + VAULT_DEFER_ORDER.length });
    let planned: DeploymentRecord | undefined;
    const deployed = await deployInStages({
      providers: this.providers,
      compiledContract: this.compiled,
      args: [config],
      initialPrivateState: {},
      deferOrder: VAULT_DEFER_ORDER,
      log: this.log,
      // Written down before anything is sent: from here on the vault can be found again.
      onPlanned: async ({ address, signingKey, deferred }) => {
        planned = { address, maintenanceKey: JSON.stringify(signingKey), deferred, inserted: [], complete: false };
        options.onStage?.({ step: 'deploy', total: 1 + deferred.length });
        await save(planned);
      },
      onDeployed: async () => { /* the hash arrives with the result below */ },
      // The inserts are done one at a time below, so each can be announced first.
      skipInserts: true,
    });
    const hash = (deployed.deployTx as { txHash?: string }).txHash;
    const current: DeploymentRecord = { ...(planned ?? { address: deployed.address, maintenanceKey: JSON.stringify(deployed.signingKey), deferred: deployed.plan.deferred, inserted: [], complete: false }), deployTxHash: hash };
    await save(current);
    await this.addCircuits(current, current.deferred, save, options);
    return this.openVault(current.address);
  }

  /** Add circuits to a deployed vault, one maintenance transaction each, saving after every one. */
  private async addCircuits(
    start: DeploymentRecord,
    pending: readonly string[],
    save: (r: DeploymentRecord) => Promise<void>,
    options: CreateVaultOptions,
  ): Promise<void> {
    let record = start;
    const total = 1 + record.deferred.length;
    if (pending.length > 0) {
      await this.privateStates.setSigningKey(record.address, JSON.parse(record.maintenanceKey) as MaintenanceKey as never);
    }
    for (const circuit of pending) {
      options.onStage?.({ step: 'insert', circuit, done: total - pending.length + pending.indexOf(circuit), total });
      const [done] = await insertVerifierKeys({
        providers: this.providers, compiledContract: this.compiled, address: record.address, circuits: [circuit], log: this.log,
      });
      record = { ...record, inserted: [...record.inserted.filter((i) => i.circuit !== circuit), { circuit, txHash: done.txHash }] };
      await save(record);
    }
    await save({ ...record, complete: true });
  }

  async openVault(address: string): Promise<VaultChain> {
    const state = await this.contractState(address);
    if (!state) throw new Error(`there is no vault at ${address} on ${this.networkId}`);
    const handle = await findDeployedContract(this.providers, {
      compiledContract: this.compiled,
      contractAddress: address,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: {},
    });
    const privateStates = this.privateStates.forContract(address);
    const chain = new LiveVaultChain(
      address,
      vaultLedger(state.data),
      async () => {
        const next = await this.contractState(address);
        if (!next) throw new Error(`the indexer no longer has the vault at ${address}`);
        return vaultLedger(next.data);
      },
      async (circuitId, privateState, args) => {
        const call = (handle.callTx as unknown as Record<string, (...a: unknown[]) => Promise<CallResult>>)[circuitId];
        if (!call) throw new Error(`unknown circuit ${circuitId}`);
        await privateStates.set(PRIVATE_STATE_ID, privateState);
        try {
          return await call(...args);
        } finally {
          // Approvals are for one call; do not leave them lying in memory.
          await privateStates.set(PRIVATE_STATE_ID, {});
        }
      },
      (listener) => this.onStage(listener),
    );
    return chain;
  }
}

/** The parts of a finalized call this file reads. */
interface CallResult {
  public: {
    txHash: string;
    blockHeight: number;
    status: string;
    fees?: { paidFees?: string };
    unshielded?: { created?: { owner: string; value: bigint }[] };
  };
  calls?: { contractAddress?: string; circuitId?: string }[];
}

class LiveVaultChain implements VaultChain {
  private readonly listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private current: Ledger;

  constructor(
    readonly address: string,
    initial: Ledger,
    private readonly read: () => Promise<Ledger>,
    private readonly submit: (circuitId: string, privateState: CodicilPrivateState, args: unknown[]) => Promise<CallResult>,
    readonly onStage: (listener: StageListener) => () => void,
  ) {
    this.current = initial;
  }

  get ledger(): Ledger {
    return this.current;
  }

  get now(): number {
    return Math.floor(Date.now() / 1000);
  }

  async call(circuitId: string, privateState: CodicilPrivateState, ...args: unknown[]): Promise<CallOutcome> {
    const r = await this.submit(circuitId, privateState, args);
    if (r.public.status !== 'SucceedEntirely') throw new Error(`the transaction was included but ended as ${r.public.status}`);
    await this.refresh();
    const paid = r.public.fees?.paidFees;
    return {
      events: [],
      payouts: (r.public.unshielded?.created ?? []).map((u) => [u.owner, u.value]),
      trace: (r.calls ?? []).map((c) => ({ address: String(c.contractAddress ?? this.address), circuitId: String(c.circuitId ?? circuitId) })),
      receipt: { txHash: r.public.txHash, blockHeight: r.public.blockHeight, fee: paid && /^\d+$/.test(paid) ? BigInt(paid) : undefined },
    };
  }

  async refresh(): Promise<Ledger> {
    this.current = await this.read();
    this.listeners.forEach((fn) => fn());
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    // Someone else's transaction (a guardian's vote, an heir starting the countdown) shows up on the next poll.
    this.timer ??= setInterval(() => { void this.refresh().catch(() => undefined); }, POLL_MS);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }
}
