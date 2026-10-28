/**
 * `COLLECTOR_VERSION` is what every upload reports as `collectorVersion`, so
 * it has to name the package that was actually installed.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { COLLECTOR_VERSION } from '../version.js'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

it('COLLECTOR_VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { version: string }
  expect(COLLECTOR_VERSION).toBe(pkg.version)
})
