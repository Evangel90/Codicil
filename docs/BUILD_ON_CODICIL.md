# Build on Codicil

A Codicil vault answers one question for other contracts: "have you released?" This page shows two
things a Midnight developer can build with that answer, with the lines to copy.

1. **The release hook.** One line makes your own contract wait for a vault's release.
2. **The seal register.** A contract that hands over the pieces of a key only after the release.
   Use it as it is, or as a pattern.

A vault is *released* when its owner stopped checking in, nobody cancelled during the challenge
window, and someone finalized the release. Until then it is *armed* or *pending*. How that works:
[ARCHITECTURE.md](ARCHITECTURE.md).

## 1. The release hook

The vault exports a circuit that only contracts can call. It returns whether the vault has released
([`codicil_vault.compact`](../contracts/src/codicil_vault.compact)):

```compact
export circuit isReleasedForContract(): Boolean {
  const caller = kernel.caller();
  assert(caller.is_some && caller.value.is_left, "callable by contracts only");
  return phase == Phase.released;
}
```

Your contract declares the one circuit it needs, stores the vault it will ask, and asserts on the
answer. These lines are from the example,
[`inheritable_escrow.compact`](../contracts/src/inheritable_escrow.compact), a savings contract that
pays its beneficiary only after the release:

```compact
contract CodicilVault {
  circuit isReleasedForContract(): Boolean;
}

export ledger vault: CodicilVault;

constructor(v: CodicilVault, color: Bytes<32>, beneficiary: Bytes<32>) {
  vault = disclose(v);
  // ...
}

export circuit withdrawToBeneficiary(recipient: UserAddress): [] {
  assert(!withdrawn, "already withdrawn");
  assert(beneficiaryCommitment(beneficiarySecret()) == beneficiaryCommit, "not the beneficiary");
  assert(vault.isReleasedForContract(), "vault not released");
  withdrawn = true;
  sendUnshielded(tokenColor, held, right<ContractAddress, UserAddress>(disclose(recipient)));
}
```

The interface is structural: any contract that exports a circuit with that name and signature fits
it. Your contract does not import Codicil's source.

What your contract learns is one bit. It never learns who is in the will, who the owner is, or who
the guardians are. What an observer learns is that your contract is linked to that vault.

Deploy it with the vault's address as the first constructor argument. In the tests that is
`vault.encodedAddress` ([`escrow.test.ts`](../contracts/test/escrow.test.ts)).

## 2. The seal register

Money can sit in a contract until a release. A secret cannot, because everything a contract stores
is public. So a sealed message is encrypted off the chain, and people hold its key: half with the
recipient, and the other half cut into pieces, one for each guardian
([D20](DECISIONS.md)). The seal register is the contract those pieces can travel through
([D21](DECISIONS.md)). It is
[`codicil_seals.compact`](../contracts/src/codicil_seals.compact).

When a message is sealed, the register records a fingerprint of the sealed text and a commitment to
each piece. A commitment is a hash that fixes a value without showing it. Handing a piece over is
this circuit:

```compact
export circuit handOver(fingerprint: Bytes<32>, x: Uint<8>, y: Bytes<32>): [] {
  const id = disclose(fingerprint);
  assert(seals.member(id), "no such seal");
  assert(vault.isReleasedForContract(), "vault not released");
  const check = pieceCommitment(id, disclose(x), disclose(y));
  assert(pieceChecks.member(check), "not a genuine piece");
  handedOver.insert(check, Piece { seal: id, x: disclose(x), y: disclose(y) });
}
```

So the register refuses every piece until the vault has released, refuses a piece that matches no
commitment, and writes an accepted piece to the public ledger. Anyone holding a genuine piece can
call it, from any wallet. The guardian does not need to know who the reader is.

The other three circuits belong to the keeper, the device that deployed the register. `seal`
records a sealed text. `unseal` removes one, and is refused after the release. `state` records the
fingerprint of a public statement, which is how the demo's canary works.

### From TypeScript

The SDK has both sides. Sealing is in [`sdk/src/sealed.ts`](../sdk/src/sealed.ts), the register's
arguments and ledger reads in [`sdk/src/seals.ts`](../sdk/src/seals.ts).

