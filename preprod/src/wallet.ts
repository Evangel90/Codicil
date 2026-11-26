// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The throwaway test wallet: Wallet SDK 2.0.1, built as the Midnight docs
// build it (docs.midnight.network/guides/acquire-tokens), plus what a
// resumable script needs on top: saved sync state, a settled check between
// transactions, and the adapter Midnight.js balances and submits through.
//
// The seed is read from the environment by the caller and never logged here.

import './ws-global.js';

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as Rx from 'rxjs';
import {
  createKeystore,
  DustAddress,
  DustWallet,
  generateRandomSeed,
  InMemoryTransactionHistoryStorage,
  isAwaiting,
  mergeWalletEntries,
  PublicKey,
  ShieldedWallet,
  UnshieldedWallet,
  WalletEntrySchema,
  WalletFacade,
  WalletSeeds,
  type FacadeState,
  type UnshieldedKeystore,
} from '@midnightntwrk/wallet-sdk';
import { DustSecretKey, LedgerParameters, Transaction, unshieldedToken, ZswapSecretKeys } from '@midnight-ntwrk/midnight-js-protocol/v9';
import {
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  type MidnightProvider,
  type WalletProvider,
} from '@midnight-ntwrk/midnight-js/types';
import { redact, type NetworkConfig } from './env.js';
import { decodeJson, encodeJson, writeFileAtomic } from './state.js';

export type Log = (line: string) => void;

/** Added to every fee the wallet declares; a DUST spend does not refund it. 0.3 DUST, as in the docs. */
export const ADDITIONAL_FEE_OVERHEAD = 300_000_000_000_000n;
/** Blocks of price movement the fee estimate allows for, as in the docs. */
export const FEE_BLOCKS_MARGIN = 5;

const NIGHT = unshieldedToken().raw;

export function newSeedHex(): string {
  return Buffer.from(generateRandomSeed()).toString('hex');
}

export interface Identity {
  seeds: WalletSeeds;
  keystore: UnshieldedKeystore;
  /** Unshielded address, Bech32m: what the faucet takes. */
  address: string;
  /** The same address as 32 bytes of hex: a contract's `UserAddress`. */
  addressHex: string;
  dustAddress: string;
  coinPublicKey: string;
  encryptionPublicKey: string;
}

/** Everything derived from the seed. Works offline. */
export function deriveIdentity(seedHex: string, networkId: string): Identity {
  const seeds = WalletSeeds.fromMasterSeed(Buffer.from(seedHex, 'hex'));
  const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, networkId);
  const zswap = ZswapSecretKeys.fromSeed(seeds.shielded);
  return {
    seeds,
    keystore,
    address: keystore.getBech32Address().asString(),
    addressHex: keystore.getAddress(),
    dustAddress: DustAddress.encodePublicKey(networkId, DustSecretKey.fromSeed(seeds.dust).publicKey),
    coinPublicKey: zswap.coinPublicKey,
    encryptionPublicKey: zswap.encryptionPublicKey,
  };
}

// ─── Saved sync state ───────────────────────────────────────────────────────
// A first sync replays the chain's history for this wallet: minutes on
// Preview, hours on Preprod. The snapshot lets a rerun start where the last
// one stopped. It is not portable between indexers, so it is tied to one.

interface Snapshot {
  version: 1;
  fingerprint: string;
  savedAt: string;
  shielded: string;
  unshielded: string;
  dust: string;
}

function fingerprint(id: Identity, cfg: NetworkConfig): string {
  const host = new URL(cfg.indexerHttp).host;
  return createHash('sha256').update(`${cfg.networkId}|${host}|${id.addressHex}`).digest('hex');
}

function loadSnapshot(path: string, id: Identity, cfg: NetworkConfig, log: Log): Snapshot | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const snap = decodeJson<Snapshot>(readFileSync(path, 'utf8'));
    if (snap.version !== 1 || snap.fingerprint !== fingerprint(id, cfg)) {
      log('saved wallet state belongs to another wallet, network or indexer; ignoring it');
      return undefined;
    }
    return snap;
  } catch {
    log('saved wallet state could not be read; ignoring it');
    return undefined;
  }
}

export interface WalletSession {
  facade: WalletFacade;
  identity: Identity;
  config: NetworkConfig;
  /** True when this session started from saved sync state. */
  restored: boolean;
  /** Write the sync state to disk now. Safe to call at any time; failures are logged, not thrown. */
  saveSnapshot(): Promise<void>;
  /** Save the sync state and stop the wallet. */
  close(): Promise<void>;
}

