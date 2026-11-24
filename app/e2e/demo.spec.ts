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

test('landing page seals the will line and links to the demo', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your will stays yours.');
  await expect(page.getByRole('button', { name: 'Show what I wrote' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('link', { name: 'Try the demo' }).click();
  await expect(page.getByRole('heading', { name: 'Seal a demo vault' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('full story with a real (virtual) passkey', async ({ page }) => {
  const errors = watchErrors(page);
  await addVirtualPasskey(page);
  await page.goto('/#/demo');

  const create = page.getByRole('button', { name: /Create a passkey/ });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByRole('heading', { name: /Next check-in due in/ })).toBeVisible({ timeout: 30_000 });

  // Proof of life through Chrome's WebAuthn and the in-circuit verifier.
  await page.getByRole('button', { name: /I'm alive/ }).click();
  await finish(page, /Check-in recorded/);
  await expect(page.getByText('Checked in', { exact: true })).toBeVisible();

  // Change the will: Ada 40%, Ben 40%. Re-sealed with the passkey.
  await page.getByRole('button', { name: 'Change the will' }).click();
  await page.getByLabel(/^Ada/).fill('40');
  await page.getByLabel(/^Ben/).fill('60');
  await expect(page.getByRole('alert')).toContainText('more than 100%');
  await expect(page.getByRole('button', { name: /Seal the new will/ })).toBeDisabled();
  await page.getByLabel(/^Ben/).fill('40');
  await page.getByRole('button', { name: /Seal the new will/ }).click();
  await finish(page, /new will is sealed/);
  await expect(page.getByRole('cell', { name: '40%' })).toHaveCount(2);

  // Two guardians report; the owner cancels.
  const actor = page.getByLabel('Act as');
  await actor.selectOption({ label: 'Dr. Mensah, family doctor' });
  await page.getByRole('button', { name: /Report Amara's death/ }).click();
  await finish(page, /1 of 2/);
  await actor.selectOption({ label: 'Sarah Lin, lawyer' });
  await page.getByRole('button', { name: /Report Amara's death/ }).click();
  await finish(page, /Enough guardians agreed/);
  await actor.selectOption({ label: 'Amara Okafor (owner)' });
  await page.getByRole('button', { name: /cancel the countdown/ }).click();
  await finish(page, /Countdown cancelled/);

  // Silence: the deadline passes, the countdown runs out, the will is released.
  await page.getByRole('button', { name: 'Skip to the deadline' }).click();
  await page.getByRole('button', { name: 'Start the countdown' }).click();
  await finish(page, /missed their deadline/);
  await page.getByRole('button', { name: 'Skip the challenge window' }).click();
  await page.getByRole('button', { name: 'Release the will' }).click();
  await finish(page, /released/);

  // Ben claims his new 40%.
  await actor.selectOption({ label: 'Ben, son' });
  await page.getByRole('button', { name: /Claim 10,000 demo tokens/ }).click();
  await finish(page, /10,000 demo tokens sent/);

  // The privacy lens shows one nullifier and no names on the public side.
  await page.getByRole('button', { name: 'Privacy lens' }).click();
  const pub = page.locator('.lens-public');
  await expect(pub.getByText('claimNullifiers')).toBeVisible();
  await expect(pub.locator('.ledger')).not.toContainText(/Ada|Ben|Cleo|Kofi|Mensah/);

  expect(errors).toEqual([]);
});
