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