export interface OpenOptions {
  /** Where sync state is kept between runs; omit to keep none. */
  snapshotPath?: string;
  /** Ignore saved sync state and sync from the start. */
  fresh?: boolean;
  log?: Log;
}

function walletConfiguration(cfg: NetworkConfig) {
  return {
    networkId: cfg.networkId,
    indexerClientConnection: { indexerHttpUrl: cfg.indexerHttp, indexerWsUrl: cfg.indexerWs },
    // The wallet proves its own DUST spend here, each time it pays a fee.
    provingServerUrl: new URL(cfg.proofServer),
    relayURL: new URL(cfg.nodeWs),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: { additionalFeeOverhead: ADDITIONAL_FEE_OVERHEAD, feeBlocksMargin: FEE_BLOCKS_MARGIN },
  };
}

/** Build and start the wallet. It connects in seconds and syncs in the background. */
export async function openWallet(cfg: NetworkConfig, seedHex: string, opts: OpenOptions = {}): Promise<WalletSession> {
  const log = opts.log ?? (() => {});
  const identity = deriveIdentity(seedHex, cfg.networkId);
  const { seeds, keystore } = identity;
  const snap = opts.snapshotPath && !opts.fresh ? loadSnapshot(opts.snapshotPath, identity, cfg, log) : undefined;

  const build = (from: Snapshot | undefined) =>
    WalletFacade.init({
      configuration: walletConfiguration(cfg),
      shielded: (config) => (from ? ShieldedWallet(config).restore(from.shielded) : ShieldedWallet(config).startWithSeed(seeds.shielded)),
      unshielded: (config) =>
        from ? UnshieldedWallet(config).restore(from.unshielded) : UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
      dust: (config) => (from ? DustWallet(config).restore(from.dust) : DustWallet(config).startWithSeed(seeds.dust)),
    });

  let facade: WalletFacade;
  let restored = false;
  if (snap) {
    try {
      facade = await build(snap);
      restored = true;
      log(`resuming wallet sync from state saved at ${snap.savedAt}`);
    } catch (e) {
      log(`saved wallet state could not be restored (${redact(errorText(e), cfg.secrets)}); syncing from the start`);
      facade = await build(undefined);
    }
  } else {
    facade = await build(undefined);
  }
  await facade.start(seeds);

  const saveSnapshot = async (): Promise<void> => {
    if (!opts.snapshotPath) return;
    try {
      const [shielded, unshielded, dust] = await Promise.all([
        facade.shielded.serializeState(),
        facade.unshielded.serializeState(),
        facade.dust.serializeState(),
      ]);
      const out: Snapshot = { version: 1, fingerprint: fingerprint(identity, cfg), savedAt: new Date().toISOString(), shielded, unshielded, dust };
      writeFileAtomic(opts.snapshotPath, encodeJson(out));
    } catch (e) {
      log(`could not save wallet state: ${redact(errorText(e), cfg.secrets)}`);
    }
  };

  return {
    facade,
    identity,
    config: cfg,
    restored,
    saveSnapshot,
    async close() {
      await saveSnapshot();
      await facade.stop();
    },
  };
}

export function errorText(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    const own = e.message || e.name;
    return cause !== undefined && cause !== e ? `${own} (caused by: ${errorText(cause)})` : own;
  }
  if (typeof e === 'object' && e !== null) {
    const o = e as { message?: unknown; _tag?: unknown };
    if (typeof o.message === 'string') return typeof o._tag === 'string' ? `${o._tag}: ${o.message}` : o.message;
    try { return JSON.stringify(e, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)); } catch { /* fall through */ }
  }
  return String(e);
}

// ─── Sync ───────────────────────────────────────────────────────────────────

const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : 0n);

/** One line describing how far each of the three wallets has synced. */
export function syncLine(state: FacadeState): string {
  const part = (name: string, p: object, applied: string, highest: string): string => {
    const r = p as Record<string, unknown>;
    const a = big(r[applied]);
    const h = big(r[highest]);
    const pct = h > 0n ? ` ${(Number((a * 1000n) / h) / 10).toFixed(1)}%` : '';
    return `${name} ${a}/${h}${pct}${r.isConnected === true ? '' : ' (not connected)'}`;
  };
  return [
    part('shielded', state.shielded.progress, 'appliedIndex', 'highestRelevantWalletIndex'),
    part('unshielded', state.unshielded.progress, 'appliedId', 'highestTransactionId'),
    part('dust', state.dust.progress, 'appliedIndex', 'highestRelevantWalletIndex'),
  ].join(', ');
}

