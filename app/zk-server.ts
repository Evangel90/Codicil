// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Codicil Authors
//
// Serves the compiler's output for the vault (`contracts/managed/codicil_vault`)
// over HTTP, so the app's live mode can fetch each circuit's keys when it
// needs them. Used by the Vite dev and preview servers (vite.config.ts) and by
// the end-to-end script, which fetches the keys exactly as a browser would.
//
// Only the three folders a proof needs are served, and only plain file names
// inside them. The proving keys are large (up to 448 MB), so files are
// streamed, and each carries an ETag (size and modified time) that lets the
// app keep its downloaded copy until the file changes.

import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VAULT_ARTIFACTS_DIR = fileURLToPath(new URL('../contracts/managed/codicil_vault', import.meta.url));
/** Where the app looks for the artifacts, relative to its own origin. */
export const ZK_ROUTE = '/zk/codicil_vault';

const ALLOWED = /^\/(keys\/[A-Za-z0-9_]+\.(?:prover|verifier)|zkir\/[A-Za-z0-9_]+\.bzkir|compiler\/contract-info\.json)$/;

/** True if the proving keys have been built (`npm run compile:full`). */
export const hasProvingKeys = (dir: string = VAULT_ARTIFACTS_DIR): boolean => existsSync(join(dir, 'keys', 'checkInPasskey.prover'));

/**
 * A request handler for `GET` and `HEAD` under `route`. Calls `next` for
 * anything else, so it can sit in front of another server.
 */
export function serveArtifacts(dir: string = VAULT_ARTIFACTS_DIR, route: string = ZK_ROUTE) {
  return (req: IncomingMessage, res: ServerResponse, next?: () => void): void => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0]);
    if (!path.startsWith(`${route}/`)) { next?.(); return; }
    const rest = path.slice(route.length);
    const file = ALLOWED.test(rest) ? join(dir, rest) : undefined;
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !file || !existsSync(file)) {
      // A plain 404, never the app's index page: the app tells "not built" from this.
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('not found: run `npm run compile:full` to build the proving keys\n');
      return;
    }
    const stat = statSync(file);
    const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    res.setHeader('content-type', rest.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    res.setHeader('content-length', String(stat.size));
    res.setHeader('etag', etag);
    // The app keeps its own copy (Cache Storage); the browser's HTTP cache should not hold a second one.
    res.setHeader('cache-control', 'no-store');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', 'etag, content-length');
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  };
}
