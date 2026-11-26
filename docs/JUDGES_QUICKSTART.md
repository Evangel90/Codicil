# Judges' quickstart

Three ways to evaluate Codicil, from five minutes to a full review. Everything in them runs locally;
no wallet or test tokens are needed. A fourth, optional, uses the app on a Midnight test network
with your own wallet.

## Setup (once)

Requirements: Node 22+, macOS or Linux, and Chrome or Safari for the passkey demo.

```bash
git clone https://github.com/Evangel90/Codicil.git && cd Codicil
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/download/compact-v0.5.3/compact-installer.sh | sh
compact update 0.36.1
npm ci
npm run compile
```

`npm run compile` should finish in seconds and write `contracts/managed/`. If `compact` is not
found, add `~/.local/bin` to your `PATH`.

## 1. Five minutes: run the tests

```bash
npm test
```

Expected: four suites, **186 + 34 + 111 + 88 = 419 passed**, in about 20 seconds (one SDK test and
one network-script test are skipped on a fresh checkout: they need a local capture file and the
proving keys). The contract suite
checks every successful call against the compiled ZK circuit, so these are calls a proof can be made
for. Details: [TESTING.md](TESTING.md).

## 2. Ten minutes: the demo

```bash
npm run dev
```

Open **http://localhost:5173** exactly (passkeys are bound to the site they were made on, and the
vault is compiled for this address). Click **Launch the demo**.

The demo runs the real compiled vault, and an example contract that calls it, in your browser on a
simulated chain whose clock you can move forward. Only proof generation and network fees are skipped.

| Step | What to do | What it shows |
|---|---|---|
| 1 | In the wizard, **Register Face ID or Touch ID** (or use a demo key), then Continue through the steps and **Seal & deploy vault**. To try the newest features, choose a **3 days** grace period in step 5 and **Create a recovery key** in step 6 (both are off by default) | The side panel shows the real values that would go on-chain: commitments and roots, no names. The recovery key is shown once, to print or download |
| 2 | Press **I'm alive** | Your passkey signs; the circuit verifies the signature, the website and that Face ID was used |
| 3 | Follow the **Next** line under the demo bar; it says whose turn it is | Guardians vote anonymously; Amara cancels with one touch |
| 4 | **Skip to deadline** → **Start the switch** → **Skip challenge window** → **Release the will** | Anyone can trigger; the owner always has a window to veto |
| 5 | Act as **Ben**: **Use the letter Amara gave me**, then **Claim my share** | His device checks the letter against the public will root; the claim reveals a one-time stamp, not who |
| 6 | **Savings** tab: as **Ben**, **Withdraw 8,000 demo tokens** before the release, and again after it | A second contract (`inheritable_escrow`) runs beside the vault and calls it. It refuses with its own error, `vault not released`, then pays once the vault says yes. The screen shows the one line of Compact a developer writes |
| 7 | **Privacy Lens**, then **Act as Anyone** | The public ledger beside what only the owner's device knows; what a stranger can learn. Both list the grace length, whether a recovery key exists, a recovery in progress, the settings values and "release fee: none" |
| 8 | With a grace period: **Skip to deadline**, then **+1 day** and **I'm alive** | Nobody can start the switch during grace (`grace period open`), and the late check-in is late but fine. **Skip the grace period** instead to see the switch start |
| 9 | As Amara, **Settings** → **Change guardians or the attestor**: swap Tomás for Ngozi and save. Then act as guardian **Tomás** | One signed update replaces the guardians. It starts a new voting round, so earlier votes are void. Tomás's own app tells him he is no longer a guardian. Once a countdown has started the settings are locked |
| 10 | With a recovery key: **Settings** → **Use the key Amara saved** → **Start the recovery**. Then either **Skip the recovery delay** → **Finish the recovery**, or go to **Vault** and check in | "I lost my passkey": a new passkey takes over after a public delay. Or the owner's side: an unmissable warning, one check-in cancels the recovery, and the recovery key is retired for good |
| 11 | Act as **Ben**, load his letter, then as Amara change the will, then act as Ben again | The vault emits a `will-changed` event; Ben's page says his letter is out of date and what to do |

Shortcuts: **⌘K** (Ctrl+K) opens a command palette to check in, skip time or act as anyone.
**Reset** starts again.

## 3. Thirty minutes: the code

