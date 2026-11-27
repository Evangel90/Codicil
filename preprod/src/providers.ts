// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Midnight.js 5.0.1 wiring: the compiled contracts, and the provider set
// (`MidnightProviders`) that deploys and calls them.
//
// Importing this module loads the compiled contracts, so `npm run compile`
// must have run. Commands that must work before that import it lazily.

import './ws-global.js';

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SigningKey } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';
import {
  createLedger9ProofProvider,
  ZKConfigRegistry,
  type ContractPrivateStates,
  type MidnightProvider,
  type MidnightProviders,
  type PrivateStateProvider,
  type ProofProvider,
  type PublicDataProvider,
  type WalletProvider,
  type ZKConfigProvider,
} from '@midnight-ntwrk/midnight-js/types';
import type { Ledger9ContractProviders } from '@midnight-ntwrk/midnight-js/contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { WasmProver } from '@midnightntwrk/wallet-sdk/prover-client/effect';
import { provingProvider } from '@midnightntwrk/zkir-v3';
import { Contract as VaultContract } from '@codicil/contracts/vault';
import { Contract as EscrowContract, type Witnesses as EscrowWitnesses } from '@codicil/contracts/escrow';
import { Contract as SealsContract, type Witnesses as SealsWitnesses } from '@codicil/contracts/seals';
import { createWitnesses, type CodicilPrivateState, type PasskeyOwner, type WalletOwner } from '@codicil/sdk';
import type { NetworkConfig } from './env.js';
import { ESCROW_DIR, PARAMS_CACHE_DIR, SEALS_DIR, VAULT_DIR } from './paths.js';


/** How long a built transaction stays valid. One hour, as Midnight's own test kit uses. */
export const TTL_SECONDS = 3600;

export const VAULT_PRIVATE_STATE_ID = 'codicil-vault';
export const ESCROW_PRIVATE_STATE_ID = 'codicil-escrow';
export const SEALS_PRIVATE_STATE_ID = 'codicil-seals';

// ─── Compiled contracts ─────────────────────────────────────────────────────

export type Vault = VaultContract<CodicilPrivateState>;

/** The vault with the SDK's strict witnesses: an approval for another digest fails before proving. */
export const vaultContract = CompiledContract.make('codicil-vault', VaultContract<CodicilPrivateState>).pipe(
  CompiledContract.withWitnesses(createWitnesses()),
  CompiledContract.withCompiledFileAssets(VAULT_DIR),
);

/** Only the beneficiary's device holds the escrow secret. */
export interface EscrowPrivateState { secret?: Uint8Array }

const escrowWitnesses: EscrowWitnesses<EscrowPrivateState> = {
  beneficiarySecret: ({ privateState }) => {
    if (!privateState.secret) throw new Error('this device has no beneficiary secret for this escrow');
    return [privateState, privateState.secret];
  },
};

export type Escrow = EscrowContract<EscrowPrivateState>;

export const escrowContract = CompiledContract.make('inheritable-escrow', EscrowContract<EscrowPrivateState>).pipe(
  CompiledContract.withWitnesses(escrowWitnesses),
  CompiledContract.withCompiledFileAssets(ESCROW_DIR),
);

/**
 * Only the owner's device holds the keeper secret. A guardian handing over a
 * piece has none, and needs none: `handOver` asks for no witness.
 */
export interface SealsPrivateState {
  keeperSecret?: Uint8Array;
  /**
   * The vault owner's key and its salt: what the vault's ledger commits to.
   * With one of them the keeper proves, in zero knowledge, that this register
   * belongs to the vault's owner. Neither leaves this machine.
   */
  passkey?: Pick<PasskeyOwner, 'pk' | 'salt'>;
  wallet?: Pick<WalletOwner, 'pk' | 'salt'>;
}

const sealsRegisterWitnesses: SealsWitnesses<SealsPrivateState> = {
  keeperSecret: ({ privateState }) => {
    if (!privateState.keeperSecret) throw new Error('this device has no keeper secret for this seal register');
    return [privateState, privateState.keeperSecret];
  },
  ownerPasskey: ({ privateState }) => {
    if (!privateState.passkey) throw new Error('this device has no owner passkey for this seal register');
    return [privateState, privateState.passkey.pk];
  },
  ownerPasskeySalt: ({ privateState }) => {
    if (!privateState.passkey) throw new Error('this device has no owner passkey for this seal register');
    return [privateState, privateState.passkey.salt];
  },
  ownerEdKey: ({ privateState }) => {
    if (!privateState.wallet) throw new Error('this device has no owner wallet key for this seal register');
    return [privateState, privateState.wallet.pk];
  },
  ownerEdSalt: ({ privateState }) => {
    if (!privateState.wallet) throw new Error('this device has no owner wallet key for this seal register');
    return [privateState, privateState.wallet.salt];
  },
};

