// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Gate V14: the vault's whole life on a real network.
//
//   deploy → deposit → check in (passkey) → check in (wallet) → [deadline passes]
//   → triggerTimeout → [challenge window] → finalizeRelease → claim → read the
//   release event back from the indexer (gate V13)
//   and, with --escrow: deploy the example escrow → deposit → cross-contract
//   withdrawal that asks the vault whether it is released (gate V12).
//   and, with --seals: deploy the seal register and seal a text while the
//   vault is armed, see a genuine key piece refused; after the release hand
//   two pieces over (each a cross-contract call into the vault), open the
//   text from the register's public ledger, and see a made-up piece and a
//   late seal refused.
//
// Every finished step is saved, so a rerun continues where the last one
// stopped. Before each step the script also asks the chain whether the step
// has in fact already happened (a crash between submitting and saving), and
// records it as recovered instead of doing it twice.

import { randomBytes } from 'node:crypto';
import {
  ContractState,
  encodeContractAddress,
  encodeRawTokenType,
  encodeUserAddress,
} from '@midnight-ntwrk/compact-runtime';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { deployContract, findDeployedContract, getUnshieldedBalances } from '@midnight-ntwrk/midnight-js/contracts';
import { deployInStages, insertVerifierKeys, VAULT_DEFER_ORDER } from './staged-deploy.js';
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js/types';
import * as Rx from 'rxjs';
import { ledger as vaultLedger, Phase, pureCircuits as vaultPure, type Ledger as VaultLedger, type VaultConfig } from '@codicil/contracts/vault';
import { ledger as escrowLedger, pureCircuits as escrowPure } from '@codicil/contracts/escrow';
import { ledger as sealsLedger } from '@codicil/contracts/seals';
import {
  checkInDigest,
  claimPackage,
  contractErrorCode,
  handOverArgs,
  heirKeyFromScalar,
  keeperCommitment,
  MerkleTree,
  newEdKey,
  newHeirKey,
  newP256Key,
  newSalt,
  buildWill,
  openMessageText,
  payoutFor,
  piecesHandedOver,
  rpIdHash,
  sealArgs,
  sealedFingerprint,
  sealedFromText,
  sealedToText,
  sealMessage,
  sealOn,
  softwareSigners,
  VAULT_OPTIONS_OFF,
  vaultId,
  verifyCip30Signature,
  verifyWebAuthnAssertion,
  withPasskeyApproval,
  withWalletApproval,
  type CodicilPrivateState,
  type EdKey,
  type P256Key,
  type Will,
} from '@codicil/sdk';
import type { NetworkConfig } from './env.js';
import { latestBlock } from './probes.js';
import {
  ESCROW_PRIVATE_STATE_ID,
  escrowContract,
  escrowProviders,
  inMemoryPrivateStateProvider,
  makePublicDataProvider,
  SEALS_PRIVATE_STATE_ID,
  sealsContract,
  sealsProviders,
  VAULT_PRIVATE_STATE_ID,
  vaultContract,
  vaultProviders,
  type EscrowPrivateState,
  type ProofTimings,
  type SealsPrivateState,
  type ProviderParts,
} from './providers.js';
import { buildResults, formatDust, formatNight, resultsMarkdown, summaryTable } from './results.js';
import {
  encodeJson,
  loadState,
  nextStep,
  recordStep,
  saveState,
  stateProblems,
  STATE_VERSION,
  stepsFor,
  writeFileAtomic,
  type Actors,
  type ReleaseEvent,
  type RunState,
  type Step,
  type StepPlan,
  type StepRecord,
} from './state.js';
import { checkInProblem, extendedDeadline, finalDeadline, firstDeadline, formatDuration, type Timers } from './timers.js';
import {
  errorText,
  midnightWalletProviders,
  readBalances,
  waitSettled,
  type Log,
  type TxTimings,
  type WalletSession,
} from './wallet.js';

/** Name the vault emits on release: `pad(32, "codicil:released:v1")`. */
export const RELEASE_EVENT_NAME = 'codicil:released:v1';

export interface RunOptions {
  cfg: NetworkConfig;
  session: WalletSession;
  timers: Timers;
  plan: StepPlan;
  statePath: string;
  /** Results are written here as `v14-<network>.json` and `.md`. */
  resultsDir: string;
  proofTimeoutMs: number;
  /** Deposit into the vault, in STAR. */
  depositAmount: bigint;
  /** Deposit into the escrow, in STAR. */
  escrowAmount: bigint;
  /** How long to wait for the wallet to settle before each transaction. */
  settleTimeoutMs: number;
  versions: Record<string, string>;
  log: Log;
}

const nowS = (): number => Math.floor(Date.now() / 1000);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const NIGHT_COLOR = (): Uint8Array => encodeRawTokenType(unshieldedToken().raw);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

// ─── Actors: the keys of the throwaway vault ────────────────────────────────

interface Cast {
  passkey: P256Key;
  wallet: EdKey;
  will: Will;
  /** Private state before any approval: owner keys and heir 0's claim package. */
  base: CodicilPrivateState;
}

