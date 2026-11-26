# Judges' quickstart

Three ways to evaluate Codicil, from five minutes to a full review. Everything runs locally; no
wallet or test tokens are needed.

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

Expected: four suites, **186 + 34 + 37 + 87 = 344 passed**, in about 10 seconds. The contract suite
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

The web demo runs the contract in the browser, not on a network. The same contract ran end to end
on Preprod from a script on 26 November 2026 ([results](../preprod/results/v14-preprod.md)); the
app's own network mode is next. Payout amounts are public today. Both are stated in [PRIVACY.md](PRIVACY.md) and
[ROADMAP.md](ROADMAP.md).
