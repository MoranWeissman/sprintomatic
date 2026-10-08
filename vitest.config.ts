import { defineConfig } from 'vitest/config';

// Pure-logic unit tests. Server modules are plain Node code, so the default
// node environment is right. Tests live next to the code as *.test.ts and are
// excluded from the tsc build (see tsconfig.server.json) so the typecheck stays
// about shipped code while Vitest owns the tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