```ts
import {
  sealMessage, sealedFingerprint, sealedToText, sealedFromText, openMessageText,
  sealArgs, handOverArgs, piecesHandedOver, sealOn, keeperCommitment, sealsWitnesses,
} from '@codicil/sdk';

// The owner: seal on the device, then record the seal. The plain text goes nowhere.
const { sealed, pieces } = await sealMessage({ vault, message, pieces: 3, needed: 2 });
// call the register's `seal` circuit with:  ...sealArgs(sealed, pieces, now)
// give each guardian one of `pieces`; give the reader sealedToText(sealed)

// A guardian, after the release:
// call `handOver` with:  ...handOverArgs(sealedFingerprint(sealed), piece)

// The reader: collect the pieces from the register's public ledger and open the text.
const onLedger = piecesHandedOver(ledger, sealedFingerprint(sealed));
const text = await openMessageText(sealedFromText(received), onLedger);
```

`keeperCommitment(secret)` is the register's second constructor argument, and
`sealsWitnesses(secret)` supplies that secret to `seal`, `unseal` and `state`. `sealOn(ledger,
fingerprint)` returns what the register holds for one sealed text. A seal carries at most eight
piece commitments.

`sealArgs` sets a "sealed before" time ten minutes ahead of `now`. A Compact circuit cannot read
the block time, only compare it, so the ledger holds an upper bound: the block that accepted the
seal was earlier than that, by less than an hour. `seal` also asks the vault and refuses once it
has released, so every seal on a register predates the release.

A vault does not know its register, and anyone can deploy one that points at any vault. So a
register proves whose it is. Call `provePasskeyOwner` (or `proveWalletOwner`) once after deploying,
with the owner's key and salt as private inputs:

```ts
await call(register, 'provePasskeyOwner', sealsWitnesses(keeperSecret, { passkey: { pk, salt } }));
// Anyone, from the two public ledgers:
registerProvesOwner(vaultLedger, sealsLedger); // true only for the vault owner's register
```

The circuit records the same owner commitment the vault's ledger holds. Producing it takes the
salt, which only the owner has, and the proof reveals neither the key nor the salt. Make the proof
again after the owner's key changes.

### A message for one person, or for everyone

A private message still needs the half of the key only its recipient holds. Publishing the
guardians' pieces opens it for nobody else. For a public disclosure, the sealed text is posted with
its half of the key, so once enough pieces are on the ledger anyone can open it.

## How the tests show it

The contract tests run each circuit in the compiler's simulator and check every successful call
against the compiled ZK circuit, so a passing call is one a proof can be made for
([TESTING.md](TESTING.md)).

A cross-contract call shows up as two circuits in one transaction, the callee first. From
[`seals.test.ts`](../contracts/test/seals.test.ts):

```ts
expect(r.trace).toEqual([
  [w.vault.address, 'isReleasedForContract'],
  [w.register.address, 'handOver'],
]);
```

[`escrow.test.ts`](../contracts/test/escrow.test.ts) shows the same for the savings example, and
that a direct user call to the hook is refused with `callable by contracts only`. The demo runs
both compiled contracts beside the compiled vault in the browser
([`app/src/demo/chain.ts`](../app/src/demo/chain.ts)).

## What has run where

- **The release hook** ran on Preprod and Preview: a withdrawal from the example escrow with two
  proofs in one transaction ([VALIDATION.md](VALIDATION.md), V14).
- **The seal register** runs in the contract tests and in the guided demo. The full compiler
  generates proving keys for its six circuits. It has also run on Preview through the network
  script (`npm run preprod:run -- --seals`): register `d709181d7c271477f322b159474a6491b21cb1381054703636e1ef8aa11f0598`
  beside vault `39cba0b46d2a8baadf6e765005392f0edadc7259928a59eec78dbbce02e9864f`
  ([results](../preprod/results/v14-preview.md)). The app's reader page (`#/read`) reads both with
  no wallet. That register was deployed before the owner proof existed, so the reader reports it
  as not proven. The owner proof has real proofs made locally (`preprod:dryrun -- --seals --prove`)
  and has not yet run on a network.

## Limits to design around

- The hook says released or not. It does not say when, or to whom.
- The register rules the public route, not the people. Guardians can share pieces somewhere else.
- The needed number of guardians, together with the recipient, can open a private message early.
  For a public disclosure the needed number of guardians is enough.
- A piece handed over is public for good.
- The register leaves a trace: that a vault has sealed texts, how many, and how many pieces each
  needs.
- None of this is audited. Codicil runs on Midnight's test networks.

More in [THREAT_MODEL.md](THREAT_MODEL.md). The error messages both contracts raise, with plain
explanations: [ERRORS.md](ERRORS.md).
