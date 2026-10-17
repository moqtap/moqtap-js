/**
 * The message gate, as a function.
 *
 * This workspace has no DOM test environment, so the gate is tested where its
 * decisions are made (`ParentGate`, `isAllowedParent`, `tellParent`), with
 * plain objects standing in for `window` and `window.parent`. `ingest.ts` is the
 * only caller, and `ingest.test.ts` checks that it asks.
 */

import { describe, expect, it } from 'vitest'
import {
  answersShareRequest,
  askParentToShare,
  asTraceMessage,
  canOfferLocalOpen,
  DEFAULT_POLICY,
  isAllowedParent,
  ParentGate,
  type ParentPolicy,
  PRODUCTION_PARENTS,
  READY,
  SHARE_REQUEST,
  STAGING_PARENTS,
  tellParent,
} from '../parents'

const self = { name: 'frame' }
const parent = { name: 'parent' }
const sibling = { name: 'sibling' }

const trace = { type: 'moqtrace', bytes: new TextEncoder().encode('MOQTRACE') }

function gate(policy: ParentPolicy = DEFAULT_POLICY) {
  return new ParentGate(parent, self, policy)
}

class Recorder {
  readonly posts: { message: unknown; targetOrigin: string }[] = []
  postMessage(message: unknown, targetOrigin: string) {
    this.posts.push({ message, targetOrigin })
  }
}

describe('the allowlist', () => {
  it('is the production portal and site, and no staging origin unless one is built in', () => {
    expect(PRODUCTION_PARENTS).toEqual(['https://app.moqtap.com', 'https://moqtap.com'])
    expect(STAGING_PARENTS).toEqual([])
  })

  it.each([
    'https://app.moqtap.com',
    'https://moqtap.com',
    'http://127.0.0.1:4321',
    'http://127.0.0.1:65535',
    'http://localhost:9000',
  ])('admits %s', (origin) => {
    expect(isAllowedParent(origin, DEFAULT_POLICY)).toBe(true)
  })

  it.each([
    // lookalikes of the exact entries
    'https://app.moqtap.com.evil.com',
    'https://evil.app.moqtap.com',
    'https://www.moqtap.com',
    'http://app.moqtap.com',
    'http://moqtap.com',
    'https://moqtap.com:8443',
    'https://moqtap.dev',
    // lookalikes of loopback
    'http://127.0.0.1.evil.com:4321',
    'http://localhost.evil.com',
    'https://127.0.0.1:4321',
    'http://127.0.0.2:4321',
    'http://[::1]:4321',
    'http://127.0.0.1:4321/path',
    'http://user@127.0.0.1:4321',
    // not origins at all
    'null',
    '',
    '*',
  ])('refuses %s', (origin) => {
    expect(isAllowedParent(origin, DEFAULT_POLICY)).toBe(false)
  })

  it('refuses loopback when the policy does not include it', () => {
    expect(isAllowedParent('http://127.0.0.1:4321', { exact: [], loopback: false })).toBe(false)
  })
})

describe('messages from a non-allowlisted parent are ignored', () => {
  it('a parent on another origin is not admitted and does not bind the frame', () => {
    const g = gate()
    expect(g.admit({ origin: 'https://evil.example', source: parent, data: trace })).toBe(false)
    expect(g.origin).toBeNull()
  })

  it('an allowed origin that is not the frame’s own parent is ignored', () => {
    // A popup or sibling frame from moqtap.com carries an allowed origin too.
    const g = gate()
    expect(g.admit({ origin: 'https://moqtap.com', source: sibling, data: trace })).toBe(false)
    expect(g.admit({ origin: 'https://moqtap.com', source: null, data: trace })).toBe(false)
    expect(g.origin).toBeNull()
  })

  it('a page that is not framed listens to nobody, even its own origin', () => {
    const top = new ParentGate(self, self)
    expect(top.admit({ origin: 'https://moqtap.com', source: self, data: trace })).toBe(false)
  })

  it('once bound, the frame hears only that exact origin', () => {
    const g = gate()
    expect(g.admit({ origin: 'https://app.moqtap.com', source: parent, data: trace })).toBe(true)
    expect(g.origin).toBe('https://app.moqtap.com')
    // Also on the allowlist, but not the parent this frame handshook with.
    expect(g.admit({ origin: 'https://moqtap.com', source: parent, data: trace })).toBe(false)
    expect(g.admit({ origin: 'http://127.0.0.1:4321', source: parent, data: trace })).toBe(false)
    expect(g.admit({ origin: 'https://app.moqtap.com', source: parent, data: trace })).toBe(true)
  })

  it('a loopback parent binds to its own port, and another port is a stranger', () => {
    const g = gate()
    expect(g.admit({ origin: 'http://127.0.0.1:4321', source: parent, data: trace })).toBe(true)
    expect(g.admit({ origin: 'http://127.0.0.1:4322', source: parent, data: trace })).toBe(false)
  })
})