/** Fresh keys and a two-heir will (60% / 40%). Heir 0 is the one who claims. */
export function newActors(): Actors {
  const passkey = newP256Key();
  const wallet = newEdKey();
  const heirs = [
    { key: newHeirKey(), keySalt: newSalt(), shareBps: 6000n },
    { key: newHeirKey(), keySalt: newSalt(), shareBps: 4000n },
  ];
  const will = buildWill(heirs.map((h) => ({ heir: { pk: h.key.pk, salt: h.keySalt }, shareBps: h.shareBps })));
  return {
    passkey: { sk: passkey.sk, pk: { x: passkey.pk.x, y: passkey.pk.y }, salt: newSalt() },
    wallet: { sk: wallet.sk, pk: { x: wallet.pk.x, y: wallet.pk.y }, salt: newSalt() },
    heirs: heirs.map((h) => ({ sk: h.key.sk, keySalt: h.keySalt, shareBps: h.shareBps })),
    leaves: will.leaves,
  };
}

/** Rebuild keys, will and private state from what the state file holds. */
export function castFrom(actors: Actors): Cast {
  const passkey: P256Key = { sk: actors.passkey.sk, pk: { ...actors.passkey.pk, identity: false } };
  const wallet: EdKey = { sk: actors.wallet.sk, pk: { ...actors.wallet.pk } };
  const tree = new MerkleTree(actors.leaves.map((l) => vaultPure.heirLeafHash(l)));
  const will: Will = { leaves: actors.leaves, tree, root: tree.root };
  const heir = heirKeyFromScalar(actors.heirs[0].sk);
  return {
    passkey,
    wallet,
    will,
    base: {
      passkey: { pk: passkey.pk, salt: actors.passkey.salt },
      wallet: { pk: wallet.pk, salt: actors.wallet.salt },
      claimant: { ...claimPackage(will, 0), key: heir, keySalt: actors.heirs[0].keySalt },
    },
  };
}

export function vaultConfigFor(cast: Cast, timers: Timers, deployedAt: number): VaultConfig {
  return {
    ownerPasskeyCommit: vaultPure.passkeyCommitment(cast.passkey.pk, cast.base.passkey!.salt),
    ownerEdCommit: vaultPure.edKeyCommitment(cast.wallet.pk, cast.base.wallet!.salt),
    passkeyRpIdHash: rpIdHash(),
    willRoot: cast.will.root,
    firstDeadline: firstDeadline(deployedAt, timers),
    maxPeriod: BigInt(timers.maxPeriodS),
    challengeWindow: BigInt(timers.challengeWindowS),
    claimWindow: BigInt(timers.claimWindowS),
    tokenColor: NIGHT_COLOR(),
    // No guardians and no attestor: this run exercises the timeout path.
    guardianRoot: 0n,
    guardianThreshold: 0n,
    attestorKeyCommit: new Uint8Array(32),
    // No grace period, release fee or recovery key: the run covers the circuits it always did.
    ...VAULT_OPTIONS_OFF,
  };
}

// ─── Small helpers ──────────────────────────────────────────────────────────

/** What a finalized transaction tells us, common to deploys and calls. */
interface TxPublic {
  txId: string;
  txHash: string;
  blockHeight: number;
  blockHash: string;
  blockTimestamp: number;
  status: string;
  fees: { paidFees: string; estimatedFees: string };
}

export { VAULT_DEFER_ORDER };

type StepOutcome =
  | { kind: 'tx'; tx: TxPublic; circuits?: string[]; notes?: string[] }
  | { kind: 'recovered'; notes: string[] }
  | { kind: 'read'; notes: string[] };

export function eventNameHex(name: string): string {
  return Buffer.from(name, 'utf8').toString('hex');
}

/** Does an indexer event field (hex, possibly 0x-prefixed and zero-padded) hold this name? */
export function matchesEventName(field: string | undefined, name: string): boolean {
  if (!field) return false;
  const want = eventNameHex(name);
  const got = field.toLowerCase().replace(/^0x/, '');
  return got.replace(/(00)+$/, '') === want || got.startsWith(want);
}

/** Block timestamps come back in seconds or milliseconds depending on the source. */
const toSeconds = (t: number): number => (t > 1e12 ? Math.floor(t / 1000) : t);

// ─── The run ────────────────────────────────────────────────────────────────

