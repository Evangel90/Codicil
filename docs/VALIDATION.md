# Phase 0: validation log

This file records every gate from the build plan: the command run, the result and any fallback
taken. Results are written down as they happen and never back-filled. **PENDING** means the
gate has not been run yet.

The spike lives in [`codicil-spike/`](../codicil-spike). It contains
`contracts/codicil_spike.compact` (vault), `contracts/p256_multi.compact` (V5) and the
simulator tests in `test/`.

**Machine:** Apple M5 Pro, 15 cores, 24 GB RAM, macOS (Darwin 25.6), Node v26.3.0.

| # | Gate | Status | Date |
|---|---|---|---|
| V1 | Toolchain 0.36.1 / runtime 0.21.x | **PASS** | 2026-11-23 |
| V2 | Spike compiles (`--skip-zk`) | **PASS**: 0 errors, both contracts | 2026-11-23 |
| V3 | Spike tests pass | **PASS**: 60/60, every call also checked against its ZK circuit | 2026-11-24 |
| V4 | Proving cost per circuit | **PASS**: keys for all 9 circuits (sizes below) | 2026-11-23 |
| V5 | 2–3 P-256 checks in one circuit | **PASS**: simulator + constraint check + keys for 1/2/3 checks | 2026-11-23 |
| V6 | WebAuthn binding | **PASS**: 4 real Touch ID assertions (Chrome) verified in-circuit, both clientDataJSON forms | 2026-11-24 |
| V7 | Cardano CIP-30 `signData` | **PASS**: COSE_Sign1 is plain Ed25519; verified in-circuit (real captures checked locally) | 2026-11-24 |
| V8 | Merkle membership | **PASS** (simulator): depth-10 will tree; outsiders rejected | 2026-11-23 |
| V9 | Division | **PASS**: no `/` in Compact; witness quotient + in-circuit check | 2026-11-23 |
| V10 | Unshielded token flow | **PASS** (simulator); Preprod PENDING (V14) | 2026-11-23 |
| V11 | Shielded payout | **PASS** (simulator): recipient hidden; amount still derivable (D8) | 2026-11-23 |
| V12 | Cross-contract call | **PASS** (simulator): escrow → vault hook, 2 proofs per tx; Preprod PENDING | 2026-11-23 |
| V13 | Events visible | **PASS** (simulator); indexer PENDING (V14) | 2026-11-23 |
| V14 | End-to-end on Preprod | PENDING | |
| V15 | Curve25519 Montgomery ⇄ Edwards | **PASS** | 2026-11-23 |

---

## V1: Toolchain

- **Date:** 2026-11-23
- **Install:** `compact-installer.sh` from release `compact-v0.5.3` → `compact update 0.36.1`
- **Output:** `compact 0.5.3`; `compact compile --version` → `0.36.1 (7fa3a117c 2026-11-11)`;
  `--language-version` → `0.28.0`; `--runtime-version` → `0.21.0`.
- **npm:** `@midnight-ntwrk/compact-runtime@0.21.0` (pinned exactly),
  `@midnightntwrk/zkir-v3@3.2.1`, `@midnightntwrk/onchain-runtime-v4@4.0.2`.
- **Result:** PASS. The generated `contract-info.json` records compiler 0.36.1 / language
  0.28.0 / runtime 0.21.0.

## V2: Spike compiles

- **Command:** `npm run compile`, which runs `compact compile --skip-zk` for both contracts.
- **Result:** PASS on the first attempt, with zero errors and zero warnings. A clean compile of
  both contracts takes under 1 s.

## V3: Spike tests

- **Command:** `npm run compile && npm test`
- **Result:** PASS, 28/28 across 4 files (`codicil` 18, `p256_multi` 2, `merkle` 6,
  `curve25519` 2). Wall time is about 1.2 s.
- **Debugging note:** the first run went 25/28. All three failures came from one bug in the
  test harness, not the contract: the harness passed the constructor's `ContractState` to
  `ledger()`, which expects its `ChargedState` (`.data`). Fixed in `test/harness.ts`.
- **ZK constraint checks:** every successful simulated call is also checked against that
  circuit's compiled `.zkir` with `@midnightntwrk/zkir-v3`'s `check`. This is the same method
  the Compact compiler's own test harness uses. A passing test therefore means a proof for that
  exact call can be generated, not just that the JavaScript ran.
