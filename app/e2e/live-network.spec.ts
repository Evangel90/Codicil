// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The live app in a real browser, on a real network, clicked through from the
// first screen to an heir's claim. Opt-in: it spends test tokens and takes
// about a quarter of an hour.
//
//   E2E_LIVE_NETWORK=preview E2E_PORT=5199 npx playwright test e2e/live-network.spec.ts
//
// Everything is the real thing except the wallet extension. A stand-in is put
// under `window.midnight` with the shape the DApp connector 4.1.0 types
// describe, and it hands each request to the throwaway test wallet, built
// from its seed with the wallet SDK in this Node process. So this covers what
// `npm run live:e2e` cannot: the screens, Chrome's WebAuthn (a virtual
// authenticator), the proving keys fetched and cached in the browser, proofs
// requested from the browser, and the app's Lace adapter (live/lace.ts)
// against a wallet that really balances, signs and submits.
//
// It does not cover the Lace extension itself. Preview only: Preprod's
// service addresses carry a provider token, which should not be put in a page.
//
// Needs what `npm run live:e2e` needs: the proving keys (`npm run
// compile:full`), a proof server on localhost:6300, and the funded test
// wallet in `.env`. Build the app first (`npm run build`).

import '../../preprod/src/ws-global.js';

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ShieldedCoinPublicKey, ShieldedEncryptionPublicKey } from '@midnightntwrk/wallet-sdk-address-format';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ENV_KEYS, mergeEnv, parseDotEnv, resolveNetwork } from '../../preprod/src/env.js';
import { ENV_PATH, networkPaths, REPO_ROOT } from '../../preprod/src/paths.js';
import { writeFileAtomic } from '../../preprod/src/state.js';
import { acquireLock, openWallet, readBalances, waitForSync, type WalletSession } from '../../preprod/src/wallet.js';
import { HeadlessWallet } from '../scripts/headless-wallet.js';
import { readWithCode } from '../src/live/keyring.js';
import type { HeirRecord, OwnerRecord } from '../src/live/records.js';
import { formatDust, formatNight } from '../src/live/wallet.js';
import { fromHex, toHex } from '../src/live/codec.js';

const NETWORK = process.env.E2E_LIVE_NETWORK;
test.skip(NETWORK !== 'preview', 'opt-in: set E2E_LIVE_NETWORK=preview (it spends test tokens on a real network)');
test.use({ trace: 'off', video: 'off' });