export async function runAll(opts: RunOptions): Promise<RunState> {
  const { cfg, session, timers, plan, log } = opts;
  const address = session.identity.address;

  // State: load, or start fresh with new keys.
  let state = loadState(opts.statePath);
  if (state) {
    const problems = stateProblems(state, cfg.name);
    if (problems.length > 0) throw new Error(`cannot resume from ${opts.statePath}:\n  - ${problems.join('\n  - ')}`);
    log(`resuming: ${Object.keys(state.steps).length} step(s) already done`);
  } else {
    state = { version: STATE_VERSION, network: cfg.name, createdAt: new Date().toISOString(), timers, actors: newActors(), steps: {} };
    saveState(opts.statePath, state);
  }
  // A vault's timers are fixed at deployment; keep using the ones it was deployed with.
  const runTimers = state.timers;
  const cast = castFrom(state.actors);

  const timings: TxTimings & ProofTimings = {};
  const publicDataProvider: PublicDataProvider = makePublicDataProvider(cfg);
  const parts: ProviderParts = {
    config: cfg,
    ...midnightWalletProviders(session, timings, log),
    publicDataProvider,
    proofTimings: timings,
    proofTimeoutMs: opts.proofTimeoutMs,
  };
  const vaultPrivate = inMemoryPrivateStateProvider<CodicilPrivateState>();
  const vProviders = vaultProviders(parts, vaultPrivate);
  const recipient = { bytes: encodeUserAddress(session.identity.addressHex) };

  const persist = (next: RunState): void => {
    state = next;
    saveState(opts.statePath, next);
    const results = buildResults(next, { remaining: stepsFor(plan).filter((s) => next.steps[s] === undefined), walletAddress: address, versions: opts.versions });
    writeFileAtomic(`${opts.resultsDir}/v14-${cfg.name}.json`, encodeJson(results), 0o644);
    writeFileAtomic(`${opts.resultsDir}/v14-${cfg.name}.md`, resultsMarkdown(results), 0o644);
  };

  /** Run one step unless it is already recorded, time it, and save what it did. */
  const step = async (name: Step, needsWallet: boolean, body: () => Promise<StepOutcome>): Promise<void> => {
    if (state!.steps[name] !== undefined) return;
    log('');
    log(`── ${name} ──`);
    if (needsWallet) {
      const settled = await waitSettled(session, opts.settleTimeoutMs);
      log(`wallet settled: ${formatNight(readBalances(settled).night)} tNIGHT, ${formatDust(readBalances(settled).dust, 3)} DUST`);
    }
    timings.proveMs = undefined;
    timings.balanceMs = undefined;
    timings.submittedAt = undefined;
    const startedAt = new Date();
    const outcome = await body();
    const finishedAt = new Date();
    const record: StepRecord = {
      step: name,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      totalMs: finishedAt.getTime() - startedAt.getTime(),
      notes: outcome.notes,
    };
    if (outcome.kind === 'tx') {
      const { tx } = outcome;
      Object.assign(record, {
        txId: tx.txId,
        txHash: tx.txHash,
        blockHeight: tx.blockHeight,
        blockHash: tx.blockHash,
        blockTimestamp: toSeconds(tx.blockTimestamp),
        status: tx.status,
        feePaid: tx.fees.paidFees,
        feeEstimated: tx.fees.estimatedFees,
        proveMs: timings.proveMs,
        balanceMs: timings.balanceMs,
        confirmMs: timings.submittedAt === undefined ? undefined : finishedAt.getTime() - timings.submittedAt,
        circuits: outcome.circuits,
      } satisfies Partial<StepRecord>);
      log(`${name}: ${tx.status} in block ${tx.blockHeight}, tx ${tx.txHash}`);
      log(
        `  prove ${fmtMs(timings.proveMs)}, balance ${fmtMs(timings.balanceMs)}, confirm ${fmtMs(record.confirmMs)}, `
        + `fee ${/^\d+$/.test(tx.fees.paidFees) ? formatDust(BigInt(tx.fees.paidFees)) : tx.fees.paidFees} DUST`,
      );
    } else if (outcome.kind === 'recovered') {
      record.status = 'recovered';
    }
    for (const n of outcome.notes ?? []) log(`  ${n}`);
    persist(recordStep(state!, record));
  };

  // ── deploy ──
  await step('deploy', true, async () => {
    const deployedAt = nowS();
    const config = vaultConfigFor(cast, runTimers, deployedAt);
    log(`deploying the vault: first deadline in ${formatDuration(runTimers.firstDeadlineS)}, max period ${formatDuration(runTimers.maxPeriodS)}, challenge window ${formatDuration(runTimers.challengeWindowS)}`);
    // A crash after the deploy transaction but before every verifier key was
    // inserted: the vault exists, so finish it instead of deploying another.
    const half = state!.vault;
    if (half?.maintenanceKey && half.pendingKeys && half.pendingKeys.length > 0) {
      log(`resuming a staged deployment at ${half.address}: ${half.pendingKeys.length} verifier key(s) still to insert`);
      await vaultPrivate.setSigningKey(half.address, half.maintenanceKey as never);
      await insertVerifierKeys({
        providers: vProviders, compiledContract: vaultContract, address: half.address, circuits: half.pendingKeys, log,
        onInserted: (_c, remaining) => persist({ ...state!, vault: { ...state!.vault!, pendingKeys: remaining } }),
      });
      return { kind: 'recovered', notes: [`vault address ${half.address}`, 'the deploy transaction was recorded by an earlier run; its verifier keys are now complete'] };
    }
    const info = {
      deployedAt,
      firstDeadline: config.firstDeadline,
      maxPeriod: config.maxPeriod,
      challengeWindow: config.challengeWindow,
      claimWindow: config.claimWindow,
      depositAmount: opts.depositAmount,
    };
    const deployed = await deployInStages({
      providers: vProviders,
      compiledContract: vaultContract,
      args: [config],
      initialPrivateState: cast.base,
      deferOrder: VAULT_DEFER_ORDER,
      log,
      onDeployed: ({ address: at, signingKey, pending }) => persist({ ...state!, vault: { address: at, ...info, maintenanceKey: signingKey, pendingKeys: pending } }),
      onInserted: (_c, remaining) => persist({ ...state!, vault: { ...state!.vault!, pendingKeys: remaining } }),
    });
    const pub = deployed.deployTx as TxPublic;
    state = { ...state!, vault: { address: deployed.address, ...info, maintenanceKey: deployed.signingKey, pendingKeys: [] } };
    const stages = deployed.plan.deferred.length === 0
      ? `one transaction (${(deployed.plan.writeShare * 100).toFixed(0)}% of a block's write limit)`
      : `${1 + deployed.inserts.length} transactions: all at once it would use ${(deployed.plan.writeShareAllAtOnce * 100).toFixed(0)}% of a block's write limit, so ${deployed.inserts.length} verifier keys were inserted afterwards (${deployed.inserts.map((i) => `${i.circuit} ${i.txHash}`).join('; ')})`;
    return { kind: 'tx', tx: pub, notes: [`vault address ${deployed.address}`, `first deadline ${new Date(Number(config.firstDeadline) * 1000).toISOString()}`, `deployed in ${stages}`] };
  });
  const vault = state.vault;
  if (!vault) throw new Error('no vault address after deploy');
  const vaultAddress = vault.address;

  // Attach to the vault (also on the run that deployed it: one code path).
  const handle = await findDeployedContract(vProviders, {
    compiledContract: vaultContract,
    contractAddress: vaultAddress,
    privateStateId: VAULT_PRIVATE_STATE_ID,
    initialPrivateState: cast.base,
  });
  const setPrivate = (ps: CodicilPrivateState) => vaultPrivate.forContract(vaultAddress).set(VAULT_PRIVATE_STATE_ID, ps);

  const readVault = async (): Promise<VaultLedger> => {
    const read = await publicDataProvider.queryContractState(vaultAddress);
    if (!read) throw new Error(`the indexer has no contract at ${vaultAddress}`);
    return vaultLedger(read.contractState.deserialize({ v9: ContractState }).data);
  };

  /** Wait until both this machine's clock and the chain's finalized blocks have passed `target`. */
  const waitUntil = async (target: bigint, what: string): Promise<void> => {
    let lastLog = 0;
    for (;;) {
      const left = Number(target) - nowS();
      if (left < 0) {
        const block = await latestBlock(cfg.indexerHttp).catch(() => undefined);
        if (block && BigInt(block.timestamp) >= target) return;
      }
      if (Date.now() - lastLog > 60_000) {
        lastLog = Date.now();
        log(left >= 0 ? `waiting ${formatDuration(left + 1)} for ${what} (${new Date(Number(target) * 1000).toISOString()})` : `waiting for a finalized block past ${what}`);
      }
      await sleep(left > 20 ? 15_000 : 5_000);
    }
  };

  // ── deposit ──
  await step('deposit', true, async () => {
    const before = await readVault();
    if (before.estateTotal >= vault.depositAmount) return { kind: 'recovered', notes: [`the vault already holds ${formatNight(before.estateTotal)} tNIGHT; transaction hash not recorded`] };
    const r = await handle.callTx.deposit(vault.depositAmount);
    const balances = await getUnshieldedBalances(publicDataProvider, vaultAddress).catch(() => []);
    const held = balances.reduce((sum, b) => sum + b.balance, 0n);
    return { kind: 'tx', tx: r.public, circuits: r.calls.map((c) => String(c.circuitId)), notes: [`deposited ${formatNight(vault.depositAmount)} tNIGHT; the indexer shows the vault holding ${formatNight(held)}`] };
  });

  /**
   * If the deadline passed before a check-in could land, the vault can no
   * longer be checked in directly ("switch already expired"). Starting the
   * countdown first makes it pending, and a check-in then vetoes it.
   */
  const ensureCheckInPossible = async (l: VaultLedger, notes: string[]): Promise<VaultLedger> => {
    if (l.phase === Phase.released) throw new Error('the vault is already released; check-ins are no longer possible. Start over with `--fresh`');
    if (l.phase !== Phase.armed || BigInt(nowS()) < l.deadline) return l;
    log('the deadline passed before this check-in; starting the countdown so the check-in can veto it');
    await waitUntil(l.deadline, 'the deadline');
    const r = await handle.callTx.triggerTimeout();
    notes.push(`deadline had passed: triggerTimeout (tx ${r.public.txHash}) first, then this check-in vetoed the countdown`);
    await waitSettled(session, opts.settleTimeoutMs);
    return readVault();
  };

  // ── check in with the passkey ──
  await step('checkInPasskey', true, async () => {
    let l = await readVault();
    if (l.nonce >= 1n) return { kind: 'recovered', notes: [`the vault's nonce is already ${l.nonce}; transaction hash not recorded`] };
    const notes: string[] = [];
    l = await ensureCheckInPossible(l, notes);
    const built = nowS();
    const next = extendedDeadline(built, runTimers);
    const problem = checkInProblem(built, next, l.deadline, l.phase === Phase.armed, l.maxPeriod);
    if (problem) throw new Error(`cannot check in: ${problem}`);
    const digest = checkInDigest(vaultAddress, next, l.nonce);
    const assertion = softwareSigners.passkey(cast.passkey, digest);
    if (!verifyWebAuthnAssertion(assertion, digest, cast.passkey.pk)) throw new Error('the software passkey assertion does not verify off-chain');
    await setPrivate(withPasskeyApproval(cast.base, digest, assertion));
    const r = await handle.callTx.checkInPasskey(next);
    const after = await readVault();
    notes.push(`WebAuthn-format assertion (software P-256 key, origin and UV flag as compiled) verified in-circuit`);
    notes.push(`deadline moved from ${l.deadline} to ${after.deadline}; nonce ${l.nonce} → ${after.nonce}`);
    return { kind: 'tx', tx: r.public, circuits: r.calls.map((c) => String(c.circuitId)), notes };
  });

  // ── the seal register, while the vault is armed and the deadline is far off ──
  const seals = plan.seals ? await setupSeals(opts, parts, vaultAddress, readVault, step, () => state!, (s) => { state = s; }) : undefined;
  await seals?.beforeRelease();

  // ── check in with the wallet key; this sets the deadline the run waits out ──
  await step('checkInEd25519', true, async () => {
    let l = await readVault();
    if (l.nonce >= 2n) return { kind: 'recovered', notes: [`the vault's nonce is already ${l.nonce}; transaction hash not recorded`] };
    const notes: string[] = [];
    l = await ensureCheckInPossible(l, notes);
    const built = nowS();
    const previous = state!.steps.checkInPasskey;
    const next = finalDeadline(built, runTimers, previous?.txHash ? previous.totalMs / 1000 : undefined);
    const problem = checkInProblem(built, next, l.deadline, l.phase === Phase.armed, l.maxPeriod);
    if (problem) throw new Error(`cannot check in: ${problem}`);
    const digest = checkInDigest(vaultAddress, next, l.nonce);
    const signature = softwareSigners.wallet(cast.wallet, digest);
    if (!verifyCip30Signature(signature, digest, cast.wallet.pk)) throw new Error('the software CIP-30 signature does not verify off-chain');
    await setPrivate(withWalletApproval(cast.base, digest, signature));
    const r = await handle.callTx.checkInEd25519(next);
    const after = await readVault();
    notes.push('CIP-30-format signature (software Ed25519 key over the 119-byte Sig_structure) verified in-circuit');
    notes.push(`deadline moved from ${l.deadline} to ${after.deadline} (${formatDuration(Number(next) - built)} after it was built); nonce ${l.nonce} → ${after.nonce}`);
    return { kind: 'tx', tx: r.public, circuits: r.calls.map((c) => String(c.circuitId)), notes };
  });

  // ── the owner goes silent; anyone may start the countdown ──
  await step('triggerTimeout', true, async () => {
    const l = await readVault();
    if (l.phase !== Phase.armed) return { kind: 'recovered', notes: [`the vault is already ${Phase[l.phase]}; transaction hash not recorded`] };
    await waitUntil(l.deadline, 'the deadline');
    await setPrivate(cast.base);
    const r = await handle.callTx.triggerTimeout();
    const after = await readVault();
    return { kind: 'tx', tx: r.public, circuits: r.calls.map((c) => String(c.circuitId)), notes: [`deadline ${l.deadline} passed; vault is ${Phase[after.phase]} until ${after.pendingUntil}`] };
  });

  // ── the challenge window passes without a veto ──
  await step('finalizeRelease', true, async () => {
    const l = await readVault();
    if (l.phase === Phase.released) return { kind: 'recovered', notes: ['the vault is already released; transaction hash not recorded'] };
    if (l.phase !== Phase.pending) throw new Error(`the vault is ${Phase[l.phase]}, not pending`);
    await waitUntil(l.pendingUntil, 'the end of the challenge window');
    const r = await handle.callTx.finalizeRelease();
    const after = await readVault();
    return {
      kind: 'tx',
      tx: r.public,
      circuits: r.calls.map((c) => String(c.circuitId)),
      notes: [`released at ${after.releasedAt}; estate snapshot ${formatNight(after.estateSnapshot)} tNIGHT`, `${r.public.logEvents.length} event(s) emitted while executing the circuit`],
    };
  });

  // ── heir 0 claims their share to the test wallet's address ──
  await step('claim', true, async () => {
    const l = await readVault();
    const leaf = cast.will.leaves[0];
    const nullifier = vaultPure.claimNullifier(vaultId(vaultAddress), vaultPure.heirLeafHash(leaf));
    if (l.claimNullifiers.member(nullifier)) return { kind: 'recovered', notes: ['the claim nullifier is already on chain; transaction hash not recorded'] };
    if (l.phase !== Phase.released) throw new Error(`the vault is ${Phase[l.phase]}, not released`);
    const expected = payoutFor(l.estateSnapshot, leaf.shareBps);
    const r = await handle.callTx.claim(recipient);
    const after = await readVault();
    // The indexer reports an owner as a bech32 address (mn_addr_…); accept the hex form too.
    const mine = new Set([address.toLowerCase(), session.identity.addressHex.toLowerCase()]);
    const paid = r.public.unshielded.created.filter((u) => mine.has(u.owner.toLowerCase()) && u.value === expected);
    return {
      kind: 'tx',
      tx: r.public,
      circuits: r.calls.map((c) => String(c.circuitId)),
      notes: [
        `heir 0 (${leaf.shareBps} bps of ${formatNight(l.estateSnapshot)}) claimed ${formatNight(expected)} tNIGHT to ${address}`,
        `estatePaid ${formatNight(l.estatePaid)} → ${formatNight(after.estatePaid)}`,
        paid.length > 0
          ? `the indexer lists a new unshielded UTXO of ${formatNight(expected)} tNIGHT owned by the test wallet in this transaction`
          : `the indexer's record of this transaction lists ${r.public.unshielded.created.length} created UTXO(s), none matching the payout exactly: check by hand`,
      ],
    };
  });

  // ── gate V13: read the release event back from the indexer ──
  await step('readEvents', false, async () => {
    const releaseTx = state!.steps.finalizeRelease?.txHash;
    const deadline = Date.now() + 180_000;
    for (;;) {
      const byTx = releaseTx
        ? await publicDataProvider.queryContractEvents({ contractAddress: vaultAddress, types: ['Misc'], transactionHash: releaseTx }).catch(() => [])
        : [];
      const all = byTx.length > 0 ? byTx : await publicDataProvider.queryContractEvents({ contractAddress: vaultAddress, types: ['Misc'] });
      const found = all.find((e) => e.eventType === 'Misc' && (matchesEventName(e.name, RELEASE_EVENT_NAME) || e.raw.toLowerCase().includes(eventNameHex(RELEASE_EVENT_NAME))));
      if (found) {
        const event: ReleaseEvent = {
          id: found.id,
          eventType: found.eventType,
          name: RELEASE_EVENT_NAME,
          txHash: byTx.length > 0 ? releaseTx : undefined,
          payloadVersion: found.payloadVersion,
          protocolVersion: found.protocolVersion,
        };
        state = { ...state!, releaseEvent: event };
        return {
          kind: 'read',
          notes: [
            `indexer returned the "${RELEASE_EVENT_NAME}" event (id ${found.id}) for the vault`,
            byTx.length > 0 ? `found by the finalizeRelease transaction hash ${releaseTx}` : 'found by contract address (the transaction-hash filter returned nothing)',
          ],
        };
      }
      if (Date.now() > deadline) {
        throw new Error(`the indexer returned ${all.length} Misc event(s) for the vault but none named "${RELEASE_EVENT_NAME}". Run again to retry`);
      }
      await sleep(10_000);
    }
  });

  if (plan.escrow) await runEscrow(opts, parts, timings, vaultAddress, recipient, step, () => state!, (s) => { state = s; });
  await seals?.afterRelease();

  log('');
  log(summaryTable(stepsFor(plan).map((s) => state!.steps[s]).filter((r): r is StepRecord => r !== undefined)));
  const left = nextStep(state, plan);
  log(left ? `stopped before "${left}"` : `gate V14 complete on ${cfg.name}: results in ${opts.resultsDir}/v14-${cfg.name}.md`);
  await Rx.firstValueFrom(session.facade.state()).then((s) => {
    const b = readBalances(s);
    log(`wallet now holds ${formatNight(b.night)} tNIGHT and ${formatDust(b.dust, 3)} DUST`);
  }).catch(() => undefined);
  return state;
}

