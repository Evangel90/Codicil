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
| A guardian **turns hostile or loses their secret**; the attestor is **compromised or closes** | The owner replaces the guardian set, the threshold and the attestor with a signed settings update (D17) | `settings.test.ts` "replaces the guardians", "replaces the attestor" |
| **Old votes counted against a new threshold**, or an old attestation used after the settings changed | Every settings update starts a new round: votes are reset and earlier attestations are void | `settings.test.ts` "voids a vote round in progress", "voids attestations signed before the update" |
| **Pre-signed or replayed attestation** | Bound to `guardianRound`, which every check-in bumps | `guardians.test.ts` "signed before the owner last checked in", "cannot be replayed after the owner vetoes" |
| **Backdating** a trigger to shorten the veto window | `asOf` must be within the last 15 minutes | `guardians.test.ts` "stale timestamps" |
| **Replayed owner approval** (check-in, will update or settings update) | Digest binds the vault address, the new value and the nonce, under a tag per kind of action; the nonce moves on every owner action | `auth.test.ts` "replayed approval", "another vault", "check-in approval to change the will"; `settings.test.ts` "replayed approval", "another vault", "differ from what was signed", "check-in or will approval" |
| **Stolen phishing-site passkey assertion** | The circuit checks `rpIdHash` (the site) and that Face ID / Touch ID was used (UV flag) | `auth.test.ts` "another website", "requires user verification" |
| **Coercion to push the deadline decades ahead** | A check-in can set the deadline at most `maxPeriod` from *now*; repeated check-ins cannot stack (D9) | `auth.test.ts` "cannot chain check-ins" |
| The owner **loses every registered key** | A recovery key (a secret kept offline) proposes new owner keys, which take effect after a public delay (D18) | `recovery.test.ts` "after the public delay the new passkey owns the vault" |
| A **stolen recovery key** used to take the vault over | The takeover waits `recoveryDelay` (at least a day) in public, with an event. Anything a current owner key signs cancels it and retires the recovery key, so a thief gets one attempt | `recovery.test.ts` "a check-in cancels a recovery", "a will update cancels it too"; `recovery-settings.test.ts`; `properties.test.ts` "an owner who still has a key can always cancel it" |
| A recovery key used to **stall, veto or outlast a release** | It acts only while armed and before the deadline. It cannot delay a timeout or veto a countdown, and guardians can stop it by starting one | `recovery.test.ts` "never delays the switch", "cannot act once the deadline has passed", "guardians can stop a recovery" |
| **Backdating or copying** a recovery start to shorten the delay | Fresh timestamp (15 minutes); a restart can only move the date later | `recovery.test.ts` "cannot be backdated", "can never bring the date forward" |
| A thief and a key-less owner **both hold the recovery secret** | Either can restart the delay, so neither can finish against the other; the deadline passes and the estate goes to the heirs under the will, not to the thief | `recovery.test.ts` "starting again replaces the proposal" |
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

- **Owner key loss.** An owner who loses *every* registered key cannot check in. With a recovery key
  they can install new keys, but only if they start at least `recoveryDelay` before the deadline; a
  loss discovered later than that cannot be recovered and the vault releases to the heirs (D18).
  Without a recovery key the vault always releases. Mitigations: register both a passkey (synced
  via iCloud/Google) and a wallet, and keep a recovery key.
- **A recovery key is a second secret to protect.** If it is stolen and the owner signs nothing for
  `recoveryDelay` (because they are not watching, or because they have died with more than that left
  before the deadline), the thief becomes the owner and can rewrite the will. The delay, the event
  and the cancel-on-any-signature rule reduce this; they do not remove it. Keep the secret offline,
  choose the delay with this in mind, and do not set a recovery key if that trade is not worth it.
- **After a cancelled recovery the vault has no usable recovery key**, and this version has no way to
  set a new one (D18, "What is left"). An owner who signs anything while their own recovery is waiting
  cancels it the same way.
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
- **Changing guardians needs the owner's key and an armed vault.** Once a countdown has started the
  settings are locked: the owner vetoes first, then replaces the guardians (D17). Someone holding an
  owner key can also replace them; that is the same power the key already has over the will.
- **A removed guardian is not told.** Their vote simply stops working. A guardian who was kept needs
  a new path from the owner.
- **The release fee is fixed at deployment** and is only as binding as the app that deploys the
  vault: an owner who deploys the contract themselves can set it to zero. Nobody, the operator
  included, can raise it later.
