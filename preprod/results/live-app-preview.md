# Live mode end to end on preview

Run by `npm run live:e2e` (app/scripts/live-e2e.ts), finished 2026-11-26T02:49:40.113Z.
The app's own live store and live chain, with the test wallet from a seed in place of Lace and a software key in place of Face ID.

- Vault: `9a65aa34f18a79fa6c8974fcea355b4d9c2947dc7ffcfc37a7dda5169de091cc`
- Wallet: `mn_addr_preview1ucfa5n7sadm7xtfhdukmqt30fd2a375q8lmtmhyl8dp7wv4eep5s22l0fp`
- Timers: check in every 5 min, 2 min challenge window
- Deployment: 8 transactions (deploy, then 7 circuits added)
- Heir paid: 6 tNIGHT of a 10 tNIGHT estate
- DUST: 276.74 at the start of this invocation, 247.55 at the end

| Step | Transaction | Block | Fee (DUST) | Time |
|---|---|---|---|---|
| owner: deploy (9 circuits) | `39e0933c3f929c4d7d973323b5b861691cdaf1965b56f8e97659fe106dbc8c9c` | | | |
| owner: add `updateSettingsEd25519` | `0b25db8befc5d89fbd823af0a6173c4c4a4c9c129d1b63dcc210b045a62a0eb2` | | | |
| owner: add `updateSettingsPasskey` | `fc1623af9c2cef709cad39dc7b364e2d62b56f9a5cf0468443aa0d59f26940ef` | | | |
| owner: add `startRecovery` | `269c7eeeb5265c34ba0e6a7b7621e5da55163361a680388f256377924bff9d9c` | | | |
| owner: add `finishRecovery` | `996d70b545c0d2ecef712bf290b1d1cd29ba737e859065de17c6f372f24263d0` | | | |
| owner: add `updateWillEd25519` | `89da8d73b5c98598ef5a0ca32c8ba42010434c8216aa2ea4be499dff48da983e` | | | |
| owner: add `updateWillPasskey` | `b792e4d487efcbc3d346ec7878f0b8f5bd4cc943f6ab82846cc191e66c9f8e1e` | | | |
| owner: add `triggerAttestation` | `b629727b394866ec1ad89cba7a3ac453950da0f98efca22bbfb13dc344573841` | | | |
| owner: deposit | `e1087a97369b535dda4259a4b9bec8d785a17bf59a994715764633975bed9d89` | 274046 | 0.593 | 23 s |
| guardian: guardianAttest | `d1897a4fc3bcb56cb34abb6f354f1523146cd6534da68a0fca7389c121054cbb` | 274051 | 0.578 | 27 s |
| owner: checkInPasskey | `1c508b0dd6147fdbc0ef0d272c219a4398e872b99a89e9664a1ca49a6ce694c1` | 274062 | 0.256 | 65 s |
| heir: triggerTimeout | `8a9724ffb2440fd959830cb0c2702fc6e92b8670290779810d65a5a0c85d0206` | 274110 | 0.244 | 19 s |
| heir: finalizeRelease | `8b71aa044f271586e08a4f8b84309aced898c4b9c76dab476dce4a6f6b44499c` | 274131 | 0.258 | 23 s |
| heir: claim | `aec0d737b1bb62240b089520d9c13d297142763bf25b2e30c15ff1c26a9cfdc1` | 274137 | 0.534 | 37 s |
