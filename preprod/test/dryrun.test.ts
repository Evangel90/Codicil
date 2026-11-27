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
import { checkArtifacts, ESCROW_RUN_CIRCUITS, SEALS_DRYRUN_CIRCUITS, VAULT_ESCROW_CIRCUITS, VAULT_RUN_CIRCUITS, vaultCircuitsFor } from '../src/artifacts.js';
import { buildAll } from '../src/dryrun.js';
import { VAULT_DEFER_ORDER } from '../src/run.js';
import { WRITE_BUDGET } from '../src/staged-deploy.js';
import { ESCROW_DIR, SEALS_DIR, VAULT_DIR } from '../src/paths.js';

const STEPS = ['deploy', 'deposit', 'checkInPasskey', 'checkInEd25519', 'triggerTimeout', 'finalizeRelease', 'claim'];
const ESCROW = ['escrowDeploy', 'escrowDeposit', 'escrowWithdraw'];
// `sealsProveOwnerWallet` is the dry run's own: a network run proves ownership once, with the passkey.
const SEALS = ['sealsDeploy', 'sealsProveOwner', 'sealsSeal', 'sealsRefused', 'sealsProveOwnerWallet', 'sealsHandOver1', 'sealsHandOver2', 'sealsOpen'];

const haveKeys = checkArtifacts('codicil_vault', VAULT_DIR, [...VAULT_RUN_CIRCUITS, ...VAULT_ESCROW_CIRCUITS]).ok
  && checkArtifacts('inheritable_escrow', ESCROW_DIR, ESCROW_RUN_CIRCUITS).ok;
const haveSealsKeys = checkArtifacts('codicil_vault', VAULT_DIR, vaultCircuitsFor({ seals: true })).ok
  && checkArtifacts('codicil_seals', SEALS_DIR, SEALS_DRYRUN_CIRCUITS).ok;

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

  it('builds the seal register: refused while the vault is armed, opened from the ledger after the release', async () => {
    const report = await buildAll({ escrow: false, seals: true, prove: false, artifacts: 'stub' });
    expect(report.steps.map((s) => s.name)).toEqual([...STEPS, ...SEALS]);
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    const detail = (name: string): string => report.steps.find((s) => s.name === name)?.detail ?? '';
    // The register proves whose it is, with each of the owner's keys, and a stranger's attempt does not match.
    expect(detail('sealsProveOwner')).toMatch(/^the keeper proved it can open vault A's owner commitment [0-9a-f]{12}… with the passkey and its salt; unproven before: yes; the owner's public key with another salt does not match: yes$/);
    expect(detail('sealsProveOwnerWallet')).toMatch(/^the keeper proved it can open vault B's owner commitment [0-9a-f]{12}… with the wallet key and its salt \(dry run only\)$/);
    // Sealing and handing over each ask the vault, in the same transaction.
    expect(detail('sealsSeal')).toMatch(/^2 calls in one transaction: isReleasedForContract then seal; fingerprint [0-9a-f]{12}…, 2 of 3 pieces needed, 3 commitments, 0 pieces on the ledger$/);
    expect(detail('sealsRefused')).toBe('a genuine piece was refused while vault A is armed: "vault not released"; nothing to prove or send');
    expect(detail('sealsHandOver1')).toBe('2 calls in one transaction: isReleasedForContract then handOver; piece 3 published, on the ledger: 3');
    expect(detail('sealsHandOver2')).toBe('2 calls in one transaction: isReleasedForContract then handOver; piece 1 published, on the ledger: 1, 3');
    expect(detail('sealsOpen')).toBe(
      'opened the sealed text from pieces 1 and 3 on the ledger: it is the text that was sealed; '
      + 'a made-up piece was refused: "not a genuine piece"; sealing another text after the release was refused: "vault released"',
    );
    // The refused calls and the read send nothing; the others are transactions.
    const sent = report.steps.filter((s) => SEALS.includes(s.name) && s.txBytes !== undefined).map((s) => s.name);
    expect(sent).toEqual(['sealsDeploy', 'sealsProveOwner', 'sealsSeal', 'sealsProveOwnerWallet', 'sealsHandOver1', 'sealsHandOver2']);
  });

  it('builds the escrow and the seal register against the same released vault', async () => {
    const report = await buildAll({ escrow: true, seals: true, prove: false, artifacts: 'stub' });
    expect(report.steps.map((s) => s.name)).toEqual([...STEPS, ...ESCROW, ...SEALS]);
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
  });

  it.skipIf(!haveSealsKeys)('builds the seal register with the real keys from the full compile', async () => {
    const report = await buildAll({ escrow: false, seals: true, prove: false });
    expect(report.artifacts).toBe('real');
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    // The register is small: its deploy carries six verifier keys and fits a block as it is.
    expect(report.steps.find((s) => s.name === 'sealsDeploy')?.txBytes).toBeGreaterThan(8_000);
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
    // The deploy carries all sixteen real verifier keys.
    expect(report.steps[0].txBytes).toBeGreaterThan(20_000);
    // With them it is too big for one block: the node refused it on Preview
    // and Preprod (docs/VALIDATION.md V14). Seven circuits go in afterwards.
    expect(report.deployPlan?.writeShareAllAtOnce).toBeGreaterThan(0.9);
    expect(report.deployPlan?.deferred).toEqual(VAULT_DEFER_ORDER.slice(0, 7));
  });

  it('plans a deployment that fits a block, deferring the least needed circuits first', async () => {
    const report = await buildAll({ escrow: false, prove: false, artifacts: 'stub' });
    const plan = report.deployPlan!;
    expect(plan.writeShare).toBeLessThanOrEqual(WRITE_BUDGET);
    expect(plan.writeShareAllAtOnce).toBeGreaterThan(plan.writeShare);
    expect(plan.deferred.length).toBeGreaterThan(0);
    expect(plan.deferred).toEqual(VAULT_DEFER_ORDER.slice(0, plan.deferred.length));
    // What the run needs first is never deferred.
    for (const needed of ['deposit', 'checkInPasskey', 'checkInEd25519', 'triggerTimeout', 'finalizeRelease', 'claim', 'isReleasedForContract']) {
      expect(plan.deferred).not.toContain(needed);
    }
  });

  it('refuses to prove without the proving keys', async () => {
    await expect(buildAll({ escrow: false, prove: true, artifacts: 'stub' })).rejects.toThrow(/npm run compile:full/);
  });
});
