# Threat model

What Codicil protects, against whom, and where the limits are. Contract: [`contracts/src/codicil_vault.compact`](../contracts/src/codicil_vault.compact).
Each mitigation below names the test that demonstrates it.

## Assets and actors

| Asset | Why it matters |
|---|---|
| The estate (tokens in the vault) | Must reach the right heirs, and only after the owner has died |
| The will (heirs, shares, unlock dates, backups) | Publishing it makes heirs targets for coercion, scams and family conflict |
| The owner's activity pattern | Reveals when someone is active, travelling or unwell |
| Guardian identities | Guardians who can be identified can be bribed or pressured |

Actors: the **owner**, **heirs** and **backup heirs**, **guardians**, an optional **attestor** (e.g. a notary
or death-registry service), **any third party** (every trigger is permissionless), and **chain observers**.

## Threats and mitigations

| Threat | Mitigation | Evidence |
|---|---|---|
| **Fake death claim** by a guardian, an heir or a stranger | Every trigger (timeout, k guardians, attestation) only starts a **challenge window**. One check-in by the owner cancels it. | `auth.test.ts` "vetoes a trigger"; `properties.test.ts` "the owner can always veto" (any window length, D9) |
| A **slightly late check-in** puts the vault into a public countdown and alarms the heirs | Optional grace period: until `deadline + gracePeriod` the owner checks in normally and no timeout can start. The challenge window is counted from the end of the grace period, so grace never shortens the veto (D15) | `lifecycle.test.ts` "grace period"; `properties.test.ts` "during the grace period" |
| Guardians **colluding** (fewer than k) | k-of-n threshold; one vote per guardian per round | `guardians.test.ts` "k−1 votes do nothing", "already voted" |
| Guardians **colluding** (k or more) | Still only starts the challenge window; the owner vetoes. Owners should pick k so a quorum is hard to buy. | `guardians.test.ts` "owner veto" |
| Votes **accumulating slowly** over months | Any check-in voids all votes so far (D13) | `guardians.test.ts` "any check-in voids votes" |
| **Pre-signed or replayed attestation** | Bound to `guardianRound`, which every check-in bumps | `guardians.test.ts` "signed before the owner last checked in", "cannot be replayed after the owner vetoes" |
| **Backdating** a trigger to shorten the veto window | `asOf` must be within the last 15 minutes | `guardians.test.ts` "stale timestamps" |
| **Replayed owner approval** (check-in or will update) | Digest binds the vault address, the new value and the nonce; the nonce moves on every owner action | `auth.test.ts` "replayed approval", "another vault", "check-in approval to change the will" |
| **Stolen phishing-site passkey assertion** | The circuit checks `rpIdHash` (the site) and that Face ID / Touch ID was used (UV flag) | `auth.test.ts` "another website", "requires user verification" |
| **Coercion to push the deadline decades ahead** | A check-in can set the deadline at most `maxPeriod` from *now*; repeated check-ins cannot stack (D9) | `auth.test.ts` "cannot chain check-ins" |
| **Impersonating an heir** | Must prove the leaf is in the will *and* know the secret key behind its commitment | `claims.test.ts` "not the heir", "not in will", "tampered leaf" |
| **Double claim** / heir and backup both claiming | One nullifier per leaf, shared by heir and backup | `claims.test.ts` "already claimed", backup suite |
| **Over-allocated or malicious will / client** | Contract checks the payout division and caps total payouts at the snapshot | `claims.test.ts` "bad payout math", "estate exhausted" |
| A hostile or buggy client **deploys the vault with a huge fee**, or a releaser lies about the fee | The constructor refuses more than 10% (`fee too high`). Rate and address are on the public ledger, so owner and heirs can check them. The circuit checks the fee division, and the fee is taken once, at release (D16) | `fee.test.ts` "above 10%", "wrong fee from a modified client", "once, at release" |
| The fee **breaking the payouts** (dust lost, double paid, vault overdrawn) | Shares are taken of the snapshot after the fee, so fee + claims ≤ estate; both round down | `fee.test.ts` "what remains"; `properties.test.ts` "only rounding dust, whatever the fee" |
| **Learning the will from the chain** | Only a salted Merkle root is public; claims reveal a nullifier | `claims.test.ts` "publishes a nullifier, not which leaf or heir" |
| **Learning the owner's keys** | Only salted commitments are public; transcripts checked for key, salt and digest bytes | `lifecycle.test.ts` "what a check-in reveals" |
| **Identifying guardians** | Membership proof plus an unlinkable per-round, per-vault nullifier | `guardians.test.ts` "unlinkable nullifier" |
| A client lying through its witnesses | Every successful test call is checked against the compiled ZK circuit, and malicious-witness tests exist | `claims.test.ts` "wrong payout quotient from a modified client"; `support/proof-check.ts` |

## Known limits (stated honestly)

- **Owner key loss.** If the owner loses *every* registered key, they cannot check in, and the vault
  will release at the deadline. Mitigations: register both a passkey (synced via iCloud/Google) and a
  wallet; a recovery key is on the roadmap.
- **Coercion of a living owner.** Someone who controls the owner's device can check in for them. That
  delays release (bounded by `maxPeriod`) but cannot redirect funds: the will cannot be changed once a
  countdown has started, and heirs are bound to their own keys.
- **Activity pattern.** The deadline and the time of each check-in are public, so observers can see
  that *some* vault is alive and how often it is renewed, but not whose it is. Unlinkable check-ins
  are a stretch goal.
- **Payout amounts are public.** Unshielded payouts reveal amounts and recipient addresses. Heirs
  should claim to a fresh address (D4, D8).
- **Front-running a claim.** The payout goes to the address chosen *inside* the proof, so a copied
  transaction pays the same heir. A front-runner gains nothing.
- **A grace period delays the heirs too.** It adds to the time between the owner's last check-in and
  release by timeout. It does not delay guardians or the attestor. It is capped at `maxPeriod`.
- **Block time.** All time checks use Midnight block time, which can drift slightly from wall-clock time.
  Windows are days long, except for the 15-minute freshness window on triggers.
- **Attestor trust.** An attestor's signature still only starts the challenge window. A compromised
  attestor can cause false alarms but cannot release funds by itself.
- **Guardians and attestor are fixed at deployment** for now (D13).
- **The release fee is fixed at deployment** and is only as binding as the app that deploys the
  vault: an owner who deploys the contract themselves can set it to zero. Nobody, the operator
  included, can raise it later.
