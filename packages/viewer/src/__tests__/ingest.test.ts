/**
 * The listener, wired to fake windows.
 *
 * `parents.test.ts` shows the gate decides correctly. This shows the listener
 * asks it: every message goes through `admit` before its data is read, the
 * dataless announcement is the only thing posted to `'*'`, and a report goes
 * only to the bound parent.
 */

import { describe, expect, it } from 'vitest'
import { type IngestedTrace, type IngestHost, startIngest } from '../ingest'
import { READY, SHARE_REQUEST } from '../parents'
import type { Theme } from '../theme'

const TRACE = new TextEncoder().encode('MOQTRACE and the rest')
const traceMessage = { type: 'moqtrace', bytes: TRACE, name: 'capture.moqtrace' }
// What the site relay sends for the recording the CLI shell handed it, and only that.
const shellTraceMessage = { ...traceMessage, shareable: true }

class FakeWindow {
  readonly posts: { message: unknown; targetOrigin: string }[] = []
  postMessage(message: unknown, targetOrigin: string) {
    this.posts.push({ message, targetOrigin })
  }
}

class FakeFrame extends FakeWindow implements IngestHost {
  #listener: ((event: MessageEvent) => void) | null = null
  readonly parent: FakeWindow

  constructor(parent?: FakeWindow) {
    super()
    // Unframed, a window is its own parent.
    this.parent = parent ?? this
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
    this.#listener = listener
  }
  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
    if (this.#listener === listener) this.#listener = null
  }

  deliver(origin: string, source: unknown, data: unknown) {
    this.#listener?.({ origin, source, data } as MessageEvent)
  }

  get listening(): boolean {
    return this.#listener !== null
  }
}

function setup() {
  const parent = new FakeWindow()
  const frame = new FakeFrame(parent)
  const traces: IngestedTrace[] = []
  const rejects: string[] = []
  const themes: Theme[] = []
  const ingest = startIngest(
    {
      onTrace: (t) => traces.push(t),
      onReject: (r) => rejects.push(r),
      onTheme: (t) => themes.push(t),
    },
    frame,
  )
  return { parent, frame, traces, rejects, themes, ingest }
}