describe('what the frame says, and to whom', () => {
  it('the ready announcement carries no data', () => {
    expect(Object.keys(READY).sort()).toEqual(['type', 'version'])
    expect(READY.type).toBe('moqtrace-inspector-ready')
  })

  it('nothing is posted to a parent before the handshake', () => {
    const g = gate()
    const out = new Recorder()
    g.admit({ origin: 'https://evil.example', source: parent, data: trace })
    expect(tellParent(g, out, 'opened')).toBe(false)
    expect(out.posts).toEqual([])
  })

  it('after the handshake, posts go to the exact bound origin and never to "*"', () => {
    const g = gate()
    const out = new Recorder()
    g.admit({ origin: 'https://app.moqtap.com', source: parent, data: trace })
    expect(tellParent(g, out, 'opened')).toBe(true)
    expect(out.posts).toEqual([
      {
        message: { type: 'moqtrace-view-state', state: 'opened' },
        targetOrigin: 'https://app.moqtap.com',
      },
    ])
  })
})

describe('the message shape', () => {
  it('reads the shape released CLI shells send', () => {
    const buffer = new TextEncoder().encode('MOQTRACE').buffer
    const msg = asTraceMessage({ type: 'moqtrace', bytes: buffer, name: 'a.moqtrace' })
    expect(msg?.name).toBe('a.moqtrace')
    expect(msg?.bytes.byteLength).toBe(8)
  })

  it.each([
    null,
    'moqtrace',
    { type: 'other', bytes: new Uint8Array(8) },
    { type: 'moqtrace', bytes: 'TU9RVFJBQ0U=' },
    { type: 'moqtrace', bytes: [77, 79] },
  ])('ignores %j', (data) => {
    expect(asTraceMessage(data)).toBeNull()
  })

  it('reads the share mark only as the literal true, and omits it otherwise', () => {
    const bytes = new Uint8Array(8)
    expect(asTraceMessage({ type: 'moqtrace', bytes, shareable: true })?.shareable).toBe(true)
    for (const shareable of [undefined, false, 'true', 1, {}]) {
      const msg = asTraceMessage({ type: 'moqtrace', bytes, shareable })
      expect(msg && 'shareable' in msg, String(shareable)).toBe(false)
    }
  })

  it('drops a name that is not a string rather than rendering it', () => {
    const msg = asTraceMessage({ type: 'moqtrace', bytes: new Uint8Array(8), name: { x: 1 } })
    expect(msg).not.toBeNull()
    expect(msg && 'name' in msg).toBe(false)
  })
})

