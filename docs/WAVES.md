# Progress by Wave

## Wave 3 (November 2026): first submission

Everything in this repository was built during Wave 3. It is a new project, not a fork.

**Validation first (23–24 Nov).** Before building, we tested every Midnight primitive the design
depends on in a throwaway spike ([`codicil-spike/`](../codicil-spike), [VALIDATION.md](VALIDATION.md)):

- Real Face ID / Touch ID passkey signatures verify inside a circuit. We found that Chrome
  randomly lengthens the signed browser data and made the verifier accept both forms.
- Real Cardano wallet (CIP-30) signatures verify inside a circuit.
- Merkle membership, payouts without integer division, shielded payouts, cross-contract calls,
  events and Curve25519 key conversion all work. 14 of 15 gates pass; the Preprod end-to-end gate
  is next.
- We found a Compact compiler crash and worked around it.

**Contracts (24 Nov).** The vault: passkey and wallet check-ins, will updates, timeout, hidden k-of-n
guardians, an attestation trigger, owner veto, release, multi-heir claims with tranches and backup
heirs, a payout cap and the cross-contract hook. Plus `inheritable_escrow` as an integration example.
104 simulator tests, each successful call checked against the ZK circuit; property tests found a
design flaw that is now fixed ([D9](DECISIONS.md)).

**SDK (24 Nov).** Witnesses, will builder, passkey and wallet format conversion, heir letters, and
an error catalogue with plain-language messages for every contract error.

**App (24 Nov).** A web app that runs the real contract in the browser:

- a landing page whose 3D point field changes shape as you scroll through how it works;
- a seven-step setup wizard with presets and a plain-words review that flags risky choices;
- owner, heir, guardian and public views, a Privacy Lens, and a guide to who acts next;
- check-ins with real Face ID / Touch ID, will changes, printable heir letters with QR codes that
  heirs check on their own device, calendar reminders, and a ⌘K command palette;
- dark and light themes; works on phones;
- browser tests that use Chrome's real WebAuthn API.

**Docs.** README, [ARCHITECTURE](ARCHITECTURE.md), [PRIVACY](PRIVACY.md),
[THREAT_MODEL](THREAT_MODEL.md), [TESTING](TESTING.md), [DECISIONS](DECISIONS.md) (D1–D13),
[ERRORS](ERRORS.md), [ROADMAP](ROADMAP.md), [BUSINESS](BUSINESS.md),
[JUDGES_QUICKSTART](JUDGES_QUICKSTART.md).

**Not done yet, stated plainly:** the Preprod deployment (V14) and the app's live network mode,
hosting, and the deck, video and blog post. Payout amounts are not hidden yet ([PRIVACY.md](PRIVACY.md)).

**What changed since the last Wave:** Codicil started in Wave 3 (first commit 23 Nov 2026), so there is no earlier version to compare against.
