// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The reader page: a vault read with no wallet. These tests stay off the
// network, so they cover the page itself. What it reads, and how it checks
// and opens a sealed text, is covered against real contract states in
// app/test/reader.test.ts; the example on the page is a real vault on Preview.

import { expect, test } from '@playwright/test';

test('the reader page asks for an address and nothing else', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Keep the test off the network: the indexer here knows no contract at all.
  await page.route(/indexer\./, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { contractAction: null } }) }));
  await page.goto('/#/read');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Read a vault. No wallet needed.');
  const read = page.getByRole('button', { name: 'Read from Preview' });
  await expect(read).toBeDisabled();

  await page.getByLabel('Vault address').fill('abc');
  await expect(page.getByText('A vault address is 64 hexadecimal characters.')).toBeVisible();
  await expect(read).toBeDisabled();

  // A full address can be read; where there is no contract the page says so in words.
  await page.getByLabel('Vault address').fill('ab'.repeat(32));
  await expect(read).toBeEnabled();
  await read.click();
  await expect(page.getByRole('alert')).toContainText('Preview has no contract at that vault address.');
  await expect(page.getByRole('button', { name: 'Use the example vault' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a link that carries addresses fills the form', async ({ page }) => {
  await page.route(/indexer\./, (route) => route.abort());
  const vault = 'cd'.repeat(32);
  const register = 'ef'.repeat(32);
  await page.goto(`/#/read/${vault}/${register}`);
  await expect(page.getByLabel('Vault address')).toHaveValue(vault);
  await expect(page.getByLabel(/Seal register address/)).toHaveValue(register);
});
