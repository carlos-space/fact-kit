import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/fact-kit-js/test/**/*.test.ts', 'facts/*/test/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Many tests run the real CLI in a child process, about half a second each on a CI runner, and a scenario
    // test runs it up to ten times. The 5 s default sits at that edge, so a slow runner fails a passing test.
    testTimeout: 30_000,
  },
})
