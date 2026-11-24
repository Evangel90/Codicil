// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Property tests over random wills, estates and claim orders (brief §7.2):
//   - total paid never exceeds the snapshot;
//   - each share is paid at most once, and exactly floor(snapshot × bps / 10000);
//   - nothing can be claimed before release;
//   - the owner can always veto during the challenge window.
// Every call is also checked against the compiled ZK circuit.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Phase } from '@codicil/contracts/vault';
import { payoutFor } from '@codicil/sdk';
import { unshieldedPaidTo } from './support/harness.js';
import {
  asClaimant,
  checkIn,
  DAY,
  deployVault,
  FIRST_DEADLINE,
  L,
  MAX_PERIOD,
  newPerson,
  newRecipient,
  nobody,
  release,
  RELEASED_AT,
  type Via,
} from './support/world.js';

const RUNS = Number(process.env.FC_RUNS ?? 12);

/** 1–8 shares in basis points, summing to at most 10000. */
const shares = fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 8 })
  .map((xs) => {
    const total = xs.reduce((a, b) => a + b, 0);
    return total <= 10_000 ? xs : xs.map((x) => Math.max(1, Math.floor((x * 10_000) / total) - 1));
  })
  .filter((xs) => xs.reduce((a, b) => a + b, 0) <= 10_000);

describe('properties of random wills', () => {
  it('pays each share exactly once and never more than the estate', async () => {
    await fc.assert(
      fc.asyncProperty(
        shares,
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 16 }),
        async (bps, estate, order) => {
          const people = bps.map(() => newPerson());
          const w = await deployVault({
            entries: () => bps.map((b, i) => ({
              heir: { pk: people[i].key.pk, salt: people[i].keySalt },
              shareBps: BigInt(b),
              unlockAt: BigInt(RELEASED_AT + (i % 3) * DAY),   // some tranches
            })),
          });
          await w.sim.call('deposit', { time: FIRST_DEADLINE - DAY, as: nobody }, estate);

          // Nothing can be claimed before release.
          await expect(w.sim.call('claim', { time: FIRST_DEADLINE, as: asClaimant(w.will, 0, people[0]) },
            newRecipient().address)).rejects.toThrow('vault not released');

          await release(w);
          const paidTo = new Map<number, bigint>();
          const time = RELEASED_AT + 3 * DAY;
          for (const pick of order) {
            const i = pick % bps.length;
            const to = newRecipient();
            const attempt = w.sim.call('claim', { time, as: asClaimant(w.will, i, people[i]) }, to.address);
            if (paidTo.has(i)) {
              await expect(attempt).rejects.toThrow('already claimed');
            } else {
              const r = await attempt;
              paidTo.set(i, unshieldedPaidTo(r.effects, to.hex));
            }
          }
          let total = 0n;
          for (const [i, paid] of paidTo) {
            expect(paid).toBe(payoutFor(estate, BigInt(bps[i])));
            total += paid;
          }
          expect(total).toBeLessThanOrEqual(estate);
          expect(L(w.sim).estatePaid).toBe(total);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('the owner can always veto during the challenge window', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Any challenge window, including ones longer than maxPeriod.
        fc.integer({ min: 1, max: 120 * DAY }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        fc.integer({ min: 1, max: MAX_PERIOD }),
        fc.constantFrom<Via>('passkey', 'wallet'),
        async (challenge, fraction, extension, via) => {
          const w = await deployVault({ config: { challengeWindow: BigInt(challenge) } });
          await w.sim.call('triggerTimeout', { time: FIRST_DEADLINE, as: nobody });
          const t = FIRST_DEADLINE + Math.floor(fraction * challenge);
          await checkIn(w, via, t + extension, t);
          expect(L(w.sim).phase).toBe(Phase.armed);
          await expect(w.sim.call('finalizeRelease', { time: FIRST_DEADLINE + challenge, as: nobody }))
            .rejects.toThrow('not pending');
        },
      ),
      { numRuns: RUNS },
    );
  });
});
