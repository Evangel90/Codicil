# Architecture

Codicil has three layers: a Compact **contract** that enforces the rules, a TypeScript **SDK** that
holds the private state and builds witnesses, and a React **app** that runs the real contract in the
browser for the demo. This page explains how they fit together. For what is public and what is
private, see [PRIVACY.md](PRIVACY.md); for threats, [THREAT_MODEL.md](THREAT_MODEL.md).

```mermaid
flowchart TB
    subgraph Devices["Each person's own device (private)"]
      O["Owner: passkey (Face ID) · Cardano wallet · the will"]
      H["Heir: heir key + letter"]
      G["Guardian: guardian secret"]
    end
    subgraph SDK["@codicil/sdk (TypeScript)"]
      WB["will builder · Merkle tree"]
      WI["witnesses (private state → circuit inputs)"]
      SG["signing helpers: WebAuthn · CIP-30"]
      LT["heir letters (encode, decode, check)"]
    end
    subgraph Chain["Midnight public ledger"]
      V["codicil_vault<br/>commitments · will root · deadline<br/>guardian root · nullifiers · estate"]
      E["inheritable_escrow (or any contract)"]
    end
    O --> WB & SG
    H --> LT
    O & H & G --> WI
    WI -- "ZK proof + public transcript" --> V
    E -- "isReleasedForContract()" --> V
```

## Repository layout

| Path | Role |
|---|---|
| [`contracts/src/codicil_vault.compact`](../contracts/src/codicil_vault.compact) | The vault: 16 exported circuits, 12 pure helpers |
| [`contracts/src/lib/WebAuthn.compact`](../contracts/src/lib/WebAuthn.compact) | Passkey assertion verification, generic over the site origin's lengths |
| [`contracts/src/lib/Cip30.compact`](../contracts/src/lib/Cip30.compact) | Cardano CIP-30 `signData` verification (COSE_Sign1, plain Ed25519) |
| [`contracts/src/inheritable_escrow.compact`](../contracts/src/inheritable_escrow.compact) | Example integrator using a cross-contract call |
| [`contracts/test/`](../contracts/test) | Simulator tests; every successful call is also checked against the ZK circuit |
| [`sdk/src/`](../sdk/src) | Keys, commitments, will builder, witnesses, signing, letters, error catalogue |
| [`app/src/`](../app/src) | Web app: landing page, setup wizard, owner / heir / guardian / public views, Privacy Lens |
| [`preprod/`](../preprod) | Gate V14: the vault end to end on a real network with Midnight.js and the wallet SDK ([PREPROD.md](PREPROD.md)) |
| [`codicil-spike/`](../codicil-spike) | Phase 0 validation spike, kept as a record ([VALIDATION.md](VALIDATION.md)) |
| [`tools/webauthn-capture/`](../tools/webauthn-capture) | Page that captured the real passkey and wallet signatures used as test fixtures |

## The contract

### State machine

```mermaid
stateDiagram-v2
    [*] --> Armed: constructor(VaultConfig)
    Armed --> Armed: checkInPasskey / checkInEd25519
    Armed --> Armed: updateWillPasskey / updateWillEd25519
    Armed --> Armed: updateSettingsPasskey / updateSettingsEd25519
    Armed --> Armed: deposit, guardianAttest (below threshold)
    Armed --> Armed: startRecovery / finishRecovery (before the deadline)
    Armed --> Pending: triggerTimeout (deadline + grace period passed)
    Armed --> Pending: guardianAttest (k-th vote)
    Armed --> Pending: triggerAttestation (attestor signature)
    Pending --> Armed: check-in (owner veto)
    Pending --> Released: finalizeRelease (window over)
    Released --> Released: claim / claimAsBackup
```

### Ledger

All of it is public. The design goal is that nothing here identifies a person
([PRIVACY.md](PRIVACY.md) explains each field).