const fmtMs = (ms: number | undefined): string => (ms === undefined ? '-' : `${(ms / 1000).toFixed(1)} s`);

// ─── Gate V12: the example escrow asks the vault whether it is released ─────

async function runEscrow(
  opts: RunOptions,
  parts: ProviderParts,
  _timings: TxTimings & ProofTimings,
  vaultAddress: string,
  recipient: { bytes: Uint8Array },
  step: (name: Step, needsWallet: boolean, body: () => Promise<StepOutcome>) => Promise<void>,
  getState: () => RunState,
  setState: (s: RunState) => void,
): Promise<void> {
  const { log } = opts;
  if (!getState().actors.escrowSecret) {
    const s = getState();
    const next = { ...s, actors: { ...s.actors, escrowSecret: newSalt() } };
    setState(next);
    saveState(opts.statePath, next);
  }
  const secret = getState().actors.escrowSecret!;
  const escrowPrivate = inMemoryPrivateStateProvider<EscrowPrivateState>();
  const eProviders = await escrowProviders(parts, escrowPrivate, vaultAddress);

  await step('escrowDeploy', true, async () => {
    log('deploying the example escrow, pointing at the vault');
    const deployed = await deployContract(eProviders, {
      compiledContract: escrowContract,
      privateStateId: ESCROW_PRIVATE_STATE_ID,
      initialPrivateState: { secret },
      args: [{ bytes: encodeContractAddress(vaultAddress) }, NIGHT_COLOR(), escrowPure.beneficiaryCommitment(secret)],
    });
    const pub = deployed.deployTxData.public;
    setState({ ...getState(), escrow: { address: pub.contractAddress, amount: opts.escrowAmount } });
    return { kind: 'tx', tx: pub, notes: [`escrow address ${pub.contractAddress}, vault ${vaultAddress}`] };
  });
  const escrow = getState().escrow;
  if (!escrow) throw new Error('no escrow address after deploy');

  const handle = await findDeployedContract(eProviders, {
    compiledContract: escrowContract,
    contractAddress: escrow.address,
    privateStateId: ESCROW_PRIVATE_STATE_ID,
    initialPrivateState: { secret },
  });
  const readEscrow = async () => {
    const read = await parts.publicDataProvider.queryContractState(escrow.address);
    if (!read) throw new Error(`the indexer has no contract at ${escrow.address}`);
    return escrowLedger(read.contractState.deserialize({ v9: ContractState }).data);
  };

  await step('escrowDeposit', true, async () => {
    const before = await readEscrow();
    if (before.held >= escrow.amount || before.withdrawn) return { kind: 'recovered', notes: [`the escrow already holds ${formatNight(before.held)} tNIGHT; transaction hash not recorded`] };
    const r = await handle.callTx.deposit(escrow.amount);
    return { kind: 'tx', tx: r.public, circuits: r.calls.map((c) => String(c.circuitId)), notes: [`deposited ${formatNight(escrow.amount)} tNIGHT into the escrow`] };
  });

  await step('escrowWithdraw', true, async () => {
    const before = await readEscrow();
    if (before.withdrawn) return { kind: 'recovered', notes: ['the escrow is already withdrawn; transaction hash not recorded'] };
    const r = await handle.callTx.withdrawToBeneficiary(recipient);
    const circuits = r.calls.map((c) => `${String(c.contractAddress).slice(0, 8)}…:${String(c.circuitId)}`);
    const paid = r.public.unshielded.created.filter((u) => u.value === before.held);
    return {
      kind: 'tx',
      tx: r.public,
      circuits,
      notes: [
        `${r.calls.length} proofs in one transaction, callee first: ${circuits.join(', ')}`,
        `withdrew ${formatNight(before.held)} tNIGHT to the test wallet once the vault answered "released"`,
        paid.length > 0 ? 'the indexer lists the matching unshielded UTXO in this transaction' : 'no created UTXO matched the withdrawn amount exactly: check by hand',
      ],
    };
  });
}

