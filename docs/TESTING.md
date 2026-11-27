# Testing

374 unit and simulator tests plus 4 browser end-to-end tests, all run by CI on every push
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
| Contract simulator + ZK constraint checks | `npm test -w @codicil/contracts` | 199 | ~6 s |
| SDK | `npm test -w @codicil/sdk` | 51 | ~1 s |
| App logic (the demo store, the live store and helpers) | `npm test -w @codicil/app` | 161 | ~40 s |
| Network script, offline parts | `npm test -w @codicil/preprod` | 99 (two more when the proving keys are present) | ~3 s |
| Browser end-to-end | `npm run e2e` | 16 (one more, on a network, is opt-in) | ~2 min |
| Live mode on a real network | `npm run live:e2e` | 14 transactions | ~13 min |
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
| [`seals.test.ts`](../contracts/test/seals.test.ts) | 13 | The seal register (D21): a seal records a fingerprint and piece commitments and no secret (a byte search of its whole public state); every piece is refused while the vault is armed or pending; after the release a genuine piece is published through a proven vault sub-call and the message opens from the ledger; a made-up piece, a piece under the wrong number and another message's piece are refused; only the keeper seals; bad piece counts and a late seal are refused; a seal taken back accepts no piece, and cannot be taken back after the release; the public statement |
| [`errors.test.ts`](../contracts/test/errors.test.ts) | 5 | Every contract error is mapped and documented |
| [`properties.test.ts`](../contracts/test/properties.test.ts) | 5 | fast-check: random wills, estates, fees and claim orders never overpay; a fully allocated will leaves only rounding dust, whatever the fee; the owner can always veto, with any grace period; during the grace period the owner can always check in; a recovery never completes early and an owner with a key can always cancel it |

## 2. SDK tests

[`sdk/test/`](../sdk/test): key shapes, commitments computed by the contract's pure circuits,
passkey and CIP-30 format conversion, the will builder and Merkle paths, witnesses, event names, heir letter
encoding (every entry round-trips; it fits a QR code), and the on-device letter check (current
letter, older will, another vault, which key opens it).

[`sealed.test.ts`](../sdk/test/sealed.test.ts) covers sealed messages (D20). Splitting a key: every
choice of the needed pieces rebuilds it, fewer give another value, one missing piece leaves every
secret possible, 255 pieces work, and pieces that cannot belong together are refused. Sealing: a
message opens with any needed pieces, not with fewer, not with a forged piece (which is named), not
with another message's pieces, not by the guardians without the recipient's half, and not after the
sealed text, its nonce or its vault is changed.

The register's SDK helpers ([`sdk/src/seals.ts`](../sdk/src/seals.ts)) and the sealed text's
fingerprint and text form are exercised by the contract suite's
[`seals.test.ts`](../contracts/test/seals.test.ts), which needs both contracts.

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
- [`messages.test.ts`](../app/test/messages.test.ts): sealed messages. Sealing changes nothing on
  the chain and publishes nothing; a guardian's app keeps its piece while the vault is armed or
  pending; the recipient cannot open with their half alone; after the release any two of three
  pieces open it and one does not; a check-in that cancels the switch keeps it shut; changing the
  guardians seals it again so the removed guardian holds nothing; and the guidance and palette
  commands for the screen. These are messages delivered by hand.
- [`reader.test.ts`](../app/test/reader.test.ts): the reader page's logic, which needs no wallet
  and no key. It reads a vault's times and a register's seals from contract state, follows a vault
  from checking in to silent to released, matches a true copy of a sealed text and rejects a
  changed one, keeps a disclosure shut until enough pieces are on the ledger and then opens it, and
  shows that a private message does not match for someone without the recipient's half.
