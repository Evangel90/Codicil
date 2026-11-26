# Gate V14 on preprod

Status: **complete**.

- Generated: 2026-11-26T00:58:03.615Z
- Vault contract: `4f3b21e1c8117afd7f874885139d18bd19bede372be425b0536dcb848cc2c853`
- Escrow contract: `c937e24b6ae8f391713652b321e04b82901b77ff12edc58f114a1dd51a54a933`
- Test wallet: `mn_addr_preprod1ucfa5n7sadm7xtfhdukmqt30fd2a375q8lmtmhyl8dp7wv4eep5s2tpl6u`
- Timers: first deadline 1200 s, max period 1200 s, final period 300 s, challenge window 120 s
- Midnight.js: 5.0.1
- Wallet SDK: 2.0.1
- compact-runtime: 0.21.0
- Compact compiler: 0.36.1
- Proof server: 9.0.2
- Node: Midnight Preprod 2.1.101-913ec011, ledger 1.0.1 (tag: crate-ledger-9.1.0.1, rev: 3e69c5e3092fa29c1e8b1728a68fc3ca98774e34)
- Indexer protocol version: 2001100

| step            | block   | tx hash                                                          | status          | prove s | balance s | confirm s | total s | fee DUST  |
| --------------- | ------- | ---------------------------------------------------------------- | --------------- | ------- | --------- | --------- | ------- | --------- |
| deploy          | 3580086 | 04bbb303ae2ba26d93617d88a729d0ec727643ea2637635fd3c381fe1a74e199 | SucceedEntirely | 0.0     | 0.8       | 0.7       | 155.3   | 12.830047 |
| deposit         | 3580112 | 82f8f81f19e677a0f981a16cbb7863381007cfb04647e81ce9018a8cedca196f | SucceedEntirely | 0.3     | 1.0       | 1.0       | 24.1    | 0.425159  |
| checkInPasskey  | 3580120 | 3ca41743e21e60b149e76925657f6a089b099c6ecda9bf15c7bad182ffdfec78 | SucceedEntirely | 26.6    | 1.1       | 1.4       | 46.7    | 0.252877  |
| checkInEd25519  | 3580126 | e4086dacece91adffbcfbedd7c7ed99cb9128d9ccde4014db50f7861e5c349e5 | SucceedEntirely | 13.6    | 1.0       | 1.2       | 36.4    | 0.261769  |
| triggerTimeout  | 3580177 | aaf34649ca7551e4917f284daa32250d3bc8bbe087a78fd4995cfbf332a179ac | SucceedEntirely | 0.4     | 0.8       | 1.6       | 306.5   | 0.240691  |
| finalizeRelease | 3580197 | 634a49c0bb08d98beaf81a8d7fc41709e81781fe7e42db79a490d66dfeeea1d1 | SucceedEntirely | 0.4     | 1.1       | 1.3       | 119.6   | 0.254604  |
| claim           | 3580202 | cb355c10aea63d3b07bd27200869863630e19b83fa8ac88c0a8b83d6dac9f93b | SucceedEntirely | 6.4     | 1.1       | 1.7       | 30.1    | 0.530821  |
| readEvents      | -       | -                                                                | no tx           | -       | -         | -         | 0.2     | -         |
| escrowDeploy    | 3580206 | 150ca65400c0411a037e87b35de367fc6c5df18b00aac679d7ca1fa902147eed | SucceedEntirely | 0.0     | 0.8       | 1.7       | 24.6    | 2.876580  |
| escrowDeposit   | 3580210 | 9d3059674f395fe67f4d189fcbcdea352f6aae5ef6dbb5f597ab7c332c9f5f31 | SucceedEntirely | 0.4     | 1.3       | 1.1       | 21.3    | 0.473562  |
| escrowWithdraw  | 3580214 | e5638da379896070cbb16f5ea770818b90ef45a9c9e114f4dffe7d5facd8128a | SucceedEntirely | 1.2     | 1.7       | 1.1       | 25.2    | 0.582322  |

Totals: 10 transactions, 18.728436 DUST in fees, 49.2 s proving contract circuits, 789.9 s in steps (waits excluded).

Release event read back from the indexer (gate V13): `codicil:released:v1`, type Misc, event id 2104553, payload version 1, protocol version 2001100.

## Notes

- deploy: vault address 4f3b21e1c8117afd7f874885139d18bd19bede372be425b0536dcb848cc2c853
- deploy: first deadline 2026-11-26T01:04:50.000Z
- deploy: deployed in 8 transactions: all at once it would use 97% of a block's write limit, so 7 verifier keys were inserted afterwards (updateSettingsEd25519 599e08ae69693ac236a12511e6f5e75d3b46a699ef65c72d62aa385a07c18b0e; updateSettingsPasskey 9ad7cf7149719a4d56280a3d698e10874d710c416c3bc9b8eee645b2fc5137eb; startRecovery 388ac33c8d6f22b5fec476598d20cd330d675fb46c871024791f0c26f5eb73a9; finishRecovery 7af473ad93c5f7f16127e813302d83a642c92610d6b9b1b40b780d1732fbc178; updateWillEd25519 56b49d17da2084a6b68708225aec54532f37f9e4a6b4a3669d65feb5572f156e; updateWillPasskey fb8c1df8e5c0e5c9cb84028753c62fb233861ebf9ecfdfa8a143de84d71aba9c; triggerAttestation a6ea60748082d065af28529a996a30eca3dd63eca2b3315b5eb7c77ad307fca0)
- deposit: deposited 10.000000 tNIGHT; the indexer shows the vault holding 10.000000
- checkInPasskey: WebAuthn-format assertion (software P-256 key, origin and UV flag as compiled) verified in-circuit
- checkInPasskey: deadline moved from 1795655090 to 1795655212; nonce 0 → 1
- checkInEd25519: CIP-30-format signature (software Ed25519 key over the 119-byte Sig_structure) verified in-circuit
- checkInEd25519: deadline moved from 1795655212 to 1795654419 (5 min after it was built); nonce 1 → 2
- triggerTimeout: deadline 1795654419 passed; vault is pending until 1795654539
- finalizeRelease: released at 1795654539; estate snapshot 10.000000 tNIGHT
- finalizeRelease: 1 event(s) emitted while executing the circuit
- claim: heir 0 (6000 bps of 10.000000) claimed 6.000000 tNIGHT to mn_addr_preprod1ucfa5n7sadm7xtfhdukmqt30fd2a375q8lmtmhyl8dp7wv4eep5s2tpl6u
- claim: estatePaid 0.000000 → 6.000000
- claim: the indexer's record of this transaction lists 1 created UTXO(s), none matching the payout exactly: check by hand
- readEvents: indexer returned the "codicil:released:v1" event (id 2104553) for the vault
- readEvents: found by the finalizeRelease transaction hash 634a49c0bb08d98beaf81a8d7fc41709e81781fe7e42db79a490d66dfeeea1d1
- escrowDeploy: escrow address c937e24b6ae8f391713652b321e04b82901b77ff12edc58f114a1dd51a54a933, vault 4f3b21e1c8117afd7f874885139d18bd19bede372be425b0536dcb848cc2c853
- escrowDeposit: deposited 5.000000 tNIGHT into the escrow
- escrowWithdraw: 2 proofs in one transaction, callee first: 4f3b21e1…:isReleasedForContract, c937e24b…:withdrawToBeneficiary
- escrowWithdraw: withdrew 5.000000 tNIGHT to the test wallet once the vault answered "released"
- escrowWithdraw: the indexer lists the matching unshielded UTXO in this transaction
