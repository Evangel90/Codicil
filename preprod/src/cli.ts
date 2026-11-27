// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Entry point: `tsx src/cli.ts <command>`. See docs/PREPROD.md.
//
// Modules that load the wallet SDK or the compiled contracts are imported
// lazily, so `init`, `status` and the first half of `check` work on a fresh
// checkout and start fast.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatLine, formatMissing, preflight, type Preflight } from './check.js';
import { ENV_KEYS, mergeEnv, parseDotEnv, parseNetworkName, redact, resolveNetwork, seedProblem, type Env, type NetworkConfig } from './env.js';
import { planInit } from './init.js';
import { createNoiseFilter } from './noise.js';
import { parseArgs, settingsFromEnv, USAGE, type CliOptions, type Settings } from './options.js';
import { ENV_PATH, ESCROW_DIR, networkPaths, REPO_ROOT, RESULTS_DIR, SEALS_DIR, VAULT_DIR } from './paths.js';
import { buildResults, formatDust, formatNight, resultsMarkdown, summaryTable } from './results.js';
import { loadState, nextStep, stepsFor, type StepRecord } from './state.js';
import { estimateRun, formatDuration, timersFromEnv } from './timers.js';

// ─── Output: timestamps, and no secret ever reaches the terminal ────────────

const secrets: string[] = [];

/**
 * Redact everything this process writes. Our own lines never contain the seed
 * or the token, but libraries print request URLs when a connection drops, and
 * on Preprod those URLs carry the Blockfrost token. The same hook hides the
 * libraries' routine connection chatter (see noise.ts).
 */
function installRedaction(): void {
  const debug = process.env.CODICIL_DEBUG === '1';
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    const quiet = debug ? (text: string): string => text : createNoiseFilter();
    stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') return original(quiet(redact(chunk, secrets)), ...rest);
      if (chunk instanceof Uint8Array) return original(quiet(redact(Buffer.from(chunk).toString('utf8'), secrets)), ...rest.filter((r) => typeof r === 'function'));
      return original(chunk, ...rest);
    }) as typeof stream.write;
  }
}

const stamp = (): string => new Date().toISOString().slice(11, 19);
const log = (line: string): void => { console.log(line === '' ? '' : `[${stamp()}] ${line}`); };
const say = (line: string): void => { console.log(line); };

function loadEnvironment(): { env: Env; envText: string | undefined } {
  const envText = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : undefined;
  const env = mergeEnv(envText === undefined ? {} : parseDotEnv(envText), process.env);
  for (const key of [ENV_KEYS.seed, ENV_KEYS.blockfrost]) {
    const v = env[key];
    if (v && v.length >= 8) secrets.push(v);
  }
  return { env, envText };
}

function requireNetwork(env: Env): NetworkConfig {
  const resolved = resolveNetwork(env);
  if (!resolved.ok) throw new Error(resolved.problems.join('\n'));
  for (const w of resolved.warnings) log(`warning: ${w}`);
  return resolved.value;
}

function requireSeed(env: Env): string {
  const problem = seedProblem(env[ENV_KEYS.seed]);
  if (problem) throw new Error(problem);
  return env[ENV_KEYS.seed]!;
}

// ─── init ───────────────────────────────────────────────────────────────────

async function init(): Promise<number> {
  const { env, envText } = loadEnvironment();
  const { newSeedHex, deriveIdentity } = await import('./wallet.js');
  const plan = planInit(envText, process.env[ENV_KEYS.seed], newSeedHex);
  secrets.push(plan.seed);
  if (plan.write !== undefined) {
    writeFileSync(ENV_PATH, plan.write, { mode: 0o600 });
    chmodSync(ENV_PATH, 0o600);
    say(`Created a throwaway test wallet. Its seed is in ${ENV_PATH} (gitignored, readable by you only).`);
    say('The seed is not shown here and is never logged. It guards test tokens only; do not reuse it for anything else.');
  } else {
    say(`A wallet seed already exists (${plan.source === 'env-file' ? ENV_PATH : `the ${ENV_KEYS.seed} environment variable`}); left as it is.`);
  }
  const name = parseNetworkName(env[ENV_KEYS.network]) ?? 'preprod';
  const id = deriveIdentity(plan.seed, name);
  say('');
  say(`Network: ${name}`);
  say(`Unshielded address to fund: ${id.address}`);
  const faucet = name === 'preprod' ? 'https://midnight-tmnight-preprod.nethermind.dev/' : name === 'preview' ? 'https://faucet.preview.midnight.network/' : undefined;
  say(faucet
    ? `Faucet (has a captcha, gives 5,000 tNIGHT): ${faucet}`
    : 'The local network has no faucet: fund this address from the midnight-local-dev funding menu (option 2).');
  say('');
  say('Next: fund the address, then `npm run preprod:dust`.');
  return 0;
}