- **Negative control:** proof data checked against the wrong circuit is rejected, and so is
  proof data with a tampered input byte. This confirms the check is not a no-op.

## V4: Proving cost

- **Command:** `npm run compile:full`, which runs `compact compile` without `--skip-zk`.
- **Key generation time:** vault (6 circuits) 87.5 s wall; `p256_multi` (3 circuits)
  122.0 s wall.

| Circuit | zkir | prover key | verifier key |
|---|---:|---:|---:|
| `checkInEd25519` | 34 KB | 276 MB | 3.3 KB |
| `checkInPasskey` | 16 KB | 224 MB | 2.7 KB |
| `claim` | 17 KB | 108 MB | 2.6 KB |
| `deposit` | 2 KB | 0.2 MB | 1.3 KB |
| `finalizeRelease` | 3 KB | 0.2 MB | 1.3 KB |
| `triggerTimeout` | 2 KB | 0.2 MB | 1.3 KB |
| `verify1` (1× P-256) | 8 KB | 164 MB | 2.0 KB |
| `verify2` (2× P-256) | 17 KB | 164 MB | 2.0 KB |
| `verify3` (3× P-256) | 25 KB | 328 MB | 2.0 KB |
| `verifyPasskey` (WebAuthn, V6) | 270 KB | 470 MB | 2.7 KB |
| `verifyCip30` (COSE Ed25519, V7) | — | 227 MB | 2.6 KB |

- **Reading:** prover-key size tracks circuit size, rounded up to a power of two. The crypto
  circuits (P-256, Ed25519 + SHA-512, Curve25519 scalar multiplication) are by far the heaviest.
  Plain state transitions cost almost nothing.
- **Follow-up:** proving *time* on the proof server is measured in V14. Large prover keys matter
  for the frontend: keys are fetched per circuit, so the UI must show a "downloading keys"
  progress state.

### Vault (Phase 1), full compile on 2026-11-24

`contracts/src/codicil_vault.compact`: 10 circuits, 143 s on the same machine.

| Circuit | zkir | prover key |
|---|---:|---:|
| `checkInPasskey` / `updateWillPasskey` (WebAuthn: SHA-256 ×3 + P-256) | 287 / 283 KB | 448 MB each |
| `checkInEd25519` / `updateWillEd25519` (CIP-30: Ed25519 over 119 bytes) | 58 / 54 KB | 276 MB each |
| `claim` / `claimAsBackup` (Merkle depth 10, Curve25519 key proof, payout) | 20 / 22 KB | 108 MB each |
| `deposit`, `triggerTimeout`, `finalizeRelease`, `isReleasedForContract` | 2–3 KB | ≤ 0.2 MB |

The passkey circuits are the heaviest. The proof server loads only the key for the circuit being
proven, so a check-in needs at most 448 MB of key material.

## V5: Multiple P-256 checks per circuit

- **Result:** PASS. `verify1/2/3` compile, generate keys, pass the simulator and pass the
  constraint check. If any one signature is bad, the whole call is rejected (`bad signature 2`).
- **Measurement:** 2 checks fit in the same circuit size class as 1 (both 164 MB prover keys).
  3 checks double it (328 MB).
- **Decision:** guardian votes stay **one per transaction**, counted with nullifiers, as the
  brief already planned. That keeps each guardian's proof small. A 2-signature circuit is
  affordable if we later need owner + co-signer in one transaction.

## V6: WebAuthn binding

Captured with `tools/webauthn-capture` (Chrome 157, macOS, Touch ID, origin `http://localhost:5173`);
fixture in `codicil-spike/test/fixtures/webauthn-chrome-macos.json`. Circuit: `contracts/webauthn.compact`.

What a passkey signs is `SHA-256(authenticatorData ‖ SHA-256(clientDataJSON))`. The circuit rebuilds
it and checks:

- `clientDataJSON` begins with `{"type":"webauthn.get","challenge":"` (36 bytes) followed by 43
  base64url characters that decode, in-circuit, to the digest being approved;
- `authenticatorData` starts with our `rpIdHash`, and the flags have **UP and UV** set (Face ID /
  Touch ID was actually used, not just a tap);
- `secp256r1EcdsaVerify` passes for the committed passkey.

