# Gate V14 on preview

Status: **complete**.

- Generated: 2026-11-26T00:52:03.125Z
- Vault contract: `df8ba3d21b106c41d9deb603c58e97101716595d22bbc351882dfc90c0c6f6d4`
- Escrow contract: `aceee253536d2932a0cb116be7feeaaa61d84bfd41334b544cd1138cade1cdd4`
- Test wallet: `mn_addr_preview1ucfa5n7sadm7xtfhdukmqt30fd2a375q8lmtmhyl8dp7wv4eep5s22l0fp`
- Timers: first deadline 1200 s, max period 1200 s, final period 300 s, challenge window 120 s
- Midnight.js: 5.0.1
- Wallet SDK: 2.0.1
- compact-runtime: 0.21.0
- Compact compiler: 0.36.1
- Proof server: 9.0.2
- Node: Midnight Preview 2.1.101-bbd616b1, ledger 1.0.1
- Indexer protocol version: 2001100

| step            | block  | tx hash                                                          | status          | prove s | balance s | confirm s | total s | fee DUST  |
| --------------- | ------ | ---------------------------------------------------------------- | --------------- | ------- | --------- | --------- | ------- | --------- |
| deploy          | 272832 | 46dc33d1d44180e106be7a77a1f2a812eded26f776d5e437f6b0ce2b5e40b2c2 | SucceedEntirely | 0.0     | 0.8       | 1.0       | 160.4   | 12.827226 |
| deposit         | 272859 | dc9134b9c9305b3c046a67a52044846756086f63911641417b8246067f3262fc | SucceedEntirely | 2.1     | 1.0       | 1.1       | 23.0    | 0.425159  |
| checkInPasskey  | 272867 | 40ec872c8e997bcbb5c2cfa2bb909294a3fdcb233aa1edeb2ffbdeff6e1ec279 | SucceedEntirely | 27.9    | 0.9       | 1.3       | 48.2    | 0.252700  |
| checkInEd25519  | 272873 | 497ce2763d0b95b8d8003bb29870e4028498d450c2aa9bcd70fea21e39298e53 | SucceedEntirely | 15.6    | 0.8       | 1.2       | 35.9    | 0.262027  |
| triggerTimeout  | 272924 | e6d23ff5273d039fa6682a5fc7a1d3ab307fe5f46f4c9a90e2c0bdb96adeeeaa | SucceedEntirely | 0.4     | 1.1       | 1.3       | 305.8   | 0.240717  |
| finalizeRelease | 272944 | ecfd18186225c0673dbeaa209cb3e543634889df2cc4539e932c4ee8b3b1a3a6 | SucceedEntirely | 2.2     | 1.1       | 1.3       | 120.1   | 0.254556  |
| claim           | 272949 | 3d307ebfaf6868dd2674cd9f143095d6d8cd3bd650f6b655376e275fcbe06a66 | SucceedEntirely | 6.7     | 1.0       | 1.3       | 30.7    | 0.530826  |
| readEvents      | -      | -                                                                | no tx           | -       | -         | -         | 0.3     | -         |
| escrowDeploy    | 272953 | e8c41e57cc1d19a17331fa2cafe87eae267c6ad0b64dc82c918117ca7bb8e777 | SucceedEntirely | 0.0     | 0.8       | 0.8       | 22.1    | 2.876202  |
| escrowDeposit   | 272957 | efc7ff6df64808032de7294ca991047a4e54026ecd56ec0b9bcf86aa31c03ee5 | SucceedEntirely | 0.4     | 1.5       | 1.0       | 22.9    | 0.473568  |
| escrowWithdraw  | 272961 | 59959b95e21dc2b7deafe61ab7f4f774d9f0c9f8e21d4b4d14a712672d125825 | SucceedEntirely | 1.9     | 1.0       | 0.9       | 25.2    | 0.503287  |

Totals: 10 transactions, 18.646274 DUST in fees, 57.1 s proving contract circuits, 794.7 s in steps (waits excluded).

Release event read back from the indexer (gate V13): `codicil:released:v1`, type Misc, event id 160700, payload version 1, protocol version 2001100.

## Notes

- deploy: vault address df8ba3d21b106c41d9deb603c58e97101716595d22bbc351882dfc90c0c6f6d4
- deploy: first deadline 2026-11-26T00:58:46.000Z
- deploy: deployed in 8 transactions: all at once it would use 97% of a block's write limit, so 7 verifier keys were inserted afterwards (updateSettingsEd25519 63b9449c1cc613d84cfb9c49fd76d0f8e8a2a2527acc8ab62965b31b64972dae; updateSettingsPasskey 785de9cfc481a1e5019d2041d557cf58392128a5ea7c7ccf95b32dbc61345126; startRecovery e76926b695e8c409b7ae9efd7d9bf0c04fcf1e87867aad004a4876e0230ea0b3; finishRecovery 146c3180a6f8ead0e8af67a8ec57fa3cb20bb245a442f0baeb7d71f193b9872c; updateWillEd25519 d3a1571d17f3fef5928084dd52266133d511009b038d418650d070c22cbdfa69; updateWillPasskey 774c540f715976973e44b390ca8abd8812f82d26e57c57edcfd583fdbfb51dd6; triggerAttestation aa0d49d485234e46c3f5f5212ec183a97929e0f06d84435b72fb61d268963287)
- deposit: deposited 10.000000 tNIGHT; the indexer shows the vault holding 10.000000
- checkInPasskey: WebAuthn-format assertion (software P-256 key, origin and UV flag as compiled) verified in-circuit
- checkInPasskey: deadline moved from 1795654726 to 1795654851; nonce 0 → 1
- checkInEd25519: CIP-30-format signature (software Ed25519 key over the 119-byte Sig_structure) verified in-circuit
- checkInEd25519: deadline moved from 1795654851 to 1795654059 (5 min after it was built); nonce 1 → 2
- triggerTimeout: deadline 1795654059 passed; vault is pending until 1795654179
- finalizeRelease: released at 1795654179; estate snapshot 10.000000 tNIGHT
- finalizeRelease: 1 event(s) emitted while executing the circuit
- claim: heir 0 (6000 bps of 10.000000) claimed 6.000000 tNIGHT to mn_addr_preview1ucfa5n7sadm7xtfhdukmqt30fd2a375q8lmtmhyl8dp7wv4eep5s22l0fp
- claim: estatePaid 0.000000 → 6.000000
- claim: the indexer's record of this transaction lists 1 created UTXO(s), none matching the payout exactly: check by hand
- readEvents: indexer returned the "codicil:released:v1" event (id 160700) for the vault
- readEvents: found by the finalizeRelease transaction hash ecfd18186225c0673dbeaa209cb3e543634889df2cc4539e932c4ee8b3b1a3a6
- escrowDeploy: escrow address aceee253536d2932a0cb116be7feeaaa61d84bfd41334b544cd1138cade1cdd4, vault df8ba3d21b106c41d9deb603c58e97101716595d22bbc351882dfc90c0c6f6d4
- escrowDeposit: deposited 5.000000 tNIGHT into the escrow
- escrowWithdraw: 2 proofs in one transaction, callee first: df8ba3d2…:isReleasedForContract, aceee253…:withdrawToBeneficiary
- escrowWithdraw: withdrew 5.000000 tNIGHT to the test wallet once the vault answered "released"
- escrowWithdraw: the indexer lists the matching unshielded UTXO in this transaction
