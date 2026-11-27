// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Where things live. Secrets and working state go under `.midnight/` at the
// repo root, which .gitignore already excludes; results, which hold nothing
// secret, go under `preprod/results/`.

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { NetworkName } from './env.js';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export const ENV_PATH = join(REPO_ROOT, '.env');
export const RESULTS_DIR = join(REPO_ROOT, 'preprod', 'results');
export const VAULT_DIR = join(REPO_ROOT, 'contracts', 'managed', 'codicil_vault');
export const ESCROW_DIR = join(REPO_ROOT, 'contracts', 'managed', 'inheritable_escrow');
export const SEALS_DIR = join(REPO_ROOT, 'contracts', 'managed', 'codicil_seals');
/** Public proving parameters downloaded for in-process proving (`dryrun --prove`). */
export const PARAMS_CACHE_DIR = join(REPO_ROOT, '.midnight', 'srs');

export interface NetworkPaths {
  dir: string;
  /** Run progress and the throwaway vault's keys. */
  state: string;
  /** Saved wallet sync state. */
  walletSnapshot: string;
  /** Held while a command is using the wallet. */
  lock: string;
}

export function networkPaths(network: NetworkName, root: string = REPO_ROOT): NetworkPaths {
  const dir = join(root, '.midnight', 'codicil', network);
  return {
    dir,
    state: join(dir, 'state.json'),
    walletSnapshot: join(dir, 'wallet.json'),
    lock: join(dir, 'wallet.lock'),
  };
}
