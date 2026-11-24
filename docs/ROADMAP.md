# Roadmap

Each phase has a definition of done. A phase is closed only when its tests pass in CI and its
results are written down ([VALIDATION.md](VALIDATION.md), [DECISIONS.md](DECISIONS.md)).

## Milestones

| Phase | Deliverable | Done when | Status |
|---|---|---|---|
| 0 | Validation gates V1–V15: every Midnight primitive Codicil relies on | Each gate passes or has a recorded fallback | ✅ 14 of 15. V14 (end-to-end on Preprod) is next |
| 1 | Vault core: check-ins by passkey and wallet, timeout, release, claim, events | Full compile with proving keys; tests; CI green | ✅ |
| 2 | Multi-heir will: shares, tranches, backup heirs, will updates, payout maths | Simulator and property tests | ✅ Property tests found and fixed a design flaw (D9) |
| 3 | Hidden k-of-n guardians, veto, attestation trigger | Tests; threat model | ✅ 12 circuits full-compiled; [THREAT_MODEL.md](THREAT_MODEL.md) |
| 4 | Web app with an end-to-end demo | Full lifecycle in the UI; browser tests | ✅ In-browser demo of the real contract. Live network mode follows V14 |
| 5 | Cross-contract `isReleased` hook and the inheritable escrow | Multi-contract test; a Preprod transaction | 🟡 Simulator done; Preprod transaction with V14 |
| 6 | Docs, pitch, blog post | README and docs complete; deck and video | 🟡 Docs done; deck, video and blog in progress |
| 7 | Stretch (below) | Each with tests and docs | ⚪ |

## Next

1. **Preprod (V14).** Deploy the vault with Midnight.js, check in with a real passkey through the
   proof server, run the lifecycle, claim, and record transaction hashes and proving times.
2. **Live mode in the app.** Swap the in-browser chain for Midnight.js providers (Lace wallet, proof
   server, indexer). The SDK, witnesses and screens stay the same.
3. **Hosting.** Recompile the passkey module for the production origin (its lengths are module
   parameters, [D12](DECISIONS.md)) and deploy the static app.
4. **Heirs create their own keys** on their own devices, and send the owner only a commitment.
   Today the demo generates heir keys for the owner.

## After that

- **Contract improvements** (held until after the Preprod test so the deployed circuits are the
  tested ones):
  - notice to heirs' apps when the will changes (an event);
  - an optional grace period between the deadline and the switch;
  - an optional release fee ([BUSINESS.md](BUSINESS.md));
  - owner-signed updates to guardians and the attestor ([D13](DECISIONS.md));
  - a recovery key.
- **Hiding payout amounts** with pre-split shielded coins or batched claims ([D8](DECISIONS.md)).

## Stretch (Phase 7)

- **Unlinkable check-ins:** a liveness registry so observers cannot tell which vault checked in.
- **Sealed digital legacy:** letters and passwords encrypted and stored on IPFS or Arweave, with the
  key split among guardians and released with the will.
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
