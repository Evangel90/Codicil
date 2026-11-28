// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The live app (#/app) in a real browser, up to the wallet. A stand-in for the
// Lace extension is put under `window.midnight`, with the shape the DApp
// connector 4.1.0 types describe; everything else is the real thing: the
// compiled contract and the ledger in WebAssembly, Midnight.js, the app's own
// store and screens. No network is used and nothing is sent.
//
// What this cannot show is a transaction: only a real wallet can pay a fee.
// That part runs on a real network in `npm run live:e2e`, and with the Lace
// extension by hand (docs/JUDGES_QUICKSTART.md).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bech32m } from '@scure/base';
import { expect, test, type Page } from '@playwright/test';

/**
 * Creating a vault needs the circuits' real keys, which only the full compile
 * makes (`npm run compile:full`, 2.7 GB). CI compiles with --skip-zk, so the
 * owner tests are skipped there, as the app itself would refuse: its button
 * stays off and it says the keys are missing.
 */
const HAVE_KEYS = existsSync(fileURLToPath(new URL('../../contracts/managed/codicil_vault/keys/deposit.prover', import.meta.url)));

/**
 * Set to use the real Preview indexer, which takes the owner test one step
 * further: the vault's deployment is built
 * and offered to the wallet, which declines it. Without it the test stops
 * where the app first needs the network, and checks that message instead.
 */
const REAL_PREVIEW = process.env.E2E_LIVE_PREVIEW === '1';
const INDEXER = REAL_PREVIEW
  ? { http: 'https://indexer.preview.midnight.network/api/v4/graphql', ws: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws' }
  : { http: 'http://indexer.invalid/api/v4/graphql', ws: 'ws://indexer.invalid/api/v4/graphql/ws' };

const key = (kind: string, network: string, byte: number): string =>
  bech32m.encode(`mn_${kind}_${network}`, bech32m.toWords(new Uint8Array(32).fill(byte)), false);

interface Mock {
  /** The network the wallet is on. */
  network: string;
  night?: string;
  dust?: string;
  apiVersion?: string;
}

/** Put a wallet under `window.midnight` that answers like Lace and declines every transaction. */
async function withWallet(page: Page, mock: Mock) {
  await page.addInitScript(({ mock, address, cpk, epk, indexer }) => {
    const declined = () => Object.assign(new Error('User rejected the request'), { type: 'DAppConnectorAPIError', code: 'Rejected', reason: 'User rejected the request' });
    const api = {
      getConfiguration: async () => ({
        networkId: mock.network, indexerUri: indexer.http, indexerWsUri: indexer.ws,
        substrateNodeUri: 'http://node.invalid', proverServerUri: 'http://localhost:6300',
      }),
      getConnectionStatus: async () => ({ status: 'connected', networkId: mock.network }),
      getUnshieldedAddress: async () => ({ unshieldedAddress: address }),
      getShieldedAddresses: async () => ({ shieldedAddress: '', shieldedCoinPublicKey: cpk, shieldedEncryptionPublicKey: epk }),
      getUnshieldedBalances: async () => ({ ['0'.repeat(64)]: BigInt(mock.night ?? '5000000000') }),
      getDustBalance: async () => ({ cap: BigInt('25000000000000000000000'), balance: BigInt(mock.dust ?? '250000000000000000') }),
      balanceUnsealedTransaction: async () => { (window as unknown as { asked: number }).asked = ((window as unknown as { asked?: number }).asked ?? 0) + 1; throw declined(); },
      submitTransaction: async () => { throw declined(); },
      hintUsage: async () => undefined,
    };
    (window as unknown as { midnight: unknown }).midnight = {
      'mock-lace': {
        rdns: 'io.lace.test-double', name: 'Lace', icon: '', apiVersion: mock.apiVersion ?? '4.1.0',
        connect: async (networkId: string) => {
          if (networkId !== mock.network) throw Object.assign(new Error(`wallet is on ${mock.network}`), { type: 'DAppConnectorAPIError', code: 'InvalidRequest', reason: 'network mismatch' });
          return api;
        },
      },
    };
  }, { mock, address: key('addr', mock.network, 0x21), cpk: key('shield-cpk', mock.network, 0x22), epk: key('shield-epk', mock.network, 0x23), indexer: INDEXER });
  // The proof server is asked whether it is there. Answer for it, so the test needs no Docker:
  // creating a vault makes no proof (a deployment carries verifier keys, not proofs).
  await page.route('http://localhost:6300/version', (route) => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: '9.0.2' }));
}

