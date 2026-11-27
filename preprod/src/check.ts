// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Preflight: everything a run needs, checked without sending anything, with
// one line per item and a numbered list of what is missing at the end.
//
// The wallet part (sync, balances) lives in cli.ts because it needs the wallet
// SDK; this module needs only `fetch` and the file system, so it also works
// before `npm run compile` and is unit-tested with a fake `fetch`.

import {
  ENV_KEYS,
  parseNetworkName,
  redact,
  resolveNetwork,
  seedProblem,
  type Env,
  type NetworkConfig,
} from './env.js';
import {
  checkArtifacts,
  circuitK,
  ESCROW_RUN_CIRCUITS,
  estimateProofMemoryGiB,
  estimateProofSeconds,
  SEALS_RUN_CIRCUITS,
  vaultCircuitsFor,
  type ArtifactReport,
} from './artifacts.js';
import { probeIndexer, probeNode, probeProofServer, type Fetch, type IndexerBlock, type NodeInfo, type ProofServerInfo } from './probes.js';

export type Level = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckLine {
  level: Level;
  text: string;
}

export interface Preflight {
  lines: CheckLine[];
  /** What the human must do, in order. Empty when nothing found here blocks a run. */
  missing: string[];
  network?: NetworkConfig;
  seedOk: boolean;
  proofServer?: ProofServerInfo;
  indexer?: IndexerBlock;
  node?: NodeInfo;
  artifacts: ArtifactReport[];
  /** Largest circuit size this run proves, when the artifacts are there. */
  maxK?: number;
}

export interface PreflightInput {
  env: Env;
  vaultDir: string;
  escrowDir: string;
  escrow: boolean;
  /** The seal register's compiled directory; needed only with `seals`. */
  sealsDir?: string;
  seals?: boolean;
  fetch?: Fetch;
}

/** Per-circuit sizes for a compiled contract, largest first. */
export function circuitSizes(dir: string, circuits: readonly string[]): { circuit: string; k: number }[] {
  return circuits.map((circuit) => ({ circuit, k: circuitK(dir, circuit) })).sort((a, b) => b.k - a.k);
}

export async function preflight(input: PreflightInput): Promise<Preflight> {
  const f = input.fetch ?? fetch;
  const out: Preflight = { lines: [], missing: [], seedOk: false, artifacts: [] };
  const line = (level: Level, text: string): void => { out.lines.push({ level, text }); };

  // 1. Environment.
  const name = parseNetworkName(input.env[ENV_KEYS.network]);
  const resolved = resolveNetwork(input.env);
  if (resolved.ok) {
    out.network = resolved.value;
    line('ok', `network ${resolved.value.name} (${ENV_KEYS.network}${input.env[ENV_KEYS.network] ? '' : ' not set, so the default'})`);
    for (const w of resolved.warnings) line('warn', w);
    if (resolved.value.name === 'preprod') line('ok', `${ENV_KEYS.blockfrost} is set`);
  } else {
    for (const p of resolved.problems) {
      line('fail', p);
      out.missing.push(p);
    }
  }
  const secrets = resolved.ok ? resolved.value.secrets : [];
  const seedIssue = seedProblem(input.env[ENV_KEYS.seed]);
  if (seedIssue) {
    line('fail', seedIssue);
    out.missing.push(seedIssue);
  } else {
    out.seedOk = true;
    line('ok', `${ENV_KEYS.seed} is set`);
  }

  // 2. Proof server.
  const proofUrl = (resolved.ok ? resolved.value.proofServer : input.env[ENV_KEYS.proofServer]?.trim()) || 'http://localhost:6300';
  const proof = await probeProofServer(proofUrl, f);
  line(proof.ok ? 'ok' : 'fail', proof.detail);
  for (const w of proof.warnings) line('warn', w);
  if (proof.ok) out.proofServer = proof.value;
  else out.missing.push(proof.detail);

  // 3. Indexer and node.
  if (resolved.ok) {
    const [indexer, node] = await Promise.all([probeIndexer(resolved.value, f), probeNode(resolved.value, f)]);
    line(indexer.ok ? 'ok' : 'fail', indexer.detail);
    for (const w of indexer.warnings) line('warn', w);
    if (indexer.ok) out.indexer = indexer.value;
    else out.missing.push(indexer.detail);
    line(node.ok ? 'ok' : 'fail', node.detail);
    for (const w of node.warnings) line('warn', w);
    if (node.ok) out.node = node.value;
    else out.missing.push(node.detail);
    if (indexer.value && node.value?.height !== undefined) {
      const behind = node.value.height - indexer.value.height;
      line(behind > 50 ? 'warn' : 'ok', `indexer is ${behind} block(s) behind the node's best block (it serves finalized blocks only)`);
    }
  } else {
    line('skip', `indexer and node not checked: no usable endpoints for ${name ?? 'the selected network'}`);
  }

  // 4. Compiled artifacts.
  const seals = input.seals === true && input.sealsDir !== undefined;
  const vaultCircuits = vaultCircuitsFor({ escrow: input.escrow, seals });
  const reports = [checkArtifacts('codicil_vault', input.vaultDir, vaultCircuits)];
  if (input.escrow) reports.push(checkArtifacts('inheritable_escrow', input.escrowDir, ESCROW_RUN_CIRCUITS));
  if (seals) reports.push(checkArtifacts('codicil_seals', input.sealsDir!, SEALS_RUN_CIRCUITS));
  out.artifacts = reports;
  for (const r of reports) {
    if (r.ok) {
      const proven = r.contract === 'codicil_vault' ? vaultCircuits : r.contract === 'codicil_seals' ? SEALS_RUN_CIRCUITS : ESCROW_RUN_CIRCUITS;
      const sizes = circuitSizes(r.dir, proven);
      out.maxK = Math.max(out.maxK ?? 0, sizes[0].k);
      line('ok', `${r.contract}: ${r.circuits.length} verifier keys, ${proven.length} prover keys (compiler ${r.compilerVersion}, runtime ${r.runtimeVersion})`);
      line(
        'ok',
        `  largest circuits: ${sizes.slice(0, 3).map((s) => `${s.circuit} k=${s.k} (~${estimateProofSeconds(s.k)} s, ~${estimateProofMemoryGiB(s.k)} GiB)`).join(', ')}`,
      );
    } else {
      for (const p of r.problems) {
        line('fail', p);
        out.missing.push(p);
      }
      if (r.missing.length > 0) line('fail', `  ${r.contract}: ${r.missing.length} file(s) missing, e.g. ${r.missing.slice(0, 3).join(', ')}`);
    }
  }
  if (out.maxK !== undefined) {
    const gib = estimateProofMemoryGiB(out.maxK);
    line('warn', `give Docker at least ${Math.ceil(gib + 3)} GB of memory: the largest proof (k=${out.maxK}) peaks near ${gib} GiB in the proof server`);
  }

  out.lines = out.lines.map((l) => ({ level: l.level, text: redact(l.text, secrets) }));
  out.missing = out.missing.map((m) => redact(m, secrets));
  return out;
}

const LABEL: Record<Level, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };

export function formatLine(l: CheckLine): string {
  return `  ${LABEL[l.level]}  ${l.text}`;
}

export function formatMissing(missing: readonly string[]): string {
  if (missing.length === 0) return 'Nothing is missing.';
  return ['Missing:', ...missing.map((m, i) => `  ${i + 1}. ${m}`)].join('\n');
}
