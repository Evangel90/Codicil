// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Checks that a simulated call also satisfies the compiled ZK circuit, so a
// passing test means "a proof for this call can be generated", not just "the
// JavaScript ran". Mirrors the Compact compiler's own test-center harness.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check, jsonIrToBinary, type KeyMaterialProvider } from '@midnightntwrk/zkir-v3';
import { proofDataIntoSerializedPreimage } from '@midnightntwrk/onchain-runtime-v4';
import type { ProofData } from '@midnight-ntwrk/compact-runtime';

export async function checkProofData(contractDir: string, circuitId: string, proofData: ProofData): Promise<void> {
  const irJson = await readFile(join(contractDir, 'zkir', `${circuitId}.zkir`), 'utf-8');
  const provider: KeyMaterialProvider = {
    lookupKey: async () => ({
      proverKey: new Uint8Array(0),
      verifierKey: new Uint8Array(0),
      ir: jsonIrToBinary(irJson),
    }),
    getParams: async (k) => {
      throw new Error(`constraint check unexpectedly asked for SRS params (k=${k})`);
    },
  };
  const preimage = proofDataIntoSerializedPreimage(
    proofData.input,
    proofData.output,
    proofData.publicTranscript,
    proofData.privateTranscriptOutputs,
    circuitId,
  );
  await check(preimage, provider);
}
