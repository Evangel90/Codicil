# Contract errors

Every `assert` in the Codicil contracts fails with a short, stable message. The app never shows
these raw strings: it maps them to the plain-language text below via `explainError()` in
[`sdk/src/errors.ts`](../sdk/src/errors.ts).

These strings are part of the public interface. Changing one is a breaking change for the UI and
for integrators. A test (`contracts/test/errors.test.ts`) fails if a contract message is missing
from the catalogue or from this page, or if the catalogue has a stale entry.

| Contract message | Who sees it | What the app says |
|---|---|---|
| `vault needs an owner key` | owner | Add a passkey or a wallet before creating the vault. |
| `invalid vault settings` | owner | The check-in period and challenge window must both be longer than zero. |
| `grace period too long` | owner | The grace period cannot be longer than the longest check-in period. |
| `fee too high` | owner | The release fee cannot be more than 10% of the estate. |
| `fee needs an address` | owner | A release fee needs an address to be paid to. |
| `vault already released` | owner | This vault has already been released to the heirs. It can no longer be changed. |
| `switch already expired` | owner | Your check-in deadline has passed. Start the challenge window, then check in to cancel it. |
| `deadline must be in the future` | owner | Choose a next check-in date in the future. |
| `deadline too far` | owner | That next check-in date is further away than this vault allows. |
| `unknown owner key` | owner | This passkey or wallet is not the one registered as the owner of this vault. |
| `bad owner signature` | owner | The approval signature could not be verified. Please approve again. |
| `will locked` | owner | The will can only be changed while the vault is active. |
| `bad passkey data` | owner | Your browser returned an approval this vault cannot read. Try again, or use another browser. |
| `bad passkey challenge` | owner | Your browser returned an approval this vault cannot read. Try again. |
| `passkey signed something else` | owner | The passkey approved a different action. Please approve again. |
| `passkey is for another site` | owner | This passkey belongs to a different website. |
| `passkey user not verified` | owner | Face ID, Touch ID or your device PIN is required to approve. |
| `not a wallet signature` | owner | The wallet returned a signature in an unexpected format. |
| `wallet signed something else` | owner | The wallet signed a different message. Please approve again. |
| `vault closed` | anyone | This vault no longer accepts deposits. |
| `not armed` | anyone | The countdown has already started or the vault was released. |
| `owner is still alive` | anyone | The owner checked in on time. Nothing to do yet. |
| `grace period open` | anyone | The owner missed the deadline but is still within the grace period. The countdown can start when it ends. |
| `not pending` | anyone | The vault is not waiting for release. |
| `challenge window open` | anyone | The owner can still cancel. Release becomes possible when the challenge window ends. |
| `bad fee math` | anyone | The release fee calculation was rejected. Please update the app and try again. |
| `vault not released` | heir | This vault has not been released yet. |
| `not in will` | heir | This claim package is not part of the current will. The owner may have updated it. |
| `not the heir` | heir | This key does not match the heir named in this share. |
| `not the backup heir` | heir | This key does not match the backup heir for this share. |
| `primary claim window open` | heir | The main heir still has time to claim this share. |
| `share still locked` | heir | This share unlocks at a later date set by the owner. |
| `already claimed` | heir | This share has already been claimed. |
| `bad payout math` | heir | The payout calculation was rejected. Please update the app and try again. |
| `estate exhausted` | heir | There is not enough left in the estate to pay this share. |
| `no guardians` | anyone | This vault has no guardians. |
| `stale timestamp` | anyone | Your device clock looks wrong. Check the time and try again. |
| `not a guardian` | anyone | This guardian key is not registered for this vault. |
| `already voted` | anyone | You have already reported this vault in the current round. |
| `unknown attestor` | anyone | This attestation is not from the attestor the owner chose (or the vault has none). |
| `bad attestation` | anyone | The attestation is invalid or out of date. The owner may have checked in since it was signed. |
| `callable by contracts only` | integrator | This check is for other contracts, not for direct calls. |
| `escrow closed` | anyone | This escrow has already been paid out. |
| `already withdrawn` | heir | This escrow has already been paid out. |
| `not the beneficiary` | heir | This secret does not match the escrow beneficiary. |

Errors raised by the SDK before any proof is attempted (no transaction is sent):

| Error | Meaning |
|---|---|
| `MissingSecretError` | This device has no passkey, wallet key or claim package for the vault. |
| `ApprovalMismatchError` | The passkey or wallet approval was made for a different action (e.g. the nonce moved). Sign again. |