- [`register.test.ts`](../app/test/register.test.ts): the seal register in the demo, with the real
  cross-contract call. It is deployed with the vault and fixed to it. A public disclosure is sealed
  in a transaction that publishes a fingerprint and commitments and none of the words; before the
  release the register refuses a guardian's genuine piece and a made-up one with `vault not
  released`; after it, two guardians' pieces are published with both circuits in the trace, and the
  text opens from the ledger; a made-up piece is refused with `not a genuine piece`; a disclosure
  can be replaced or taken back while armed and not after the release. A private message through
  the register opens only for its recipient and nothing public names them. Changing the guardians
  replaces the seal. The vault read as a signal (checking in, silent, released), and a public
  statement that puts only a fingerprint on the register.

Live mode has two more files. They run the **live store** on the in-memory chain, which is the same
store the app runs on a network: only the host behind the chain boundary differs
([ARCHITECTURE.md](ARCHITECTURE.md#two-chains-and-the-wallet-boundary)).

- [`live-store.test.ts`](../app/test/live-store.test.ts): three people as three stores with their
  own storage. An owner seals a will with their own heirs and guardians; an heir and two guardians
  open invitations; votes start the switch and a check-in cancels it; timeout, release, claims, a
  backup heir who must wait and then may claim. What survives a reload; a vault on another network
  is refused with the network's name. **A deployment interrupted after three of eight
  transactions** keeps everything typed, says why it stopped, and continues in a new store from the
  saved record. A missing proof server stops an action before anything is sent.
- [`live-parts.test.ts`](../app/test/live-parts.test.ts): the pure parts. The chain boundary on the
  in-memory chain; amounts and Bech32m addresses; records; **backups** (round trip into a clean
  store, wrong passphrase, tampered file, nothing readable without the passphrase, merging);
  invitations (inside a link or a sentence, and what is wrong with a bad one); the **Lace
  connector** against a stand-in with the connector's shape (which wallet, which network, a decline
  stops at once); circuit keys over HTTP (progress, kept until the file changes, "never built" told
  apart from a dropped connection, a key handed over as the cached copy and never read into memory,
  a cache that refuses it); **the request to the proof server**, built around a large key by hand
  and compared byte for byte with the ledger's own `createProvingPayload` for key sizes on both
  sides of every length boundary, on a real proof preimage; and **every message for what can go wrong**, including the
  node's own reason for a refused transaction and that a provider token never reaches the screen.

## 4. Network script tests

[`preprod/test/`](../preprod/test) covers the parts of the Preprod script ([PREPROD.md](PREPROD.md))
that need no network: environment and endpoint selection, secret redaction, timer selection, the
resumable state file, the results table, the preflight (with a fake `fetch`), and
[`dryrun.test.ts`](../preprod/test/dryrun.test.ts), which builds every transaction of the real run
through Midnight.js, including the cross-contract withdrawal, and checks the plan that splits the
vault's deployment so it fits a block ([D19](DECISIONS.md)). Nothing in these tests opens a
connection. The run itself is opt-in: `npm run preprod:check`, `preprod:dust` and `preprod:run`. It passed on
Preprod and Preview on 26 November 2026 ([VALIDATION.md](VALIDATION.md) V14); that run found three
problems no offline test could: the block's write limit, the fee a deployment needs, and a wrong
address comparison in the script's own payout check.

## 5. Browser end-to-end

[`app/e2e/demo.spec.ts`](../app/e2e/demo.spec.ts) runs in Chrome with a **CDP virtual authenticator**,
so the passkey goes through the browser's real WebAuthn API and is verified by the circuit. The story:
landing page → the choice of four stories → wizard with a passkey → check in → a withdrawal from the savings contract, refused
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
→ the old passkey is refused and the new one checks in. **A sealed message:** the owner seals one
for Ada with no transaction → the Privacy Lens shows nothing on the public side → Ada cannot open
it and a guardian's app refuses to hand over its piece → timeout and release → one guardian's piece
is not enough, a second is → Ada opens it with real decryption in the browser, and Ben sees nothing.
**A message written in the wizard** is sealed with the vault, for Ben, and is absent from the public
side of the Privacy Lens. **A public disclosure:** the demo starts from the "Seal a disclosure"
story → the owner seals a text for everyone through the seal register → the Privacy Lens shows one
fingerprint and three commitments and none of the words → the register refuses a guardian's piece
with `vault not released`, and nobody can open the text → timeout and release → two guardians hand
their pieces over, each in a transaction that runs the vault's check and the register → a made-up
piece is refused → anyone opens the text from the ledger. **A canary:** from the "Publish a canary"
story the owner stands behind a statement → anyone reads "Still checking in" beside it → after a
missed check-in the same page says "Gone silent" and that the statement no longer holds.

[`app/e2e/live.spec.ts`](../app/e2e/live.spec.ts) opens live mode with a stand-in for the Lace
extension under `window.midnight`, shaped as the DApp connector 4.1.0 types describe. No wallet: it
is told to install Lace. A wallet on another network, or with an old connector: told what to do. On
Preview and on Preprod: the three ways in, the wizard with a real (virtual-authenticator) passkey,
sealing, and what is saved across a reload; the backup file downloads. A wallet with no tokens is
sent to the faucet for its network. These tests use no network, so they stop where the app first
needs one. With `E2E_LIVE_PREVIEW=1` the owner test goes one step further: it builds the staged
deployment in the browser and offers it to the wallet, which declines.
The two owner tests build a real deployment, which needs the circuits' keys from
`npm run compile:full`. CI compiles without them, so those two are skipped there and run locally.

[`app/e2e/live-network.spec.ts`](../app/e2e/live-network.spec.ts) is opt-in
(`E2E_LIVE_NETWORK=preview`). It clicks through live mode in headless Chromium **on the real
Preview network**: create a vault, deposit, check in with a WebAuthn passkey, open an heir's
invitation in a second browser context, start the switch, release, claim. The stand-in wallet hands
every request to the test wallet in the Node process, so the app's Lace adapter is exercised against
a wallet that really balances, signs and submits. **It has not passed yet.** Its one run, on
26 November 2026, created the vault and made the deposit through the screens and then lost the tab
at the check-in ([VALIDATION.md](VALIDATION.md#live-mode-on-a-network-2026-11-26)); the cause is
fixed in the code and the test has not been run again.

`npm run live:e2e` ([`app/scripts/live-e2e.ts`](../app/scripts/live-e2e.ts)) needs no browser: it
drives the live store and the live chain on a real network with the same test wallet, as three
stores (owner, guardian, heir), and writes every transaction hash to `preprod/results/`. It is
resumable. It ran on Preview on 26 November 2026
([results](../preprod/results/live-app-preview.md)), before the proof client was rewritten.

The suite runs on port 5173. If that port is taken, `E2E_PORT=5199 npm run e2e` uses another: the
vault accepts a passkey from any `http://localhost:NNNN` origin of the same length.

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