/** A platform authenticator that answers the PRF extension, as iCloud Keychain and Google Password Manager do. */
async function addVirtualPasskey(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
}

const heading = (page: Page, name: RegExp | string) => page.getByRole('heading', { name });

/**
 * First use: a passkey (or none), then the recovery code, shown once and
 * checked by typing back the group the page asks for. Returns the code.
 */
async function setUpBrowser(page: Page, { passkey }: { passkey: boolean }): Promise<string> {
  await expect(heading(page, 'Lock what this browser keeps.')).toBeVisible();
  if (passkey) {
    await page.getByRole('button', { name: 'Create a passkey' }).click();
    await expect(page.getByText('Passkey created. Face ID will unlock this.')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
  } else {
    await page.getByRole('button', { name: 'Skip, use only the recovery code' }).click();
  }
  await expect(heading(page, 'Write down your recovery code.')).toBeVisible();
  const groups = await page.getByLabel('Your recovery code').locator('span').allTextContents();
  expect(groups.join('-')).toMatch(/^([0-9A-Z]{5}-){5}[0-9A-Z]{2}$/);
  const field = page.getByLabel(/type group \d of the code/);
  const n = Number(/group (\d)/.exec((await page.locator('label', { has: field }).textContent()) ?? '')?.[1]);
  await field.fill(groups[(n + 1) % 5]);
  await expect(page.getByText(`That is not group ${n}.`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'I have written it down' })).toBeDisabled();
  await field.fill(groups[n - 1]);
  await page.getByRole('button', { name: 'I have written it down' }).click();
  return groups.join('-');
}

