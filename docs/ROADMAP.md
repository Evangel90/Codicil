# Roadmap

Each phase has a definition of done. A phase is closed only when its tests pass in CI and its
results are written down ([VALIDATION.md](VALIDATION.md), [DECISIONS.md](DECISIONS.md)).

## Milestones

| Phase | Deliverable | Done when | Status |
|---|---|---|---|
| 0 | Validation gates V1–V15: every Midnight primitive Codicil relies on | Each gate passes or has a recorded fallback | ✅ 15 of 15. V14 (end-to-end on Preprod) passed on 26 Nov 2026 |
| 1 | Vault core: check-ins by passkey and wallet, timeout, release, claim, events | Full compile with proving keys; tests; CI green | ✅ |
| 2 | Multi-heir will: shares, tranches, backup heirs, will updates, payout maths | Simulator and property tests | ✅ Property tests found and fixed a design flaw (D9) |
| 3 | Hidden k-of-n guardians, veto, attestation trigger | Tests; threat model | ✅ 12 circuits full-compiled; [THREAT_MODEL.md](THREAT_MODEL.md) |
| 4 | Web app with an end-to-end demo | Full lifecycle in the UI; browser tests | ✅ In-browser demo of the real contract. 🟡 Live mode (`#/app`): built, run end to end on Preview from a script; a browser check-in and Lace itself still to be proven |
| 5 | Cross-contract `isReleased` hook and the inheritable escrow | Multi-contract test; a Preprod transaction | ✅ Simulator, and a Preprod transaction with two proofs ([VALIDATION.md](VALIDATION.md) V14) |
| 6 | Docs, pitch, blog post | README and docs complete; deck and video | 🟡 Docs done; deck, video and blog in progress |
| 7 | Stretch (below) | Each with tests and docs | ⚪ |

## Next

1. **Done: Preprod (V14).** The vault ran end to end on Preprod and Preview on 26 November 2026,
   with software keys in the passkey and wallet formats. It deploys in stages, because it does not
   fit one block ([D19](DECISIONS.md)).
2. **Give up the maintenance key after deployment**, so nobody can change a deployed vault's
   circuits ([D19](DECISIONS.md), [THREAT_MODEL.md](THREAT_MODEL.md)).
