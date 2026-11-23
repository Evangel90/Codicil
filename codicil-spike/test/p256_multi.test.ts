// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Gate V5: several secp256r1 checks in one circuit. Simulator correctness is
// checked here; proving cost is measured by `npm run compile:full` and
// recorded in docs/VALIDATION.md.

import { describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { Contract, ledger } from '../contracts/managed/p256_multi/contract/index.js';
import { Simulator } from './harness.js';
import { newP256Key, signP256 } from './crypto.js';

const CONTRACT_DIR = new URL('../contracts/managed/p256_multi', import.meta.url).pathname;
const T = 1_800_000_000;

function signed() {
  const key = newP256Key();
  const digest = randomBytes(32);
  return [digest, signP256(key.sk, digest), key.pk] as const;
}

describe('P-256 checks per circuit [V5]', () => {
  it('verifies 1, 2 and 3 signatures in a single circuit', async () => {
    const sim = (await Simulator.deploy<object>(new Contract({}), {})).withProofChecks(CONTRACT_DIR);
    await sim.call('verify1', { time: T, as: {} }, ...signed());
    await sim.call('verify2', { time: T, as: {} }, ...signed(), ...signed());
    await sim.call('verify3', { time: T, as: {} }, ...signed(), ...signed(), ...signed());
    expect(ledger(sim.ledgerState).verified).toBe(6n);
  });

  it('rejects when any one of the signatures is invalid', async () => {
    const sim = (await Simulator.deploy<object>(new Contract({}), {})).withProofChecks(CONTRACT_DIR);
    const [d, s, k] = signed();
    const forged = [d, { r: s.r, s: (s.s + 1n) }, k] as const;
    await expect(sim.call('verify3', { time: T, as: {} }, ...signed(), ...forged, ...signed()))
      .rejects.toThrow('bad signature 2');
    expect(ledger(sim.ledgerState).verified).toBe(0n);
  });
});