test.describe('live mode, before a wallet is connected', () => {
  test('says what is needed, and that Lace is missing when it is', async ({ page }) => {
    await page.goto('/#/app');
    await expect(heading(page, 'Connect your wallet to begin.')).toBeVisible();
    await expect(page.getByText('tokens are free and have no value')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Preview faucet' })).toHaveAttribute('href', 'https://faucet.preview.midnight.network/');
    await expect(page.getByRole('link', { name: 'Preprod faucet' })).toHaveAttribute('href', 'https://midnight-tmnight-preprod.nethermind.dev/');
    await page.getByRole('button', { name: 'Connect Lace' }).click();
    await expect(heading(page, 'Install the Lace wallet')).toBeVisible();
    // The demo is one click away and untouched.
    await page.getByRole('link', { name: 'Open the guided demo' }).click();
    await expect(page).toHaveURL(/#\/demo$/);
  });

  test('a wallet on another network is told which networks work', async ({ page }) => {
    await withWallet(page, { network: 'mainnet' });
    await page.goto('/#/app');
    await page.getByRole('button', { name: 'Connect Lace' }).click();
    await expect(heading(page, 'Switch Lace to a Midnight test network')).toBeVisible();
    await expect(page.getByText(/test networks only: Preview or Preprod/)).toBeVisible();
  });

  test('an older wallet is asked to update', async ({ page }) => {
    await withWallet(page, { network: 'preview', apiVersion: '3.0.0' });
    await page.goto('/#/app');
    await page.getByRole('button', { name: 'Connect Lace' }).click();
    await expect(heading(page, 'Update the Lace wallet')).toBeVisible();
  });
});

for (const network of (REAL_PREVIEW ? ['preview'] : ['preview', 'preprod']) as ('preview' | 'preprod')[]) {
  test(`an owner on ${network}: from the wizard to the first approval, and back after a reload`, async ({ page }) => {
    test.skip(!HAVE_KEYS, 'needs the proving keys: run `npm run compile:full`');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const Network = network === 'preview' ? 'Preview' : 'Preprod';
    await withWallet(page, { network });
    await addVirtualPasskey(page);
    await page.goto('/#/app');
    await page.getByRole('button', { name: 'Connect Lace' }).click();

    // First use: this browser's records get a passkey and a printed recovery code.
    await setUpBrowser(page, { passkey: true });

    // Connected: the network is named, the balances are shown, and there are three ways in.
    await expect(page.getByText(`Midnight ${Network}. Tokens here have no value.`)).toBeVisible();
    await expect(page.getByText('5,000 tNIGHT')).toBeVisible();
    await expect(heading(page, 'What brings you here?')).toBeVisible();
    await expect(page.getByText(`no vaults in this browser on Midnight ${Network} yet`)).toBeVisible();
    for (const way of ['I want to create my will', 'I was given an invitation', 'I have a backup file']) await expect(heading(page, way)).toBeVisible();

    // A bad invitation says what is wrong with it.
    await page.getByLabel('Your invitation').fill('hello');
    await page.getByRole('button', { name: 'Open my invitation' }).click();
    await expect(page.getByText(/That is not a Codicil invitation/)).toBeVisible();

    // The wizard: the owner's own people, and the passkey made at set-up.
    await page.getByRole('button', { name: 'Create your will' }).click();
    await page.getByLabel('Your name').fill('Ngozi Adeyemi');
    await expect(page.getByText('Your passkey is ready.')).toBeVisible();
    await expect(page.getByText(/printed recovery code can replace it/)).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Trying the app alone: this device makes the keys, and says what that costs.
    await page.getByRole('button', { name: 'Make their keys for them (faster, but you will know their keys)' }).click();
    await expect(page.getByText(/you, your browser and your backup file hold every heir's key/)).toBeVisible();

    await page.getByLabel('Name', { exact: true }).fill('Tunde');
    await page.getByLabel('Share, in percent').fill('60');
    await page.getByRole('button', { name: 'Add another heir' }).click();
    await page.getByLabel('Name', { exact: true }).nth(1).fill('Sade');
    await expect(page.getByLabel('Share, in percent').nth(1)).toHaveValue('40');
    await expect(page.getByText('Everything is allocated.')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('button', { name: 'Add a guardian' }).click();
    await page.getByLabel("Guardian 1's name").fill('Dr. Bello');
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('button', { name: 'Trying it out, in minutes' }).click();
    await expect(page.getByText(/far too short for a real will/)).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Tunde 60% · Sade 40%')).toBeVisible();
    await expect(page.getByText(/Your printed recovery code replaces it, after a public wait of 1 day/)).toBeVisible();
    await expect(page.getByText(`Midnight ${Network}, a test network.`)).toBeVisible();
    await expect(page.getByText(/eight transactions/)).toBeVisible();

    // Sealing runs the vault's constructor and builds the staged deployment in this
    // browser. With the network, the wallet is then asked, and declines. Without it,
    // the app stops at its first question to the network. Either way nothing is sent
    // and nothing typed is lost.
    await page.getByRole('button', { name: 'Seal the will and create the vault' }).click();
    await expect(heading(page, REAL_PREVIEW ? 'You declined in your wallet' : `Could not reach ${Network}`)).toBeVisible({ timeout: 90_000 });
    await expect(heading(page, 'Nothing has been sent yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create the vault' })).toBeEnabled();
    if (REAL_PREVIEW) expect(await page.evaluate(() => (window as unknown as { asked?: number }).asked)).toBe(1);

    // Everything typed is still there after a reload, locked; Face ID opens it.
    await page.reload();
    await expect(page.getByText('Your vaults are saved in this browser, locked.')).toBeVisible();
    await page.getByRole('button', { name: 'Connect Lace' }).click();
    await expect(heading(page, 'Unlock your vaults.')).toBeVisible();
    await page.getByRole('button', { name: 'Unlock with Face ID' }).click();
    await expect(heading(page, 'Nothing has been sent yet.')).toBeVisible();
    const saved = await page.evaluate(() => localStorage.getItem('codicil.vaults.v1') ?? '');
    expect(saved).toContain('"format":2');
    expect(saved).not.toContain('Ngozi Adeyemi');
    expect(saved).not.toContain('Tunde');

    // A backup file can be saved. It needs no passphrase: Face ID or the code opens it.
    await page.getByRole('button', { name: 'Backup', exact: true }).click();
    await expect(page.getByText(/Opens with: Face ID, your printed recovery code/)).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save the backup file' }).click();
    expect((await download).suggestedFilename()).toMatch(/^codicil-backup-\d{4}-\d{2}-\d{2}\.json$/);
    await expect(page.getByText(/Saved to your downloads/)).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('a wallet with no tokens is sent to the right faucet, and one with no DUST is told to wait', async ({ page }) => {
  await withWallet(page, { network: 'preview', night: '0', dust: '0' });
  // A machine with no Face ID or Touch ID. Said outright, because the Chrome
  // this runs in may be on a laptop that has one.
  await page.addInitScript(() => {
    if ('PublicKeyCredential' in window) {
      (window.PublicKeyCredential as unknown as { isUserVerifyingPlatformAuthenticatorAvailable: () => Promise<boolean> })
        .isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
    }
  });
  await page.goto('/#/app');
  await page.getByRole('button', { name: 'Connect Lace' }).click();
  // No passkey here: the recovery code alone locks this browser's records.
  const code = await setUpBrowser(page, { passkey: false });
  await page.getByRole('button', { name: 'Create your will' }).click();
  await page.getByLabel('Your name').fill('Ngozi');
  // No passkey hardware here: the app offers a key kept in the browser, and says what that costs.
  await expect(page.getByText(/less safe than a passkey/)).toBeVisible();
  await page.getByRole('button', { name: 'Use a key stored in this browser' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Make their keys for them (faster, but you will know their keys)' }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  for (const fill of [async () => page.getByLabel('Name', { exact: true }).fill('Tunde'), async () => {}, async () => {}]) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await fill();
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(heading(page, 'Your wallet has no tNIGHT yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the Preview faucet' })).toHaveAttribute('href', 'https://faucet.preview.midnight.network/');
  await expect(page.getByRole('button', { name: 'Seal the will and create the vault' })).toBeDisabled();

  // A reload asks for the code, the only way in here; a wrong one is refused.
  await page.reload();
  await page.getByRole('button', { name: 'Connect Lace' }).click();
  await expect(heading(page, 'Unlock your vaults.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlock with Face ID' })).toHaveCount(0);
  const field = page.getByLabel('Your printed recovery code');
  await field.fill(code.replace(/^./, (c) => (c === '0' ? '1' : '0')));
  await page.getByRole('button', { name: 'Unlock with the code' }).click();
  await expect(page.getByText(/typing mistake|does not open this/)).toBeVisible();
  await field.fill(code);
  await page.getByRole('button', { name: 'Unlock with the code' }).click();
  await expect(heading(page, 'What brings you here?')).toBeVisible();
});

test('an heir answers an invitation in their own browser, and the owner gets only a reply', async ({ browser }) => {
  const errors: string[] = [];
  const ownerPage = await (await browser.newContext()).newPage();
  const heirPage = await (await browser.newContext()).newPage();
  for (const p of [ownerPage, heirPage]) {
    p.on('pageerror', (e) => errors.push(e.message));
    await withWallet(p, { network: 'preview' });
    await addVirtualPasskey(p);
    await p.goto('/#/app');
    await p.getByRole('button', { name: 'Connect Lace' }).click();
  }
  await setUpBrowser(ownerPage, { passkey: true });
  await setUpBrowser(heirPage, { passkey: false });

  // The owner: name an heir, and make their invitation. It carries no key.
  await ownerPage.getByRole('button', { name: 'Create your will' }).click();
  await ownerPage.getByLabel('Your name').fill('Ngozi Adeyemi');
  await ownerPage.getByRole('button', { name: 'Continue' }).click();
  await expect(ownerPage.getByText(/You never hold their key/)).toBeVisible();
  await ownerPage.getByLabel('Name', { exact: true }).fill('Tunde');
  await expect(ownerPage.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await ownerPage.getByRole('button', { name: "Make Tunde's invitation" }).click();
  const link = (await ownerPage.locator('.live-copy code').first().textContent()) ?? '';
  expect(link).toContain('/#/app/join/codicil:invite:v1:');

  // The heir opens it in their own browser, which makes their key and shows the reply.
  await ownerPage.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await ownerPage.getByRole('button', { name: 'Copy the invitation link' }).click();
  const full = await ownerPage.evaluate(() => navigator.clipboard.readText());
  await heirPage.getByLabel('Your invitation').fill(full);
  await heirPage.getByRole('button', { name: 'Open my invitation' }).click();
  await expect(heading(heirPage, 'Ngozi Adeyemi asked you to be an heir in their will.')).toBeVisible();
  const reply = (await heirPage.locator('.live-copy code').textContent()) ?? '';
  expect(reply).toMatch(/^codicil:reply:v1:/);

  // The owner pastes the reply. The will is built from it; the heir's key never left their browser.
  await ownerPage.getByLabel("Tunde's reply").fill(reply);
  await expect(ownerPage.getByText('Reply from Tunde received. Their key stays with them.')).toBeVisible();
  await expect(ownerPage.getByRole('button', { name: 'Continue' })).toBeEnabled();
  // A reply pasted where the owner's letter belongs is explained, not accepted.
  await heirPage.getByLabel('The letter from Ngozi Adeyemi').fill(reply);
  await heirPage.getByRole('button', { name: 'Open the letter' }).click();
  await expect(heirPage.getByText(/That is a reply. It goes back to the person who invited you/)).toBeVisible();
  expect(errors).toEqual([]);
});