| Group | Fields |
|---|---|
| Owner | `ownerPasskeyCommit`, `ownerEdCommit` (salted commitments; zero = that key type disabled), `passkeyRpIdHash` (the website), `nonce` (owner actions so far) |
| Recovery | `recoveryKeyCommit` (zero = no recovery key), `recoveryDelay`; for a recovery that was started: `recoveryReadyAt`, `recoveryNonce` (the owner `nonce` at that moment), `recoveryPasskeyCommit`, `recoveryEdCommit`, `recoveryNextKeyCommit` |
| Will | `willRoot` (Merkle root of the heir entries), `willVersion` |
| Timers | `phase`, `deadline`, `maxPeriod`, `challengeWindow`, `claimWindow`, `gracePeriod` (0 = none), `pendingUntil`, `releasedAt` |
| Estate | `tokenColor`, `estateTotal`, `estateSnapshot` (frozen at release, after the fee), `estatePaid` (capped at the snapshot), `feeBps` and `feeRecipient` (the optional release fee; 0 = none) |
| Claims | `claimNullifiers` (one per claimed will entry) |
| Guardians | `guardianRoot`, `guardianThreshold` (k), `guardianRound`, `guardianVotes`, `guardianNullifiers` |
| Attestor | `attestorKeyCommit` |

### Circuits

| Circuit | Who calls it | Authorisation | Effect |
|---|---|---|---|
| `checkInPasskey(next)` | Owner | WebAuthn assertion over `aliveDigest(vault, next, nonce)`, from the committed passkey, on the committed website, with Face ID / Touch ID | Moves the deadline (at most `maxPeriod` from now), bumps the nonce, voids guardian votes; vetoes a pending switch; cancels a recovery in progress. Allowed until the deadline plus the grace period, and during any challenge window |
| `checkInEd25519(next)` | Owner | CIP-30 signature over the same digest from the committed wallet key | Same |
| `updateWillPasskey(root)` / `updateWillEd25519(root)` | Owner | Signature over `willUpdateDigest(vault, root, nonce)` | Replaces the will root; only while armed and before the deadline. Cancels a recovery in progress. Emits `codicil:will-changed:v1` |
| `updateSettingsPasskey(settings)` / `updateSettingsEd25519(settings)` | Owner | Signature over `settingsDigest(vault, settings, nonce)` | Replaces the guardian root, the threshold and the attestor commitment together; starts a new guardian round; cancels a recovery in progress; only while armed and before the deadline |
| `startRecovery(passkeyCommit, edCommit, nextRecoveryCommit, asOf)` | Whoever holds the recovery secret | Knowledge of the secret behind `recoveryKeyCommit`; fresh timestamp | Proposes new owner keys, effective after `recoveryDelay`; replaces an earlier proposal; emits `codicil:recovery-started:v1`. Only while armed, and only if it can finish before the deadline |
| `finishRecovery()` | Anyone | The delay is over; still armed and before the deadline | Installs the proposed owner keys and the next recovery key |
| `deposit(amount)` | Anyone | None | Receives unshielded tokens while armed |
| `triggerTimeout()` | Anyone | The deadline and the grace period have passed | Starts the challenge window, counted from the end of the grace period |
| `guardianAttest(asOf)` | A guardian | Merkle membership in `guardianRoot`, one nullifier per guardian per round | Counts a vote; the k-th vote starts the challenge window |
| `triggerAttestation(asOf)` | Anyone holding an attestation | P-256 signature from the committed attestor over `attestationDigest(vault, round)` | Starts the challenge window |
| `finalizeRelease()` | Anyone | Challenge window over | Releases; sends the release fee, if one is set; snapshots what remains; emits `codicil:released:v1` |
| `isReleasedForContract()` | Other contracts only | `kernel.caller()` must be a contract | Returns whether the vault is released |
| `claim(to)` | An heir | Merkle membership in `willRoot`, knowledge of the heir key's secret, unlock date reached, unused nullifier | Pays `snapshot × shareBps / 10000` to `to` |
| `claimAsBackup(to)` | A backup heir | Same, with the backup key, and only after `claimWindow` | Pays the same share; shares the nullifier, so heir and backup cannot both be paid |

