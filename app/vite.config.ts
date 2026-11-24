// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [react(), wasm()],
  // Passkey signatures are bound to the origin, and the vault was compiled for
  // http://localhost:5173 (sdk/src/config.ts), so the port must not drift.
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  build: { target: 'esnext', chunkSizeWarningLimit: 4096 },
  optimizeDeps: {
    exclude: ['@midnightntwrk/onchain-runtime-v4'],
    esbuildOptions: { target: 'esnext' },
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 60_000 },
} as never);
