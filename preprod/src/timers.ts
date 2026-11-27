// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Timer selection for a real run. On a network there is no clock to move
// forward, so the vault is deployed with the shortest timers that still leave
// room to build, prove and land each transaction.
//
// What the contract enforces (contracts/src/codicil_vault.compact):
//   constructor      maxPeriod > 0 and challengeWindow > 0. Nothing else: no minimum
//                    for the first deadline, the periods or the claim window.
//   check-in         block time < current deadline (while armed)
//                    block time < next
//                    next - maxPeriod <= block time        (next <= now + maxPeriod)
//   triggerTimeout   block time >= deadline
//   finalizeRelease  block time >= pendingUntil = deadline + challengeWindow
//   claim            block time >= leaf.unlockAt (0 here)
//
// So the floor is practical, not contractual. A circuit runs on this machine
// against the local clock, is proven, then is checked again by the chain
// against the block that includes it. Every `block time < X` must still hold
// at that later moment, and every `block time >= X` must already hold on this
// machine when the call is built.
//
// The heaviest circuit, checkInPasskey, has size k = 18 (470 MB prover key).
// The docs measure a k = 18 proof at 17 s and 5 GiB on an Apple M4 with the
// Docker proof server; blocks are 6 s apart. A check-in should therefore land
// about a minute after it is built, and the defaults leave five.

export interface Timers {
  /** Seconds from deployment to the first deadline. Covers deploy, deposit and the first check-in. */
  firstDeadlineS: number;
  /** `VaultConfig.maxPeriod`: the longest a check-in may push the deadline from now. */
  maxPeriodS: number;
  /** The last check-in sets the deadline this far ahead. The run then waits it out. */
  finalPeriodS: number;
  /** `VaultConfig.challengeWindow`: wait between `triggerTimeout` and `finalizeRelease`. */
  challengeWindowS: number;
  /** `VaultConfig.claimWindow`: only matters for backup heirs, which this run does not exercise. */
  claimWindowS: number;
}

/** Shortest time allowed between building a check-in and the deadline it sets. */
export const MIN_ACTION_BUDGET_S = 120;
/** Distance kept from `now + maxPeriod`, in case the chain's clock is behind this machine's. */
export const CLOCK_SLACK_S = 60;
const U64_MAX = (1n << 64n) - 1n;

export const DEFAULT_TIMERS: Timers = {
  firstDeadlineS: 20 * 60,
  maxPeriodS: 20 * 60,
  finalPeriodS: 5 * 60,
  challengeWindowS: 2 * 60,
  claimWindowS: 10 * 60,
};

export const TIMER_ENV = {
  firstDeadlineS: 'CODICIL_FIRST_DEADLINE_S',
  maxPeriodS: 'CODICIL_MAX_PERIOD_S',
  finalPeriodS: 'CODICIL_FINAL_PERIOD_S',
  challengeWindowS: 'CODICIL_CHALLENGE_S',
  claimWindowS: 'CODICIL_CLAIM_WINDOW_S',
} as const satisfies Record<keyof Timers, string>;

/** Everything wrong with a set of timers; empty when they can be used. */
export function validateTimers(t: Timers): string[] {
  const problems: string[] = [];
  for (const [k, v] of Object.entries(t) as [keyof Timers, number][]) {
    if (!Number.isSafeInteger(v) || v < 0) problems.push(`${TIMER_ENV[k]} must be a whole number of seconds, 0 or more`);
  }
  if (problems.length > 0) return problems;
  if (t.maxPeriodS <= 0) problems.push(`${TIMER_ENV.maxPeriodS} must be above 0 (the contract rejects 0: "invalid vault settings")`);
  if (t.challengeWindowS <= 0) problems.push(`${TIMER_ENV.challengeWindowS} must be above 0 (the contract rejects 0: "invalid vault settings")`);
  if (t.firstDeadlineS < MIN_ACTION_BUDGET_S) {
    problems.push(`${TIMER_ENV.firstDeadlineS} must be at least ${MIN_ACTION_BUDGET_S}: the deposit and first check-in must land before it`);
  }
  if (t.finalPeriodS < MIN_ACTION_BUDGET_S) {
    problems.push(`${TIMER_ENV.finalPeriodS} must be at least ${MIN_ACTION_BUDGET_S}: the check-in that sets it must land before it expires`);
  }
  if (t.maxPeriodS < MIN_ACTION_BUDGET_S + CLOCK_SLACK_S) {
    problems.push(`${TIMER_ENV.maxPeriodS} must be at least ${MIN_ACTION_BUDGET_S + CLOCK_SLACK_S}`);
  } else if (t.finalPeriodS > t.maxPeriodS - CLOCK_SLACK_S) {
    problems.push(`${TIMER_ENV.finalPeriodS} must be at most ${TIMER_ENV.maxPeriodS} - ${CLOCK_SLACK_S} (the contract caps a check-in at now + maxPeriod)`);
  }
  return problems;
}