export const isSynced = (s: FacadeState): boolean => s.isSynced && s.protocol._tag === 'Settled';

export class SyncTimeoutError extends Error {
  constructor(seconds: number, readonly last: string) {
    super(`the wallet did not finish syncing within ${seconds} s (${last}). Sync state is saved; run the command again to continue`);
    this.name = 'SyncTimeoutError';
  }
}

/**
 * Wait until all three wallets have caught up with the chain. Prints progress
 * and saves the sync state every few minutes, so an interrupted first sync is
 * not lost.
 */
export async function waitForSync(
  session: WalletSession,
  opts: { timeoutMs: number; log?: Log; progressEveryMs?: number; snapshotEveryMs?: number },
): Promise<FacadeState> {
  const log = opts.log ?? (() => {});
  let last = '';
  let lastSaved = Date.now();
  const started = Date.now();
  const progress = session.facade.state().pipe(Rx.throttleTime(opts.progressEveryMs ?? 15_000)).subscribe((s) => {
    const line = syncLine(s);
    if (line !== last && !isSynced(s)) log(`syncing: ${line}`);
    last = line;
    if (Date.now() - lastSaved > (opts.snapshotEveryMs ?? 300_000)) {
      lastSaved = Date.now();
      void session.saveSnapshot();
    }
  });
  try {
    return await Rx.firstValueFrom(
      session.facade.state().pipe(
        Rx.filter(isSynced),
        Rx.timeout({ first: opts.timeoutMs, with: () => Rx.throwError(() => new SyncTimeoutError(Math.round(opts.timeoutMs / 1000), last)) }),
      ),
    );
  } finally {
    progress.unsubscribe();
    if (Date.now() - started > 60_000) await session.saveSnapshot();
  }
}

/**
 * True once the wallet has applied the result of everything it submitted:
 * nothing awaiting an answer, no NIGHT in flight, and a DUST UTXO free to pay
 * the next fee. The docs: "Wait until the wallet has applied the confirmation
 * before you build the next transaction. A resolved submitTransaction call and
 * an isSynced value of true do not mean that it has."
 */
export const isSettled = (s: FacadeState): boolean =>
  isSynced(s) && !s.lifecycle.some(isAwaiting) && s.unshielded.pendingCoins.length === 0 && s.dust.availableCoins.length > 0;

export async function waitSettled(session: WalletSession, timeoutMs: number): Promise<FacadeState> {
  return Rx.firstValueFrom(
    session.facade.state().pipe(
      Rx.filter(isSettled),
      Rx.timeout({
        first: timeoutMs,
        with: () =>
          Rx.throwError(() => new Error(
            `the wallet did not settle within ${Math.round(timeoutMs / 1000)} s (a transaction still pending, or no spendable DUST). `
            + 'On Blockfrost the sync signal can lag about 5 minutes after a transaction; run the command again to continue',
          )),
      }),
    ),
  );
}

// ─── Balances and DUST ──────────────────────────────────────────────────────

export interface Balances {
  /** tNIGHT in STAR (10^6 per NIGHT), confirmed UTXOs only. */
  night: bigint;
  /** DUST in SPECK (10^15 per DUST) right now, from UTXOs no transaction has locked. */
  dust: bigint;
  nightUtxos: number;
  /** NIGHT UTXOs not registered for DUST generation. */
  unregistered: number;
  dustUtxos: number;
}

export function readBalances(state: FacadeState, at: Date = new Date()): Balances {
  const coins = state.unshielded.availableCoins.filter((c) => c.utxo.type === NIGHT);
  return {
    night: state.unshielded.balances[NIGHT] ?? 0n,
    dust: state.dust.balance(at),
    nightUtxos: coins.length,
    unregistered: coins.filter((c) => c.meta?.registeredForDustGeneration !== true).length,
    dustUtxos: state.dust.availableCoins.length,
  };
}

/** Wait for tNIGHT to arrive. Balances stream in while the wallet is still syncing. */
export async function waitForNight(session: WalletSession, timeoutMs: number): Promise<bigint> {
  return Rx.firstValueFrom(
    session.facade.state().pipe(
      Rx.map((s) => s.unshielded.balances[NIGHT] ?? 0n),
      Rx.filter((b) => b > 0n),
      Rx.timeout({ first: timeoutMs, with: () => Rx.throwError(() => new Error(`no tNIGHT arrived within ${Math.round(timeoutMs / 1000)} s`)) }),
    ),
  );
}

