// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors

import { describe, expect, it } from 'vitest';
import { createNoiseFilter, SYNC_RETRY_NOTE } from '../src/noise.js';

// Lines captured from a real wallet sync against Preview on 2026-11-25.
const POLKADOT = [
  '2026-11-25 21:37:17        RPC-CORE: call(method: Text, data: Bytes, at?: BlockHash): Bytes:: disconnected from wss://rpc.preview.midnight.network/: 1000:: Normal Closure',
  '2026-11-25 21:37:17        API/INIT: error with state_call::Metadata_metadata_versions, rpc::state::get_metadata will be used',
  '2026-11-25 21:37:17        RPC-CORE: getMetadata(at?: BlockHash): Metadata:: WebSocket is not connected',
  'Failed WS Request: {"method":"state_getMetadata","params":[]}',
  '2026-11-25 21:37:17        API/INIT: Error: FATAL: Unable to initialize the API: WebSocket is not connected',
  'Failed WS Request: {"method":"state_getMetadata","params":[]}',
  '    at #onProviderConnect (file:///repo/node_modules/@polkadot/api/base/Init.js:387:27)',
];
const SYNC_DUMP = [
  'Wallet.Sync: [object Object]',
  '    at file:///repo/node_modules/@midnightntwrk/wallet-sdk-shielded/dist/v2/Sync.js:332:169',
  '    at e (/repo/node_modules/effect/src/internal/cause.ts:369:45)',
  '    at <anonymous> (/repo/node_modules/effect/src/Function.ts:245:18) {',
  "  _tag: 'Wallet.Sync'",
  '}',
];
const OURS = '        syncing: shielded 12614/158337 7.9%, unshielded 0/0, dust 878/158359 0.5%';

const feed = (filter: (chunk: string) => string, lines: string[]): string => lines.map((l) => filter(`${l}\n`)).join('');

describe('library noise filter', () => {
  it('drops the node client\'s connection chatter and keeps our lines', () => {
    const out = feed(createNoiseFilter(), [OURS, ...POLKADOT, OURS, '[21:37:20] deploy: SucceedEntirely in block 5']);
    expect(out).toBe(`${OURS}\n${OURS}\n[21:37:20] deploy: SucceedEntirely in block 5\n`);
  });

  it('replaces a sync error dump with one line, at most once a minute', () => {
    let t = 0;
    const filter = createNoiseFilter({ now: () => t });
    expect(feed(filter, [...SYNC_DUMP, OURS])).toBe(`${SYNC_RETRY_NOTE}\n${OURS}\n`);
    t = 30_000;
    expect(feed(filter, [...SYNC_DUMP, OURS])).toBe(`${OURS}\n`);
    t = 61_000;
    expect(feed(filter, SYNC_DUMP)).toBe(`${SYNC_RETRY_NOTE}\n`);
  });

  it('does not swallow a real error that follows the noise', () => {
    const out = feed(createNoiseFilter(), [...POLKADOT, '', 'error: the wallet did not settle within 600 s', 'cause: Insufficient Funds: could not balance dust']);
    expect(out).toBe('\nerror: the wallet did not settle within 600 s\ncause: Insufficient Funds: could not balance dust\n');
  });

  it('handles a chunk that holds several lines, or ends mid-line', () => {
    const filter = createNoiseFilter();
    expect(filter(`${OURS}\n${POLKADOT.join('\n')}\nkept\n`)).toBe(`${OURS}\nkept\n`);
    expect(filter('half a ')).toBe('');
    expect(filter('line\n')).toBe('half a line\n');
  });
});
