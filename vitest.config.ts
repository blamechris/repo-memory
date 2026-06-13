import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // Windows CI runners are slow to spin up a vitest worker and import the
    // native/WASM deps (better-sqlite3, tree-sitter); that one-time cost lands
    // on whichever test runs first in a worker and blew past the 5s default
    // even for pure-string tests. A generous global ceiling kills that flake
    // class without per-test overrides; a genuinely hung test still fails.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
});
