import { defineConfig } from 'vitest/config'

/**
 * This package carries its own config so that running `vitest` from inside it
 * resolves against this directory. With no config here, vitest walks up to the
 * workspace root, finds its `projects` list and re-resolves those paths
 * relative to this package -- looking for `packages/trace/packages/codec`,
 * which does not exist, and failing at startup before any test runs.
 */
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
})
