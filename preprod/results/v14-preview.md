# Gate V14 on preview

Status: **complete**.

- Generated: 2026-11-27T11:48:53.330Z
- Vault contract: `39cba0b46d2a8baadf6e765005392f0edadc7259928a59eec78dbbce02e9864f`
- Seal register: `d709181d7c271477f322b159474a6491b21cb1381054703636e1ef8aa11f0598`
- Sealed text fingerprint on the register: `b457509beb147f2c8c89b9f7e208cc96b42c75046749ee87e38e9dab4710b5d5`
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
| deploy          | 293774 | 1081d7d03ced62ec25c0191bbecf760e5f0774deb4a4d5d1e12f35d3121af7ac | SucceedEntirely | 0.0     | 1.2       | 1.2       | 186.1   | 12.831157 |
| deposit         | 293805 | 275acdf6a3ef2dd9411e040451d16527e28f46f9b2f0fbbabaf07388dbec80b4 | SucceedEntirely | 0.7     | 2.0       | 1.3       | 21.3    | 0.425159  |
| checkInPasskey  | 293818 | ed4178f1da04c9fd30f8f482a3a7469cb399e2f63c766af520bad4362acc578d | SucceedEntirely | 56.4    | 1.1       | 1.6       | 79.0    | 0.252949  |
| sealsDeploy     | 293822 | 5d87d816a723cc38bb3915e7143e4d7a824884eec286e9f992645561ad5bea26 | SucceedEntirely | 0.0     | 1.6       | 0.9       | 23.4    | 5.609038  |
| sealsSeal       | 293826 | 4d5e57053d4109b8387ef5ca7c01ace84f1d08d2877d4ffc33a9761e86a43246 | SucceedEntirely | 1.6     | 2.4       | 1.2       | 24.3    | 0.711978  |
| sealsRefused    | -      | -                                                                | no tx           | -       | -         | -         | 2.0     | -         |
| checkInEd25519  | 293834 | 3b6f6449d3a723de520bd30405181159d0c87b925e6a7a4d2b05380ad0044eb7 | SucceedEntirely | 25.8    | 1.7       | 1.7       | 46.6    | 0.261769  |
| triggerTimeout  | 293883 | 3c626c95af723473b560094b4b7dcd60c5eaa8ca3ff3bc14823a897faa2a501b | SucceedEntirely | 0.5     | 1.1       | 1.8       | 293.8   | 0.240677  |
| finalizeRelease | 293903 | 56f364555c7c0f8c20b3cbf04f5b263f91c710109e916e95f688f72396415741 | SucceedEntirely | 0.7     | 1.3       | 1.4       | 119.8   | 0.254556  |
| claim           | 293909 | f872b424bb6d31b0e4741261a112cc7e15c628c5bd1a376564c827725b03644f | SucceedEntirely | 10.0    | 1.7       | 1.7       | 36.4    | 0.530861  |
| readEvents      | -      | -                                                                | no tx           | -       | -         | -         | 0.3     | -         |
| sealsHandOver1  | 293913 | b8ce11b896259bfa8ec36a9de8e784816816bc15b325ad4cd4fcbbb6de043064 | SucceedEntirely | 1.6     | 1.1       | 1.4       | 23.4    | 0.526045  |
| sealsHandOver2  | 293917 | 0dd79e59edd74dc7b929b9c5c7cd8ad16ca537dfed7e080c05e8359a2fe1ce0a | SucceedEntirely | 1.2     | 1.2       | 1.3       | 24.0    | 0.605277  |
| sealsOpen       | -      | -                                                                | no tx           | -       | -         | -         | 2.4     | -         |

Totals: 11 transactions, 22.249471 DUST in fees, 98.3 s proving contract circuits, 882.6 s in steps (waits excluded).

Release event read back from the indexer (gate V13): `codicil:released:v1`, type Misc, event id 186462, payload version 1, protocol version 2001100.

## Notes

