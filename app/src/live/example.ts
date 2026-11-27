// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// A real vault and seal register on Midnight's Preview test network, made by
// `npm run preprod:run -- --seals` (preprod/results). The vault was released
// and two guardians' pieces were handed over, so the reader page can open the
// sealed text below from the public ledger. Empty strings hide the example.
// The sealed text is public by design: it is a test disclosure, and it carries
// no secret that the register's ledger does not already complete.

export const EXAMPLE = {
  vault: '39cba0b46d2a8baadf6e765005392f0edadc7259928a59eec78dbbce02e9864f',
  register: 'd709181d7c271477f322b159474a6491b21cb1381054703636e1ef8aa11f0598',
  /** The sealed text, exactly as it was sealed: public, and useless without the pieces. */
  sealedText: "{\"codicil\":\"sealed\",\"version\":1,\"vault\":\"39cba0b46d2a8baadf6e765005392f0edadc7259928a59eec78dbbce02e9864f\",\"needed\":2,\"recipientHalf\":\"71319b74444fb802aa152319af1226701a8f9d3942d6b05211bbf65e9da5556d\",\"nonce\":\"7c0e71f01b79c69ae6f1d87c\",\"ciphertext\":\"c9efdcd7f68a0e95e1a76165ee5d2f0e25d6b849d3f4ccae8b75f6ee44dcb04b252ed5573db1c5c57e1ea5f90919d6b0789400f4f85da98949abb88a7228965f6b7cbbbeb0d65a6ec9e8ad2073351f1c469e532ff3863bcb4a5c98e84065724b766d7c31cec097\",\"pieceChecks\":[\"b04c4928c1902fdd692e4436a65cd9f41b5197e67bd6face6c5d0b4be4b0f490\",\"effd4268c892cb3372a05c74aa52bd15ad4460fd5283bf7b76866156d1ccd78a\",\"9d560a37e41de137eb205c0c7c17a4496428d9d3dea49decba3f4bdb5588d09a\"]}",
};
