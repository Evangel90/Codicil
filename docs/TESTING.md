# Testing

373 unit and simulator tests plus 4 browser end-to-end tests, all run by CI on every push
([workflow](../.github/workflows/ci.yml)). This page explains what each level proves, how to run
it, and the bugs the tests caught.

## Run everything

```bash
npm ci
npm run compile      # Compact → JS + ZK circuits (--skip-zk: no proving keys, seconds)
npm test             # contracts, SDK, app and the network script's offline tests: about 15 seconds
npm run e2e          # builds the app and runs Playwright in Chrome
```

| Level | Command | Count | Time |
|---|---|---|---|
| Contract simulator + ZK constraint checks | `npm test -w @codicil/contracts` | 186 | ~6 s |
| SDK | `npm test -w @codicil/sdk` | 34 | ~1 s |
| App logic (the demo store and helpers) | `npm test -w @codicil/app` | 66 | ~6 s |
| Network script, offline parts | `npm test -w @codicil/preprod` | 87 (one more when the proving keys are present) | ~3 s |
| Browser end-to-end | `npm run e2e` | 4 | ~75 s |
| Full compile with proving keys | `npm run compile:full` | 16 circuits | several minutes |

Property tests run 12 cases per property by default. Run more with `FC_RUNS=500 npm test -w @codicil/contracts`.

## 1. Contract tests: the simulator, checked against the circuit

The tests run the compiler's generated JavaScript for each circuit with `@midnight-ntwrk/compact-runtime`,
moving block time forward to exercise deadlines.

That alone could pass a call the ZK circuit would reject. So **every successful call is also checked
against the compiled circuit** with `@midnightntwrk/zkir-v3`'s constraint checker, as the Compact
compiler's own tests do ([`support/proof-check.ts`](../contracts/test/support/proof-check.ts), [D7](DECISIONS.md)).
A passing test means a proof for that call can be generated.

Every `assert` in the contract is triggered on purpose by at least one test, and
[`errors.test.ts`](../contracts/test/errors.test.ts) checks that each one has a plain-language message
in the SDK and a row in [ERRORS.md](ERRORS.md).

| File | Tests | What it covers |
|---|---|---|
| [`auth.test.ts`](../contracts/test/auth.test.ts) | 48 | Check-ins and will updates by passkey and by wallet, each against: replay, wrong deadline, another vault, wrong key, forged signature, another website, Face ID not used, the `maxPeriod` limit, veto; the will-change notice |
| [`claims.test.ts`](../contracts/test/claims.test.ts) | 18 | Claims, tranches, backup heirs, exact payout maths, over-allocated wills, a client lying about the payout division |
| [`guardians.test.ts`](../contracts/test/guardians.test.ts) | 16 | k-of-n threshold, double votes, outsiders, stale timestamps, votes voided by a check-in, attestations bound to a round |
| [`fee.test.ts`](../contracts/test/fee.test.ts) | 9 | The optional release fee: exact amount, one transfer, shares taken of what remains, dust, the 10% cap, a client lying about the fee, and no fee meaning no transfer |
| [`lifecycle.test.ts`](../contracts/test/lifecycle.test.ts) | 20 | Deposits, timeout, release, the release event, the grace period (late check-ins, when the timeout opens, the veto window after it), and a byte search of the check-in transcript for keys, salts and digests |
| [`recovery-settings.test.ts`](../contracts/test/recovery-settings.test.ts) | 3 | The recovery key and the settings update together: a settings update cancels a recovery like any other owner action |
| [`recovery.test.ts`](../contracts/test/recovery.test.ts) | 23 | The recovery key: new owner keys after the public delay, cancellation by a check-in or will update, the retired key, restarts, timestamps, the deadline rules, no effect on the switch, guardians stopping a recovery, the delay limits, and a byte search of the transcripts for the secret |
| [`settings.test.ts`](../contracts/test/settings.test.ts) | 28 | Owner-signed replacement of guardians, threshold and attestor, by passkey and by wallet: votes and attestations voided, replay, another vault, tampered values, approvals for other actions, wrong key, forged signature, when it is locked, and a byte search of the transcript |
| [`webauthn-real.test.ts`](../contracts/test/webauthn-real.test.ts) | 6 | Real Touch ID assertions captured in Chrome on macOS, verified by the vault's own WebAuthn module, including Chrome's long `clientDataJSON` form |
| [`escrow.test.ts`](../contracts/test/escrow.test.ts) | 5 | Cross-contract call: the escrow asks the vault, two proofs in one transaction |
| [`errors.test.ts`](../contracts/test/errors.test.ts) | 5 | Every contract error is mapped and documented |
| [`properties.test.ts`](../contracts/test/properties.test.ts) | 5 | fast-check: random wills, estates, fees and claim orders never overpay; a fully allocated will leaves only rounding dust, whatever the fee; the owner can always veto, with any grace period; during the grace period the owner can always check in; a recovery never completes early and an owner with a key can always cancel it |

## 2. SDK tests

[`sdk/test/`](../sdk/test): key shapes, commitments computed by the contract's pure circuits,
passkey and CIP-30 format conversion, the will builder and Merkle paths, witnesses, event names, heir letter
encoding (every entry round-trips; it fits a QR code), and the on-device letter check (current
letter, older will, another vault, which key opens it).

## 3. App tests

[`app/test/`](../app/test) drives the demo store, which runs the real contract in-memory:

- [`demo.test.ts`](../app/test/demo.test.ts): the whole story. Wizard setup (the preview root equals
  the deployed root), check-ins, veto, guardian rounds, release, claims, Cleo's tranche, Kofi's
  backup claim, retries after a failure, address validation.
