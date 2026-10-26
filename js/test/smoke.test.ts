import { expect, test } from 'vitest'
import * as factKit from '../src/index.js'

test('fact-kit entry module loads', () => {
  expect(factKit).toBeDefined()
})
