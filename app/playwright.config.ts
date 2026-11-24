// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Browser end-to-end tests against the production build, served on the
// origin the vault was compiled for (passkeys are bound to it).

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    // CI installs Playwright's Chromium; locally, PW_CHANNEL=chrome uses the installed Chrome.
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite preview --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
