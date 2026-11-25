// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Dry run: build every transaction of the real run with Midnight.js, with no
// network, no wallet, no proof server, and nothing sent anywhere.
//
// It goes through the same code a real run does up to the point where a
// transaction would be proven: the compiled contracts and witnesses, the
// approvals signed by the software passkey and wallet key, Midnight.js's
// circuit executor and its transaction assembly. Each step's public state is
// carried into the next by hand, standing in for the chain.
//
// What it cannot show: proving against the proof server, fee balancing,
// submission, and what the indexer returns. With `--prove` each transaction
// is also proven in this process (it needs the full-compile keys), except the
// passkey check-in, whose circuit is too large for WebAssembly's memory.
//
// On a network there is no clock to move, so two vaults cover the lifecycle:
//   A  deadline ahead      deposit, both check-ins
//   B  deadline in the past, 1 s challenge window
//                          deposit, triggerTimeout, finalizeRelease, claim,
//                          and (with --escrow) the cross-contract withdrawal

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChargedState,
  ContractState,
  encodeContractAddress,
  encodeRawTokenType,
  encodeUserAddress,
  sampleSigningKey,
  type Module,
  type StateValue,
} from '@midnight-ntwrk/compact-runtime';
import { LedgerParameters, unshieldedToken, ZswapChainState } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { createUnprovenCallTxFromInitialStates, createUnprovenDeployTx } from '@midnight-ntwrk/midnight-js/contracts';
import {
  createLedger9WalletProvider,
  createProverKey,
  createVerifierKey,
  createZKIR,
  SerializedContractState,
  SerializedLedgerParameters,
  SerializedZswapChainState,
  ZKConfigProvider,
  ZKConfigRegistry,
  type ProverKey,
  type PublicDataProvider,
  type UnprovenTx,
  type VerifierKey,
  type ZKIR,
} from '@midnight-ntwrk/midnight-js/types';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import * as vaultModule from '@codicil/contracts/vault';
import { ledger as escrowLedger, pureCircuits as escrowPure } from '@codicil/contracts/escrow';
import { checkInDigest, newSalt, softwareSigners, withPasskeyApproval, withWalletApproval, type CodicilPrivateState } from '@codicil/sdk';
import { checkArtifacts, circuitK, ESCROW_RUN_CIRCUITS, VAULT_ESCROW_CIRCUITS, VAULT_RUN_CIRCUITS } from './artifacts.js';
import { ESCROW_DIR, REPO_ROOT, VAULT_DIR } from './paths.js';
import { escrowContract, makeProofProvider, TTL_SECONDS, vaultContract, WASM_MAX_K, type EscrowPrivateState, type ProofTimings } from './providers.js';
import { formatNight } from './results.js';
import { castFrom, newActors, RELEASE_EVENT_NAME, vaultConfigFor } from './run.js';
import { DEFAULT_TIMERS, extendedDeadline, finalDeadline, type Timers } from './timers.js';
import { deriveIdentity, newSeedHex } from './wallet.js';

const { Phase, ledger: vaultLedger } = vaultModule;

export interface DryRunStep {
  name: string;
  ok: boolean;
  detail: string;
  txBytes?: number;
  /** Time spent proving, when `--prove` proved this transaction's circuits. */
  proveMs?: number;
  /** Circuit proofs made for this transaction (two for the cross-contract withdrawal, none for a deploy). */
  proofs?: number;
}

export interface DryRunReport {
  /** `real`: keys from the full compile. `stub`: stand-in verifier keys, enough to build but not to prove. */
  artifacts: 'real' | 'stub';
  steps: DryRunStep[];
  ok: boolean;
}

export interface DryRunOptions {
  escrow: boolean;
  prove: boolean;
  /** `stub` forces the stand-in keys even when the real ones exist (tests). */
  artifacts?: 'auto' | 'stub';
  log?: (line: string) => void;
}

// ─── ZK artifacts: the real ones, or stand-ins ──────────────────────────────

/**
 * Serves stand-in verifier keys for a contract compiled with `--skip-zk`.
 * The ledger checks a verifier key's envelope but never parses its payload,
 * so a real key with its last 32 bytes replaced is accepted when building.
 * (The same trick as contracts/test/support/chain.ts.) Nothing built with
 * these can be proven.
 */
