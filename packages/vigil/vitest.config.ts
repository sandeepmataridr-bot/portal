import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The replay suite plays 8-hour scenarios at full speed.
    testTimeout: 120_000,
  },
});