| To check | Read |
|---|---|
| The contract | [`codicil_vault.compact`](../contracts/src/codicil_vault.compact): each circuit is commented; start at `checkInPasskey` and `claim` |
| Passkeys verified in a circuit | [`lib/WebAuthn.compact`](../contracts/src/lib/WebAuthn.compact) and the real Touch ID test [`webauthn-real.test.ts`](../contracts/test/webauthn-real.test.ts) |
| Private state and witnesses | [`sdk/src/witnesses.ts`](../sdk/src/witnesses.ts) |
| Public vs private | [PRIVACY.md](PRIVACY.md), including the leaks we have not removed yet |
| How it fits together | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Threats and the tests that cover them | [THREAT_MODEL.md](THREAT_MODEL.md) |
| Why it is built this way | [DECISIONS.md](DECISIONS.md) |
| What was validated before building | [VALIDATION.md](VALIDATION.md) |

Optional, slower:

```bash
npm run compile:full          # proving keys for all 16 circuits (about four minutes, about 2.7 GB of keys)
PW_CHANNEL=chrome npm run e2e  # the browser test with Chrome's real WebAuthn API
FC_RUNS=500 npm test -w @codicil/contracts   # longer property tests
```

## 4. Optional: live mode on a test network

The same vault on Midnight Preview or Preprod, through your own Lace wallet, at
**http://localhost:5173/#/app**. Allow half an hour the first time, most of it waiting for DUST.

You need Chrome with [Lace](https://www.lace.io/) on a Midnight test network (Preview is quicker to
start on), tNIGHT from a faucet ([Preview](https://faucet.preview.midnight.network/),
[Preprod](https://midnight-tmnight-preprod.nethermind.dev/)) with "Generate tDUST" turned on, and
Docker with 8 GB of memory.

```bash
npm run compile:full      # after `npm run compile`: proving keys, about 4 minutes, 2.7 GB
docker run -d --name proof-server -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:9.0.2
npm run dev
```

1. Open `http://localhost:5173/#/app` and press **Connect Lace**. If something is missing, the page
   says what and how to fix it: no wallet, another network, no tNIGHT (with the faucet for your
   network), no DUST yet, no proof server.
2. **Create a vault.** On the timers step choose **Trying it out, in minutes**, so a deadline is
   minutes away, not a month.
3. **Seal the will.** Approve the eight transactions in Lace, about three minutes in all. The page
   explains why there are eight. Close the tab in the middle if you like: it continues afterwards.
4. Press **Backup** and save the file. Add some tNIGHT. Press **I'm alive**: the first check-in
   downloads a 448 MB proving key (kept afterwards) and takes about a minute.
5. Copy an heir's invitation link from **Invitations to send**. Open it in another Chrome profile
   with Lace. After the deadline that page offers **Start the switch**, then **Release the will**,
   then **Claim**.

If you would rather not install a wallet, `npm run live:e2e` runs the same store and chain code on a
network from the command line with the throwaway test wallet of [PREPROD.md](PREPROD.md), and writes
every transaction hash to `preprod/results/`.

What is and is not proven here ([VALIDATION.md](VALIDATION.md#live-mode-on-a-network-2026-11-26)):
the app's live store and chain code ran this whole story on Preview with a wallet built from a
seed. In a real browser, with a stand-in for the extension, the screens created a vault and made a
deposit on Preview; the first check-in then crashed the tab, and the app's proof client was
rewritten for it and has not been run on a network since. So **step 4's check-in is the step most
likely to show a problem**, and the Lace extension itself has not been driven by our tooling: if
its behaviour differs from the DApp connector's published types, the connect step is where it
would show. The live code has not been run on Preprod.

## Where to find each rubric item

| Rubric item | Evidence |
|---|---|
| Contract compiles | CI badge in the README; `npm run compile`; full compile results in [VALIDATION.md](VALIDATION.md) |
| Private-state management | [`sdk/src/witnesses.ts`](../sdk/src/witnesses.ts); the witnesses at the top of the contract |
| Dual-ledger understanding | [PRIVACY.md](PRIVACY.md); the Privacy Lens and public inspector in the demo |
| Tests pass | `npm test`; CI; [TESTING.md](TESTING.md) |
| Error handling | Every contract error has a plain message ([ERRORS.md](ERRORS.md)); the demo shows where a transaction failed and offers a retry |
| End-to-end UX | The demo, and the browser test that drives it |
| Product and roadmap | [ROADMAP.md](ROADMAP.md) |
| Business | [BUSINESS.md](BUSINESS.md) |
| Progress this Wave | [WAVES.md](WAVES.md) |

## Known limits

The guided demo runs the contract in the browser, not on a network. Live mode (`#/app`) runs it on
Preview or Preprod; its code has been run end to end on Preview with a wallet from a seed, not yet
with the Lace extension and not yet with a check-in from a browser, and it works at `http://localhost:5173` only because the passkey circuits are compiled
for that origin. In live mode a sealed will, its guardians and its recovery options cannot be
changed yet. Payout amounts are public today. All of this is stated in [PRIVACY.md](PRIVACY.md) and
[ROADMAP.md](ROADMAP.md).