// ─── check ──────────────────────────────────────────────────────────────────

async function check(options: CliOptions): Promise<number> {
  const { env } = loadEnvironment();
  let settings: Settings | undefined;
  const extraMissing: string[] = [];
  try { settings = settingsFromEnv(env); } catch (e) { extraMissing.push((e as Error).message); }
  try { timersFromEnv(env); } catch (e) { extraMissing.push((e as Error).message); }

  say(`Codicil gate V14 preflight (${new Date().toISOString()})`);
  const pre = await preflight({
    env,
    vaultDir: VAULT_DIR,
    escrowDir: ESCROW_DIR,
    escrow: options.escrow,
    sealsDir: SEALS_DIR,
    seals: options.seals,
  });
  for (const l of pre.lines) say(formatLine(l));
  for (const m of extraMissing) say(formatLine({ level: 'fail', text: m }));
  const missing = [...pre.missing, ...extraMissing];

  const walletReady = pre.network && pre.seedOk && pre.indexer && pre.node;
  if (options.noWallet) {
    say(formatLine({ level: 'skip', text: 'wallet not checked (--no-wallet)' }));
  } else if (!walletReady) {
    say(formatLine({ level: 'skip', text: 'wallet not checked: it needs the seed, the indexer and the node' }));
  } else {
    missing.push(...(await checkWallet(pre, env, settings ?? settingsFromEnv({}), options)));
  }

  say('');
  say(formatMissing(missing));
  if (missing.length === 0) {
    const est = estimateRun(timersFromEnv(env), { escrow: options.escrow, seals: options.seals });
    const flags = [options.escrow ? '--escrow' : '', options.seals ? '--seals' : ''].filter(Boolean).join(' ');
    say(`Ready. \`npm run preprod:run${flags ? ` -- ${flags}` : ''}\` should take about ${formatDuration(est.totalS)}.`);
  }
  return missing.length === 0 ? 0 : 1;
}

async function checkWallet(pre: Preflight, env: Env, settings: Settings, options: CliOptions): Promise<string[]> {
  const cfg = pre.network!;
  const missing: string[] = [];
  const wallet = await import('./wallet.js');
  const paths = networkPaths(cfg.name);
  mkdirSync(paths.dir, { recursive: true });
  let release: (() => void) | undefined;
  try {
    release = wallet.acquireLock(paths.lock);
  } catch (e) {
    say(formatLine({ level: 'skip', text: `wallet not checked: ${(e as Error).message}` }));
    return missing;
  }
  const session = await wallet.openWallet(cfg, requireSeed(env), {
    snapshotPath: paths.walletSnapshot,
    fresh: options.freshSync,
    log: (l) => say(formatLine({ level: 'ok', text: l })),
  });
  say(formatLine({ level: 'ok', text: `wallet address ${session.identity.address}` }));
  const timeoutS = options.syncTimeoutS ?? 90;
  try {
    const state = await wallet.waitForSync(session, { timeoutMs: timeoutS * 1000, log: (l) => say(`        ${l}`) });
    const b = wallet.readBalances(state);
    say(formatLine({ level: 'ok', text: `wallet synced: ${formatNight(b.night)} tNIGHT in ${b.nightUtxos} UTXO(s), ${formatDust(b.dust, 3)} DUST` }));
    const needNight = settings.depositStar + (options.escrow ? settings.escrowStar : 0n);
    if (b.night === 0n) {
      missing.push(`the wallet has no tNIGHT: fund ${session.identity.address}${cfg.faucet ? ` at ${cfg.faucet}` : ''}`);
    } else if (b.night < needNight) {
      missing.push(`the wallet has ${formatNight(b.night)} tNIGHT but the run deposits ${formatNight(needNight)}`);
    }
    if (b.night > 0n && b.unregistered > 0) {
      missing.push(`${b.unregistered} tNIGHT UTXO(s) are not registered for DUST generation: run \`npm run preprod:dust\``);
    } else if (b.night > 0n && b.dust < settings.minDustSpeck) {
      missing.push(`the wallet has ${formatDust(b.dust, 3)} DUST; a run starts at ${formatDust(settings.minDustSpeck, 0)}. It is generating: wait, or run \`npm run preprod:dust\` to watch`);
    }
  } catch (e) {
    if (e instanceof wallet.SyncTimeoutError) {
      say(formatLine({ level: 'warn', text: `wallet not synced after ${timeoutS} s (${e.last})` }));
      missing.push('the wallet has not finished its first sync: run `npm run preprod:dust`, which keeps syncing and saves its progress (minutes on Preview, possibly hours on Preprod)');
    } else {
      missing.push(`wallet check failed: ${redact(wallet.errorText(e), cfg.secrets)}`);
    }
  } finally {
    await session.close().catch(() => undefined);
    release();
  }
  return missing;
}