3. **Built: live mode in the app** (`#/app`). A person creates and uses their own vault on Preview or
   Preprod through Lace; heirs and guardians act from their own browsers with an invitation. Its
   store and chain code ran end to end on Preview with a wallet built from a seed. What it does not
   do yet is listed [below](#live-mode-what-it-does-not-do-yet).
4. **Finish proving live mode**: a check-in from a browser with the app's own proof client, a run on
   Preprod, and a first run with the Lace extension by hand, with fixes for whatever they show.
5. **Hosting.** Recompile the passkey module for the production origin (its lengths are module
   parameters, [D12](DECISIONS.md)) and deploy the static app.
6. ~~**Heirs create their own keys** on their own devices, and send the owner only a commitment.~~
   Done in live mode ([D22](DECISIONS.md)): heirs and guardians answer an invitation with a reply,
   and the owner seals their letter to them. The guided demo still makes them on the owner's device.
   Next: **keepers**, services that watch a vault and hand over guardians' pieces without being
   asked, and a direct **switch off the passkey** circuit, which waits for the next contract change
   so the vault is recompiled and redeployed once (today a recovery can replace the passkey with a
   wallet key, after the delay).
7. **Sealed messages, disclosures and the seal register in live mode.** The demo seals a message for
   one person or for everyone, and hands the key's pieces over by hand or through the seal register
   ([D20, D21](DECISIONS.md)). The register's circuits compile with full keys, and it has not been
   deployed to a network. Live mode needs the register deployed beside a live vault, the sealed text
   and the pieces carried in the guardian and heir invitations, and storage outside the app for
   texts larger than a short message, and for files.

## Live mode: what it does not do yet

Stated plainly, so nobody relies on it for more than it is.

- **It has not been run with the Lace extension.** The whole flow ran on Preview with a wallet built
  from a seed. The adapter for the real extension ([`app/src/live/lace.ts`](../app/src/live/lace.ts))
  is written from the DApp connector 4.1.0 types. In particular, how Lace answers `connect` when it
  is on a different network than the one asked for is an assumption.
- **A check-in from a browser has not succeeded on a network yet.** The first attempt crashed the
  tab and the proof server ran out of memory at the same moment
  ([VALIDATION.md](VALIDATION.md#live-mode-on-a-network-2026-11-26)). The app's proof client was
  rewritten so the 448 MB key is never held in the page; that is tested offline and in a browser
  without a network, and not yet with a real proof.
- **It has not been run on Preprod.** Nothing in it is specific to Preview, but it has not been tried.
- **Test networks only**, and they can be reset. Tokens have no value.
- **Localhost only.** The passkey circuits are compiled for `http://localhost:5173`
  ([D12](DECISIONS.md)). On any other origin the app offers a key stored in the browser, which is
  weaker than a passkey.
- **A sealed will cannot be changed.** The contract supports changing the will, the guardians and
  the attestor; the demo shows them. Live mode does not offer them yet, and deploys with no release
  fee. Its records hold the will as key fingerprints, so a later will change works the same for
  heirs who made their own keys.
- ~~**No recovery key.**~~ Every live vault now has one, derived from the owner's root, so the
  printed recovery code replaces a lost passkey after a public delay (a quarter of the check-in
  period, one to seven days). With testing timers the delay (at least a day, the contract's floor)
  is longer than the time to the deadline, so a recovery there cannot finish, and the app says so.
- ~~**The owner's device makes the heirs' keys.**~~ By default each heir and guardian makes their
  own and the owner holds only fingerprints. "Make their keys for them" remains for trying the app
  alone; then whoever holds an heir's invitation can claim that share.
- ~~**Secrets live in the browser's local storage, unencrypted.**~~ Records are encrypted under the
  person's root; Face ID (where WebAuthn PRF is supported) or the printed recovery code opens them,
  and the backup file needs no passphrase.
- **Face ID unlock has not been tried with a real passkey provider.** It is tested with Chrome's
  virtual authenticator. Browsers and providers without PRF fall back to the code, which then has to
  be typed at each visit.
- **Unlocking with Lace is likely unavailable.** The connector's `signData` signs with BIP-340
  Schnorr by default, which normally adds fresh randomness, so the app refuses the wallet unless two
  signatures agree. It has not been tried with Lace.
- **The maintenance key is kept**, in the owner's record and backup. Whoever holds it could change
  the vault's rules ([D19](DECISIONS.md)). Giving it up after deployment is item 2 above.
- **Deposits cannot be taken back out**, and a claim pays the wallet the heir is connected with, so
  the payment is visibly from the vault to that address.
- **The activity list is local.** It shows what was done from this browser, not what others did.
  Events from the network (a will change, a recovery) are not followed yet.
- **A proof server must be running on the person's own machine**, and the first check-in downloads
  a 448 MB key.
- **Only the owner's passkey can check in.** The wallet-key check-in the contract supports is not
  offered in live mode.

## After that

- **Contract improvements.** They change the circuits, so a vault must be redeployed to get them;
  each is merged only once it is built, tested and reviewed. ✅ marks the ones that are built:
  - ✅ notice to heirs' apps when the will changes (an event, [D14](DECISIONS.md));
  - ✅ an optional grace period between the deadline and the switch ([D15](DECISIONS.md));
  - ✅ an optional release fee ([BUSINESS.md](BUSINESS.md), [D16](DECISIONS.md));
  - ✅ owner-signed updates to guardians and the attestor ([D17](DECISIONS.md));
  - ✅ a recovery key, in its smallest safe form ([D18](DECISIONS.md)). Still open: a recovery that
    can outlast the deadline (for a loss discovered late), and owner-signed rotation of a single
    lost key.
- **Hiding payout amounts** with pre-split shielded coins or batched claims ([D8](DECISIONS.md)).

## Stretch (Phase 7)

- **Unlinkable check-ins:** a liveness registry so observers cannot tell which vault checked in.
- **Sealed files:** the demo seals short texts with the key split among guardians (D20, D21).
  Larger files need the sealed bytes stored on IPFS or Arweave, with only the fingerprint on the
  register.
- **Executor disclosure:** prove single facts about the will to a court or tax authority without
  revealing the rest ([PRIVACY.md](PRIVACY.md)).

## How the work is divided

The work splits into four tracks, each with its own tests:

| Track | Scope |
|---|---|
| Contracts | `contracts/`: circuits, modules, simulator and property tests, full compiles |
| SDK | `sdk/`: keys, witnesses, signing formats, will builder, letters, errors |
| App | `app/`: design, wizard, views, demo chain, browser tests; live mode after V14 |
| Docs and pitch | `docs/`, README, deck, video, blog, community posts |