**Finding: Chrome's random extra key.** 2 of 5 real captures were 243 bytes instead of 134: Chrome
appends `,"other_keys_can_be_added_here":"do not compare clientDataJSON against a template…"` (109 bytes)
at random. Retrying is not an option at a ~40% rate, so the circuit accepts both forms: the witness
pads to 243 bytes, a `longForm` flag selects which SHA-256 to use, and the short form must have
all-zero padding. Lying about the form breaks the signature check (tested).

`persistentHash<Bytes<N>>` is confirmed to be plain SHA-256 (tested against `@noble/hashes`).

Tests (16): 4 real assertions (two of each form); a different digest, a different relying party,
a flipped origin byte, a false `longForm`, non-zero padding and a different key are all rejected;
edge-case challenges (all-zero, all-`0xff`, `-`/`_` characters) decode correctly; a signature
without UV is rejected. Cost: 470 MB prover key, 46 s compile; the most expensive circuit so far.

**Constraint for Phase 1:** the origin length is fixed per deployment (it changes the 134/243
lengths), so the vault is compiled for the production origin. Safari and Android captures are still
worth collecting before launch.

## V7: Cardano CIP-30 `signData`

Circuit: `contracts/cip30.compact`. Captured with a Nightly wallet (3 signatures).

`signData` returns a COSE_Sign1 whose Ed25519 signature covers the CBOR
`Sig_structure = ["Signature1", protected, h'', payload]`. With a base address (57 bytes) this is
always **119 bytes with the digest at offset 87**. It is plain RFC 8032 Ed25519, so
`ed25519Verify<119>` verifies it directly; no Blake2b or CBOR parsing is needed in-circuit. The circuit
pins the context string and protected-header bytes for domain separation.

All 3 real captures verified with `@noble/curves` and in the circuit. They are **not committed**
(the capture contains a personal mainnet address); the test verifies them only when the local
file exists, and CI uses synthetic signatures with the identical byte layout.

Tests (8): wallet-format signature verifies; a different digest, a different key, and a valid
Ed25519 signature over a non-CIP-30 message are rejected. Cost: 227 MB prover key, 17 s compile.

**Compiler bug found:** exporting a struct with a `Curve25519Point` or `Secp256r1Point` field crashes
compactc 0.36.1 (`print-typescript.ss`). Workaround: don't export the struct. A minimal reproduction
is ready to report upstream.

## V8: Merkle membership

- The stdlib source (`compiler/standard-library.compact`) shows how
  `merkleTreePathRootNoLeafHash` works. It starts from `degradeToTransient(leaf)` and hashes up
  the path with `transientHash<Vector<2, Field>>([left, right])`. When `goes_left` is true, the
  running digest goes on the left.
- `test/crypto.ts › WillTree` builds a depth-10 tree with exactly that hash. Empty subtrees use
  precomputed zero hashes, so a 3-heir tree costs about 13 hashes instead of 1,023.
- **Off-chain:** `test/merkle.test.ts` re-folds every path. Trees of 1, 2, 3, 8 and 33 leaves
  all reach the root; foreign and tampered leaves do not.
- **In-circuit:** in `codicil.test.ts`, heirs claim with a Merkle path + key proof. A
  well-formed leaf from another tree is rejected (`not in will`). Someone who knows the leaf but
  not the heir's key is rejected (`not the heir`).

## V9: Division

- The Compact reference (*Binary arithmetic expressions*) lists only `+`, `-` and `*`, so
  there is **no native division**.
- Approach: the `payoutDivision` witness returns `(q, r)`, and `claim` asserts
  `q * 10000 + r == snapshot * bps` and `r < 10000`.
- **Tests:** 3333 bps of 1,000,001 pays exactly 333,300. A witness that inflates `q` by 1 is
  rejected (`bad payout math`). Across 3 heirs (5000/3333/1667 bps), the total paid is at most
  the snapshot, and the rounding dust left over is less than the number of heirs.

## V10: Unshielded token flow (simulator)

- `deposit` calls `receiveUnshielded(tokenColor, amount)`. The call's effects show the expected
  unshielded input (600 for a 600 deposit).
- `claim` calls `sendUnshielded(tokenColor, q, right(UserAddress))`. The call's
  `claimedUnshieldedSpends` effect pays exactly `q` to the heir's chosen address.
- **Still to do:** a real Preprod run (V14).