// ─── Shared: open the wallet for a command that transacts ───────────────────

async function withWallet<T>(
  cfg: NetworkConfig,
  env: Env,
  settings: Settings,
  options: CliOptions,
  body: (session: import('./wallet.js').WalletSession, wallet: typeof import('./wallet.js')) => Promise<T>,
): Promise<T> {
  const wallet = await import('./wallet.js');
  const paths = networkPaths(cfg.name);
  mkdirSync(paths.dir, { recursive: true });
  const release = wallet.acquireLock(paths.lock);
  let session: import('./wallet.js').WalletSession | undefined;
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) process.exit(130);
    stopping = true;
    log(`${signal}: saving wallet state and stopping (press again to stop at once)`);
    void (session?.close() ?? Promise.resolve()).catch(() => undefined).finally(() => {
      release();
      process.exit(130);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    session = await wallet.openWallet(cfg, requireSeed(env), {
      snapshotPath: paths.walletSnapshot,
      fresh: options.freshSync,
      log,
    });
    log(`wallet address ${session.identity.address}`);
    return await body(session, wallet);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (!stopping) {
      await session?.close().catch(() => undefined);
      release();
    }
  }
}

// ─── dust ───────────────────────────────────────────────────────────────────

async function dust(options: CliOptions): Promise<number> {
  const { env } = loadEnvironment();
  const cfg = requireNetwork(env);
  const settings = settingsFromEnv(env);
  const syncTimeoutMs = options.syncTimeoutS ? options.syncTimeoutS * 1000 : settings.syncTimeoutMs;
  // Fail fast, and in plain words, on a wrong token or an unreachable network.
  const { probeIndexer, probeNode } = await import('./probes.js');
  for (const probe of await Promise.all([probeIndexer(cfg), probeNode(cfg)])) {
    if (!probe.ok) throw new Error(probe.detail);
    log(probe.detail);
  }
  return withWallet(cfg, env, settings, options, async (session, wallet) => {
    const first = await (await import('rxjs')).firstValueFrom(session.facade.state());
    if (wallet.readBalances(first).night === 0n) {
      log(`waiting for tNIGHT. Send some to ${session.identity.address}${cfg.faucet ? ` from ${cfg.faucet}` : ''}`);
      log('(a balance appears as soon as the wallet has read the funding transaction; the full sync continues after)');
    }
    const night = await wallet.waitForNight(session, syncTimeoutMs);
    log(`tNIGHT received: ${formatNight(night)}`);

    log('syncing the wallet (a first sync replays chain history: minutes on Preview, possibly hours on Preprod; progress is saved)');
    let state = await wallet.waitForSync(session, { timeoutMs: syncTimeoutMs, log });
    let b = wallet.readBalances(state);
    log(`synced: ${formatNight(b.night)} tNIGHT in ${b.nightUtxos} UTXO(s), ${b.unregistered} not registered, ${formatDust(b.dust, 3)} DUST`);

    if (b.unregistered > 0) {
      const txId = await wallet.registerForDust(session, state, { log });
      log(`DUST registration submitted: ${txId}`);
      state = await wallet.waitSettled(session, settings.settleTimeoutMs);
      b = wallet.readBalances(state);
      log(`registration applied: ${b.nightUtxos} tNIGHT UTXO(s), ${b.unregistered} not registered`);
    } else {
      log('all tNIGHT is already registered for DUST generation');
    }
    const have = await wallet.waitForDust(session, settings.minDustSpeck, { timeoutMs: syncTimeoutMs, log, format: (s) => `${formatDust(s, 3)} DUST` });
    log(`DUST balance ${formatDust(have, 3)}: enough to start a run (threshold ${formatDust(settings.minDustSpeck, 0)}). Next: \`npm run preprod:run\``);
    return 0;
  });
}

