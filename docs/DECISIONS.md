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

## D14: The will-change notice is an event with no payload (2026-11-25)

Every will update emits `codicil:will-changed:v1`, next to the existing `codicil:released:v1`.
A letter holds a Merkle path to the will root, so *every* letter issued before an update stops
working, including those of heirs whose share did not change. The event lets an heir's app notice
without polling, re-run `checkHeirLetter` against the new root, and tell the heir to ask the owner
for a new letter.

- **No payload.** The new root and version are already on the ledger, and the will update was
  already visible there (`willRoot`, `willVersion`). The event adds a signal, not information.
- **Not per heir.** A notice addressed to particular heirs would say who is in the will. Everyone
  following the vault gets the same event.
- **What it does not do.** It does not deliver the new letter; the owner still sends that
  privately. The demo app collects the events each call emits and, on this one, tells an heir who
  holds a letter that it is out of date and what to do.

## D15: The grace period delays only the timeout, and never shortens the veto (2026-11-25)

`gracePeriod` (seconds, set at deployment, 0 = none) sits between a missed deadline and the moment
anyone can start the countdown by timeout. The reason is practical: without it, an owner who is one
day late has to let the vault go into a public countdown and then cancel it, which alarms heirs and
tells every observer that the owner slipped.

- **The owner can check in during the grace period.** `checkIn` is allowed while armed until
  `deadline + gracePeriod` (before: until `deadline`). After that the old rule applies: start the
  countdown, then veto.
- **`triggerTimeout` is refused until `deadline + gracePeriod`** with its own message
  (`grace period open`), so apps can tell "on time" from "late but in grace".
- **The challenge window starts at the end of the grace period**, not at the deadline. Otherwise a
  grace period as long as the challenge window would leave no time to veto. The owner's total
  allowance after a missed deadline is `gracePeriod + challengeWindow`, whenever the trigger arrives.
- **Guardians and the attestor are not delayed.** They assert that the owner has died; the grace
  period is about a late check-in. Both still only start a challenge window.
- **The will stays locked from the deadline itself.** A late owner checks in first, then changes the
  will. This keeps "nothing but a check-in happens after the deadline" true.
- **Capped at `maxPeriod`** (`grace period too long`). A grace period longer than the check-in
  period would make the deadline meaningless, and the cap catches unit mistakes (milliseconds for
  seconds) before they lock the timers.
- **Zero is the old behaviour.** `deadline + 0` is the deadline in every check; the existing tests
  run with grace off and are unchanged.
- **Cost.** No new circuits. The check-in circuits gain one ledger read and one addition, 28 rows.
  The wallet check-in has 57 rows to spare ([VALIDATION.md](VALIDATION.md), "Circuit headroom"),
  so it stays in its size class with 29 left. Without the read-once change recorded there it
  would not fit, and its prover key would double.

**Trade-off:** grace also delays the heirs by the same amount, and a check-in made during grace is
visibly late on-chain, because block time is public.

## D16: The release fee is taken once, in `finalizeRelease`, before the snapshot (2026-11-25)

A vault can be deployed with `feeBps` (basis points of the estate) and `feeRecipient` (a user
address). `finalizeRelease` sends `floor(estateTotal × feeBps / 10000)` to that address and sets
`estateSnapshot = estateTotal − fee`.

- **Why at release and not per claim.** One transfer instead of one per heir, and the payout maths
  does not change at all: shares are still `floor(snapshot × bps / 10000)` and `estatePaid` is still
  capped at the snapshot. So `fee + all claims ≤ fee + snapshot = estateTotal`, with no path that
  pays a unit twice. A per-claim fee would need a second division in every claim and would leave
  fee dust behind for every heir.
- **Rounding.** The fee rounds down, so its dust stays in the snapshot for the heirs. Heirs' shares
  round down as before; a fully allocated will leaves less than one unit per heir in the vault.
  Both are property-tested.
- **The same checked division as payouts** (D2): the `payoutDivision` witness supplies `(q, r)` and
  the circuit asserts `q × 10000 + r = estateTotal × feeBps` with `r < 10000` (`bad fee math`). The
  releaser is anyone, so the circuit cannot trust the number.
- **Zero means off.** With `feeBps = 0` the circuit does not call the witness and makes no transfer;
  a client with no payout witness can still release. A fee that rounds to zero is not sent either.
- **A 10% cap in the constructor** (`fee too high`), and a non-zero address when a fee is set
  (`fee needs an address`). The cap is a seat belt against a hostile or buggy client: no deployment
  can route more than a tenth of the estate away from the heirs.
- **Fixed at deployment.** There is no circuit that changes the fee, so the operator cannot raise it
  and the owner agreed to it by deploying.
- **No extra ledger field for the amount.** Deposits close when the countdown starts, so the fee
  taken is always `estateTotal − estateSnapshot`.

**What it makes public:** the rate and the fee address, from deployment, and the fee transfer at
release. That is unavoidable for a fee. The cost is a link: every vault that pays the same operator
shows the same address ([PRIVACY.md](PRIVACY.md), known leaks). **Limits:** the fee address is a
user address, not a contract; and the fee binds only owners who deploy through an app that sets it.

