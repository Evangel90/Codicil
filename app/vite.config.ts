// SPDX-License-Identifier: Apache-2.0
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { serveArtifacts } from './zk-server.js';

/**
 * Live mode fetches each circuit's proving key when it needs it, from
 * `/zk/codicil_vault/`. The dev and preview servers serve them straight from
 * `contracts/managed/codicil_vault`, where `npm run compile:full` writes them:
 * 2.7 GB that should not be copied into every build. A static deployment has
 * to publish that folder at the same path itself.
 */
function zkArtifacts(): Plugin {
  const handler = serveArtifacts();
  return {
    name: 'codicil-zk-artifacts',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [react(), wasm(), zkArtifacts()],
  // Passkey signatures are bound to the origin, and the vault was compiled for
  // http://localhost:5173 (sdk/src/config.ts), so the port must not drift.
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  build: { target: 'esnext', chunkSizeWarningLimit: 4096 },
  optimizeDeps: {
    exclude: ['@midnightntwrk/onchain-runtime-v4', '@midnightntwrk/ledger-v9', '@midnightntwrk/ledger-v8'],
    esbuildOptions: { target: 'esnext' },
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 60_000 },
} as never);