- [`guide.test.ts`](../app/test/guide.test.ts): who acts next at every stage, the plain-words
  summary and its warnings, presets, letters held by heirs (a letter goes stale when the will
  changes and then cannot claim; the app hears the `will-changed` event and points at the heirs
  whose letters are out of date), calendar reminders (which never mention heirs), the ⌘K palette.
- [`grace.test.ts`](../app/test/grace.test.ts): the grace period as the app shows it. The lengths
  the wizard offers, the plain-words rule and the worst case; after a missed deadline nobody can
  start the switch (`grace period open`, with the date it can start), the guide and palette say so
  and offer "Skip the grace period"; a late check-in is late but fine; the will and settings stay
  locked from the deadline; after grace the owner still gets the whole challenge window; guardians
  are not delayed.
- [`settings.test.ts`](../app/test/settings.test.ts): changing guardians and the attestor. A
  replaced guardian cannot vote and the new one can, every update starts a new round and voids
  votes, impossible choices are refused before signing, `settings locked` during a countdown and
  after release, nothing published says who, and a named attestor's signed notice starts the switch.
- [`recovery.test.ts`](../app/test/recovery.test.ts): the recovery key. Its text form (round trip,
  typing mistakes caught on the device), the deployed commitment equals the key the wizard showed,
  the lost-passkey path (start, `recovery delay open`, finish; the new passkey checks in, the old
  one is refused, the next key replaces the used one), `too late to recover`, and the owner's side:
  a check-in, will change or settings change cancels a recovery and retires the key for good.
- [`savings.test.ts`](../app/test/savings.test.ts): the escrow next to the vault, with the real
  cross-contract call. Refused with `vault not released` while armed or pending, refused for anyone
  without the beneficiary secret, paid after the release with both circuits in the transaction's
  trace, the vault hook closed to direct calls, the guidance and palette commands for the savings
  screen, the code shown on screen checked against the contract source, and the `Buffer` stand-in
  the browser needs.

## 4. Network script tests

[`preprod/test/`](../preprod/test) covers the parts of the Preprod script ([PREPROD.md](PREPROD.md))
that need no network: environment and endpoint selection, secret redaction, timer selection, the
resumable state file, the results table, the preflight (with a fake `fetch`), and
[`dryrun.test.ts`](../preprod/test/dryrun.test.ts), which builds every transaction of the real run
through Midnight.js, including the cross-contract withdrawal. Nothing in these tests opens a
connection. The run itself is opt-in: `npm run preprod:check`, `preprod:dust` and `preprod:run`.

## 5. Browser end-to-end

[`app/e2e/demo.spec.ts`](../app/e2e/demo.spec.ts) runs in Chrome with a **CDP virtual authenticator**,
so the passkey goes through the browser's real WebAuthn API and is verified by the circuit. The story:
landing page → wizard with a passkey → check in → a withdrawal from the savings contract, refused
because the vault is armed → change the will → open a letter → guardian votes
and veto → the ⌘K palette → timeout and release → Ben loads and checks his letter (a bad letter is
rejected first) → claim → the same withdrawal, now paid through the cross-contract call → public
inspector (no names on the page) → Privacy Lens.

Two more stories cover what an owner chooses in the wizard and changes later. **Grace and a
cancelled recovery:** a vault with a 3-day grace period and a recovery key (shown once, on a sheet
with a QR code) → the deadline passes and nobody can start the switch → a check-in one day late,
through the passkey, is late but fine → after the grace period the switch starts and is cancelled →
a recovery starts with the saved key (a mistyped key never leaves the device) → the owner's
dashboard shows the warning → one check-in cancels it and retires the key → the inspector and
Privacy Lens show the grace length, "no release fee" and the cancelled recovery, with no names.
**New guardians and a lost passkey:** one guardian has voted when the owner replaces another → the
vote is void, the removed guardian is refused, the new one votes → a recovery with the saved key
creates a second passkey in the virtual authenticator → the delay is skipped and anyone finishes it
→ the old passkey is refused and the new one checks in.

Run against your local Chrome with `PW_CHANNEL=chrome npm run e2e`. On failure CI uploads Playwright
traces.

## Bugs the tests caught

| Bug | Caught by | Fix |
|---|---|---|
| The owner could lose the ability to veto when the challenge window is longer than `maxPeriod`; repeated check-ins could push the deadline arbitrarily far | `properties.test.ts` | Limit measured from now ([D9](DECISIONS.md)) |
| Chrome randomly appends a member to `clientDataJSON` (2 of 5 real captures), so a fixed-length verifier rejected real Face ID signatures | `webauthn-real.test.ts` with real captures | The module accepts both lengths ([VALIDATION.md](VALIDATION.md) V6) |
| Guardian votes could accumulate across months, and an attestation signed earlier could be replayed after a veto | `guardians.test.ts` | Any check-in starts a new round ([D13](DECISIONS.md)) |
| The compiler crashes when exporting a struct containing `Curve25519Point` or `Secp256r1Point` | Compile step | Worked around; reported in [VALIDATION.md](VALIDATION.md) |
| The wizard previewed one will root and deployed another (fresh salts each build) | `demo.test.ts` "deploys exactly the will the wizard previewed" | The draft will is cached and reused |
| The Privacy Lens showed the owner which guardians had voted, which even the owner cannot know | Code review | Removed |

## Reproducing the real-device captures

[`tools/webauthn-capture/`](../tools/webauthn-capture) is the page used to capture the passkey and
wallet signatures. Serve it with `python3 -m http.server 5173 -d tools/webauthn-capture`, open
`http://localhost:5173`, sign with Face ID / Touch ID and a CIP-30
wallet, and save the JSON. The passkey capture is committed as a fixture. The wallet capture came
from a mainnet wallet, so it is kept out of the repository; its results are recorded in
[VALIDATION.md](VALIDATION.md) V7.