describe('startIngest', () => {
  it('announces to its parent with target * and a dataless message', () => {
    const { parent } = setup()
    expect(parent.posts).toEqual([{ message: READY, targetOrigin: '*' }])
  })

  it('announces nothing when it is not framed', () => {
    const frame = new FakeFrame()
    startIngest({ onTrace: () => {}, onReject: () => {} }, frame)
    expect(frame.posts).toEqual([])
  })

  it('takes a trace from an allowlisted origin posted by its parent', () => {
    const { parent, frame, traces } = setup()
    frame.deliver('https://app.moqtap.com', parent, traceMessage)
    expect(traces).toEqual([
      {
        source: 'parent',
        bytes: TRACE,
        origin: 'https://app.moqtap.com',
        name: 'capture.moqtrace',
      },
    ])
  })

  it('hands a replacement from its parent to the page as one', () => {
    const { parent, frame, traces } = setup()
    frame.deliver('https://app.moqtap.com', parent, traceMessage)
    frame.deliver('https://app.moqtap.com', parent, { ...traceMessage, type: 'moqtrace-replace' })
    expect(traces.map((t) => t.replace)).toEqual([undefined, true])
  })

  it('gates a replacement like any trace', () => {
    const { parent, frame, traces } = setup()
    frame.deliver('https://app.moqtap.com', parent, traceMessage)
    const replacement = { ...traceMessage, type: 'moqtrace-replace' }
    frame.deliver('https://moqtap.com', parent, replacement)
    frame.deliver('https://app.moqtap.com', new FakeWindow(), replacement)
    frame.deliver('https://evil.example', parent, replacement)
    expect(traces).toHaveLength(1)
  })

  it('says a refused replacement was one, and reports it to the bound origin', () => {
    const parent = new FakeWindow()
    const frame = new FakeFrame(parent)
    const rejects: [string, boolean | undefined][] = []
    startIngest({ onTrace: () => {}, onReject: (r, replace) => rejects.push([r, replace]) }, frame)
    frame.deliver('https://app.moqtap.com', parent, {
      type: 'moqtrace-replace',
      bytes: new Uint8Array(4),
    })
    expect(rejects).toEqual([["The page sent 4 bytes that aren't a .moqtrace file.", true]])
    expect(parent.posts.slice(1)).toEqual([
      {
        message: { type: 'moqtrace-view-state', state: 'failed' },
        targetOrigin: 'https://app.moqtap.com',
      },
    ])
  })

  it('never hands a trace from an origin off the allowlist to the page', () => {
    const { parent, frame, traces, rejects } = setup()
    frame.deliver('https://evil.example', parent, traceMessage)
    frame.deliver('https://app.moqtap.com.evil.com', parent, traceMessage)
    expect(traces).toEqual([])
    expect(rejects).toEqual([])
  })

  it('never hands a trace from an allowlisted origin that is not its parent to the page', () => {
    const { frame, traces } = setup()
    const sibling = new FakeWindow()
    frame.deliver('https://moqtap.com', sibling, traceMessage)
    frame.deliver('https://moqtap.com', null, traceMessage)
    expect(traces).toEqual([])
  })

  it('does not answer a refused sender, even with a non-trace', () => {
    const { parent, frame, rejects } = setup()
    frame.deliver('https://evil.example', parent, { type: 'moqtrace', bytes: new Uint8Array(4) })
    expect(rejects).toEqual([])
    expect(parent.posts).toEqual([{ message: READY, targetOrigin: '*' }])
  })

  it('hears only the origin it bound to', () => {
    const { parent, frame, traces } = setup()
    frame.deliver('http://127.0.0.1:4321', parent, traceMessage)
    frame.deliver('https://moqtap.com', parent, traceMessage)
    expect(traces.map((t) => t.origin)).toEqual(['http://127.0.0.1:4321'])
  })

  it('reports to the bound origin and nowhere else', () => {
    const { parent, frame, traces, ingest } = setup()
    frame.deliver('https://moqtap.com', parent, traceMessage)
    const [trace] = traces
    if (trace === undefined) throw new Error('no trace admitted')
    ingest.report(trace, 'opened')
    expect(parent.posts.slice(1)).toEqual([
      {
        message: { type: 'moqtrace-view-state', state: 'opened' },
        targetOrigin: 'https://moqtap.com',
      },
    ])
  })

  it('reports a bad file to the bound origin with the state only', () => {
    const { parent, frame, rejects } = setup()
    frame.deliver('https://moqtap.com', parent, { type: 'moqtrace', bytes: new Uint8Array(4) })
    expect(rejects).toHaveLength(1)
    expect(parent.posts.slice(1)).toEqual([
      {
        message: { type: 'moqtrace-view-state', state: 'failed' },
        targetOrigin: 'https://moqtap.com',
      },
    ])
  })

  it('reports nothing for a file the person opened, or before a handshake', () => {
    const { parent, ingest } = setup()
    ingest.report({ source: 'file', bytes: TRACE }, 'opened')
    ingest.report({ source: 'parent', bytes: TRACE }, 'opened')
    expect(parent.posts).toEqual([{ message: READY, targetOrigin: '*' }])
  })

  it('offers Share for a trace the site relay marks as the shell recording, and posts only to it', () => {
    const { parent, frame, traces, ingest } = setup()
    frame.deliver('https://moqtap.com', parent, shellTraceMessage)
    expect(traces[0]?.shareable).toBe(true)
    expect(ingest.canShare(traces[0] ?? null)).toBe(true)
    expect(ingest.requestShare(traces[0] ?? null)).toBe(true)
    expect(parent.posts.slice(1)).toEqual([
      { message: SHARE_REQUEST, targetOrigin: 'https://moqtap.com' },
    ])
  })

  it('offers Share for a marked trace from the site inspector served on loopback', () => {
    const { parent, frame, traces, ingest } = setup()
    frame.deliver('http://localhost:4321', parent, shellTraceMessage)
    expect(ingest.canShare(traces[0] ?? null)).toBe(true)
    ingest.requestShare(traces[0] ?? null)
    expect(parent.posts.slice(1)).toEqual([
      { message: SHARE_REQUEST, targetOrigin: 'http://localhost:4321' },
    ])
  })

  it('hides Share for an unmarked trace from the site relay: its own sample or drop, or no shell bound', () => {
    const { parent, frame, traces, ingest } = setup()
    frame.deliver('https://moqtap.com', parent, traceMessage)
    expect(traces[0]?.shareable).toBeUndefined()
    expect(ingest.canShare(traces[0] ?? null)).toBe(false)
    expect(ingest.requestShare(traces[0] ?? null)).toBe(false)
    expect(parent.posts).toEqual([{ message: READY, targetOrigin: '*' }])
  })

  it('withdraws Share when the relay replaces the shell recording with an unmarked trace', () => {
    const { parent, frame, traces, ingest } = setup()
    frame.deliver('https://moqtap.com', parent, shellTraceMessage)
    frame.deliver('https://moqtap.com', parent, traceMessage)
    expect(ingest.canShare(traces[1] ?? null)).toBe(false)
    expect(ingest.requestShare(traces[1] ?? null)).toBe(false)
    expect(parent.posts).toEqual([{ message: READY, targetOrigin: '*' }])
  })

  it('reads the mark only as the literal true', () => {
    const { frame, parent, traces, ingest } = setup()
    for (const shareable of ['true', 1, {}, [true]]) {
      frame.deliver('https://moqtap.com', parent, { ...traceMessage, shareable })
    }
    for (const t of traces) expect(ingest.canShare(t)).toBe(false)
  })

  it('hides Share under the portal and posts nothing there, marked or not', () => {
    const { parent, frame, traces, ingest } = setup()
    frame.deliver('https://app.moqtap.com', parent, shellTraceMessage)
    expect(ingest.canShare(traces[0] ?? null)).toBe(false)
    expect(ingest.requestShare(traces[0] ?? null)).toBe(false)
    expect(parent.posts).toEqual([{ message: READY, targetOrigin: '*' }])
  })

  it('hides Share before a handshake, with nothing on screen, and for a file the person opened', () => {
    const { parent, frame, ingest } = setup()
    const forged: IngestedTrace = { source: 'parent', bytes: TRACE, shareable: true }
    expect(ingest.canShare(forged)).toBe(false)
    expect(ingest.requestShare(forged)).toBe(false)
    // A refused sender does not bind the frame, so it cannot be asked either.
    frame.deliver('http://127.0.0.1:4321', new FakeWindow(), shellTraceMessage)
    expect(ingest.requestShare(forged)).toBe(false)
    frame.deliver('http://127.0.0.1:4321', parent, shellTraceMessage)
    expect(ingest.canShare(null)).toBe(false)
    expect(ingest.requestShare(null)).toBe(false)
    const file: IngestedTrace = { source: 'file', bytes: TRACE, shareable: true }
    expect(ingest.canShare(file)).toBe(false)
    expect(ingest.requestShare(file)).toBe(false)
    expect(parent.posts).toEqual([{ message: READY, targetOrigin: '*' }])
  })

  it('carries no trace data in the share request', () => {
    const { parent, frame, traces, ingest } = setup()
    frame.deliver('http://127.0.0.1:4321', parent, shellTraceMessage)
    ingest.requestShare(traces[0] ?? null)
    const sent = parent.posts.at(-1)?.message
    expect(sent).toEqual({ type: 'moqtrace-share-request' })
    expect(Object.keys(sent as object)).toEqual(['type'])
  })

  it('hides Open capture beside a trace the portal handed over, and offers it again for a local file', () => {
    const { parent, frame, traces, ingest } = setup()
    expect(ingest.canOpenLocal(null)).toBe(false)
    frame.deliver('https://app.moqtap.com', parent, traceMessage)
    expect(ingest.canOpenLocal(traces[0] ?? null)).toBe(false)
    const file: IngestedTrace = { source: 'file', bytes: TRACE }
    expect(ingest.canOpenLocal(file)).toBe(true)
  })

  it('hides Open capture beside the shell recording the site relay passes on, not beside its own sample', () => {
    const { parent, frame, traces, ingest } = setup()
    frame.deliver('https://moqtap.com', parent, shellTraceMessage)
    frame.deliver('https://moqtap.com', parent, { ...traceMessage, local: true })
    expect(ingest.canOpenLocal(traces[0] ?? null)).toBe(false)
    expect(traces[1]?.local).toBe(true)
    expect(ingest.canOpenLocal(traces[1] ?? null)).toBe(true)
  })

  it('leaves the title to the portal and the shell, and keeps it for a capture read locally', () => {
    const { parent, frame, traces, ingest } = setup()
    expect(ingest.showsTitle(null)).toBe(false)
    frame.deliver('https://moqtap.com', parent, shellTraceMessage)
    frame.deliver('https://moqtap.com', parent, { ...traceMessage, local: true })
    expect(ingest.showsTitle(traces[0] ?? null)).toBe(false)
    expect(ingest.showsTitle(traces[1] ?? null)).toBe(true)
    expect(ingest.showsTitle({ source: 'file' })).toBe(true)
  })

  it('offers Open capture on the viewer opened on its own', () => {
    const frame = new FakeFrame()
    const ingest = startIngest({ onTrace: () => {}, onReject: () => {} }, frame)
    expect(ingest.canOpenLocal(null)).toBe(true)
  })

  it('passes the threshold and the place to open on to the page', () => {
    const { parent, frame, traces } = setup()
    frame.deliver('https://app.moqtap.com', parent, {
      ...traceMessage,
      pendingMs: 2000,
      t: 5,
      msg: '1:2',
    })
    expect(traces[0]).toMatchObject({ pendingMs: 2000, t: 5, msg: '1:2' })
  })

  it("reports the reader's selection to the bound parent, and never for a local file", () => {
    const { parent, frame, traces, ingest } = setup()
    frame.deliver('https://app.moqtap.com', parent, traceMessage)
    parent.posts.length = 0
    ingest.reportSelection({ source: 'file' }, { t: 1, msg: null })
    ingest.reportSelection(null, { t: 1, msg: null })
    expect(parent.posts).toEqual([])
    ingest.reportSelection(traces[0] ?? null, { t: 41_212, msg: '0:21' })
    expect(parent.posts).toEqual([
      {
        message: { type: 'moqtrace-view-selection', t: 41_212, msg: '0:21' },
        targetOrigin: 'https://app.moqtap.com',
      },
    ])
  })

  it('stops listening when stopped', () => {
    const { frame, ingest } = setup()
    ingest.stop()
    expect(frame.listening).toBe(false)
  })
})