/**
 * Register every unregistered NIGHT UTXO so it generates DUST for this
 * wallet. A first registration pays its own fee from the DUST the NIGHT would
 * have generated since it arrived, carries no DUST spend, and so needs no
 * proof server. Returns the transaction id, or undefined if there was nothing
 * to register.
 */
export async function registerForDust(session: WalletSession, state: FacadeState, opts: { log?: Log; waitMs?: number } = {}): Promise<string | undefined> {
  const log = opts.log ?? (() => {});
  const { facade, identity } = session;
  const unregistered = state.unshielded.availableCoins.filter((c) => c.utxo.type === NIGHT && c.meta?.registeredForDustGeneration !== true);
  if (unregistered.length === 0) return undefined;
  const { fee } = await facade.estimateRegistration(unregistered);
  log(`registering ${unregistered.length} NIGHT UTXO(s); waiting until they have generated the registration fee (${fee} SPECK)`);
  await facade.waitForGeneratedDust(unregistered, fee, { timeoutMs: opts.waitMs ?? 600_000 });
  const recipe = await facade.registerNightUtxosForDustGeneration(
    unregistered,
    identity.keystore.getPublicKey(),
    (payload) => identity.keystore.signDataAsync(payload),
  );
  const finalized = await facade.finalizeRecipe(recipe);
  return facade.submitTransaction(finalized);
}

