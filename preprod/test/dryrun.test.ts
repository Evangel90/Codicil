// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The whole run, built offline through Midnight.js: every transaction the
// real run sends is assembled here from the compiled contracts, the SDK's
// witnesses and the software signers. No network, no proof server, no wallet.
//
// Runs after `npm run compile` (--skip-zk) with stand-in verifier keys, which
// is what CI has. When the full-compile keys are present it also runs with
// the real ones.

import { describe, expect, it } from 'vitest';
import { checkArtifacts, ESCROW_RUN_CIRCUITS, VAULT_ESCROW_CIRCUITS, VAULT_RUN_CIRCUITS } from '../src/artifacts.js';
import { buildAll } from '../src/dryrun.js';
import { ESCROW_DIR, VAULT_DIR } from '../src/paths.js';

const STEPS = ['deploy', 'deposit', 'checkInPasskey', 'checkInEd25519', 'triggerTimeout', 'finalizeRelease', 'claim'];
const ESCROW = ['escrowDeploy', 'escrowDeposit', 'escrowWithdraw'];

const haveKeys = checkArtifacts('codicil_vault', VAULT_DIR, [...VAULT_RUN_CIRCUITS, ...VAULT_ESCROW_CIRCUITS]).ok
  && checkArtifacts('inheritable_escrow', ESCROW_DIR, ESCROW_RUN_CIRCUITS).ok;

describe('dry run through Midnight.js', () => {
  it('builds every vault transaction with stand-in keys', async () => {
    const report = await buildAll({ escrow: false, prove: false, artifacts: 'stub' });
    expect(report.artifacts).toBe('stub');
    expect(report.steps.map((s) => s.name)).toEqual(STEPS);
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    for (const s of report.steps) expect(s.txBytes).toBeGreaterThan(500);
  });

  it('builds the cross-contract withdrawal: two calls in one transaction, the vault first', async () => {
    const report = await buildAll({ escrow: true, prove: false, artifacts: 'stub' });
    expect(report.steps.map((s) => s.name)).toEqual([...STEPS, ...ESCROW]);
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    const withdraw = report.steps.find((s) => s.name === 'escrowWithdraw');
    expect(withdraw?.detail).toContain('2 calls in one transaction: isReleasedForContract then withdrawToBeneficiary');
  });

  it('reports what each step did to the vault', async () => {
    const report = await buildAll({ escrow: false, prove: false, artifacts: 'stub' });
    const detail = (name: string): string => report.steps.find((s) => s.name === name)?.detail ?? '';
    expect(detail('deploy')).toMatch(/16 circuits, phase armed/);
    expect(detail('deposit')).toBe('estateTotal 10.000000');
    expect(detail('checkInPasskey')).toMatch(/nonce 1$/);
    expect(detail('checkInEd25519')).toMatch(/nonce 2$/);
    expect(detail('triggerTimeout')).toMatch(/^phase pending until \d+$/);
    expect(detail('finalizeRelease')).toBe('phase released, snapshot 10.000000, 1 event(s) named "codicil:released:v1"');
    expect(detail('claim')).toBe('estatePaid 6.000000 (6000 bps); output to the wallet present');
  });

  it.skipIf(!haveKeys)('builds everything with the real keys from the full compile', async () => {
    const report = await buildAll({ escrow: true, prove: false });
    expect(report.artifacts).toBe('real');
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    // The deploy carries all twelve real verifier keys.
    expect(report.steps[0].txBytes).toBeGreaterThan(20_000);
  });

  it('refuses to prove without the proving keys', async () => {
    await expect(buildAll({ escrow: false, prove: true, artifacts: 'stub' })).rejects.toThrow(/npm run compile:full/);
  });
});
