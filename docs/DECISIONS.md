# Design decisions

Short records of choices and their trade-offs, newest last.

## D1 — Track deposits in the ledger instead of reading `unshieldedBalance` (2026-11-23)

`unshieldedBalance(color)` fixes a transaction to the exact balance seen when it was built.
If any other transaction changes the balance first, `finalizeRelease` fails. Instead,
`deposit` adds to a public `estateTotal`, and `finalizeRelease` snapshots it.
**Trade-off:** tokens sent to the vault outside `deposit` are not counted. Deposits are
public in either design.

## D2 — Payout division via witness quotient (2026-11-23)

Compact has no `/` (see VALIDATION V9). The witness supplies `(q, r)`, and the circuit checks
`q·10000 + r = snapshot·bps` with `r < 10000`. Rounding always goes down, so the total paid
can never exceed the snapshot. Dust (< number of heirs) stays in the vault.

## D3 — Heir identity is a Curve25519 scalar proven with `ecMulGenerator` (2026-11-23)

To claim, an heir proves knowledge of `sk` such that `edKeyCommitment(sk·G, salt)` equals
the commitment in their leaf. They never sign anything, so a claim reveals nothing linking it
to a public key. The claim nullifier is `H("codicil:claim:v1", vault, leafHash)`. Outsiders
can't link it to a leaf, because leaves are salted.

## D4 — Known leak: unshielded payouts reveal the share (2026-11-23)

With unshielded payouts, the claimed amount is public, so `amount / snapshot` reveals that
heir's basis points (not their identity). An heir's unlock date is also disclosed at claim
time, because block-time comparisons are public kernel operations. Shielded payouts (V11)
would remove the first leak. This is stated honestly in the README.

## D5 — Liveness digests are bound to the vault address and a nonce (2026-11-23)

`aliveDigest = H("codicil:alive:v1", vaultAddress, nextDeadline, nonce)`. Binding the
address stops a signature for one vault being replayed on another. The nonce stops a
signature being replayed on the same vault.

## D6: One guardian vote per transaction (2026-11-23)

V5 shows 2 P-256 checks fit in the same circuit size as 1, but 3 double the prover key
(164 MB → 328 MB). Guardians therefore vote one per transaction, counted with nullifiers.
This keeps every guardian's proof as small as possible, and the threshold k is not limited
by circuit size.

## D7: Simulator tests also check the ZK circuit (2026-11-23)

The JavaScript that the compiler generates can, in principle, accept a call that the ZK
circuit would reject. To rule this out, the test harness runs `@midnightntwrk/zkir-v3`'s
`check` on every successful call, as the Compact compiler's own tests do. It costs well under a
second for the whole suite.

## D8: Payouts: shielded where the wallet flow allows, amount leak declared (2026-11-23)

V11 shows a contract-held shielded coin can pay an heir without publishing the heir's key, which
beats unshielded payouts, where the recipient address is public. But a contract's coin lives in
public ledger state, so the paid amount is still derivable from the change.
**Plan:** use shielded payouts in v1 if V14 confirms the heir's wallet sees the coin; otherwise
use unshielded payouts to a fresh address. Either way the README states that per-heir *amounts*
are not hidden today. Roadmap ideas: pay every heir from separate pre-split coins, or batch
claims so amounts cannot be attributed.

## D9: The check-in limit is measured from now, not from the old deadline (2026-11-24)

The brief specified `next ≤ deadline + maxPeriod`. A property test (`contracts/test/properties.test.ts`)
found two problems with it:

1. **The veto could become impossible.** While the vault is pending, the old deadline is already in
   the past. If the challenge window is longer than `maxPeriod`, then late in the window no valid
   `next` exists and the owner can no longer cancel a false trigger.
2. **The limit could be bypassed.** Several check-ins in a row could each add `maxPeriod`, pushing
   the deadline arbitrarily far into the future. The limit exists to stop exactly that, for example
   a coerced owner setting the switch decades ahead.

**Decision:** `next ≤ now + maxPeriod`, written as `blockTimeGte(next − maxPeriod)` because Compact
can compare against block time but not read it. The subtraction is guarded for `maxPeriod > next`.
A test covers that case under the ZK constraint check. The veto property now holds for any
challenge window, which is tested.

## D10: Owner approvals are signed first, then proven (2026-11-24)

Witnesses run synchronously inside proof generation. A Face ID prompt or a wallet pop-up is
asynchronous. So the app:

1. computes the digest with the contract's own pure circuit (`aliveDigest` / `willUpdateDigest`,
   with the vault address and current nonce);
2. asks the passkey or wallet to sign it;
3. stores `{digest, signature}` as an *approval* in the private state;
4. calls the circuit.

The witness hands the approval over only if its digest matches (`ApprovalMismatchError` otherwise),
so a stale approval fails fast and plainly instead of failing a proof. Tests run the witnesses in a
lax mode to prove the circuit also rejects such approvals by itself.

## D11: The wallet path verifies the CIP-30 message format (2026-11-24)

`checkInEd25519` / `updateWillEd25519` verify a CIP-30 `Sig_structure` (119 bytes, digest at
offset 87; gate V7), not a raw signature over the digest. A Cardano wallet (Lace, Nightly, Eternl)
can then approve directly. An app-held Ed25519 key signs the same 119 bytes. The circuit pins the
COSE context and header bytes, so a signature the key made for some other purpose cannot be
replayed as an approval.

## D12: Passkey origin lengths are module parameters; total payouts are capped (2026-11-24)

- The WebAuthn verifier is a generic module, `WebAuthn<#CD, #CDX>`, because the signed
  clientDataJSON length depends on the site origin (gate V6). The vault imports it with the
  lengths for its deployment origin (`<134, 243>` for `http://localhost:5173`). The SDK holds the
  origin in `sdk/src/config.ts`, and a test fails if the two disagree. **Deploying under a new
  domain means changing one line and recompiling.**
- `estatePaid` tracks the sum of all claims, and `claim` asserts it never exceeds the snapshot
  (`estate exhausted`). The SDK refuses to build a will over 100%, but the contract does not rely on
  the client for that.

## D13: Guardians and attestations are voided by any proof of life (2026-11-24)

- **Hidden guardians.** Each guardian creates a secret on their own device and gives the owner
  only `guardianLeaf(secret)`. Only the Merkle root and threshold `k` are on-chain. A vote proves
  membership and publishes `H(domain, vault, secret, round)`. That nullifier stops double votes
  but differs per round and per vault, so votes cannot be linked to a guardian or across vaults.
- **Votes are voided by every check-in, not only by a veto.** The brief resets the round only when
  the owner cancels a countdown. That would let votes pile up slowly: one guardian's mistaken
  vote in March plus another's in October could trigger a living owner's vault. Every owner
  check-in now bumps `guardianRound` and resets the count, so only `k` votes cast since the
  owner's last sign of life count.
- **Attestations are bound to the round** (`attestationDigest(vault, guardianRound)`). An
  attestation signed in advance, or one the owner already vetoed, stops working at the next
  check-in.
- **Fresh timestamps.** Both triggers take `asOf` and require `asOf ≤ now < asOf + 15 min`.
  Otherwise a trigger could backdate `asOf` and shorten the owner's challenge window.
- **Not yet supported:** changing guardians or the attestor after deployment. That needs an
  owner-signed settings update like `updateWill`; it is on the roadmap.
