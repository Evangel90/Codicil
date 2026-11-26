// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The web app's live mode, end to end on a real Midnight network, with no
// browser and nobody clicking: `npm run live:e2e`.
//
// It drives the same code the app runs at #/app: the live store
// (src/live/store.ts) on the live chain (src/live/live-chain.ts), fetching the
// circuit keys over HTTP as a browser does. Only two things differ. The wallet
// is the throwaway test wallet built from a seed (scripts/headless-wallet.ts)
// instead of Lace, and the owner's passkey is a software key that signs in the
// passkey format, because a script has no Face ID.
//
//   owner     creates a vault (staged: 8 transactions), deposits, checks in
//   guardian  opens their invitation on "their own device" and votes
//   heir      opens their invitation, starts the switch after the deadline,
//             releases the will after the challenge window, and claims
//
// The three people are three separate stores with separate storage, as three
// browsers would be. They share one wallet here, which pays every fee.
//
// It is resumable: stop it at any point and run it again. `--fresh` starts a
// new vault. Needs what `npm run preprod:run` needs (docs/PREPROD.md): the
// proving keys, a proof server, a funded test wallet in `.env`.

import '../../preprod/src/ws-global.js';

import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Phase } from '@codicil/contracts/vault';
import { ENV_KEYS, mergeEnv, parseDotEnv, redact, resolveNetwork, seedProblem } from '../../preprod/src/env.js';
import { createNoiseFilter } from '../../preprod/src/noise.js';
import { ENV_PATH, networkPaths, REPO_ROOT } from '../../preprod/src/paths.js';
import { writeFileAtomic } from '../../preprod/src/state.js';
import { acquireLock, openWallet, readBalances, waitForSync } from '../../preprod/src/wallet.js';
import type { CallOutcome, VaultChain, VaultHost } from '../src/chain/types.js';
import { approveWithPasskey, createDemoPasskey } from '../src/demo/passkey.js';
import { LiveHost } from '../src/live/live-chain.js';
import { describeProblem } from '../src/live/problems.js';
import { decodeRecords, type OwnerRecord, type RecordStorage } from '../src/live/records.js';
import { CLOCK_MARGIN, LiveStore, MINUTE, type HeirView, type LiveSnapshot, type OwnerView } from '../src/live/store.js';
import { formatDust, formatNight, STAR_PER_NIGHT } from '../src/live/wallet.js';
import { hasProvingKeys, serveArtifacts, VAULT_ARTIFACTS_DIR, ZK_ROUTE } from '../zk-server.js';
import { HeadlessWallet } from './headless-wallet.js';

// ─── Output: timestamps, and no secret ever reaches the terminal ────────────