- deploy: vault address 39cba0b46d2a8baadf6e765005392f0edadc7259928a59eec78dbbce02e9864f
- deploy: first deadline 2026-11-27T11:54:09.000Z
- deploy: deployed in 8 transactions: all at once it would use 97% of a block's write limit, so 7 verifier keys were inserted afterwards (updateSettingsEd25519 17dbc0c93a7bcd3ecee067145a97c6d9b7ea9defa3dc16b22509adde95851b44; updateSettingsPasskey 76a411431e85ad0b19413b815ce239e0e906128fc172f043445fcf4069d751e8; startRecovery 649a92e19f0747585f6a58f53a969689e32c103119b408797d8a938ea1a8e9af; finishRecovery 16a4f792f439ecfa68c88432d67b1960ba5083049da32a56c8ff559d99e8987a; updateWillEd25519 ce6d7dcfe321f04fbb57a5b4481b92f3b8389a2452612e2577df4b4ce7bf5731; updateWillPasskey 9903e141f730558643db66a61c411885e8c3779c32f43cc725ac37b2dd38bcaf; triggerAttestation ffe38a1b648d5012e2673303f64ed4d57958cc4e243e39427d31023d9694f2a4)
- deposit: deposited 10.000000 tNIGHT; the indexer shows the vault holding 10.000000
- checkInPasskey: WebAuthn-format assertion (software P-256 key, origin and UV flag as compiled) verified in-circuit
- checkInPasskey: deadline moved from 1795780449 to 1795780598; nonce 0 → 1
- sealsDeploy: seal register address d709181d7c271477f322b159474a6491b21cb1381054703636e1ef8aa11f0598, vault 39cba0b46d2a8baadf6e765005392f0edadc7259928a59eec78dbbce02e9864f
- sealsSeal: 2 proofs in one transaction, callee first: 39cba0b4…:isReleasedForContract, d709181d…:seal
- sealsSeal: sealed 87 characters on this machine; the key's guardian half is cut into 3 pieces, 2 needed
- sealsSeal: fingerprint b457509beb147f2c8c89b9f7e208cc96b42c75046749ee87e38e9dab4710b5d5, recorded as sealed before 2026-11-27T11:49:21.000Z
- sealsSeal: the register's ledger holds 3 piece commitments and 0 pieces: no text, no key
- sealsRefused: a genuine piece was refused while the vault is armed: the register asked the vault and stopped with "vault not released"
- sealsRefused: the call failed on this machine against the chain's state, so nothing was proven or sent; pieces on the ledger: 0
- checkInEd25519: CIP-30-format signature (software Ed25519 key over the 119-byte Sig_structure) verified in-circuit
- checkInEd25519: deadline moved from 1795780598 to 1795779887 (5 min after it was built); nonce 1 → 2
- triggerTimeout: deadline 1795779887 passed; vault is pending until 1795780007
- finalizeRelease: released at 1795780007; estate snapshot 10.000000 tNIGHT
- finalizeRelease: 1 event(s) emitted while executing the circuit
- claim: heir 0 (6000 bps of 10.000000) claimed 6.000000 tNIGHT to mn_addr_preview1ucfa5n7sadm7xtfhdukmqt30fd2a375q8lmtmhyl8dp7wv4eep5s22l0fp
- claim: estatePaid 0.000000 → 6.000000
- claim: the indexer lists a new unshielded UTXO of 6.000000 tNIGHT owned by the test wallet in this transaction
- readEvents: indexer returned the "codicil:released:v1" event (id 186462) for the vault
- readEvents: found by the finalizeRelease transaction hash 56f364555c7c0f8c20b3cbf04f5b263f91c710109e916e95f688f72396415741
- sealsHandOver1: 2 proofs in one transaction, callee first: 39cba0b4…:isReleasedForContract, d709181d…:handOver
- sealsHandOver1: piece 3 of 3 was checked against its commitment and written to the register's public ledger, by a caller holding no keeper secret
- sealsHandOver1: pieces on the ledger for this text: 3 (2 needed)
- sealsHandOver2: 2 proofs in one transaction, callee first: 39cba0b4…:isReleasedForContract, d709181d…:handOver
- sealsHandOver2: piece 1 of 3 was checked against its commitment and written to the register's public ledger, by a caller holding no keeper secret
- sealsHandOver2: pieces on the ledger for this text: 1, 3 (2 needed)
- sealsOpen: read pieces 1 and 3 from the register's public ledger, rebuilt the key and opened the sealed text: it is the 87 characters that were sealed
- sealsOpen: a made-up piece was refused after the release too: "not a genuine piece" (nothing was proven or sent)
- sealsOpen: the keeper could not seal another text after the release: "vault released" (nothing was proven or sent)