/** Wait until the wallet is settled and holds at least `minSpeck` of DUST. */
export async function waitForDust(session: WalletSession, minSpeck: bigint, opts: { timeoutMs: number; log?: Log; format?: (speck: bigint) => string }): Promise<bigint> {
  const log = opts.log ?? (() => {});
  const fmt = opts.format ?? ((s: bigint) => `${s} SPECK`);
  const deadline = Date.now() + opts.timeoutMs;
  let lastLog = 0;
  for (;;) {
    const s = await Rx.firstValueFrom(session.facade.state());
    const dust = isSynced(s) ? s.dust.balance(new Date()) : 0n;
    if (isSynced(s) && dust >= minSpeck) return dust;
    if (Date.now() > deadline) {
      throw new Error(`DUST did not reach ${fmt(minSpeck)} within ${Math.round(opts.timeoutMs / 1000)} s (have ${fmt(dust)}). It keeps generating; run the command again`);
    }
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      log(isSynced(s) ? `DUST ${fmt(dust)} of ${fmt(minSpeck)} needed` : `waiting for sync: ${syncLine(s)}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// ─── Midnight.js adapter ────────────────────────────────────────────────────

export interface TxTimings {
  balanceMs?: number;
  /** What the wallet estimated this transaction would cost, in SPECK. */
  feeEstimate?: bigint;
  /** Bytes of ledger state the finalized transaction writes; a block allows 50,000. */
  bytesWritten?: number;
  submittedAt?: number;
}

/**
 * The two providers Midnight.js needs from a wallet. Transactions cross as
 * bytes: `adoptTransaction` reads them with the wallet SDK's own ledger copy,
 * at the protocol version the wallet is acting at.
 */
export function midnightWalletProviders(session: WalletSession, timings: TxTimings, log: Log = () => {}): { walletProvider: WalletProvider; midnightProvider: MidnightProvider } {
  const { facade, identity } = session;
  const dust = (speck: bigint) => `${(Number(speck) / 1e15).toFixed(3)} DUST`;
  const dustNow = async () => {
    const s = await Rx.firstValueFrom(facade.state());
    return isSynced(s) ? s.dust.balance(new Date()) : 0n;
  };
  const shortOfDust = (e: unknown): boolean => {
    for (let x: unknown = e, depth = 0; x && depth < 6; x = (x as { cause?: unknown }).cause, depth++) {
      if (/could not balance dust|InsufficientFunds/i.test(x instanceof Error ? `${x.name} ${x.message}` : String(x))) return true;
    }
    return false;
  };
  const walletProvider = createLedger9WalletProvider({
    async balanceTx(tx, ttl) {
      const started = Date.now();
      const bytes = tx.serialize();
      // Fees are paid in DUST, which a wallet generates over time and cannot
      // buy. A transaction that costs more than the wallet holds is not a
      // failure, only early: say what it needs and wait for it. A deployment
      // carries every verifier key, so it costs far more than a call.
      const estimate = await facade.estimateTransactionFee(facade.adoptTransaction(bytes, 'Unbound'))
        .catch(() => facade.calculateTransactionFee(facade.adoptTransaction(bytes, 'Unbound')))
        .catch(() => undefined);
      if (estimate !== undefined) {
        timings.feeEstimate = estimate;
        const have = await dustNow();
        log(`  fee estimate ${dust(estimate)}; the wallet holds ${dust(have)}`);
        if (have < estimate) {
          await waitForDust(session, estimate + estimate / 20n, { timeoutMs: 6 * 3600_000, log: (l) => log(`  ${l}`), format: dust });
        }
      }
      for (let attempt = 1; ; attempt++) {
        try {
          const unbound = facade.adoptTransaction(bytes, 'Unbound');
          const recipe = await facade.balanceUnboundTransaction(unbound, { ttl: ttl ?? new Date(Date.now() + 3600_000) });
          const signed = await facade.signRecipe(recipe, (payload) => identity.keystore.signDataAsync(payload));
          const finalized = await facade.finalizeRecipe(signed);
          timings.balanceMs = Date.now() - started;
          return finalized.serialize();
        } catch (e) {
          // The estimate can fall short of what balancing needs. DUST keeps
          // arriving, so try again every minute for up to three hours.
          if (!shortOfDust(e) || attempt >= 180) throw e;
          if (attempt % 5 === 1) log(`  not enough DUST yet (${dust(await dustNow())}); it is still generating, trying again every minute`);
          await new Promise((r) => setTimeout(r, 60_000));
        }
      }
    },
    getCoinPublicKey: () => identity.coinPublicKey,
    getEncryptionPublicKey: () => identity.encryptionPublicKey,
  });
  const midnightProvider = createLedger9MidnightProvider(async (tx) => {
    // How much of a block this transaction takes. The node refuses one that is
    // too big ("would exhaust the block limits"), and the size that matters is
    // the bytes of state it writes, not the bytes of the transaction.
    try {
      const params = LedgerParameters.initialParameters();
      const cost = Transaction.deserialize('signature', 'proof', 'binding', tx.serialize()).cost(params);
      timings.bytesWritten = Number(cost.bytesWritten);
      log(`  writes ${cost.bytesWritten} bytes of state (a block allows ${/block_limits[\s\S]*?bytes_written:\s*(\d+)/.exec(params.toString())?.[1] ?? '50000'}), ${tx.serialize().length} bytes on the wire`);
    } catch { /* a diagnostic only */ }
    try {
      const id = await facade.submitTransaction(facade.adoptTransaction(tx.serialize(), 'Finalized'));
      timings.submittedAt = Date.now();
      return id;
    } catch (e) {
      // Midnight.js replaces a submission failure with a generic message. The
      // node's own reason (which rule the transaction broke) is what a person
      // needs, and it holds no key material, so show the whole chain here.
      for (let x: unknown = e, depth = 0; x && depth < 6; x = (x as { cause?: unknown }).cause, depth++) {
        const err = x as { name?: string; message?: string; _tag?: string };
        let extra = '';
        try {
          // Leave out the transaction bytes; keep every message and code.
          extra = JSON.stringify(x, (k, v) => (
            k === 'txData' || v instanceof Uint8Array ? undefined
              : typeof v === 'bigint' ? v.toString()
              : v instanceof Error ? { ...v, name: v.name, message: v.message, cause: (v as { cause?: unknown }).cause }
              : v))?.slice(0, 3000) ?? '';
        } catch { /* not serializable */ }
        log(`  submit failed [${depth}] ${err._tag ?? err.name ?? typeof x}: ${err.message ?? String(x)} ${extra}`);
      }
      log(`  transaction size ${tx.serialize().length} bytes`);
      throw e;
    }
  });
  return { walletProvider, midnightProvider };
}

// ─── One wallet session per seed ────────────────────────────────────────────
// Two wallet instances on one seed spend the same DUST UTXO and the node
// rejects the second transaction (DustDoubleSpend), so commands take a lock.

export function acquireLock(path: string): () => void {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8').trim());
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM'; }
    }
    if (alive && pid !== process.pid) {
      throw new Error(`another command is using this wallet (process ${pid}). Wait for it, or stop it; two wallets on one seed double-spend DUST`);
    }
  }
  writeFileAtomic(path, `${process.pid}\n`);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { rmSync(path, { force: true }); } catch { /* nothing to release */ }
  };
}
