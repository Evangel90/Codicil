// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Runs the demo in a real browser. The owner's passkey is a Chrome virtual
// authenticator, so check-ins go through Chrome's real WebAuthn stack and the
// vault's in-circuit P-256 / clientDataJSON verification, compiled to WASM.
// The savings contract runs next to the vault and calls into it, also in WASM.

import { expect, test, type Page } from '@playwright/test';

async function addVirtualPasskey(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

async function finish(page: Page, expectText: RegExp) {
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('status')).toContainText(expectText, { timeout: 30_000 });
  await sheet.getByRole('button', { name: 'Close' }).click();
}

test('landing page tells the story and opens the demo', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Leave your crypto to the people you choose.');
  await page.getByRole('link', { name: /Try the guided demo/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Protect your vault with your face or fingerprint.' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('full story with a real (virtual) passkey', async ({ page }) => {
  const errors = watchErrors(page);
  await addVirtualPasskey(page);
  await page.goto('/#/demo');

  // The wizard: register the passkey, choose a 1-of-3 guardian threshold, seal.
  await page.getByRole('button', { name: /Register Face ID/ }).click();
  await expect(page.getByText('Passkey registered on this device.')).toBeVisible();
  const next = page.getByRole('button', { name: /Continue|Looks right/ });
  await next.click();                                   // heirs
  await next.click();                                   // shares
  await next.click();                                   // guardians
  await page.getByRole('button', { name: 'Fewer votes needed' }).click();
  await expect(page.getByText('1 of 3', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More votes needed' }).click();
  await next.click();                                   // timers
  await next.click();                                   // recovery key: none
  await next.click();                                   // review
  await expect(page.getByText('2 of 3 must agree')).toBeVisible();
  await expect(page.locator('.review')).toContainText('no grace period');
  await next.click();                                   // deploy
  await page.getByRole('button', { name: 'Seal & deploy vault' }).click();
  await page.getByRole('button', { name: /Go to my vault/ }).click({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Your next check-in is due in' })).toBeVisible();

  await expect(page.getByRole('status').filter({ hasText: /^Next/ })).toContainText('Amara is checking in');

  // Proof of life through Chrome's WebAuthn and the in-circuit verifier.
  await page.getByRole('button', { name: /I'm alive/ }).click();
  await finish(page, /Check-in recorded/);
  await expect(page.getByText(/^Check-in · deadline moved/)).toBeVisible();

  // Harbour Savings, a second contract that asks the vault before it pays.
  // While the vault is armed, the escrow circuit calls the vault circuit and refuses.
  const nav = page.getByRole('navigation', { name: 'Sections' });
  const main = page.getByRole('main');
  const actAs = page.getByRole('group', { name: 'Act as' });
  await nav.getByRole('button', { name: 'Savings' }).click();
  await expect(page.getByRole('heading', { name: 'Savings that follow the will' })).toBeVisible();
  await expect(main.getByText('assert(vault.isReleasedForContract(), "vault not released");')).toBeVisible();
  await main.getByRole('button', { name: 'Act as Ben' }).click();
  await main.getByRole('button', { name: 'Withdraw 8,000 demo tokens' }).click();
  const refusal = page.getByRole('dialog').getByRole('status');
  await expect(refusal).toContainText('the vault said the will is not released', { timeout: 30_000 });
  await expect(refusal).toContainText('vault not released');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await expect(main.getByRole('heading', { name: /^Refused on/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /^Next/ })).toContainText('Harbour Savings refused, as it should.');
  await actAs.getByRole('button', { name: 'Amara' }).click();

  // Change the will: Ada 40%, Ben 40%. Re-sealed with the passkey.
  await page.getByRole('button', { name: 'Will', exact: true }).click();
  await page.getByRole('button', { name: 'Change the will' }).click();
  await page.getByLabel(/^Ada/).fill('40');
  await page.getByLabel(/^Ben/).fill('60');
  await expect(page.getByRole('alert')).toContainText('more than 100%');
  await expect(page.getByRole('button', { name: /Seal the new will/ })).toBeDisabled();
  await page.getByLabel(/^Ben/).fill('40');
  await page.getByRole('button', { name: /Seal the new will/ }).click();
  await finish(page, /new will is sealed/);
  await expect(page.getByRole('cell', { name: '40%' })).toHaveCount(2);

  // Ben's letter: reissued for the new will, with a QR code.
  await page.getByRole('button', { name: "Open Ben's letter" }).click();
  const letter = page.getByRole('dialog', { name: 'For Ben' });
  await expect(letter.getByRole('img', { name: /QR code/ })).toBeVisible();
  await expect(letter).toContainText('will version 2');
  await letter.getByText('Letter as text').click();
  await expect(letter.locator('code')).toContainText('codicil:claim:v1:');
  await letter.getByRole('button', { name: 'Close' }).click();
  await expect(letter).toBeHidden();

  // Two guardians vote, each after confirming; the owner cancels.
  const vote = async () => {
    await page.getByRole('button', { name: 'I confirm the owner has died' }).click();
    const cast = page.getByRole('button', { name: 'Cast my vote' });
    await expect(cast).toBeDisabled();
    await page.getByLabel(/reliable knowledge/).check();
    await cast.click();
  };
  await actAs.getByRole('button', { name: 'Guardian' }).click();
  await vote();
  await finish(page, /1 of 2 so far/);
  await page.getByRole('group', { name: 'Which guardian' }).getByRole('button', { name: 'Sarah Lin' }).click();
  await vote();
  await finish(page, /switch has started/);
  await actAs.getByRole('button', { name: 'Amara' }).click();
  await page.getByRole('button', { name: "I'm here, cancel the switch" }).click();
  await finish(page, /Switch cancelled/);

  // Silence: the deadline passes, the window runs out, the will is released.
  // The command palette, from the keyboard.
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('skip deadline');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await page.getByRole('button', { name: 'Start the switch', exact: true }).click();
  await finish(page, /The switch has started/);
  await page.getByRole('button', { name: 'Skip challenge window' }).click();
  await page.getByRole('button', { name: /Release the will/ }).click();
  await finish(page, /released/);
  await expect(page.getByRole('heading', { name: /This will has been released/ })).toBeVisible();

  // Ben claims his new 40% to a fresh address.
  await actAs.getByRole('button', { name: 'Heir' }).click();
  await page.getByRole('group', { name: 'Which heir' }).getByRole('button', { name: /^Ben/ }).click();
  await expect(page.getByRole('heading', { name: 'Your share is ready when you are.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Claim my share' })).toBeHidden();   // needs his letter first
  await page.getByLabel('Letter text').fill('not a letter');
  await page.getByRole('button', { name: 'Check the letter' }).click();
  await expect(page.getByRole('alert')).toContainText('not a Codicil heir letter');
  await page.getByRole('button', { name: /Use the letter Amara gave me/ }).click();
  await expect(page.getByRole('heading', { name: 'Your letter checks out.' })).toBeVisible();
  await page.getByRole('button', { name: 'Claim my share' }).click();
  await finish(page, /10,000 demo tokens sent/);
  await expect(page.getByRole('heading', { name: 'Thank you, Ben.' })).toBeVisible();

  // The will is released, so the same withdrawal now pays: the escrow asks the
  // vault and gets a yes, two circuits in one transaction.
  await page.getByRole('button', { name: /Amara also named you in Harbour Savings/ }).click();
  await main.getByRole('button', { name: 'Withdraw 8,000 demo tokens' }).click();
  await finish(page, /8,000 demo tokens sent from Harbour Savings/);
  await expect(main.getByRole('heading', { name: 'Paid to the beneficiary' })).toBeVisible();
  await expect(main.getByText('vault.isReleasedForContract', { exact: true })).toBeVisible();
  await expect(main.getByText('savings.withdrawToBeneficiary', { exact: true })).toBeVisible();
  const publicSide = page.locator('.savings-public');
  await expect(publicSide.locator('dl > div').filter({ hasText: 'Withdrawn' })).toContainText('yes');
  await expect(publicSide).not.toContainText(/\b(Ada|Ben|Cleo|Kofi|Mensah|Sarah|Tomás|Amara)\b/);   // "Beneficiary" is a label, not a name

  // The public inspector: what anyone can learn, in plain words.
  await actAs.getByRole('button', { name: 'Anyone' }).click();
  await nav.getByRole('button', { name: 'Inspect' }).click();
  await expect(page.getByRole('heading', { name: 'What anyone can learn.' })).toBeVisible();
  await expect(page.locator('.inspect-rows')).toContainText('1 one-time stamp');
  await expect(page.locator('.inspect-rows')).toContainText('8,000 demo tokens, paid out');
  await expect(page.locator('.inspect-rows')).not.toContainText(/Ada|Ben|Cleo|Kofi|Mensah|Sarah|Tomás|Amara/);
  const fact = (label: string) => page.locator('.inspect-rows > div').filter({ has: page.getByText(label, { exact: true }) });
  await expect(fact('Release fee')).toContainText('None');
  await expect(fact('Recovery key')).toContainText('None');
  await expect(fact('Events')).toContainText('will changed × 1, released × 1');

  // The privacy lens: one nullifier, and no names on the public side.
  await page.getByRole('button', { name: 'Privacy Lens' }).click();
  const pub = page.locator('.lens-public');
  await expect(pub.getByText('claimNullifiers')).toBeVisible();
  await expect(pub.locator('.ledger')).toContainText('1 spent');
  await expect(pub.locator('.ledger')).toContainText('8,000');
  await expect(pub.locator('.ledger')).not.toContainText(/Ada|Ben|Cleo|Kofi|Mensah|Sarah|Tomás|Amara/);
  await page.getByRole('button', { name: "Reveal Amara's view" }).first().click();
  await expect(page.locator('.lens-private .ledger')).toContainText('Ben claimed');

  expect(errors).toEqual([]);
});

/** The wizard, with a passkey from Chrome's virtual authenticator. Ends on the owner's dashboard. */
async function createVault(page: Page, opts: { grace?: string; recoveryKey?: boolean } = {}) {
  await addVirtualPasskey(page);
  await page.goto('/#/demo');
  await page.getByRole('button', { name: /Register Face ID/ }).click();
  await expect(page.getByText('Passkey registered on this device.')).toBeVisible();
  const next = page.getByRole('button', { name: /Continue|Looks right/ });
  for (let i = 0; i < 4; i++) await next.click();       // heirs, shares, guardians, timers
  if (opts.grace) {
    await page.getByRole('group', { name: 'Grace period' }).getByRole('button', { name: opts.grace }).click();
    await expect(page.locator('.worst')).toContainText('47 days');
  }
  await next.click();                                   // recovery key
  await expect(page.getByRole('heading', { name: 'What if you lose your passkey?' })).toBeVisible();
  if (opts.recoveryKey) {
    await page.getByRole('button', { name: 'Create a recovery key' }).click();
    await expect(page.getByLabel('Your recovery key', { exact: true })).toContainText(/^([0-9a-f]{4}\s*){17}$/);
    await expect(next).toBeDisabled();                  // not until the key is saved
    await page.getByRole('button', { name: 'Open the sheet to print or download' }).click();
    const sheet = page.getByRole('dialog', { name: 'Your recovery key' });
    await expect(sheet.getByRole('img', { name: /QR code/ })).toBeVisible();
    await expect(sheet).toContainText('codicil:recovery:v1:');
    await sheet.getByRole('button', { name: 'Close' }).click();
    await page.getByLabel(/I have saved my recovery key/).check();
  }
  await next.click();                                   // review
  await next.click();                                   // deploy
  await page.getByRole('button', { name: 'Seal & deploy vault' }).click();
  await page.getByRole('button', { name: /Go to my vault/ }).click({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Your next check-in is due in' })).toBeVisible();
}

test('grace period: late but fine, and a recovery the owner cancels', async ({ page }) => {
  const errors = watchErrors(page);
  await createVault(page, { grace: '3 days', recoveryKey: true });
  const nextBar = page.getByRole('status').filter({ hasText: /^Next/ });
  const nav = page.getByRole('navigation', { name: 'Sections' });
  const actAs = page.getByRole('group', { name: 'Act as' });
  const main = page.getByRole('main');
  const fact = (label: string) => page.locator('.inspect-rows > div').filter({ has: page.getByText(label, { exact: true }) });

  // The deadline passes. Nobody can start the switch: Amara is inside her grace period.
  await page.getByRole('button', { name: 'Skip to deadline' }).click();
  await expect(nextBar).toContainText('her 3-day grace period runs until');
  await expect(page.getByRole('button', { name: 'Start the switch', exact: true })).toHaveCount(0);
  await expect(main.getByRole('heading', { name: /You missed your check-in on .* You are late, but inside your 3-day grace period/ })).toBeVisible();
  await actAs.getByRole('button', { name: 'Anyone' }).click();
  await expect(fact('State')).toContainText('this vault has a grace period');
  await expect(fact('Grace period')).toContainText('3 days');
  await actAs.getByRole('button', { name: 'Amara' }).click();

  // A day late, she checks in through the passkey as usual: late but fine.
  await page.getByRole('button', { name: '+1 day' }).click();
  await page.getByRole('button', { name: /I'm alive/ }).click();
  await finish(page, /Check-in recorded, 1 day late\. You were inside your grace period, so nothing else happened\./);
  await expect(main.getByText(/^Late check-in, inside the grace period/)).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Your next check-in is due in' })).toBeVisible();

  // Silence through the deadline and the whole grace period: now the switch can start.
  await page.getByRole('button', { name: 'Skip to deadline' }).click();
  await page.getByRole('button', { name: 'Skip the grace period' }).click();
  await expect(nextBar).toContainText('her grace period is over');
  await main.getByRole('button', { name: 'Start the switch so I can cancel it' }).click();
  await finish(page, /The switch has started\. The owner can cancel until .*, 14 days from now\./);
  await page.getByRole('button', { name: "I'm here, cancel the switch" }).click();
  await finish(page, /Switch cancelled/);

  // Someone uses the recovery key. A mistyped key never leaves the device.
  await nav.getByRole('button', { name: 'Settings' }).click();
  await expect(main.getByRole('heading', { name: 'Your recovery key is ready.' })).toBeVisible();
  await main.getByRole('textbox', { name: 'Recovery key' }).fill('not my key');
  await main.getByRole('button', { name: 'Start the recovery' }).click();
  await expect(main.getByRole('alert')).toContainText('only the digits 0 to 9 and the letters a to f');
  await main.getByRole('button', { name: /Use the key Amara saved/ }).click();
  await main.getByRole('button', { name: 'Start the recovery' }).click();
  await finish(page, /Recovery started\. The new passkey takes over on/);

  // Amara's dashboard cannot be read without seeing it, and it says what stops it.
  await nav.getByRole('button', { name: 'Vault' }).click();
  const alert = main.getByRole('alert');
  await expect(alert.getByRole('heading')).toContainText('Someone is replacing your passkey');
  await expect(alert).toContainText('If this was not you, check in now.');
  await expect(alert).toContainText('retired for good');
  await expect(nextBar).toContainText("A recovery started with Amara's recovery key");
  await expect(page.getByRole('button', { name: 'Skip the recovery delay' })).toBeVisible();
  await actAs.getByRole('button', { name: 'Anyone' }).click();
  await expect(fact('Recovery key')).toContainText('recovery started, takes effect');
  await expect(fact('Events')).toContainText('recovery started × 1');
  await actAs.getByRole('button', { name: 'Amara' }).click();

  // One check-in cancels it, and the key is gone for good.
  await alert.getByRole('button', { name: /Check in with Face ID and cancel the recovery/ }).click();
  await finish(page, /It also cancelled the recovery that was in progress, and the recovery key is now retired for good\./);
  await expect(main.getByRole('alert')).toHaveCount(0);
  await expect(main.getByRole('heading', { name: 'The recovery was cancelled.' })).toBeVisible();
  await expect(main.getByText('Recovery cancelled · recovery key retired for good')).toBeVisible();
  await main.getByRole('button', { name: 'Dismiss' }).click();
  await expect(main.getByRole('button', { name: /Guardians and recovery key/ })).toContainText('recovery key retired for good');
  await nav.getByRole('button', { name: 'Settings' }).click();
  await expect(main.getByRole('heading', { name: 'Your recovery key is retired for good.' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Start the recovery' })).toHaveCount(0);

  // What the chain shows of all this: lengths, dates and counters; no secret, no names.
  await nav.getByRole('button', { name: 'Privacy Lens' }).click();
  const ledger = page.locator('.lens-public .ledger');
  const row = (key: string) => ledger.locator('.lens-row').filter({ has: page.getByText(key, { exact: true }) });
  await expect(row('gracePeriod')).toContainText('259200');
  await expect(row('feeBps')).toContainText('0 · no release fee');
  await expect(row('recoveryReadyAt · recoveryNonce')).toContainText('cancelled');
  await expect(row('events')).toContainText('recovery started × 1');
  await expect(ledger).not.toContainText(/Ada|Ben|Cleo|Kofi|Mensah|Sarah|Tomás|Ngozi|Bello|Amara|Lagos/);
  await actAs.getByRole('button', { name: 'Anyone' }).click();
  await nav.getByRole('button', { name: 'Inspect' }).click();
  await expect(fact('Recovery key')).toContainText('a recovery was cancelled, key retired');

  expect(errors).toEqual([]);
});

test('new guardians, and a lost passkey recovered with the saved key', async ({ page }) => {
  const errors = watchErrors(page);
  await createVault(page, { recoveryKey: true });
  const nextBar = page.getByRole('status').filter({ hasText: /^Next/ });
  const nav = page.getByRole('navigation', { name: 'Sections' });
  const actAs = page.getByRole('group', { name: 'Act as' });
  const main = page.getByRole('main');

  // One guardian has voted when Amara replaces Tomás with Ngozi.
  await actAs.getByRole('button', { name: 'Guardian' }).click();
  await page.getByRole('button', { name: 'I confirm the owner has died' }).click();
  await page.getByLabel(/reliable knowledge/).check();
  await page.getByRole('button', { name: 'Cast my vote' }).click();
  await finish(page, /1 of 2 so far/);
  await actAs.getByRole('button', { name: 'Amara' }).click();
  await main.getByRole('button', { name: /Guardians and recovery key/ }).click();
  await expect(main.getByRole('heading', { name: 'Guardians and recovery' })).toBeVisible();
  await main.getByRole('button', { name: 'Change guardians or the attestor' }).click();
  const save = main.getByRole('button', { name: /Save and start a new round/ });
  await expect(save).toBeDisabled();                    // nothing changed yet
  await main.getByLabel(/^Tomás/).uncheck();
  await main.getByLabel(/^Ngozi/).check();
  await expect(main.locator('.settings-effect')).toContainText('Adds Ngozi.');
  await expect(main.locator('.settings-effect')).toContainText('Removes Tomás.');
  await expect(main.locator('.settings-effect')).toContainText('The vote already cast this round will no longer count');
  await save.click();
  await finish(page, /Ngozi can vote from now on\. Tomás can no longer vote\. A new voting round has started, so the vote cast before no longer counts\./);
  await expect(main.locator('.people-read')).toContainText('Removed, can no longer vote');
  await expect(main.getByText('Round 2 · 0 votes so far')).toBeVisible();

  // Tomás is told by his own app; Ngozi can vote with the proof she was sent.
  await actAs.getByRole('button', { name: 'Guardian' }).click();
  const which = page.getByRole('group', { name: 'Which guardian' });
  await which.getByRole('button', { name: 'Tomás' }).click();
  await expect(main.getByRole('heading', { name: 'You are no longer a guardian of this will.' })).toBeVisible();
  await main.getByRole('button', { name: 'Try to vote anyway' }).click();
  await finish(page, /You are no longer a guardian of this will/);
  await which.getByRole('button', { name: 'Ngozi' }).click();
  await page.getByRole('button', { name: 'I confirm the owner has died' }).click();
  await page.getByLabel(/reliable knowledge/).check();
  await page.getByRole('button', { name: 'Cast my vote' }).click();
  await finish(page, /1 of 2 so far/);
  await actAs.getByRole('button', { name: 'Amara' }).click();
  await page.getByRole('button', { name: /I'm alive/ }).click();
  await finish(page, /Check-in recorded/);

  // Amara loses her phone. With the saved key, a new passkey is proposed.
  await nav.getByRole('button', { name: 'Settings' }).click();
  await main.getByRole('button', { name: /Use the key Amara saved/ }).click();
  await main.getByRole('button', { name: 'Start the recovery' }).click();
  await finish(page, /Recovery started/);
  await main.getByRole('button', { name: 'Open my next recovery key' }).click();
  const sheet = page.getByRole('dialog', { name: 'Your next recovery key' });
  await expect(sheet).toContainText('replaces the one you used to start it');
  await sheet.getByRole('button', { name: 'Close' }).click();

  // The public delay runs out, and anyone finishes it.
  await page.getByRole('button', { name: 'Skip the recovery delay' }).click();
  await expect(nextBar).toContainText('The recovery delay is over.');
  await nextBar.getByRole('button', { name: 'Finish the recovery' }).click();
  await finish(page, /The recovery is finished\. The new passkey now owns the vault and the old one no longer works\./);
  await expect(main.getByRole('heading', { name: 'The recovery is finished.' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Your recovery key is ready.' })).toBeVisible();

  // The old passkey is refused by the vault; the new one checks in.
  await main.getByRole('button', { name: 'Try a check-in with the old passkey' }).click();
  await finish(page, /The vault refused the old passkey/);
  await nav.getByRole('button', { name: 'Vault' }).click();
  await page.getByRole('button', { name: /I'm alive/ }).click();
  await finish(page, /Check-in recorded/);

  expect(errors).toEqual([]);
});

test('a sealed message: shut until the release, then opened by the one person it is for', async ({ page }) => {
  const errors = watchErrors(page);
  await createVault(page);
  const nav = page.getByRole('navigation', { name: 'Sections' });
  const main = page.getByRole('main');
  const actAs = page.getByRole('group', { name: 'Act as' });
  const nextBar = page.getByRole('status').filter({ hasText: /^Next/ });
  const messages = () => nav.getByRole('button', { name: 'Messages' }).click();
  const SECRET = 'harbor velvet orbit lantern copper meadow';

  // Amara writes to Ada and seals it. No transaction sheet opens: nothing goes to the chain.
  await messages();
  await expect(nextBar).toContainText('Amara can seal a message for one person.');
  await main.getByRole('button', { name: 'Write to Ada' }).click();
  await expect(main.getByRole('button', { name: 'Seal for Ada' })).toBeDisabled();
  await main.getByRole('button', { name: 'a recovery phrase' }).click();
  await expect(main.getByLabel('Your message for Ada')).toHaveValue(new RegExp(SECRET));
  await main.getByRole('button', { name: 'Seal for Ada' }).click();
  await expect(page.locator('.toast')).toContainText('Each of your 3 guardians holds a piece of the key. 2 of them are needed.');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(main).toContainText('Dr. Mensah, Sarah Lin and Tomás each hold a piece of its key. Any 2 of them open it, together with Ada.');

  // The chain has no record of it; the private side of the lens does.
  await nav.getByRole('button', { name: 'Privacy Lens' }).click();
  await expect(page.locator('.lens-public')).toContainText('nothing · no field');
  await expect(page.locator('.lens-public')).not.toContainText('Ada');
  await expect(page.locator('.lens-private .ledger')).toContainText('1, for Ada');

  // Ada holds sealed text she cannot open, and a guardian's app keeps its piece.
  await actAs.getByRole('button', { name: 'Heir' }).click();
  await page.getByRole('group', { name: 'Which heir' }).getByRole('button', { name: 'Ada' }).click();
  await nav.getByRole('button', { name: 'Your share' }).click();
  await main.getByRole('button', { name: /Amara left you a sealed message/ }).click();
  await expect(main.getByRole('heading', { name: 'Amara left you a sealed message.' })).toBeVisible();
  await expect(main).not.toContainText(SECRET);
  await main.getByRole('button', { name: 'Open the message' }).click();
  await expect(main.getByRole('alert')).toHaveText('It is still locked. It needs 2 guardian pieces and none has arrived.');
  await actAs.getByRole('button', { name: 'Guardian' }).click();
  await messages();
  await expect(main.getByRole('heading', { name: 'You hold a piece of a key.' })).toBeVisible();
  await main.getByRole('button', { name: 'Hand over my piece' }).click();
  await expect(main.getByRole('alert')).toHaveText('The vault has not released, so your piece stays on this device. Nothing was sent.');

  // Amara stops checking in. The switch starts, nobody cancels, the will is released.
  await page.getByRole('button', { name: 'Skip to deadline' }).click();
  await nav.getByRole('button', { name: 'Guardian' }).click();
  await nextBar.getByRole('button', { name: /Start the switch/ }).click();
  await finish(page, /switch has started|countdown/i);
  await page.getByRole('button', { name: 'Skip challenge window' }).click();
  await nextBar.getByRole('button', { name: /Release the will/ }).click();
  await finish(page, /The will is released/);

  // Two guardians hand over their pieces; the first alone is not enough.
  await messages();
  await expect(nextBar).toContainText('2 more are needed before Ada can open the message.');
  await main.getByRole('button', { name: 'Hand over my piece' }).click();
  await expect(main).toContainText('Your piece is handed over.');
  await expect(nextBar).toContainText('One more is needed');
  await page.getByRole('group', { name: 'Which guardian' }).getByRole('button', { name: /Tomás/ }).click();
  await main.getByRole('button', { name: 'Hand over my piece' }).click();
  await expect(nextBar).toContainText('Enough pieces have arrived. Ada can open the message now.');

  // Ada opens it on her own device, with real decryption in the browser.
  await nextBar.getByRole('button', { name: 'Act as Ada' }).click();
  await expect(main.getByRole('img', { name: '2 of 2 pieces have arrived' })).toBeVisible();
  await main.getByRole('button', { name: 'Open the message' }).click();
  await expect(main.getByRole('heading', { name: "Amara's message to you." })).toBeVisible();
  await expect(main.getByRole('article', { name: 'Message from Amara' })).toContainText(SECRET);

  // Nobody else sees it, and it is still not on the chain.
  await page.getByRole('group', { name: 'Which heir' }).getByRole('button', { name: 'Ben' }).click();
  await expect(main.getByRole('heading', { name: 'No sealed message on this device.' })).toBeVisible();
  await nav.getByRole('button', { name: 'Privacy Lens' }).click();
  await expect(page.locator('.lens-public')).toContainText('nothing · no field');
  await expect(page.locator('.lens-public')).not.toContainText(/Ada|harbor/);

  expect(errors).toEqual([]);
});
