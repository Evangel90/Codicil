# Business

## The problem, in numbers

- **Most holders have no plan.** In a 2020 survey of 1,150 crypto investors by the Cremation
  Institute, only 23% had a documented plan for their crypto when they die
  ([report via Yahoo Finance](https://uk.finance.yahoo.com/news/only-23-hodlers-crypto-estate-155050564.html)). A CoinCover survey of 2,000 UK
  self-custody holders with over $10,000 found 52% had made no provision for crypto in their estate
  plans ([report](https://www.coincover.com/hubfs/The%20Crypto%20Inheritance%20Black%20Hole%20Report%20-%20CoinCover.pdf)).
- **Coins are already being lost.** Chainalysis has estimated that around 3.7 million bitcoin may be
  permanently lost, a share of it to owners who died without passing on their keys
  ([Cointelegraph](https://cointelegraph.com/news/lost-bitcoin-may-be-a-donation-but-is-it-hindering-adoption)).
  These are estimates and they vary by study.
- **The usual fixes have costs.** Writing a seed phrase into a paper will hands it to everyone who
  handles the will. Custodial inheritance services require trusting a company with the keys.
  On-chain dead man's switches on public chains publish who the heirs are and what each gets.

## Who it is for

| Segment | Need | Why Codicil |
|---|---|---|
| Self-custody holders | Keep control while alive; family can recover funds after death | Proof of life is one Face ID touch. Nobody else holds the keys |
| Families with significant holdings | Avoid making heirs targets for coercion, scams or family conflict | The will is private; heirs are not named on-chain |
| Wallets and custodians | Offer an inheritance feature without becoming the custodian | The SDK plus the `isReleased` hook: any contract or wallet can integrate |
| Estate lawyers and notaries | Handle crypto in estates they already manage | Act as the attestor; prove facts to courts with selective disclosure |
| DeFi and other protocols on Midnight | Positions that pass on, not just tokens | One cross-contract call makes a position inheritable (`inheritable_escrow`) |

## Why now, and why Midnight

Ledger 9 (Midnight mainnet, November 2026) added the primitives this needs: P-256 for passkeys,
Ed25519 for Cardano wallets, Curve25519, cross-contract calls and events. Passkeys mean proof of life
works with the Face ID people already use every day, with no seed phrase. On a public chain the same
product would publish the will. Midnight's private state is what makes a private will possible.

## Go-to-market

1. **Developers and wallets first.** Publish the SDK and the `isReleased` hook with the escrow
   example. One integration in a Midnight wallet reaches all of its users. Pitch Midnight ecosystem
   wallets directly.
2. **Self-custody users.** The hosted app with passkey check-ins, launched with a tutorial blog post
   and community posts. The public inspector and the Privacy Lens show what stays private without
   asking anyone to trust us.
3. **Professionals.** A referral channel with crypto-aware estate lawyers, who can serve as
   attestors and recommend Codicil to clients.
4. **Cardano holders.** CIP-30 wallet check-ins already work, so Cardano users can protect their
   Midnight assets with the wallet they have.

## Revenue

Proposed, and to be tested with users:

| Stream | How |
|---|---|
| Release fee | A small percentage of the estate, taken only when a will is released. Nothing is charged while the owner is alive and checking in |
| Vault creation | A flat fee at deployment, waived for small estates |
| B2B licensing | White-label vaults and SDK support for wallets and custodians |
| Professional tools | Attestor and executor tools for lawyers and notaries: issuing attestations, disclosure proofs for courts |

The contract does not take fees today. A release fee would be a single extra transfer in
`finalizeRelease` or `pay`; it is on the [roadmap](ROADMAP.md) after the Preprod test.

## Competition

| | Public-chain switches (e.g. Safe modules) | Custodial inheritance services | Paper will with a seed phrase | **Codicil** |
|---|---|---|---|---|
| Heirs private | No, on-chain | Trust the company | No, everyone who handles the will sees it | **Yes, a Merkle root** |
| Owner keeps custody | Yes | No | Yes | **Yes** |
| Proof of life | Wallet transaction, public | Email or app | None | **Face ID, private** |
| False death claims | Varies | Company decides | Executor decides | **Challenge window; one touch cancels** |
| Shares and dates enforced | Partly | By the company | By a court | **By the contract** |

## Scale

Any asset on Midnight today, and assets on other chains later through bridges. The `isReleased`
hook means Codicil does not need to hold every asset: other contracts ask the vault and release
their own positions. Costs to run are low: the app is static and the proving happens on the user's
proof server.

## Risks

| Risk | Response |
|---|---|
| Regulation of inheritance and probate differs by country | Codicil executes the owner's instructions for assets they control; executors can prove facts with selective disclosure. Legal partners per market |
| Users fear a false release | Every trigger only starts a challenge window that one touch cancels; reminders by calendar; the owner chooses the timers |
| Key loss | Passkeys sync across devices; owners can register both a passkey and a wallet; a recovery key is on the roadmap |
| Adoption of a new chain | Cardano wallet support; integrations via wallets rather than a standalone app only |
