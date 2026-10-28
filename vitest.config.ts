import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/codec',
      'packages/trace',
      'packages/inspect',
      'packages/monitor-browser',
      'packages/viewer',
    ],
  },
})
