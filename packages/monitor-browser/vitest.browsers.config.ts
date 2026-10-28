import { defineConfig } from 'vitest/config'

/**
 * The tests that drive real browsers. Kept out of `vitest.config.ts`, so
 * `bun run test` never needs the Playwright browsers installed.
 */
export default defineConfig({
  test: {
    include: ['src/__tests__/browser/**/*.browser.ts'],
  },
})