// ─── run ────────────────────────────────────────────────────────────────────

async function prefetchParams(cfg: NetworkConfig, ks: number[]): Promise<void> {
  // The proof server downloads public parameters for a circuit size the first
  // time it proves one (k 18 is about 50 MB). Fetch them now, so that download
  // does not eat into a check-in's deadline.
  for (const k of ks) {
    const started = Date.now();
    try {
      const res = await fetch(`${cfg.proofServer}/fetch-params/${k}`, { signal: AbortSignal.timeout(30 * 60_000) });
      await res.arrayBuffer();
      log(`proof server has the public parameters for k=${k} (HTTP ${res.status}, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    } catch (e) {
      log(`warning: could not prefetch public parameters for k=${k} (${(e as Error).message}); the first proof of that size will download them`);
    }
  }
}

async function run(options: CliOptions): Promise<number> {
  const { env } = loadEnvironment();
  const cfg = requireNetwork(env);
  const settings = settingsFromEnv(env);
  const timers = timersFromEnv(env);
  const plan = { escrow: options.escrow, seals: options.seals };
  const paths = networkPaths(cfg.name);

  // Everything that can be checked without the wallet is checked first.
  const pre = await preflight({ env, vaultDir: VAULT_DIR, escrowDir: ESCROW_DIR, escrow: options.escrow, sealsDir: SEALS_DIR, seals: options.seals });
  for (const l of pre.lines) say(formatLine(l));
  if (pre.missing.length > 0) {
    say('');
    say(formatMissing(pre.missing));
    return 1;
  }

  if (options.fresh && existsSync(paths.state)) {
    const aside = join(paths.dir, `state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    renameSync(paths.state, aside);
    log(`--fresh: the previous run was set aside as ${aside}`);
  }
  const existing = loadState(paths.state);
  const est = estimateRun(existing?.timers ?? timers, plan);
  log(`plan: ${stepsFor(plan).join(' → ')}`);
  log(`expected time once the wallet is synced: about ${formatDuration(est.totalS)}`);
  for (const l of est.lines) log(`  ${l}`);

  const versions: Record<string, string> = {
    ...packageVersions(),
    'Compact compiler': pre.artifacts[0]?.compilerVersion ?? '?',
    'Proof server': pre.proofServer?.version ?? '?',
    'Node': `${pre.node?.chain ?? '?'} ${pre.node?.version ?? '?'}, ledger ${pre.node?.ledgerVersion ?? '?'}`,
    'Indexer protocol version': String(pre.indexer?.protocolVersion ?? '?'),
  };

  return withWallet(cfg, env, settings, options, async (session, wallet) => {
    const syncTimeoutMs = options.syncTimeoutS ? options.syncTimeoutS * 1000 : settings.syncTimeoutMs;
    const state = await wallet.waitForSync(session, { timeoutMs: syncTimeoutMs, log });
    const b = wallet.readBalances(state);
    log(`wallet synced: ${formatNight(b.night)} tNIGHT, ${formatDust(b.dust, 3)} DUST`);
    if (!existing?.steps.deploy) {
      const needNight = settings.depositStar + (options.escrow ? settings.escrowStar : 0n);
      if (b.night < needNight) throw new Error(`the wallet has ${formatNight(b.night)} tNIGHT but the run deposits ${formatNight(needNight)}: fund ${session.identity.address}`);
      if (b.unregistered > 0 && b.dust === 0n) throw new Error('the wallet\'s tNIGHT is not registered for DUST generation: run `npm run preprod:dust` first');
      if (b.dust < settings.minDustSpeck) {
        throw new Error(`the wallet has ${formatDust(b.dust, 3)} DUST; a run starts at ${formatDust(settings.minDustSpeck, 0)} so it cannot run dry between deadlines. Run \`npm run preprod:dust\` to wait for it`);
      }
    }
    if (pre.maxK !== undefined) {
      const { circuitSizes } = await import('./check.js');
      const { VAULT_RUN_CIRCUITS } = await import('./artifacts.js');
      const ks = [...new Set(circuitSizes(VAULT_DIR, VAULT_RUN_CIRCUITS).map((s) => s.k).filter((k) => k > 15))].sort((a, c) => a - c);
      await prefetchParams(cfg, ks);
    }
    const { runAll } = await import('./run.js');
    const final = await runAll({
      cfg,
      session,
      timers,
      plan,
      statePath: paths.state,
      resultsDir: RESULTS_DIR,
      proofTimeoutMs: settings.proofTimeoutMs,
      depositAmount: settings.depositStar,
      escrowAmount: settings.escrowStar,
      settleTimeoutMs: settings.settleTimeoutMs,
      versions,
      log,
    });
    return nextStep(final, plan) === undefined ? 0 : 1;
  });
}

function packageVersions(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'preprod', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const d = pkg.dependencies;
  return {
    'Midnight.js': d['@midnight-ntwrk/midnight-js'],
    'Wallet SDK': d['@midnightntwrk/wallet-sdk'],
    'compact-runtime': d['@midnight-ntwrk/compact-runtime'],
  };
}

// ─── status ─────────────────────────────────────────────────────────────────

function status(options: CliOptions): number {
  const { env } = loadEnvironment();
  const name = parseNetworkName(env[ENV_KEYS.network]);
  if (!name) throw new Error(`${ENV_KEYS.network} is not a known network`);
  const paths = networkPaths(name);
  const state = loadState(paths.state);
  if (!state) {
    say(`No run recorded for ${name} (${paths.state} does not exist).`);
    return 0;
  }
  const plan = { escrow: options.escrow || state.steps.escrowDeploy !== undefined, seals: options.seals || state.steps.sealsDeploy !== undefined };
  const remaining = stepsFor(plan).filter((s) => state.steps[s] === undefined);
  say(`Run on ${name}, started ${state.createdAt}`);
  if (state.vault) say(`Vault: ${state.vault.address}`);
  if (state.escrow) say(`Escrow: ${state.escrow.address}`);
  if (state.seals) say(`Seal register: ${state.seals.address} (sealed text fingerprint ${state.seals.fingerprint})`);
  say('');
  say(summaryTable(stepsFor(plan).map((s) => state.steps[s]).filter((r): r is StepRecord => r !== undefined)));
  say('');
  say(remaining.length === 0 ? 'Complete.' : `Next step: ${remaining[0]} (then ${remaining.slice(1).join(', ') || 'nothing'})`);
  if (state.vault && remaining.length > 0) {
    const now = Math.floor(Date.now() / 1000);
    const first = Number(state.vault.firstDeadline);
    if (!state.steps.checkInPasskey && now < first) say(`First deadline in ${formatDuration(first - now)}: check-ins must land before it.`);
  }
  if (process.env.CODICIL_PRINT_RESULTS === '1') say(resultsMarkdown(buildResults(state, { remaining })));
  return 0;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  installRedaction();
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case 'init': return init();
    case 'check': return check(options);
    case 'dust': return dust(options);
    case 'run': return run(options);
    case 'status': return status(options);
    case 'dryrun': {
      const { dryRun } = await import('./dryrun.js');
      const ok = await dryRun({ escrow: options.escrow, seals: options.seals, prove: options.prove, log: say });
      return ok ? 0 : 1;
    }
    default:
      say(USAGE);
      return 0;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    console.error(`\nerror: ${redact(text, secrets)}`);
    if (process.env.CODICIL_DEBUG === '1' && error instanceof Error) console.error(redact(error.stack ?? '', secrets));
    const cause = (error as { cause?: unknown })?.cause;
    if (cause !== undefined) console.error(`cause: ${redact(cause instanceof Error ? cause.message : String(cause), secrets)}`);
    process.exit(1);
  },
);