class StubZkConfigProvider extends ZKConfigProvider<string> {
  private readonly template: Uint8Array;

  constructor(private readonly dir: string) {
    super();
    this.template = new Uint8Array(readFileSync(join(REPO_ROOT, 'contracts', 'test', 'fixtures', 'template.verifier')));
  }

  keyFor(circuitId: string): Uint8Array {
    const key = Uint8Array.from(this.template);
    key.set(createHash('sha256').update(`${this.dir}:${circuitId}`).digest(), key.length - 32);
    return key;
  }

  async getVerifierKey(circuitId: string): Promise<VerifierKey> {
    return createVerifierKey(this.keyFor(circuitId));
  }

  async getProverKey(): Promise<ProverKey> {
    return createProverKey(new Uint8Array());
  }

  async getZKIR(): Promise<ZKIR> {
    return createZKIR(new Uint8Array());
  }

  override async getArtifactRuntimeVersion(): Promise<string> {
    const info = JSON.parse(readFileSync(join(this.dir, 'compiler', 'contract-info.json'), 'utf8')) as { 'runtime-version': string };
    return info['runtime-version'];
  }
}

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** What the dry run reads from a built call; the SDK's own type depends on the circuit, which is a string here. */
interface BuiltCall {
  public: { nextContractState: StateValue; logEvents: readonly unknown[] };
  private: { unprovenTx: UnprovenTx };
  calls: readonly { circuitId: unknown }[];
}
const nowS = (): number => Math.floor(Date.now() / 1000);

