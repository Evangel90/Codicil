# Codicil

[![CI](https://github.com/Evangel90/Codicil/actions/workflows/ci.yml/badge.svg)](https://github.com/Evangel90/Codicil/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Codicil is a private switch on [Midnight](https://midnight.network). You check in now and then.
If you ever stop, your vault releases what you chose. Until that day nobody can tell what is
inside, who it is for, or whose vault it is.**

Some things should happen only if you are gone: savings reach your family, a letter reaches one
person, documents you could not publish come out. A switch that does this on a public blockchain
publishes the plan in advance: who gets what, and how recently you were active. Codicil keeps the
plan private with zero-knowledge proofs, which let the network check a rule without seeing the
data behind it. You prove you are still here with **Face ID or Touch ID** (a passkey) or a
**Cardano wallet**, and that proof is checked inside the circuit.

## What a vault can release

| | For whom | How it stays private | Where it runs today |
|---|---|---|---|
| **A will** | Heirs, each with a share | The chain holds one fingerprint of the whole will. Not who, how many, or how much | Live app on Preview and Preprod; guided demo |
| **A sealed message** | One person: a letter, a recovery phrase | Encrypted on your device. The recipient holds half the key; your guardians hold the other half in pieces | Guided demo |
| **A public disclosure** | Everyone: a reporter's documents | Only a fingerprint is on the chain until the release. A contract refuses every piece of the key before it | Guided demo; the contract has run on Preview |
| **A signal** | Anyone watching, and other contracts | The vault's status is public by design: checking in, gone silent, released. It says nothing else | Reader page on Preview; guided demo; one-line hook for contracts |

Developers can build on two pieces: the release hook and the seal register.
[Build on Codicil](docs/BUILD_ON_CODICIL.md).

## Status

Wave 3, in progress. Test networks only, and unaudited.

- **Built and tested:** the vault contract, the seal register, the SDK and the web app. 523 tests,
  every contract call checked against its ZK circuit, plus browser tests that check in through
  Chrome's real WebAuthn.
- **Run on real networks:** on 26 November 2026 the vault ran end to end on Preprod and Preview:
  deploy, both kinds of check-in, release, a claim and a cross-contract withdrawal
  ([results](preprod/results/v14-preprod.md), vault `4f3b21e1c811…`). On 27 November the seal
  register ran on Preview: it refused a piece of a key before the release, accepted two after it
  with two proofs in each transaction, and the sealed text opened from the public ledger
  ([results](preprod/results/v14-preview.md)).
- **Readable by anyone:** a [reader page](#read-a-real-vault-with-no-wallet) shows that vault's
  status and opens that text from Preview, with no wallet.
- **A register proves whose it is:** its keeper shows in zero knowledge that it holds the key
  behind the vault's owner commitment, so nobody can pass off their own register as the owner's.
  This is tested and has real proofs made locally. It is newer than the Preview run, so the
  register on Preview has not made the proof and the reader page says so.
- **Live mode** (`#/app`): a person creates and uses their own vault on Preview or Preprod through
  the Lace wallet ([how to try it](#try-it-on-a-test-network)). Its store and chain code ran the
  whole story on Preview with a wallet built from a seed.
- **Not done yet:** live mode has not been run with the Lace extension itself, and a check-in from
  a browser is not yet proven on a network. Sealed messages, disclosures and the canary are created
  in the guided demo only, not in live mode.

See [What changed this Wave](#what-changed-this-wave). Demo video and deck: *coming*.

## Judge quickstart

The full guide, with what to expect at each step and where each rubric item is evidenced:
[docs/JUDGES_QUICKSTART.md](docs/JUDGES_QUICKSTART.md).

Requirements: Node 22+ and the [Compact toolchain](https://docs.midnight.network/) (compiler 0.36.1).

```bash
git clone https://github.com/Evangel90/Codicil.git && cd Codicil
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/download/compact-v0.5.3/compact-installer.sh | sh
compact update 0.36.1
npm ci
npm run compile     # compiles the Compact contracts (--skip-zk: seconds, not minutes)
npm test            # contracts, SDK and app, about a minute
npm run dev         # the web app at http://localhost:5173
```

### Try the demo

`npm run dev`, then open **http://localhost:5173** (use exactly this address: passkeys are bound to
the site they were made on, and the vault was compiled for it). The demo runs the **real vault
contract in your browser**, with two contracts that call it, on a simulated chain with a clock you
can fast-forward. Only proof generation and network fees are skipped.

The demo opens on four stories: **Leave a will**, **Seal a disclosure**, **Publish a canary** and
**Make a contract wait for the release**. The will is set up by hand in the steps below. The other
three start with a vault already made and open on the screen the story is about (steps 9, 10 and 7).
**Reset** returns to the four stories.

1. Choose **Leave a will** and **create a vault** in the nine-step wizard: register Face ID / Touch ID (or a demo key), set the
   shares, the guardian threshold and the timers (or start from a Careful / Balanced / Quick preset).
   Three choices are optional and off by default: a **grace period** (step 5), a **recovery key**
   (step 6), which is shown once to print or download, and a **sealed message** for one person or for
   everyone (step 7).
   The review step reads the will back in plain words and flags risky choices. The side panel shows the real heirs root and
   commitments that would go on-chain, recomputed as you edit.
2. **I'm alive**: your passkey signs the check-in, and the circuit verifies the signature, the
   website and the Face ID flag.
   The **Next** line under the demo bar always says whose turn it is, and their button pulses.
3. **Act as** a guardian (Dr. Mensah, then Sarah Lin) and vote: two of three start a 14-day
   challenge window. Switch back to Amara and cancel it.
4. **Skip to deadline**, start the switch, skip the challenge window, **release**. With a grace
   period, the deadline is followed by **Skip the grace period**: until then nobody can start the
   switch, and a check-in is late but fine.
5. Optional: on the **Will** tab, change the will and re-seal it with Face ID, then open an **heir
   letter** (what you would print or send each heir; it is reissued whenever the will changes).
6. Act as heir **Ben**: load his letter (paste it, scan its QR code, or use the demo shortcut). His
   device checks it against the public will fingerprint and spots letters from an older will. Then
   claim his share to a fresh address. Try **Kofi** (backup heir: must wait
   30 days) and **Cleo** (her share unlocks on her 18th birthday).
7. Open the **Savings** tab at any point: a second contract (the compiled `inheritable_escrow`)
   holds tokens for Ben and calls the vault before it pays. Before the release it refuses with its
   own error, `vault not released`; after, the same button pays. The screen shows the one line of
   Compact that makes any contract inheritable.
8. Open the **Messages** tab as the owner and seal a message for one person: a letter or a recovery
   phrase. It is encrypted in your browser, and half of its key is split among the guardians. Choose
   how the pieces travel. **By hand**: before the release a guardian's app keeps its piece; after,
   each guardian's app hands it over by itself when it is opened, and the recipient reads it. None of it is a transaction, and the
   Privacy Lens shows the chain has no record of it. **Through the register**: the pieces go through
   a third contract, the compiled `codicil_seals`, so the guardians never learn who the message is
   for, and the chain shows a fingerprint and nothing about the message.
9. Seal a **public disclosure** (the **Everyone** row, or the "Seal a disclosure" story): a text for
   everyone, such as documents to publish. Sealing is a transaction that records a fingerprint and
   no words. As a guardian, **Hand over through the register** before the release: the register
   asks the vault and refuses with its own error, `vault not released`. After the release, act as
   two guardians: each one's app hands over by itself, in a transaction that also runs the vault's
   check, and then anyone, with no key, can **Open the disclosure**. **Send the register a made-up
   piece** is refused. **Attach a file** (a PDF, up to 25 MB) to seal a file instead of words, or
   with them: before the release it says it cannot be opened yet; after, the app collects the
   pieces, fetches and checks the encrypted copy, decrypts it and offers **Download**.
10. Publish a **canary** (the "A public signal" card on the Messages tab, or the "Publish a canary"
   story): stand behind a statement, then **Act as Anyone**. The public page reads "Still checking
   in" beside the statement. Skip to the deadline and it reads "Gone silent", and says the statement
   no longer holds.
11. On the owner's **Settings** tab: add, remove or replace **guardians**, change how many must
   agree, or name an attestor, all in one update signed like a check-in. It starts a new voting
   round and is locked once a countdown has started. With a recovery key, play **"I lost my
   passkey"**: start a recovery with the saved key, then either skip the delay and finish it (the new
   passkey works, the old one is refused) or check in as Amara, which cancels it and retires the key
   for good. While a recovery is in progress her dashboard shows a warning that cannot be missed.
12. Open the **Privacy Lens** at any point: the real public ledger beside what only the owner's
   device knows. Or **Act as Anyone** for the public inspector: what a stranger can learn from the
   vault address alone. Both show the seal register.
13. The owner can download check-in reminders as a calendar file, made on the device, so no server
   learns the deadline.
14. Press **⌘K** (Ctrl+K) to do anything from the keyboard: check in, skip ahead, act as anyone.

What is real in the demo and what is not: the contracts are the compiled ones, the passkey is real
when the browser supports it, and the encryption and key splitting of sealed messages are real.
Proofs and fees are skipped, the chain is in memory, and every person's device is the same browser
tab, so a piece "arrives" at once.

`npm run compile:full` also generates the proving keys (several minutes; sizes in
[docs/VALIDATION.md](docs/VALIDATION.md)).

### Read a real vault, with no wallet

**http://localhost:5173/#/read** reads a vault's public state from Midnight's Preview network
through its indexer. It asks for no key and sends no transaction.

1. Press **Use the example vault**. The page reads vault `39cba0b4…864f` and its seal register
   `d709181d…0598`, both made by the network script, and says **Released**.
2. The page says this register has not proved that it belongs to the vault's owner. That is
   correct: it was deployed before registers could prove that.
3. The sealed text in the box is checked against the register: its fingerprint matches a seal
   recorded before the vault released.
4. Press **Open it in this browser**. The page rebuilds the key from the two pieces on the public
   ledger and shows the text.
5. Change one character of the sealed text. It no longer matches.

Paste any other vault address from Preview to read it as a signal: still checking in, gone silent,
or released.

### Try it on a test network

Live mode is the same vault on a real network, used through your own wallet:
**http://localhost:5173/#/app**. There is no cast and no clock to move: the heirs and guardians are
the ones you type in, time is real, and every transaction is proven on your machine and paid for by
your wallet. It works on Midnight **Preview** or **Preprod**, whichever your wallet is on. Preview is
the quicker one to start on: a new wallet syncs there in minutes.

What you need:

| Thing | Why |
|---|---|
| Chrome with the [Lace wallet](https://www.lace.io/), set to Midnight Preview or Preprod | It pays the fees and signs. The app reads the network and its service addresses from the wallet |
| tNIGHT from a faucet ([Preview](https://faucet.preview.midnight.network/), [Preprod](https://midnight-tmnight-preprod.nethermind.dev/)), with "Generate tDUST" turned on in Lace | Fees are paid in DUST, which tNIGHT generates over time. Creating a vault takes about 30 DUST (about 12 minutes of generation from 5,000 tNIGHT); any other action takes under 1 |
| A proof server on your machine, in Docker with at least 8 GB of memory | Proofs are made locally, so secrets never leave your computer |
| The proving keys: `npm run compile:full` (about 4 minutes, 2.7 GB) | The app serves them to itself; a check-in's key is 448 MB and is downloaded once, then kept by the browser |

```bash
npm run compile && npm run compile:full   # in this order; `npm run compile` alone deletes the keys
docker run -d --name proof-server -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:9.0.2
npm run dev                               # then open http://localhost:5173/#/app
```

1. **Connect Lace.** The bar under the header names the network and shows your tNIGHT and DUST.
2. **Create your will**: your name, a passkey, your heirs and their shares, guardians if you want
   them, and the timers. To see the whole life of a vault in one sitting, choose **Trying it out, in
   minutes** on the timers step.
3. **Seal the will.** Lace asks you to approve **eight transactions** over about three minutes: the
   vault is too large for one block, so it is created with the rules it needs first and the rest are
   added one at a time ([D19](docs/DECISIONS.md)). If you close the tab part-way, the page continues
   from where it stopped.
4. **Save a backup file** (the Backup button). Everything private is kept only in your browser.
5. **Add tNIGHT** to the vault, and check in with **I'm alive**.
6. Under **Invitations to send**, copy an heir's link. Open it in another browser profile that has
   Lace (the same wallet will do for a test). That browser now knows only what the invitation holds.
7. Let the check-in deadline pass. In the heir's browser: **Start the switch**, wait out the
   challenge window, **Release the will**, then **Claim** to that wallet.

**What has and has not been run** ([docs/VALIDATION.md](docs/VALIDATION.md#live-mode-on-a-network-2026-11-26)):

- `npm run live:e2e` drove the app's own live store and live chain through this whole story on
  **Preview**: 14 transactions, with a wallet built from a seed in place of Lace
  ([results](preprod/results/live-app-preview.md)).
- In a real browser on Preview, with a stand-in for the extension answered by that same wallet, the
  screens created a vault (eight transactions) and made a deposit. The first check-in then crashed
  the tab: Midnight.js's proof client holds the 448 MB proving key in memory several times over.
  The app now has its own proof client that never holds it, tested offline byte for byte. **It has
  not yet made a proof on a network**, so a check-in from a browser is unproven.
- The live code has **not been run on Preprod** (the contract itself has, from the script), and
  **not with the Lace extension**, which our tooling cannot click; that path is written from the
  DApp connector's published types.

Passkeys work at `http://localhost:5173` only, so live mode is a localhost experience for now.
Limits: [docs/ROADMAP.md](docs/ROADMAP.md#live-mode-what-it-does-not-do-yet).

## How it works

```mermaid
stateDiagram-v2
    [*] --> Armed: deploy (owner key commitments + will root)
    Armed --> Armed: checkIn (passkey or wallet proof of life)
    Armed --> Pending: triggerTimeout (deadline passed, anyone)
    Armed --> Pending: guardianAttest (k of n hidden guardians)
    Armed --> Pending: triggerAttestation (signed by the owner's chosen attestor)
    Pending --> Armed: checkIn during the challenge window (veto)
    Pending --> Released: finalizeRelease (window over, anyone)
    Released --> Released: claim / claimAsBackup (heirs, once per share)
```

```mermaid
flowchart LR
    subgraph Device["Owner / heir device (private)"]
      K["passkey · wallet key · heir key"]
      W["will: heirs, shares, unlock dates, backups"]
      SDK["@codicil/sdk<br/>witnesses · will builder · signing"]
    end
    subgraph Chain["Midnight (public ledger)"]
      V["codicil_vault<br/>commitments · will root · deadline · nullifiers"]
      E["any contract, e.g. inheritable_escrow"]
      R["codicil_seals<br/>fingerprints · piece commitments"]
    end
    K --> SDK
    W --> SDK
    SDK -- "ZK proof (no secrets)" --> V
    E -- "isReleasedForContract()" --> V
    R -- "isReleasedForContract()" --> V
```

- **Owner** registers a passkey and/or a Cardano wallet. Only salted *commitments* to the keys go
  on-chain.
- **Will**: each heir entry (key commitment, share, unlock date, optional backup heir, salt) is a
  leaf of a Merkle tree. Only the root is on-chain. Each heir privately receives their own leaf
  and path.
- **Check-in** signs `aliveDigest(vault, nextDeadline, nonce)`. The circuit checks the signature
  against the committed key without revealing it. Replays fail because the nonce moves.
- **Settings**: the owner can replace the guardians, the threshold and the attestor with a signed
  update. It starts a new guardian round, so earlier votes and attestations stop counting.
- **Recovery**: an optional recovery key, kept offline, can install new owner keys after a public
  delay. Anything the current owner signs cancels it, and it can never delay a release.
- **Release**: the countdown starts after a missed deadline plus an optional grace period (anyone
  can trigger it), when k of n
  hidden guardians vote, or with an attestation from a trusted signer. In every case the owner can
  veto during the challenge window, and any check-in voids earlier votes and attestations. After
  the window the estate is snapshotted, after an optional release fee.
- **Claim**: an heir proves their leaf is in the will and that they hold its key. A nullifier
  stops double claims without revealing which heir claimed. Backup heirs share the same nullifier,
  so at most one of the pair is ever paid.

Repository layout:

| Path | What |
|---|---|
| [`contracts/src/codicil_vault.compact`](contracts/src/codicil_vault.compact) | The vault |
| [`contracts/src/lib/WebAuthn.compact`](contracts/src/lib/WebAuthn.compact) | Passkey (WebAuthn) verification in-circuit |
| [`contracts/src/lib/Cip30.compact`](contracts/src/lib/Cip30.compact) | Cardano CIP-30 wallet signature verification in-circuit |
| [`contracts/src/inheritable_escrow.compact`](contracts/src/inheritable_escrow.compact) | Example: any contract becomes inheritable with one call |
| [`contracts/src/codicil_seals.compact`](contracts/src/codicil_seals.compact) | The seal register: hands over the pieces of a sealed message's key only after the vault has released |
| [`contracts/test/`](contracts/test) | Simulator, property and cross-contract tests |
| [`sdk/src/`](sdk/src) | Witnesses, will builder, passkey/wallet conversion, error catalogue |
| [`codicil-spike/`](codicil-spike) | Phase 0 validation spike (gates V1–V15) |
| [`tools/webauthn-capture/`](tools/webauthn-capture) | Page used to capture real passkey and wallet signatures |
| [`docs/`](docs) | [Architecture](docs/ARCHITECTURE.md), [privacy](docs/PRIVACY.md), [threat model](docs/THREAT_MODEL.md), [testing](docs/TESTING.md), [validation](docs/VALIDATION.md), [decisions](docs/DECISIONS.md), [errors](docs/ERRORS.md), [roadmap](docs/ROADMAP.md), [business](docs/BUSINESS.md), [progress by Wave](docs/WAVES.md), [building on Codicil](docs/BUILD_ON_CODICIL.md) |

## Midnight integration

| Midnight feature | Used for | Where |
|---|---|---|
| Dual ledger: public ledger plus private witnesses | Only commitments, the will root, deadlines and nullifiers are public | [`codicil_vault.compact:59`](contracts/src/codicil_vault.compact#L59), witnesses [`:85`](contracts/src/codicil_vault.compact#L85) |
| `persistentCommit` (salted commitments) | Hide owner and heir public keys | [`codicil_vault.compact:125`](contracts/src/codicil_vault.compact#L125) |
| Merkle proofs (`merkleTreePathRootNoLeafHash`) | Prove "my share is in the will" without saying which | [`codicil_vault.compact:364`](contracts/src/codicil_vault.compact#L364) |
| Nullifiers (`Set<Bytes<32>>`) | One claim per share, one vote per guardian per round, unlinkable | `claimNullifiers`, `guardianNullifiers` in [`codicil_vault.compact`](contracts/src/codicil_vault.compact) |
| **P-256** `secp256r1EcdsaVerify` (Ledger 9) | Face ID / Touch ID passkey check-ins; attestor signatures | [`lib/WebAuthn.compact:99`](contracts/src/lib/WebAuthn.compact#L99) |
| **SHA-256** `persistentHash` over raw bytes | Rebuild the WebAuthn signed message in-circuit | [`lib/WebAuthn.compact:96`](contracts/src/lib/WebAuthn.compact#L96) |
| **Ed25519** `ed25519Verify` (Ledger 9) | Cardano wallet (CIP-30) check-ins | [`lib/Cip30.compact:38`](contracts/src/lib/Cip30.compact#L38) |
| **Curve25519** `ecMulGenerator` (Ledger 9) | Heirs prove they hold their key | [`codicil_vault.compact:370`](contracts/src/codicil_vault.compact#L370) |
| **`kernel.caller()`** (Ledger 9) | The integrator hook answers only contracts | [`codicil_vault.compact:350`](contracts/src/codicil_vault.compact#L350) |
| **Cross-contract calls** (Ledger 9) | `inheritable_escrow` asks the vault before paying out; `codicil_seals` asks it before accepting a piece of a key | [`inheritable_escrow.compact:49`](contracts/src/inheritable_escrow.compact#L49), [`codicil_seals.compact:122`](contracts/src/codicil_seals.compact#L122) |
| **Events** `emit` (Ledger 9) | Heir apps and indexers learn of a release | [`codicil_vault.compact:344`](contracts/src/codicil_vault.compact#L344) |
| Block time (`blockTimeGte` / `blockTimeLt`) | Deadlines, challenge window, tranches | [`codicil_vault.compact:218`](contracts/src/codicil_vault.compact#L218) |
| Unshielded tokens (`receiveUnshielded` / `sendUnshielded`) | Hold the estate, pay heirs | [`codicil_vault.compact:277`](contracts/src/codicil_vault.compact#L277), [`:388`](contracts/src/codicil_vault.compact#L388) |
| Generic modules | Passkey verifier parameterised by the site origin | [`codicil_vault.compact:28`](contracts/src/codicil_vault.compact#L28) |

## What is public and what is private

| Data | Where it lives | Who can see it |
|---|---|---|
| Owner passkey / wallet public key | Private; only a salted commitment on-chain | Owner only |
| Will (heirs, shares, unlock dates, backups) | Private; only the Merkle root on-chain | Owner; each heir learns only their own entry |
| Deadline, phase, counters | Public ledger | Everyone (reveals that *a* vault is alive, not *whose*) |
| Guardian identities and votes | Private; only the Merkle root, threshold and a vote count on-chain | Each guardian knows only themselves |
| Claims | Public nullifier; payout to an address the heir chooses | Everyone sees *that* a share was claimed, not by which heir |
| Payout amount | Public (unshielded transfer) | Everyone. Hiding amounts is on the roadmap ([D4, D8](docs/DECISIONS.md)) |
| A sealed message delivered by hand | Private; nothing on-chain | The recipient, after the release. Nobody can tell that it exists |
| A sealed message or disclosure through the seal register | The text is private; a fingerprint, the number of pieces and a commitment to each are on-chain; after the release, the pieces | Everyone sees that a sealed text exists. A private message opens only for its recipient. A public disclosure opens for anyone once enough pieces are handed over ([D21](docs/DECISIONS.md)) |

Every ledger field and transaction, and what each reveals: [docs/PRIVACY.md](docs/PRIVACY.md).
Threats and mitigations, each linked to the test that demonstrates it: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

Tests check the privacy claims directly: a check-in transcript contains no owner key, salt or
signed digest, and a claim transcript contains no leaf, key commitment or heir key
([`lifecycle.test.ts`](contracts/test/lifecycle.test.ts), [`claims.test.ts`](contracts/test/claims.test.ts)).

## Testing

`npm test` runs, for every circuit, the happy path plus every `assert` triggered on purpose.
**Every successful simulated call is also checked against the compiled ZK circuit** (`zkir`
constraint check, as the Compact compiler's own test suite does), so passing means "a proof for
this call can be generated", not just "the JavaScript ran".

| Suite | What it proves |
|---|---|
| [`auth.test.ts`](contracts/test/auth.test.ts) | Check-ins and will updates via passkey and wallet: replay, wrong deadline, other vault, wrong key, forged signature, other website, Face ID not used, limits, veto |
| [`lifecycle.test.ts`](contracts/test/lifecycle.test.ts) | Deposits, timeout, release, events, what a check-in reveals |
| [`claims.test.ts`](contracts/test/claims.test.ts) | Claims, tranches, backups, exact payout maths, over-allocated wills, malicious payout witness |
| [`fee.test.ts`](contracts/test/fee.test.ts) | Optional release fee: exact amount, shares taken of what remains, the 10% cap, malicious fee witness, no fee means no transfer |
| [`properties.test.ts`](contracts/test/properties.test.ts) | fast-check: random wills, estates, fees and claim orders; the owner can always veto |
| [`guardians.test.ts`](contracts/test/guardians.test.ts) | k-of-n threshold, double votes, non-members, stale timestamps, votes voided by check-ins, attestation replay across rounds |
| [`settings.test.ts`](contracts/test/settings.test.ts) | Owner-signed replacement of guardians and attestor: votes and attestations voided, replay, other vault, tampered values, wrong key, when it is locked |
| [`recovery.test.ts`](contracts/test/recovery.test.ts) | Recovery key: new owner keys after a public delay, cancelled by any owner signature, never delays the switch, restarts, timestamps, limits |
| [`escrow.test.ts`](contracts/test/escrow.test.ts) | Cross-contract hook: two proofs in one transaction |
| [`seals.test.ts`](contracts/test/seals.test.ts) | The seal register: every piece refused before the release, genuine pieces published after it through a proven vault sub-call, made-up pieces refused, no secret in its public state |
| [`webauthn-real.test.ts`](contracts/test/webauthn-real.test.ts) | Real Touch ID assertions verified by the vault's own WebAuthn module |
| [`errors.test.ts`](contracts/test/errors.test.ts) | Every contract error has a friendly UI message and is documented |
| [`sdk/test`](sdk/test) | Passkey/wallet format conversion, will builder, witnesses, heir letter encoding and checking against the will root |
| [`app/test`](app/test/demo.test.ts) | The whole demo story through the app's own store: wizard setup and preview, check-ins, veto, guardian rounds, release, claims, tranche, backup, retries; who acts next, the plain-words summary and its warnings, presets, letters held by heirs (stale after a will change, announced by the will-changed event), calendar reminders, the command palette; the savings contract that calls the vault (refused before the release, paid after); the grace period (late but fine, the switch held back, the full window kept); changing guardians and the attestor (new round, locked during a countdown); the recovery key (its text form, recover with a new passkey, cancelled and retired by any owner signature); sealed messages by hand; the seal register (a public disclosure refused before the release and opened by anyone after it, a private message through the register, the canary); sealed files (refused before the release, opened after it with the bytes intact, a damaged stored copy caught) and guardians' apps that hand over by themselves, once, only after the release |
| [`app/e2e`](app/e2e/demo.spec.ts) | In Chrome: the setup wizard with a passkey (virtual authenticator), check-in through the real WebAuthn API, a refused and then a successful cross-contract withdrawal, will change and letter, guardian votes, release, loading and checking a letter, the command palette, claim, public inspector, privacy lens; a late check-in inside the grace period; a recovery the owner cancels; replacing a guardian; a lost passkey recovered with the saved key; a sealed message by hand; a public disclosure through the seal register; a sealed PDF downloaded unchanged after the release; a canary. `npm run e2e` |

The property tests already found one design flaw, now fixed ([D9](docs/DECISIONS.md)). How to run each
level, and the bugs the tests caught: [docs/TESTING.md](docs/TESTING.md).

## Validation results

Before building, we validated every Midnight primitive Codicil depends on (15 gates, all passing).
Highlights:

- The vault ran **end to end on Preprod and Preview**: ten transactions each, including a 27-second
  passkey proof and a cross-contract withdrawal with two proofs in one transaction
  ([Preprod](preprod/results/v14-preprod.md), [Preview](preprod/results/v14-preview-escrow.md)).
- The **seal register ran on Preview** beside a vault: deployed, a text sealed, a genuine piece
  refused before the release, two pieces accepted after it (each transaction carries two proofs,
  the vault's and the register's), the text opened from the ledger, and a made-up piece and a late
  seal refused ([results](preprod/results/v14-preview.md)).
- The first real deployment was refused: the 16-circuit vault is too big for one block. It now
  **deploys in stages**, nine circuits first and seven added after
  ([D19](docs/DECISIONS.md)).

- Real **Touch ID** signatures verify in-circuit. Chrome randomly lengthens the signed browser
  data (in 2 of 5 captures), so the verifier accepts both forms.
- Real **Cardano wallet** `signData` signatures verify in-circuit (119-byte COSE structure).
- We found a Compact compiler crash (exporting a struct containing `Curve25519Point` or
  `Secp256r1Point`) and worked around it.

Full results, key sizes and fallbacks: [docs/VALIDATION.md](docs/VALIDATION.md).
Design decisions: [docs/DECISIONS.md](docs/DECISIONS.md). Error catalogue: [docs/ERRORS.md](docs/ERRORS.md).

## Roadmap

1. Live mode in the app is built, and its code has run end to end on Preview with a wallet from a
   seed ([how to try it](#try-it-on-a-test-network)). Next: a check-in from a browser and a run on
   Preprod, a first run with the Lace extension itself, will and guardian changes in live mode, and giving up the contract's maintenance key
   after deployment ([D19](docs/DECISIONS.md)).
2. In the app: writing a will from scratch, and heirs creating their own keys on their own devices.
3. A recovery that can outlast a deadline, and owner-signed rotation of a single lost key
   ([D18](docs/DECISIONS.md)).
4. Sealed messages, public disclosures and the seal register in live mode: today they run in the
   guided demo ([D20, D21](docs/DECISIONS.md)).
5. Stretch: unlinkable check-ins, sealed files on lasting storage (they run in the guided demo), and executor disclosures for
   courts and tax authorities.

Milestones and status: [docs/ROADMAP.md](docs/ROADMAP.md). Customers, go-to-market and revenue:
[docs/BUSINESS.md](docs/BUSINESS.md).

## What changed this Wave

- Phase 0: 15 validation gates, 14 passing, with real passkey and wallet captures.
- Vault contract: passkey and wallet check-ins, will updates, timeout, hidden k-of-n guardians, an
  attestation trigger, veto, release, multi-heir claims with tranches and backup heirs, a payout cap,
  and the cross-contract hook.
- TypeScript SDK with witnesses, will builder, passkey/wallet conversion and an error catalogue.
- Web app with a demo that runs the real contract in the browser: Face ID check-ins, changing the
  will, printable heir letters with QR codes that heirs check on their own device, a who-acts-next
  guide, plain-words summary with warnings, presets, a public inspector, calendar reminders, a ⌘K command palette, guardian reports, veto, release, claims, a second
  contract that pays out through the cross-contract hook, an optional grace period, changing
  guardians and the attestor after setup, an optional recovery key with a warning the owner cannot
  miss, a notice to heirs when the will changes, and a privacy
  lens, in the Obsidian design, with a landing page whose 3D point field changes shape as you scroll. Dark and light themes,
  works on phones.
- Live mode (`#/app`): the same vault on Midnight Preview or Preprod through the Lace wallet, with
  the owner's own heirs and guardians, real time, a deployment in eight resumable transactions,
  invitations that let an heir claim and a guardian vote from their own browser, passphrase-locked
  backups, and a plain message for everything that can go wrong. Its store and chain code ran end
  to end on Preview with a wallet from a seed (`npm run live:e2e`).
- More than a will, in the guided demo: sealed messages for one person, delivered by hand or through
  a new contract, the seal register (`codicil_seals`), which accepts a piece of a key only after
  the vault has released; a public disclosure anyone can open after the release; and the vault's
  public status read as a canary. The demo opens on four stories.
- 523 tests with ZK constraint checks, including property tests, plus browser end-to-end tests.
  CI on every push.
- Docs: architecture, privacy (every field and transaction), a threat model mapping each threat to
  the test that covers it, testing, roadmap, business and a judges' quickstart. Details: [docs/WAVES.md](docs/WAVES.md).

## License and attribution

Apache License 2.0, see [LICENSE](LICENSE).

Built on [Midnight](https://midnight.network): the [Compact](https://github.com/midnightntwrk/compact)
language and compiler, [`@midnight-ntwrk/compact-runtime`](https://www.npmjs.com/package/@midnight-ntwrk/compact-runtime),
and `@midnightntwrk/zkir-v3` / `@midnightntwrk/onchain-runtime-v4` for constraint checks. The
multi-contract test chain (`contracts/test/support/chain.ts`) is adapted from the Compact
compiler's test-center (Apache-2.0).