The 12 exported pure circuits (`passkeyCommitment`, `edKeyCommitment`, `recoveryCommitment`,
`heirLeafHash`, `aliveDigest`, `willUpdateDigest`, `settingsDigest`, `claimNullifier`, `guardianLeaf`, `guardianNullifier`, `attestorCommitment`,
`attestationDigest`) are called by the SDK, so TypeScript never re-implements a hash.

### Grace period

`gracePeriod` is optional ([D15](DECISIONS.md)). When it is set, an owner who misses the deadline can
still check in normally until `deadline + gracePeriod`, and `triggerTimeout` is refused until then, so
a check-in that is a day late does not put the vault into a public countdown. Guardians and the
attestor are not delayed. The will stays locked from the deadline itself. With `gracePeriod = 0` the
vault behaves as it did before the option existed.

### Signing first, proving second

An owner action has two steps ([D10](DECISIONS.md)):

```mermaid
sequenceDiagram
    participant App
    participant Passkey as Passkey (Face ID)
    participant SDK
    participant Vault as codicil_vault
    App->>Vault: read nonce, deadline (public)
    App->>SDK: checkInDigest(vault, next, nonce)
    SDK-->>App: 32-byte digest (from the contract's pure circuit)
    App->>Passkey: navigator.credentials.get(challenge = digest)
    Passkey-->>App: assertion (authenticatorData, clientDataJSON, signature)
    App->>SDK: store the approval in private state
    App->>Vault: checkInPasskey(next) with witnesses
    Note over Vault: verifies commitment, rpIdHash, UV flag,<br/>challenge = digest, P-256 signature
    Vault-->>App: deadline moved; public transcript has no key, salt or signature
```

The circuit rebuilds the WebAuthn message in-circuit. It checks that `clientDataJSON` is a
`webauthn.get` whose base64url challenge decodes to the digest, and that `authenticatorData` carries
the site's `rpIdHash` and the user-present and user-verified (Face ID / Touch ID) flags. It then
hashes `clientDataJSON` with SHA-256, appends that to `authenticatorData`, hashes again and verifies
the P-256 signature. Chrome sometimes lengthens `clientDataJSON`, so
the module accepts both lengths for the origin ([VALIDATION.md](VALIDATION.md) V6). The origin's
lengths are module parameters (`WebAuthn<134, 243>` for `http://localhost:5173`), which is why a
hosted deployment needs a recompile for its own origin ([D12](DECISIONS.md)).

### The will

Each heir entry is a `HeirLeaf { heirKeyCommit, backupKeyCommit, shareBps, unlockAt, salt }`. The SDK
builds a depth-10 Merkle tree (up to 1,024 entries) of `heirLeafHash(leaf)` values; empty slots are
zero. Only the root goes on-chain.

An heir's identity is a Curve25519 key ([D3](DECISIONS.md)). The leaf stores
`edKeyCommitment(publicKey, salt)`. To claim, the heir supplies the secret scalar as a witness and the
circuit recomputes the public key with `ecMulGenerator`, so the claim proves possession of the key
without revealing it.

The payout needs a division, which Compact lacks. The witness supplies quotient and remainder; the
circuit checks `q × 10000 + r == snapshot × bps` and `r < 10000` ([D2](DECISIONS.md)), and that total
payouts never exceed the snapshot.

### Release fee

A vault can be deployed with a release fee ([D16](DECISIONS.md)): `feeBps` basis points of the estate,
at most 10%, sent to `feeRecipient` by `finalizeRelease`. The fee is computed with the same checked
division, rounded down, and the snapshot becomes `estateTotal − fee`. Heirs' shares are taken of that
snapshot, so the payout maths above is unchanged and `fee + all claims ≤ estateTotal`. With
`feeBps = 0` there is no transfer and no witness call, and the snapshot is the whole estate.

### Heir letters

