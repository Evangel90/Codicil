// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The run's progress on disk. Real time has to pass between steps, so every
// finished step is written down and a rerun continues from the next one.
//
// The state file holds the throwaway vault's keys (owner passkey, owner wallet
// key, heir keys). They guard test tokens only, but they are still secrets:
// the file lives under `.midnight/`, which is gitignored, with mode 0600.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NetworkName } from './env.js';
import type { Timers } from './timers.js';

export const STATE_VERSION = 1;

/** Vault steps, in the order the run performs them. */
export const VAULT_STEPS = [
  'deploy',
  'deposit',
  'checkInPasskey',
  'checkInEd25519',
  'triggerTimeout',
  'finalizeRelease',
  'claim',
  'readEvents',
] as const;

/** Optional escrow steps (gate V12), run after the vault is released. */
export const ESCROW_STEPS = ['escrowDeploy', 'escrowDeposit', 'escrowWithdraw'] as const;

export const ALL_STEPS = [...VAULT_STEPS, ...ESCROW_STEPS] as const;
export type Step = (typeof ALL_STEPS)[number];

/** What one finished step left behind. Nothing here is secret. */
export interface StepRecord {
  step: Step;
  /** ISO time the step started and finished on this machine. */
  startedAt: string;
  finishedAt: string;
  /** Wall time for the whole step, in milliseconds. */
  totalMs: number;
  txId?: string;
  txHash?: string;
  blockHeight?: number;
  blockHash?: string;
  /** Unix seconds, as the indexer reports the block. */
  blockTimestamp?: number;
  status?: string;
  /** Fee the ledger took, in SPECK (1 DUST = 10^15 SPECK), as the indexer reports it. */
  feePaid?: string;
  feeEstimated?: string;
  /** Time the proof server took for the contract's own circuits. */
  proveMs?: number;
  /** Time the wallet took to add the fee, prove its DUST spend and sign. */
  balanceMs?: number;
  /** Time from submission until the indexer reported the transaction final. */
  confirmMs?: number;
  /** Circuits proven for this transaction (more than one for a cross-contract call). */
  circuits?: string[];
  /** Anything worth a line in the results: amounts, deadlines, recovered steps. */
  notes?: string[];
}

/** The release event as the indexer served it (gate V13). */
export interface ReleaseEvent {
  /** Indexer cursor of the event. */
  id: number;
  eventType: string;
  /** Event name as text, with the zero padding removed. */
  name: string;
  /** Hash of the transaction the indexer attributes the event to, when it was queried by hash. */
  txHash?: string;
  payloadVersion: number;
  protocolVersion: number;
}

/** Secrets of the throwaway vault, kept so a rerun can sign and claim again. */
export interface Actors {
  /** Software "passkey": a P-256 key that signs in the WebAuthn format the vault verifies. */
  passkey: { sk: Uint8Array; pk: { x: bigint; y: bigint }; salt: Uint8Array };
  /** Software "Cardano wallet": an Ed25519 key that signs in the CIP-30 format. */
  wallet: { sk: Uint8Array; pk: { x: bigint; y: bigint }; salt: Uint8Array };
  heirs: { sk: bigint; keySalt: Uint8Array; shareBps: bigint }[];
  /** The will's leaves exactly as deployed (their salts are random, so they cannot be rebuilt). */
  leaves: { heirKeyCommit: Uint8Array; backupKeyCommit: Uint8Array; shareBps: bigint; unlockAt: bigint; salt: Uint8Array }[];
  /** Escrow beneficiary secret, when the escrow steps run. */
  escrowSecret?: Uint8Array;
}

export interface VaultInfo {
  address: string;
  /** Unix seconds the deploy transaction was built at. */
  deployedAt: number;
  firstDeadline: bigint;
  maxPeriod: bigint;
  challengeWindow: bigint;
  claimWindow: bigint;
  depositAmount: bigint;
}

export interface RunState {
  version: typeof STATE_VERSION;
  network: NetworkName;
  createdAt: string;
  timers: Timers;
  actors: Actors;
  vault?: VaultInfo;
  escrow?: { address: string; amount: bigint };
  releaseEvent?: ReleaseEvent;
  steps: Partial<Record<Step, StepRecord>>;
}

export interface StepPlan {
  /** Whether the escrow steps are part of this run. */
  escrow: boolean;
}

export function stepsFor(plan: StepPlan): readonly Step[] {
  return plan.escrow ? ALL_STEPS : VAULT_STEPS;
}

/** The first step with no record, or undefined when the run is complete. */
export function nextStep(state: Pick<RunState, 'steps'>, plan: StepPlan): Step | undefined {
  return stepsFor(plan).find((s) => state.steps[s] === undefined);
}

export function isComplete(state: Pick<RunState, 'steps'>, plan: StepPlan): boolean {
  return nextStep(state, plan) === undefined;
}

/**
 * Check a loaded state against what this run was asked to do. A state file
 * from another network, or one whose steps are out of order, is refused
 * rather than guessed at.
 */
export function stateProblems(state: RunState, network: NetworkName): string[] {
  const problems: string[] = [];
  if (state.version !== STATE_VERSION) problems.push(`state file version ${state.version} is not ${STATE_VERSION}`);
  if (state.network !== network) problems.push(`state file is for ${state.network}, but this run targets ${network}`);
  // Within each group the recorded steps must be a prefix: no step without the ones before it.
  for (const group of [VAULT_STEPS, ESCROW_STEPS] as const) {
    let gap: Step | undefined;
    for (const s of group) {
      if (state.steps[s] === undefined) gap ??= s;
      else if (gap !== undefined) problems.push(`step "${s}" is recorded but the earlier step "${gap}" is not`);
    }
  }
  if (state.steps.deploy !== undefined && state.vault === undefined) problems.push('deploy is recorded but the vault address is missing');
  if (state.steps.escrowDeploy !== undefined && state.escrow === undefined) problems.push('escrowDeploy is recorded but the escrow address is missing');
  return problems;
}

/** Record a finished step. Returns a new state; the caller saves it. */
export function recordStep(state: RunState, record: StepRecord): RunState {
  return { ...state, steps: { ...state.steps, [record.step]: record } };
}

// ─── JSON with bigints and bytes ────────────────────────────────────────────
// Tagged strings, so the file stays readable: "n:123" for a bigint, "x:0a0b" for bytes.

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error('corrupt state file: bad byte string');
  return Uint8Array.from(s.match(/../g) ?? [], (p) => parseInt(p, 16));
};

export function encodeJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) => {
      if (typeof v === 'bigint') return `n:${v.toString()}`;
      if (v instanceof Uint8Array) return `x:${hex(v)}`;
      if (typeof v === 'string' && /^[nxs]:/.test(v)) return `s:${v}`;
      return v;
    },
    2,
  ) + '\n';
}

export function decodeJson<T>(text: string): T {
  return JSON.parse(text, (_k, v: unknown) => {
    if (typeof v !== 'string') return v;
    if (v.startsWith('n:')) return BigInt(v.slice(2));
    if (v.startsWith('x:')) return unhex(v.slice(2));
    if (v.startsWith('s:')) return v.slice(2);
    return v;
  }) as T;
}

export function loadState(path: string): RunState | undefined {
  if (!existsSync(path)) return undefined;
  return decodeJson<RunState>(readFileSync(path, 'utf8'));
}

/** Write atomically (temp file, then rename), readable by the owner only. */
export function writeFileAtomic(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

export function saveState(path: string, state: RunState): void {
  writeFileAtomic(path, encodeJson(state));
}