const log = (line: string): void => { console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`); };

let session: WalletSession | undefined;
let release: (() => void) | undefined;
test.afterAll(async () => {
  await session?.close().catch(() => undefined);
  release?.();
});

/** Put "Lace" under `window.midnight`, answered by the test wallet in this process. */
async function bridgeWallet(context: BrowserContext, wallet: HeadlessWallet, sent: string[], step: { label: string }) {
  const services = await wallet.services();
  const address = await wallet.address();
  const keys = await wallet.shieldedKeys();
  // The keys as a real wallet reports them: Bech32m, made by the wallet SDK's own encoder.
  const cpk = ShieldedCoinPublicKey.codec.encode(services.networkId, new ShieldedCoinPublicKey(Buffer.from(keys.coinPublicKey, 'hex'))).asString();
  const epk = ShieldedEncryptionPublicKey.codec.encode(services.networkId, new ShieldedEncryptionPublicKey(Buffer.from(keys.encryptionPublicKey, 'hex'))).asString();
  await context.exposeFunction('__walletBalances', async () => {
    const b = await wallet.balances();
    return { night: b.night.toString(), dust: b.dust.toString() };
  });
  await context.exposeFunction('__walletBalance', async (tx: string) => toHex(await wallet.balanceTransaction(fromHex(tx))));
  await context.exposeFunction('__walletSubmit', async (tx: string) => {
    const before = Date.now();
    await wallet.submitTransaction(fromHex(tx));
    sent.push(step.label);
    log(`  wallet submitted a transaction for "${step.label}" (${Date.now() - before} ms)`);
  });
  await context.addInitScript(({ services, address, cpk, epk }) => {
    const w = window as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const api = {
      getConfiguration: async () => ({
        networkId: services.networkId, indexerUri: services.indexerUri, indexerWsUri: services.indexerWsUri,
        substrateNodeUri: services.nodeUri, proverServerUri: services.proofServerUri,
      }),
      getConnectionStatus: async () => ({ status: 'connected', networkId: services.networkId }),
      getUnshieldedAddress: async () => ({ unshieldedAddress: address }),
      getShieldedAddresses: async () => ({ shieldedAddress: '', shieldedCoinPublicKey: cpk, shieldedEncryptionPublicKey: epk }),
      getUnshieldedBalances: async () => ({ ['0'.repeat(64)]: BigInt(((await w.__walletBalances()) as { night: string }).night) }),
      getDustBalance: async () => ({ cap: BigInt(0), balance: BigInt(((await w.__walletBalances()) as { dust: string }).dust) }),
      balanceUnsealedTransaction: async (tx: string) => ({ tx: await w.__walletBalance(tx) }),
      submitTransaction: async (tx: string) => { await w.__walletSubmit(tx); },
      hintUsage: async () => undefined,
    };
    (window as unknown as { midnight: unknown }).midnight = {
      'test-wallet': { rdns: 'io.lace.test-double', name: 'Lace', icon: '', apiVersion: '4.1.0', connect: async () => api },
    };
  }, { services, address: address.bech32, cpk, epk });
}

async function addVirtualPasskey(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
}

/** First use: a passkey (or none) and the printed recovery code, typed back once. Returns the code. */
async function setUpBrowser(page: Page, { passkey }: { passkey: boolean }): Promise<string> {
  await expect(page.getByRole('heading', { name: 'Lock what this browser keeps.' })).toBeVisible({ timeout: 60_000 });
  if (passkey) {
    await page.getByRole('button', { name: 'Create a passkey' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
  } else {
    await page.getByRole('button', { name: 'Skip, use only the recovery code' }).click();
  }
  const groups = await page.getByLabel('Your recovery code').locator('span').allTextContents();
  const field = page.getByLabel(/type group \d of the code/);
  const n = Number(/group (\d)/.exec((await page.locator('label', { has: field }).textContent()) ?? '')?.[1]);
  await field.fill(groups[n - 1]);
  await page.getByRole('button', { name: 'I have written it down' }).click();
  return groups.join('-');
}

/** Wait for the progress sheet to finish, read what it says, and close it. */
async function finished(page: Page, pattern: RegExp, timeout: number): Promise<string> {
  const result = page.locator('.sheet-result p');
  const failure = page.locator('.err-row');
  await expect(result.or(failure)).toBeVisible({ timeout });
  if (await failure.isVisible()) throw new Error(`the app reported: ${(await failure.innerText()).replace(/\s+/g, ' ')}`);
  await expect(result).toHaveText(pattern);
  const text = await result.innerText();
  await page.getByRole('button', { name: 'Close' }).click();
  return text;
}

const recordsOf = async (page: Page, code: string) => (await readWithCode((await page.evaluate(() => localStorage.getItem('codicil.vaults.v1')))!, code)).records;

test('an owner creates a vault and checks in; an heir starts the switch, releases the will and claims', async ({ browser }) => {
  test.setTimeout(45 * 60_000);
  const env = mergeEnv(existsSync(ENV_PATH) ? parseDotEnv(readFileSync(ENV_PATH, 'utf8')) : {}, { ...process.env, MIDNIGHT_NETWORK: NETWORK });
  const resolved = resolveNetwork(env);
  if (!resolved.ok) throw new Error(resolved.problems.join('\n'));
  const cfg = resolved.value;
  const paths = networkPaths(cfg.name);
  mkdirSync(paths.dir, { recursive: true });
  release = acquireLock(paths.lock);
  session = await openWallet(cfg, env[ENV_KEYS.seed]!, { snapshotPath: paths.walletSnapshot, log });
  const start = readBalances(await waitForSync(session, { timeoutMs: 30 * 60_000, log }));
  log(`wallet ${session.identity.address}: ${formatNight(start.night)} tNIGHT, ${formatDust(start.dust, 2)} DUST`);
  const wallet = new HeadlessWallet(session, cfg, log);
  const sent: string[] = [];
  const step = { label: 'connect' };
  const startedAt = Date.now();

  // ── The owner's browser ──
  const ownerContext = await browser.newContext({ acceptDownloads: true });
  await bridgeWallet(ownerContext, wallet, sent, step);
  const owner = await ownerContext.newPage();
  const errors: string[] = [];
  owner.on('pageerror', (e) => errors.push(e.message));
  await addVirtualPasskey(owner);
  await owner.goto('/#/app');
  await owner.getByRole('button', { name: 'Connect Lace' }).click();
  const ownerCode = await setUpBrowser(owner, { passkey: true });
  await expect(owner.getByText('Midnight Preview. Tokens here have no value.')).toBeVisible();
  await expect(owner.getByText(`${formatNight(start.night, 0)} tNIGHT`)).toBeVisible({ timeout: 30_000 });

  await owner.getByRole('button', { name: 'Create your will' }).click();
  await owner.getByLabel('Your name').fill('Ngozi Adeyemi');
  await expect(owner.getByText('Your passkey is ready.')).toBeVisible();
  await owner.getByRole('button', { name: 'Continue' }).click();
  // The kit flow, so one browser can hand the heir everything; the reply flow is covered in live.spec.ts.
  await owner.getByRole('button', { name: 'Make their keys for them (faster, but you will know their keys)' }).click();
  await owner.getByLabel('Name', { exact: true }).fill('Tunde');
  await owner.getByLabel('Share, in percent').fill('60');
  await owner.getByRole('button', { name: 'Add another heir' }).click();
  await owner.getByLabel('Name', { exact: true }).nth(1).fill('Sade');
  await owner.getByRole('button', { name: 'Continue' }).click();
  await owner.getByRole('button', { name: 'Continue' }).click();
  await owner.getByRole('button', { name: 'Trying it out, in minutes' }).click();
  await owner.getByRole('group', { name: 'Check-in period' }).getByRole('button', { name: '5 minutes' }).click();
  await owner.getByRole('group', { name: 'Challenge window' }).getByRole('button', { name: '2 minutes' }).click();
  await owner.getByRole('button', { name: 'Continue' }).click();

  step.label = 'create the vault';
  log('owner: sealing the will (8 transactions)');
  await owner.getByRole('button', { name: 'Seal the will and create the vault' }).click();
  await expect(owner.getByRole('heading', { name: /Transaction \d of 8/ })).toBeVisible({ timeout: 60_000 });
  await expect(owner.getByRole('heading', { name: 'Your will is sealed.' })).toBeVisible({ timeout: 15 * 60_000 });
  await owner.getByRole('button', { name: 'Go to my vault' }).click();
  await expect(owner.getByRole('heading', { name: /Your vault, Ngozi Adeyemi/ })).toBeVisible();
  log(`owner: vault created after ${Math.round((Date.now() - startedAt) / 1000)} s`);

  step.label = 'deposit';
  await owner.getByRole('button', { name: 'Add tNIGHT' }).click();
  await owner.getByRole('button', { name: 'Add', exact: true }).click();
  log(`owner: ${await finished(owner, /10 tNIGHT added/, 5 * 60_000)}`);

  // The check-in: a passkey assertion from Chrome's WebAuthn, verified in a proof made from a 448 MB key the browser fetched.
  step.label = 'check in';
  const checkInStarted = Date.now();
  await owner.getByRole('button', { name: "I'm alive" }).click();
  log(`owner: ${await finished(owner, /Check-in recorded/, 10 * 60_000)} (${Math.round((Date.now() - checkInStarted) / 1000)} s)`);

  // The owner sends the first heir their invitation.
  const row = owner.locator('.people li', { hasText: 'Tunde' });
  await row.getByRole('button', { name: 'Show the invitation' }).click();
  const download = owner.waitForEvent('download');
  await row.getByRole('button', { name: 'Download as a file' }).click();
  const invitation = readFileSync(await (await download).path(), 'utf8').split('\n').find((l) => l.startsWith('codicil:heir-kit:v1:'));
  expect(invitation).toBeTruthy();

  // ── The heir's browser: nothing in it but the link ──
  const heirContext = await browser.newContext();
  await bridgeWallet(heirContext, wallet, sent, step);
  const heir = await heirContext.newPage();
  heir.on('pageerror', (e) => errors.push(e.message));
  await heir.goto(`/#/app/join/${invitation}`);
  await expect(heir.getByRole('heading', { name: 'Connect your wallet to open your invitation.' })).toBeVisible();
  await heir.getByRole('button', { name: 'Connect Lace' }).click();
  const heirCode = await setUpBrowser(heir, { passkey: false });
  await expect(heir.getByRole('heading', { name: 'You are named in a will.' })).toBeVisible({ timeout: 60_000 });
  await expect(heir.getByText('For Tunde · from Ngozi Adeyemi')).toBeVisible();
  await expect(heir.getByText('Your share · 60%')).toBeVisible();
  log('heir: invitation opened; waiting for the owner\'s deadline to pass');

  step.label = 'start the switch';
  await heir.getByRole('button', { name: 'Start the switch' }).click({ timeout: 9 * 60_000 });
  log(`heir: ${await finished(heir, /The switch has started/, 5 * 60_000)}`);
  await expect(heir.getByRole('heading', { name: 'The will may open soon.' })).toBeVisible();

  step.label = 'release the will';
  await heir.getByRole('button', { name: 'Release the will' }).click({ timeout: 6 * 60_000 });
  log(`heir: ${await finished(heir, /The will is released/, 5 * 60_000)}`);
  await expect(heir.getByRole('heading', { name: 'Your share is ready when you are.' })).toBeVisible();

  step.label = 'claim';
  await heir.getByRole('button', { name: 'Claim 6 tNIGHT to my wallet' }).click();
  log(`heir: ${await finished(heir, /6 tNIGHT is on its way to your wallet/, 5 * 60_000)}`);
  await expect(heir.getByRole('heading', { name: /Your share is with you/ })).toBeVisible();

  // The owner's page saw all of it happen, without a reload.
  await expect(owner.getByRole('heading', { name: /This will has been released/ })).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);

  // What was sent, for the record.
  const [ownerRecord] = await recordsOf(owner, ownerCode) as OwnerRecord[];
  const [heirRecord] = await recordsOf(heir, heirCode) as HeirRecord[];
  const d = ownerRecord.deployment!;
  const end = readBalances(await waitForSync(session, { timeoutMs: 10 * 60_000 }));
  const out = join(REPO_ROOT, 'preprod', 'results', `live-browser-${cfg.name}.md`);
  writeFileAtomic(out, [
    `# Live mode in a browser, end to end on ${cfg.name}`,
    '',
    `Run by \`app/e2e/live-network.spec.ts\` in headless Chromium, finished ${new Date().toISOString()}, ${Math.round((Date.now() - startedAt) / 60_000)} minutes.`,
    'The app at #/app, clicked through. The wallet extension is replaced by a stand-in with the DApp connector\'s shape, answered by the test wallet from its seed; the passkey is a Chrome virtual authenticator.',
    '',
    `- Vault: \`${d.address}\``,
    `- Wallet: \`${session.identity.address}\``,
    `- Transactions the wallet submitted: ${sent.length} (${[...new Set(sent)].join(', ')})`,
    `- Heir paid: ${formatNight(heirRecord.claimed?.amount ?? 0n)} tNIGHT`,
    `- DUST: ${formatDust(start.dust, 2)} at the start, ${formatDust(end.dust, 2)} at the end`,
    '',
    '| Step | Transaction |',
    '|---|---|',
    `| owner: deploy (9 circuits) | \`${d.deployTxHash}\` |`,
    ...d.inserted.map((i) => `| owner: add \`${i.circuit}\` | \`${i.txHash}\` |`),
    ...ownerRecord.activity.filter((a) => !/Vault created/.test(a.what)).reverse().map((a) => `| owner: ${a.what} | \`${a.txHash}\` |`),
    ...(heirRecord.activity ?? []).slice().reverse().map((a) => `| heir: ${a.what} | \`${a.txHash}\` |`),
    '',
  ].join('\n'), 0o644);
  log(`complete. Results in ${out}`);
});
