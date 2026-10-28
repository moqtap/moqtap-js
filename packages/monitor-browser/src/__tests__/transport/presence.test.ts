/**
 * The page-global presence marker — a **cross-repository contract**.
 *
 * The moqtap browser extension reads `globalThis.__moqtapCollector` to tell a
 * developer whether the connection they are inspecting is also being collected,
 * and whether the SDK on the page is transmitting or merely installed. Nothing
 * in this repository consumes it, so these tests are the only thing standing
 * between a rename here and a silently broken feature there.
 */

import { describe, expect, it } from 'vitest'
import { PRESENCE_KEY, publishPresence, readPresence } from '../../transport/presence.js'

const SINCE = 1_700_000_000_000

function fakeGlobal(): Record<string, unknown> {
  return {}
}

describe('the presence marker', () => {
  it('is published under the exact name the extension reads', () => {
    // A rename is a breaking change to another repository, so the literal is
    // pinned here rather than referenced through the constant alone.
    expect(PRESENCE_KEY).toBe('__moqtapCollector')

    const g = fakeGlobal()
    publishPresence(g, '0.1.0', SINCE)
    expect(g.__moqtapCollector).toBeDefined()
  })

  it('starts dormant, because that is what the collector is at module eval', () => {
    // The hook installs at module-eval time and transmits nothing until a
    // key arrives. "Installed but sending nothing" is a normal state and a
    // common misconfiguration, and the extension distinguishes the two.
    const g = fakeGlobal()
    publishPresence(g, '0.1.0', SINCE)
    expect(readPresence(g)).toEqual({ v: 1, version: '0.1.0', since: SINCE, active: false })
  })

  it('flips to active when init() supplies a key, keeping `since`', () => {
    const g = fakeGlobal()
    const h = publishPresence(g, '0.1.0', SINCE)
    h.setActive(true)
    const p = readPresence(g)
    expect(p?.active).toBe(true)
    // `since` must not move: the extension uses it to decide which of its own
    // sessions were open early enough to be uncollected.
    expect(p?.since).toBe(SINCE)
  })

  it('carries no credential, endpoint or identifier', () => {
    // Everything on `globalThis` is readable by every script on the page,
    // including ones the customer did not write. This is the test that stops a
    // convenience field from becoming a leak.
    const g = fakeGlobal()
    publishPresence(g, '0.1.0', SINCE).setActive(true)
    const p = readPresence(g)
    expect(Object.keys(p as object).sort()).toEqual(['active', 'since', 'v', 'version'])
    expect(JSON.stringify(p)).not.toMatch(/key|token|secret|endpoint|https?:/i)
  })

  it('is frozen, so a page script cannot flip it to lie about us', () => {
    const g = fakeGlobal()
    publishPresence(g, '0.1.0', SINCE)
    const p = g.__moqtapCollector as { active: boolean }
    expect(Object.isFrozen(p)).toBe(true)
  })

  it('never clobbers a newer collector than the one holding the handle', () => {
    // Two copies of the SDK on one page is a real deployment accident. The
    // second one wins the global; the first must not then reach back through a
    // stale handle and overwrite it.
    const g = fakeGlobal()
    const first = publishPresence(g, '0.1.0', SINCE)
    publishPresence(g, '0.2.0', SINCE + 1)

    first.setActive(true)
    expect(readPresence(g)?.version).toBe('0.2.0')
    expect(readPresence(g)?.active).toBe(false)

    first.remove()
    expect(readPresence(g)).not.toBeNull()
  })

  it('removes itself on teardown', () => {
    const g = fakeGlobal()
    publishPresence(g, '0.1.0', SINCE).remove()
    expect(readPresence(g)).toBeNull()
    expect(PRESENCE_KEY in g).toBe(false)
  })

  it('costs the marker rather than the collector when the global refuses it', () => {
    // Nothing here may throw into the page. A frozen global, or a page
    // that has trapped defineProperty, loses the diagnostic and nothing else.
    const g = Object.freeze({}) as Record<string, unknown>
    expect(() => publishPresence(g, '0.1.0', SINCE).setActive(true)).not.toThrow()
    expect(readPresence(g)).toBeNull()
  })

  it('rejects a malformed or foreign marker rather than trusting it', () => {
    // Any script can write this property. A reader that trusted the shape would
    // let a page make the extension report a collector that is not there.
    const g = fakeGlobal()
    g[PRESENCE_KEY] = { v: 2, active: true }
    expect(readPresence(g)).toBeNull()
    g[PRESENCE_KEY] = 'yes'
    expect(readPresence(g)).toBeNull()
    g[PRESENCE_KEY] = { v: 1, since: 'soon', active: true }
    expect(readPresence(g)).toBeNull()
  })
})
