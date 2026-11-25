// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Command-line flags and the settings read from the environment. Pure, so it
// is unit-tested.

import { parseNight, SPECK_PER_DUST } from './results.js';

export const COMMANDS = ['init', 'check', 'dust', 'run', 'status', 'dryrun', 'help'] as const;
export type Command = (typeof COMMANDS)[number];

export interface CliOptions {
  command: Command;
  /** `run`, `check`, `dryrun`: include the example escrow (gate V12). */
  escrow: boolean;
  /** `run`: set the saved run aside and deploy a new vault. */
  fresh: boolean;
  /** Ignore saved wallet sync state and sync from the start. */
  freshSync: boolean;
  /** `check`: skip the wallet (no sync, no balances). */
  noWallet: boolean;
  /** `dryrun`: also prove each transaction in this process. */
  prove: boolean;
  /** Override for how long to wait for the wallet to sync, in seconds. */
  syncTimeoutS?: number;
}

export const USAGE = `Codicil gate V14: the vault end to end on a real Midnight network.

  npm run preprod:init      create the throwaway test wallet (.env) and print its address
  npm run preprod:check     say exactly what is missing before a run
  npm run preprod:dust      register the wallet's tNIGHT for DUST and wait for enough to pay fees
  npm run preprod:run       deploy, deposit, check in twice, time out, release, claim, read the event
  npm run preprod:status    show the saved progress of the run (no network)
  npm run preprod:dryrun    build every transaction offline with Midnight.js (no network, nothing sent)

Flags (after \`--\`, for example \`npm run preprod:run -- --escrow\`):
  --escrow             also deploy the example escrow and do the cross-contract withdrawal (gate V12)
  --fresh              run: set the saved run aside and start a new vault
  --fresh-sync         ignore saved wallet sync state
  --no-wallet          check: skip the wallet sync and balances
  --sync-timeout=SEC   how long to wait for the wallet to sync
  --prove              dryrun: also prove in this process what fits in WebAssembly (downloads public parameters)

Network: MIDNIGHT_NETWORK=preprod (default, needs BLOCKFROST_PROJECT_ID), preview, or undeployed.
See docs/PREPROD.md.`;

export function parseArgs(argv: readonly string[]): CliOptions {
  const out: CliOptions = { command: 'help', escrow: false, fresh: false, freshSync: false, noWallet: false, prove: false };
  let sawCommand = false;
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      out.command = 'help';
      return out;
    }
    if (arg === '--escrow') out.escrow = true;
    else if (arg === '--fresh') out.fresh = true;
    else if (arg === '--fresh-sync') out.freshSync = true;
    else if (arg === '--no-wallet') out.noWallet = true;
    else if (arg === '--prove') out.prove = true;
    else if (arg.startsWith('--sync-timeout=')) {
      const n = Number(arg.slice('--sync-timeout='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${arg}: expected a whole number of seconds`);
      out.syncTimeoutS = n;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag ${arg}`);
    } else if (!sawCommand) {
      if (!(COMMANDS as readonly string[]).includes(arg)) throw new Error(`unknown command "${arg}" (expected one of: ${COMMANDS.join(', ')})`);
      out.command = arg as Command;
      sawCommand = true;
    } else {
      throw new Error(`unexpected argument "${arg}"`);
    }
  }
  return out;
}

export interface Settings {
  /** tNIGHT put into the vault, in STAR. */
  depositStar: bigint;
  /** tNIGHT put into the escrow, in STAR. */
  escrowStar: bigint;
  /** DUST the wallet must hold before a run starts, in SPECK. */
  minDustSpeck: bigint;
  /** Per-request timeout for the proof server. */
  proofTimeoutMs: number;
  /** How long `dust` and `run` wait for the wallet to sync. A first sync on Preprod can take hours. */
  syncTimeoutMs: number;
  /** How long to wait for the wallet to apply a transaction before building the next. */
  settleTimeoutMs: number;
}

export const SETTINGS_ENV = {
  deposit: 'CODICIL_DEPOSIT',
  escrowDeposit: 'CODICIL_ESCROW_DEPOSIT',
  minDust: 'CODICIL_MIN_DUST',
  proofTimeout: 'CODICIL_PROOF_TIMEOUT_S',
  syncTimeout: 'CODICIL_SYNC_TIMEOUT_S',
  settleTimeout: 'CODICIL_SETTLE_TIMEOUT_S',
} as const;

function seconds(env: Readonly<Record<string, string | undefined>>, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`${key}="${raw}" is not a positive whole number of seconds`);
  return Number(raw);
}

export function settingsFromEnv(env: Readonly<Record<string, string | undefined>>): Settings {
  const night = (key: string, fallback: string): bigint => {
    const v = parseNight(env[key]?.trim() || fallback);
    if (v <= 0n) throw new Error(`${key} must be above 0`);
    return v;
  };
  const minDustRaw = env[SETTINGS_ENV.minDust]?.trim() || '20';
  if (!/^\d+$/.test(minDustRaw)) throw new Error(`${SETTINGS_ENV.minDust}="${minDustRaw}" must be a whole number of DUST`);
  return {
    depositStar: night(SETTINGS_ENV.deposit, '10'),
    escrowStar: night(SETTINGS_ENV.escrowDeposit, '5'),
    minDustSpeck: BigInt(minDustRaw) * SPECK_PER_DUST,
    proofTimeoutMs: seconds(env, SETTINGS_ENV.proofTimeout, 900) * 1000,
    syncTimeoutMs: seconds(env, SETTINGS_ENV.syncTimeout, 6 * 3600) * 1000,
    settleTimeoutMs: seconds(env, SETTINGS_ENV.settleTimeout, 600) * 1000,
  };
}
