/**
 * The cooperative patch chain — a **cross-repository contract** with the moqtap
 * browser extension, which ships a mirror of `transport/patch-chain.ts`.
 *
 * What it buys: a moqtap patch in the *middle* of a chain can remove itself for
 * real, instead of going inert and leaving a permanent no-op constructor on the
 * page global. What it deliberately does not buy: anything against a
 * non-participant, where the conservative fallback still applies.
 */

import { describe, expect, it } from 'vitest'
import { CHAIN_KEY, joinChain } from '../../transport/patch-chain.js'

/** A minimal stand-in for a hook: it delegates through a mutable variable. */
function fakeHook(id: string, glob: Record<string, unknown>) {
  let delegate = glob.WebTransport
  const patched = {
    id,
    get delegate() {
      return delegate
    },
  }
  glob.WebTransport = patched
  const chain = joinChain(glob, {
    id,
    patched,
    original: delegate,
    repoint(next: unknown) {
      delegate = next
    },
  })
  return {
    patched,
    get delegate() {
      return delegate
    },
    uninstall(): void {
      const handover = chain.release()
      if (handover !== null && glob.WebTransport === patched) {
        glob.WebTransport = handover.restore
      }
    },
  }
}

describe('the patch chain', () => {
  it('uses the exact global name the extension mirrors', () => {
    expect(CHAIN_KEY).toBe('__moqtapPatchChain')
  })

  it('lets the middle patch splice itself out for real', () => {
    // The whole point. Without the chain, `lower` can only go inert, and its
    // dead wrapper stays in the delegation path forever.
    const NATIVE = { native: true }
    const g: Record<string, unknown> = { WebTransport: NATIVE }

    const lower = fakeHook('extension', g)
    const upper = fakeHook('collector', g)
    expect(upper.delegate).toBe(lower.patched)

    lower.uninstall()

    // The global still names the upper patch -- it is still installed and
    // still observing -- but it now delegates straight to native.
    expect(g.WebTransport).toBe(upper.patched)
    expect(upper.delegate).toBe(NATIVE)

    upper.uninstall()
    expect(g.WebTransport).toBe(NATIVE)
  })

  it('leaves nothing behind when the outermost goes first either', () => {
    const NATIVE = { native: true }
    const g: Record<string, unknown> = { WebTransport: NATIVE }
    const lower = fakeHook('extension', g)
    const upper = fakeHook('collector', g)

    upper.uninstall()
    expect(g.WebTransport).toBe(lower.patched)
    lower.uninstall()
    expect(g.WebTransport).toBe(NATIVE)
  })

  it('will not unwind past a non-participant on top of us', () => {
    // A foreign patch -- another SDK, a page's own instrumentation -- captured
    // our constructor by value and is not in the registry. Restoring the global
    // here would discard it. The conservative fallback is the only safe answer,
    // and it is what the chain returns to when nobody claims the handover.
    const NATIVE = { native: true }
    const g: Record<string, unknown> = { WebTransport: NATIVE }
    const ours = fakeHook('collector', g)

    const foreign = { foreign: true }
    g.WebTransport = foreign

    ours.uninstall()
    expect(g.WebTransport).toBe(foreign)
  })

  it('stands down if something else owns the registry name', () => {
    // The name is not ours by right. If a page has put something else there,
    // participating would mean writing into a stranger's object.
    const g: Record<string, unknown> = { WebTransport: {}, [CHAIN_KEY]: 'not ours' }
    const h = joinChain(g, { id: 'collector', patched: {}, original: {}, repoint() {} })
    expect(h.release()).toBeNull()
    expect(g[CHAIN_KEY]).toBe('not ours')
  })

  it('keeps delegating through an inert hop if a peer cannot be repointed', () => {
    // Correct, just not tidy: a participant whose `repoint` throws keeps
    // pointing at our wrapper, which by then observes nothing. Better than
    // rewriting a global we can no longer reason about.
    const NATIVE = { native: true }
    const g: Record<string, unknown> = { WebTransport: NATIVE }
    const mine = { id: 'lower' }
    g.WebTransport = mine
    const chain = joinChain(g, {
      id: 'extension',
      patched: mine,
      original: NATIVE,
      repoint() {},
    })
    joinChain(g, {
      id: 'collector',
      patched: { id: 'upper' },
      original: mine,
      repoint() {
        throw new Error('cannot repoint')
      },
    })
    expect(() => chain.release()).not.toThrow()
  })

  it('is not enumerable, so it does not show up in page introspection', () => {
    const g: Record<string, unknown> = { WebTransport: {} }
    joinChain(g, { id: 'collector', patched: {}, original: {}, repoint() {} })
    expect(Object.keys(g)).not.toContain(CHAIN_KEY)
    expect(CHAIN_KEY in g).toBe(true)
  })
})