## V11: Shielded payout (simulator)

- **Contract:** `contracts/shielded_payout.compact`. `fund(coin)` calls `receiveShielded` and stores
  the coin with `Cell.writeCoin`. `payShielded(recipient, amount)` calls
  `sendShielded(pot, left(recipient), amount)` and writes the change back with `writeCoin`.
- **Compiler finding:** passing the recipient to `sendShielded` needs `disclose()`. The disclosure
  checker says what is revealed: *"a link between a coin spend and the coin with the commitment
  given by a hash of the witness value"*. That is the new coin's commitment, not the key.
- **Tests** (`test/shielded.test.ts`, 4/4 PASS, all constraint-checked):
  - A partial payout spends the pot (1 nullifier), creates the heir coin + change (2 outputs), and
    returns the change to the contract (1 receive). A full payout empties the pot.
  - **The recipient key never appears in the public transcript.** A positive control shows the
    same byte search does find the disclosed coin nonce, so the result is meaningful.
  - **Leak, documented:** a contract-held shielded coin lives in a public `Cell`, so its value is
    public, and `old pot − new pot` reveals the amount paid.
- **Keys** (full compile, 12.8 s): `fund` 22 MB prover, `payShielded` 45 MB prover. Both are
  much lighter than the signature circuits.
- **Wallet note (stdlib docs):** `sendShielded` does not create coin ciphertexts, so only the
  *submitter's own wallet* learns of a coin sent to its key. In Codicil the heir submits their
  own claim to their own `ZswapCoinPublicKey`, so this fits. Confirm on Preprod in V14.
- **Verdict:** PASS on the mechanics. Privacy is better than unshielded (the recipient address is
  hidden), but the amount is not hidden. See D8.

## V12: Cross-contract call (simulator)

- **Contracts:** the vault exports `isReleasedForContract(): Boolean`. It asserts
  `kernel.caller()` is `some(left(contract))` ("callable by contracts only") and returns
  `phase == released`. `contracts/inheritable_escrow.compact` declares
  `contract CodicilVault { circuit isReleasedForContract(): Boolean; }`, stores the vault in a
  ledger field, and gates `withdrawToBeneficiary` on the call.
- **Compile:** both compiled on the first try; the escrow's `declaredInterfaces` records the
  vault interface. Escrow keys (full compile, 4.1 s): `deposit` 0.2 MB, `withdrawToBeneficiary`
  11 MB prover.
- **Harness:** `test/chain.ts` is an in-memory multi-contract chain adapted from the compiler's
  test-center `TestChain`. It acts as state + module provider, installs verifier keys for
  caller/callee key agreement, and constraint-checks **every** circuit in the call tree.
- **Tests** (`test/escrow.test.ts`, 4/4 PASS):
  - Withdrawal is blocked while the vault is armed (`vault not released`).
  - After release it pays the beneficiary, and the transaction contains two checked proofs
    (vault `isReleasedForContract`, then escrow `withdrawToBeneficiary`, in completion order).
  - A wrong beneficiary secret is rejected.
  - A direct user call to the hook is rejected (`callable by contracts only`), because a root
    call sees `kernel.caller() = none`.
- **Debugging notes:**
  - (1) Generated `Contract` constructors validate that every declared witness is a
    function, even for circuits that never call it, so non-beneficiary callers get a throwing stub.
  - (2) `callProofDataTrace` is in completion order (the callee first).
- **Remaining:** Preprod transaction (V14).

## V13: Events (simulator)

- `finalizeRelease` emits `Misc { name: "codicil:released:v1", … }`. The test finds exactly one
  event and the name bytes in its payload.
- **Still to do:** read the event from the indexer on Preprod (V14).

## V15: Curve25519 conversion

- **Command:** `npx vitest run test/curve25519.test.ts`
- **Result:** PASS (2/2).
  - Edwards → Montgomery `u = (1+y)/(1-y)` matches noble's `toMontgomery` for 20 random keys.
  - Montgomery → Edwards recovers the identical point, given the x sign bit, and the runtime
    accepts it (`isValidCurve25519Point`).
  - X25519 shared secrets agree whichever form is used.
- **Note:** X25519 keys carry no x sign bit. An heir importing a bare X25519 key must also supply
  one bit, or the app tries both and matches against the commitment.
