// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// `init`: make sure there is a seed for the throwaway test wallet, without
// ever replacing one that exists and without ever printing it.

import { ENV_KEYS, parseDotEnv, seedProblem, upsertDotEnv } from './env.js';

export interface InitPlan {
  /** Where the seed in use comes from. */
  source: 'env-file' | 'process' | 'new';
  seed: string;
  /** New `.env` contents to write, or undefined when the file must not change. */
  write?: string;
}

/**
 * Decide what `init` does.
 *
 * @param envText current contents of `.env`, or undefined if there is none
 * @param processSeed `WALLET_SEED` from the process environment, if set
 * @param newSeed makes a fresh random seed (hex); called only when one is needed
 */
export function planInit(envText: string | undefined, processSeed: string | undefined, newSeed: () => string): InitPlan {
  const inFile = envText === undefined ? undefined : parseDotEnv(envText)[ENV_KEYS.seed];
  if (inFile !== undefined && inFile !== '') {
    const problem = seedProblem(inFile);
    if (problem) throw new Error(`.env already has a ${ENV_KEYS.seed}, but ${problem}. Fix or remove that line by hand; init will not replace it`);
    return { source: 'env-file', seed: inFile };
  }
  if (processSeed !== undefined && processSeed !== '') {
    const problem = seedProblem(processSeed);
    if (problem) throw new Error(`the environment has a ${ENV_KEYS.seed}, but ${problem}`);
    return { source: 'process', seed: processSeed };
  }
  const seed = newSeed();
  const problem = seedProblem(seed);
  if (problem) throw new Error(`generated seed is malformed: ${problem}`);
  return { source: 'new', seed, write: upsertDotEnv(envText ?? '', ENV_KEYS.seed, seed) };
}
