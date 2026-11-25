// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// The wallet SDK's dependencies write to the terminal on their own. While a
// wallet syncs, the node client opens and closes WebSocket connections and
// logs each close as an error ("FATAL: Unable to initialize the API"), and a
// retried sync step prints "Wallet.Sync: [object Object]" with a stack trace.
// Both are routine and both recover by themselves, but they bury the lines
// that matter. This filter drops the first kind and shortens the second.
// CODICIL_DEBUG=1 turns it off.

const POLKADOT = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\s+(RPC-CORE|API\/INIT|API-WS|API):/;
const POLKADOT_TAIL = /^(Failed WS Request:|\s+at )/;
const SYNC_ERROR = /^Wallet\.Sync: /;
const DUMP_TAIL = /^(\s+at |\s+\[cause\]: |\s+_tag: |\}\s*$)/;

export const SYNC_RETRY_NOTE = 'wallet sync hit an error and is retrying (set CODICIL_DEBUG=1 for the details)';

/**
 * A line filter for one output stream. Feed it chunks as they are written;
 * it returns what should reach the terminal. Stateful: a dropped line takes
 * its continuation lines (stack frames, the tail of an object dump) with it.
 */
export function createNoiseFilter(opts: { now?: () => number; noteEveryMs?: number } = {}): (chunk: string) => string {
  const now = opts.now ?? Date.now;
  const noteEvery = opts.noteEveryMs ?? 60_000;
  let mode: 'pass' | 'polkadot' | 'sync' = 'pass';
  let lastNote = -Infinity;
  let pending = '';
  return (chunk: string): string => {
    const text = pending + chunk;
    const lines = text.split('\n');
    // Keep an unterminated last line until the rest of it arrives.
    pending = lines.pop() ?? '';
    const out: string[] = [];
    for (const line of lines) {
      if (POLKADOT.test(line)) {
        mode = 'polkadot';
        continue;
      }
      if (SYNC_ERROR.test(line)) {
        mode = 'sync';
        if (now() - lastNote >= noteEvery) {
          lastNote = now();
          out.push(SYNC_RETRY_NOTE);
        }
        continue;
      }
      if (mode === 'polkadot' && POLKADOT_TAIL.test(line)) continue;
      if (mode === 'sync' && DUMP_TAIL.test(line)) continue;
      mode = 'pass';
      out.push(line);
    }
    return out.length === 0 ? '' : out.join('\n') + '\n';
  };
}