describe('the share request', () => {
  it('is a type and nothing else, the one the CLI shell and site relay match on', () => {
    expect(SHARE_REQUEST).toEqual({ type: 'moqtrace-share-request' })
  })

  it('is answered by the site relay, in production or on loopback, not the portal or a lookalike', () => {
    for (const ok of ['http://127.0.0.1:4321', 'http://localhost:9000', 'https://moqtap.com']) {
      expect(answersShareRequest(ok), ok).toBe(true)
    }
    for (const no of [
      null,
      'https://app.moqtap.com',
      ...STAGING_PARENTS,
      'https://moqtap.com.evil.com',
      'http://moqtap.com',
      'https://127.0.0.1:4321',
      'http://127.0.0.1.evil.com:4321',
      'http://127.0.0.1:4321/',
      '*',
    ]) {
      expect(answersShareRequest(no), String(no)).toBe(false)
    }
  })

  it('is posted to the handshaken loopback site relay by its exact origin', () => {
    const g = gate()
    const out = new Recorder()
    g.admit({ origin: 'http://127.0.0.1:4321', source: parent, data: trace })
    expect(askParentToShare(g, out)).toBe(true)
    expect(out.posts).toEqual([{ message: SHARE_REQUEST, targetOrigin: 'http://127.0.0.1:4321' }])
  })

  it('is posted to the handshaken site relay by its exact origin', () => {
    const g = gate()
    const out = new Recorder()
    g.admit({ origin: 'https://moqtap.com', source: parent, data: trace })
    expect(askParentToShare(g, out)).toBe(true)
    expect(out.posts).toEqual([{ message: SHARE_REQUEST, targetOrigin: 'https://moqtap.com' }])
  })

  it('is never posted before a handshake, so never to "*"', () => {
    const g = gate()
    const out = new Recorder()
    // A loopback origin that is not the frame's parent does not bind it.
    g.admit({ origin: 'http://127.0.0.1:4321', source: sibling, data: trace })
    expect(askParentToShare(g, out)).toBe(false)
    expect(out.posts).toEqual([])
  })

  it('is never posted to a portal parent', () => {
    const g = gate()
    const out = new Recorder()
    g.admit({ origin: 'https://app.moqtap.com', source: parent, data: trace })
    expect(askParentToShare(g, out)).toBe(false)
    expect(out.posts).toEqual([])
  })
})

describe('the Open capture button', () => {
  const given = { source: 'parent' }
  const local = { source: 'parent', local: true }
  const file = { source: 'file' }

  it('is offered on the viewer opened on its own, with or without a file', () => {
    const alone = new ParentGate(self, self)
    expect(canOfferLocalOpen(alone, null)).toBe(true)
    expect(canOfferLocalOpen(alone, file)).toBe(true)
  })

  it('is not offered in a frame before anything is on screen: the empty state has its own chooser', () => {
    expect(canOfferLocalOpen(gate(), null)).toBe(false)
  })

  it('is never offered beside a trace the portal handed over, marked or not', () => {
    for (const origin of ['https://app.moqtap.com', ...STAGING_PARENTS]) {
      const g = gate()
      g.admit({ origin, source: parent, data: trace })
      expect(canOfferLocalOpen(g, given), origin).toBe(false)
      expect(canOfferLocalOpen(g, local), origin).toBe(false)
      expect(canOfferLocalOpen(g, null), origin).toBe(false)
    }
  })

  it('is not offered beside an unmarked trace from loopback: the portal in development runs there too', () => {
    for (const origin of ['http://localhost:8790', 'http://127.0.0.1:4321']) {
      const g = gate()
      g.admit({ origin, source: parent, data: trace })
      expect(canOfferLocalOpen(g, given), origin).toBe(false)
    }
  })

  it('is not offered beside the CLI shell recording the site relay passes on', () => {
    const g = gate()
    g.admit({ origin: 'https://moqtap.com', source: parent, data: trace })
    expect(canOfferLocalOpen(g, { source: 'parent', shareable: true } as typeof given)).toBe(false)
  })

  it('is offered beside a capture the site inspector marks as read itself, and beside a local file', () => {
    for (const origin of ['https://moqtap.com', 'http://localhost:4321']) {
      const g = gate()
      g.admit({ origin, source: parent, data: trace })
      expect(canOfferLocalOpen(g, local), origin).toBe(true)
      expect(canOfferLocalOpen(g, file), origin).toBe(true)
    }
  })

  it('is not offered for a parent trace before any parent bound the frame', () => {
    expect(canOfferLocalOpen(gate(), local)).toBe(false)
  })

  it('reads the mark only as the literal true', () => {
    expect(asTraceMessage({ ...trace, local: true })?.local).toBe(true)
    for (const mark of [undefined, false, 'true', 1, {}]) {
      expect(asTraceMessage({ ...trace, local: mark })?.local, String(mark)).toBeUndefined()
    }
  })
})