/** Defaults overridden by `CODICIL_*_S` variables. Throws with every problem at once. */
export function timersFromEnv(env: Readonly<Record<string, string | undefined>>): Timers {
  const t: Timers = { ...DEFAULT_TIMERS };
  const problems: string[] = [];
  for (const key of Object.keys(TIMER_ENV) as (keyof Timers)[]) {
    const raw = env[TIMER_ENV[key]];
    if (raw === undefined || raw.trim() === '') continue;
    if (!/^\d+$/.test(raw.trim())) problems.push(`${TIMER_ENV[key]}="${raw}" is not a whole number of seconds`);
    else t[key] = Number(raw.trim());
  }
  problems.push(...(problems.length === 0 ? validateTimers(t) : []));
  if (problems.length > 0) throw new Error(`invalid timers:\n  - ${problems.join('\n  - ')}`);
  return t;
}

/** The first deadline for a vault deployed at `nowS` (unix seconds). */
export function firstDeadline(nowS: number, t: Timers): bigint {
  return BigInt(nowS + t.firstDeadlineS);
}

/**
 * Deadline for the first (passkey) check-in: as far ahead as the contract
 * allows, less the clock slack. It shows the deadline really moves, and
 * leaves the most room for the second check-in.
 */
export function extendedDeadline(nowS: number, t: Timers): bigint {
  return BigInt(nowS + t.maxPeriodS - CLOCK_SLACK_S);
}

/**
 * Deadline for the last check-in: `finalPeriodS` ahead, or longer if the
 * previous check-in showed that this machine needs more time than that to
 * prove and land one. Never beyond what the contract allows.
 *
 * @param lastCheckInS wall time the previous check-in took, build to finality
 */
export function finalDeadline(nowS: number, t: Timers, lastCheckInS?: number): bigint {
  const measured = lastCheckInS === undefined ? 0 : Math.ceil(lastCheckInS * 3) + CLOCK_SLACK_S;
  const period = Math.min(Math.max(t.finalPeriodS, measured), t.maxPeriodS - CLOCK_SLACK_S);
  return BigInt(nowS + period);
}

/** Why a check-in to `next` built at `nowS` would be rejected, or undefined if it is fine. */
export function checkInProblem(nowS: number, next: bigint, currentDeadline: bigint, armed: boolean, maxPeriodS: bigint): string | undefined {
  const now = BigInt(nowS);
  if (next > U64_MAX) return 'deadline does not fit in 64 bits';
  if (armed && now >= currentDeadline) return 'switch already expired';
  if (next <= now) return 'deadline must be in the future';
  if (next > now + maxPeriodS) return 'deadline too far';
  if (next - now < BigInt(MIN_ACTION_BUDGET_S)) return `deadline is under ${MIN_ACTION_BUDGET_S} s away; the transaction may not land in time`;
  return undefined;
}

export interface RunEstimate {
  /** Fixed waits the timers impose, in seconds. */
  waitS: number;
  /** Assumed time for the transactions themselves, in seconds. */
  transactionsS: number;
  totalS: number;
  lines: string[];
}

/**
 * How long a run takes once the wallet is synced and holds DUST. The waits are
 * exact; the per-transaction figure is an assumption until gate V14 has
 * measured it (see docs/PREPROD.md).
 */
export function estimateRun(t: Timers, opts: { escrow?: boolean; seals?: boolean; perTxS?: number; heavyProofS?: number } = {}): RunEstimate {
  const perTx = opts.perTxS ?? 60;
  const heavy = opts.heavyProofS ?? 90;
  // The seal register adds a deploy, the owner proof, a seal and two hand-overs; its two refused calls send nothing.
  const txs = 7 + (opts.escrow ? 3 : 0) + (opts.seals ? 5 : 0);
  const transactionsS = txs * perTx + 3 * heavy;
  // The final check-in is part of finalPeriodS; triggerTimeout is part of the challenge window.
  const waitS = t.finalPeriodS + t.challengeWindowS;
  const overlap = perTx + heavy + perTx;
  const totalS = waitS + transactionsS - overlap;
  return {
    waitS,
    transactionsS,
    totalS,
    lines: [
      `${txs} transactions at about ${perTx} s each to build, balance, submit and finalize`,
      `3 heavy proofs (two check-ins and the claim) at about ${heavy} s each`,
      `${t.finalPeriodS} s until the last check-in's deadline passes`,
      `${t.challengeWindowS} s challenge window before finalizeRelease`,
      ...(opts.seals ? ['the seal register is 5 of those transactions; its two refused calls fail on this machine and send nothing'] : []),
    ],
  };
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 90) return rest === 0 ? `${m} min` : `${m} min ${rest} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
