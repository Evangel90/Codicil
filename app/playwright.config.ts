// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Browser end-to-end tests against the production build, served on the
// origin the vault was compiled for (passkeys are bound to it).

import { defineConfig } from '@playwright/test';

// The vault accepts passkeys from any origin as long as `http://localhost:5173`
// (it checks the relying party, `localhost`, and the origin's length), so the
// suite can run on another four-digit port when 5173 is taken: E2E_PORT=5199.
const port = Number(process.env.E2E_PORT ?? 5173);

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    // CI installs Playwright's Chromium; locally, PW_CHANNEL=chrome uses the installed Chrome.
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
