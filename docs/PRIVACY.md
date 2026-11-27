# Privacy

Midnight has two kinds of state. The **public ledger** is visible to everyone, like any blockchain.
**Private state** stays on each person's device and enters a transaction only as a *witness*: an
input to a zero-knowledge proof that the network verifies without seeing it.

Codicil puts only commitments, roots, counters, deadlines and nullifiers on the public ledger. Keys,
the will and guardian identities are witnesses. This page lists what each part reveals, including the
leaks we have not removed yet. To see it live, open the **Privacy Lens** or **Act as Anyone** in the
[demo](../README.md#try-the-demo).

## Summary

| Data | Where it lives | Who can see it |
|---|---|---|
| Owner passkey / wallet public key | Private; a salted commitment on-chain | Owner only |
| Recovery secret | Private; a commitment on-chain | Owner only. Everyone can see *that* a vault has a recovery key |
| Will: heirs, shares, unlock dates, backups | Private; only the Merkle root on-chain | Owner; each heir sees only their own entry (in their letter) |
| How many heirs there are | Private (the tree has 1,024 slots) | Owner |
| Guardian identities | Private; only the Merkle root on-chain | Each guardian knows only themselves |
| How many guardians there are | Private (the tree has 1,024 slots) | Owner |
| Guardian threshold k, votes this round | Public | Everyone sees "2 must agree, 1 vote so far", never who |
| Deadline, phase, challenge window | Public | Everyone. Shows that *a* vault is alive, not whose |
| Claims | Public nullifier per claimed entry | Everyone sees *that* a share was claimed, not by which heir |
| Payout amount, unlock date and recipient address of a claim | Public | Everyone (see "Known leaks") |
| Estate balance | Public | Everyone |
| Release fee rate and fee address (if a fee is set) | Public | Everyone, from the day the vault is deployed |

## The public ledger, field by field

| Field | What it is | What it reveals |
|---|---|---|
| `ownerPasskeyCommit`, `ownerEdCommit` | `persistentCommit` of the public key with a random salt | Which key types are enabled. Not the key: two vaults by the same person look unrelated |
| `passkeyRpIdHash` | SHA-256 of the website's domain | Which website the passkey belongs to (the Codicil app) |
| `recoveryKeyCommit`, `recoveryDelay` | Hash of the recovery secret; the public wait before a recovery takes effect | Whether the vault has a recovery key, and how long the owner has to cancel a recovery. Not the secret. The same secret on two vaults gives the same commitment (see "Known leaks") |
| `recoveryReadyAt`, `recoveryNonce`, `recoveryPasskeyCommit`, `recoveryEdCommit`, `recoveryNextKeyCommit` | A recovery that was started: when it takes effect, the owner nonce at that moment, and the salted commitments it would install | That someone holding the recovery secret is replacing the owner keys, and when. This must be public so the owner can cancel. Not the new keys. After a cancellation these fields stay, so anyone can see that a recovery was tried and stopped |
| `willRoot` | Merkle root of salted heir entries | Nothing about the will. It changes when the will changes |
| `willVersion` | Counter | How many times the will was changed |
| `nonce` | Counter of owner actions | How many check-ins, will changes and settings changes so far |
| `deadline`, `maxPeriod`, `challengeWindow`, `claimWindow`, `gracePeriod` | Timers | The owner's check-in rhythm and how much slack they chose. The contract must enforce time, so time is public |
| `phase`, `pendingUntil`, `releasedAt` | State machine | Whether the switch has started or the will was released |
| `guardianRoot`, `guardianThreshold` | Merkle root, k | k, but not n and not who |
| `guardianRound`, `guardianVotes`, `guardianNullifiers` | Vote bookkeeping | A vote count. Nullifiers differ per guardian, per round and per vault, so votes cannot be linked |
| `attestorKeyCommit` | Salted commitment | Whether an attestor is set, not who |
| `estateTotal`, `estateSnapshot`, `estatePaid` | Token accounting | The estate size and how much has been paid out. `estateTotal − estateSnapshot` is the release fee that was taken |
| `feeBps`, `feeRecipient` | The optional release fee and where it goes | Public by nature: the fee is a visible transfer to a visible address, and owner and heirs must be able to check the rate. The address is the same for every vault that pays the same operator (see "Known leaks") |
| `claimNullifiers` | `hash(vault, leafHash)` per claim | How many entries have been claimed, not which |

## What each transaction reveals

Which circuit a transaction calls is public, as are its disclosed values. Each row was checked
against the public transcript the circuit produces; the tests named in the last column search the
transcript bytes for the secret values.

| Transaction | Publishes | Never publishes | Test |
|---|---|---|---|
| `checkInPasskey` / `checkInEd25519` | The new deadline; that a passkey or a wallet was used | Public key, salt, signature, signed digest | `lifecycle.test.ts` "what a check-in reveals" |
| `updateWillPasskey` / `updateWillEd25519` | The new will root; a `codicil:will-changed:v1` event with no payload | Heirs, shares, dates, the old will, what changed | `auth.test.ts` "emits a notice" |
| `updateSettingsPasskey` / `updateSettingsEd25519` | The new guardian root, threshold and attestor commitment; that a passkey or a wallet was used | Owner key, salt, signature, signed digest; who the guardians or the attestor are, old or new | `settings.test.ts` "publishes the new root" |
| `startRecovery` | The proposed owner key commitments, the next recovery key commitment, the start time; an event with no payload | The recovery secret, the new keys and their salts | `recovery.test.ts` "never the recovery secret" |
| `finishRecovery` | That the proposed commitments are now the owner's | — (it takes no private input) | `recovery.test.ts` "never the recovery secret" |
| A check-in, will update or settings update while a recovery is in progress | The usual, and nothing more. Because the nonce moved, everyone can tell that the recovery was cancelled and its key retired | — | `recovery.test.ts` "cancels a recovery" |
| `deposit` | Amount; the depositing address (unshielded input) | — | `lifecycle.test.ts` |
| `triggerTimeout`, `finalizeRelease` | That the switch started / the will was released. With a release fee: the fee amount and the fee address | — | `lifecycle.test.ts`; `fee.test.ts` "public by design" |
| A check-in during the grace period | The same as any check-in. Because block time is public, everyone can see that it came after the deadline | — | `lifecycle.test.ts` "grace period" |
| `guardianAttest` | A nullifier and the vote time | Which guardian, how many guardians exist | `guardians.test.ts` "unlinkable nullifier" |
| `triggerAttestation` | The attestation time | The attestor's key | `guardians.test.ts` |
| `claim` / `claimAsBackup` | Nullifier, amount, unlock date, recipient address; whether it was a backup claim | Which entry, the heir's key or its commitment, the Merkle path | `claims.test.ts` "publishes a nullifier, not which leaf or heir" |

## Known leaks

We state these plainly rather than hide them ([D4](DECISIONS.md), [D8](DECISIONS.md)):

1. **Payout amounts.** Payouts are unshielded, so a claim shows its amount. Dividing it by the
   public snapshot gives that entry's share. It does not say *who* claimed. Shielded payouts
   ([VALIDATION.md](VALIDATION.md) V11) hide the recipient but not the amount, because the
   contract's coin is public state. Roadmap: pre-split coins or batched claims.
2. **Unlock dates at claim time.** Block-time comparisons are public kernel operations, so a claim
   reveals that entry's unlock date.
3. **Recipient addresses.** An heir should claim to a fresh address; the app suggests one.
4. **Will changes are visible.** `willRoot` and `willVersion` change, and an event is emitted, so
   anyone can see *that* and *when* a will was changed, and how often. Nobody can see what changed.
   An heir who was removed is not told by the chain; they find out only because no new letter arrives.
5. **A recovery is public, and so is having a recovery key.** `recoveryKeyCommit` shows from
   deployment that a recovery secret exists somewhere, which tells a thief it is worth looking for.
   Starting a recovery shows everyone that this vault's owner has lost their keys or is under
   attack. Both are needed: the delay only protects the owner if the owner can see the recovery.
6. **A reused recovery secret links vaults.** The commitment is a plain hash of the secret, so the
   same secret on two vaults shows the same value on both. The SDK generates a fresh secret per vault.
7. **Settings changes are visible.** A settings update shows that, and when, the owner changed
   guardians or the attestor. Comparing the old and new values shows which of the three changed
   (root, threshold, attestor commitment). It does not show who was added or removed, or how many
   guardians there are.
8. **A fee address links vaults to an operator.** A vault deployed with a release fee names its fee
   address on the ledger from day one. Every vault that pays the same operator carries the same
   address, so observers can list them and see how large each estate is. They still learn nothing
   about owners or heirs. A vault with no fee has a zero address and is not linked this way.
9. **Activity rhythm.** The deadline moves at each check-in, so observers can see how often *some*
   vault is renewed. Unlinkable check-ins are a stretch goal.
10. **Network metadata.** Like any transaction, a check-in is sent from somewhere and pays a fee.
   What a Midnight fee payment reveals about the payer is checked as part of the Preprod test (V14).
   Until then, assume an owner should check in from a wallet that is not publicly theirs.

## Sealed messages and the seal register

A sealed message is encrypted on the owner's device. How its key reaches the reader decides what
the chain shows ([D20, D21](DECISIONS.md)). Both routes run in the guided demo only.

**By hand.** Nothing is on the chain: not the message, not that one exists, not who it is for.
The guardians learn who the recipient is, because they hand their pieces to that person.

**Through the seal register** ([`codicil_seals.compact`](../contracts/src/codicil_seals.compact)).
The register's public ledger, field by field:

| Field | What it holds | What it reveals |
|---|---|---|
| `vault` | The vault this register asks | That this vault has a register |
| `keeperCommit` | A commitment to a secret on the owner's device | Nothing about the owner |
| `seals` | For each sealed text: its fingerprint, how many pieces exist, how many are needed, and a time it was recorded before | That a sealed text exists, and roughly when. Not what it says, how long it is, or who it is for |
| `pieceChecks` | A commitment to each piece of each key | How many pieces there are in all. Not the pieces |
| `handedOver` | Pieces handed over after the release | The pieces themselves. A private message still needs the half only its recipient holds. A public disclosure opens for anyone once enough are here |
| `statement` | The fingerprint of a public statement, or zeros | That the owner stands behind some statement. The words are on the owner's page, not on the chain |

A guardian who hands over through the register sends a transaction from any wallet. The contract
records the piece and its number, and nothing about who sent it. What a transaction's fee payment
reveals is leak 10 above. The guardian never learns who a message is for.

## Why the heir's letter is safe to lose

A letter holds the vault address, one will entry and its Merkle path. Someone who finds it learns
that entry's share and unlock date, and can see on-chain whether it has been claimed. They cannot
claim it: that needs the secret key behind the entry's key commitment, which the heir keeps
separately. They learn nothing about the other heirs.

## Selective disclosure (roadmap)

Because every fact is committed, an executor can later prove one fact to a court or tax authority
(for example "this person was an heir with 30%") by revealing one entry and its path, without
revealing the rest of the will. The heir's letter is already exactly that proof for one entry.