// ─── The seal register: key pieces are handed over only after the release ───

/** What the run seals. It is public once the run ends; nothing rides on it. */
export const SEALS_TEXT = 'Codicil seal register, network run: these words open only after the vault has released.';
/** How many pieces the key is cut into, and how many rebuild it. */
export const SEALS_PIECES = 3;
export const SEALS_NEEDED = 2;

/** Every message in an error and its causes, joined: a contract's assert text can sit a few levels down. */
export function errorChain(e: unknown): string {
  const out: string[] = [];
  for (let cur: unknown = e, depth = 0; cur !== undefined && cur !== null && depth < 8; depth++) {
    out.push(cur instanceof Error ? cur.message : String(cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return out.join(' | ');
}

/**
 * Make a call the register must refuse, and return the contract's own words.
 * A refused call fails while the circuit runs on this machine, so nothing is
 * proven or sent. Anything else (it went through, or it failed differently)
 * is an error.
 */
export async function expectRefusal(call: () => Promise<unknown>, want: string): Promise<string> {
  try {
    await call();
  } catch (e) {
    const text = errorChain(e);
    if (contractErrorCode(new Error(text)) === want || text.includes(want)) return want;
    throw new Error(`expected the register to refuse with "${want}", but the call failed with: ${text}`);
  }
  throw new Error(`the register accepted a call it should have refused with "${want}"`);
}

interface SealsRun {
  /** Deploy, seal, and see a genuine piece refused: all while the vault is armed. */
  beforeRelease(): Promise<void>;
  /** Hand two pieces over, open the text from the ledger, and see a made-up piece and a late seal refused. */
  afterRelease(): Promise<void>;
}

async function setupSeals(
  opts: RunOptions,
  parts: ProviderParts,
  vaultAddress: string,
  readVault: () => Promise<VaultLedger>,
  step: (name: Step, needsWallet: boolean, body: () => Promise<StepOutcome>) => Promise<void>,
  getState: () => RunState,
  setState: (s: RunState) => void,
): Promise<SealsRun> {
  const { log } = opts;
  if (!getState().actors.seals) {
    // Sealed here, on this machine: the plain text and the key go nowhere.
    const { sealed, pieces } = await sealMessage({ vault: vaultAddress.toLowerCase(), message: SEALS_TEXT, pieces: SEALS_PIECES, needed: SEALS_NEEDED });
    const s = getState();
    const next = {
      ...s,
      actors: { ...s.actors, seals: { keeper: newSalt(), sealedText: sealedToText(sealed), pieces: pieces.map((p) => ({ x: p.x, y: p.y })), text: SEALS_TEXT } },
    };
    setState(next);
    saveState(opts.statePath, next);
  }
  const kit = getState().actors.seals!;
  const sealed = sealedFromText(kit.sealedText);
  const fingerprint = sealedFingerprint(sealed);
  const fingerprintHex = hex(fingerprint);
  const keeper: SealsPrivateState = { keeperSecret: kit.keeper };
  const sealsPrivate = inMemoryPrivateStateProvider<SealsPrivateState>();
  const sProviders = await sealsProviders(parts, sealsPrivate, vaultAddress);

  const attach = async () => {
    const register = getState().seals;
    if (!register) throw new Error('no seal register address after deploy');
    const handle = await findDeployedContract(sProviders, {
      compiledContract: sealsContract,
      contractAddress: register.address,
      privateStateId: SEALS_PRIVATE_STATE_ID,
      initialPrivateState: keeper,
    });
    const read = async () => {
      const got = await parts.publicDataProvider.queryContractState(register.address);
      if (!got) throw new Error(`the indexer has no contract at ${register.address}`);
      return sealsLedger(got.contractState.deserialize({ v9: ContractState }).data);
    };
    /** Act as the owner's device (holds the keeper secret) or as anyone else's (holds nothing). */
    const actAs = (who: 'keeper' | 'guardian') => sealsPrivate.forContract(register.address).set(SEALS_PRIVATE_STATE_ID, who === 'keeper' ? keeper : {});
    return { address: register.address, handle, read, actAs };
  };
  let attached: Awaited<ReturnType<typeof attach>> | undefined;
  const register = async () => (attached ??= await attach());

  const handOver = (name: Step, index: number) => step(name, true, async () => {
    const r = await register();
    const piece = kit.pieces[index];
    const before = piecesHandedOver(await r.read(), fingerprint);
    if (before.some((p) => p.x === piece.x)) return { kind: 'recovered', notes: [`piece ${piece.x} is already on the register's ledger; transaction hash not recorded`] };
    const v = await readVault();
    if (v.phase !== Phase.released) throw new Error(`the vault is ${Phase[v.phase]}, not released`);
    await r.actAs('guardian');
    const tx = await r.handle.callTx.handOver(...handOverArgs(fingerprint, piece));
    const circuits = tx.calls.map((c) => `${String(c.contractAddress).slice(0, 8)}…:${String(c.circuitId)}`);
    const after = piecesHandedOver(await r.read(), fingerprint);
    return {
      kind: 'tx',
      tx: tx.public,
      circuits,
      notes: [
        `${tx.calls.length} proofs in one transaction, callee first: ${circuits.join(', ')}`,
        `piece ${piece.x} of ${SEALS_PIECES} was checked against its commitment and written to the register's public ledger, by a caller holding no keeper secret`,
        `pieces on the ledger for this text: ${after.map((p) => p.x).join(', ')} (${SEALS_NEEDED} needed)`,
      ],
    };
  });

  return {
    async beforeRelease() {
      await step('sealsDeploy', true, async () => {
        log('deploying the seal register, pointing at the vault');
        const deployed = await deployContract(sProviders, {
          compiledContract: sealsContract,
          privateStateId: SEALS_PRIVATE_STATE_ID,
          initialPrivateState: keeper,
          args: [{ bytes: encodeContractAddress(vaultAddress) }, keeperCommitment(kit.keeper)],
        });
        const pub = deployed.deployTxData.public;
        setState({ ...getState(), seals: { address: pub.contractAddress, fingerprint: fingerprintHex } });
        return { kind: 'tx', tx: pub, notes: [`seal register address ${pub.contractAddress}, vault ${vaultAddress}`] };
      });

      await step('sealsSeal', true, async () => {
        const r = await register();
        if (sealOn(await r.read(), fingerprint)) return { kind: 'recovered', notes: [`the register already holds the seal ${fingerprintHex}; transaction hash not recorded`] };
        await r.actAs('keeper');
        // Sealing asks the vault as well: the register takes no new text once the vault has released.
        const tx = await r.handle.callTx.seal(...sealArgs(sealed, kit.pieces, nowS()));
        const circuits = tx.calls.map((c) => `${String(c.contractAddress).slice(0, 8)}…:${String(c.circuitId)}`);
        const l = await r.read();
        const seal = sealOn(l, fingerprint);
        if (!seal) throw new Error('the seal transaction is final but the register does not hold the fingerprint');
        return {
          kind: 'tx',
          tx: tx.public,
          circuits,
          notes: [
            `${tx.calls.length} proofs in one transaction, callee first: ${circuits.join(', ')}`,
            `sealed ${kit.text.length} characters on this machine; the key's guardian half is cut into ${seal.pieces} pieces, ${seal.needed} needed`,
            `fingerprint ${fingerprintHex}, recorded as sealed before ${new Date(Number(seal.sealedBefore) * 1000).toISOString()}`,
            `the register's ledger holds ${l.pieceChecks.size()} piece commitments and ${l.handedOver.size()} pieces: no text, no key`,
          ],
        };
      });

      await step('sealsRefused', false, async () => {
        const r = await register();
        const v = await readVault();
        if (v.phase === Phase.released) {
          return { kind: 'read', notes: ['the vault had already released when this step ran, so the refusal before the release could not be shown on this run'] };
        }
        await r.actAs('guardian');
        const said = await expectRefusal(() => r.handle.callTx.handOver(...handOverArgs(fingerprint, kit.pieces[0])), 'vault not released');
        const l = await r.read();
        return {
          kind: 'read',
          notes: [
            `a genuine piece was refused while the vault is ${Phase[v.phase]}: the register asked the vault and stopped with "${said}"`,
            `the call failed on this machine against the chain's state, so nothing was proven or sent; pieces on the ledger: ${l.handedOver.size()}`,
          ],
        };
      });
    },

    async afterRelease() {
      // Any two of the three pieces: the last and the first.
      await handOver('sealsHandOver1', SEALS_PIECES - 1);
      await handOver('sealsHandOver2', 0);

      await step('sealsOpen', false, async () => {
        const r = await register();
        const onLedger = piecesHandedOver(await r.read(), fingerprint);
        const opened = await openMessageText(sealed, onLedger);
        if (opened !== kit.text) throw new Error('the text opened from the ledger is not the text that was sealed');
        await r.actAs('guardian');
        const said = await expectRefusal(
          () => r.handle.callTx.handOver(...handOverArgs(fingerprint, { x: 2, y: new Uint8Array(randomBytes(32)) })),
          'not a genuine piece',
        );
        // The owner's device comes back after the release and tries to seal something else.
        const late = await sealMessage({ vault: vaultAddress.toLowerCase(), message: `${SEALS_TEXT} (late)`, pieces: SEALS_PIECES, needed: SEALS_NEEDED });
        await r.actAs('keeper');
        const closed = await expectRefusal(() => r.handle.callTx.seal(...sealArgs(late.sealed, late.pieces, nowS())), 'vault released');
        return {
          kind: 'read',
          notes: [
            `read pieces ${onLedger.map((p) => p.x).join(' and ')} from the register's public ledger, rebuilt the key and opened the sealed text: it is the ${opened.length} characters that were sealed`,
            `a made-up piece was refused after the release too: "${said}" (nothing was proven or sent)`,
            `the keeper could not seal another text after the release: "${closed}" (nothing was proven or sent)`,
          ],
        };
      });
    },
  };
}

export { errorText };
