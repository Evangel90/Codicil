// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The results file and the summary table. Everything in a results file is
// already public on the chain (addresses, hashes, fees) or is a timing
// measured on this machine, so it is safe to commit as evidence for gate V14.

import type { NetworkName } from './env.js';
import { ALL_STEPS, type ReleaseEvent, type RunState, type Step, type StepRecord } from './state.js';
import type { Timers } from './timers.js';

export const STAR_PER_NIGHT = 1_000_000n;
export const SPECK_PER_DUST = 1_000_000_000_000_000n;

/** STAR (the smallest NIGHT unit) as a NIGHT amount with six decimals. */
export function formatNight(star: bigint): string {
  const sign = star < 0n ? '-' : '';
  const v = star < 0n ? -star : star;
  return `${sign}${v / STAR_PER_NIGHT}.${(v % STAR_PER_NIGHT).toString().padStart(6, '0')}`;
}

/** SPECK (the smallest DUST unit) as a DUST amount, rounded down to `decimals` places. */
export function formatDust(speck: bigint, decimals = 6): string {
  const sign = speck < 0n ? '-' : '';
  const v = speck < 0n ? -speck : speck;
  const frac = (v % SPECK_PER_DUST).toString().padStart(15, '0').slice(0, decimals);
  return decimals === 0 ? `${sign}${v / SPECK_PER_DUST}` : `${sign}${v / SPECK_PER_DUST}.${frac}`;
}

/** Whole NIGHT (decimals allowed, up to six) to STAR. Throws on anything else. */
export function parseNight(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a NIGHT amount (examples: 10, 2.5)`);
  return BigInt(m[1]) * STAR_PER_NIGHT + BigInt((m[2] ?? '').padEnd(6, '0'));
}

const seconds = (ms: number | undefined): string => (ms === undefined ? '-' : (ms / 1000).toFixed(1));
const short = (h: string | undefined, n = 10): string => (h === undefined ? '-' : h.length <= n + 2 ? h : `${h.slice(0, n)}…`);

function feeDust(r: StepRecord): string {
  if (r.feePaid === undefined || !/^\d+$/.test(r.feePaid)) return '-';
  return formatDust(BigInt(r.feePaid));
}

export interface Results {
  gate: 'V14';
  network: NetworkName;
  generatedAt: string;
  complete: boolean;
  /** Steps still to do, in order. */
  remaining: Step[];
  vaultAddress?: string;
  escrowAddress?: string;
  walletAddress?: string;
  timers: Timers;
  versions: Record<string, string>;
  steps: StepRecord[];
  releaseEvent?: ReleaseEvent;
  totals: { transactions: number; feePaidSpeck: string; proveMs: number; wallMs: number };
}

export function buildResults(
  state: RunState,
  extra: { remaining: Step[]; walletAddress?: string; versions?: Record<string, string>; now?: Date },
): Results {
  const steps = ALL_STEPS.map((s) => state.steps[s]).filter((r): r is StepRecord => r !== undefined);
  let fee = 0n;
  let prove = 0;
  let wall = 0;
  let txs = 0;
  for (const r of steps) {
    if (r.txHash !== undefined || r.txId !== undefined) txs++;
    if (r.feePaid !== undefined && /^\d+$/.test(r.feePaid)) fee += BigInt(r.feePaid);
    prove += r.proveMs ?? 0;
    wall += r.totalMs;
  }
  return {
    gate: 'V14',
    network: state.network,
    generatedAt: (extra.now ?? new Date()).toISOString(),
    complete: extra.remaining.length === 0,
    remaining: extra.remaining,
    vaultAddress: state.vault?.address,
    escrowAddress: state.escrow?.address,
    walletAddress: extra.walletAddress,
    timers: state.timers,
    versions: extra.versions ?? {},
    steps,
    releaseEvent: state.releaseEvent,
    totals: { transactions: txs, feePaidSpeck: fee.toString(), proveMs: prove, wallMs: wall },
  };
}

function table(header: string[], rows: string[][], markdown: boolean): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    markdown
      ? `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`
      : cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const rule = markdown ? `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |` : widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(header), rule, ...rows.map(line)].join('\n');
}

const HEADER = ['step', 'block', 'tx hash', 'status', 'prove s', 'balance s', 'confirm s', 'total s', 'fee DUST'];

function rowsFor(steps: StepRecord[], full: boolean): string[][] {
  return steps.map((r) => [
    r.step,
    r.blockHeight?.toString() ?? '-',
    full ? (r.txHash ?? '-') : short(r.txHash),
    r.status ?? (r.txHash ? '-' : 'no tx'),
    seconds(r.proveMs),
    seconds(r.balanceMs),
    seconds(r.confirmMs),
    seconds(r.totalMs),
    feeDust(r),
  ]);
}

/** The table printed at the end of `run`: one line per finished step. */
export function summaryTable(steps: StepRecord[]): string {
  if (steps.length === 0) return '(no steps finished yet)';
  return table(HEADER, rowsFor(steps, false), false);
}

/** A page a human can read, and paste into docs/VALIDATION.md. */
export function resultsMarkdown(r: Results): string {
  const out: string[] = [];
  out.push(`# Gate V14 on ${r.network}`, '');
  out.push(r.complete ? 'Status: **complete**.' : `Status: **incomplete**. Still to do: ${r.remaining.join(', ')}.`, '');
  out.push(`- Generated: ${r.generatedAt}`);
  if (r.vaultAddress) out.push(`- Vault contract: \`${r.vaultAddress}\``);
  if (r.escrowAddress) out.push(`- Escrow contract: \`${r.escrowAddress}\``);
  if (r.walletAddress) out.push(`- Test wallet: \`${r.walletAddress}\``);
  out.push(
    `- Timers: first deadline ${r.timers.firstDeadlineS} s, max period ${r.timers.maxPeriodS} s, `
    + `final period ${r.timers.finalPeriodS} s, challenge window ${r.timers.challengeWindowS} s`,
  );
  for (const [k, v] of Object.entries(r.versions)) out.push(`- ${k}: ${v}`);
  out.push('');
  if (r.steps.length > 0) {
    out.push(table(HEADER, rowsFor(r.steps, true), true), '');
    out.push(
      `Totals: ${r.totals.transactions} transactions, ${formatDust(BigInt(r.totals.feePaidSpeck))} DUST in fees, `
      + `${seconds(r.totals.proveMs)} s proving contract circuits, ${seconds(r.totals.wallMs)} s in steps (waits excluded).`,
      '',
    );
  }
  if (r.releaseEvent) {
    const e = r.releaseEvent;
    out.push(
      `Release event read back from the indexer (gate V13): \`${e.name}\`, type ${e.eventType}, `
      + `event id ${e.id}, payload version ${e.payloadVersion}, protocol version ${e.protocolVersion}.`,
      '',
    );
  }
  const notes = r.steps.flatMap((s) => (s.notes ?? []).map((n) => `- ${s.step}: ${n}`));
  if (notes.length > 0) out.push('## Notes', '', ...notes, '');
  return out.join('\n');
}