/** Build everything. Throws only on a programming error; a step that fails is reported. */
export async function buildAll(opts: DryRunOptions): Promise<DryRunReport> {
  const log = opts.log ?? (() => {});
  const vaultCircuits = [...VAULT_RUN_CIRCUITS, ...(opts.escrow ? VAULT_ESCROW_CIRCUITS : [])];
  const real = opts.artifacts !== 'stub'
    && checkArtifacts('codicil_vault', VAULT_DIR, vaultCircuits).ok
    && (!opts.escrow || checkArtifacts('inheritable_escrow', ESCROW_DIR, ESCROW_RUN_CIRCUITS).ok);
  if (opts.prove && !real) throw new Error('--prove needs the proving keys: run `npm run compile:full` first');
  if (!existsSync(join(VAULT_DIR, 'contract', 'index.js'))) throw new Error('contracts are not compiled: run `npm run compile`');

  const vaultZk: ZKConfigProvider<string> = real ? new NodeZkConfigProvider<string>(VAULT_DIR) : new StubZkConfigProvider(VAULT_DIR);
  const escrowZk: ZKConfigProvider<string> = real ? new NodeZkConfigProvider<string>(ESCROW_DIR) : new StubZkConfigProvider(ESCROW_DIR);
  const config = { networkId: 'undeployed', ttlSeconds: TTL_SECONDS };
  const identity = deriveIdentity(newSeedHex(), config.networkId);
  const walletProvider = createLedger9WalletProvider({
    balanceTx: async () => { throw new Error('the dry run does not balance transactions'); },
    getCoinPublicKey: () => identity.coinPublicKey,
    getEncryptionPublicKey: () => identity.encryptionPublicKey,
  });
  const zswap = SerializedZswapChainState.fromBytes('v9', new ZswapChainState().serialize());
  const params = SerializedLedgerParameters.fromBytes('v9', LedgerParameters.initialParameters().serialize());
  const color = encodeRawTokenType(unshieldedToken().raw);
  const recipient = { bytes: encodeUserAddress(identity.addressHex) };

  const timings: ProofTimings = {};
  const prover = opts.prove
    ? makeProofProvider({ proofServer: '' }, new ZKConfigRegistry([vaultZk, escrowZk]), 'wasm', timings, 0)
    : undefined;

  const steps: DryRunStep[] = [];
  /**
   * @param circuits what the transaction proves, as [contract dir, circuit]; empty for a deploy
   */
  const record = async (name: string, tx: UnprovenTx, detail: string, expect: boolean, circuits: [string, string][] = []): Promise<void> => {
    const step: DryRunStep = { name, ok: expect, detail, txBytes: tx.serialize().length };
    if (prover && expect) {
      // The in-process prover aborts the whole process when it runs out of WebAssembly memory, so ask first.
      const tooBig = circuits.map(([dir, circuit]) => ({ circuit, k: circuitK(dir, circuit) })).find((c) => c.k > WASM_MAX_K);
      if (tooBig) {
        step.detail += `; not proven here: ${tooBig.circuit} is k=${tooBig.k}, beyond WebAssembly's memory, and needs the proof server`;
      } else {
        timings.proveMs = undefined;
        try {
          // A deploy has no circuit to prove, but still goes through the prover to reach the next stage.
          const proven = await prover.proveTx(tx);
          if (circuits.length > 0) {
            step.proveMs = timings.proveMs;
            step.proofs = circuits.length;
            step.detail += `; ${circuits.length === 1 ? 'proof' : `${circuits.length} proofs`} made in ${((timings.proveMs ?? 0) / 1000).toFixed(1)} s (${proven.serialize().length} bytes)`;
          }
        } catch (e) {
          step.ok = false;
          step.detail += `; PROOF FAILED: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
    steps.push(step);
    log(`  ${step.ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(24)} ${String(step.txBytes).padStart(6)} bytes  ${step.detail}`);
  };

  const actors = newActors();
  const cast = castFrom(actors);
  const deposit = 10_000_000n;

  const deployVault = async (timers: Timers, deployedAt: number) => {
    const vaultConfig = vaultConfigFor(cast, timers, deployedAt);
    const built = await createUnprovenDeployTx(
      { zkConfigProvider: vaultZk as never, walletProvider, config },
      { compiledContract: vaultContract, args: [vaultConfig], initialPrivateState: cast.base, signingKey: sampleSigningKey() },
    );
    return { address: built.public.contractAddress, state: built.public.initialContractState as SerializedContractState, tx: built.private.unprovenTx };
  };

  /** Call a vault circuit against `state`, returning the transaction and the state after it. */
  const callVault = async (address: string, state: SerializedContractState, privateState: CodicilPrivateState, circuitId: string, args: unknown[]) => {
    const built = (await createUnprovenCallTxFromInitialStates(
      vaultZk as never,
      {
        compiledContract: vaultContract,
        circuitId,
        contractAddress: address,
        args,
        coinPublicKey: identity.coinPublicKey,
        initialContractState: state,
        initialZswapChainState: zswap,
        ledgerParameters: params,
        config,
        initialPrivateState: privateState,
      } as never,
      identity.encryptionPublicKey,
    )) as unknown as BuiltCall;
    const cs = state.deserialize({ v9: ContractState });
    cs.data = new ChargedState(built.public.nextContractState);
    const next = SerializedContractState.fromBytes('v9', cs.serialize());
    return { built, next, ledger: vaultLedger(cs.data) };
  };

  // ── Vault A: armed, deadline ahead ──
  log('vault A (armed, deadline ahead):');
  const a = await deployVault(DEFAULT_TIMERS, nowS());
  let sA = a.state;
  let lA = vaultLedger(sA.deserialize({ v9: ContractState }).data);
  await record('deploy', a.tx, `vault ${a.address.slice(0, 12)}…, ${sA.deserialize({ v9: ContractState }).operations().length} circuits, phase ${Phase[lA.phase]}`, lA.phase === Phase.armed);

  {
    const r = await callVault(a.address, sA, cast.base, 'deposit', [deposit]);
    sA = r.next;
    lA = r.ledger;
    await record('deposit', r.built.private.unprovenTx, `estateTotal ${formatNight(lA.estateTotal)}`, lA.estateTotal === deposit, [[VAULT_DIR, 'deposit']]);
  }
  {
    const before = lA;
    const next = extendedDeadline(nowS(), DEFAULT_TIMERS);
    const digest = checkInDigest(a.address, next, before.nonce);
    const ps = withPasskeyApproval(cast.base, digest, softwareSigners.passkey(cast.passkey, digest));
    const r = await callVault(a.address, sA, ps, 'checkInPasskey', [next]);
    sA = r.next;
    lA = r.ledger;
    await record('checkInPasskey', r.built.private.unprovenTx, `deadline ${before.deadline} → ${lA.deadline}, nonce ${lA.nonce}`, lA.deadline === next && lA.nonce === before.nonce + 1n, [[VAULT_DIR, 'checkInPasskey']]);
  }
  {
    const before = lA;
    const next = finalDeadline(nowS(), DEFAULT_TIMERS);
    const digest = checkInDigest(a.address, next, before.nonce);
    const ps = withWalletApproval(cast.base, digest, softwareSigners.wallet(cast.wallet, digest));
    const r = await callVault(a.address, sA, ps, 'checkInEd25519', [next]);
    sA = r.next;
    lA = r.ledger;
    await record('checkInEd25519', r.built.private.unprovenTx, `deadline ${before.deadline} → ${lA.deadline}, nonce ${lA.nonce}`, lA.deadline === next && lA.nonce === before.nonce + 1n, [[VAULT_DIR, 'checkInEd25519']]);
  }

  // ── Vault B: deadline already past, one-second challenge window ──
  log('vault B (deadline already past):');
  const expired: Timers = { ...DEFAULT_TIMERS, challengeWindowS: 1 };
  const b = await deployVault(expired, nowS() - expired.firstDeadlineS - 600);
  let sB = b.state;
  let lB = vaultLedger(sB.deserialize({ v9: ContractState }).data);
  {
    const r = await callVault(b.address, sB, cast.base, 'deposit', [deposit]);
    sB = r.next;
    lB = r.ledger;
  }
  {
    const r = await callVault(b.address, sB, cast.base, 'triggerTimeout', []);
    sB = r.next;
    lB = r.ledger;
    await record('triggerTimeout', r.built.private.unprovenTx, `phase ${Phase[lB.phase]} until ${lB.pendingUntil}`, lB.phase === Phase.pending, [[VAULT_DIR, 'triggerTimeout']]);
  }
  {
    const r = await callVault(b.address, sB, cast.base, 'finalizeRelease', []);
    sB = r.next;
    lB = r.ledger;
    const events = r.built.public.logEvents;
    const named = JSON.stringify(events, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v))
      .includes(Buffer.from(RELEASE_EVENT_NAME).toString('hex'));
    await record(
      'finalizeRelease',
      r.built.private.unprovenTx,
      `phase ${Phase[lB.phase]}, snapshot ${formatNight(lB.estateSnapshot)}, ${events.length} event(s)${named ? ` named "${RELEASE_EVENT_NAME}"` : ''}`,
      lB.phase === Phase.released && lB.estateSnapshot === deposit && events.length === 1 && named,
      [[VAULT_DIR, 'finalizeRelease']],
    );
  }
  {
    const r = await callVault(b.address, sB, cast.base, 'claim', [recipient]);
    const paid = r.ledger.estatePaid;
    const text = r.built.private.unprovenTx.deserialize({ v9: (await import('@midnight-ntwrk/midnight-js-protocol/v9')).Transaction }).toString();
    const toWallet = text.includes(identity.addressHex) && text.includes(`value: ${paid}`);
    await record('claim', r.built.private.unprovenTx, `estatePaid ${formatNight(paid)} (6000 bps); output to the wallet ${toWallet ? 'present' : 'MISSING'}`, paid === 6_000_000n && toWallet, [[VAULT_DIR, 'claim']]);
  }

  // ── Escrow: cross-contract withdrawal against released vault B ──
  if (opts.escrow) {
    log('escrow (cross-contract call into vault B):');
    const secret = newSalt();
    const escrowPrivate: EscrowPrivateState = { secret };
    const deployed = await createUnprovenDeployTx(
      { zkConfigProvider: escrowZk as never, walletProvider, config },
      { compiledContract: escrowContract, args: [{ bytes: encodeContractAddress(b.address) }, color, escrowPure.beneficiaryCommitment(secret)], initialPrivateState: escrowPrivate, signingKey: sampleSigningKey() },
    );
    const escrowAddress = deployed.public.contractAddress;
    let sE = deployed.public.initialContractState as SerializedContractState;
    await record('escrowDeploy', deployed.private.unprovenTx, `escrow ${escrowAddress.slice(0, 12)}… → vault ${b.address.slice(0, 12)}…`, true);

    // With stand-in keys the vault module must expect the stand-in keys, as a full compile would expect the real ones.
    const calleeModule: Module = real
      ? (vaultModule as unknown as Module)
      : ({ ...vaultModule, expectedVk: Object.fromEntries(vaultModule.circuitSignatures && Object.keys(vaultModule.circuitSignatures).map((c) => [c, sha256Hex((vaultZk as StubZkConfigProvider).keyFor(c))])) } as unknown as Module);
    const chain = {
      queryZSwapAndContractState: async (address: string) =>
        address.toLowerCase() === b.address.toLowerCase() ? { contractState: sB, zswapChainState: zswap, ledgerParameters: params } : null,
    } as unknown as PublicDataProvider;

    const callEscrow = async (circuitId: string, args: unknown[], crossContract: boolean) => {
      const built = (await createUnprovenCallTxFromInitialStates(
        escrowZk as never,
        {
          compiledContract: escrowContract,
          circuitId,
          contractAddress: escrowAddress,
          args,
          coinPublicKey: identity.coinPublicKey,
          initialContractState: sE,
          initialZswapChainState: zswap,
          ledgerParameters: params,
          config,
          initialPrivateState: escrowPrivate,
        } as never,
        identity.encryptionPublicKey,
        crossContract
          ? { publicDataProvider: chain, blockHash: '00'.repeat(32), moduleProvider: { resolve: (addr: string) => (addr.toLowerCase() === b.address.toLowerCase() ? () => Promise.resolve(calleeModule) : undefined) } }
          : undefined,
      )) as unknown as BuiltCall;
      const cs = sE.deserialize({ v9: ContractState });
      cs.data = new ChargedState(built.public.nextContractState);
      sE = SerializedContractState.fromBytes('v9', cs.serialize());
      return { built, ledger: escrowLedger(cs.data) };
    };
    {
      const r = await callEscrow('deposit', [5_000_000n], false);
      await record('escrowDeposit', r.built.private.unprovenTx, `held ${formatNight(r.ledger.held)}`, r.ledger.held === 5_000_000n, [[ESCROW_DIR, 'deposit']]);
    }
    {
      const r = await callEscrow('withdrawToBeneficiary', [recipient], true);
      const circuits = r.built.calls.map((c) => String(c.circuitId));
      await record(
        'escrowWithdraw',
        r.built.private.unprovenTx,
        `${circuits.length} calls in one transaction: ${circuits.join(' then ')}; withdrawn ${r.ledger.withdrawn}`,
        r.ledger.withdrawn && circuits.length === 2 && circuits[0] === 'isReleasedForContract' && circuits[1] === 'withdrawToBeneficiary',
        [[VAULT_DIR, 'isReleasedForContract'], [ESCROW_DIR, 'withdrawToBeneficiary']],
      );
    }
  }

  return { artifacts: real ? 'real' : 'stub', steps, ok: steps.every((s) => s.ok) };
}

export async function dryRun(opts: DryRunOptions): Promise<boolean> {
  const log = opts.log ?? console.log;
  log('Dry run: building every transaction with Midnight.js. No network, nothing is sent.');
  const report = await buildAll({ ...opts, log });
  log('');
  log(report.artifacts === 'real'
    ? 'Built with the real verifier keys from the full compile.'
    : 'Built with stand-in verifier keys (no full compile found): this checks the wiring, not the keys.');
  log(report.ok
    ? `All ${report.steps.length} transactions built${opts.prove ? `; ${report.steps.reduce((n, s) => n + (s.proofs ?? 0), 0)} circuit proofs made in this process` : ''}.`
    : `FAILED: ${report.steps.filter((s) => !s.ok).map((s) => s.name).join(', ')}`);
  log(opts.prove
    ? 'Not covered: the passkey check-in proof, fee balancing, submission, the indexer. Those need the real run.'
    : 'Not covered: proving, fee balancing, submission, the indexer. Those need the real run.');
  return report.ok;
}
