import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * This package carries its own config so that running `vitest` from inside it
 * resolves against this directory rather than the workspace root's project
 * list (see `packages/trace/vitest.config.ts`).
 *
 * The aliases mirror `tsconfig.json`'s `paths`: the tests run on the same
 * `@moqtap/trace` and `@moqtap/inspect` sources the bundle is built from.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@moqtap/trace': fileURLToPath(new URL('../trace/src/index.ts', import.meta.url)),
      '@moqtap/inspect': fileURLToPath(new URL('../inspect/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
})
