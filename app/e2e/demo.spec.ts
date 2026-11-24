// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Runs the demo in a real browser. The owner's passkey is a Chrome virtual
// authenticator, so check-ins go through Chrome's real WebAuthn stack and the
// vault's in-circuit P-256 / clientDataJSON verification, compiled to WASM.

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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your will, proven private.');
  await page.getByRole('link', { name: /Launch the demo/ }).click();
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
  await next.click();                                   // review
  await expect(page.getByText('2 of 3 must agree')).toBeVisible();
  await next.click();                                   // deploy
  await page.getByRole('button', { name: 'Seal & deploy vault' }).click();
  await page.getByRole('button', { name: /Go to my vault/ }).click({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Your next check-in is due in' })).toBeVisible();

  await expect(page.getByRole('status').filter({ hasText: /^Next/ })).toContainText('Amara is checking in');

  // Proof of life through Chrome's WebAuthn and the in-circuit verifier.
  await page.getByRole('button', { name: /I'm alive/ }).click();
  await finish(page, /Check-in recorded/);
  await expect(page.getByText(/^Check-in · deadline moved/)).toBeVisible();

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
  const actAs = page.getByRole('group', { name: 'Act as' });
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
  await page.getByRole('button', { name: /Start the switch/ }).click();
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

  // The public inspector: what anyone can learn, in plain words.
  await actAs.getByRole('button', { name: 'Anyone' }).click();
  await expect(page.getByRole('heading', { name: 'What anyone can learn.' })).toBeVisible();
  await expect(page.locator('.inspect-rows')).toContainText('1 one-time stamp');
  await expect(page.locator('.inspect-rows')).not.toContainText(/Ada|Ben|Cleo|Kofi|Mensah|Sarah|Tomás|Amara/);

  // The privacy lens: one nullifier, and no names on the public side.
  await page.getByRole('button', { name: 'Privacy Lens' }).click();
  const pub = page.locator('.lens-public');
  await expect(pub.getByText('claimNullifiers')).toBeVisible();
  await expect(pub.locator('.ledger')).toContainText('1 spent');
  await expect(pub.locator('.ledger')).not.toContainText(/Ada|Ben|Cleo|Kofi|Mensah|Sarah|Tomás|Amara/);
  await page.getByRole('button', { name: "Reveal Amara's view" }).first().click();
  await expect(page.locator('.lens-private .ledger')).toContainText('Ben claimed');

  expect(errors).toEqual([]);
});
