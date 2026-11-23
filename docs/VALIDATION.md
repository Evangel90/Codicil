# Phase 0 — Validation log

Every gate from the build plan, with the command run, the result and any fallback taken.
Results are recorded as they happen and never back-filled. **PENDING** means not run yet.

Spike: [`codicil-spike/`](../codicil-spike) — `contracts/codicil_spike.compact`,
`contracts/p256_multi.compact`, and the simulator tests in `test/`.

| # | Gate | Status | Date |
|---|---|---|---|
| V1 | Toolchain 0.36.1 / runtime 0.21.x | **BLOCKED**: compiler not installed yet | 2026-11-23 |
| V2 | Spike compiles (`--skip-zk`) | PENDING (needs V1) | |
| V3 | Spike tests pass | PARTIAL: 8/8 compiler-independent tests pass; 18 contract tests need V2 | 2026-11-23 |
| V4 | Proving cost per circuit | PENDING (needs V1) | |
| V5 | 2–3 P-256 checks in one circuit | PENDING: contract + tests written (`p256_multi`) | |
| V6 | WebAuthn binding | PENDING (needs a browser passkey fixture) | |
| V7 | Cardano CIP-30 `signData` | PENDING (needs a Lace/Eternl capture) | |
| V8 | Merkle membership | PARTIAL: off-chain tree folds correctly; in-circuit claim tests written | 2026-11-23 |
| V9 | Division | DESIGN DECIDED: no `/` in Compact; witness quotient + check (see below) | 2026-11-23 |
| V10 | Unshielded token flow | PENDING: simulator tests written; Preprod later | |
| V11 | Shielded payout | PENDING | |
| V12 | Cross-contract call | PENDING (Phase 5) | |
| V13 | Events visible | PENDING: simulator test written; indexer check later | |
| V14 | End-to-end on Preprod | PENDING | |
| V15 | Curve25519 Montgomery ⇄ Edwards | **PASS** | 2026-11-23 |

---

## V1 — Toolchain

- **Date:** 2026-11-23
- **Found:** `compact` was not on the machine. Node v26.3.0, npm 11.16.0.
- **Latest releases (GitHub `midnightntwrk/compact`):** `compactc-v0.36.1` (2026-11-11),
  CLI `compact-v0.5.3`. **npm:** `@midnight-ntwrk/compact-runtime@0.21.0`,
  `compact-js@3.0.2`, `midnight-js-contracts@5.0.1`, `zkir-v3@3.2.1`.
- **Result:** BLOCKED. The coding agent's sandbox is not permitted to install or run the
  compiler. The human installs it with:
  ```sh
  curl --proto '=https' --tlsv1.2 -LsSf \
    https://github.com/midnightntwrk/compact/releases/download/compact-v0.5.3/compact-installer.sh | sh
  compact update 0.36.1
  compact compile --version   # expect 0.36.1
  ```
- **Spike pins:** `@midnight-ntwrk/compact-runtime` **0.21.0** (exact).

## V3 — Spike tests (partial)

- **Command:** `npx vitest run test/merkle.test.ts test/curve25519.test.ts`
- **Result:** 8/8 pass (Merkle fold × 6 trees + negative case; Curve25519 × 2).
- The remaining suites (`codicil.test.ts`: 18 tests, `p256_multi.test.ts`: 2 tests) import
  compiler output and run once V2 passes.

## V8 — Merkle membership (off-chain half)

- Stdlib source (`compiler/standard-library.compact`) shows
  `merkleTreePathRootNoLeafHash` folds `degradeToTransient(leaf)` up the path with
  `transientHash<Vector<2, Field>>([left, right])`, where `goes_left` puts the running digest on
  the left.
- `test/crypto.ts › WillTree` builds a depth-10 tree with exactly that hash; empty subtrees use
  precomputed zero hashes, so building a 3-heir tree costs ~13 hashes instead of 1,023.
- `test/merkle.test.ts` re-folds every path with the stdlib algorithm. **PASS** for 1, 2, 3, 8
  and 33 leaves. Foreign leaves and tampered leaves do not reach the root.

## V9 — Division

- The Compact reference (*Binary arithmetic expressions*) lists only `+`, `-` and `*`.
  **No native division.**
- Approach: the `payoutDivision` witness returns `(q, r)`; `claim` asserts
  `q * 10000 + r == snapshot * bps` and `r < 10000`. Test `rejects a witness that lies about
  the payout quotient` checks that a dishonest witness is caught.

## V15 — Curve25519 conversion

- **Command:** `npx vitest run test/curve25519.test.ts`
- **Result:** **PASS** (2/2). Edwards → Montgomery `u = (1+y)/(1-y)` matches noble
  `toMontgomery` for 20 random keys. Montgomery → Edwards recovers the identical point
  (given the x sign bit) and the runtime accepts it (`isValidCurve25519Point`). X25519 shared
  secrets agree either way.
- **Note:** X25519 keys carry no x sign bit, so an heir importing a bare X25519 key must also
  supply one bit (or we try both and match the commitment).