## D17: One signed settings update replaces guardians and attestor together (2026-11-25)

D13 left guardians and the attestor fixed at deployment. `updateSettingsPasskey` and
`updateSettingsEd25519` now let the owner replace `guardianRoot`, `guardianThreshold` and
`attestorKeyCommit`, authenticated exactly like a check-in.

- **One circuit per auth method, not one per setting.** A passkey circuit costs about 450 MB of
  prover key and a wallet circuit about 280 MB. Separate circuits for "guardians" and "attestor"
  would add four heavy circuits; one settings update adds two. The circuit count goes from 12 to 14.
- **The owner signs the complete new settings**, not a change. The digest is one SHA-256 over a
  fixed-layout message: tag `"codicil:settings:v1"`, vault, the three settings, nonce (137 bytes).
  One approval cannot be read as a different change, and there is no action tag to get wrong. To
  change one value the app starts from the current ledger values.
- **One hash, not two.** Hashing the settings first and then the usual four-part digest was the
  first version. It cost two extra SHA-256 blocks, about 4,000 rows, which pushed the wallet
  circuit past 2^17 rows and doubled its prover key to 552 MB. The single message fits the same
  three blocks as the check-in and will digests, so `updateSettingsEd25519` is the size of
  `updateWillEd25519` ([VALIDATION.md](VALIDATION.md), "Circuit headroom"). Folding this into the will update was
  rejected: it would change two tested circuits and make every will change re-sign the guardians.
- **Replay.** Same rules as D5: the vault address stops use on another vault, the nonce stops reuse
  on this one, and the domain tag stops a check-in or will approval being used here or the reverse.
  All are tested for both auth methods.
- **A vote round in progress is always voided.** Every settings update bumps `guardianRound` and
  resets `guardianVotes`, whether or not the guardian values changed. Otherwise one vote out of two
  could become "one out of one" by lowering the threshold, or votes from removed guardians could
  count towards the new set. Because attestations are bound to the round (D13), any attestation
  signed before the update is void too, even from an attestor who was kept; they sign again. This
  is the simplest rule that is safe, and only the owner can cause it.
- **Only while armed and before the deadline** (`settings locked`, `switch already expired`), like
  a will update. During a countdown the owner must veto first. This stops settings being changed
  under a countdown that guardians or an attestor started, and keeps "a check-in is the only owner
  action during a countdown" true.
- **No validation of the values.** The contract cannot know how many guardians are behind a root, so
  a threshold above the set size makes the guardian trigger unusable until the next update; the SDK
  (`buildGuardianSet`) refuses to build one. Threshold 0 and a zero attestor commitment switch each
  trigger off.
- **No event.** A guardian's app can compare its path with `guardianRoot` on the ledger
  (`isCurrentGuardian`).

**What it makes public:** the new root, threshold and attestor commitment (all already public
fields), and therefore that a change happened and which of the three values changed. Not who the
guardians or attestor are. **Cost:** two more heavy circuits, in the same size class as the two
will-update circuits.

## D18: Recovery key: new owner keys after a public delay, cancelled by any owner signature (2026-11-25)

**Problem.** An owner who loses both the passkey and the wallet cannot check in. Nothing is stolen,
but the vault releases to the heirs while the owner is alive, and the owner can never change the
will again.

**Options considered.**

- *Let guardians rotate the owner keys.* Rejected. Today k colluding guardians can only start a
  countdown that one check-in cancels. Giving them the keys would let them take the estate.
- *A spare owner key that works immediately.* Rejected. It is one more key with full power and no
  warning; stealing it is as good as stealing the passkey.
- *A separate recovery key that works only after a public delay, which the owner can cancel.*
  Chosen. It is strictly weaker than an owner key.

**Design.**

- **The recovery key is a secret, not a signing key.** 32 random bytes, kept offline (printed, in a
  safe). The ledger holds `H("codicil:recovery:v1", secret)`. `startRecovery` proves knowledge of the
  secret inside the circuit, the same way guardians and heirs prove theirs. The proof is bound to the
  transaction's public values, so nobody can copy it and substitute other keys. This costs a small
  circuit instead of another 200 to 450 MB signature circuit, and a recovery key is typed in from
  paper once, not used daily.
- **`startRecovery(newPasskeyCommit, newEdCommit, nextRecoveryKeyCommit, asOf)`** records the
  proposal and sets `recoveryReadyAt = asOf + recoveryDelay`. `asOf` must be fresh (15 minutes, as
  for the triggers), so the delay cannot be backdated. It emits `codicil:recovery-started:v1`.
- **`finishRecovery()`** can be sent by anyone once `recoveryReadyAt` has passed. It installs exactly
  what the start proposed, and replaces the recovery commitment with the one named at the start, so
  the secret that was typed into a device is retired.
- **Anything a current owner key signs cancels a recovery, and retires the recovery key**: a
  check-in, a will update or a settings update (D17). Either the recovery key was stolen, and the
  thief must not get a second attempt, or the owner has their keys after all. Without this a thief
  could start again every time, and the owner would have to win every round. The price: after a
  cancelled recovery the vault has no usable recovery key, and this version has no way to set a
  new one (see "What is left").