const secrets: string[] = [];
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
const log = (line: string): void => { console.log(line === '' ? '' : `[${new Date().toISOString().slice(11, 19)}] ${line}`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nowS = (): number => Math.floor(Date.now() / 1000);

// ─── Storage: one file per "device" ─────────────────────────────────────────

function fileStorage(path: string): RecordStorage {
  return {
    load: () => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    // Holds the throwaway vault's keys: gitignored, and readable by this user only.
    save: (text) => writeFileAtomic(path, text),
  };
}

// ─── Every transaction the stores make, written down ────────────────────────

interface Row { step: string; circuit: string; txHash: string; blockHeight?: number; feeSpeck?: string; seconds: number }

/** The chain boundary, unchanged, with a note taken of each call's receipt. */
function recording(host: VaultHost, rows: Row[], who: string): VaultHost {
  const wrap = (chain: VaultChain): VaultChain => ({
    get address() { return chain.address; },
    get ledger() { return chain.ledger; },
    get now() { return chain.now; },
    refresh: () => chain.refresh(),
    subscribe: (fn) => chain.subscribe(fn),
    onStage: chain.onStage && ((fn) => chain.onStage!(fn)),
    async call(circuitId, privateState, ...args): Promise<CallOutcome> {
      const started = Date.now();
      const out = await chain.call(circuitId, privateState, ...args);
      const row: Row = {
        step: `${who}: ${circuitId}`, circuit: circuitId, txHash: out.receipt?.txHash ?? '?', blockHeight: out.receipt?.blockHeight,
        feeSpeck: out.receipt?.fee?.toString(), seconds: (Date.now() - started) / 1000,
      };
      rows.push(row);
      log(`  ${row.step}: block ${row.blockHeight}, tx ${row.txHash}, ${row.seconds.toFixed(0)} s${out.receipt?.fee !== undefined ? `, fee ${formatDust(out.receipt.fee, 3)} DUST` : ''}`);
      return out;
    },
  });
  return {
    kind: host.kind,
    networkId: host.networkId,
    get now() { return host.now; },
    tokenColor: host.tokenColor,
    preflight: () => host.preflight?.() ?? Promise.resolve(),
    onStage: host.onStage && ((fn) => host.onStage!(fn)),
    createVault: async (config, options) => wrap(await host.createVault(config, options)),
    openVault: async (address) => wrap(await host.openVault(address)),
  };
}

/** Fail with the store's own words for the person, so the script shows what the app would. */
function mustSucceed(ok: boolean, s: LiveSnapshot, what: string): void {
  if (ok) return;
  const p = s.tx?.problem ?? s.deploy?.problem ?? s.load.problem;
  throw new Error(`${what} failed. The app would say: "${p?.title ?? 'unknown'}: ${p?.body ?? ''}"${p?.detail ? ` [${p.detail}]` : ''}`);
}

async function waitUntil(target: number, what: string): Promise<void> {
  let lastLog = 0;
  for (;;) {
    const left = target - nowS();
    if (left <= 0) return;
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      log(`waiting ${Math.ceil(left / 60)} min for ${what} (${new Date(target * 1000).toISOString()})`);
    }
    await sleep(Math.min(left, 15) * 1000);
  }
}

async function main(): Promise<number> {
  installRedaction();
  const fresh = process.argv.includes('--fresh');
  const envText = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : undefined;
  const env = mergeEnv(envText === undefined ? {} : parseDotEnv(envText), process.env);
  for (const key of [ENV_KEYS.seed, ENV_KEYS.blockfrost]) if ((env[key]?.length ?? 0) >= 8) secrets.push(env[key]!);
  const resolved = resolveNetwork(env);
  if (!resolved.ok) throw new Error(resolved.problems.join('\n'));
  const cfg = resolved.value;
  const seedIssue = seedProblem(env[ENV_KEYS.seed]);
  if (seedIssue) throw new Error(seedIssue);
  if (!hasProvingKeys()) throw new Error('the proving keys are missing: run `npm run compile:full` (and do not run `npm run compile` afterwards, it deletes them)');

  const everyS = Number(env.CODICIL_LIVE_EVERY_S ?? 5 * MINUTE);
  const windowS = Number(env.CODICIL_LIVE_WINDOW_S ?? 2 * MINUTE);
  const depositStar = BigInt(env.CODICIL_DEPOSIT ?? '10') * STAR_PER_NIGHT;

  const paths = networkPaths(cfg.name);
  mkdirSync(paths.dir, { recursive: true });
  const files = { owner: join(paths.dir, 'live-owner.json'), heir: join(paths.dir, 'live-heir.json'), guardian: join(paths.dir, 'live-guardian.json'), rows: join(paths.dir, 'live-rows.json') };
  if (fresh) {
    for (const f of Object.values(files)) {
      if (existsSync(f)) renameSync(f, f.replace(/\.json$/, `-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    }
    log('--fresh: the previous run was set aside');
  }
  const rows: Row[] = existsSync(files.rows) ? JSON.parse(readFileSync(files.rows, 'utf8')) as Row[] : [];

  // The circuit keys, over HTTP, exactly as the app's own server gives them to a browser.
  const server = createServer(serveArtifacts(VAULT_ARTIFACTS_DIR, ZK_ROUTE));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const artifactsUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${ZK_ROUTE}`;

  const release = acquireLock(paths.lock);
  const session = await openWallet(cfg, env[ENV_KEYS.seed]!, { snapshotPath: paths.walletSnapshot, log });
  let code = 1;
  try {
    log(`network ${cfg.name}; wallet ${session.identity.address}`);
    const synced = await waitForSync(session, { timeoutMs: 6 * 3600_000, log });
    const start = readBalances(synced);
    log(`wallet synced: ${formatNight(start.night)} tNIGHT, ${formatDust(start.dust, 3)} DUST`);

    const wallet = new HeadlessWallet(session, cfg, log);
    const live = await LiveHost.connect({ wallet, artifactsUrl, allowedNetworks: [cfg.networkId], log });
    log(`proof server ${await live.checkProofServer()}; circuit keys from ${artifactsUrl}`);
    const passkeys = { approve: approveWithPasskey };
    const save = () => writeFileAtomic(files.rows, JSON.stringify(rows, null, 2), 0o644);

    // ── The owner's browser ──
    const owner = new LiveStore({ storage: fileStorage(files.owner), passkeys, rpId: 'localhost' });
    owner.walletName = wallet.name;
    await owner.attach(recording(live, rows, 'owner'));
    const ownerView = () => owner.getSnapshot().active as OwnerView | undefined;

    if (!ownerView()) {
      log('');
      log(`── owner: create a vault (check in every ${everyS / 60} min, ${windowS / 60} min challenge window) ──`);
      const ok = await owner.createVault({
        ownerName: 'Test owner',
        heirs: [{ name: 'First heir', sharePct: 60 }, { name: 'Second heir', sharePct: 40, backupName: 'Backup heir' }],
        guardians: ['First guardian', 'Second guardian'],
        threshold: 2,
        timers: { every: everyS, window: windowS, grace: 0, testing: true },
      }, createDemoPasskey());
      mustSucceed(ok, owner.getSnapshot(), 'creating the vault');
    } else if (ownerView()!.status !== 'ready') {
      log('');
      log('── owner: continue the interrupted deployment ──');
      mustSucceed(await owner.resumeDeployment(), owner.getSnapshot(), 'finishing the vault');
    }
    const record = decodeRecords(readFileSync(files.owner, 'utf8'))[0] as OwnerRecord;
    const deployment = record.deployment!;
    log(`vault ${deployment.address}: deploy tx ${deployment.deployTxHash ?? '(recovered)'}, ${deployment.inserted.length} circuits added afterwards`);
    log(`first deadline ${new Date((record.firstDeadline ?? 0) * 1000).toISOString()}`);

    if ((ownerView()!.vault?.estate ?? 0n) === 0n && ownerView()!.vault?.phase === Phase.armed) {
      log('');
      log(`── owner: deposit ${formatNight(depositStar)} tNIGHT ──`);
      mustSucceed(await owner.deposit(depositStar), owner.getSnapshot(), 'the deposit');
      owner.dismissTx();
      save();
    }

    // ── A guardian's browser ──
    const guardian = new LiveStore({ storage: fileStorage(files.guardian), passkeys });
    guardian.walletName = wallet.name;
    await guardian.attach(recording(live, rows, 'guardian'));
    if (!guardian.getSnapshot().active) await guardian.join(owner.guardianKit(ownerView()!.guardians[0].id));
    {
      const g = guardian.getSnapshot().active;
      if (g?.role !== 'guardian' || !g.vault) throw new Error('the guardian could not open the vault');
      log('');
      log(`── guardian: "${g.name}" opened their invitation; a current guardian: ${g.current}; voted this round: ${g.voted} ──`);
      if (g.vault.phase === Phase.armed && g.vault.nonce === 0n && !g.voted) {
        mustSucceed(await guardian.vote(), guardian.getSnapshot(), 'the guardian vote');
        log(`  ${guardian.getSnapshot().tx?.message}`);
        guardian.dismissTx();
        save();
      }
    }

    // ── The owner checks in, which also starts a new voting round ──
    await owner.open();
    if (ownerView()!.vault!.phase === Phase.armed && ownerView()!.vault!.nonce === 0n) {
      log('');
      log('── owner: check in with the passkey ──');
      mustSucceed(await owner.checkIn(), owner.getSnapshot(), 'the check-in');
      log(`  ${owner.getSnapshot().tx?.message}`);
      owner.dismissTx();
      save();
    }

    // ── An heir's browser ──
    const heir = new LiveStore({ storage: fileStorage(files.heir), passkeys });
    heir.walletName = wallet.name;
    await heir.attach(recording(live, rows, 'heir'));
    if (!heir.getSnapshot().active) await heir.join(owner.heirKit(ownerView()!.heirs[0].id));
    const heirView = () => heir.getSnapshot().active as HeirView;
    const refreshHeir = async () => { await heir.open(); return heirView(); };
    let h = await refreshHeir();
    if (!h.vault) throw new Error('the heir could not open the vault');
    log('');
    log(`── heir: "${h.name}" opened their invitation: ${Number(h.shareBps) / 100}% of the estate, status ${h.status} ──`);

    if (h.vault.phase === Phase.armed) {
      await waitUntil(h.vault.switchOpensAt + CLOCK_MARGIN + 5, 'the check-in deadline to pass');
      log('── heir: the owner has gone silent; start the switch ──');
      mustSucceed(await heir.startSwitch(), heir.getSnapshot(), 'starting the switch');
      log(`  ${heir.getSnapshot().tx?.message}`);
      heir.dismissTx();
      save();
      h = heirView();
    }
    if (h.vault!.phase === Phase.pending) {
      await waitUntil(h.vault!.pendingUntil + CLOCK_MARGIN + 5, 'the challenge window to end');
      log('── heir: release the will ──');
      mustSucceed(await heir.release(), heir.getSnapshot(), 'releasing the will');
      heir.dismissTx();
      save();
      h = heirView();
    }
    if (h.status === 'claimable') {
      const to = await wallet.address();
      log(`── heir: claim to their own wallet (${to.bech32}) ──`);
      mustSucceed(await heir.claim(to.hex), heir.getSnapshot(), 'the claim');
      log(`  ${heir.getSnapshot().tx?.message}`);
      heir.dismissTx();
      save();
      h = heirView();
    }
    if (h.status !== 'claimed') throw new Error(`the run ended with the heir's share ${h.status}, not claimed`);

    // ── A backup of the owner's browser opens in a clean one ──
    const backup = await owner.exportBackup('correct horse battery');
    const restoredStorage: RecordStorage & { text: string | null } = { text: null, load() { return this.text; }, save(t) { this.text = t; } };
    const restored = new LiveStore({ storage: restoredStorage, passkeys });
    await restored.attach(live);
    const merged = await restored.importBackup(backup, 'correct horse battery');
    const back = restored.getSnapshot().active as OwnerView;
    if (merged.added !== 1 || back.vault?.phase !== Phase.released) throw new Error('the restored backup did not open the released vault');
    log('');
    log(`── backup: ${backup.length} bytes, restored into an empty store, which opened the vault and read it as released ──`);

    const end = readBalances(await waitForSync(session, { timeoutMs: 600_000 }));
    const lines = [
      `# Live mode end to end on ${cfg.name}`,
      '',
      `Run by \`npm run live:e2e\` (app/scripts/live-e2e.ts), finished ${new Date().toISOString()}.`,
      'The app\'s own live store and live chain, with the test wallet from a seed in place of Lace and a software key in place of Face ID.',
      '',
      `- Vault: \`${deployment.address}\``,
      `- Wallet: \`${session.identity.address}\``,
      `- Timers: check in every ${everyS / 60} min, ${windowS / 60} min challenge window`,
      `- Deployment: ${1 + deployment.inserted.length} transactions (deploy, then ${deployment.inserted.length} circuits added)`,
      `- Heir paid: ${formatNight(h.claimed?.amount ?? 0n)} tNIGHT of a ${formatNight(depositStar)} tNIGHT estate`,
      `- DUST: ${formatDust(start.dust, 2)} at the start of this invocation, ${formatDust(end.dust, 2)} at the end`,
      '',
      '| Step | Transaction | Block | Fee (DUST) | Time |',
      '|---|---|---|---|---|',
      `| owner: deploy (9 circuits) | \`${deployment.deployTxHash ?? 'recovered'}\` | | | |`,
      ...deployment.inserted.map((i) => `| owner: add \`${i.circuit}\` | \`${i.txHash}\` | | | |`),
      ...rows.map((r) => `| ${r.step} | \`${r.txHash}\` | ${r.blockHeight ?? ''} | ${r.feeSpeck ? formatDust(BigInt(r.feeSpeck), 3) : ''} | ${r.seconds.toFixed(0)} s |`),
      '',
    ];
    const out = join(REPO_ROOT, 'preprod', 'results', `live-app-${cfg.name}.md`);
    writeFileAtomic(out, lines.join('\n'), 0o644);
    log('');
    log(`complete: the heir's share is claimed. Results in ${out}`);
    code = 0;
  } catch (e) {
    const p = describeProblem(e, { network: cfg.name });
    console.error(`\nerror: ${redact(e instanceof Error ? e.message : String(e), secrets)}`);
    if (p.kind !== 'unknown') console.error(`the app would say: ${p.title}: ${p.body}${p.detail ? ` [${p.detail}]` : ''}`);
  } finally {
    await session.close().catch(() => undefined);
    release();
    server.close();
  }
  return code;
}

main().then((code) => process.exit(code), (e: unknown) => {
  console.error(`\nerror: ${redact(e instanceof Error ? e.message : String(e), secrets)}`);
  process.exit(1);
});
