# Codicil

[![CI](https://github.com/Evangel90/Codicil/actions/workflows/ci.yml/badge.svg)](https://github.com/Evangel90/Codicil/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**On every other blockchain, your will is public. Codicil is an inheritance protocol where your
heirs, their shares and your proof that you're alive all stay private, enforced by
zero-knowledge proofs on [Midnight](https://midnight.network).**

Self-custodied crypto is lost when its owner dies. Existing on-chain "dead man's switches" publish
who the heirs are, what each gets and when the owner is active, which makes families targets.
Codicil keeps the will private. The owner proves they are alive with **Face ID / Touch ID** (a
passkey) or a **Cardano wallet**, verified inside a ZK circuit. If they stop, heirs can claim
their share privately once the owner has had a chance to veto.

> **Status (Wave 3, in progress):** contracts and SDK for the vault core, multi-heir wills,
> tranches, backup heirs and the cross-contract hook are built and tested (106 tests, every call
> checked against its ZK circuit). Guardians, the attestation trigger, the web app and the Preprod
> deployment are next. See [What changed this Wave](#what-changed-this-wave).
> Demo video, deck and live demo: *coming with the app*.

## Judge quickstart

Requirements: Node 22+ and the [Compact toolchain](https://docs.midnight.network/) (compiler 0.36.1).

```bash
git clone https://github.com/Evangel90/Codicil.git && cd Codicil
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/download/compact-v0.5.3/compact-installer.sh | sh
compact update 0.36.1
npm ci
npm run compile     # compiles the Compact contracts (--skip-zk: seconds, not minutes)
npm test            # contracts + SDK, about 5 s
```

`npm run compile:full` also generates the proving keys (several minutes; sizes in
[docs/VALIDATION.md](docs/VALIDATION.md)).

## How it works

```mermaid
stateDiagram-v2
    [*] --> Armed: deploy (owner key commitments + will root)
    Armed --> Armed: checkIn (passkey or wallet proof of life)
    Armed --> Pending: triggerTimeout (deadline passed, anyone)
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
    end
    K --> SDK
    W --> SDK
    SDK -- "ZK proof (no secrets)" --> V
    E -- "isReleasedForContract()" --> V
```

- **Owner** registers a passkey and/or a Cardano wallet. Only salted *commitments* to the keys go
  on-chain.
- **Will**: each heir entry (key commitment, share, unlock date, optional backup heir, salt) is a
  leaf of a Merkle tree. Only the root is on-chain. Each heir privately receives their own leaf
  and path.
- **Check-in** signs `aliveDigest(vault, nextDeadline, nonce)`. The circuit checks the signature
  against the committed key without revealing it. Replays fail because the nonce moves.
- **Release**: anyone can start the countdown after a missed deadline. The owner can veto during
  the challenge window. After that the estate is snapshotted.
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
| [`contracts/test/`](contracts/test) | Simulator, property and cross-contract tests |
| [`sdk/src/`](sdk/src) | Witnesses, will builder, passkey/wallet conversion, error catalogue |
| [`codicil-spike/`](codicil-spike) | Phase 0 validation spike (gates V1–V15) |
| [`tools/webauthn-capture/`](tools/webauthn-capture) | Page used to capture real passkey and wallet signatures |
| [`docs/`](docs) | Validation results, design decisions, error catalogue |

## Midnight integration

| Midnight feature | Used for | Where |
|---|---|---|
| Dual ledger: public ledger plus private witnesses | Only commitments, the will root, deadlines and nullifiers are public | [`codicil_vault.compact:56`](contracts/src/codicil_vault.compact#L56), witnesses [`:76`](contracts/src/codicil_vault.compact#L76) |
| `persistentCommit` (salted commitments) | Hide owner and heir public keys | [`codicil_vault.compact:108`](contracts/src/codicil_vault.compact#L108) |
| Merkle proofs (`merkleTreePathRootNoLeafHash`) | Prove "my share is in the will" without saying which | [`codicil_vault.compact:268`](contracts/src/codicil_vault.compact#L268) |
| Nullifiers (`Set<Bytes<32>>`) | One claim per share, unlinkable to the heir | [`codicil_vault.compact:282`](contracts/src/codicil_vault.compact#L282) |
| **P-256** `secp256r1EcdsaVerify` (Ledger 9) | Face ID / Touch ID passkey check-ins | [`lib/WebAuthn.compact:99`](contracts/src/lib/WebAuthn.compact#L99) |
| **SHA-256** `persistentHash` over raw bytes | Rebuild the WebAuthn signed message in-circuit | [`lib/WebAuthn.compact:96`](contracts/src/lib/WebAuthn.compact#L96) |
| **Ed25519** `ed25519Verify` (Ledger 9) | Cardano wallet (CIP-30) check-ins | [`lib/Cip30.compact:38`](contracts/src/lib/Cip30.compact#L38) |
| **Curve25519** `ecMulGenerator` (Ledger 9) | Heirs prove they hold their key | [`codicil_vault.compact:274`](contracts/src/codicil_vault.compact#L274) |
| **`kernel.caller()`** (Ledger 9) | The integrator hook answers only contracts | [`codicil_vault.compact:254`](contracts/src/codicil_vault.compact#L254) |
| **Cross-contract calls** (Ledger 9) | `inheritable_escrow` asks the vault before paying out | [`inheritable_escrow.compact:49`](contracts/src/inheritable_escrow.compact#L49) |
| **Events** `emit` (Ledger 9) | Heir apps and indexers learn of a release | [`codicil_vault.compact:248`](contracts/src/codicil_vault.compact#L248) |
| Block time (`blockTimeGte` / `blockTimeLt`) | Deadlines, challenge window, tranches | [`codicil_vault.compact:175`](contracts/src/codicil_vault.compact#L175) |
| Unshielded tokens (`receiveUnshielded` / `sendUnshielded`) | Hold the estate, pay heirs | [`codicil_vault.compact:230`](contracts/src/codicil_vault.compact#L230), [`:292`](contracts/src/codicil_vault.compact#L292) |
| Generic modules | Passkey verifier parameterised by the site origin | [`codicil_vault.compact:28`](contracts/src/codicil_vault.compact#L28) |

## What is public and what is private

| Data | Where it lives | Who can see it |
|---|---|---|
| Owner passkey / wallet public key | Private; only a salted commitment on-chain | Owner only |
| Will (heirs, shares, unlock dates, backups) | Private; only the Merkle root on-chain | Owner; each heir learns only their own entry |
| Deadline, phase, counters | Public ledger | Everyone (reveals that *a* vault is alive, not *whose*) |
| Claims | Public nullifier; payout to an address the heir chooses | Everyone sees *that* a share was claimed, not by which heir |
| Payout amount | Public (unshielded transfer) | Everyone. Hiding amounts is on the roadmap ([D4, D8](docs/DECISIONS.md)) |

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
| [`properties.test.ts`](contracts/test/properties.test.ts) | fast-check: random wills, estates and claim orders; the owner can always veto |
| [`escrow.test.ts`](contracts/test/escrow.test.ts) | Cross-contract hook: two proofs in one transaction |
| [`webauthn-real.test.ts`](contracts/test/webauthn-real.test.ts) | Real Touch ID assertions verified by the vault's own WebAuthn module |
| [`errors.test.ts`](contracts/test/errors.test.ts) | Every contract error has a friendly UI message and is documented |
| [`sdk/test`](sdk/test) | Passkey/wallet format conversion, will builder, witnesses |

The property tests already found one design flaw, now fixed ([D9](docs/DECISIONS.md)).

## Validation results

Before building, we validated every Midnight primitive Codicil depends on (15 gates; 14 pass,
end-to-end on Preprod is pending). Highlights:

- Real **Touch ID** signatures verify in-circuit. Chrome randomly lengthens the signed browser
  data (in 2 of 5 captures), so the verifier accepts both forms.
- Real **Cardano wallet** `signData` signatures verify in-circuit (119-byte COSE structure).
- We found a Compact compiler crash (exporting a struct containing `Curve25519Point` or
  `Secp256r1Point`) and worked around it.

Full results, key sizes and fallbacks: [docs/VALIDATION.md](docs/VALIDATION.md).
Design decisions: [docs/DECISIONS.md](docs/DECISIONS.md). Error catalogue: [docs/ERRORS.md](docs/ERRORS.md).

## Roadmap

1. Hidden guardians (k-of-n, nullifier votes) and a signed attestation trigger, both followed by
   the owner's challenge window.
2. Web app: create a vault, check in with Face ID, heir claim page, a "privacy lens" showing what
   is public, plus a demo mode.
3. End-to-end deployment on Preprod.
4. Stretch: unlinkable check-ins, a sealed digital legacy (encrypted letters with keys split among
   guardians), and executor disclosures for courts and tax authorities.

## What changed this Wave

- Phase 0: 15 validation gates, 14 passing, with real passkey and wallet captures.
- Vault contract: passkey and wallet check-ins, will updates, timeout, veto, release, multi-heir
  claims with tranches and backup heirs, a payout cap, and the cross-contract hook.
- TypeScript SDK with witnesses, will builder, passkey/wallet conversion and an error catalogue.
- 106 tests with ZK constraint checks, including property tests. CI on every push.

## License and attribution

Apache License 2.0, see [LICENSE](LICENSE).

Built on [Midnight](https://midnight.network): the [Compact](https://github.com/midnightntwrk/compact)
language and compiler, [`@midnight-ntwrk/compact-runtime`](https://www.npmjs.com/package/@midnight-ntwrk/compact-runtime),
and `@midnightntwrk/zkir-v3` / `@midnightntwrk/onchain-runtime-v4` for constraint checks. The
multi-contract test chain (`contracts/test/support/chain.ts`) is adapted from the Compact
compiler's test-center (Apache-2.0).