- **Cancellation works through the owner nonce.** A recovery records the owner `nonce` when it
  starts (`recoveryNonce`). Every owner action already moves that nonce, so `finishRecovery`
  requires the two to be equal (`recovery cancelled`), and `startRecovery` refuses a key whose
  earlier recovery was cancelled (`recovery key retired`). The first version cleared the recovery
  fields inside the check-in and will-update circuits. That cost about 100 rows in each, and the
  wallet check-in has 29 to spare ([VALIDATION.md](VALIDATION.md), "Circuit headroom"); it would
  have doubled that circuit's prover key. With the nonce the owner circuits are not touched at
  all, and any owner action added later cancels a recovery without being told to. The cancelled
  proposal and the dead commitment stay on the ledger; `recoveryStatus()` reads them as `retired`.
- **Starting again is allowed** and replaces the proposal. The new date must be later than the
  pending one (`stale timestamp`), which also makes a copied earlier transaction useless. If a thief
  and a key-less owner both hold the secret, each can restart the other's delay, neither can finish,
  and the estate goes to the heirs under the will at the deadline. Without restarts the first to
  start would win.
- **The recovery key never touches the switch.** Both circuits require the vault to be armed and
  before the deadline. A recovery cannot delay a timeout, cannot veto a countdown, and stops working
  the moment guardians or an attestor start one (so k guardians can stop a recovery they do not
  believe). A start that could not finish before the deadline is refused (`too late to recover`),
  because it would only announce that the owner has lost their keys.
- **Limits in the constructor.** `recoveryDelay` must be at least one day
  (`recovery delay too short`): the delay is the whole protection, and one second would make the
  recovery key a spare owner key. It must be shorter than `maxPeriod` (`recovery delay too long`),
  or no recovery could ever finish before a deadline. Zero commitment means no recovery key, and the
  vault behaves exactly as before.
- **Cost.** Two light circuits (16 in total after D17). No new signature circuit, and no change to
  the owner circuits.

**Why this does not weaken the vault.**

1. A recovery key can never do more than an owner key already can, and only after a public wait in
   which any owner signature stops it for good.
2. It cannot delay, stop or veto a release, or act after the deadline. The heirs' position is
   unchanged except through the new owner's own later actions.
3. A vault with no recovery key is unchanged.

**What it does add, stated plainly.** A second secret whose theft matters. If the recovery secret is
stolen and no owner key signs anything for `recoveryDelay`, the thief becomes the owner. That happens
if the owner is not watching, or if the owner has died with more than `recoveryDelay` left before the
deadline, when nobody can cancel. A stolen owner key is still worse (it works at once and cannot be
evicted), but an owner who would rather not carry this risk should not set a recovery key. Having
one is visible on the ledger.

**Choosing the delay.** It should be longer than the time in which the owner is sure to notice an
alert, and short enough to fit between noticing a loss and the deadline. With a 30-day check-in
period, 3 to 7 days is a reasonable range. The app should warn when the deadline is closer than the
delay, because from then on a lost key cannot be recovered.

**What is left (this is the smallest safe version).**

1. *A loss discovered late.* A recovery must start at least `recoveryDelay` before the deadline.
   Owners often find out they have lost a key when they try to check in, close to the deadline, and
   then it is too late: the vault releases to the heirs. The fix is to let a recovery in progress
   hold the timeout for a bounded time and let finishing it count as a check-in. That gives the
   recovery key the power to delay a release, and makes "owner dead, secret stolen" worse (the thief
   could always finish), so it needs its own analysis: a bound on the hold, and probably a guardian
   override. Not done in this pass.
2. *A delay longer than the check-in period.* With (1), the delay could be required to exceed
   `maxPeriod`. Then a routine check-in would always cancel a thief's recovery, even if the owner
   never saw the alert. Under the current rule the delay must be shorter than the period, so the
   protection relies on the owner noticing.
3. *Owner-signed key rotation.* An owner who lost one of two keys can use the recovery key to
   replace it, but must not sign anything during the delay. A direct rotation signed by the
   remaining key would be simpler; it also lets a thief with one key evict the owner at once, which
   is why it is not here.
4. *Setting a new recovery key.* The recovery key is set at deployment and replaced only by a
   completed recovery. After a cancelled one the vault has none, for good. Letting an owner key set
   it (through the settings update, D17) is the obvious fix and was left out on purpose: it would
   give a thief holding one of the owner's two keys a way to lock the owner out (set a recovery key,
   start a recovery, wait for one unanswered delay), where today that thief and the owner can only
   overwrite each other. It would equally let the owner evict the thief. Which of those matters
   more is a product decision, not a detail.
5. *An alert the owner will see.* The demo app shows a warning on the owner's dashboard while a
   recovery is in progress, with the one action that cancels it. That only helps an owner who opens
   the app: an owner who is not using it needs another channel (a notification, an email from a
   watcher), which does not exist yet.
6. *A hardware-held recovery key* (a signature instead of a secret), if paper secrets prove too
   easy to copy. It would cost one more signature circuit.
