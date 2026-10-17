import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * This package carries its own config so that running `vitest` from inside it
 * resolves against this directory rather than the workspace root's project
 * list (see `packages/trace/vitest.config.ts`).
 *
 * The alias mirrors `tsconfig.json`'s `paths`: the tests read traces through
 * the same `@moqtap/trace` source the bundle is built from.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@moqtap/trace': fileURLToPath(new URL('../trace/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
})
