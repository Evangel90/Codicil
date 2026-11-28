# Running the vault on Preprod (gate V14)

This is the runbook for the one gate that needs a real network: deploy the vault to Midnight
Preprod, fund it, check in with both key types, let it time out, release it, claim as an heir and
read the release event back from the indexer. The script lives in [`preprod/`](../preprod).

The script uses its own throwaway wallet. It never asks for your real wallet's recovery phrase,
and you should never give it one.

## What you need

| Thing | Why | Where |
|---|---|---|
| Docker, running, with **at least 8 GB of memory** | The proof server runs in it. The passkey check-in proof peaks near 5 GiB | Docker Desktop → Settings → Resources |
| A Blockfrost token for **Midnight Preprod** | Preprod's node and indexer are served by Blockfrost and reject requests without one | [blockfrost.io](https://blockfrost.io), free account |
| One faucet request | 5,000 tNIGHT for the test wallet. The faucet has a captcha, so a person must do it | [Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/) |
| Node 22 or later, `compact` 0.36.1 | Already needed for the rest of the repo | |

If Blockfrost is a problem, use Preview instead: put `MIDNIGHT_NETWORK=preview` in `.env`. Preview
needs no token, has its own [faucet](https://faucet.preview.midnight.network/), runs the same
ledger, and its first wallet sync is much faster. Everything below works the same.

## Steps

1. **Install and compile with proving keys.** The full compile takes about 3 minutes and writes
   about 1.5 GB of keys under `contracts/managed/`.

   ```bash
   npm ci
   npm run compile
   npm run compile:full
   ```

   The order matters. `npm run compile` also builds the test-only contract the unit tests need;
   `compile:full` then adds the keys. Do not run `npm run compile` again afterwards: it deletes
   the keys. (`npm run preprod:check` tells you if that has happened; run `npm run compile:full`
   again to fix it.)

2. **Start the proof server.** Start Docker, then:

   ```bash
   docker run -d --name proof-server -p 127.0.0.1:6300:6300 \
     -v midnight-zk-params:/var/cache/midnight/zk-params \
     midnightntwrk/proof-server:9.0.2
   curl http://localhost:6300/version     # prints 9.0.2
   ```

   The `-v` line keeps downloaded parameters between container restarts.

3. **Get a Blockfrost token.** Sign in at [blockfrost.io](https://blockfrost.io), create a project
   on the **Midnight Preprod** network and copy its project ID. It starts with `nightpreprod`.
   Put it in `.env` at the repo root (copy `.env.example` if there is no `.env` yet):

   ```
   BLOCKFROST_PROJECT_ID=nightpreprod...
   ```

4. **Create the test wallet.**

   ```bash
   npm run preprod:init
   ```

   This writes a new random seed to `.env` (only if none is there) and prints the wallet's address,
   which starts with `mn_addr_preprod1`. The seed is never printed.

5. **Fund the address.** Open the [Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/),
   paste the address, solve the captcha, and request tokens.

6. **Register for DUST and wait for it.** Fees are paid in DUST, which tNIGHT generates only after
   a registration transaction.

   ```bash
   npm run preprod:dust
   ```

   This waits for the tNIGHT, syncs the wallet, registers it, and waits for 20 DUST. Leave it
   running. **The first sync on Preprod is slow**: the Midnight docs report about three and a half
   hours for a new wallet. Progress is saved every few minutes, so you can stop it with Ctrl-C and
   run it again. After the first sync, every later command starts in seconds.

7. **Check.** This lists anything still missing, in order.

   ```bash
   npm run preprod:check
   ```

8. **Run.**

   ```bash
   npm run preprod:run               # the vault: gates V10, V13, V14
   npm run preprod:run -- --escrow   # also the escrow's cross-contract withdrawal: gate V12
   ```

   Leave it running. It prints each step as it happens and a summary table at the end. If it
   stops for any reason, run the same command again: it continues from the last finished step.

## How long the run takes

About **15 minutes** for the vault, and about 3 more with `--escrow`, once the wallet is synced
and holds DUST. Measured on 26 November 2026: 15 minutes for the whole run with `--escrow`, on
both networks. Before that, allow for the wallet's first sync: about 8 minutes on Preview and
2 hours 40 minutes on Preprod, once.

The deployment itself is eight transactions, not one. The vault's sixteen circuits write more
state than a block allows, so the script deploys nine and inserts the other seven afterwards
([D19](DECISIONS.md)). It needs about 30 DUST in all; if the wallet has less, the script says how
much the next transaction needs and waits for it to generate. Seven minutes of that are waits that cannot be skipped, because a real network
has no clock to move forward:

| Wait | Default | Why |
|---|---|---|
| Until the last check-in's deadline passes | 5 min | `triggerTimeout` is only accepted after the deadline |
| Challenge window | 2 min | `finalizeRelease` is only accepted after it |

The contract itself only requires both to be above zero. The defaults are the shortest that leave
room to prove and land each transaction: the last check-in must be included in a block *before*
the deadline it sets. If the first check-in turns out slow on your machine, the script lengthens
the second one's deadline by itself. All timers can be changed in `.env` (see `.env.example`).

The rest is transactions of 20 to 50 seconds each; the real numbers are in the results file.

## Where the results land

| File | What |
|---|---|
| `preprod/results/v14-preprod.md` | Summary: every transaction hash, block, proving time and fee. Safe to commit |
| `preprod/results/v14-preprod.json` | The same, as data |
| `.midnight/codicil/preprod/state.json` | Progress, and the throwaway vault's keys. Gitignored. Do not share |
| `.midnight/codicil/preprod/wallet.json` | Saved wallet sync state. Gitignored |

`npm run preprod:status` shows the progress without touching the network. The results of the
26 November 2026 runs are committed and summarised in [VALIDATION.md](VALIDATION.md) V14.

## What the run does

| Step | Transaction | What it shows |
|---|---|---|
| `deploy` | Deploy `codicil_vault` with a two-heir will (60% / 40%) | The 12 verifier keys are accepted |
| `deposit` | `deposit(10 tNIGHT)` | Unshielded tokens go into a contract (V10) |
| `checkInPasskey` | `checkInPasskey(next)` | A WebAuthn-format assertion is verified in a real proof |
| `checkInEd25519` | `checkInEd25519(next)` | A CIP-30-format signature is verified in a real proof |
| `triggerTimeout` | after the deadline | Anyone can start the countdown |
| `finalizeRelease` | after the challenge window | The vault releases and emits `codicil:released:v1` |
| `claim` | `claim(test wallet address)` | An heir proves their place in the will and is paid 6 tNIGHT (V10) |
| `readEvents` | none | The indexer returns the release event (V13) |
| `escrowDeploy`, `escrowDeposit`, `escrowWithdraw` | with `--escrow` | One transaction, two proofs: the escrow asks the vault (V12) |

The script has no Face ID and no Cardano wallet, so the two check-ins use software keys that sign
in exactly the formats the circuits verify, as the tests do. The proofs are real.

## If something goes wrong

| What you see | What to do |
|---|---|
| `proof server not reachable` | Start Docker and the container from step 2 |
| `HTTP 403 ... Invalid project token` | The Blockfrost ID is wrong, or is for another network. It must start with `nightpreprod` |
| The proof server container exits during `checkInPasskey` | Docker ran out of memory. Give it 8 GB or more and start the container again, then rerun |
| `the wallet did not settle within 600 s` | Blockfrost can take about 5 minutes to confirm the wallet's own transaction. Rerun |
| The log says `the deadline passed before this check-in` | Nothing to do. The script starts the countdown and lets the check-in veto it, which the contract allows |
| The first proof of a size is very slow | The proof server is downloading public parameters (50 MB for the passkey circuit). `run` fetches them before it deploys, so this should only delay the start |
| A check-in fails with `deadline must be in the future` | It landed after its own deadline. Set `CODICIL_FINAL_PERIOD_S` higher and rerun |
| `not enough DUST yet … trying again every minute` | Nothing to do. The script waits for the wallet to generate what the transaction needs (about 2.5 DUST a minute per 5,000 tNIGHT) |
| `Transaction would exhaust the block limits` | The transaction writes too much state for one block. The script prints how many bytes it writes; for a deployment, lower `WRITE_BUDGET` in `preprod/src/staged-deploy.ts` so more circuits are inserted afterwards |
| `Custom error: 110` on a deployment | `VerifierKeyNotSet`: a circuit was declared without its key. See [D19](DECISIONS.md) |
| `wallet sync hit an error and is retrying`, often | The connection to the indexer dropped. It resumes by itself; on Preprod a first sync can take hours |
| You want to start over with a new vault | `npm run preprod:run -- --fresh` (the old run is set aside, not deleted) |
| Lines from libraries are hidden and you want them | `CODICIL_DEBUG=1 npm run preprod:run` |

## The web app's own code on a network

`npm run live:e2e` does for the web app's live mode what `preprod:run` does for the contract. It
drives the app's live store and live chain (the code behind `#/app`) through a vault's whole life on
a real network, with this same test wallet in place of Lace: a staged deployment, a deposit, a
guardian's vote, a passkey check-in, the timeout, the release and an heir's claim, as three separate
stores for the three people. It needs the same setup as above, is resumable (`--fresh` starts a new
vault), takes about 13 minutes, and writes `preprod/results/live-app-<network>.md`.

```bash
MIDNIGHT_NETWORK=preview npm run live:e2e
```

Its timers are `CODICIL_LIVE_EVERY_S` (300) and `CODICIL_LIVE_WINDOW_S` (120).

## Where sealed files are kept: the ar.io sandbox

A sealed file's body is encrypted before it leaves the browser, then stored outside the chain
([D22](DECISIONS.md)). Live mode keeps it on the [ar.io testnet sandbox](https://docs.ar.io/build/testnet/)
(`app/src/live/arweave.ts`, store name `arweave-sandbox`). It needs no wallet and no funds.

- **It is not permanent.** The sandbox never posts to real Arweave and deletes files after about three
  days. A file read after that is "not found", and the app says why.
- **5 MiB per file**, the sandbox's free tier, header and signature included (5,242,724 bytes of body).
  The app refuses anything larger before uploading. Paid uploads are not set up.
- **100 MiB in all per connection.** The free tier also counts per wallet and per IP range (a /24),
  for good. Each upload is signed with a fresh key, so only the IP range limit applies.
- Uploads go to `https://upload.services.ar-io.dev/v1/tx` as signed ANS-104 data items, and are
  read from `https://ar-io.dev/raw/<id>`. A fresh upload is served at once.

```bash
npm run arweave:smoke -w app   # upload 2 KB, read it back, compare hashes
```

Measured on 2026-11-28: a 5,242,880-byte item uploaded free and one byte more was refused with 402;
a 2 KB upload took about 1.5 seconds and was readable at once; an id the gateway does not have is
answered with 504 after about 16 seconds, not 404.

**Arweave mainnet is deferred.** It is the same store with mainnet endpoints, another name (so pointers
say which network holds a file) and funding, which is not built.

## Without a network

`npm run preprod:dryrun -- --escrow` builds every transaction of the run offline, through the same
Midnight.js code a real run uses, and sends nothing. Add `--prove` to also prove them in this
process, which takes about six minutes and downloads about 90 MB of public parameters the first
time. That covers every circuit except the passkey check-in, which is too large for WebAssembly's
4 GiB of memory and needs the proof server. The proofs are made but not checked by a verifier;
only the network does that. It is a check of the script, not a substitute for the gate.

## Versions

Confirmed against the [compatibility matrix](https://docs.midnight.network/relnotes/support-matrix)
on 2026-11-25. Preprod and Preview both run ledger 9.

| Component | Version |
|---|---|
| Compact compiler / language / runtime | 0.36.1 / 0.28.0 / 0.21.0 |
| Midnight.js | 5.0.1 |
| Wallet SDK (`@midnightntwrk/wallet-sdk`) | 2.0.1 |
| Proof server | 9.0.2 |
| Node / indexer on the networks | 2.1.101 / 4.4.101 |
