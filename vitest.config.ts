import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['js/test/**/*.test.ts', 'facts/*/test/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
