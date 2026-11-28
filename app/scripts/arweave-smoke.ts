// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// One real round trip through the ar.io testnet sandbox: `npm run arweave:smoke`.
// It uploads 2 KB of random bytes with the store live mode uses, reads them
// back, and checks they are the same. It needs no wallet and no funds: the
// sandbox's free tier covers it. The file is deleted after about three days.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { BlobError } from '@codicil/sdk';
import { ARWEAVE_SANDBOX, arweaveSandboxStore } from '../src/live/arweave.js';

const SIZE = 2048;

async function main(): Promise<void> {
  const store = arweaveSandboxStore({ readBudgetMs: 60_000, readDelaysMs: [500, 1000, 2000, 4000, 8000, 15000, 30000] });
  const body = randomBytes(SIZE);
  console.log(`upload  ${SIZE} bytes to ${ARWEAVE_SANDBOX.uploadUrl}`);

  const t0 = performance.now();
  const id = await store.put(body);
  const t1 = performance.now();
  console.log(`id      ${id}  (${Math.round(t1 - t0)} ms)`);

  const back = await store.get(id);
  const t2 = performance.now();
  console.log(`read    ${back.length} bytes from ${ARWEAVE_SANDBOX.gatewayUrl}/raw/${id}  (${Math.round(t2 - t1)} ms after upload)`);

  const sent = bytesToHex(sha256(body));
  const got = bytesToHex(sha256(back));
  console.log(`sha256  sent ${sent}`);
  console.log(`        got  ${got}`);
  if (sent !== got) throw new Error('the bytes read back are not the bytes uploaded');
  console.log('ok      the sandbox gave back the same bytes');
}

main().catch((error: unknown) => {
  if (error instanceof BlobError) console.error(`failed  ${error.problem}: ${error.message}`);
  else console.error('failed ', error);
  process.exit(1);
});