describe('the theme handshake', () => {
  const dark = { type: 'moqtap:theme', theme: 'dark' }

  it('takes a theme from an allowlisted parent, and only as a theme', () => {
    const { parent, frame, themes, traces, rejects } = setup()
    frame.deliver('https://app.moqtap.com', parent, dark)
    frame.deliver('https://app.moqtap.com', parent, { type: 'moqtap:theme', theme: 'system' })
    expect(themes).toEqual(['dark', 'system'])
    expect(traces).toEqual([])
    expect(rejects).toEqual([])
    expect(parent.posts).toEqual([{ message: READY, targetOrigin: '*' }])
  })

  it('takes one from the site inspector on loopback, the middle of the CLI nest', () => {
    const { parent, frame, themes } = setup()
    frame.deliver('http://127.0.0.1:4400', parent, dark)
    expect(themes).toEqual(['dark'])
  })

  it('ignores a theme from an origin off the allowlist', () => {
    const { parent, frame, themes } = setup()
    frame.deliver('https://evil.example', parent, dark)
    frame.deliver('https://moqtap.com.evil.com', parent, dark)
    frame.deliver('https://127.0.0.1:4400', parent, dark)
    expect(themes).toEqual([])
  })

  it('ignores a theme from an allowlisted origin that is not its parent', () => {
    const { frame, themes } = setup()
    frame.deliver('https://moqtap.com', new FakeWindow(), dark)
    frame.deliver('https://moqtap.com', null, dark)
    expect(themes).toEqual([])
  })

  it('hears themes only from the origin it bound to', () => {
    const { parent, frame, themes } = setup()
    frame.deliver('https://app.moqtap.com', parent, traceMessage)
    frame.deliver('https://moqtap.com', parent, dark)
    frame.deliver('https://app.moqtap.com', parent, { type: 'moqtap:theme', theme: 'light' })
    expect(themes).toEqual(['light'])
  })

  it('ignores a malformed theme without treating it as a failed import', () => {
    const { parent, frame, themes, rejects } = setup()
    frame.deliver('https://app.moqtap.com', parent, { type: 'moqtap:theme', theme: 'purple' })
    expect(themes).toEqual([])
    expect(rejects).toEqual([])
    expect(parent.posts).toEqual([{ message: READY, targetOrigin: '*' }])
  })

  it('works without a theme handler', () => {
    const parent = new FakeWindow()
    const frame = new FakeFrame(parent)
    startIngest({ onTrace: () => {}, onReject: () => {} }, frame)
    expect(() => frame.deliver('https://app.moqtap.com', parent, dark)).not.toThrow()
  })
})
