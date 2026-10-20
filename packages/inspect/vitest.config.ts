import { defineConfig } from 'vitest/config'

// Without its own config, vitest run from this directory picks up the root's
// `projects` list and resolves those paths relative to this package.
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
})
