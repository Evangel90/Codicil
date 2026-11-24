// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Every assert message in the contracts must have a friendly UI message in
// sdk/src/errors.ts and a row in docs/ERRORS.md, and no catalogue entry may be
// stale. The UI relies on these strings, so changing one is a breaking change.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTRACT_ERRORS, contractErrorCode, explainError } from '@codicil/sdk';

const SRC = new URL('../src', import.meta.url).pathname;
const DOC = new URL('../../docs/ERRORS.md', import.meta.url);

function compactFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? compactFiles(join(dir, e.name)) : e.name.endsWith('.compact') ? [join(dir, e.name)] : []);
}

/** The message argument of every assert(...) in the sources. */
function assertMessages(): Set<string> {
  const out = new Set<string>();
  for (const f of compactFiles(SRC)) {
    const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    for (const m of src.matchAll(/assert\s*\(((?:[^()"]|"[^"]*"|\((?:[^()"]|"[^"]*"|\([^()]*\))*\))*)\)/g)) {
      const literal = m[1].match(/"([^"]*)"\s*$/);
      if (!literal) throw new Error(`assert without a message literal in ${f}: ${m[0]}`);
      out.add(literal[1]);
    }
  }
  return out;
}

describe('error catalogue', () => {
  const messages = assertMessages();

  it('finds the contract asserts', () => {
    expect(messages.size).toBeGreaterThan(25);
    expect(messages).toContain('owner is still alive');
  });

  it('has a friendly message for every contract error', () => {
    const missing = [...messages].filter((m) => !(m in CONTRACT_ERRORS));
    expect(missing).toEqual([]);
  });

  it('has no stale entries', () => {
    const stale = Object.keys(CONTRACT_ERRORS).filter((m) => !messages.has(m));
    expect(stale).toEqual([]);
  });

  it('documents every error in docs/ERRORS.md', () => {
    const doc = readFileSync(DOC, 'utf8');
    const undocumented = [...messages].filter((m) => !doc.includes('`' + m + '`'));
    expect(undocumented).toEqual([]);
  });

  it('recognises contract errors inside runtime exceptions', () => {
    const err = new Error('failed assert: share still locked');
    expect(contractErrorCode(err)).toBe('share still locked');
    expect(explainError(err)).toBe(CONTRACT_ERRORS['share still locked'].message);
    // Longest match wins: "not the backup heir" contains no shorter code by accident.
    expect(contractErrorCode(new Error('failed assert: not the backup heir'))).toBe('not the backup heir');
    expect(explainError(new Error('socket hang up'))).toMatch('Nothing was changed');
  });
});