The owner gives each heir a **letter**: `codicil:claim:v1:` followed by 461 bytes in base64url (vault
address, the heir's leaf, its Merkle path). It fits in a QR code. It does not contain the heir's
secret key, which the heir keeps separately, so neither works alone
([`sdk/src/letter.ts`](../sdk/src/letter.ts)).

The heir's device checks a letter using public data only (`checkHeirLetter`): the vault address
matches, the path leads to the current `willRoot` (an old letter fails after the will changes), and
the heir's own key opens the leaf as heir or as backup. Nothing is sent anywhere.

Every will update emits a `codicil:will-changed:v1` event ([D14](DECISIONS.md)). An heir's app that
follows the vault can then re-run the check and tell the heir to ask the owner for a new letter. The
event has no payload: it says that the will changed, never how.

### Guardians and the attestor

A guardian holds a random secret. The guardian root is a Merkle tree of `guardianLeaf(secret)`.
A vote proves membership and publishes `guardianNullifier(vault, secret, round)`, which changes every
round and differs between vaults, so votes cannot be linked to each other or to a guardian. Any
check-in bumps the round, which voids all earlier votes and attestations ([D13](DECISIONS.md)).
Guardians vote in separate transactions to keep each proof small ([D6](DECISIONS.md)).

The owner can replace the guardian root, the threshold and the attestor commitment with a signed
settings update ([D17](DECISIONS.md)). The owner signs the complete new settings, so to change one
value the app starts from `currentSettings(ledger)`. Every settings update starts a new guardian
round: votes cast under the old set or threshold stop counting, and so do attestations signed
before it. A guardian who was kept needs a new Merkle path from the owner; their app can tell with
`isCurrentGuardian`.

### Recovery key

An owner who loses every registered key can get back in with a recovery key ([D18](DECISIONS.md)): 32
random bytes kept offline, with only `recoveryCommitment(secret)` on the ledger.

```mermaid
sequenceDiagram
    participant R as Recovery secret holder
    participant V as codicil_vault
    participant O as Current owner key (if any)
    R->>V: startRecovery(new key commitments, next recovery key)
    Note over V: recoveryReadyAt = now + recoveryDelay<br/>event codicil:recovery-started:v1
    alt the owner still has a key
      O->>V: any check-in, will update or settings update
      Note over V: nonce moves: recovery cancelled, recovery key retired
    else nobody objects before recoveryReadyAt
      R->>V: finishRecovery() (anyone can send it)
      Note over V: owner keys replaced, next recovery key installed
    end
```

A recovery stands only while the owner `nonce` is the one recorded when it started. Every owner
action moves the nonce, so cancelling costs the owner circuits nothing, and a key whose recovery was
cancelled can never start another. `recoveryStatus()` in the SDK reads this from the ledger.

The recovery key never touches the switch. It acts only while the vault is armed and before the
deadline; it cannot delay a timeout, veto a countdown, or act once guardians or an attestor have
started one. A recovery that could not finish before the deadline is refused when it starts. With
`recoveryKeyCommit` all zeros there is no recovery key and none of this applies.

### Cross-contract hook

`inheritable_escrow` declares the vault's interface and calls `isReleasedForContract()` before paying
its beneficiary. Any Midnight contract can make a position inheritable this way. Both proofs go in
one transaction ([`escrow.test.ts`](../contracts/test/escrow.test.ts)). The demo's **Savings** tab
runs this for real: the compiled escrow next to the compiled vault, refused before the release and
paid after it.

## The SDK

| Module | Purpose |
|---|---|
| [`keys.ts`](../sdk/src/keys.ts) | P-256 and Ed25519 keys and salts in the runtime's exact shapes |
| [`webauthn.ts`](../sdk/src/webauthn.ts), [`cip30.ts`](../sdk/src/cip30.ts) | Convert real passkey assertions and wallet `signData` results to circuit inputs |
| [`config.ts`](../sdk/src/config.ts) | Origin, relying party id and the two `clientDataJSON` lengths |
| [`owner.ts`](../sdk/src/owner.ts) | Digests the owner signs (check-in, will, settings), computed by the contract's pure circuits |
| [`will.ts`](../sdk/src/will.ts), [`merkle.ts`](../sdk/src/merkle.ts) | Will builder, Merkle tree and paths, `rootFromPath` |
| [`guardians.ts`](../sdk/src/guardians.ts) | Guardian set and per-guardian paths |
| [`recovery.ts`](../sdk/src/recovery.ts) | Recovery secret, its commitment, config limits and `recoveryStatus()` from public ledger fields |
| [`witnesses.ts`](../sdk/src/witnesses.ts) | `CodicilPrivateState` and the witness functions the circuits call |
| [`letter.ts`](../sdk/src/letter.ts) | Heir letter encoding, decoding, fingerprint and on-device check |
| [`errors.ts`](../sdk/src/errors.ts) | Every contract `assert` message mapped to plain language ([ERRORS.md](ERRORS.md)) |
| [`events.ts`](../sdk/src/events.ts) | Names of the events the vault emits, and `vaultEventName()` to recognise one |

## The app

The app is React + Vite with hand-written CSS tokens (the "Obsidian" design: dark and light themes,
works on phones).

- **Landing page** (`#/`): a scrolling page over a WebGL point field that changes shape with each section.
- **Demo** (`#/demo`): an eight-step setup wizard, then the vault from four points of view: the
  owner (Amara), an heir (Ada, Ben, Cleo, Kofi), a guardian, and "Anyone" (the public inspector).
  The owner has three more tabs: Will, Settings (guardians, attestor and the recovery key) and Savings.

### What the demo runs

[`app/src/demo/chain.ts`](../app/src/demo/chain.ts) runs the **compiled vault contract** in the
browser against an in-memory ledger with a clock the demo can move forward. Each action executes the
same circuit code and produces the same public transcript a real transaction would. Only proof
generation and network submission are skipped. The passkey is real when the browser supports it:
Face ID / Touch ID signs, and the circuit verifies the signature.

The same chain holds a second compiled contract, `inheritable_escrow` (shown as "Harbour Savings"),
and is the state and module provider for cross-contract calls, so a withdrawal runs the escrow
circuit and, inside it, the vault's `isReleasedForContract` circuit against the vault's current
state. The runtime's cross-contract path uses Node's `Buffer` for hex, so
[`buffer-shim.ts`](../app/src/demo/buffer-shim.ts) supplies those two conversions in the browser.

[`app/src/demo/store.ts`](../app/src/demo/store.ts) holds the world (chain, keys, will, letters held
by heirs, the proof each guardian holds, the saved recovery key) and exposes it to React through
`useSyncExternalStore`. Every action goes through a
transaction sheet with the real stages (prepare, approve, run the circuit, proof, record), so a
failure shows where it happened and in plain words.

The store deploys with the release fee off and the owner's choice of grace period and recovery key
(`VAULT_OPTIONS_OFF`, `recoveryConfig`). What the screens show about them comes from the SDK and the
ledger, not from the store's memory: `timeoutOpensAt` for when the switch can start,
`recoveryStatus` for the recovery key, `isCurrentGuardian` for each guardian's own proof, and the
events each call emitted (`vaultEventName`), which is how an heir's page learns that a will changed.
A settings update is signed like a check-in (`settingsDigest`); a recovery makes a new passkey, as a
new device would, and installs it only when `finishRecovery` succeeds.

Pure helpers keep the views simple and testable:
[`guide.ts`](../app/src/demo/guide.ts) (who acts next, on time / in grace / expired, what to try on the savings screen, the will in plain words, presets),
[`recoveryKey.ts`](../app/src/demo/recoveryKey.ts) (the recovery key as text with a check for typing mistakes),
[`commands.ts`](../app/src/demo/commands.ts) (the ⌘K palette),
[`ics.ts`](../app/src/demo/ics.ts) (calendar reminders made on the device).

### From demo to network

Going live replaces the in-memory chain with Midnight.js providers (wallet, proof server, indexer)
and keeps the SDK, witnesses and views. The same step has been done from the command line: gate V14
([VALIDATION.md](VALIDATION.md)) ran the vault on Preprod, deploying it in stages because it does
not fit one block ([D19](DECISIONS.md)). The app's own network mode is next on the
[roadmap](ROADMAP.md) and can reuse that provider wiring
([`preprod/src/providers.ts`](../preprod/src/providers.ts), [PREPROD.md](PREPROD.md)).
