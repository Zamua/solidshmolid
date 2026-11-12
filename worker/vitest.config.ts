import { defineConfig } from 'vitest/config';

// The suite runs on node. The one platform module the runtime imports is
// stood in for, so tests can load the Worker entry and drive its fetch.
export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': new URL('./tests/support/cloudflareWorkers.ts', import.meta.url).pathname },
  },
});