export type Seals = SealsContract<SealsPrivateState>;

export const sealsContract = CompiledContract.make('codicil-seals', SealsContract<SealsPrivateState>).pipe(
  CompiledContract.withWitnesses(sealsRegisterWitnesses),
  CompiledContract.withCompiledFileAssets(SEALS_DIR),
);

// ─── Private state ──────────────────────────────────────────────────────────
// Kept in memory. The run's own state file is what survives a restart: it
// holds the keys, and each command rebuilds the private state from it. That
// also avoids serializing bigints and curve points through a store.

const unsupported = (what: string) => (): never => {
  throw new Error(`${what} is not supported by the in-memory private state provider`);
};

export function inMemoryPrivateStateProvider<PS>(): PrivateStateProvider<string, PS> {
  const states = new Map<string, PS>();
  const signingKeys = new Map<string, SigningKey>();
  const forContract = (address: string): ContractPrivateStates<string, PS> => {
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

// ─── Proving ────────────────────────────────────────────────────────────────

export interface ProofTimings { proveMs?: number }

/**
 * Public parameters for circuit size `k`, kept on disk between runs. They are
 * large (50 MB for k = 18) and the same for everyone; the SDK checks each
 * download against the hash the ledger release declares before we store it.
 */
async function cachedParams(k: number, download: (k: number) => Promise<Uint8Array>): Promise<Uint8Array> {
  const path = join(PARAMS_CACHE_DIR, `bls_midnight_2p${k}`);
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
  const params = await download(k);
  mkdirSync(PARAMS_CACHE_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, params);
  renameSync(tmp, path);
  return params;
}

/**
 * Where the contract's own circuits are proven.
 *
 * `server` is the local proof server in Docker
 * (`midnightntwrk/proof-server:9.0.2`), the only mode a real run uses.
 *
 * `wasm` proves in this process with `@midnightntwrk/zkir-v3`, the engine
 * Midnight's test kit uses for the same purpose. It is used by `dryrun
 * --prove` only: WebAssembly has 4 GiB of memory, and the passkey check-in
 * (k = 18, about 5 GiB) aborts in it. Tested 2026-11-25: every other circuit
 * of the run proves this way.
 */
export type ProofMode = 'server' | 'wasm';

/** Largest circuit size the in-process prover can handle. */
export const WASM_MAX_K = 17;

export function makeProofProvider(
  cfg: Pick<NetworkConfig, 'proofServer'>,
  zk: ZKConfigProvider<string> | ZKConfigRegistry,
  mode: ProofMode,
  timings: ProofTimings,
  timeoutMs: number,
): ProofProvider {
  let inner: ProofProvider;
  if (mode === 'server') {
    inner = httpClientProofProvider({ url: cfg.proofServer, zkConfigProvider: zk, timeout: timeoutMs });
  } else {
    const registry = zk instanceof ZKConfigRegistry ? zk : new ZKConfigRegistry([zk]);
    const builtin = WasmProver.makeDefaultKeyMaterialProvider();
    inner = createLedger9ProofProvider(
      provingProvider({
        async lookupKey(keyLocation: string) {
          const found = await registry.resolveKeyLocation(keyLocation);
          return found ? { ir: found.zkir, proverKey: found.proverKey, verifierKey: found.verifierKey } : builtin.lookupKey(keyLocation);
        },
        getParams: (k: number) => cachedParams(k, (size) => builtin.getParams(size)),
      }),
    );
  }
  return {
    supportedEras: inner.supportedEras,
    async proveTx(tx, config) {
      const started = Date.now();
      try {
        // The in-process provider rejects a per-call timeout rather than ignoring it.
        return await (mode === 'server' ? inner.proveTx(tx, config) : inner.proveTx(tx));
      } finally {
        timings.proveMs = (timings.proveMs ?? 0) + (Date.now() - started);
      }
    },
  };
}

// ─── Provider sets ──────────────────────────────────────────────────────────

export interface ProviderParts {
  config: NetworkConfig;
  walletProvider: WalletProvider;
  midnightProvider: MidnightProvider;
  publicDataProvider: PublicDataProvider;
  proofTimings: ProofTimings;
  proofTimeoutMs: number;
}

export function makePublicDataProvider(cfg: Pick<NetworkConfig, 'indexerHttp' | 'indexerWs'>) {
  return indexerPublicDataProvider({ queryURL: cfg.indexerHttp, subscriptionURL: cfg.indexerWs });
}

type CircuitsOf<P> = P extends MidnightProviders<infer K, string, unknown> ? K : never;
export type VaultProviders = Ledger9ContractProviders<Vault>;
export type EscrowProviders = Ledger9ContractProviders<Escrow>;
export type SealsProviders = Ledger9ContractProviders<Seals>;

/** Providers for the vault: its own artifacts, one proof per transaction. */
export function vaultProviders(parts: ProviderParts, privateStateProvider: PrivateStateProvider<string, CodicilPrivateState>): VaultProviders {
  const zkConfigProvider = new NodeZkConfigProvider<CircuitsOf<VaultProviders>>(VAULT_DIR);
  return {
    privateStateProvider,
    publicDataProvider: parts.publicDataProvider,
    zkConfigProvider,
    proofProvider: makeProofProvider(parts.config, zkConfigProvider, 'server', parts.proofTimings, parts.proofTimeoutMs),
    walletProvider: parts.walletProvider,
    midnightProvider: parts.midnightProvider,
    config: { networkId: parts.config.networkId, ttlSeconds: TTL_SECONDS },
  };
}

/**
 * Providers for the escrow. Its withdrawal calls into the vault, so the
 * transaction carries two proofs: the proof provider resolves artifacts for
 * both contracts (by verifier key), and the module provider tells the runtime
 * which compiled contract lives at the vault's address.
 */
export async function escrowProviders(
  parts: ProviderParts,
  privateStateProvider: PrivateStateProvider<string, EscrowPrivateState>,
  vaultAddress: string,
): Promise<EscrowProviders> {
  const zkConfigProvider = new NodeZkConfigProvider<CircuitsOf<EscrowProviders>>(ESCROW_DIR);
  const registry = new ZKConfigRegistry([zkConfigProvider, new NodeZkConfigProvider<string>(VAULT_DIR)]);
  const vaultModule = await import('@codicil/contracts/vault');
  return {
    privateStateProvider,
    publicDataProvider: parts.publicDataProvider,
    zkConfigProvider,
    proofProvider: makeProofProvider(parts.config, registry, 'server', parts.proofTimings, parts.proofTimeoutMs),
    walletProvider: parts.walletProvider,
    midnightProvider: parts.midnightProvider,
    config: { networkId: parts.config.networkId, ttlSeconds: TTL_SECONDS },
    contractModuleProvider: {
      resolve: (address: string) => (address.toLowerCase() === vaultAddress.toLowerCase() ? () => Promise.resolve(vaultModule) : undefined),
    },
  };
}

/**
 * Providers for the seal register. `handOver` and `unseal` call into the
 * vault, so, as for the escrow, the proof provider resolves artifacts for both
 * contracts and the module provider names the contract at the vault's address.
 */
export async function sealsProviders(
  parts: ProviderParts,
  privateStateProvider: PrivateStateProvider<string, SealsPrivateState>,
  vaultAddress: string,
): Promise<SealsProviders> {
  const zkConfigProvider = new NodeZkConfigProvider<CircuitsOf<SealsProviders>>(SEALS_DIR);
  const registry = new ZKConfigRegistry([zkConfigProvider, new NodeZkConfigProvider<string>(VAULT_DIR)]);
  const vaultModule = await import('@codicil/contracts/vault');
  return {
    privateStateProvider,
    publicDataProvider: parts.publicDataProvider,
    zkConfigProvider,
    proofProvider: makeProofProvider(parts.config, registry, 'server', parts.proofTimings, parts.proofTimeoutMs),
    walletProvider: parts.walletProvider,
    midnightProvider: parts.midnightProvider,
    config: { networkId: parts.config.networkId, ttlSeconds: TTL_SECONDS },
    contractModuleProvider: {
      resolve: (address: string) => (address.toLowerCase() === vaultAddress.toLowerCase() ? () => Promise.resolve(vaultModule) : undefined),
    },
  };
}
