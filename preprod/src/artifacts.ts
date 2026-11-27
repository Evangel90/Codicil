// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Are the full-compile artifacts there? `npm run compile` (--skip-zk) writes
// the JavaScript and the .zkir text only. A real transaction also needs, per
// circuit, what `npm run compile:full` adds:
//
//   keys/<circuit>.verifier   every circuit of the contract (they go into the deploy)
//   keys/<circuit>.prover     every circuit this run proves
//   zkir/<circuit>.bzkir      every circuit this run proves
//
// and compiler/contract-manifest.json listing them: Midnight.js verifies each
// file against that manifest before use. A `--skip-zk` recompile after a full
// one deletes the keys again (seen with compact 0.36.1), so the check below is
// worth running right before a run, not only once.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Zkir } from '@midnightntwrk/zkir-v3';

/** compact-runtime version this repo pins; Midnight.js 5 accepts artifacts built for it. */
export const EXPECTED_RUNTIME_VERSION = '0.21.0';

/** Vault circuits the run proves, in order. */
export const VAULT_RUN_CIRCUITS = ['deposit', 'checkInPasskey', 'checkInEd25519', 'triggerTimeout', 'finalizeRelease', 'claim'] as const;
/** The vault circuit other contracts call into; proven inside the escrow's withdrawal and the register's hand-over. */
export const VAULT_ESCROW_CIRCUITS = ['isReleasedForContract'] as const;
export const ESCROW_RUN_CIRCUITS = ['deposit', 'withdrawToBeneficiary'] as const;
/** Seal register circuits the run proves; each carries a second proof, of the vault's hook. */
export const SEALS_RUN_CIRCUITS = ['seal', 'handOver'] as const;

/** Vault circuits a run proves, given which contracts beside the vault it exercises. */
export function vaultCircuitsFor(plan: { escrow?: boolean; seals?: boolean }): string[] {
  return [...VAULT_RUN_CIRCUITS, ...(plan.escrow || plan.seals ? VAULT_ESCROW_CIRCUITS : [])];
}

export interface ArtifactReport {
  contract: string;
  dir: string;
  ok: boolean;
  /** Paths relative to `dir` that should exist and do not. */
  missing: string[];
  problems: string[];
  compilerVersion?: string;
  runtimeVersion?: string;
  /** Circuits of the contract that need a proof, from contract-info.json. */
  circuits: string[];
  /** Prover key size in bytes, per circuit this run proves. */
  proverKeyBytes: Record<string, number>;
}

interface ManifestFile { type: 'file'; size: number; hash: string }
type ManifestDir = { type: 'directory' } & Record<string, ManifestFile | string>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Check one compiled contract directory (`contracts/managed/<name>`).
 *
 * @param proven circuits whose prover key and binary ZKIR this run needs
 */
export function checkArtifacts(contract: string, dir: string, proven: readonly string[]): ArtifactReport {
  const report: ArtifactReport = { contract, dir, ok: false, missing: [], problems: [], circuits: [], proverKeyBytes: {} };
  const infoPath = join(dir, 'compiler', 'contract-info.json');
  if (!existsSync(infoPath)) {
    report.missing.push('compiler/contract-info.json');
    report.problems.push(`${contract} is not compiled: run \`npm run compile:full\``);
    return report;
  }
  const info = readJson(infoPath) as { 'compiler-version'?: string; 'runtime-version'?: string; circuits?: { name: string; proof?: boolean }[] };
  report.compilerVersion = info['compiler-version'];
  report.runtimeVersion = info['runtime-version'];
  report.circuits = (info.circuits ?? []).filter((c) => c.proof === true).map((c) => c.name);
  if (report.runtimeVersion !== EXPECTED_RUNTIME_VERSION) {
    report.problems.push(`${contract} was compiled for compact-runtime ${report.runtimeVersion}, expected ${EXPECTED_RUNTIME_VERSION}`);
  }
  for (const c of proven) {
    if (!report.circuits.includes(c)) report.problems.push(`${contract} has no circuit "${c}"`);
  }

  const wanted = new Set<string>();
  for (const c of report.circuits) wanted.add(`keys/${c}.verifier`);
  for (const c of proven) {
    wanted.add(`keys/${c}.prover`);
    wanted.add(`zkir/${c}.bzkir`);
  }

  const manifestPath = join(dir, 'compiler', 'contract-manifest.json');
  let manifest: Record<string, ManifestDir> | undefined;
  if (existsSync(manifestPath)) manifest = readJson(manifestPath) as Record<string, ManifestDir>;
  else report.missing.push('compiler/contract-manifest.json');

  let unlisted = 0;
  for (const rel of [...wanted].sort()) {
    const path = join(dir, rel);
    if (!existsSync(path)) {
      report.missing.push(rel);
      continue;
    }
    const size = statSync(path).size;
    if (rel.endsWith('.prover')) report.proverKeyBytes[rel.slice('keys/'.length, -'.prover'.length)] = size;
    if (!manifest) continue;
    const [folder, file] = rel.split('/');
    const entry = manifest[folder]?.[file];
    if (entry === undefined || typeof entry === 'string') unlisted++;
    else if (entry.size !== size) report.problems.push(`${rel} is ${size} bytes but the manifest says ${entry.size}: recompile`);
  }
  if (report.missing.some((m) => m.startsWith('keys/') || m.endsWith('.bzkir'))) {
    report.problems.push(`${contract} has no proving keys: run \`npm run compile:full\` (slow, about 1.5 GB)`);
  } else if (unlisted > 0) {
    report.problems.push(
      `${contract}: ${unlisted} key file(s) are on disk but not in contract-manifest.json. `
      + 'Midnight.js would refuse them; run `npm run compile:full` again',
    );
  }
  report.ok = report.missing.length === 0 && report.problems.length === 0;
  return report;
}

/**
 * Circuit size `k` (the circuit has up to 2^k rows), read from the compiled
 * binary ZKIR. Proof time and proof-server memory roughly double with each
 * step of `k`.
 */
export function circuitK(dir: string, circuit: string): number {
  return Zkir.deserialize(readFileSync(join(dir, 'zkir', `${circuit}.bzkir`))).getK();
}

// docs.midnight.network/guides/local-proving measured proof server 9.0.2 on an
// Apple M4 (Docker VM with 10 CPUs, 7.6 GiB): k 13 took 0.65 s and 194 MiB,
// k 14 1.2 s and 370 MiB, k 16 4.0 s and 1.3 GiB, k 18 17 s and 5 GiB.

/** Peak proof-server memory to plan for, in GiB, for one proof of size `k`. */
export function estimateProofMemoryGiB(k: number): number {
  return Math.round(5 * 2 ** (k - 18) * 100) / 100;
}

/** Rough proving time in seconds for one proof of size `k`, after the first (which is up to twice as slow). */
export function estimateProofSeconds(k: number): number {
  return Math.round(17 * 2 ** (k - 18) * 10) / 10;
}
